/**
 * Scenario fixture (ticket 06): one isolation jar per scenario.
 *
 * A jar owns a temporary git repository for the reviewed head, a FakeGitHub,
 * two scripted model endpoints, and a real storage service on localhost with
 * a temporary SQLite directory — per the ticket, the scenario suite runs
 * against the real storage service instead of direct local SQLite, and
 * stopping the service simulates an outage.
 *
 * Host configs point at the jar's endpoints. A crash scenario opens host A,
 * kills its runner, then opens host B on the same jar: the same GitHub fake,
 * model endpoints, and storage partition — exactly what an Actions re-run
 * faces.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startReviewStorageService, type ReviewStorageService } from "../../src/storage/service.js";
import type { ReviewHostConfig } from "../../src/review-host/config.js";
import type { ReviewHost } from "../../src/review-host/review-host.js";
import { openReviewHost } from "../../src/review-host/review-host.js";
import { FakeGitHub, type FakePullRequest } from "./fake-github.js";
import { ModelStub, type StubScript } from "./model-stub.js";
import { createGitRepoFixture, unifiedDiff, type GitRepoFixture } from "./git-fixture.js";

export interface ScenarioJarOptions {
  /** Pull number the fake GitHub serves and the host config targets. */
  pullNumber: number;
  /** Diff anchors (path#SIDE#line) valid for the reviewed commit. */
  diffAnchors?: string[];
  primaryScript: StubScript;
  reReviewScript: StubScript;
  /** Reviewer stage deadlines in ms; defaults are generous. */
  deadlines?: { primaryMs?: number; reReviewMs?: number };
  /** Test seam (ticket 05): publication rate-limit pacing recorder. */
  publicationSleep?: (ms: number) => Promise<void>;
}

export interface ScenarioJar {
  /** The pull number the fake GitHub serves and the host config targets. */
  readonly pullNumber: number;
  readonly repo: GitRepoFixture;
  readonly fakeGithub: FakeGitHub;
  readonly githubBase: string;
  readonly primaryStub: ModelStub;
  readonly reReviewStub: ModelStub;
  /** The model stubs' base URLs (the entry tests wire them as env inputs). */
  readonly stubBases: { readonly primary: string; readonly reReview: string };
  /** The storage service; the URL is current after stop/start cycles. */
  readonly service: ReviewStorageService;
  readonly dataDir: string;
  readonly headSha: string;
  readonly baseSha: string;
  /** A host config targeting the jar's first pull number (call after restarts). */
  hostConfig(): ReviewHostConfig;
  /** Open a runner (one Actions job) against this jar. */
  openHost(): Promise<ReviewHost>;
  /** Simulate a storage outage: the service stops; the SQLite files remain. */
  stopStorage(): Promise<void>;
  /** Storage returns after an outage; a re-run can then reopen the attempt. */
  startStorage(): Promise<void>;
  dispose(): Promise<void>;
}

export async function openScenarioJar(options: ScenarioJarOptions): Promise<ScenarioJar> {
  const dataDir = mkdtempSync(join(tmpdir(), "nitpi-scenario-"));
  const repo = createGitRepoFixture();
  const pulls: FakePullRequest[] = [
    { number: options.pullNumber, headSha: repo.headSha, baseSha: repo.baseSha, state: "open" },
  ];
  // The pinned diff (ticket 02): the anchor validator checks the final
  // review against the diff GitHub serves for the pull request.
  const fakeGithub = new FakeGitHub(pulls, options.diffAnchors ?? [], { diffText: unifiedDiff() });
  const githubBase = await fakeGithub.listen();
  const primaryStub = new ModelStub(options.primaryScript, "stub-scenario-primary");
  const reReviewStub = new ModelStub(options.reReviewScript, "stub-scenario-rereview");
  const [primaryBase, reReviewBase] = await Promise.all([primaryStub.listen(), reReviewStub.listen()]);

  const state = {
    service: await startReviewStorageService({
      dataDir,
      authToken: "scenario-storage-token",
      leaseTtlMs: 1_500,
    }),
  };

  const pullNumber = options.pullNumber;

  function hostConfig(): ReviewHostConfig {
    return {
      repository: "example/scenario",
      pullNumber,
      githubToken: "scenario-token",
      githubBaseUrl: githubBase,
      storage: { baseUrl: state.service.url, authToken: "scenario-storage-token" },
      primaryDeadlineMs: options.deadlines?.primaryMs ?? 120_000,
      reReviewDeadlineMs: options.deadlines?.reReviewMs ?? 120_000,
      ...(options.publicationSleep ? { publicationSleep: options.publicationSleep } : {}),
      primary: {
        baseUrl: `${primaryBase}/v1`,
        modelId: "stub-scenario-primary",
        apiKey: "stub-key",
      },
      reReview: {
        baseUrl: `${reReviewBase}/v1`,
        modelId: "stub-scenario-rereview",
        apiKey: "stub-key",
      },
      repositoryInstructions: "Be strict about unused parameters.",
      repositoryInstructionsRevision: repo.baseSha,
      headCheckoutSource: repo.headCheckout(),
    };
  }

  return {
    get service(): ReviewStorageService {
      return state.service;
    },
    pullNumber,
    repo,
    fakeGithub,
    githubBase,
    primaryStub,
    reReviewStub,
    stubBases: { primary: primaryBase, reReview: reReviewBase },
    dataDir,
    headSha: repo.headSha,
    baseSha: repo.baseSha,
    hostConfig,
    openHost: () => openReviewHost(hostConfig()),
    stopStorage: async () => {
      await state.service.stop();
    },
    startStorage: async () => {
      // The same data directory: the durable files survive the outage.
      state.service = await startReviewStorageService({
        dataDir,
        authToken: "scenario-storage-token",
        leaseTtlMs: 1_500,
      });
    },
    dispose: async () => {
      await fakeGithub.close();
      await primaryStub.close();
      await reReviewStub.close();
      await state.service.stop();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows can hold the SQLite file briefly after close; the OS temp
        // dir cleans up, and teardown must not fail the suite.
      }
    },
  };
}
