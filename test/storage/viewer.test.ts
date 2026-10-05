/**
 * Run view reader: lease-free reads of committed WAL state and document
 * deltas, and per-run isolation of the shared canonical conversation.
 */
import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readRuns } from "../../src/storage/viewer/runs.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nitpi-viewer-"));
  mkdirSync(join(dir, "example_repo"));
  const file = join(dir, "example_repo/pr-11.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE documents(id INTEGER PRIMARY KEY, kind TEXT, owner_id INTEGER, retired_at INTEGER);
    CREATE TABLE document_revisions(document_id INTEGER, seq INTEGER, kind TEXT, version INTEGER, content TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY, record TEXT);
    CREATE TABLE conversations(id INTEGER PRIMARY KEY, record TEXT);
    CREATE TABLE entries(id INTEGER PRIMARY KEY, record TEXT);`);
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const revision = (id: number, seq: number, kind: string, value: unknown) =>
    db.prepare("INSERT INTO document_revisions VALUES (?, ?, ?, 1, ?)").run(id, seq, kind, JSON.stringify(value));
  const doc = (id: number, kind: string, owner: number, value: unknown) => {
    db.prepare("INSERT INTO documents VALUES (?, ?, ?, NULL)").run(id, JSON.stringify(kind), owner);
    revision(id, 1, "base", value);
  };
  const record = (table: string, value: { id: number; [key: string]: unknown }) =>
    db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(value.id, JSON.stringify(value));
  const run = (stamp: number, task: number, state: string) => ({
    runId: `run-${stamp.toString(36)}-abc`, pipelineTaskId: task, canonicalConversationId: "2", mode: "normal",
    phase: state === "success" ? "published" : "primary", checkStatus: state,
    subject: { repository: "example/repo", pullNumber: 11, headSha: "a".repeat(40), baseSha: "b".repeat(40) },
  });
  const first = run(1700000000000, 10, "success");
  const second = run(1700000010000, 30, "in progress");
  doc(1, "nitpi.runs", 0, { runs: [first, second] });
  record("conversations", { id: 2 });
  for (const r of [first, second]) {
    record("tasks", { id: r.pipelineTaskId, kind: "nitpi.review", conversationId: 2, input: { runId: r.runId } });
  }
  record("entries", { id: 11, conversationId: 2, model: [{ role: "assistant", content: "first run output" }] });
  record("entries", { id: 31, conversationId: 2, model: [{ role: "assistant", content: "second run output" }] });
  doc(40, "pi.live", 2, { generation: { message: { role: "assistant", content: [{ type: "text", text: "streaming" }] } } });
  return { dir, file, record, revision, first, second };
}

it("reads committed WAL updates and document deltas without changing the database", () => {
  const f = fixture();
  f.revision(1, 2, "delta", [["s", ["runs", 1, "phase"], "re-review"]]);
  const original = readFileSync(f.file);
  const listed = readRuns(f.dir);
  expect(listed.errors).toEqual([]);
  expect(listed.runs[0]!.phase).toBe("re-review");
  const live = () => (readRuns(f.dir, f.second.runId).selected!.live[0]!.message.content as { text: string }[])[0]!.text;
  expect(live()).toBe("streaming");
  f.revision(40, 2, "delta", [["a", ["generation", "message", "content", 0, "text"], " more"]]);
  expect(live()).toBe("streaming more");
  expect(readFileSync(f.file)).toEqual(original);
});

it("isolates historical shared conversations and includes owned re-review conversations", () => {
  const f = fixture();
  f.record("conversations", { id: 20, owner: { taskId: 10 } });
  f.record("tasks", { id: 12, kind: "pi.generation", conversationId: 2 });
  f.record("entries", { id: 24, conversationId: 2, model: [{ role: "assistant", content: "matching output" }] });
  f.record("entries", { id: 22, conversationId: 20, model: [{ role: "assistant", content: "re-review output" }] });
  const selected = readRuns(f.dir, f.first.runId).selected!;
  expect(selected.activity.map((entry) => entry.id)).toEqual(["11-0", "22-0", "24-0"]);
  expect(selected.live).toEqual([]);
});

it("reports a broken partition while preserving readable run history", () => {
  const f = fixture();
  new DatabaseSync(join(f.dir, "example_repo/pr-12.sqlite")).close();
  const result = readRuns(f.dir);
  expect(result.runs).toHaveLength(2);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]!.file).toMatch(/pr-12\.sqlite/);
});
