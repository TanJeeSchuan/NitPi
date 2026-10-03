/**
 * Open a review host against a real storage service (ticket 06) rooted at a
 * test directory. Reopening the same directory after `close()` reaches the
 * same durable state, which is how restart scenarios simulate an Actions
 * re-run. The service stops when the host closes.
 */
import { openReviewHost, type ReviewHost } from "../../src/review-host/review-host.js";
import type { ReviewHostConfig } from "../../src/review-host/config.js";
import { startReviewStorageService } from "../../src/storage/service.js";

type StorageFreeConfig = Omit<ReviewHostConfig, "storage" | "primaryDeadlineMs" | "reReviewDeadlineMs"> &
  Partial<Pick<ReviewHostConfig, "primaryDeadlineMs" | "reReviewDeadlineMs">>;

const AUTH_TOKEN = "test-storage-token";

export async function openHostOnStorage(config: StorageFreeConfig, dataDir: string): Promise<ReviewHost> {
  const service = await startReviewStorageService({ dataDir, authToken: AUTH_TOKEN, leaseTtlMs: 1_500 });
  let host: ReviewHost;
  try {
    host = await openReviewHost({
      primaryDeadlineMs: 120_000,
      reReviewDeadlineMs: 120_000,
      ...config,
      storage: { baseUrl: service.url, authToken: AUTH_TOKEN },
    });
  } catch (error) {
    await service.stop();
    throw error;
  }
  const close = host.close.bind(host);
  host.close = async () => {
    try {
      await close();
    } finally {
      await service.stop();
    }
  };
  return host;
}
