/**
 * Fake GitHub: an in-memory fake of the GitHub REST + GraphQL subset this
 * reviewer uses (spec: Testing Decisions). It is both the scenario harness's
 * wire surface and the publisher's typed client target: the publisher talks
 * HTTP to a base URL; tests point it at <fake>/api/v3.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { parseUnifiedDiffAnchors } from "../../src/review-host/anchor-validation.js";

export interface FakePullRequest {
  number: number;
  headSha: string;
  baseSha: string;
  state: "open" | "closed";
}

export interface FakeReview {
  id: number;
  pullNumber: number;
  commitId: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" | "PENDING";
  body: string;
  comments: Array<{
    id: number;
    path: string;
    side: "LEFT" | "RIGHT";
    line: number;
    startSide?: "LEFT" | "RIGHT";
    startLine?: number;
    body: string;
    commitId: string;
  }>;
}

export interface FakeGitHubState {
  pulls: Record<number, FakePullRequest>;
  /** Diff rules: which path/line/side anchors are valid for the reviewed commit. */
  diffAnchors: Set<string>;
  reviews: FakeReview[];
  checks: Array<{ headSha: string; state: string; detail: string; summary: string }>;
  /** Scripted responses: applied-write, then dropped (unknown outcome). */
  dropNextWrite: { match: RegExp; remaining: number };
  /** 422 detail for malformed anchors. */
  validationErrors: Map<string, string>;
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
  private server: Server | undefined;
  private reviewsSeq = 100;
  private commentsSeq = 1000;

  constructor(
    readonly pulls: FakePullRequest[],
    readonly diffAnchors: string[] = [],
    readonly options: { diffText?: string } = {},
  ) {
    this.state = {
      pulls: Object.fromEntries(pulls.map((p) => [p.number, p])),
      diffAnchors: new Set(diffAnchors),
      reviews: [],
      checks: [],
      dropNextWrite: { match: /reviews$/, remaining: 0 },
      validationErrors: new Map(),
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

  private respond(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://fake-github.test");
    const path = url.pathname.replace(/^\/api\/v3/, "");
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
      this.route(request.method ?? "GET", path, body, response, accept);
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

  private route(method: string, path: string, body: string, response: ServerResponse, accept = ""): void {
    const prMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/);
    if (method === "POST" && prMatch) {
      const parsed = JSON.parse(body) as {
        body?: string;
        commit_id?: string;
        event?: string;
        comments?: FakeReviewCommentInput[];
      };
      const bad = parsed.comments?.find((c) => {
        const side = (c.side ?? "RIGHT") as "LEFT" | "RIGHT";
        if (!this.state.diffAnchors.has(`${c.path}#${side}#${c.line}`)) return true;
        if (c.start_line !== undefined) {
          const startSide = (c.start_side ?? side) as "LEFT" | "RIGHT";
          if (!this.state.diffAnchors.has(`${c.path}#${startSide}#${c.start_line}`)) return true;
        }
        return false;
      });
      if (bad) {
        this.respond(response, 422, { message: "Validation Failed", detail: `invalid anchor: ${bad.path}:${bad.line}` });
        return;
      }
      if (prMatch && !this.state.pulls[Number(prMatch[1])]) {
        this.respond(response, 404, { message: "Not Found" });
        return;
      }
      const review = this.createReview(Number(prMatch[1]), parsed);
      this.respond(response, 201, review);
      return;
    }

    const listMatch = path.match(/^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/);
    if (method === "GET" && listMatch) {
      this.respond(response, 200, this.state.reviews.filter((r) => r.pullNumber === Number(listMatch[1])));
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
      this.respond(response, 200, {
        number: pull.number,
        state: pull.state,
        head: { sha: pull.headSha },
        base: { sha: pull.baseSha },
      });
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

  private createReview(pullNumber: number, parsed: { body?: string; commit_id?: string; event?: string; comments?: FakeReviewCommentInput[] }): FakeReview {
    const id = ++this.reviewsSeq;
    const review: FakeReview = {
      id,
      pullNumber,
      commitId: parsed.commit_id ?? this.state.pulls[pullNumber]?.headSha ?? "",
      event: (parsed.event as FakeReview["event"]) ?? "PENDING",
      body: parsed.body ?? "",
      comments: (parsed.comments ?? []).map((c) => ({
        id: ++this.commentsSeq,
        path: c.path ?? "",
        side: (c.side ?? "RIGHT") as "LEFT" | "RIGHT",
        line: c.line ?? 0,
        ...(c.start_line !== undefined
          ? { startSide: (c.start_side ?? c.side ?? "RIGHT") as "LEFT" | "RIGHT", startLine: c.start_line }
          : {}),
        body: c.body ?? "",
        commitId: parsed.commit_id ?? "",
      })),
    };
    this.state.reviews.push(review);
    return review;
  }

  /** Aggregate what GitHub shows for a PR: published reviews (submitted only). */
  publishedReviews(pullNumber: number): FakeReview[] {
    return this.state.reviews.filter((r) => r.pullNumber === pullNumber && r.event !== "PENDING");
  }
}
/** Minimal HTTP client the publisher uses against the fake (or real) GitHub. */
export class GitHubClient {
  constructor(readonly normalizedBase: string, readonly token: string) {}

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.normalizedBase}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as T) : (undefined as T) };
  }

  createReview = (
    repository: string,
    pullNumber: number,
    payload: {
      commit_id: string;
      event: "COMMENT";
      body: string;
      comments: Array<{ path: string; side: "LEFT" | "RIGHT"; line: number; body: string }>;
    },
    signal?: AbortSignal,
  ): Promise<{ status: number; body: FakeReview | { message: string; detail?: string } }> =>
    this.request("POST", `/repos/${repository}/pulls/${pullNumber}/reviews`, payload, signal);

  createCheckRun = (
    repository: string,
    payload: { name: string; head_sha: string; status: "in_progress"; output: { title: string; summary: string } },
  ): Promise<{ status: number; body: unknown }> =>
    this.request("POST", `/repos/${repository}/check-runs`, payload);

  completeCheckRun = (
    repository: string,
    payload: {
      name: string;
      head_sha: string;
      status: "completed";
      conclusion: "success" | "failure";
      output: { title: string; summary: string };
    },
  ): Promise<{ status: number; body: unknown }> =>
    this.request("POST", `/repos/${repository}/check-runs`, payload);
}
