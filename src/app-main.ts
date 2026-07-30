import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, screen, shell, WebContentsView } from "electron";
import type { WebContents } from "electron";
import { git, isGitRepository, resolveWorkspaceRoot, validateReviewBase } from "./git.js";
import { renderWelcomeHtml } from "./render.js";
import { relaunchUpdatedApp, selfUpdateInstallAttempts } from "./self-update.js";
import { ProjectAnalysis } from "./analysis.js";
import { ReviewPerformanceTrace } from "./perf.js";
import { ProjectMarkdownMemo } from "./memos.js";
import type { SourceFile } from "./types.js";
import { workspaceReviewFile } from "./workspace-data.js";
import { kakapoIconCssVariable, kakapoIconHtml } from "./brand.js";
import { reviewDiffSignature, writeReviewWorkspace } from "./review-workspace.js";
import { decideWatchTick, shouldPushUpdate } from "./watch-decision.js";
import { parseReviewArgs, readOption } from "./cli-args.js";
import { AppPreferences } from "./app-preferences.js";
import { registerReviewIpc } from "./app-review-ipc.js";
import { registerProjectPathIpc } from "./app-path-ipc.js";
import { registerTerminalIpc } from "./app-terminal-ipc.js";
import { registerAnswersIpc, syncAnswersFile, answersFilePath } from "./answers-ipc.js";
import { registerExplainIpc, refreshExplainIfChanged } from "./app-explain-ipc.js";
import type { IPty } from "node-pty";
import { installWindowSurfaceRecovery } from "./window-layout.js";
import { HUB_WIDTH, HUB_EXPANDED, TITLEBAR_H } from "./constants.js";
import { hubHtml, modalOverlayHtml, tileMenuHtml } from "./shell-pages.js";
import { createManagedWorkspaceAsync, defaultBase, removalRisk, removeManagedWorkspace, workspaceRecord, workspaceSlug, type WorkspaceRecord } from "./workspaces.js";

type AppOptions = {
  root: string;
  base?: string;
  target?: string; // A→B compare: right/new side revision (undefined = working tree)
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  watch: boolean;
  ignoreWhitespace: boolean;
};

type ReviewSurface = {
  webContents: WebContents;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  hide(): void;
  focus(): void;
  loadURL(url: string): Promise<void>;
  loadFile(path: string): Promise<void>;
  detach(): void;
  isDetached(): boolean;
};

// Per-window state. Everything that used to be a module-level global (the review signature, watch timer,
// lazily-served diff bodies/source, and last-diff hash) now lives here, keyed
// by BrowserWindow.id, so two windows reviewing different repos don't trample each other's state.
type WinState = {
  win: ReviewSurface;
  options: AppOptions; // this window's repo + diff flags (root + ignoreWhitespace are per-window)
  signature: string;
  refreshing: boolean;
  refreshTimer?: NodeJS.Timeout;
  analysisWarmTimer?: NodeJS.Timeout;
  // Agent-answers exchange (see answers-ipc.ts): this window's answers.json path, its poll timer (runs
  // independent of --watch), the last raw file content seen (change short-circuit), and the last known
  // answer/answeredAt per comment seq (delta computation).
  answersFile?: string;
  answersFileSig?: string;
  answersTimer?: NodeJS.Timeout;
  lastAnswers?: Map<number, { answer: string | null; answeredAt: string | null }>;
  bodyDiffs: string[]; // Phase 2 lazy-LOAD: raw per-file diffs rendered for THIS window's renderer on demand
  bodyCache: Map<number, string>; // rendered per-file diff bodies, scoped to the current build
  sourceFiles: Map<string, SourceFile>; // source content stays in main; renderer requests one open file at a time
  analysis: ProjectAnalysis; // LSP-first project analysis + main-process regex fallback
  analysisSuspended: boolean;
  idleTimer?: NodeJS.Timeout;
  terms: Map<number, IPty>; // integrated-terminal ptys owned by this window (killed on close)
  commandBuffers: Map<number, string>;
  resumeCommand?: string;
  onResumeCommand: (command: string | undefined) => void;
  onAgentFinished: () => void;
  onAgentOutput: () => void;
  onAgentBell: () => void;
  unread: boolean; // an agent turn finished / needs input in this (non-active) workspace — the tile's red dot
  busy: boolean; // an agent is actively producing output here — the tile's animated "working" spinner
  busyTimer?: NodeJS.Timeout; // debounce: cleared/reset on each output chunk; on expiry the workspace goes idle
  // Rail tile data (repo record + working-tree dirty count) is git-derived — ~5 subprocesses/workspace.
  // renderHub fires on every agent-activity event, so cache it per workspace with a short TTL: without this
  // an N-workspace hub render spawns ~5N git processes on the main thread each time an agent turn finishes.
  hubTile?: { record: WorkspaceRecord; dirtyCount: number; computedAt: number };
  bootStarted: boolean;
  perf: ReviewPerformanceTrace; // local startup/analysis evidence under this workspace's app-data mirror
  lastDiffSig: string; // watch fast-path: hash of the last git diff, to skip rebuilds when unchanged
  reviewBase?: string; // exact base used by the latest build (may be an automatic upstream merge-base)
  reviewTarget?: string; // exact right/new side revision for an A→B compare (undefined = working tree)
  // Commits of the range opened from the Cmd+9 history (oldest→newest). While set, the compare bar's two
  // dropdowns pick base/target from THIS list, so B..D within an opened A..F is selectable. Cleared on exit.
  compareScope?: { sha: string; shortSha: string; subject: string; date: string }[];
  reviewUpstream?: string; // tracking ref behind an automatic base; included in the watch signature
  disposeWindowSurfaceRecovery: () => void;
  explainTimer?: NodeJS.Timeout; // Explain view: polls this workspace's content-spec file, independent of --watch
  explainSig: string; // last-seen spec file mtime+size, to skip re-parsing when unchanged
  explainSpec: unknown; // last-parsed content spec, served immediately to a newly-opened Explain view
  explainUpdatedAt: number | null;
};

// `npm run dev` sets KAKAPO_DEV=1 so a locally-built app announces itself — a window-title suffix
// plus a boot log with its on-disk path — making it obvious whether `kakapo` launched THIS checkout or
// the globally-installed package (their version numbers can be identical; the path is the tell).
const DEV_BUILD = process.env.KAKAPO_DEV === "1";
const APP_NAME = "Kakapo";
const APP_TITLE = DEV_BUILD ? `${APP_NAME} (dev)` : APP_NAME;
const APP_VERSION = app.isPackaged ? app.getVersion() : (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version as string;
  } catch {
    return app.getVersion();
  }
})();
const REVIEW_FILE = "app-review.html";
const WATCH_INTERVAL_MS = 1000;
const ANALYSIS_PREWARM_DELAY_MS = 350;

