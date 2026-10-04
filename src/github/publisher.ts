/**
 * GitHub publication (spec: Publisher + tickets 01 and 04).
 *
 * One review carries the maintained summary; each finding lives in one
 * review-comment thread. The first publication creates that review with
 * `event: COMMENT`, `commit_id` = reviewed head SHA and one inline comment
 * per finding. A rerun syncs instead of duplicating:
 *
 * - the summary review's body is PATCHed (exactly one bot summary is current;
 *   when several bot reviews already exist, the newest carries the summary —
 *   submitted reviews cannot be deleted through the REST API, and stray
 *   summaries are reconciled by ticket 05);
 * - a finding at the same anchor updates its existing comment body;
 * - a recurring finding at a resolved thread's anchor reopens the thread
 *   (GraphQL `unresolveReviewThread`) and updates it;
 * - a moved finding marks the old comment superseded (keeping its
 *   discussion) and posts a replacement at the new anchor;
 * - an earlier finding a complete current-head review omits has its thread
 *   resolved (GraphQL `resolveReviewThread`). Threads rooted at other
 *   people's comments are never touched; a thread containing human replies
 *   may be resolved only because its root is a bot finding's thread — the
 *   reply text itself is never edited or deleted.
 * - every model-supplied comment ID is validated against the pull request,
 *   bot ownership, root-ness and superseded-ness before any write; rejected
 *   IDs are never acted on.
 *
 * This phase only runs after a complete final review froze: parse failures
 * fail the run before publication, so an incomplete review never resolves
 * anything.
 *
 * Anchors are assumed valid on the model side (validation is ticket 02); an
 * anchor GitHub rejects (422) fails with an explicit reason and is not
 * retried here. Publication idempotency and reconciliation are ticket 05.
 */
import type { InlineLocation, ReviewFinding, DiffSide } from "../review-host/artifact.js";
import type { Context } from "@earendil-works/chord";
import type { RunDocument } from "../review-host/run-history.js";
import {
  validateMatches,
  SUPERSEDED_MARKER_PREFIX,
  type FindingMatch,
  type MatchRejection,
  type PublishedComment,
  type ValidMatch,
} from "../review-host/matching.js";
import {
  PublicationLedger,
  bodyWithMarker,
  extractMarkers,
  nextCreateOrdinal,
  operationKey,
  findingMarker,
  recreateOperationKey,
  summaryMarker,
  type PublicationIntent,
  type PublicationOp,
  type PublicationRemote,
} from "./ledger.js";
import { isRateLimited, rateLimitDelayMs, retryAfterMs } from "./retry.js";
import {
  readAllReviewComments,
  readAllReviews,
  readThreadPages,
  matchesPublished,
  recordMatchesRemote,
  type PaginatedRead,
  type ReconcileReview,
} from "./publication-reads.js";

/** Error thrown when a write's outcome could not be determined either way
 * (GitHub may have accepted it; the response never arrived). Reconciliation —
 * not a blind create retry — decides what happened. */
export class WriteOutcomeUnknown extends Error {
  constructor(message: string) {
    super(`${message} — its outcome stays unknown; reconciliation is retried later instead of creating again`);
    this.name = "WriteOutcomeUnknown";
  }
}

/** Ledger the publisher records every intended write into before sending. */
export type PublishLedgerHooks = {
  ledger: PublicationLedger;
  runId: string;
  /** The reviewed subject every operation belongs to. */
  subject: RunDocument["subject"];
  /** Injectable pacing for rate-limit waits (tests pass clock-advancing). */
  sleep: (ms: number) => Promise<void>;
  context: Context;
};

/** The result of reconciling one write against GitHub's actual state. */
export type ReconcileResult =
  | { status: "confirmed"; remote: PublicationRemote }
  | { status: "not_found" }
  | { status: "retry" }
  | { status: "unknown"; detail?: string };

/** The listing-based reconciliation skeleton shared by every write kind
 * (ticket 05): adopt the matching object when the listing shows it, prove
 * absence when a complete listing lacks it, stay unknown when the listing
 * itself cannot be read. */
function reconcileListing<T>(
  read: () => Promise<PaginatedRead<T>>,
  what: string,
  match: (item: T) => PublicationRemote | undefined,
): Promise<ReconcileResult> {
  return read().then((result) => {
    if (!result.ok) return { status: "unknown" as const, detail: `${what} failed with HTTP ${result.status}` };
    for (const item of result.items) {
      const remote = match(item);
      if (remote) return { status: "confirmed" as const, remote };
    }
    return { status: "not_found" as const };
  });
}

/** Bounded reconciliation rounds after a lost response. */
const MAX_LOST_RESPONSE_ROUNDS = 3;
/** Bounded paced retries for one rate-limited write (exponential waits). */
const MAX_RATE_LIMIT_RESPONSES = 4;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A body rewritten with every given marker comment appended (missing ones
 * only): updated bodies keep every earlier marker so each run's unconfirmed
 * operation can still find its object after a later run's update. */
