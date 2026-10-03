/**
 * Storage-service CLI (ticket 11's homeserver step): runs one storage
 * service process on the homeserver. Configuration via environment:
 * - `NITPI_STORAGE_DATA_DIR`   directory for the per-partition SQLite files (required)
 * - `NITPI_STORAGE_AUTH_TOKEN` shared bearer secret (required)
 * - `NITPI_STORAGE_PORT`       listen port (default: ephemeral)
 * - `NITPI_STORAGE_HOST`       bind address (default 127.0.0.1; set the
 *                              tailnet IP or 0.0.0.0 when the service is
 *                              reached over Tailscale and the tailnet ACL
 *                              is the access boundary)
 * - `NITPI_STORAGE_LEASE_TTL_MS` partition-lease lifetime (default 45000)
 *
 * The service never exits on its own; stop it with a signal (SIGINT/SIGTERM).
 * `docs/actions-setup.md` documents the deployment.
 */
import process from "node:process";
import { startReviewStorageService } from "./service.js";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

async function main(): Promise<void> {
  const dataDir = env("NITPI_STORAGE_DATA_DIR");
  const authToken = env("NITPI_STORAGE_AUTH_TOKEN");
  if (!dataDir || !authToken) {
    console.error(
      "usage: NITPI_STORAGE_DATA_DIR=<dir> NITPI_STORAGE_AUTH_TOKEN=<secret> npx tsx src/storage/service-main.ts",
    );
    process.exitCode = 2;
    return;
  }
  const port = env("NITPI_STORAGE_PORT");
  const host = env("NITPI_STORAGE_HOST");
  const leaseTtlMs = env("NITPI_STORAGE_LEASE_TTL_MS");
  const service = await startReviewStorageService({
    dataDir,
    authToken,
    ...(port !== undefined ? { port: Number(port) } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(leaseTtlMs !== undefined ? { leaseTtlMs: Number(leaseTtlMs) } : {}),
  });
  console.log(`nitpi storage service listening at ${service.url} (data dir: ${dataDir})`);
}

void main();
