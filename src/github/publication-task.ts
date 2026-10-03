/**
 * Durable publication child task (ticket 05): `nitpi.publish`, owned by the
 * review task (`nitpi.review`).
 *
 * A crash or network failure at the wrong moment never posts a review twice,
 * and a failed publication can be retried without paying for the model
 * review again. The task reads the run document's frozen final review and
 * recorded matches, reconciles every recorded-but-unconfirmed operation
 * against GitHub's actual state (adopt when it landed, retry when the
 * listing proves it did not, stay unknown when the listing cannot be read),
 * and performs the remaining writes through the ledgered publisher.
 *
 * The task is NOT marked `replay: "safe"` anywhere: retry safety comes from
 * the operation ledger plus reconciliation, never from a tool flag.
 *
 * Outcomes:
 * - `published` — every write confirmed; the run document moves to
 *   `published` and the check succeeds.
 * - `failed` — a known publication failure (auth, permission, anchor,
 *   rate-limit exhaustion). The completed final review stays on the run
 *   document; a later trigger resumes publication only, with zero new model
 *   calls.
 * - `unknown` — a write's outcome could not be established; the check is not
 *   success and reconciliation is retried later instead of creating again.
 */
import type { Context } from "@earendil-works/chord";
import { defineTask } from "@earendil-works/pi-durable";
import { PublicationLedger } from "./ledger.js";
import { Publisher, WriteOutcomeUnknown, type PublishError, type PublishLedgerHooks } from "./publisher.js";
import { reviewTaskDeps } from "../review-host/review-task.js";
import type { RunDocument } from "../review-host/run-history.js";

export interface PublishTaskInput {
  readonly runId: string;
}

export interface PublishCheckpoint {
  readonly phase: "publish";
}

export type PublishTaskResult =
  | { readonly status: "published"; readonly reviewId: number; readonly commentIds: number[] }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "unknown"; readonly reason: string };

export const publicationTask = defineTask<PublishTaskInput, PublishCheckpoint, PublishTaskResult, object>({
  name: "nitpi.publish",
  version: 1,
  initial: () => ({ phase: "publish" as const }),
  phases: {
    publish: async (_task, runtime, context) => {
      const host = reviewTaskDeps();
      const runDoc = await host.runHistory.findRun(_task.input.runId, context);
      if (!runDoc?.finalReview) {
        throw new Error("publication started without a frozen final review");
      }

      const ledger = new PublicationLedger(host.runHistory.harness);
      const hooks: PublishLedgerHooks = {
        ledger,
        runId: runDoc.runId,
        subject: runDoc.subject,
        context,
        // Durable pacing by default: waits ride the harness clock, so a
        // rate-limit wait survives a runner restart without re-spending a
        // write attempt. Tests inject a recording clock instead (nothing
        // ever really sleeps in the suite).
        sleep: host.publicationSleep ?? ((ms) => runtime.sleep(runtime.now() + ms, context)),
      };
      const publisher = new Publisher(host.api, hooks);

      try {
        const published = await publisher.publish(
          runDoc,
          runDoc.finalReview,
          runDoc.findings ?? [],
          runDoc.earlierComments ?? [],
          runDoc.matches ?? [],
          context.abortSignal,
        );
        await commitRunPublication(host, runDoc.runId, context, (run) => ({
          ...run,
          publication: { reviewId: published.reviewId, commentIds: published.commentIds },
          publicationOutcome: "published" as const,
          matchRejections: published.rejections,
          phase: "published",
          checkStatus: "success",
          checkDetail: `published review ${published.reviewId} with ${runDoc.findings?.length ?? 0} finding(s)`,
        }), { missing: "throw" });
        await publisher.checkSuccess(runDoc.subject, runDoc.findings?.length ?? 0);
        await runtime.commit(
          () => ({
            status: "terminal" as const,
            outcome: {
              status: "completed" as const,
              result: { status: "published", reviewId: published.reviewId, commentIds: published.commentIds },
            },
          }) as const,
          context,
        );
      } catch (error) {
        if (runtime.signal.aborted) return; // Killed runner records nothing; the durable checkpoint stands.
        const reason = error instanceof Error ? error.message : String(error);
        const unknown = error instanceof WriteOutcomeUnknown;
        await commitRunPublication(host, runDoc.runId, context, (run) => ({
          ...run,
          publicationOutcome: unknown ? "unknown" : "failed",
          checkStatus: "failure",
          checkDetail: unknown
            ? `publication outcome unknown: ${reason} (reconciled on the next retry, never re-created blind)`
            : `publication failed: ${reason} (retry publishes the completed review with no new model calls)`,
          error: reason,
        }), { missing: "skip", tolerateFailure: true });
        if (unknown) {
          await publisher.checkIncomplete(runDoc.subject, `publication outcome unknown: ${reason}`);
        } else {
          await publisher.checkFailure(runDoc.subject, `publication failed: ${reason}`);
        }
        await runtime.commit(
          () =>
            ({
              status: "terminal" as const,
              outcome: { status: "failed" as const, error: { message: reason } },
            }) as const,
          context,
        );
      }
    },
  },
  abort: async (task, runtime, context) => {
    // The abort protocol pi-durable requires: an aborted publication
    // publishes nothing and commits a terminal outcome. Any write whose
    // outcome is already unknown stays unknown in the ledger; ticket 09
    // refines the cancellation fence and recovery rules around this.
    await commitRunPublication(reviewTaskDeps(), task.input.runId, context, (run) => ({
      ...run,
      checkStatus: "failure",
      checkDetail: run.checkDetail ?? "publication canceled before completion",
    }), { missing: "skip", tolerateFailure: true });
    await runtime.commit(
      () => ({ status: "terminal" as const, outcome: { status: "aborted" as const, reason: "publication canceled" } }) as const,
      context,
    );
  },
  hooks: {},
});

/**
 * Record the publication outcome on the run document in one transaction.
 * The `policy` decides the two failure postures the outcome paths need: the
 * success path throws when the run is unreadable (storage down is the
 * execution failure itself), and the failure/abort paths skip a missing run
 * and swallow storage faults so the original reason is never masked.
 */
async function commitRunPublication(
  host: ReturnType<typeof reviewTaskDeps>,
  runId: string,
  context: Context,
  mutate: (run: RunDocument) => RunDocument,
  policy: { missing: "throw" | "skip"; tolerateFailure?: boolean },
): Promise<void> {
  try {
    await host.runHistory.harness.commit(async (tx) => {
      const current = await host.runHistory.findRunInTx(tx, runId);
      if (!current) {
        if (policy.missing === "skip") return;
        throw new Error(`run ${runId} missing while recording publication`);
      }
      await host.runHistory.record(tx, mutate(current));
    }, context);
  } catch (error) {
    if (policy.tolerateFailure) return; // The task still fails with the reason; storage recovery reopens it.
    throw error;
  }
}

export type { PublishError };
