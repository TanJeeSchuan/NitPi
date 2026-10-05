/**
 * Read-only run view for the storage service's `/view` page.
 *
 * Reads every partition's SQLite file directly, without a lease, so it works
 * while a reviewer holds the partition. Each file is read in one read-only
 * transaction; document deltas are applied with Chord.
 */
import { readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apply, type Op } from "@earendil-works/chord/delta";
import type { RunDocument } from "../../review-host/run-history.js";

interface Message {
  role: string;
  toolName?: string;
  timestamp?: number;
  content: unknown;
}
interface TaskRecord {
  id: number;
  kind: string;
  owner?: number;
  conversationId?: number;
  input?: { runId?: string };
}
interface ConversationRecord {
  id: number;
  owner?: { taskId?: number; conversationId?: number };
}
interface EntryRecord {
  id: number;
  conversationId: number;
  model?: Message[];
}
interface LiveDocument {
  generation?: { message?: Message };
  tools?: { callId: string; name: string; status: string; output?: string }[];
}

export interface ActivityItem {
  id: string;
  message: Message;
}

const records = <T>(db: DatabaseSync, table: string): T[] =>
  db.prepare(`SELECT record FROM ${table} ORDER BY id`).all().map((row) => JSON.parse(String(row.record)) as T);

// Read a complete base and its deltas from one SQLite snapshot.
function document<T>(db: DatabaseSync, id: number): T {
  const base = db
    .prepare("SELECT seq, content, version FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1")
    .get(id);
  if (!base) throw new Error(`Document ${id} has no base`);
  let value = JSON.parse(String(base.content)) as T;
  for (const delta of db.prepare("SELECT kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq").all(id, base.seq as number)) {
    if (delta.kind !== "delta" || delta.version !== base.version) throw new Error(`Unsupported document revision ${id}`);
    value = apply(value, JSON.parse(String(delta.content)) as Op[]);
  }
  return value;
}

function documents(db: DatabaseSync, kind: string): { id: number; owner_id: number }[] {
  return db.prepare("SELECT id, owner_id FROM documents WHERE kind = ? AND retired_at IS NULL").all(JSON.stringify(kind)) as { id: number; owner_id: number }[];
}

function summary(run: RunDocument) {
  const started = /^run-([a-z0-9]+)-/.exec(run.runId);
  return {
    runId: run.runId,
    ...run.subject,
    mode: run.mode,
    phase: run.phase,
    status: run.checkStatus,
    reason: run.error ?? run.checkDetail,
    requester: run.requester,
    startedAt: started ? parseInt(started[1]!, 36) : null,
    tokens: Object.values(run.usage ?? {}).reduce((sum, usage) => sum + usage.totalTokens, 0),
    reviewId: run.publication?.reviewId,
  };
}

function detail(db: DatabaseSync, run: RunDocument) {
  const tasks = records<TaskRecord>(db, "tasks");
  // Normal runs share a primary conversation. Split it by pipeline attempt,
  // so looking at an old run never includes a later run's transcript.
  const canonical = Number(run.canonicalConversationId);
  const pipelines = tasks.filter((task) => task.kind === "nitpi.review" && task.conversationId === canonical);
  const spans = pipelines.flatMap((task, index) =>
    task.input?.runId === run.runId ? [[task.id, pipelines[index + 1]?.id ?? Infinity] as const] : [],
  );
  const withinAttempt = (id: number) => spans.some(([from, to]) => id > from && id < to);
  const ownedTasks = new Set<number | undefined>(
    tasks
      .filter((task) => (task.kind === "nitpi.review" && task.input?.runId === run.runId) || (task.conversationId === canonical && withinAttempt(task.id)))
      .map((task) => task.id),
  );
  const ownedConversations = new Set<number | undefined>([run.primaryConversationId, run.reReviewConversationId].filter(Boolean).map(Number));
  const conversations = records<ConversationRecord>(db, "conversations");
  let expanded;
  do {
    expanded = false;
    for (const conversation of conversations) {
      const owner = conversation.owner;
      if ((ownedTasks.has(owner?.taskId) || ownedConversations.has(owner?.conversationId)) && !ownedConversations.has(conversation.id)) {
        ownedConversations.add(conversation.id);
        expanded = true;
      }
    }
    for (const task of tasks) {
      if ((ownedTasks.has(task.owner) || ownedConversations.has(task.conversationId)) && !ownedTasks.has(task.id)) {
        ownedTasks.add(task.id);
        expanded = true;
      }
    }
  } while (expanded);

  const activity: ActivityItem[] = records<EntryRecord>(db, "entries")
    .filter((entry) => ownedConversations.has(entry.conversationId) || (entry.conversationId === canonical && withinAttempt(entry.id)))
    .flatMap((entry) =>
      (entry.model ?? []).filter((message) => message.role !== "system").map((message, index) => ({ id: `${entry.id}-${index}`, message })),
    );
  const live: ActivityItem[] = [];
  if (run.checkStatus === "in progress") {
    const latestIsThisRun = pipelines.at(-1)?.input?.runId === run.runId;
    for (const doc of documents(db, "pi.live")) {
      if (!ownedConversations.has(doc.owner_id) && !(doc.owner_id === canonical && latestIsThisRun)) continue;
      const value = document<LiveDocument>(db, doc.id);
      if (value.generation?.message) live.push({ id: `live-${doc.id}`, message: value.generation.message });
      for (const tool of value.tools ?? []) {
        if (tool.status !== "done") {
          live.push({ id: `tool-${doc.id}-${tool.callId}`, message: { role: "toolResult", toolName: tool.name, content: tool.output ?? tool.status } });
        }
      }
    }
  }
  return { finalReview: run.finalReview, artifact: run.artifact, auditNotes: run.auditNotes, activity, live };
}

/** Every run across the data directory, newest first, plus the selected run's detail. */
export function readRuns(dataDir: string, selectedRunId?: string) {
  const root = realpathSync(dataDir);
  const runs: ReturnType<typeof summary>[] = [];
  const errors: { file: string; message: string }[] = [];
  let selected: (ReturnType<typeof summary> & ReturnType<typeof detail>) | null = null;
  for (const file of readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => /(?:^|[\\/])pr-\d+\.sqlite$/.test(file))) {
    let db: DatabaseSync | undefined;
    try {
      const path = realpathSync(resolve(root, file));
      const within = relative(root, path);
      if (within.startsWith("..") || isAbsolute(within)) throw new Error("Database is outside the data directory");
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 3000; BEGIN");
      for (const doc of documents(db, "nitpi.runs")) {
        for (const run of document<{ runs: RunDocument[] }>(db, doc.id).runs) {
          const item = summary(run);
          runs.push(item);
          if (run.runId === selectedRunId) selected = { ...item, ...detail(db, run) };
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      errors.push({ file, message: (error as Error).message });
    } finally {
      db?.close();
    }
  }
  runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return { runs, errors, selected };
}
