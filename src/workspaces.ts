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
    kind: common && gitDir && common !== gitDir ? "worktree" : "main",
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
  options: { base?: string; prefix?: string; container?: string; signal?: AbortSignal } = {},
): Promise<WorkspaceRecord> {
  const main = workspaceRecord(repo);
  const base = options.base || defaultBase(main.repoRoot);
  const prefix = options.prefix ?? "kakapo";
  const container = options.container ?? join(homedir(), "kakapo", "workspaces");
  let slug = workspaceSlug(label), branch = `${prefix}/${slug}`, target = join(container, main.repoName, slug);
  for (let suffix = 2; existsSync(target) || git(main.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]); suffix += 1) {
    slug = `${workspaceSlug(label)}-${suffix}`; branch = `${prefix}/${slug}`; target = join(container, main.repoName, slug);
  }
  mkdirSync(resolve(target, ".."), { recursive: true });
  const fetch = await runAsync(main.repoRoot, ["fetch", "--prune"], options.signal);
  if (options.signal?.aborted) throw new Error("Workspace creation cancelled.");
  const added = await runAsync(main.repoRoot, ["worktree", "add", "-b", branch, target, base], options.signal);
  if (options.signal?.aborted) throw new Error("Workspace creation cancelled.");
  if (!added.ok) throw new Error(added.output || `Failed to create worktree ${target}`);
  return { ...workspaceRecord(realpathSync(target)), alias: label.trim() || slug, base, fetchWarning: fetch.ok ? undefined : fetch.output };
}

export function removalRisk(workspace: WorkspaceRecord, runningProcesses = false): WorkspaceRemovalRisk {
  const status = git(workspace.path, ["status", "--porcelain"]);
  const upstream = git(workspace.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const raw = upstream
    ? git(workspace.path, ["rev-list", "--count", `${upstream}..HEAD`])
    : workspace.base ? git(workspace.path, ["rev-list", "--count", `${workspace.base}..HEAD`]) : "";
  return { dirty: !!status, unpushed: Number(raw) || 0, runningProcesses };
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
