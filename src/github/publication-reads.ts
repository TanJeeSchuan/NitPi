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
  /** Inline comment IDs the review was submitted with. */
  commentIds?: number[];
}

/** A bot review comment as read from GitHub for reconciliation. */
export interface ReconcileComment {
  id: number;
  body: string;
  authorLogin: string;
  commitId: string;
  path: string;
  side: string;
  line: number;
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
  remote: { body: string; commitId: string; authorLogin: string },
  botLogin: string,
): boolean {
  return matchesPublished(remote, botLogin, op.reviewedSubject.headSha, payloadMarkers(op));
}

/** The shared three-part match (ticket 05: marker, author, reviewed
 * subject): the object was written by the reviewer bot on the reviewed head
 * and carries one of the intended markers. */
export function matchesPublished(
  remote: { body: string; commitId: string; authorLogin: string },
  botLogin: string,
  reviewedHeadSha: string,
  markers: readonly string[],
): boolean {
  if (remote.authorLogin !== botLogin) return false;
  if (reviewedHeadSha && remote.commitId && remote.commitId !== reviewedHeadSha) return false;
  const bodyMarkers = extractMarkers(remote.body);
  return markers.some((m) => bodyMarkers.includes(m));
}

/** The outcome of one paginated reconciliation read: `ok` lists are
 * authoritative (every page was read); a failed page makes the whole read
 * unestablishable — the caller stays unknown instead of trusting a partial
 * list. */
export type PaginatedRead<T> = { ok: true; items: T[] } | { ok: false; status: number };

/** Follow the listing's `Link` header (`rel="next"`, GitHub's pagination
 * contract) page by page; without one the listing is done. A non-200 page
 * makes the whole read unestablishable. */
async function readAllPages<T>(
  fetchPage: (page: number) => Promise<HttpResponse>,
  map: (raw: Record<string, unknown>) => T,
  perPage = 100,
): Promise<PaginatedRead<T>> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchPage(page);
    if (response.status !== 200) return { ok: false, status: response.status };
    for (const raw of response.body as Array<Record<string, unknown>>) items.push(map(raw));
    if (!hasNextPage(response)) return { ok: true, items };
  }
}

/** The listing's `Link` header carries `rel="next"` while pages remain. */
function hasNextPage(response: { headers?: Record<string, string> }): boolean {
  return /rel="next"/.test(response.headers?.["link"] ?? "");
}

/** Read all of the pull request's review comments, any author. */
export async function readAllReviewComments(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
): Promise<PaginatedRead<ReconcileComment>> {
  return readAllPages(
    (page) => api.listReviewComments(repository, pullNumber, { page }),
    (raw) => ({
      id: raw.id as number,
      body: (raw.body as string) ?? "",
      authorLogin: (raw.user as { login?: string } | undefined)?.login ?? "",
      commitId: (raw.commit_id as string) ?? "",
      path: (raw.path as string) ?? "",
      side: (raw.side as string) ?? "RIGHT",
      line: (raw.line as number) ?? 0,
      ...(raw.in_reply_to_id != null ? { inReplyToId: raw.in_reply_to_id as number } : {}),
    }),
  );
}

/** Read all of the pull request's reviews, any author, with markers. */
export async function readAllReviews(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
): Promise<PaginatedRead<ReconcileReview>> {
  return readAllPages(
    (page) => api.listReviews(repository, pullNumber, { page }),
    (raw) => ({
      id: raw.id as number,
      body: (raw.body as string) ?? "",
      authorLogin: (raw.user as { login?: string } | undefined)?.login ?? "",
      commitId: (raw.commit_id as string) ?? "",
      ...((raw.comments as Array<{ id: number }> | undefined)
        ? { commentIds: (raw.comments as Array<{ id: number }>).map((c) => c.id) }
        : {}),
    }),
  );
}

/** One page of the paginated review-thread listing (GraphQL). */
export interface ThreadPage {
  nodes: ReviewThreadNode[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** One review thread node as the GraphQL listing serves it. */
export interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  comments: { nodes: Array<{ databaseId: number }> };
}

/**
 * All review threads with pagination. The publisher uses this instead of the
 * first-page-only query it shipped with (ticket 04), so thread resolution
 * stays correct on long pull requests. A failed page is signaled, not
 * swallowed: reconciliation must treat an unreadable listing as unknown.
 */
export async function readThreadPages(
  api: GitHubApi,
  repository: string,
  pullNumber: number,
  pageSize = 100,
): Promise<PaginatedRead<ReviewThreadNode>> {
  const [owner, name] = repository.split("/");
  const nodes: ReviewThreadNode[] = [];
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
    if (response.status !== 200 || response.body.errors?.length) {
      return { ok: false, status: response.status };
    }
    const data = response.body.data as
      | {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
                nodes?: ReviewThreadNode[];
              };
            };
          };
        }
      | undefined;
    const page = data?.repository?.pullRequest?.reviewThreads;
    for (const node of page?.nodes ?? []) nodes.push(node);
    if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) return { ok: true, items: nodes };
    cursor = page.pageInfo.endCursor;
  }
}
