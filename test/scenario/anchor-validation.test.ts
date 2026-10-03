/**
 * Ticket 02 scenario tests (spec: Testing Decisions — one seam: the review
 * host's process boundary). Each scenario sends `/review` and asserts only
 * what is visible on GitHub (the fake server's state) and in the durable run
 * state: invalid anchors go back to the re-reviewer, corrections publish at
 * the corrected anchor, withdrawals are not published, and an unresolved
 * invalid anchor fails the run with nothing posted.
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

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "nitpi-anchor-"));
  repo = createGitRepoFixture();
});

afterAll(async () => {
  repo.dispose();
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Windows can hold the SQLite file briefly after close; the OS temp dir
    // cleans up. Cleanup failure must not fail the suite.
  }
});

const PRIMARY_ARTIFACT = [
  "## Review artifact",
  "",
  "F1: The loop in handler() rebuilds result by concatenation — unnecessary complexity; a join() would be simpler.",
  "",
  "F2: The inlined trimming of each part happens twice, once here and once in the caller; missed simplification.",
].join("\n");

const FINAL_REVIEW_INVALID = [
  "# Final review",
  "",
  "## F1 — Unnecessary complexity: concatenation loop",
  "",
  "handler() rebuilds the result string inside a loop. A join() would be simpler and preserves behavior.",
  "",
  "Evidence: src/handler.ts lines 3-6 in the reviewed head replace the original one-line return.",
  "src/handler.ts | RIGHT | 99",
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
  '- F1: retained. Primary text: "The loop in handler() rebuilds result by concatenation".',
  '- F2: retained. Primary text: "The inlined trimming of each part happens twice".',
].join("\n");

const FINAL_REVIEW_WITHDRAWN = [
  "# Final review",
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
  '- F1: withdrawn. Primary text: "The loop in handler() rebuilds result by concatenation". Its anchor was not in the reviewed diff and no valid anchor exists, so the finding is withdrawn and not published.',
  '- F2: retained. Primary text: "The inlined trimming of each part happens twice".',
].join("\n");

const FINAL_REVIEW_ROUND1 = [
  "# Final review",
  "",
  "## F1 — Unnecessary complexity: concatenation loop",
  "",
  "handler() rebuilds the result string inside a loop. A join() would be simpler and preserves behavior.",
  "",
  "Evidence: unchanged caller code also trims; the anchor below is in the reviewed diff.",
  "src/handler.ts | RIGHT | 3 | RIGHT | 2",
  "",
  "## F2 — Missed simplification: double trimming",
  "",
  "Each part is trimmed both in handler() and again by callers, so the inner trim can move to the boundary.",
  "",
  "Evidence: the trim also appears in the caller added by this diff.",
  "src/handler.ts | RIGHT | 50",
  "",
  "# Audit notes",
  "",
  '- F1: amended. Primary text: "The loop in handler() rebuilds result by concatenation". Anchor corrected after host feedback: RIGHT 99 is not in the reviewed diff.',
  '- F2: retained. Primary text: "The inlined trimming of each part happens twice".',
].join("\n");

const FINAL_REVIEW_CORRECTED = [
  "# Final review",
  "",
  "## F1 — Unnecessary complexity: concatenation loop",
  "",
  "handler() rebuilds the result string inside a loop. A join() would be simpler and preserves behavior.",
  "",
  "Evidence: unchanged caller code also trims; the anchor below is in the reviewed diff.",
  "src/handler.ts | RIGHT | 3 | RIGHT | 2",
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
  '- F1: amended. Primary text: "The loop in handler() rebuilds result by concatenation". Anchor corrected after host feedback: RIGHT 99 is not in the reviewed diff.',
  '- F2: retained. Primary text: "The inlined trimming of each part happens twice".',
].join("\n");

interface Stage {
  host: ReviewHost;
  fake: FakeGitHub;
  reReviewStub: ModelStub;
}

async function openScenario(reReviewScript: StubScript, onReReviewServe?: (index: number) => void): Promise<Stage> {
  const fake = new FakeGitHub(
    [{ number: 7, headSha: repo.headSha, baseSha: repo.baseSha, state: "open" }],
    [],
    { diffText: unifiedDiff() },
  );
  const githubBase = await fake.listen();
  const primaryStub = new ModelStub(
    [{ text: [PRIMARY_ARTIFACT], finishReason: "stop" as const }],
    "stub-primary",
  );
  const reReviewStub = new ModelStub(reReviewScript, "stub-rereview", onReReviewServe);
  const [primaryBase, reReviewBase] = await Promise.all([primaryStub.listen(), reReviewStub.listen()]);
  const host = await openReviewHost(
    {
      repository: "example/widgets",
      pullNumber: 7,
      githubToken: "test-token",
      githubBaseUrl: githubBase,
      primary: { baseUrl: `${primaryBase}/v1`, modelId: "stub-primary", apiKey: "stub-primary-key" },
      reReview: { baseUrl: `${reReviewBase}/v1`, modelId: "stub-rereview", apiKey: "stub-rereview-key" },
      repositoryInstructions: "Be strict about unused parameters.",
      repositoryInstructionsRevision: repo.baseSha,
      headCheckoutSource: repo.headCheckout(),
    },
    join(workspace, `run-${Math.random().toString(36).slice(2)}.sqlite`),
  );
  return { host, fake, reReviewStub };
}

/** The newest user message of a recorded request (the resent history's last turn input). */
function lastUserMessage(messages: Array<{ role: string; content: unknown }> | undefined): string {
  const user = messages?.filter((m) => m.role === "user").at(-1);
  return typeof user?.content === "string" ? user.content : "";
}

