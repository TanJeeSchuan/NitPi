/**
 * Scenario tests (ticket 08 — one pipeline per PR and stale results; spec:
 * Testing Decisions — the review host's process boundary).
 *
 * Sends triggers (commands, pushes) against one host and asserts only
 * externally visible results: what GitHub shows (reviews, comments, checks)
 * and what is in the durable run state. Everything inside the host runs for
 * real. Each test gets its own fake GitHub and host; the git fixture is
 * shared (its head branch accumulates the pushes the tests make).
 *
 * Timing: run 1's first turn holds its response open (`delayMs`), so a push
 * delivered after that request was served is deterministically still inside
 * the active run. The queued follow-up run reviews the newest head after
 * run 1 ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { openReviewHost, type ReviewHost } from "../../src/review-host/review-host.js";
import { FakeGitHub, type FakePullRequest } from "../fixtures/fake-github.js";
import { ModelStub, type StubScript, type StubTurn } from "../fixtures/model-stub.js";
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
  "- F1: retained. Primary text: \"the primary found one complexity issue\". Verified against the head checkout.",
].join("\n");

/** The tool round every reviewer turn starts with (its execution is quick;
 * the turn's response itself is what a test can hold open via `delayMs`). */
const READ_TURN: StubTurn = {
  toolCall: { id: "call-08-read", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) },
};

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "nitpi-pipeline-"));
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

/** A new commit on the fixture's head branch: simulates a push to the PR. */
function pushCommit(summary: string): string {
  const checkout = repo.headCheckout();
  const file = join(checkout, "src", `pushed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.ts`);
  execFileSync("node", ["-e", `require("node:fs").writeFileSync(process.argv[1], "// pushed\\n")`, file]);
  execFileSync("git", ["-C", checkout, "add", "."]);
  execFileSync("git", ["-C", checkout, "commit", "-m", summary]);
  return execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Poll until `read` resolves a defined value (drain loops and runs are asynchronous). */
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface Stage {
  primaryStub: ModelStub;
  reReviewStub: ModelStub;
  host: ReviewHost;
  fake: FakeGitHub;
  /** Open pull request #7 the host is configured for. */
  pull: FakePullRequest;
}

interface StageOptions {
  primaryScript: StubScript;
  reReviewScript: StubScript;
  pull?: Partial<FakePullRequest>;
}

/** One test-local harness: fake GitHub + host; both closed afterwards. */
async function withStage(options: StageOptions, test: (stage: Stage) => Promise<void>): Promise<void> {
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
  const primaryStub = new ModelStub(options.primaryScript, "stub-primary");
  const reReviewStub = new ModelStub(options.reReviewScript, "stub-rereview");
  const [primaryBase, reReviewBase, githubBase] = await Promise.all([
    primaryStub.listen(),
    reReviewStub.listen(),
    fake.listen(),
  ]);
  try {
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
        autoMode: automaticPreset(),
      },
      join(workspace, `pipeline-${Math.random().toString(36).slice(2)}.sqlite`),
    );
    try {
      await test({ primaryStub, reReviewStub, host, fake, pull });
    } finally {
      await host.close();
    }
  } finally {
    await fake.close();
    primaryStub.close();
    reReviewStub.close();
  }
}

async function runsOf(host: ReviewHost) {
  return host.runHistory().allRuns({} as never);
}

/** Wait until the run document leaves "in progress" and return it. Durable
 * state, not the host's in-memory waiter — a run may already be terminal. */
async function awaitRunTerminal(host: ReviewHost, runId: string) {
  return waitFor(() =>
    runsOf(host).then((runs) => {
      const run = runs.find((r) => r.runId === runId);
      return run && run.checkStatus !== "in progress" ? run : undefined;
    }),
  );
}

/**
 * Scripts for two complete reviews on this stage, in service order: run 1
 * (its `hold` stage's first turn stays open `delayMs`) and the follow-up run.
 * Under ticket 08 the stale run 1 publishes nothing, so the follow-up run is
 * the first publication and needs no matching turn in its script.
 */
function twoRunScripts(hold: "primary" | "re-review", delayMs = 800): { primaryScript: StubScript; reReviewScript: StubScript } {
  const holdDelay: StubTurn = { ...READ_TURN, delayMs };
  const oneReviewPrimary: StubScript = [
    READ_TURN,
    { text: [ARTIFACT], finishReason: "stop" as const, usage: { promptTokens: 100, completionTokens: 20 } },
  ];
  const oneReviewReReview: StubScript = [
    READ_TURN,
    { text: [REREVIEW_FINAL], finishReason: "stop" as const, usage: { promptTokens: 200, completionTokens: 40 } },
  ];
  return {
    primaryScript:
      hold === "primary" ? [holdDelay, ...oneReviewPrimary.slice(1), ...oneReviewPrimary] : [...oneReviewPrimary, ...oneReviewPrimary],
    reReviewScript:
      hold === "re-review"
        ? [holdDelay, ...oneReviewReReview.slice(1), ...oneReviewReReview]
        : [...oneReviewReReview, ...oneReviewReReview],
  };
}

