/**
 * GitHub PR reviewer — Actions entry point (ticket 11).
 *
 * One invocation serves one delivered GitHub event for one pull request.
 * There is no long-lived process: the workflow runs this file fresh on every
 * delivery, and durable state lives behind the homeserver storage service
 * (ticket 06), so the only machine-local state is the workflow's checkout
 * and the per-stage worktrees derived from it (checkouts.ts).
 *
 * Inputs and secrets arrive as environment variables: the workflow (the
 * trusted main-branch file, the configuration layer) emits `${{ inputs.* }}`
 * and `${{ secrets.* }}` as `NITPI_INPUT_*` / `NITPI_SECRET_*` env vars, so
 * this plain module needs no YAML parser. A missing required item is a
 * configuration error thrown before any model call (resolveConfig, and the
 * bespoken provider-bridge decision: no fallback model).
 *
 * Delivery keys: `NITPI_DELIVERY_ID` (issued by the workflow from the
 * event's id) is the production dedup key — the trigger gate dedupes only
 * a caller-supplied id; a delivery without one is deliberately a distinct
 * delivery (spec: repeated `/review` on an already-reviewed head starts a
 * new run).
 *
 * Invocation kinds: `NITPI_ACTION` ∈ issue-comment | pull-request |
 * check-run-rekick, set by the workflow from the event shape (the entry
 * makes no gate decisions — it only fills the host's TriggerEvent).
 * `check-run-rekick` (an entry-side-only action the workflow may use when
 * a later delivery needs to re-serve a durable pending request early)
 * calls `drainPendingRequests()` and exits; nothing else.
 *
 * Exit contract (the job's own status; the GitHub check outcome is
 * published by the run task itself over the publisher's channel, so the
 * job status cannot disagree):
 *   0 — settled: the delivered trigger was consumed (run completed or
 *       queued, a refusal published as its check, a delivery deduped, a
 *       stop event applied, or a second opener skipped on StorageInUse),
 *   1 — the run's terminal state was a failure (reason on the run
 *       document and the check; a re-run reopens the attempt, ticket 06),
 *   2 — configuration error before anything ran.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { openReviewHost, type ReviewHost } from "../src/review-host/review-host.js";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import {
  ConfigError,
  resolveConfig,
  type AutoModeConfig,
  type CustomPrompt,
  type ReviewHostConfig,
  type StageInput,
  type StorageEndpoint,
} from "../src/review-host/config.js";
import { StorageInUse } from "../src/storage/remote-storage.js";

type ReviewCommand = "/review" | "/review clean" | "/review cancel";
type PrAction =
  | "opened" | "reopened" | "synchronize" | "ready_for_review"
  | "closed" | "converted_to_draft";

/** The three trusted commands in NITPI_INPUT_COMMAND mapping form. */
export const COMMAND_INPUTS: Readonly<Record<string, ReviewCommand>> = {
  review: "/review",
  "review-clean": "/review clean",
  "review-cancel": "/review cancel",
} as const;

function validatedCommand(raw: string): ReviewCommand {
  const command = COMMAND_INPUTS[raw];
  if (!command) {
    throw new ConfigError(
      `NITPI_INPUT_COMMAND must be one of ${Object.keys(COMMAND_INPUTS).join(" | ")}, got "${raw}"`,
    );
  }
  return command;
}

/** Actions the host accepts on one pull_request_target payload. */
export const PR_ACTIONS: ReadonlySet<PrAction> = new Set<PrAction>([
  "opened", "reopened", "synchronize", "ready_for_review", "closed", "converted_to_draft",
]);

