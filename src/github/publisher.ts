/**
 * GitHub publication (spec: Publisher + tickets 01 and 04).
 *
 * One review carries the maintained summary; each finding lives in one
 * review-comment thread. The first publication creates that review with
 * `event: COMMENT`, `commit_id` = reviewed head SHA and one inline comment
 * per finding. A rerun updates instead of duplicating:
 *
 * - the summary review's body is PATCHed (exactly one bot summary is current);
 * - a finding at the same anchor updates its existing comment body;
 * - a recurring finding at a resolved thread's anchor reopens the thread
 *   (GraphQL `unresolveReviewThread`) and updates it;
 * - a moved finding marks the old comment superseded (keeping its
 *   discussion) and posts a replacement at the new anchor;
 * - an earlier finding a complete current-head review omits has its thread
 *   resolved (GraphQL `resolveReviewThread`);
 * - every model-supplied comment ID is validated against the pull request
 *   and bot ownership before any write; rejected IDs are never acted on;
 * - human replies and other people's comments are never edited, deleted,
 *   resolved or reopened.
 *
 * Anchors are assumed valid on the model side (validation is ticket 02); an
 * anchor GitHub rejects (422) fails with an explicit reason and is not
 * retried here. Publication idempotency and reconciliation are ticket 05.
 */
import type { ReviewFinding, DiffSide } from "../review-host/artifact.js";
import type { RunDocument } from "../review-host/run-history.js";
import {
  validateMatches,
  type FindingMatch,
  type MatchRejection,
  type PublishedComment,
  type ValidMatch,
} from "../review-host/matching.js";

