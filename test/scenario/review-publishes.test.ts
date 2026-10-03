/**
 * Scenario test (spec: Testing Decisions — one seam: the review host's
 * process boundary) against the real storage service on localhost (ticket
 * 06): every run's durable state lives on the service, not in direct local
 * SQLite.
 *
 * Sends the `/review` trigger and asserts what is visible on GitHub (the
 * fake server's state) and what is in the durable run state. Everything
 * inside the host runs for real: Pi Durable over the storage service, the
 * provider bridge over AI SDK streamText, run documents, per-stage
 * checkouts, and the publisher (with ticket 02's anchor validation).
 */
import { afterAll, describe, expect, it } from "vitest";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import { openScenarioJar, type ScenarioJar } from "../fixtures/scenario-jar.js";
import type { RunHistory } from "../../src/review-host/run-history.js";
import type { StubScript } from "../fixtures/model-stub.js";

const jars: ScenarioJar[] = [];

afterAll(async () => {
  for (const jar of jars.splice(0).reverse()) {
    await jar.dispose();
  }
});

async function openJar(options: {
  pullNumber: number;
  primaryScript: StubScript;
  reReviewScript: StubScript;
}): Promise<ScenarioJar> {
  const jar = await openScenarioJar({
    pullNumber: options.pullNumber,
    diffAnchors: ["src/handler.ts#RIGHT#3", "src/handler.ts#RIGHT#5"],
    primaryScript: options.primaryScript,
    reReviewScript: options.reReviewScript,
  });
  jars.push(jar);
  return jar;
}

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
  'handler() rebuilds the result string inside a loop. `parts.map(p => p.trim().toUpperCase()).join(" ")` is simpler and preserves behavior.',
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
  '- F1: retained. Primary text: "The loop in handler() rebuilds result by concatenation — unnecessary complexity". Verified against the head checkout.',
  '- F2: amended. Primary text: "The inlined trimming of each part happens twice, once here and once in the caller". Restructured after verifying the caller.',
].join("\n");

