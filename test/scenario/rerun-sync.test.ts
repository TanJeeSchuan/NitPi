/**
 * Scenario tests (ticket 04 — maintained findings across reruns; spec:
 * Testing Decisions — the review host's process boundary).
 *
 * Each test runs a real first review and then a rerun against one fake
 * GitHub, asserting only externally visible results: what GitHub shows
 * (reviews, comments, threads, checks) and what is in the durable run state.
 * The match turn is scripted after run 1 so it can reference the real
 * published comment IDs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { FakeGitHub } from "../fixtures/fake-github.js";
import {
  closeScenarioStage,
  lastUserMessage,
  latestRun,
  openScenarioStage,
  runReview,
  type ScenarioStage,
} from "../helpers/scenario-stage.js";
import { createGitRepoFixture, type GitRepoFixture } from "../fixtures/git-fixture.js";

let workspace: string;
let repo: GitRepoFixture;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "nitpi-rerun-"));
  repo = createGitRepoFixture();
});

afterAll(() => {
  repo.dispose();
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Windows can hold the SQLite file briefly after close; the OS temp dir
    // cleans up. Cleanup failure must not fail the suite.
  }
});

// --- shared review text ------------------------------------------------------

const RUN1_ARTIFACT = [
  "## Review artifact",
  "",
  "F1: The loop in handler() rebuilds result by concatenation — unnecessary complexity; a join() would be simpler.",
  "",
  "F2: The inlined trimming of each part happens twice, once here and once in the caller; missed simplification.",
].join("\n");

const RUN1_F1_SECTION = [
  "## F1 — Unnecessary complexity: concatenation loop",
  "",
  "handler() rebuilds the result string inside a loop. `parts.map(p => p.trim().toUpperCase()).join(\" \")` is simpler and preserves behavior.",
  "",
  "Evidence: src/handler.ts lines 3-6 in the reviewed head replace the original one-line return expression.",
  "src/handler.ts | RIGHT | 3",
].join("\n");

const RUN1_F2_SECTION = [
  "## F2 — Missed simplification: double trimming",
  "",
  "Each part is trimmed both in handler() and again by callers, so the inner trim can move to the boundary.",
  "",
  "Evidence: the trim also appears in the caller added by this diff.",
  "src/handler.ts | RIGHT | 5",
].join("\n");

const RUN1_AUDIT = [
  "# Audit notes",
  "",
  "- F1: retained. Primary text: \"The loop in handler() rebuilds result by concatenation — unnecessary complexity\". Verified against the head checkout.",
  "- F2: amended. Primary text: \"The inlined trimming of each part happens twice, once here and once in the caller\". Restructured after verifying the caller.",
].join("\n");

const RUN1_FINAL = [RUN1_F1_SECTION, "", RUN1_F2_SECTION, "", RUN1_AUDIT].join("\n");

/** Run-1 scripts: one tool turn, one final turn, per stage. */
const RUN1_PRIMARY = [
  { toolCall: { id: "call-1", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
  { text: [RUN1_ARTIFACT], finishReason: "stop" as const },
] as const;
const RUN1_REREVIEW = [
  { toolCall: { id: "call-2", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
  { text: [RUN1_FINAL], finishReason: "stop" as const },
] as const;

/** Script run 2: a one-turn primary and the re-reviewer's final + match turn. */
function scriptRerun(stage: ScenarioStage, finalReview: string, matchReply: string): void {
  stage.primaryStub.append({ text: [RUN1_ARTIFACT], finishReason: "stop" as const });
  stage.reReviewStub.append({ text: [finalReview], finishReason: "stop" as const });
  stage.reReviewStub.append({ text: [matchReply], finishReason: "stop" as const });
}

async function openStage(primaryScript: readonly unknown[], reReviewScript: readonly unknown[]): Promise<ScenarioStage> {
  return openScenarioStage(repo, {
    primary: primaryScript as never,
    reReview: reReviewScript as never,
    workspace,
  });
}

describe("scenario: reruns maintain findings across review threads (ticket 04)", () => {
  it("rerun on the same head updates the summary and both comments and posts no duplicates", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      expect(run1.phase).toBe("published");
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // Run 2 reaches the same findings at the same anchors; the match turn
      // (scripted with run 1's real comment IDs) maps them to the originals.
      const run2Final = [
        RUN1_F1_SECTION.replace("preserves behavior.", "preserves behavior. (Rechecked on rerun.)"),
        "",
        RUN1_F2_SECTION.replace("to the boundary.", "to the boundary. (Rechecked on rerun.)"),
        "",
        RUN1_AUDIT.replace("Verified against the head checkout.", "Re-verified on the rerun."),
      ].join("\n");
      scriptRerun(stage, run2Final, `F1 -> ${c1}\nF2 -> ${c2}\n`);
      await runReview(stage);

      // GitHub: still exactly ONE submitted review — updated, not duplicated.
      const reviews = stage.fake.publishedReviews(7);
      expect(reviews).toHaveLength(1);
      const review = reviews[0]!;
      expect(review.commitId).toBe(repo.headSha);
      expect(review.body).toContain("2 findings");
      expect(review.body).toContain("(Rechecked on rerun.)");

      // The same two inline comments with updated bodies — no new comments.
      const comments = stage.fake.prComments(7);
      expect(comments).toHaveLength(2);
      expect(comments.map((c) => c.id)).toEqual([c1, c2]);
      expect(comments[0]!.body).toContain("(Rechecked on rerun.)");
      expect(comments[1]!.body).toContain("(Rechecked on rerun.)");

      // The check still lands on success.
      expect(stage.fake.state.checks.at(-1)).toMatchObject({ state: "success", headSha: repo.headSha });

      // Durable state: matching assignments recorded; the frozen final review
      // is byte-identical before and after matching.
      const run2 = await latestRun(stage);
      expect(run2.phase).toBe("published");
      expect(run2.finalReview).toBe(run2Final);
      expect(run2.findings?.map((f) => `${f.path} | ${f.side} | ${f.line}`)).toEqual([
        "src/handler.ts | RIGHT | 3",
        "src/handler.ts | RIGHT | 5",
      ]);
      expect(run2.matches).toEqual([
        { label: "F1", commentId: c1 },
        { label: "F2", commentId: c2 },
      ]);
      expect(run2.matchRejections).toEqual([]);
      expect(run2.earlierComments?.map((c) => c.id)).toEqual([c1, c2]);
      expect(run2.usage?.matching?.output).toBeGreaterThan(0);
      expect(run2.publication?.reviewId).toBe(review.id);

      // Wire output: the match turn showed the re-reviewer the earlier
      // published findings and their comment IDs.
      const matchPrompt = lastUserMessage(stage.reReviewStub.requests.at(-1)?.body.messages as never);
      expect(matchPrompt).toContain(`#${c1}`);
      expect(matchPrompt).toContain(`#${c2}`);
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("a reworded finding still updates its original thread by meaning", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // F1 is substantially reworded; the match turn still maps it to the
      // original comment by meaning.
      const rewordedF1 = [
        "## F1 — String rebuilt by concatenation",
        "",
        "The result is assembled part by part with +=; building the list first and joining once would be easier to read and cheaper.",
        "",
        "Evidence: src/handler.ts line 3 introduces the loop that rebuilds the string.",
        "src/handler.ts | RIGHT | 3",
      ].join("\n");
      const run2Final = [rewordedF1, "", RUN1_F2_SECTION, "", RUN1_AUDIT].join("\n");
      scriptRerun(stage, run2Final, `F1 -> ${c1}\nF2 -> ${c2}\n`);
      await runReview(stage);

      const comments = stage.fake.prComments(7);
      expect(comments).toHaveLength(2);
      expect(comments[0]!.id).toBe(c1);
      // The original thread now carries the reworded finding.
      expect(comments[0]!.body).toBe(rewordedF1);
      expect(comments[0]!.line).toBe(3);

      const run2 = await latestRun(stage);
      expect(run2.finalReview).toBe(run2Final);
      expect(run2.matches).toEqual([
        { label: "F1", commentId: c1 },
        { label: "F2", commentId: c2 },
      ]);
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("a finding recurring at a resolved thread's anchor reopens that thread and updates it", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // Someone resolved the bot's first thread by hand between runs, and a
      // person also replied under it.
      stage.fake.resolveThreadOfComment(c1, true);
      const humanReply = stage.fake.addSeededComment(7, {
        body: "Filed upstream — see #1201.",
        author: "helper-human",
        replyTo: c1,
      });
      expect(stage.fake.threadForComment(c1)!.resolved).toBe(true);

      const run2Final = [RUN1_F1_SECTION, "", RUN1_F2_SECTION, "", RUN1_AUDIT].join("\n");
      scriptRerun(stage, run2Final, `F1 -> ${c1}\nF2 -> ${c2}\n`);
      await runReview(stage);

      // The recurring finding reopened its thread (GraphQL unresolve) and
      // updated the comment.
      expect(stage.fake.threadForComment(c1)!.resolved).toBe(false);
      const comments = stage.fake.prComments(7);
      expect(comments.map((c) => c.id)).toEqual([c1, c2, humanReply.id]);
      expect(comments[0]!.body).toBe(RUN1_F1_SECTION);
      // The person's reply is untouched even though it shares the thread.
      expect(comments[2]!.body).toBe("Filed upstream — see #1201.");
      expect(comments[2]!.author).toBe("helper-human");
      // The untouched second thread stays as it was.
      expect(stage.fake.threadForComment(c2)!.resolved).toBe(false);

      const run2 = await latestRun(stage);
      expect(run2.phase).toBe("published");
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("a moved finding marks the old comment superseded and posts a replacement at the new anchor", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // F1 moved from line 3 to line 5; F2 stays at line 5.
      const movedF1 = [
        "## F1 — Unnecessary complexity: concatenation loop",
        "",
        "handler() rebuilds the result string inside a loop. The simplification still applies, now anchored at the loop it replaces. (Rechecked on rerun.)",
        "",
        "Evidence: the loop still rebuilds the result line by line.",
        "src/handler.ts | RIGHT | 5",
      ].join("\n");
      const run2Final = [
        movedF1,
        "",
        RUN1_F2_SECTION.replace("to the boundary.", "to the boundary. (Rechecked on rerun.)"),
        "",
        RUN1_AUDIT.replace("Verified against the head checkout.", "Re-verified on the rerun."),
      ].join("\n");
      scriptRerun(stage, run2Final, `F1 -> ${c1}\nF2 -> ${c2}\n`);
      await runReview(stage);

      const comments = stage.fake.prComments(7);
      expect(comments).toHaveLength(3);
      // The old comment is marked superseded and keeps its original text,
      // staying at the old anchor with its discussion.
      const old = comments.find((c) => c.id === c1)!;
      expect(old.line).toBe(3);
      expect(old.body).toContain("Superseded");
      expect(old.body).toContain("src/handler.ts | RIGHT | 3");
      // The replacement sits at the new anchor with the current section text.
      const replacement = comments.find((c) => c.id !== c1 && c.id !== c2)!;
      expect(replacement.line).toBe(5);
      expect(replacement.body).toBe(movedF1);
      // F2 still updates its own thread in the same run.
      expect(comments.find((c) => c.id === c2)!.body).toContain("(Rechecked on rerun.)");

      const run2 = await latestRun(stage);
      expect(run2.phase).toBe("published");
      expect(run2.publication?.reviewId).toBe((stage.fake.publishedReviews(7))[0]!.id);
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("a finding omitted by a complete rerun has its thread resolved, the reported one updated", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // Run 2 reports only F1: F2 is omitted by a complete current-head review.
      const partialF1 = [
        "## F1 — Unnecessary complexity: concatenation loop",
        "",
        "handler() rebuilds the result string inside a loop. The join() simplification still applies. (Still present.)",
        "",
        "Evidence: src/handler.ts lines 3-6 in the reviewed head replace the original one-line return expression.",
        "src/handler.ts | RIGHT | 3",
      ].join("\n");
      const run2Final = [partialF1, "", "# Audit notes", "", "- F1: retained; F2 no longer applies to the current head."].join("\n");
      scriptRerun(stage, run2Final, `F1 -> ${c1}\n`);
      await runReview(stage);

      // The omitted finding's thread is resolved (GraphQL resolve); nothing
      // was posted for it and its comment body is untouched.
      expect(stage.fake.threadForComment(c2)!.resolved).toBe(true);
      // The reported finding keeps its thread open and updated.
      expect(stage.fake.threadForComment(c1)!.resolved).toBe(false);
      const comments = stage.fake.prComments(7);
      expect(comments).toHaveLength(2);
      expect(comments.find((c) => c.id === c2)!.body).toBe(RUN1_F2_SECTION);
      expect(comments.find((c) => c.id === c1)!.body).toBe(partialF1);

      // Summary shows the current finding count.
      const review = stage.fake.publishedReviews(7)[0]!;
      expect(review.body).toContain("1 finding");
      expect(review.body).not.toContain("1 findings");

      const run2 = await latestRun(stage);
      expect(run2.phase).toBe("published");
      expect(run2.matches).toEqual([{ label: "F1", commentId: c1 }]);
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("model-supplied foreign comment IDs are rejected with a reason and never acted on", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // Two people commented since: one on F1's anchor, one reply to it.
      const humanRoot = stage.fake.addSeededComment(7, {
        path: "src/handler.ts",
        side: "RIGHT",
        line: 3,
        body: "I looked at this too — see the linked issue.",
        author: "helper-human",
      });
      stage.fake.addSeededComment(7, { body: "Same here.", author: "other-human", replyTo: humanRoot.id });

      const run2Final = [RUN1_F1_SECTION, "", RUN1_F2_SECTION, "", RUN1_AUDIT].join("\n");
      // A buggy match turn points at a human comment and at an ID that does
      // not exist on this pull request.
      scriptRerun(stage, run2Final, `F1 -> ${humanRoot.id}\nF2 -> 999999\n`);
      await runReview(stage);

      const run2 = await latestRun(stage);
      expect(run2.phase).toBe("published");
      expect(run2.matchRejections).toEqual([
        {
          label: "F1",
          commentId: humanRoot.id,
          reason: expect.stringContaining("was not written by the reviewer bot"),
        },
        {
          label: "F2",
          commentId: 999999,
          reason: expect.stringContaining("does not belong to this pull request"),
        },
      ]);

      // The people's comments were never edited, resolved or reopened.
      expect(humanRoot.body).toBe("I looked at this too — see the linked issue.");
      expect(stage.fake.threadForComment(humanRoot.id)!.resolved).toBe(false);

      // Both findings were still published, as new comments at their anchors;
      // the earlier bot threads they failed to claim are resolved instead.
      const comments = stage.fake.prComments(7);
      expect(comments).toHaveLength(6);
      const posted = comments.slice(-2);
      expect(posted[0]!.line).toBe(3);
      expect(posted[0]!.body).toBe(RUN1_F1_SECTION);
      expect(posted[1]!.line).toBe(5);
      expect(posted[1]!.body).toBe(RUN1_F2_SECTION);
      expect(stage.fake.threadForComment(c1)!.resolved).toBe(true);
      expect(stage.fake.threadForComment(c2)!.resolved).toBe(true);

      // Wire output: the match turn showed only the bot's earlier comments,
      // never the human ones.
      const matchPrompt = lastUserMessage(stage.reReviewStub.requests.at(-1)?.body.messages as never);
      expect(matchPrompt).toContain(`#${c1}`);
      expect(matchPrompt).not.toContain("I looked at this too");
      expect(matchPrompt).not.toContain("helper-human");
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("a superseded comment is out of the matching pool: re-matching it is rejected and the banner survives", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      // Run 1: F1@3, F2@5.
      await runReview(stage);
      const run1 = await latestRun(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // Run 2: F1 moved to line 5 — run 2's replacement comment id is known
      // only after the run; script run 3 from the fake afterwards.
      const movedF1 = [
        "## F1 — Unnecessary complexity: concatenation loop",
        "",
        "The finding still applies at the loop it now anchors. (Rechecked on rerun.)",
        "",
        "Evidence: the loop still rebuilds the result line by line.",
        "src/handler.ts | RIGHT | 5",
      ].join("\n");
      const movedFinal = [movedF1, "", RUN1_F2_SECTION, "", RUN1_AUDIT].join("\n");
      scriptRerun(stage, movedFinal, `F1 -> ${c1}\nF2 -> ${c2}\n`);
      await runReview(stage);
      const replacement = stage.fake.prComments(7).find((c) => c.id !== c1 && c.id !== c2)!.id;

      // Run 3: the match turn (wrongly) points the still-current finding at
      // the superseded comment instead of its replacement.
      stage.primaryStub.append({ text: [RUN1_ARTIFACT], finishReason: "stop" as const });
      stage.reReviewStub.append({ text: [movedFinal], finishReason: "stop" as const });
      stage.reReviewStub.append({ text: [`F1 -> ${c1}\nF2 -> ${c2}\n`], finishReason: "stop" as const });
      await runReview(stage);

      const run3 = await latestRun(stage);
      expect(run3.phase).toBe("published");
      expect(run3.matchRejections).toEqual([
        {
          label: "F1",
          commentId: c1,
          reason: expect.stringContaining("was superseded earlier"),
        },
      ]);

      // The superseded banner was not overwritten; the old thread carries it
      // still, and the finding was published fresh instead.
      const comments = stage.fake.prComments(7);
      expect(comments.find((c) => c.id === c1)!.body).toContain("**Superseded:**");
      // The run-2 replacement is untouched; run 3 posted a new comment at
      // the current anchor alongside it.
      expect(comments.find((c) => c.id === replacement)!.body).toBe(movedF1);
      expect(comments.filter((c) => c.line === 5)).toHaveLength(3);
      expect(comments).toHaveLength(4);

      // The match pool excluded the superseded comment: the prompt listed the
      // replacement, never the superseded id.
      const match3Prompt = lastUserMessage(stage.reReviewStub.requests.at(-1)?.body.messages as never);
      expect(match3Prompt).toContain(`#${replacement}`);
      expect(match3Prompt).not.toContain(`#${c1}`);
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("matches earlier bot comments even when no bot summary review exists", async () => {
    // Odd state: bot threads exist but the summary review is gone (someone
    // deleted it by hand). A run must still match and update the threads
    // instead of re-posting everything.
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      const seeded1 = stage.fake.addSeededComment(7, {
        path: "src/handler.ts",
        side: "RIGHT",
        line: 3,
        body: "## F1 — older text of the same finding",
        author: "nitpi-reviewer[bot]",
      });
      const seeded2 = stage.fake.addSeededComment(7, {
        path: "src/handler.ts",
        side: "RIGHT",
        line: 5,
        body: "## F2 — older text of the same finding",
        author: "nitpi-reviewer[bot]",
      });

      // The one run's scripts were handed to openStage; the match turn is
      // appended now that the seeded comment ids are known.
      stage.reReviewStub.append({ text: [`F1 -> ${seeded1.id}\nF2 -> ${seeded2.id}\n`], finishReason: "stop" as const });
      await runReview(stage);

      const run = await latestRun(stage);
      expect(run.phase).toBe("published");
      // Both earlier threads were updated in place — no duplicates.
      const comments = stage.fake.prComments(7);
      expect(comments.map((c) => c.id)).toEqual([seeded1.id, seeded2.id]);
      expect(comments[0]!.body).toBe(RUN1_F1_SECTION);
      expect(comments[1]!.body).toBe(RUN1_F2_SECTION);
      // A summary review was created (body only) — one bot review total.
      const reviews = stage.fake.publishedReviews(7);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.comments).toHaveLength(0);
      expect(reviews[0]!.body).toContain("2 findings");
    } finally {
      await closeScenarioStage(stage);
    }
  });
});