describe("scenario: anchor validation and correction", () => {
  it("returns an invalid anchor to the re-reviewer and publishes the corrected anchor", async () => {
    const reReviewScript: StubScript = [
      { text: [FINAL_REVIEW_INVALID], finishReason: "stop" as const, usage: { promptTokens: 200, completionTokens: 90 } },
      { text: [FINAL_REVIEW_ROUND1], finishReason: "stop" as const, usage: { promptTokens: 205, completionTokens: 92 } },
      { text: [FINAL_REVIEW_CORRECTED], finishReason: "stop" as const, usage: { promptTokens: 210, completionTokens: 95 } },
    ];
    const stage = await openScenario(reReviewScript);
    try {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
      });
      await stage.host.waitForRun(started.runId);

      // The corrected finding publishes at its corrected anchor (a range);
      // the valid finding publishes unchanged.
      const review = stage.fake.publishedReviews(7).at(-1)!;
      expect(review.event).toBe("COMMENT");
      expect(review.commitId).toBe(repo.headSha);
      expect(review.body).toContain("2 findings");
      expect(review.comments).toHaveLength(2);
      expect(review.comments[0]).toMatchObject({
        path: "src/handler.ts",
        side: "RIGHT",
        line: 3,
        startSide: "RIGHT",
        startLine: 2,
      });
      expect(review.comments[1]).toMatchObject({ path: "src/handler.ts", side: "RIGHT", line: 5 });

      // The feedback turns reached the re-reviewer's own conversation with
      // each written anchor and the validator's reason (wire output).
      const firstFeedback = lastUserMessage(stage.reReviewStub.requests[1]?.body.messages);
      expect(firstFeedback).toContain("src/handler.ts | RIGHT | 99");
      expect(firstFeedback).toContain("not part of the reviewed diff");
      const secondFeedback = lastUserMessage(stage.reReviewStub.requests[2]?.body.messages);
      expect(secondFeedback).toContain("src/handler.ts | RIGHT | 50");
      expect(stage.reReviewStub.exhausted).toBe(true);

      // The final review froze only after validation: the frozen text is the
      // corrected one, and the correction round is recorded.
      const run = (await stage.host.runHistory().allRuns({} as never)).at(-1)!;
      expect(run.phase).toBe("published");
      expect(run.finalReview).toBe(FINAL_REVIEW_CORRECTED);
      expect(run.anchorRounds).toBe(2);
      expect(run.findings?.map((f) => f.label)).toEqual(["F1", "F2"]);
      expect(stage.fake.state.checks.at(-1)).toMatchObject({ state: "success", headSha: repo.headSha });
    } finally {
      await stage.host.close();
    }
  });

  it("publishes a withdrawn finding neither in comments nor summary, with the withdrawal in the audit notes", async () => {
    const reReviewScript: StubScript = [
      { text: [FINAL_REVIEW_INVALID], finishReason: "stop" as const, usage: { promptTokens: 200, completionTokens: 90 } },
      { text: [FINAL_REVIEW_WITHDRAWN], finishReason: "stop" as const, usage: { promptTokens: 210, completionTokens: 95 } },
    ];
    const stage = await openScenario(reReviewScript);
    try {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
      });
      await stage.host.waitForRun(started.runId);

      // The withdrawn finding is not published: only F2's comment remains.
      const review = stage.fake.publishedReviews(7).at(-1)!;
      expect(review.comments).toHaveLength(1);
      expect(review.comments[0]).toMatchObject({ path: "src/handler.ts", side: "RIGHT", line: 5 });
      expect(review.comments[0]!.body).not.toContain("F1");
      expect(review.body).toContain("1 finding");
      expect(review.body).not.toContain("2 findings");

      // The withdrawal is recorded in the audit notes stored with the run.
      const run = (await stage.host.runHistory().allRuns({} as never)).at(-1)!;
      expect(run.phase).toBe("published");
      expect(run.auditNotes).toContain("F1: withdrawn");
      expect(run.findings?.map((f) => f.label)).toEqual(["F2"]);
      expect(run.anchorRounds).toBe(1);
      expect(stage.fake.state.checks.at(-1)).toMatchObject({ state: "success", headSha: repo.headSha });
    } finally {
      await stage.host.close();
    }
  });

  it("fails the run when the re-reviewer finishes with an invalid anchor still in place; nothing is posted", async () => {
    const STILL_INVALID = FINAL_REVIEW_INVALID.replace(
      "src/handler.ts | RIGHT | 99",
      "src/handler.ts | RIGHT | 98",
    );
    // The correction loop allows three rounds; the model keeps the invalid
    // anchor in place through every one of them.
    const reReviewScript: StubScript = [
      { text: [FINAL_REVIEW_INVALID], finishReason: "stop" as const, usage: { promptTokens: 200, completionTokens: 90 } },
      { text: [STILL_INVALID], finishReason: "stop" as const, usage: { promptTokens: 210, completionTokens: 95 } },
      { text: [STILL_INVALID], finishReason: "stop" as const, usage: { promptTokens: 220, completionTokens: 95 } },
      { text: [STILL_INVALID], finishReason: "stop" as const, usage: { promptTokens: 230, completionTokens: 95 } },
    ];
    const stage = await openScenario(reReviewScript);
    try {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
      });
      await expect(stage.host.waitForRun(started.runId)).rejects.toThrow(/F1.*RIGHT \| 98|RIGHT \| 98.*F1/s);

      // Nothing is published: no review, and the check is a failure — never
      // a zero-finding success.
      expect(stage.fake.publishedReviews(7)).toHaveLength(0);
      const check = stage.fake.state.checks.at(-1)!;
      expect(check).toMatchObject({ state: "failure", headSha: repo.headSha });
      expect(check.summary).toContain("F1");

      const run = (await stage.host.runHistory().allRuns({} as never)).at(-1)!;
      expect(run.error).toContain("F1");
      expect(run.error).toContain("RIGHT | 98");
      expect(run.findings).toBeUndefined();
    } finally {
      await stage.host.close();
    }
  });

  it("fails the run when a resubmission silently drops a finding without recording the withdrawal", async () => {
    const SILENT_DROP = [
      "# Final review",
      "",
      "## F2 — Missed simplification: double trimming",
      "",
      "Each part is trimmed both in handler() and again by callers.",
      "",
      "src/handler.ts | RIGHT | 5",
      "",
      "# Audit notes",
      "",
      '- F2: retained. Primary text: "The inlined trimming of each part happens twice".',
    ].join("\n");
    const reReviewScript: StubScript = [
      { text: [FINAL_REVIEW_INVALID], finishReason: "stop" as const, usage: { promptTokens: 200, completionTokens: 90 } },
      { text: [SILENT_DROP], finishReason: "stop" as const, usage: { promptTokens: 210, completionTokens: 95 } },
    ];
    const stage = await openScenario(reReviewScript);
    try {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
      });
      // F1's section vanished and the audit notes never mention it: the
      // withdrawal was not recorded, so the run fails and nothing publishes.
      await expect(stage.host.waitForRun(started.runId)).rejects.toThrow(/F1/);
      expect(stage.fake.publishedReviews(7)).toHaveLength(0);
      expect(stage.fake.state.checks.at(-1)).toMatchObject({ state: "failure", headSha: repo.headSha });
    } finally {
      await stage.host.close();
    }
  });

  it("validates against the diff pinned at run start, not a PR diff that moved mid-run", async () => {
    // After the primary freezes, GitHub's live diff changes to a different
    // file entirely. The re-reviewer anchors on lines of the pinned diff.
    const LIVE_DIFF_AFTER_PUSH = [
      "diff --git a/src/added.ts b/src/added.ts",
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/src/added.ts",
      "@@ -0,0 +1,2 @@",
      "+export const added = 1;",
      "+export const added2 = 2;",
    ].join("\n");
    const reReviewScript: StubScript = [
      { text: [FINAL_REVIEW_CORRECTED], finishReason: "stop" as const, usage: { promptTokens: 200, completionTokens: 90 } },
    ];
    const stage = await openScenario(reReviewScript, (index) => {
      if (index === 0) stage?.fake.setPullDiff(LIVE_DIFF_AFTER_PUSH);
    });
    try {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
      });
      await stage.host.waitForRun(started.runId);

      // The anchors of the PINNED diff (fetched during primary) validate and
      // publish; validation against the live diff would have bounced them.
      const review = stage.fake.publishedReviews(7).at(-1)!;
      expect(review.comments).toHaveLength(2);
      const run = (await stage.host.runHistory().allRuns({} as never)).at(-1)!;
      expect(run.pinnedDiff).toBe(unifiedDiff());
      expect(run.anchorRounds).toBe(0);
      expect(run.phase).toBe("published");
    } finally {
      await stage.host.close();
    }
  });
});
