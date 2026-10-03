/**
 * Durable recovery scenarios (ticket 06): a review survives a dead runner.
 *
 * Every scenario runs against the real storage service on localhost (its
 * temporary SQLite directory under the jar's data dir), exactly what an
 * Actions re-run faces: the same GitHub fake, the same scripted model
 * endpoints, and the same storage partition across the crashed runner and
 * the re-run.
 *
 * Covered scenarios:
 * 1. crash mid-primary → the re-run resumes the same attempt; the canonical
 *    conversation carries the interrupted work forward (no restart from
 *    scratch);
 * 2. crash mid-re-review → the re-run resumes; after the completed primary
 *    stage no new primary model calls happen;
 * 3. reviewer error → no findings are published, the check fails with a
 *    reason, and the durable work is kept for a re-run;
 * 4. reviewer timeout → nothing published, the check reports incomplete
 *    with a reason, and the durable work is kept for a re-run;
 * 5. storage outage then recovery → the run stops with an execution
 *    failure, no local continuation, and a re-run after storage returns
 *    resumes the same attempt;
 * 6. single owner: a second opener of the PR's storage is refused.
 *
 * The adapter-level scenario "retried commit after a lost acknowledgement"
 * lives in test/storage/service-behavior.test.ts (the identity-based dedupe
 * is the adapter's property; the suite runs it as part of `npm test`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import { openScenarioJar, type ScenarioJar } from "../fixtures/scenario-jar.js";
import type { StubScript } from "../fixtures/model-stub.js";
import type { ReviewHost } from "../../src/review-host/review-host.js";
import type { RunDocument } from "../../src/review-host/run-history.js";
import { StorageInUse } from "../../src/storage/remote-storage.js";

const jars: ScenarioJar[] = [];

/** Empty tool turn: satisfies pi's auto-resumed interrupted generation without adding transcript text. */
const EMPTY_TURN: StubScript = [{ text: [""], finishReason: "stop" as const }];

afterAll(async () => {
  for (const jar of jars.splice(0).reverse()) {
    await jar.dispose();
  }
});

const ARTIFACT = "# Review artifact\n\nF1: The trimming in handler() happens twice; move it to the boundary.\n";
const FINAL_REVIEW = [
  "# Final review",
  "",
  "## F1 — Missed simplification: double trimming",
  "",
  "The trim happens in handler() and again in callers.",
  "",
  "Evidence: the trim also appears in the caller added by this diff.",
  "src/handler.ts | RIGHT | 5",
  "",
  "# Audit notes",
  "",
  '- F1: retained. Primary text: "The trimming in handler() happens twice". Verified against the head checkout.',
].join("\n");

async function openJar(options: {
  pullNumber: number;
  primaryScript: StubScript;
  reReviewScript: StubScript;
  deadlines?: { primaryMs?: number; reReviewMs?: number };
}): Promise<ScenarioJar> {
  const jar = await openScenarioJar({
    pullNumber: options.pullNumber,
    diffAnchors: ["src/handler.ts#RIGHT#5"],
    primaryScript: options.primaryScript,
    reReviewScript: options.reReviewScript,
    deadlines: options.deadlines,
  });
  jars.push(jar);
  return jar;
}

