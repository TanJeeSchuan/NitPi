/**
 * Parsing of the final review Markdown into publishable findings.
 *
 * The re-reviewer's contract (instructions.ts) fixes one finding per section
 * with an inline location `path | LEFT/RIGHT | line`. This parser derives the
 * publisher's anchors from the Markdown; the Markdown remains the source of
 * truth and nothing becomes a second source of truth.
 *
 * Ticket 01 assumes every inline anchor is valid; validation lands in ticket
 * 02. The publisher still refuses anchors outside the reviewed diff.
 */
export interface ParsedFinding {
  /** `F1`, `F2`, ... by section order (the reviewing labels). */
  label: string;
  /** Section text (heading + body + location) verbatim as written. */
  section: string;
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
}

export interface ParsedReview {
  findings: ParsedFinding[];
  auditNotes: string;
}

const SECTION_HEADING = /^##\s+(.+?)\s*$/;

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
  const findings: ParsedFinding[] = [];
  for (const section of sections) {
    const parsed = parseSection(section, findings.length + 1);
    if (parsed) findings.push(parsed);
  }
  return { findings, auditNotes: audit };
}

function splitAudit(markdown: string): { review: string; audit: string } {
  const auditMarker = markdown.match(/^#\s+Audit notes.*$/m);
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

function parseSection(section: string, ordinal: number): ParsedFinding | undefined {
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
  // No inline location: not a publishable finding.
  return undefined;
}

export interface InlineLocation {
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
}

/** Parse `path | LEFT|RIGHT | line` (three segments, ` | ` separated). */
export function parseLocation(line: string): InlineLocation | undefined {
  const parts = line.trim().split("|").map((p) => p.trim());
  if (parts.length !== 3) return undefined;
  const [path, side, lineRaw] = parts;
  if (!path || !side || !lineRaw) return undefined;
  if (side !== "LEFT" && side !== "RIGHT") return undefined;
  if (!/^\d+$/.test(lineRaw)) return undefined;
  const lineNumber = Number.parseInt(lineRaw, 10);
  if (lineNumber < 1) return undefined;
  return { path, side, line: lineNumber };
}
