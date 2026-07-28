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

// Validate a user-supplied review base (the CLI --base value) before it reaches `git diff <base>`. spawnSync
// uses argv (no shell) so the ref cannot inject a command; this check just rejects typos and refs that don't
// exist in the repository, and fails fast at launch with a clear message instead of an empty/garbage diff.
export function validateReviewBase(root: string, ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || !/^[\w./@^~{}-]+$/.test(trimmed)) {
    throw new Error(`Invalid --base value ${JSON.stringify(ref)}: expected a branch, tag, or commit.`);
  }
  const resolved = git(root, ["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`]);
  if (!resolved) {
    throw new Error(`--base ${trimmed} is not a commit in this repository (try a branch, tag, or commit SHA).`);
  }
  return trimmed;
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

// 이 워크트리 고유의 `.git/worktrees/<name>` 경로를 가리킨다 (워크트리가 아닌 일반 clone이면 `.git`) —
// answers 교환 파일이 이 경로 아래에 저장된다 (answers-ipc.ts 참고). git은 자신의 `.git/` 내용물을
// 추적하지 않으므로, 에이전트가 `git status`를 더럽히지 않고 파일을 쓸 수 있는 장소이기 때문이다.
export function absoluteGitDir(root: string): string {
  return git(root, ["rev-parse", "--absolute-git-dir"]);
}

export function canonicalWorkspaceRoot(cwd: string = process.cwd()): string {
  const root = resolve(cwd);
  try { return realpathSync.native(root); } catch { return root; }
}

// A Kakapo workspace is identified by the Git worktree top-level, not by the subdirectory from which
// the CLI happened to be launched. This gives single-instance handoff a stable identity: launching from
// two different folders in the same checkout focuses the existing workspace, while another worktree
// remains a distinct workspace.
export function resolveWorkspaceRoot(cwd: string = process.cwd()): string {
  return canonicalWorkspaceRoot(repoRoot(canonicalWorkspaceRoot(cwd)));
}

export function readGitSnapshot(root: string): GitSnapshot {
  return {
    branch: git(root, ["branch", "--show-current"]),
    status: git(root, ["status", "--short"]),
    diffStat: git(root, ["diff", "--stat"]),
    recentCommits: git(root, ["log", "--oneline", "-5"]),
  };
}
