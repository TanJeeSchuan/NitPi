/**
 * Thin REST adapter implementing `GitHubApi` over any base URL (fake in tests,
 * real `api.github.com` in the workflow).
 */
import type { GitHubApi } from "./publisher.js";

export class RestGitHubApi implements GitHubApi {
  constructor(readonly normalizedBase: string, readonly token: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.normalizedBase}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as T) : (undefined as T);
    return { status: response.status, body: parsed };
  }

  createReview(repository: string, pullNumber: number, payload: unknown, signal?: AbortSignal) {
    return this.request<unknown>("POST", `/repos/${repository}/pulls/${pullNumber}/reviews`, payload, signal);
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

  /** Check runs at one commit: the named-check wait for automatic reviews. */
  listCheckRunsForHead(repository: string, headSha: string) {
    return this.request<unknown>("GET", `/repos/${repository}/commits/${headSha}/check-runs`);
  }
}
