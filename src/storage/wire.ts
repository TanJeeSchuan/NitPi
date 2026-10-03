/**
 * Wire encoding for Pi Durable's `Storage` contract over HTTP.
 *
 * The service owns Pi's actual `SqliteStorage` (the SQLite file lives beside
 * the service, on homelab storage); the client adapter speaks this protocol.
 * Branded ids (ConversationId, EntryId, ...) are plain numbers on the wire;
 * `Seq` likewise. `DocumentPoint` distinguishes `"current"` from a numeric
 * commit sequence. Everything else is plain JSON already.
 */
import type {
  ConversationId,
  EntryId,
  Page,
  Seq,
  SubmissionId,
  TaskId,
} from "@earendil-works/pi-durable";

export type WireIdNumber =
  | { readonly kind: "conversation"; readonly id: number }
  | { readonly kind: "entry"; readonly id: number; readonly conversationId?: number }
  | { readonly kind: "task"; readonly id: number }
  | { readonly kind: "submission"; readonly id: number; readonly conversationId?: number };

/** A document read point is either `current` or a specific commit sequence. */
export function encodeDocumentPoint(at: Seq | "current"): number | "current" {
  return at;
}

export function decodeDocumentPoint(at: number | "current"): Seq | "current" {
  return at === "current" ? at : (at as Seq);
}

export function decodePage<T, C>(requestPage: { items: unknown[]; next?: unknown }): Page<T, C> {
  return {
    items: requestPage.items as T[],
    ...(requestPage.next === undefined ? {} : { next: requestPage.next as C }),
  };
}

/** Names of the storage methods that reach the wire, per `Storage`. */
export const STORAGE_METHODS = [
  "mintId",
  "conversation",
  "scanConversations",
  "entry",
  "findLatestHeadMarker",
  "scanEntries",
  "task",
  "scanTasks",
  "submission",
  "scanSubmissions",
  "submissionByRequest",
  "findDocument",
  "document",
  "scanDocuments",
  "commit",
] as const;

export type StorageMethodName = (typeof STORAGE_METHODS)[number];