function bodyWithAllMarkers(body: string, markers: readonly string[]): string {
  let result = body;
  for (const marker of markers) result = bodyWithMarker(result, marker);
  return result;
}

/** The publisher's superseded banner as reconciliation sees it (the first
 * line must still be the banner for `isSupersededComment`'s startsWith). */
function isSupersededCommentText(body: string): boolean {
  return body.startsWith(SUPERSEDED_MARKER_PREFIX);
}

/** Typed subset of the GitHub REST + GraphQL endpoints the reviewer host uses. */
export interface GitHubApi {
  createReview(
    repository: string,
    pullNumber: number,
    payload: {
      commit_id: string;
      event: "COMMENT";
      body: string;
      comments: Array<{
        path: string;
        side: "LEFT" | "RIGHT";
        line: number;
        start_side?: "LEFT" | "RIGHT";
        start_line?: number;
        body: string;
      }>;
    },
    signal?: AbortSignal,
  ): Promise<HttpResponse>;
  /** Update a review's summary body (the maintained summary). */
  updateReview(
    repository: string,
    pullNumber: number,
    reviewId: number,
    payload: { body: string },
  ): Promise<HttpResponse>;
  /** All submitted reviews on the pull request. `query` pages the listing
   * (ticket 05's reconciliation paginates). */
  listReviews(repository: string, pullNumber: number, query?: { page?: number; perPage?: number }): Promise<HttpResponse>;
  /** Post one review comment on the pull request (its own thread). */
  createReviewComment(
    repository: string,
    pullNumber: number,
    payload: {
      commit_id: string;
      path: string;
      side: "LEFT" | "RIGHT";
      line: number;
      start_side?: "LEFT" | "RIGHT";
      start_line?: number;
      body: string;
    },
    signal?: AbortSignal,
  ): Promise<HttpResponse>;
  /** All review comments on the pull request (any author). `query` pages
   * the listing (ticket 05's reconciliation paginates). */
  listReviewComments(repository: string, pullNumber: number, query?: { page?: number; perPage?: number }): Promise<HttpResponse>;
  /** Update one review comment's body. */
  updateReviewComment(
    repository: string,
    commentId: number,
    payload: { body: string },
    signal?: AbortSignal,
  ): Promise<HttpResponse>;
  createCheckRun(
    repository: string,
    payload:
      | { name: string; head_sha: string; status: "in_progress"; output: { title: string; summary: string } }
      | {
          name: string;
          head_sha: string;
          status: "completed";
          conclusion: "success" | "failure" | "neutral" | "skipped" | "action_required" | "cancelled";
          output: { title: string; summary: string };
        },
  ): Promise<HttpResponse>;
  /** The identity publishing writes as — the reviewer bot. */
  getAuthenticatedUser(): Promise<HttpResponse>;
  /** GraphQL for the review-thread subset: listing, resolve, unresolve. */
  graphql(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: { data?: unknown; errors?: Array<{ message: string }> } }>;
  /** Trigger-gate inputs (minimal gate for ticket 01; full gate is ticket 03). */
  getPullRequest(repository: string, pullNumber: number): Promise<HttpResponse>;
  getCollaboratorPermission(
    repository: string,
    username: string,
  ): Promise<HttpResponse>;
  /**
   * Check runs at one commit (named-check wait for automatic reviews,
   * ticket 03). Undefined when the transport has no such route.
   */
  listCheckRunsForHead?(repository: string, headSha: string): Promise<{ status: number; body: unknown }>;
  /**
   * The pull request's unified diff (base→head), the pinned diff anchor
   * validation checks against (ticket 02). Served with the `diff` media type.
   */
  getPullRequestDiff(repository: string, pullNumber: number): Promise<{ status: number; body: string }>;
}

/** REST response shape used by the publisher. */
export interface HttpResponse {
  status: number;
  body: unknown;
  /** Response headers (lower-cased), kept for `Retry-After` pacing. */
  headers?: Record<string, string>;
}

export interface PublishedResult {
  reviewId: number;
  commentIds: number[];
  /** Model-supplied IDs rejected at publication, with reasons. */
  rejections: MatchRejection[];
}

const CHECK_NAME = "nitpi / review";

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

export function renderSummary(run: RunDocument, finalReview: string, findingCount: number): string {
  const plural = findingCount === 1 ? "finding" : "findings";
  const summary = [
    `**Reviewed commit:** \`${run.subject.headSha}\``,
    `**Outcome:** complete review with ${findingCount} ${plural}`,
    findingCount === 0 ? "No findings. The check succeeds on a complete review regardless of findings." : "",
    "",
    finalReview,
  ]
    .filter(Boolean)
    .join("\n\n");
  return summary;
}

/** Body of an earlier comment whose finding moved: marked superseded, with
 * the original text kept so the old discussion keeps its context. */
