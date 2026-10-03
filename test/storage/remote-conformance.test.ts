/**
 * Pi Durable's official storage conformance suite, run against the Actions
 * storage adapter over the real HTTP storage service (localhost).
 *
 * This is the contract check for "a storage adapter implements Pi Durable's
 * storage contract (reads plus atomic commit batches)": the suite covers
 * atomic mixed-table commits and rollbacks, cursor pages, fork-aware entry
 * scans, task/submission lifecycle states, document incarnations and
 * revisions, ID namespaces, and post-close rejection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { startReviewStorageService, type ReviewStorageService } from "../../src/storage/service.js";
import { openRemoteStorage } from "../../src/storage/remote-storage.js";

const TOKEN = "conformance-token";
let dataDir: string;
let service: ReviewStorageService;
let partition = 90_000;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "nitpi-storage-"));
  service = await startReviewStorageService({ dataDir, authToken: TOKEN });
});

afterAll(async () => {
  await service.stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows may hold a SQLite file briefly after close; OS temp cleanup
    // handles the rest, and teardown must not fail the suite.
  }
});

registerStorageConformance({ describe, expect, it }, "RemoteStorage over HTTP", async (use) => {
  partition += 1;
  const storage = await openRemoteStorage({
    baseUrl: service.url,
    authToken: TOKEN,
    repository: "conformance/adapter",
    pullNumber: partition,
  });
  try {
    await use(storage);
  } finally {
    await storage.close();
  }
});
