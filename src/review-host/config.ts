/**
 * Workflow-input configuration for the two review stages. Per the spec's
 * Configuration decision: workflow inputs carry endpoints and instructions;
 * GitHub secrets carry credentials. Inputs arrive already resolved by the
 * trusted main-branch workflow.
 *
 * Automatic mode (ticket 03): `mode` with four independent event toggles
 * (`automaticPreset()` enables all four with no check wait) and optional
 * named checks an automatic review waits for. Manual mode is the default.
 *
 * Custom prompts per stage (ticket 10) arrive here the same way: per-stage
 * `customPrompt` with `append` or `replace` mode. They are trusted policy from
 * the main-branch workflow; PR content can never supply them.
 *
 * An endpoint that lacks streaming or tool-call support fails with an explicit
 * configuration error before any model call — there is no fallback model.
 */
import type { StageConfig } from "../pi-bridge/provider-bridge.js";

/** Shared full-commit-SHA predicate (trigger-gate SHAs and pinned revisions). */
export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

/** One stage's resolved configuration. */
export interface CustomPrompt {
  /** The prompt text. Empty replace text is rejected by `resolveConfig`. */
  readonly text: string;
  /** `append` adds the prompt below the built-in policy; `replace` swaps it in. */
  readonly mode: "append" | "replace";
}

export interface StageInput {
  /** Base URL of the stage's OpenAI-compatible endpoint. */
  readonly baseUrl: string;
  /** Model ID at that endpoint. */
  readonly modelId: string;
  /** API key injected from a GitHub secret. */
  readonly apiKey: string;
  /** Optional provider options merged into the model request. */
  readonly providerOptions?: Record<string, unknown>;
  /**
   * Optional repository-owner prompt for this stage (ticket 10). With no
   * prompt, the stage's instructions use the built-in review policy.
   */
  readonly customPrompt?: CustomPrompt | undefined;
}

/** Automatic-mode configuration: which pull-request events start reviews. */
export interface AutoModeConfig {
  /** Manual mode is the default: pull-request events start nothing. */
  readonly mode: "manual" | "automatic";
  /** Independent toggles for opened, reopened, new-commit and ready-for-review. */
  readonly events: {
    readonly opened: boolean;
    readonly reopened: boolean;
    readonly synchronize: boolean;
    readonly readyForReview: boolean;
  };
  /**
   * Named checks that must complete on the head before an automatic review
   * starts. Undefined or empty waits for nothing.
   */
  readonly waitForChecks?: readonly string[];
}

export interface ReviewHostConfig {
  /** Repository slug, e.g. `owner/name`. */
  readonly repository: string;
  readonly pullNumber: number;
  /**
   * The storage service for durable state (ticket 06): runs on the homeserver
   * and keeps this PR's partition of Pi's state in SQLite.
   */
  readonly storage: StorageEndpoint;
  /** Primary reviewer deadline in ms; a timeout is an incomplete check. */
  readonly primaryDeadlineMs: number;
  /** Re-reviewer deadline in ms; a timeout is an incomplete check. */
  readonly reReviewDeadlineMs: number;
  /** GitHub token with `pull-requests: write` for publication. */
  readonly githubToken: string;
  /** GitHub API base URL (fake in tests, `https://api.github.com` in CI). */
  readonly githubBaseUrl: string;
  readonly primary: StageInput;
  readonly reReview: StageInput;
  /**
   * Main-branch repository review instructions, captured at a pinned revision
   * by the trusted main-branch workflow and passed in as trusted text.
   */
  readonly repositoryInstructions: string;
  /** The pinned revision the instructions were captured at (recorded per run). */
  readonly repositoryInstructionsRevision: string;
  /**
   * The workflow's checked-out repository directory. Each stage gets its own
   * unchanged worktree of the reviewed head, created from this checkout.
   */
  readonly headCheckoutSource: string;
  /** Manual (default) or automatic trigger mode with its event toggles. */
  readonly autoMode?: AutoModeConfig;
  /**
   * Refused triggers surface on GitHub as check runs (skipped or action
   * required, with the explanation). "none" suppresses them entirely.
   */
  readonly refusalCheckBehavior?: "as-refused" | "action_required" | "none";
}

