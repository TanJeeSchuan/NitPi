/**
 * Reconciliation reads (ticket 05): what GitHub actually has, and what the
 * ledger says the publisher intended.
 *
 * Recovery paginates the bot's reviews and review comments on the pull
 * request, matches them to recorded operations by marker + author + reviewed
 * subject, and adopts the match into the ledger — the durable intent gets its
 * confirming remote ID without a second create. A bot comment someone deleted
 * by hand is found absent from the read: the publisher recreates it under a
 * fresh ordinal key only after that read confirms the deletion.
 */
import { extractMarkers, type PublicationOp } from "./ledger.js";
import type { GitHubApi, HttpResponse } from "./publisher.js";

/** A bot review as read from GitHub for reconciliation. */
export interface ReconcileReview {
  id: number;
  body: string;
  authorLogin: string;
  commitId: string;
}

/** A bot review comment as read from GitHub for reconciliation. */
export interface ReconcileComment {
  id: number;
  body: string;
  authorLogin: string;
  commitId: string;
  inReplyToId?: number;
}

/**
 * All markers the operation's recorded payload carries. The payload is the
 * exact request body the publisher committed, so the adopter does not guess
 * what the object looks like: the marker it searches for is the one the
 * payload embedded.
 */
export function payloadMarkers(op: PublicationOp): string[] {
  const payload = (op.payload ?? {}) as { body?: unknown };
  const body = typeof payload.body === "string" ? payload.body : "";
  if (!body) return op.marker ? [op.marker] : [];
  return extractMarkers(body);
}

/**
 * Match one read remote object against a recorded operation: the write we
 * intended is the one whose payload carries the object's marker, whose
 * reviewed subject (reviewed head SHA) is the object's commit, and which was
 * written by the reviewer bot.
 */
export function recordMatchesRemote(
  op: PublicationOp,
  remote: { bodyMarkers: string[]; commitId: string; authorLogin: string },
  botLogin: string,
): boolean {
  if (remote.authorLogin !== botLogin) return false;
  if (op.reviewedSubject.headSha && remote.commitId && remote.commitId !== op.reviewedSubject.headSha) {
    return false;
  }
  return payloadMarkers(op).some((m) => remote.bodyMarkers.includes(m));
}

/** The outcome of one paginated reconciliation read: `ok` lists are
 * authoritative (every page was read); a failed page makes the whole read
 * unestablishable — the caller stays unknown instead of trusting a partial
 * list. */
export type PaginatedRead<T> = { ok: true; items: T[] } | { ok: false; status: number };

/** Read all of the pull request's review comments, any author, following
 * pagination (`page`/`per_page`) until the listing is exhausted. */
export async function readAllReviewComments(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
  perPage = 100,
): Promise<PaginatedRead<ReconcileComment>> {
  const items: ReconcileComment[] = [];
  for (let page = 1; ; page += 1) {
    const response: HttpResponse = await api.listReviewComments(repository, pullNumber, { page, perPage });
    if (response.status !== 200) return { ok: false, status: response.status };
    for (const raw of response.body as Array<Record<string, unknown>>) {
      items.push({
        id: raw.id as number,
        body: (raw.body as string) ?? "",
        authorLogin: (raw.user as { login?: string } | undefined)?.login ?? "",
        commitId: (raw.commit_id as string) ?? "",
        ...(raw.in_reply_to_id != null ? { inReplyToId: raw.in_reply_to_id as number } : {}),
      });
    }
    if ((response.body as Array<unknown>).length < perPage) return { ok: true, items };
  }
}

/** Read all of the pull request's reviews, any author, with markers,
 * following pagination. */
export async function readAllReviews(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
  perPage = 100,
): Promise<PaginatedRead<ReconcileReview>> {
  const items: ReconcileReview[] = [];
  for (let page = 1; ; page += 1) {
    const response = await api.listReviews(repository, pullNumber, { page, perPage });
    if (response.status !== 200) return { ok: false, status: response.status };
    for (const raw of response.body as Array<Record<string, unknown>>) {
      items.push({
        id: raw.id as number,
        body: (raw.body as string) ?? "",
        authorLogin: (raw.user as { login?: string } | undefined)?.login ?? "",
        commitId: (raw.commit_id as string) ?? "",
      });
    }
    if ((response.body as Array<unknown>).length < perPage) return { ok: true, items };
  }
}

/** One page of the paginated review-thread listing (GraphQL). */
export interface ThreadPage {
  nodes: Array<{
    id: string;
    isResolved: boolean;
    comments: { nodes: Array<{ databaseId: number }> };
  }>;
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * All review threads with pagination. The publisher uses this instead of the
 * first-page-only query it shipped with (ticket 04), so thread resolution
 * stays correct on long pull requests.
 */
export async function readThreadPages(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
  pageSize = 100,
): Promise<ThreadPage["nodes"]> {
  const [owner, name] = repository.split("/");
  const nodes: ThreadPage["nodes"] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    const query = `query($owner: String!, $name: String!, $number: Int!${cursor ? ", $after: String" : ""}) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${pageSize}${cursor ? ", after: $after" : ""}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 50) { nodes { databaseId } }
        }
      }
    }
  }
}`;
    const response = await api.graphql(
      query,
      cursor ? { owner, name, number: pullNumber, after: cursor } : { owner, name, number: pullNumber },
    );
    if (response.status !== 200) return nodes;
    const data = response.body.data as
      | {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
                nodes?: ThreadPage["nodes"];
              };
            };
          };
        }
      | undefined;
    const page = data?.repository?.pullRequest?.reviewThreads;
    for (const node of page?.nodes ?? []) nodes.push(node);
    if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
    cursor = page.pageInfo.endCursor;
  }
  return nodes;
}
