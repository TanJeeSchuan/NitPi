/**
 * Scenario tests for ticket 10: custom prompts per stage.
 *
 * Same seam as review-publishes.test.ts: the review host's process boundary.
 * Each test sends the `/review` trigger and asserts only on wire-visible
 * results — the requests each model stub received — and durable run state.
 * Everything inside the host runs for real; the model endpoints are the
 * scripted OpenAI-compatible stubs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openReviewHost, type ReviewHost } from "../../src/review-host/review-host.js";
import { FakeGitHub } from "../fixtures/fake-github.js";
import { ModelStub, type StubScript } from "../fixtures/model-stub.js";
import { createGitRepoFixture, unifiedDiff, type GitRepoFixture } from "../fixtures/git-fixture.js";

let workspace: string;
let repo: GitRepoFixture;
let fakeGithub: FakeGitHub;
let githubBase: string;

const POLICY_PIN = "cursor/plugins@№47b12849e43f18d5c374c7069c744cc55b0ea00".replace("№", "c");

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "nitpi-host-"));
  repo = createGitRepoFixture();
  fakeGithub = new FakeGitHub(
    [{ number: 7, headSha: repo.headSha, baseSha: repo.baseSha, state: "open" }],
    ["src/handler.ts#RIGHT#3"],
    { diffText: unifiedDiff() },
  );
  githubBase = await fakeGithub.listen();
});

afterAll(async () => {
  await fakeGithub.close();
  repo.dispose();
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Windows can hold the SQLite file briefly after close; the OS temp dir
    // cleans up. Cleanup failure must not fail the suite.
  }
});

type CustomPrompt = { text: string; mode: "append" | "replace" };

interface Stage {
  primaryStub: ModelStub;
  reReviewStub: ModelStub;
  host: ReviewHost;
}

/** One shared script; each stage gets its own ModelStub around the same steps. */
async function openHostWith(options: {
  script?: StubScript;
  primaryScript?: StubScript;
  reReviewScript?: StubScript;
  primaryPrompt?: CustomPrompt;
  reReviewPrompt?: CustomPrompt;
}): Promise<Stage> {
  const primary = new ModelStub(options.primaryScript ?? DEFAULT_PRIMARY, "stub-primary");
  const reReview = new ModelStub(options.reReviewScript ?? DEFAULT_RE_REVIEW, "stub-rereview");
  const [primaryBase, reReviewBase] = await Promise.all([primary.listen(), reReview.listen()]);
  const host = await openReviewHost(
    {
      repository: "example/widgets",
      pullNumber: 7,
      githubToken: "test-token",
      githubBaseUrl: githubBase,
      primary: {
        baseUrl: `${primaryBase}/v1`,
        modelId: "stub-primary",
        apiKey: "stub-primary-key",
        ...(options.primaryPrompt ? { customPrompt: options.primaryPrompt } : {}),
      },
      reReview: {
        baseUrl: `${reReviewBase}/v1`,
        modelId: "stub-rereview",
        apiKey: "stub-rereview-key",
        ...(options.reReviewPrompt ? { customPrompt: options.reReviewPrompt } : {}),
      },
      repositoryInstructions: "Be strict about unused parameters.",
      repositoryInstructionsRevision: repo.baseSha,
      headCheckoutSource: repo.headCheckout(),
    },
    join(workspace, `run-${Math.random().toString(36).slice(2)}.sqlite`),
  );
  return { primaryStub: primary, reReviewStub: reReview, host };
}

const FINAL = [
  "# Final review",
  "",
  "# Audit notes",
  "",
  "- Nothing to audit: the primary found nothing to verify.",
].join("\n");

/**
 * Default scripts: the primary turns once (its free-form artifact), the
 * re-reviewer turns once with a zero-finding parseable final review.
 */
const DEFAULT_PRIMARY: StubScript = [
  { text: ["Nothing to report in the artifact."], finishReason: "stop" as const },
];
const DEFAULT_RE_REVIEW: StubScript = [{ text: [FINAL], finishReason: "stop" as const }];

async function startDefaultReview(stage: Stage): Promise<string> {
  const started = await stage.host.handleReviewCommand({
    repository: "example/widgets",
    pullNumber: 7,
    requester: "octocat",
  });
  expect(started.refused).toBeUndefined();
  return started.runId;
}

function systemMessageOf(stub: ModelStub): string {
  const messages = stub.requests[0]?.body.messages as Array<{ role: string; content: unknown }> | undefined;
  return lastSystemContent(messages);
}

function secondSystemMessageOf(stub: ModelStub): string {
  const messages = stub.requests[1]?.body.messages as Array<{ role: string; content: unknown }> | undefined;
  return lastSystemContent(messages);
}

/**
 * The conversation's effective system text: later `pi.system` entries patch
 * earlier ones, so the LAST system-role message carries the current sections.
 */
