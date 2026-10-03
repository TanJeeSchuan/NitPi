/**
 * Actions entry-point tests (ticket 11).
 *
 * The entry point is the review host's Actions-side boundary: the workflow
 * invokes it as a fresh process per delivered event, and its externally
 * visible contract is (a) the environment it maps onto the host config,
 * (b) the trigger it files with the gate, and (c) its exit code. So these
 * tests run it exactly the way the workflow does — a child `tsx` process
 * whose env carries the mapped inputs and secrets and whose working
 * directory is a checked-out repository — against the same jar fixtures
 * the scenario suite uses (real storage service, fake GitHub, scripted
 * model endpoints).
 *
 * The workflow YAML's trust pins live in workflow.test.ts; the Tailscale
 * join and the concurrency settings are checked by hand on a real PR
 * (docs/actions-setup.md).
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openScenarioJar, type ScenarioJar } from "../fixtures/scenario-jar.js";
import type { StubScript } from "../fixtures/model-stub.js";
import type { RunDocument } from "../../src/review-host/run-history.js";
import type { ReviewHost } from "../../src/review-host/review-host.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const ENTRY_PATH = join(REPO_ROOT, "actions/entry.mts");
const TSX_PATH = join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

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

/** Empty tool turn: satisfies pi's auto-resumed interrupted generation. */
const EMPTY_TURN: StubScript[number] = { text: [""], finishReason: "stop" as const };

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
}): Promise<ScenarioJar> {
  const jar = await openScenarioJar({
    pullNumber: options.pullNumber,
    diffAnchors: ["src/handler.ts#RIGHT#5"],
    primaryScript: options.primaryScript,
    reReviewScript: options.reReviewScript,
  });
  jars.push(jar);
  return jar;
}

