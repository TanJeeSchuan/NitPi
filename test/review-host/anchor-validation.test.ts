/**
 * Unit seam for ticket 02: the pure Markdown location grammar and the pure
 * anchor validator. The scenario seam (review host process boundary) covers
 * the full correction loop; these tests pin the parsing and validation rules
 * the loop depends on.
 */
import { describe, expect, it } from "vitest";
import { parseLocation, type ReviewFinding } from "../../src/review-host/artifact.js";
import { parseUnifiedDiffAnchors, validateFindingAnchors } from "../../src/review-host/anchor-validation.js";

/**
 * The unified diff of the git fixture's base→head change (git-fixture.ts):
 * src/handler.ts replaces the one-line return with a concatenation loop.
 */
export const FIXTURE_DIFF = [
  "diff --git a/src/handler.ts b/src/handler.ts",
  "index 0000000..1111111 100644",
  "--- a/src/handler.ts",
  "+++ b/src/handler.ts",
  "@@ -1,3 +1,8 @@",
  " export function handler(input: string): string {",
  "-  return input.trim();",
  "+  const parts = input.split(',');",
  "+  let result = '';",
  "+  for (const part of parts) {",
  "+    result += part.trim().toUpperCase() + ' ';",
  "+  }",
  "+  return result.trim();",
  " }",
].join("\n");

describe("inline location parsing", () => {
  it("parses the single-line form (ticket 01 grammar)", () => {
    expect(parseLocation("src/handler.ts | RIGHT | 3")).toEqual({
      path: "src/handler.ts",
      side: "RIGHT",
      line: 3,
    });
  });

  it("parses the range form: end side/line, then start side/line", () => {
    expect(parseLocation("src/handler.ts | RIGHT | 5 | RIGHT | 3")).toEqual({
      path: "src/handler.ts",
      side: "RIGHT",
      line: 5,
      startSide: "RIGHT",
      startLine: 3,
    });
    expect(parseLocation("src/handler.ts | RIGHT | 5 | LEFT | 2")).toEqual({
      path: "src/handler.ts",
      side: "RIGHT",
      line: 5,
      startSide: "LEFT",
      startLine: 2,
    });
  });

  it("rejects malformed range forms", () => {
    expect(parseLocation("src/handler.ts | RIGHT | 5 | RIGHT")).toBeUndefined();
    expect(parseLocation("src/handler.ts | RIGHT | 5 | UP | 3")).toBeUndefined();
    expect(parseLocation("src/handler.ts | RIGHT | 5 | RIGHT | 0")).toBeUndefined();
    expect(parseLocation("src/handler.ts | RIGHT | 5 | RIGHT | x")).toBeUndefined();
    expect(parseLocation("src/handler.ts | RIGHT | 5 | RIGHT | 3 | extra")).toBeUndefined();
  });
});