function lastSystemContent(messages: Array<{ role: string; content: unknown }> | undefined): string {
  const system = messages?.filter((m) => m.role === "system").at(-1);
  return typeof system?.content === "string" ? system.content : "";
}

describe("scenario: custom prompts per stage (ticket 10)", () => {
  it("append sends built-in policy plus the custom prompt, in layer order", async () => {
    const stage = await openHostWith({
      primaryPrompt: { text: "Watch for leaked credentials.", mode: "append" },
      reReviewPrompt: { text: "Verify every numeric claim.", mode: "append" },
    });
    try {
      const runId = await startDefaultReview(stage);
      await stage.host.waitForRun(runId);

      const primary = systemMessageOf(stage.primaryStub);
      expect(primary).toContain(POLICY_PIN);
      expect(primary).toContain("Watch for leaked credentials.");
      expect(primary.indexOf("Watch for leaked credentials.")).toBeGreaterThan(
        primary.indexOf("Be strict about unused parameters."),
      );

      const rereview = systemMessageOf(stage.reReviewStub);
      expect(rereview).toContain(POLICY_PIN);
      expect(rereview).toContain("Verify every numeric claim.");

      const run = (await stage.host.runHistory().allRuns({} as never)).at(-1)!;
      expect(run.resolvedInstructions?.primary?.promptMode).toBe("append");
      expect(run.resolvedInstructions?.primary?.customPrompt).toBe("Watch for leaked credentials.");
      expect(run.resolvedInstructions?.reReview?.promptMode).toBe("append");
      expect(run.resolvedInstructions?.reReview?.customPrompt).toBe("Verify every numeric claim.");
      expect(run.instructionHashes?.primary).toBeTruthy();
      expect(run.instructionHashes?.reReview).toBeTruthy();
    } finally {
      await stage.host.close();
    }
  });

  it("replace drops the built-in policy but keeps protocol and repository instructions", async () => {
    const stage = await openHostWith({
      primaryPrompt: { text: "Primary searches for leaked credentials only.", mode: "replace" },
    });
    try {
      const runId = await startDefaultReview(stage);
      await stage.host.waitForRun(runId);

      const primary = systemMessageOf(stage.primaryStub);
      expect(primary).toContain("Primary searches for leaked credentials only.");
      expect(primary).not.toContain("Thermo-Nuclear Code Quality Review");
      expect(primary).not.toContain(POLICY_PIN);
      expect(primary).toContain("You are the primary reviewer");
      // The protocol layer survived the replace: the artifact hand-off contract.
      expect(primary).toContain("review artifact");
      expect(primary).toContain("Be strict about unused parameters.");

      // Without its own custom prompt, the re-reviewer keeps the built-in policy.
      const rereview = systemMessageOf(stage.reReviewStub);
      expect(rereview).toContain("Thermo-Nuclear Code Quality Review");
      expect(rereview).toContain(POLICY_PIN);

      const run = (await stage.host.runHistory().allRuns({} as never)).at(-1)!;
      expect(run.resolvedInstructions?.primary?.promptMode).toBe("replace");
      expect(run.resolvedInstructions?.reReview?.promptMode).toBe("none");
    } finally {
      await stage.host.close();
    }
  });

  it("each stage's prompt reaches only that stage", async () => {
    const stage = await openHostWith({
      primaryPrompt: { text: "PRIMARY-SENTINEL", mode: "append" },
      reReviewPrompt: { text: "REREVIEW-SENTINEL", mode: "append" },
    });
    try {
      const runId = await startDefaultReview(stage);
      await stage.host.waitForRun(runId);

      const primary = systemMessageOf(stage.primaryStub);
      const rereview = systemMessageOf(stage.reReviewStub);
      expect(primary).toContain("PRIMARY-SENTINEL");
      expect(primary).not.toContain("REREVIEW-SENTINEL");
      expect(rereview).toContain("REREVIEW-SENTINEL");
      expect(rereview).not.toContain("PRIMARY-SENTINEL");
    } finally {
      await stage.host.close();
    }
  });

  it("when neither stage has a prompt, both get the built-in policy", async () => {
    const stage = await openHostWith({});
    try {
      const runId = await startDefaultReview(stage);
      await stage.host.waitForRun(runId);

      const primary = systemMessageOf(stage.primaryStub);
      expect(primary).toContain(POLICY_PIN);
      expect(primary).not.toContain("Additional review focus");

      const run = (await stage.host.runHistory().allRuns({} as never)).at(-1)!;
      expect(run.resolvedInstructions?.primary?.promptMode).toBe("none");
      expect(run.resolvedInstructions?.reReview?.promptMode).toBe("none");
      expect(run.resolvedInstructions?.primary?.customPrompt).toBeUndefined();
    } finally {
      await stage.host.close();
    }
  });

  it("a prompt changed between two normal runs is used by the second run in the shared PR conversation", async () => {
    // One host, one canonical PR conversation, two sequential runs. The
    // second run's primary turn is the second recorded wire request: its
    // system prompt must reflect the changed configuration.
    const stage = await openHostWith({
      primaryScript: [
        { text: ["FIRST RUN ARTIFACT"], finishReason: "stop" as const },
        { text: ["SECOND RUN ARTIFACT"], finishReason: "stop" as const },
      ],
      reReviewScript: [
        { text: [FINAL], finishReason: "stop" as const },
        { text: [FINAL], finishReason: "stop" as const },
      ],
      primaryPrompt: { text: "First-prompt sentinel.", mode: "append" },
    });
    try {
      const first = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
      });
      await stage.host.waitForRun(first.runId);

      // The configuration changes between the two runs (what a repository
      // owner editing the workflow inputs looks like to the reviewer).
      stage.host.replaceInstructions("primary", { text: "Second-prompt sentinel.", mode: "append" });

      const second = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
      });
      expect(second.runId).not.toBe(first.runId);
      await stage.host.waitForRun(second.runId);

      // The first wire request ran with the first prompt; the second run's
      // turn received the second one (the run's configure() patch rides in
      // the folded system text — pi-ai keeps the conversation-creation
      // baseline in the content and appends the updated section, so the
      // second prompt is present, and the run documents prove which run used
      // which instructions).
      const firstSystem = systemMessageOf(stage.primaryStub);
      expect(firstSystem).toContain("First-prompt sentinel.");
      const secondPrimarySystem = secondSystemMessageOf(stage.primaryStub);
      expect(secondPrimarySystem).toContain("Second-prompt sentinel.");
      expect(secondPrimarySystem).toContain(POLICY_PIN);

      // Run documents: each run stored the instructions it actually used.
      const runs = await stage.host.runHistory().allRuns({} as never);
      const firstDoc = runs.find((r) => r.runId === first.runId);
      const secondDoc = runs.find((r) => r.runId === second.runId);
      expect(firstDoc?.resolvedInstructions?.primary?.customPrompt).toBe("First-prompt sentinel.");
      expect(secondDoc?.resolvedInstructions?.primary?.customPrompt).toBe("Second-prompt sentinel.");
    } finally {
      await stage.host.close();
    }
  });

  it("recovery after a configuration change reads the run's stored instructions, not the new configuration", async () => {
    const stage = await openHostWith({
      primaryPrompt: { text: "Stored at run start.", mode: "replace" },
      reReviewPrompt: { text: "Also stored.", mode: "append" },
    });
    try {
      const runId = await startDefaultReview(stage);
      await stage.host.waitForRun(runId);

      const run = (await stage.host.runHistory().allRuns({} as never)).at(-1)!;
      // What a recovered process reads for this run: the run document's stored
      // resolution (pi-durable reads are the same in-process or after reopen).
      const recoveredPrimary = await stage.host
        .runHistory()
        .instructionsFor(run.runId, "primary", {} as never);
      expect(recoveredPrimary?.text).toContain("Stored at run start.");
      expect(recoveredPrimary?.promptMode).toBe("replace");
      expect(recoveredPrimary?.text).not.toContain(POLICY_PIN);

      const recoveredReReview = await stage.host
        .runHistory()
        .instructionsFor(run.runId, "re-review", {} as never);
      expect(recoveredReReview?.text).toContain("Also stored.");
      expect(recoveredReReview?.promptMode).toBe("append");
    } finally {
      await stage.host.close();
    }
  });

  it("replace mode with an empty prompt fails as a configuration error before any model call", async () => {
    // openReviewHost resolves the configuration before anything runs — and
    // `resolveConfig` rejects an empty replace prompt before opening storage,
    // registering providers, or contacting an endpoint.
    const primary = new ModelStub(DEFAULT_PRIMARY, "stub-primary");
    const reReview = new ModelStub(DEFAULT_RE_REVIEW, "stub-rereview");
    const [primaryBase, reReviewBase] = await Promise.all([primary.listen(), reReview.listen()]);
    await expect(
      openReviewHost(
        {
          repository: "example/widgets",
          pullNumber: 7,
          githubToken: "test-token",
          githubBaseUrl: githubBase,
          primary: {
            baseUrl: `${primaryBase}/v1`,
            modelId: "stub-primary",
            apiKey: "stub-primary-key",
            customPrompt: { text: "   \n\t", mode: "replace" },
          },
          reReview: { baseUrl: `${reReviewBase}/v1`, modelId: "stub-rereview", apiKey: "stub-rereview-key" },
          repositoryInstructions: "Be strict about unused parameters.",
          repositoryInstructionsRevision: repo.baseSha,
          headCheckoutSource: repo.headCheckout(),
        },
        join(workspace, `run-${Math.random().toString(36).slice(2)}.sqlite`),
      ),
    ).rejects.toThrow(/replace mode requires a non-empty custom prompt/);

    // No model call happened before the configuration error.
    expect(primary.requests.length).toBe(0);
    expect(reReview.requests.length).toBe(0);
    await primary.close();
    await reReview.close();
  });
});
