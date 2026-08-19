import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
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

// Same contract as git() but WITHOUT blocking the caller's thread. spawnSync costs ~5ms per invocation and
// `status --porcelain` reaches ~45ms on a real repo; on the Electron main process that time is frozen UI, so
// anything that runs while the user is interacting (rail tile refreshes, see app-main.ts) uses this instead.
// A failed command resolves to "" exactly like git(), so callers need no extra error branch.
export function gitAsync(root: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput) => {
    let stdout = "";
    try {
      const child = spawn("git", args, { cwd: root });
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", () => resolveOutput(""));
      child.on("close", (code) => resolveOutput(code === 0 ? stdout.trim() : ""));
    } catch {
      resolveOutput("");
    }
  });
}

export type AutomaticReviewBase = {
  revision: string;
  upstream: string;
  label: string;
  ahead: number;
  // Set only for the incoming case below: the review's RIGHT side is the tracking branch, not the working
  // tree, because what needs reading is what the remote has and this checkout does not.
  target?: string;
  behind?: number;
};

// The ref a branch was cut from when it has no tracking branch — a feature branch nobody has pushed yet.
// Without this the automatic base gave up on such a branch entirely, the review fell back to
// HEAD-vs-worktree, and the moment an agent committed its work that diff went empty: every review comment
// lost the line it hangs on and the whole review looked wiped (the comments were safe on disk the whole
// time — there was simply no diff left to draw them on). Same fallback the patch-set selector already uses.
function defaultBranchRef(root: string): string {
  for (const candidate of ["main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", candidate])) return candidate;
  }
  return "";
}

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

  const tracking = git(canonicalRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const upstream = tracking || defaultBranchRef(canonicalRoot);
  if (!upstream) return undefined;
  const counts = git(canonicalRoot, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`])
    .split(/\s+/)
    .map(Number);
  const ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
  const behind = Number.isFinite(counts[0]) ? counts[0] : 0;
  const revision = git(canonicalRoot, ["merge-base", upstream, "HEAD"]);
  if (!revision) return undefined;
  if (ahead > 0) return { revision, upstream, label: `${upstream}...HEAD`, ahead };
  // "Read what the remote has and you don't" only makes sense for a real tracking branch. Falling back to a
  // local default branch here would flip an ordinary stale feature branch into an incoming-changes review.
  if (!tracking) return undefined;
  // Nothing of your own to review: the worktree is clean and nothing is unpushed. The only difference left
  // between this checkout and the remote is what the remote has and you do not, so review THAT — right side
  // pinned to the tracking branch instead of the working tree. Reviewing an incoming change before you merge
  // it is the same reading task, and it is what "explain this diff" should reach for rather than an empty
  // review. Still the merge-base, so a diverged branch shows only the commits that arrived on the remote.
  if (behind > 0) return { revision, upstream, label: `HEAD...${upstream}`, ahead: 0, target: upstream, behind };
  return undefined;
}

// git's own hash for the empty tree — the same value in every repository, and the only way to say "before
// anything existed". A repository's FIRST commit has no parent, so it is the one commit that cannot be shown
// as "this against the one before it"; against the empty tree it shows as what it actually is, every file
// added. Without this the initial commit is the single thing Cmd+9 cannot open, which is the kind of
// exception that comes back as a bug report a year later.
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Validate a user-supplied review base (the CLI --base value) before it reaches `git diff <base>`. spawnSync
// uses argv (no shell) so the ref cannot inject a command; this check just rejects typos and refs that don't
// exist in the repository, and fails fast at launch with a clear message instead of an empty/garbage diff.
export function validateReviewBase(root: string, ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || !/^[\w./@^~{}-]+$/.test(trimmed)) {
    throw new Error(`Invalid --base value ${JSON.stringify(ref)}: expected a branch, tag, or commit.`);
  }
  // A tree, not a commit, so the ^{commit} check below would reject it. `git diff` takes it on the left
  // exactly like any revision.
  if (trimmed === EMPTY_TREE) return trimmed;
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
// A directory's git top-level is stable for the life of the process, so memoize by cwd — this is a hot
// helper reached from the review build and several path-resolution sites, and each miss is a subprocess.
const repoRootCache = new Map<string, string>();
export function repoRoot(cwd: string = process.cwd()): string {
  const cached = repoRootCache.get(cwd);
  if (cached !== undefined) return cached;
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = top || cwd;
  repoRootCache.set(cwd, root);
  return root;
}

// 이 워크트리 고유의 `.git/worktrees/<name>` 경로를 가리킨다 (워크트리가 아닌 일반 clone이면 `.git`) —
// answers 교환 파일이 이 경로 아래에 저장된다 (answers-ipc.ts 참고). git은 자신의 `.git/` 내용물을
// 추적하지 않으므로, 에이전트가 `git status`를 더럽히지 않고 파일을 쓸 수 있는 장소이기 때문이다.
export function absoluteGitDir(root: string): string {
  return git(root, ["rev-parse", "--absolute-git-dir"]);
}

// Absolute path to a kakapo data file inside the repo's git dir — `.git/kakapo/<name>`, or a linked
// worktree's own `.git/worktrees/<id>/kakapo/<name>`. undefined when `root` isn't a git repo. This is where
// kakapo stashes per-workspace agent-exchange files so they travel with the checkout but stay out of the tree.
// The git dir SHARED by a repository and every worktree linked to it (`.git`, not `.git/worktrees/<id>`).
// Anything that must outlive one task belongs here: a worktree is created for a task and deleted when it is
// done, so a file written under absoluteGitDir dies with it.
export function commonGitDir(root: string): string {
  return git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

// Like kakapoGitDataFile, but shared across the repository's worktrees — for knowledge that accumulates.
export function kakapoSharedDataFile(root: string, name: string): string | undefined {
  const gitDir = commonGitDir(root);
  return gitDir ? join(gitDir, "kakapo", name) : undefined;
}

export function kakapoGitDataFile(root: string, name: string): string | undefined {
  const gitDir = absoluteGitDir(root);
  return gitDir ? join(gitDir, "kakapo", name) : undefined;
}

// A git object id (short or full). The compare bar and history send SHAs from the renderer, so every one is
// validated with this before it reaches `git` as a revision argument.
export function isCommitSha(value: string): boolean {
  return /^[0-9a-fA-F]{4,64}$/.test(value);
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
