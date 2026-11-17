import type { IpcMain, IpcMainEvent } from "electron";
import type { AppPreferences } from "./app-preferences.js";

export type SettingsStateResolver = (event: IpcMainEvent) => { options: { root: string } } | undefined;

export function registerSettingsIpc(
  ipc: IpcMain,
  preferences: AppPreferences,
  stateFromEvent: SettingsStateResolver,
  onChange?: (key: string, value: unknown) => void,
): void {
  ipc.on("kakapo:get-settings", (event) => {
    const state = stateFromEvent(event);
    event.returnValue = state ? preferences.rendererSettings(state.options.root) : preferences.readGlobal();
  });
  ipc.on("kakapo:set-setting", (event, msg: { key?: string; value?: unknown }) => {
    if (!msg || typeof msg.key !== "string") return;
    const state = stateFromEvent(event);
    preferences.setRendererSetting(state?.options.root, msg.key, msg.value);
    onChange?.(msg.key, msg.value);
  });
}
