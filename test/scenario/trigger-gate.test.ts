/**
 * Scenario tests for ticket 03 — trigger gate and automatic mode (spec:
 * Testing Decisions; one seam, the review host's process boundary).
 *
 * Sends commands and pull-request events and asserts only what is visible
 * on GitHub (the fake server's state) and what is in the durable run state.
 * Everything inside the host runs for real. Each test gets its own fake
 * GitHub and host; the git fixture is shared (its head branch accumulates
 * the pushes the tests make).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { openReviewHost, type ReviewHost } from "../../src/review-host/review-host.js";
import { FakeGitHub, type FakePullRequest } from "../fixtures/fake-github.js";
import { ModelStub, type StubScript } from "../fixtures/model-stub.js";
import { createGitRepoFixture, unifiedDiff, type GitRepoFixture } from "../fixtures/git-fixture.js";
import { automaticPreset } from "../../src/review-host/trigger-gate.js";
import type { AutoModeConfig } from "../../src/review-host/config.js";

let workspace: string;
let repo: GitRepoFixture;

const NO_FINDINGS_PRIMARY: StubScript = [
  { text: ["No issues found; the change is a clean simplification."], finishReason: "stop" as const, usage: { promptTokens: 100, completionTokens: 20 } },
];
const NO_FINDINGS_REREVIEW: StubScript = [
  {
    text: ["# Final review\n\n# Audit notes\n\n- Nothing to audit: the primary found nothing to verify."],
    finishReason: "stop" as const,
    usage: { promptTokens: 200, completionTokens: 30 },
  },
];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "nitpi-gate-"));
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
function pushNextCommit(): string {
  const checkout = repo.headCheckout();
  const file = join(checkout, "src", `pushed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.ts`);
  execFileSync("node", ["-e", `require("node:fs").writeFileSync(process.argv[1], "// pushed\\n")`, file]);
  execFileSync("git", ["-C", checkout, "add", "."]);
  execFileSync("git", ["-C", checkout, "commit", "-m", "pushed"]);
  return execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** Poll until `read` resolves a defined value (drain loops and runs are asynchronous). */
async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
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
  autoMode?: AutoModeConfig;
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
        ...(options.autoMode ? { autoMode: options.autoMode } : {}),
      },
      join(workspace, `gate-${Math.random().toString(36).slice(2)}.sqlite`),
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

describe("scenario: trigger gate refuses and explains", () => {
  it("refuses a non-writer's /review as action required, with no run and no review", async () => {
    await withStage(
      { primaryScript: [], reReviewScript: [] },
      async (stage) => {
        stage.fake.collaboratorPermissions["outsider"] = "read";
        const refused = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "outsider",
          deliveryKey: "comment-1001",
        });
        expect(refused.outcome).toBe("refused");
        expect(refused.refused).toContain("is not a repository writer or maintainer");

        // GitHub: the refusal is visible as a check on the head; no review, no run.
        const refusalChecks = stage.fake.state.checks.filter((c) => c.headSha === repo.headSha);
        expect(refusalChecks.at(-1)).toMatchObject({ state: "action_required" });
        expect(refusalChecks.at(-1)!.summary).toContain("outsider");
        expect(stage.fake.publishedReviews(7)).toHaveLength(0);
        expect(await runsOf(stage.host)).toHaveLength(0);
      },
    );
  });

  it("refuses /review on a closed pull request as skipped, with an explanation", async () => {
    await withStage(
      { primaryScript: [], reReviewScript: [], pull: { state: "closed" } },
      async (stage) => {
        const refused = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "comment-1002",
        });
        expect(refused.outcome).toBe("refused");
        expect(refused.refused).toContain("closed");
        const refusalChecks = stage.fake.state.checks.filter((c) => c.headSha === repo.headSha);
        expect(refusalChecks.at(-1)).toMatchObject({ state: "skipped" });
        expect(await runsOf(stage.host)).toHaveLength(0);
        expect(stage.fake.publishedReviews(7)).toHaveLength(0);
      },
    );
  });

  it("recognises /review clean and /review cancel and applies the same requester check to each", async () => {
    await withStage(
      { primaryScript: [], reReviewScript: [] },
      async (stage) => {
        // Non-writer: the same refusal as /review, for both commands.
        stage.fake.collaboratorPermissions["outsider"] = "read";
        const clean = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "outsider",
          command: "/review clean",
          deliveryKey: "comment-1003",
        });
        expect(clean.outcome).toBe("refused");
        expect(clean.refused).toContain("is not a repository writer or maintainer");

        const cancel = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "outsider",
          command: "/review cancel",
          deliveryKey: "comment-1004",
        });
        expect(cancel.outcome).toBe("refused");
        expect(cancel.refused).toContain("is not a repository writer or maintainer");

        // A writer is permitted; the commands' run behaviour is not wired yet.
        const writerClean = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          command: "/review clean",
          deliveryKey: "comment-1005",
        });
        expect(writerClean.outcome).toBe("refused");
        expect(writerClean.refused).toContain("ticket 07");
        expect(await runsOf(stage.host)).toHaveLength(0);
      },
    );
  });

  it("refuses redelivery of the same comment: at most one run per delivery", async () => {
    await withStage(
      { primaryScript: [NO_FINDINGS_PRIMARY[0]!], reReviewScript: [NO_FINDINGS_REREVIEW[0]!] },
      async (stage) => {
        const first = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "comment-delivery-1",
        });
        expect(first.runId).toBeTruthy();
        await stage.host.waitForRun(first.runId);

        // The same comment delivered again (GitHub retry): duplicate, no new run.
        const replay = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "comment-delivery-1",
        });
        expect(replay.outcome).toBe("duplicate");
        expect(replay.runId).toBe("");

        expect(await runsOf(stage.host)).toHaveLength(1);
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);
      },
    );
  });
});

