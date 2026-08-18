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
  // Review menu's Cmd/Ctrl+Shift+N -> open/close the prompt memo in the renderer.
  onOpenMemo: (cb: () => void): void => {
    ipcRenderer.on("kakapo:open-memo", () => cb());
  },
  // Electron watch: main pushes rebuilt review data so the renderer refreshes the diff in place.
  onDiffUpdate: (cb: (html: string) => void): void => {
    ipcRenderer.on("kakapo:diff-update", (_event, html: string) => cb(html));
  },
  // A long-parked workspace is asked to drop its diff DOM; the rebuild on the way back in repaints it.
  onReleaseView: (cb: () => void): void => {
    ipcRenderer.on("kakapo:release-view", () => cb());
  },
  // Cmd/Ctrl+W from the Window menu -> close the active Files-mode tab in the renderer.
  onCloseTab: (cb: () => void): void => {
    ipcRenderer.on("kakapo:close-tab", () => cb());
  },
  // Terminal menu accelerators (Ctrl+` / Cmd+D / Cmd+Alt+[ etc.) that Chromium swallows before renderer
  // keydown, routed via the app menu to the focused window's terminal client.
  // ⌘+ / ⌘− change the zoom in main (Chromium never lets these reach a renderer keydown). This is main
  // telling the page what the new size is, so the Settings dropdown can show it.
  onUiScale: (cb: (scale: number) => void): void => {
    ipcRenderer.on("kakapo:ui-scale", (_event, scale: number) => cb(Number(scale)));
  },
  onTerminalToggle: (cb: () => void): void => {
    ipcRenderer.on("kakapo:terminal-toggle", () => cb());
  },
  // "row" splits side by side (Cmd+D), "column" stacks top/bottom (Cmd+Shift+D).
  onTerminalSplit: (cb: (direction: "row" | "column") => void): void => {
    ipcRenderer.on("kakapo:terminal-split", (_event, direction) => cb(direction === "column" ? "column" : "row"));
  },
  onTerminalPaneFocus: (cb: (delta: number) => void): void => {
    ipcRenderer.on("kakapo:terminal-pane-focus", (_event, delta: number) => cb(delta));
  },
  onTerminalPaneRename: (cb: () => void): void => {
    ipcRenderer.on("kakapo:terminal-pane-rename", () => cb());
  },
  onAgentResume: (cb: (command: string) => void): void => {
    ipcRenderer.on("kakapo:agent-resume", (_event, command: string) => cb(command));
  },
  onWorkspaceState: (cb: (state: unknown) => void): void => {
    ipcRenderer.on("kakapo:workspace-state", (_event, state: unknown) => cb(state));
  },
  toggleWorkspaceHub: (): void => ipcRenderer.send("kakapo:workspace-hub-toggle"),
  // A click in the review CONTENT dismisses an expanded rail. Reported from here rather than inferred from
  // the view's focus event in main, which cannot tell a click in the diff from one in the terminal panel.
  reviewClicked: (): void => ipcRenderer.send("kakapo:review-clicked"),
  // ⌘K opens a floating quick-switcher rendered over the review (the review stays visible behind it).
  onOpenQuickSwitcher: (cb: () => void): void => {
    ipcRenderer.on("kakapo:open-quick-switcher", () => cb());
  },
  activateWorkspace: (id: number): void => ipcRenderer.send("kakapo:hub-activate", id),
  // The shell title-bar mirrors the activity rail: main relays a title-bar tool click here so the viewer
  // replays it through its own rail dispatcher, and the viewer reports view/terminal state back for highlight.
  onRailAction: (cb: (action: string) => void): void => {
    ipcRenderer.on("kakapo:rail-action", (_event, action: string) => cb(action));
  },
  sendRailState: (state: { active: string[]; terminal: boolean }): void => ipcRenderer.send("kakapo:rail-state", state),
  // While the workspace rail is expanded (pushing this view right), collapse the in-view file tree so the two
  // panels don't compete; restore it when the rail collapses.
  onRailPushed: (cb: (pushed: boolean) => void): void => {
    ipcRenderer.on("kakapo:rail-pushed", (_event, pushed: boolean) => cb(pushed));
  },
});

