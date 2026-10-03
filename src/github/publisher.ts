/**
 * GitHub publication (spec: Publisher + ticket 01's publication criterion).
 *
 * Creates ONE review with `event: COMMENT` and `commit_id` = reviewed head
 * SHA. The summary shows the reviewed commit, the outcome and the finding
 * count; each final finding becomes one inline comment anchored with
 * path/side/line.
 *
 * v0 publisher restriction (ticket 01): anchors are assumed valid on the model
 * side (validation is ticket 02), but an anchor that GitHub rejects (422) fails
 * with an explicit reason and is not retried here. Publication idempotency and
 * reconciliation are ticket 05; this thin slice publishes once per run.
 */
import type { ReviewFinding } from "../review-host/artifact.js";
import type { RunDocument } from "../review-host/run-history.js";

/** Typed subset of the GitHub REST endpoints the reviewer host uses. */
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
  /** Trigger-gate inputs (minimal gate for ticket 01; full gate is ticket 03). */
  getPullRequest(repository: string, pullNumber: number): Promise<{ status: number; body: unknown }>;
  getCollaboratorPermission(
    repository: string,
    username: string,
  ): Promise<{ status: number; body: unknown }>;
  /**
   * The pull request's unified diff (base→head), the pinned diff anchor
   * validation checks against (ticket 02). Served with the `diff` media type.
   */
  getPullRequestDiff(repository: string, pullNumber: number): Promise<{ status: number; body: string }>;
}

export interface PublishedResult {
  reviewId: number;
  commentIds: number[];
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

  /** Publish one advisory review for the reviewed head. Failure = explicit reason. */
  async publish(
    run: RunDocument,
    finalReview: string,
    findings: ReviewFinding[],
    signal?: AbortSignal,
  ): Promise<PublishedResult> {
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
          ...(f.startSide !== undefined && f.startLine !== undefined
            ? { start_side: f.startSide, start_line: f.startLine }
            : {}),
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

function describeBody(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    return String(record.detail ?? record.message ?? JSON.stringify(body));
  }
  return String(body);
}
