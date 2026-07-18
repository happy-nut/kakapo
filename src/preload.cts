import { clipboard, contextBridge, ipcRenderer } from "electron";

// Bridges the sandboxed renderer to the main process so .http requests can be
// executed without CORS or sandbox restrictions. Kept intentionally tiny: the
// renderer only ever asks main to perform a single fetch and return the result.
contextBridge.exposeInMainWorld("kakapoHttp", {
  send: (request: unknown): Promise<unknown> => ipcRenderer.invoke("kakapo:http-send", request),
});

// Lets the Review menu's Cmd/Ctrl+Shift+/ and +. accelerators open the merged comment views in
// the renderer (the keys macOS would otherwise reserve for its Help search).
contextBridge.exposeInMainWorld("kakapoMenu", {
  onMergedView: (cb: (kind: string) => void): void => {
    ipcRenderer.on("kakapo:merged-view", (_event, kind: string) => cb(kind));
  },
  // Review menu's Cmd/Ctrl+Shift+N -> open/close the prompt memo in the renderer.
  onOpenMemo: (cb: () => void): void => {
    ipcRenderer.on("kakapo:open-memo", () => cb());
  },
  // Electron watch: main pushes rebuilt review data so the renderer refreshes the diff in place.
  onDiffUpdate: (cb: (html: string) => void): void => {
    ipcRenderer.on("kakapo:diff-update", (_event, html: string) => cb(html));
  },
  // Cmd/Ctrl+W from the Window menu -> close the active Files-mode tab in the renderer.
  onCloseTab: (cb: () => void): void => {
    ipcRenderer.on("kakapo:close-tab", () => cb());
  },
});

// Phase 2 lazy-LOAD: fetch a single file's diff body from the main process on demand, so the initial
// HTML can omit the embedded diff bodies (tens of MB on big repos) and stay small.
contextBridge.exposeInMainWorld("kakapoFile", {
  get: (index: number, kind: string): Promise<string> => ipcRenderer.invoke("kakapo:get-file", { index, kind }),
  getIndex: (): Promise<unknown> => ipcRenderer.invoke("kakapo:get-project-index"),
  getSource: (path: string): Promise<unknown> => ipcRenderer.invoke("kakapo:get-source", { path }),
  existingPaths: (paths: string[]): Promise<unknown> => ipcRenderer.invoke("kakapo:existing-project-paths", { paths }),
  getDiffContext: (request: unknown): Promise<unknown> => ipcRenderer.invoke("kakapo:get-diff-context", request),
});

// LSP-first code intelligence and change-impact analysis. The renderer sends only a location/query and
// receives compact result locations; project sources and language-server processes stay in main.
contextBridge.exposeInMainWorld("kakapoAnalysis", {
  query: (request: unknown): Promise<unknown> => ipcRenderer.invoke("kakapo:analysis", request),
  diagnostics: (path: string): Promise<unknown> => ipcRenderer.invoke("kakapo:diagnostics", { path }),
  status: (): Promise<unknown> => ipcRenderer.invoke("kakapo:analysis-status"),
  onStatus: (cb: (status: unknown) => void): void => {
    ipcRenderer.on("kakapo:analysis-status", (_event, status: unknown) => cb(status));
  },
});

// User-visible performance milestones are persisted by main as compact local evidence. The renderer can
// only send a named marker; main validates the payload and owns the artifact path.
contextBridge.exposeInMainWorld("kakapoPerf", {
  mark: (name: string, details?: unknown): void => ipcRenderer.send("kakapo:perf-mark", { name, details }),
});

// Project-wide occurrence search. The main process uses kakapo's bundled ripgrep binary; browser/static
// reviews, where native processes cannot run, retain the renderer's local fallback.
contextBridge.exposeInMainWorld("kakapoSearch", {
  query: (request: { query: string; limit?: number; extensions?: string[]; excludeCommentsAndTests?: boolean }): Promise<unknown> => ipcRenderer.invoke("kakapo:search", request),
});

// Git history view (Cmd+9): list commits and fetch one commit's full diff for the current window's repo.
contextBridge.exposeInMainWorld("kakapoGit", {
  log: (request: { limit?: number; skip?: number }): Promise<unknown> => ipcRenderer.invoke("kakapo:git-log", request),
  lineLog: (request: { path: string; line: number; limit?: number }): Promise<unknown> => ipcRenderer.invoke("kakapo:git-line-log", request),
  blame: (request: { path: string; side?: "old" | "new" }): Promise<unknown> => ipcRenderer.invoke("kakapo:git-blame", request),
  commitDiff: (sha: string): Promise<unknown> => ipcRenderer.invoke("kakapo:git-commit-diff", { sha }),
});

// Self-update: ask the main process to install the latest version globally and relaunch. Only present
// in the Electron app (not browser/watch mode), so the renderer hides the in-app update button there.
contextBridge.exposeInMainWorld("kakapoUpdate", {
  run: (): Promise<unknown> => ipcRenderer.invoke("kakapo:self-update"),
});

// Packaged .app (double-clicked, no cwd repo): the welcome screen's "Open Folder" button asks the main
// process to show a directory picker and load that git repo's review.
contextBridge.exposeInMainWorld("kakapoApp", {
  openFolder: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("kakapo:open-folder"),
  // Welcome screen's Recent Projects: open a remembered repo path in the current window.
  openRecent: (path: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("kakapo:open-recent", { path }),
  // Sidebar Opt+Enter menu: path actions stay in main so the sandboxed renderer never receives the root.
  absolutePath: (path: string): Promise<unknown> => ipcRenderer.invoke("kakapo:absolute-file-path", { path }),
  revealInFinder: (path: string): Promise<unknown> => ipcRenderer.invoke("kakapo:reveal-in-finder", { path }),
  openTerminal: (path: string): Promise<unknown> => ipcRenderer.invoke("kakapo:open-terminal", { path }),
});

// Clipboard bridge for review locations and grounded handoff prompts. Electron's clipboard is reliable
// even when navigator.clipboard is unavailable for a local file.
contextBridge.exposeInMainWorld("kakapoClipboard", {
  write: (text: string): void => clipboard.writeText(typeof text === "string" ? text : String(text)),
});

// One worktree-scoped Markdown memo. Main owns the file under Electron userData; the sandboxed renderer
// receives document operations and can never choose a filesystem path inside or outside the repository.
contextBridge.exposeInMainWorld("kakapoMemo", {
  read: (): Promise<unknown> => ipcRenderer.invoke("kakapo:memo-read"),
  write: (body: string): Promise<unknown> => ipcRenderer.invoke("kakapo:memo-write", { body }),
  remove: (): Promise<unknown> => ipcRenderer.invoke("kakapo:memo-delete"),
});

// Global settings (locale, …) persisted by the main process under userData so they survive app
// restarts — the renderer's file:// localStorage is not reliably persisted across reopens. `all` is
// read synchronously at preload so the renderer can pick the locale before first paint; `set` writes
// asynchronously. Only present in the Electron app; browser/serve mode falls back to localStorage.
const persistedSettings: Record<string, unknown> = (() => {
  try {
    return (ipcRenderer.sendSync("kakapo:get-settings") as Record<string, unknown>) || {};
  } catch {
    return {};
  }
})();
contextBridge.exposeInMainWorld("kakapoSettings", {
  all: persistedSettings,
  set: (key: string, value: unknown): void => {
    try {
      ipcRenderer.send("kakapo:set-setting", { key, value });
    } catch {
      /* noop */
    }
  },
});
