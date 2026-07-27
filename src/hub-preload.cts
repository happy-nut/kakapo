import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kakapoHub", {
  onState: (callback: (items: unknown[]) => void) => ipcRenderer.on("kakapo:hub-state", (_event, items) => callback(items)),
  onToggle: (callback: (collapsed: boolean) => void) => ipcRenderer.on("kakapo:hub-toggle", (_event, collapsed) => callback(collapsed)),
  onNew: (callback: () => void) => ipcRenderer.on("kakapo:hub-new", callback),
  activate: (id: number) => ipcRenderer.send("kakapo:hub-activate", id),
  activateIndex: (index: number) => ipcRenderer.send("kakapo:hub-activate-index", index),
  chooseRepo: () => ipcRenderer.invoke("kakapo:hub-choose-repo"),
  preview: (repo: string, label: string) => ipcRenderer.invoke("kakapo:hub-preview", { repo, label }),
  create: (repo: string, label: string) => ipcRenderer.invoke("kakapo:hub-create", { repo, label }),
  cancelCreate: () => ipcRenderer.send("kakapo:hub-cancel-create"),
  rename: (id: number, alias?: string, memo?: string) => ipcRenderer.invoke("kakapo:hub-rename", { id, alias, memo }),
  remove: (id: number, mode: "close" | "delete", force = false, deleteBranch = false) =>
    ipcRenderer.invoke("kakapo:hub-remove", { id, mode, force, deleteBranch }),
  resume: (id: number) => ipcRenderer.send("kakapo:hub-resume", id),
  settings: () => ipcRenderer.send("kakapo:hub-settings"),
  // The New-workspace <dialog> lives in the shell page, which is covered by the review WebContentsView
  // everywhere except the 52px rail. Ask main to hide the review views while a shell modal is open so the
  // dialog (and its backdrop) are actually visible and clickable, then restore on close.
  modal: (open: boolean) => ipcRenderer.send("kakapo:hub-modal", open),
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
  // The rail can widen (hover / ⌘⇧E / pin) to show full workspace names. It reports the new state to main so
  // the review views are pushed right to make room (they render on top of the shell page, so no overlay).
  setHubExpanded: (expanded: boolean) => ipcRenderer.send("kakapo:hub-expanded", expanded),
  onToggleExpand: (callback: () => void) => ipcRenderer.on("kakapo:hub-toggle-expand", callback),
});
