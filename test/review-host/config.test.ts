/** Config validation: explicit errors before any model call. */
import { describe, expect, it } from "vitest";
import { resolveConfig, ConfigError, type ReviewHostConfig, type StageInput } from "../../src/review-host/config.js";

function baseStage(): StageInput {
  return { baseUrl: "http://stage.test/v1", modelId: "stage-model", apiKey: "stage-key" };
}

function baseConfig(): ReviewHostConfig {
  return {
    repository: "example/widgets",
    pullNumber: 7,
    githubToken: "t",
    githubBaseUrl: "http://github.test",
    primary: baseStage(),
    reReview: baseStage(),
    repositoryInstructions: "repo rules",
    repositoryInstructionsRevision: "a".repeat(40),
    headCheckoutSource: ".",
  };
}

describe("review host configuration", () => {
  it("accepts a valid configuration", () => {
    expect(() => resolveConfig(baseConfig())).not.toThrow();
  });

  it("rejects missing credentials, endpoints and model ids explicitly", () => {
    const missingKey = baseConfig();
    (missingKey.primary as { apiKey: string }).apiKey = "";
    expect(() => resolveConfig(missingKey)).toThrow(ConfigError);

    const badBaseUrl = baseConfig();
    (badBaseUrl.reReview as { baseUrl: string }).baseUrl = "not-a-url";
    expect(() => resolveConfig(badBaseUrl)).toThrow(ConfigError);

    const noModel = baseConfig();
    (noModel.primary as { modelId: string }).modelId = "";
    expect(() => resolveConfig(noModel)).toThrow(ConfigError);
  });

  it("rejects malformed repository, pull number and token", () => {
    const badRepo = baseConfig();
    (badRepo as { repository: string }).repository = "owner_only";
    expect(() => resolveConfig(badRepo)).toThrow(ConfigError);

    const badPull = baseConfig();
    (badPull as { pullNumber: number }).pullNumber = 0;
    expect(() => resolveConfig(badPull)).toThrow(ConfigError);

    const noToken = baseConfig();
    (noToken as { githubToken: string }).githubToken = "";
    expect(() => resolveConfig(noToken)).toThrow(ConfigError);
  });

  it("requires pinned repository instructions and a checkout source", () => {
    const noInstructions = baseConfig();
    (noInstructions as { repositoryInstructions: string }).repositoryInstructions = "  ";
    expect(() => resolveConfig(noInstructions)).toThrow(ConfigError);

    const badRevision = baseConfig();
    (badRevision as { repositoryInstructionsRevision: string }).repositoryInstructionsRevision = "short";
    expect(() => resolveConfig(badRevision)).toThrow(ConfigError);

    const noCheckout = baseConfig();
    (noCheckout as { headCheckoutSource: string }).headCheckoutSource = "";
    expect(() => resolveConfig(noCheckout)).toThrow(ConfigError);
  });
});
