import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { gitAsync } from "./git.js";

// Every checkout that shares this repository's object store — the main clone plus every `git worktree add`.
// kakapo does not create, move or remove worktrees (AGENTS.md: no workspace management); it lists the ones
// git already knows about so a reviewer can jump between them without leaving the app.
export type Worktree = {
  path: string;
  // Short branch name ("feature/x"), or "" on a detached HEAD.
  branch: string;
  head: string;
  shortHead: string;
  // The worktree this window is currently reviewing, so its row can say so instead of offering to reopen it.
  current: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  // git's own word for "the directory is gone but the administrative files are still here".
  prunable: boolean;
  // HEAD commit subject — what this worktree was last doing, which is what the path alone never says.
  subject: string;
  // Committer date of HEAD (ISO-8601), for sorting most-recently-touched first.
  date: string;
  // Uncommitted tracked changes present. Untracked files are deliberately not counted: build output and
  // caches differ per worktree and would mark every row dirty.
  dirty: boolean;
  // Relative to the worktree's own upstream, absent when it has none.
  ahead?: number;
  behind?: number;
  // What the list shows in place of `path`: see shortWorktreePath.
  displayPath: string;
};

// These paths are long and mostly identical — `~/repos/app/.claude/worktrees/<name>` repeated down the whole
// list — and the part that tells them apart is at the END, which is exactly what an ellipsis eats. So the
// middle goes instead: the first two segments say where the tree lives, the last two say which one it is.
// The untruncated path is still right there, in the preview strip under the list.
export function shortWorktreePath(path: string, home = homedir()): string {
  let text = String(path || "");
  const base = (home || "").replace(/\/+$/, "");
  if (base && (text === base || text.startsWith(base + "/"))) text = "~" + text.slice(base.length);
  const parts = text.split("/");
  if (parts.length <= 5) return text;
  return [...parts.slice(0, 2), "\u2026", ...parts.slice(-2)].join("/");
}

const FS = "\x1f";

// `git worktree list --porcelain` emits one blank-line-separated record per worktree, each a sequence of
// "key value" (or bare-flag) lines. Parsed rather than the human-readable form, which aligns columns with
// spaces and becomes ambiguous the moment a path contains one.
function parsePorcelain(out: string): Array<Partial<Worktree>> {
  const records: Array<Partial<Worktree>> = [];
  let current: Partial<Worktree> | undefined;
  for (const raw of out.split("\n")) {
    const line = raw.trimEnd();
    if (!line) { current = undefined; continue; }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "worktree") {
      current = { path: value, branch: "", head: "", detached: false, bare: false, locked: false, prunable: false };
      records.push(current);
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
    else if (key === "locked") current.locked = true;
    else if (key === "prunable") current.prunable = true;
  }
  return records;
}

// left/right counts from `rev-list --count --left-right <upstream>...HEAD`: left is upstream-only (behind),
// right is HEAD-only (ahead). Empty when the branch has no upstream — the command fails and gitAsync
// resolves to "".
function parseAheadBehind(out: string): { ahead?: number; behind?: number } {
  const parts = out.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return {};
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return {};
  return { ahead, behind };
}

// One worktree's per-checkout detail. Three git reads, all async and all issued in parallel across every
// worktree by readWorktrees: `status` alone costs ~45ms on a real repo, and on the main process that time
// would be frozen UI (see gitAsync in git.ts).
async function describe(entry: Partial<Worktree>, currentPath: string): Promise<Worktree> {
  const path = entry.path ?? "";
  const head = entry.head ?? "";
  const base: Worktree = {
    path,
    branch: entry.branch ?? "",
    head,
    shortHead: head.slice(0, 8),
    current: path === currentPath,
    detached: Boolean(entry.detached),
    bare: Boolean(entry.bare),
    locked: Boolean(entry.locked),
    prunable: Boolean(entry.prunable),
    subject: "",
    date: "",
    dirty: false,
    displayPath: shortWorktreePath(path),
  };
  // A pruned or bare worktree has no working copy to read: every command below would fail one at a time and
  // cost a spawn each to learn nothing. The row still lists, flagged, so the reviewer can see why it is dead.
  if (base.bare || base.prunable || !path || !existsSync(path)) return base;
  const [log, status, aheadBehind] = await Promise.all([
    gitAsync(path, ["-c", "log.showSignature=false", "log", "-1", "--no-color", `--pretty=format:%s${FS}%cI`, "--"]),
    gitAsync(path, ["status", "--porcelain", "--untracked-files=no"]),
    base.branch ? gitAsync(path, ["rev-list", "--count", "--left-right", "@{upstream}...HEAD"]) : Promise.resolve(""),
  ]);
  const fields = log.split(FS);
  base.subject = fields[0] ?? "";
  base.date = fields[1] ?? "";
  base.dirty = status.length > 0;
  return { ...base, ...parseAheadBehind(aheadBehind) };
}

