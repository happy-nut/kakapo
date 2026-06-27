import { clipboard, contextBridge, ipcRenderer } from "electron";

// Bridges the sandboxed renderer to the main process so .http requests can be
// executed without CORS or sandbox restrictions. Kept intentionally tiny: the
// renderer only ever asks main to perform a single fetch and return the result.
contextBridge.exposeInMainWorld("monacoriHttp", {
  send: (request: unknown): Promise<unknown> => ipcRenderer.invoke("monacori:http-send", request),
});

// Lets the Review menu's Cmd/Ctrl+Shift+/ and +. accelerators open the merged comment views in
// the renderer (the keys macOS would otherwise reserve for its Help search).
contextBridge.exposeInMainWorld("monacoriMenu", {
  onMergedView: (cb: (kind: string) => void): void => {
    ipcRenderer.on("monacori:merged-view", (_event, kind: string) => cb(kind));
  },
  // Review menu's Cmd/Ctrl+Shift+N -> open/close the prompt memo in the renderer.
  onOpenMemo: (cb: () => void): void => {
    ipcRenderer.on("monacori:open-memo", () => cb());
  },
  // Electron watch: main pushes the rebuilt review HTML so the renderer refreshes the diff in place
  // (no window reload), keeping the integrated terminal's pty sessions alive.
  onDiffUpdate: (cb: (html: string) => void): void => {
    ipcRenderer.on("monacori:diff-update", (_event, html: string) => cb(html));
  },
  // Cmd/Ctrl+W from the Window menu -> close the active Files-mode tab in the renderer.
  onCloseTab: (cb: () => void): void => {
    ipcRenderer.on("monacori:close-tab", () => cb());
  },
  // Terminal menu accelerators (Ctrl+`/Alt+F12 toggle, Cmd+D split) — routed via the menu because
  // Chromium swallows Cmd+D before it reaches the renderer's keydown handler.
  onTerminalToggle: (cb: () => void): void => {
    ipcRenderer.on("monacori:terminal-toggle", () => cb());
  },
  onTerminalSplit: (cb: () => void): void => {
    ipcRenderer.on("monacori:terminal-split", () => cb());
  },
  onTerminalPaneFocus: (cb: (delta: number) => void): void => {
    ipcRenderer.on("monacori:terminal-pane-focus", (_event, delta: number) => cb(delta));
  },
  onTerminalPaneRename: (cb: () => void): void => {
    ipcRenderer.on("monacori:terminal-pane-rename", () => cb());
  },
});

// Phase 2 lazy-LOAD: fetch a single file's diff body from the main process on demand, so the initial
// HTML can omit the embedded diff bodies (tens of MB on big repos) and stay small.
contextBridge.exposeInMainWorld("monacoriFile", {
  get: (index: number, kind: string): Promise<string> => ipcRenderer.invoke("monacori:get-file", { index, kind }),
  getSourceData: (): Promise<string> => ipcRenderer.invoke("monacori:get-source-data"),
});

// Self-update: ask the main process to install the latest version globally and relaunch. Only present
// in the Electron app (not browser/watch mode), so the renderer hides the in-app update button there.
contextBridge.exposeInMainWorld("monacoriUpdate", {
  run: (): Promise<unknown> => ipcRenderer.invoke("monacori:self-update"),
});

// Packaged .app (double-clicked, no cwd repo): the welcome screen's "Open Folder" button asks the main
// process to show a directory picker and load that git repo's review.
contextBridge.exposeInMainWorld("monacoriApp", {
  openFolder: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("monacori:open-folder"),
  // Welcome screen's Recent Projects: open a remembered repo path in the current window.
  openRecent: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("monacori:open-recent", { path }),
});


// Integrated terminal: bridge the renderer's xterm view to a node-pty owned by the main process (the
// sandboxed renderer can't spawn a pty). Only present in the Electron app; browser/serve mode lacks it,
// so the renderer keeps the terminal panel hidden there.
contextBridge.exposeInMainWorld("monacoriPty", {
  spawn: (size: { cols: number; rows: number }): Promise<{ ok: boolean; id: number }> => ipcRenderer.invoke("monacori:pty-spawn", size),
  write: (msg: { id: number; data: string }): void => ipcRenderer.send("monacori:pty-write", msg),
  resize: (msg: { id: number; cols: number; rows: number }): void => ipcRenderer.send("monacori:pty-resize", msg),
  kill: (msg: { id: number }): void => ipcRenderer.send("monacori:pty-kill", msg),
  // A TUI in the pane rang the terminal bell (e.g. Claude Code finished a turn / needs input). The renderer
  // passes a pre-localized title+body; the main process decides whether to raise a native notification.
  bell: (msg: { title: string; body: string }): void => ipcRenderer.send("monacori:bell", msg),
  onData: (cb: (msg: { id: number; data: string }) => void): void => {
    ipcRenderer.on("monacori:pty-data", (_event, msg: { id: number; data: string }) => cb(msg));
  },
  onExit: (cb: (msg: { id: number }) => void): void => {
    ipcRenderer.on("monacori:pty-exit", (_event, msg: { id: number }) => cb(msg));
  },
});

// Clipboard bridge — the integrated terminal copies its own selection on Cmd+C (xterm doesn't auto-copy, and
// the sandboxed renderer's navigator.clipboard is unreliable on file://). Electron's clipboard always works here.
contextBridge.exposeInMainWorld("monacoriClipboard", {
  write: (text: string): void => clipboard.writeText(typeof text === "string" ? text : String(text)),
});

// Global settings (locale, …) persisted by the main process under userData so they survive app
// restarts — the renderer's file:// localStorage is not reliably persisted across reopens. `all` is
// read synchronously at preload so the renderer can pick the locale before first paint; `set` writes
// asynchronously. Only present in the Electron app; browser/serve mode falls back to localStorage.
const persistedSettings: Record<string, unknown> = (() => {
  try {
    return (ipcRenderer.sendSync("monacori:get-settings") as Record<string, unknown>) || {};
  } catch {
    return {};
  }
})();
contextBridge.exposeInMainWorld("monacoriSettings", {
  all: persistedSettings,
  set: (key: string, value: unknown): void => {
    try {
      ipcRenderer.send("monacori:set-setting", { key, value });
    } catch {
      /* noop */
    }
  },
});
