/**
 * Review host: wires storage, pi-ai models, the durable harness, and the
 * review pipeline behind the spec's single test seam — the review host's
 * process boundary.
 *
 * Everything inside the host runs for real: Pi Durable (SQLite file), the
 * provider bridge, run documents, per-stage checkouts, and the publisher
 * (HTTP to GitHub).
 *
 * Trigger gate (ticket 01's minimal gate; the full gate is ticket 03):
 * the requester must be a collaborator with write access, the pull request
 * must be open, and at most one run exists per reviewed head.
 */
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { Harness, createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RestGitHubApi } from "../github/rest-api.js";
import { Publisher } from "../github/publisher.js";
import { createBridgedProvider } from "../pi-bridge/provider-bridge.js";
import { ensureStageCheckouts, CheckoutError } from "./checkouts.js";
import { isFullSha, resolveConfig, type ReviewHostConfig } from "./config.js";
import { resolveInstructions } from "./instructions.js";
import { RunHistory, type RunDocument } from "./run-history.js";
import { type GitHubApi } from "../github/publisher.js";
import {
  installReviewTaskDeps,
  reviewTask,
  type ReviewRunRequest,
  type ReviewTaskDeps,
} from "./review-task.js";

export interface ReviewHost {
  /**
   * Trigger gate entry: a writer's `/review` — or `/review clean` (ticket
   * 07). Resolves the pull request, checks eligibility, and starts exactly
   * one durable run for the current head. Rejects with a reason when the
   * request is refused.
   */
  handleReviewCommand(command: {
    repository: string;
    pullNumber: number;
    requester: string;
    /** The command text; the default is `/review`. `/review clean` starts a
     * run in mode `clean`, which reviews from fresh task-owned
     * conversations and imports only its completed report once frozen. */
    commandText?: string;
  }): Promise<{ runId: string; refused?: string; conversationId: string }>;
  /** Resolves when the run's durable task reaches a terminal state. */
  waitForRun(runId: string): Promise<void>;
  /** Aggregate Pi usage for assertion by tests. */
  usage(): Promise<Awaited<ReturnType<RunHistory["usage"]>>>;
  runHistory(): RunHistory;
  close(): Promise<void>;
}

export async function openReviewHost(
  workflowInputConfig: ReviewHostConfig,
  sqliteFile: string,
): Promise<ReviewHost> {
  const config = resolveConfig(workflowInputConfig);
  const storage = await openNodeSqliteStorage(sqliteFile, { busyTimeoutMs: 5_000 });

  const models = createModels();
  models.setProvider(
    createBridgedProvider({
      stage: "primary",
      baseUrl: config.primary.baseUrl,
      modelId: config.primary.modelId,
      apiKey: config.primary.apiKey,
      providerOptions: config.primary.providerOptions,
    }),
  );
  models.setProvider(
    createBridgedProvider({
      stage: "re-review",
      baseUrl: config.reReview.baseUrl,
      modelId: config.reReview.modelId,
      apiKey: config.reReview.apiKey,
      providerOptions: config.reReview.providerOptions,
    }),
  );

  const registry = createRegistry<ToolRegistration>();
  registry.install(CodingTools);
  registry.install({ name: "nitpi-review", tools: [], sections: [], tasks: [reviewTask], hooks: [], wraps: [] });

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: {
        // Absent: every installed extension (CodingTools) is selected.
        compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 32_768 },
        stream: { timeoutMs: 300_000 },
        retry: { enabled: true, maxRetries: 0 },
        toolExecution: "parallel",
      },
      env: (target) => nodeEnv(target.cwd ?? process.cwd()),
    },
    TODO_CONTEXT,
  );

  const runHistory = new RunHistory(harness);
  const deps: ReviewTaskDeps = {
    config,
    runHistory,
    api: new RestGitHubApi(config.githubBaseUrl, config.githubToken),
    getInstructions: (role) => resolveInstructions(role, config.repositoryInstructions),
  };
  installReviewTaskDeps(deps);
  harness.resume();

  return new ReviewHostImpl(harness, runHistory, models, config, deps.api);
}

class ReviewHostImpl implements ReviewHost {
  private activeRuns = new Map<string, Promise<void>>();

  constructor(
    private readonly harness: Harness,
    private readonly history: RunHistory,
    private readonly models: Models,
    private readonly config: ReviewHostConfig,
    private readonly api: GitHubApi,
  ) {}

