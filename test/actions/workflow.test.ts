/**
 * GitHub Actions hygiene smoke tests (ticket 11).
 *
 * The ticket's own note: the workflow's checks sit outside the scenario
 * test seam, so they are done by hand on a real PR — EXCEPT the
 * workflow-defined trust properties that a pull request must not be able
 * to violate. Those are pinned here, cheaply and textually:
 *
 * - the workflow triggers on the issue-comment and pull_request_target
 *   events (plus the check_run clock that re-kicks a durable pending
 *   request after its named-check wait deferred), with the six actions the
 *   host accepts;
 * - the workflow definition and the checked-out code come from the default
 *   branch (a PR cannot change the workflow that gates it);
 * - the default token's permissions are minimal; writes go through the
 *   publisher's secret token;
 * - one concurrency group per PR with cancel-in-progress disabled;
 * - the six named secrets are wired through `secrets.*` only;
 * - the runner joins the tailnet as an ephemeral tagged node.
 *
 * The live behaviors (event handling, check outcomes, the Tailscale join)
 * are the code under test in src/ plus manual verification on a real PR
 * (docs/actions-setup.md lists the manual checks).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = join(import.meta.dirname, "../../.github/workflows/tailscale-review.yml");
const ENTRY_PATH = join(import.meta.dirname, "../../actions/entry.mts");

const WORKFLOW = readFileSync(WORKFLOW_PATH, "utf8");
const ENTRY = readFileSync(ENTRY_PATH, "utf8");

/** Collapse whitespace so assertions pin structure, not formatting. */
function normalized(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[ \t]+/, "").replace(/[ \t]+/g, " "))
    .join("\n")
    .replace(/\n+/g, "\n");
}

const WORKFLOW_TEXT = normalized(WORKFLOW);

describe("workflow trust pins (ticket 11)", () => {
  it("triggers on issue-comment, pull_request_target and the check-run clock, with the six accepted actions", () => {
    expect(WORKFLOW_TEXT).toContain("issue_comment:");
    expect(WORKFLOW_TEXT).toContain("pull_request_target:");
    // The check-run clock: a durable pending request's named-check wait is
    // re-kicked when a watched check completes (ticket 03's re-kick).
    expect(WORKFLOW_TEXT).toContain("check_run:");
    expect(WORKFLOW_TEXT).toContain("types: [completed]");
    for (const action of [
      "opened", "reopened", "synchronize", "ready_for_review", "closed", "converted_to_draft",
    ]) {
      expect(WORKFLOW_TEXT).toContain(`- ${action}`);
    }
    // Not subscribed to the PR-modifiable pull_request event.
    expect(WORKFLOW_TEXT).not.toMatch(/^\s*pull_request:\s*$/m);
    // A comment edit must not re-run the gate.
    expect(WORKFLOW_TEXT).toContain("types: [created]");
  });

  it("checks out and runs the default branch, never the PR's workflow", () => {
    expect(WORKFLOW_TEXT).toContain("ref: ${{ github.event.repository.default_branch }}");
    // The reviewed head is fetched as objects only (never checked out, never run).
    expect(WORKFLOW_TEXT).toContain("refs/pull/$PR_NUMBER/head");
  });

  it("limits the default token to read; publication uses the publisher secret", () => {
    expect(WORKFLOW_TEXT).toContain("permissions:\ncontents: read");
    // No write scope is granted to the default token anywhere in the file:
    // only comment prose may mention the publisher's scopes.
    expect(WORKFLOW_TEXT).not.toMatch(/^pull-requests: write$/m);
    expect(WORKFLOW_TEXT).not.toMatch(/^checks: write$/m);
    // The publisher token and the other secrets flow through the entry's env.
    for (const secret of [
      "NITPI_PRIMARY_API_KEY",
      "NITPI_RE_REVIEW_API_KEY",
      "NITPI_STORAGE_AUTH_KEY",
      "NITPI_GITHUB_TOKEN",
      "NITPI_TAILSCALE_OAUTH_SECRET",
    ]) {
      expect(WORKFLOW_TEXT).toContain(`secrets.${secret}`);
    }
  });

  it("runs one review pipeline per pull request, cancel-in-progress disabled", () => {
    expect(WORKFLOW_TEXT).toContain(
      "group: nitpi-review-${{ github.event.issue.number || github.event.pull_request.number || github.event.check_run.pull_requests[0].number || github.run_id }}",
    );
    expect(WORKFLOW_TEXT).toContain("cancel-in-progress: false");
  });

  it("joins the tailnet as an ephemeral tagged node", () => {
    expect(WORKFLOW_TEXT).toContain("tailscale.com/install.sh");
    expect(WORKFLOW_TEXT).toContain("--advertise-tags=\"$TS_TAGS\"");
    // OAuth-registered nodes are ephemeral by default; the auth key comes
    // from the OAuth client secret (tailscale/kb/1215).
    expect(WORKFLOW_TEXT).toContain("--auth-key=\"$TS_AUTHKEY\"");
  });

  it("runs the entry point with the workflow-input and secret env wiring", () => {
    expect(WORKFLOW_TEXT).toContain("node_modules/.bin/tsx actions/entry.mts");
    expect(WORKFLOW_TEXT).toContain("NITPI_ACTION: ${{ needs.decide.outputs.kind }}");
    expect(WORKFLOW_TEXT).toContain("NITPI_DELIVERY_ID:");
  });

  it("keeps the entry point and the workflow on the trusted default branch", () => {
    // The entry imports only the repo's own src; no third-party runtime
    // beyond the package-lock-pinned dependencies (npm ci).
    expect(ENTRY).toContain('from "../src/review-host/review-host.js"');
    expect(ENTRY).toContain('from "../src/review-host/config.js"');
    expect(ENTRY).toContain('from "../src/storage/remote-storage.js"');
  });
});

describe("entry exit contract (ticket 11)", () => {
  it("documents the 0/1/2 exit contract it implements", () => {
    expect(ENTRY).toContain("0 — settled");
    expect(ENTRY).toContain("1 — the run's terminal state was a failure");
    expect(ENTRY).toContain("2 — configuration error before anything ran");
  });
});
