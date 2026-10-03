/**
 * Trigger gate (spec: "Trigger gate" decision; ticket 03).
 *
 * Trusted main-branch workflow code: it decides which triggers start review
 * runs and refuses everything else with a reason. Checks, in order:
 *   1. the commenter is a writer or maintainer (commands only),
 *   2. the pull request is open and not a draft for automatic triggers,
 *   3. the event toggle is enabled in automatic mode,
 *   4. the named checks have completed on the head, when configured,
 *   5. for forks, a writer's command approves only the current head SHA,
 *   6. delivery deduplication: one delivered comment or event starts at most
 *      one run.
 *
 * Durable gate state lives in one session doc (`nitpi.gate`): per-PR fork
 * approvals, the newest pending request per pull request, and delivery
 * dedup keys. Every record survives a runner going away, so approvals and
 * the pending backlog are read back from storage on a host restart.
 *
 * Manual mode is the default: pull-request events start nothing. `/review
 * clean` and `/review cancel` are recognised and permission-checked here;
 * their run behaviour belongs to tickets 07 and 09.
 */
import { TODO_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { GitHubApi } from "../github/publisher.js";
import type { AutoModeConfig } from "./config.js";
import type { RunDocument, RunHistory } from "./run-history.js";

/** Pull-request event the automatic mode can subscribe to. */
export type PrAction = "opened" | "reopened" | "synchronize" | "ready_for_review";

/** Check conclusions for refused triggers (spec: skipped or action required). */
export type RefusalOutcome = "skipped" | "action_required";

/** One delivered trigger: an issue-comment command or a pull-request event. */
export type TriggerEvent =
  | {
      kind: "comment";
      repository: string;
      pullNumber: number;
      requester: string;
      /** `/review`; `/review clean` and `/review cancel` are tickets 07/09. */
      command: "/review" | "/review clean" | "/review cancel";
      /** GitHub's comment or delivery id; redelivery of the same one deduplicates. */
      deliveryKey?: string;
    }
  | {
      kind: "pull-request";
      action: PrAction;
      repository: string;
      pullNumber: number;
      sender: string;
      /** Optional workflow-supplied delivery id for deduplication. */
      deliveryKey?: string;
    };

/** What the gate decided for a delivered trigger. */
export type GateEvaluation =
  | { outcome: "start"; deliveryKey: string; request: GateStart }
  | {
      outcome: "refused";
      /** Explanation the requester sees as the check reason. */
      reason: string;
      checkOutcome: RefusalOutcome;
      /** Head SHA for the refused check run; absent when the PR was unreadable. */
      headSha?: string;
      baseSha?: string;
    }
  | {
      /** An in-progress run already covers what was asked. Not a refusal. */
      outcome: "satisfied";
      run: RunDocument;
    }
  | {
      /** A new commit or event was accepted and stored as the pull
       * request's pending request; the host's drain starts it after the
       * active run finishes (newest eligible head, runs coalesced). */
      outcome: "queued";
      deliveryKey: string;
    }
  | {
      /** A pending request exists but its review cannot start yet (named
       * checks outstanding). Re-evaluate with `evaluatePending` later. */
      outcome: "deferred";
      reason: string;
    }
  | { outcome: "duplicate" }
  /** Manual mode: pull-request events request nothing and stay silent. */
  | { outcome: "ignored"; reason: string };

export interface GateStart {
  repository: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  /** Source of the request, recorded on the run document. */
  source: "command" | "automatic";
  /** For command sources: the recorded `/review`. */
  command: "/review";
  /** Who asked (login) when the request came from a command. */
  requester?: string;
  /** Original trigger, for the run document and check summary. */
  triggeredBy: string;
}

/** Fork per-head approval: one record per pull request, newest head wins. */
export interface ForkApprovalRecord {
  repository: string;
  pullNumber: number;
  headSha: string;
  approvedBy: string;
}

/**
 * The gate's newest pending request per pull request, stored while an active
 * run prevents starting (reducer backlog: the waiter picks up the newest
 * eligible requested head next). Commands record the head they approve;
 * automatic requests resolve the head again at start time.
 */
export interface PendingRequestDoc {
  source: "command" | "automatic";
  command?: "/review";
  action?: PrAction;
  requester?: string;
  headSha?: string;
  /**
   * The delivery key of the queued trigger. Recorded durably in the same
   * commit that creates the run, so a redelivery of the same comment or
   * event after the queued run finished is a duplicate, not a second run.
   */
  deliveryKey?: string;
  requestedAt: number;
}

/**
 * Doc value shape: an intersection so the interface properties don't have to
 * conform to the JSON index signature (mirrors run-history.ts).
 */
type GateJsonValueLike =
  | null
  | boolean
  | number
  | string
  | GateJsonValueLike[]
  | { [key: string]: GateJsonValueLike };

export type GateRegistryState = { [key: string]: GateJsonValueLike } & {
  /** Per pull request: one record; only the newest approved head matters. */
  approvals: ForkApprovalRecord[];
  /** Keyed `repo#pr`: the newest pending request per pull request. */
  pendingByPr: Record<string, PendingRequestDoc>;
  /** Delivery dedup keys, pruned to the newest window. */
  delivered: Array<{ key: string; at: number }>;
}

export const GateRegistry = defineDoc<GateRegistryState>({
  kind: "nitpi.gate",
  version: 1,
  scope: "session",
  initial: () => ({ approvals: [], pendingByPr: {}, delivered: [] }),
});

const DELIVERED_WINDOW = 400;
export { DELIVERED_WINDOW };

/**
 * Store one pull request's newest pending request, pruning the delivery key
 * of a request it replaces: coalescing drops the older request (reducer:
 * newest eligible head wins), so its delivery must count as consumed, or a
 * redelivery of it would start a second review.
 */
function storePending(
  gate: GateRegistryState,
  repository: string,
  pullNumber: number,
  pending: PendingRequestDoc,
): void {
  const key = prKey(repository, pullNumber);
  const replaced = gate.pendingByPr[key];
  if (replaced?.deliveryKey && replaced.deliveryKey !== pending.deliveryKey) {
    gate.delivered = [
      ...gate.delivered,
      { key: replaced.deliveryKey, at: Date.now() },
    ].slice(-DELIVERED_WINDOW);
  }
  gate.pendingByPr[key] = pending;
}

export const prKey = (repository: string, pullNumber: number): string => `${repository}#${pullNumber}`;

/**
 * Dedup identity of a delivered trigger. An explicit workflow delivery id
 * (GitHub's delivery GUID) decides alone — that is the production contract
 * (ticket 11 wiring supplies it); without one the composite fallback can
 * conflate distinct triggers that coincide on requester/action/head, so
 * `deliveryKey` should always be supplied in the workflow.
 */
export function eventKeyOf(event: TriggerEvent, headSha?: string): string {
  const pr = prKey(event.repository, event.pullNumber);
  if (event.deliveryKey) return `${pr}:delivery:${event.deliveryKey}`;
  if (event.kind === "comment") {
    return `${pr}:comment:${event.requester}:${event.command}${headSha ? `@${headSha}` : ""}`;
  }
  return `${pr}:${event.action}:${event.sender}:${headSha ?? "head"}`;
}

/** The automatic preset: all four events, no check wait. */
export function automaticPreset(waitChecks?: string[]): AutoModeConfig {
  return {
    mode: "automatic",
    events: { opened: true, reopened: true, synchronize: true, readyForReview: true },
    waitForChecks: waitChecks,
  };
}

/** Manual is the default: the gate subscribes to nothing. */
export function manualMode(): AutoModeConfig {
  return { mode: "manual", events: { opened: false, reopened: false, synchronize: false, readyForReview: false } };
}

export function isEventEnabled(auto: AutoModeConfig, action: PrAction): boolean {
  if (auto.mode !== "automatic") return false;
  const key = action === "ready_for_review" ? "readyForReview" : action;
  return auto.events[key] === true;
}

export function isWriter(level: string | undefined): boolean {
  return level === "write" || level === "admin";
}

interface GatePrBody {
  state?: string;
  draft?: boolean;
  head?: { sha?: string };
  base?: { sha?: string };
  isFork?: boolean;
}

/**
 * Adapt a REST pull-request body to the gate's view. A pull request is a
 * fork pull when its head repository differs from the base repository
 * (GitHub returns `head.repo`/`base.repo` full names); a deleted fork head
 * (no `head.repo`) is treated as a fork — the strict side.
 */
function prFromRest(raw: unknown): GatePrBody {
  const body = (raw ?? {}) as {
    state?: string;
    draft?: boolean;
    head?: { sha?: string; repo?: { full_name?: string } | null };
    base?: { sha?: string; repo?: { full_name?: string } | null };
  };
  const headRepo = body.head?.repo?.full_name;
  const baseRepo = body.base?.repo?.full_name;
  return {
    state: body.state,
    draft: body.draft,
    head: { sha: body.head?.sha },
    base: { sha: body.base?.sha },
    isFork: headRepo === undefined || headRepo !== baseRepo,
  };
}

function isFork(body: GatePrBody): boolean {
  return body.isFork === true;
}

/** Callback the host supplies to verify named checks have completed on a head. */
export type NamedCheckWait = (
  repository: string,
  pullNumber: number,
  headSha: string,
) => Promise<"completed" | string>;

export class TriggerGate {
  constructor(
    private readonly harness: Harness,
    private readonly api: GitHubApi,
    private readonly history: RunHistory,
    private readonly auto: AutoModeConfig,
  ) {}

  /** Entry for workflow subscribers: commands and pull-request events. */
  evaluate(event: TriggerEvent): Promise<GateEvaluation> {
    return event.kind === "comment" ? this.evaluateCommand(event) : this.evaluatePrEvent(event);
  }

  // -- commands ----------------------------------------------------------------

  private async evaluateCommand(event: Extract<TriggerEvent, { kind: "comment" }>): Promise<GateEvaluation> {
    const contextNote = event.command !== "/review" ? event.command : undefined;
    // Commands check the requester first: the same writer check applies to
    // /review, /review clean and /review cancel (tickets 07/09 wire those).
    const permission = await this.api.getCollaboratorPermission(event.repository, event.requester);
    if (permission.status !== 200) {
      return {
        outcome: "refused",
        reason: `cannot read permission for ${event.requester} (HTTP ${permission.status})`,
        checkOutcome: "action_required",
      };
    }
    if (!isWriter((permission.body as { permission?: string }).permission)) {
      return {
        outcome: "refused",
        reason: `${event.requester} is not a repository writer or maintainer; ask one to comment ${contextNote ?? event.command}`,
        checkOutcome: "action_required",
      };
    }

    const pr = await this.api.getPullRequest(event.repository, event.pullNumber);
    if (pr.status !== 200) {
      return {
        outcome: "refused",
        reason: `pull request not found (HTTP ${pr.status})`,
        checkOutcome: "skipped",
      };
    }
    const body = prFromRest(pr.body);
    if (body.state !== "open") {
      return {
        outcome: "refused",
        reason:
          event.command === "/review cancel"
            ? `the pull request is closed; there is no active review to cancel`
            : `the pull request is closed; a review can only be requested while it is open`,
        checkOutcome: "skipped",
        headSha: body.head?.sha,
        baseSha: body.base?.sha,
      };
    }
    const headSha = body.head?.sha ?? "";
    const baseSha = body.base?.sha ?? "";
    if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[0-9a-f]{40}$/i.test(baseSha)) {
      return { outcome: "refused", reason: "pull request SHAs unavailable", checkOutcome: "skipped", headSha, baseSha };
    }

    const deliveryKey = eventKeyOf(event, headSha);
    if (await this.delivered(deliveryKey)) return { outcome: "duplicate" };

    const active = await this.findActiveRunAnyHead(event.repository, event.pullNumber);
    if (active) {
      if (event.command === "/review") {
        // A running review of the same head satisfies the command; a command
        // on a newer head queues behind the active run (coalesced catch-up).
        if (active.subject.headSha === headSha) return { outcome: "satisfied", run: active };
        return this.queueCommand(event, deliveryKey, headSha, isFork(body));
      }
      // /review clean and /review cancel behave later (tickets 07/09); the
      // gate recognises them but their run wiring is not built yet.
      return {
        outcome: "refused",
        reason: `${event.command} is not wired yet (ticket ${event.command === "/review clean" ? "07" : "09"})`,
        checkOutcome: "action_required",
        headSha,
        baseSha,
      };
    }

    if (event.command !== "/review") {
      return {
        outcome: "refused",
        reason: `${event.command} is not wired yet (ticket ${event.command === "/review clean" ? "07" : "09"})`,
        checkOutcome: "action_required",
        headSha,
        baseSha,
      };
    }

    // Fork heads only run with a writer's per-commit approval. A writer's own
    // /review IS the approval; a later push needs a fresh approval.
    if (isFork(body) && !(await this.isForkHeadApproved(event.repository, event.pullNumber, headSha))) {
      await this.recordApproval(event.repository, event.pullNumber, headSha, event.requester);
    }

    return {
      outcome: "start",
      deliveryKey,
      request: {
        source: "command",
        repository: event.repository,
        pullNumber: event.pullNumber,
        baseSha,
        headSha,
        command: "/review",
        requester: event.requester,
        triggeredBy: `${event.requester} commented "${event.command}"`,
      },
    };
  }

  /** Queue a command behind the active run; the drain starts it next. A
   * writer's queued command approves the current head of a fork, too. */
  private async queueCommand(
    event: Extract<TriggerEvent, { kind: "comment" }>,
    deliveryKey: string,
    headSha: string,
    fork: boolean,
  ): Promise<GateEvaluation> {
    await this.commitGateState((gate) => {
      if (fork) {
        gate.approvals = [
          ...gate.approvals.filter((a) => !(a.repository === event.repository && a.pullNumber === event.pullNumber)),
          { repository: event.repository, pullNumber: event.pullNumber, headSha, approvedBy: event.requester },
        ];
      }
      storePending(gate, event.repository, event.pullNumber, {
        source: "command",
        command: "/review",
        requester: event.requester,
        headSha,
        deliveryKey,
        requestedAt: Date.now(),
      });
    });
    return { outcome: "queued", deliveryKey };
  }

  // -- automatic events --------------------------------------------------------

  private async evaluatePrEvent(event: Extract<TriggerEvent, { kind: "pull-request" }>): Promise<GateEvaluation> {
    // Manual mode is the default; nothing subscribes and nothing is posted.
    if (this.auto.mode !== "automatic") {
      return { outcome: "ignored", reason: "manual mode: pull-request events start no review" };
    }
    if (!isEventEnabled(this.auto, event.action)) {
      return { outcome: "ignored", reason: `automatic review for "${event.action}" is not enabled` };
    }

    const pr = await this.api.getPullRequest(event.repository, event.pullNumber);
    if (pr.status !== 200) {
      return {
        outcome: "refused",
        reason: `pull request not found (HTTP ${pr.status})`,
        checkOutcome: "skipped",
      };
    }
    const body = prFromRest(pr.body);
    const headSha = body.head?.sha ?? "";
    const baseSha = body.base?.sha ?? "";
    if (body.state !== "open") {
      // Automatic triggers require an open, reviewable PR. Closed PRs are
      // refused with an explanation; the refusal lands as a skipped check.
      return {
        outcome: "refused",
        reason: `the pull request is closed; automatic reviews start only while it is open`,
        checkOutcome: "skipped",
        headSha,
        baseSha,
      };
    }
    // Drafts get no automatic review (they wait for ready_for_review).
    if (body.draft === true) {
      return {
        outcome: "refused",
        reason: `the pull request is a draft; automatic reviews start when it is ready for review`,
        checkOutcome: "action_required",
        headSha,
        baseSha,
      };
    }
    if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[0-9a-f]{40}$/i.test(baseSha)) {
      return { outcome: "refused", reason: "pull request SHAs unavailable", checkOutcome: "skipped", headSha, baseSha };
    }

    const deliveryKey = eventKeyOf(event, headSha);
    if (await this.delivered(deliveryKey)) return { outcome: "duplicate" };

    // Fork heads: automatic events never approve; no fork head is reviewed
    // in any mode without a writer's per-commit approval.
    if (isFork(body) && !(await this.isForkHeadApproved(event.repository, event.pullNumber, headSha))) {
      return {
        outcome: "refused",
        reason: `fork head ${headSha.slice(0, 12)} has not been approved by a writer; a maintainer must comment /review on it first`,
        checkOutcome: "action_required",
        headSha,
        baseSha,
      };
    }

    // An active run holds the request; the newest eligible head is picked up
    // next after it finishes. Named checks always route through the pending
    // request: the drain re-evaluates until they have completed on the head.
    if ((this.auto.waitForChecks?.length ?? 0) > 0 || (await this.findActiveRunAnyHead(event.repository, event.pullNumber))) {
      await this.commitGateState((gate) => {
        storePending(gate, event.repository, event.pullNumber, {
          source: "automatic",
          action: event.action,
          deliveryKey,
          requestedAt: Date.now(),
        });
      });
      return { outcome: "queued", deliveryKey };
    }

    // An automatic review runs at most once per head: a run for this head
    // (any status) already covers it.
    if (await this.findRunAnyStatus(event.repository, event.pullNumber, headSha)) {
      return { outcome: "ignored", reason: "a run for this head already exists" };
    }

    return {
      outcome: "start",
      deliveryKey,
      request: {
        source: "automatic",
        repository: event.repository,
        pullNumber: event.pullNumber,
        baseSha,
        headSha,
        command: "/review",
        triggeredBy: `pull-request event "${event.action}" by ${event.sender}`,
      },
    };
  }

  // -- pending request drain ---------------------------------------------------

  /**
   * Decide whether the pull request's newest pending request may start now,
   * after the active run that held it finished. Consumes the pending
   * request for every verdict except `start` — whose consumption commits
   * with the run creation in the host — and `deferred` (named checks
   * outstanding), which keeps the request durable.
   */
  async evaluatePending(
    repository: string,
    pullNumber: number,
    namedCheckWait: NamedCheckWait | undefined,
  ): Promise<GateEvaluation> {
    const key = prKey(repository, pullNumber);
    const gate = await this.snapshot();
    const pending = gate.pendingByPr[key];
    if (!pending) return { outcome: "ignored", reason: "no pending request" };

    const pr = await this.api.getPullRequest(repository, pullNumber);
    if (pr.status !== 200) {
      await this.consumePending(key);
      return { outcome: "refused", reason: `pull request not found (HTTP ${pr.status})`, checkOutcome: "skipped" };
    }
    const body = prFromRest(pr.body);
    const headSha = body.head?.sha ?? "";
    const baseSha = body.base?.sha ?? "";
    const clearAnd =
      async (evaluation: Extract<GateEvaluation, { outcome: "refused" | "ignored" | "duplicate" }>) => {
        await this.consumePending(key);
        return evaluation satisfies GateEvaluation;
      };

    if (body.state !== "open") {
      // The holding run finished; the PR no longer qualifies. Drop the
      // pending request (spec: closing drops the pending request).
      return clearAnd({
        outcome: "refused",
        reason: "the pull request is closed; the pending review request is dropped",
        checkOutcome: "skipped",
        headSha,
        baseSha,
      });
    }
    if (pending.source === "automatic") {
      if (body.draft === true) {
        return clearAnd({
          outcome: "refused",
          reason: "the pull request became a draft; the automatic review request is dropped",
          checkOutcome: "action_required",
          headSha,
          baseSha,
        });
      }
      const action: PrAction = pending.action ?? "synchronize";
      if (this.auto.mode !== "automatic" || !isEventEnabled(this.auto, action)) {
        return clearAnd({
          outcome: "refused",
          reason: `automatic review for "${action}" is no longer enabled; the pending request is dropped`,
          checkOutcome: "skipped",
          headSha,
          baseSha,
        });
      }
    }

    if (!/^[0-9a-f]{40}$/i.test(headSha) || !/^[0-9a-f]{40}$/i.test(baseSha)) {
      return clearAnd({
        outcome: "refused",
        reason: "pull request SHAs unavailable",
        checkOutcome: "skipped",
        headSha,
        baseSha,
      });
    }

    if (pending.source === "command") {
      // The queued command's head must still be the current head; a later
      // push makes the recorded request stale (reducer: queued head matches,
      // or nothing starts).
      if (pending.headSha && pending.headSha !== headSha) {
        return clearAnd({
          outcome: "refused",
          reason: `the queued /review requested head ${pending.headSha.slice(0, 12)} but the pull request moved to ${headSha.slice(0, 12)}; request a review of the new head`,
          checkOutcome: "action_required",
          headSha,
          baseSha,
        });
      }
      // The requester must still hold write access when the command lands.
      if (pending.requester) {
        const permission = await this.api.getCollaboratorPermission(repository, pending.requester);
        if (permission.status !== 200) {
          return clearAnd({
            outcome: "refused",
            reason: `cannot read permission for ${pending.requester} (HTTP ${permission.status})`,
            checkOutcome: "action_required",
            headSha,
            baseSha,
          });
        }
        if (!isWriter((permission.body as { permission?: string }).permission)) {
          return clearAnd({
            outcome: "refused",
            reason: `${pending.requester} is not a repository writer or maintainer; the queued /review is refused`,
            checkOutcome: "action_required",
            headSha,
            baseSha,
          });
        }
      }
    } else if (isFork(body)) {
      // Automatic fork reviews re-check the approval against the current head.
      if (!(await this.isForkHeadApproved(repository, pullNumber, headSha))) {
        return clearAnd({
          outcome: "refused",
          reason: `fork head ${headSha.slice(0, 12)} is not approved by a writer; the automatic review is refused`,
          checkOutcome: "action_required",
          headSha,
          baseSha,
        });
      }
    }

    // Named checks must have completed on the head before an automatic
    // review starts (keep the pending request while they run).
    if (namedCheckWait && pending.source === "automatic") {
      const verdict = await namedCheckWait(repository, pullNumber, headSha);
      if (verdict !== "completed") {
        return { outcome: "deferred", reason: `waiting for checks: ${verdict}` };
      }
    }

    // An automatic review for this head already ran (any status): one
    // delivery starts at most one run per head.
    if (pending.source === "automatic" && (await this.findRunAnyStatus(repository, pullNumber, headSha))) {
      return clearAnd({ outcome: "ignored", reason: "a run for this head already exists" });
    }

    if (pending.source === "automatic") {
      return {
        outcome: "start",
        deliveryKey: pending.deliveryKey ?? `pending:${key}:${headSha}`,
        request: { source: "automatic", repository, pullNumber, baseSha, headSha, command: "/review", triggeredBy: "automatic review of the newest eligible head" },
      };
    }
    return {
      outcome: "start",
      deliveryKey: pending.deliveryKey ?? `pending:${key}:${pending.headSha ?? headSha}`,
      request: {
        source: "command",
        repository,
        pullNumber,
        baseSha,
        headSha,
        command: pending.command ?? "/review",
        requester: pending.requester,
        triggeredBy: `${pending.requester ?? "a writer"} commented "${pending.command ?? "/review"}" (queued)`,
      },
    };
  }

  /** Discard the pending request; used when a start was refused up front. */
  async consumePending(key: string): Promise<void> {
    await this.commitGateState((gate) => {
      delete gate.pendingByPr[key];
    });
  }

  // -- fork approvals ------------------------------------------------------------

  async isForkHeadApproved(repository: string, pullNumber: number, headSha: string): Promise<boolean> {
    const gate = await this.snapshot();
    return gate.approvals.some(
      (a) => a.repository === repository && a.pullNumber === pullNumber && a.headSha === headSha,
    );
  }

  private async recordApproval(repository: string, pullNumber: number, headSha: string, approvedBy: string) {
    await this.commitGateState((gate) => {
      gate.approvals = [
        ...gate.approvals.filter((a) => !(a.repository === repository && a.pullNumber === pullNumber)),
        { repository, pullNumber, headSha, approvedBy },
      ];
    });
  }

  // -- internals -------------------------------------------------------------------

  private async snapshot(): Promise<GateRegistryState> {
    const doc = await this.harness.snapshot(GateRegistry, TODO_CONTEXT);
    return doc ?? { approvals: [], pendingByPr: {}, delivered: [] };
  }

  private commitGateState(mutate: (gate: GateRegistryState) => void): Promise<unknown> {
    return this.harness.commit(async (tx) => {
      const doc = await tx.doc(GateRegistry);
      mutate(doc);
    }, TODO_CONTEXT);
  }

  private async delivered(deliveryKey: string): Promise<boolean> {
    const gate = await this.snapshot();
    return gate.delivered.some((d) => d.key === deliveryKey);
  }

  private async findActiveRunAnyHead(
    repository: string,
    pullNumber: number,
  ): Promise<RunDocument | undefined> {
    return (await this.history.allRuns(TODO_CONTEXT)).find(
      (r) =>
        r.subject.repository === repository &&
        r.subject.pullNumber === pullNumber &&
        r.checkStatus === "in progress",
    );
  }

  private async findRunAnyStatus(
    repository: string,
    pullNumber: number,
    headSha: string,
  ): Promise<RunDocument | undefined> {
    return (await this.history.allRuns(TODO_CONTEXT)).find(
      (r) =>
        r.subject.repository === repository &&
        r.subject.pullNumber === pullNumber &&
        r.subject.headSha === headSha,
    );
  }

}

export type { Tx };