function supersededBody(earlierBody: string, movedTo: InlineLocation): string {
  return [
    `${SUPERSEDED_MARKER_PREFIX} this finding now anchors at \`${movedTo.path} | ${movedTo.side} | ${movedTo.line}\` — the replacement comment carries the current text. This thread is kept for its discussion.`,
    "",
    earlierBody,
  ].join("\n");
}

/** Login that wrote a review or comment, from the REST `user.login` shape. */
function authorLogin(raw: { user?: { login?: string } }): string {
  return raw.user?.login ?? "";
}

interface ThreadInfo {
  threadId: string;
  isResolved: boolean;
}

export class Publisher {
  constructor(
    readonly api: GitHubApi,
    private readonly ledgerHooks?: PublishLedgerHooks,
  ) {}

  async checkInProgress(subject: RunDocument["subject"], stage: string): Promise<void> {
    await this.createCheck(subject, {
      status: "in_progress" as const,
      output: {
        title: "Review in progress",
        summary: `Reviewing ${subject.headSha.slice(0, 12)} · stage: ${stage}`,
      },
    }, "start");
  }

  /** The login that publishes writes as — model-supplied IDs are validated
   * against it (ticket 04: bot ownership). */
  async botLogin(): Promise<string> {
    const response = await this.api.getAuthenticatedUser();
    this.ensureStatus(response, 200, "identifying the reviewer bot");
    const login = (response.body as { login?: string }).login;
    if (!login) throw new PublishError("the authenticated user has no login");
    return login;
  }

  /** All review comments on the pull request (any author), read with
   * pagination (ticket 05). This is the matching turn's input snapshot. */
  async listPublishedComments(subject: RunDocument["subject"]): Promise<PublishedComment[]> {
    const read = await readAllReviewComments(this.api, subject.repository, subject.pullNumber);
    if (!read.ok) {
      throw new PublishError(`listing review comments failed with HTTP ${read.status}`);
    }
    return read.items.map((item) => ({
      id: item.id,
      path: item.path,
      side: item.side as DiffSide,
      line: item.line,
      body: item.body,
      author: item.authorLogin,
      ...(item.inReplyToId !== undefined ? { inReplyToId: item.inReplyToId } : {}),
    }));
  }

  /** The bot's summary review for THIS run: the review whose body carries
   * this run's summary marker. Falls back to the bot's newest review when no
   * marker is present (runs published before ticket 05). When it exists, a
   * rerun PATCHes it instead of adding another summary. A recorded-but-
   * unconfirmed create operation whose object is on GitHub is adopted here:
   * the durable intent gets its remote ID without a second create. Reads
   * with pagination (ticket 05). */
  private async botSummaryReview(
    subject: RunDocument["subject"],
    botLogin: string,
    runId: string,
  ): Promise<{ id: number; body: string } | undefined> {
    const read = await readAllReviews(this.api, subject.repository, subject.pullNumber);
    if (!read.ok) {
      throw new PublishError(`listing reviews failed with HTTP ${read.status}`);
    }
    const marker = summaryMarker(runId);
    let newest: { id: number; body: string } | undefined;
    for (const review of read.items) {
      // Only the reviewer bot's reviews are summary candidates (ticket 04:
      // other people's comments are never touched).
      if (review.authorLogin !== botLogin) continue;
      const candidate = { id: review.id, body: review.body };
      if (matchesPublished(review, botLogin, subject.headSha, [marker])) {
        await this.adoptRecordedCreate(runId, candidate, review, botLogin);
        return candidate;
      }
      if (!newest || review.id > newest.id) newest = candidate;
    }
    return newest;
  }

  /** Adopt the run's recorded-but-unconfirmed create-review operation when
   * the review it intended is on GitHub (marker, author, reviewed subject). */
  private async adoptRecordedCreate(
    runId: string,
    review: { id: number; body: string },
    read: ReconcileReview,
    botLogin: string,
  ): Promise<void> {
    const hooks = this.ledgerHooks;
    if (!hooks) return;
    const opKey = operationKey("create-review", runId, "summary");
    const op = await hooks.ledger.op(opKey, hooks.context);
    if (!op || op.state === "confirmed") return;
    if (!recordMatchesRemote(op, read, botLogin)) return;
    const inlineIds = read.commentIds ?? [];
    await hooks.ledger.confirmFromState(opKey, { reviewId: review.id, commentIds: inlineIds }, hooks.context);
  }

  /** GraphQL thread state keyed by the database ID of any comment in the
   * thread, read with pagination (ticket 05: list and paginate). An
   * unreadable thread listing fails the publication with a reason. */
  private async loadThreadMap(subject: RunDocument["subject"]): Promise<Map<number, ThreadInfo>> {
    const read = await readThreadPages(this.api, subject.repository, subject.pullNumber);
    if (!read.ok) {
      throw new PublishError(`the review-threads listing failed with HTTP ${read.status}`);
    }
    const map = new Map<number, ThreadInfo>();
    for (const thread of read.items) {
      for (const comment of thread.comments.nodes) {
        map.set(comment.databaseId, { threadId: thread.id, isResolved: thread.isResolved });
      }
    }
    return map;
  }

