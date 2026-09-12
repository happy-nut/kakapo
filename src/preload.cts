import { clipboard, contextBridge, ipcRenderer } from "electron";

// Bridges the sandboxed renderer to the main process so .http requests can be
// executed without CORS or sandbox restrictions. Kept intentionally tiny: the
// renderer only ever asks main to perform a single fetch and return the result.
contextBridge.exposeInMainWorld("kakapoHttp", {
  send: (request: unknown): Promise<unknown> => ipcRenderer.invoke("kakapo:http-send", request),
});

// Lets the Review menu's Cmd/Ctrl+Shift+/ accelerator open the merged review-comments view in
// the renderer (the key macOS would otherwise reserve for its Help search).
contextBridge.exposeInMainWorld("kakapoMenu", {
  onMergedView: (cb: () => void): void => {
    ipcRenderer.on("kakapo:merged-view", () => cb());
  },
  // Electron watch: main pushes rebuilt review data so the renderer refreshes the diff in place.
  onDiffUpdate: (cb: (html: string) => void): void => {
    ipcRenderer.on("kakapo:diff-update", (_event, html: string) => cb(html));
  },
  // A long-minimized window is asked to drop its diff DOM; the rebuild on the way back repaints it.
  onReleaseView: (cb: () => void): void => {
    ipcRenderer.on("kakapo:release-view", () => cb());
  },
  // Cmd/Ctrl+W from the Window menu -> close the active Files-mode tab in the renderer.
  onCloseTab: (cb: () => void): void => {
    ipcRenderer.on("kakapo:close-tab", () => cb());
  },
  // ⌘+ / ⌘− change the zoom in main (Chromium never lets these reach a renderer keydown). This is main
  // telling the page what the new size is, so the Settings dropdown can show it.
  onUiScale: (cb: (scale: number) => void): void => {
    ipcRenderer.on("kakapo:ui-scale", (_event, scale: number) => cb(Number(scale)));
  },
});

// The review conversation (comments-file.ts): comments, agent answers and agent notes are one list in one
// file. `read` returns it (plus the path the agent is told to append to), `write` saves the renderer's whole
// list, and `onUpdate` pushes the file back whenever an agent appends to it.
contextBridge.exposeInMainWorld("kakapoComments", {
  read: (): Promise<{ path: string; exists: boolean; records: unknown[]; legacyNotes: unknown[] }> =>
    ipcRenderer.invoke("kakapo:comments-read"),
  write: (payload: { records: unknown[]; knownMaxId: number }): Promise<{ ok: boolean; path?: string; arrived?: unknown[] }> =>
    ipcRenderer.invoke("kakapo:comments-write", payload),
  onUpdate: (cb: (payload: { records: unknown[] }) => void): void => {
    ipcRenderer.on("kakapo:comments-update", (_event, payload) => cb(payload));
  },
  // The notification about an answer was clicked: go to the comment it was about.
  onReveal: (cb: (payload: { seq: number }) => void): void => {
    ipcRenderer.on("kakapo:comments-reveal", (_event, payload) => cb(payload));
  },
});

// Phase 2 lazy-LOAD: fetch a single file's diff body from the main process on demand, so the initial
// HTML can omit the embedded diff bodies (tens of MB on big repos) and stay small.
contextBridge.exposeInMainWorld("kakapoFile", {
  get: (index: number, kind: string): Promise<string> => ipcRenderer.invoke("kakapo:get-file", { index, kind }),
  getIndex: (): Promise<unknown> => ipcRenderer.invoke("kakapo:get-project-index"),
  getSource: (path: string): Promise<unknown> => ipcRenderer.invoke("kakapo:get-source", { path }),
  getAsset: (path: string): Promise<{ dataUrl: string } | null> => ipcRenderer.invoke("kakapo:get-asset", { path }),
  existingPaths: (paths: string[]): Promise<unknown> => ipcRenderer.invoke("kakapo:existing-project-paths", { paths }),
  getDiffContext: (request: unknown): Promise<unknown> => ipcRenderer.invoke("kakapo:get-diff-context", request),
});

