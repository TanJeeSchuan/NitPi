/**
 * Thin REST + GraphQL adapter implementing `GitHubApi` over any base URL
 * (fake in tests, `api.github.com` in the workflow).
 */
import type { GitHubApi } from "./publisher.js";

export class RestGitHubApi implements GitHubApi {
  constructor(readonly normalizedBase: string, readonly token: string) {}

  /**
   * GraphQL endpoint: `{host}/api/graphql` when the REST base carries the
   * `/api/v3` suffix (GitHub Enterprise-style), else `{base}/graphql`
   * (`https://api.github.com`).
   */
  private graphqlUrl(): string {
    if (this.normalizedBase.endsWith("/api/v3")) {
      return `${this.normalizedBase.slice(0, -"/api/v3".length)}/api/graphql`;
    }
    return `${this.normalizedBase.replace(/\/$/, "")}/graphql`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    options: { accept?: string; rawText?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    return this.send<T>(method, `${this.normalizedBase}${path}`, body, signal, options);
  }

  private async send<T>(
    method: string,
    url: string,
    body?: unknown,
    signal?: AbortSignal,
    options: { accept?: string; rawText?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(url, {
      method,
      headers: {
        accept: options.accept ?? "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    const parsed = options.rawText ? (text as T) : text ? (JSON.parse(text) as T) : (undefined as T);
    return { status: response.status, body: parsed };
  }

  createReview(repository: string, pullNumber: number, payload: unknown, signal?: AbortSignal) {
    return this.request<unknown>("POST", `/repos/${repository}/pulls/${pullNumber}/reviews`, payload, signal);
  }

  updateReview(repository: string, pullNumber: number, reviewId: number, payload: unknown) {
    return this.request<unknown>(
      "PATCH",
      `/repos/${repository}/pulls/${pullNumber}/reviews/${reviewId}`,
      payload,
    );
  }

  listReviews(repository: string, pullNumber: number) {
    return this.request<unknown>("GET", `/repos/${repository}/pulls/${pullNumber}/reviews`);
  }

  createReviewComment(repository: string, pullNumber: number, payload: unknown, signal?: AbortSignal) {
    return this.request<unknown>(
      "POST",
      `/repos/${repository}/pulls/${pullNumber}/comments`,
      payload,
      signal,
    );
  }

  listReviewComments(repository: string, pullNumber: number) {
    return this.request<unknown>("GET", `/repos/${repository}/pulls/${pullNumber}/comments`);
  }

  updateReviewComment(repository: string, commentId: number, payload: unknown, signal?: AbortSignal) {
    return this.request<unknown>(
      "PATCH",
      `/repos/${repository}/pulls/comments/${commentId}`,
      payload,
      signal,
    );
  }

  createCheckRun(repository: string, payload: unknown) {
    return this.request<unknown>("POST", `/repos/${repository}/check-runs`, payload);
  }

  getPullRequest(repository: string, pullNumber: number) {
    return this.request<unknown>("GET", `/repos/${repository}/pulls/${pullNumber}`);
  }

  getCollaboratorPermission(repository: string, username: string) {
    return this.request<unknown>(
      "GET",
      `/repos/${repository}/collaborators/${encodeURIComponent(username)}/permission`,
    );
  }

  getAuthenticatedUser() {
    return this.request<unknown>("GET", "/user");
  }

  graphql(query: string, variables: Record<string, unknown>, signal?: AbortSignal) {
    return this.send<{ data?: unknown; errors?: Array<{ message: string }> }>(
      "POST",
      this.graphqlUrl(),
      { query, variables },
      signal,
    );
  }

  /** The PR's unified diff (base→head), served with the `diff` media type. */
  getPullRequestDiff(repository: string, pullNumber: number) {
    return this.request<string>("GET", `/repos/${repository}/pulls/${pullNumber}`, undefined, undefined, {
      accept: "application/vnd.github.diff",
      rawText: true,
    });
  }
}