  private async setThreadResolved(
    subject: RunDocument["subject"],
    threadId: string,
    resolved: boolean,
    runId: string,
  ): Promise<void> {
    const mutation = resolved
      ? `mutation($input: ResolveReviewThreadInput!) {
  resolveReviewThread(input: $input) { thread { id isResolved } }
}`
      : `mutation($input: UnresolveReviewThreadInput!) {
  unresolveReviewThread(input: $input) { thread { id isResolved } }
}`;
    await this.runLedgered({
      intent: resolved ? "resolve-thread" : "unresolve-thread",
      subjectKey: `thread-${threadId}`,
      // GraphQL mutations carry no body to mark; the record's payload
      // (threadId + intended state) is the reconciliation input.
      marker: "",
      payload: { threadId, resolved },
      runId,
      send: () => this.api.graphql(mutation, { input: { threadId } }),
      ok: (response) => {
        const errors = response.body.errors;
        if (response.status !== 200 || errors?.length) {
          return { ok: false, reason: `${resolved ? "resolveReviewThread" : "unresolveReviewThread"} failed: ${errors?.[0]?.message ?? `HTTP ${response.status}`}` };
        }
        return { ok: true, remote: {} };
      },
      reconcile: async () => {
        const read = await readThreadPages(this.api, subject.repository, subject.pullNumber);
        if (!read.ok) {
          return { status: "unknown" as const, detail: `the review-threads listing failed with HTTP ${read.status}` };
        }
        const thread = read.items.find((t) => t.id === threadId);
        if (!thread) return { status: "not_found" as const };
        if (thread.isResolved === resolved) return { status: "confirmed" as const, remote: {} };
        return { status: "retry" as const };
      },
    });
  }

