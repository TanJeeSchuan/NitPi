/**
 * Scenario tests (ticket 09 — cancellation; spec: Testing Decisions — the
 * review host's process boundary).
 *
 * Cancelling a review actually stops it. Each test sends one real trigger
 * (`/review cancel`, a close, a merge's closed state, a draft conversion)
 * against one host and asserts only externally visible results: what GitHub
 * shows (reviews, comments, checks) and what is in the durable run state.
 * Everything inside the host runs for real — the abort goes through Pi
 * Durable's abort API, and the fence is the run document on the storage
 * service.
 *
 * Timing: the stage under test holds its response open (`delayMs`), so the
 * cancel deterministically lands inside the active run. The
 * cancel-during-publication test instead holds the fake GitHub's review
 * write, so the cancel lands while the publication write is in flight.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { ReviewHost } from "../../src/review-host/review-host.js";
import type { RunDocument } from "../../src/review-host/run-history.js";
import { openScenarioJar, type ScenarioJar } from "../fixtures/scenario-jar.js";
import type { StubScript, StubTurn } from "../fixtures/model-stub.js";
import { openHostOnStorage } from "../helpers/host-on-storage.js";
import { FakeGitHub, type FakePullRequest } from "../fixtures/fake-github.js";
import { createGitRepoFixture, unifiedDiff, type GitRepoFixture } from "../fixtures/git-fixture.js";
import { automaticPreset } from "../../src/review-host/trigger-gate.js";

let workspace: string;
let repo: GitRepoFixture;

const ARTIFACT = "Artifact: the primary found one complexity issue in the handler loop.";

const REREVIEW_FINAL = [
  "## F1 — Unnecessary complexity: concatenation loop",
  "",
  "handler() rebuilds the result string inside a loop. `parts.map(p => p.trim().toUpperCase()).join(\" \")` is simpler and preserves behavior.",
  "",
  "Evidence: src/handler.ts lines 3-6 in the reviewed head replace the original one-line return expression.",
  "src/handler.ts | RIGHT | 3",
  "",
  "# Audit notes",
  "",
  '- F1: retained. Primary text: "the primary found one complexity issue". Verified against the head checkout.',
].join("\n");

/** The tool round every reviewer turn starts with; a turn's response itself
 * is what a test holds open via `delayMs`. */
const READ_TURN: StubTurn = {
  toolCall: { id: "call-09-read", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) },
};

const ONE_REVIEW_PRIMARY: StubScript = [
  READ_TURN,
  { text: [ARTIFACT], finishReason: "stop" as const, usage: { promptTokens: 100, completionTokens: 20 } },
];
const ONE_REVIEW_REREVIEW: StubScript = [
  READ_TURN,
  { text: [REREVIEW_FINAL], finishReason: "stop" as const, usage: { promptTokens: 200, completionTokens: 40 } },
];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "nitpi-cancel-"));
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

