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
import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  type Conversation,
  type ConversationId,
  type Harness,
  type SessionDocToken,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ReviewFinding } from "./artifact.js";
import type { FindingMatch, MatchRejection, PublishedComment } from "./matching.js";

export type RunPhase =
  | "primary"
  | "primary frozen"
  | "re-review"
  | "final frozen"
  | "matched"
  | "publishing"
  | "published";

/** Token usage of one settling assistant message. */
export interface StageUsage {
  input: number;
  output: number;
  totalTokens: number;
}

export interface RunUsage {
  primary?: StageUsage;
  reReview?: StageUsage;
  /** The post-freeze matching turn (ticket 04). */
  matching?: StageUsage;
}

export interface RunDocument {
  kind: "nitpi.run";
  version: 1;
  runId: string;
  /** Mode `normal`; `/review clean` is ticket 07. */
  mode: "normal";
  /** What started the run: a writer's command or an automatic event (ticket 03). */
  source?: "command" | "automatic";
  /** Who asked (login), for command sources. */
  requester?: string;
  /** Human-readable original trigger, recorded for audit. */
  triggeredBy?: string;
  phase: RunPhase;
  subject: {
    repository: string;
    pullNumber: number;
    baseSha: string;
    headSha: string;
  };
  /** The durable review pipeline task driving this run. */
  pipelineTaskId: string;
  /** Conversation of the canonical PR history this run continues. */
  canonicalConversationId: string;
  /** Frozen primary artifact, stored verbatim once primary review completes. */
  artifact?: string;
  artifactFrozen: boolean;
  finalReview?: string;
  auditNotes?: string;
  findings?: ReviewFinding[];
  /** Correction rounds sent back to the re-reviewer for invalid anchors. */
  anchorRounds?: number;
  /** The reviewed base→head diff, fetched once at run start; anchor
   *  validation checks against this text even if the PR later moves. */
  pinnedDiff?: string;
  reReviewConversationId?: string;
  publication?: { reviewId: number; commentIds: number[] };
  /** Review-comment snapshot (any author) read at matching time — the input
   * the matching turn saw and the set the publisher validates against. */
  earlierComments?: PublishedComment[];
  /** Raw model assignments from the matching turn (label → comment id or null). */
  matches?: FindingMatch[];
  /** Model-supplied IDs rejected at publication, with reasons (ticket 04:
   * rejected with a reason and not acted on). */
  matchRejections?: MatchRejection[];
  /** The instructions each stage actually used, by content hash. */
  instructionHashes?: { primary?: string; reReview?: string };
  /** Pinned revision the repository instructions were captured at. */
  repositoryInstructionsRevision?: string;
  /** Per-stage unchanged checkouts of the reviewed head. */
  checkouts?: { primary: string; reReview: string };
  usage?: RunUsage;
  checkStatus: "in progress" | "success" | "failure" | "skipped";
  checkDetail?: string;
  error?: string;
}

type RunsRegistryValue = { [key: string]: JsonValueLike } & { runs: RunDocument[] };
type JsonValueLike = null | boolean | number | string | JsonValueLike[] | { [key: string]: JsonValueLike };

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

  async usage(context: Context) {
    return this.harness.usage(context);
  }
}

export type { ConversationId };