/** Deliver a synchronize event for a pushed head and assert the pending
 * slot accepted it (automatic mode + active run ⇒ queued, ticket 08). */
async function queuePush(stage: Stage, deliveryKey: string): Promise<void> {
  const sync = await stage.host.handlePullRequestEvent({
    action: "synchronize",
    repository: "example/widgets",
    pullNumber: 7,
    sender: "octocat",
    deliveryKey,
  });
  expect(sync.outcome).toBe("queued");
}

describe("scenario: one review at a time, pushes queue, stale results stay off GitHub (ticket 08)", () => {
  it("a push during primary review does not interrupt it; the pushed head is reviewed next", async () => {
    await withStage(twoRunScripts("primary"), async (stage) => {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
        deliveryKey: "t08-primary-command",
      });
      expect(started.runId).toBeTruthy();

      // Push while the primary reviewer's first turn is still open.
      await waitFor(() => (stage.primaryStub.served >= 1 ? true : undefined));
      const pushedSha = pushCommit("pushed during primary");
      stage.pull.headSha = pushedSha;
      await queuePush(stage, "t08-primary-sync-1");

      // Run 1 finishes on its own head; the pushed head's run starts next.
      await awaitRunTerminal(stage.host, started.runId);
      const second = await waitFor(() =>
        runsOf(stage.host).then((runs) =>
          runs.find((r) => r.subject.headSha === pushedSha && r.checkStatus === "success"),
        ),
      );

      const runs = await runsOf(stage.host);
      expect(runs.map((r) => r.subject.headSha)).toEqual([repo.headSha, pushedSha]);
      // GitHub shows exactly one review: the follow-up run's, on the pushed head.
      const reviews = stage.fake.publishedReviews(7);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.commitId).toBe(pushedSha);
      // The stale run posted nothing; the follow-up run published the findings.
      expect(runs[0]!.checkStatus).toBe("skipped");
      expect(second.checkStatus).toBe("success");
    });
  }, 60_000);

  it("a push during re-review does not interrupt it either; the new head runs next", async () => {
    await withStage(twoRunScripts("re-review"), async (stage) => {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
        deliveryKey: "t08-rereview-command",
      });
      expect(started.runId).toBeTruthy();

      // Push while the re-reviewer's first turn is still open.
      await waitFor(() => (stage.reReviewStub.served >= 1 ? true : undefined));
      const pushedSha = pushCommit("pushed during re-review");
      stage.pull.headSha = pushedSha;
      await queuePush(stage, "t08-rereview-sync-1");

      await awaitRunTerminal(stage.host, started.runId);
      const second = await waitFor(() =>
        runsOf(stage.host).then((runs) =>
          runs.find((r) => r.subject.headSha === pushedSha && r.checkStatus === "success"),
        ),
      );

      const runs = await runsOf(stage.host);
      expect(runs.map((r) => r.subject.headSha)).toEqual([repo.headSha, pushedSha]);
      const reviews = stage.fake.publishedReviews(7);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.commitId).toBe(pushedSha);
      expect(second.checkStatus).toBe("success");
    });
  }, 60_000);

  it("three pushes during one run: only the newest eligible head is reviewed next", async () => {
    await withStage(twoRunScripts("primary"), async (stage) => {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
        deliveryKey: "t08-three-command",
      });
      expect(started.runId).toBeTruthy();

      await waitFor(() => (stage.primaryStub.served >= 1 ? true : undefined));
      // Three pushes during the one active run, each delivered as its own
      // synchronize event; the pending slot keeps only the newest.
      const pushed: string[] = [];
      for (const label of ["a", "b", "c"]) {
        const sha = pushCommit(`pushed ${label} during run 1`);
        stage.pull.headSha = sha;
        pushed.push(sha);
        await queuePush(stage, `t08-three-sync-${label}`);
      }

      await awaitRunTerminal(stage.host, started.runId);
      const second = await waitFor(() =>
        runsOf(stage.host).then((runs) =>
          runs.find((r) => r.subject.headSha === pushed[2] && r.checkStatus === "success"),
        ),
      );

      // Exactly two runs ever: the first and the newest pushed head. The
      // two superseded pushes were never reviewed.
      const runs = await runsOf(stage.host);
      expect(runs.map((r) => r.subject.headSha)).toEqual([repo.headSha, pushed[2]]);
      const reviews = stage.fake.publishedReviews(7);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.commitId).toBe(pushed[2]);
      // The newest head's check is success — reported by its own run, not
      // by the stale one (which posted nothing anywhere).
      const pushedChecks = stage.fake.state.checks.filter((c) => c.headSha === pushed[2]);
      expect(pushedChecks.at(-1)).toMatchObject({ state: "success" });
    });
  }, 60_000);

  it("a stale run leaves GitHub untouched: history keeps the review, nothing is posted", async () => {
    await withStage(twoRunScripts("primary"), async (stage) => {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
        deliveryKey: "t08-untouched-command",
      });
      expect(started.runId).toBeTruthy();

      await waitFor(() => (stage.primaryStub.served >= 1 ? true : undefined));
      const pushedSha = pushCommit("pushed during primary");
      stage.pull.headSha = pushedSha;
      // No review is requested for the pushed head: nothing is pending.
      const checksAtPush = stage.fake.state.checks.length;

      // Durable state: the run completed its review, kept in history and
      // attributed to the head it reviewed; it published nothing.
      const staleRun = await awaitRunTerminal(stage.host, started.runId);
      expect(staleRun.checkStatus).toBe("skipped");
      expect(staleRun.phase).toBe("GitHub skipped");
      expect(staleRun.finalReview).toBe(REREVIEW_FINAL);
      expect(staleRun.subject.headSha).toBe(repo.headSha);
      expect(staleRun.publication).toBeUndefined();
      expect(staleRun.error).toBeUndefined();

      // GitHub: no review, no comments, no thread writes; the newer head
      // carries no check runs at all; and no check reached a completed
      // conclusion after the push — the stale run reports its outcome only
      // in durable history (its own-head in-progress stage signals while it
      // still ran are the run's activity, not a publication).
      expect(stage.fake.publishedReviews(7)).toHaveLength(0);
      expect(stage.fake.prComments(7)).toHaveLength(0);
      expect(stage.fake.state.checks.filter((c) => c.headSha === pushedSha)).toHaveLength(0);
      expect(stage.fake.state.checks.slice(checksAtPush).filter((c) => c.state !== "in_progress")).toHaveLength(0);
    });
  }, 60_000);

  it("a run finishing after the pull request closed also ends as GitHub skipped", async () => {
    await withStage(twoRunScripts("primary"), async (stage) => {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
        deliveryKey: "t08-closed-command",
      });
      expect(started.runId).toBeTruthy();

      await waitFor(() => (stage.primaryStub.served >= 1 ? true : undefined));
      stage.pull.state = "closed";
      const checksAtClose = stage.fake.state.checks.length;

      const staleRun = await awaitRunTerminal(stage.host, started.runId);
      expect(staleRun.checkStatus).toBe("skipped");
      expect(staleRun.phase).toBe("GitHub skipped");
      expect(staleRun.checkDetail).toContain("the pull request is closed");
      expect(staleRun.finalReview).toBe(REREVIEW_FINAL);
      expect(staleRun.publication).toBeUndefined();

      // Nothing reached GitHub after the close: no review, no comments, no
      // completed check on any head.
      expect(stage.fake.publishedReviews(7)).toHaveLength(0);
      expect(stage.fake.prComments(7)).toHaveLength(0);
      expect(stage.fake.state.checks.slice(checksAtClose).filter((c) => c.state !== "in_progress")).toHaveLength(0);
    });
  }, 60_000);

  it("the stale run never marks the newer head's check successful", async () => {
    await withStage(twoRunScripts("primary"), async (stage) => {
      const started = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
        deliveryKey: "t08-notsuccess-command",
      });
      expect(started.runId).toBeTruthy();

      await waitFor(() => (stage.primaryStub.served >= 1 ? true : undefined));
      const pushedSha = pushCommit("pushed during primary");
      stage.pull.headSha = pushedSha;
      // Request a review of the pushed head WHILE run 1 is still active:
      // it queues behind the active run instead of starting a second one.
      const queued = await stage.host.handleReviewCommand({
        repository: "example/widgets",
        pullNumber: 7,
        requester: "octocat",
        deliveryKey: "t08-notsuccess-queued",
      });
      expect(queued.outcome).toBe("queued");

      await awaitRunTerminal(stage.host, started.runId);

      // At the moment the stale run ends, the newer head carries no check
      // runs at all — most importantly no success.
      const checksOnPushed = stage.fake.state.checks.filter((c) => c.headSha === pushedSha);
      expect(checksOnPushed).toHaveLength(0);

      // The queued request then starts and IT is the run that reviews the
      // newer head and marks its check successful.
      const second = await waitFor(() =>
        runsOf(stage.host).then((runs) =>
          runs.find((r) => r.subject.headSha === pushedSha && r.checkStatus === "success"),
        ),
      );
      expect(second.checkStatus).toBe("success");
      const successOnPushed = stage.fake.state.checks.filter(
        (c) => c.headSha === pushedSha && c.state === "success",
      );
      expect(successOnPushed).toHaveLength(1);
      expect(stage.fake.publishedReviews(7)[0]!.commitId).toBe(pushedSha);
    });
  }, 60_000);
});
