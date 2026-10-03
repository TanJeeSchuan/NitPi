/**
 * Durable review task: pi-durable task `nitpi.review`, one per run.
 *
 * Phases (pipeline, spec "Pi Durable mapping"):
 *   primary → freeze artifact → re-review → final frozen → publish → published
 *
 * Instructions per stage come from the run document's stored resolution
 * (protocol + policy + repository layers, resolved once at command time;
 * ticket 10), never from the live configuration — recovery reuses the stored
 * text even if the configuration changed mid-run. The primary turn runs in the canonical
 * PR conversation; the re-reviewer runs in a task-owned conversation (reused
 * when an interrupted attempt already recorded one) with explicit agent
 * configuration, on its own unchanged checkout. It receives the frozen
 * artifact plus repository and PR inputs — never the primary transcript.
 * After the final review is frozen, one more matching-only turn in that same
 * conversation assigns current findings to earlier published comment IDs
 * (ticket 04); the publisher then keeps the pull request's threads in sync.
 *
 * Recovery (ticket 06): the task's checkpoint is the pipeline phase. On
 * reopen (an Actions re-run) a surviving run resumes from its last durable
 * checkpoint, and the run document itself decides what is already durable:
 * a frozen artifact means the re-review stage; a frozen final review means
 * matching, and a recorded match means publication. After a completed primary stage, no new primary model calls
 * happen — the canonical conversation's transcript is the durable primary
 * work, and a mid-stage attempt continues it instead of starting over. When
 * the runner itself is killed (host signal, close, job cancel), the
 * interrupted attempt records nothing: the durable checkpoint stands and no
 * failure handling fires.
 *
 * Failure handling: if either reviewer errors or exceeds its deadline, no
 * findings are published. The check reports failure (error) or incomplete
 * (timeout) with a reason, and the durable work stays recorded on the run
 * document for a re-run. If storage is unreachable, the phase stops with an
 * execution failure: no local continuation, no publication.
 *
 * Anchor validation (ticket 02) stays on the frozen-artifact flow: the
 * final review freezes only once every remaining anchor is valid against
 * the pinned diff, with correction rounds inside the re-review conversation.
 *
 * Clean runs (ticket 07) review in fresh task-owned conversations for BOTH
 * stages: until the final review freezes, neither reviewer may receive
 * earlier transcripts, artifacts, findings or discussion — the canonical PR
 * conversation stays idle, and no GitHub read returns earlier bot comments.
 * After matching, a clean run's completed report is imported into the idle
 * canonical conversation (the import and its marker in one transaction)
 * before publication.
 *
 * Module dependencies (`installReviewTaskDeps`) exist because pi-durable
 * resolves task definitions from the registry at invocation: the process-wide
 * host wires registry + publisher once before the harness starts work.
 *
 * Deliberate cohesion: this module is the pipeline state machine, so the
 * recovery contract's deadlines (StageTimeout), resume positioning
 * (initialPhase), strict-JSON usage recording, and anchor-round carry-over
 * all live here — they are one durable phase-advance behavior, not unrelated
 * reasons (the code-review question is answered by the phase boundaries
 * each concern sits behind).
 */
import type { Context } from "@earendil-works/chord";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import { createHash } from "node:crypto";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { Conversation, Harness, Submission, TaskId, TaskRuntime } from "@earendil-works/pi-durable";
import { defineEntry, defineTask } from "@earendil-works/pi-durable";
import { Publisher, PublishError } from "../github/publisher.js";
import type { GitHubApi } from "../github/publisher.js";
import { publicationTask } from "../github/publication-task.js";
import type { PublishTaskResult } from "../github/publication-task.js";
import { parseFinalReview, stripAuditNotes } from "./artifact.js";
import {
  parseUnifiedDiffAnchors,
  validateFindingAnchors,
  type InvalidAnchor,
} from "./anchor-validation.js";
import {
  buildMatchPrompt,
  matchableComments,
  parseMatchList,
  type FindingMatch,
} from "./matching.js";
import type { ReviewHostConfig } from "./config.js";
import type { ResolvedInstructions } from "./instructions.js";
import type {
  RunDocument,
  RunHistory,
  RunPhase,
  RunUsage,
  StageInstructionsRecord,
  StageUsage,
} from "./run-history.js";

/** The review commands the trigger gate accepts today (ticket 09 widens it
 *  with `cancel`). */
export type ReviewCommand = "/review" | "/review clean";

