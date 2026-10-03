/**
 * Review host: wires the storage service, pi-ai models, the durable harness,
 * and the review pipeline behind the spec's single test seam — the review
 * host's process boundary.
 *
 * Everything inside the host runs for real: Pi Durable against the storage
 * service (ticket 06: state lives on the homelab, partitioned by repository
 * and PR — never on the runner), the provider bridge, run documents,
 * per-stage checkouts, and the publisher (HTTP to GitHub).
 *
 * Durable recovery (ticket 06):
 * - The host opens one partition of the storage service. A second opener
 *   while the lease is live is refused (`StorageInUse`) — one process owns a
 *   PR's storage at a time.
 * - `handleReviewCommand` resumes an interrupted attempt instead of starting
 *   a second one: an in-progress run for the same head is joined (its
 *   recorded pipeline task survives reopen and resumes at the last durable
 *   checkpoint); a failed run for the same head starts a new durable task
 *   that picks up where the run document's already-frozen work is. A
 *   published head stays published.
 * - Every model stage has a deadline; a timed-out reviewer fails the stage
 *   as incomplete and the durable work is kept for a re-run.
 *
 * Trigger gate (ticket 01's minimal gate; the full gate is ticket 03):
 * the requester must be a collaborator with write access, and the pull
 * request must be open.
 */
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { Harness, createRegistry, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { RestGitHubApi } from "../github/rest-api.js";
import { Publisher } from "../github/publisher.js";
import { createBridgedProvider } from "../pi-bridge/provider-bridge.js";
import { openRemoteStorage, StorageInUse, type RemoteStorage } from "../storage/remote-storage.js";
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

export { StorageInUse, CheckoutError };

export interface ReviewHost {
  /**
   * Trigger gate entry: a writer's `/review`. Resolves the pull request,
   * checks eligibility, and starts exactly one durable run for the current
   * head; an interrupted attempt for the same head is resumed. Rejects
   * with a reason when the request is refused.
   */
  handleReviewCommand(command: {
    repository: string;
    pullNumber: number;
    requester: string;
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
): Promise<ReviewHost> {
  const config = resolveConfig(workflowInputConfig);
  const storage: RemoteStorage = await openRemoteStorage({
    baseUrl: config.storage.baseUrl,
    authToken: config.storage.authToken,
    repository: config.repository,
    pullNumber: config.pullNumber,
  });

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
    stageDeadline: (stage) => (stage === "primary" ? config.primaryDeadlineMs : config.reReviewDeadlineMs),
  };
  installReviewTaskDeps(deps);
  // Reopen recovery: interrupted tasks resume from their last checkpoint.
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
  }): Promise<{ runId: string; refused?: string; conversationId: string }> {
    const context = TODO_CONTEXT;
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

    const subject: RunDocument["subject"] = {
      repository: command.repository,
      pullNumber: command.pullNumber,
      baseSha: baseSha!,
      headSha: headSha!,
    };

    const forHead = (await this.history.allRuns(context)).filter(
      (r) => r.subject.headSha === subject.headSha && r.subject.pullNumber === subject.pullNumber,
    );

    // An in-progress run is joined, not duplicated. On the re-opening host
    // the run's recorded pipeline task survives (pending at its last
    // checkpoint after reopen), so the caller waits on that task.
    const inProgress = forHead.find((r) => r.checkStatus === "in progress");
    if (inProgress) {
      this.trackTask(inProgress.runId, inProgress.pipelineTaskId);
      return { runId: inProgress.runId, conversationId: inProgress.canonicalConversationId };
    }

    // A published head stays published: the check already succeeded and the
    // durable work is complete.
    const published = forHead.find((r) => r.phase === "published" && r.publication);
    if (published) {
      return { runId: published.runId, conversationId: published.canonicalConversationId };
    }

    // A failed or interrupted attempt for the same head resumes the same
    // run: a new durable task picks up where the run document's durable
    // work is (re-review if the artifact froze, publish if the final review
    // froze, otherwise the primary stage runs again).
    const interrupted = forHead.find((r) => r.checkStatus === "failure");
    if (interrupted) {
      return this.resumeInterruptedRun(interrupted);
    }

    return this.startRun(subject);
  }

  /** Fresh attempt for a head with no durable prior work. */
  private async startRun(
    subject: RunDocument["subject"],
  ): Promise<{ runId: string; refused?: string; conversationId: string }> {
    const context = TODO_CONTEXT;
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
    const request = toRunRequest(subject);
    const started = await this.harness.commit(async (tx) => {
      const taskId = await tx.createTask(
        reviewTask,
        { runId, canonicalConversationId: canonicalId, request },
        { ownership: { kind: "conversation" }, conversationId: canonicalId as never },
      );
      const run: RunDocument = {
        kind: "nitpi.run",
        version: 1,
        runId,
        mode: "normal",
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

    this.trackTask(started.runId, started.taskId as unknown as string);
    return { runId: started.runId, conversationId: canonicalId! };
  }

  /** Actions re-run: pick the same attempt back up on a new durable task. */
  private async resumeInterruptedRun(
    runDoc: RunDocument,
  ): Promise<{ runId: string; refused?: string; conversationId: string }> {
    const context = TODO_CONTEXT;
    const initialPhase: "primary" | "re-review" | "publish" = runDoc.finalReview
      ? "publish"
      : runDoc.artifactFrozen && runDoc.artifact
        ? "re-review"
        : "primary";

    // The check goes back to in progress with the resumed stage.
    try {
      await new Publisher(this.api).checkInProgress(runDoc.subject, initialPhase);
    } catch {
      // A check-start failure must not stop the resumed attempt.
    }

    const request = toRunRequest(runDoc.subject);
    const resumed = await this.harness.commit(async (tx) => {
      const taskId = await tx.createTask(
        reviewTask,
        { runId: runDoc.runId, canonicalConversationId: runDoc.canonicalConversationId, request, initialPhase },
        { ownership: { kind: "conversation" }, conversationId: runDoc.canonicalConversationId as never },
      );
      // Strict JSON documents: clear the error by omitting the key.
      const { error: _clearedError, ...kept } = runDoc;
      void _clearedError;
      const updated: RunDocument = {
        ...kept,
        pipelineTaskId: taskId as unknown as string,
        phase: phaseForResume(initialPhase),
        checkStatus: "in progress",
        checkDetail: `stage: ${initialPhase} (resumed)`,
      };
      await this.history.record(tx, updated);
      return { runId: runDoc.runId, taskId };
    }, context);

    this.trackTask(resumed.runId, resumed.taskId as unknown as string);
    return { runId: resumed.runId, conversationId: runDoc.canonicalConversationId };
  }

  private trackTask(runId: string, taskId: string): void {
    if (this.activeRuns.has(runId)) return;
    // The rejection is not lost: waitForRun reads the durable run document,
    // which records the error/check outcome for every terminal state.
    this.activeRuns.set(
      runId,
      this.harness
        .waitForTask(taskId as never, TODO_CONTEXT)
        .then(() => undefined, () => undefined),
    );
  }

  async waitForRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) throw new Error(`unknown run ${runId} (tracking ${[...this.activeRuns.keys()].join(",")})`);
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
    // Signal first: close aborts in-flight invocations, so their waits can
    // settle; joining a hung generation before the signal would deadlock.
    await this.harness.close(TODO_CONTEXT);
    await Promise.allSettled(pending);
  }
}

function toRunRequest(subject: RunDocument["subject"]): ReviewRunRequest {
  return {
    repository: subject.repository,
    pullNumber: subject.pullNumber,
    baseSha: subject.baseSha,
    headSha: subject.headSha,
    command: "/review",
  };
}

function phaseForResume(initialPhase: "primary" | "re-review" | "publish"): RunDocument["phase"] {
  switch (initialPhase) {
    case "publish":
      return "publishing";
    case "re-review":
      return "re-review";
    default:
      return "primary";
  }
}

function nodeEnv(cwd: string) {
  // Real execution environment: shell + file tools rooted at the reviewer's
  // unchanged checkout of the reviewed head.
  return new NodeExecutionEnv({ cwd, shellEnv: process.env }) as never;
}

export type { RunDocument };