export interface StorageEndpoint {
  /** Storage service base URL, e.g. `http://homeserver:51733`. */
  readonly baseUrl: string;
  /** Storage bearer token (a GitHub secret in Actions). */
  readonly authToken: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireStage(stage: string, input: StageInput | undefined): StageInput {
  if (!input) throw new ConfigError(`missing stage configuration for ${stage}`);
  if (!/^https?:\/\//.test(input.baseUrl)) {
    throw new ConfigError(`${stage} baseUrl must be an absolute http(s) URL`);
  }
  if (!input.modelId) throw new ConfigError(`${stage} modelId is required`);
  if (!input.apiKey) throw new ConfigError(`${stage} apiKey is required (GitHub secret)`);
  return input;
}

/**
 * Validate one stage's custom prompt (ticket 10). Structural errors are
 * configuration errors so they fail before anything runs; `replace` mode with
 * an empty prompt is rejected so no stage is ever left without a review
 * policy.
 */
export function validateCustomPrompt(stage: string, prompt: CustomPrompt | undefined): void {
  if (!prompt) return;
  if (typeof prompt.text !== "string") {
    throw new ConfigError(`${stage} customPrompt.text must be a string`);
  }
  if (prompt.mode !== "append" && prompt.mode !== "replace") {
    throw new ConfigError(
      `${stage} customPrompt.mode must be "append" or "replace", got ${JSON.stringify(prompt.mode)}`,
    );
  }
  if (prompt.mode === "replace" && !prompt.text.trim()) {
    throw new ConfigError(
      `${stage} replace mode requires a non-empty custom prompt (a stage without a review policy is not reviewable)`,
    );
  }
}

export function toStageConfig(stage: string, input: StageInput): StageConfig {
  return {
    stage,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    apiKey: input.apiKey,
    providerOptions: input.providerOptions,
  };
}

/** Validate the whole host config; throws `ConfigError` before anything runs. */
export function resolveConfig(input: ReviewHostConfig): ReviewHostConfig {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository)) {
    throw new ConfigError(`repository must look like owner/name, got ${input.repository}`);
  }
  if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) {
    throw new ConfigError("pullNumber must be a positive integer");
  }
  if (!input.githubToken) throw new ConfigError("githubToken is required");
  if (!/^https?:\/\//.test(input.githubBaseUrl)) {
    throw new ConfigError("githubBaseUrl must be an absolute http(s) URL");
  }
  if (!input.repositoryInstructions?.trim()) {
    throw new ConfigError(
      "repositoryInstructions are required (captured from the main branch at a pinned revision)",
    );
  }
  if (!isFullSha(input.repositoryInstructionsRevision)) {
    throw new ConfigError("repositoryInstructionsRevision must be a full commit SHA");
  }
  if (!input.storage || !/^https?:\/\//.test(input.storage.baseUrl ?? "")) {
    throw new ConfigError("storage.baseUrl must be an absolute http(s) URL (the storage service)");
  }
  if (!input.storage.authToken) {
    throw new ConfigError("storage.authToken is required (GitHub secret)");
  }
  for (const [name, value] of [
    ["primaryDeadlineMs", input.primaryDeadlineMs],
    ["reReviewDeadlineMs", input.reReviewDeadlineMs],
  ] as const) {
    if (!Number.isFinite(value) || (value as number) <= 0) {
      throw new ConfigError(`${name} must be a positive number of milliseconds`);
    }
  }
  if (!input.headCheckoutSource) {
    throw new ConfigError("headCheckoutSource is required (the workflow's checked-out repository)");
  }
  if (input.autoMode) {
    if (input.autoMode.mode !== "manual" && input.autoMode.mode !== "automatic") {
      throw new ConfigError(`autoMode.mode must be "manual" or "automatic", got ${String(input.autoMode.mode)}`);
    }
    if (!input.autoMode.events) {
      throw new ConfigError(
        `autoMode.events is required (all four toggles must be booleans when autoMode is set)`,
      );
    }
    for (const toggle of ["opened", "reopened", "synchronize", "readyForReview"] as const) {
      if (typeof input.autoMode.events[toggle] !== "boolean") {
        throw new ConfigError(`autoMode.events.${toggle} must be a boolean`);
      }
    }
    if ((input.autoMode.waitForChecks?.length ?? 0) > 0 && input.autoMode.waitForChecks!.some((name) => !name.trim())) {
      // Validated in every mode: a typo must not be silently ignored when the
      // operator later flips the mode to automatic.
      throw new ConfigError("autoMode.waitForChecks entries must be non-empty check names");
    }
  }
  requireStage("primary", input.primary);
  requireStage("re-review", input.reReview);
  validateCustomPrompt("primary", input.primary?.customPrompt);
  validateCustomPrompt("re-review", input.reReview?.customPrompt);
  return input;
}
