/**
 * Scenario test (spec: Testing Decisions — one seam: the review host's
 * process boundary).
 *
 * Sends the `/review` trigger and asserts two things only: what is visible on
 * GitHub (the fake server's state) and what is in the durable run state.
 * Everything inside the host runs for real: Pi Durable on a SQLite file, the
 * provider bridge over AI SDK streamText, run documents, per-stage checkouts,
 * and the publisher.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
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

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "nitpi-host-"));
  repo = createGitRepoFixture();
  fakeGithub = new FakeGitHub(
    [
      {
        number: 7,
        headSha: repo.headSha,
        baseSha: repo.baseSha,
        state: "open",
      },
    ],
    [
      // The reviewed diff: handler.ts lines 3 and 5 added on RIGHT (head checkout).
      "src/handler.ts#RIGHT#3",
      "src/handler.ts#RIGHT#5",
    ],
    // The pinned diff the anchor validator checks against (ticket 02).
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

interface Stage {
  primaryStub: ModelStub;
  reReviewStub: ModelStub;
  host: ReviewHost;
}

async function openHost(primaryScript: StubScript, reReviewScript: StubScript): Promise<Stage> {
  const primaryStub = new ModelStub(primaryScript, "stub-primary");
  const reReviewStub = new ModelStub(reReviewScript, "stub-rereview");
  const [primaryBase, reReviewBase] = await Promise.all([primaryStub.listen(), reReviewStub.listen()]);
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
      },
      reReview: {
        baseUrl: `${reReviewBase}/v1`,
        modelId: "stub-rereview",
        apiKey: "stub-rereview-key",
      },
      repositoryInstructions: "Be strict about unused parameters.",
      repositoryInstructionsRevision: repo.baseSha,
      headCheckoutSource: repo.headCheckout(),
    },
    join(workspace, `run-${Math.random().toString(36).slice(2)}.sqlite`),
  );
  return { primaryStub, reReviewStub, host };
}

const HANDLER_HEAD_BODY = ["export function handler(input: string): string {", "  const parts = input.split(',');", "  let result = '';"].join("\n");

const PRIMARY_ARTIFACT = [
  "## Review artifact",
  "",
  "F1: The loop in handler() rebuilds result by concatenation — unnecessary complexity; a join() would be simpler.",
  "",
  "F2: The inlined trimming of each part happens twice, once here and once in the caller; missed simplification.",
].join("\n");

const FINAL_REVIEW = [
  "# Final review",
  "",
  "## F1 — Unnecessary complexity: concatenation loop",
  "",
  "handler() rebuilds the result string inside a loop. `parts.map(p => p.trim().toUpperCase()).join(\" \")` is simpler and preserves behavior.",
  "",
  "Evidence: src/handler.ts lines 3-6 in the reviewed head replace the original one-line return expression.",
  "src/handler.ts | RIGHT | 3",
  "",
  "## F2 — Missed simplification: double trimming",
  "",
  "Each part is trimmed both in handler() and again by callers, so the inner trim can move to the boundary.",
  "",
  "Evidence: the trim also appears in the caller added by this diff.",
  "src/handler.ts | RIGHT | 5",
  "",
  "# Audit notes",
  "",
  "- F1: retained. Primary text: \"The loop in handler() rebuilds result by concatenation — unnecessary complexity\". Verified against the head checkout.",
  "- F2: amended. Primary text: \"The inlined trimming of each part happens twice, once here and once in the caller\". Restructured after verifying the caller.",
].join("\n");

describe("scenario: /review publishes a two-stage review", () => {
  it("runs the trigger gate: refuses non-writers and other repositories", async () => {
    const stage = await openHost([], []);
    try {
      // A non-writer's /review is refused before anything runs.
      fakeGithub.collaboratorPermissions["outsider"] = "read";
      const refused = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "outsider",
      });
      expect(refused.refused).toContain("is not a repository writer or maintainer");

      const wrongRepo = await stage.host.handleReviewCommand({
        repository: "example/other",
        pullNumber: 7,
        requester: "octocat",
      });
      expect(wrongRepo.refused).toContain("not configured");
    } finally {
      await stage.host.close();
    }
  });

  it("drives primary → frozen artifact → re-review → publication with one review and inline comments", async () => {
    const primaryScript: StubScript = [
      // Turn 1: primary reads the reviewed file (tool call), Pi's tool loop runs it.
      { toolCall: { id: "call-1", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
      // Turn 2: primary writes the free-form review artifact.
      { text: [PRIMARY_ARTIFACT], finishReason: "stop" as const, usage: { promptTokens: 100, completionTokens: 60 } },
    ];
    const reReviewScript: StubScript = [
      // Re-reviewer reads the file itself (own unchanged checkout), then finalizes.
      { toolCall: { id: "call-2", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
      { text: [FINAL_REVIEW], finishReason: "stop" as const, usage: { promptTokens: 200, completionTokens: 90 } },
    ];
    const stage = await openHost(primaryScript, reReviewScript);

    const started = await stage.host.handleReviewCommand({
      repository: "example/widgets",
      pullNumber: 7,
      requester: "octocat",
    });
    await stage.host.waitForRun(started.runId);

    // GitHub: exactly one submitted review anchored at the reviewed head.
    const reviews = fakeGithub.publishedReviews(7);
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review.event).toBe("COMMENT");
    expect(review.commitId).toBe(repo.headSha);
    expect(review.body).toContain(`\`${repo.headSha}\``);
    expect(review.body).toContain("2 findings");
    expect(review.body).toContain("Outcome");
    // Each final finding becomes one inline comment with a valid anchor.
    expect(review.comments).toHaveLength(2);
    expect(review.comments[0]).toMatchObject({ path: "src/handler.ts", side: "RIGHT", line: 3 });
    expect(review.comments[1]).toMatchObject({ path: "src/handler.ts", side: "RIGHT", line: 5 });
    // Inline comment bodies are the finding sections (explanation + evidence + location).
    expect(review.comments[0]!.body).toContain("Unnecessary complexity");
    expect(review.comments[0]!.body).toContain("src/handler.ts | RIGHT | 3");

    // Check outcome: in progress with head and current stage while running,
    // success after confirmed publication, regardless of findings. (Earlier
    // scenarios in this file post refusal checks on the same head; the run's
    // own checks are the in_progress ones.)
    const checks = fakeGithub.state.checks.filter((c) => c.headSha === repo.headSha);
    const firstCheck = checks.find((c) => c.state === "in_progress")!;
    expect(firstCheck.state).toBe("in_progress");
    expect(firstCheck.summary).toContain("stage: primary");
    expect(checks.at(-1)).toMatchObject({ state: "success" });

    // Durable history: run documents record subject, mode, phase, artifacts.
    const runs = await stage.host.runHistory().allRuns({} as never);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.subject).toEqual({
      repository: "example/widgets",
      pullNumber: 7,
      baseSha: repo.baseSha,
      headSha: repo.headSha,
    });
    expect(run.mode).toBe("normal");
    expect(run.phase).toBe("published");
    expect(run.artifactFrozen).toBe(true);
    expect(run.artifact).toBe(PRIMARY_ARTIFACT);
    expect(run.finalReview).toBe(FINAL_REVIEW);
    expect(run.auditNotes).toContain("# Audit notes");
    expect(run.findings?.map((f) => ({ label: f.label, path: f.path, side: f.side, line: f.line }))).toEqual([
      { label: "F1", path: "src/handler.ts", side: "RIGHT", line: 3 },
      { label: "F2", path: "src/handler.ts", side: "RIGHT", line: 5 },
    ]);
    expect(run.publication?.reviewId).toBe(review.id);
    // Repository instructions captured at a pinned revision, recorded per run.
    expect(run.repositoryInstructionsRevision).toBe(repo.baseSha);

    // The re-reviewer ran in a fresh task-owned conversation: scanning
    // conversations owned by the run's pipeline task finds it, and it is not
    // the canonical conversation.
    expect(run.pipelineTaskId).toBeTruthy();
    const owned = await listConversationsOwnedBy(stage.host, run.pipelineTaskId);
    expect(owned).toContain(run.reReviewConversationId);
    expect(owned).not.toContain(run.canonicalConversationId);

    // Usage accounting is recorded per run.
    expect(run.usage?.primary?.output).toBe(60);
    expect(run.usage?.reReview?.output).toBe(90);

    // The reviewers' tools ran against their own checkouts of the head: the
    // second primary wire request carries the read tool's result, which is the
    // head checkout's file content.
    const secondMessages = stage.primaryStub.requests[1]?.body.messages as
      | Array<{ role: string; content: unknown }>
      | undefined;
    const toolOutput = JSON.stringify(secondMessages ?? []);
    expect(toolOutput).toContain("toUpperCase");

    // Model endpoint scripts fully consumed, in order: 1 tool turn + 1 final per stage.
    expect(stage.primaryStub.exhausted).toBe(true);
    expect(stage.reReviewStub.exhausted).toBe(true);

    // Instructions each stage sent are wire output: the primary's system
    // prompt carries protocol + pinned thermo-nuclear policy + repository
    // instructions; the re-reviewer's carries its own role and audit contract.
    const primarySystem = firstSystemMessage(stage.primaryStub.requests[0]?.body.messages);
    expect(primarySystem).toContain("primary reviewer");
    // The pinned skill body, verbatim, with its provenance line.
    expect(primarySystem).toContain("cursor/plugins@c47b12849e43f18d5c374c7069c744cc55b0ea00");
    expect(primarySystem).toContain("Thermo-Nuclear Code Quality Review");
    expect(primarySystem).toContain("code judo");
    expect(primarySystem).toContain("presumptive blockers");
    expect(primarySystem).toContain("Be strict about unused parameters.");
    const reSystem = firstSystemMessage(stage.reReviewStub.requests[0]?.body.messages);
    expect(reSystem).toContain("re-reviewer");
    expect(reSystem).toContain("audit notes");
    expect(reSystem).toContain("Be strict about unused parameters.");
    // The frozen artifact reached the re-reviewer through its prompt.
    const reUser = firstUserMessage(stage.reReviewStub.requests[0]?.body.messages);
    expect(reUser).toContain("FROZEN PRIMARY REVIEW ARTIFACT");
    expect(reUser).toContain("The loop in handler() rebuilds result by concatenation");

    await stage.host.close();
  });

  it("publishes a zero-finding review and the check succeeds", async () => {
    const primaryScript: StubScript = [
      { text: ["No issues found. The change is a clean simplification."], finishReason: "stop" as const },
    ];
    const reReviewScript: StubScript = [
      {
        text: [
          "# Final review",
          "",
          "# Audit notes",
          "",
          "- Nothing to audit: the primary found nothing to verify.",
        ],
        finishReason: "stop" as const,
      },
    ];
    const stage = await openHost(primaryScript, reReviewScript);

    const started = await stage.host.handleReviewCommand({
      repository: "example/widgets",
      pullNumber: 7,
      requester: "octocat",
    });
    await stage.host.waitForRun(started.runId);

    const reviews = fakeGithub.publishedReviews(7);
    // This scenario's review lands after the first scenario's.
    const mine = reviews[reviews.length - 1]!;
    expect(mine.event).toBe("COMMENT");
    expect(mine.commitId).toBe(repo.headSha);
    expect(mine.body).toContain("0 findings");
    expect(mine.comments).toHaveLength(0);
    expect(fakeGithub.state.checks.at(-1)).toMatchObject({ state: "success", headSha: repo.headSha });

    const runs = await stage.host.runHistory().allRuns({} as never);
    const run = runs.at(-1)!;
    expect(run.phase).toBe("published");
    expect(run.artifact).toContain("No issues found");
    expect(run.findings).toEqual([]);

    await stage.host.close();
  });

  it("fails explicitly when the endpoint does not support tool calls; no fallback model", async () => {
    // The primary endpoint rejects tool-bearing requests with an explicit error.
    const primaryScript: StubScript = [
      { kind: "error", status: 400, body: { error: { message: "tools are not supported", code: "invalid_request_error" } } },
    ];
    const stage = await openHost(primaryScript, []);

    const trigger = await stage.host.handleReviewCommand({
      repository: "example/widgets",
      pullNumber: 7,
      requester: "octocat",
    });
    await expect(stage.host.waitForRun(trigger.runId)).rejects.toThrow(/tools are not supported/i);

    // No publication, and the re-review endpoint was never called (no fallback).
    expect(fakeGithub.publishedReviews(7).length).toBe(2); // only the previous scenarios'
    // The run recorded the failure and the check failed.
    const runs = await stage.host.runHistory().allRuns({} as never);
    const run = runs.at(-1)!;
    expect(run.error).toContain("tools are not supported");
    expect(fakeGithub.state.checks.at(-1)).toMatchObject({ state: "failure", headSha: repo.headSha });

    await stage.host.close();
  });
});

/** Wire helpers: extract messages from a recorded chat-completions request. */
type RecordedMessages = Array<{ role: string; content: unknown }> | undefined;

function firstSystemMessage(messages: RecordedMessages): string {
  const system = messages?.find((m) => m.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

function firstUserMessage(messages: RecordedMessages): string {
  const user = messages?.find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}

/** Durable-history read: conversations owned by one pipeline task. */
async function listConversationsOwnedBy(host: ReviewHost, taskId: string): Promise<string[]> {
  const history = host.runHistory();
  const page = await history.harness.commit(
    async (tx) => tx.scanConversations({ ownerTaskId: taskId as never }, 50, undefined),
    TODO_CONTEXT,
  );
  return page.items.map((c) => c.id as unknown as string);
}
