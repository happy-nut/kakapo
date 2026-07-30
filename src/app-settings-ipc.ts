import type { IpcMain, IpcMainEvent } from "electron";
import type { AppPreferences } from "./app-preferences.js";

// The window state this adapter needs: only the repo root, to scope settings per worktree.
export type SettingsStateResolver = (event: IpcMainEvent) => { options: { root: string } } | undefined;

// Renderer settings live in AppPreferences (global + per-worktree scoping, outside the Electron composition
// root); the sandboxed renderer reads/writes them over synchronous IPC. Extracted from app-main so the wiring
// is a one-line registration, matching the other register*Ipc adapters.
export function registerSettingsIpc(ipc: IpcMain, preferences: AppPreferences, stateFromEvent: SettingsStateResolver): void {
  ipc.on("kakapo:get-settings", (event) => {
    const state = stateFromEvent(event);
    event.returnValue = state ? preferences.rendererSettings(state.options.root) : preferences.readGlobal();
  });
  ipc.on("kakapo:set-setting", (event, msg: { key?: string; value?: unknown }) => {
    if (!msg || typeof msg.key !== "string") return;
    const state = stateFromEvent(event);
    preferences.setRendererSetting(state?.options.root, msg.key, msg.value);
  });
}
