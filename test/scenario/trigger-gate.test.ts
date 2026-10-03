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
import type { ReviewHost } from "../../src/review-host/review-host.js";
import { openHostOnStorage } from "../helpers/host-on-storage.js";
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
    const host = await openHostOnStorage(
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
      join(workspace, `gate-${Math.random().toString(36).slice(2)}`),
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
        // Ticket 04's maintained summary: the rerun publishes by PATCHing the
        // bot's summary review, not by adding another one — its body shows the
        // new run's reviewed head and its zero finding count.
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);
        expect(stage.fake.publishedReviews(7)[0]!.body).toContain(`\`${pushedSha}\``);
        expect(stage.fake.publishedReviews(7)[0]!.body).toContain("0 findings");
        expect(runs[1]!.publication?.reviewId).toBe(stage.fake.publishedReviews(7)[0]!.id);
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

  it("each toggle runs its own event and nothing else (reopened, ready_for_review on; synchronize off)", async () => {
    await withStage(
      {
        primaryScript: [NO_FINDINGS_PRIMARY[0]!, NO_FINDINGS_PRIMARY[0]!],
        reReviewScript: [NO_FINDINGS_REREVIEW[0]!, NO_FINDINGS_REREVIEW[0]!],
        autoMode: {
          mode: "automatic",
          events: { opened: false, reopened: true, synchronize: false, readyForReview: true },
        },
      },
      async (stage) => {
        // synchronize toggle off: a new commit requests nothing.
        const sync = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "matrix-sync-off",
        });
        expect(sync.outcome).toBe("ignored");

        // reopened toggle on: the run starts without any command.
        const reopened = await stage.host.handlePullRequestEvent({
          action: "reopened",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "matrix-reopened-on",
        });
        expect(reopened.outcome).toBe("start");
        await stage.host.waitForRun(reopened.runId);

        // ready_for_review toggle on: the (already reviewed) head is not
        // re-reviewed, but the toggle itself accepted the event. Push first
        // so the event targets a fresh head.
        const pushed = pushNextCommit();
        stage.pull.headSha = pushed;
        const ready = await stage.host.handlePullRequestEvent({
          action: "ready_for_review",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "matrix-ready-on",
        });
        expect(ready.outcome).toBe("start");
        await stage.host.waitForRun(ready.runId);

        const runs = await runsOf(stage.host);
        expect(runs).toHaveLength(2);
        expect(runs.map((r) => r.subject.headSha)).toEqual([repo.headSha, pushed]);
      },
    );
  });

  it("refuses an automatic event on a closed pull request with a skipped check", async () => {
    await withStage(
      {
        primaryScript: [],
        reReviewScript: [],
        autoMode: automaticPreset(),
        pull: { state: "closed" as const },
      },
      async (stage) => {
        const refused = await stage.host.handlePullRequestEvent({
          action: "opened",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "closed-auto-1",
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

  it("refuses redelivery of the same pull-request event: at most one automatic run", async () => {
    await withStage(
      {
        primaryScript: [NO_FINDINGS_PRIMARY[0]!],
        reReviewScript: [NO_FINDINGS_REREVIEW[0]!],
        autoMode: { mode: "automatic", events: { opened: false, reopened: false, synchronize: true, readyForReview: false } },
      },
      async (stage) => {
        // The first delivery starts the automatic review; re-delivering the
        // SAME event (GitHub retry) is a duplicate and starts nothing.
        const first = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "pr-event-delivery-1",
        });
        expect(first.outcome).toBe("start");
        await stage.host.waitForRun(first.runId);

        const replay = await stage.host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "pr-event-delivery-1",
        });
        expect(replay.outcome).toBe("duplicate");
        expect(await runsOf(stage.host)).toHaveLength(1);
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);
      },
    );
  });
});

