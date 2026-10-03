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
 * Trigger gate (ticket 03): commands and, when opted in, automatic
 * pull-request events go through `TriggerGate`. The requester must be a
 * writer or maintainer, the pull request open (and not a draft for
 * automatic triggers), the head eligible (fork heads only with a writer's
 * per-commit approval), and one delivered trigger starts at most one run.
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
import {
  isFullSha,
  resolveConfig,
  validateCustomPrompt,
  type AutoModeConfig,
  type CustomPrompt,
  type ReviewHostConfig,
} from "./config.js";
import { resolveInstructions, type ResolvedInstructions } from "./instructions.js";
import { RunHistory, type RunDocument } from "./run-history.js";
import {
  TriggerGate,
  GateRegistry,
  DELIVERED_WINDOW,
  prKey,
  type GateEvaluation,
  type GateStart,
  type TriggerEvent,
  type RefusalOutcome,
} from "./trigger-gate.js";
import { type GitHubApi } from "../github/publisher.js";
import {
  installReviewTaskDeps,
  reviewTask,
  type ReviewCommand,
  type ReviewRunRequest,
  type ReviewTaskDeps,
} from "./review-task.js";
import type { StageInstructionsRecord } from "./run-history.js";

export { StorageInUse, CheckoutError };

export interface ReviewHost {
  /**
   * Trigger gate entry: all issue-comment commands (`/review`, `/review
   * clean`, `/review cancel`). The gate applies the same requester check to
   * each; `/review` starts one normal run for the current head, `/review
   * clean` one clean run (ticket 07); `/review cancel` is wired by ticket 09. Refusals return a reason. A
   * failed attempt for the same head is resumed rather than restarted
   * (ticket 06).
   */
  handleReviewCommand(command: {
    repository: string;
    pullNumber: number;
    requester: string;
    command?: "/review" | "/review clean" | "/review cancel";
    /** GitHub comment or delivery id; redelivery of the same one deduplicates. */
    deliveryKey?: string;
  }): Promise<{ runId: string; refused?: string; conversationId: string; outcome?: GateEvaluation["outcome"] }>;
  /**
   * Automatic-trigger entry: a pull-request event (opened, reopened,
   * synchronize, ready_for_review). A no-op in manual mode. Refusals are
   * recorded on GitHub as skipped or action-required checks.
   */
  handlePullRequestEvent(event: {
    action: "opened" | "reopened" | "synchronize" | "ready_for_review";
    repository: string;
    pullNumber: number;
    sender: string;
    deliveryKey?: string;
  }): Promise<{ runId: string; refused?: string; conversationId: string; outcome?: GateEvaluation["outcome"] }>;
  /**
   * Ticket 10 test seam: change one stage's custom prompt between runs, the
   * way a workflow-input edit changes the trusted configuration. Runs already
   * in progress are unaffected — their instructions are stored on the run
   * document.
   */
  replaceCustomPrompt(role: "primary" | "re-review", prompt: CustomPrompt | undefined): void;
  /** Resolves when the run's durable task reaches a terminal state. */
  waitForRun(runId: string): Promise<void>;
  /**
   * Drain any durable pending requests now (host recovery: a queued request
   * from an earlier host run starts on the newest eligible head). Resolves
   * when every per-PR drain loop settles.
   */
  drainPendingRequests(): Promise<void>;
  /** Aggregate Pi usage for assertion by tests. */
  usage(): Promise<Awaited<ReturnType<RunHistory["usage"]>>>;
  runHistory(): RunHistory;
  close(): Promise<void>;
}

const MANUAL_AUTO_MODE: AutoModeConfig = {
  mode: "manual",
  events: { opened: false, reopened: false, synchronize: false, readyForReview: false },
};

/**
 * Named-check probe for automatic reviews: every check named in the
 * automatic-mode configuration must be completed on the head before the
 * review starts. The host's probe reads the check-runs surface at the head
 * commit over `GitHubApi`; the workflow (ticket 11) supplies the transport.
 */
export type NamedCheckProbe = (
  repository: string,
  pullNumber: number,
  headSha: string,
) => Promise<"completed" | string>;

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
    stageDeadline: (stage) => (stage === "primary" ? config.primaryDeadlineMs : config.reReviewDeadlineMs),
  };
  installReviewTaskDeps(deps);
  // Reopen recovery: interrupted tasks resume from their last checkpoint.
  harness.resume();

  return new ReviewHostImpl(harness, runHistory, models, config, deps.api);
}