function validatedPrAction(raw: string): PrAction {
  if (!PR_ACTIONS.has(raw as PrAction)) {
    throw new ConfigError(
      `NITPI_INPUT_PR_ACTION must be one of ${[...PR_ACTIONS].join(", ")}, got "${raw}"`,
    );
  }
  return raw as PrAction;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** One workflow input, rendered by the workflow as NITPI_INPUT_<name>. */
export function input(name: string): string | undefined {
  return env(`NITPI_INPUT_${name}`);
}

function requiredInput(name: string): string {
  const value = input(name);
  if (value === undefined) {
    throw new ConfigError(`required workflow input NITPI_INPUT_${name} is missing or empty`);
  }
  return value;
}

function requiredSecret(name: string): string {
  const value = env(`NITPI_SECRET_${name}`);
  if (value === undefined) {
    throw new ConfigError(`required secret NITPI_SECRET_${name} is missing or empty`);
  }
  return value;
}

/** GitHub's "true"/"false" string inputs; unset means false. */
function booleanInput(name: string): boolean {
  return input(name) === "true";
}

/**
 * Provider options input: a JSON object (`additionalProperties: true` per
 * the spec's Configuration), or absent/empty/none. Malformed JSON is a
 * configuration error before any model call.
 */
function providerOptions(stage: "PRIMARY" | "RE_REVIEW"): Record<string, unknown> | undefined {
  const raw = input(`${stage}_PROVIDER_OPTIONS`);
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `NITPI_INPUT_${stage}_PROVIDER_OPTIONS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`NITPI_INPUT_${stage}_PROVIDER_OPTIONS must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Per-stage custom prompt (ticket 10): per-stage text plus append/replace
 * mode. No text means no custom prompt (the built-in policy runs); a mode
 * input without a text input is a configuration error; `replace` with
 * empty text fails at resolveConfig before any model call.
 */
function customPrompt(stage: "PRIMARY" | "RE_REVIEW"): CustomPrompt | undefined {
  const raw = input(`${stage}_CUSTOM_PROMPT`);
  const rawMode = input(`${stage}_CUSTOM_PROMPT_MODE`);
  if (raw === undefined || raw.trim() === "") {
    // A whitespace prompt with no mode is simply absent (the built-in policy
    // runs); a set mode input with an empty prompt is the spec's
    // configuration error, reported before any model call.
    if (rawMode !== undefined) {
      throw new ConfigError(
        `NITPI_INPUT_${stage}_CUSTOM_PROMPT_MODE is set but NITPI_INPUT_${stage}_CUSTOM_PROMPT is not` +
          (rawMode === "replace" ? " (replace mode requires a non-empty custom prompt)" : ""),
      );
    }
    return undefined;
  }
  const mode = rawMode ?? "append";
  if (mode !== "append" && mode !== "replace") {
    throw new ConfigError(`NITPI_INPUT_${stage}_CUSTOM_PROMPT_MODE must be "append" or "replace", got "${mode}"`);
  }
  return { text: raw, mode };
}

/** Comma-separated check names; blank entries dropped. */
function checksList(name: string): string[] | undefined {
  const raw = input(name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const names = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return names.length > 0 ? names : undefined;
}

/**
 * Automatic mode (ticket 03): manual is the default. `AUTOMATIC_PRESET=true`
 * enables all four event toggles and waits for no checks; otherwise the
 * mode input, the four event toggles and the optional named checks
 * configure it individually.
 */
function autoModeInput(): AutoModeConfig | undefined {
  if (booleanInput("AUTOMATIC_PRESET")) {
    return {
      mode: "automatic",
      events: { opened: true, reopened: true, synchronize: true, readyForReview: true },
    };
  }
  const mode = input("MODE");
  if (mode === undefined || mode === "manual") return undefined;
  if (mode !== "automatic") {
    throw new ConfigError(`NITPI_INPUT_MODE must be "manual" or "automatic", got "${mode}"`);
  }
  return {
    mode: "automatic",
    events: {
      opened: booleanInput("EVENT_OPENED"),
      reopened: booleanInput("EVENT_REOPENED"),
      synchronize: booleanInput("EVENT_SYNCHRONIZE"),
      readyForReview: booleanInput("EVENT_READY_FOR_REVIEW"),
    },
    waitForChecks: checksList("WAIT_FOR_CHECKS"),
  };
}

function refusalCheckBehaviorInput(): "as-refused" | "action_required" | "none" {
  const raw = input("REFUSAL_CHECK_BEHAVIOR");
  if (raw === undefined || raw === "as-refused") return "as-refused";
  if (raw !== "action_required" && raw !== "none") {
    throw new ConfigError(
      `NITPI_INPUT_REFUSAL_CHECK_BEHAVIOR must be "as-refused", "action_required" or "none", got "${raw}"`,
    );
  }
  return raw;
}

function positiveMs(name: string, fallback: number): number {
  const raw = input(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`NITPI_INPUT_${name} must be a positive number of milliseconds, got "${raw}"`);
  }
  return value;
}

/**
 * The trusted main-branch repository instructions (spec: review
 * instructions read from the main branch at a pinned revision): a file the
 * default-branch checkout provides, mapped through
 * `NITPI_REVIEW_INSTRUCTIONS_FILE`, with the pinned revision carried
 * separately (`NITPI_INPUT_REVIEW_INSTRUCTIONS_REVISION`) and recorded
 * verbatim on every run document. An absent or empty file yields empty
 * instructions text, which resolveConfig rejects as a configuration error
 * before anything runs — a repository without the file has no reviewer.
 */
function readInstructionsFile(path?: string): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function buildStage(stage: "PRIMARY" | "RE_REVIEW"): StageInput {
  return {
    baseUrl: requiredInput(`${stage}_BASE_URL`),
    modelId: requiredInput(`${stage}_MODEL_ID`),
    apiKey: requiredSecret(`${stage}_API_KEY`),
    providerOptions: providerOptions(stage),
    customPrompt: customPrompt(stage),
  };
}

/**
 * Build and validate the whole host config (`.resolveConfig`'s order:
 * shape first, then one error at a time).
 */
export function buildConfig(): ReviewHostConfig {
  const repository = env("GITHUB_REPOSITORY");
  if (!repository) throw new ConfigError("GITHUB_REPOSITORY is not set (run inside a GitHub Actions job)");
  const storage: StorageEndpoint = {
    baseUrl: requiredInput("STORAGE_BASE_URL"),
    authToken: requiredSecret("STORAGE_AUTH_KEY"),
  };
  return resolveConfig({
    repository,
    pullNumber: Number(requiredInput("PR_NUMBER")),
    storage,
    primaryDeadlineMs: positiveMs("PRIMARY_DEADLINE_MS", 900_000),
    reReviewDeadlineMs: positiveMs("RE_REVIEW_DEADLINE_MS", 900_000),
    githubToken: requiredSecret("GITHUB_TOKEN"),
    githubBaseUrl: env("GITHUB_API_BASE_URL") ?? "https://api.github.com",
    primary: buildStage("PRIMARY"),
    reReview: buildStage("RE_REVIEW"),
    repositoryInstructions: readInstructionsFile(env("NITPI_REVIEW_INSTRUCTIONS_FILE")),
    repositoryInstructionsRevision: requiredInput("REVIEW_INSTRUCTIONS_REVISION"),
    headCheckoutSource: process.cwd(),
    autoMode: autoModeInput(),
    refusalCheckBehavior: refusalCheckBehaviorInput(),
  });
}

type Invocation = "issue-comment" | "pull-request" | "check-run-rekick";

/**
 * Which invocation the workflow requested (`NITPI_ACTION`; the workflow
 * materializes one value from GitHub's event shape — the entry itself
 * makes gate decisions only through the host API).
 */
export function readInvocation(): Invocation {
  const action = env("NITPI_ACTION");
  if (action === "issue-comment" || action === "pull-request" || action === "check-run-rekick") return action;
  throw new ConfigError(
    `NITPI_ACTION must be "issue-comment", "pull-request" or "check-run-rekick", got "${action ?? "unset"}"`,
  );
}

async function main(): Promise<number> {
  try {
    const headCheckoutSource = process.cwd();
    if (!existsSync(join(headCheckoutSource, ".git"))) {
      throw new ConfigError(
        `the workflow did not check out the reviewed repository at ${headCheckoutSource}` +
          " (the entry derives the reviewers' unchanged per-stage worktrees from it)",
      );
    }
    const config = buildConfig();
    const invocation = readInvocation();
    // GitHub's delivery ids reach Actions as event ids (comment id on
    // issue_comment, PR number + action + head SHA otherwise). The durable
    // gate treats a supplied key as the delivery identity and dedups it.
    const deliveryKey = env("NITPI_DELIVERY_ID") ?? `local-${process.pid}-${Date.now().toString(36)}`;
    const sender = env("GITHUB_ACTOR") ?? "unknown-sender";
    // Parsed and validated up front, before the host opens (and before any
    // network): a malformed invocation input is a configuration error, exit 2.
    const command = invocation === "issue-comment"
      ? validatedCommand(requiredInput("COMMAND"))
      : undefined;
    const prAction = invocation === "pull-request"
      ? validatedPrAction(requiredInput("PR_ACTION"))
      : undefined;

    return await withHost(config, async (host) => {
      const resumedRunIds = (await host.runHistory().allRuns(TODO_CONTEXT))
        .filter((run) => run.subject.repository === config.repository && run.subject.pullNumber === config.pullNumber)
        .filter((run) => run.checkStatus === "in progress")
        .map((run) => run.runId);
      switch (invocation) {
        case "issue-comment":
          return settle(host, config, await host.handleReviewCommand({
            repository: config.repository,
            pullNumber: config.pullNumber,
            requester: sender,
            command: command!,
            deliveryKey,
          }), resumedRunIds);
        case "pull-request":
          return settle(host, config, await host.handlePullRequestEvent({
            action: prAction!,
            repository: config.repository,
            pullNumber: config.pullNumber,
            sender,
            deliveryKey,
          }), resumedRunIds);
        case "check-run-rekick":
          // The clock: pending requests stay durable; this invocation serves
          // them (and waits out a run the drain starts) unless another
          // process currently owns the partition.
          return settle(host, config, { runId: "" }, resumedRunIds);
      }
    });
  } catch (error) {
    if (error instanceof StorageInUse) {
      // One process owns a PR's storage at a time (ticket 06): a second
      // opener (the re-kick while a run is active, or a lost job race with
      // the run's own invocation) exits without racing the owner's work.
      // The durable pending request is served by the next delivery, after
      // the owner releases the lease.
      console.error("skipped: another review process owns this PR's storage; waiting for the next delivery");
      return 0;
    }
    if (error instanceof ConfigError) {
      console.error("configuration error:", error.message);
      return 2;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      // The runner cancelled the job: the durable state (canonical
      // conversation, pipeline checkpoint) is kept for an Actions re-run,
      // the same as a hard runner kill.
      console.error("the job was cancelled; durable work is kept for a re-run");
      return 0;
    }
    console.error("reviewer run failed:", error instanceof Error ? (error.stack ?? error.message) : String(error));
    return 1;
  }
}

/** Open the host, run one invocation against it, close it either way. */
async function withHost<T>(
  config: ReviewHostConfig,
  body: (host: ReviewHost) => Promise<T>,
): Promise<T> {
  const host = await openReviewHost(config);
  try {
    return await body(host);
  } finally {
    await host.close().catch(() => undefined);
  }
}

/**
 * Settle one delivery's outcome: a run the gate started or joined is awaited
 * to its terminal state — the Actions job IS the run's duration, so an
 * operator re-running the job always resumes the durable attempt behind it
 * (the next delivery reopens it, ticket 06). A queued request is consumed by
 * this job's own drain, or re-kicked by a later delivery; a refusal's reason
 * is published by the host as a skipped/action-required check. Delivery
 * bookkeeping settles with exit 0 — exit severity belongs to the review
 * run's terminal outcome (waitForRun's failure throw and the resumed-run
 * check below), so the job status never disagrees with the GitHub check the
 * run itself published.
 */
async function settle(
  host: ReviewHost,
  config: ReviewHostConfig,
  outcome: { runId: string; refused?: string; outcome?: string },
  /** Runs already in progress at open: a resumed attempt whose outcome only
   *  the drain waited out (untracked after reopen, ticket 06). */
  resumedRunIds: readonly string[],
): Promise<number> {
  const waited: string[] = [];
  if (outcome.runId) {
    waited.push(outcome.runId);
    await waitOutRun(host, outcome.runId);
  }
  if (outcome.outcome === "queued" || outcome.outcome === "deferred" || outcome.outcome === "duplicate") {
    // The pending request is durable; this delivery waits on neither the
    // named checks nor a finishing run — the re-kick deliveries own that
    // clock, and the host's close abandons its kicked drain loop without
    // dropping the request.
    if (outcome.refused) console.log(`refused: ${outcome.refused}`);
    return 0;
  }
  await host.drainPendingRequests().catch(() => undefined);
  // The drain may have served a pending request by starting a run (the
  // check-run re-kick), and the resumed runs from before the delivery may
  // still be running (they are untracked after reopen, so the drain's
  // active-run wait does not see them): wait out whatever is left.
  const inProgress = (await host.runHistory().allRuns(TODO_CONTEXT)).filter(
    (run) =>
      run.subject.repository === config.repository &&
      run.subject.pullNumber === config.pullNumber &&
      run.checkStatus === "in progress" &&
      !waited.includes(run.runId),
  );
  for (const run of inProgress) {
    waited.push(run.runId);
    await waitOutRun(host, run.runId);
  }
  for (const runId of [...resumedRunIds, ...waited]) {
    const run = await host.runHistory().findRun(runId, TODO_CONTEXT);
    if (run?.checkStatus === "failure") {
      // A run failure the job waited out (a resumed attempt's terminal
      // state, or the joined run's): the run's own check carries the
      // reason. Exit 1 so the job agrees.
      console.error(`run ${runId} failed: ${run.checkDetail ?? "review failed"}`);
      return 1;
    }
  }
  if (outcome.refused) console.log(`refused: ${outcome.refused}`);
  return 0;
}

/**
 * Wait one run to its terminal state: through the host's tracker when the
 * run is tracked (started or joined in this process), otherwise by polling
 * the durable run document (a task auto-resumed at open is untracked).
 * A tracked run's failure throws (the exit-1 path); an untracked run's
 * failure is reported by settle's document check. Bounded, so a wedged
 * review cannot camp the job past the Actions timeout by much.
 */
async function waitOutRun(host: ReviewHost, runId: string, budgetMs = 240_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      await host.waitForRun(runId);
      return;
    } catch (error) {
      const unknown = error instanceof Error && error.message.startsWith("unknown run");
      if (!unknown) throw error; // Tracked run failure: the exit-1 path.
    }
    const run = await host.runHistory().findRun(runId, TODO_CONTEXT);
    if (!run || run.checkStatus !== "in progress") return; // settled (or vanished)
    if (Date.now() > deadline) {
      console.error(`run ${runId} is still in progress after ${budgetMs}ms; leaving it to the next delivery`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// (Tailscale join/leave, storage endpoint reachability and the tailnet ACL
// for the tagged node are workflow steps, not host code; see
// docs/actions-setup.md, which mirrors them.)

main().then(
  (code) => {
    // Natural exit, so piped stdout/stderr flush before the process ends
    // (process.exit() drops buffered pipe writes on Windows).
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      "reviewer entry failed:",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exitCode = 1;
  },
);