export interface ReviewRunRequest {
  readonly repository: string;
  readonly pullNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  /** `/review` or `/review clean` (ticket 07); `cancel` is ticket 09. */
  readonly command: ReviewCommand;
  /** What started the run (ticket 03): a command or an automatic event. */
  readonly source: "command" | "automatic";
  /** Human-readable original trigger recorded on the run document. */
  readonly triggeredBy: string;
}

/** Imported report entry (ticket 07): one clean run's completed review in the
 * canonical PR conversation. The `model` payload is the user message the next
 * normal run sees; audit notes are not imported. */
export const ImportedReportEntry = defineEntry<{ runId: string }>("nitpi.imported-report");

/** Process-wide host wiring consumed by task phases. */
export interface ReviewTaskDeps {
  readonly config: ReviewHostConfig;
  readonly runHistory: RunHistory;
  readonly api: GitHubApi;
  /** Duration in milliseconds after which a stage fails as incomplete. */
  stageDeadline(stage: "primary" | "re-review"): number;
  /** Pacing for publication's rate-limit waits (ticket 05). Production uses
   * the durable runtime clock; tests inject a recording clock so nothing
   * ever really sleeps in the suite. */
  publicationSleep?: (ms: number) => Promise<void>;
}

let deps: ReviewTaskDeps | undefined;

export function installReviewTaskDeps(installed: ReviewTaskDeps): void {
  deps = installed;
}

export function reviewTaskDeps(): ReviewTaskDeps {
  if (!deps) throw new Error("review task dependencies are not installed");
  return deps;
}

export interface ReviewTaskInput {
  readonly runId: string;
  readonly canonicalConversationId: string;
  readonly request: ReviewRunRequest;
  /**
   * First checkpoint of this task. Fresh runs start the primary; a re-run
   * resuming a failed attempt starts where the run document's durable
   * already-completed work is (re-review or publish).
   */
  readonly initialPhase?: "primary" | "re-review" | "match" | "import" | "publish";
}

export interface ReviewCheckpoint {
  phase: "primary" | "re-review" | "match" | "import" | "publish";
}

export type ReviewTaskResult =
  | { readonly published: true; readonly reviewId: number }
  | { readonly published: false; readonly reason: string };

