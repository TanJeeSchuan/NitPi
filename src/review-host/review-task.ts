/**
 * Durable review task: pi-durable task `nitpi.review`, one per run.
 *
 * Phases (pipeline, spec "Pi Durable mapping"):
 *   primary → freeze artifact → re-review → final frozen → publish → published
 *
 * Instructions per stage come from the resolved protocol + policy + repository
 * layers (instructions.ts). The primary turn runs in the canonical PR
 * conversation; the re-reviewer runs in a fresh conversation created by this
 * task with explicit agent configuration.
 *
 * Module dependencies (`installReviewTaskDeps`) exist because pi-durable
 * resolves task definitions from the registry at invocation: the process-wide
 * host wires registry + publisher once before the harness starts work.
 */
import type { Context } from "@earendil-works/chord";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import { defineTask } from "@earendil-works/pi-durable";
import { Publisher, PublishError } from "../github/publisher.js";
import type { GitHubApi } from "../github/publisher.js";
import { parseFinalReview, type ParsedFinding } from "./artifact.js";
import type { ReviewHostConfig } from "./config.js";
import type { ResolvedInstructions } from "./instructions.js";
import type { RunDocument, RunHistory, RunReviewFinding } from "./run-history.js";

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
  phase: "primary" | "re-review" | "publish";
}

export type ReviewTaskResult =
  | { readonly published: true; readonly reviewId: number }
  | { readonly published: false; readonly reason: string };



/** Record a stage failure on the run document and GitHub, then rethrow so the
 * durable task faults with the reason. No provisional findings are published. */
