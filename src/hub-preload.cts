import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kakapoHub", {
  onState: (callback: (items: unknown[]) => void) => ipcRenderer.on("kakapo:hub-state", (_event, items) => callback(items)),
  onToggle: (callback: (collapsed: boolean) => void) => ipcRenderer.on("kakapo:hub-toggle", (_event, collapsed) => callback(collapsed)),
  onNew: (callback: () => void) => ipcRenderer.on("kakapo:hub-new", callback),
  activate: (id: number) => ipcRenderer.send("kakapo:hub-activate", id),
  activateIndex: (index: number) => ipcRenderer.send("kakapo:hub-activate-index", index),
  chooseRepo: () => ipcRenderer.invoke("kakapo:hub-choose-repo"),
  // Known Git projects (deduped by repo root) for the New-workspace dialog's project dropdown.
  listProjects: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke("kakapo:hub-projects"),
  preview: (repo: string, label: string) => ipcRenderer.invoke("kakapo:hub-preview", { repo, label }),
  create: (repo: string, label: string) => ipcRenderer.invoke("kakapo:hub-create", { repo, label }),
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
  openModal: (type: string, data?: { id?: number; name?: string }) =>
    ipcRenderer.send("kakapo:hub-open-modal", { type, ...(data || {}) }),
  closeModal: () => ipcRenderer.send("kakapo:hub-close-modal"),
  onModalOpen: (callback: (payload: { type: string; id?: number; name?: string }) => void) =>
    ipcRenderer.on("kakapo:modal-open", (_event, payload) => callback(payload)),
  // Ask main to return keyboard focus to the active review view (its shortcuts don't fire while the shell
  // rail holds focus). Called after clicking non-interactive rail/title-bar chrome.
  refocusReview: () => ipcRenderer.send("kakapo:hub-refocus"),
  detach: (id: number) => ipcRenderer.send("kakapo:hub-detach", id),
  forget: (path: string) => ipcRenderer.invoke("kakapo:hub-forget", { path }),
  reconnect: (oldPath: string, newPath: string) => ipcRenderer.invoke("kakapo:hub-reconnect", { oldPath, newPath }),
  requestState: () => ipcRenderer.send("kakapo:hub-ready"),
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