  /**
   * Publish one advisory review for the reviewed head, keeping the pull
   * request's threads in sync with this run's final review. `earlier` is the
   * review-comment snapshot the matching turn saw; `rawMatches` are the
   * model's assignments, validated here before anything is acted on.
   *
   * Ticket 05: every write is durable-idiempotent. Before each GitHub write
   * the publisher commits an operation key (logical finding, reviewed
   * subject, intended change) and the payload; the remote ID is recorded
   * once GitHub confirms. A response that never arrives is reconciled
   * against GitHub's actual state — the object adopted when it landed, the
   * write retried when the listing proves it did not, and
   * `WriteOutcomeUnknown` raised when neither can be established. 403/429
   * responses wait out `Retry-After` (at least one minute without it),
   * backing off exponentially; auth, permission and anchor errors fail once
   * with a reason.
   */
  async publish(
    run: RunDocument,
    finalReview: string,
    findings: ReviewFinding[],
    earlier: PublishedComment[],
    rawMatches: FindingMatch[],
    signal?: AbortSignal,
  ): Promise<PublishedResult> {
    const botLogin = await this.botLogin();
    const { matches: validMatches, rejections } = validateMatches(rawMatches, earlier, botLogin);
    const subject = run.subject;
    const runId = run.runId;

    // Fresh live state for write decisions (ticket 05): a comment the
    // matching snapshot knew that GitHub no longer has was deleted by hand —
    // reconciled against this listing before anything is recreated. With the
    // ledger installed the listing always runs: recovery reconciles recorded
    // operations against it before any write.
    const liveComments =
      earlier.length > 0 || this.ledgerHooks !== undefined
        ? await this.listPublishedComments(subject)
        : earlier;
    const liveById = new Map(liveComments.map((c) => [c.id, c]));

    // One maintained summary: update the bot's review for this run when it
    // exists (marker match, ticket 05), else the newest bot review (runs
    // published before markers did).
    const summaryReview = await this.botSummaryReview(subject, botLogin, runId);
    // Sync mode when the run must not blanket-post findings inline: a bot
    // summary already exists, or earlier bot comments exist to match against
    // (even when the summary review is gone, its replacements may remain).
    const sync = summaryReview !== undefined || earlier.length > 0;
    let reviewId: number;
    let inlineIds: number[] = [];
    if (summaryReview) {
      const summaryBody = this.ledgerHooks
        ? bodyWithMarker(renderSummary(run, finalReview, findings.length), summaryMarker(runId))
        : renderSummary(run, finalReview, findings.length);
      reviewId = summaryReview.id;
      await this.runLedgered({
        intent: "update-review",
        subjectKey: "summary",
        marker: summaryMarker(runId),
        payload: { body: summaryBody },
        runId,
        send: () =>
          this.api.updateReview(subject.repository, subject.pullNumber, summaryReview.id, { body: summaryBody }),
        ok: (response) =>
          response.status === 200
            ? { ok: true, remote: { reviewId: summaryReview.id } }
            : { ok: false, reason: `updating the summary review ${summaryReview.id} failed with HTTP ${response.status}: ${describeBody(response.body)}` },
        reconcile: () =>
          reconcileListing(
            () => readAllReviews(this.api, subject.repository, subject.pullNumber),
            "listing reviews",
            (r) =>
              r.id === summaryReview.id &&
              matchesPublished(r, botLogin, subject.headSha, [summaryMarker(runId)])
                ? { reviewId: r.id }
                : undefined,
          ),
      });
    } else {
      // The summary carries the true finding count even in sync mode, where
      // the findings themselves land as standalone comments via the loop.
      const created = await this.createReviewWithFindings(
        run,
        finalReview,
        findings.length,
        sync ? [] : findings,
        botLogin,
        signal,
      );
      reviewId = created.reviewId;
      inlineIds = created.commentIds;
    }

    const matchByLabel = new Map<string, number>(validMatches.map((m) => [m.label, m.commentId]));
    const commentIds: number[] = [];
    const threads = earlier.length > 0 ? await this.loadThreadMap(subject) : undefined;

    if (sync) {
      for (const finding of findings) {
        const matchedId = matchByLabel.get(finding.label);
        if (matchedId === undefined || !liveById.has(matchedId)) {
          // No match, or the matched comment was deleted by hand between the
          // matching snapshot and this write. First reconcile the finding's
          // own marker: a comment of this run already carrying it (an inline
          // comment adopted with a recovered review) is reused as-is instead
          // of being posted a second time (ticket 05).
          const own = liveComments.find(
            (c) =>
              c.author === botLogin &&
              extractMarkers(c.body).includes(findingMarker(runId, finding.label)) &&
              c.path === finding.path &&
              c.side === finding.side &&
              c.line === finding.line,
          );
          if (own) {
            commentIds.push(own.id);
            continue;
          }
          commentIds.push(await this.postComment(subject, finding, runId, botLogin, signal));
          continue;
        }
        const live = liveById.get(matchedId)!;
        if (sameAnchor(live, finding)) {
          // Recurring after resolution: reopen the thread, then update.
          const thread = threads?.get(matchedId);
          if (thread?.isResolved) {
            await this.setThreadResolved(subject, thread.threadId, false, runId);
          }
          const body = this.ledgerHooks
            ? bodyWithAllMarkers(finding.section, [
                ...extractMarkers(live.body),
                findingMarker(runId, finding.label),
              ])
            : finding.section;
          await this.runLedgered({
            intent: "update-comment",
            subjectKey: finding.label,
            marker: findingMarker(runId, finding.label),
            payload: { commentId: matchedId, body },
            runId,
            send: () =>
              this.api.updateReviewComment(subject.repository, matchedId, { body }, signal),
            ok: (response) =>
              response.status === 200
                ? { ok: true, remote: { commentId: matchedId } }
                : { ok: false, status: response.status, reason: `updating comment ${matchedId} failed with HTTP ${response.status}: ${describeBody(response.body)}` },
            reconcile: () =>
              reconcileListing(
                () => readAllReviewComments(this.api, subject.repository, subject.pullNumber),
                "listing review comments",
                (c) =>
                  c.id === matchedId &&
                  matchesPublished(c, botLogin, subject.headSha, [findingMarker(runId, finding.label)])
                    ? { commentId: c.id }
                    : undefined,
              ),
          });
          commentIds.push(matchedId);
        } else {
          // Moved: mark the old comment superseded and post a replacement at
          // the new anchor, keeping the old discussion. The replacement gets
          // its own ordinal marker: the old comment keeps the original's.
          const supersededBodyText = supersededBody(live.body, finding);
          await this.runLedgered({
            intent: "supersede-comment",
            subjectKey: finding.label,
            marker: findingMarker(runId, finding.label),
            payload: { commentId: matchedId, body: supersededBodyText },
            runId,
            send: () =>
              this.api.updateReviewComment(subject.repository, matchedId, { body: supersededBodyText }, signal),
            ok: (response) =>
              response.status === 200
                ? { ok: true, remote: { commentId: matchedId } }
                : { ok: false, status: response.status, reason: `marking comment ${matchedId} superseded failed with HTTP ${response.status}: ${describeBody(response.body)}` },
            reconcile: () =>
              reconcileListing(
                () => readAllReviewComments(this.api, subject.repository, subject.pullNumber),
                "listing review comments",
                (c) =>
                  c.id === matchedId && c.authorLogin === botLogin && isSupersededCommentText(c.body)
                    ? { commentId: c.id }
                    : undefined,
              ),
          });
          commentIds.push(await this.postComment(subject, finding, runId, botLogin, signal));
        }
      }
    }
    if (!sync) commentIds.push(...inlineIds);

    // Omitted findings: unclaimed bot ROOT threads resolve so the open
    // threads match the current review. Replies are never iterated; threads
    // rooted at other people's comments are never touched.
    if (threads) {
      const claimed = new Set(validMatches.map((m) => m.commentId));
      for (const comment of earlier) {
        if (comment.inReplyToId !== undefined) continue;
        if (comment.author !== botLogin || claimed.has(comment.id)) continue;
        const thread = threads.get(comment.id);
        if (!thread || thread.isResolved) continue;
        await this.setThreadResolved(subject, thread.threadId, true, runId);
      }
    }

    return { reviewId, commentIds, rejections };
  }

