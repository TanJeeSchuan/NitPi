/** Config validation: explicit errors before any model call. */
import { describe, expect, it } from "vitest";
import { resolveConfig, ConfigError, PromptConfigError, type ReviewHostConfig } from "../../src/review-host/config.js";

function baseConfig(): ReviewHostConfig {
  return {
    repository: "example/widgets",
    pullNumber: 7,
    githubToken: "t",
    githubBaseUrl: "http://github.test",
    primary: { baseUrl: "http://p.test/v1", modelId: "p-model", apiKey: "k", promptMode: "append" },
    reReview: { baseUrl: "http://r.test/v1", modelId: "r-model", apiKey: "k", promptMode: "append" },
    repositoryInstructions: "repo rules",
  };
}

describe("review host configuration", () => {
  it("accepts a valid configuration", () => {
    expect(() => resolveConfig(baseConfig())).not.toThrow();
  });

  it("rejects replace mode with an empty prompt before any model call", () => {
    const config = baseConfig();
    (config as { primary: ReviewHostConfig["primary"] }).primary = { ...config.primary, promptMode: "replace", customPrompt: "   " };
    try {
      resolveConfig(config);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(PromptConfigError);
      expect((error as PromptConfigError).stage).toBe("primary");
    }
  });

  it("rejects a custom prompt without a prompt mode", () => {
    const config = baseConfig();
    (config as { reReview: ReviewHostConfig["reReview"] }).reReview = { ...config.reReview, customPrompt: "verify harder", promptMode: undefined as never };
    expect(() => resolveConfig(config)).toThrow(PromptConfigError);
  });

  it("rejects missing credentials and malformed endpoints explicitly", () => {
    const config = baseConfig();
    (config as { primary: ReviewHostConfig["primary"] }).primary = { ...config.primary, apiKey: "" };
    expect(() => resolveConfig(config)).toThrow(ConfigError);

    const config2 = baseConfig();
    (config2 as { reReview: ReviewHostConfig["reReview"] }).reReview = { ...config2.reReview, baseUrl: "not-a-url" };
    expect(() => resolveConfig(config2)).toThrow(ConfigError);

    const config3 = baseConfig();
    (config3 as { repository: string }).repository = "owner_only";
    expect(() => resolveConfig(config3)).toThrow(ConfigError);
  });
});
