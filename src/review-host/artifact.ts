/**
 * Parsing of the final review Markdown into publishable findings.
 *
 * The re-reviewer's contract (instructions.ts) fixes one finding per section
 * with an inline location `path | LEFT/RIGHT | line`, or for a range
 * `path | LEFT/RIGHT | line | LEFT/RIGHT | startLine` (the range ends at
 * side/line and starts at startSide/startLine, mirroring GitHub's
 * `line`/`side` plus `start_line`/`start_side`). This parser derives the
 * publisher's anchors from the Markdown; the Markdown remains the source of
 * truth and nothing becomes a second source of truth.
 *
 * Ticket 01 assumed every inline anchor is valid; ticket 02 adds validation
 * (anchor-validation.ts). A labeled finding section without an inline
 * location is a parse error, not a silent drop.
 */
export type DiffSide = "LEFT" | "RIGHT";

/** One finding: the Markdown section plus the inline anchor derived from it. */
export interface ReviewFinding {
  /** `F1`, `F2`, ... by section order (the reviewing labels). */
  label: string;
  /** Section text (heading + body + location) verbatim as written. */
  section: string;
  path: string;
  side: DiffSide;
  line: number;
  /** Range start, present only when the location used the range form. */
  startSide?: DiffSide;
  startLine?: number;
}

export interface ParsedReview {
  findings: ReviewFinding[];
  auditNotes: string;
}

export class FinalReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinalReviewParseError";
  }
}

const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const AUDIT_HEADING = /^#\s+Audit notes.*$/m;

/**
 * Split the final review into `## ` sections and parse each section's trailing
 * inline location line. Location grammar: segments separated by ` | `,
 * expecting three segments (path, side, line). Content after an
 * `# Audit notes` heading is audit notes, not findings.
 */
export function parseFinalReview(markdown: string): ParsedReview {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const { review, audit } = splitAudit(normalized);
  const sections = splitSections(review);
  const findings: ReviewFinding[] = [];
  for (const section of sections) {
    const parsed = parseSection(section, findings.length + 1);
    if (parsed) findings.push(parsed);
  }
  return { findings, auditNotes: audit };
}

function splitAudit(markdown: string): { review: string; audit: string } {
  const auditMarker = markdown.match(AUDIT_HEADING);
  if (auditMarker && auditMarker.index !== undefined) {
    return {
      review: markdown.slice(0, auditMarker.index).trimEnd(),
      audit: markdown.slice(auditMarker.index).trimStart(),
    };
  }
  return { review: markdown, audit: "" };
}

function splitSections(review: string): string[] {
  const lines = review.split("\n");
  const sections: string[] = [];
  let current: string[] | undefined;
  let sawHeading = false;
  for (const line of lines) {
    if (SECTION_HEADING.test(line)) {
      if (current && sawHeading) sections.push(current.join("\n").trimEnd());
      current = [line];
      sawHeading = true;
    } else if (current) {
      current.push(line);
    }
    // Preamble before the first heading is ignored for findings.
  }
  if (current && sawHeading) sections.push(current.join("\n").trimEnd());
  return sections;
}

function parseSection(section: string, ordinal: number): ReviewFinding | undefined {
  const lines = section.split("\n");
  const heading = SECTION_HEADING.exec(lines[0] ?? "");
  const headingText = heading?.[1] ?? "";
  const labelMatch = headingText.match(/^F\d+/);
  const label = labelMatch?.[0] ?? `F${ordinal}`;
  for (let i = lines.length - 1; i >= 1; i--) {
    const location = parseLocation(lines[i] ?? "");
    if (location) {
      return { label, section, ...location };
    }
  }
  if (labelMatch) {
    // A labeled finding without an inline location must not silently vanish.
    throw new FinalReviewParseError(
      `finding ${label} has no inline location line ("path | LEFT/RIGHT | line")`,
    );
  }
  // Unlabeled sections (preamble-style) are not findings.
  return undefined;
}

export interface InlineLocation {
  path: string;
  side: DiffSide;
  line: number;
  /** Range start, present only in the five-segment range form. */
  startSide?: DiffSide;
  startLine?: number;
}

/**
 * Parse `path | LEFT|RIGHT | line` (three segments) or the range form
 * `path | LEFT|RIGHT | line | LEFT|RIGHT | startLine` (five segments),
 * ` | ` separated.
 */
export function parseLocation(line: string): InlineLocation | undefined {
  const parts = line.trim().split("|").map((p) => p.trim());
  if (parts.length === 3) {
    const [path, side, lineRaw] = parts;
    if (!path || !side || !lineRaw) return undefined;
    if (!isSide(side) || !isPositiveInt(lineRaw)) return undefined;
    return { path, side, line: Number.parseInt(lineRaw, 10) };
  }
  if (parts.length === 5) {
    const [path, side, lineRaw, startSide, startLineRaw] = parts;
    if (!path || !side || !lineRaw || !startSide || !startLineRaw) return undefined;
    if (!isSide(side) || !isPositiveInt(lineRaw)) return undefined;
    if (!isSide(startSide) || !isPositiveInt(startLineRaw)) return undefined;
    return {
      path,
      side,
      line: Number.parseInt(lineRaw, 10),
      startSide,
      startLine: Number.parseInt(startLineRaw, 10),
    };
  }
  return undefined;
}

function isSide(value: string): value is DiffSide {
  return value === "LEFT" || value === "RIGHT";
}

function isPositiveInt(value: string): boolean {
  return /^\d+$/.test(value) && Number.parseInt(value, 10) >= 1;
}
