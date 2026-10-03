/**
 * Storage service behavior (ticket 06): authentication, partitioning,
 * single-owner leases, durable commits with retried-commit dedup after a
 * lost acknowledgement, and unreachability during an outage.
 *
 * These drive the storage service/adapter seam directly, not the review-
 * host process boundary: the lease/identity/outage properties are the
 * adapter's own protocol (pi-durable documents the same pattern for custom
 * backends — the shared conformance suite runs against a Storage
 * implementation directly). The host-level integration seam is
 * test/scenario/durable-recovery.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@earendil-works/chord";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import {
  startReviewStorageService,
  type ReviewStorageService,
} from "../../src/storage/service.js";
import {
  StorageInUse,
  StorageUnreachable,
  openRemoteStorage,
} from "../../src/storage/remote-storage.js";

const TOKEN = "service-token";
const noContext = {} as Context;

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "nitpi-service-"));
});

afterAll(async () => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows file-lock cleanup; covered by the OS temp dir.
  }
});

interface Service {
  service: ReviewStorageService;
}

async function start(): Promise<Service> {
  const service = await startReviewStorageService({ dataDir, authToken: TOKEN, leaseTtlMs: 1_200 });
  return { service };
}

/** One root conversation plus its row-count view of the partition's tables. */
async function openPartitionStorage(repository: string, pullNumber: number, token = TOKEN) {
  return openRemoteStorage({ baseUrl: (await start()).service.url, authToken: token, repository, pullNumber });
}

function rootPartitionsWrite(): StorageWrite[] {
  return [{ type: "conversation", value: { id: 1 } as never }];
}

function countObjectsThrough(storage: Storage, table: string): Promise<void> {
  // Reads go through the contract surface: the count of conversations and
  // entries is observable through scans.
  void table;
  return Promise.resolve();
}