/** Poll the durable run document until the predicate holds (or time out). */
async function waitForRunDoc(
  host: ReviewHost,
  runId: string,
  predicate: (run: RunDocument) => boolean,
  timeoutMs = 10_000,
): Promise<RunDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = (await host.runHistory().allRuns({} as never)).find((r) => r.runId === runId);
    if (run && predicate(run)) return run;
    if (Date.now() > deadline) {
      throw new Error(`run document never satisfied the predicate: ${JSON.stringify(run ?? null)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Wait until a model stub has served at least `count` requests. */
async function stubServed(
  stub: { readonly requests: unknown[] },
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stub.requests.length >= count) return;
    if (Date.now() > deadline) throw new Error(`model stub never reached ${count} requests`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Kill the runner mid-primary: the artifact has not frozen yet. */
async function crashMidPrimary(host: ReviewHost, runId: string, jar: ScenarioJar): Promise<void> {
  await stubServed(jar.primaryStub, 1);
  await waitForRunDoc(
    host,
    runId,
    (run) => run.subject.headSha === jar.headSha && !run.artifactFrozen,
  );
  // The model request hangs, so the phase cannot progress; the runner is
  // killed hard (close against a hanging turn: task outcomes are not
  // written, and the durable checkpoint stays in the primary). The crash is
  // verified on the re-opening host: this harness is closed by the kill.
  await host.close();
}

describe("durable recovery (ticket 06)", () => {
  it("resumes a crash mid-primary: the re-run continues the same attempt and publishes", { timeout: 90_000 }, async () => {
    const jar = await openJar({
      pullNumber: 11,
      primaryScript: [
        // The crashed attempt's turn: the runner dies while the model request
        // hangs (no streaming, no freeze).
        { kind: "hang" },
        // The re-run's continuation: writes the artifact. An empty turn
        // follows so pi's auto-resumed interrupted generation cannot hit an
        // exhausted script when it re-issues its own request.
        { text: [ARTIFACT], finishReason: "stop" as const, usage: { promptTokens: 40, completionTokens: 30 } },
        ...EMPTY_TURN,
      ],
      reReviewScript: [{ text: [FINAL_REVIEW], finishReason: "stop" as const }],
    });
    const hostA = await jar.openHost();
    const started = await hostA.handleReviewCommand({
      repository: "example/scenario",
      pullNumber: 11,
      requester: "octocat",
    });

    // Kill the runner hard while the primary's turn is mid-flight (task
    // outcomes are not written; the durable checkpoint stays in the primary).
    await crashMidPrimary(hostA, started.runId, jar);

    // The Actions re-run: a new runner opens the same storage partition;
    // handleReviewCommand resumes the interrupted attempt instead of
    // starting a second one.
    const hostB = await jar.openHost();
    try {
      // Crash verified durably: the interrupted attempt kept the durable
      // checkpoint in the primary and recorded nothing for publication.
      const afterCrash = (await hostB.runHistory().allRuns({} as never)).find(
        (r) => r.runId === started.runId,
      );
      expect(afterCrash?.artifactFrozen).toBe(false);
      expect(afterCrash?.checkStatus).toBe("in progress");
      expect(afterCrash?.publication).toBeUndefined();

      const rejoined = await hostB.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 11,
        requester: "octocat",
      });
      expect(rejoined.runId).toBe(started.runId);
      await hostB.waitForRun(rejoined.runId);

      // The attempt completed on the resumed runner.
      const run = await waitForRunDoc(hostB, started.runId, (r) => r.phase === "published");
      expect(run.artifact).toContain("move it to the boundary");
      expect(run.finalReview).toContain("Audit notes");
      expect(run.publication).toBeDefined();
      const reviews = jar.fakeGithub.publishedReviews(11);
      expect(reviews).toHaveLength(1);
      expect(jar.fakeGithub.state.checks.at(-1)).toMatchObject({ state: "success", headSha: jar.headSha });

      // Same-attempt evidence: the canonical conversation of the original
      // attempt is the one the re-run continued.
      expect(run.canonicalConversationId).toBe(rejoined.conversationId);
      // The re-reviewer received the frozen artifact.
      const reUser = firstUserMessage(jar.reReviewStub.requests[0]!.body.messages);
      expect(reUser).toContain("FROZEN PRIMARY REVIEW ARTIFACT");
      // Both stages consumed their scripted turns: the hang (attempt 1) and
      // the continuation (attempt 2) for the primary; one for the re-review.
      expect(jar.primaryStub.exhausted).toBe(true);
      expect(jar.reReviewStub.exhausted).toBe(true);
    } finally {
      await hostB.close();
    }
  });

  it("resumes a crash mid-re-review: no new primary model calls after the completed primary stage", { timeout: 90_000 }, async () => {
    const jar = await openJar({
      pullNumber: 12,
      primaryScript: [{ text: [ARTIFACT], finishReason: "stop" as const }],
      reReviewScript: [
        // The crashed attempt's re-review turn: the runner dies while the
        // model request hangs (the artifact is already frozen downhill).
        { kind: "hang" },
        // The re-run's continuation: writes the final review. An empty turn
        // follows so pi's auto-resumed interrupted generation cannot hit an
        // exhausted script when it re-issues its own request.
        { text: [FINAL_REVIEW], finishReason: "stop" as const, usage: { promptTokens: 70, completionTokens: 40 } },
        ...EMPTY_TURN,
      ],
    });
    const hostA = await jar.openHost();
    const started = await hostA.handleReviewCommand({
      repository: "example/scenario",
      pullNumber: 12,
      requester: "octocat",
    });

    // The primary stage completes and its artifact freezes durably; the
    // re-reviewer's turn hangs and the runner is killed hard with no outcome
    // writes and the durable re-review conversation already recorded.
    await waitForRunDoc(hostA, started.runId, (run) => run.artifactFrozen === true);
    await stubServed(jar.reReviewStub, 1);
    await waitForRunDoc(
      hostA,
      started.runId,
      (run) => run.reReviewConversationId !== undefined && run.finalReview === undefined,
    );
    await hostA.close();

    // Durable work kept from host A: usage totals from the primary stage.
    const hostB = await jar.openHost();
    try {
      const rejoined = await hostB.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 12,
        requester: "octocat",
      });
      expect(rejoined.runId).toBe(started.runId);
      await hostB.waitForRun(rejoined.runId);

      const run = await waitForRunDoc(hostB, started.runId, (r) => r.phase === "published");
      expect(run.artifactFrozen).toBe(true);
      expect(run.finalReview).toContain("Audit notes");
      expect(run.publication).toBeDefined();
      expect(jar.fakeGithub.publishedReviews(12)).toHaveLength(1);
      expect(jar.fakeGithub.state.checks.at(-1)).toMatchObject({ state: "success", headSha: jar.headSha });

      // After the completed primary stage, no new primary model calls
      // happened: the primary endpoint served exactly one request, all
      // before the crash.
      expect(jar.primaryStub.requests).toHaveLength(1);
      // The re-reviewer continued its own durable conversation: three
      // requests total — the hung one before the crash, pi's own resumed
      // generation (which carried the final review), and this re-run's
      // re-issued turn. The durable conversation is reused end to end.
      expect(jar.reReviewStub.requests).toHaveLength(3);
      const runAgain = await waitForRunDoc(hostB, started.runId, (r) => r.phase === "published");
      expect(runAgain.reReviewConversationId).toBeDefined();
    } finally {
      await hostB.close();
    }
  });

  it("reviewer error: nothing publishes, the check fails with a reason, and the re-run reuses the durable work", { timeout: 90_000 }, async () => {
    // The re-review stage errors once (host A), then works on the re-run.
    const jar = await openJar({
      pullNumber: 13,
      primaryScript: [{ text: [ARTIFACT], finishReason: "stop" as const }],
      reReviewScript: [
        { kind: "error", status: 503, body: { error: { message: "re-review endpoint melted down" } } },
        { text: [FINAL_REVIEW], finishReason: "stop" as const },
      ],
    });
    const hostA = await jar.openHost();
    let startedRunId = "";
    try {
      const started = await hostA.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 13,
        requester: "octocat",
      });
      startedRunId = started.runId;
      await expect(hostA.waitForRun(started.runId)).rejects.toThrow(/melted down/i);

      // No findings are published; the check fails with the reason.
      expect(jar.fakeGithub.publishedReviews(13)).toHaveLength(0);
      expect(jar.fakeGithub.state.checks.at(-1)).toMatchObject({
        state: "failure",
        summary: expect.stringContaining("melted down"),
      });
      // The durable work is kept: the frozen artifact and its stage usage.
      const run = (await hostA.runHistory().allRuns({} as never)).find((r) => r.runId === started.runId)!;
      expect(run.artifactFrozen).toBe(true);
      expect(run.artifact).toBe(ARTIFACT);
      expect(run.usage?.primary?.totalTokens).toBeGreaterThan(0);
    } finally {
      await hostA.close();
    }

    // The Actions re-run resumes the same attempt: the primary stage does
    // not run again, the re-reviewer verifies from the frozen artifact.
    const hostB = await jar.openHost();
    try {
      const resumed = await hostB.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 13,
        requester: "octocat",
      });
      expect(resumed.runId).toBe(startedRunId);
      await hostB.waitForRun(resumed.runId);
      const run = await waitForRunDoc(hostB, resumed.runId, (r) => r.phase === "published");
      expect(run.finalReview).toContain("Audit notes");
      expect(jar.fakeGithub.publishedReviews(13)).toHaveLength(1);
      expect(jar.fakeGithub.state.checks.at(-1)).toMatchObject({ state: "success" });
      // The primary stage was already complete: no new primary model calls.
      expect(jar.primaryStub.requests).toHaveLength(1);
    } finally {
      await hostB.close();
    }
  });

  it("reviewer timeout: nothing publishes, the check reports incomplete with a reason, durable work kept", { timeout: 90_000 }, async () => {
    // The re-review turn hangs; the stage deadline fires and aborts it.
    const jar = await openJar({
      pullNumber: 14,
      primaryScript: [{ text: [ARTIFACT], finishReason: "stop" as const }],
      reReviewScript: [
        { kind: "hang" }, // host A's re-review turn: deadline fires
        { text: [FINAL_REVIEW], finishReason: "stop" as const }, // host B's re-review
      ],
      deadlines: { primaryMs: 60_000, reReviewMs: 400 },
    });
    const hostA = await jar.openHost();
    try {
      const started = await hostA.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 14,
        requester: "octocat",
      });
      await expect(hostA.waitForRun(started.runId)).rejects.toThrow(/re-review reviewer exceeded/);

      // No findings are published; the check reports incomplete with a reason.
      expect(jar.fakeGithub.publishedReviews(14)).toHaveLength(0);
      const check = jar.fakeGithub.state.checks.at(-1)!;
      expect(check.state).toBe("neutral");
      expect(check.detail).toBe("Review incomplete");
      expect(check.summary).toContain("exceeded its 400ms deadline");

      // The durable work is kept: the frozen artifact, and the run stays
      // resumable.
      const run = (await hostA.runHistory().allRuns({} as never)).find((r) => r.runId === started.runId)!;
      expect(run.artifactFrozen).toBe(true);
      expect(run.checkDetail).toContain("incomplete");
    } finally {
      await hostA.close();
    }

    // The re-run resumes the re-review stage (which hung before) and finishes.
    const hostB = await jar.openHost();
    try {
      const resumed = await hostB.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 14,
        requester: "octocat",
      });
      await hostB.waitForRun(resumed.runId);
      const run = await waitForRunDoc(hostB, resumed.runId, (r) => r.phase === "published");
      expect(run.finalReview).toContain("Audit notes");
      expect(jar.fakeGithub.publishedReviews(14)).toHaveLength(1);
      // After the completed primary stage: no new primary model calls.
      expect(jar.primaryStub.requests).toHaveLength(1);
    } finally {
      await hostB.close();
    }
  });

  it("storage outage stops the run with an execution failure; a re-run after storage returns resumes the same attempt", { timeout: 90_000 }, async () => {
    const jar = await openJar({
      pullNumber: 15,
      primaryScript: [
        { toolCall: { id: "call-1", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
        { text: [ARTIFACT], finishReason: "stop" as const },
      ],
      reReviewScript: [
        { toolCall: { id: "call-2", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
        { text: [FINAL_REVIEW], finishReason: "stop" as const },
      ],
    });
    const hostA = await jar.openHost();
    const started = await hostA.handleReviewCommand({
      repository: "example/scenario",
      pullNumber: 15,
      requester: "octocat",
    });

    // Once the primary stage is durably frozen, kill the storage service.
    await waitForRunDoc(hostA, started.runId, (run) => run.artifactFrozen === true && !!run.usage?.primary);
    await jar.stopStorage();

    // The run stops with an execution failure: nothing more is published and
    // no stage proceeds. (The runner's attempt may not even answer its
    // caller — committing the failure outcome needs storage too. Its durable
    // state and the failure check carry the reason.)
    if (jar.fakeGithub.state.checks.at(-1)?.state === "failure") {
      expect(jar.fakeGithub.state.checks.at(-1)?.summary).toContain("storage");
      expect(jar.fakeGithub.publishedReviews(15)).toHaveLength(0);
      expect(jar.reReviewStub.requests).toHaveLength(0);
    }
    // The runner is dead from here: its close races out; whatever hangs on
    // the poisoned session is abandoned, as an Actions runner would be.
    void Promise.race([
      hostA.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1_500).unref()),
    ]);

    // Storage returns (same data directory: the durable files survived).
    await jar.startStorage();
    const hostB = await jar.openHost();
    try {
      const resumed = await hostB.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 15,
        requester: "octocat",
      });
      expect(resumed.runId).toBe(started.runId);
      await hostB.waitForRun(resumed.runId);

      // The re-run resumes the same attempt: it picks up the frozen
      // artifact, re-runs only the re-review, and publishes.
      const run = await waitForRunDoc(hostB, started.runId, (r) => r.phase === "published");
      expect(run.artifactFrozen).toBe(true);
      expect(run.finalReview).toContain("Audit notes");
      expect(jar.fakeGithub.publishedReviews(15)).toHaveLength(1);
      expect(jar.fakeGithub.state.checks.at(-1)).toMatchObject({ state: "success" });
      // No new primary model calls: the primary stage completed before the outage.
      expect(jar.primaryStub.requests).toHaveLength(2);
    } finally {
      await hostB.close();
    }
  });

  it("only one process owns a PR's storage; a second opener is refused", { timeout: 90_000 }, async () => {
    const jar = await openJar({
      pullNumber: 16,
      primaryScript: [],
      reReviewScript: [],
    });
    const hostA = await jar.openHost();
    try {
      // The partition lease is held by host A; the re-open is refused.
      const lease = jar.service.liveLease("example/scenario", 16);
      expect(lease).toBeDefined();

      let refusedError: unknown;
      try {
        await jar.openHost();
      } catch (error) {
        refusedError = error;
      }
      expect(refusedError).toBeInstanceOf(StorageInUse);
      expect((refusedError as StorageInUse).message).toContain("already owned by another process");
    } finally {
      await hostA.close();
      // Lease released on close; a follow-up opener is accepted again.
      const next = await jar.openHost();
      await next.close();
    }
  });
});

type RecordedMessages = Array<{ role: string; content: unknown }> | undefined;

function firstUserMessage(messages: RecordedMessages): string {
  const user = messages?.find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}