  /**
   * First publication: one review with the summary and (unless the run is
   * syncing against earlier threads) one inline comment per finding. The
   * whole write is one ledgered operation: the summary marker identifies the
   * review, each inline body carries its finding's marker.
   */
  private async createReviewWithFindings(
    run: RunDocument,
    finalReview: string,
    findingCount: number,
    inline: ReviewFinding[],
    botLogin: string,
    signal?: AbortSignal,
  ): Promise<{ reviewId: number; commentIds: number[] }> {
    const body = this.ledgerHooks
      ? bodyWithMarker(renderSummary(run, finalReview, findingCount), summaryMarker(run.runId))
      : renderSummary(run, finalReview, findingCount);
    const payload = {
      commit_id: run.subject.headSha,
      event: "COMMENT" as const,
      body,
      comments: inline.map((f) => ({
        path: f.path,
        side: f.side,
        line: f.line,
        ...(f.startSide !== undefined && f.startLine !== undefined
          ? { start_side: f.startSide, start_line: f.startLine }
          : {}),
        body: this.ledgerHooks ? bodyWithMarker(f.section, findingMarker(run.runId, f.label)) : f.section,
      })),
    };
    const remote = await this.runLedgered({
      intent: "create-review",
      subjectKey: "summary",
      marker: summaryMarker(run.runId),
      payload,
      runId: run.runId,
      send: () => this.api.createReview(run.subject.repository, run.subject.pullNumber, payload, signal),
      ok: (response) => {
        if (response.status === 422) {
          return { ok: false, status: 422, reason: `GitHub rejected the review: ${describeBody(response.body)}` };
        }
        const created = response.body as { id?: number; comments?: Array<{ id: number }> };
        if (response.status !== 200) {
          return { ok: false, status: response.status, reason: `GitHub create review failed with HTTP ${response.status}: ${describeBody(response.body)}` };
        }
        if (typeof created.id !== "number") {
          return { ok: false, reason: "GitHub create review returned no review id" };
        }
        return {
          ok: true,
          remote: { reviewId: created.id, commentIds: (created.comments ?? []).map((c) => c.id) },
        };
      },
      reconcile: () =>
        reconcileListing(
          () => readAllReviews(this.api, run.subject.repository, run.subject.pullNumber),
          "listing reviews",
          (r) =>
            matchesPublished(r, botLogin, run.subject.headSha, [summaryMarker(run.runId)])
              ? { reviewId: r.id, commentIds: r.commentIds ?? [] }
              : undefined,
        ),
    });
    return { reviewId: remote.reviewId!, commentIds: remote.commentIds ?? [] };
  }

  /** Post one finding as a standalone review comment at its anchor,
   * carrying the finding's current-ordinal marker. */
  private async postComment(
    subject: RunDocument["subject"],
    finding: ReviewFinding,
    runId: string,
    botLogin: string,
    signal?: AbortSignal,
  ): Promise<number> {
    // Ordinal marker: the first comment for this label in this run is plain;
    // a replacement (moved finding) or a recreate after a manual deletion
    // appends an ordinal so each published comment is uniquely findable.
    let ordinal = 1;
    const hooks = this.ledgerHooks;
    if (hooks) {
      const ops = await hooks.ledger.opsForRun(runId, hooks.context);
      ordinal = nextCreateOrdinal(ops, runId, finding.label);
    }
    const label = ordinal === 1 ? finding.label : `${finding.label}/r${ordinal}`;
    const marker = findingMarker(runId, label);
    const payload = {
      commit_id: subject.headSha,
      path: finding.path,
      side: finding.side,
      line: finding.line,
      ...(finding.startSide !== undefined && finding.startLine !== undefined
        ? { start_side: finding.startSide, start_line: finding.startLine }
        : {}),
      body: this.ledgerHooks ? bodyWithMarker(finding.section, marker) : finding.section,
    };
    const remote = await this.runLedgered({
      intent: "create-comment",
      subjectKey: label,
      marker,
      payload,
      runId,
      send: () => this.api.createReviewComment(subject.repository, subject.pullNumber, payload, signal),
      ok: (response) => {
        if (response.status === 422) {
          return { ok: false, status: 422, reason: `GitHub rejected the comment anchor: ${describeBody(response.body)}` };
        }
        const created = response.body as { id?: number };
        if (response.status !== 201) {
          return { ok: false, status: response.status, reason: `GitHub create comment failed with HTTP ${response.status}: ${describeBody(response.body)}` };
        }
        if (typeof created.id !== "number") {
          return { ok: false, reason: "GitHub create comment returned no comment id" };
        }
        return { ok: true, remote: { commentId: created.id } };
      },
      reconcile: () =>
        reconcileListing(
          () => readAllReviewComments(this.api, subject.repository, subject.pullNumber),
          "listing review comments",
          (c) =>
            matchesPublished(c, botLogin, subject.headSha, [marker]) ? { commentId: c.id } : undefined,
        ),
    });
    return remote.commentId!;
  }