export const reviewTask = defineTask<ReviewTaskInput, ReviewCheckpoint, ReviewTaskResult, object>({
  name: "nitpi.review",
  version: 1,
  initial: (input) => ({ phase: input.initialPhase ?? ("primary" as const) }),
  phases: {
    primary: async (task, runtime, context) => {
      try {
        const host = reviewTaskDeps();
        const runDoc = await host.runHistory.findRun(task.input.runId, context);
        if (!runDoc) throw new Error(`run ${task.input.runId} is not recorded`);

        // Where the primary reviews: a normal run continues the canonical PR
        // conversation; a clean run (ticket 07) opens a fresh task-owned
        // conversation instead — never a fork of the canonical one, and the
        // canonical conversation stays idle until the report is imported.
        let primaryConversation = await harnessConversation(
          host.runHistory.harness,
          task.input.canonicalConversationId,
        );
        if (runDoc.mode === "clean") {
          const fresh = await freshTaskOwnedConversation(runtime, context);
          await commitRunUpdate(host, task.input.runId, context, (run) => ({
            ...run,
            primaryConversationId: fresh.id as unknown as string,
          }));
          primaryConversation = fresh;
        }

        // Cross-commit boundary recovery: the artifact froze but the task
        // still points at the primary phase → primary model work is done and
        // must not run again; continue with the re-review stage.
        if (runDoc.artifactFrozen && runDoc.artifact) {
          await advancePhase(runtime, context, "re-review");
          return;
        }

        // Primary instructions: the run's stored resolution (protocol +
        // policy + repository layers, plus the custom prompt in append or
        // replace mode), with the content hash recorded on the run document.
        const instructions = await instructionsForStage(host, "primary", runDoc, context);
        await configureConversation(
          primaryConversation,
          "nitpi-primary",
          host.config.primary.modelId,
          instructions.text,
          runDoc.checkouts?.primary,
          context,
        );

        // Pin the reviewed base→head diff once, at run start: anchor
        // validation (ticket 02) checks against THIS text even if the pull
        // request's head moves while the review runs. A resumed attempt
        // reuses the first attempt's pin: the pin is per-run durable state.
        if (!runDoc.pinnedDiff?.trim()) {
          const pinnedDiff = await readPinnedDiff(host, runDoc.subject);
          await commitRunUpdate(host, task.input.runId, context, (run) => ({
            ...run,
            pinnedDiff,
          }));
        }

        // Primary turn: one prompt, run to completion, Pi keeps the tool loop.
        // A resumed attempt continues the canonical conversation's earlier
        // work instead of restarting it from scratch.
        const prompt = buildPrimaryPrompt(runDoc);
        await runConversationTurn(primaryConversation, prompt, context, host, "primary");

        // Freeze the hand-off: stored unchanged as free-form text.
        const answer = await latestAssistant(primaryConversation, context);
        const artifact = answer?.text ?? "";
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          artifact,
          artifactFrozen: true,
          phase: "primary frozen",
          instructionHashes: { ...run.instructionHashes, primary: sha256(instructions.text) },
          usage: mergeUsage(run, "primary", answer?.usageSummary),
        }));

        await advancePhase(runtime, context, "re-review");
      } catch (error) {
        if (isKilledInvocation(runtime)) return;
        await failRun(task.input, context, error);
      }
    },

    "re-review": async (task, runtime, context) => {
      try {
        const host = reviewTaskDeps();
        const runDoc = await host.runHistory.findRun(task.input.runId, context);
        if (!runDoc) throw new Error(`run ${task.input.runId} is not recorded`);
        if (!runDoc.artifact) throw new Error("primary artifact is not frozen");

        // Cross-commit boundary recovery: the final review froze but the task
        // still points at re-review → go straight to matching (ticket 04),
        // which runs before publication.
        if (runDoc.finalReview) {
          await advancePhase(runtime, context, "match");
          return;
        }

        // The check keeps showing the current stage while running.
        await new Publisher(host.api).checkInProgress(runDoc.subject, "re-review");

        // Task-owned conversation for the re-reviewer. A resumed attempt
        // reuses its durable task-owned conversation when one was already
        // recorded; a fresh attempt creates one. The commit makes durable
        // progress; the task checkpoint changes at the phase boundary below.
        let conversation: Conversation;
        if (runDoc.reReviewConversationId) {
          // The durable conversation carries the earlier re-review work: an
          // interrupted attempt continues it instead of starting another one.
          conversation = await harnessConversation(
            host.runHistory.harness,
            runDoc.reReviewConversationId,
          );
        } else {
          let createdId: string | undefined;
          await runtime.commit(async (tx) => {
            const record = await tx.createConversation({
              ownership: { kind: "task", taskId: runtime.taskId },
            });
            createdId = record.id as unknown as string;
          }, context);
          conversation = await harnessConversation(host.runHistory.harness, createdId!);
        }
        const instructions = await instructionsForStage(host, "re-review", runDoc, context);
        await configureConversation(
          conversation,
          "nitpi-re-review",
          host.config.reReview.modelId,
          instructions.text,
          runDoc.checkouts?.reReview,
          context,
        );
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          reReviewConversationId: conversation.id as unknown as string,
        }));

        const prompt = buildReReviewPrompt(runDoc);
        await runConversationTurn(conversation, prompt, context, host, "re-review");

        // Anchor validation against the pinned diff (ticket 02): the final
        // review freezes only once every remaining anchor is valid. An
        // invalid anchor goes back to the re-reviewer in this same
        // conversation, with the reason, to correct or withdraw the finding;
        // a finding that disappears from a resubmission must be accounted
        // for in the audit notes (a withdrawal is recorded there).
        if (!runDoc.pinnedDiff?.trim()) throw new Error("the pinned diff is not recorded on the run");
        const anchors = parseUnifiedDiffAnchors(runDoc.pinnedDiff);
        let answer = await latestAssistant(conversation, context);
        let parsed = parseFinalReview(answer?.text ?? "");
        let previousLabels = parsed.findings.map((f) => f.label);
        let invalid = validateFindingAnchors(parsed.findings, anchors);
        let anchorRounds = runDoc.anchorRounds ?? 0;
        while (invalid.length > 0) {
          if (anchorRounds >= MAX_ANCHOR_ROUNDS) {
            // The re-reviewer finished with an invalid anchor still in
            // place: the run fails, nothing is published, and the check is
            // never a zero-finding success.
            throw new Error(
              `re-reviewer finished with invalid inline anchors after ${MAX_ANCHOR_ROUNDS} correction rounds: ${invalid
                .map((i) => `${i.label} "${i.written}" — ${i.reason}`)
                .join("; ")}`,
            );
          }
          anchorRounds += 1;
          await commitRunUpdate(host, task.input.runId, context, (run) => ({
            ...run,
            anchorRounds,
          }));
          await runConversationTurn(conversation, buildAnchorFeedbackPrompt(invalid), context, host, "re-review");
          answer = await latestAssistant(conversation, context);
          parsed = parseFinalReview(answer?.text ?? "");
          const currentLabels = parsed.findings.map((f) => f.label);
          const unrecorded = previousLabels.filter(
            (label) => !currentLabels.includes(label) && !parsed.auditNotes.includes(label),
          );
          if (unrecorded.length > 0) {
            throw new Error(
              `finding(s) ${unrecorded.join(", ")} disappeared from the resubmitted final review without a withdrawal recorded in the audit notes`,
            );
          }
          previousLabels = currentLabels;
          invalid = validateFindingAnchors(parsed.findings, anchors);
        }

        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          finalReview: answer?.text ?? "",
          auditNotes: parsed.auditNotes,
          findings: parsed.findings,
          phase: "final frozen",
          anchorRounds,
          instructionHashes: { ...run.instructionHashes, reReview: sha256(instructions.text) },
          usage: mergeUsage(run, "reReview", answer?.usageSummary),
        }));

        await advancePhase(runtime, context, "match");
      } catch (error) {
        await failRun(task.input, context, error);
      }
    },

    match: async (task, runtime, context) => {
      try {
        const host = reviewTaskDeps();
        const runDoc = await host.runHistory.findRun(task.input.runId, context);
        if (!runDoc?.finalReview) throw new Error("final review is not frozen");
        const publisher = new Publisher(host.api);
        await publisher.checkInProgress(runDoc.subject, "matching");

        // Earlier published findings and their comment IDs, read once: this
        // is the snapshot the matching turn sees and the same snapshot the
        // publisher validates model-supplied IDs against.
        const earlier = await publisher.listPublishedComments(runDoc.subject);
        const findings = runDoc.findings ?? [];
        const matches: FindingMatch[] = [];
        let matchUsage: StageUsage | undefined;
        if (earlier.length > 0 && findings.length > 0) {
          // A zero-finding rerun needs no matching turn: the publisher
          // resolves every omitted bot thread at publish time. This turn
          // runs only when there are findings to assign and something to
          // assign them to.
          // One more turn in the SAME re-reviewer conversation; matching
          // only — it cannot change the frozen findings.
          if (!runDoc.reReviewConversationId) {
            throw new Error("re-reviewer conversation is not recorded");
          }
          const conversation = await harnessConversation(host.runHistory.harness, runDoc.reReviewConversationId);
          const botLogin = await publisher.botLogin();
          // Only live bot thread roots are matchable: replies and comments
          // the publisher already marked superseded are out of the pool.
          await runConversationTurn(
            conversation,
            buildMatchPrompt(findings, matchableComments(earlier, botLogin)),
            context,
            host,
            "re-review",
          );
          const answer = await latestAssistant(conversation, context);
          matches.push(...parseMatchList(answer?.text ?? "", new Set(findings.map((f) => f.label))).matches);
          matchUsage = answer?.usageSummary;
        }

        // Durable commits carry strict JSON: include the matching-turn usage
        // only when the turn ran (it is skipped on first runs and
        // zero-finding reviews).
        const usage = matchUsage ? { ...runDoc.usage, matching: matchUsage } : runDoc.usage;
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          earlierComments: earlier,
          matches,
          phase: "matched",
          ...(usage !== undefined ? { usage } : {}),
        }));

        // Clean runs (ticket 07) import their completed report before
        // publication; normal runs review in the canonical conversation and
        // have nothing to import.
        await advancePhase(runtime, context, runDoc.mode === "clean" ? "import" : "publish");
      } catch (error) {
        if (isKilledInvocation(runtime)) return;
        await failRun(task.input, context, error);
      }
    },

    publish: async (task, runtime, context) => {
      const host = reviewTaskDeps();
      const runDoc = await host.runHistory.findRun(task.input.runId, context);
      if (!runDoc?.finalReview) throw new Error("final review is not frozen");
      const publisher = new Publisher(host.api);
      const subject = runDoc.subject;

      try {
        // Idempotent re-entry: a crash between the publication commit and the
        // task's terminal completion re-enters here with publication already
        // recorded — nothing is written again.
        if (runDoc.publication && runDoc.publicationOutcome === "published") {
          await publisher.checkSuccess(subject, runDoc.findings?.length ?? 0);
          await runtime.commit(
            (_tx) =>
              ({
                status: "terminal" as const,
                outcome: {
                  status: "completed" as const,
                  result: { published: true, reviewId: runDoc.publication!.reviewId },
                },
              }) as const,
            context,
          );
          return;
        }

        await publisher.checkInProgress(subject, "publish");
        // Publication runs as a durable child task (ticket 05): its own
        // checkpoints, operation ledger and reconciliation survive a runner
        // crash, and a failed publication retries as publication only — the
        // completed final review is kept, with zero new model calls.
        let childTaskId: TaskId<PublishTaskResult> | undefined;
        await runtime.commit(
          async (tx) => {
            childTaskId = await tx.createTask(
              publicationTask,
              { runId: task.input.runId },
              { ownership: { kind: "task" as const, taskId: runtime.taskId } },
            );
            return undefined; // The child's creation is the commit; the phase continues unchanged.
          },
          context,
        );
        if (!childTaskId) throw new Error("publication child task was not created");
        const settled = await runtime.waitForTask(childTaskId, context);
        const outcome = settled.state.outcome as TaskOutcomeLike;
        const settledOutcome = outcome.status === "completed" ? (outcome.result as { status: string; reviewId?: number } | undefined) : undefined;
        if (outcome.status === "completed" && settledOutcome?.status === "published" && typeof settledOutcome.reviewId === "number") {
          // The child committed the run document's publication, phase and
          // check status; the pipeline closes out here.
          const reviewId = settledOutcome.reviewId;
          await runtime.commit(
            (_tx) =>
              ({
                status: "terminal" as const,
                outcome: {
                  status: "completed" as const,
                  result: { published: true, reviewId },
                },
              }) as const,
            context,
          );
          return;
        }
        // Known failure or unknown outcome: the child already recorded the
        // run document state and the GitHub check; the durable attempt fails
        // with the child's reason and a later trigger resumes publication
        // only.
        const reason =
          outcome.status === "failed"
            ? outcome.error?.message ?? "publication failed"
            : outcome.status === "aborted"
              ? outcome.reason ?? "publication canceled"
              : outcome.error?.message ?? "publication failed";
        await runtime.commit(
          (_tx) => ({ status: "terminal" as const, outcome: { status: "failed" as const, error: { message: reason } } }) as const,
          context,
        );
      } catch (error) {
        if (isKilledInvocation(runtime)) return; // A dead runner records nothing.
        await failRun(task.input, context, error);
      }
    },

    /** Clean-run import (ticket 07): the completed report joins the shared PR
     * history once, in one transaction, before publication — even when
     * publication later fails. The append and the run's import marker are
     * committed together; a re-entry (a crash between this commit and the
     * next durable step) finds the marker and imports nothing. Failed or
     * cancelled clean runs never reach this phase: failures before the final
     * review froze fault the run earlier, and the abort handler imports
     * nothing.
     */
    import: async (task, runtime, context) => {
      try {
        const host = reviewTaskDeps();
        const runDoc = await host.runHistory.findRun(task.input.runId, context);
        // Invariant, not a duplicate decision: the routing in the match phase
        // must never send a normal run here; the frozen-final-review and
        // marker guards live inside the import transaction itself.
        if (!runDoc) throw new Error(`run ${task.input.runId} is not recorded`);
        if (runDoc.mode !== "clean") throw new Error("only clean runs import their report");
        await commitImportedReport(host.runHistory, task.input.runId, context);

        await runtime.commit(
          (_tx, current) => ({
            status: "running" as const,
            checkpoint: { ...current.state.checkpoint, phase: "publish" as const },
          }),
          context,
        );
      } catch (error) {
        await failRun(task.input, context, error);
      }
    },
  },
  abort: async (task, runtime, context) => {
    // Durable cancellation: nothing publishes after abort (ticket 09 refines
    // the fence). The run document already carries the stage's reason when
    // this follows a failed stage; the check status flips to failure here.
    await commitRunUpdateSafe(reviewTaskDeps(), task.input.runId, context, (run) => ({
      ...run,
      checkStatus: "failure",
    }));
    await runtime.commit(
      (_tx) =>
        ({
          status: "terminal" as const,
          outcome: { status: "aborted" as const, reason: "review canceled" },
        }) as const,
      context,
    );
  },
  hooks: {},
});

