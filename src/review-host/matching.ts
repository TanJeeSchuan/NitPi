/**
 * Post-freeze matching (ticket 04 — maintained findings across reruns).
 *
 * After the final review is frozen, one more turn in the same re-reviewer
 * conversation receives the pull request's earlier published review comments
 * and their comment IDs, and assigns each current finding to the earlier
 * comment it corresponds to by meaning, or to none. The turn is
 * matching-only: the frozen findings, their text and their anchors never
 * change (spec: "That turn receives earlier published findings and comment
 * IDs, and it can only assign matches").
 *
 * This module owns the matching grammar — the prompt shown to the
 * re-reviewer, the parser for its reply, and the validation that every
 * model-supplied comment ID belongs to this pull request and was written by
 * the reviewer bot. Validation is pure: the publisher acts only on validated
 * matches, and rejected IDs are recorded with their reason.
 */
import type { DiffSide, ReviewFinding } from "./artifact.js";

/** One review comment as read from GitHub (any author). */
export interface PublishedComment {
  id: number;
  path: string;
  side: DiffSide;
  line: number;
  body: string;
  /** Author login on GitHub. */
  author: string;
  /** Set when the comment is a reply inside another thread. */
  inReplyToId?: number;
}

/** The model's assignment: label → earlier comment id, or null (no match). */
export interface FindingMatch {
  label: string;
  commentId: number | null;
}

/** A model-supplied match that failed the ownership check, with its reason. */
export interface MatchRejection {
  label: string;
  commentId?: number;
  reason: string;
}

/** A validated assignment the publisher may act on. */
export interface ValidMatch {
  label: string;
  commentId: number;
}

/** First line of the banner the publisher writes on superseded comments.
 * Detection keys on it so a superseded comment never re-enters the matching
 * pool: its finding now lives at a different anchor. */
export const SUPERSEDED_MARKER_PREFIX = "**Superseded:**";

/** True when a publisher write marked this comment superseded earlier. */
export function isSupersededComment(comment: PublishedComment): boolean {
  return comment.body.startsWith(SUPERSEDED_MARKER_PREFIX);
}

/** Build the matching-only prompt for the frozen final review's findings.
 *
 * Only the reviewer bot's earlier THREAD ROOT comments are shown, superseded
 * ones excluded: they are the findings the re-reviewer may assign to. Human
 * comments are never offered as match targets (and would be rejected by
 * `validateMatches` if the model named one anyway).
 */
export function matchableComments(comments: PublishedComment[], botLogin: string): PublishedComment[] {
  return comments.filter(
    (c) => c.author === botLogin && c.inReplyToId === undefined && !isSupersededComment(c),
  );
}

/** Build the matching-only prompt for the frozen final review's findings. */
export function buildMatchPrompt(findings: ReviewFinding[], earlierBotComments: PublishedComment[]): string {
  const current = findings
    .map((f) => `[ ${f.label} | ${f.path} | ${f.side} | ${f.line} ]\n${f.section}`)
    .join("\n\n");
  const earlier = earlierBotComments
    .map((c) => `#${c.id} | ${c.path} | ${c.side} | ${c.line}\n${c.body}`)
    .join("\n\n");
  return [
    "Your final review is frozen and must not change. This is a MATCHING-ONLY turn for publication:",
    "assign each current finding to the earlier published comment it corresponds to by meaning, or to none.",
    "You cannot change the frozen findings, their text, their anchors, or the audit notes.",
    "",
    "Current findings (frozen):",
    "",
    current,
    "",
    "Earlier published review comments (all written by the reviewer bot on this pull request):",
    "",
    earlier,
    "",
    "Reply with only the match list — exactly one line per finding label above, in the form:",
    "F1 -> 12345",
    "or",
    "F2 -> none",
  ].join("\n");
}

const MATCH_LINE = /^(F\d+)\s*->\s*(\d+|none)\s*$/i;

/** Parse the match-list reply. One line per known label; the first line for a
 * label wins. Unknown labels and malformed lines are ignored — the publisher
 * acts only on assignments for findings the frozen review actually has. */
export function parseMatchList(
  reply: string,
  validLabels: ReadonlySet<string>,
): { matches: FindingMatch[]; ignored: string[] } {
  const matches: FindingMatch[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of reply.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = MATCH_LINE.exec(line);
    if (!match) continue;
    const label = match[1]!;
    if (!validLabels.has(label) || seen.has(label)) {
      ignored.push(line);
      continue;
    }
    seen.add(label);
    const idToken = match[2]!;
    matches.push({
      label,
      commentId: idToken.toLowerCase() === "none" ? null : Number.parseInt(idToken, 10),
    });
  }
  return { matches, ignored };
}

/** Validate raw model matches against the comments actually on this pull
 * request (the snapshot read at matching time). An ID is usable only when it
 * exists on this pull request, was written by the reviewer bot on this pull
 * request, is a thread root, and was not superseded earlier; each earlier
 * comment can back at most one finding. Everything else is rejected with a
 * reason and never acted on. */
export function validateMatches(
  matches: FindingMatch[],
  earlier: PublishedComment[],
  botLogin: string,
): { matches: ValidMatch[]; rejections: MatchRejection[] } {
  const byId = new Map(earlier.map((c) => [c.id, c]));
  const valid: ValidMatch[] = [];
  const rejections: MatchRejection[] = [];
  const claimed = new Map<number, string>();
  for (const match of matches) {
    if (match.commentId === null) continue;
    const comment = byId.get(match.commentId);
    if (!comment) {
      rejections.push({
        label: match.label,
        commentId: match.commentId,
        reason: `comment ${match.commentId} does not belong to this pull request`,
      });
      continue;
    }
    if (comment.author !== botLogin) {
      rejections.push({
        label: match.label,
        commentId: match.commentId,
        reason: `comment ${match.commentId} was not written by the reviewer bot (author: ${comment.author})`,
      });
      continue;
    }
    if (comment.inReplyToId !== undefined) {
      rejections.push({
        label: match.label,
        commentId: match.commentId,
        reason: `comment ${match.commentId} is a reply, not a thread root`,
      });
      continue;
    }
    if (isSupersededComment(comment)) {
      rejections.push({
        label: match.label,
        commentId: match.commentId,
        reason: `comment ${match.commentId} was superseded earlier; its replacement comment carries the finding`,
      });
      continue;
    }
    const firstLabel = claimed.get(match.commentId);
    if (firstLabel && firstLabel !== match.label) {
      rejections.push({
        label: match.label,
        commentId: match.commentId,
        reason: `comment ${match.commentId} is already matched to ${firstLabel}`,
      });
      continue;
    }
    claimed.set(match.commentId, match.label);
    valid.push({ label: match.label, commentId: match.commentId });
  }
  return { matches: valid, rejections };
}