describe("scenario: fork pull requests", () => {
  it("a writer's /review approves only the current head; a later push needs fresh approval", async () => {
    await withStage(
      {
        primaryScript: [NO_FINDINGS_PRIMARY[0]!, NO_FINDINGS_PRIMARY[0]!],
        reReviewScript: [NO_FINDINGS_REREVIEW[0]!, NO_FINDINGS_REREVIEW[0]!],
        autoMode: automaticPreset(),
        pull: { headRepo: "fork-owner/widgets", baseRepo: "example/widgets" },
      },
      async (stage) => {
        // First /review on the fork: the writer's own command approves this head.
        const first = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "fork-command-1",
        });
        expect(first.runId).toBeTruthy();
        await stage.host.waitForRun(first.runId);
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);

        // The fork pushes; automatic events must not review the new head.
        const pushedSha = pushNextCommit();
        stage.pull.headSha = pushedSha;
        stage.pull.headRef = "patch-2";
        const auto = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "fork-owner",
          deliveryKey: "fork-push-2",
        });
        expect(auto.outcome).toBe("refused");
        expect(auto.refused).toContain("has not been approved by a writer");
        const refusalChecks = stage.fake.state.checks.filter((c) => c.headSha === pushedSha);
        expect(refusalChecks.at(-1)).toMatchObject({ state: "action_required" });
        expect(stage.fake.publishedReviews(7)).toHaveLength(1); // nothing new published

        // A writer's fresh /review approves the new head and reviews it.
        const second = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "fork-command-2",
        });
        expect(second.runId).toBeTruthy();
        await stage.host.waitForRun(second.runId);
        const runs = await runsOf(stage.host);
        expect(runs).toHaveLength(2);
        expect(runs.map((r) => r.subject.headSha)).toEqual([repo.headSha, pushedSha]);
        expect(stage.fake.publishedReviews(7)).toHaveLength(2);
        expect(stage.fake.publishedReviews(7)[1]!.commitId).toBe(pushedSha);
      },
    );
  });

  it("automatic reviews of an unapproved fork head are refused; the writer's command is the approval", async () => {
    await withStage(
      {
        primaryScript: [NO_FINDINGS_PRIMARY[0]!],
        reReviewScript: [NO_FINDINGS_REREVIEW[0]!],
        autoMode: automaticPreset(),
        pull: { headRepo: "fork-owner/widgets", baseRepo: "example/widgets" },
      },
      async (stage) => {
        // Push-triggered automatic review of an unapproved fork head: refused.
        const refused = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "fork-owner",
          deliveryKey: "auto-fork-1",
        });
        expect(refused.outcome).toBe("refused");
        expect(refused.refused).toContain("has not been approved");
        expect(await runsOf(stage.host)).toHaveLength(0);
        expect(stage.fake.publishedReviews(7)).toHaveLength(0);

        // A maintainer's /review approves the current head; the run starts.
        const command = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "fork-approval-1",
        });
        await stage.host.waitForRun(command.runId);
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);
      },
    );
  });
});

