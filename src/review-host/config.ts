/**
 * Workflow-input configuration for the two review stages. Per the spec's
 * Configuration decision: workflow inputs carry endpoints and prompt policy;
 * GitHub secrets carry credentials. Inputs arrive already resolved.
 *
 * An endpoint that lacks streaming or tool-call support fails with an explicit
 * configuration error before any model call — there is no fallback model.
 */
import type { StageConfig } from "../pi-bridge/provider-bridge.js";

export type PromptMode = "append" | "replace";

/** One stage's resolved configuration. */
export interface StageInput {
  /** Base URL of the stage's OpenAI-compatible endpoint. */
  readonly baseUrl: string;
  /** Model ID at that endpoint. */
  readonly modelId: string;
  /** API key injected from a GitHub secret. */
  readonly apiKey: string;
  /** Optional custom prompt from the trusted main-branch workflow. */
  readonly customPrompt?: string;
  readonly promptMode: PromptMode;
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
   * by the trigger workflow and passed in as trusted text.
   */
  readonly repositoryInstructions: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class PromptConfigError extends ConfigError {
  readonly stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.name = "PromptConfigError";
    this.stage = stage;
  }
}

function requireStage(stage: string, input: StageInput | undefined): StageInput {
  if (!input) throw new ConfigError(`missing stage configuration for ${stage}`);
  if (!/^https?:\/\//.test(input.baseUrl)) {
    throw new ConfigError(`${stage} baseUrl must be an absolute http(s) URL`);
  }
  if (!input.modelId) throw new ConfigError(`${stage} modelId is required`);
  if (!input.apiKey) throw new ConfigError(`${stage} apiKey is required (GitHub secret)`);
  // Replace mode with an empty prompt is a configuration error reported before
  // any model call (spec: Custom prompts §9).
  if (input.promptMode === "replace" && !input.customPrompt?.trim()) {
    throw new PromptConfigError(stage, `${stage} promptMode is replace but the custom prompt is empty`);
  }
  if (!input.promptMode && input.customPrompt) {
    throw new PromptConfigError(stage, `${stage} has a custom prompt without a promptMode`);
  }
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
    throw new ConfigError(`pullNumber must be a positive integer`);
  }
  if (!input.githubToken) throw new ConfigError("githubToken is required");
  if (!input.repositoryInstructions?.trim()) {
    throw new ConfigError("repositoryInstructions are required (captured from the main branch at a pinned revision)");
  }
  requireStage("primary", input.primary);
  requireStage("re-review", input.reReview);
  return input;
}
