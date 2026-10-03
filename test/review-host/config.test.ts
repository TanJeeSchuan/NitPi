/**
 * Config validation: explicit errors before any model call. Ticket 10: the
 * per-stage custom prompt is workflow input; validation failures (unknown
 * mode, replace-with-empty) are `ConfigError`s raised by `resolveConfig`
 * before any stage is created or any endpoint is contacted.
 */
import { describe, expect, it } from "vitest";
import {
  resolveConfig,
  ConfigError,
  type ReviewHostConfig,
  type StageInput,
} from "../../src/review-host/config.js";
import { resolveInstructions } from "../../src/review-host/instructions.js";

const PIN = "cursor/plugins@c47b12849e43f18d5c374c7069c744cc55b0ea00";

function baseStage(): StageInput {
  return { baseUrl: "http://stage.test/v1", modelId: "stage-model", apiKey: "stage-key" };
}

function baseConfig(): ReviewHostConfig {
  return {
    repository: "example/widgets",
    pullNumber: 7,
    githubToken: "t",
    githubBaseUrl: "http://github.test",
    storage: { baseUrl: "http://storage.test", authToken: "storage-token" },
    primaryDeadlineMs: 300_000,
    reReviewDeadlineMs: 300_000,
    primary: baseStage(),
    reReview: baseStage(),
    repositoryInstructions: "Be strict about unused parameters.",
    repositoryInstructionsRevision: "a".repeat(40),
    headCheckoutSource: ".",
  };
}

describe("review host configuration", () => {
  it("accepts a valid configuration", () => {
    expect(() => resolveConfig(baseConfig())).not.toThrow();
  });

  it("rejects missing credentials, endpoints and model ids explicitly", () => {
    const missingKey: ReviewHostConfig = {
      ...baseConfig(),
      primary: { ...baseConfig().primary, apiKey: "" },
    };
    expect(() => resolveConfig(missingKey)).toThrow(ConfigError);

    const badBaseUrl: ReviewHostConfig = {
      ...baseConfig(),
      reReview: { ...baseConfig().reReview, baseUrl: "not-a-url" },
    };
    expect(() => resolveConfig(badBaseUrl)).toThrow(ConfigError);

    const noModel: ReviewHostConfig = {
      ...baseConfig(),
      primary: { ...baseConfig().primary, modelId: "" },
    };
    expect(() => resolveConfig(noModel)).toThrow(ConfigError);
  });

  it("rejects malformed repository, pull number and token", () => {
    const badRepo: ReviewHostConfig = { ...baseConfig(), repository: "owner_only" };
    expect(() => resolveConfig(badRepo)).toThrow(ConfigError);

    const badPull: ReviewHostConfig = { ...baseConfig(), pullNumber: 0 };
    expect(() => resolveConfig(badPull)).toThrow(ConfigError);

    const noToken: ReviewHostConfig = { ...baseConfig(), githubToken: "" };
    expect(() => resolveConfig(noToken)).toThrow(ConfigError);
  });

  it("validates automatic-mode configuration explicitly", () => {
    const noEvents = baseConfig();
    (noEvents as { autoMode?: unknown }).autoMode = { mode: "automatic" };
    expect(() => resolveConfig(noEvents)).toThrow(ConfigError);
    expect(() => resolveConfig(noEvents)).toThrow(/events is required/);

    const badToggle = baseConfig();
    (badToggle as { autoMode?: unknown }).autoMode = {
      mode: "automatic",
      events: { opened: true, reopened: true, synchronize: "yes", readyForReview: true },
    };
    expect(() => resolveConfig(badToggle)).toThrow(ConfigError);
    expect(() => resolveConfig(badToggle)).toThrow(/must be a boolean/);

    const emptyCheckName = baseConfig();
    (emptyCheckName as { autoMode?: unknown }).autoMode = {
      mode: "manual",
      events: { opened: false, reopened: false, synchronize: false, readyForReview: false },
      waitForChecks: ["  "],
    };
    // Garbage check names are rejected in every mode, so a later flip to
    // automatic does not silently ignore the typo.
    expect(() => resolveConfig(emptyCheckName)).toThrow(ConfigError);
  });

  it("requires pinned repository instructions and a checkout source", () => {
    const noInstructions: ReviewHostConfig = { ...baseConfig(), repositoryInstructions: "  " };
    expect(() => resolveConfig(noInstructions)).toThrow(ConfigError);

    const badRevision: ReviewHostConfig = {
      ...baseConfig(),
      repositoryInstructionsRevision: "short",
    };
    expect(() => resolveConfig(badRevision)).toThrow(ConfigError);

    const noCheckout: ReviewHostConfig = { ...baseConfig(), headCheckoutSource: "" };
    expect(() => resolveConfig(noCheckout)).toThrow(ConfigError);
  });

  it("requires the storage service endpoint and positive reviewer deadlines", () => {
    const noStorage = baseConfig();
    (noStorage as { storage: unknown }).storage = undefined;
    expect(() => resolveConfig(noStorage)).toThrow(ConfigError);

    const badStorageUrl = baseConfig();
    (badStorageUrl.storage as { baseUrl: string }).baseUrl = "not-a-url";
    expect(() => resolveConfig(badStorageUrl)).toThrow(ConfigError);

    const noStorageToken = baseConfig();
    (noStorageToken.storage as { authToken: string }).authToken = "";
    expect(() => resolveConfig(noStorageToken)).toThrow(ConfigError);

    const zeroDeadline = baseConfig();
    (zeroDeadline as { primaryDeadlineMs: number }).primaryDeadlineMs = 0;
    expect(() => resolveConfig(zeroDeadline)).toThrow(ConfigError);

    const weirdTimeout = baseConfig();
    (weirdTimeout as { reReviewDeadlineMs: number }).reReviewDeadlineMs = Number.NaN;
    expect(() => resolveConfig(weirdTimeout)).toThrow(ConfigError);
  });

  it("rejects replace mode with an empty prompt before anything runs", () => {
    const cfg: ReviewHostConfig = {
      ...baseConfig(),
      reReview: { ...baseConfig().reReview, customPrompt: { text: "", mode: "replace" } },
    };
    expect(() => resolveConfig(cfg)).toThrow(ConfigError);

    const whitespace: ReviewHostConfig = {
      ...baseConfig(),
      primary: { ...baseConfig().primary, customPrompt: { text: "   \n", mode: "replace" } },
    };
    expect(() => resolveConfig(whitespace)).toThrow(ConfigError);
  });

  it("rejects an unknown prompt mode", () => {
    const cfg: ReviewHostConfig = {
      ...baseConfig(),
      primary: {
        ...baseConfig().primary,
        customPrompt: { text: "anything", mode: "sometimes" as "append" | "replace" },
      },
    };
    expect(() => resolveConfig(cfg)).toThrow(ConfigError);
  });

  it("accepts append and replace prompts with text", () => {
    const cfg: ReviewHostConfig = {
      ...baseConfig(),
      primary: { ...baseConfig().primary, customPrompt: { text: "Focus on API changes.", mode: "append" } },
      reReview: { ...baseConfig().reReview, customPrompt: { text: "Verify harder.", mode: "replace" } },
    };
    expect(() => resolveConfig(cfg)).not.toThrow();
  });
});

