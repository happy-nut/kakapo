import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kakapoHub", {
  onState: (callback: (items: unknown[]) => void) => ipcRenderer.on("kakapo:hub-state", (_event, items) => callback(items)),
  onToggle: (callback: (collapsed: boolean) => void) => ipcRenderer.on("kakapo:hub-toggle", (_event, collapsed) => callback(collapsed)),
  // ⌘N / the New Workspace menu item. Main names the project of the window it was pressed in; the rail
  // falls back to its own idea of the active one when that is absent (no workspace open at all).
  onNew: (callback: (prefill?: { path: string; name: string }) => void) =>
    ipcRenderer.on("kakapo:hub-new", (_event, prefill) => callback(prefill)),
  activate: (id: number) => ipcRenderer.send("kakapo:hub-activate", id),
  // Open (or focus) a project's main checkout that is pinned in the rail but has no window yet.
  openPath: (path: string) => ipcRenderer.send("kakapo:hub-open", path),
  activateIndex: (index: number) => ipcRenderer.send("kakapo:hub-activate-index", index),
  chooseRepo: () => ipcRenderer.invoke("kakapo:hub-choose-repo"),
  // Known Git projects (deduped by repo root) for the New-workspace dialog's project dropdown.
  listProjects: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke("kakapo:hub-projects"),
  // worktree=false means "open this project's existing checkout" — no new branch, no new folder.
  // `slug` rides both ways: the preview names the worktree (a random pair, not the task name — see
  // randomWorkspaceSlug), and the dialog hands the very same one back so what you were shown is what is made.
  preview: (repo: string, label: string, worktree: boolean, slug?: string) => ipcRenderer.invoke("kakapo:hub-preview", { repo, label, worktree, slug }),
  // `base` is the ref the new worktree branches FROM. Empty means "whatever defaultBase() picks", which is
  // origin/HEAD — right for a repo whose work lands on the default branch, wrong for one that develops on
  // another, where every new workspace would silently start life behind.
  create: (repo: string, label: string, worktree: boolean, opts?: { base?: string; slug?: string; memo?: string }) =>
    ipcRenderer.invoke("kakapo:hub-create", { repo, label, worktree, ...(opts || {}) }),
  cancelCreate: () => ipcRenderer.send("kakapo:hub-cancel-create"),
  rename: (id: number, alias?: string, memo?: string) => ipcRenderer.invoke("kakapo:hub-rename", { id, alias, memo }),
  // Native workspace-tile context menu (drawn above the review views, so it doesn't blank the main panel).
  tileMenu: (info: { id: number; name: string; resume: boolean; kind?: string }) => ipcRenderer.send("kakapo:tile-menu", info),
  onTileAction: (callback: (data: { id: number; action: string; name: string }) => void) =>
    ipcRenderer.on("kakapo:tile-action", (_event, data) => callback(data)),
  remove: (id: number, mode: "close" | "delete", force = false, deleteBranch = false) =>
    ipcRenderer.invoke("kakapo:hub-remove", { id, mode, force, deleteBranch }),
  resume: (id: number) => ipcRenderer.send("kakapo:hub-resume", id),
  settings: () => ipcRenderer.send("kakapo:hub-settings"),
  // The New-workspace / rename / memo dialogs live in a transparent overlay WebContentsView layered ABOVE the
  // review view, so the live content dims behind them (no snapshot). The rail calls openModal to ask main to
  // show the overlay and which dialog to open; the overlay page receives that via onModalOpen and asks main to
  // hide the overlay again via closeModal.
  openModal: (type: string, data?: { id?: number; name?: string; path?: string }) =>
    ipcRenderer.send("kakapo:hub-open-modal", { type, ...(data || {}) }),
  closeModal: () => ipcRenderer.send("kakapo:hub-close-modal"),
  onModalOpen: (
    callback: (payload: {
      type: string; id?: number; name?: string; path?: string;
      title?: string; message?: string; detail?: string; buttons?: string[]; danger?: boolean; defaultId?: number; checkbox?: string; checked?: boolean;
    }) => void,
  ) => ipcRenderer.on("kakapo:modal-open", (_event, payload) => callback(payload)),
  // Custom confirm/alert component: the rail (or any renderer) calls confirm() to show a design-system dialog in
  // the overlay instead of a native message box; main relays the spec to the overlay and resolves with the
  // chosen button index (+ optional checkbox state). The overlay reports the click back via confirmResult().
  confirm: (spec: {
    title?: string; message?: string; detail?: string; buttons?: string[]; danger?: boolean; defaultId?: number; checkbox?: string; checked?: boolean;
  }): Promise<{ index: number; checked: boolean }> => ipcRenderer.invoke("kakapo:hub-confirm", spec),
  confirmResult: (result: { index: number; checked: boolean }) => ipcRenderer.send("kakapo:confirm-result", result),
  // Ask main to return keyboard focus to the active review view (its shortcuts don't fire while the shell
  // rail holds focus). Called after clicking non-interactive rail/title-bar chrome.
  refocusReview: () => ipcRenderer.send("kakapo:hub-refocus"),
  detach: (id: number) => ipcRenderer.send("kakapo:hub-detach", id),
  forget: (path: string) => ipcRenderer.invoke("kakapo:hub-forget", { path }),
  reconnect: (oldPath: string, newPath: string) => ipcRenderer.invoke("kakapo:hub-reconnect", { oldPath, newPath }),
  // The disconnected-tile dialog (folder gone) is a custom overlay component now (openModal 'disconnected').
  // Its Reconnect button calls this so main can run the native folder picker + repoint the entry; Remove uses
  // forget() above.
  reconnectPick: (path: string) => ipcRenderer.invoke("kakapo:hub-reconnect-pick", { path }),
  requestState: () => ipcRenderer.send("kakapo:hub-ready"),
  // Agent quota (Claude via its usage API, Codex from its session logs). Shown in the rail rather than the
  // review's sidebar footer: it is per-account, not per-workspace, so one place for the whole app is right.
  usage: (): Promise<unknown> => ipcRenderer.invoke("kakapo:usage-stats"),
  // Title-bar review tools: the buttons live in this shell page but the actions run in the active review
  // view (a separate WebContentsView). Forward the click to main, which relays it to that view; the view
  // reports its active-view/terminal state back so the title-bar buttons can mirror the highlight.
  railAction: (action: string) => ipcRenderer.send("kakapo:hub-rail-action", action),
  onRailState: (callback: (state: { active?: string[]; terminal?: boolean }) => void) =>
    ipcRenderer.on("kakapo:hub-rail-state", (_event, state) => callback(state)),
  // Per-workspace agent-activity deltas (busy spinner / attention dot), applied to existing tiles without a
  // full rail re-render.
  onActivity: (callback: (list: { id: number; busy: boolean; unread: boolean; running: boolean }[]) => void) =>
    ipcRenderer.on("kakapo:hub-activity", (_event, list) => callback(list)),
  // The rail can widen (hover / ⌘⇧E / pin) to show full workspace names. It reports the new state to main so
  // the review views are pushed right to make room (they render on top of the shell page, so no overlay).
  setHubExpanded: (expanded: boolean) => ipcRenderer.send("kakapo:hub-expanded", expanded),
  onToggleExpand: (callback: () => void) => ipcRenderer.on("kakapo:hub-toggle-expand", callback),
  // Main collapses the rail (visual only) when focus returns to the review view.
  onSetExpanded: (callback: (open: boolean) => void) => ipcRenderer.on("kakapo:hub-set-expanded", (_event, open) => callback(open)),
});
