/**
 * Publication operation ledger (ticket 05): durable record of every intended
 * GitHub write.
 *
 * GitHub's create endpoints have no idempotency key, so the publisher records
 * what it intends to write before writing. One operation record carries:
 *
 * - the operation key — logical finding (or the summary review / a thread),
 *   reviewed subject and intended change, joined into one stable string;
 * - the payload — the exact request body the publisher will send;
 * - the publisher-owned marker embedded in the payload's body, so the object
 *   can be found again on GitHub;
 * - the remote ID once GitHub confirms the write.
 *
 * A record committed before the write (`state: "recorded"`) is the durable
 * intent; the outcome commit happens only after the response arrived. If the
 * host crashes in between, the operation stays recorded with `attempts > 0`
 * and reconciliation — not a blind re-post — decides what happened: it
 * paginates GitHub's reviews and comments, matches by marker, author and
 * reviewed subject, and adopts the object it finds.
 *
 * The ledger is one session doc on the PR's storage partition (ticket 06):
 * the same SQLite file the review pipeline uses, so operations survive a
 * runner going away exactly like run documents do.
 */
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Harness, type SessionDocToken, type Tx } from "@earendil-works/pi-durable";

/** What one operation intended to change. */
export type PublicationIntent =
  | "create-review"
  | "update-review"
  | "create-comment"
  | "update-comment"
  | "supersede-comment"
  | "resolve-thread"
  | "unresolve-thread";

/** Remote IDs recorded once GitHub confirmed the write. */
export interface PublicationRemote {
  reviewId?: number;
  commentId?: number;
  /** Inline comment IDs confirmed with a batched review create. */
  commentIds?: number[];
}

/** One intended GitHub write, from durable intent to confirmed remote ID. */
export interface PublicationOp {
  /** Stable idempotency key: intent, reviewed subject and logical target. */
  opKey: string;
  runId: string;
  intent: PublicationIntent;
  /** What the write changes: `summary`, a finding label, or `thread-<id>`. */
  subject: string;
  /** The reviewed subject the write belongs to. */
  reviewedSubject: {
    repository: string;
    pullNumber: number;
    headSha: string;
  };
  /** The exact request payload sent to GitHub (strict JSON). */
  payload: unknown;
  /** Publisher-owned marker embedded in the payload's body. */
  marker: string;
  state: "recorded" | "confirmed";
  /** Write attempts made under this key (including refused ones). */
  attempts: number;
  remote?: PublicationRemote;
  lastError?: string;
  createdAt: number;
  confirmedAt?: number;
}

type LedgerValueShape = { [key: string]: JsonLike } & { ops: PublicationOp[] };
type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

/** The intent bag every ledgered write carries: the operation key's fields
 * (logical subject, run, intended change), the exact payload, the marker
 * embedded in the payload's body and the attempt ordinal. */
export interface RecordedIntent {
  opKey: string;
  runId: string;
  intent: PublicationIntent;
  subject: string;
  reviewedSubject: PublicationOp["reviewedSubject"];
  payload: unknown;
  marker: string;
  attempts: number;
}

/** Session-scoped ledger of publication operations (one review host). */
export const PublicationLedgerDoc: SessionDocToken<LedgerValueShape> = defineDoc({
  kind: "nitpi.publication-ops",
  version: 1,
  scope: "session",
  initial: () => ({ ops: [] }),
});

// --- markers -----------------------------------------------------------------

/** Publisher-owned marker for the maintained summary review of one run. */
export function summaryMarker(runId: string): string {
  return `nitpi:summary:${runId}`;
}

/** Publisher-owned marker for one finding's comment as created by one run. */
export function findingMarker(runId: string, label: string): string {
  return `nitpi:finding:${runId}:${label}`;
}

/** The marker as it appears inside a body: an HTML comment, invisible when
 * GitHub renders the body. */
export function markerComment(marker: string): string {
  return `<!-- ${marker} -->`;
}

/** Append the marker to a body; idempotent so repeated assembly (retries
 * re-patching the same body) never stacks duplicates. */
export function bodyWithMarker(body: string, marker: string): string {
  if (body.includes(markerComment(marker))) return body;
  return `${body}\n\n${markerComment(marker)}`;
}

/** Every publisher-owned marker found in a body, in order. */
export function extractMarkers(body: string): string[] {
  const markers: string[] = [];
  const pattern = /<!--\s*(nitpi:(?:summary|finding):[^>]*?)\s*-->/g;
  for (const match of body.matchAll(pattern)) markers.push(match[1] ?? "");
  return markers.filter(Boolean);
}