async function failRun(
  runId: string,
  context: Context,
  phase: string,
  error: unknown,
): Promise<never> {
  const host = reviewTaskDeps();
  const reason = describe(error);
  const runDoc = await host.runHistory.findRun(runId, context);
  try {
    if (runDoc) {
      const publisher = new Publisher(host.api);
      await publisher.checkFailure(host.config.repository, runDoc.subject.headSha, reason);
    }
  } catch {
    // checkFailure itself failing must not mask the original reason.
  }
  await commitRunUpdateSafe(host, runId, context, (run) => ({
    ...run,
    phase: phase === "publish" ? "publishing" : run.phase,
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
    // If the run doc cannot be updated (storage failure), the throw above still
    // surfaces the original failure through the task.
  }
}

export const reviewTask = defineTask<
  ReviewTaskInput,
  ReviewCheckpoint,
  ReviewTaskResult,
  object
>({
  name: "nitpi.review",
  version: 1,
  initial: (input) => ({ phase: "primary" as const }),
  phases: {
    primary: async (task, runtime, context) => {
      try {
        const host = reviewTaskDeps();
        const runDoc = await host.runHistory.findRun(task.input.runId, context);
        if (!runDoc) throw new Error(`run ${task.input.runId} is not recorded`);
        const canonical = await harnessConversation(host.runHistory.harness, task.input.canonicalConversationId);

        // Primary instructions: protocol + policy + repository layers.
        const instructions = host.getInstructions("primary");
        await configureConversation(canonical, "nitpi-primary", host.config.primary.modelId, instructions.text, context);

        // Primary turn: one prompt, run to completion, Pi keeps the tool loop.
        const prompt = buildPrimaryPrompt(host.config, runDoc);
        await runConversationTurn(canonical, prompt, context);

        // Freeze the hand-off: stored unchanged as free-form text.
        const answer = await latestAssistant(canonical, context);
        const artifact = answer?.text ?? "";
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          artifact,
          artifactFrozen: true,
          phase: "primary frozen" as const,
          usage: { ...run.usage, primary: answer?.usageSummary },
        }));

        await runtime.commit(
          (_tx, current) => ({ status: "running" as const, checkpoint: { ...current.state.checkpoint, phase: "re-review" as const } }),
          context,
        );
      } catch (error) {
        if (isAbort(error)) throw error;
        await failRun(task.input.runId, context, "primary", error);
      }
    },

    "re-review": async (task, runtime, context) => {
      try {
      const host = reviewTaskDeps();
      const runDoc = await host.runHistory.findRun(task.input.runId, context);
      if (!runDoc) throw new Error(`run ${task.input.runId} is not recorded`);
      if (!runDoc.artifact) throw new Error("primary artifact is not frozen");

      // Fresh task-owned conversation for the re-reviewer. It receives the
      // frozen artifact plus repository and PR inputs — never the primary
      // transcript.
      const instructions = host.getInstructions("re-review");
      const conversation = await host.runHistory.createReReviewConversation(
        task.input.runId,
        host.config.reReview.modelId,
        instructions.text,
        context,
      );
      await commitRunUpdate(host, task.input.runId, context, (run) => ({
        ...run,
        reReviewConversationId: conversation.id as unknown as string,
      }));

      const prompt = buildReReviewPrompt(host.config, runDoc);
      await runConversationTurn(conversation, prompt, context);

      const answer2 = await latestAssistant(conversation, context);
      const finalMarkdown = answer2?.text ?? "";
      const parsed = parseFinalReview(finalMarkdown);
      await commitRunUpdate(host, task.input.runId, context, (run) => ({
        ...run,
        finalReview: finalMarkdown,
        auditNotes: parsed.auditNotes,
        findings: parsed.findings.map(toRunFinding),
        phase: "final frozen" as const,
        usage: { ...run.usage, reReview: answer2?.usageSummary },
      }));

      await runtime.commit(
        (_tx, current) => ({ status: "running" as const, checkpoint: { ...current.state.checkpoint, phase: "publish" as const } }),
        context,
      );
      } catch (error) {
        if (isAbort(error)) throw error;
        await failRun(task.input.runId, context, "re-review", error);
      }
    },

    publish: async (task, runtime, context) => {
      const host = reviewTaskDeps();
      const runDoc = await host.runHistory.findRun(task.input.runId, context);
      if (!runDoc?.finalReview) throw new Error("final review is not frozen");
      const publisher = new Publisher(host.api);
      const repository = host.config.repository;
      const headSha = runDoc.subject.headSha;

      try {
        await publisher.checkInProgress(repository, headSha, "publish");
        const published = await publisher.publish(
          repository,
          host.config.pullNumber,
          runDoc,
          runDoc.finalReview,
          (runDoc.findings ?? []).map(fromRunFinding),
          context.abortSignal,
        );
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          publication: { reviewId: published.reviewId, commentIds: published.commentIds },
          phase: "published" as const,
          checkStatus: "success" as const,
          checkDetail: `published review ${published.reviewId} with ${run.findings?.length ?? 0} finding(s)`,
        }));
        await publisher.checkSuccess(repository, headSha, runDoc.findings?.length ?? 0);
        await runtime.commit(
          (_tx) =>
            ({
              status: "terminal" as const,
              outcome: { status: "completed" as const, result: { published: true, reviewId: published.reviewId } },
            }) as const,
          context,
        );
      } catch (error) {
        const reason = error instanceof PublishError ? error.message : describe(error);
        await publisher.checkFailure(repository, headSha, reason);
        await commitRunUpdate(host, task.input.runId, context, (run) => ({
          ...run,
          phase: "publishing" as const,
          checkStatus: "failure" as const,
          checkDetail: reason,
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
  context: Context,
): Promise<void> {
  await conversation.configure(
    { model: { provider, modelId }, instructions },
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

async function latestAssistant(conversation: Conversation, context: Context): Promise<TurnAnswer | undefined> {
  const page = await conversation.entries({ conversationId: conversation.id } as never, 20, undefined, context);
  for (const entry of page.items) {
    if (entry.kind === "pi.assistant") {
      const model = entry.model ?? [];
      for (const message of model) {
        if (message.role === "assistant") {
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
    }
  }
  return undefined;
}

function toRunFinding(finding: ParsedFinding): RunReviewFinding {
  return {
    label: finding.label,
    section: finding.section,
    path: finding.path,
    side: finding.side,
    line: finding.line,
  };
}

function fromRunFinding(finding: RunReviewFinding): ParsedFinding {
  return {
    label: finding.label,
    section: finding.section,
    path: finding.path,
    side: finding.side,
    line: finding.line,
  };
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

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildPrimaryPrompt(_config: ReviewHostConfig, run: RunDocument): string {
  return [
    `Review pull request #${run.subject.pullNumber} in repository ${run.subject.repository}.`,
    `Reviewed head: ${run.subject.headSha} (base: ${run.subject.baseSha}).`,
    `Mode: ${run.mode}. Use your tools on this checkout; do not push or commit anything.`,
    `Finish with your free-form review artifact as your final assistant message.`,
  ].join("\n");
}

function buildReReviewPrompt(_config: ReviewHostConfig, run: RunDocument): string {
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

export const __testing = { buildPrimaryPrompt, buildReReviewPrompt, latestAssistant };
