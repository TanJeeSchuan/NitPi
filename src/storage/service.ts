/**
 * Storage service (spec ticket 06): Pi Durable's state on homelab storage.
 *
 * An authenticated small HTTP service keeps each PR's state in one SQLite
 * file, partitioned by repository and PR. The service side runs Pi Durable's
 * actual `SqliteStorage` implementation, so the Steps-side adapter only has
 * to relay Pi's `Storage` contract over HTTP.
 *
 * Protocol guarantees:
 * - Authentication: every route except /v1/health and /view carries
 *   `Authorization: Bearer <token>`.
 * - Partitioning: one SQLite file per (repository, pull number).
 * - Durable commits: the partition runs SQLite in WAL with
 *   `synchronous = FULL`, so a returned commit sequence only happens after
 *   the transaction committed durably.
 * - Ack-lost retries: each commit carries an identity (payload hash). The
 *   client flags a re-sent batch it could not observe (lost ack), and the
 *   service's ledger returns the previously recorded sequence without
 *   reapplying — a batch re-sent under a new identity (fresh ids from Pi's
 *   recovery machinery) applies as the new attempt it is.
 * - Single owner: `/v1/open` takes a lease on the partition; a second
 *   opener is refused with `StorageInUseError` while the lease is live.
 *   Heartbeats renew the lease; expiry frees the partition for a re-run.
 * - Viewing: `/view` serves a static page (no data; unauthenticated) that
 *   reads `/v1/view/runs` with the bearer token. That route reads SQLite
 *   directly without a lease, so it works during an active review.
 */

import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  type ConversationQuery,
  type Cursor,
  type DocumentAddress,
  type DocumentPoint,
  type DocumentQuery,
  type EntryId,
  type EntryQuery,
  type Seq,
  type Storage,
  type StorageWrite,
  type SubmissionId,
  type SubmissionQuery,
  type TaskId,
  type TaskQuery,
} from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import type { StoragePartitionId } from "./wire.js";
import { readRuns } from "./viewer/runs.js";

const viewPage = readFileSync(new URL("./viewer/view.html", import.meta.url));

export interface ReviewStorageServiceOptions {
  /** Directory that holds the per-partition SQLite files. */
  readonly dataDir: string;
  /** Shared secret; every request must carry it as a bearer token. */
  readonly authToken: string;
  /** HTTP port; defaults to an ephemeral one. */
  readonly port?: number;
  /** Bind address; defaults to the loopback interface. A homeserver
   *  deployment reached over Tailscale binds its tailnet IP (or the
   *  wildcard interface, with the tailnet ACL as the access boundary). */
  readonly host?: string;
  /** Lease lifetime in milliseconds. Default 45s. */
  readonly leaseTtlMs?: number;
}

interface Lease {
  readonly id: string;
  expiresAtMs: number;
}

interface Partition {
  readonly key: string;
  readonly file: string;
  storage?: Storage;
  database?: SqliteDatabase;
  lease?: Lease;
  /** Identity → acknowledged commit sequence, for declared-batch retries. */
  readonly commitLedger: Map<string, number>;
  /** All dispatched work serializes through this queue, per partition. */
  queue: Promise<void>;
}

export interface ReviewStorageService {
  readonly url: string;
  readonly authToken: string;
  readonly port: number;
  stop(): Promise<void>;
  /** Test seam: destroy the response of the next matching commit after it durably applied. */
  faultDropCommitResponse(pathIncludes: string): void;
  /** Test seam: the current live lease for a partition, if any. */
  liveLease(id: StoragePartitionId): Lease | undefined;
}

class ServiceRouteError extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceRouteError";
  }
}

