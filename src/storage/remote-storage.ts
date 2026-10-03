/**
 * Actions-side storage adapter (spec ticket 06): one partition of the storage
 * service, seen through Pi Durable's `Storage` contract.
 *
 * The adapter implements reads plus atomic commit batches over HTTP: every
 * `commit()` sends the whole write batch to the service, which applies it in
 * one SQLite transaction and answers only after a durable commit. A commit
 * retried with the same identity cannot duplicate state: the identity (the
 * batch's payload hash) is recorded server-side on first application and the
 * replay returns the recorded sequence without reapplying.
 *
 * The partition is opened through the service's lease: only one process owns
 * a PR's storage at a time, and a second opener is refused
 * (`StorageInUse`). A background heartbeat renews the lease; `close()`
 * releases it.
 */

import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  ConversationBusy,
  ReadAfterWrite,
  StorageRejected,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type Page,
  type Seq,
  type Storage,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from "@earendil-works/pi-durable";

export interface RemoteStorageOptions {
  /** Storage service base URL, e.g. `http://127.0.0.1:51733`. */
  readonly baseUrl: string;
  /** Storage bearer token (a GitHub secret in Actions). */
  readonly authToken: string;
  /** The PR this partition belongs to. */
  readonly repository: string;
  readonly pullNumber: number;
}

/** Storage is unreachable (service down/starting) — nothing was applied. */
export class StorageUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnreachable";
  }
}

/** Another process owns this PR's storage while the lease is live. */
export class StorageInUse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageInUse";
  }
}

/** The lease expired (heartbeats failed); the partition moved on. */
export class LeaseLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseLost";
  }
}

type EntryLookup =
  | { readonly entry: EntryRecord; readonly commitSeq: Seq }
  | undefined;