// --- helpers ----------------------------------------------------------------

class StageTimeout extends Error {
  constructor(
    readonly stage: "primary" | "re-review",
    readonly deadlineMs: number,
  ) {
    super(`${stage} reviewer exceeded its ${deadlineMs}ms deadline`);
    this.name = "StageTimeout";
  }
}

/** Advance the pipeline to the next phase as one durable checkpoint. */
async function advancePhase(
  runtime: Pick<TaskRuntime<ReviewTaskInput, ReviewCheckpoint, ReviewTaskResult, object>, "commit">,
  context: Context,
  phase: "re-review" | "match" | "import" | "publish",
): Promise<void> {
  await runtime.commit(
    (_tx, current) => ({
      status: "running" as const,
      checkpoint: { ...current.state.checkpoint, phase },
    }),
    context,
  );
}

/** Merge this turn's usage into the run document (strict JSON: absent key,
 * never an undefined value, when the turn produced no usage). */
function mergeUsage(
  run: RunDocument,
  stage: keyof RunUsage,
  next: TurnAnswer["usageSummary"] | undefined,
): RunUsage {
  const usage: RunUsage = { ...run.usage };
  if (next) usage[stage] = next;
  return usage;
}

/**
 * The runner was killed (host signal, close, job cancel): nothing is recorded
 * for this attempt — the crash semantics leave the durable checkpoint as it
 * was, and the durable failure handling (reason, GitHub check) does not fire.
 */