/** Typed subset of the GitHub REST + GraphQL endpoints the reviewer host uses. */
export interface GitHubApi {
  createReview(
    repository: string,
    pullNumber: number,
    payload: {
      commit_id: string;
      event: "COMMENT";
      body: string;
      comments: Array<{ path: string; side: "LEFT" | "RIGHT"; line: number; body: string }>;
    },
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
  /** Update a review's summary body (the maintained summary). */
  updateReview(
    repository: string,
    pullNumber: number,
    reviewId: number,
    payload: { body: string },
  ): Promise<{ status: number; body: unknown }>;
  /** All submitted reviews on the pull request. */
  listReviews(repository: string, pullNumber: number): Promise<{ status: number; body: unknown }>;
  /** Post one review comment on the pull request (its own thread). */
  createReviewComment(
    repository: string,
    pullNumber: number,
    payload: { commit_id: string; path: string; side: "LEFT" | "RIGHT"; line: number; body: string },
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
  /** All review comments on the pull request (any author). */
  listReviewComments(repository: string, pullNumber: number): Promise<{ status: number; body: unknown }>;
  /** Update one review comment's body. */
  updateReviewComment(
    repository: string,
    commentId: number,
    payload: { body: string },
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
  createCheckRun(
    repository: string,
    payload:
      | { name: string; head_sha: string; status: "in_progress"; output: { title: string; summary: string } }
      | {
          name: string;
          head_sha: string;
          status: "completed";
          conclusion: "success" | "failure";
          output: { title: string; summary: string };
        },
  ): Promise<{ status: number; body: unknown }>;
  /** The identity publishing writes as — the reviewer bot. */
  getAuthenticatedUser(): Promise<{ status: number; body: unknown }>;
  /** GraphQL for the review-thread subset: listing, resolve, unresolve. */
  graphql(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: { data?: unknown; errors?: Array<{ message: string }> } }>;
  /** Trigger-gate inputs (minimal gate for ticket 01; full gate is ticket 03). */
  getPullRequest(repository: string, pullNumber: number): Promise<{ status: number; body: unknown }>;
  getCollaboratorPermission(
    repository: string,
    username: string,
  ): Promise<{ status: number; body: unknown }>;
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
function supersededBody(earlierBody: string, movedTo: { path: string; side: DiffSide; line: number }): string {
  return [
    `**Superseded:** this finding now anchors at \`${movedTo.path} | ${movedTo.side} | ${movedTo.line}\` — the replacement comment carries the current text. This thread is kept for its discussion.`,
    "",
    earlierBody,
  ].join("\n");
}

interface ThreadInfo {
  threadId: string;
  isResolved: boolean;
}

export class Publisher {
  constructor(readonly api: GitHubApi) {}

  async checkInProgress(subject: RunDocument["subject"], stage: string): Promise<void> {
    const response = await this.api.createCheckRun(subject.repository, {
      name: CHECK_NAME,
      head_sha: subject.headSha,
      status: "in_progress",
      output: {
        title: "Review in progress",
        summary: `Reviewing ${subject.headSha.slice(0, 12)} · stage: ${stage}`,
      },
    });
    if (response.status !== 201) {
      throw new PublishError(`check-run start failed with HTTP ${response.status}`);
    }
  }

  /** The login that publishes writes as — model-supplied IDs are validated
   * against it (ticket 04: bot ownership). */
  async botLogin(): Promise<string> {
    const response = await this.api.getAuthenticatedUser();
    if (response.status !== 200) {
      throw new PublishError(`cannot identify the reviewer bot (HTTP ${response.status})`);
    }
    const login = (response.body as { login?: string }).login;
    if (!login) throw new PublishError("the authenticated user has no login");
    return login;
  }

  /** All review comments on the pull request (any author), as read from
   * GitHub. This is the matching turn's input snapshot. */
  async listPublishedComments(subject: RunDocument["subject"]): Promise<PublishedComment[]> {
    const response = await this.api.listReviewComments(subject.repository, subject.pullNumber);
    if (response.status !== 200) {
      throw new PublishError(`listing review comments failed with HTTP ${response.status}`);
    }
    const body = response.body as Array<Record<string, unknown>>;
    return body.map((raw) => ({
      id: raw.id as number,
      path: (raw.path as string) ?? "",
      side: ((raw.side as string) ?? "RIGHT") as DiffSide,
      line: (raw.line as number) ?? 0,
      body: (raw.body as string) ?? "",
      author: ((raw.user as { login?: string } | undefined)?.login as string) ?? "",
    }));
  }

  /** The bot's newest summary review on the pull request, if any. When it
   * exists, a rerun PATCHes it instead of adding another summary. */
  private async botSummaryReview(
    subject: RunDocument["subject"],
    botLogin: string,
  ): Promise<{ id: number; body: string } | undefined> {
    const response = await this.api.listReviews(subject.repository, subject.pullNumber);
    if (response.status !== 200) {
      throw new PublishError(`listing reviews failed with HTTP ${response.status}`);
    }
    const body = response.body as Array<Record<string, unknown>>;
    let newest: { id: number; body: string } | undefined;
    for (const raw of body) {
      const author = (raw.user as { login?: string } | undefined)?.login;
      const id = raw.id as number;
      if (author !== botLogin || typeof id !== "number") continue;
      if (!newest || id > newest.id) newest = { id, body: (raw.body as string) ?? "" };
    }
    return newest;
  }

  /** GraphQL thread state keyed by the database ID of any comment in the
   * thread. First page of 100 covers v0; pagination is ticket 05's domain. */
  private async loadThreadMap(subject: RunDocument["subject"]): Promise<Map<number, ThreadInfo>> {
    const [owner, name] = subject.repository.split("/");
    const query = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 20) { nodes { databaseId } }
        }
      }
    }
  }
}`;
    const response = await this.api.graphql(query, { owner, name, number: subject.pullNumber });
    if (response.status !== 200) {
      throw new PublishError(`review-threads query failed with HTTP ${response.status}`);
    }
    if (response.body.errors?.length) {
      throw new PublishError(`review-threads query failed: ${response.body.errors[0]!.message}`);
    }
    const data = response.body.data as
      | {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: Array<{
                  id: string;
                  isResolved: boolean;
                  comments: { nodes: Array<{ databaseId: number }> };
                }>;
              };
            };
          };
        }
      | undefined;
    const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    const map = new Map<number, ThreadInfo>();
    for (const thread of nodes) {
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
  ): Promise<void> {
    const mutation = resolved
      ? `mutation($input: ResolveReviewThreadInput!) {
  resolveReviewThread(input: $input) { thread { id isResolved } }
}`
      : `mutation($input: UnresolveReviewThreadInput!) {
  unresolveReviewThread(input: $input) { thread { id isResolved } }
}`;
    const response = await this.api.graphql(mutation, { input: { threadId } });
    if (response.status !== 200) {
      throw new PublishError(
        `${resolved ? "resolveReviewThread" : "unresolveReviewThread"} failed with HTTP ${response.status}`,
      );
    }
    if (response.body.errors?.length) {
      throw new PublishError(
        `${resolved ? "resolveReviewThread" : "unresolveReviewThread"} failed: ${response.body.errors[0]!.message}`,
      );
    }
  }

  /**
   * Publish one advisory review for the reviewed head, keeping the pull
   * request's threads in sync with this run's final review. `earlier` is the
   * review-comment snapshot the matching turn saw; `rawMatches` are the
   * model's assignments, validated here before anything is acted on.
   * Failure = explicit reason; nothing is retried here (ticket 05).
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

    // One maintained summary: update the bot's newest review, or create it
    // on the first publication with every finding inline (ticket 01 behavior).
    const existing = await this.botSummaryReview(subject, botLogin);
    let reviewId: number;
    let inlineIds: number[] = [];
    if (existing) {
      const patched = await this.api.updateReview(
        subject.repository,
        subject.pullNumber,
        existing.id,
        { body: renderSummary(run, finalReview, findings.length) },
      );
      if (patched.status !== 200) {
        throw new PublishError(
          `updating the summary review failed with HTTP ${patched.status}: ${describeBody(patched.body)}`,
        );
      }
      reviewId = existing.id;
    } else {
      const created = await this.createReviewWithFindings(run, finalReview, findings, signal);
      reviewId = created.reviewId;
      inlineIds = created.commentIds;
    }

    const rerun = existing !== undefined;
    const matchByLabel = new Map<string, number>(validMatches.map((m) => [m.label, m.commentId]));
    const commentIds: number[] = [];
    const threads = earlier.length > 0 ? await this.loadThreadMap(subject) : undefined;

    if (rerun) {
      for (const finding of findings) {
        const matchedId = matchByLabel.get(finding.label);
        if (matchedId === undefined) {
          commentIds.push(await this.postComment(subject, finding, signal));
          continue;
        }
        const earlierComment = earlier.find((c) => c.id === matchedId)!;
        if (sameAnchor(earlierComment, finding)) {
          // Recurring after resolution: reopen the thread, then update.
          const thread = threads?.get(matchedId);
          if (thread?.isResolved) await this.setThreadResolved(subject, thread.threadId, false);
          const patched = await this.api.updateReviewComment(
            subject.repository,
            matchedId,
            { body: finding.section },
            signal,
          );
          if (patched.status !== 200) {
            throw new PublishError(
              `updating comment ${matchedId} failed with HTTP ${patched.status}: ${describeBody(patched.body)}`,
            );
          }
          commentIds.push(matchedId);
        } else {
          // Moved: mark the old comment superseded and post a replacement at
          // the new anchor, keeping the old discussion.
          const superseded = await this.api.updateReviewComment(
            subject.repository,
            matchedId,
            { body: supersededBody(earlierComment.body, finding) },
            signal,
          );
          if (superseded.status !== 200) {
            throw new PublishError(
              `marking comment ${matchedId} superseded failed with HTTP ${superseded.status}: ${describeBody(superseded.body)}`,
            );
          }
          commentIds.push(await this.postComment(subject, finding, signal));
        }
      }
    }
    if (!rerun) commentIds.push(...inlineIds);

    // Omitted findings: unclaimed bot threads resolve so the open threads
    // match the current review. Threads rooted at other people's comments
    // are never touched.
    if (threads) {
      const claimed = new Set(validMatches.map((m) => m.commentId));
      for (const comment of earlier) {
        if (comment.author !== botLogin || claimed.has(comment.id)) continue;
        const thread = threads.get(comment.id);
        if (!thread || thread.isResolved) continue;
        await this.setThreadResolved(subject, thread.threadId, true);
      }
    }

    return { reviewId, commentIds, rejections };
  }

  /** First publication: one review with the summary and one inline comment
   * per finding (ticket 01's publication criterion). */
  private async createReviewWithFindings(
    run: RunDocument,
    finalReview: string,
    findings: ReviewFinding[],
    signal?: AbortSignal,
  ): Promise<{ reviewId: number; commentIds: number[] }> {
    const response = await this.api.createReview(
      run.subject.repository,
      run.subject.pullNumber,
      {
        commit_id: run.subject.headSha,
        event: "COMMENT",
        body: renderSummary(run, finalReview, findings.length),
        comments: findings.map((f) => ({
          path: f.path,
          side: f.side,
          line: f.line,
          body: f.section,
        })),
      },
      signal,
    );
    if (response.status === 422) {
      throw new PublishError(`GitHub rejected the review: ${describeBody(response.body)}`);
    }
    if (response.status !== 201) {
      throw new PublishError(
        `GitHub create review failed with HTTP ${response.status}: ${describeBody(response.body)}`,
      );
    }
    const created = response.body as { id?: number; comments?: Array<{ id: number }> };
    if (typeof created.id !== "number") {
      throw new PublishError("GitHub create review returned no review id");
    }
    return {
      reviewId: created.id,
      commentIds: (created.comments ?? []).map((c) => c.id),
    };
  }

  /** Post one finding as a standalone review comment at its anchor. */
  private async postComment(
    subject: RunDocument["subject"],
    finding: ReviewFinding,
    signal?: AbortSignal,
  ): Promise<number> {
    const response = await this.api.createReviewComment(
      subject.repository,
      subject.pullNumber,
      {
        commit_id: subject.headSha,
        path: finding.path,
        side: finding.side,
        line: finding.line,
        body: finding.section,
      },
      signal,
    );
    if (response.status === 422) {
      throw new PublishError(`GitHub rejected the comment anchor: ${describeBody(response.body)}`);
    }
    if (response.status !== 201) {
      throw new PublishError(
        `GitHub create comment failed with HTTP ${response.status}: ${describeBody(response.body)}`,
      );
    }
    const created = response.body as { id?: number };
    if (typeof created.id !== "number") {
      throw new PublishError("GitHub create comment returned no comment id");
    }
    return created.id;
  }

  async checkSuccess(subject: RunDocument["subject"], findingCount: number): Promise<void> {
    const response = await this.api.createCheckRun(subject.repository, {
      name: CHECK_NAME,
      head_sha: subject.headSha,
      status: "completed",
      conclusion: "success",
      output: {
        title: "Review published",
        summary:
          findingCount === 0
            ? "Complete review: no findings."
            : `Complete review: ${findingCount} finding(s), all advisory.`,
      },
    });
    if (response.status !== 201) {
      throw new PublishError(`check-run completion failed with HTTP ${response.status}`);
    }
  }

  async checkFailure(subject: RunDocument["subject"], reason: string): Promise<void> {
    const response = await this.api.createCheckRun(subject.repository, {
      name: CHECK_NAME,
      head_sha: subject.headSha,
      status: "completed",
      conclusion: "failure",
      output: { title: "Review failed", summary: reason },
    });
    if (response.status !== 201) {
      throw new PublishError(`check-run completion failed with HTTP ${response.status}`);
    }
  }
}

function sameAnchor(comment: PublishedComment, finding: ReviewFinding): boolean {
  return comment.path === finding.path && comment.side === finding.side && comment.line === finding.line;
}

function describeBody(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    return String(record.detail ?? record.message ?? JSON.stringify(body));
  }
  return String(body);
}
