/**
 * Fake GitHub: an in-memory fake of the GitHub REST + GraphQL subset this
 * reviewer uses (spec: Testing Decisions). It is both the scenario harness's
 * wire surface and the publisher's typed client target: the publisher talks
 * HTTP to a base URL; tests point it at `<fake>` or `<fake>/api/v3`.
 *
 * Ticket 04 adds the review-comment surface the maintained-findings publisher
 * needs: listing and patching review comments, posting standalone comments,
 * patching a review's summary body, the authenticated user (bot ownership),
 * and the GraphQL review-thread subset (`resolveReviewThread` /
 * `unresolveReviewThread`) plus the thread-listing query.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { parseUnifiedDiffAnchors } from "../../src/review-host/anchor-validation.js";

export interface FakePullRequest {
  number: number;
  headSha: string;
  baseSha: string;
  state: "open" | "closed";
  /** Draft pull requests get no automatic review (ticket 03). */
  draft?: boolean;
  /** Head repository full name; differs from `baseRepo` on fork pulls. */
  headRepo?: string;
  baseRepo?: string;
  /** Head ref name, for fork-push realism (unused by the gate itself). */
  headRef?: string;
  baseRef?: string;
}

export interface FakeReview {
  id: number;
  pullNumber: number;
  commitId: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" | "PENDING";
  body: string;
  /** Author login. Publisher-created reviews carry the bot login. */
  author: string;
  /** Inline comments created with this review (shared objects with `state.comments`). */
  comments: FakeReviewComment[];
}

export interface FakeReviewComment {
  id: number;
  pullNumber: number;
  /** Set when the comment was created as part of a review. */
  reviewId?: number;
  /** Set when the comment is a reply. */
  inReplyToId?: number;
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
  /** Range start, present only for range anchors (ticket 02). */
  startSide?: "LEFT" | "RIGHT";
  startLine?: number;
  body: string;
  commitId: string;
  author: string;
}

/** One review thread: a root comment plus its replies (fake GraphQL view). */
export interface FakeThread {
  id: string;
  pullNumber: number;
  rootCommentId: number;
  commentIds: number[];
  resolved: boolean;
}

export interface FakeGitHubState {
  pulls: Record<number, FakePullRequest>;
  /** Diff rules: which path/line/side anchors are valid for the reviewed commit. */
  diffAnchors: Set<string>;
  reviews: FakeReview[];
  /** Every review comment on every pull request (any author, any review). */
  comments: FakeReviewComment[];
  /** Review threads, keyed by root comment at creation. */
  threads: FakeThread[];
  checks: Array<{ headSha: string; state: string; detail: string; summary: string }>;
  /** Scripted responses: applied-write, then dropped (unknown outcome). */
  dropNextWrite: { match: RegExp; remaining: number };
  /** Scripted refusals: the write is NOT applied; the response carries the
   * status (and a `Retry-After` header when set) — ticket 05's rate-limit
   * and permission scenarios. `methods` narrows which verbs refuse (writes
   * by default; pass `["GET"]` to refuse a reconciliation read). */
  refuseNextWrite: { match: RegExp; remaining: number; status: number; retryAfter?: number; message?: string; methods?: string[]; /** Matches to pass through before the refusals start firing. */ skip?: number };
  /** When set, list endpoints never serve more items per page than this,
   * regardless of the requested `per_page` — the pagination exercise. */
  enforceListPageSize?: number;
  /** 422 detail for malformed anchors. */
  validationErrors: Map<string, string>;
  /**
   * External check status per head SHA (ticket 03's named-check wait).
   * Keyed `headSha|name` → "in_progress" | "completed:success" | "completed:failure"
   * | "completed:neutral".
   */
  externalChecks: Map<string, "in_progress" | "completed:success" | "completed:failure" | "completed:neutral">;
}

export interface FakeReviewCommentInput {
  path?: string;
  side?: string;
  line?: number;
  start_side?: string;
  start_line?: number;
  body?: string;
}

