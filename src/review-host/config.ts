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
 * An endpoint that lacks streaming or tool-call support fails with an explicit
 * configuration error before any model call — there is no fallback model.
 */
import type { StageConfig } from "../pi-bridge/provider-bridge.js";

/** Shared full-commit-SHA predicate (trigger-gate SHAs and pinned revisions). */
export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

/** One stage's resolved configuration. */
export interface StageInput {
  /** Base URL of the stage's OpenAI-compatible endpoint. */
  readonly baseUrl: string;
  /** Model ID at that endpoint. */
  readonly modelId: string;
  /** API key injected from a GitHub secret. */
  readonly apiKey: string;
  /** Optional provider options merged into the model request. */
  readonly providerOptions?: Record<string, unknown>;
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
  if (!input.headCheckoutSource) {
    throw new ConfigError("headCheckoutSource is required (the workflow's checked-out repository)");
  }
  if (input.autoMode) {
    if (input.autoMode.mode !== "manual" && input.autoMode.mode !== "automatic") {
      throw new ConfigError(`autoMode.mode must be "manual" or "automatic", got ${String(input.autoMode.mode)}`);
    }
    for (const toggle of ["opened", "reopened", "synchronize", "readyForReview"] as const) {
      if (typeof input.autoMode.events[toggle] !== "boolean") {
        throw new ConfigError(`autoMode.events.${toggle} must be a boolean`);
      }
    }
    if (input.autoMode.mode === "automatic" && (input.autoMode.waitForChecks?.length ?? 0) > 0) {
      if (input.autoMode.waitForChecks!.some((name) => !name.trim())) {
        throw new ConfigError("autoMode.waitForChecks entries must be non-empty check names");
      }
    }
  }
  requireStage("primary", input.primary);
  requireStage("re-review", input.reReview);
  return input;
}