function isKilledInvocation(runtime: { readonly signal: AbortSignal }): boolean {
  return runtime.signal.aborted;
}

/**
 * Run one reviewer turn up to the stage deadline. On deadline, abort the
 * submission so the in-flight model work stops, and fail the stage as
 * incomplete: no findings are published and the durable work is kept for a
 * re-run.
 */
async function runConversationTurn(
  conversation: Conversation,
  prompt: string,
  context: Context,
  host: ReviewTaskDeps,
  stage: "primary" | "re-review",
): Promise<void> {
  const deadlineMs = host.stageDeadline(stage);
  const submission: Submission = await conversation.submit({ type: "input", content: prompt }, context);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new StageTimeout(stage, deadlineMs));
      }, deadlineMs);
      timer.unref?.();
    });
    const settled = await Promise.race([submission.wait(context), deadline]);
    if (settled.status === "unanswered") {
      const detail = settled.detail === undefined ? undefined : String(settled.detail);
      throw new Error(detail ?? `model turn did not answer (${settled.reason})`);
    }
  } catch (error) {
    if (timedOut) {
      // Stop the in-flight turn so no further model work happens for this
      // stage; the durable conversation keeps what already ran.
      await submission.abort(TODO_CONTEXT).catch(() => undefined);
      throw new StageTimeout(stage, deadlineMs);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Ticket 10: the instructions one stage runs with — the run document's stored
 * resolution, written at command time before any model call. There is no
 * fallback: a run whose document has no stored instructions is corrupt, and
 * re-resolving from the live configuration would let a mid-run configuration
 * change alter a run already in progress.
 */
async function instructionsForStage(
  host: ReviewTaskDeps,
  role: "primary" | "re-review",
  runDoc: RunDocument,
  context: Context,
): Promise<ResolvedInstructions> {
  const stored = await host.runHistory.instructionsFor(runDoc.runId, role, context);
  if (!stored) {
    throw new Error(`run ${runDoc.runId} has no stored ${role} instructions (corrupt run document)`);
  }
  return storedInstructionsToResolved(stored);
}

/** A stored record is the same shape the resolver produces. */
function storedInstructionsToResolved(stored: StageInstructionsRecord): ResolvedInstructions {
  if (stored.promptMode !== "append" && stored.promptMode !== "replace" && stored.promptMode !== "none") {
    throw new Error(`stored instructions for the stage have an unknown prompt mode: ${String(stored.promptMode)}`);
  }
  return {
    text: stored.text,
    policyPin: stored.policyPin,
    promptMode: stored.promptMode,
    ...(stored.customPrompt !== undefined ? { customPrompt: stored.customPrompt } : {}),
  };
}

/** Record a stage failure on the run document and GitHub, then rethrow so the
 * durable task faults with the reason. No provisional findings are published;
 * the durable work stays for a re-run. Storage being unreachable degrades to
 * an execution failure surfaced through the task: the subject comes from the
 * durable task input, because storage being down may leave the run document
 * unreadable while the check must still report. */
async function failRun(
  input: ReviewTaskInput,
  context: Context,
  error: unknown,
): Promise<never> {
  const host = reviewTaskDeps();
  const reason = errorText(error);
  const subject: RunDocument["subject"] = {
    repository: input.request.repository,
    pullNumber: input.request.pullNumber,
    baseSha: input.request.baseSha,
    headSha: input.request.headSha,
  };
  const publisher = new Publisher(host.api);
  try {
    if (error instanceof StageTimeout) {
      await publisher.checkIncomplete(subject, reason);
    } else {
      await publisher.checkFailure(subject, reason);
    }
  } catch {
    // The check failing must not mask the original reason.
  }
  await commitRunUpdateSafe(host, input.runId, context, (run) => ({
    ...run,
    checkStatus: "failure",
    checkDetail: error instanceof StageTimeout ? `incomplete review: ${reason}` : reason,
    error: reason,
  }));
  throw error instanceof Error ? error : new Error(reason);
}

async function commitRunUpdateSafe(
  host: ReviewTaskDeps,
  runId: string,
  context: Context,
  mutate: (run: RunDocument) => RunDocument,
): Promise<void> {
  try {
    await commitRunUpdate(host, runId, context, mutate);
  } catch {
    // With storage unreachable this is the execution failure itself; the
    // rethrow path in the caller still surfaces it through the task.
  }
}

async function harnessConversation(harness: Harness, conversationId: string): Promise<Conversation> {
  const conversation = await harness.conversation(conversationId as never, TODO_CONTEXT);
  if (!conversation) throw new Error(`conversation ${conversationId} not found`);
  return conversation;
}

async function configureConversation(
  conversation: Conversation,
  provider: string,
  modelId: string,
  instructions: string,
  cwd: string | undefined,
  context: Context,
): Promise<void> {
  await conversation.configure(
    { model: { provider, modelId }, instructions, ...(cwd ? { cwd } : {}) },
    context,
  );
}

export interface TurnAnswer {
  text: string;
  /** Usage of the assistant message that settled the turn. */
  usageSummary: { input: number; output: number; totalTokens: number };
}

/** The newest assistant entry with text; return the first hit found of the
 * newest-first page. Tool-only assistant messages (no text) are skipped, so
 * the loop keeps walking past them to the newest turn that actually answered.
 * The correction and matching turns depend on this: the resubmitted final
 * review (ticket 02) and the match list (ticket 04) are the newest assistant
 * text, not an earlier turn's. */
async function latestAssistant(conversation: Conversation, context: Context): Promise<TurnAnswer | undefined> {
  const page = await conversation.entries({ conversationId: conversation.id } as never, 20, undefined, context);
  for (const entry of page.items) {
    if (entry.kind !== "pi.assistant") continue;
    for (const message of entry.model ?? []) {
      if (message.role !== "assistant") continue;
      const text = message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text.trim()) {
        return {
          text,
          usageSummary: {
            input: message.usage.input,
            output: message.usage.output,
            totalTokens: message.usage.totalTokens,
          },
        };
      }
    }
  }
  return undefined;
}

async function commitRunUpdate(
  host: ReviewTaskDeps,
  runId: string,
  context: Context,
  mutate: (run: RunDocument) => RunDocument,
): Promise<void> {
  await host.runHistory.harness.commit(async (tx) => {
    const current = await host.runHistory.findRunInTx(tx, runId);
    if (!current) throw new Error(`run ${runId} missing while updating`);
    await host.runHistory.record(tx, mutate(current));
  }, context);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function buildPrimaryPrompt(run: RunDocument): string {
  // A resumed attempt continues the canonical conversation: its transcript
  // already holds the earlier inspect-and-draft work, so the prompt asks the
  // reviewer to continue instead of starting over.
  return [
    `Review pull request #${run.subject.pullNumber} in repository ${run.subject.repository}.`,
    `Reviewed head: ${run.subject.headSha} (base: ${run.subject.baseSha}).`,
    `Mode: ${run.mode}. Use your tools on this checkout; do not push, commit or edit the pull request.`,
    `Earlier turns in this conversation may already contain part of this review from an interrupted attempt; continue from there instead of starting over.`,
    `Finish with your free-form review artifact as your final assistant message.`,
  ].join("\n");
}

function buildReReviewPrompt(run: RunDocument): string {
  return [
    `Verify the primary review of pull request #${run.subject.pullNumber} in ${run.subject.repository}.`,
    `Reviewed head: ${run.subject.headSha} (base: ${run.subject.baseSha}).`,
    `Use your own checkout; you never see the primary's conversation.`,
    ``,
    `--- FROZEN PRIMARY REVIEW ARTIFACT ---`,
    run.artifact ?? "",
    `--- END FROZEN PRIMARY REVIEW ARTIFACT ---`,
    ``,
    `Write your final review (one finding per section with an inline location "path | SIDE | line", or "path | SIDE | line | START_SIDE | startLine" for a range) followed by "# Audit notes".`,
  ].join("\n");
}

/**
 * Feedback for invalid anchors, returned to the re-reviewer in its own
 * conversation: correct the anchor to a line of the reviewed diff, or
 * withdraw the finding (section removed, withdrawal recorded in the audit
 * notes). Anchors are never guessed; evidence may cite unchanged code.
 */
function buildAnchorFeedbackPrompt(invalid: readonly InvalidAnchor[]): string {
  return [
    `Your final review has invalid inline anchors. Every finding's inline location must point at a line of the reviewed diff, in the form "path | SIDE | line" or, for a range, "path | SIDE | line | START_SIDE | startLine" (a range must lie on one side). Evidence may cite unchanged code (callers, config); only the inline location must be in the diff.`,
    ``,
    `Invalid anchors:`,
    ...invalid.map((i) => `- ${i.label}: "${i.written}" — ${i.reason}`),
    ``,
    `Correct each listed anchor to a line that is in the reviewed diff, or withdraw the finding: remove its section entirely and record the withdrawal in the audit notes. Resubmit the complete final review (every remaining finding, one per section, followed by the audit notes). Anchors are never guessed; a finding you cannot anchor validly is withdrawn.`,
  ].join("\n");
}

/**
 * Clean-run import (ticket 07): append the run's completed report to the
 * canonical PR conversation and set the run's import marker — in ONE
 * transaction. The imported entry is a user message so the next normal run's
 * model context sees the report; private conversations, tool output and audit
 * notes are not imported. A run whose marker is already set (the re-entry a
 * crash between the import commit and the next durable step takes) appends
 * nothing: every run imports its report once, even when publication later
 * fails. Normal runs import nothing (their primary already runs in the
 * canonical conversation).
 */
export async function commitImportedReport(
  history: RunHistory,
  runId: string,
  context: Context,
): Promise<{ imported: boolean; entryId?: string }> {
  let result: { imported: boolean; entryId?: string } | undefined;
  await history.harness.commit(async (tx) => {
    const run = await history.findRunInTx(tx, runId);
    if (!run) throw new Error(`run ${runId} missing while importing`);
    if (run.mode !== "clean") {
      result = { imported: false };
      return;
    }
    if (!run.finalReview) throw new Error("a clean run cannot import without a frozen final review");
    if (run.imported) {
      result = { imported: false, entryId: run.imported.entryId };
      return;
    }
    const report = stripAuditNotes(run.finalReview);
    const entry = await tx.appendEntry(ImportedReportEntry, run.canonicalConversationId as never, {
      data: { runId },
      model: [
        {
          role: "user",
          content: report,
          timestamp: Date.now(),
        } satisfies UserMessage,
      ],
    });
    const entryId = entry.id as unknown as string;
    // Same transaction: the append and the marker commit together.
    await history.record(tx, { ...run, imported: { entryId }, phase: "imported" });
    result = { imported: true, entryId };
  }, context);
  return result!;
}


/** Fresh task-owned conversation for one clean-run stage (ticket 07): a real
 * conversation, never a fork of the canonical PR conversation. */
async function freshTaskOwnedConversation(
  runtime: TaskRuntime<ReviewTaskInput, ReviewCheckpoint, ReviewTaskResult, object>,
  context: Context,
): Promise<Conversation> {
  let createdId: string | undefined;
  await runtime.commit(async (tx) => {
    const record = await tx.createConversation({
      ownership: { kind: "task", taskId: runtime.taskId },
    });
    createdId = record.id as unknown as string;
  }, context);
  if (!createdId) throw new Error("task-owned conversation was not created");
  return harnessConversation(reviewTaskDeps().runHistory.harness, createdId);
}

/** Read the pull request's base→head diff (the pinned diff), as GitHub serves it. */
async function readPinnedDiff(
  host: ReviewTaskDeps,
  subject: RunDocument["subject"],
): Promise<string> {
  const response = await host.api.getPullRequestDiff(subject.repository, subject.pullNumber);
  if (response.status !== 200 || typeof response.body !== "string" || !response.body.trim()) {
    throw new Error(
      `cannot read the pinned diff for ${subject.repository}#${subject.pullNumber} (HTTP ${response.status})`,
    );
  }
  return response.body;
}

/** Correction rounds allowed before an unresolved anchor fails the run. */
const MAX_ANCHOR_ROUNDS = 3;

export const __testing = {
  buildPrimaryPrompt,
  buildReReviewPrompt,
  buildAnchorFeedbackPrompt,
  StageTimeout,
};

/** Minimal structural view of a settled child task's outcome, narrowed in
 * the publish phase (pi-durable's TaskOutcome union). */
interface TaskOutcomeLike {
  readonly status: "completed" | "failed" | "aborted" | "orphaned" | "faulted";
  readonly result?: unknown;
  readonly error?: { message: string };
  readonly reason?: string;
}

export type { RunPhase };