describe("pinned diff anchors", () => {
  it("derives anchors from context, added and removed lines", () => {
    const anchors = parseUnifiedDiffAnchors(FIXTURE_DIFF);
    expect(anchors.has("src/handler.ts", "LEFT", 1)).toBe(true); // context
    expect(anchors.has("src/handler.ts", "LEFT", 2)).toBe(true); // removed
    expect(anchors.has("src/handler.ts", "LEFT", 3)).toBe(true); // context
    expect(anchors.has("src/handler.ts", "LEFT", 4)).toBe(false);
    expect(anchors.has("src/handler.ts", "RIGHT", 1)).toBe(true); // context
    expect(anchors.has("src/handler.ts", "RIGHT", 3)).toBe(true); // added
    expect(anchors.has("src/handler.ts", "RIGHT", 5)).toBe(true); // added
    expect(anchors.has("src/handler.ts", "RIGHT", 8)).toBe(true); // context
    expect(anchors.has("src/handler.ts", "RIGHT", 9)).toBe(false);
    expect(anchors.has("src/other.ts", "RIGHT", 1)).toBe(false);
  });

  it("handles new files, single-line hunk headers and multiple files", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const x = 1;",
      "+export const y = 2;",
      "diff --git a/src/old.ts b/src/old.ts",
      "index 3333333..4444444 100644",
      "--- a/src/old.ts",
      "+++ b/src/old.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");
    const anchors = parseUnifiedDiffAnchors(diff);
    expect(anchors.has("src/new.ts", "RIGHT", 1)).toBe(true);
    expect(anchors.has("src/new.ts", "RIGHT", 2)).toBe(true);
    expect(anchors.has("src/new.ts", "LEFT", 1)).toBe(false);
    expect(anchors.has("src/old.ts", "LEFT", 1)).toBe(true);
    expect(anchors.has("src/old.ts", "RIGHT", 1)).toBe(true);
  });

  it("ignores no-newline markers and blank inter-file lines", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "index 0000000..1111111 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old line",
      "\\ No newline at end of file",
      "+new line",
      "\\ No newline at end of file",
    ].join("\n");
    const anchors = parseUnifiedDiffAnchors(diff);
    expect(anchors.has("a.txt", "LEFT", 1)).toBe(true);
    expect(anchors.has("a.txt", "RIGHT", 1)).toBe(true);
    expect(anchors.size).toBe(2);
  });
});

describe("anchor validation", () => {
  const anchors = parseUnifiedDiffAnchors(FIXTURE_DIFF);

  function finding(overrides: Partial<ReviewFinding>): ReviewFinding {
    return {
      label: "F1",
      section: "## F1 — section\nsrc/handler.ts | RIGHT | 3",
      path: "src/handler.ts",
      side: "RIGHT",
      line: 3,
      ...overrides,
    };
  }

  it("accepts single-line and range anchors that are in the diff", () => {
    expect(validateFindingAnchors([finding({ line: 5 })], anchors)).toEqual([]);
    expect(
      validateFindingAnchors([finding({ line: 5, startSide: "RIGHT", startLine: 3 })], anchors),
    ).toEqual([]);
    expect(
      validateFindingAnchors([finding({ side: "LEFT", line: 2 })], anchors),
    ).toEqual([]);
  });

  it("rejects anchors outside the diff with a reason naming the anchor", () => {
    const invalid = validateFindingAnchors([finding({ line: 99 })], anchors);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ label: "F1" });
    expect(invalid[0]!.reason).toContain("RIGHT line 99");
    expect(invalid[0]!.reason).toContain("src/handler.ts");

    const wrongPath = validateFindingAnchors([finding({ path: "src/absent.ts" })], anchors);
    expect(wrongPath[0]!.reason).toContain("does not appear in the reviewed diff");
  });

  it("rejects ranges whose start is not in the diff or lies after the end", () => {
    const badStart = validateFindingAnchors(
      [finding({ line: 5, startSide: "RIGHT", startLine: 9 })],
      anchors,
    );
    expect(badStart[0]!.reason).toContain("range start RIGHT line 9");

    const startAfterEnd = validateFindingAnchors(
      [finding({ line: 3, startSide: "RIGHT", startLine: 5 })],
      anchors,
    );
    expect(startAfterEnd[0]!.reason).toContain("after the end");
  });

  it("rejects ranges whose start and end lie on different sides", () => {
    const crossSide = validateFindingAnchors(
      [finding({ line: 2, side: "LEFT", startSide: "RIGHT", startLine: 5 })],
      anchors,
    );
    expect(crossSide[0]!.reason).toContain("same side");
  });

  it("accepts evidence citing unchanged code — only the inline anchor is checked", () => {
    const section = [
      "## F1 — problem introduced here, visible in unchanged callers",
      "",
      "The caller at src/caller.ts:10 (unchanged by this PR) now double-trims.",
      "Config at config/app.yml line 4 is unaffected but relevant.",
      "src/handler.ts | RIGHT | 3",
    ].join("\n");
    const invalid = validateFindingAnchors([finding({ section })], anchors);
    expect(invalid).toEqual([]);
  });
});
