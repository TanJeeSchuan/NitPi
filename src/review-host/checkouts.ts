/**
 * Stage checkouts: each reviewer works on its own unchanged checkout of the
 * reviewed head (spec: "each reviewer to start from an unchanged checkout of
 * the reviewed revision, so that the primary's scratch edits can't affect the
 * re-review or the evidence it cites").
 *
 * The host receives the workflow's checked-out repository (trusted main-branch
 * workflow performed the checkout) and derives one disposable git worktree per
 * stage, pinned at the reviewed head SHA. Worktrees are re-created
 * idempotently when missing, so a resumed run keeps working.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class CheckoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutError";
  }
}

export interface StageCheckouts {
  readonly primary: string;
  readonly reReview: string;
}

/** Ensure per-stage worktrees of `headSha` under a stable scratch root. */
export function ensureStageCheckouts(sourceRepo: string, headSha: string, scratchRoot?: string): StageCheckouts {
  assertHeadPresent(sourceRepo, headSha);
  const root = scratchRoot ?? join(mkdtempSync(join(tmpdir(), "nitpi-checkout-")), "stages");
  const primary = join(root, "primary");
  const reReview = join(root, "re-review");
  ensureWorktree(sourceRepo, primary, headSha);
  ensureWorktree(sourceRepo, reReview, headSha);
  return { primary, reReview };
}

function git(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFailure) return "";
    throw new CheckoutError(`git ${args.join(" ")} failed: ${describeGitError(error)}`);
  }
}

function describeGitError(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    return String((error as { stderr: unknown }).stderr ?? "").trim() || String(error);
  }
  return String(error);
}

function assertHeadPresent(sourceRepo: string, headSha: string): void {
  if (!existsSync(join(sourceRepo, ".git"))) {
    throw new CheckoutError(`headCheckoutSource ${sourceRepo} is not a git repository`);
  }
  const resolved = git(sourceRepo, ["rev-parse", `${headSha}^{commit}`], true).trim();
  if (resolved !== headSha) {
    throw new CheckoutError(`checked-out repository does not contain reviewed head ${headSha}`);
  }
}

function ensureWorktree(sourceRepo: string, path: string, headSha: string): void {
  mkdirSync(path, { recursive: true });
  if (readdirSync(path).length === 0) {
    // Fresh directory: attach a detached worktree at the pinned head.
    git(sourceRepo, ["worktree", "add", "--detach", path, headSha]);
  }
  const current = git(path, ["rev-parse", "HEAD"], true).trim();
  if (current !== headSha) {
    // Stale or corrupted worktree: recreate from scratch.
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    git(sourceRepo, ["worktree", "add", "--detach", path, headSha]);
  }
}
