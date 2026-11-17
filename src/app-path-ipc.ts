import { existsSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { containedRealPath } from "./util.js";
import { RAW_PATHS } from "./git.js";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, Shell } from "electron";

export type ProjectPathIpcState = {
  options: { root: string; target?: string };
  reviewTarget?: string;
};
type ProjectPathEvent = IpcMainEvent | IpcMainInvokeEvent;
type ProjectPathStateResolver = (event: ProjectPathEvent) => ProjectPathIpcState | undefined;

/** Resolve a renderer-provided relative path without permitting workspace escape. */
export function resolveProjectPath(rootPath: string, requestedPath: unknown): string | undefined {
  if (typeof requestedPath !== "string" || !requestedPath.trim() || isAbsolute(requestedPath)) return;
  const root = resolve(rootPath);
  const target = resolve(root, requestedPath);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) return;
  if (!existsSync(target)) return target;
  return containedRealPath(root, fromRoot);
}

/**
 * A URL is safe to hand to the OS only if it is plain http(s). A link in reviewed content is untrusted, so a
 * `file://`, `javascript:` or custom-scheme URL must never reach shell.openExternal, where the OS would hand
 * it to whatever app claims that scheme. The window-open handler in app-main.ts is the only caller.
 */
export function externalUrl(requested: unknown): string | undefined {
  if (typeof requested !== "string" || requested.length > 2048) return;
  try {
    const url = new URL(requested);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Registers filesystem-adjacent actions behind one confined workspace-path policy. */
export function registerProjectPathIpc(
  ipc: IpcMain,
  shell: Shell,
  stateFromEvent: ProjectPathStateResolver,
): void {
  const pathFor = (event: ProjectPathEvent, requestedPath: unknown) => {
    const state = stateFromEvent(event);
    return state ? resolveProjectPath(state.options.root, requestedPath) : undefined;
  };

  ipc.handle("kakapo:absolute-file-path", (event, request: { path?: string }) => {
    const path = pathFor(event, request?.path);
    return path ? { ok: true, path } : { ok: false };
  });

  ipc.handle("kakapo:existing-project-paths", (event, request: { paths?: unknown[] }) => {
    const state = stateFromEvent(event);
    const requested = Array.isArray(request?.paths) ? request.paths.slice(0, 2000) : [];
    const existing: Record<string, boolean> = {};
    const reviewTarget = state?.reviewTarget ?? state?.options.target;
    const target = reviewTarget && reviewTarget !== "worktree" ? reviewTarget : undefined;
    const inTarget = (path: string): boolean => {
      if (!target || !state) return false;
      try {
        return spawnSync("git", [...RAW_PATHS, "cat-file", "-e", `${target}:${path}`], { cwd: state.options.root }).status === 0;
      } catch { return false; }
    };
    for (const requestedPath of requested) {
      if (typeof requestedPath !== "string" || Object.prototype.hasOwnProperty.call(existing, requestedPath)) continue;
      const path = pathFor(event, requestedPath);
      let present = false;
      try { present = Boolean(path && existsSync(path) && statSync(path).isFile()); }
      catch { present = false; }
      existing[requestedPath] = present || (Boolean(path) && inTarget(requestedPath));
    }
    return existing;
  });

  ipc.handle("kakapo:reveal-in-finder", (event, request: { path?: string }) => {
    const path = pathFor(event, request?.path);
    if (!path) return { ok: false };
    try { shell.showItemInFolder(path); return { ok: true }; }
    catch (error) { return { ok: false, error: String(error) }; }
  });

  ipc.handle("kakapo:open-terminal", (event, request: { path?: string }) => {
    const path = pathFor(event, request?.path);
    if (!path) return { ok: false };
    const directory = dirname(path);
    if (!existsSync(directory)) return { ok: false, error: "missing-directory" };
    try {
      const child = process.platform === "darwin"
        ? spawn("open", ["-a", "Terminal", directory], { detached: true, stdio: "ignore" })
        // `cwd` instead of a `cd` command line. Node quotes an argument that contains a space or a quote,
        // but passes anything else through verbatim, and cmd.exe then parses `&` in it as a command
        // separator — so a tracked directory named `a&calc&b` (legal on NTFS) turned "Open in Terminal"
        // into "run calc". Nothing about the path reaches a command line now.
        : process.platform === "win32"
          ? spawn("cmd.exe", ["/c", "start", "", "cmd.exe", "/K"], { cwd: directory, detached: true, stdio: "ignore", windowsHide: true })
          : spawn(process.env.TERMINAL || "x-terminal-emulator", [], { cwd: directory, detached: true, stdio: "ignore" });
      child.once("error", () => {});
      child.unref();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
}