  /**
   * One paced, ledgered GitHub write (ticket 05). Before the send, the
   * intent — operation key, payload, marker, attempt ordinal — commits
   * durably; after GitHub confirms, the remote IDs are recorded. A response
   * that never arrives is reconciled against GitHub's actual state: the
   * object is adopted when it landed, the write retried when the listing
   * proves it did not, and `WriteOutcomeUnknown` raised when neither can be
   * established. 403/429 responses pace with `Retry-After` (at least one
   * minute without it), backing off exponentially, bounded; auth,
   * permission and anchor errors fail once with a reason.
   */
  private async runLedgered<T>(input: {
    intent: PublicationIntent;
    subjectKey: string;
    marker: string;
    payload: unknown;
    runId: string;
    send: () => Promise<T>;
    ok: (response: T) => { ok: true; remote: PublicationRemote } | { ok: false; status?: number; reason: string };
    reconcile: () => Promise<ReconcileResult>;
  }): Promise<PublicationRemote> {
    const hooks = this.ledgerHooks;
    const opKey = operationKey(input.intent, input.runId, input.subjectKey);
    let attempts = 0;
    let rateLimitStreak = 0;
    let lostRounds = 0;
    if (hooks) {
      const existing = await hooks.ledger.op(opKey, hooks.context);
      // Already confirmed under an earlier attempt of this run: the write is
      // done; nothing is sent again.
      if (existing?.state === "confirmed") return existing.remote ?? {};
      attempts = existing?.attempts ?? 0;
      // A prior attempt wrote under this key and its outcome was never
      // recorded (the host crashed, or the response was lost): check GitHub
      // before retrying — the object is adopted when it landed, and the
      // write only re-issued when the listing proves it did not.
      if (existing && existing.attempts > 0) {
        const outcome = await input.reconcile();
        if (outcome.status === "confirmed") {
          await hooks.ledger.confirmFromState(opKey, outcome.remote, hooks.context);
          return outcome.remote;
        }
        if (outcome.status === "unknown") {
          throw new WriteOutcomeUnknown(
            `publication write ${input.intent}/${input.subjectKey} could not be reconciled: ${outcome.detail ?? "GitHub state unreadable"}`,
          );
        }
      }
    }
    for (;;) {
      attempts += 1;
      if (hooks) {
        await hooks.ledger.recordIntent(
          {
            opKey,
            runId: input.runId,
            intent: input.intent,
            subject: input.subjectKey,
            reviewedSubject: {
              repository: hooks.subject.repository,
              pullNumber: hooks.subject.pullNumber,
              headSha: hooks.subject.headSha,
            },
            payload: input.payload,
            marker: input.marker,
            attempts,
          },
          hooks.context,
        );
      }
      let response: T;
      try {
        response = await input.send();
      } catch {
        // The response never arrived: GitHub may have accepted the write.
        // Without a ledger the body carries no marker to reconcile against,
        // so the outcome cannot be established either way.
        if (!hooks) {
          throw new WriteOutcomeUnknown(
            `publication write ${input.intent}/${input.subjectKey} lost its response; outcome stays unknown`,
          );
        }
        lostRounds += 1;
        if (lostRounds > MAX_LOST_RESPONSE_ROUNDS) {
          throw new WriteOutcomeUnknown(
            `publication write ${input.intent}/${input.subjectKey} could not be reconciled: its outcome stays unknown`,
          );
        }
        const outcome = await input.reconcile();
        if (outcome.status === "confirmed") {
          if (hooks) {
            await hooks.ledger.confirmFromState(opKey, outcome.remote, hooks.context);
          }
          return outcome.remote;
        }
        if (outcome.status === "not_found" || outcome.status === "retry") continue; // Proven absent (or re-derivable): re-issue under the same key.
        throw new WriteOutcomeUnknown(
          `publication write ${input.intent}/${input.subjectKey} could not be reconciled: ${outcome.status === "unknown" ? outcome.detail ?? "GitHub state unreadable" : "unreadable"}`,
        );
      }
      const verdict = input.ok(response);
      if (verdict.ok) {
        if (hooks) {
          await hooks.ledger.confirm(opKey, verdict.remote, hooks.context);
        }
        return verdict.remote;
      }
      const status = verdict.status;
      if (status !== undefined && isRateLimited(status, (response as unknown as { headers?: Record<string, string> }).headers)) {
        rateLimitStreak += 1;
        if (rateLimitStreak > MAX_RATE_LIMIT_RESPONSES) {
          throw new PublishError(verdict.reason);
        }
        const headers = (response as unknown as { headers?: Record<string, string> }).headers;
        const delayMs = rateLimitDelayMs(status, rateLimitStreak, headers);
        await (hooks ? hooks.sleep(delayMs) : sleepMs(delayMs));
        continue; // Re-issue under the same key after the documented wait.
      }
      // Auth, permission, anchor and other GitHub rejections: fail once with
      // a reason. Nothing is retried here.
      throw new PublishError(verdict.reason);
    }
  }