// The list behind the launcher's Worktrees section. `current` first so the row you are in anchors the list,
// then most recently committed — the checkout you last worked in is the one you are likeliest to want.
export async function readWorktrees(root: string): Promise<Worktree[]> {
  const out = await gitAsync(root, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const entries = parsePorcelain(out);
  if (!entries.length) return [];
  const currentPath = await gitAsync(root, ["rev-parse", "--show-toplevel"]);
  const worktrees = await Promise.all(entries.map((entry) => describe(entry, currentPath)));
  return worktrees.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return (b.date || "").localeCompare(a.date || "");
  });
}

// Just the paths git knows about, without the per-checkout reads readWorktrees does. This is the validation
// step behind "open this worktree": a `status` on every sibling is a lot of work to answer one yes/no.
export async function worktreePaths(root: string): Promise<string[]> {
  const out = await gitAsync(root, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  return parsePorcelain(out).map((entry) => entry.path ?? "").filter(Boolean);
}

// One open pull request, matched to a worktree by its head branch.
export type BranchPullRequest = {
  number: number;
  title: string;
  isDraft: boolean;
  url: string;
};

// `gh` is not a dependency and not required: it is used the way `git` is, as a command that may or may not be
// on PATH. Killed after a timeout so a hung network call can never hold a row's badge — the list itself has
// already rendered by then, and a missing badge is the same as no PR.
function runGh(root: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveOutput) => {
    let stdout = "";
    let done = false;
    const finish = (value: string) => { if (!done) { done = true; resolveOutput(value); } };
    try {
      const child = spawn("gh", args, { cwd: root });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish(""); }, timeoutMs);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.on("error", () => { clearTimeout(timer); finish(""); });
      child.on("close", (code) => { clearTimeout(timer); finish(code === 0 ? stdout.trim() : ""); });
    } catch {
      finish("");
    }
  });
}

// Branch -> open pull request, for worktree rows whose local commits have since become a PR. This is the
// whole of kakapo's GitHub reach on purpose: one read, no auth code of its own, no write path. Review
// comments stay local (`.git/.../kakapo/comments.jsonl`, per worktree) and are never posted anywhere.
// Returns {} when `gh` is absent, unauthenticated, offline, or the remote is not GitHub — all the same
// outcome to a caller: no badge.
export async function readBranchPullRequests(root: string, timeoutMs = 4000): Promise<Record<string, BranchPullRequest>> {
  const out = await runGh(root, ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,title,isDraft,url"], timeoutMs);
  if (!out) return {};
  try {
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed)) return {};
    const byBranch: Record<string, BranchPullRequest> = {};
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const branch = typeof row.headRefName === "string" ? row.headRefName : "";
      const number = typeof row.number === "number" ? row.number : 0;
      if (!branch || !number) continue;
      // Lowest number wins when a branch somehow has two open PRs: the original, not a later duplicate.
      if (byBranch[branch] && byBranch[branch].number <= number) continue;
      byBranch[branch] = {
        number,
        title: typeof row.title === "string" ? row.title : "",
        isDraft: row.isDraft === true,
        url: typeof row.url === "string" ? row.url : "",
      };
    }
    return byBranch;
  } catch {
    return {};
  }
}