export class FakeGitHub {
  readonly state: FakeGitHubState;
  /** Login → permission level; default writer. Tests override per login. */
  collaboratorPermissions: Record<string, "read" | "write" | "admin"> = {};
  /** Every request routed through this fake, in order (ticket 07 tests this
   * log to show what was read when — e.g. no comment listings before a
   * clean run's freeze). */
  readonly requestLog: Array<{ method: string; path: string; accept: string }> = [];
  private server: Server | undefined;
  private reviewsSeq = 100;
  private commentsSeq = 1000;

  constructor(
    readonly pulls: FakePullRequest[],
    readonly diffAnchors: string[] = [],
    readonly options: { diffText?: string } = {},
    /** What `GET /user` reports as the reviewer bot's login. */
    readonly botLogin: string = "nitpi-reviewer[bot]",
  ) {
    this.state = {
      pulls: Object.fromEntries(pulls.map((p) => [p.number, p])),
      diffAnchors: new Set(diffAnchors),
      reviews: [],
      comments: [],
      threads: [],
      checks: [],
      dropNextWrite: { match: /reviews$/, remaining: 0 },
      refuseNextWrite: { match: /^$/, remaining: 0, status: 403 },
      validationErrors: new Map(),
      externalChecks: new Map(),
    };
    // When the fake serves a PR diff, its validation set derives from that
    // diff (GitHub is the authority; the host validates against the same
    // pinned diff it fetches from here).
    if (options.diffText) {
      for (const anchor of parseUnifiedDiffAnchors(options.diffText).entries()) {
        this.state.diffAnchors.add(`${anchor.path}#${anchor.side}#${anchor.line}`);
      }
    }
  }

  /** Serve a different PR diff from now on; its anchors union in. */
  setPullDiff(diffText: string): void {
    (this.options as { diffText?: string }).diffText = diffText;
    for (const anchor of parseUnifiedDiffAnchors(diffText).entries()) {
      this.state.diffAnchors.add(`${anchor.path}#${anchor.side}#${anchor.line}`);
    }
  }

  async listen(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server!.address();
    if (typeof address !== "object" || !address) throw new Error("fake GitHub failed to bind");
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.close();
    await once(this.server, "close");
    this.server = undefined;
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    return body;
  }

  private respond(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.end(JSON.stringify(body));
  }

  /** A scripted refusal fires before routing: the write is not applied and
   * the response carries its status (plus `Retry-After` when scripted). */
  private scriptedRefusal(request: IncomingMessage, path: string): boolean {
    const scripted = this.state.refuseNextWrite;
    if (scripted.remaining <= 0) return false;
    const methods = scripted.methods ?? ["POST", "PATCH", "PUT"];
    if (!methods.includes(request.method ?? "")) return false;
    if (!new RegExp(scripted.match).test(path)) return false;
    if ((scripted.skip ?? 0) > 0) {
      scripted.skip = (scripted.skip ?? 0) - 1;
      return false;
    }
    scripted.remaining -= 1;
    return true;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake-github.test");
    const path = url.pathname.replace(/^\/api\/v3/, "");
    this.requestLog.push({ method: request.method ?? "", path, accept: String(request.headers.accept ?? "") });
    if (request.method === "POST" && this.state.dropNextWrite.remaining > 0 && new RegExp(this.state.dropNextWrite.match).test(path)) {
      this.state.dropNextWrite.remaining -= 1;
      // Apply the write, then swallow the response (unknown outcome).
      void this.applyWrite(request, await this.readBody(request), path);
      response.destroy();
      return;
    }
    const body = ["POST", "PATCH", "PUT"].includes(request.method ?? "") ? await this.readBody(request) : "";
    const accept = String(request.headers.accept ?? "");
    try {
      if (this.scriptedRefusal(request, path)) {
        const scripted = this.state.refuseNextWrite;
        this.respond(
          response,
          scripted.status,
          { message: scripted.message ?? "Request refused by scenario script" },
          scripted.retryAfter !== undefined ? { "retry-after": String(scripted.retryAfter) } : {},
        );
        return;
      }
      this.route(request.method ?? "GET", path, body, response, accept, url.searchParams);
    } catch (error) {
      this.respond(response, 500, { message: String(error) });
    }
  }

