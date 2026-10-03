/**
 * Run history: durable state for the review host, on Pi Durable.
 *
 * - One canonical PR conversation per (repository, pull number). Normal
 *   primary turns run in it; Pi's built-in compaction manages its context.
 * - Every run gets a fresh re-reviewer conversation.
 * - Run documents record the reviewed subject (repo, PR, base SHA, head SHA),
 *   mode normal, phase, artifact references and check outcome. Markdown stays
 *   the source of truth for findings; run documents are bookkeeping.
 */
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import { defineDoc, type Conversation, type Harness, type SessionDocToken, type Tx } from "@earendil-works/pi-durable";

export type RunMode = "normal";
export type RunPhase =
  | "primary"
  | "primary frozen"
  | "re-review"
  | "final frozen"
  | "publishing"
  | "published";

export interface RunUsage {
  primary?: { input: number; output: number; totalTokens: number };
  reReview?: { input: number; output: number; totalTokens: number };
}

export interface RunReviewFinding {
  label: string;
  /** The finding's section Markdown verbatim (source of truth for the body). */
  section: string;
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
}

export interface RunDocument {
  kind: "nitpi.run";
  version: 1;
  runId: string;
  mode: RunMode;
  phase: RunPhase;
  subject: {
    repository: string;
    pullNumber: number;
    baseSha: string;
    headSha: string;
  };
  /** Conversation of the canonical PR history this run continues. */
  canonicalConversationId: string;
  /** Frozen primary artifact, stored verbatim once primary review completes. */
  artifact?: string;
  artifactFrozen: boolean;
  finalReview?: string;
  auditNotes?: string;
  findings?: RunReviewFinding[];
  reReviewConversationId?: string;
  publication?: { reviewId: number; commentIds: number[] };
  instructionHashes?: { primary?: string; reReview?: string };
  usage?: RunUsage;
  checkStatus: "in progress" | "success" | "failure";
  checkDetail?: string;
  error?: string;
}

type RunsRegistryValue = { [key: string]: JsonValue } & { runs: RunDocument[] };

/** Session-scoped registry of runs (one process hosts one review host). */
export const RunsRegistry: SessionDocToken<RunsRegistryValue> = defineDoc({
  kind: "nitpi.runs",
  version: 1,
  scope: "session",
  initial: () => ({ runs: [] }),
});

export class RunHistory {
  constructor(readonly harness: Harness) {}

  async record(tx: Tx, run: RunDocument): Promise<void> {
    // `doc` is an in-transaction Draft; mutate fields in place.
    const doc = await tx.doc(RunsRegistry);
    const runs = [...doc.runs];
    const index = runs.findIndex((r) => r.runId === run.runId);
    if (index >= 0) runs[index] = run;
    else runs.push(run);
    doc.runs = runs;
  }

  async findRun(runId: string, context: Context): Promise<RunDocument | undefined> {
    const doc = await this.harness.snapshot(RunsRegistry, context);
    return doc?.runs.find((r) => r.runId === runId);
  }

  async findRunInTx(tx: Tx, runId: string): Promise<RunDocument | undefined> {
    const doc = await tx.doc(RunsRegistry);
    return doc.runs.find((r) => r.runId === runId);
  }

  async allRuns(context: Context): Promise<RunDocument[]> {
    const doc = await this.harness.snapshot(RunsRegistry, context);
    return doc?.runs ?? [];
  }

  async findCanonicalConversation(
    repository: string,
    pullNumber: number,
    context: Context,
  ): Promise<string | undefined> {
    const doc = await this.harness.snapshot(RunsRegistry, context);
    const run = doc?.runs.find(
      (r) => r.subject.repository === repository && r.subject.pullNumber === pullNumber,
    );
    return run?.canonicalConversationId;
  }

  async createCanonicalConversation(
    request: { repository: string; pullNumber: number },
    agent: { modelId: string; instructions: string },
    context: Context,
  ): Promise<Conversation> {
    return this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "nitpi-primary", modelId: agent.modelId },
          instructions: agent.instructions,
        },
      },
      context,
    );
  }

  /** Fresh re-reviewer conversation for one run (task-owned boundary). */
  async createReReviewConversation(
    runId: string,
    modelId: string,
    instructions: string,
    context: Context,
  ): Promise<Conversation> {
    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "nitpi-re-review", modelId },
          instructions,
        },
      },
      context,
    );
    void runId;
    return conversation;
  }

  async usage(context: Context) {
    return this.harness.usage(context);
  }
}