/** Rebuild the typed error instances the contract's callers may instanceof-check. */
function restoreReadAfterWrite(message: string): ReadAfterWrite {
  // The server's message encodes the method: `Tx.<method>() cannot read ...`.
  const match = /^Tx\.([^(]+)\(\)/.exec(message);
  return new ReadAfterWrite(match?.[1] ?? "unknown");
}

function restoreConversationBusy(message: string): ConversationBusy {
  // The server's message encodes the id: `Conversation <n> is busy`.
  const match = /^Conversation (\d+) is busy/.exec(message);
  return new ConversationBusy((match ? Number(match[1]) : NaN) as ConversationId);
}

type TaskRecordValue = TaskRecord<JsonValue, JsonValue, JsonValue>;

export class RemoteStorage implements Storage {
  private closed = false;
  private leaseId?: string;
  private heartbeat?: NodeJS.Timeout;
  private queue: Promise<void> = Promise.resolve();
  /** Identity of the most recent commit whose outcome is unknown (lost ack). */
  private uncertainCommitIdentity?: string;

  constructor(
    private readonly options: RemoteStorageOptions,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Open: acquire the partition lease from the service. */
  async open(): Promise<void> {
    const response = (await this.request("POST", "/v1/open", {
      repository: this.options.repository,
      pullNumber: this.options.pullNumber,
    })) as { leaseId: string; ttlMs: number };
    this.leaseId = response.leaseId;
    // Renew well inside the TTL; any transport error retries on the next tick.
    const beat = Math.max(250, Math.floor(response.ttlMs / 3));
    this.heartbeat = setInterval(() => {
      void this.beat();
    }, beat);
    this.heartbeat.unref();
  }

  private async beat(): Promise<void> {
    try {
      await this.request("POST", "/v1/heartbeat", {
        repository: this.options.repository,
        pullNumber: this.options.pullNumber,
        leaseId: this.leaseId,
      });
    } catch {
      // Renewal failures surface through the next storage operation, which
      // the service refuses with LeaseLost once the lease is gone.
    }
  }

  /** Release backend resources; all later operations must reject. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    try {
      if (this.leaseId) {
        await this.request("POST", "/v1/close", {
          repository: this.options.repository,
          pullNumber: this.options.pullNumber,
          leaseId: this.leaseId,
        });
      }
    } catch {
      // The lease expires server-side on its own; closing must not throw.
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new StorageRejected("storage is closed");
  }

  private async request(method: string, path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.authToken}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new StorageUnreachable(
        `storage service unreachable at ${this.options.baseUrl}${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      // The error body may itself be malformed (mid-collapse responses,
      // proxy truncations); the status and the error name still classify it.
      const payload = (await response.json().catch(() => undefined)) as
        | { error?: { name?: string; message?: string } }
        | undefined;
      const name = payload?.error?.name ?? `HTTP ${response.status}`;
      const message = payload?.error?.message ?? "storage request failed";
      if (name === "StorageInUseError") throw new StorageInUse(message);
      if (name === "LeaseLostError") {
        this.closed = true;
        if (this.heartbeat) {
          clearInterval(this.heartbeat);
          this.heartbeat = undefined;
        }
        throw new LeaseLost(message);
      }
      if (name === "StorageRejected") throw new StorageRejected(message);
      if (name === "ReadAfterWrite") throw restoreReadAfterWrite(message);
      if (name === "ConversationBusy") throw restoreConversationBusy(message);
      // Not one of the contract's typed channel faults (an infrastructure
      // classification, not a retryable storage-state error): the plain
      // error carries the host name and reason verbatim.
      throw new Error(`${name}: ${message}`);
    }
    return response.status === 204 ? undefined : ((await response.json()) as unknown);
  }

  /** Serialize contract operations; one client never interleaves its calls. */
  // (commit's uncertain mark is cleared on the next different commit)
  private op<T>(run: () => Promise<T>): Promise<T> {
    this.ensureOpen();
    const execute = this.queue.then(run, run);
    this.queue = execute.then(
      () => undefined,
      () => undefined,
    );
    return execute;
  }

  private async storageCall<T>(path: string, args: Record<string, unknown>): Promise<T> {
    return this.op(async () => {
      const response = (await this.request("POST", path, {
        repository: this.options.repository,
        pullNumber: this.options.pullNumber,
        leaseId: this.leaseId,
        args,
      })) as T;
      return response;
    });
  }

  async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    const identity = createHash("sha256").update(JSON.stringify(writes)).digest("hex");
    // A commit whose previous attempt could not be observed (lost ack)
    // declares itself as a retry so the service can dedupe; a first attempt
    // always applies — identical content re-committed after a visible ack is
    // a contract violation the service must reject instead of dedupe.
    const retry = this.uncertainCommitIdentity === identity;
    try {
      const response = await this.storageCall<{ seq: number; deduped: boolean }>("/v1/storage/commit", {
        identity,
        writes,
        retry,
      });
      return response.seq as Seq;
    } catch (error) {
      if (error instanceof StorageUnreachable) {
        // The server may or may not have applied this batch; a reissue of the
        // same batch becomes a declared retry.
        this.uncertainCommitIdentity = identity;
      } else if (retry) {
        this.uncertainCommitIdentity = undefined;
      }
      throw error;
    }
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    const response = await this.storageCall<{ id: number }>("/v1/storage/mintId", {});
    return response.id as I;
  }

  async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    const response = await this.storageCall<{ record: ConversationRecord | null }>(
      "/v1/storage/conversation",
      { id: Number(id) },
    );
    return response.record ?? undefined;
  }

  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    const response = await this.storageCall<{ page: Page<ConversationRecord, Cursor> }>(
      "/v1/storage/scanConversations",
      { query: query ?? {}, limit, ...(cursor ? { cursor } : {}) },
    );
    return response.page;
  }

  async entry(id: EntryId, _context: Context): Promise<EntryLookup>;
  async entry(conversationId: ConversationId, id: EntryId, _context: Context): Promise<EntryLookup>;
  async entry(...rest: unknown[]): Promise<EntryLookup> {
    // Dispatch on argument count: the by-conversation form is `conversationId, id, context`.
    if (rest.length <= 2) {
      const response = await this.storageCall<{ result: EntryLookup | null }>(
        "/v1/storage/entry/by-id",
        { id: Number(rest[0] as number) },
      );
      return response.result ?? undefined;
    }
    const response = await this.storageCall<{ result: EntryLookup | null }>("/v1/storage/entry", {
      conversationId: Number(rest[0] as number),
      id: Number(rest[1] as number),
    });
    return response.result ?? undefined;
  }

  async findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { head: EntryId }) | undefined> {
    const response = await this.storageCall<{ result: (EntryRecord & { head: EntryId }) | null }>(
      "/v1/storage/findLatestHeadMarker",
      {
        conversationId: Number(conversationId),
        atOrBeforeEntryId: atOrBeforeEntryId === undefined ? null : Number(atOrBeforeEntryId),
      },
    );
    return response.result ?? undefined;
  }

  async scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    const response = await this.storageCall<{ page: Page<EntryRecord, Cursor> }>(
      "/v1/storage/scanEntries",
      { query, limit, ...(cursor ? { cursor } : {}) },
    );
    return response.page;
  }

  async task(id: TaskId, _context: Context): Promise<TaskRecordValue | undefined> {
    const response = await this.storageCall<{ record: TaskRecordValue | null }>(
      "/v1/storage/task",
      { id: Number(id) },
    );
    return response.record ?? undefined;
  }

  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<TaskRecordValue, Cursor>> {
    const response = await this.storageCall<{ page: Page<TaskRecordValue, Cursor> }>(
      "/v1/storage/scanTasks",
      { query: query ?? {}, limit, ...(cursor ? { cursor } : {}) },
    );
    return response.page;
  }

  async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    const response = await this.storageCall<{ record: SubmissionRecord | null }>(
      "/v1/storage/submission",
      { id: Number(id) },
    );
    return response.record ?? undefined;
  }

  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    const response = await this.storageCall<{ page: Page<SubmissionRecord, Cursor> }>(
      "/v1/storage/scanSubmissions",
      { query: query ?? {}, limit, ...(cursor ? { cursor } : {}) },
    );
    return response.page;
  }

  async submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    const response = await this.storageCall<{ record: SubmissionRecord | null }>(
      "/v1/storage/submissionByRequest",
      { conversationId: Number(conversationId), requestId },
    );
    return response.record ?? undefined;
  }

  async findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    _context: Context,
  ): Promise<DocumentRecord | undefined> {
    const response = await this.storageCall<{ record: DocumentRecord | null }>(
      "/v1/storage/findDocument",
      { address, at },
    );
    return response.record ?? undefined;
  }

  async document(
    id: DocumentId,
    at: DocumentPoint,
    _context: Context,
  ): Promise<StoredDocument | undefined> {
    const response = await this.storageCall<{ stored: StoredDocument | null }>(
      "/v1/storage/document",
      { id: Number(id as unknown as number), at },
    );
    return response.stored ?? undefined;
  }

  async scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    const response = await this.storageCall<{ page: Page<DocumentRecord, Cursor> }>(
      "/v1/storage/scanDocuments",
      { query, limit, ...(cursor ? { cursor } : {}) },
    );
    return response.page;
  }
}

/** Open one partition of the storage service for this process. */
export async function openRemoteStorage(options: RemoteStorageOptions): Promise<RemoteStorage> {
  const storage = new RemoteStorage(options);
  await storage.open();
  return storage;
}
