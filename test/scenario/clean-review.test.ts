/**
 * Scenario tests (ticket 07 — clean review; spec: Testing Decisions — the
 * review host's process boundary).
 *
 * Each test runs a real first (normal) review and then a `/review clean`
 * against one fake GitHub, asserting only externally visible results: what
 * GitHub shows, what the model stubs receive on the wire, and what is in the
 * durable run state and the canonical PR conversation.
 *
 * A clean run's pipeline has the same shape as a normal run (primary → frozen
 * artifact → re-review → final frozen → match → publish) plus the import
 * step; the run-1 scripts give the matching phase real published comment IDs
 * to reuse.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { commitImportedReport } from "../../src/review-host/review-task.js";
import {
  closeScenarioStage,
  firstSystemMessage,
  latestRun,
  lastUserMessage,
  openScenarioStage,
  runReview,
  type RecordedMessages,
  type ScenarioStage,
} from "../helpers/scenario-stage.js";
import { createGitRepoFixture, type GitRepoFixture } from "../fixtures/git-fixture.js";
import type { FakeReviewComment } from "../fixtures/fake-github.js";

let workspace: string;
let repo: GitRepoFixture;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "nitpi-clean-"));
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

// --- run-1 review text (the clean run must never see it before its freeze) ---

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
  "- F1: retained. Verified against the head checkout.",
  "- F2: amended after verifying the caller.",
].join("\n");

const RUN1_FINAL = [RUN1_F1_SECTION, "", RUN1_F2_SECTION, "", RUN1_AUDIT].join("\n");

const RUN1_PRIMARY = [
  { toolCall: { id: "call-1", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
  { text: [RUN1_ARTIFACT], finishReason: "stop" as const },
] as const;
const RUN1_REREVIEW = [
  { toolCall: { id: "call-2", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
  { text: [RUN1_FINAL], finishReason: "stop" as const },
] as const;

/** Distinctive strings only a run that saw earlier reviews would carry. */
const RUN1_MARKERS = [
  "preserves behavior",
  "to the boundary",
  "Unnecessary complexity",
  "double trimming",
  "Verified against the head checkout",
] as const;

// --- clean-run review text (this run's own context, at run-1's anchors) ------

const CLEAN_PRIMARY_ARTIFACT = [
  "## Review artifact",
  "",
  "F1: handler() assembles the result string with += inside the loop; building the list first and joining once is simpler.",
  "",
  "F2: Each part is trimmed twice along the path; the inner trim belongs at a single place.",
].join("\n");

const CLEAN_F1_SECTION = [
  "## F1 — String is rebuilt inside the loop",
  "",
  "handler() assembles the result string with += inside the loop; building the parts first and joining once is simpler. (Clean recheck.)",
  "",
  "Evidence: the loop in the reviewed head rebuilds the string line by line.",
  "src/handler.ts | RIGHT | 3",
].join("\n");

const CLEAN_F2_SECTION = [
  "## F2 — Trimming happens twice along the path",
  "",
  "The parts are trimmed in handler() and again by callers; the inner trim belongs at a single place. (Clean recheck.)",
  "",
  "Evidence: the trim appears again in the caller added by this diff.",
  "src/handler.ts | RIGHT | 5",
].join("\n");

const CLEAN_AUDIT = [
  "# Audit notes",
  "",
  "- F1: preserved from the clean review's own search.",
  "- F2: reverified on the clean checkout.",
].join("\n");

const CLEAN_FINAL = [CLEAN_F1_SECTION, "", CLEAN_F2_SECTION, "", CLEAN_AUDIT].join("\n");