describe("scenario: automatic mode and toggles", () => {
  it("manual mode is the default: pull-request events start nothing, commands still do", async () => {
    await withStage(
      { primaryScript: [NO_FINDINGS_PRIMARY[0]!], reReviewScript: [NO_FINDINGS_REREVIEW[0]!] },
      async (stage) => {
        const pushed = pushNextCommit();
        stage.pull.headSha = pushed;

        // New commit in manual mode: no review requested, nothing posted.
        const sync = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "manual-sync-1",
        });
        expect(sync.outcome).toBe("ignored");
        const opened = await stage.host.handlePullRequestEvent({
          action: "opened",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "manual-opened-1",
        });
        expect(opened.outcome).toBe("ignored");
        expect(await runsOf(stage.host)).toHaveLength(0);
        expect(stage.fake.publishedReviews(7)).toHaveLength(0);
        // No refusal checks either: manual silence is not a refusal.
        expect(stage.fake.state.checks).toHaveLength(0);

        // A writer's command still works in manual mode.
        const command = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "manual-command-1",
        });
        await stage.host.waitForRun(command.runId);
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);
      },
    );
  });

  it("the automatic preset reviews opened and synchronize events without commands", async () => {
    await withStage(
      {
        primaryScript: [NO_FINDINGS_PRIMARY[0]!, NO_FINDINGS_PRIMARY[0]!],
        reReviewScript: [NO_FINDINGS_REREVIEW[0]!, NO_FINDINGS_REREVIEW[0]!],
        autoMode: automaticPreset(),
      },
      async (stage) => {
        // PR opened: the automatic review starts without any command.
        const opened = await stage.host.handlePullRequestEvent({
          action: "opened",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "auto-opened-1",
        });
        expect(opened.outcome).toBe("start");
        await stage.host.waitForRun(opened.runId);
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);

        // New commit: the synchronize toggle reviews the new head next.
        const pushed = pushNextCommit();
        stage.pull.headSha = pushed;
        const sync = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "auto-sync-1",
        });
        expect(sync.outcome).toBe("start");
        await stage.host.waitForRun(sync.runId);

        const runs = await runsOf(stage.host);
        expect(runs).toHaveLength(2);
        expect(runs[0]!.source).toBe("automatic");
        expect(runs[1]!.source).toBe("automatic");
        expect(runs.map((r) => r.subject.headSha)).toEqual([repo.headSha, pushed]);
      },
    );
  });

  it("toggle-off events are ignored and toggle-on events run; toggles are independent", async () => {
    await withStage(
      {
        primaryScript: [NO_FINDINGS_PRIMARY[0]!],
        reReviewScript: [NO_FINDINGS_REREVIEW[0]!],
        autoMode: {
          mode: "automatic",
          events: { opened: false, reopened: false, synchronize: true, readyForReview: false },
        },
      },
      async (stage) => {
        const openedOff = await stage.host.handlePullRequestEvent({
          action: "opened",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "toggle-opened-off",
        });
        expect(openedOff.outcome).toBe("ignored");
        const readyOff = await stage.host.handlePullRequestEvent({
          action: "ready_for_review",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "toggle-ready-off",
        });
        expect(readyOff.outcome).toBe("ignored");
        expect(await runsOf(stage.host)).toHaveLength(0);

        // The one enabled toggle runs.
        const sync = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "toggle-sync-on",
        });
        expect(sync.outcome).toBe("start");
        await stage.host.waitForRun(sync.runId);
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);
      },
    );
  });

  it("a draft pull request gets no automatic review, with an action-required explanation", async () => {
    await withStage(
      { primaryScript: [], reReviewScript: [], autoMode: automaticPreset(), pull: { draft: true } },
      async (stage) => {
        const refused = await stage.host.handlePullRequestEvent({
          action: "opened",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "draft-auto-1",
        });
        expect(refused.outcome).toBe("refused");
        expect(refused.refused).toContain("draft");
        const refusalChecks = stage.fake.state.checks.filter((c) => c.headSha === repo.headSha);
        expect(refusalChecks.at(-1)).toMatchObject({ state: "action_required" });
        expect(refusalChecks.at(-1)!.summary).toContain("draft");
        expect(await runsOf(stage.host)).toHaveLength(0);
        expect(stage.fake.publishedReviews(7)).toHaveLength(0);
      },
    );
  });

  it("the automatic preset enables all four events with no check wait", async () => {
    const preset = automaticPreset();
    expect(preset.mode).toBe("automatic");
    expect(preset.events).toEqual({ opened: true, reopened: true, synchronize: true, readyForReview: true });
    expect(preset.waitForChecks).toBeUndefined();
  });
});