describe("resolved instructions with custom prompts (ticket 10)", () => {
  it("append sends policy plus the custom prompt below the repository layer", () => {
    const resolved = resolveInstructions("primary", "Be strict about unused parameters.", {
      text: "Watch for leaked credentials.",
      mode: "append",
    });
    expect(resolved.promptMode).toBe("append");
    expect(resolved.customPrompt).toBe("Watch for leaked credentials.");
    expect(resolved.text.indexOf("Thermo-Nuclear Code Quality Review")).toBeGreaterThan(-1);
    expect(resolved.text.indexOf(PIN)).toBeGreaterThan(-1);
    expect(resolved.text.indexOf("Be strict about unused parameters.")).toBeGreaterThan(-1);
    expect(resolved.text.indexOf("Watch for leaked credentials.")).toBeGreaterThan(-1);
    expect(resolved.text.indexOf("Watch for leaked credentials.")).toBeGreaterThan(
      resolved.text.indexOf("Be strict about unused parameters."),
    );
  });

  it("replace drops the built-in policy but keeps protocol and repository instructions", () => {
    const resolved = resolveInstructions("re-review", "Be strict about unused parameters.", {
      text: "Judge only test coverage.",
      mode: "replace",
    });
    expect(resolved.promptMode).toBe("replace");
    expect(resolved.text).not.toContain("Thermo-Nuclear Code Quality Review");
    expect(resolved.text).not.toContain("code judo");
    expect(resolved.text).toContain("re-reviewer");
    expect(resolved.text).toContain("audit notes");
    expect(resolved.text).toContain("Be strict about unused parameters.");
  });

  it("no prompt keeps the built-in thermo-nuclear policy", () => {
    const resolved = resolveInstructions("primary", "repo rules");
    expect(resolved.promptMode).toBe("none");
    expect(resolved.customPrompt).toBeUndefined();
    expect(resolved.text).toContain(PIN);
    expect(resolved.text).toContain("Thermo-Nuclear Code Quality Review");
  });

  it("each stage's prompt reaches only that stage", () => {
    const primary = resolveInstructions("primary", "repo rules", { text: "PRIMARY ONLY", mode: "append" });
    const reReview = resolveInstructions("re-review", "repo rules", { text: "REREVIEW ONLY", mode: "append" });
    expect(primary.text).toContain("PRIMARY ONLY");
    expect(primary.text).not.toContain("REREVIEW ONLY");
    expect(reReview.text).toContain("REREVIEW ONLY");
    expect(reReview.text).not.toContain("PRIMARY ONLY");
  });

  it("append with empty text degrades to the built-in policy", () => {
    const resolved = resolveInstructions("primary", "repo rules", { text: "", mode: "append" });
    expect(resolved.promptMode).toBe("none");
    expect(resolved.customPrompt).toBeUndefined();
    expect(resolved.text).toContain(PIN);
  });

  it("append with whitespace-only text degrades to the built-in policy", () => {
    const resolved = resolveInstructions("primary", "repo rules", { text: "  \n", mode: "append" });
    expect(resolved.promptMode).toBe("none");
    expect(resolved.customPrompt).toBeUndefined();
  });

  it("replace with text produces no policy pin reference but includes protocol", () => {
    const resolved = resolveInstructions("primary", "repo rules", { text: "My policy.", mode: "replace" });
    expect(resolved.text).not.toContain(PIN);
    expect(resolved.text).toContain("primary reviewer");
  });
});
