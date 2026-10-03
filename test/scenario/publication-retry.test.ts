/**
 * Scenario tests (ticket 05 — publication idempotency and retry).
 *
 * GitHub's create endpoints have no idempotency key, so the publisher
 * records what it intends to write before writing (the operation ledger on
 * the PR's durable storage), records the remote ID once GitHub confirms, and
 * reconciles a write whose outcome never arrived against GitHub's actual
 * state before retrying. Rate limits follow `Retry-After` (at least one
 * minute without it) with exponential back-off; auth, permission and anchor
 * errors fail once with a reason. A known publication failure keeps the
 * completed final review; the retry publishes it with zero new model calls.
 *
 * Everything runs for real inside the host (Pi Durable over the storage
 * service, the publication child task, the ledgered publisher); the fake
 * GitHub can apply a write and destroy the response, refuse one with a
 * status and `Retry-After`, or cap list pages to force real pagination.
 */
import { afterAll, describe, expect, it } from "vitest";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import { PublicationLedger, PublicationLedgerDoc } from "../../src/github/ledger.js";
import { openScenarioJar, type ScenarioJar } from "../fixtures/scenario-jar.js";
import type { StubScript, StubTurn } from "../fixtures/model-stub.js";

type Stage = Awaited<ReturnType<ScenarioJar["openHost"]>>;

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
  publicationSleep?: (ms: number) => Promise<void>;
}): Promise<ScenarioJar> {
  const jar = await openScenarioJar({
    pullNumber: options.pullNumber,
    diffAnchors: ["src/handler.ts#RIGHT#3", "src/handler.ts#RIGHT#5"],
    primaryScript: options.primaryScript,
    reReviewScript: options.reReviewScript,
    ...(options.publicationSleep ? { publicationSleep: options.publicationSleep } : {}),
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
  '- F1: retained. Primary text: "The loop in handler() rebuilds result by concatenation".',
  '- F2: retained. Primary text: "The inlined trimming of each part happens twice".',
].join("\n");

const RECHECKED = "(Rechecked on rerun.)";
/** Run 2's final review: F1 rechecked at the same anchor; F2 unchanged. */
function rerunFinalReview(): string {
  return FINAL_REVIEW.replace(
    "handler() rebuilds the result string inside a loop.",
    `handler() rebuilds the result string inside a loop. ${RECHECKED}`,
  );
}

function primaryScript(): StubScript {
  return [
    { toolCall: { id: "call-1", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
    { text: [PRIMARY_ARTIFACT], finishReason: "stop" as const, usage: { promptTokens: 100, completionTokens: 60 } },
  ];
}

function reReviewScript(): StubScript {
  return [
    { toolCall: { id: "call-2", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
    { text: [FINAL_REVIEW], finishReason: "stop" as const, usage: { promptTokens: 200, completionTokens: 90 } },
  ];
}

async function requestReview(jar: ScenarioJar, stage: Stage): Promise<string> {
  const started = await stage.handleReviewCommand({
    repository: "example/scenario",
    pullNumber: jar.fakeGithub.state.pulls && Object.keys(jar.fakeGithub.state.pulls).length ? Number(Object.keys(jar.fakeGithub.state.pulls)[0]) : 7,
    requester: "octocat",
  });
  return started.runId;
}

/** The bot's markers as GitHub holds them: marker comments inside bodies. */
async function ledgerOps(jar: ScenarioJar, host: Stage): Promise<unknown[]> {
  const ledger = new PublicationLedger(host.runHistory().harness);
  const doc = await host.runHistory().harness.snapshot(PublicationLedgerDoc, TODO_CONTEXT);
  void ledger;
  return doc?.ops ?? [];
}

describe("scenario: publication idempotency and retry (ticket 05)", () => {
  it("a dropped create response is reconciled in-process: adopted, published once", async () => {
    const jar = await openJar({
      pullNumber: 7,
      primaryScript: primaryScript(),
      reReviewScript: reReviewScript(),
      publicationSleep: async () => undefined,
    });
    const stage = await jar.openHost();
    try {
      // GitHub accepts the review create, then the response is destroyed.
      jar.fakeGithub.state.dropNextWrite = { match: /reviews$/, remaining: 1 };
      const runId = await requestReview(jar, stage);
      await stage.waitForRun(runId);

      // The write landed exactly once and was adopted: publication succeeded.
      const reviews = jar.fakeGithub.publishedReviews(7);
      expect(reviews).toHaveLength(1);
      const run = await latestRunDoc(stage);
      expect(run.publicationOutcome).toBe("published");
      expect(run.publication?.reviewId).toBe(reviews[0]!.id);
      expect(run.checkStatus).toBe("success");
      // The bodies carry the publisher-owned markers the reconciliation found.
      expect(reviews[0]!.body).toContain("nitpi:summary:");
      expect(reviews[0]!.comments[0]!.body).toContain("nitpi:finding:");
    } finally {
      await stage.close();
    }
  });

  it("an unresolvable outcome stays unknown (no success, no blind re-create), and the retry reconciles with zero model calls", async () => {
    const jar = await openJar({
      pullNumber: 7,
      primaryScript: primaryScript(),
      reReviewScript: reReviewScript(),
      publicationSleep: async () => undefined,
    });
    const stageA = await jar.openHost();
    let runId: string;
    try {
      // The create lands, its response is destroyed, and the reconciliation
      // read fails too: the outcome cannot be established either way. The
      // first listing (the summary lookup) passes; the reconcile read fails.
      jar.fakeGithub.state.dropNextWrite = { match: /reviews$/, remaining: 1 };
      jar.fakeGithub.state.refuseNextWrite = { match: /reviews$/, remaining: 1, status: 500, methods: ["GET"], skip: 1 };
      runId = await requestReview(jar, stageA);
      await expect(stageA.waitForRun(runId)).rejects.toThrow(/unknown/);

      const runA = await latestRunDoc(stageA);
      expect(runA.publicationOutcome).toBe("unknown");
      expect(runA.checkStatus).toBe("failure");
      expect(runA.checkDetail).toContain("unknown");
      expect(runA.error).toBeTruthy();
      // The check is NOT success: unknown outcomes complete as neutral.
      expect(jar.fakeGithub.state.checks.at(-1)!.state).toBe("neutral");
      expect(jar.fakeGithub.state.checks.at(-1)!.summary).toContain("unknown");
      // The write landed once; nothing was created again.
      expect(jar.fakeGithub.publishedReviews(7)).toHaveLength(1);
      // The model stages completed before publication; nothing re-ran.
      const servedBefore = { primary: jar.primaryStub.served, reReview: jar.reReviewStub.served };
      expect(servedBefore).toEqual({ primary: 2, reReview: 2 });
      void servedBefore;
    } finally {
      await stageA.close();
    }

    // The retry (Actions re-run on the same storage): publication only.
    const stageB = await jar.openHost();
    try {
      const started = await stageB.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 7,
        requester: "octocat",
      });
      await stageB.waitForRun(started.runId);

      const runB = await latestRunDoc(stageB);
      expect(runB.runId).toBe(runId);
      expect(runB.publicationOutcome).toBe("published");
      expect(runB.checkStatus).toBe("success");
      // Still exactly one review: the dropped write was adopted, not repeated.
      expect(jar.fakeGithub.publishedReviews(7)).toHaveLength(1);
      expect(runB.publication?.commentIds).toHaveLength(2);
      // Zero new model calls: the completed final review was reused.
      expect(jar.primaryStub.served).toBe(2);
      expect(jar.reReviewStub.served).toBe(2);
      expect(jar.primaryStub.requests).toHaveLength(2);
      expect(jar.reReviewStub.requests).toHaveLength(2);
    } finally {
      await stageB.close();
    }
  });

  it("a bot comment deleted by hand is reconciled against GitHub before it is recreated", async () => {
    const jar = await openJar({
      pullNumber: 7,
      primaryScript: primaryScript(),
      reReviewScript: reReviewScript(),
      publicationSleep: async () => undefined,
    });
    const stage = await jar.openHost();
    try {
      const runId = await requestReview(jar, stage);
      await stage.waitForRun(runId);
      const run1 = await latestRunDoc(stage);
      const [c1, c2] = run1.publication!.commentIds as [number, number];

      // Someone deletes the F2 comment by hand.
      jar.fakeGithub.state.comments = jar.fakeGithub.state.comments.filter((c) => c.id !== c2);

      // Rerun: the frozen findings match by meaning; F1 keeps its thread, F2
      // is recreated only after the listing proves its absence. The rerun is
      // a deliberate new run: its primary re-emits the artifact and the
      // re-reviewer re-freezes before the match turn.
      jar.primaryStub.append({ text: [PRIMARY_ARTIFACT], finishReason: "stop" as const });
      jar.reReviewStub.append({ text: [rerunFinalReview()], finishReason: "stop" as const });
      jar.reReviewStub.append({ text: [`F1 -> ${c1}\nF2 -> none\n`], finishReason: "stop" as const });
      const started = await stage.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 7,
        requester: "octocat",
      });
      await stage.waitForRun(started.runId);

      const comments = jar.fakeGithub.prComments(7);
      // F1's thread still exists (updated, not duplicated)…
      expect(comments.find((c) => c.id === c1)!.body).toContain(RECHECKED);
      // …and F2 has exactly one comment: the recreation.
      const f2 = comments.filter((c) => c.id !== c1);
      expect(f2).toHaveLength(1);
      expect(f2[0]!.id).not.toBe(c2);
      expect(f2[0]!.body).toContain("double trimming");
      expect(f2[0]!.body).toContain("nitpi:finding:");
      const run2 = await latestRunDoc(stage);
      expect(run2.publicationOutcome).toBe("published");
    } finally {
      await stage.close();
    }
  });

  it("429 with Retry-After waits exactly that long, then the write retries once", async () => {
    const waits: number[] = [];
    const jar = await openJar({
      pullNumber: 7,
      primaryScript: primaryScript(),
      reReviewScript: reReviewScript(),
      publicationSleep: async (ms) => {
        waits.push(ms);
      },
    });
    const stage = await jar.openHost();
    try {
      // First create attempt is rate-limited with the documented wait.
      jar.fakeGithub.state.refuseNextWrite = { match: /reviews$/, remaining: 1, status: 429, retryAfter: 1 };
      const runId = await requestReview(jar, stage);
      await stage.waitForRun(runId);

      // The publisher followed Retry-After (1 second), then retried once.
      expect(waits).toEqual([1000]);
      expect(jar.fakeGithub.publishedReviews(7)).toHaveLength(1);
      const run = await latestRunDoc(stage);
      expect(run.publicationOutcome).toBe("published");
    } finally {
      await stage.close();
    }
  });

  it("429 without Retry-After waits at least one minute and backs off exponentially, then fails with a reason", async () => {
    const waits: number[] = [];
    const jar = await openJar({
      pullNumber: 7,
      primaryScript: primaryScript(),
      reReviewScript: reReviewScript(),
      publicationSleep: async (ms) => {
        waits.push(ms);
      },
    });
    const stage = await jar.openHost();
    try {
      // Every create attempt is rate-limited without a Retry-After header.
      jar.fakeGithub.state.refuseNextWrite = { match: /reviews$/, remaining: 99, status: 429 };
      const runId = await requestReview(jar, stage);
      await expect(stage.waitForRun(runId)).rejects.toThrow();

      // Bounded pacing: 60s, 120s, 240s, 480s — then the write fails.
      expect(waits).toEqual([60_000, 120_000, 240_000, 480_000]);
      // Nothing was published, and the failure carries the reason once.
      expect(jar.fakeGithub.publishedReviews(7)).toHaveLength(0);
      const run = await latestRunDoc(stage);
      expect(run.publicationOutcome).toBe("failed");
      expect(run.error).toContain("429");
      expect(jar.fakeGithub.state.checks.at(-1)!.state).toBe("failure");

      // The completed final review is kept; a retry republishes it with no
      // new model calls — here it gets through.
      jar.fakeGithub.state.refuseNextWrite = { match: /^$/, remaining: 0, status: 429 };
      jar.reReviewStub.append({ text: ["F1 -> none\nF2 -> none\n"], finishReason: "stop" as const });
      const started = await stage.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 7,
        requester: "octocat",
      });
      await stage.waitForRun(started.runId);
      const retry = await latestRunDoc(stage);
      expect(retry.runId).toBe(runId);
      expect(retry.publicationOutcome).toBe("published");
      expect(jar.primaryStub.served).toBe(2);
      // No matching turn on the retry: the first run had no earlier comments
      // to match against, so publication-only means publication only.
      expect(jar.reReviewStub.served).toBe(2);
    } finally {
      await stage.close();
    }
  });

  it("a permission error fails once with a reason and is never retried", async () => {
    const jar = await openJar({
      pullNumber: 7,
      primaryScript: primaryScript(),
      reReviewScript: reReviewScript(),
      publicationSleep: async () => undefined,
    });
    const stage = await jar.openHost();
    try {
      jar.fakeGithub.state.refuseNextWrite = {
        match: /reviews$/,
        remaining: 99,
        status: 403,
        message: "Resource not accessible by integration",
      };
      const runId = await requestReview(jar, stage);
      await expect(stage.waitForRun(runId)).rejects.toThrow(/Resource not accessible/);

      // Exactly one attempt: no pacing, no retry.
      const reviewAttempts = jar.fakeGithub.requestLog.filter(
        (entry) => entry.method === "POST" && /\/reviews$/.test(entry.path),
      );
      expect(reviewAttempts).toHaveLength(1);
      const run = await latestRunDoc(stage);
      expect(run.publicationOutcome).toBe("failed");
      expect(run.error).toContain("Resource not accessible");
    } finally {
      await stage.close();
    }
  });

  it("reconciliation lists and paginates: an object on a later page is adopted", async () => {
    const jar = await openJar({
      pullNumber: 7,
      primaryScript: primaryScript(),
      reReviewScript: reReviewScript(),
      publicationSleep: async () => undefined,
    });
    const stage = await jar.openHost();
    try {
      // GitHub accepts the create, drops the response, and the listing is
      // forced onto one item per page: the adopter must paginate.
      // A human review seeds the listing's first page; the forced page size
      // pushes the recovered bot review onto page 2.
      jar.fakeGithub.addSeededReview(7, { body: "A human review from before.", author: "octocat" });
      jar.fakeGithub.state.enforceListPageSize = 1;
      jar.fakeGithub.state.dropNextWrite = { match: /reviews$/, remaining: 1 };
      const runId = await requestReview(jar, stage);
      await stage.waitForRun(runId);

      // The seeded human review is one of the submitted reviews; the bot's
      // recovered review is exactly one — nothing was created twice.
      expect(jar.fakeGithub.publishedReviews(7)).toHaveLength(2);
      expect(jar.fakeGithub.publishedReviews(7).filter((r) => r.author === jar.fakeGithub.botLogin)).toHaveLength(1);
      const run = await latestRunDoc(stage);
      expect(run.publicationOutcome).toBe("published");
      const reviewListings = jar.fakeGithub.requestLog.filter(
        (entry) => entry.method === "GET" && entry.path.endsWith("/reviews"),
      );
      expect(reviewListings.length).toBeGreaterThanOrEqual(3);
    } finally {
      await stage.close();
    }
  });
});

async function latestRunDoc(stage: Stage) {
  const runs = await stage.runHistory().allRuns(TODO_CONTEXT);
  return runs.at(-1)!;
}
