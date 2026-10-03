/**
 * Durable review task: pi-durable task `nitpi.review`, one per run.
 *
 * Phases (pipeline, spec "Pi Durable mapping"):
 *   primary → freeze artifact → re-review → final frozen → publish → published
 *
 * Instructions per stage come from the resolved protocol + policy + repository
 * layers (instructions.ts). The primary turn runs in the canonical PR
 * conversation; the re-reviewer runs in a fresh task-owned conversation
 * created by this task with explicit agent configuration, on its own unchanged
 * checkout. It receives the frozen artifact plus repository and PR inputs —
 * never the primary transcript. After the final review is frozen, one more
 * matching-only turn in that same conversation assigns current findings to
 * earlier published comment IDs (ticket 04); the publisher then keeps the
 * pull request's threads in sync.
 *
 * Module dependencies (`installReviewTaskDeps`) exist because pi-durable
 * resolves task definitions from the registry at invocation: the process-wide
 * host wires registry + publisher once before the harness starts work.
 */
import type { Context } from "@earendil-works/chord";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import { createHash } from "node:crypto";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { Publisher, PublishError } from "../github/publisher.js";
import type { GitHubApi } from "../github/publisher.js";
import { parseFinalReview } from "./artifact.js";
import {
  buildMatchPrompt,
  matchableComments,
  parseMatchList,
  type FindingMatch,
} from "./matching.js";
import type { ReviewHostConfig } from "./config.js";
import type { ResolvedInstructions } from "./instructions.js";
import type { RunDocument, RunHistory, StageUsage } from "./run-history.js";

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
}

export interface ReviewCheckpoint {
  phase: "primary" | "re-review" | "match" | "publish";
}

export type ReviewTaskResult =
  | { readonly published: true; readonly reviewId: number }
  | { readonly published: false; readonly reason: string };

