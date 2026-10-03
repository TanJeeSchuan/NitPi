/**
 * Temporary git repository fixture: base and head commits with a small diff,
 * exactly what the scenario harness asserts the reviewer was pointed at.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitRepoFixture {
  path: string;
  baseSha: string;
  headSha: string;
  baseCheckout(): string;
  headCheckout(): string;
  readFile(revision: string, relativePath: string): string;
  dispose(): void;
}

export function createGitRepoFixture(): GitRepoFixture {
  const root = mkdtempSync(join(tmpdir(), "nitpi-repo-"));
  const base = join(root, "base");
  const head = join(root, "head");
  const git = (cwd: string, args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

  for (const dir of [base, head]) {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--initial-branch=main"]);
    git(dir, ["config", "user.email", "reviewer-fixture@example.invalid"]);
    git(dir, ["config", "user.name", "Review Fixture"]);
  }

  writeFileSync(join(base, "README.md"), "fixture base\n");
  mkdirSync(join(base, "src"), { recursive: true });
  writeFileSync(
    join(base, "src", "handler.ts"),
    ["export function handler(input: string): string {", "  return input.trim();", "}", ""].join("\n"),
  );
  mkdirSync(join(base, ".github"), { recursive: true });
  writeFileSync(join(base, ".github", "review-instructions.md"), "Be strict about unused parameters.\n");
  git(base, ["add", "."]);
  git(base, ["commit", "-m", "base"]);
  const baseSha = git(base, ["rev-parse", "HEAD"]).trim();

  writeFileSync(join(head, "README.md"), "fixture base\n");
  mkdirSync(join(head, "src"), { recursive: true });
  writeFileSync(
    join(head, "src", "handler.ts"),
    [
      "export function handler(input: string): string {",
      "  const parts = input.split(',');",
      "  let result = '';",
      "  for (const part of parts) {",
      "    result += part.trim().toUpperCase() + ' ';",
      "  }",
      "  return result.trim();",
      "}",
      "",
    ].join("\n"),
  );
  git(head, ["add", "."]);
  git(head, ["commit", "-m", "head"]);
  const headSha = git(head, ["rev-parse", "HEAD"]).trim();

  return {
    path: root,
    baseSha,
    headSha,
    baseCheckout: () => base,
    headCheckout: () => head,
    readFile(revision: string, relativePath: string): string {
      return readFileSync(join(root, revision, relativePath), "utf8");
    },
    dispose(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