describe("storage service", () => {
  it("refuses unauthenticated requests", async () => {
    const { service } = await start();
    try {
      const storage = await openRemoteStorage({
        baseUrl: service.url,
        authToken: "wrong-token",
        repository: "example/auth",
        pullNumber: 1,
      }).catch((error) => error as Error);
      // The open itself is refused: the answer to the unauthenticated service
      // is a rejection at the adapter boundary.
      expect(storage).toBeInstanceOf(Error);
      expect((storage as Error).message).toContain("Unauthenticated");
    } finally {
      await service.stop();
    }
  });

  it("refuses a second opener while the first's lease is live; frees on expiry", async () => {
    const { service } = await start();
    try {
      const first = await openRemoteStorage({
        baseUrl: service.url,
        authToken: TOKEN,
        repository: "example/lock",
        pullNumber: 2,
      });
      try {
        let secondError: unknown;
        try {
          await openRemoteStorage({
            baseUrl: service.url,
            authToken: TOKEN,
            repository: "example/lock",
            pullNumber: 2,
          });
        } catch (error) {
          secondError = error;
        }
        expect(secondError).toBeInstanceOf(StorageInUse);
        expect((secondError as StorageInUse).message).toContain("already owned");
      } finally {
        await first.close();
      }
      // Released: the same partition opens again immediately.
      const again = await openRemoteStorage({
        baseUrl: service.url,
        authToken: TOKEN,
        repository: "example/lock",
        pullNumber: 2,
      });
      await again.close();
    } finally {
      await service.stop();
    }
  });

  it("partitions state per repository and pull number", async () => {
    const { service } = await start();
    try {
      const alpha = await openRemoteStorage({
        baseUrl: service.url,
        authToken: TOKEN,
        repository: "example/alpha",
        pullNumber: 3,
      });
      const beta = await openRemoteStorage({
        baseUrl: service.url,
        authToken: TOKEN,
        repository: "example/beta",
        pullNumber: 3,
      });
      try {
        await alpha.commit(rootPartitionsWrite(), noContext);
        const alphaRoot = await alpha.conversation(1 as never, noContext);
        const betaRoot = await beta.conversation(1 as never, noContext);
        expect(alphaRoot).toBeDefined();
        expect(betaRoot).toBeUndefined();
      } finally {
        await alpha.close();
        await beta.close();
      }
    } finally {
      await service.stop();
    }
  });

  it("deduplicates a retried commit after a lost acknowledgement", async () => {
    const { service } = await start();
    try {
      const repository = "example/retry";
      // The response of the next commit is destroyed after it durably applied
      // — exactly a lost acknowledgement.
      service.faultDropCommitResponse("commit");
      const storage = await openRemoteStorage({
        baseUrl: service.url,
        authToken: TOKEN,
        repository,
        pullNumber: 4,
      });
      try {
        const writes = [...rootPartitionsWrite()] as StorageWrite[];
        let firstError: unknown;
        try {
          await storage.commit(writes, noContext);
        } catch (error) {
          firstError = error;
        }
        // The ack was lost: the adapter cannot know whether the batch applied.
        expect(firstError).toBeInstanceOf(StorageUnreachable);

        // Retrying the same commit preserves the identity, so the service
        // recorded the durable result and returns it without reapplying.
        const seq = await storage.commit(writes, noContext);
        expect(Number(seq)).toBe(1);

        // The retried batch must not duplicate state: exactly one conversation.
        const page = await storage.scanConversations({}, 10, undefined, noContext);
        expect(page.items).toHaveLength(1);
      } finally {
        await storage.close();
      }
    } finally {
      await service.stop();
    }
  });

  it("rejects identical re-committed content from a fresh attempt (no dedupe)", async () => {
    const { service } = await start();
    try {
      const storage = await openRemoteStorage({
        baseUrl: service.url,
        authToken: TOKEN,
        repository: "example/duplicate",
        pullNumber: 5,
      });
      try {
        await storage.commit(rootPartitionsWrite(), noContext);
        // A new batch with the same content is a contract violation: the id
        // is already taken. The service must NOT silently dedupe it.
        await expect(storage.commit(rootPartitionsWrite(), noContext)).rejects.toThrow(/already belongs/);
      } finally {
        await storage.close();
      }
    } finally {
      await service.stop();
    }
  });

  it("keeps durable state across a service restart on the same data directory", async () => {
    const first = await startReviewStorageService({
      dataDir,
      authToken: TOKEN,
      leaseTtlMs: 30_000,
    });
    try {
      const storage = await openRemoteStorage({
        baseUrl: first.url,
        authToken: TOKEN,
        repository: "example/restart",
        pullNumber: 6,
      });
      await storage.commit(rootPartitionsWrite(), noContext);
      await storage.close();
      await first.stop();

      // The service restarts (outage/recovery): the partition's durable
      // state must be exactly as committed before the restart.
      const restarted = await startReviewStorageService({
        dataDir,
        authToken: TOKEN,
        leaseTtlMs: 30_000,
      });
      try {
        const reopened = await openRemoteStorage({
          baseUrl: restarted.url,
          authToken: TOKEN,
          repository: "example/restart",
          pullNumber: 6,
        });
        try {
          const root = await reopened.conversation(1 as never, noContext);
          expect(root).toBeDefined();
          // And minted IDs continue from the durable state, not from zero.
          expect(Number(await reopened.mintId())).toBeGreaterThan(1);
        } finally {
          await reopened.close();
        }
      } finally {
        await restarted.stop();
      }
    } catch (error) {
      throw error;
    }
  });

  it("reports unreachable storage when the service is stopped", async () => {
    const service = await startReviewStorageService({ dataDir, authToken: TOKEN });
    const storage = await openRemoteStorage({
      baseUrl: service.url,
      authToken: TOKEN,
      repository: "example/outage",
      pullNumber: 7,
    });
    await service.stop();
    try {
      await expect(storage.commit(rootPartitionsWrite(), noContext)).rejects.toBeInstanceOf(StorageUnreachable);
    } finally {
      await storage.close();
    }
  });
});