function pushCommit(summary: string): string {
  const checkout = repo.headCheckout();
  const file = join(checkout, "src", `pushed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.ts`);
  execFileSync("node", ["-e", `require("node:fs").writeFileSync(process.argv[1], "// pushed\\n")`, file]);
  execFileSync("git", ["-C", checkout, "add", "."]);
  execFileSync("git", ["-C", checkout, "commit", "-m", summary]);
  return execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition never held within the timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Stage {
  fake: FakeGitHub;
  primaryStub: { served: number; requests: unknown[] };
  reReviewStub: { served: number; requests: unknown[] };
  host: ReviewHost;
  pull: FakePullRequest;
}

interface StageOptions {
  primaryScript: StubScript;
  reReviewScript: StubScript;
  pull?: Partial<FakePullRequest>;
  autoMode?: boolean;
}

/** One fake GitHub + two model stubs + one review host, all test-scoped.
 * The storage directory is fixed per stage so a test can reopen the same
 * partition (crash scenarios) via `reopen()`. */
async function withStage(options: StageOptions, test: (stage: Stage) => Promise<void>): Promise<void> {
  const dataDir = join(workspace, `stage-${Math.random().toString(36).slice(2)}`);
  const pull: FakePullRequest = {
    number: 7,
    headSha: repo.headSha,
    baseSha: repo.baseSha,
    state: "open",
    ...options.pull,
  };
  const fake = new FakeGitHub([pull], ["src/handler.ts#RIGHT#3", "src/handler.ts#RIGHT#5"], {
    diffText: unifiedDiff(),
  });
  const { ModelStub } = await import("../fixtures/model-stub.js");
  const primaryStub = new ModelStub(options.primaryScript, "stub-cancel-primary");
  const reReviewStub = new ModelStub(options.reReviewScript, "stub-cancel-rereview");
  const [primaryBase, reReviewBase, githubBase] = await Promise.all([
    primaryStub.listen(),
    reReviewStub.listen(),
    fake.listen(),
  ]);
  let host: ReviewHost;
  try {
    host = await openHostOnStorage(
      {
        repository: "example/widgets",
        pullNumber: 7,
        githubToken: "test-token",
        githubBaseUrl: githubBase,
        ...(options.autoMode ? { autoMode: automaticPreset() } : {}),
        primary: { baseUrl: `${primaryBase}/v1`, modelId: "stub-cancel-primary", apiKey: "k" },
        reReview: { baseUrl: `${reReviewBase}/v1`, modelId: "stub-cancel-rereview", apiKey: "k" },
        repositoryInstructions: "Be strict about unused parameters.",
        repositoryInstructionsRevision: repo.baseSha,
        headCheckoutSource: repo.headCheckout(),
      },
      dataDir,
    );
  } catch (error) {
    await Promise.all([primaryStub.close(), reReviewStub.close(), fake.close()]);
    throw error;
  }

  const stage: Stage = {
    fake,
    primaryStub,
    reReviewStub,
    host,
    pull,
  };
  try {
    await test(stage);
  } finally {
    await host.close().catch(() => undefined);
    await Promise.all([primaryStub.close(), reReviewStub.close(), fake.close()]).catch(() => undefined);
  }
}

async function runsOf(host: ReviewHost): Promise<RunDocument[]> {
  return host.runHistory().allRuns({} as never);
}

/** Wait until the run document leaves "in progress" and return it. Durable
 * state, not the host's in-memory waiter. */
async function awaitRunTerminal(host: ReviewHost, runId: string): Promise<RunDocument> {
  return waitFor(async () => {
    const run = (await runsOf(host)).find((r) => r.runId === runId);
    return run && run.checkStatus !== "in progress" ? run : undefined;
  });
}

/** The writer's cancel command against the stage's pull request. */
async function cancelCommand(stage: Stage): Promise<{ runId: string; refused?: string; outcome?: string }> {
  const result = await stage.host.handleReviewCommand({
    repository: "example/widgets",
    pullNumber: 7,
    requester: "octocat",
    command: "/review cancel",
    deliveryKey: `cancel-${Math.random().toString(36).slice(2)}`,
  });
  return { ...result, outcome: result.outcome };
}

/** The stage's checks for one head, in order. */
function checksForHead(stage: Stage, headSha: string) {
  return stage.fake.state.checks.filter((c) => c.headSha === headSha);
}

describe("scenario: cancelling a review actually stops it (ticket 09)", () => {
  it("/review cancel during primary review aborts the run; nothing publishes; a follow-up /review starts a new run", async () => {
    // Run 1's first primary turn holds; run 2 (after the cancel) reviews fully.
    await withStage(
      {
        primaryScript: [
          { ...READ_TURN, delayMs: 800 },
          ...ONE_REVIEW_PRIMARY.slice(1),
          ...ONE_REVIEW_PRIMARY,
        ],
        reReviewScript: ONE_REVIEW_REREVIEW,
      },
      async (stage) => {
        const started = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "t09-primary-command",
        });
        expect(started.runId).toBeTruthy();

        // Cancel while the primary reviewer's first turn is still open.
        await waitFor(() => (stage.primaryStub.served >= 1 ? true : undefined));
        const cancelled = await cancelCommand(stage);
        expect(cancelled.outcome).toBe("cancel");
        expect(cancelled.runId).toBe(started.runId);
        await stage.host.waitForRun(started.runId);

        // Durable state: cancelled, with the fence; never a completed result.
        const run = await awaitRunTerminal(stage.host, started.runId);
        expect(run.phase).toBe("cancelled");
        expect(run.checkStatus).toBe("cancelled");
        expect(run.cancelled?.by).toBe("octocat");
        expect(run.artifactFrozen).toBe(false);
        expect(run.publication).toBeUndefined();
        expect(run.error).toBeUndefined();

        // GitHub: no review, no comments; the head's check ends cancelled.
        expect(stage.fake.publishedReviews(7)).toHaveLength(0);
        expect(stage.fake.prComments(7)).toHaveLength(0);
        const checks = checksForHead(stage, repo.headSha);
        expect(checks.at(-1)).toMatchObject({ state: "cancelled" });
        expect(checks.some((c) => c.state === "success")).toBe(false);

        // Recovery does not restart the cancelled run: a follow-up command
        // starts a NEW run, and that run publishes.
        const again = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "t09-primary-again",
        });
        expect(again.runId).toBeTruthy();
        expect(again.runId).not.toBe(started.runId);
        const second = await awaitRunTerminal(stage.host, again.runId);
        expect(second.checkStatus).toBe("success");
        expect(second.phase).toBe("published");
        const reviews = stage.fake.publishedReviews(7);
        expect(reviews).toHaveLength(1);
        expect(reviews[0]!.commitId).toBe(repo.headSha);
        // The cancelled run stayed cancelled in history.
        const runs = await runsOf(stage.host);
        expect(runs.find((r) => r.runId === started.runId)?.phase).toBe("cancelled");
      },
    );
  }, 60_000);

  it("/review cancel during re-review keeps the frozen primary artifact in history and publishes nothing", async () => {
    await withStage(
      {
        primaryScript: ONE_REVIEW_PRIMARY,
        reReviewScript: [{ ...READ_TURN, delayMs: 800 }, ...ONE_REVIEW_REREVIEW.slice(1)],
      },
      async (stage) => {
        const started = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "t09-rereview-command",
        });
        expect(started.runId).toBeTruthy();

        // The artifact froze; the re-reviewer's first turn is still open.
        await waitFor(() => (stage.reReviewStub.served >= 1 ? true : undefined));
        const cancelled = await cancelCommand(stage);
        expect(cancelled.outcome).toBe("cancel");
        await stage.host.waitForRun(started.runId);

        const run = await awaitRunTerminal(stage.host, started.runId);
        expect(run.phase).toBe("cancelled");
        expect(run.checkStatus).toBe("cancelled");
        // History is kept: the primary stage's frozen artifact survives.
        expect(run.artifactFrozen).toBe(true);
        expect(run.artifact).toBe(ARTIFACT);
        // No final review, no publication: the re-review never froze.
        expect(run.finalReview).toBeUndefined();
        expect(run.publication).toBeUndefined();
        expect(stage.fake.publishedReviews(7)).toHaveLength(0);
        expect(checksForHead(stage, repo.headSha).at(-1)).toMatchObject({ state: "cancelled" });
      },
    );
  }, 60_000);

  it("cancel during publication: an in-flight publication write stops; the run is never recorded as completed", async () => {
    await withStage(
      {
        primaryScript: ONE_REVIEW_PRIMARY,
        reReviewScript: ONE_REVIEW_REREVIEW,
      },
      async (stage) => {
        const started = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "t09-publish-command",
        });
        expect(started.runId).toBeTruthy();

        // Hold the publication write: the run reaches the publish phase and
        // its review POST is in flight when the cancel lands.
        stage.fake.state.delayNext = { match: /reviews$/, ms: 5_000, remaining: 1 };
        await waitFor(() =>
          stage.fake.requestLog.some((entry) => entry.method === "POST" && entry.path.endsWith("/reviews"))
            ? true
            : undefined,
        );
        const cancelled = await cancelCommand(stage);
        expect(cancelled.outcome).toBe("cancel");
        await stage.host.waitForRun(started.runId);

        const run = await awaitRunTerminal(stage.host, started.runId);
        // The final review had frozen, but the run records cancelled — never
        // a completed result — with no durable publication.
        expect(run.phase).toBe("cancelled");
        expect(run.checkStatus).toBe("cancelled");
        expect(run.finalReview).toBe(REREVIEW_FINAL);
        expect(run.publication).toBeUndefined();

        // GitHub: no success anywhere; the run's own check ends cancelled.
        const checks = checksForHead(stage, repo.headSha);
        expect(checks.some((c) => c.state === "success")).toBe(false);
        expect(checks.at(-1)).toMatchObject({ state: "cancelled" });
      },
    );
  }, 60_000);

  it("closing the pull request cancels the active run and drops the pending request", async () => {
    await withStage(
      {
        primaryScript: [
          { ...READ_TURN, delayMs: 800 },
          ...ONE_REVIEW_PRIMARY.slice(1),
          ...ONE_REVIEW_PRIMARY,
        ],
        reReviewScript: ONE_REVIEW_REREVIEW,
      },
      async (stage) => {
        const started = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "t09-close-command",
        });
        expect(started.runId).toBeTruthy();

        // Queue a review of a pushed head while run 1 is active.
        await waitFor(() => (stage.primaryStub.served >= 1 ? true : undefined));
        const pushedSha = pushCommit("pushed before close");
        stage.pull.headSha = pushedSha;
        const queued = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "t09-close-queued",
        });
        expect(queued.outcome).toBe("queued");

        // The close (a merge is the same closed state) stops the run.
        const stop = await stage.host.handlePullRequestEvent({
          action: "closed",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "t09-close-event",
        });
        expect(stop.outcome).toBe("stop-cancelled");
        await stage.host.waitForRun(started.runId);

        const run = await awaitRunTerminal(stage.host, started.runId);
        expect(run.phase).toBe("cancelled");
        expect(run.checkStatus).toBe("cancelled");
        expect(run.cancelled?.reason).toContain("closed");

        // The pending request was dropped with the pull request: no second
        // run ever starts for the pushed head, and its head carries no
        // success. The drained queue stays empty.
        await stage.host.drainPendingRequests();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const runs = await runsOf(stage.host);
        expect(runs).toHaveLength(1);
        expect(stage.fake.publishedReviews(7)).toHaveLength(0);
        expect(checksForHead(stage, pushedSha)).toHaveLength(0);
        expect(checksForHead(stage, repo.headSha).at(-1)).toMatchObject({ state: "cancelled" });
      },
    );
  }, 60_000);

  it("conversion to draft cancels the active run", async () => {
    await withStage(
      {
        primaryScript: [
          { ...READ_TURN, delayMs: 800 },
          ...ONE_REVIEW_PRIMARY.slice(1),
        ],
        reReviewScript: ONE_REVIEW_REREVIEW,
      },
      async (stage) => {
        const started = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "t09-draft-command",
        });
        expect(started.runId).toBeTruthy();

        await waitFor(() => (stage.primaryStub.served >= 1 ? true : undefined));
        const stop = await stage.host.handlePullRequestEvent({
          action: "converted_to_draft",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "t09-draft-event",
        });
        expect(stop.outcome).toBe("stop-cancelled");
        await stage.host.waitForRun(started.runId);

        const run = await awaitRunTerminal(stage.host, started.runId);
        expect(run.phase).toBe("cancelled");
        expect(run.checkStatus).toBe("cancelled");
        expect(run.cancelled?.reason).toContain("draft");
        expect(stage.fake.publishedReviews(7)).toHaveLength(0);
        expect(checksForHead(stage, repo.headSha).at(-1)).toMatchObject({ state: "cancelled" });
      },
    );
  }, 60_000);

  it("cancel then host crash then Actions re-run: the cancelled run is not restarted; a new command reviews again", async () => {
    const jar = await openScenarioJar({
      pullNumber: 21,
      primaryScript: [
        // The cancelled attempt's turn hangs; the re-run's primary turn and a
        // safety turn follow. A restart of the CANCELLED run would issue a
        // third primary request and exhaust or misorder the script.
        { kind: "hang" },
        ...ONE_REVIEW_PRIMARY.slice(1),
        ...ONE_REVIEW_PRIMARY,
      ],
      reReviewScript: ONE_REVIEW_REREVIEW,
    });
    try {
      const hostA = await jar.openHost();
      const started = await hostA.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 21,
        requester: "octocat",
        deliveryKey: "t09-crash-command",
      });
      await waitFor(() => (jar.primaryStub.served >= 1 ? true : undefined));
      const cancelled = await hostA.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 21,
        requester: "octocat",
        command: "/review cancel",
        deliveryKey: "t09-crash-cancel",
      });
      expect(cancelled.outcome).toBe("cancel");
      await hostA.waitForRun(started.runId);
      const afterCancel = (await hostA.runHistory().allRuns({} as never)).find((r) => r.runId === started.runId);
      expect(afterCancel?.checkStatus).toBe("cancelled");
      await hostA.close();

      // The Actions re-run: the cancelled run stays cancelled and is not
      // picked up; a fresh command starts a new run that publishes.
      const hostB = await jar.openHost();
      try {
        const reRun = await hostB.handleReviewCommand({
          repository: "example/scenario",
          pullNumber: 21,
          requester: "octocat",
          deliveryKey: "t09-crash-rerun",
        });
        expect(reRun.runId).not.toBe(started.runId);
        await hostB.waitForRun(reRun.runId);
        const second = await hostB
          .runHistory()
          .allRuns({} as never)
          .then((runs) => runs.find((r) => r.runId === reRun.runId));
        expect(second?.checkStatus).toBe("success");
        expect(second?.publication).toBeDefined();

        // History: the cancelled run kept its state, attributed to its own
        // attempt; only the new run published.
        const runs = await hostB.runHistory().allRuns({} as never);
        const cancelledRun = runs.find((r) => r.runId === started.runId);
        expect(cancelledRun?.phase).toBe("cancelled");
        expect(cancelledRun?.publication).toBeUndefined();
        expect(jar.fakeGithub.publishedReviews(21)).toHaveLength(1);
      } finally {
        await hostB.close();
      }
    } finally {
      await jar.dispose();
    }
  }, 90_000);

  it("a lost Actions job without a cancel command stays resumable: the re-run joins the same run and publishes", async () => {
    const jar = await openScenarioJar({
      pullNumber: 22,
      primaryScript: [
        // The killed attempt's turn hangs; the resumed attempt's continuation
        // and a safety turn follow.
        { kind: "hang" },
        { text: [ARTIFACT], finishReason: "stop" as const, usage: { promptTokens: 40, completionTokens: 30 } },
        { text: [""], finishReason: "stop" as const },
      ],
      reReviewScript: ONE_REVIEW_REREVIEW,
    });
    try {
      const hostA = await jar.openHost();
      const started = await hostA.handleReviewCommand({
        repository: "example/scenario",
        pullNumber: 22,
        requester: "octocat",
        deliveryKey: "t09-lost-command",
      });
      await waitFor(() => (jar.primaryStub.served >= 1 ? true : undefined));
      // The job is lost: the runner dies without any cancel command.
      await hostA.close();

      const hostB = await jar.openHost();
      try {
        const rejoined = await hostB.handleReviewCommand({
          repository: "example/scenario",
          pullNumber: 22,
          requester: "octocat",
          deliveryKey: "t09-lost-rerun",
        });
        // The same durable run is joined, not restarted as a new one.
        expect(rejoined.runId).toBe(started.runId);
        await hostB.waitForRun(rejoined.runId);
        const run = await hostB
          .runHistory()
          .allRuns({} as never)
          .then((runs) => runs.find((r) => r.runId === started.runId));
        expect(run?.checkStatus).toBe("success");
        expect(run?.cancelled).toBeUndefined();
        expect(jar.fakeGithub.publishedReviews(22)).toHaveLength(1);
      } finally {
        await hostB.close();
      }
    } finally {
      await jar.dispose();
    }
  }, 90_000);

  it("cancel keeps automatic mode on: a queued automatic request starts after the cancelled run", async () => {
    await withStage(
      {
        autoMode: true,
        primaryScript: [
          { ...READ_TURN, delayMs: 800 },
          ...ONE_REVIEW_PRIMARY.slice(1),
          ...ONE_REVIEW_PRIMARY,
        ],
        reReviewScript: ONE_REVIEW_REREVIEW,
      },
      async (stage) => {
        const started = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "t09-auto-command",
        });
        expect(started.runId).toBeTruthy();

        // A push during the run queues the automatic follow-up.
        await waitFor(() => (stage.primaryStub.served >= 1 ? true : undefined));
        const pushedSha = pushCommit("pushed during cancelled run");
        stage.pull.headSha = pushedSha;
        const sync = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "t09-auto-sync",
        });
        expect(sync.outcome).toBe("queued");

        // Cancel run 1; automatic mode stays on, so the queued request for
        // the pushed head starts next and publishes.
        const cancelled = await cancelCommand(stage);
        expect(cancelled.outcome).toBe("cancel");
        await stage.host.waitForRun(started.runId);

        const second = await waitFor(async () =>
          (await runsOf(stage.host)).find(
            (r) => r.subject.headSha === pushedSha && r.checkStatus === "success",
          ),
        );
        expect(second.phase).toBe("published");
        const runs = await runsOf(stage.host);
        expect(runs.map((r) => r.subject.headSha)).toEqual([repo.headSha, pushedSha]);
        expect(runs[0]!.checkStatus).toBe("cancelled");
        const reviews = stage.fake.publishedReviews(7);
        expect(reviews).toHaveLength(1);
        expect(reviews[0]!.commitId).toBe(pushedSha);
      },
    );
  }, 60_000);
});