describe("scenario: pending requests and named checks", () => {
  it("redelivery of a queued /review does not start a second run after the queued run finishes", async () => {
    // Writer's /review on head B queues behind run A; the drain runs it; a
    // GitHub redelivery of the SAME comment must not start it again.
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
          deliveryKey: "queued-redelivery-1",
        });
        const pushed = pushNextCommit();
        stage.pull.headSha = pushed;
        const queued = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "queued-redelivery-2",
        });
        expect(queued.outcome).toBe("queued");

        // Run A finishes; the queued request starts (records its delivery key).
        await stage.host.waitForRun(first.runId);
        await waitFor(() =>
          stage.host
            .runHistory()
            .allRuns({} as never)
            .then((runs) => runs.find((r) => r.subject.headSha === pushed && r.checkStatus === "success")),
        );

        // Redelivery of the queued comment: duplicate, no third run.
        const replay = await stage.host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "queued-redelivery-2",
        });
        expect(replay.outcome).toBe("duplicate");
        expect(await runsOf(stage.host)).toHaveLength(2);
        // The queued run publishes under ticket 04's maintained-summary model:
        // one summary review, PATCHed to show the queued run's head.
        const pushes = await runsOf(stage.host);
        expect(pushes[1]!.publication?.reviewId).toBeTruthy();
        expect(stage.fake.publishedReviews(7)).toHaveLength(1);
        expect(stage.fake.publishedReviews(7)[0]!.body).toContain(`\`${pushed}\``);
      },
    );
  });

  it("fork approvals and delivery dedup survive a host restart", async () => {
    const storageDir = join(workspace, `restart-approval-${Math.random().toString(36).slice(2)}`);
    const pull: FakePullRequest = {
      number: 7,
      headSha: repo.headSha,
      baseSha: repo.baseSha,
      state: "open",
      headRepo: "fork-owner/widgets",
      baseRepo: "example/widgets",
    };
    const openHostOn = async (fake: FakeGitHub, primaryStub: ModelStub, reReviewStub: ModelStub) => {
      const [primaryBase, reReviewBase, githubBase] = await Promise.all([
        primaryStub.listen(), reReviewStub.listen(), fake.listen(),
      ]);
      return openHostOnStorage(
        {
          repository: "example/widgets",
          pullNumber: 7,
          githubToken: "t",
          githubBaseUrl: githubBase,
          primary: { baseUrl: `${primaryBase}/v1`, modelId: "stub-primary", apiKey: "k" },
          reReview: { baseUrl: `${reReviewBase}/v1`, modelId: "stub-rereview", apiKey: "k" },
          repositoryInstructions: "rules",
          repositoryInstructionsRevision: repo.baseSha,
          headCheckoutSource: repo.headCheckout(),
          autoMode: {
            mode: "automatic",
            events: { opened: false, reopened: false, synchronize: true, readyForReview: false },
          },
        },
        storageDir,
      );
    };

    // Host A: the writer's /review approves the fork head and runs once.
    const fakeA = new FakeGitHub([pull], ["src/handler.ts#RIGHT#3", "src/handler.ts#RIGHT#5"], { diffText: unifiedDiff() });
    const stubA1 = new ModelStub([NO_FINDINGS_PRIMARY[0]!], "stub-primary");
    const stubA2 = new ModelStub([NO_FINDINGS_REREVIEW[0]!], "stub-rereview");
    {
      const host = await openHostOn(fakeA, stubA1, stubA2);
      try {
        const command = await host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "restart-command-1",
        });
        expect(command.outcome).toBe("start");
        await host.waitForRun(command.runId);
      } finally {
        await host.close();
        await fakeA.close();
        stubA1.close();
        stubA2.close();
      }
    }

    // Host B on the same storage: the delivered key and the fork approval
    // are enforced without re-running models.
    const fakeB = new FakeGitHub([pull], ["src/handler.ts#RIGHT#3", "src/handler.ts#RIGHT#5"], { diffText: unifiedDiff() });
    const stubB1 = new ModelStub([], "stub-primary");
    const stubB2 = new ModelStub([], "stub-rereview");
    try {
      const host = await openHostOn(fakeB, stubB1, stubB2);
      try {
        // Redelivery of the command's comment: duplicate, no new run.
        const replay = await host.handleReviewCommand({
          repository: "example/widgets",
          pullNumber: 7,
          requester: "octocat",
          deliveryKey: "restart-command-1",
        });
        expect(replay.outcome).toBe("duplicate");

        // The approved fork head is still approved: an automatic event is not
        // refused for approval, and not re-run (head already reviewed).
        const auto = await host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "fork-owner",
          deliveryKey: "restart-sync-1",
        });
        expect(auto.outcome).toBe("ignored");
        expect(auto.refused).toBeUndefined();

        // The whole history survived the restart: exactly the one run.
        expect(await host.runHistory().allRuns({} as never)).toHaveLength(1);
        expect(fakeB.publishedReviews(7)).toHaveLength(0); // nothing new published
      } finally {
        await host.close();
      }
    } finally {
      await fakeB.close();
      stubB1.close();
      stubB2.close();
    }
  });

  it("a pending automatic request for named checks survives a host restart", async () => {
    const storageDir = join(workspace, `restart-pending-${Math.random().toString(36).slice(2)}`);
    const pull: FakePullRequest = {
      number: 7,
      headSha: repo.headSha,
      baseSha: repo.baseSha,
      state: "open",
    };
    const openHostOn = async (fake: FakeGitHub, primaryStub: ModelStub, reReviewStub: ModelStub) => {
      const [primaryBase, reReviewBase, githubBase] = await Promise.all([
        primaryStub.listen(), reReviewStub.listen(), fake.listen(),
      ]);
      return openHostOnStorage(
        {
          repository: "example/widgets",
          pullNumber: 7,
          githubToken: "t",
          githubBaseUrl: githubBase,
          primary: { baseUrl: `${primaryBase}/v1`, modelId: "stub-primary", apiKey: "k" },
          reReview: { baseUrl: `${reReviewBase}/v1`, modelId: "stub-rereview", apiKey: "k" },
          repositoryInstructions: "rules",
          repositoryInstructionsRevision: repo.baseSha,
          headCheckoutSource: repo.headCheckout(),
          autoMode: {
            mode: "automatic",
            events: { opened: false, reopened: false, synchronize: true, readyForReview: false },
            waitForChecks: ["lint"],
          },
        },
        storageDir,
      );
    };

    // Host A: the automatic request queues for the named check and stays
    // pending across close() (the drain never sees the check complete).
    const fakeA = new FakeGitHub([pull], ["src/handler.ts#RIGHT#3", "src/handler.ts#RIGHT#5"], { diffText: unifiedDiff() });
    const stubA1 = new ModelStub([], "stub-primary");
    const stubA2 = new ModelStub([], "stub-rereview");
    {
      const host = await openHostOn(fakeA, stubA1, stubA2);
      try {
        const queued = await host.handlePullRequestEvent({
          action: "synchronize",
          repository: "example/widgets",
          pullNumber: 7,
          sender: "octocat",
          deliveryKey: "restart-sync-pending",
        });
        expect(queued.outcome).toBe("queued");
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await host.runHistory().allRuns({} as never)).toHaveLength(0);
      } finally {
        await host.close(); // abandons the polling drain; pending stays durable
        await fakeA.close();
        stubA1.close();
        stubA2.close();
      }
    }

    // Host B on the same storage: the check completes; the recovered request
    // starts on its own through drainPendingRequests().
    const fakeB = new FakeGitHub([pull], ["src/handler.ts#RIGHT#3", "src/handler.ts#RIGHT#5"], { diffText: unifiedDiff() });
    const stubB1 = new ModelStub([NO_FINDINGS_PRIMARY[0]!], "stub-primary");
    const stubB2 = new ModelStub([NO_FINDINGS_REREVIEW[0]!], "stub-rereview");
    try {
      const host = await openHostOn(fakeB, stubB1, stubB2);
      try {
        fakeB.state.externalChecks.set(`${repo.headSha}|lint`, "completed:success");
        await host.drainPendingRequests();
        const run = await waitFor(() =>
          host
            .runHistory()
            .allRuns({} as never)
            .then((runs) => runs.find((r) => r.subject.headSha === repo.headSha && r.checkStatus === "success")),
        );
        expect(run.runId).toBeTruthy();
        expect(run.source).toBe("automatic");
        expect(fakeB.publishedReviews(7)).toHaveLength(1);
      } finally {
        await host.close();
      }
    } finally {
      await fakeB.close();
      stubB1.close();
      stubB2.close();
    }
  });
});