export const reviewTask = defineTask<ReviewTaskInput, ReviewCheckpoint, ReviewTaskResult, object>({
  name: "nitpi.review",
  version: 1,
  initial: () => ({ phase: "primary" as const }),
  phases: {
    primary: async (task, runtime, context) => {
      try {
        const host = reviewTaskDeps();
        const runDoc = await host.runHistory.findRun(task.input.runId, context);
        if (!runDoc) throw new Error(`run ${task.input.runId} is not recorded`);
        const canonical = await harnessConversation(host.runHistory.harness, task.input.canonicalConversationId);

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

        // Primary turn: one prompt, run to completion, Pi keeps the tool loop.
        const prompt = buildPrimaryPrompt(runDoc);
        await runConversationTurn(canonical, prompt, context);

        // Freeze the hand-off: stored unchanged as free-form text.
        const answer = await latestAssistant(canonical, context);
        const artifact = answer?.text ?? "";
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          artifact,
          artifactFrozen: true,
          phase: "primary frozen",
          instructionHashes: { ...run.instructionHashes, primary: sha256(instructions.text) },
          usage: { ...run.usage, primary: answer?.usageSummary },
        }));

        await runtime.commit(
          (_tx, current) => ({
            status: "running" as const,
            checkpoint: { ...current.state.checkpoint, phase: "re-review" as const },
          }),
          context,
        );
      } catch (error) {
        await failRun(task.input.runId, context, error);
      }
    },

    "re-review": async (task, runtime, context) => {
      try {
        const host = reviewTaskDeps();
        const runDoc = await host.runHistory.findRun(task.input.runId, context);
        if (!runDoc) throw new Error(`run ${task.input.runId} is not recorded`);
        if (!runDoc.artifact) throw new Error("primary artifact is not frozen");

        // The check keeps showing the current stage while running.
        await new Publisher(host.api).checkInProgress(runDoc.subject, "re-review");

        // Fresh task-owned conversation for the re-reviewer. The commit makes
        // durable progress by creating the conversation; the task checkpoint
        // changes at the phase boundary below.
        let createdId: string | undefined;
        await runtime.commit(async (tx) => {
          const record = await tx.createConversation({
            ownership: { kind: "task", taskId: runtime.taskId },
          });
          createdId = record.id as unknown as string;
        }, context);
        const conversation = await harnessConversation(host.runHistory.harness, createdId!);
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
        await runConversationTurn(conversation, prompt, context);

        const answer2 = await latestAssistant(conversation, context);
        const finalMarkdown = answer2?.text ?? "";
        const parsed = parseFinalReview(finalMarkdown);
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          finalReview: finalMarkdown,
          auditNotes: parsed.auditNotes,
          findings: parsed.findings,
          phase: "final frozen",
          instructionHashes: { ...run.instructionHashes, reReview: sha256(instructions.text) },
          usage: { ...run.usage, reReview: answer2?.usageSummary },
        }));

        await runtime.commit(
          (_tx, current) => ({
            status: "running" as const,
            checkpoint: { ...current.state.checkpoint, phase: "match" as const },
          }),
          context,
        );
      } catch (error) {
        await failRun(task.input.runId, context, error);
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

        await runtime.commit(
          (_tx, current) => ({
            status: "running" as const,
            checkpoint: { ...current.state.checkpoint, phase: "publish" as const },
          }),
          context,
        );
      } catch (error) {
        await failRun(task.input.runId, context, error);
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
          runDoc.earlierComments ?? [],
          runDoc.matches ?? [],
          context.abortSignal,
        );
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          publication: { reviewId: published.reviewId, commentIds: published.commentIds },
          matchRejections: published.rejections,
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
        const reason = error instanceof PublishError ? error.message : errorText(error);
        try {
          await publisher.checkFailure(subject, reason);
        } catch {
          // checkFailure failing must not mask the publication reason.
        }
        await commitRunUpdateSafe(host, task.input.runId, context, (run) => ({
          ...run,
          phase: "publishing",
          checkStatus: "failure",
          checkDetail: reason,
          error: reason,
        }));
        await runtime.commit(
          (_tx) =>
            ({
              status: "terminal" as const,
              outcome: { status: "failed" as const, error: { message: reason } },
            }) as const,
          context,
        );
      }
    },
  },
  abort: async (_task, runtime, context) => {
    // Durable cancellation: nothing publishes after abort (ticket 09 refines
    // the fence; v0 keeps the terminal marker).
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

/** Record a stage failure on the run document and GitHub, then rethrow so the
 * durable task faults with the reason. No provisional findings are published. */
async function failRun(
  runId: string,
  context: Context,
  error: unknown,
): Promise<never> {
  const host = reviewTaskDeps();
  const reason = errorText(error);
  const runDoc = await host.runHistory.findRun(runId, context);
  try {
    if (runDoc) {
      await new Publisher(host.api).checkFailure(runDoc.subject, reason);
    }
  } catch {
    // checkFailure itself failing must not mask the original reason.
  }
  await commitRunUpdateSafe(host, runId, context, (run) => ({
    ...run,
    checkStatus: "failure",
    checkDetail: reason,
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
    // If the run doc cannot be updated, the rethrow in the caller still
    // surfaces the original failure through the task.
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

async function runConversationTurn(conversation: Conversation, prompt: string, context: Context): Promise<void> {
  const submission = await conversation.submit({ type: "input", content: prompt }, context);
  const settled = await submission.wait(context);
  if (settled.status === "unanswered") {
    const detail = settled.detail === undefined ? undefined : String(settled.detail);
    throw new Error(detail ?? `model turn did not answer (${settled.reason})`);
  }
}

export interface TurnAnswer {
  text: string;
  /** Usage of the assistant message that settled the turn. */
  usageSummary: { input: number; output: number; totalTokens: number };
}

/** The newest assistant entry with text. Entry pages are newest-first, so
 * return the first hit found; tool-only assistant messages (no text) are
 * skipped, so the loop keeps walking past them to the newest turn that
 * actually answered. */
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
  return [
    `Review pull request #${run.subject.pullNumber} in repository ${run.subject.repository}.`,
    `Reviewed head: ${run.subject.headSha} (base: ${run.subject.baseSha}).`,
    `Mode: ${run.mode}. Use your tools on this checkout; do not push, commit or edit the pull request.`,
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
    `Write your final review (one finding per section with an inline location "path | SIDE | line") followed by "# Audit notes".`,
  ].join("\n");
}

export const __testing = { buildPrimaryPrompt, buildReReviewPrompt };