class ReviewHostImpl implements ReviewHost {
  private activeRuns = new Map<string, Promise<void>>();
  private settledRuns = new Map<string, Promise<void>>();
  /** Per-PR serial chain that serializes gate decisions with run starts. */
  private prQueues = new Map<string, Promise<unknown>>();
  /** Per-PR pending-request drain loops, awaited by drainPendingRequests(). */
  private draining = new Map<string, Promise<void>>();
  private gate: TriggerGate;
  /**
   * Ticket 10 test seam: per-stage custom prompts, initialized from the
   * workflow configuration and replaceable between runs the way a workflow
   * input edit replaces them. The host config itself stays immutable.
   */
  private stagePrompts: { primary?: CustomPrompt; reReview?: CustomPrompt };

  constructor(
    private readonly harness: Harness,
    private readonly history: RunHistory,
    private readonly models: Models,
    private readonly config: ReviewHostConfig,
    private readonly api: GitHubApi,
  ) {
    this.gate = new TriggerGate(harness, api, history, config.autoMode ?? MANUAL_AUTO_MODE);
    this.stagePrompts = {
      ...(config.primary.customPrompt ? { primary: config.primary.customPrompt } : {}),
      ...(config.reReview.customPrompt ? { reReview: config.reReview.customPrompt } : {}),
    };
  }

  async handleReviewCommand(command: {
    repository: string;
    pullNumber: number;
    requester: string;
    command?: "/review" | "/review clean" | "/review cancel";
    deliveryKey?: string;
  }): Promise<{ runId: string; refused?: string; conversationId: string; outcome?: GateEvaluation["outcome"] }> {
    return this.enqueue(command.repository, command.pullNumber, () =>
      this.processEvaluation(
        { kind: "comment", command: command.command ?? "/review", requester: command.requester, deliveryKey: command.deliveryKey, repository: command.repository, pullNumber: command.pullNumber },
      ),
    );
  }

  async handlePullRequestEvent(event: {
    action: "opened" | "reopened" | "synchronize" | "ready_for_review";
    repository: string;
    pullNumber: number;
    sender: string;
    deliveryKey?: string;
  }): Promise<{ runId: string; refused?: string; conversationId: string; outcome?: GateEvaluation["outcome"] }> {
    return this.enqueue(event.repository, event.pullNumber, () =>
      this.processEvaluation({ kind: "pull-request", ...event }),
    );
  }

