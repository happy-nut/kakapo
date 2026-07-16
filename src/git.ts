import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { GitSnapshot } from "./types.js";

export function isGitRepository(root: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && (result.stdout ?? "").trim() === "true";
}

export function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

export type AutomaticReviewBase = {
  revision: string;
  upstream: string;
  label: string;
  ahead: number;
};

// A clean worktree can still contain the exact changes that need review when its branch has local,
// unpushed commits. In that state HEAD-vs-worktree is empty, so use the tracking branch's merge-base as
// the review base. The merge-base (rather than the upstream tip) also behaves correctly after divergence:
// only commits introduced on the local branch are reviewed.
export function resolveAutomaticReviewBase(root: string, includeUntracked = true): AutomaticReviewBase | undefined {
  const workspaceRoot = resolve(root);
  const canonicalRoot = repoRoot(root);
  // A monorepo workspace is allowed to be clean even when a sibling package is dirty. Scope the
  // worktree check to the folder the reviewer explicitly opened; branch/upstream resolution remains a
  // repository-level operation below.
  const status = git(workspaceRoot, [
    "status",
    "--porcelain",
    includeUntracked ? "--untracked-files=all" : "--untracked-files=no",
    "--",
    ".",
  ]);
  if (status) return undefined;

  const upstream = git(canonicalRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!upstream) return undefined;
  const counts = git(canonicalRoot, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`])
    .split(/\s+/)
    .map(Number);
  const ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
  if (ahead <= 0) return undefined;

  const revision = git(canonicalRoot, ["merge-base", upstream, "HEAD"]);
  if (!revision) return undefined;
  return { revision, upstream, label: `${upstream}...HEAD`, ahead };
}

// Resolve the repository root. `git diff` and `git ls-files` print paths relative to it, and the
// desktop tree shows them as-is — so every filesystem read of those paths must resolve against the
// SAME root, not process.cwd(). When `kakapo` runs from a monorepo subdirectory (cwd != root), joining a
// repo-root-relative path onto cwd points at a file that doesn't exist, which surfaced as a diff with
// no source preview ("file is not present in the working tree"). Falls back to cwd outside a repo.
export function repoRoot(cwd: string = process.cwd()): string {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  return top || cwd;
}

export function canonicalWorkspaceRoot(cwd: string = process.cwd()): string {
  const root = resolve(cwd);
  try { return realpathSync.native(root); } catch { return root; }
}

export function readGitSnapshot(root: string): GitSnapshot {
  return {
    branch: git(root, ["branch", "--show-current"]),
    status: git(root, ["status", "--short"]),
    diffStat: git(root, ["diff", "--stat"]),
    recentCommits: git(root, ["log", "--oneline", "-5"]),
  };
}