  private async applyWrite(request: IncomingMessage, body: string, path: string): Promise<void> {
    // Mirrors route() writes for the drop scenario without a response.
    const prMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/);
    if (prMatch) {
      const parsed = JSON.parse(body) as { body?: string; commit_id?: string; comments?: FakeReviewCommentInput[] };
      this.createReview(Number(prMatch[1]), parsed);
    }
  }

  private route(method: string, path: string, body: string, response: ServerResponse, accept = "", params = new URLSearchParams()): void {
    if (method === "POST" && (path === "/api/graphql" || path === "/graphql")) {
      this.handleGraphql(body, response);
      return;
    }

    if (method === "GET" && path === "/user") {
      this.respond(response, 200, { login: this.botLogin });
      return;
    }
    const prMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/);
    if (method === "POST" && prMatch) {
      const parsed = JSON.parse(body) as {
        body?: string;
        commit_id?: string;
        event?: string;
        comments?: FakeReviewCommentInput[];
      };
      if (prMatch && !this.state.pulls[Number(prMatch[1])]) {
        this.respond(response, 404, { message: "Not Found" });
        return;
      }
      const bad = parsed.comments?.find((c) => !this.anchorIsValid(c));
      if (bad) {
        this.respond(response, 422, { message: "Validation Failed", detail: `invalid anchor: ${bad.path}:${bad.line}` });
        return;
      }
      const review = this.createReview(Number(prMatch[1]), parsed);
      this.respond(response, 201, this.toRestReview(review));
      return;
    }

    if (method === "GET" && prMatch) {
      const page = this.listPage(
        this.state.reviews.filter((r) => r.pullNumber === Number(prMatch[1])).map((r) => this.toRestReview(r)),
        params,
      );
      this.respondPaged(response, 200, page.items, page.nextUrl);
      return;
    }

    const reviewPatch = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)$/);
    if (method === "PATCH" && reviewPatch) {
      const parsed = JSON.parse(body) as { body?: string };
      const review = this.state.reviews.find(
        (r) => r.id === Number(reviewPatch[2]) && r.pullNumber === Number(reviewPatch[1]),
      );
      if (!review) {
        this.respond(response, 404, { message: "Not Found" });
        return;
      }
      review.body = parsed.body ?? review.body;
      this.respond(response, 200, this.toRestReview(review));
      return;
    }

    const commentPost = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/);
    if (method === "POST" && commentPost) {
      const pullNumber = Number(commentPost[1]);
      if (!this.state.pulls[pullNumber]) {
        this.respond(response, 404, { message: "Not Found" });
        return;
      }
      const parsed = JSON.parse(body) as { commit_id?: string; path?: string; side?: string; line?: number; body?: string };
      if (!this.anchorIsValid(parsed)) {
        this.respond(response, 422, {
          message: "Validation Failed",
          detail: `invalid anchor: ${parsed.path}:${parsed.line}`,
        });
        return;
      }
      const comment = this.addComment(pullNumber, {
        path: parsed.path ?? "",
        side: (parsed.side ?? "RIGHT") as "LEFT" | "RIGHT",
        line: parsed.line ?? 0,
        body: parsed.body ?? "",
        commitId: parsed.commit_id ?? "",
        author: this.botLogin,
      });
      this.respond(response, 201, this.toRestComment(comment));
      return;
    }

    const commentsList = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/);
    if (method === "GET" && commentsList) {
      const pullNumber = Number(commentsList[1]);
      if (!this.state.pulls[pullNumber]) {
        this.respond(response, 404, { message: "Not Found" });
        return;
      }
      const page = this.listPage(
        this.state.comments.filter((c) => c.pullNumber === pullNumber).map((c) => this.toRestComment(c)),
        params,
      );
      this.respondPaged(response, 200, page.items, page.nextUrl);
      return;
    }

    const commentPatch = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/comments\/(\d+)$/);
    if (method === "PATCH" && commentPatch) {
      const parsed = JSON.parse(body) as { body?: string };
      const comment = this.state.comments.find((c) => c.id === Number(commentPatch[1]));
      if (!comment) {
        this.respond(response, 404, { message: "Not Found" });
        return;
      }
      comment.body = parsed.body ?? comment.body;
      this.respond(response, 200, this.toRestComment(comment));
      return;
    }

    const checkMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/check-runs$/);
    if (method === "POST" && checkMatch) {
      const parsed = JSON.parse(body) as { head_sha?: string; conclusion?: string; output?: { title?: string; summary?: string } };
      const entry = {
        headSha: parsed.head_sha ?? "",
        state: parsed.conclusion ?? "in_progress",
        detail: parsed.output?.title ?? "",
        summary: parsed.output?.summary ?? "",
      };
      this.state.checks.push(entry);
      this.respond(response, 201, { id: this.state.checks.length, ...entry });
      return;
    }

    const prGetMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/);
    if (method === "GET" && prGetMatch) {
      const pull = this.state.pulls[Number(prGetMatch[1])];
      if (!pull) {
        this.respond(response, 404, { message: "Not Found" });
        return;
      }
      // The diff media type returns the pinned base→head diff (ticket 02).
      if (accept.includes("application/vnd.github.diff")) {
        if (!this.options.diffText) {
          this.respond(response, 404, { message: "no diff configured for this fake" });
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end(this.options.diffText);
        return;
      }
      const repo = { full_name: pull.headRepo ?? pull.baseRepo ?? "example/widgets" };
      const baseRepo = { full_name: pull.baseRepo ?? "example/widgets" };
      this.respond(response, 200, {
        number: pull.number,
        state: pull.state,
        draft: pull.draft ?? false,
        head: { sha: pull.headSha, ref: pull.headRef ?? "feature", repo },
        base: { sha: pull.baseSha, ref: pull.baseRef ?? "main", repo: baseRepo },
      });
      return;
    }

    // Check runs at one commit: the named-check wait reads this (ticket 03).
    const checkRunsMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/check-runs$/);
    if (method === "GET" && checkRunsMatch) {
      const headSha = checkRunsMatch[1] ?? "";
      const runs: Array<Record<string, unknown>> = [];
      for (const [key, status] of this.state.externalChecks) {
        const [sha, name] = key.split("|");
        if (sha !== headSha || !name) continue;
        const completed = status.startsWith("completed:");
        runs.push({
          name,
          status: completed ? "completed" : "in_progress",
          conclusion: completed ? status.split(":")[1] : null,
        });
      }
      this.respond(response, 200, { total_count: runs.length, check_runs: runs });
      return;
    }

    const permMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/);
    if (method === "GET" && permMatch) {
      const user = decodeURIComponent(permMatch[1] ?? "");
      const level = this.collaboratorPermissions[user] ?? "write";
      this.respond(response, 200, { permission: level, user: { login: user } });
      return;
    }

    this.respond(response, 404, { message: `unrouted: ${method} ${path}` });
  }

  /** Honor `page`/`per_page` like the REST list endpoints; a forced page
   * size (the pagination exercise) caps every page. Emits the `Link` header
   * with `rel="next"` while more pages remain. */
  private listPage<T>(items: T[], params: URLSearchParams): { items: T[]; nextUrl?: string } {
    const requested = Number.parseInt(params.get("per_page") ?? "", 10);
    const perPage =
      this.state.enforceListPageSize ??
      (Number.isInteger(requested) && requested > 0 ? requested : items.length + 1);
    const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    if (page * perPage < items.length) {
      return { items: slice, nextUrl: `?page=${page + 1}&per_page=${perPage}` };
    }
    return { items: slice };
  }

  /** respond() plus the paged Link header (relative URL, like GitHub). */
  private respondPaged(response: ServerResponse, status: number, body: unknown, nextUrl?: string): void {
    if (nextUrl) {
      this.respond(response, status, body, { link: `<${nextUrl}>; rel="next"` });
      return;
    }
    this.respond(response, status, body);
  }

  /** Range-aware anchor check (ticket 02): the end anchor must be in the
   * diff, and a range start must land there on the same side. */
  private anchorIsValid(comment: FakeReviewCommentInput): boolean {
    const side = (comment.side ?? "RIGHT") as "LEFT" | "RIGHT";
    if (!this.state.diffAnchors.has(`${comment.path}#${side}#${comment.line ?? 0}`)) return false;
    if (comment.start_line !== undefined) {
      const startSide = (comment.start_side ?? side) as "LEFT" | "RIGHT";
      if (!this.state.diffAnchors.has(`${comment.path}#${startSide}#${comment.start_line}`)) return false;
    }
    return true;
  }

  private handleGraphql(body: string, response: ServerResponse): void {
    const parsed = JSON.parse(body) as {
      query?: string;
      variables?: { owner?: string; name?: string; number?: number; input?: { threadId?: string } };
    };
    const query = parsed.query ?? "";
    const variables = parsed.variables ?? {};
    // `unresolveReviewThread` contains `resolveReviewThread`; test it first.
    if (query.includes("unresolveReviewThread")) return this.mutateThread(variables.input?.threadId, false, "unresolveReviewThread", response);
    if (query.includes("resolveReviewThread")) return this.mutateThread(variables.input?.threadId, true, "resolveReviewThread", response);
    if (query.includes("reviewThreads")) {
      const nodes = this.state.threads
        .filter((t) => variables.number === undefined || t.pullNumber === variables.number)
        .map((t) => ({
          id: t.id,
          isResolved: t.resolved,
          comments: { nodes: t.commentIds.map((id) => ({ databaseId: id })) },
        }));
      this.respond(response, 200, {
        data: {
          repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } },
        },
      });
      return;
    }
    this.respond(response, 200, { errors: [{ message: "unsupported GraphQL operation" }] });
  }

  private mutateThread(
    threadId: string | undefined,
    resolved: boolean,
    field: "resolveReviewThread" | "unresolveReviewThread",
    response: ServerResponse,
  ): void {
    if (!threadId) {
      this.respond(response, 200, { errors: [{ message: "missing input.threadId" }] });
      return;
    }
    const thread = this.state.threads.find((t) => t.id === threadId);
    if (!thread) {
      this.respond(response, 200, {
        errors: [{ message: `Could not resolve to a node with the global id of '${threadId}'` }],
      });
      return;
    }
    if (thread.resolved === resolved) {
      this.respond(response, 200, {
        errors: [{ message: `thread ${threadId} is already ${resolved ? "resolved" : "unresolved"}` }],
      });
      return;
    }
    thread.resolved = resolved;
    this.respond(response, 200, { data: { [field]: { thread: { id: thread.id, isResolved: thread.resolved } } } });
  }

  private addComment(
    pullNumber: number,
    input: {
      reviewId?: number;
      inReplyToId?: number;
      path: string;
      side: "LEFT" | "RIGHT";
      line: number;
      startSide?: "LEFT" | "RIGHT";
      startLine?: number;
      body: string;
      commitId: string;
      author: string;
    },
  ): FakeReviewComment {
    const id = ++this.commentsSeq;
    const comment: FakeReviewComment = { id, pullNumber, ...input };
    this.state.comments.push(comment);
    if (input.inReplyToId === undefined) {
      this.state.threads.push({ id: `RT_${id}`, pullNumber, rootCommentId: id, commentIds: [id], resolved: false });
    } else {
      const thread = this.state.threads.find((t) => t.commentIds.includes(input.inReplyToId!));
      if (thread) thread.commentIds.push(id);
    }
    return comment;
  }

  private createReview(
    pullNumber: number,
    parsed: { body?: string; commit_id?: string; event?: string; comments?: FakeReviewCommentInput[] },
  ): FakeReview {
    const id = ++this.reviewsSeq;
    const review: FakeReview = {
      id,
      pullNumber,
      commitId: parsed.commit_id ?? this.state.pulls[pullNumber]?.headSha ?? "",
      event: (parsed.event as FakeReview["event"]) ?? "PENDING",
      body: parsed.body ?? "",
      author: this.botLogin,
      comments: [],
    };
    for (const c of parsed.comments ?? []) {
      review.comments.push(
        this.addComment(pullNumber, {
          reviewId: id,
          path: c.path ?? "",
          side: (c.side ?? "RIGHT") as "LEFT" | "RIGHT",
          line: c.line ?? 0,
          ...(c.start_line !== undefined
            ? { startSide: (c.start_side ?? c.side ?? "RIGHT") as "LEFT" | "RIGHT", startLine: c.start_line }
            : {}),
          body: c.body ?? "",
          commitId: review.commitId,
          author: this.botLogin,
        }),
      );
    }
    this.state.reviews.push(review);
    return review;
  }

  private toRestReview(review: FakeReview): Record<string, unknown> {
    return {
      ...review,
      // Real GitHub serves snake_case on the wire.
      commit_id: review.commitId,
      user: { login: review.author },
      comments: review.comments.map((c) => this.toRestComment(c)),
    };
  }

  private toRestComment(comment: FakeReviewComment): Record<string, unknown> {
    return {
      id: comment.id,
      user: { login: comment.author },
      path: comment.path,
      side: comment.side,
      line: comment.line,
      ...(comment.startSide !== undefined && comment.startLine !== undefined
        ? { start_side: comment.startSide, start_line: comment.startLine }
        : {}),
      body: comment.body,
      commit_id: comment.commitId,
      in_reply_to_id: comment.inReplyToId,
      pull_request_review_id: comment.reviewId,
    };
  }

  /** Test fixture: seed a submitted review directly in state (any author;
   * the reviewer bot's login replicates bot output without a create). */
  addSeededReview(
    pullNumber: number,
    input: { body: string; commitId?: string; author?: string; event?: FakeReview["event"] },
  ): FakeReview {
    const id = ++this.reviewsSeq;
    const review: FakeReview = {
      id,
      pullNumber,
      commitId: input.commitId ?? this.state.pulls[pullNumber]?.headSha ?? "",
      event: input.event ?? "COMMENT",
      body: input.body,
      author: input.author ?? this.botLogin,
      comments: [],
    };
    this.state.reviews.push(review);
    return review;
  }

  /** Test fixture: seed a comment directly in state (root, or reply via
   * `replyTo`). The author decides whose comment it is — human logins for
   * people's comments, the bot login to replicate bot output without a
   * summary review. */
  addSeededComment(
    pullNumber: number,
    input: { path?: string; side?: "LEFT" | "RIGHT"; line?: number; body: string; author: string; replyTo?: number },
  ): FakeReviewComment {
    if (input.replyTo !== undefined) {
      const root = this.state.comments.find((c) => c.id === input.replyTo);
      if (!root) throw new Error(`replyTo comment ${input.replyTo} not found`);
      return this.addComment(pullNumber, {
        inReplyToId: input.replyTo,
        path: root.path,
        side: root.side,
        line: root.line,
        body: input.body,
        commitId: root.commitId,
        author: input.author,
      });
    }
    return this.addComment(pullNumber, {
      path: input.path ?? "",
      side: input.side ?? "RIGHT",
      line: input.line ?? 0,
      body: input.body,
      commitId: "",
      author: input.author,
    });
  }

  /** All review comments on one pull request, newest last. */
  prComments(pullNumber: number): FakeReviewComment[] {
    return this.state.comments.filter((c) => c.pullNumber === pullNumber);
  }

  threadForComment(commentId: number): FakeThread | undefined {
    return this.state.threads.find((t) => t.commentIds.includes(commentId));
  }

  /** Test fixture: resolve or unresolve the thread containing `commentId`. */
  resolveThreadOfComment(commentId: number, resolved: boolean): void {
    const thread = this.threadForComment(commentId);
    if (!thread) throw new Error(`no thread for comment ${commentId}`);
    thread.resolved = resolved;
  }

  /** Aggregate what GitHub shows for a PR: published reviews (submitted only). */
  publishedReviews(pullNumber: number): FakeReview[] {
    return this.state.reviews.filter((r) => r.pullNumber === pullNumber && r.event !== "PENDING");
  }
}
