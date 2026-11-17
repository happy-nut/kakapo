import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

export function workspaceDataDirectory(userData: string, root: string): string {
  return join(resolve(userData), "workspaces", ...workspacePathSegments(root));
}

export function workspaceReviewFile(userData: string, root: string): string {
  return join(workspaceDataDirectory(userData, root), "review", "app-review.html");
}

export function workspacePerformanceDirectory(userData: string, root: string): string {
  return join(workspaceDataDirectory(userData, root), "perf");
}

export function workspaceSymbolCacheFile(userData: string, repoRoot: string): string {
  return join(workspaceDataDirectory(userData, repoRoot), "symbols", "index.json");
}

export function defaultKakapoUserDataDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Kakapo");
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "Kakapo");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Kakapo");
}