  async handleReviewCommand(command: {
    repository: string;
    pullNumber: number;
    requester: string;
    commandText?: string;
  }): Promise<{ runId: string; refused?: string; conversationId: string }> {
    const context = TODO_CONTEXT;
    const parsed = parseReviewCommand(command.commandText ?? "/review");
    if (!parsed) {
      return {
        runId: "",
        refused: `unknown review command: ${command.commandText} (expected /review or /review clean)`,
        conversationId: "",
      };
    }
    // Same repository: the host is configured for exactly one repository.
    if (command.repository !== this.config.repository) {
      return { runId: "", refused: `reviewer is not configured for ${command.repository}`, conversationId: "" };
    }

    // The pull request must be open.
    const pr = await this.api.getPullRequest(command.repository, command.pullNumber);
    if (pr.status !== 200) {
      return { runId: "", refused: `pull request not found (HTTP ${pr.status})`, conversationId: "" };
    }
    const prBody = pr.body as { state?: string; head?: { sha?: string }; base?: { sha?: string } };
    if (prBody.state !== "open") {
      return { runId: "", refused: "pull request is not open", conversationId: "" };
    }

    // Only collaborators with write access may request reviews.
    const permission = await this.api.getCollaboratorPermission(command.repository, command.requester);
    if (permission.status !== 200) {
      return { runId: "", refused: `cannot read permission for ${command.requester}`, conversationId: "" };
    }
    const level = (permission.body as { permission?: string }).permission ?? "none";
    if (level !== "write" && level !== "admin") {
      return { runId: "", refused: `${command.requester} does not have write access`, conversationId: "" };
    }

    const headSha = prBody.head?.sha;
    const baseSha = prBody.base?.sha;
    if (!isFullSha(headSha) || !isFullSha(baseSha)) {
      return { runId: "", refused: "pull request SHAs unavailable", conversationId: "" };
    }

    // At most one run per reviewed head: an in-progress run for the same head
    // satisfies the request instead of starting a second one.
    const subject = {
      repository: command.repository,
      pullNumber: command.pullNumber,
      baseSha: baseSha!,
      headSha: headSha!,
    };
    const existing = (await this.history.allRuns(context)).find(
      (r) => r.subject.headSha === subject.headSha && r.checkStatus === "in progress",
    );
    if (existing) {
      return { runId: existing.runId, conversationId: existing.canonicalConversationId };
    }

    // Per-stage unchanged checkouts of the reviewed head.
    const checkouts = ensureStageCheckouts(this.config.headCheckoutSource, subject.headSha);

    // The check shows in progress with the head and current stage while running.
    await new Publisher(this.api).checkInProgress(subject, "primary");

    // The canonical PR conversation is durable state, shared by every run of
    // this PR (recovered from the runs registry on reopen).
    let canonicalId = await this.history.findCanonicalConversation(
      subject.repository,
      subject.pullNumber,
      context,
    );
    if (!canonicalId) {
      const primaryInstructions = resolveInstructions("primary", this.config.repositoryInstructions);
      const canonical = await this.history.createCanonicalConversation(
        { modelId: this.config.primary.modelId, instructions: primaryInstructions.text },
        context,
      );
      canonicalId = canonical.id as unknown as string;
    }

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const request = toRunRequest(subject, parsed.commandText);
    const started = await this.harness.commit(async (tx) => {
      const taskId = await tx.createTask(
        reviewTask,
        { runId, canonicalConversationId: canonicalId!, request },
        // Task ownership sits on the canonical conversation in both modes:
        // it is host machinery. A clean run's REVIEWER conversations are the
        // fresh task-owned ones created inside the pipeline (review-task).
        { ownership: { kind: "conversation" }, conversationId: canonicalId as never },
      );
      const run: RunDocument = {
        kind: "nitpi.run",
        version: 1,
        runId,
        mode: parsed.mode,
        phase: "primary",
        subject,
        pipelineTaskId: taskId as unknown as string,
        canonicalConversationId: canonicalId!,
        artifactFrozen: false,
        checkStatus: "in progress",
        checkDetail: "stage: primary",
        checkouts,
        repositoryInstructionsRevision: this.config.repositoryInstructionsRevision,
      };
      await this.history.record(tx, run);
      return { runId, taskId };
    }, context);

    this.activeRuns.set(
      started.runId,
      this.harness.waitForTask(started.taskId, TODO_CONTEXT).then(() => undefined),
    );
    return { runId: started.runId, conversationId: canonicalId! };
  }

  async waitForRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) throw new Error(`unknown run ${runId}`);
    try {
      await active;
      // Surface terminal failures/aborts as errors on the host seam.
      const run = await this.history.findRun(runId, TODO_CONTEXT);
      if (run?.error) throw new Error(run.error);
      if (run?.checkStatus === "failure") throw new Error(run.checkDetail ?? "review failed");
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  async usage() {
    return this.history.usage(TODO_CONTEXT);
  }

  runHistory(): RunHistory {
    return this.history;
  }

  async close(): Promise<void> {
    const pending = [...this.activeRuns.values()];
    this.activeRuns.clear();
    await Promise.allSettled(pending);
    await this.harness.close(TODO_CONTEXT);
  }
}

function toRunRequest(subject: RunDocument["subject"], commandText: string): ReviewRunRequest {
  return {
    repository: subject.repository,
    pullNumber: subject.pullNumber,
    baseSha: subject.baseSha,
    headSha: subject.headSha,
    command: commandText as ReviewRunRequest["command"],
  };
}

/** `/review` → mode normal; `/review clean` → mode clean (ticket 07). Any
 * other spelling is refused before any GitHub call. */
function parseReviewCommand(text: string): { mode: "normal" | "clean"; commandText: string } | undefined {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized === "/review") return { mode: "normal", commandText: "/review" };
  if (normalized === "/review clean") return { mode: "clean", commandText: "/review clean" };
  return undefined;
}

function nodeEnv(cwd: string) {
  // Real execution environment: shell + file tools rooted at the reviewer's
  // unchanged checkout of the reviewed head.
  return new NodeExecutionEnv({ cwd, shellEnv: process.env }) as never;
}

export { CheckoutError };