interface EntryResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The repository instructions file the workflow passes through
 * `NITPI_REVIEW_INSTRUCTIONS_FILE`: written into the checkout the entry
 * runs from (the child's cwd), so every child exercises the real file flow —
 * there is no text override path.
 */
function provideInstructionsFile(jar: ScenarioJar, text: string): string {
  const path = join(jar.repo.headCheckout(), ".nitpi", "review-instructions.md");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** Run the entry exactly the way the workflow's delivery step does (async:
 *  a synchronous spawn would block this process's event loop, and the stub
 *  and fake servers it must answer to run HERE). */
async function runEntry(jar: ScenarioJar, env: Record<string, string>): Promise<EntryResult> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_REPOSITORY: "example/scenario",
    GITHUB_ACTOR: "octocat",
    NITPI_INPUT_PR_NUMBER: String(jar.pullNumber),
    NITPI_INPUT_STORAGE_BASE_URL: jar.service.url,
    NITPI_SECRET_STORAGE_AUTH_KEY: "scenario-storage-token",
    NITPI_SECRET_GITHUB_TOKEN: "scenario-token",
    NITPI_SECRET_PRIMARY_API_KEY: "stub-key",
    NITPI_SECRET_RE_REVIEW_API_KEY: "stub-key",
    NITPI_INPUT_PRIMARY_BASE_URL: `${jar.stubBases.primary}/v1`,
    NITPI_INPUT_PRIMARY_MODEL_ID: "stub-scenario-primary",
    NITPI_INPUT_RE_REVIEW_BASE_URL: `${jar.stubBases.reReview}/v1`,
    NITPI_INPUT_RE_REVIEW_MODEL_ID: "stub-scenario-rereview",
    NITPI_INPUT_REVIEW_INSTRUCTIONS_REVISION: jar.baseSha,
    NITPI_REVIEW_INSTRUCTIONS_FILE: provideInstructionsFile(jar, "Be strict about unused parameters."),
    GITHUB_API_BASE_URL: jar.githubBase,
    NITPI_INPUT_PRIMARY_DEADLINE_MS: "120000",
    NITPI_INPUT_RE_REVIEW_DEADLINE_MS: "120000",
    ...env,
  };
  return await new Promise<EntryResult>((resolve) => {
    const child = spawn(process.execPath, [TSX_PATH, ENTRY_PATH], {
      cwd: jar.repo.headCheckout(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: status ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

/** Wait until a model stub has served at least `count` requests. */
async function stubServed(stub: { readonly requests: unknown[] }, count: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stub.requests.length >= count) return;
    if (Date.now() > deadline) throw new Error(`model stub never reached ${count} requests`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Poll an ALREADY-OPEN host's run documents until the predicate holds. */
async function waitForRunDoc(
  host: ReviewHost,
  runId: string,
  predicate: (run: RunDocument) => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = (await host.runHistory().allRuns({} as never)).find((r) => r.runId === runId);
    if (run && predicate(run)) return;
    if (Date.now() > deadline) {
      throw new Error(`run document never satisfied the predicate: ${JSON.stringify(run ?? null)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Wait until a fresh host's run documents satisfy the predicate. */
async function pollRuns(
  openHost: () => Promise<ReviewHost>,
  predicate: (run: RunDocument) => boolean,
): Promise<RunDocument> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const host = await openHost();
    try {
      const runs = await host.runHistory().allRuns({} as never);
      const found = runs.find(predicate);
      if (found) return found;
    } finally {
      await host.close().catch(() => undefined);
    }
    if (Date.now() > deadline) throw new Error("run documents never satisfied the predicate");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("entry point: configuration failures exit 2 before anything runs", () => {
  const base: Record<string, string> = {
    NITPI_ACTION: "issue-comment",
    NITPI_INPUT_COMMAND: "review",
    NITPI_INPUT_PR_NUMBER: "11",
    NITPI_INPUT_PRIMARY_BASE_URL: "http://127.0.0.1:1/v1",
    NITPI_INPUT_PRIMARY_MODEL_ID: "m",
    NITPI_INPUT_RE_REVIEW_BASE_URL: "http://127.0.0.1:1/v1",
    NITPI_INPUT_RE_REVIEW_MODEL_ID: "m",
    NITPI_INPUT_STORAGE_BASE_URL: "http://127.0.0.1:1",
    NITPI_SECRET_PRIMARY_API_KEY: "k",
    NITPI_SECRET_RE_REVIEW_API_KEY: "k",
    NITPI_SECRET_STORAGE_AUTH_KEY: "k",
    NITPI_SECRET_GITHUB_TOKEN: "t",
    NITPI_INPUT_REVIEW_INSTRUCTIONS_REVISION: "0011223344556677889900112233445566778899",
  };

  function runWith(jar: ScenarioJar, overrides: Record<string, string>): Promise<EntryResult> {
    // The instructions file is provided per jar (the child's cwd), so the
    // configuration failures below are the one the test targets, not the
    // missing-instructions error that resolveConfig reports first.
    return runEntry(jar, {
      ...base,
      NITPI_REVIEW_INSTRUCTIONS_FILE: provideInstructionsFile(jar, "Be strict."),
      ...overrides,
    });
  }

  it("fails when a required input is missing", { timeout: 60_000 }, async () => {
    const jar = await openJar({ pullNumber: 11, primaryScript: [], reReviewScript: [] });
    const result = await runWith(jar, { NITPI_INPUT_PRIMARY_BASE_URL: "" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("configuration error");
    expect(result.stderr).toContain("NITPI_INPUT_PRIMARY_BASE_URL");
    // Nothing ran: no run documents, no GitHub writes.
    expect(jar.fakeGithub.publishedReviews(11)).toHaveLength(0);
  });

  it("fails on a malformed provider-options input", { timeout: 60_000 }, async () => {
    const jar = await openJar({ pullNumber: 11, primaryScript: [], reReviewScript: [] });
    const result = await runWith(jar, { NITPI_INPUT_PRIMARY_PROVIDER_OPTIONS: "{not json" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("PROVIDER_OPTIONS is not valid JSON");
  });

  it("fails on replace mode with an empty prompt", { timeout: 60_000 }, async () => {
    const jar = await openJar({ pullNumber: 11, primaryScript: [], reReviewScript: [] });
    const result = await runWith(jar, {
      NITPI_INPUT_PRIMARY_CUSTOM_PROMPT: "   ",
      NITPI_INPUT_PRIMARY_CUSTOM_PROMPT_MODE: "replace",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("replace mode requires a non-empty custom prompt");
  });

  it("fails when NITPI_ACTION names no known invocation", { timeout: 60_000 }, async () => {
    const jar = await openJar({ pullNumber: 11, primaryScript: [], reReviewScript: [] });
    const result = await runWith(jar, { NITPI_ACTION: "workflow-something" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("NITPI_ACTION must be");
  });

  it("fails when the command input is not one of the three commands", { timeout: 60_000 }, async () => {
    const jar = await openJar({ pullNumber: 11, primaryScript: [], reReviewScript: [] });
    const result = await runWith(jar, { NITPI_INPUT_COMMAND: "reformat" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("NITPI_INPUT_COMMAND must be one of");
  });

  it("fails when the pull-request action is not one of the six accepted", { timeout: 60_000 }, async () => {
    const jar = await openJar({ pullNumber: 11, primaryScript: [], reReviewScript: [] });
    const result = await runWith(jar, { NITPI_ACTION: "pull-request", NITPI_INPUT_PR_ACTION: "labeled" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("NITPI_INPUT_PR_ACTION");
  });
});

describe("entry point: delivered triggers", () => {
  it("delivers /review end to end, then dedupes a redelivered comment id", { timeout: 180_000 }, async () => {
    const jar = await openJar({
      pullNumber: 11,
      primaryScript: [
        { text: [ARTIFACT], finishReason: "stop" as const, usage: { promptTokens: 40, completionTokens: 30 } },
        EMPTY_TURN,
      ],
      reReviewScript: [{ text: [FINAL_REVIEW], finishReason: "stop" as const, usage: { promptTokens: 20, completionTokens: 15 } }],
    });

    const first = await runEntry(jar, {
      NITPI_ACTION: "issue-comment",
      NITPI_INPUT_COMMAND: "review",
      NITPI_DELIVERY_ID: "comment-1001",
    });
    expect(first.status).toBe(0);

    // The delivery published the review and the success check.
    const reviews = jar.fakeGithub.publishedReviews(11);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.commitId).toBe(jar.headSha);
    expect(jar.fakeGithub.state.checks.at(-1)).toMatchObject({ state: "success" });

    // The same delivery id again (a redelivery): deduped, nothing new.
    const served = jar.primaryStub.served + jar.reReviewStub.served;
    const again = await runEntry(jar, {
      NITPI_ACTION: "issue-comment",
      NITPI_INPUT_COMMAND: "review",
      NITPI_DELIVERY_ID: "comment-1001",
    });
    expect(again.status).toBe(0);
    expect(jar.fakeGithub.publishedReviews(11)).toHaveLength(1);
    expect(jar.primaryStub.served + jar.reReviewStub.served).toBe(served);

    // Durable history holds exactly the one run, completed.
    const run = await pollRuns(
      () => jar.openHost(),
      (candidate) => candidate.subject.headSha === jar.headSha,
    );
    expect(run.checkStatus).toBe("success");
  });

  it("resumes a killed job's attempt on re-run without repeating the primary", { timeout: 180_000 }, async () => {
    const jar = await openJar({
      pullNumber: 12,
      primaryScript: [
        { text: [ARTIFACT], finishReason: "stop" as const, usage: { promptTokens: 40, completionTokens: 30 } },
        EMPTY_TURN,
      ],
      reReviewScript: [
        // The killed attempt's re-review request hangs; the runner dies.
        { kind: "hang" },
        // The re-run's continuation: writes the final review.
        { text: [FINAL_REVIEW], finishReason: "stop" as const, usage: { promptTokens: 20, completionTokens: 15 } },
        EMPTY_TURN,
      ],
    });

    // Runner A: the run reaches the re-review stage and the re-review turn's
    // request is IN FLIGHT (the stub serves the hang step), then the job is
    // killed hard (close against the hanging turn) — mirroring the durable
    // recovery suite's kill procedure: the kill must land on a turn that has
    // actually started, or nothing was interrupted.
    const hostA = await jar.openHost();
    const started = await hostA.handleReviewCommand({
      repository: "example/scenario",
      pullNumber: 12,
      requester: "octocat",
    });
    await stubServed(jar.reReviewStub, 1);
    await waitForRunDoc(hostA, started.runId,
      (run) => run.runId === started.runId && run.artifactFrozen && run.reReviewConversationId !== undefined,
    );
    await hostA.close();

    // Runner B ("Re-run jobs"): a fresh entry invocation with the same
    // delivery identity resumes the attempt. The primary stage never runs
    // again (its artifact is frozen), the re-review continues, publication
    // happens, and the job exits 0.
    const rerun = await runEntry(jar, {
      NITPI_ACTION: "issue-comment",
      NITPI_INPUT_COMMAND: "review",
      NITPI_DELIVERY_ID: "comment-2001",
    });
    expect(rerun.stderr).not.toContain("reviewer run failed");
    expect(rerun.status).toBe(0);

    expect(jar.primaryStub.served).toBe(1); // only the artifact turn, never repeated
    expect(jar.fakeGithub.publishedReviews(12)).toHaveLength(1);
    expect(jar.fakeGithub.state.checks.at(-1)).toMatchObject({ state: "success" });
  });

  it("delivers an automatic synchronize event and the check_run re-kick serves a queued request", { timeout: 180_000 }, async () => {
    const jar = await openJar({
      pullNumber: 13,
      primaryScript: [{ text: [ARTIFACT], finishReason: "stop" as const, usage: { promptTokens: 40, completionTokens: 30 } }, EMPTY_TURN],
      reReviewScript: [{ text: [FINAL_REVIEW], finishReason: "stop" as const, usage: { promptTokens: 20, completionTokens: 15 } }, EMPTY_TURN],
    });

    // Automatic mode waits for a named check: the synchronize delivery
    // queues a pending request (nothing runs yet).
    const queued = await runEntry(jar, {
      NITPI_ACTION: "pull-request",
      NITPI_INPUT_PR_ACTION: "synchronize",
      NITPI_DELIVERY_ID: "pr-13-synchronize-x",
      NITPI_INPUT_MODE: "automatic",
      NITPI_INPUT_EVENT_SYNCHRONIZE: "true",
      NITPI_INPUT_WAIT_FOR_CHECKS: "lint",
    });
    expect(queued.status).toBe(0);
    expect(jar.fakeGithub.publishedReviews(13)).toHaveLength(0);

    // The named check completes on the head; the check_run re-kick delivery
    // re-invokes the entry — with the SAME configuration the original
    // delivery ran with (the workflow's env block applies to every step),
    // because the drain re-evaluates the pending request against the live
    // automatic-mode configuration before starting it.
    jar.fakeGithub.state.externalChecks.set(`${jar.headSha}|lint`, "completed:success");
    const kicked = await runEntry(jar, {
      NITPI_ACTION: "check-run-rekick",
      NITPI_DELIVERY_ID: "kick-1",
      NITPI_INPUT_MODE: "automatic",
      NITPI_INPUT_EVENT_SYNCHRONIZE: "true",
      NITPI_INPUT_WAIT_FOR_CHECKS: "lint",
    });
    expect(kicked.status).toBe(0);

    const run = await pollRuns(
      () => jar.openHost(),
      (candidate) => candidate.subject.headSha === jar.headSha && candidate.checkStatus === "success",
    );
    expect(run.source).toBe("automatic");
    expect(jar.fakeGithub.publishedReviews(13)).toHaveLength(1);
  });

  it("a second opener skips without racing the active owner", { timeout: 120_000 }, async () => {
    const jar = await openJar({ pullNumber: 14, primaryScript: [], reReviewScript: [] });
    // An active owner holds the partition's lease...
    const owner = await jar.openHost();
    try {
      // ...and the re-kick invocation skips instead of racing it.
      const skipped = await runEntry(jar, {
        NITPI_ACTION: "check-run-rekick",
        NITPI_DELIVERY_ID: "kick-race",
      });
      expect(skipped.status).toBe(0);
      expect(skipped.stderr + skipped.stdout).toContain("another review process owns");
    } finally {
      await owner.close();
    }
  });
});