describe("scenario: pending requests and named checks", () => {
  it("a /review on a newer head queues behind the active run and starts after it", async () => {
    // Run A reads a file first (stays active); a command for the same head is
    // satisfied, a command for a newer head queues.
    const slowPrimary: StubScript = [
      { toolCall: { id: "call-slow", name: "read", input: JSON.stringify({ path: "src/handler.ts" }) } },
      { text: ["No issues found."], finishReason: "stop" as const, usage: { promptTokens: 100, completionTokens: 10 } },
    ];
    await withStage(
      {
        primaryScript: [slowPrimary[0]!, slowPrimary[1]!, NO_FINDINGS_PRIMARY[0]!],
        reReviewScript: [NO_FINDINGS_REREVIEW[0]!, NO_FINDINGS_REREVIEW[0]!],
      },
      async (stage) => {
        const first = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "queue-command-1",
        });

        // Same-head command while the run is active: satisfied, no second run.
        const sameHead = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "queue-command-2",
        });
        expect(sameHead.outcome).toBe("satisfied");
        expect(sameHead.runId).toBe(first.runId);

        // The PR pushes to a new head; the writer's command approves and queues.
        const pushed = pushNextCommit();
        stage.pull.headSha = pushed;
        const queued = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "queue-command-3",
        });
        expect(queued.outcome).toBe("queued");
        expect(queued.runId).toBe("");

        // The queued request starts after the active run finishes.
        await stage.host.waitForRun(first.runId);
        const second = await waitFor(() =>
          stage.host
            .runHistory()
            .allRuns({} as never)
            .then((runs) => runs.find((r) => r.subject.headSha === pushed && r.checkStatus !== "in progress")),
        );
        expect(second.source).toBe("command");
        expect(stage.fake.publishedReviews(7)).toHaveLength(2);
      },
    );
  });

  it("an automatic review waits until the named checks have completed on the head", async () => {
    await withStage(
      {
        primaryScript: [NO_FINDINGS_PRIMARY[0]!],
        reReviewScript: [NO_FINDINGS_REREVIEW[0]!],
        autoMode: {
          mode: "automatic",
          events: { opened: false, reopened: false, synchronize: true, readyForReview: false },
          waitForChecks: ["lint"],
        },
      },
      async (stage) => {
        // The named check has not started: the request stays pending, no run.
        const queued = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "checks-sync-1",
        });
        expect(queued.outcome).toBe("queued");
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(await runsOf(stage.host)).toHaveLength(0);

        // The check runs (in progress) — still waiting.
        stage.fake.state.externalChecks.set(`${repo.headSha}|lint`, "in_progress");
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await runsOf(stage.host)).toHaveLength(0);

        // The check completes: the review starts on its own.
        stage.fake.state.externalChecks.set(`${repo.headSha}|lint`, "completed:success");
        // Wait for terminal durable state (the run may finish before we look).
        const run = await waitFor(() =>
          stage.host
            .runHistory()
            .allRuns({} as never)
            .then((runs) =>
              runs.find((r) => r.subject.headSha === repo.headSha && r.checkStatus === "success"),
            ),
        );
        expect(run.phase).toBe("published");
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);
      },
    );
  });
});