  async checkSuccess(subject: RunDocument["subject"], findingCount: number): Promise<void> {
    await this.createCheck(subject, {
      status: "completed" as const,
      conclusion: "success" as const,
      output: {
        title: "Review published",
        summary:
          findingCount === 0
            ? "Complete review: no findings."
            : `Complete review: ${findingCount} finding(s), all advisory.`,
      },
    }, "completion");
  }

  async checkFailure(subject: RunDocument["subject"], reason: string): Promise<void> {
    await this.createCheck(subject, {
      status: "completed" as const,
      conclusion: "failure" as const,
      output: { title: "Review failed", summary: reason },
    }, "completion");
  }

  private async createCheck(
    subject: RunDocument["subject"],
    payload:
      | { status: "in_progress"; output: { title: string; summary: string } }
      | { status: "completed"; conclusion: "success" | "failure"; output: { title: string; summary: string } },
    stage: string,
  ): Promise<void> {
    const response = await this.api.createCheckRun(subject.repository, {
      name: CHECK_NAME,
      head_sha: subject.headSha,
      ...payload,
    });
    if (response.status !== 201) {
      throw new PublishError(`check-run ${stage} failed with HTTP ${response.status}`);
    }
  }

  /**
   * Refused by the trigger gate (ticket 03): the requester is told why and
   * what to do next, surfaced as a skipped or action-required check.
   */
  async checkRefused(
    subject: { repository: string; pullNumber: number; headSha: string; baseSha?: string },
    outcome: "skipped" | "action_required",
    reason: string,
  ): Promise<void> {
    const response = await this.api.createCheckRun(subject.repository, {
      name: CHECK_NAME,
      head_sha: subject.headSha,
      status: "completed",
      conclusion: outcome,
      output: {
        title: outcome === "skipped" ? "Review skipped" : "Review action required",
        summary: reason,
      },
    });
    if (response.status !== 201) {
      throw new PublishError(`refusal check run failed with HTTP ${response.status}`);
    }
  }

  /** A reviewer deadline passed: the attempt is incomplete, not failed outright. */
  async checkIncomplete(subject: RunDocument["subject"], reason: string): Promise<void> {
    const response = await this.api.createCheckRun(subject.repository, {
      name: CHECK_NAME,
      head_sha: subject.headSha,
      status: "completed",
      conclusion: "neutral",
      output: { title: "Review incomplete", summary: reason },
    });
    if (response.status !== 201) {
      throw new PublishError(`check-run completion failed with HTTP ${response.status}`);
    }
  }

  /**
   * A cancelled run (ticket 09): GitHub's own `cancelled` conclusion, the
   * same status channel failure/incomplete use — a cancellation status, not
   * a publication (no review, comment or thread write).
   */
  async checkCancelled(subject: RunDocument["subject"], reason: string): Promise<void> {
    const response = await this.api.createCheckRun(subject.repository, {
      name: CHECK_NAME,
      head_sha: subject.headSha,
      status: "completed",
      conclusion: "cancelled",
      output: { title: "Review cancelled", summary: reason },
    });
    if (response.status !== 201) {
      throw new PublishError(`check-run cancellation failed with HTTP ${response.status}`);
    }
  }

  private ensureStatus(response: HttpResponse, expected: number, what: string): void {
    if (response.status !== expected) {
      throw new PublishError(`${what} failed with HTTP ${response.status}: ${describeBody(response.body)}`);
    }
  }

  private ensureGraphqlOk(
    response: { status: number; body: { data?: unknown; errors?: Array<{ message: string }> } },
    what: string,
  ): void {
    if (response.status !== 200) {
      throw new PublishError(`${what} failed with HTTP ${response.status}`);
    }
    if (response.body.errors?.length) {
      throw new PublishError(`${what} failed: ${response.body.errors[0]!.message}`);
    }
  }
}

function sameAnchor(comment: PublishedComment, finding: InlineLocation): boolean {
  return comment.path === finding.path && comment.side === finding.side && comment.line === finding.line;
}

function describeBody(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    return String(record.detail ?? record.message ?? JSON.stringify(body));
  }
  return String(body);
}
