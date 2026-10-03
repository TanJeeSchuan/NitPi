/**
 * Anchor validation against the pinned diff (ticket 02).
 *
 * Every published finding lands on a line that is valid in the reviewed diff.
 * The pinned diff is the pull request's base→head diff as GitHub computes it;
 * the host parses it into the set of anchorable (path, side, line) triples and
 * checks each final section's inline location against that set.
 *
 * Evidence that cites unchanged code (callers, config) is accepted: only the
 * inline anchor has to be in the diff. Anchors are never guessed here — an
 * invalid anchor is returned to the re-reviewer with the reason (review-task).
 */
import type { DiffSide, ReviewFinding } from "./artifact.js";

/** The set of (path, side, line) triples anchorable in the pinned diff. */
export class DiffAnchors {
  private readonly lines = new Set<string>();

  add(path: string, side: DiffSide, line: number): void {
    this.lines.add(`${path}#${side}#${line}`);
  }

  has(path: string, side: DiffSide, line: number): boolean {
    return this.lines.has(`${path}#${side}#${line}`);
  }

  /** Whether the path appears anywhere in the diff. */
  hasPath(path: string): boolean {
    for (const key of this.lines) {
      if (key.startsWith(`${path}#`)) return true;
    }
    return false;
  }

  /** All anchored triples, structured. */
  entries(): Array<{ path: string; side: DiffSide; line: number }> {
    return [...this.lines].map((key) => {
      const [path, side, line] = key.split("#");
      return { path: path!, side: side as DiffSide, line: Number.parseInt(line!, 10) };
    });
  }

  get size(): number {
    return this.lines.size;
  }
}

/**
 * Parse a unified diff (git/GitHub `diff` media type) into its anchorable
 * lines. Context lines anchor on both sides; `-` lines anchor LEFT at their
 * old-file position; `+` lines anchor RIGHT at their new-file position.
 */
export function parseUnifiedDiffAnchors(diffText: string): DiffAnchors {
  const anchors = new DiffAnchors();
  const normalized = diffText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let path: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = diffPath(line.slice(4)) ?? path;
      continue;
    }
    if (line.startsWith("--- ")) {
      // For deletions the only path is on the `---` line (`+++ /dev/null`).
      const oldPath = diffPath(line.slice(4));
      if (oldPath) path = oldPath;
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1]!, 10);
      newLine = Number.parseInt(hunk[2]!, 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || !path) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      anchors.add(path, "RIGHT", newLine);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      anchors.add(path, "LEFT", oldLine);
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      anchors.add(path, "LEFT", oldLine);
      anchors.add(path, "RIGHT", newLine);
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // File headers, index lines, mode lines and blank separators: ignored.
  }
  return anchors;
}

/** One finding whose inline anchor is not valid in the pinned diff. */
export interface InvalidAnchor {
  /** The finding's reviewing label (`F1`, ...). */
  label: string;
  /** The location as the re-reviewer wrote it, e.g. `src/x.ts | RIGHT | 99`. */
  written: string;
  /** Human-readable reason, returned verbatim to the re-reviewer. */
  reason: string;
}

/**
 * Check every finding's inline anchor against the pinned diff. Evidence is
 * never validated: a finding may cite unchanged code (callers, config); only
 * its inline location has to be in the diff.
 */
export function validateFindingAnchors(
  findings: readonly ReviewFinding[],
  anchors: DiffAnchors,
): InvalidAnchor[] {
  const invalid: InvalidAnchor[] = [];
  for (const finding of findings) {
    const reason = anchorProblem(finding, anchors);
    if (reason) {
      invalid.push({ label: finding.label, written: writtenLocation(finding), reason });
    }
  }
  return invalid;
}

function writtenLocation(finding: ReviewFinding): string {
  const parts = [finding.path, finding.side, String(finding.line)];
  if (finding.startSide !== undefined && finding.startLine !== undefined) {
    parts.push(finding.startSide, String(finding.startLine));
  }
  return parts.join(" | ");
}

function anchorProblem(finding: ReviewFinding, anchors: DiffAnchors): string | undefined {
  if (!anchors.hasPath(finding.path)) {
    return `path "${finding.path}" does not appear in the reviewed diff`;
  }
  if (!anchors.has(finding.path, finding.side, finding.line)) {
    return `${finding.side} line ${finding.line} of "${finding.path}" is not part of the reviewed diff`;
  }
  if (finding.startSide !== undefined && finding.startLine !== undefined) {
    if (finding.startSide !== finding.side) {
      return `range start ${finding.startSide} line ${finding.startLine} must be on the same side as the end ${finding.side} line ${finding.line}`;
    }
    if (!anchors.has(finding.path, finding.startSide, finding.startLine)) {
      return `range start ${finding.startSide} line ${finding.startLine} of "${finding.path}" is not part of the reviewed diff`;
    }
    if (finding.startLine > finding.line) {
      return `range start ${finding.startSide} line ${finding.startLine} is after the end ${finding.side} line ${finding.line}`;
    }
  }
  return undefined;
}

/** Strip the `a/`/`b/` prefix and git's quoting from a diff path. */
function diffPath(raw: string): string | undefined {
  const trimmed = raw.trim().split("\t")[0]!;
  if (trimmed === "/dev/null") return undefined;
  const withoutPrefix = trimmed.replace(/^[ab]\//, "");
  if (!withoutPrefix) return undefined;
  if (withoutPrefix.startsWith('"') && withoutPrefix.endsWith('"') && withoutPrefix.length >= 2) {
    return withoutPrefix.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return withoutPrefix;
}
