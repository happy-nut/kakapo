import { spawn, spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitSnapshot } from "./types.js";
import { isServerCacheInsideProject } from "./server-cache.js";

export function isGitRepository(root: string): boolean {
  const result = spawnSync("git", [...RAW_PATHS, "rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && (result.stdout ?? "").trim() === "true";
}

/**
 * How kakapo frames the records of a `--pretty=format:` read, and the only shape it accepts back.
 *
 * Both separators used to be chosen "because git output cannot contain them". Git output can: a commit
 * message and an ident are arbitrary bytes, `git commit -m` passes 0x1e straight through, and
 * `hash-object -t commit --literally` writes anything at all into either while `git fsck` merely warns. One
 * commit in a reviewed repository could therefore add whole RECORDS — a forged row in the history panel, a
 * forged entry in the patch-set selector — and a review tool that can be made to narrate a history that
 * never happened is lying to its only reader. `-z` is no better: a NUL in a message is emitted verbatim.
 *
 * A NEWLINE is the one separator git normalises away. `%s` is the first paragraph with its line breaks
 * turned into spaces; a newline inside an ident makes git print `%an`/`%ae` empty rather than leak it; and
 * `%H`, `%P`, `%h`, `%cI` and `%D` are structurally newline-free (git's ref-name rules forbid control
 * characters). Measured on this repository: 939 commits, 939 lines.
 *
 * So: one record per line, free-text fields LAST so a stray 0x1f cannot shift the structured ones out of
 * their columns, and a record is a commit only when it opens with a hash. A field separator inside a
 * subject can still make that one row's own columns odd; it can no longer invent a row.
 */
export const RECORD_FS = "\x1f";
export const RECORD_RS = "\n";

// Git escapes any non-ASCII byte in the paths it PRINTS (status, ls-files, diff headers) as C octal —
// "과제 안내.md" comes out as "\352\263\274\354\240\234 \354\225\210\353\202\264.md". kakapo then
// shows that literal string as the filename, splits the stray quote into a phantom directory, and cannot
// find the file on disk. Every git read in the app goes through these two helpers plus the diff/status
// spawns in diff.ts, so ask git for raw UTF-8 at the source instead of un-escaping downstream.
// The rest of this list is not about paths at all: it is what keeps `git` from running a command the
// REVIEWED repository chose. `core.fsmonitor` is executed during the index refresh that `diff` and `status`
// both do, and `core.hooksPath` points at hooks; both are ordinary config, so a repo that arrives as an
// archive or a copied directory (its own .git/config included) picks them. kakapo runs `git diff` and
// `git status` before the first paint, so neither needs a click. Together with `--no-ext-diff` and
// `--no-textconv` on the diff/show argv, this is the full set of config-driven exec vectors in the
// read-only commands this app runs.
export const RAW_PATHS = [
  "-c", "core.quotePath=false",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
];

export function git(root: string, args: string[]): string {
  const result = spawnSync("git", [...RAW_PATHS, ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

export function gitAsync(root: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput) => {
    let stdout = "";
    try {
      const child = spawn("git", [...RAW_PATHS, ...args], { cwd: root });
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
  target?: string;
  behind?: number;
};

export function defaultBaseRef(root: string): string {
  const remoteHead = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) return candidate;
  }
  return "";
}

export function resolveAutomaticReviewBase(root: string, includeUntracked = true): AutomaticReviewBase | undefined {
  const workspaceRoot = resolve(root);
  const canonicalRoot = repoRoot(root);
  const status = git(workspaceRoot, [
    "status",
    "--porcelain",
    includeUntracked ? "--untracked-files=all" : "--untracked-files=no",
    "--",
    ".",
  ]);
  if (status) return undefined;

  const tracking = git(canonicalRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const upstream = tracking || defaultBaseRef(canonicalRoot);
  if (!upstream) return undefined;
  const counts = git(canonicalRoot, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`])
    .split(/\s+/)
    .map(Number);
  const ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
  const behind = Number.isFinite(counts[0]) ? counts[0] : 0;
  const revision = git(canonicalRoot, ["merge-base", upstream, "HEAD"]);
  if (!revision) return undefined;
  if (ahead > 0) return { revision, upstream, label: `${upstream}...HEAD`, ahead };
  if (!tracking) return undefined;
  if (behind > 0) return { revision, upstream, label: `HEAD...${upstream}`, ahead: 0, target: upstream, behind };
  return undefined;
}

export function untrackedPaths(root: string): string[] {
  return git(root, ["ls-files", "--others", "--exclude-standard", "--", "."])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => !isServerCacheInsideProject(path));
}

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

export function isBranchRef(root: string, ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed || !/^[\w./-]+$/.test(trimmed)) return false;
  return Boolean(
    git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${trimmed}`])
    || git(root, ["rev-parse", "--verify", "--quiet", `refs/remotes/${trimmed}`]),
  );
}

const repoRootCache = new Map<string, string>();
export function repoRoot(cwd: string = process.cwd()): string {
  const cached = repoRootCache.get(cwd);
  if (cached !== undefined) return cached;
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = top || cwd;
  repoRootCache.set(cwd, root);
  return root;
}

const workspacePrefixCache = new Map<string, string>();
export function workspaceGitPrefix(root: string): string {
  const cached = workspacePrefixCache.get(root);
  if (cached !== undefined) return cached;
  const prefix = git(root, ["rev-parse", "--show-prefix"]).replace(/\\/g, "/").replace(/\/+$/, "");
  workspacePrefixCache.set(root, prefix);
  return prefix;
}

export function absoluteGitDir(root: string): string {
  return git(root, ["rev-parse", "--absolute-git-dir"]);
}

export function commonGitDir(root: string): string {
  return git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

export function isLinkedWorktree(root: string): boolean {
  let dotGit;
  try { dotGit = statSync(join(root, ".git")); } catch { return false; }
  if (dotGit.isDirectory()) return false;
  const gitDir = absoluteGitDir(root);
  const shared = commonGitDir(root);
  return Boolean(gitDir) && Boolean(shared) && gitDir !== shared;
}

export function kakapoSharedDataFile(root: string, name: string): string | undefined {
  const gitDir = commonGitDir(root);
  return gitDir ? join(gitDir, "kakapo", name) : undefined;
}

export function kakapoGitDataFile(root: string, name: string): string | undefined {
  const gitDir = absoluteGitDir(root);
  return gitDir ? join(gitDir, "kakapo", name) : undefined;
}

export function isCommitSha(value: string): boolean {
  return /^[0-9a-fA-F]{4,64}$/.test(value);
}

export function canonicalWorkspaceRoot(cwd: string = process.cwd()): string {
  const root = resolve(cwd);
  try { return realpathSync.native(root); } catch { return root; }
}

export function resolveWorkspaceRoot(cwd: string = process.cwd()): string {
  return canonicalWorkspaceRoot(repoRoot(canonicalWorkspaceRoot(cwd)));
}

export function listRemotes(root: string): string[] {
  return git(root, ["remote"]).split("\n").map((line) => line.trim()).filter(Boolean);
}

export function listBranches(root: string): string[] {
  const refs = (scope: string): string[] =>
    git(root, ["for-each-ref", "--sort=-committerdate", "--count=300", "--format=%(refname:short)", scope])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  // `refs/remotes/origin/HEAD` shortens to a bare `origin`, which is not a branch and cannot be diffed
  // against. Every real remote-tracking ref is `<remote>/<branch>`, so the slash is the whole test.
  return refs("refs/heads").concat(refs("refs/remotes").filter((name) => name.includes("/")));
}
