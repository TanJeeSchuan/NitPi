/**
 * Durable review task: pi-durable task `nitpi.review`, one per run.
 *
 * Phases (pipeline, spec "Pi Durable mapping"):
 *   primary → freeze artifact → re-review → final frozen → publish → published
 *
 * Instructions per stage come from the resolved protocol + policy +
 * repository layers (instructions.ts). The primary turn runs in the canonical
 * PR conversation; the re-reviewer runs in a task-owned conversation (reused
 * when an interrupted attempt already recorded one) with explicit agent
 * configuration, on its own unchanged checkout. It receives the frozen
 * artifact plus repository and PR inputs — never the primary transcript.
 *
 * Recovery (ticket 06): the task's checkpoint is the pipeline phase. On
 * reopen (an Actions re-run) a surviving run resumes from its last durable
 * checkpoint, and the run document itself decides what is already durable:
 * a frozen artifact means the re-review stage; a frozen final review means
 * publication. After a completed primary stage, no new primary model calls
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
 * Module dependencies (`installReviewTaskDeps`) exist because pi-durable
 * resolves task definitions from the registry at invocation: the process-wide
 * host wires registry + publisher once before the harness starts work.
 */
import type { Context } from "@earendil-works/chord";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import { createHash } from "node:crypto";
import type { Conversation, Harness, Submission } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { Publisher, PublishError } from "../github/publisher.js";
import type { GitHubApi } from "../github/publisher.js";
import { parseFinalReview } from "./artifact.js";
import {
  parseUnifiedDiffAnchors,
  validateFindingAnchors,
  type InvalidAnchor,
} from "./anchor-validation.js";
import type { ReviewHostConfig } from "./config.js";
import type { ResolvedInstructions } from "./instructions.js";
import type { RunDocument, RunHistory, RunPhase } from "./run-history.js";

export interface ReviewRunRequest {
  readonly repository: string;
  readonly pullNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  /** `/review` only in ticket 01 (`clean` is ticket 07, `cancel` ticket 09). */
  readonly command: "/review";
}

/** Process-wide host wiring consumed by task phases. */
export interface ReviewTaskDeps {
  readonly config: ReviewHostConfig;
  readonly runHistory: RunHistory;
  readonly api: GitHubApi;
  getInstructions(role: "primary" | "re-review"): ResolvedInstructions;
  /** Duration in milliseconds after which a stage fails as incomplete. */
  stageDeadline(stage: "primary" | "re-review"): number;
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
  readonly initialPhase?: "primary" | "re-review" | "publish";
}

export interface ReviewCheckpoint {
  phase: "primary" | "re-review" | "publish";
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
        const canonical = await harnessConversation(host.runHistory.harness, task.input.canonicalConversationId);

        // Cross-commit boundary recovery: the artifact froze but the task
        // still points at the primary phase → primary model work is done and
        // must not run again; continue with the re-review stage.
        if (runDoc.artifactFrozen && runDoc.artifact) {
          await runtime.commit(
            (_tx, current) => ({
              status: "running" as const,
              checkpoint: { ...current.state.checkpoint, phase: "re-review" as const },
            }),
            context,
          );
          return;
        }

        // Primary instructions: protocol + policy + repository layers, with
        // the content hash recorded on the run document.
        const instructions = host.getInstructions("primary");
        await configureConversation(
          canonical,
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
        await runConversationTurn(canonical, prompt, context, host, "primary");

        // Freeze the hand-off: stored unchanged as free-form text.
        const answer = await latestAssistant(canonical, context);
        const artifact = answer?.text ?? "";
        await commitRunUpdate(host, task.input.runId, context, (run) => {
          // Strict JSON documents: an absent key (not an undefined value).
          const usage = { ...run.usage };
          if (answer?.usageSummary) usage.primary = answer.usageSummary;
          return {
            ...run,
            artifact,
            artifactFrozen: true,
            phase: "primary frozen",
            instructionHashes: { ...run.instructionHashes, primary: sha256(instructions.text) },
            usage,
          };
        });

        await runtime.commit(
          (_tx, current) => ({
            status: "running" as const,
            checkpoint: { ...current.state.checkpoint, phase: "re-review" as const },
          }),
          context,
        );
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
        // still points at re-review → go straight to publication.
        if (runDoc.finalReview) {
          await runtime.commit(
            (_tx, current) => ({
              status: "running" as const,
              checkpoint: { ...current.state.checkpoint, phase: "publish" as const },
            }),
            context,
          );
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
        const instructions = host.getInstructions("re-review");
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

        await commitRunUpdate(host, task.input.runId, context, (run) => {
          const usage = { ...run.usage };
          if (answer?.usageSummary) usage.reReview = answer.usageSummary;
          return {
            ...run,
            finalReview: answer?.text ?? "",
            auditNotes: parsed.auditNotes,
            findings: parsed.findings,
            phase: "final frozen",
            anchorRounds,
            instructionHashes: { ...run.instructionHashes, reReview: sha256(instructions.text) },
            usage,
          };
        });

        await runtime.commit(
          (_tx, current) => ({
            status: "running" as const,
            checkpoint: { ...current.state.checkpoint, phase: "publish" as const },
          }),
          context,
        );
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
        await publisher.checkInProgress(subject, "publish");
        const published = await publisher.publish(
          runDoc,
          runDoc.finalReview,
          runDoc.findings ?? [],
          context.abortSignal,
        );
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          publication: { reviewId: published.reviewId, commentIds: published.commentIds },
          phase: "published",
          checkStatus: "success",
          checkDetail: `published review ${published.reviewId} with ${run.findings?.length ?? 0} finding(s)`,
        }));
        await publisher.checkSuccess(subject, runDoc.findings?.length ?? 0);
        await runtime.commit(
          (_tx) =>
            ({
              status: "terminal" as const,
              outcome: {
                status: "completed" as const,
                result: { published: true, reviewId: published.reviewId },
              },
            }) as const,
          context,
        );
      } catch (error) {
        if (isKilledInvocation(runtime)) return; // A dead runner records nothing.
        // Record the failure on the run document and GitHub. Storage being
        // down must not itself turn into a crash here: the run doc update is
        // best-effort, and the check still reports a reason.
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

/**
 * Newest assistant entry with text, scanning newest-first. Entries arrive
 * newest-first; the first assistant entry carrying text is the answer (the
 * ticket-02 fix: an earlier turn's text must never win over the newest).
 */
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

export type { RunPhase };