describe("scenario: /review publishes a two-stage review", () => {
  it("runs the trigger gate: refuses non-writers and other repositories", async () => {
    const jar = await openJar({ pullNumber: 7, primaryScript: [], reReviewScript: [] });
    const stage = await jar.openHost();
    try {
      // A non-writer's /review is refused before anything runs.
      jar.fakeGithub.collaboratorPermissions["outsider"] = "read";
      const refused = await stage.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 7,
        requester: "outsider",
      });
      expect(refused.refused).toContain("is not a repository writer or maintainer");

      const wrongRepo = await stage.handleReviewCommand({
        repository: "example/other",
        pullNumber: 7,
        requester: "octocat",
      });
      expect(wrongRepo.refused).toContain("not configured");
    } finally {
      await stage.close();
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
    const jar = await openJar({ pullNumber: 8, primaryScript, reReviewScript });
    const stage = await jar.openHost();

    const started = await stage.handleReviewCommand({
      repository: "example/scenario",
      pullNumber: 8,
      requester: "octocat",
    });
    await stage.waitForRun(started.runId);

    // GitHub: exactly one submitted review anchored at the reviewed head.
    const reviews = jar.fakeGithub.publishedReviews(8);
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review.event).toBe("COMMENT");
    expect(review.commitId).toBe(jar.headSha);
    expect(review.body).toContain(`\`${jar.headSha}\``);
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
    // success after confirmed publication, regardless of findings.
    const checks = jar.fakeGithub.state.checks;
    expect(checks[0]).toMatchObject({ state: "in_progress" });
    expect(checks[0]!.summary).toContain("stage: primary");
    expect(checks.at(-1)).toMatchObject({ state: "success" });

    // Durable history (on the storage service): run documents record subject,
    // mode, phase, artifacts.
    const runs = await stage.runHistory().allRuns({} as never);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.subject).toEqual({
      repository: "example/scenario",
      pullNumber: 8,
      baseSha: jar.baseSha,
      headSha: jar.headSha,
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
    expect(run.repositoryInstructionsRevision).toBe(jar.baseSha);
    // The pinned diff (ticket 02) is part of the durable run state.
    expect(run.pinnedDiff).toContain("diff --git");

    // The re-reviewer ran in a fresh task-owned conversation: scanning
    // conversations owned by the run's pipeline task finds it, and it is not
    // the canonical conversation.
    expect(run.pipelineTaskId).toBeTruthy();
    const owned = await listConversationsOwnedBy(stage.runHistory(), run.pipelineTaskId);
    expect(owned).toContain(run.reReviewConversationId);
    expect(owned).not.toContain(run.canonicalConversationId);

    // Usage accounting is recorded per run.
    expect(run.usage?.primary?.output).toBe(60);
    expect(run.usage?.reReview?.output).toBe(90);

    // The reviewers' tools ran against their own checkouts of the head: the
    // second primary wire request carries the read tool's result, which is the
    // head checkout's file content.
    const secondMessages = jar.primaryStub.requests[1]?.body.messages as
      | Array<{ role: string; content: unknown }>
      | undefined;
    const toolOutput = JSON.stringify(secondMessages ?? []);
    expect(toolOutput).toContain("toUpperCase");

    // Model endpoint scripts fully consumed, in order: 1 tool turn + 1 final per stage.
    expect(jar.primaryStub.exhausted).toBe(true);
    expect(jar.reReviewStub.exhausted).toBe(true);

    // Instructions each stage sent are wire output: the primary's system
    // prompt carries protocol + pinned thermo-nuclear policy + repository
    // instructions; the re-reviewer's carries its own role and audit contract.
    const primarySystem = firstSystemMessage(jar.primaryStub.requests[0]?.body.messages);
    expect(primarySystem).toContain("primary reviewer");
    // The pinned skill body, verbatim, with its provenance line.
    expect(primarySystem).toContain("cursor/plugins@c47b12849e43f18d5c374c7069c744cc55b0ea00");
    expect(primarySystem).toContain("Thermo-Nuclear Code Quality Review");
    expect(primarySystem).toContain("code judo");
    expect(primarySystem).toContain("presumptive blockers");
    expect(primarySystem).toContain("Be strict about unused parameters.");
    const reSystem = firstSystemMessage(jar.reReviewStub.requests[0]?.body.messages);
    expect(reSystem).toContain("re-reviewer");
    expect(reSystem).toContain("audit notes");
    expect(reSystem).toContain("Be strict about unused parameters.");
    // The frozen artifact reached the re-reviewer through its prompt.
    const reUser = firstUserMessage(jar.reReviewStub.requests[0]?.body.messages);
    expect(reUser).toContain("FROZEN PRIMARY REVIEW ARTIFACT");
    expect(reUser).toContain("The loop in handler() rebuilds result by concatenation");

    await stage.close();
  });

  it("publishes a zero-finding review and the check succeeds", async () => {
    const jar = await openJar({
      pullNumber: 9,
      primaryScript: [{ text: ["No issues found. The change is a clean simplification."], finishReason: "stop" as const }],
      reReviewScript: [
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
      ],
    });
    const stage = await jar.openHost();

    const started = await stage.handleReviewCommand({
      repository: "example/scenario",
      pullNumber: 9,
      requester: "octocat",
    });
    await stage.waitForRun(started.runId);

    const reviews = jar.fakeGithub.publishedReviews(9);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.event).toBe("COMMENT");
    expect(reviews[0]!.commitId).toBe(jar.headSha);
    expect(reviews[0]!.body).toContain("0 findings");
    expect(reviews[0]!.comments).toHaveLength(0);
    expect(jar.fakeGithub.state.checks.at(-1)).toMatchObject({
      state: "success",
      headSha: jar.headSha,
    });

    const runs = await stage.runHistory().allRuns({} as never);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.phase).toBe("published");
    expect(runs[0]!.artifact).toContain("No issues found");
    expect(runs[0]!.findings).toEqual([]);

    await stage.close();
  });

  it("fails explicitly when the endpoint does not support tool calls; no fallback model", async () => {
    // The primary endpoint rejects tool-bearing requests with an explicit error.
    const jar = await openJar({
      pullNumber: 10,
      primaryScript: [
        { kind: "error", status: 400, body: { error: { message: "tools are not supported", code: "invalid_request_error" } } },
      ],
      reReviewScript: [
        { kind: "error", status: 400, body: { error: { message: "tools are not supported", code: "invalid_request_error" } } },
      ],
    });
    const stage = await jar.openHost();

    const trigger = await stage.handleReviewCommand({
      repository: "example/scenario",
      pullNumber: 10,
      requester: "octocat",
    });
    await expect(stage.waitForRun(trigger.runId)).rejects.toThrow(/tools are not supported/i);

    // No publication, and the re-review endpoint was never called (no fallback).
    expect(jar.fakeGithub.publishedReviews(10)).toHaveLength(0);
    expect(jar.reReviewStub.requests).toHaveLength(0);
    // The run recorded the failure and the check failed.
    const runs = await stage.runHistory().allRuns({} as never);
    expect(runs[0]!.error).toContain("tools are not supported");
    expect(jar.fakeGithub.state.checks.at(-1)).toMatchObject({
      state: "failure",
      headSha: jar.headSha,
    });

    await stage.close();
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
async function listConversationsOwnedBy(history: RunHistory, taskId: string): Promise<string[]> {
  const page = await history.harness.commit(
    async (tx) => tx.scanConversations({ ownerTaskId: taskId as never }, 50, undefined),
    TODO_CONTEXT,
  );
  return page.items.map((c) => c.id as unknown as string);
}
