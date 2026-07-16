import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function canonicalWorkspacePath(root: string): string {
  const workspace = resolve(root);
  try { return realpathSync.native(workspace); } catch { return workspace; }
}

function workspacePathSegments(root: string): string[] {
  const normalized = canonicalWorkspacePath(root).replace(/\\/g, "/");
  const drive = normalized.match(/^([A-Za-z]):(?:\/|$)/);
  const unc = normalized.startsWith("//");
  const remainder = drive ? normalized.slice(2) : normalized;
  const segments = remainder.split("/").filter(Boolean);
  if (drive) segments.unshift(drive[1].toUpperCase());
  else if (unc) segments.unshift("UNC");
  return segments.length ? segments : ["root"];
}

// Keep application data inspectable and collision-free without hashes. A workspace such as
// /Users/me/repos/app maps to <userData>/workspaces/Users/me/repos/app, so multiple folders and nested
// monorepo packages can stay open simultaneously without sharing review state.
export function workspaceDataDirectory(userData: string, root: string): string {
  return join(resolve(userData), "workspaces", ...workspacePathSegments(root));
}

export function workspaceReviewFile(userData: string, root: string): string {
  return join(workspaceDataDirectory(userData, root), "review", "app-review.html");
}

export function workspacePerformanceDirectory(userData: string, root: string): string {
  return join(workspaceDataDirectory(userData, root), "perf");
}

export function workspaceMemoFile(userData: string, root: string): string {
  return join(workspaceDataDirectory(userData, root), "memo.json");
}

export type LegacyWorkspaceMigration = {
  source: string;
  archive: string;
};

// Releases before the workspace mirror wrote generated artifacts into <root>/.monacori. Preserve that
// whole tree below userData the first time the workspace is opened, then remove it from the repository.
// A tracked .monacori is user-owned rather than disposable app state, so never move it automatically.
export function migrateLegacyProjectData(userData: string, root: string): LegacyWorkspaceMigration | undefined {
  const workspace = canonicalWorkspacePath(root);
  const source = join(workspace, ".monacori");
  try {
    if (!existsSync(source) || !statSync(source).isDirectory()) return undefined;
    const tracked = spawnSync("git", ["ls-files", "--", ".monacori"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (tracked.status !== 0 || String(tracked.stdout || "").trim()) return undefined;

    const base = join(workspaceDataDirectory(userData, workspace), "legacy-project-state");
    let archive = base;
    for (let suffix = 2; existsSync(archive); suffix += 1) archive = `${base}-${suffix}`;
    mkdirSync(workspaceDataDirectory(userData, workspace), { recursive: true });
    cpSync(source, archive, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    rmSync(source, { recursive: true, force: true });
    return { source, archive };
  } catch {
    // A partial copy is harmless and inspectable. Keep the original directory intact unless the complete
    // archive succeeded, so a permission or disk-space failure can never destroy review notes.
    return undefined;
  }
}

// CLI-only utilities (for example the benchmark command) do not have Electron's app.getPath(). Mirror
// Electron's conventional userData location so they still never write into the reviewed repository.
export function defaultMonacoriUserDataDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Monacori");
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "Monacori");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Monacori");
}