// --- operation keys ----------------------------------------------------------

/** Operation key: intended change, run (the review's subject holder) and the
 * logical target it changes. The record carries the full reviewed subject. */
export function operationKey(intent: PublicationIntent, runId: string, subject: string): string {
  return `${intent}/${runId}/${subject}`;
}

/** Key for a re-created finding comment (a confirmed comment someone deleted
 * by hand): the recreate ordinal keeps keys stable across retries. */
export function recreateOperationKey(runId: string, label: string, recreateOrdinal: number): string {
  return operationKey("create-comment", runId, `${label}/r${recreateOrdinal}`);
}

/** Ordinal for the next create-comment write of one run's finding, from
 * the ledger's existing ops (pure; no counter state). The first write is
 * ordinal 1 (plain key); replacements and recreates append `/r<N>` so every
 * published comment has a unique operation key and marker. */
export function nextCreateOrdinal(ops: PublicationOp[], runId: string, label: string): number {
  const base = operationKey("create-comment", runId, label);
  const recreatePrefix = `${base}/r`;
  const count = ops.filter((op) => op.opKey === base || op.opKey.startsWith(recreatePrefix)).length;
  return count + 1;
}

// --- ledger ------------------------------------------------------------------

/** Read and write publication operations through the PR's durable storage. */
export class PublicationLedger {
  constructor(readonly harness: Harness) {}

  async op(opKey: string, context: Context): Promise<PublicationOp | undefined> {
    const doc = await this.harness.snapshot(PublicationLedgerDoc, context);
    return doc?.ops.find((op) => op.opKey === opKey);
  }

  async opsForRun(runId: string, context: Context): Promise<PublicationOp[]> {
    const doc = await this.harness.snapshot(PublicationLedgerDoc, context);
    return (doc?.ops ?? []).filter((op) => op.runId === runId);
  }

  /**
   * Commit the intent before the write: upsert with the payload (strict JSON)
   * and the attempt ordinal. Called once per write attempt under the key.
   */
  async recordIntent(intent: RecordedIntent, context: Context): Promise<void> {
    if (!context) throw new Error("publication ledger requires an explicit context (no TODO_CONTEXT fallback)");
    await this.harness.commit(async (tx) => {
      await upsertOp(tx, intent);
    }, context);
  }

  /** Record the remote ID once GitHub confirmed the write. */
  async confirm(opKey: string, remote: PublicationRemote, context: Context): Promise<void> {
    if (!context) throw new Error("publication ledger requires an explicit context (no TODO_CONTEXT fallback)");
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(PublicationLedgerDoc);
      const ops = [...doc.ops];
      const index = ops.findIndex((op) => op.opKey === opKey);
      if (index < 0) throw new Error(`publication operation ${opKey} was never recorded`);
      ops[index] = {
        ...ops[index]!,
        state: "confirmed",
        remote: { ...ops[index]!.remote, ...remote },
        confirmedAt: Date.now(),
      };
      doc.ops = ops;
    }, context);
  }

  /**
   * Confirm (or adopt) from remote truth without a fresh write: an operation
   * whose object is already in the intended remote state — a thread found
   * already resolved after an interrupted mutation — is confirmed from the
   * state GitHub reports.
   */
  async confirmFromState(opKey: string, remote: PublicationRemote, context: Context): Promise<void> {
    const existing = await this.op(opKey, context);
    if (existing?.state === "confirmed") return;
    await this.confirm(opKey, remote, context);
  }
}

/** Upsert inside a caller-provided transaction (used by `recordIntent` and
 * by tests that stage several intents in one commit). */
export async function upsertOp(tx: Tx, intent: RecordedIntent): Promise<void> {
  const doc = await tx.doc(PublicationLedgerDoc);
  const ops = [...doc.ops];
  const index = ops.findIndex((op) => op.opKey === intent.opKey);
  const existing = index >= 0 ? ops[index] : undefined;
  const record: PublicationOp = {
    opKey: intent.opKey,
    runId: intent.runId,
    intent: intent.intent,
    subject: intent.subject,
    reviewedSubject: intent.reviewedSubject,
    payload: intent.payload,
    marker: intent.marker,
    state: "recorded",
    attempts: intent.attempts,
    createdAt: existing?.createdAt ?? Date.now(),
    ...(existing?.state === "confirmed" && existing.remote ? { remote: existing.remote, state: "confirmed" as const } : {}),
  };
  if (index >= 0) ops[index] = record;
  else ops.push(record);
  doc.ops = ops;
}