  /**
   * One serial chain per pull request, so two triggers arriving together
   * cannot both pass the active-run check and start two runs, and a drain
   * cannot race a start.
   */
  private enqueue<T>(repository: string, pullNumber: number, work: () => Promise<T>): Promise<T> {
    const key = prKey(repository, pullNumber);
    const previous = this.prQueues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.prQueues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private async processEvaluation(event: TriggerEvent): Promise<{
    runId: string;
    refused?: string;
    conversationId: string;
    outcome?: GateEvaluation["outcome"];
  }> {
    // Same repository: the host is configured for exactly one repository.
    if (event.repository !== this.config.repository) {
      return { runId: "", refused: `reviewer is not configured for ${event.repository}`, conversationId: "", outcome: "refused" };
    }
    const evaluation = await this.gate.evaluate(event);
    switch (evaluation.outcome) {
      case "start":
        return this.startRun(evaluation.request, evaluation.deliveryKey);
      case "satisfied":
        // A running review already covers the head: join its run. On a
        // re-opened host the run's recorded pipeline task survives (pending at
        // its last checkpoint), so the caller waits on that task (ticket 06).
        this.trackTask(
          evaluation.run.runId,
          evaluation.run.pipelineTaskId,
          evaluation.run.subject.repository,
          evaluation.run.subject.pullNumber,
        );
        return { runId: evaluation.run.runId, conversationId: evaluation.run.canonicalConversationId, outcome: "satisfied" };
      case "queued":
        // The newest eligible head is stored as the PR's pending request;
        // the drain (kicked by this trigger or by a finishing run) starts it.
        void this.ensureDrainLoop(event.repository, event.pullNumber).catch(() => undefined);
        return { runId: "", conversationId: "", outcome: "queued" };
      case "duplicate":
        return { runId: "", conversationId: "", outcome: "duplicate" };
      case "deferred":
        // evaluate() never defers; only evaluatePending does. Defensive.
        return { runId: "", conversationId: "", outcome: "deferred" };
      case "ignored":
        return { runId: "", conversationId: "", outcome: "ignored" };
      case "refused": {
        // Every refusal carries a reason and never starts a run; refusals are
        // deliberately re-evaluated on redelivery (state may have changed:
        // draft became ready, permission was granted), at the cost of one
        // refusal check per delivery. No AC violation — see the review note.
        await this.recordRefusal(event, evaluation);
        return { runId: "", refused: evaluation.reason, conversationId: "", outcome: "refused" };
      }
    }
  }

  /** Refusals surface on GitHub as skipped or action-required checks. */
  private async recordRefusal(
    event: TriggerEvent,
    evaluation: Extract<GateEvaluation, { outcome: "refused" }> ,
  ): Promise<void> {
    if (this.config.refusalCheckBehavior === "none") return;
    const repository = event.repository;
    let headSha = evaluation.headSha;
    let baseSha = evaluation.baseSha;
    // Refusals decided before the pull request was read (the requester
    // check) still show their reason at the pull request's head.
    if (!headSha) {
      const pr = await this.api.getPullRequest(repository, event.pullNumber);
      const body = (pr.body ?? {}) as { head?: { sha?: string }; base?: { sha?: string } };
      headSha = body.head?.sha;
      baseSha = body.base?.sha;
    }
    if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha)) return;
    const outcome = evaluation.checkOutcome === "skipped" && this.config.refusalCheckBehavior === "action_required"
      ? "action_required" as const
      : evaluation.checkOutcome;
    await new Publisher(this.api).checkRefused(
      { repository, pullNumber: event.pullNumber, baseSha: baseSha ?? "", headSha },
      outcome as RefusalOutcome,
      evaluation.reason,
    );
  }

  /**
   * Per-PR drain loop: waits out an active run, re-evaluates the pending
   * request (re-reading GitHub state), and starts it when eligible.
   */
  private async ensureDrainLoop(repository: string, pullNumber: number): Promise<void> {
    const key = prKey(repository, pullNumber);
    if (this.draining.has(key)) return;
    const loop = this.drainLoop(repository, pullNumber).finally(() => this.draining.delete(key));
    this.draining.set(key, loop);
    await loop;
  }

  /**
   * Bounded poll loop over the PR's pending request. Between attempts it
   * sleeps with capped exponential backoff (from `DRAIN_POLL_MS` up to
   * `DRAIN_POLL_MAX_MS`), so a named-check wait — CI checks run for
   * minutes — or a finishing run can make a request startable. When the
   * attempts run out the loop exits but the pending request itself stays
   * durable: the workflow (ticket 11) re-kicks the drain on `check_run`
   * completion events and on every later trigger, and a host restart serves
   * the request through `drainPendingRequests()`.
   */
  private async drainLoop(repository: string, pullNumber: number): Promise<void> {
    let deferredStreak = 0;
    for (let attempt = 0; attempt < DRAIN_MAX_ATTEMPTS; attempt++) {
      // Outside the chain: wait out any active run of this pull request.
      const activePromises: Promise<void>[] = [];
      for (const [runId, promise] of this.activeRuns) {
        const run = await this.history.findRun(runId, TODO_CONTEXT);
        if (
          run &&
          run.subject.repository === repository &&
          run.subject.pullNumber === pullNumber
        ) {
          activePromises.push(promise);
        }
      }
      if (activePromises.length > 0) {
        await Promise.allSettled(activePromises);
        continue; // run finished; the loop re-checks at full speed
      }
      const decided = await this.enqueue(repository, pullNumber, () =>
        this.evaluateAndStartPending(repository, pullNumber),
      );
      if (decided === "started") {
        // A run just started; its completion kicks another drain if a request
        // was queued while it ran.
        return;
      }
      if (decided === "deferred") {
        // Capped backoff across consecutive deferrals; the streak resets on
        // every fresh drain loop (kicked by any trigger or run completion).
        await sleep(Math.min(DRAIN_POLL_MAX_MS, DRAIN_POLL_MS * 2 ** Math.min(deferredStreak++, 8)));
        continue;
      }
      return; // nothing pending, or refused/ignored: the loop is done
    }
  }

  /** One drain decision inside the PR's serialized chain. It never waits on
   * an active run — the chain must stay free for other triggers — an active
   * run is reported as "deferred" and the loop re-checks after sleeping. */
  private async evaluateAndStartPending(
    repository: string,
    pullNumber: number,
  ): Promise<"started" | "deferred" | "stop"> {
    const key = prKey(repository, pullNumber);
    // An active run for this PR holds the pending request; nothing starts
    // until it finishes (its completion re-kicks this loop).
    const inProgress = (await this.history.allRuns(TODO_CONTEXT)).find(
      (r) =>
        r.subject.repository === repository &&
        r.subject.pullNumber === pullNumber &&
        r.checkStatus === "in progress",
    );
    if (inProgress) return "deferred";
    const evaluation = await this.gate.evaluatePending(repository, pullNumber, this.namedCheckWait());
    switch (evaluation.outcome) {
      case "start":
        // The pending request's consumption commits with the run creation.
        await this.startRun(evaluation.request, evaluation.deliveryKey, { pendingKey: key });
        return "started";
      case "deferred":
        return "deferred";
      case "refused": {
        // The refusal is visible on GitHub as skipped or action required.
        const headSha = evaluation.headSha;
        if (this.config.refusalCheckBehavior !== "none" && headSha && /^[0-9a-f]{40}$/i.test(headSha)) {
          await new Publisher(this.api)
            .checkRefused(
              { repository, pullNumber, baseSha: evaluation.baseSha ?? "", headSha },
              evaluation.checkOutcome,
              evaluation.reason,
            )
            .catch(() => undefined);
        }
        return "stop";
      }
      default:
        return "stop";
    }
  }

  /**
   * Named checks for automatic reviews: every configured check must be
   * completed on the head before the review starts. The probe reads the
   * check-runs surface at the head commit over the host's GitHub API.
   */
  private namedCheckWait(): NamedCheckProbe | undefined {
    const names = this.config.autoMode?.waitForChecks ?? [];
    if (this.config.autoMode?.mode !== "automatic" || names.length === 0) return undefined;
    return async (repository, _pullNumber, headSha) => {
      const response = await this.api.listCheckRunsForHead?.(repository, headSha);
      if (!response || response.status !== 200) {
        return `check runs unavailable (HTTP ${response?.status ?? "no route"})`;
      }
      const body = response.body as {
        check_runs?: Array<{ name?: string; status?: string; conclusion?: string | null }>;
      };
      const runs = body.check_runs ?? [];
      for (const name of names) {
        const run = runs.find((r) => r.name === name);
        if (!run) return `check "${name}" has not started`;
        if (run.status !== "completed") return `check "${name}" is ${run.status}`;
      }
      return "completed";
    };
  }

  private async startRun(
    request: GateStart,
    deliveryKey: string,
    options: { pendingKey?: string } = {},
  ): Promise<{ runId: string; conversationId: string; outcome: "start" }> {
    // A failed or interrupted attempt for the same head resumes the same
    // run (ticket 06): a new durable task picks up where the run document's
    // durable work is (re-review if the artifact froze, publish if the final
    // review froze, otherwise the primary stage runs again).
    const interrupted = (await this.history.allRuns(TODO_CONTEXT)).find(
      (r) =>
        r.subject.repository === request.repository &&
        r.subject.pullNumber === request.pullNumber &&
        r.subject.headSha === request.headSha &&
        r.checkStatus === "failure",
    );
    if (interrupted) {
      const resumed = await this.resumeInterruptedRun(interrupted);
      return { runId: resumed.runId, conversationId: resumed.conversationId, outcome: "start" as const };
    }

    // Per-stage unchanged checkouts of the reviewed head.
    const checkouts = ensureStageCheckouts(this.config.headCheckoutSource, request.headSha);

    // The check shows in progress with the head and current stage while running.
    await new Publisher(this.api).checkInProgress(
      { repository: request.repository, pullNumber: request.pullNumber, baseSha: request.baseSha, headSha: request.headSha },
      "primary",
    );

    // The canonical PR conversation is durable state, shared by every run of
    // this PR (recovered from the runs registry on reopen).
    let canonicalId = await this.history.findCanonicalConversation(
      request.repository,
      request.pullNumber,
      TODO_CONTEXT,
    );

    // Ticket 10: resolve both stages' instructions once, at run start, from
    // the workflow configuration. The resolved text is stored with the run
    // before any model call, so recovery reuses exactly what this run started
    // with even if the configuration changes mid-run.
    const resolved = {
      primary: this.resolveStageInstructions("primary"),
      reReview: this.resolveStageInstructions("re-review"),
    };
    if (!canonicalId) {
      const canonical = await this.history.createCanonicalConversation(
        { modelId: this.config.primary.modelId, instructions: resolved.primary.text },
        TODO_CONTEXT,
      );
      canonicalId = canonical.id as unknown as string;
    }

    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const runRequest: ReviewRunRequest = {
      repository: request.repository,
      pullNumber: request.pullNumber,
      baseSha: request.baseSha,
      headSha: request.headSha,
      command: request.command,
      source: request.source,
      triggeredBy: request.triggeredBy,
    };
    const started = await this.harness.commit(async (tx) => {
      // Consume the pending request (queued or automatic) in the same
      // transaction as the run creation: no double starts after a crash.
      if (options.pendingKey) {
        const gateDoc = await tx.doc(GateRegistry);
        delete gateDoc.pendingByPr[options.pendingKey];
      }
      // Record the delivery key in the same commit: one delivery starts at
      // most one run, even if delivery repeats while the run is active.
      const gateDoc = await tx.doc(GateRegistry);
      const delivered = [...gateDoc.delivered, { key: deliveryKey, at: Date.now() }].slice(-DELIVERED_WINDOW);
      gateDoc.delivered = delivered;
      const taskId = await tx.createTask(
        reviewTask,
        { runId, canonicalConversationId: canonicalId!, request: runRequest },
        // Task ownership sits on the canonical conversation in both modes:
        // it is host machinery. A clean run's REVIEWER conversations are the
        // fresh task-owned ones created inside the pipeline (review-task).
        { ownership: { kind: "conversation" }, conversationId: canonicalId as never },
      );
      const run: RunDocument = {
        kind: "nitpi.run",
        version: 1,
        runId,
        mode: request.command === "/review clean" ? "clean" : "normal",
        source: request.source,
        phase: "primary",
        subject: {
          repository: request.repository,
          pullNumber: request.pullNumber,
          baseSha: request.baseSha,
          headSha: request.headSha,
        },
        pipelineTaskId: taskId as unknown as string,
        canonicalConversationId: canonicalId!,
        artifactFrozen: false,
        resolvedInstructions: resolved,
        checkStatus: "in progress",
        checkDetail: "stage: primary",
        checkouts,
        triggeredBy: request.triggeredBy,
        ...(request.requester ? { requester: request.requester } : {}),
        repositoryInstructionsRevision: this.config.repositoryInstructionsRevision,
      };
      await this.history.record(tx, run);
      return { runId, taskId };
    }, TODO_CONTEXT);

    this.trackTask(started.runId, started.taskId as unknown as string, request.repository, request.pullNumber);
    return { runId: started.runId, conversationId: canonicalId!, outcome: "start" as const };
  }

  /** Actions re-run: pick the same attempt back up on a new durable task. */
  private async resumeInterruptedRun(
    runDoc: RunDocument,
  ): Promise<{ runId: string; refused?: string; conversationId: string }> {
    const context = TODO_CONTEXT;
    // A clean run imports its report (ticket 07) between matching and
    // publication; the import marker records that it already happened.
    const initialPhase: "primary" | "re-review" | "match" | "import" | "publish" = runDoc.finalReview
      ? runDoc.matches === undefined
        ? "match"
        : runDoc.mode === "clean" && !runDoc.imported
          ? "import"
          : "publish"
      : runDoc.artifactFrozen && runDoc.artifact
        ? "re-review"
        : "primary";

    // The check goes back to in progress with the resumed stage.
    try {
      await new Publisher(this.api).checkInProgress(runDoc.subject, initialPhase);
    } catch {
      // A check-start failure must not stop the resumed attempt.
    }

    const request = toRunRequest(runDoc);
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

    this.trackTask(resumed.runId, resumed.taskId as unknown as string, runDoc.subject.repository, runDoc.subject.pullNumber);
    return { runId: resumed.runId, conversationId: runDoc.canonicalConversationId };
  }

  /**
   * Track one run to its terminal state. A finished run moves from
   * `activeRuns` (what the drain loop waits out) to `settledRuns` (what
   * `waitForRun` reads), then kicks the PR's pending drain (ticket 03).
   */
  private trackTask(runId: string, taskId: string, repository: string, pullNumber: number): void {
    if (this.activeRuns.has(runId)) return;
    // The rejection is not lost: waitForRun reads the durable run document,
    // which records the error/check outcome for every terminal state.
    const finished: Promise<void> = this.harness
      .waitForTask(taskId as never, TODO_CONTEXT)
      .then(() => undefined, () => undefined)
      .then(() => {
        this.activeRuns.delete(runId);
        this.settledRuns.set(runId, finished);
        return this.ensureDrainLoop(repository, pullNumber).catch(() => undefined);
      });
    this.activeRuns.set(runId, finished);
  }

  /**
   * Ticket 10: one stage's resolved instructions for this run, from the
   * stage prompts the host currently holds.
   */
  resolveStageInstructions(role: "primary" | "re-review"): StageInstructionsRecord {
    const resolved: ResolvedInstructions = resolveInstructions(
      role,
      this.config.repositoryInstructions,
      role === "primary" ? this.stagePrompts.primary : this.stagePrompts.reReview,
    );
    return {
      text: resolved.text,
      policyPin: resolved.policyPin,
      promptMode: resolved.promptMode,
      ...(resolved.customPrompt !== undefined ? { customPrompt: resolved.customPrompt } : {}),
    };
  }

  replaceCustomPrompt(role: "primary" | "re-review", prompt: CustomPrompt | undefined): void {
    validateCustomPrompt(role, prompt);
    if (prompt) {
      if (role === "primary") this.stagePrompts.primary = prompt;
      else this.stagePrompts.reReview = prompt;
    } else {
      if (role === "primary") delete this.stagePrompts.primary;
      else delete this.stagePrompts.reReview;
    }
  }

  async waitForRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId) ?? this.settledRuns.get(runId);
    if (!active) throw new Error(`unknown run ${runId} (tracking ${[...this.activeRuns.keys()].join(",")})`);
    try {
      await active;
      // Surface terminal failures/aborts as errors on the host seam.
      const run = await this.history.findRun(runId, TODO_CONTEXT);
      if (run?.error) throw new Error(run.error);
      if (run?.checkStatus === "failure") throw new Error(run.checkDetail ?? "review failed");
    } finally {
      this.activeRuns.delete(runId);
      this.settledRuns.delete(runId);
    }
  }

  async drainPendingRequests(): Promise<void> {
    const gate = await this.harness.snapshot(GateRegistry, TODO_CONTEXT);
    const keys = Object.keys(gate?.pendingByPr ?? {});
    await Promise.all(
      keys.map((key) => {
        const [repository, pullRaw] = key.split("#");
        const pullNumber = Number.parseInt(pullRaw ?? "", 10);
        if (!repository || !Number.isInteger(pullNumber)) return Promise.resolve();
        return this.ensureDrainLoop(repository, pullNumber).catch(() => undefined);
      }),
    );
  }

  async usage() {
    return this.history.usage(TODO_CONTEXT);
  }

  runHistory(): RunHistory {
    return this.history;
  }

  async close(): Promise<void> {
    // Active runs are awaited to their terminal state; drain loops are
    // abandoned, not awaited — their pending requests stay durable (nitpi.gate)
    // and a later trigger or `drainPendingRequests()` on a reopened host serves
    // them. close() must not camp on a named-check wait.
    const pending = [...this.activeRuns.values()];
    this.activeRuns.clear();
    for (const [, loop] of this.draining) void loop.catch(() => undefined);
    this.draining.clear();
    // Signal first: close aborts in-flight invocations, so their waits can
    // settle; joining a hung generation before the signal would deadlock.
    await this.harness.close(TODO_CONTEXT);
    await Promise.allSettled(pending);
  }
}

const DRAIN_POLL_MS = 100;
const DRAIN_POLL_MAX_MS = 5000;
/** Bounded: 80 attempts with capped backoff camp on a pending request for
 * roughly five minutes before the loop exits — the request itself stays
 * durable and is re-kicked by later triggers, check_run completions (ticket
 * 11 wiring) or a host restart. The bound keeps `close()` finite. */
const DRAIN_MAX_ATTEMPTS = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The resumed attempt's request, rebuilt from its run document. */
function toRunRequest(runDoc: RunDocument): ReviewRunRequest {
  return {
    repository: runDoc.subject.repository,
    pullNumber: runDoc.subject.pullNumber,
    baseSha: runDoc.subject.baseSha,
    headSha: runDoc.subject.headSha,
    command: runDoc.mode === "clean" ? "/review clean" : "/review",
    source: runDoc.source ?? "command",
    triggeredBy: runDoc.triggeredBy ?? "/review (resumed)",
  };
}

function phaseForResume(initialPhase: "primary" | "re-review" | "match" | "import" | "publish"): RunDocument["phase"] {
  switch (initialPhase) {
    case "import":
      return "matched";
    case "publish":
      return "publishing";
    case "match":
      return "final frozen";
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
