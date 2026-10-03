/**
 * Scenario stage wiring: one fake GitHub, two model stubs, and one review
 * host per test (spec: Testing Decisions — one seam, the review host's
 * process boundary; everything inside the host runs for real).
 */
import { join } from "node:path";
import type { ReviewHost } from "../../src/review-host/review-host.js";
import { openHostOnStorage } from "./host-on-storage.js";
import { FakeGitHub } from "../fixtures/fake-github.js";
import { ModelStub, type StubScript } from "../fixtures/model-stub.js";
import { unifiedDiff, type GitRepoFixture } from "../fixtures/git-fixture.js";

export interface ScenarioStage {
  fake: FakeGitHub;
  primaryStub: ModelStub;
  reReviewStub: ModelStub;
  host: ReviewHost;
  /** Current re-review stub serve hook (ticket 07 tests snapshot other
   * fixtures' state at the freeze moment, i.e. when a given request arrives). */
  onReReviewServe: { current?: (index: number) => void };
  /** Log index this test's latest onReReviewServe hook captured; -1 until set. */
  freezeLogIndex: number;
}

/** The reviewed diff in the git fixture: handler.ts lines 3 and 5 on RIGHT. */
export const STAGE_ANCHORS = ["src/handler.ts#RIGHT#3", "src/handler.ts#RIGHT#5"];

/** One fake GitHub + two model stubs + one review host, all test-scoped. */
export async function openScenarioStage(
  repo: GitRepoFixture,
  opts: {
    primary: StubScript;
    reReview: StubScript;
    workspace: string;
  },
): Promise<ScenarioStage> {
  const fake = new FakeGitHub(
    [{ number: 7, headSha: repo.headSha, baseSha: repo.baseSha, state: "open" }],
    STAGE_ANCHORS,
    // The host pins this diff at run start (ticket 02) and validates anchors
    // against it; the fake serves it with the diff media type.
    { diffText: unifiedDiff() },
  );
  const githubBase = await fake.listen();
  const primaryStub = new ModelStub(opts.primary, "stub-primary");
  const onReReviewServe: { current?: (index: number) => void } = {};
  const reReviewStub = new ModelStub(opts.reReview, "stub-rereview", (index) => onReReviewServe.current?.(index));
  const [primaryBase, reReviewBase] = await Promise.all([primaryStub.listen(), reReviewStub.listen()]);
  const host = await openHostOnStorage(
    {
      repository: "example/widgets",
      pullNumber: 7,
      githubToken: "test-token",
      githubBaseUrl: githubBase,
      primary: {
        baseUrl: `${primaryBase}/v1`,
        modelId: "stub-primary",
        apiKey: "stub-primary-key",
      },
      reReview: {
        baseUrl: `${reReviewBase}/v1`,
        modelId: "stub-rereview",
        apiKey: "stub-rereview-key",
      },
      repositoryInstructions: "Be strict about unused parameters.",
      repositoryInstructionsRevision: repo.baseSha,
      headCheckoutSource: repo.headCheckout(),
    },
    join(opts.workspace, `run-${Math.random().toString(36).slice(2)}`),
  );
  return { fake, primaryStub, reReviewStub, host, onReReviewServe, freezeLogIndex: -1 };
}

/** Close everything; a closed host must not mask earlier test failures. */
export async function closeScenarioStage(stage: ScenarioStage): Promise<void> {
  await stage.host.close();
  await Promise.all([stage.primaryStub.close(), stage.reReviewStub.close()]);
  await stage.fake.close();
}

/** A writer's `/review` (or `/review clean`) on the stage's pull request,
 * run to completion. */
export async function runReview(
  stage: ScenarioStage,
  command: "/review" | "/review clean" = "/review",
): Promise<{ runId: string }> {
  const started = await stage.host.handleReviewCommand({
    repository: "example/widgets",
    pullNumber: 7,
    requester: "octocat",
    command,
  });
  if (started.refused) throw new Error(started.refused);
  await stage.host.waitForRun(started.runId);
  return { runId: started.runId };
}

/** The newest durable run document on the stage's host. */
export async function latestRun(stage: ScenarioStage) {
  const runs = await stage.host.runHistory().allRuns({} as never);
  return runs.at(-1)!;
}

/** Wire helpers: extract messages from a recorded chat-completions request. */
export type RecordedMessages = Array<{ role: string; content: unknown }> | undefined;

export function firstSystemMessage(messages: RecordedMessages): string {
  const system = messages?.find((m) => m.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

export function firstUserMessage(messages: RecordedMessages): string {
  const user = messages?.find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}

/** The newest user message — a follow-up wire request carries the whole
 * conversation; the matching turn's prompt is its last user message. */
export function lastUserMessage(messages: RecordedMessages): string {
  const user = messages ? [...messages].reverse().find((m) => m.role === "user") : undefined;
  return typeof user?.content === "string" ? user.content : "";
}
