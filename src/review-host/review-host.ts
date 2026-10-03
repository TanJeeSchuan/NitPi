/**
 * Review host: wires storage, pi-ai models, the durable harness, and the
 * review pipeline behind the spec's single test seam — the review host's
 * process boundary.
 *
 * Everything inside the host runs for real: Pi Durable (SQLite file), the
 * provider bridge, run documents, and the publisher (HTTP to GitHub).
 */
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { Harness, createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RestGitHubApi } from "../github/rest-api.js";
import { createBridgedProvider } from "../pi-bridge/provider-bridge.js";
import { resolveConfig, type ReviewHostConfig } from "./config.js";
import { resolveInstructions } from "./instructions.js";
import { RunHistory } from "./run-history.js";
import type { ConversationId } from "@earendil-works/pi-durable";
import { installReviewTaskDeps, reviewTask, type ReviewRunRequest, type ReviewTaskDeps } from "./review-task.js";

export interface ReviewHost {
  /** Trigger gate (`/review`): starts exactly one durable run for the head. */
  startReview(request: ReviewRunRequest): Promise<{ runId: string; conversationId: string }>;
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
  models.setProvider(createBridgedProvider({ stage: "primary", baseUrl: config.primary.baseUrl, modelId: config.primary.modelId, apiKey: config.primary.apiKey, providerOptions: config.primary.providerOptions }));
  models.setProvider(createBridgedProvider({ stage: "re-review", baseUrl: config.reReview.baseUrl, modelId: config.reReview.modelId, apiKey: config.reReview.apiKey, providerOptions: config.reReview.providerOptions }));

  const registry = createRegistry<ToolRegistration>();
  registry.install(CodingTools);
  registry.install({ name: "nitpi-review", tools: [], sections: [], tasks: [reviewTask], hooks: [], wraps: [] });

  const harness = await Harness.open(storage, {
    models,
    registry,
    settings: {
      extensions: [],
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 32_768 },
      stream: { timeoutMs: 300_000 },
      retry: { enabled: true, maxRetries: 0 },
      toolExecution: "parallel",
    },
    env: (target) => nodeEnv(target.cwd ?? process.cwd()),
  }, TODO_CONTEXT);

  const runHistory = new RunHistory(harness);
  const deps: ReviewTaskDeps = {
    config,
    runHistory,
    api: new RestGitHubApi(config.githubBaseUrl, config.githubToken),
    getInstructions: (role) => resolveInstructions(role, role === "primary" ? config.primary : config.reReview, config.repositoryInstructions),
  };
  installReviewTaskDeps(deps);
  harness.resume();

  return new ReviewHostImpl(harness, runHistory, models, config);
}

class ReviewHostImpl implements ReviewHost {
  private activeRuns = new Map<string, Promise<void>>();
  private canonicalIds = new Map<string, string>();

  constructor(
    private readonly harness: Harness,
    private readonly history: RunHistory,
    private readonly models: Models,
    private readonly config: ReviewHostConfig,
  ) {}

  async startReview(request: ReviewRunRequest): Promise<{ runId: string; conversationId: string }> {
    const context = TODO_CONTEXT;
    const canonicalKey = `${request.repository}#${request.pullNumber}`;
    let canonicalId = this.canonicalIds.get(canonicalKey);
    if (!canonicalId) {
      const primaryInstructions = resolveInstructions("primary", this.config.primary, this.config.repositoryInstructions);
      const canonical = await this.history.createCanonicalConversation(
        request,
        { modelId: this.config.primary.modelId, instructions: primaryInstructions.text },
        context,
      );
      canonicalId = canonical.id as unknown as string;
      this.canonicalIds.set(canonicalKey, canonicalId);
    }

    const started = await this.harness.commit(async (tx) => {
      const run: RunDocumentShape = {
        kind: "nitpi.run",
        version: 1,
        runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        mode: "normal",
        phase: "primary",
        subject: {
          repository: request.repository,
          pullNumber: request.pullNumber,
          baseSha: request.baseSha,
          headSha: request.headSha,
        },
        artifactFrozen: false,
        checkStatus: "in progress",
        checkDetail: `stage: primary · head ${request.headSha.slice(0, 12)}`,
        canonicalConversationId: canonicalId!,
      };
      await this.history.record(tx, run);
      const taskId = await tx.createTask(
        reviewTask,
        { runId: run.runId, canonicalConversationId: canonicalId!, request },
        { ownership: { kind: "conversation" }, conversationId: canonicalId as unknown as ConversationId, },
      );
      return { runId: run.runId, taskId };
    }, context);

    this.activeRuns.set(
      started.runId,
      this.harness.waitForTask(started.taskId, TODO_CONTEXT).then(() => undefined),
    );
    return { runId: started.runId, conversationId: canonicalId as unknown as string };
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

type RunDocumentShape = Parameters<RunHistory["record"]>[1];

function nodeEnv(cwd: string) {
  // Real execution environment: shell + file access rooted at the stage's
  // unchanged checkout of the reviewed head.
  return new NodeExecutionEnv({ cwd, shellEnv: process.env }) as never;
}