/** A clean run with no prior history: one tool turn and one artifact turn. */
const CLEAN_PRIMARY_SCRIPT_FOR_FRESH_STAGE = [
  { toolCall: { id: "call-c1", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
  { text: [CLEAN_PRIMARY_ARTIFACT], finishReason: "stop" as const },
] as const;

/**
 * Script a clean run after run 1: a one-turn clean primary (tool + artifact),
 * the re-reviewer's final turn, and — only when earlier comments exist — the
 * matching turn. Steps are appended so they land after run 1's script.
 */
function scriptCleanRun(stage: ScenarioStage, matchReply?: string): void {
  stage.primaryStub.append({ toolCall: { id: "call-c1", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } });
  stage.primaryStub.append({ text: [CLEAN_PRIMARY_ARTIFACT], finishReason: "stop" as const });
  stage.reReviewStub.append({ text: [CLEAN_FINAL], finishReason: "stop" as const });
  if (matchReply !== undefined) {
    stage.reReviewStub.append({ text: [matchReply], finishReason: "stop" as const });
  }
}

async function openStage(
  primaryScript: readonly unknown[] = [],
  reReviewScript: readonly unknown[] = [],
): Promise<ScenarioStage> {
  return openScenarioStage(repo, {
    primary: primaryScript as never,
    reReview: reReviewScript as never,
    workspace,
  });
}

/** The `nitpi.imported-report` entries of one durable conversation. */
async function importedReports(host: ScenarioStage["host"], conversationId: string): Promise<EntryRecord[]> {
  const history = host.runHistory();
  const page = await history.harness.commit(
    async (tx) => tx.scanEntries({ conversationId: conversationId as never }, 100, undefined),
    TODO_CONTEXT,
  );
  return page.items.filter((e) => e.kind === "nitpi.imported-report");
}

/** Conversations owned by one pipeline task (their ids). */
async function conversationsOwnedBy(host: ScenarioStage["host"], taskId: string): Promise<string[]> {
  const history = host.runHistory();
  const page = await history.harness.commit(
    async (tx) => tx.scanConversations({ ownerTaskId: taskId as never }, 50, undefined),
    TODO_CONTEXT,
  );
  return page.items.map((c) => c.id as unknown as string);
}

/** Scan messages JSON for substrings — short negative assertions on wire. */
function messagesJson(messages: RecordedMessages): string {
  return JSON.stringify(messages ?? []);
}

/** GET reads that would return earlier review output: comment and review
 * listings. (The pull-request GET returns the PR or diff, not bot comments.) */
function isBannedRead(r: { method: string; path: string }): boolean {
  return r.method === "GET" && (/\/comments$/.test(r.path) || /\/reviews$/.test(r.path));
}

describe("scenario: /review clean runs a review without prior context (ticket 07)", () => {
  it("starts a clean run: primary and re-reviewer in fresh task-owned conversations, canonical idle, report imported", async () => {
    // No prior history: a clean run behaves like a normal run for
    // publication, reviews in fresh conversations, and still imports its own
    // report into the canonical PR conversation.
    const stage = await openStage(
      CLEAN_PRIMARY_SCRIPT_FOR_FRESH_STAGE,
      [{ text: [CLEAN_FINAL], finishReason: "stop" as const }],
    );
    try {
      const started = await runReview(stage, "/review clean");
      expect(started.runId).not.toBe("");

      const run = await latestRun(stage);
      expect(run.mode).toBe("clean");
      expect(run.phase).toBe("published");
      expect(run.primaryConversationId).toBeTruthy();

      // The import marker names the entry it appended — one report, once.
      const reports = await importedReports(stage.host, run.canonicalConversationId);
      expect(reports).toHaveLength(1);
      expect(run.imported?.entryId).toBe(reports[0]!.id);

      // Both reviewers ran in fresh task-owned conversations; the canonical
      // PR conversation is not among the pipeline task's conversations.
      const owned = await conversationsOwnedBy(stage.host, run.pipelineTaskId);
      expect(owned).toContain(run.primaryConversationId);
      expect(owned).toContain(run.reReviewConversationId);
      expect(owned).not.toContain(run.canonicalConversationId);

      // The canonical conversation stayed idle during the run: it carries no
      // model turns, only the imported report entry.
      const canonical = await importedReports(stage.host, run.canonicalConversationId);
      const allEntries = (
        await stage.host.runHistory().harness.commit(
          async (tx) => tx.scanEntries({ conversationId: run.canonicalConversationId as never }, 100, undefined),
          TODO_CONTEXT,
        )
      ).items;
      expect(allEntries).toHaveLength(1);
      expect(allEntries[0]!.kind).toBe("nitpi.imported-report");
      expect(canonical).toHaveLength(1);

      // The clean primary's prompt says this is a clean review.
      const messages = (stage.primaryStub.requests[0]?.body.messages ?? []) as Array<{ role: string; content: string }>;
      const firstUser = messages.filter((m) => m.role === "user")[0]?.content ?? "";
      expect(firstUser).toContain("Mode: clean");

      // Publication without any earlier threads: one review, inline comments.
      const reviews = stage.fake.publishedReviews(7);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.comments.map((c) => c.line)).toEqual([3, 5]);
      expect(stage.fake.state.checks.at(-1)).toMatchObject({ state: "success", headSha: repo.headSha });
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("keeps prior review context from both stubs before the freeze and blocks GitHub reads of earlier comments", async () => {
    // Run 1 publishes findings and two comments; the clean run must see none
    // of it until its own final review is frozen.
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      expect(run1.phase).toBe("published");
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      const beforeClean = stage.fake.requestLog.length;
      const served = {
        primary: stage.primaryStub.requests.length,
        reReview: stage.reReviewStub.requests.length,
      };
      // The freeze is the moment the clean re-reviewer's final-result request
      // arrives (the last request that may not carry earlier context).
      stage.onReReviewServe.current = (index) => {
        if (index === served.reReview) stage.freezeLogIndex = stage.fake.requestLog.length;
      };
      scriptCleanRun(stage, `F1 -> ${c1}\nF2 -> ${c2}\n`);
      await runReview(stage, "/review clean");

      // Wire isolation before the freeze: run-1 review text, findings, audit
      // notes, and comment IDs never reached the clean reviewers' requests.
      const preFreezeRequests = [
        ...stage.primaryStub.requests.slice(served.primary),
        stage.reReviewStub.requests[served.reReview]!,
      ];
      expect(preFreezeRequests.length).toBe(3);
      for (const request of preFreezeRequests) {
        const json = messagesJson(request.body.messages);
        for (const marker of RUN1_MARKERS) expect(json).not.toContain(marker);
        expect(json).not.toContain(`#${c1}`);
        expect(json).not.toContain(`#${c2}`);
      }
      // And it does carry this run's own frozen artifact (the allowed input).
      const cleanFinalJson = messagesJson(stage.reReviewStub.requests[served.reReview]!.body.messages);
      expect(cleanFinalJson).toContain("FROZEN PRIMARY REVIEW ARTIFACT");
      expect(cleanFinalJson).toContain("building the list first and joining once is simpler");

      // GitHub reads of earlier bot comments are blocked before the freeze:
      // no comment/review listings land between the clean run's start and its
      // freeze; the matching phase after the freeze does read them.
      expect(stage.freezeLogIndex).toBeGreaterThan(beforeClean);
      const preFreeze = stage.fake.requestLog.slice(beforeClean, stage.freezeLogIndex);
      expect(preFreeze.filter(isBannedRead)).toEqual([]);
      const postFreeze = stage.fake.requestLog.slice(stage.freezeLogIndex);
      expect(postFreeze.some(isBannedRead)).toBe(true);

      // The matching turn (after the freeze) is where the earlier published
      // findings and IDs arrive — for matching only.
      const matchPrompt = lastUserMessage(stage.reReviewStub.requests[served.reReview + 1]?.body.messages);
      expect(matchPrompt).toContain(`#${c1}`);
      expect(matchPrompt).toContain(`#${c2}`);
      expect(matchPrompt).toContain("MATCHING-ONLY");

      // Matching reuses run 1's threads — no duplicates on GitHub.
      const comments = stage.fake.prComments(7) as FakeReviewComment[];
      expect(comments.map((c) => c.id)).toEqual([c1, c2]);
      expect(comments[0]!.body).toContain("(Clean recheck.)");
      const run2 = await latestRun(stage);
      expect(run2.matches).toEqual([
        { label: "F1", commentId: c1 },
        { label: "F2", commentId: c2 },
      ]);
      expect(stage.fake.publishedReviews(7)).toHaveLength(1);
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("imports the report despite a publication failure", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // Clean run: F1 matches run 1's thread; F2 needs a fresh comment, and
      // GitHub refuses that POST with a permission error — a known
      // publication failure (ticket 05) that no retry or reconciliation can
      // clear; publication fails after the import.
      stage.fake.state.refuseNextWrite = { match: /comments$/, remaining: 1, status: 403, message: "Resource not accessible by integration" };
      scriptCleanRun(stage, `F1 -> ${c1}\nF2 -> none\n`);
      await expect(runReview(stage, "/review clean")).rejects.toThrow();

      const run2 = await latestRun(stage);
      expect(run2.checkStatus).toBe("failure");
      expect(run2.error).toBeTruthy();

      // The report joined the shared PR history anyway: imported exactly
      // once, before publication, with audit notes stripped.
      const reports = await importedReports(stage.host, run2.canonicalConversationId);
      expect(reports).toHaveLength(1);
      const reportJson = JSON.stringify(reports[0]!.model);
      expect(reportJson).toContain("Clean recheck");
      expect(reportJson).not.toContain("# Audit notes");
      expect(reportJson).not.toContain("preserved from the clean review");
      expect(run2.imported).toBeTruthy();
      expect(run2.imported?.entryId).toBe(reports[0]!.id);
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("an import retry (the crash-retry re-entry path) appends no second copy; normal runs are never imported", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      scriptCleanRun(stage, `F1 -> ${c1}\nF2 -> ${c2}\n`);
      await runReview(stage, "/review clean");
      const run2 = await latestRun(stage);
      expect(run2.phase).toBe("published");
      expect(run2.imported).toBeTruthy();
      expect(await importedReports(stage.host, run2.canonicalConversationId)).toHaveLength(1);

      // A crash between the import commit and the pipeline's next durable
      // step re-enters at the import step. The marker — committed in the
      // same transaction as the append — makes the re-entry a no-op.
      const skip = await commitImportedReport(stage.host.runHistory(), run2.runId, TODO_CONTEXT);
      expect(skip.imported).toBe(false);
      expect(await importedReports(stage.host, run2.canonicalConversationId)).toHaveLength(1);

      // Normal runs are never imported: their primary already runs in the
      // canonical conversation, so there is nothing to import.
      const normalSkip = await commitImportedReport(stage.host.runHistory(), run1.runId, TODO_CONTEXT);
      expect(normalSkip.imported).toBe(false);
      expect(await importedReports(stage.host, run1.canonicalConversationId)).toHaveLength(1);
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("a failed clean run is never imported", async () => {
    // Clean run with no history: the primary completes; the re-reviewer
    // endpoint fails before the final review exists.
    const stage = await openStage(
      CLEAN_PRIMARY_SCRIPT_FOR_FRESH_STAGE,
      [{ kind: "error", status: 500, body: { error: { message: "re-review model exploded" } } }],
    );
    try {
      await expect(runReview(stage, "/review clean")).rejects.toThrow("re-review model exploded");
      const run = await latestRun(stage);
      expect(run.mode).toBe("clean");
      expect(run.checkStatus).toBe("failure");
      expect(run.finalReview).toBeUndefined();
      expect(run.imported).toBeUndefined();
      expect(await importedReports(stage.host, run.canonicalConversationId)).toHaveLength(0);
      expect(stage.fake.state.checks.at(-1)).toMatchObject({ state: "failure", headSha: repo.headSha });
      expect(firstSystemMessage(stage.primaryStub.requests[0]?.body.messages)).toContain("primary reviewer");
    } finally {
      await closeScenarioStage(stage);
    }
  });

  it("the next normal run sees the imported report, and only the report", async () => {
    const stage = await openStage(RUN1_PRIMARY, RUN1_REREVIEW);
    try {
      await runReview(stage);
      const run1 = await latestRun(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // Run 2 (clean): its match turn maps its findings to none — the clean
      // findings post as fresh comments and run 1's threads resolve.
      scriptCleanRun(stage);
      stage.reReviewStub.append({ text: ["F1 -> none\nF2 -> none\n"], finishReason: "stop" as const });
      await runReview(stage, "/review clean");

      // Run 3: a normal zero-finding review; its primary shares the canonical
      // conversation and must see the imported report on the wire.
      stage.primaryStub.append({
        text: ["Review artifact: nothing new; the change is a clean simplification."],
        finishReason: "stop" as const,
      });
      stage.reReviewStub.append({
        text: ["# Final review\n\n# Audit notes\n\n- Nothing to audit."],
        finishReason: "stop" as const,
      });
      await runReview(stage);

      const run3 = await latestRun(stage);
      expect(run3.mode).toBe("normal");
      expect(run3.phase).toBe("published");
      const wire = messagesJson(stage.primaryStub.requests.at(-1)?.body.messages as never);
      // The imported report is visible to the next normal run…
      expect(wire).toContain("Clean recheck");
      // …while the clean run's private material is not: its re-reviewer
      // conversation (tool loop, matching turn) and audit notes stay out.
      expect(wire).not.toContain("MATCHING-ONLY");
      expect(wire).not.toContain("F1 -> ");
      expect(wire).not.toContain("preserved from the clean review");
      void c1;
      void c2;
    } finally {
      await closeScenarioStage(stage);
    }
  });
});
