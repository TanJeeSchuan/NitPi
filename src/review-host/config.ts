/**
 * Workflow-input configuration for the two review stages. Per the spec's
 * Configuration decision: workflow inputs carry endpoints and instructions;
 * GitHub secrets carry credentials. Inputs arrive already resolved by the
 * trusted main-branch workflow.
 *
 * Custom prompts per stage are ticket 10 and intentionally absent here.
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
  requireStage("primary", input.primary);
  requireStage("re-review", input.reReview);
  return input;
}