// Integrated terminal: bridge the renderer's xterm view to a node-pty owned by the main process (the
// sandboxed renderer can't spawn a pty). Only present in the Electron app; browser/serve mode lacks it,
// so the renderer keeps the terminal panel hidden when window.kakapoPty is undefined.
contextBridge.exposeInMainWorld("kakapoPty", {
  // `ordinal` re-attaches to a specific tmux session — see sessions() below, used to restore the panes.
  spawn: (size: { cols: number; rows: number; ordinal?: number }): Promise<{ ok: boolean; id: number }> => ipcRenderer.invoke("kakapo:pty-spawn", size),
  // Persistent terminals (Settings > Terminal): is tmux available, and can we install it for them?
  tmuxStatus: (): Promise<{ tmux: boolean; brew: boolean }> => ipcRenderer.invoke("kakapo:tmux-status"),
  installTmux: (): void => ipcRenderer.send("kakapo:tmux-install"),
  onTmuxInstallOutput: (cb: (chunk: string) => void): void => {
    ipcRenderer.on("kakapo:tmux-install-output", (_event, chunk: string) => cb(chunk));
  },
  onTmuxInstallDone: (cb: (result: { ok: boolean; reason: string }) => void): void => {
    ipcRenderer.on("kakapo:tmux-install-done", (_event, result: { ok: boolean; reason: string }) => cb(result));
  },
  write: (msg: { id: number; data: string }): void => ipcRenderer.send("kakapo:pty-write", msg),
  resize: (msg: { id: number; cols: number; rows: number }): void => ipcRenderer.send("kakapo:pty-resize", msg),
  kill: (msg: { id: number }): void => ipcRenderer.send("kakapo:pty-kill", msg),
  // Is a foreground process (agent/command) running in this pane? Used to confirm before ⌘W closes it.
  foreground: (msg: { id: number }): Promise<{ running: boolean; name: string }> => ipcRenderer.invoke("kakapo:pty-foreground", msg),
  // Live tmux sessions for this workspace, so reopening the panel restores the panes it had.
  sessions: (): Promise<{ ordinals: number[] }> => ipcRenderer.invoke("kakapo:pty-sessions"),
  // A TUI in the pane rang the terminal bell (e.g. Claude Code finished a turn / needs input), or an agent
  // answered a review comment (07-comments.js). The renderer passes a pre-localized title+body; the main
  // process decides whether to raise a native notification. `seq` names the comment the notification is
  // about, so clicking it lands on that thread instead of merely raising the window.
  bell: (msg: { title: string; body: string; seq?: number }): void => ipcRenderer.send("kakapo:bell", msg),
  onData: (cb: (msg: { id: number; data: string }) => void): void => {
    ipcRenderer.on("kakapo:pty-data", (_event, msg: { id: number; data: string }) => cb(msg));
  },
  onExit: (cb: (msg: { id: number }) => void): void => {
    ipcRenderer.on("kakapo:pty-exit", (_event, msg: { id: number }) => cb(msg));
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
  // Park the merged hand-off document next to the thread file and return its path — what the terminal gets is
  // that one path, not the document.
  writeRequest: (text: string, name?: string): Promise<{ ok: boolean; path?: string }> =>
    ipcRenderer.invoke("kakapo:comments-request-write", { text, name }),
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
  // History shift-select: combined diff between two commits (old→new endpoints).
  rangeDiff: (oldSha: string, newSha: string): Promise<unknown> => ipcRenderer.invoke("kakapo:git-range-diff", { oldSha, newSha }),
  // Patch-set compare bar: list selectable bases, and switch the diff base to one (or "auto").
  patchSets: (): Promise<unknown> => ipcRenderer.invoke("kakapo:git-patch-sets"),
  setReviewBase: (ref: string): Promise<unknown> => ipcRenderer.invoke("kakapo:set-review-base", { ref }),
  setReviewTarget: (ref: string): Promise<unknown> => ipcRenderer.invoke("kakapo:set-review-target", { ref }),
  // Open a two-commit range from the history view as the main review's A→B compare (both sides at once).
  // `scope` (optional) is the pickable commit list, so the compare bar's dropdowns can select any B..D in it.
  setReviewCompare: (base: string, target: string, scope?: unknown): Promise<unknown> => ipcRenderer.invoke("kakapo:set-review-compare", { base, target, scope }),
});

// Self-update: ask the main process to install the latest version globally and relaunch. Only present
// in the Electron app (not browser/watch mode), so the renderer hides the in-app update button there.
contextBridge.exposeInMainWorld("kakapoUpdate", {
  run: (): Promise<unknown> => ipcRenderer.invoke("kakapo:self-update"),
  // How far the release image has downloaded. The reviewer keeps working while it streams, so the only
  // reporting surface is the brand mark in the sidebar header — see applyUpdateProgress.
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
  openTerminal: (path: string): Promise<unknown> => ipcRenderer.invoke("kakapo:open-terminal", { path }),
  // A link clicked in the integrated terminal. Main re-checks the scheme — terminal output is untrusted.
  openExternal: (url: string): Promise<unknown> => ipcRenderer.invoke("kakapo:open-external", { url }),
  // Lets the merged-prompt dock claim Cmd+A/Cmd+C for its own whole-document select-all/copy-all while it's
  // open, instead of racing the app menu's identical native accelerators (role: "editMenu" in app-main.ts).
  setIgnoreMenuShortcuts: (ignore: boolean): void => ipcRenderer.send("kakapo:set-ignore-menu-shortcuts", { ignore }),
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
// Live theme/locale sync. Theme + locale are global settings; when one review window changes them (or the OS
// switches while the theme follows "system"), the main process broadcasts the resolved preference here so every
// open review re-applies it without a reload — keeping windows, the rail, and native chrome all in one theme.
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