// Painted immediately while the first review build + HTML render run, so startup shows the Kakapo mark
// of a blank window. Inlined as a data: URL so it needs no file on disk and appears before any review
// work. Theme-aware so a light-theme user doesn't get a dark flash before the renderer applies the theme.
function loadingHtml(light: boolean): string {
  const bg = light ? "#ffffff" : "#2b2b2b";
  const fg = light ? "#6e7781" : "#9aa4af";
  const mark = kakapoIconHtml("kakapo-mark");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{${kakapoIconCssVariable()}}
  html,body{margin:0;height:100vh;background:${bg};color:${fg};display:flex;flex-direction:column;
    align-items:center;justify-content:center;
    font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .kakapo-loader{display:grid;place-items:center;width:72px;height:72px;filter:drop-shadow(0 9px 15px rgba(0,0,0,.2))}
  .kakapo-mark{display:block;width:64px;height:64px;background:var(--kakapo-ui-icon) center/contain no-repeat;
    animation:kakapo-peck 1.05s cubic-bezier(.45,0,.25,1) infinite;transform-origin:52% 72%}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  @keyframes kakapo-peck{0%,100%{transform:translateY(0) rotate(0);opacity:.9}38%{transform:translateY(-3px) rotate(-3deg);opacity:1}62%{transform:translateY(1px) rotate(2deg)}}
  @media(prefers-reduced-motion:reduce){.kakapo-mark{animation:kakapo-breathe 1.6s ease-in-out infinite}@keyframes kakapo-breathe{50%{opacity:.65}}}
</style></head><body><span class="kakapo-loader" role="status" aria-label="Kakapo is loading">${mark}<span class="sr-only">Kakapo is loading</span></span></body></html>`;
}
// The persisted theme (set by the renderer via kakapoSettings). Read at startup so the native window
// chrome + loading screen match before the renderer boots. Defaults to dark.
function isLightTheme(): boolean {
  try {
    return preferences.readGlobal()["kakapo-theme"] === "light";
  } catch {
    return false;
  }
}

app.setName(APP_NAME);
if (DEV_BUILD) app.setPath("userData", join(app.getPath("userData"), "dev"));
// Opt-in local CDP endpoint for automated verification (never on in normal runs).
if (process.env.KAKAPO_REMOTE_DEBUG) app.commandLine.appendSwitch("remote-debugging-port", process.env.KAKAPO_REMOTE_DEBUG);
// The lazy Markdown editor cannot reliably load from the repository's file:// review. A narrow, read-only
// standard scheme serves only production assets copied under the historical dist/monaco directory.
protocol.registerSchemesAsPrivileged([{
  scheme: "kakapo-asset",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);
// Never patch or rename Electron.app from inside the running Electron process. The CLI launcher performs
// that repair synchronously before spawning Electron (and postinstall handles the normal install path).
// Mutating the live bundle during macOS didFinishLaunching can terminate Chromium with SIGTRAP.

const iconPath = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon.png");
const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.cjs");
const hubPreloadPath = join(dirname(fileURLToPath(import.meta.url)), "hub-preload.cjs");

// Development argv is `[electron, app-main.js, ...flags]`; a packaged app is
// `[Kakapo, ...flags]`. Dropping two entries unconditionally erased `--cwd` from the installed app,
// so scripted relaunches landed on the welcome/recent-project screen instead of the requested folder.
const runtimeArgs = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
const options = parseArgs(runtimeArgs);
// Electron forwards this small, serializable payload to the primary process. Keeping the canonical path
// in additionalData avoids relying on platform-specific command-line/cwd behavior during handoff.
const hasSingleInstanceLock = app.requestSingleInstanceLock({ workspaceRoot: options.root });
const states = new Map<number, WinState>();
let shellWindow: BrowserWindow | undefined;
let activeStateId: number | undefined;
let quitConfirmed = false;
// Set once the shell window is closing (Cmd+Q, red-X, or app.quit()). Every review view is torn down during
// shutdown, and each teardown would otherwise rewrite kakapo-open-workspaces from the shrinking live set —
// leaving an empty list that erases the restore-on-launch session. Skip that teardown persist while quitting
// so the workspaces open at quit time survive to the next launch. Explicit single-workspace closes (hub-remove,
// detached-window close) happen with this flag false, so they still drop the workspace from the saved list.
let appQuitting = false;
// The workspace rail is a thin, ALWAYS-VISIBLE column of workspace tiles (like an editor's activity bar).
// Switching workspaces never removes the review's own Changes/Files sidebar, so there is no "how do I get
// back" state — you never left. `hubOpen` stays true; the rail is not a mode you toggle into and out of.
// Expanded (⌘⇧E / pinned) the rail widens to show each workspace's full name + branch. The review views
// can't overlay the shell page (it renders behind them), so expansion PUSHES them right. Set to the collapsed
// rail width plus the review sidebar's default width, so the expanded rail reaches exactly where the file
// tree's right edge was — the rail replaces the tree in place and the content doesn't shift.
let hubWidth = HUB_WIDTH; // current rail width the review views are laid out against
// A full-width title strip gives the macOS traffic lights their own clean band, so no vertical divider
// runs up into them. The review views sit below it; the active workspace's name lives in the strip.
let hubOpen = true;
// True while a shell-page modal (the New-workspace dialog) is up. Suppresses the "return keyboard focus to
// the review view" behavior so the dialog keeps focus.
let modalOpen = false;
// The New-workspace / rename / memo dialogs render in a transparent WebContentsView layered above the review
// views, so the live content dims behind them. Kept for the shell window's lifetime; toggled visible per modal.
let modalView: WebContentsView | undefined;
let modalViewReady = false;
let pendingModalOpen: unknown = null;
let workspaceCreation: AbortController | undefined;
const preferences = new AppPreferences(app.getPath("userData"), isGitRepository);
const startupWorkspaceMetadata = preferences.readOpenWorkspaces();
let markdownMemo: ProjectMarkdownMemo | undefined;

if (!existsSync(options.root)) {
  throw new Error(`Repository path does not exist: ${options.root}`);
}

// Resolve the WinState for an IPC call by mapping its sender back to a window — this is how get-file /
// source/analysis requests are routed to the right window's state instead of a shared global.
function stateFromEvent(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): WinState | undefined {
  return states.get(event.sender.id);
}
function focusedState(): WinState | undefined {
  return activeStateId === undefined ? undefined : states.get(activeStateId);
}
// Menu accelerators are application-global, so they act on whichever window is focused.
function sendToFocused(channel: string, payload?: unknown): void {
  const state = focusedState();
  if (state && !state.win.isDestroyed()) state.win.webContents.send(channel, payload);
}

function memoStore(): ProjectMarkdownMemo {
  if (!markdownMemo) markdownMemo = new ProjectMarkdownMemo(app.getPath("userData"));
  return markdownMemo;
}

function readMemoWithLegacyImport(root: string) {
  let document = memoStore().read(root);
  if (document.body) return document;
  const settings = preferences.readGlobal();
  const legacy = settings["kakapo-memo"];
  if (typeof legacy !== "string" || !legacy.trim() || settings["kakapo-memo-migrated-worktree"]) return document;
  document = memoStore().write(root, legacy);
  delete settings["kakapo-memo"];
  settings["kakapo-memo-migrated-worktree"] = document.worktreePath;
  preferences.writeGlobal(settings);
  return document;
}

// The composition root supplies window-scoped state; the adapter owns review/query IPC details.
registerReviewIpc(ipcMain, stateFromEvent);
registerProjectPathIpc(ipcMain, shell, stateFromEvent);
registerTerminalIpc(ipcMain, stateFromEvent);
registerAnswersIpc(ipcMain, stateFromEvent);
registerExplainIpc(ipcMain, stateFromEvent);
ipcMain.on("kakapo:hub-ready", renderHub);
// Title-bar review tools live in the shell page but act on the active review view. Relay the click to that
// view (which replays it through its own rail dispatcher). Guard on an active workspace existing.
ipcMain.on("kakapo:hub-rail-action", (_event, action: unknown) => {
  if (typeof action !== "string" || activeStateId === undefined) return;
  states.get(activeStateId)?.win.webContents.send("kakapo:rail-action", action);
});
// The active view reports which views are open + whether its terminal exists, so the title-bar buttons can
// mirror the highlight. Ignore reports from background views to avoid a stale view overwriting the state.
ipcMain.on("kakapo:rail-state", (event, state: unknown) => {
  if (event.sender.id !== activeStateId) return;
  if (shellWindow && !shellWindow.isDestroyed()) shellWindow.webContents.send("kakapo:hub-rail-state", state);
});
// The rail is always visible, so there is nothing to toggle. Kept as a harmless no-op so the viewer's
// existing chip-click / ⌘K wiring does not error; a floating quick-switcher can hook here later.
ipcMain.on("kakapo:workspace-hub-toggle", () => { /* rail is persistent — no takeover to toggle */ });
// The shell page reports when the rail expands/collapses (⌘⇧E or the pin) so the review views can be pushed
// right to make room — they can't overlay the shell page, which renders behind them. The width is animated in
// step with the shell's CSS width transition; the active view collapses its own sidebar while pushed.
let railExpanded = false;
let hubAnimTimer: ReturnType<typeof setInterval> | undefined;
// cubic-bezier(.2,.8,.2,1) — the exact easing the review sidebar's grid-template-columns transition uses, so
// the rail push and the file-tree collapse stay in lockstep for one continuous motion.
function easeRail(p: number): number {
  const cx = 3 * 0.2, bx = 3 * (0.2 - 0.2) - cx, ax = 1 - cx - bx;
  const cy = 3 * 0.8, by = 3 * (1 - 0.8) - cy, ay = 1 - cy - by;
  let t = p;
  for (let i = 0; i < 6; i++) {
    const x = ((ax * t + bx) * t + cx) * t - p;
    const d = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(d) < 1e-6) break;
    t -= x / d;
  }
  return ((ay * t + by) * t + cy) * t;
}
function animateHubWidth(target: number): void {
  if (hubAnimTimer) { clearInterval(hubAnimTimer); hubAnimTimer = undefined; }
  const start = hubWidth;
  if (start === target) { hubWidth = target; layoutWorkspaceViews(); return; }
  const t0 = Date.now(), dur = 180;
  hubAnimTimer = setInterval(() => {
    const p = Math.min(1, (Date.now() - t0) / dur);
    hubWidth = Math.round(start + (target - start) * easeRail(p));
    layoutWorkspaceViews();
    if (p >= 1 && hubAnimTimer) { clearInterval(hubAnimTimer); hubAnimTimer = undefined; }
  }, 16);
}
function sendRailPushed(): void {
  const active = activeStateId != null ? states.get(activeStateId) : undefined;
  if (active && !active.win.isDestroyed()) active.win.webContents.send("kakapo:rail-pushed", railExpanded);
}
ipcMain.on("kakapo:hub-expanded", (_event, expanded: unknown) => {
  railExpanded = !!expanded;
  animateHubWidth(railExpanded ? HUB_EXPANDED : HUB_WIDTH);
  sendRailPushed();
  // While expanded, keys belong to the rail so it can be navigated; the moment focus returns to the review view
  // (a click into the "main window"), collapseRailFromReview() pulls it back in.
  if (railExpanded) shellWindow?.webContents.focus();
  else focusActiveReviewView();
});
// The expanded rail is a transient peek. When the user clicks back into the active review view, collapse it —
// visual-only on the shell side (no echo back to main), matching the width animation main runs here.
function collapseRailFromReview(): void {
  if (!railExpanded) return;
  railExpanded = false;
  animateHubWidth(HUB_WIDTH);
  sendRailPushed();
  if (shellWindow && !shellWindow.isDestroyed()) shellWindow.webContents.send("kakapo:hub-set-expanded", false);
}

// The New-workspace / rename / memo dialogs render in a transparent overlay WebContentsView (modalView) that
// is layered above the review views, so the live review content dims behind them rather than blanking. The
// rail asks to open one here; main brings the overlay to the front, shows it, focuses it, and tells its page
// which dialog to open. Keyboard focus is handed to the overlay so Esc/typing reach the dialog.
ipcMain.on("kakapo:hub-open-modal", (_event, payload: unknown) => {
  const view = ensureModalView(isLightTheme());
  if (!view || !shellWindow || shellWindow.isDestroyed()) return;
  modalOpen = true;
  // A review view opened after the overlay would sit on top of it; re-add the overlay to keep it frontmost.
  shellWindow.contentView.removeChildView(view);
  shellWindow.contentView.addChildView(view);
  layoutModalView();
  view.setVisible(true);
  view.webContents.focus();
  if (modalViewReady) view.webContents.send("kakapo:modal-open", payload);
  else pendingModalOpen = payload;
});
ipcMain.on("kakapo:hub-close-modal", () => {
  modalOpen = false;
  pendingModalOpen = null;
  modalView?.setVisible(false);
  focusActiveReviewView();
});

// Keyboard shortcuts live in the review viewer (a WebContentsView). Clicking the shell-page rail moves
// keyboard focus to the shell, where those shortcuts do nothing — so hand focus back to the active review
// view after any rail interaction (and whenever the window is re-activated), unless a modal owns focus.
function focusActiveReviewView(): void {
  if (modalOpen || !shellWindow || shellWindow.isDestroyed()) return;
  const active = activeStateId != null ? states.get(activeStateId) : undefined;
  if (active && !active.win.isDetached() && !active.win.isDestroyed()) active.win.webContents.focus();
}
ipcMain.on("kakapo:hub-refocus", () => focusActiveReviewView());
ipcMain.on("kakapo:hub-activate", (_event, id: unknown) => {
  if (typeof id === "number") activateWorkspace(id);
});
ipcMain.on("kakapo:hub-activate-index", (_event, index: unknown) => {
  if (typeof index !== "number") return;
  const state = Array.from(states.values())[index];
  if (state) activateWorkspace(state.win.webContents.id);
});
ipcMain.on("kakapo:hub-resume", (_event, id: unknown) => {
  if (typeof id !== "number") return;
  const state = states.get(id);
  if (!state?.resumeCommand) return;
  activateWorkspace(id);
  state.win.webContents.send("kakapo:agent-resume", state.resumeCommand);
});
ipcMain.on("kakapo:hub-settings", () => {
  const state = focusedState();
  if (!state) return;
  state.win.webContents.sendInputEvent({ type: "keyDown", keyCode: ",", modifiers: process.platform === "darwin" ? ["meta"] : ["control"] });
  state.win.webContents.sendInputEvent({ type: "keyUp", keyCode: ",", modifiers: process.platform === "darwin" ? ["meta"] : ["control"] });
});
ipcMain.on("kakapo:hub-detach", (_event, id: unknown) => {
  if (typeof id === "number") states.get(id)?.win.detach();
});
ipcMain.handle("kakapo:hub-choose-repo", async () => {
  const repo = await pickRepo(shellWindow, focusedState()?.options.root);
  return repo ? { ok: true, repo } : { ok: false };
});
// The distinct Git projects Kakapo already knows about (open workspaces + saved + recent), deduped by their
// main repo root, so the New-workspace dialog can offer them in a dropdown instead of forcing a folder pick
// every time. `path` is the main repo root — createManagedWorkspace resolves the worktree container from it.
ipcMain.handle("kakapo:hub-projects", () => {
  const seen = new Set<string>();
  const projects: { name: string; path: string }[] = [];
  const add = (candidate: string) => {
    try {
      if (!candidate || !existsSync(candidate) || !isGitRepository(candidate)) return;
      const record = workspaceRecord(candidate);
      if (seen.has(record.repoRoot)) return;
      seen.add(record.repoRoot);
      projects.push({ name: record.repoName, path: record.repoRoot });
    } catch { /* unreadable/removed repo — skip it rather than break the whole list */ }
  };
  for (const state of states.values()) add(state.options.root);
  for (const item of savedWorkspaceMetadata()) add(item.path);
  for (const recent of preferences.readRecentProjects()) add(recent.path);
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
});
// The workspace-tile context menu is a custom design-system component, not the OS native menu. It renders in a
// small frameless, transparent child window at the cursor, so it floats ABOVE the review views (which cover the
// shell page) without blanking the panel — the reason the old in-shell HTML menu couldn't work. The window is
// sized to its content (the page reports its measured size), positioned at the cursor, and dismissed on choose,
// blur, Escape, or a click outside the menu box.
let tileMenuWindow: BrowserWindow | undefined;
let tileMenuTarget: { id: number; name: string } | undefined;
let tileMenuAnchor: { x: number; y: number } | undefined;
let tileMenuShown = false;
function closeTileMenu(): void {
  const win = tileMenuWindow;
  tileMenuWindow = undefined; tileMenuTarget = undefined; tileMenuAnchor = undefined; tileMenuShown = false;
  if (win && !win.isDestroyed()) win.close();
}

ipcMain.on("kakapo:tile-menu", (_event, info: { id?: unknown; name?: unknown; resume?: unknown; kind?: unknown }) => {
  if (!shellWindow || shellWindow.isDestroyed()) return;
  const id = Number(info?.id);
  if (!Number.isFinite(id)) return;
  closeTileMenu();
  tileMenuTarget = { id, name: typeof info?.name === "string" ? info.name : "" };
  tileMenuAnchor = screen.getCursorScreenPoint();
  const win = new BrowserWindow({
    width: 248, height: 220, show: false, frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
    parent: shellWindow, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  tileMenuWindow = win;
  win.on("blur", () => { if (tileMenuWindow === win && tileMenuShown) closeTileMenu(); });
  win.on("closed", () => { if (tileMenuWindow === win) { tileMenuWindow = undefined; tileMenuTarget = undefined; tileMenuAnchor = undefined; tileMenuShown = false; } });
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(tileMenuHtml(Boolean(info?.resume), info?.kind !== "main", isLightTheme())));
});
ipcMain.on("kakapo:menu-size", (event, size: { w?: unknown; h?: unknown }) => {
  const win = tileMenuWindow;
  if (!win || win.isDestroyed() || event.sender !== win.webContents || !tileMenuAnchor) return;
  const w = Math.max(80, Math.min(640, Math.ceil(Number(size?.w) || 248)));
  const h = Math.max(48, Math.min(900, Math.ceil(Number(size?.h) || 220)));
  const wa = screen.getDisplayNearestPoint(tileMenuAnchor).workArea;
  let x = tileMenuAnchor.x - 14, y = tileMenuAnchor.y - 14;
  if (x + w > wa.x + wa.width) x = wa.x + wa.width - w;
  if (y + h > wa.y + wa.height) y = wa.y + wa.height - h;
  x = Math.max(wa.x, x); y = Math.max(wa.y, y);
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  if (!tileMenuShown) { tileMenuShown = true; win.show(); win.focus(); }
});
ipcMain.on("kakapo:menu-choose", (event, action: unknown) => {
  const win = tileMenuWindow;
  if (!win || event.sender !== win.webContents) return;
  const target = tileMenuTarget;
  closeTileMenu();
  if (target && shellWindow && !shellWindow.isDestroyed() && typeof action === "string")
    shellWindow.webContents.send("kakapo:tile-action", { id: target.id, action, name: target.name });
});
ipcMain.on("kakapo:menu-close", (event) => {
  if (tileMenuWindow && event.sender === tileMenuWindow.webContents) closeTileMenu();
});
ipcMain.handle("kakapo:hub-preview", (_event, payload: { repo?: unknown; label?: unknown }) => {
  if (typeof payload?.repo !== "string" || typeof payload?.label !== "string" || !isGitRepository(payload.repo)) return { ok: false };
  const repo = workspaceRecord(payload.repo), slug = workspaceSlug(payload.label);
  return { ok: true, slug, base: defaultBase(repo.repoRoot), branch: `kakapo/${slug}`,
    path: join("~", "kakapo", "workspaces", repo.repoName, slug) };
});
ipcMain.handle("kakapo:hub-create", async (_event, payload: { repo?: unknown; label?: unknown }) => {
  if (typeof payload?.repo !== "string" || typeof payload?.label !== "string") return { ok: false };
  if (workspaceCreation) return { ok: false, error: "A workspace is already being created." };
  workspaceCreation = new AbortController();
  try {
    const created = await createManagedWorkspaceAsync(payload.repo, payload.label, { signal: workspaceCreation.signal });
    const records = savedWorkspaceMetadata().filter((item) => resolveWorkspaceRoot(item.path) !== created.path);
    records.push(created);
    preferences.writeOpenWorkspaces(records, created.path);
    const state = openOrFocusWorkspace(created.path);
    const openTerminal = () => {
      if (state.win.webContents.isDestroyed()) return;
      if (!state.win.webContents.getURL().includes(REVIEW_FILE)) return;
      state.win.webContents.removeListener("did-finish-load", openTerminal);
      state.win.webContents.send("kakapo:terminal-toggle");
    };
    state.win.webContents.on("did-finish-load", openTerminal);
    openTerminal();
    return { ok: true, warning: created.fetchWarning };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    workspaceCreation = undefined;
  }
});
ipcMain.on("kakapo:hub-cancel-create", () => workspaceCreation?.abort());
ipcMain.handle("kakapo:hub-forget", (_event, payload: { path?: unknown }) => {
  if (typeof payload?.path !== "string") return { ok: false };
  const next = savedWorkspaceMetadata().filter((item) => item.path !== payload.path);
  const startupIndex = startupWorkspaceMetadata.findIndex((item) => item.path === payload.path);
  if (startupIndex >= 0) startupWorkspaceMetadata.splice(startupIndex, 1);
  preferences.writeOpenWorkspaces(next, focusedState()?.options.root);
  renderHub();
  return { ok: true };
});
ipcMain.handle("kakapo:hub-reconnect", (_event, payload: { oldPath?: unknown; newPath?: unknown }) => {
  if (typeof payload?.oldPath !== "string" || typeof payload?.newPath !== "string" || !isGitRepository(payload.newPath)) return { ok: false };
  const old = savedWorkspaceMetadata().find((item) => item.path === payload.oldPath);
  const replacement = { ...workspaceRecord(payload.newPath), alias: old?.alias, memo: old?.memo, base: old?.base };
  const next = savedWorkspaceMetadata().filter((item) => item.path !== payload.oldPath);
  const startupIndex = startupWorkspaceMetadata.findIndex((item) => item.path === payload.oldPath);
  if (startupIndex >= 0) startupWorkspaceMetadata.splice(startupIndex, 1);
  next.push(replacement);
  preferences.writeOpenWorkspaces(next, replacement.path);
  openOrFocusWorkspace(replacement.path);
  return { ok: true };
});
ipcMain.handle("kakapo:hub-rename", (_event, payload: { id?: unknown; alias?: unknown; memo?: unknown }) => {
  if (typeof payload?.id !== "number") return { ok: false };
  const state = states.get(payload.id);
  if (!state) return { ok: false };
  const records = preferences.readOpenWorkspaces();
  const record = records.find((item) => resolveWorkspaceRoot(item.path) === resolveWorkspaceRoot(state.options.root));
  if (record && typeof payload.alias === "string") record.alias = payload.alias.trim();
  if (record && typeof payload.memo === "string") record.memo = payload.memo.trim();
  preferences.writeOpenWorkspaces(records, focusedState()?.options.root);
  renderHub();
  return { ok: true };
});
ipcMain.handle("kakapo:hub-remove", (_event, payload: { id?: unknown; mode?: unknown; force?: unknown; deleteBranch?: unknown }) => {
  if (typeof payload?.id !== "number" || (payload.mode !== "close" && payload.mode !== "delete")) return { ok: false };
  const state = states.get(payload.id);
  if (!state) return { ok: false };
  const record = workspaceRecord(state.options.root);
  const metadata = savedWorkspaceMetadata().find((item) => resolveWorkspaceRoot(item.path) === record.path);
  record.base = metadata?.base;
  const risk = removalRisk(record, state.terms.size > 0);
  if (payload.mode === "delete") {
    if (record.kind === "main") return { ok: false, error: "The main checkout can only be closed.", risk };
    if (!payload.force && (risk.dirty || risk.unpushed || risk.runningProcesses)) return { ok: false, needsConfirmation: true, risk };
    for (const term of state.terms.values()) try { term.kill(); } catch {}
    removeManagedWorkspace(record, !!payload.force, !!payload.deleteBranch);
  }
  const metadataIndex = startupWorkspaceMetadata.findIndex((item) => resolveWorkspaceRoot(item.path) === record.path);
  if (metadataIndex >= 0) startupWorkspaceMetadata.splice(metadataIndex, 1);
  state.win.webContents.close();
  const next = Array.from(states.values()).find((item) => item !== state);
  if (next) activateWorkspace(next.win.webContents.id);
  return { ok: true };
});

// The single Markdown memo is application data, never a repository artifact. Main derives the scope from
// the calling window's canonical worktree; the sandboxed renderer cannot choose a filesystem path.
ipcMain.handle("kakapo:memo-read", (event) => {
  const state = stateFromEvent(event);
  return state ? readMemoWithLegacyImport(state.options.root) : { version: 1, worktreePath: "", body: "", updatedAt: null };
});
ipcMain.handle("kakapo:memo-write", (event, input?: { body?: unknown }) => {
  const state = stateFromEvent(event);
  return state ? memoStore().write(state.options.root, input?.body) : null;
});
ipcMain.handle("kakapo:memo-delete", (event) => {
  const state = stateFromEvent(event);
  if (!state) return { ok: false };
  memoStore().remove(state.options.root);
  return { ok: true };
});
// Patch-set compare bar: switch the diff base to a chosen patch set (or "auto" to restore the automatic
// upstream merge-base). Mirrors the "Ignore whitespace" menu toggle — mutate this window's options,
// rebuild, and push the diff in place (like refreshIfChanged) so comments/scroll survive. The right side
// stays the working tree ("latest"); only the base moves, and base already threads through diff/context/
// blame/source, so no other plumbing changes.
ipcMain.handle("kakapo:set-review-base", (event, payload: { ref?: unknown }) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const raw = typeof payload?.ref === "string" ? payload.ref.trim() : "";
  if (!raw) return { ok: false };
  try {
    if (raw === "auto") {
      state.options.base = undefined; // restore the automatic base + upstream watching
    } else {
      // The ref originates from the enumerated patch-set list, but validate before it reaches git diff.
      state.options.base = validateReviewBase(state.options.root, raw);
    }
    state.options.staged = false; // --staged takes precedence over --base in readUnifiedDiff; clear it
    state.lastDiffSig = ""; // re-baseline the watch fast-path against the new base
    const build = writeReviewFile(state);
    state.signature = build.signature;
    if (build.update) state.win.webContents.send("kakapo:diff-update", build.update);
    scheduleAnalysisPrewarm(state);
    return { ok: true, activeBase: state.options.base ?? "auto" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Right/new side of the compare bar: pick a patch set as target B (A→B compare) or the sentinel
// "worktree" to return to base-vs-working-tree. Same rebuild+in-place-update shape as set-review-base;
// the source model then serves commit B's content so comments reconcile against B.
ipcMain.handle("kakapo:set-review-target", (event, payload: { ref?: unknown }) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const raw = typeof payload?.ref === "string" ? payload.ref.trim() : "";
  if (!raw) return { ok: false };
  try {
    if (raw === "worktree") {
      state.options.target = undefined; // compare against the working tree (today's default)
    } else {
      state.options.target = validateReviewBase(state.options.root, raw);
      state.options.staged = false; // an A→B compare has no index side
    }
    state.lastDiffSig = "";
    const build = writeReviewFile(state);
    state.signature = build.signature;
    if (build.update) state.win.webContents.send("kakapo:diff-update", build.update);
    scheduleAnalysisPrewarm(state);
    return { ok: true, activeTarget: state.options.target ?? "worktree" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Validate/clamp the pickable commit list the renderer sends when opening a range from Cmd+9. The SHAs are
// only ever used as dropdown data-refs (re-validated by set-review-compare before any git call); the rest is
// display metadata, so this just rejects junk and bounds sizes.
function sanitizeCompareScope(raw: unknown[]): { sha: string; shortSha: string; subject: string; date: string }[] {
  const out: { sha: string; shortSha: string; subject: string; date: string }[] = [];
  for (const item of raw.slice(0, 500)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const sha = String(record.sha ?? "");
    if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) continue;
    out.push({
      sha,
      shortSha: String(record.shortSha ?? sha.slice(0, 7)).slice(0, 16),
      subject: String(record.subject ?? "").slice(0, 300),
      date: String(record.date ?? "").slice(0, 40),
    });
  }
  return out;
}

// Set both sides at once (base A + target B) in a single rebuild — used by the Cmd+9 history view to open a
// shift-selected commit range in the main review, where the full comment system applies. "auto"/"worktree"
// sentinels reset a side to its default. `scope` (sent when opening a range) is the pickable commit list, so
// the compare bar's dropdowns can then select any B..D within the opened A..F.
ipcMain.handle("kakapo:set-review-compare", (event, payload: { base?: unknown; target?: unknown; scope?: unknown }) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const rawBase = typeof payload?.base === "string" ? payload.base.trim() : "";
  const rawTarget = typeof payload?.target === "string" ? payload.target.trim() : "";
  if (!rawBase || !rawTarget) return { ok: false };
  try {
    if (Array.isArray(payload?.scope)) {
      const scope = sanitizeCompareScope(payload.scope);
      state.compareScope = scope.length ? scope : undefined;
    }
    state.options.base = rawBase === "auto" ? undefined : validateReviewBase(state.options.root, rawBase);
    state.options.target = rawTarget === "worktree" ? undefined : validateReviewBase(state.options.root, rawTarget);
    if (rawBase === "auto" || rawTarget === "worktree") state.compareScope = undefined; // exiting compare clears the scope
    state.options.staged = false;
    state.lastDiffSig = "";
    const build = writeReviewFile(state);
    state.signature = build.signature;
    if (build.update) state.win.webContents.send("kakapo:diff-update", build.update);
    scheduleAnalysisPrewarm(state);
    return { ok: true, activeBase: state.options.base ?? "auto", activeTarget: state.options.target ?? "worktree" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Welcome screen's "Open Folder" button: pick a directory; load it into the window that asked if it's a
// git repo, else return the "not-git" code so the welcome renderer can show its inline hint (it keys off
// r.error === "not-git"). This flow reports errors in-page, so — unlike the File menu — no native box.
ipcMain.handle("kakapo:open-folder", async (event) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const root = await pickDirectory(shellWindow, state.options.root);
  if (!root) return { ok: false };
  if (!isGitRepository(root)) return { ok: false, error: "not-git" };
  await openReview(state, root);
  return { ok: true };
});

// Welcome screen's Recent Projects list: open the clicked path into the calling window. If it's gone or no
// longer a git repo, drop it from the list and tell the renderer (error: "missing") to remove that row.
ipcMain.handle("kakapo:open-recent", async (event, payload: { path?: string }) => {
  const state = stateFromEvent(event);
  const path = typeof payload?.path === "string" ? payload.path : "";
  if (!state || state.win.isDestroyed() || !path) return { ok: false };
  if (!existsSync(path) || !isGitRepository(path)) {
    preferences.forgetRecentProject(path);
    return { ok: false, error: "missing" };
  }
  await openReview(state, path);
  return { ok: true };
});

// Self-update: install the latest published package globally, then relaunch so the updated code loads.
// Runs in the main process because the sandboxed renderer can't spawn npm. Returns {ok:true} (and
// relaunches shortly after) or {ok:false,error} so the renderer can fall back to the manual command.
ipcMain.handle("kakapo:self-update", (event) => new Promise<{ ok: boolean; error?: string }>((resolve) => {
  // Relaunch the freshly-installed `kakapo` in the calling window's repo so the user lands back where they were.
  const cwd = stateFromEvent(event)?.options.root ?? options.root;
  // Async, NOT spawnSync: spawnSync froze the ENTIRE main process for the whole npm install (up to
  // minutes), so the app looked hung and "nothing happened" — even the renderer's "Updating…" couldn't
  // paint and the user saw no restart. Stream it so the UI stays responsive; resolve on close.
  let out = "";
  const attempts = selfUpdateInstallAttempts(process.env, process.platform);
  const runAttempt = (index: number) => {
    const attempt = attempts[index];
    if (!attempt) {
      resolve({ ok: false, error: (out || "npm install failed").trim().slice(-900) });
      return;
    }
    let attemptOut = "";
    let done = false;
    let child: import("node:child_process").ChildProcess;
    const fail = (reason: string) => {
      if (done) return;
      done = true;
      out += `\n[${attempt.label}] ${reason}`;
      if (attemptOut.trim()) out += "\n" + attemptOut.trim();
      runAttempt(index + 1);
    };
    try {
      child = spawn(attempt.command, attempt.args, { shell: attempt.shell, env: process.env });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    child.stdout?.on("data", (d) => { attemptOut += String(d); if (attemptOut.length > 8000) attemptOut = attemptOut.slice(-8000); });
    child.stderr?.on("data", (d) => { attemptOut += String(d); if (attemptOut.length > 8000) attemptOut = attemptOut.slice(-8000); });
    child.on("error", (error) => fail(error instanceof Error ? error.message : String(error)));
    child.on("close", (code) => {
      if (code !== 0) { fail(`exit ${code ?? "unknown"}`); return; }
      if (done) return;
      done = true;
      resolve({ ok: true });
      // The global install replaced our on-disk dist, so THIS process is stale. Use Electron's native relaunch
      // path instead of shelling out to `kakapo`: GUI apps often have a thin PATH, and a detached shell can fail
      // without a reliable event before our exit timer fires.
      setTimeout(() => {
        try {
          relaunchUpdatedApp(app, process.argv, cwd);
        } catch (error) {
          console.error("kakapo: update installed, but relaunch failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }, 250);
    });
  };
  runAttempt(0);
}));

// The renderer uses synchronous IPC for startup settings, while AppPreferences owns persistence and
// global-vs-worktree scoping outside the Electron composition root.
ipcMain.on("kakapo:get-settings", (event) => {
  const state = stateFromEvent(event);
  event.returnValue = state ? preferences.rendererSettings(state.options.root) : preferences.readGlobal();
});
ipcMain.on("kakapo:set-setting", (event, msg: { key?: string; value?: unknown }) => {
  if (!msg || typeof msg.key !== "string") return;
  const state = stateFromEvent(event);
  preferences.setRendererSetting(state?.options.root, msg.key, msg.value);
});
// The merged-prompt dock implements its own whole-document Cmd+A/Cmd+C (select every card + prose region,
// copy the assembled hand-off text — see openMergedView in 08-dock.js). The app menu's `role: "editMenu"`
// (kept so real text fields get native Cut/Paste/Undo) binds the SAME accelerators, and on macOS the menu's
// native Select All/Copy can fire independently of — and race — the page's own keydown handling. While the
// dock signals it owns these keys, ignore the menu's accelerators for its window so only the page's handler
// responds; the dock un-ignores on close so every other Cmd+A/Cmd+C in the app (comment composer, memo,
// terminal) keeps its normal native behavior.
ipcMain.on("kakapo:set-ignore-menu-shortcuts", (event, msg: { ignore?: boolean }) => {
  event.sender.setIgnoreMenuShortcuts(!!(msg && msg.ignore));
});

if (hasSingleInstanceLock) app.on("second-instance", (_event, commandLine, workingDirectory, additionalData) => {
  const handoff = additionalData as { workspaceRoot?: unknown } | undefined;
  const suppliedRoot = handoff && typeof handoff.workspaceRoot === "string"
    ? handoff.workspaceRoot
    : readOption(commandLine, "--cwd") ?? workingDirectory;
  if (!suppliedRoot || !existsSync(suppliedRoot) || !isGitRepository(suppliedRoot)) return;
  openOrFocusWorkspace(resolveWorkspaceRoot(suppliedRoot));
});

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  const assetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "monaco");
  protocol.handle("kakapo-asset", (request) => {
    try {
      const url = new URL(request.url);
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const target = resolve(assetRoot, relativePath);
      const containedPath = relative(assetRoot, target);
      if (!relativePath || containedPath.startsWith("..") || isAbsolute(containedPath)) return new Response("Not found", { status: 404 });
      const extension = target.slice(target.lastIndexOf(".")).toLowerCase();
      const contentType = extension === ".js" ? "text/javascript; charset=utf-8"
        : extension === ".css" ? "text/css; charset=utf-8"
          : extension === ".json" ? "application/json; charset=utf-8"
            : extension === ".ttf" ? "font/ttf"
              : "application/octet-stream";
      return new Response(readFileSync(target), { headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  // Foreground development runs surface this boot log; detached launches drop it. Either way the path
  // disambiguates a local checkout from the installed package.
  console.error(`[kakapo] ${DEV_BUILD ? "DEV build" : "build"} — ${app.getAppPath()} (electron ${process.versions.electron})`);

  buildApplicationMenu();

  const appIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin" && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  // First window uses the CLI-resolved root + flags. The repository stays read-only: each window writes
  // generated review state into its mirrored directory below Electron userData.
  const restored = preferences.readOpenWorkspaces()
    .filter((workspace) => existsSync(workspace.path) && isGitRepository(workspace.path));
  const activePath = preferences.readActiveWorkspace();
  const restoreActive = app.isPackaged && !isGitRepository(options.root) && activePath;
  const requested = createWindow(options.root, !!restoreActive);
  for (const workspace of restored) {
    if (resolveWorkspaceRoot(workspace.path) !== resolveWorkspaceRoot(options.root)) {
      createWindow(workspace.path, !restoreActive || resolveWorkspaceRoot(workspace.path) !== resolveWorkspaceRoot(restoreActive));
    }
  }
  const active = restoreActive && Array.from(states.values()).find(
    (state) => resolveWorkspaceRoot(state.options.root) === resolveWorkspaceRoot(restoreActive),
  );
  if (active && active !== requested) {
    requested.win.hide();
    active.win.show();
    active.win.focus();
  }
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit();
});
else app.quit();

// Each window's "closed" handler clears its timer and deletes its state, so quit once the last window is gone.
app.on("before-quit", (event) => {
  if (quitConfirmed) return;
  const running = Array.from(states.values()).filter((state) => state.terms.size > 0).length;
  if (!running) { quitConfirmed = true; return; }
  event.preventDefault();
  const messageOptions: Electron.MessageBoxSyncOptions = {
    type: "warning",
    title: "Agents are still running",
    message: `${running} workspace${running === 1 ? "" : "s"} still has a running terminal or agent.`,
    detail: "Quitting stops these processes. Resume metadata will be kept when the agent can be identified.",
    buttons: ["Keep Kakapo Open", "Quit and Stop Agents"],
    defaultId: 0,
    cancelId: 0,
  };
  const choice = shellWindow ? dialog.showMessageBoxSync(shellWindow, messageOptions) : dialog.showMessageBoxSync(messageOptions);
  if (choice === 1) { quitConfirmed = true; app.quit(); }
});
app.on("window-all-closed", () => {
  app.quit();
});

// Keep the Ignore-whitespace menu checkbox honest as focus moves between windows (it's per-window state).
app.on("browser-window-focus", (_event, win) => {
  const state = states.get(win.id);
  const item = Menu.getApplicationMenu()?.getMenuItemById("ignore-whitespace");
  if (item && state) item.checked = state.options.ignoreWhitespace;
});

// Build the application menu once. Items act on the focused window (BrowserWindow.getFocusedWindow()),
// so a single global menu drives whichever window is in front.
function buildApplicationMenu(): void {
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") menuTemplate.push({ role: "appMenu" });
  // File menu: open a repo in the current window, or spawn a new window for it.
  menuTemplate.push({
    label: "File",
    submenu: [
      { label: "Open Folder…", accelerator: "CommandOrControl+O", click: () => void openFolderInCurrent() },
      { label: "Open in New Window…", accelerator: "CommandOrControl+Shift+O", click: () => void openFolderInNewWindow() },
    ],
  });
  // Keep the standard Edit/Window roles so Cmd+C/V/X/A (copy comments into prompts) and Cmd+Q work.
  // The in-window menu bar stays hidden on Windows/Linux via autoHideMenuBar; macOS shows it in the top bar.
  menuTemplate.push({ role: "editMenu" });
  menuTemplate.push({
    label: "Workspace",
    submenu: [
      { label: "Switch Workspace", accelerator: "CommandOrControl+K", click: () => {
        // Open the floating quick-switcher inside the active review view (it renders over the diff, so the
        // review stays visible behind it). Focus the view first so its input receives keystrokes.
        const active = activeStateId != null ? states.get(activeStateId) : undefined;
        if (active && !active.win.isDetached() && !active.win.isDestroyed()) {
          active.win.webContents.focus();
          active.win.webContents.send("kakapo:open-quick-switcher");
        }
      } },
      { label: "New Workspace", accelerator: "CommandOrControl+N", click: () => {
        shellWindow?.webContents.send("kakapo:hub-new");
      } },
      { label: "Expand Workspace Rail", accelerator: "CommandOrControl+Shift+E", click: () => {
        shellWindow?.webContents.send("kakapo:hub-toggle-expand");
      } },
      { type: "separator" },
      ...Array.from({ length: 9 }, (_, index): Electron.MenuItemConstructorOptions => ({
        label: `Workspace ${index + 1}`, accelerator: `CommandOrControl+Alt+${index + 1}`, visible: false,
        click: () => { const state = Array.from(states.values())[index]; if (state) activateWorkspace(state.win.webContents.id); },
      })),
    ],
  });
  // Ctrl+Cmd+Shift+/ ("?") opens the merged review-comments view (questions, then change requests).
  // ? is Shift+/ so Shift is part of the combo; Ctrl+Cmd avoids macOS's Cmd+? Help grab.
  menuTemplate.push({
    label: "Review",
    submenu: [
      { label: "All review comments", accelerator: "Control+Command+Shift+/", click: () => sendToFocused("kakapo:merged-view") },
      // Cmd/Ctrl+Shift+N opens (and toggles) the single freeform prompt memo — a Markdown scratchpad.
      { label: "Markdown memo", accelerator: "CommandOrControl+Shift+N", click: () => sendToFocused("kakapo:open-memo") },
      { type: "separator" },
      // Whitespace-ignore re-runs git diff with --ignore-all-space and reloads (main-process action,
      // so a menu checkbox is simpler than a renderer IPC round-trip). Per-window: applies to the focused
      // window only, and browser-window-focus syncs this checkbox to the focused window's state.
      {
        id: "ignore-whitespace",
        label: "Ignore whitespace",
        type: "checkbox",
        checked: options.ignoreWhitespace,
        accelerator: "CommandOrControl+Shift+W",
        click: (item) => {
          const state = focusedState();
          if (!state) return;
          state.options.ignoreWhitespace = item.checked;
          state.signature = writeReviewFile(state).signature;
          state.win.webContents.reloadIgnoringCache();
        },
      },
    ],
  });
  // Terminal toggle/split/pane shortcuts as menu accelerators: Chromium swallows Cmd+D / Ctrl+` before they
  // reach the renderer's keydown, so route them through the app menu to the focused window's terminal client.
  menuTemplate.push({
    label: "Terminal",
    submenu: [
      { label: "Toggle Terminal", accelerator: "Control+`", click: () => sendToFocused("kakapo:terminal-toggle") },
      { label: "Toggle Terminal (F12)", accelerator: "Alt+F12", click: () => sendToFocused("kakapo:terminal-toggle") },
      { label: "Split Terminal", accelerator: "CommandOrControl+D", click: () => sendToFocused("kakapo:terminal-split") },
      { type: "separator" },
      { label: "Focus Previous Pane", accelerator: "CommandOrControl+Alt+Left", click: () => sendToFocused("kakapo:terminal-pane-focus", -1) },
      { label: "Focus Next Pane", accelerator: "CommandOrControl+Alt+Right", click: () => sendToFocused("kakapo:terminal-pane-focus", 1) },
      { label: "Rename Pane", accelerator: "CommandOrControl+Alt+R", click: () => sendToFocused("kakapo:terminal-pane-rename") },
    ],
  });
  // Cmd/Ctrl+W closes the active Files-mode tab (routed to the renderer) instead of the window, matching
  // editor/browser tab behavior. Closing the window stays available via the menu item and Cmd/Ctrl+Q.
  menuTemplate.push({
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { label: "Close Tab", accelerator: "CommandOrControl+W", click: () => sendToFocused("kakapo:close-tab") },
      { label: "Close Window", click: () => BrowserWindow.getFocusedWindow()?.close() },
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

function ensureShellWindow(light: boolean): BrowserWindow {
  if (shellWindow && !shellWindow.isDestroyed()) return shellWindow;
  appQuitting = false; // a fresh shell means we're up-and-running again, not tearing down
  shellWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640, show: false, title: APP_TITLE,
    icon: iconPath, backgroundColor: light ? "#f5f5f5" : "#202124", autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    webPreferences: { preload: hubPreloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  installWindowSurfaceRecovery(shellWindow);
  shellWindow.on("resize", layoutWorkspaceViews);
  // Re-activating the app returns keys to the review viewer — UNLESS the rail is expanded, where keys belong to
  // the rail. Without this guard, focusing the shell to hold rail focus (in the hub-expanded handler) would loop
  // back through here to the review view and instantly collapse the rail via its focus listener.
  shellWindow.on("focus", () => { if (!railExpanded) focusActiveReviewView(); });
  if (DEV_BUILD) shellWindow.webContents.on("console-message", (...args: unknown[]) => {
    const first = args[0] as { message?: string } | undefined;
    console.error(`[hub] ${String(first && typeof first === "object" ? first.message : args[2])}`);
  });
  // "close" fires before the window (and its child review views) are destroyed, so latch the quitting flag
  // here — this is the one point that precedes every view teardown for both Cmd+Q and the shell's red-X.
  shellWindow.on("close", () => { appQuitting = true; });
  shellWindow.on("closed", () => {
    for (const state of states.values()) state.win.webContents.close();
    shellWindow = undefined;
    modalView = undefined; modalViewReady = false; pendingModalOpen = null; modalOpen = false;
  });
  void shellWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(hubHtml(light, APP_VERSION)));
  shellWindow.webContents.on("did-finish-load", renderHub);
  shellWindow.once("ready-to-show", () => shellWindow?.show());
  ensureModalView(light); // preload the (hidden) modal overlay so the first New/rename open has no load delay
  return shellWindow;
}

function layoutWorkspaceViews(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return;
  const [width, height] = shellWindow.getContentSize();
  for (const state of states.values()) {
    if (state.win.isDetached()) continue;
    const view = shellWindow.contentView.children.find(
      (child): child is WebContentsView => child instanceof WebContentsView && child.webContents.id === state.win.webContents.id,
    );
    view?.setBounds({ x: hubWidth, y: TITLEBAR_H, width: Math.max(1, width - hubWidth), height: Math.max(1, height - TITLEBAR_H) });
  }
  layoutModalView();
}

// The transparent overlay that hosts the New-workspace / rename / memo dialogs. Created once per shell window
// and left hidden until a modal opens. Its page background is transparent and the dialogs' ::backdrop is a
// translucent dim, so the live review view shows through dimmed — no snapshot of the content is needed.
function ensureModalView(light: boolean): WebContentsView | undefined {
  if (!shellWindow || shellWindow.isDestroyed()) return undefined;
  if (modalView && !modalView.webContents.isDestroyed()) return modalView;
  const view = new WebContentsView({ webPreferences: {
    preload: hubPreloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  view.setBackgroundColor("#00000000"); // transparent so the review view below shows through the CSS dim
  view.setVisible(false);
  shellWindow.contentView.addChildView(view);
  modalView = view;
  modalViewReady = false;
  view.webContents.on("did-finish-load", () => {
    modalViewReady = true;
    if (pendingModalOpen != null) { view.webContents.send("kakapo:modal-open", pendingModalOpen); pendingModalOpen = null; }
  });
  void view.webContents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(modalOverlayHtml(light)));
  layoutModalView();
  return view;
}

// Cover everything below the title bar (rail + review area) so the whole background dims; the native title
// bar stays uncovered so its traffic lights and window drag keep working while a modal is up.
function layoutModalView(): void {
  if (!shellWindow || shellWindow.isDestroyed() || !modalView || modalView.webContents.isDestroyed()) return;
  const [width, height] = shellWindow.getContentSize();
  modalView.setBounds({ x: 0, y: TITLEBAR_H, width, height: Math.max(1, height - TITLEBAR_H) });
}

function setWorkspaceHubOpen(open: boolean): void {
  hubOpen = open;
  layoutWorkspaceViews();
  shellWindow?.webContents.send("kakapo:hub-toggle", open);
  for (const state of states.values()) {
    if (!state.win.isDestroyed()) state.win.webContents.send("kakapo:workspace-hub-open", open);
  }
  renderHub();
}

function activateWorkspace(id: number): void {
  if (!shellWindow || shellWindow.isDestroyed() || !states.has(id)) return;
  activeStateId = id;
  const activated = states.get(id);
  if (activated) {
    activated.unread = false;
    if (activated.idleTimer) { clearTimeout(activated.idleTimer); activated.idleTimer = undefined; }
    if (activated.analysisSuspended) {
      activated.analysis = new ProjectAnalysis(activated.options.root);
      activated.analysisSuspended = false;
      scheduleAnalysisPrewarm(activated);
      // Rebuilding the review here (writeReviewFile) takes ~1s+ on large repos (6k+ source files), and it ran
      // SYNCHRONOUSLY on the switch — freezing the whole app for ~2s on every switch to an idle workspace. Defer
      // it off the switch path: the view keeps its last-rendered diff, and the refreshed diff/state is pushed a
      // moment later. Skip if the user has already switched away again.
      const target = activated;
      setTimeout(() => {
        if (target.win.isDestroyed() || target.win.webContents.id !== activeStateId) return;
        const rebuilt = writeReviewFile(target);
        target.signature = rebuilt.signature;
        if (rebuilt.update && !target.win.isDestroyed()) target.win.webContents.send("kakapo:diff-update", rebuilt.update);
      }, 0);
    }
    if (!activated.bootStarted) {
      activated.bootStarted = true;
      void bootWindow(activated, isLightTheme());
    }
    if (activated.win.isDetached()) {
      activated.win.focus();
      persistWorkspaceSession(activated.options.root);
      renderHub();
      return;
    }
  }
  const identity = activated && workspaceRecord(activated.options.root);
  if (identity) {
    const metadata = savedWorkspaceMetadata().find((item) => resolveWorkspaceRoot(item.path) === identity.path);
    shellWindow.setTitle(`${metadata?.alias || identity.branch} · ${identity.repoName} — ${APP_TITLE}`);
  }
  for (const state of states.values()) {
    if (state.win.isDetached()) continue;
    const view = shellWindow.contentView.children.find(
      (child): child is WebContentsView => child instanceof WebContentsView && child.webContents.id === state.win.webContents.id,
    );
    view?.setVisible(state.win.webContents.id === id);
    if (state.win.webContents.id !== id) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.idleTimer = setTimeout(() => {
        state.analysis.dispose();
        state.analysisSuspended = true;
        state.sourceFiles.clear();
        state.bodyCache.clear();
      }, 5 * 60_000);
      state.idleTimer.unref?.();
    }
  }
  shellWindow.show();
  shellWindow.focus();
  focusActiveReviewView(); // keyboard belongs to the review viewer, not the rail — this also collapses an
  // expanded rail (the view's focus handler calls collapseRailFromReview), so picking a workspace dismisses the peek.
  persistWorkspaceSession(states.get(id)?.options.root);
  sendRailPushed(); // the newly active view collapses its sidebar too while the rail is expanded
  renderHub();
}

// Push only the per-workspace agent-activity flags (busy spinner + attention dot) to the rail, so the tiles'
// indicators update without a full renderHub — which re-runs `git status` for every workspace and rebuilds the
// rail DOM (dropping hover/focus). The shell toggles CSS classes on the existing tiles from this.
function sendAgentActivity(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return;
  const activity = Array.from(states.values()).map((state) => ({
    id: state.win.webContents.id, busy: state.busy, unread: state.unread, running: state.terms.size > 0,
  }));
  void shellWindow.webContents.send("kakapo:hub-activity", activity);
}
// An output chunk arrived: mark the workspace "working" and (re)arm the idle timer. Only notify the rail on the
// idle->busy edge; while output keeps flowing the timer just resets, so a streaming agent doesn't spam IPC.
function markAgentBusy(state: WinState): void {
  if (state.busyTimer) clearTimeout(state.busyTimer);
  if (!state.busy) { state.busy = true; sendAgentActivity(); }
  state.busyTimer = setTimeout(() => { state.busyTimer = undefined; if (state.busy) { state.busy = false; sendAgentActivity(); } }, 1200);
}
function clearAgentBusy(state: WinState): void {
  if (state.busyTimer) { clearTimeout(state.busyTimer); state.busyTimer = undefined; }
  if (state.busy) { state.busy = false; sendAgentActivity(); }
}

// GitHub project icons: the repo owner's avatar (github.com/<owner>.png) used as the workspace badge so the
// rail reads like GitHub instead of colored initials. Parsed from origin (cached per root), fetched once per
// owner (cached as a data URL). Falls back to the colored initials when there's no GitHub remote or the fetch
// fails (offline / private / unknown user).
const rootOwner = new Map<string, string | null>();
const ownerAvatar = new Map<string, string>();
const ownerAvatarPending = new Set<string>();
function githubOwnerFor(root: string): string | undefined {
  if (rootOwner.has(root)) return rootOwner.get(root) ?? undefined;
  let owner: string | undefined;
  try {
    const url = git(root, ["config", "--get", "remote.origin.url"]).trim();
    const match = url.match(/github\.com[:/]+([^/]+)\/[^/]+/i);
    owner = match ? match[1] : undefined;
  } catch { /* not a git repo / no origin */ }
  rootOwner.set(root, owner ?? null);
  return owner;
}
async function ensureOwnerAvatar(owner: string): Promise<void> {
  if (ownerAvatar.has(owner) || ownerAvatarPending.has(owner)) return;
  ownerAvatarPending.add(owner);
  try {
    const response = await fetch(`https://github.com/${encodeURIComponent(owner)}.png?size=80`, { redirect: "follow" });
    if (response.ok) {
      const type = response.headers.get("content-type") || "image/png";
      const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
      ownerAvatar.set(owner, `data:${type};base64,${base64}`);
      renderHub(); // re-render so the badge swaps from initials to the fetched icon
    }
  } catch { /* offline / no such user — keep the initials fallback */ }
  finally { ownerAvatarPending.delete(owner); }
}

// Git-derived rail tile data (repo record + dirty count), cached per workspace for HUB_TILE_TTL_MS so a burst
// of renderHub calls (agent activity across N workspaces) doesn't re-spawn ~5N git subprocesses. Branch/dirty
// changes surface within the TTL — fine for a rail badge, and freshly-created workspaces have no cache yet.
const HUB_TILE_TTL_MS = 1000;
function hubTileFor(state: WinState): { record: WorkspaceRecord; dirtyCount: number } {
  const now = Date.now();
  if (state.hubTile && now - state.hubTile.computedAt < HUB_TILE_TTL_MS) return state.hubTile;
  const record = workspaceRecord(state.options.root);
  const dirtyCount = git(record.path, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
  state.hubTile = { record, dirtyCount, computedAt: now };
  return state.hubTile;
}

function renderHub(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return;
  const saved = savedWorkspaceMetadata();
  const live = Array.from(states.values()).map((state) => {
    const { record: current, dirtyCount } = hubTileFor(state);
    const metadata = saved.find((item) => resolveWorkspaceRoot(item.path) === current.path);
    const owner = githubOwnerFor(state.options.root);
    const avatar = owner ? ownerAvatar.get(owner) : undefined;
    if (owner && !avatar) void ensureOwnerAvatar(owner);
    return { id: state.win.webContents.id, ...current, alias: metadata?.alias, memo: metadata?.memo,
      base: metadata?.base, fetchWarning: metadata?.fetchWarning, openedAt: metadata?.openedAt, dirtyCount, avatar,
      active: state.win.webContents.id === activeStateId, running: state.terms.size > 0,
      resume: state.resumeCommand, unread: state.unread, busy: state.busy, detached: state.win.isDetached() };
  });
  const disconnected = saved.filter((item) => !existsSync(item.path)).map((item, index) => ({
    ...item, id: -(index + 1), active: false, running: false, unread: false, busy: false, disconnected: true,
  }));
  const workspaces = [...live, ...disconnected];
  void shellWindow.webContents.send("kakapo:hub-state", workspaces);
  for (const state of states.values()) {
    if (state.win.isDestroyed()) continue;
    state.win.webContents.send("kakapo:workspace-state", {
      items: workspaces,
      currentId: state.win.webContents.id,
      // The rail never hijacks the review's own Changes/Files sidebar, so the viewer must never enter the
      // hub-open state that hides it. The rail's own visibility is owned entirely by the shell page.
      open: false,
    });
  }
}



// Create a window for `root`, register its WinState, wire teardown, and boot it (animated mark ->
// first build, or the welcome screen for a packaged launch with no repo).
function createWindow(root: string, deferBoot = false): WinState {
  const themeLight = isLightTheme();
  const host = ensureShellWindow(themeLight);
  const view = new WebContentsView({ webPreferences: {
    preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
  } });
  host.contentView.addChildView(view);
  view.setVisible(false);
  // Clicking into the active review view returns focus to the "main window" — collapse an expanded rail so its
  // peek dismisses. Only the active (visible) view can receive a user click, so this never fires for a background one.
  view.webContents.on("focus", () => { if (view.webContents.id === activeStateId) collapseRailFromReview(); });
  layoutWorkspaceViews();
  let surfaceHost = host;
  let detachedHost: BrowserWindow | undefined;
  const win: ReviewSurface = {
    webContents: view.webContents,
    isDestroyed: () => view.webContents.isDestroyed(),
    isMinimized: () => surfaceHost.isMinimized(),
    restore: () => surfaceHost.restore(),
    show: () => detachedHost ? win.focus() : activateWorkspace(view.webContents.id),
    hide: () => view.setVisible(false),
    focus: () => { surfaceHost.show(); surfaceHost.focus(); },
    loadURL: (url) => view.webContents.loadURL(url),
    loadFile: (path) => view.webContents.loadFile(path),
    isDetached: () => !!detachedHost && !detachedHost.isDestroyed(),
    detach: () => {
      if (detachedHost && !detachedHost.isDestroyed()) {
        detachedHost.show();
        detachedHost.focus();
        return;
      }
      host.contentView.removeChildView(view);
      detachedHost = new BrowserWindow({
        width: 1180, height: 820, minWidth: 720, minHeight: 480, show: false,
        title: `${workspaceRecord(root).branch} — ${APP_TITLE}`,
        icon: iconPath, backgroundColor: themeLight ? "#f5f5f5" : "#202124", autoHideMenuBar: true,
      });
      surfaceHost = detachedHost;
      detachedHost.contentView.addChildView(view);
      const fitDetachedView = () => {
        if (!detachedHost || detachedHost.isDestroyed()) return;
        const [width, height] = detachedHost.getContentSize();
        view.setBounds({ x: 0, y: 0, width, height });
      };
      detachedHost.on("resize", fitDetachedView);
      detachedHost.on("closed", () => {
        detachedHost = undefined;
        if (!view.webContents.isDestroyed()) view.webContents.close();
      });
      fitDetachedView();
      view.setVisible(true);
      detachedHost.show();
      detachedHost.focus();
      renderHub();
    },
  };
  const resolvedRoot = resolve(root);
  const perf = new ReviewPerformanceTrace(resolvedRoot, app.getPath("userData"));
  perf.mark("window-created");
  let state!: WinState;
  const analysis = new ProjectAnalysis(resolvedRoot, {
    onStatus: (status) => {
      if (!state || state.win.isDestroyed()) return;
      state.win.webContents.send("kakapo:analysis-status", status);
      state.perf.mark("analysis-status", {
        generation: status.generation,
        phase: status.phase,
        server: status.server ?? "",
        source: status.serverSource ?? "",
      });
    },
  });
  state = {
    win,
    options: makeOptions(root),
    signature: "",
    refreshing: false,
    bodyDiffs: [],
    bodyCache: new Map(),
    sourceFiles: new Map(),
    analysis,
    analysisSuspended: false,
    terms: new Map(),
    commandBuffers: new Map(),
    resumeCommand: typeof preferences.readWorkspace(resolvedRoot)["kakapo-agent-resume"] === "string"
      ? preferences.readWorkspace(resolvedRoot)["kakapo-agent-resume"] as string : undefined,
    onResumeCommand: (command) => {
      state.resumeCommand = command;
      preferences.setRendererSetting(state.options.root, "kakapo-agent-resume", command);
      renderHub();
    },
    onAgentFinished: () => {
      if (state.busyTimer) { clearTimeout(state.busyTimer); state.busyTimer = undefined; }
      state.busy = false;
      state.unread = state.win.webContents.id !== activeStateId;
      renderHub();
    },
    onAgentOutput: () => markAgentBusy(state),
    onAgentBell: () => {
      if (state.busyTimer) { clearTimeout(state.busyTimer); state.busyTimer = undefined; }
      state.busy = false;
      if (state.win.webContents.id !== activeStateId) state.unread = true;
      sendAgentActivity();
    },
    unread: false,
    busy: false,
    bootStarted: false,
    perf,
    lastDiffSig: "",
    reviewBase: undefined,
    reviewUpstream: undefined,
    disposeWindowSurfaceRecovery: () => {},
    explainSig: "",
    explainSpec: null,
    explainUpdatedAt: null,
  };
  const id = view.webContents.id;
  states.set(id, state);
  layoutWorkspaceViews();
  persistWorkspaceSession(resolvedRoot);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Dev-only: surface renderer console output in the terminal that launched `npm run dev`, so viewer-side
  // logs/errors are visible without opening DevTools.
  if (DEV_BUILD) {
    win.webContents.on("console-message", (...args: unknown[]) => {
      // Electron 36+ passes a single details object ({ message, level, ... }); older builds passed
      // positional (event, level, message). Handle both so the dev log works across versions.
      const first = args[0] as { message?: string; level?: unknown } | undefined;
      const message = first && typeof first === "object" && "message" in first ? first.message : args[2];
      process.stdout.write(`[renderer] ${String(message)}\n`);
    });
  }
  win.webContents.on("did-finish-load", () => {
    const url = win.webContents.getURL();
    const document = url.startsWith("data:") ? "loading" : url.includes(REVIEW_FILE) ? "review" : "welcome";
    state.perf.mark("document-loaded", { document });
    scheduleAnalysisPrewarm(state);
  });
  view.webContents.once("did-finish-load", () => {
    if (activeStateId === undefined) activateWorkspace(id);
    // The hub may already be open while this review document is loading. Re-broadcast after the
    // renderer has installed its listener so it cannot retain a hidden sidebar's empty grid column.
    renderHub();
    if (DEV_BUILD) state.win.webContents.openDevTools({ mode: "detach" });
  });
  view.webContents.on("destroyed", () => {
    for (const t of state.terms.values()) { try { t.kill(); } catch { /* already exited */ } }
    state.terms.clear();
    state.commandBuffers.clear();
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    if (state.answersTimer) clearInterval(state.answersTimer);
    if (state.explainTimer) clearInterval(state.explainTimer);
    if (state.analysisWarmTimer) clearTimeout(state.analysisWarmTimer);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.analysis.dispose();
    states.delete(id);
    if (!appQuitting) persistWorkspaceSession(); // don't let shutdown teardown erase the restore session
    renderHub();
  });

  if (!deferBoot) { state.bootStarted = true; void bootWindow(state, themeLight); }
  return state;
}

// A second CLI launch joins this app process. Duplicate launches (including launches from nested
// directories) focus the existing workspace; a different worktree gets its own isolated window/state
// inside the same Electron instance until the hub view replaces this presentation layer.
function openOrFocusWorkspace(root: string): WinState {
  const canonicalRoot = resolveWorkspaceRoot(root);
  const existing = Array.from(states.values()).find(
    (state) => resolveWorkspaceRoot(state.options.root) === canonicalRoot,
  );
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.show();
    existing.win.focus();
    persistWorkspaceSession(canonicalRoot);
    return existing;
  }
  const created = createWindow(canonicalRoot);
  created.win.show();
  created.win.focus();
  return created;
}

function persistWorkspaceSession(activeRoot?: string): void {
  const saved = savedWorkspaceMetadata();
  const records: import("./workspaces.js").WorkspaceRecord[] = Array.from(states.values())
    .filter((state) => !state.win.isDestroyed() && isGitRepository(state.options.root))
    .map((state) => {
      const current = workspaceRecord(state.options.root, Date.now());
      const prior = saved.find((item) => resolveWorkspaceRoot(item.path) === current.path);
      return { ...current, alias: prior?.alias, memo: prior?.memo, base: prior?.base, fetchWarning: prior?.fetchWarning };
    });
  records.push(...saved.filter((item) => !existsSync(item.path)));
  const active = activeRoot ?? focusedState()?.options.root ?? preferences.readActiveWorkspace();
  preferences.writeOpenWorkspaces(records, active);
}

function savedWorkspaceMetadata() {
  const saved = [...preferences.readOpenWorkspaces()];
  for (const item of startupWorkspaceMetadata) {
    if (!saved.some((entry) => resolveWorkspaceRoot(entry.path) === resolveWorkspaceRoot(item.path))) saved.push(item);
  }
  return saved;
}

// Paint the animated mark immediately, then build the (potentially heavy) review off the first paint and swap it
// in. Building before the window exists left the screen blank for the first few seconds of startup.
async function bootWindow(state: WinState, themeLight: boolean): Promise<void> {
  await state.win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(loadingHtml(themeLight)));
  state.perf.mark("spinner-loaded"); // stable trace key retained for existing performance histories
  // Give the mark a few frames to paint before the (synchronous) first build blocks the main process —
  // otherwise the animation looks frozen until the build finishes. The boot overlay in the review HTML then
  // takes over, so there's no blank gap when loadFile swaps the page in.
  setTimeout(async () => {
    // Bail if the window was closed during the spinner delay — its closed handler already tore down state,
    // so building/loading here is wasted and (critically) arming the watch timer below would re-create an
    // interval that nothing will ever clear, leaking it and pinning the deleted WinState.
    if (state.win.isDestroyed()) return;
    try {
      // A packaged .app (double-clicked) can launch with no useful cwd repo. Show the welcome screen
      // (an Open Folder button) instead of an empty diff. New windows always get a validated repo.
      if (app.isPackaged && !isGitRepository(state.options.root)) { void showWelcome(state); return; }
      state.answersFile = answersFilePath(state.options.root);
      const firstBuild = writeReviewFile(state);
      state.signature = firstBuild.signature;
      preferences.recordRecentProject(state.options.root); // remember the launched/new-window repo for the welcome screen
      if (!state.win.isDestroyed()) {
        await state.win.loadFile(reviewPath(state.options.root));
        // ⌘0/⌘1 (and the other in-view shortcuts) are renderer keydown handlers, so they only fire while the
        // review view holds keyboard focus. loadFile swaps the page out from under the focus set during
        // activateWorkspace, leaving the freshly-painted review looking ready but ignoring its own shortcuts
        // for the first few seconds until the user clicks into it. Re-focus once the review is on screen.
        if (!state.win.isDestroyed() && state.win.webContents.id === activeStateId) focusActiveReviewView();
      }
      if (state.options.watch) state.refreshTimer = setInterval(() => void refreshIfChanged(state), WATCH_INTERVAL_MS);
      // Independent of --watch: an agent can write answers/the Explain content spec whether or not the
      // diff itself is being polled. One immediate answers sync catches up on anything written before this
      // window existed (the Explain spec has no such backlog concern — nothing could have targeted this
      // window's spec file before it existed).
      state.answersTimer = setInterval(() => void syncAnswersFile(state), WATCH_INTERVAL_MS);
      void syncAnswersFile(state);
      state.explainTimer = setInterval(() => refreshExplainIfChanged(state), WATCH_INTERVAL_MS);
    } catch (error) {
      // One window's build failure shouldn't take down the whole app (other windows may be fine); log and
      // leave this window on the loading mark rather than quitting.
      console.error(error instanceof Error ? error.message : String(error));
    }
  }, 60);
}

async function refreshIfChanged(state: WinState): Promise<void> {
  if (state.refreshing || state.win.isDestroyed()) return;
  state.refreshing = true;
  try {
    // Fast path: the review-workspace service hashes only the Git diff before a full rebuild. Most watch
    // ticks see no change, leaving this Electron orchestrator free to serve navigation/search IPC.
    const diffSig = reviewDiffSignature(state.options, state.reviewBase, state.reviewUpstream);
    // The first watch tick seeds the baseline for the review boot/openReview just built; without it an
    // unchanged repository would rebuild ~1s after first paint, exactly as the reviewer starts interacting.
    const decision = decideWatchTick(state.lastDiffSig, diffSig);
    if (decision.action === "seed") { state.lastDiffSig = decision.diffSig; return; }
    if (decision.action === "skip") return;
    state.lastDiffSig = decision.diffSig;
    const next = writeReviewFile(state);
    if (shouldPushUpdate(state.signature, next.signature)) {
      state.signature = next.signature;
      // Refresh the diff in place instead of reloading the window so review context remains stable. Send
      // only the compact update payload; the renderer transplants it and re-fetches per-file bodies/source
      // over the existing IPC (state.bodyDiffs/state.sourceFiles were refreshed by writeReviewFile above).
      if (next.update) state.win.webContents.send("kakapo:diff-update", next.update);
      scheduleAnalysisPrewarm(state);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    state.refreshing = false;
  }
}

function writeReviewFile(state: WinState): { signature: string; html: string; update?: import("./types.js").DiffReviewUpdate } {
  const started = performance.now();
  state.perf.mark("review-build-start");
  const build = writeReviewWorkspace(reviewPath(state.options.root), state.options, APP_TITLE);
  state.reviewBase = build.reviewBase;
  state.reviewTarget = build.reviewTarget;
  state.reviewUpstream = build.reviewUpstream;
  // The review artifact mirrors the workspace's absolute folder structure below userData. Different
  // repositories, nested monorepo packages, and worktrees therefore never share a file or touch source.
  state.bodyDiffs = build.bodyDiffs;
  state.bodyCache.clear();
  // Retain native records from the workspace snapshot instead of serializing and parsing the whole project
  // index (which can approach the source budget on large repositories).
  state.sourceFiles = new Map(build.sourceFiles.map((file) => [file.path, file]));
  state.analysis.invalidate();
  state.perf.mark("review-build-complete", {
    durationMs: Math.round((performance.now() - started) * 10) / 10,
    sourceFiles: state.sourceFiles.size,
    diffBodies: state.bodyDiffs.length,
  });
  return { signature: build.signature, html: build.html, update: build.update };
}

function scheduleAnalysisPrewarm(state: WinState): void {
  if (state.analysisWarmTimer) clearTimeout(state.analysisWarmTimer);
  const paths = Array.from(state.sourceFiles.values())
    .filter((file) => file.changed && !file.skippedReason)
    .map((file) => file.path)
    .slice(0, 500);
  if (!paths.length || state.win.isDestroyed()) return;
  const analysis = state.analysis;
  state.analysisWarmTimer = setTimeout(() => {
    state.analysisWarmTimer = undefined;
    if (state.win.isDestroyed() || state.analysis !== analysis) return;
    void analysis.prewarm(paths);
  }, ANALYSIS_PREWARM_DELAY_MS);
  state.analysisWarmTimer.unref?.();
}

function reviewPath(root: string): string {
  return workspaceReviewFile(app.getPath("userData"), root);
}

// Welcome screen for the packaged .app (double-clicked, no cwd repo). Written to userData (we can't write
// the review file under "/") and loaded so preload exposes window.kakapoApp.openFolder to its button.
async function showWelcome(state: WinState): Promise<void> {
  if (state.win.isDestroyed()) return;
  const welcomePath = join(app.getPath("userData"), "welcome.html");
  mkdirSync(dirname(welcomePath), { recursive: true });
  const recent = preferences.readRecentProjects().filter((p) => existsSync(p.path)); // hide entries whose folder is gone
  writeFileSync(welcomePath, renderWelcomeHtml(isLightTheme(), recent));
  await state.win.loadFile(welcomePath);
}

// Load a chosen git repo into an existing window — the welcome screen's folder picker, or File > Open
// Folder. Repoints the window's root, (re)writes the review, swaps the page, and re-arms its watch timer.
// No process.chdir: root is threaded through writeReviewFile/refreshIfChanged per window.
async function openReview(state: WinState, root: string): Promise<void> {
  if (state.analysisWarmTimer) { clearTimeout(state.analysisWarmTimer); state.analysisWarmTimer = undefined; }
  state.analysis.dispose();
  state.options.root = resolve(root);
  state.perf = new ReviewPerformanceTrace(state.options.root, app.getPath("userData"));
  state.perf.mark("review-opened");
  state.analysis = new ProjectAnalysis(state.options.root, {
    onStatus: (status) => {
      if (state.win.isDestroyed()) return;
      state.win.webContents.send("kakapo:analysis-status", status);
      state.perf.mark("analysis-status", {
        generation: status.generation,
        phase: status.phase,
        server: status.server ?? "",
        source: status.serverSource ?? "",
      });
    },
  });
  preferences.recordRecentProject(state.options.root); // remember it for the welcome screen's Recent Projects
  state.lastDiffSig = ""; // new repo -> force the next watch tick to rebuild
  if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = undefined; }
  if (state.answersTimer) { clearInterval(state.answersTimer); state.answersTimer = undefined; }
  state.answersFile = answersFilePath(state.options.root);
  state.answersFileSig = undefined;
  state.lastAnswers = undefined;
  state.explainSig = ""; // new repo -> different workspace's spec file, force a fresh read
  state.explainSpec = null;
  state.explainUpdatedAt = null;
  if (state.explainTimer) { clearInterval(state.explainTimer); state.explainTimer = undefined; }
  const build = writeReviewFile(state);
  state.signature = build.signature;
  if (!state.win.isDestroyed()) await state.win.loadFile(reviewPath(state.options.root));
  if (state.options.watch) state.refreshTimer = setInterval(() => void refreshIfChanged(state), WATCH_INTERVAL_MS);
  state.answersTimer = setInterval(() => void syncAnswersFile(state), WATCH_INTERVAL_MS);
  void syncAnswersFile(state);
  state.explainTimer = setInterval(() => refreshExplainIfChanged(state), WATCH_INTERVAL_MS);
}

// File > Open Folder (Cmd/Ctrl+O): pick a repo and load it into the focused window.
async function openFolderInCurrent(): Promise<void> {
  const state = focusedState();
  if (!state) return;
  const root = await pickRepo(shellWindow, state.options.root);
  if (root) await openReview(state, root);
}
// File > Open in New Window (Cmd/Ctrl+Shift+O): pick a repo and open it in a brand-new window.
async function openFolderInNewWindow(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const root = await pickRepo(parent, focusedState()?.options.root);
  if (root) createWindow(root);
}
// Shared directory picker — just the dialog; returns the chosen path or undefined if canceled. Callers
// validate (the welcome flow reports not-git in-page; the File menu shows a native box via pickRepo).
async function pickDirectory(parent: BrowserWindow | undefined, defaultPath?: string): Promise<string | undefined> {
  const dialogOptions: Electron.OpenDialogOptions = {
    properties: ["openDirectory"],
    title: "Open a Git repository",
    ...(defaultPath ? { defaultPath } : {}),
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  return result.canceled ? undefined : (result.filePaths[0] || undefined);
}

// File-menu picker: a directory that's a validated git repo, or undefined (canceled, or not-git with a
// native error box). Used by Open Folder / Open in New Window, which have no in-page error surface.
async function pickRepo(parent: BrowserWindow | undefined, defaultPath?: string): Promise<string | undefined> {
  const root = await pickDirectory(parent, defaultPath);
  if (!root) return undefined;
  if (!isGitRepository(root)) {
    dialog.showErrorBox("Not a Git repository", `${root} is not a Git repository.`);
    return undefined;
  }
  return resolveWorkspaceRoot(root);
}

// Clone the CLI-resolved flags for a new window, overriding only the repo root. root + ignoreWhitespace are
// then mutated per window without affecting other windows or the template.
function makeOptions(root: string): AppOptions {
  return { ...options, root: resolveWorkspaceRoot(root) };
}

function parseArgs(args: string[]): AppOptions {
  const parsed = parseReviewArgs(args); // pure flag parsing; this function adds the git-dependent resolution
  const requestedRoot = resolve(parsed.requestedCwd ?? process.cwd());
  const root = isGitRepository(requestedRoot) ? resolveWorkspaceRoot(requestedRoot) : requestedRoot;
  // Default (neither flag): diff the working tree against an automatic base — the upstream merge-base when the
  // branch has unpushed commits, otherwise HEAD. --base <ref> reviews the working tree against any branch/tag/
  // commit (e.g. the whole AI feature branch: --base main). --staged reviews the index against HEAD.
  const base = parsed.baseValue !== undefined && isGitRepository(root)
    ? validateReviewBase(root, parsed.baseValue)
    : parsed.baseValue;
  return {
    root,
    base,
    staged: parsed.staged,
    includeUntracked: parsed.includeUntracked,
    context: parsed.context,
    watch: parsed.watch,
    ignoreWhitespace: parsed.ignoreWhitespace,
  };
}
