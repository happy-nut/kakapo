import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { git, resolveWorkspaceRoot } from "./git.js";

export type WorkspaceKind = "main" | "worktree";
export type WorkspaceRecord = {
  path: string;
  repoRoot: string;
  repoName: string;
  branch: string;
  kind: WorkspaceKind;
  alias?: string;
  memo?: string;
  base?: string;
  openedAt: number;
  fetchWarning?: string;
};

export type WorkspaceRemovalRisk = {
  dirty: boolean;
  unpushed: number;
  runningProcesses: boolean;
};

function run(root: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

export function workspaceRecord(path: string, openedAt = Date.now()): WorkspaceRecord {
  const root = resolveWorkspaceRoot(path);
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = git(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const mainRoot = common && basename(common) === ".git" ? resolve(common, "..") : root;
  return {
    path: root,
    repoRoot: mainRoot,
    repoName: basename(mainRoot),
    branch: git(root, ["branch", "--show-current"]) || "detached",
    // "main" is a claim — this is the project's own checkout — and every `git rev-parse` here returning empty
    // is not evidence for it. That happens to a workspace whose folder has been deleted out from under us, and
    // the empty answers used to read as main: the rail labelled a dead path "main worktree", filed it under a
    // project named after its own folder, and the delete guard ("the main checkout can only be closed")
    // refused to let you clean it up. Unreadable is not main.
    kind: !common && !gitDir ? "worktree" : common && gitDir && common !== gitDir ? "worktree" : "main",
    openedAt,
  };
}

export function defaultBase(root: string): string {
  const remoteHead = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead;
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) return candidate;
  }
  return "HEAD";
}

// The name a worktree gets on disk and on its branch. Deliberately NOT derived from the task name: that name
// is prose, often not in English, and it ended up verbatim in a branch ref and a filesystem path — macOS
// hands back decomposed Hangul in paths, and a branch called `kakapo/버그-픽스` is awkward everywhere a branch
// is typed. A random pair is always ASCII, always short, and never collides with what the task is called, so
// the pretty name stays free to be pretty (it is kept as the workspace's alias).
const SLUG_ADJECTIVES = [
  "amber", "brisk", "calm", "clever", "dusky", "eager", "fleet", "gentle", "hollow", "keen",
  "lucid", "mellow", "nimble", "olive", "patient", "quiet", "rapid", "silent", "tidy", "vivid",
];
const SLUG_NOUNS = [
  "heron", "kestrel", "lark", "magpie", "nuthatch", "oriole", "petrel", "quail", "raven", "shrike",
  "swift", "tanager", "thrush", "vireo", "warbler", "wren", "avocet", "bittern", "curlew", "dunlin",
];

export function randomWorkspaceSlug(pick: () => number = Math.random): string {
  const at = (list: string[]) => list[Math.min(list.length - 1, Math.floor(pick() * list.length))];
  return `${at(SLUG_ADJECTIVES)}-${at(SLUG_NOUNS)}`;
}

// Every ref a new worktree could sensibly start from, most recently committed first. Local branches and
// remote-tracking ones both, because "start from origin/main" and "start from my develop" are equally normal
// answers — and typing either by hand was the only way to say it before.
export function listStartRefs(root: string, limit = 60): string[] {
  const raw = git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const line of raw.split("\n")) {
    const name = line.trim();
    // origin/HEAD is a symbolic alias for the default branch, which is already in this list under its own name.
    if (!name || name.endsWith("/HEAD") || seen.has(name)) continue;
    seen.add(name);
    refs.push(name);
    if (refs.length >= limit) break;
  }
  return refs;
}

export function workspaceSlug(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function runAsync(root: string, args: string[], signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveResult) => {
    if (signal?.aborted) {
      resolveResult({ ok: false, output: "Cancelled" });
      return;
    }
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const cancel = () => child.kill();
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => resolveResult({ ok: false, output: error.message }));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", cancel);
      resolveResult({ ok: code === 0, output: signal?.aborted ? "Cancelled" : output.trim() });
    });
  });
}

export async function createManagedWorkspaceAsync(
  repo: string,
  label: string,
  options: { base?: string; slug?: string; memo?: string; prefix?: string; container?: string; signal?: AbortSignal } = {},
): Promise<WorkspaceRecord> {
  const main = workspaceRecord(repo);
  const base = options.base || defaultBase(main.repoRoot);
  const prefix = options.prefix ?? "kakapo";
  const container = options.container ?? join(homedir(), "kakapo", "workspaces");
  // The dialog previews a slug and sends that same one back, so what you were shown is what gets created.
  // Without one (a caller that never previewed), pick a fresh pair here.
  const wanted = options.slug ? workspaceSlug(options.slug) : randomWorkspaceSlug();
  let slug = wanted, branch = `${prefix}/${slug}`, target = join(container, main.repoName, slug);
  for (let suffix = 2; existsSync(target) || git(main.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); suffix += 1) {
    slug = `${wanted}-${suffix}`; branch = `${prefix}/${slug}`; target = join(container, main.repoName, slug);
  }
  mkdirSync(resolve(target, ".."), { recursive: true });
  const fetch = await runAsync(main.repoRoot, ["fetch", "--prune"], options.signal);
  if (options.signal?.aborted) throw new Error("Workspace creation cancelled.");
  const added = await runAsync(main.repoRoot, ["worktree", "add", "-b", branch, target, base], options.signal);
  if (options.signal?.aborted) throw new Error("Workspace creation cancelled.");
  if (!added.ok) throw new Error(added.output || `Failed to create worktree ${target}`);
  const memo = options.memo?.trim();
  return { ...workspaceRecord(realpathSync(target)), alias: label.trim() || slug, memo: memo || undefined,
    base, fetchWarning: fetch.ok ? undefined : fetch.output };
}

// Which ref "ahead" is measured against, in one place. The upstream when there is one; otherwise the ref this
// workspace was branched from — kakapo's own task worktrees have no upstream until somebody pushes, so for
// them `base` is the only answer that means anything. Returned as ARGS rather than a count so the sync caller
// (removalRisk, below) and the async one (the hub tile, app-main.ts) can share the rule without sharing a
// runner; a rule that lives twice is a rule that drifts.
export function aheadArgs(upstream: string, base?: string): string[] | undefined {
  const ref = upstream || base;
  return ref ? ["rev-list", "--count", `${ref}..HEAD`] : undefined;
}

export function aheadCount(path: string, base?: string): number {
  const args = aheadArgs(git(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]), base);
  return args ? Number(git(path, args)) || 0 : 0;
}

export function removalRisk(workspace: WorkspaceRecord, runningProcesses = false): WorkspaceRemovalRisk {
  const status = git(workspace.path, ["status", "--porcelain"]);
  return { dirty: !!status, unpushed: aheadCount(workspace.path, workspace.base), runningProcesses };
}

export function removeManagedWorkspace(workspace: WorkspaceRecord, force = false, deleteBranch = false): void {
  if (workspace.kind !== "worktree") throw new Error("The main checkout can only be closed, not deleted.");
  const risk = removalRisk(workspace);
  if (!force && (risk.dirty || risk.unpushed)) throw new Error("Workspace has uncommitted or unpushed changes.");
  const removed = run(workspace.repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), workspace.path]);
  if (!removed.ok) throw new Error(removed.output || "Failed to remove worktree.");
  if (deleteBranch && workspace.branch !== "detached") {
    const deleted = run(workspace.repoRoot, ["branch", force ? "-D" : "-d", workspace.branch]);
    if (!deleted.ok) throw new Error(deleted.output || "Worktree removed, but branch deletion failed.");
  }
}