// LSP-first code intelligence. The renderer sends only a location/query and
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
  // History shift-select: combined diff between two commits (old→new endpoints).
  rangeDiff: (oldSha: string, newSha: string): Promise<unknown> => ipcRenderer.invoke("kakapo:git-range-diff", { oldSha, newSha }),
  // Patch-set compare bar: list selectable bases, and switch the diff base to one (or "auto").
  patchSets: (): Promise<unknown> => ipcRenderer.invoke("kakapo:git-patch-sets"),
  setReviewBase: (ref: string): Promise<unknown> => ipcRenderer.invoke("kakapo:set-review-base", { ref }),
  setReviewTarget: (ref: string): Promise<unknown> => ipcRenderer.invoke("kakapo:set-review-target", { ref }),
  // Open a two-commit range from the history view as the main review's A→B compare (both sides at once).
  // `scope` (optional) is the pickable commit list, so the compare bar's dropdowns can select any B..D in it.
  setReviewCompare: (base: string, target: string, scope?: unknown): Promise<unknown> => ipcRenderer.invoke("kakapo:set-review-compare", { base, target, scope }),
  // Compare dropdown on the toolbar pill: read the current mode + branch list, and switch between
  // "all changes vs <branch>" and "uncommitted changes".
  compareMenu: (): Promise<unknown> => ipcRenderer.invoke("kakapo:compare-menu"),
  setCompareMode: (mode: string, ref?: string): Promise<unknown> => ipcRenderer.invoke("kakapo:set-compare-mode", { mode, ref }),
});

// Self-update: ask the main process to install the latest version globally and relaunch. Only present
// in the Electron app (not browser/watch mode), so the renderer hides the in-app update button there.
contextBridge.exposeInMainWorld("kakapoUpdate", {
  run: (): Promise<unknown> => ipcRenderer.invoke("kakapo:self-update"),
  // A packaged update streams a ~200MB DMG; the Settings row counts it up so the wait is legible.
  onProgress: (cb: (payload: { percent: number; done?: boolean }) => void): void => {
    ipcRenderer.on("kakapo:update-progress", (_event, payload) => cb(payload));
  },
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
  // Open the OS terminal in the folder holding this file.
  openTerminal: (path: string): Promise<unknown> => ipcRenderer.invoke("kakapo:open-terminal", { path }),
  // A link clicked in a review. Main re-checks the scheme before anything is opened.
  openExternal: (url: string): Promise<unknown> => ipcRenderer.invoke("kakapo:open-external", { url }),
  // An image path clicked there. Main re-checks everything (viewableFilePath in app-path-ipc.ts).
  openViewable: (path: string): Promise<unknown> => ipcRenderer.invoke("kakapo:open-viewable", { path }),
  // Lets the merged-prompt dock claim Cmd+A/Cmd+C for its own whole-document select-all/copy-all while it's
  // open, instead of racing the app menu's identical native accelerators (role: "editMenu" in app-main.ts).
  setIgnoreMenuShortcuts: (ignore: boolean): void => ipcRenderer.send("kakapo:set-ignore-menu-shortcuts", { ignore }),
});

// Clipboard bridge for review locations and grounded handoff prompts. Electron's clipboard is reliable
// even when navigator.clipboard is unavailable for a local file.
contextBridge.exposeInMainWorld("kakapoClipboard", {
  write: (text: string): void => clipboard.writeText(typeof text === "string" ? text : String(text)),
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
// Live theme/locale sync. Theme + locale are global settings; when one review window changes them (or the OS
// switches while the theme follows "system"), the main process broadcasts the resolved preference here so every
// open review re-applies it without a reload — keeping every window and the native chrome in one theme.
contextBridge.exposeInMainWorld("kakapoChrome", {
  onChange: (cb: (payload: { theme?: string; resolved?: string; locale?: string }) => void): void => {
    ipcRenderer.on("kakapo:chrome", (_event, payload) => cb(payload));
  },
});

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
