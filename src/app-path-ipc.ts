import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, Shell } from "electron";

export type ProjectPathIpcState = { options: { root: string } };
type ProjectPathEvent = IpcMainEvent | IpcMainInvokeEvent;
type ProjectPathStateResolver = (event: ProjectPathEvent) => ProjectPathIpcState | undefined;

/** Resolve a renderer-provided relative path without permitting workspace escape. */
export function resolveProjectPath(rootPath: string, requestedPath: unknown): string | undefined {
  if (typeof requestedPath !== "string" || !requestedPath.trim() || isAbsolute(requestedPath)) return;
  const root = resolve(rootPath);
  const target = resolve(root, requestedPath);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) return;
  return target;
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
    const requested = Array.isArray(request?.paths) ? request.paths.slice(0, 2000) : [];
    const existing: Record<string, boolean> = {};
    for (const requestedPath of requested) {
      if (typeof requestedPath !== "string" || Object.prototype.hasOwnProperty.call(existing, requestedPath)) continue;
      const path = pathFor(event, requestedPath);
      try { existing[requestedPath] = Boolean(path && existsSync(path) && statSync(path).isFile()); }
      catch { existing[requestedPath] = false; }
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
        : process.platform === "win32"
          ? spawn("cmd.exe", ["/c", "start", "", "cmd.exe", "/K", "cd", "/d", directory], { detached: true, stdio: "ignore", windowsHide: true })
          : spawn(process.env.TERMINAL || "x-terminal-emulator", [], { cwd: directory, detached: true, stdio: "ignore" });
      child.once("error", () => {});
      child.unref();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
}