export async function startReviewStorageService(
  options: ReviewStorageServiceOptions,
): Promise<ReviewStorageService> {
  const leaseTtlMs = options.leaseTtlMs ?? 45_000;
  await mkdir(options.dataDir, { recursive: true });

  const partitions = new Map<string, Partition>();
  let dropCommitPath = "";
  let dropCommitRemaining = 0;

  function partitionKey(id: StoragePartitionId): string {
    return `${id.repository.toLowerCase()}/pr-${id.pullNumber}`;
  }

  function safeDir(repository: string): string {
    return repository.toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  }

  function partition(key: string, id: StoragePartitionId): Partition {
    const existing = partitions.get(key);
    if (existing) return existing;
    const record: Partition = {
      key,
      file: join(options.dataDir, safeDir(id.repository), `pr-${id.pullNumber}.sqlite`),
      commitLedger: new Map(),
      queue: Promise.resolve(),
    };
    partitions.set(key, record);
    return record;
  }

  /** Open (or reuse) the partition's Pi storage. */
  async function openPartition(record: Partition): Promise<Storage> {
    if (record.storage) return record.storage;
    await mkdir(dirname(record.file), { recursive: true });
    const database = await openNodeSqliteDatabase(record.file);
    // Durability before acknowledgement: FULL fsyncs the WAL on every commit.
    await database.exec("PRAGMA synchronous = FULL");
    record.database = database;
    record.storage = await SqliteStorage.open(database);
    return record.storage;
  }

  function queued<T>(record: Partition, job: () => Promise<T>): Promise<T> {
    const run = record.queue.then(job, job);
    record.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Returns `null` instead of `undefined` so a missing row survives JSON. */
  const absent = null as unknown;

  async function dispatchStorage(storage: Storage, method: string, kind: string | undefined, args: Record<string, unknown>): Promise<unknown> {
    const context = TODO_CONTEXT;
    const toNumber = (value: unknown) => Number(value);
    switch (method) {
      case "mintId":
        return { id: toNumber(await storage.mintId()) };
      case "conversation":
        return { record: (await storage.conversation(toNumber(args.id) as ConversationId, context)) ?? absent };
      case "scanConversations":
        return {
          page: await storage.scanConversations(
            (args.query ?? {}) as ConversationQuery,
            toNumber(args.limit),
            (args.cursor ?? undefined) as Cursor,
            context,
          ),
        };
      case "entry": {
        if (kind === "by-id") {
          return { result: (await storage.entry(toNumber(args.id) as EntryId, context)) ?? absent };
        }
        const found = await storage.entry(
          toNumber(args.conversationId) as ConversationId,
          toNumber(args.id) as EntryId,
          context,
        );
        return { result: found ?? absent };
      }
      case "findLatestHeadMarker":
        return {
          result:
            (await storage.findLatestHeadMarker(
              toNumber(args.conversationId) as ConversationId,
              (args.atOrBeforeEntryId == null ? undefined : toNumber(args.atOrBeforeEntryId)) as EntryId | undefined,
              context,
            )) ?? absent,
        };
      case "scanEntries":
        return {
          page: await storage.scanEntries(
            args.query as EntryQuery,
            toNumber(args.limit),
            (args.cursor ?? undefined) as Cursor,
            context,
          ),
        };
      case "task":
        return { record: (await storage.task(toNumber(args.id) as TaskId, context)) ?? absent };
      case "scanTasks":
        return {
          page: await storage.scanTasks(
            (args.query ?? {}) as TaskQuery,
            toNumber(args.limit),
            (args.cursor ?? undefined) as Cursor,
            context,
          ),
        };
      case "submission":
        return {
          record: (await storage.submission(toNumber(args.id) as unknown as SubmissionId, context)) ?? absent,
        };
      case "scanSubmissions":
        return {
          page: await storage.scanSubmissions(
            (args.query ?? {}) as SubmissionQuery,
            toNumber(args.limit),
            (args.cursor ?? undefined) as Cursor,
            context,
          ),
        };
      case "submissionByRequest":
        return {
          record:
            (await storage.submissionByRequest(
              toNumber(args.conversationId) as ConversationId,
              String(args.requestId),
              context,
            )) ?? absent,
        };
      case "findDocument":
        return {
          record:
            (await storage.findDocument(args.address as DocumentAddress, args.at as DocumentPoint, context)) ??
            absent,
        };
      case "document":
        return {
          stored: (await storage.document(toNumber(args.id) as never, args.at as DocumentPoint, context)) ?? absent,
        };
      case "scanDocuments":
        return {
          page: await storage.scanDocuments(
            args.query as DocumentQuery,
            toNumber(args.limit),
            (args.cursor ?? undefined) as Cursor,
            context,
          ),
        };
      default:
        throw new ServiceRouteError(404, "NotFound", `unknown storage method ${method}`);
    }
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: { name: "StorageFailure", message: "internal failure" } }));
      }
      response.destroy();
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  const url = `http://${options.host && options.host !== "0.0.0.0" ? options.host : "127.0.0.1"}:${port}`;

  function respond(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  }

  function readBody(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) return resolve(undefined);
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
      request.on("error", reject);
    });
  }

  async function leaseFor(body: {
    repository: string;
    pullNumber: number;
    leaseId: string;
  }): Promise<Partition | undefined> {
    const record = partitions.get(partitionKey(body));
    const lease = record?.lease;
    if (!record || !lease || lease.id !== body.leaseId) return undefined;
    if (lease.expiresAtMs <= Date.now()) {
      record.lease = undefined;
      return undefined;
    }
    return record;
  }

  function requireKeyOf(value: unknown): {
    repository: string;
    pullNumber: number;
    leaseId: string;
  } {
    const body = (value ?? {}) as { repository?: unknown; pullNumber?: unknown; leaseId?: unknown };
    if (typeof body.repository !== "string" || !Number.isFinite(Number(body.pullNumber)) || typeof body.leaseId !== "string") {
      throw new ServiceRouteError(400, "BadRequest", "repository, pullNumber and leaseId are required");
    }
    return {
      repository: body.repository,
      pullNumber: Number(body.pullNumber),
      leaseId: body.leaseId,
    };
  }

  /** A commit whose HTTP response is annihilated after it durably applied. */
  class ResponseDrop extends Error {
    constructor() {
      super("response dropped after durable commit (fault injection)");
      this.name = "ResponseDrop";
    }
  }

  async function runStorageMethod(
    record: Partition,
    method: string,
    kind: string | undefined,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const storage = await openPartition(record);
    const dropResponse = method === "commit" && dropCommitRemaining > 0;
    if (dropResponse) dropCommitRemaining -= 1;
    try {
      return await queued(record, async () => {
        if (method === "commit") {
          const identity = String(args.identity);
          const writes = args.writes as readonly StorageWrite[];
          // Only a declared retry (a re-sent batch the caller could not
          // observe) returns the recorded result without reapplying;
          // identical content from a fresh attempt still re-validates.
          if (args.retry === true) {
            const ledged = record.commitLedger.get(identity);
            if (ledged !== undefined) return { seq: ledged, deduped: true };
          }
          const seq = await storage.commit(writes, TODO_CONTEXT);
          record.commitLedger.set(identity, Number(seq));
          return { seq: Number(seq), deduped: false };
        }
        return dispatchStorage(storage, method, kind, args);
      });
    } finally {
      if (dropResponse) throw new ResponseDrop();
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathUrl = new URL(request.url ?? "/", url);
    const path = pathUrl.pathname;

    if (path === "/v1/health") {
      return respond(response, 200, { ok: true });
    }

    if (path === "/view") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      });
      return void response.end(viewPage);
    }

    const auth = request.headers.authorization ?? "";
    if (auth !== `Bearer ${options.authToken}`) {
      return respond(response, 401, {
        error: { name: "Unauthenticated", message: "storage token rejected" },
      });
    }

    try {
      if (path === "/v1/view/runs" && request.method === "GET") {
        return respond(response, 200, readRuns(options.dataDir, pathUrl.searchParams.get("run") ?? undefined));
      }
      if (path === "/v1/open" && request.method === "POST") {
        const body = (await readBody(request)) as { repository?: string; pullNumber?: number } | undefined;
        const repository = String(body?.repository ?? "");
        const pullNumber = Number(body?.pullNumber ?? NaN);
        if (!repository || !Number.isInteger(pullNumber) || pullNumber <= 0) {
          throw new ServiceRouteError(400, "BadRequest", "repository and pullNumber are required");
        }
        const id: StoragePartitionId = { repository, pullNumber };
        const key = partitionKey(id);
        const record = partition(key, id);
        if (record.lease && record.lease.expiresAtMs > Date.now()) {
          return respond(response, 409, {
            error: {
              name: "StorageInUseError",
              message: `storage for ${key} is already owned by another process`,
            },
          });
        }
        const lease: Lease = { id: randomUUID(), expiresAtMs: Date.now() + leaseTtlMs };
        record.lease = lease;
        return respond(response, 200, { leaseId: lease.id, ttlMs: leaseTtlMs });
      }

      if (path === "/v1/heartbeat" && request.method === "POST") {
        const key = requireKeyOf(await readBody(request));
        const record = await leaseFor(key);
        if (!record || !record.lease) {
          return respond(response, 410, {
            error: { name: "LeaseLostError", message: "storage lease expired or unknown" },
          });
        }
        record.lease.expiresAtMs = Date.now() + leaseTtlMs;
        return respond(response, 200, { ttlMs: leaseTtlMs });
      }

      if (path === "/v1/close" && request.method === "POST") {
        const key = requireKeyOf(await readBody(request));
        const record = partitions.get(partitionKey(key));
        if (record?.lease?.id === key.leaseId) record.lease = undefined;
        return respond(response, 204, { ok: true });
      }

      const methodMatch = /^\/v1\/storage\/([a-zA-Z]+)(?:\/([a-z-]+))?$/.exec(path);
      if (methodMatch && request.method === "POST") {
        // Read the body exactly once; it carries both the lease key and the args.
        const raw = (await readBody(request)) as
          | { repository?: string; pullNumber?: unknown; leaseId?: string; args?: Record<string, unknown> }
          | undefined;
        const key = requireKeyOf(raw);
        const record = await leaseFor(key);
        if (!record) {
          throw new ServiceRouteError(410, "LeaseLostError", "storage lease expired or unknown");
        }
        let result: unknown;
        try {
          result = await runStorageMethod(record, methodMatch[1]!, methodMatch[2], raw?.args ?? {});
        } catch (error) {
          if (error instanceof Error && error.name !== "Error") {
            const name = error.name;
            if (name === "StorageRejected" || name === "ReadAfterWrite" || name === "ConversationBusy") {
              return respond(response, 422, { error: { name, message: error.message } });
            }
          }
          throw error;
        }
        return respond(response, 200, result);
      }

      return respond(response, 404, { error: { name: "NotFound", message: `no route for ${path}` } });
    } catch (error) {
      if (error instanceof ServiceRouteError) {
        return respond(response, error.status, {
          error: { name: error.errorName, message: error.message },
        });
      }
      if (error instanceof ResponseDrop) {
        // The commit is durably applied; the caller must not receive its ack.
        response.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      return respond(response, 500, {
        error: {
          name: error instanceof Error && error.name !== "Error" ? error.name : "StorageFailure",
          message,
        },
      });
    }
  }

  // (the in-memory ledger's lifetime matches the alive retry window: a re-sent
  // batch only reaches the service while the same client process is running)

  return {
    url,
    authToken: options.authToken,
    port,
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const closes: Array<Promise<void>> = [];
      for (const record of partitions.values()) {
        closes.push(
          queued(record, async () => {
            const storage = record.storage;
            record.storage = undefined;
            if (storage) {
              await storage.close(TODO_CONTEXT).catch(() => undefined);
            }
          }),
        );
      }
      await Promise.all(closes);
      partitions.clear();
    },
    faultDropCommitResponse(pathIncludes: string): void {
      dropCommitPath = pathIncludes;
      dropCommitRemaining += 1;
    },
    liveLease(id) {
      return partitions.get(partitionKey(id))?.lease;
    },
  };
}

// (page types come from `@earendil-works/pi-durable` inside the dispatch switch)
