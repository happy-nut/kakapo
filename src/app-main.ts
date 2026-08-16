import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell, WebContentsView } from "electron";
import type { WebContents } from "electron";
import { git, gitAsync, isCommitSha, isGitRepository, resolveWorkspaceRoot, validateReviewBase } from "./git.js";
import { renderWelcomeHtml } from "./render.js";
import { makeTranslator, normalizeLocale, type Locale } from "./i18n.js";
import { relaunchUpdatedApp, selfUpdateInstallAttempts } from "./self-update.js";
import { bundlePathFor, installPackagedUpdate, isNewerVersion, macDmgAsset } from "./app-update.js";
import { ProjectAnalysis } from "./analysis.js";
import { ReviewPerformanceTrace } from "./perf.js";
import { ProjectMarkdownMemo } from "./memos.js";
import type { SourceFile } from "./types.js";
import { workspaceReviewFile } from "./workspace-data.js";
import { kakapoIconCssVariable, kakapoIconHtml } from "./brand.js";
import { reviewDiffSignature } from "./review-workspace.js";
import { ReviewBuilder, type BuildSnapshot } from "./review-builder.js";
import { decideWatchTick, shouldPushUpdate } from "./watch-decision.js";
import { parseReviewArgs, readOption } from "./cli-args.js";
import { easeRail } from "./rail-animation.js";
import { errorMessage, githubOwnerFromUrl, tmuxSessionsForRoot } from "./util.js";
import { AppPreferences } from "./app-preferences.js";
import { registerReviewIpc } from "./app-review-ipc.js";
import { registerSettingsIpc } from "./app-settings-ipc.js";
import { registerMemoIpc } from "./app-memo-ipc.js";
import { registerProjectPathIpc } from "./app-path-ipc.js";
import { registerTerminalIpc, ptyReaper, killWorkspaceTerminals, resolveTmux } from "./app-terminal-ipc.js";
import { registerCommentsIpc, syncCommentsFile, commentsFilePath, knowledgeFilePath } from "./comments-file.js";
import { registerTileMenuIpc } from "./app-tile-menu-ipc.js";
import type { IPty } from "node-pty";
import { installWindowSurfaceRecovery } from "./window-layout.js";
import { HUB_WIDTH, HUB_EXPANDED, TITLEBAR_H } from "./constants.js";
import { collectUsageStats } from "./usage-stats.js";
import { agentForCommand, type AgentKind } from "./agent-resume.js";
import { hubHtml, modalOverlayHtml } from "./shell-pages.js";
import { aheadArgs, aheadCount, createManagedWorkspaceAsync, defaultBase, listStartRefs, randomWorkspaceSlug, removalRisk, removeManagedWorkspace, workspaceRecord, workspaceSlug, type WorkspaceRecord } from "./workspaces.js";

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
  // The review conversation (see comments-file.ts): this window's comments.jsonl path, the last-seen
  // mtime+size, and the poll timer that picks up whatever an agent appended — all independent of --watch.
  commentsFile?: string;
  commentsSig?: string;
  // The repository-shared notes file (knowledgeFilePath): what the agent has learned outlives the worktree it
  // was learned in, so it does not live beside this workspace's conversation.
  knowledgeFile?: string;
  knowledgeSig?: string;
  commentsTimer?: NodeJS.Timeout;
  bodyDiffs: string[]; // Phase 2 lazy-LOAD: raw per-file diffs rendered for THIS window's renderer on demand
  bodyCache: Map<number, string>; // rendered per-file diff bodies, scoped to the current build
  sourceFiles: Map<string, SourceFile>; // source content stays in main; renderer requests one open file at a time
  analysis: ProjectAnalysis; // LSP-first project analysis + main-process regex fallback
  analysisSuspended: boolean;
  // The idle timer dropped this workspace's caches (main) and its diff DOM (renderer). Cleared once the
  // rebuild on the way back in has repainted the view; until then every activation retries.
  viewReleased: boolean;
  idleTimer?: NodeJS.Timeout;
  terms: Map<number, IPty>; // integrated-terminal ptys owned by this window (killed on close)
  termSessions: Map<number, string>; // pty id -> tmux session, for panes opted into persistent terminals
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
  hubTile?: { record: WorkspaceRecord; dirtyCount: number; ahead: number; base?: string; computedAt: number };
  bootStarted: boolean;
  // Set when activateWorkspace focuses this view while it is still loading, so the "content is ready" hook
  // can hand it the keyboard. Consumed once.
  wantsFocusOnReady?: boolean;
  perf: ReviewPerformanceTrace; // local startup/analysis evidence under this workspace's app-data mirror
  lastDiffSig: string; // watch fast-path: hash of the last git diff, to skip rebuilds when unchanged
  reviewBase?: string; // exact base used by the latest build (may be an automatic upstream merge-base)
  reviewTarget?: string; // exact right/new side revision for an A→B compare (undefined = working tree)
  // Commits of the range opened from the Cmd+9 history (oldest→newest). While set, the compare bar's two
  // dropdowns pick base/target from THIS list, so B..D within an opened A..F is selectable. Cleared on exit.
  compareScope?: { sha: string; shortSha: string; subject: string; date: string }[];
  reviewUpstream?: string; // tracking ref behind an automatic base; included in the watch signature
  // Diff-first startup: the first paint indexed ONLY the changed files; the full project index is still owed
  // and built on demand (ensureFullIndex) the first time the renderer pulls it. Cleared once the full index
  // lands — here, or via any watch rebuild (which always builds full).
  fullIndexPending?: boolean;
  ensureFullIndex?: () => Promise<void>; // materialize the deferred full project index into sourceFiles, once
  fullIndexInFlight?: Promise<void>; // dedups concurrent project-index pulls onto one worker build
  // Monotonic per-window build counter. Every build off the worker stamps its request; when the result
  // returns, a stale stamp (a newer build was requested, or the window closed) means the result is dropped.
  buildSeq: number;
  disposeWindowSurfaceRecovery: () => void;
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
// How long a workspace must stay hidden before its language servers are shut down. Resuming pays the full
// cold start again (the bundled Kotlin server alone allocates well over a gigabyte on every restart), so a
// short timer turns ordinary back-and-forth switching into pure churn: it costs more than the RSS it frees.
// Long enough that only a genuinely parked workspace is reclaimed. See issue #24.
const ANALYSIS_IDLE_SUSPEND_MS = 30 * 60_000;

// Painted immediately while the first review build + HTML render run, so startup shows the Kakapo mark
// of a blank window. Inlined as a data: URL so it needs no file on disk and appears before any review
// work. Theme-aware so a light-theme user doesn't get a dark flash before the renderer applies the theme.
// `compact` halves the mark for every window after the first. Opening the app is a moment worth branding;
// opening the fifth workspace of the session is not, and a 72px bird flashing on each one reads as noise.
function loadingHtml(light: boolean, compact = false): string {
  const bg = light ? "#ffffff" : "#2b2b2b";
  const fg = light ? "#6e7781" : "#9aa4af";
  const mark = kakapoIconHtml("kakapo-mark");
  const box = compact ? 36 : 72;
  const glyph = compact ? 32 : 64;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{${kakapoIconCssVariable()}}
  html,body{margin:0;height:100vh;background:${bg};color:${fg};display:flex;flex-direction:column;
    align-items:center;justify-content:center;
    font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .kakapo-loader{display:grid;place-items:center;width:${box}px;height:${box}px;filter:drop-shadow(0 9px 15px rgba(0,0,0,.2))}
  .kakapo-mark{display:block;width:${glyph}px;height:${glyph}px;background:var(--kakapo-ui-icon) center/contain no-repeat;
    animation:kakapo-peck 1.05s cubic-bezier(.45,0,.25,1) infinite;transform-origin:52% 72%}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  @keyframes kakapo-peck{0%,100%{transform:translateY(0) rotate(0);opacity:.9}38%{transform:translateY(-3px) rotate(-3deg);opacity:1}62%{transform:translateY(1px) rotate(2deg)}}
  @media(prefers-reduced-motion:reduce){.kakapo-mark{animation:kakapo-breathe 1.6s ease-in-out infinite}@keyframes kakapo-breathe{50%{opacity:.65}}}
</style></head><body><span class="kakapo-loader" role="status" aria-label="Kakapo is loading">${mark}<span class="sr-only">Kakapo is loading</span></span></body></html>`;
}
// The persisted theme PREFERENCE (set by the renderer via kakapoSettings): 'system' follows the OS, 'light'/'dark'
// pin it. Defaults to 'system'. Mirrored into nativeTheme.themeSource (see syncNativeThemeSource) so the native
// window chrome (traffic lights, menus) and prefers-color-scheme both track the choice.
type ThemePreference = "system" | "light" | "dark";
function themePreference(): ThemePreference {
  try {
    const value = preferences.readGlobal()["kakapo-theme"];
    // Default dark (as before System existed), so users who never set a theme keep the UI they had.
    return value === "light" || value === "dark" || value === "system" ? value : "dark";
  } catch {
    return "dark";
  }
}
// The resolved light/dark used by the loading screen, window backgrounds, hub, and welcome page. 'system' resolves
// against nativeTheme.shouldUseDarkColors, which itself tracks themeSource + the OS.
function isLightTheme(): boolean {
  const preference = themePreference();
  if (preference === "system") return !nativeTheme.shouldUseDarkColors;
  return preference === "light";
}
function syncNativeThemeSource(): void {
  try { nativeTheme.themeSource = themePreference(); } catch { /* best-effort */ }
}
// The active UI locale + a translator bound to it, for the native menu, native dialogs, the workspace rail, and
// the welcome screen — every user-visible string the main process renders itself rather than the viewer's data-i18n.
function currentLocale(): Locale {
  try { return normalizeLocale(preferences.readGlobal()["kakapo-locale"]); } catch { return "en"; }
}
function tr(): (key: string, vars?: Record<string, string | number>) => string {
  return makeTranslator(currentLocale());
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
// macOS has no window icons, and it reads the app icon off the bundle — the packaged one from Info.plist, the
// dev one from the electron.icns that the postinstall branding step overwrites with ours. Handing Electron the
// 1024² PNG on top of that only decoded bitmaps into the main process and left them there: measured +33.5 MB
// for dock.setIcon, +14.3 MB for the first window's `icon:`, +5.2 MB per window after that, which is most of
// the 64 MB of CG image this process was holding. Everywhere else it IS the window/taskbar icon, so it stays.
const windowIcon = process.platform === "darwin" ? undefined : iconPath;
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
// Every review build runs in this one worker thread, so a rebuild never blocks the main loop's IPC/terminal
// handling — the main thread only pays the compact snapshot clone. Warmed up at startup (whenReady).
const reviewBuilder = new ReviewBuilder();
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
// Which workspace the user is actually looking at. A detached workspace owns its own OS window, so the hub's
// notion of "active" can name a different one entirely — and ⌘N pressed in a detached B offered A's project.
// Falls back to the hub's active workspace, which is the right answer for every non-detached window (they
// share the shell's window, so the OS only ever reports the shell as focused).
function focusedWorkspace(): WinState | undefined {
  const focusedId = BrowserWindow.getFocusedWindow()?.webContents.id;
  if (focusedId !== undefined) {
    for (const state of states.values()) {
      if (!state.win.isDestroyed() && state.win.webContents.id === focusedId) return state;
    }
  }
  return focusedState();
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
registerCommentsIpc(ipcMain, stateFromEvent);
registerTileMenuIpc(ipcMain, { getShellWindow: () => shellWindow, isLightTheme, getTranslate: tr });
// Theme + locale are global settings; re-theme the native chrome and broadcast to every window when either changes.
// One UI scale for the whole app. Each surface is its own WebContents (the rail, every review view, the modal
// overlay), so a CSS-only setting would have to be replicated into three documents — and would still miss the
// px-based layout the diff caret and gutters measure. Chromium's zoom factor scales all of it uniformly.
const UI_SCALE_KEY = "kakapo-ui-scale";
function uiScale(): number {
  const raw = Number(preferences.readGlobal()[UI_SCALE_KEY]);
  return Number.isFinite(raw) && raw >= 0.8 && raw <= 1.6 ? raw : 1;
}
function applyUiScale(target?: WebContents): void {
  const factor = uiScale();
  const set = (wc: WebContents | undefined): void => { if (wc && !wc.isDestroyed()) wc.setZoomFactor(factor); };
  if (target) { set(target); return; }
  set(shellWindow?.webContents);
  set(modalView?.webContents);
  for (const state of states.values()) set(state.win.webContents);
}
registerSettingsIpc(ipcMain, preferences, stateFromEvent, (key) => {
  if (key === "kakapo-theme" || key === "kakapo-locale") refreshChrome();
  if (key === UI_SCALE_KEY) applyUiScale();
});
registerMemoIpc(ipcMain, { read: readMemoWithLegacyImport, write: (root, body) => memoStore().write(root, body), remove: (root) => memoStore().remove(root) }, stateFromEvent);
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
  // Tell the view to pin its diff column BEFORE the width animation starts resizing it, so the pin captures the
  // settled diff width (not a mid-animation one) — that's what keeps the main panel from juddering.
  sendRailPushed();
  animateHubWidth(railExpanded ? HUB_EXPANDED : HUB_WIDTH);
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
  sendRailPushed(); // pin the diff column before the collapse animation resizes the view (see hub-expanded)
  animateHubWidth(HUB_WIDTH);
  if (shellWindow && !shellWindow.isDestroyed()) shellWindow.webContents.send("kakapo:hub-set-expanded", false);
}

// The New-workspace / rename / memo dialogs render in a transparent overlay WebContentsView (modalView) that
// is layered above the review views, so the live review content dims behind them rather than blanking. The
// rail asks to open one here; main brings the overlay to the front, shows it, focuses it, and tells its page
// which dialog to open. Keyboard focus is handed to the overlay so Esc/typing reach the dialog.
// Bring the overlay to the front, show + focus it, and tell its page which dialog to open (queued until the page
// finishes loading). Returns false when there's no shell window to host it. Shared by the rail's openModal and by
// showOverlayConfirm below.
function presentModal(payload: unknown): boolean {
  const view = ensureModalView(isLightTheme());
  if (!view || !shellWindow || shellWindow.isDestroyed()) return false;
  modalOpen = true;
  // A review view opened after the overlay would sit on top of it; re-add the overlay to keep it frontmost.
  shellWindow.contentView.removeChildView(view);
  shellWindow.contentView.addChildView(view);
  layoutModalView();
  view.setVisible(true);
  view.webContents.focus();
  if (modalViewReady) view.webContents.send("kakapo:modal-open", payload);
  else pendingModalOpen = payload;
  return true;
}
function hideModal(): void {
  modalOpen = false;
  pendingModalOpen = null;
  modalView?.setVisible(false);
  focusActiveReviewView();
}
ipcMain.on("kakapo:hub-open-modal", (_event, payload: unknown) => { presentModal(payload); });
ipcMain.on("kakapo:hub-close-modal", () => { hideModal(); });

// Custom confirm/alert: show a design-system dialog in the overlay (instead of a native message box) and resolve
// with the chosen button index + checkbox state. Only one is shown at a time; the overlay reports the click via
// kakapo:confirm-result. `presented` is false when there was no window to host it, so critical callers (quit) can
// fall back to a native box.
type ConfirmResult = { index: number; checked: boolean; presented: boolean };
let pendingConfirm: ((result: ConfirmResult) => void) | null = null;
function showOverlayConfirm(spec: Record<string, unknown>): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    if (pendingConfirm) { const prev = pendingConfirm; pendingConfirm = null; prev({ index: -1, checked: false, presented: true }); }
    if (!presentModal({ type: "confirm", ...spec })) { resolve({ index: -1, checked: false, presented: false }); return; }
    pendingConfirm = resolve;
  });
}
ipcMain.on("kakapo:confirm-result", (_event, result: unknown) => {
  const resolve = pendingConfirm;
  pendingConfirm = null;
  hideModal();
  if (!resolve) return;
  const r = (result ?? {}) as { index?: unknown; checked?: unknown };
  resolve({ index: typeof r.index === "number" ? r.index : -1, checked: r.checked === true, presented: true });
});
ipcMain.handle("kakapo:hub-confirm", (_event, spec: unknown) =>
  showOverlayConfirm((spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>));

// Bottom usage bar: the shell page pulls a fresh local snapshot on load, on a timer, and on manual refresh.
ipcMain.handle("kakapo:usage-stats", async () => { try { return await collectUsageStats(); } catch { return { updatedAt: Date.now() }; } });

// Keyboard shortcuts live in the review viewer (a WebContentsView). Clicking the shell-page rail moves
// keyboard focus to the shell, where those shortcuts do nothing — so hand focus back to the active review
// view after any rail interaction (and whenever the window is re-activated), unless a modal owns focus.
function focusActiveReviewView(): void {
  if (modalOpen || !shellWindow || shellWindow.isDestroyed()) return;
  const active = activeStateId != null ? states.get(activeStateId) : undefined;
  if (active && !active.win.isDetached() && !active.win.isDestroyed()) active.win.webContents.focus();
}
ipcMain.on("kakapo:hub-refocus", () => focusActiveReviewView());
// A click landed in the review CONTENT — not in its terminal panel, which the renderer filters out. The
// expanded rail is a transient peek, so a genuine click back into the review dismisses it; main cannot judge
// this from the view's focus event alone, because the terminal lives inside the same view and taking focus
// there is not "I am done with the rail".
ipcMain.on("kakapo:review-clicked", (event) => {
  if (event.sender.id === activeStateId) collapseRailFromReview();
});
// Picking a workspace from the rail — a click or Enter on a tile — is the user saying "this one", so the
// expanded rail has done its job and gets out of the way. This is the deliberate SELECTION, which is a
// different thing from the view merely taking focus: the rail must survive a click into a terminal pane
// (see kakapo:review-clicked), but not survive the choice it exists to offer.
ipcMain.on("kakapo:hub-activate", (_event, id: unknown) => {
  if (typeof id !== "number") return;
  activateWorkspace(id);
  collapseRailFromReview();
});
// A pinned-but-closed project tile (its main checkout has no open window yet) opens by path — activate() only
// works for windows that already exist in `states`.
ipcMain.on("kakapo:hub-open", (_event, path: unknown) => {
  if (typeof path === "string" && existsSync(path) && isGitRepository(path)) { openOrFocusWorkspace(path); collapseRailFromReview(); }
});
ipcMain.on("kakapo:hub-activate-index", (_event, index: unknown) => {
  if (typeof index !== "number") return;
  const state = Array.from(states.values())[index];
  if (!state) return;
  activateWorkspace(state.win.webContents.id);
  collapseRailFromReview();
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
// The distinct Git projects Kakapo already knows about (open workspaces + saved + recent), deduped by their main
// repo root. The New-workspace dialog offers them in a dropdown (instead of forcing a folder pick every time),
// and the rail pins each project's main checkout so a project's home is always reachable (see projectMainTiles).
// `root` is the main repo root — createManagedWorkspace resolves the worktree container from it.
function knownProjectRoots(): { name: string; root: string }[] {
  const seen = new Set<string>();
  const roots: { name: string; root: string }[] = [];
  const add = (candidate: string) => {
    try {
      if (!candidate || !existsSync(candidate) || !isGitRepository(candidate)) return;
      const record = workspaceRecord(candidate);
      if (seen.has(record.repoRoot)) return;
      seen.add(record.repoRoot);
      roots.push({ name: record.repoName, root: record.repoRoot });
    } catch { /* unreadable/removed repo — skip it rather than break the whole list */ }
  };
  for (const state of states.values()) add(state.options.root);
  for (const item of savedWorkspaceMetadata()) add(item.path);
  for (const recent of preferences.readRecentProjects()) add(recent.path);
  return roots;
}
ipcMain.handle("kakapo:hub-projects", () =>
  knownProjectRoots().map(({ name, root }) => ({ name, path: root })).sort((a, b) => a.name.localeCompare(b.name)));
// The workspace-tile context menu (kakapo:tile-menu / menu-size / menu-choose / menu-close) is a custom
// frameless popup, not the OS native menu — it lives in registerTileMenuIpc (app-tile-menu-ipc.ts), wired with
// the other IPC adapters above.
ipcMain.handle("kakapo:hub-preview", (_event, payload: { repo?: unknown; label?: unknown; worktree?: unknown; slug?: unknown }) => {
  if (typeof payload?.repo !== "string" || typeof payload?.label !== "string" || !isGitRepository(payload.repo)) return { ok: false };
  const repo = workspaceRecord(payload.repo);
  // worktree=false: nothing is created, the project's own checkout opens as-is — preview its real branch/path.
  if (payload.worktree === false) return { ok: true, worktree: false, branch: repo.branch, path: repo.repoRoot };
  // The slug is random and the dialog sends back the one it was shown, so the preview is a promise rather than
  // a guess. A slug already on screen is kept: re-previewing on every keystroke of the task name must not
  // reshuffle the branch out from under the reader.
  const slug = typeof payload.slug === "string" && payload.slug.trim() ? workspaceSlug(payload.slug) : randomWorkspaceSlug();
  return { ok: true, worktree: true, slug, base: defaultBase(repo.repoRoot), branch: `kakapo/${slug}`,
    refs: listStartRefs(repo.repoRoot),
    path: join("~", "kakapo", "workspaces", repo.repoName, slug) };
});
ipcMain.handle("kakapo:hub-create", async (_event, payload: { repo?: unknown; label?: unknown; worktree?: unknown; base?: unknown; slug?: unknown; memo?: unknown }) => {
  if (typeof payload?.repo !== "string" || typeof payload?.label !== "string") return { ok: false };
  // "Create a new worktree" unchecked: open the project's existing checkout instead of adding a branch+folder.
  if (payload.worktree === false) {
    if (!existsSync(payload.repo) || !isGitRepository(payload.repo)) return { ok: false };
    openOrFocusWorkspace(payload.repo);
    return { ok: true };
  }
  if (workspaceCreation) return { ok: false, error: "A workspace is already being created." };
  workspaceCreation = new AbortController();
  try {
    // An unknown ref is not worth pre-validating here: `git worktree add` refuses it, and its own message
    // ("invalid reference: origin/nope") is more useful than anything a check of ours would say. It reaches
    // the dialog's error line the same way every other creation failure does.
    const base = typeof payload.base === "string" && payload.base.trim() ? payload.base.trim() : undefined;
    const slug = typeof payload.slug === "string" && payload.slug.trim() ? payload.slug.trim() : undefined;
    const memo = typeof payload.memo === "string" && payload.memo.trim() ? payload.memo.trim() : undefined;
    const created = await createManagedWorkspaceAsync(payload.repo, payload.label, { base, slug, memo, signal: workspaceCreation.signal });
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
    return { ok: false, error: errorMessage(error) };
  } finally {
    workspaceCreation = undefined;
  }
});
ipcMain.on("kakapo:hub-cancel-create", () => workspaceCreation?.abort());
function forgetWorkspace(path: string): void {
  const next = savedWorkspaceMetadata().filter((item) => item.path !== path);
  const startupIndex = startupWorkspaceMetadata.findIndex((item) => item.path === path);
  if (startupIndex >= 0) startupWorkspaceMetadata.splice(startupIndex, 1);
  preferences.writeOpenWorkspaces(next, focusedState()?.options.root);
  renderHub();
}
function reconnectWorkspace(oldPath: string, newPath: string): boolean {
  if (!isGitRepository(newPath)) return false;
  const old = savedWorkspaceMetadata().find((item) => item.path === oldPath);
  const replacement = { ...workspaceRecord(newPath), alias: old?.alias, memo: old?.memo, base: old?.base };
  const next = savedWorkspaceMetadata().filter((item) => item.path !== oldPath);
  const startupIndex = startupWorkspaceMetadata.findIndex((item) => item.path === oldPath);
  if (startupIndex >= 0) startupWorkspaceMetadata.splice(startupIndex, 1);
  next.push(replacement);
  preferences.writeOpenWorkspaces(next, replacement.path);
  openOrFocusWorkspace(replacement.path);
  return true;
}
ipcMain.handle("kakapo:hub-forget", (_event, payload: { path?: unknown }) => {
  if (typeof payload?.path !== "string") return { ok: false };
  forgetWorkspace(payload.path);
  return { ok: true };
});
ipcMain.handle("kakapo:hub-reconnect", (_event, payload: { oldPath?: unknown; newPath?: unknown }) => {
  if (typeof payload?.oldPath !== "string" || typeof payload?.newPath !== "string") return { ok: false };
  return { ok: reconnectWorkspace(payload.oldPath, payload.newPath) };
});
// A disconnected tile (its folder is gone) was previously actioned with window.prompt(), which returns null
// in Electron — so clicking one did nothing and it could be neither reconnected nor removed. Offer a reliable
// native choice instead: point it at a new folder, or drop it from the list.
// The "folder is gone" dialog is now a custom overlay component (modalOverlayHtml #disc), not a native
// message box. Its Reconnect button still needs the native folder picker, which only main can run — pick the
// folder's new location, then repoint the saved entry. Remove-from-list reuses kakapo:hub-forget.
ipcMain.handle("kakapo:hub-reconnect-pick", async (_event, payload: { path?: unknown }) => {
  if (typeof payload?.path !== "string") return { ok: false };
  const repo = await pickRepo(shellWindow, focusedState()?.options.root);
  if (!repo) return { ok: false };
  return { ok: reconnectWorkspace(payload.path, repo) };
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
    // git first, terminals second. Removing the worktree is the step that can fail (a submodule, a lock, a
    // path git no longer recognizes), and it used to run AFTER the kill — so a failed delete left the
    // workspace intact but every one of its agent sessions dead. Unlinking a directory that a tmux pane has
    // as its cwd is fine on the platforms we ship, so nothing is lost by proving the removal first.
    try {
      removeManagedWorkspace(record, !!payload.force, !!payload.deleteBranch);
    } catch (error) {
      // This used to propagate, and an ipcMain.handle that throws rejects the renderer's invoke — so the
      // rail's `await` threw before reaching its own failure dialog. git's reason was swallowed whole and a
      // delete that removed nothing was indistinguishable from one that worked, which is how a worktree
      // could still be on disk after the app said nothing at all.
      return { ok: false, error: errorMessage(error) };
    }
    // tmux sessions die with the workspace too: killing only the ptys DETACHES a persistent pane, leaving
    // its session (and whatever agent is in it) running forever, invisible, with its worktree deleted.
    killWorkspaceTerminals(state);
  }
  const metadataIndex = startupWorkspaceMetadata.findIndex((item) => resolveWorkspaceRoot(item.path) === record.path);
  if (metadataIndex >= 0) startupWorkspaceMetadata.splice(metadataIndex, 1);
  if (payload.mode === "delete") {
    // Deleting is not closing: nothing may keep pointing at a worktree that no longer exists. A saved entry
    // whose path is gone is exactly what renderHub turns into a "disconnected" tile, so leaving it behind
    // made a deleted workspace linger in the rail instead of disappearing.
    const gone = (path: string) => path === record.path || resolveWorkspaceRoot(path) === record.path;
    preferences.writeOpenWorkspaces(preferences.readOpenWorkspaces().filter((item) => !gone(item.path)));
    preferences.forgetRecentProject(record.path);
    hubMainTilesCache = undefined; // the pinned-project set may have changed
  }
  state.win.webContents.close();
  const next = Array.from(states.values()).find((item) => item !== state);
  if (next) activateWorkspace(next.win.webContents.id);
  return { ok: true };
});

// Patch-set compare bar: switch the diff base to a chosen patch set (or "auto" to restore the automatic
// upstream merge-base). Mirrors the "Ignore whitespace" menu toggle — mutate this window's options,
// rebuild, and push the diff in place (like refreshIfChanged) so comments/scroll survive. The right side
// stays the working tree ("latest"); only the base moves, and base already threads through diff/context/
// blame/source, so no other plumbing changes.
ipcMain.handle("kakapo:set-review-base", async (event, payload: { ref?: unknown }) => {
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
    await rebuildAndPushUpdate(state, true);
    return { ok: true, activeBase: state.options.base ?? "auto" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
});

// Right/new side of the compare bar: pick a patch set as target B (A→B compare) or the sentinel
// "worktree" to return to base-vs-working-tree. Same rebuild+in-place-update shape as set-review-base;
// the source model then serves commit B's content so comments reconcile against B.
ipcMain.handle("kakapo:set-review-target", async (event, payload: { ref?: unknown }) => {
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
    await rebuildAndPushUpdate(state, true);
    return { ok: true, activeTarget: state.options.target ?? "worktree" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
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
    if (!isCommitSha(sha)) continue;
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
ipcMain.handle("kakapo:set-review-compare", async (event, payload: { base?: unknown; target?: unknown; scope?: unknown }) => {
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
    await rebuildAndPushUpdate(state, true);
    return { ok: true, activeBase: state.options.base ?? "auto", activeTarget: state.options.target ?? "worktree" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
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
// The packaged bundle and the global CLI are two different installs with two different update channels, and
// answering with the wrong one is why "Update" could report success and change nothing: `npm i -g` replaces
// the command, never /Applications/Kakapo.app. Ask the release for the DMG when we ARE the bundle.
// Tell every open workspace how far the download has got, so the brand mark can fill (15-analysis-status.js).
// Percent only — a byte count in a 28px mark is unreadable, and the one thing the reviewer wants to know is
// whether it is moving. `done` releases the mark whether the update succeeded or failed.
function sendUpdateProgress(payload: { percent: number; done?: boolean }): void {
  for (const state of states.values()) {
    if (!state.win.isDestroyed()) state.win.webContents.send("kakapo:update-progress", payload);
  }
}

// Stream the release DMG to disk, reporting bytes as they land. Electron's net.request rather than fetch or
// curl: it follows GitHub's redirect to the CDN by default, it goes through the app's own proxy/TLS settings,
// and it hands us the chunks — which is what makes a percentage possible at all. The whole point is that the
// main process keeps painting while ~200MB moves, so nothing here may be synchronous.
function downloadUpdateDmg(assetUrl: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  return new Promise((resolve) => {
    const work = mkdtempSync(join(tmpdir(), "kakapo-dmg-"));
    const target = join(work, "kakapo.dmg");
    const file = createWriteStream(target);
    const request = net.request({ url: assetUrl, redirect: "follow" });
    const fail = (error: string) => { try { file.destroy(); } catch { /* already gone */ } sendUpdateProgress({ percent: 0, done: true }); resolve({ ok: false, error }); };
    request.on("response", (response) => {
      if (response.statusCode >= 400) { fail(`download returned ${response.statusCode}`); return; }
      const total = Number(response.headers["content-length"]) || 0;
      let received = 0;
      let lastSent = -1;
      response.on("data", (chunk: Buffer) => {
        file.write(chunk);
        received += chunk.length;
        // One IPC per whole percent, not per chunk: a 200MB download is thousands of chunks and the mark
        // cannot show more than 100 states anyway.
        const percent = total ? Math.min(99, Math.floor((received / total) * 100)) : 0;
        if (percent !== lastSent) { lastSent = percent; sendUpdateProgress({ percent }); }
      });
      response.on("end", () => { file.end(() => resolve({ ok: true, path: target })); });
      response.on("error", (error: Error) => fail(errorMessage(error)));
    });
    request.on("error", (error) => fail(errorMessage(error)));
    request.end();
  });
}

async function updatePackagedApp(): Promise<{ ok: boolean; error?: string }> {
  const installed = bundlePathFor(app.getPath("exe"));
  if (!installed) return { ok: false, error: "not running from an application bundle" };
  try {
    const response = await fetch("https://api.github.com/repos/happy-nut/kakapo/releases/latest", {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!response.ok) return { ok: false, error: `GitHub returned ${response.status}` };
    const release = await response.json() as { tag_name?: string; assets?: { name?: string; browser_download_url?: string }[] };
    const tag = String(release.tag_name ?? "");
    if (!isNewerVersion(tag, APP_VERSION)) return { ok: false, error: `already on ${APP_VERSION}` };
    const asset = macDmgAsset((release.assets ?? [])
      .filter((item) => item.name && item.browser_download_url)
      .map((item) => ({ name: String(item.name), url: String(item.browser_download_url) })));
    if (!asset) return { ok: false, error: `${tag} has no build for this machine` };
    const downloaded = await downloadUpdateDmg(asset.url);
    if (!downloaded.ok || !downloaded.path) return { ok: false, error: downloaded.error ?? "download failed" };
    return installPackagedUpdate({ dmgPath: downloaded.path, installed, quit: () => { quitConfirmed = true; app.quit(); } });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

ipcMain.handle("kakapo:self-update", (event) => {
  if (app.isPackaged && process.platform === "darwin") return updatePackagedApp();
  // kakapo ships from GitHub Releases only — there is no npm publish (see release.yml), so the global-CLI
  // path below cannot resolve the package. A run from source updates the way source does.
  if (!app.isPackaged) return Promise.resolve({ ok: false, error: "running from source — update with git pull" });
  return updateGlobalCli(event);
});

const updateGlobalCli = (event: Electron.IpcMainInvokeEvent) => new Promise<{ ok: boolean; error?: string }>((resolve) => {
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
      fail(errorMessage(error));
      return;
    }
    child.stdout?.on("data", (d) => { attemptOut += String(d); if (attemptOut.length > 8000) attemptOut = attemptOut.slice(-8000); });
    child.stderr?.on("data", (d) => { attemptOut += String(d); if (attemptOut.length > 8000) attemptOut = attemptOut.slice(-8000); });
    child.on("error", (error) => fail(errorMessage(error)));
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
          console.error("kakapo: update installed, but relaunch failed: " + (errorMessage(error)));
        }
      }, 250);
    });
  };
  runAttempt(0);
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

  // Spawn the build worker now so the first window's boot build doesn't pay worker startup on the hot path.
  reviewBuilder.warmUp();

  // Drop recent-project entries whose folder is gone, so deleted worktrees stop cluttering the settings + rail.
  preferences.pruneRecentProjects();

  // Mirror the saved theme preference into nativeTheme so the OS chrome (traffic lights, menus) and every
  // renderer's prefers-color-scheme track it from the first paint. When "system" is active and the OS theme
  // flips, re-theme all the chrome live.
  syncNativeThemeSource();
  nativeTheme.on("updated", () => { if (themePreference() === "system") refreshChrome(); });

  buildApplicationMenu();

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
  console.error(errorMessage(error));
  app.quit();
});
else app.quit();

// Quitting kills every pty, and node-pty delivers those exits from a native thread: one landing after Electron
// has begun tearing the Node environment down aborts the process, so an ordinary Cmd+Q raises a macOS crash
// dialog. Take the exits here, while the environment is still alive, and only then quit for real.
async function finishQuit(): Promise<void> {
  quitConfirmed = true;
  for (const state of states.values()) for (const term of state.terms.values()) ptyReaper.kill(term);
  await ptyReaper.drain();
  app.quit();
}

// Each window's "closed" handler clears its timer and deletes its state, so quit once the last window is gone.
app.on("before-quit", (event) => {
  if (quitConfirmed) return;
  event.preventDefault();
  // Only panes that quitting would actually stop are worth a confirmation. A tmux-backed pane just loses its
  // client — the agent keeps running and comes back when the pane is reopened — so warning about it made the
  // dialog cry wolf on every quit (and, with nothing else to click, blocked scripted shutdowns entirely).
  const running = Array.from(states.values()).filter((state) => state.terms.size > (state.termSessions?.size ?? 0)).length;
  if (!running) { void finishQuit(); return; }
  const t = tr();
  const message = t("dialog.agentsRunning.message", { n: running, s: running === 1 ? "" : "s" });
  const detail = t("dialog.agentsRunning.detail");
  const title = t("dialog.agentsRunning.title");
  const buttons = [t("dialog.agentsRunning.keepOpen"), t("dialog.agentsRunning.quit")];
  const quitIfChosen = (choice: number): void => { if (choice === 1) void finishQuit(); };
  // Custom overlay dialog, with the native box as a fallback so quit is never blocked if the overlay can't show.
  void showOverlayConfirm({ title, message, detail, buttons, danger: true, defaultId: 0 }).then((r) => {
    if (r.presented) { quitIfChosen(r.index); return; }
    const opts: Electron.MessageBoxSyncOptions = { type: "warning", title, message, detail, buttons, defaultId: 0, cancelId: 0 };
    quitIfChosen(shellWindow ? dialog.showMessageBoxSync(shellWindow, opts) : dialog.showMessageBoxSync(opts));
  });
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
  const t = tr();
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") menuTemplate.push({ role: "appMenu" });
  // File menu: open a repo in the current window, or spawn a new window for it.
  menuTemplate.push({
    label: t("menu.file"),
    submenu: [
      { label: t("menu.openFolder"), accelerator: "CommandOrControl+O", click: () => void openFolderInCurrent() },
      { label: t("menu.openNewWindow"), accelerator: "CommandOrControl+Shift+O", click: () => void openFolderInNewWindow() },
    ],
  });
  // Keep the standard Edit/Window roles so Cmd+C/V/X/A (copy comments into prompts) and Cmd+Q work.
  // The in-window menu bar stays hidden on Windows/Linux via autoHideMenuBar; macOS shows it in the top bar.
  menuTemplate.push({ role: "editMenu" });
  menuTemplate.push({
    label: t("menu.workspace"),
    submenu: [
      { label: t("menu.switchWorkspace"), accelerator: "CommandOrControl+K", click: () => {
        // Open the floating quick-switcher inside the active review view (it renders over the diff, so the
        // review stays visible behind it). Focus the view first so its input receives keystrokes.
        const active = activeStateId != null ? states.get(activeStateId) : undefined;
        if (active && !active.win.isDetached() && !active.win.isDestroyed()) {
          active.win.webContents.focus();
          active.win.webContents.send("kakapo:open-quick-switcher");
        }
      } },
      { label: t("menu.newWorkspace"), accelerator: "CommandOrControl+N", click: () => {
        // A new task nearly always belongs to the project you are in, so main names it rather than leaving the
        // rail to guess from whichever workspace the hub last activated — which is a different one whenever
        // you pressed this in a detached window.
        const state = focusedWorkspace();
        const record = state && !state.win.isDestroyed() ? hubTileFor(state).record : undefined;
        shellWindow?.webContents.send("kakapo:hub-new", record ? { path: record.repoRoot, name: record.repoName } : undefined);
      } },
      { label: t("menu.expandRail"), accelerator: "CommandOrControl+Shift+E", click: () => {
        shellWindow?.webContents.send("kakapo:hub-toggle-expand");
      } },
      { type: "separator" },
      ...Array.from({ length: 9 }, (_, index): Electron.MenuItemConstructorOptions => ({
        label: `${t("menu.workspaceNumbered")} ${index + 1}`, accelerator: `CommandOrControl+Alt+${index + 1}`, visible: false,
        click: () => { const state = Array.from(states.values())[index]; if (state) activateWorkspace(state.win.webContents.id); },
      })),
    ],
  });
  // Ctrl+Cmd+Shift+/ ("?") opens the merged review-comments view (questions, then change requests).
  // ? is Shift+/ so Shift is part of the combo; Ctrl+Cmd avoids macOS's Cmd+? Help grab.
  menuTemplate.push({
    label: t("menu.review"),
    submenu: [
      { label: t("menu.allReviewComments"), accelerator: "Control+Command+Shift+/", click: () => sendToFocused("kakapo:merged-view") },
      // Cmd/Ctrl+Shift+N opens (and toggles) the single freeform prompt memo — a Markdown scratchpad.
      { label: t("menu.markdownMemo"), accelerator: "CommandOrControl+Shift+N", click: () => sendToFocused("kakapo:open-memo") },
      { type: "separator" },
      // Whitespace-ignore re-runs git diff with --ignore-all-space and reloads (main-process action,
      // so a menu checkbox is simpler than a renderer IPC round-trip). Per-window: applies to the focused
      // window only, and browser-window-focus syncs this checkbox to the focused window's state.
      {
        id: "ignore-whitespace",
        label: t("menu.ignoreWhitespace"),
        type: "checkbox",
        checked: options.ignoreWhitespace,
        accelerator: "CommandOrControl+Shift+W",
        click: async (item) => {
          const state = focusedState();
          if (!state) return;
          state.options.ignoreWhitespace = item.checked;
          const build = await buildReview(state);
          if (!build || state.win.isDestroyed()) return;
          state.signature = build.signature;
          state.win.webContents.reloadIgnoringCache();
        },
      },
    ],
  });
  // Terminal toggle/split/pane shortcuts as menu accelerators: Chromium swallows Cmd+D / Ctrl+` before they
  // reach the renderer's keydown, so route them through the app menu to the focused window's terminal client.
  menuTemplate.push({
    label: t("menu.terminal"),
    submenu: [
      { label: t("menu.toggleTerminal"), accelerator: "Control+`", click: () => sendToFocused("kakapo:terminal-toggle") },
      { label: t("menu.toggleTerminalF12"), accelerator: "Alt+F12", click: () => sendToFocused("kakapo:terminal-toggle") },
      { label: t("menu.splitTerminal"), accelerator: "CommandOrControl+D", click: () => sendToFocused("kakapo:terminal-split", "row") },
      { label: t("menu.splitTerminalDown"), accelerator: "CommandOrControl+Shift+D", click: () => sendToFocused("kakapo:terminal-split", "column") },
      { type: "separator" },
      { label: t("menu.focusPrevPane"), accelerator: "CommandOrControl+Alt+Left", click: () => sendToFocused("kakapo:terminal-pane-focus", -1) },
      { label: t("menu.focusNextPane"), accelerator: "CommandOrControl+Alt+Right", click: () => sendToFocused("kakapo:terminal-pane-focus", 1) },
      { label: t("menu.renamePane"), accelerator: "CommandOrControl+Alt+R", click: () => sendToFocused("kakapo:terminal-pane-rename") },
    ],
  });
  // Cmd/Ctrl+W closes the active Files-mode tab (routed to the renderer) instead of the window, matching
  // editor/browser tab behavior. Closing the window stays available via the menu item and Cmd/Ctrl+Q.
  menuTemplate.push({
    label: t("menu.window"),
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { label: t("menu.closeTab"), accelerator: "CommandOrControl+W", click: () => sendToFocused("kakapo:close-tab") },
      { label: t("menu.closeWindow"), click: () => BrowserWindow.getFocusedWindow()?.close() },
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

function ensureShellWindow(light: boolean): BrowserWindow {
  if (shellWindow && !shellWindow.isDestroyed()) return shellWindow;
  appQuitting = false; // a fresh shell means we're up-and-running again, not tearing down
  shellWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640, show: false, title: APP_TITLE,
    icon: windowIcon, backgroundColor: light ? "#f5f5f5" : "#202124", autoHideMenuBar: true,
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    webPreferences: { preload: hubPreloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  installWindowSurfaceRecovery(shellWindow);
  shellWindow.on("resize", layoutWorkspaceViews);
  // Re-activating the app returns keys to the review viewer — UNLESS the rail is expanded, where keys belong to
  // the rail. Without this guard, focusing the shell to hold rail focus (in the hub-expanded handler) would loop
  // back through here to the review view and instantly collapse the rail via its focus listener.
  shellWindow.on("focus", () => { if (!railExpanded) focusActiveReviewView(); });
  // Minimizing the shell takes every workspace it hosts off screen at once, and no activation follows.
  shellWindow.on("minimize", reconcileAllIdleSuspend);
  shellWindow.on("restore", reconcileAllIdleSuspend);
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
  void shellWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(hubHtml(light, APP_VERSION, tr())));
  shellWindow.webContents.on("did-finish-load", () => { applyUiScale(shellWindow?.webContents); renderHub(); });
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
    applyUiScale(view.webContents);
    modalViewReady = true;
    if (pendingModalOpen != null) { view.webContents.send("kakapo:modal-open", pendingModalOpen); pendingModalOpen = null; }
  });
  void view.webContents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(modalOverlayHtml(light, tr())));
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
    preferences.writeUnread(activated.options.root, false);
    if (activated.idleTimer) { clearTimeout(activated.idleTimer); activated.idleTimer = undefined; }
    if (activated.analysisSuspended) {
      // Rebuild the analysis with the same status relay a fresh window gets, so the resumed workspace's
      // analysis-status indicator updates again (previously this re-created it without the onStatus relay).
      activated.analysis = makeAnalysis(activated.options.root, () => activated);
      activated.analysisSuspended = false;
      scheduleAnalysisPrewarm(activated);
    }
    // Rebuilding the review on a switch to an idle workspace used to freeze the whole app for ~1-2s on a
    // large repo (the build ran synchronously on the main process). buildReview now runs it in the worker,
    // so main stays responsive, and the refreshed diff/state is pushed when the build lands. Skip if the user
    // has already switched away again — viewReleased stays set, so the next activation tries again. Keyed on
    // the released view rather than on the suspend flag: a view whose diff DOM was dropped MUST be repainted,
    // and the two are armed by the same timer.
    if (activated.viewReleased) {
      const target = activated;
      setTimeout(async () => {
        if (target.win.isDestroyed() || target.win.webContents.id !== activeStateId) return;
        const rebuilt = await buildReview(target);
        if (!rebuilt || target.win.isDestroyed() || target.win.webContents.id !== activeStateId) return;
        target.signature = rebuilt.signature;
        if (rebuilt.update) {
          target.win.webContents.send("kakapo:diff-update", rebuilt.update);
          target.viewReleased = false;
        }
      }, 0);
    } else if (activated.bootStarted) {
      // This workspace's pollers were paused while it was hidden (isVisibleWorkspace). Catch up now rather
      // than up to a tick later, so a switch still lands on the current diff/answers/annotations. The
      // suspended branch above already rebuilds everything, hence the else.
      if (activated.options.watch) void refreshIfChanged(activated);
      syncCommentsFile(activated);
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
  // Reuse the rail tile's cached record rather than re-deriving it: workspaceRecord is 3 more spawnSync git
  // calls, and renderHub below needs the very same record anyway.
  const identity = activated && hubTileFor(activated).record;
  if (identity) {
    const metadata = savedWorkspaceMetadata().find((item) => resolveWorkspaceRoot(item.path) === identity.path);
    shellWindow.setTitle(`${metadata?.alias || identity.branch} · ${identity.repoName} — ${APP_TITLE}`);
  }
  for (const state of states.values()) {
    if (!state.win.isDetached()) {
      const view = shellWindow.contentView.children.find(
        (child): child is WebContentsView => child instanceof WebContentsView && child.webContents.id === state.win.webContents.id,
      );
      view?.setVisible(state.win.webContents.id === id);
    }
    reconcileIdleSuspend(state);
  }
  shellWindow.show();
  shellWindow.focus();
  // Keyboard belongs to the review viewer, not the rail — but this focus is OURS, not a click into the
  // review, so the rail stays open. Only a click in the review content collapses it (kakapo:review-clicked).
  const activating = states.get(id);
  if (activating) activating.wantsFocusOnReady = true; // the view may still be loading; see did-finish-load
  focusActiveReviewView();
  persistWorkspaceSession(states.get(id)?.options.root);
  sendRailPushed(); // the newly active view collapses its sidebar too while the rail is expanded
  renderHub();
}

// Whether a workspace has a terminal actually running a foreground process (an agent/command) rather than just
// sitting idle at the shell prompt. node-pty's `process` reports the pty's foreground process; when it's no
// longer the shell, something is running. This drives the green "running" dot — an open-but-idle terminal must
// not light it (a bare shell isn't an agent). Recomputed on every activity tick / renderHub, and each terminal's
// output already fires an activity tick (plus a 1200ms busy-decay tick), so start/stop transitions converge.
function shellBasename(): string {
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
  return shell.split(/[\\/]/).pop() || shell;
}
// Ask TMUX what is running, not our own ptys. Panes are not restored on launch, so after a quit the pty map
// is empty while the agent itself is very much still working inside its session — and the tile went grey,
// saying the opposite of the truth. One `list-panes -a` maps session -> the command its pane runs, and both
// questions the rail asks are answered from it: "is anything but a shell running here" (the green dot) and
// "which agent is it" (the tile badge). Running the scan twice would be two subprocesses giving one answer,
// and it is cached for a beat besides, because the rail asks on every activity tick.
let tmuxPaneCache: { panes: Map<string, string>; at: number } | undefined;
const TMUX_SCAN_TTL_MS = 2000;
function tmuxPaneCommands(): Map<string, string> {
  if (tmuxPaneCache && Date.now() - tmuxPaneCache.at < TMUX_SCAN_TTL_MS) return tmuxPaneCache.panes;
  const panes = new Map<string, string>();
  const tmux = resolveTmux(process.env);
  if (tmux) {
    try {
      const listed = spawnSync(tmux, ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}"], { encoding: "utf8" });
      for (const line of String(listed.stdout ?? "").split("\n")) {
        const [session, command] = line.split("\t");
        // First non-shell pane wins, so a session whose second pane sits at a prompt still reports its agent.
        const name = (command ?? "").trim();
        if (!session || !name) continue;
        if (!panes.has(session) || panes.get(session)!.replace(/^-/, "") === shellBasename()) panes.set(session.trim(), name);
      }
    } catch { /* no tmux server -> nothing running that outlived us */ }
  }
  tmuxPaneCache = { panes, at: Date.now() };
  return panes;
}
function runningTmuxSessions(): string {
  const shellName = shellBasename();
  return Array.from(tmuxPaneCommands())
    .filter(([, command]) => command.replace(/^-/, "") !== shellName)
    .map(([session]) => session)
    .join("\n");
}
function rootHasRunningAgent(root: string): boolean {
  return tmuxSessionsForRoot(root, runningTmuxSessions()).length > 0;
}
function hasRunningProcess(state: WinState): boolean {
  const shellName = shellBasename();
  for (const t of state.terms.values()) {
    let fg = "";
    try { fg = t.process || ""; } catch { /* pty may have exited mid-query */ }
    const name = fg.replace(/^-/, ""); // login shells surface as "-zsh"
    if (name && name !== shellName) return true;
  }
  // No pane of ours is busy — but one may be running detached in tmux, from before this app run.
  return rootHasRunningAgent(state.options.root);
}

// Which agent this workspace is running, most authoritative source first.
//
// The recorded resume command (what the user was seen TYPING) is only a proxy, and it was the sole source
// until now: a workspace whose agent was started any other way — recalled with the up arrow, launched from a
// script or an alias, or simply still running inside a tmux session kakapo re-attached to on a later launch —
// never recorded anything and so never got a badge. That is not an edge case; re-attaching is the normal
// path, because running the shell inside tmux is what keeps an agent alive across restarts.
//
// It also means node-pty's own `t.process` reports "tmux" for a persistent pane, never the agent, so tmux has
// to be asked directly. Non-persistent panes still answer through the pty. The typed command remains the last
// resort, which is what keeps the badge on a workspace whose agent has since exited.
function agentForWorkspace(state: WinState, panes: Map<string, string>): AgentKind | undefined {
  for (const session of state.termSessions.values()) {
    const agent = agentForCommand(panes.get(session));
    if (agent) return agent;
  }
  for (const t of state.terms.values()) {
    try {
      const agent = agentForCommand(t.process);
      if (agent) return agent;
    } catch { /* pty may have exited mid-query */ }
  }
  return agentForCommand(state.resumeCommand);
}

// Push only the per-workspace agent-activity flags (busy spinner + attention dot) to the rail, so the tiles'
// indicators update without a full renderHub — which re-runs `git status` for every workspace and rebuilds the
// rail DOM (dropping hover/focus). The shell toggles CSS classes on the existing tiles from this.
function sendAgentActivity(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return;
  const activity = Array.from(states.values()).map((state) => ({
    id: state.win.webContents.id, busy: state.busy, unread: state.unread, running: hasRunningProcess(state),
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
    owner = githubOwnerFromUrl(url);
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
// Serving a STALE tile beats blocking for a fresh one. renderHub runs on the workspace-switch path, and the
// only way to compute a tile synchronously is spawnSync git — ~5ms per call, ~45ms for `status --porcelain` on
// a real repo, multiplied by every open workspace and pinned project. That is frozen UI at exactly the moment
// the user is interacting, and it is what made switching workspaces hitch. So: hand back whatever is cached
// (however old) and revalidate off-thread, re-rendering only if something actually changed. Only a tile that
// has never been computed still pays the synchronous cost, once.
const hubTileRefreshing = new Set<number>();
function hubTileFor(state: WinState): { record: WorkspaceRecord; dirtyCount: number; ahead: number } {
  if (state.hubTile) {
    if (Date.now() - state.hubTile.computedAt >= HUB_TILE_TTL_MS) void refreshHubTile(state);
    return state.hubTile;
  }
  const record = workspaceRecord(state.options.root);
  const dirtyCount = git(record.path, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
  // The base is read once, here, and then rides on the tile: a workspace cannot change what it was branched
  // from, and the refresh below runs far more often than this seed does.
  const base = savedWorkspaceMetadata().find((item) => resolveWorkspaceRoot(item.path) === record.path)?.base;
  state.hubTile = { record, dirtyCount, ahead: aheadCount(record.path, base), base, computedAt: Date.now() };
  return state.hubTile;
}
// Only branch and dirty count can change for a live workspace — repoRoot/repoName/kind are fixed for a given
// checkout — so revalidation is two async git calls, not a whole workspaceRecord rebuild.
async function refreshHubTile(state: WinState): Promise<void> {
  const previous = state.hubTile;
  if (!previous || state.win.isDestroyed()) return;
  const id = state.win.webContents.id;
  if (hubTileRefreshing.has(id)) return;
  hubTileRefreshing.add(id);
  // Bump the stamp up front so concurrent renderHub calls don't queue a second refresh behind this one.
  previous.computedAt = Date.now();
  try {
    const [branch, status, upstream] = await Promise.all([
      gitAsync(previous.record.path, ["branch", "--show-current"]),
      gitAsync(previous.record.path, ["status", "--porcelain"]),
      gitAsync(previous.record.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    ]);
    if (state.win.isDestroyed()) return;
    const countArgs = aheadArgs(upstream, previous.base);
    const ahead = countArgs ? Number(await gitAsync(previous.record.path, countArgs)) || 0 : 0;
    if (state.win.isDestroyed()) return;
    const dirtyCount = status.split("\n").filter(Boolean).length;
    const nextBranch = branch || "detached";
    const changed = dirtyCount !== previous.dirtyCount || nextBranch !== previous.record.branch || ahead !== previous.ahead;
    state.hubTile = { record: { ...previous.record, branch: nextBranch }, dirtyCount, ahead, base: previous.base, computedAt: Date.now() };
    if (changed) renderHub();
  } finally {
    hubTileRefreshing.delete(id);
  }
}

// The main checkout is the rail's home base, so it stays pinned for every known project even when no window is
// open for it — otherwise closing the main window (while task worktrees stay open) would make the project vanish
// from the rail. These are lightweight synthesized tiles (kind:"main", no window); clicking one opens it via
// kakapo:hub-open. renderHub drops any whose root is already an open/disconnected tile so the main never
// double-lists. Git facts share the same 1s TTL as live tiles so a burst of renders doesn't re-status per project.
function buildProjectMainTiles() {
  const saved = savedWorkspaceMetadata();
  return knownProjectRoots().filter(({ root }) => existsSync(root)).map(({ root }, index) => {
    const record = workspaceRecord(root);
    const metadata = saved.find((item) => resolveWorkspaceRoot(item.path) === record.path);
    const owner = githubOwnerFor(root);
    const avatar = owner ? ownerAvatar.get(owner) : undefined;
    if (owner && !avatar) void ensureOwnerAvatar(owner);
    const dirtyCount = git(record.path, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
    return { id: -(1000 + index), ...record, alias: metadata?.alias, memo: metadata?.memo, base: metadata?.base,
      openedAt: metadata?.openedAt, dirtyCount, avatar,
      // A closed workspace still shows what is true of it: an agent left running in its tmux session, and an
      // answer nobody has read. Both outlive the window, so neither waits for you to open it to be visible.
      active: false, running: rootHasRunningAgent(record.path), unread: preferences.readUnread(record.path),
      busy: false, closed: true };
  });
}
let hubMainTilesCache: { tiles: ReturnType<typeof buildProjectMainTiles>; computedAt: number } | undefined;
let hubMainTilesRefreshing = false;
// Stale-while-revalidate, same reasoning as hubTileFor — and this is the heavier half: every pinned project
// costs a workspaceRecord (3 git calls) plus a `status --porcelain`, whether or not it has a window open.
function projectMainTiles(): ReturnType<typeof buildProjectMainTiles> {
  if (hubMainTilesCache) {
    if (Date.now() - hubMainTilesCache.computedAt >= HUB_TILE_TTL_MS) void refreshProjectMainTiles();
    return hubMainTilesCache.tiles;
  }
  hubMainTilesCache = { tiles: buildProjectMainTiles(), computedAt: Date.now() };
  return hubMainTilesCache.tiles;
}
// The project set itself changes rarely, so revalidation re-reads only the per-project git facts that move
// (branch, dirty count) off-thread, and keeps the cached identity/avatar/metadata for everything else. A
// project appearing or disappearing arrives through the paths that already invalidate this cache.
async function refreshProjectMainTiles(): Promise<void> {
  const previous = hubMainTilesCache;
  if (!previous || hubMainTilesRefreshing) return;
  hubMainTilesRefreshing = true;
  previous.computedAt = Date.now(); // claim the window so concurrent renders don't stack refreshes
  try {
    const tiles = await Promise.all(previous.tiles.map(async (tile) => {
      const [branch, status] = await Promise.all([
        gitAsync(tile.path, ["branch", "--show-current"]),
        gitAsync(tile.path, ["status", "--porcelain"]),
      ]);
      return { ...tile, branch: branch || "detached", dirtyCount: status.split("\n").filter(Boolean).length };
    }));
    const changed = tiles.some((tile, index) =>
      tile.branch !== previous.tiles[index].branch || tile.dirtyCount !== previous.tiles[index].dirtyCount);
    hubMainTilesCache = { tiles, computedAt: Date.now() };
    if (changed) renderHub();
  } finally {
    hubMainTilesRefreshing = false;
  }
}

function renderHub(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return;
  const saved = savedWorkspaceMetadata();
  const panes = tmuxPaneCommands(); // shared 2s-cached tmux scan; also backs the green running dot
  const live = Array.from(states.values()).map((state) => {
    const { record: current, dirtyCount, ahead } = hubTileFor(state);
    const metadata = saved.find((item) => resolveWorkspaceRoot(item.path) === current.path);
    const owner = githubOwnerFor(state.options.root);
    const avatar = owner ? ownerAvatar.get(owner) : undefined;
    if (owner && !avatar) void ensureOwnerAvatar(owner);
    return { id: state.win.webContents.id, ...current, alias: metadata?.alias, memo: metadata?.memo,
      base: metadata?.base, fetchWarning: metadata?.fetchWarning, openedAt: metadata?.openedAt, dirtyCount, ahead, avatar,
      active: state.win.webContents.id === activeStateId, running: hasRunningProcess(state),
      resume: state.resumeCommand, agent: agentForWorkspace(state, panes),
      unread: state.unread, busy: state.busy, detached: state.win.isDetached() };
  });
  const disconnected = saved.filter((item) => !existsSync(item.path)).map((item, index) => ({
    ...item, id: -(index + 1), active: false, running: false, unread: false, busy: false, disconnected: true,
  }));
  // Pin every known project's main checkout, dropping any whose root already has an open or disconnected tile so
  // the main never double-lists (an open main is a live tile; only its closed state needs synthesizing here).
  const shownRoots = new Set([...live, ...disconnected].map((w) => resolveWorkspaceRoot(w.path)));
  const closedMains = projectMainTiles().filter((tile) => !shownRoots.has(resolveWorkspaceRoot(tile.path)));
  // Drop any tile whose repo identity couldn't be resolved: the rail groups by repoName, so an empty one renders
  // as an unidentifiable "?" project. Valid workspaces always carry a repoName, so this only strips junk.
  const workspaces = [...live, ...disconnected, ...closedMains].filter((w) => typeof w.repoName === "string" && w.repoName.trim());
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

// Re-apply the current theme + locale everywhere after either changes (a settings pick in one window, or the OS
// theme switching while "system" is active). The review views re-theme/re-localize live from the kakapo:chrome
// broadcast; the shell chrome pages (hub, modal overlay, tile menu) bake their theme/locale at build time, so they
// are regenerated instead. The hub reload is safe: review views are separate WebContentsViews layered on top, so
// only the rail document reloads, and it re-requests its state on load.
function refreshChrome(): void {
  // Reloading the hub resets its client-side rail state to collapsed; collapse main's matching state + view layout
  // first so the review views aren't left pushed-right against a now-collapsed rail. No-op if already collapsed.
  collapseRailFromReview();
  syncNativeThemeSource();
  const light = isLightTheme();
  const t = tr();
  const payload = { theme: themePreference(), resolved: light ? "light" : "dark", locale: currentLocale() };
  // Native menu labels follow the locale.
  buildApplicationMenu();
  // Reload the rail with the new theme/locale; it self-repopulates via requestState() on did-finish-load.
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.setBackgroundColor(light ? "#f5f5f5" : "#202124");
    void shellWindow.webContents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(hubHtml(light, APP_VERSION, t)));
  }
  // Drop the persisted modal overlay so its next open is rebuilt in the new theme/locale (never mid-dialog: the
  // settings modal can't be opened while the overlay is up, so modalOpen is false here).
  if (modalView && !modalOpen) {
    if (shellWindow && !shellWindow.isDestroyed() && !modalView.webContents.isDestroyed()) {
      shellWindow.contentView.removeChildView(modalView);
    }
    modalView = undefined;
    modalViewReady = false;
  }
  // Live re-theme / re-localize every open review (and any welcome view — harmlessly ignored there).
  for (const state of states.values()) {
    if (!state.win.isDestroyed()) state.win.webContents.send("kakapo:chrome", payload);
  }
}



// A window's project analysis relays LSP status to that window's renderer (the analysis-status indicator) and
// its perf trace. createWindow, the switch-resume rebuild, and openReview all need the identical relay, so
// build it in one place. getState is a thunk because createWindow constructs the analysis before its WinState
// exists — the onStatus closure must read the state lazily; the other callers already hold one.
function makeAnalysis(root: string, getState: () => WinState | undefined): ProjectAnalysis {
  return new ProjectAnalysis(root, {
    onStatus: (status) => {
      const state = getState();
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
}

// Create a window for `root`, register its WinState, wire teardown, and boot it (animated mark ->
// first build, or the welcome screen for a packaged launch with no repo).
function createWindow(root: string, deferBoot = false): WinState {
  const themeLight = isLightTheme();
  const host = ensureShellWindow(themeLight);
  const view = new WebContentsView({ webPreferences: {
    preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    // Chromium's built-in PDF viewer is a "plugin", and Electron ships with plugins off — without this an
    // <embed type="application/pdf"> renders as an empty box. It enables PDFium and nothing else: NPAPI/Flash
    // are long gone from Chromium, so this is not a general extension surface. See renderPdfView.
    plugins: true,
  } });
  host.contentView.addChildView(view);
  view.setVisible(false);
  // Clicking into the active review view returns focus to the "main window" — collapse an expanded rail so its
  // peek dismisses. Only the active (visible) view can receive a user click, so this never fires for a background one.
  // Zoom is per-WebContents and resets on navigation, so re-apply the UI scale on every load.
  view.webContents.on("did-finish-load", () => applyUiScale(view.webContents));
  // The review's keyboard shortcuts (Cmd+1 Files, etc.) attach only once its HTML has loaded. On a switch the
  // view is often still booting when activateWorkspace focuses it, so early key presses land on nothing (the
  // "press Cmd+1 three times" symptom). Hand it the keyboard the moment its content is ready.
  // This used to be skipped while the rail was expanded, back when expanding meant the rail owned the keyboard.
  // Activating a workspace now focuses the view regardless of the rail, so gate on the activation's own intent
  // instead — otherwise a view still loading at switch time never got focus and ⌘0/⌘1/F7 went nowhere.
  view.webContents.on("did-finish-load", () => {
    const state = states.get(view.webContents.id);
    if (!state?.wantsFocusOnReady) return;
    state.wantsFocusOnReady = false;
    if (view.webContents.id === activeStateId) focusActiveReviewView();
  });
  layoutWorkspaceViews();
  let surfaceHost = host;
  let detachedHost: BrowserWindow | undefined;
  const win: ReviewSurface = {
    webContents: view.webContents,
    // Electron's WebContentsView.webContents getter returns undefined once the underlying webContents is
    // destroyed, so guard the read: a pty can drain buffered onData/onExit after its window is gone and
    // deliver() calls this — `undefined.isDestroyed()` would crash the main process.
    isDestroyed: () => !view.webContents || view.webContents.isDestroyed(),
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
        icon: windowIcon, backgroundColor: themeLight ? "#f5f5f5" : "#202124", autoHideMenuBar: true,
      });
      surfaceHost = detachedHost;
      detachedHost.contentView.addChildView(view);
      const fitDetachedView = () => {
        if (!detachedHost || detachedHost.isDestroyed()) return;
        const [width, height] = detachedHost.getContentSize();
        view.setBounds({ x: 0, y: 0, width, height });
      };
      detachedHost.on("resize", fitDetachedView);
      // A detached workspace never passes through activateWorkspace again, so its own window is the only
      // place that knows it left the screen.
      const reconcileDetached = () => {
        const detachedState = states.get(view.webContents.id);
        if (detachedState) reconcileIdleSuspend(detachedState);
      };
      detachedHost.on("minimize", reconcileDetached);
      detachedHost.on("restore", reconcileDetached);
      detachedHost.on("show", reconcileDetached);
      detachedHost.on("hide", reconcileDetached);
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
  const analysis = makeAnalysis(resolvedRoot, () => state);
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
    viewReleased: false,
    terms: new Map(),
    termSessions: new Map(),
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
      preferences.writeUnread(state.options.root, state.unread);
      renderHub();
    },
    onAgentOutput: () => markAgentBusy(state),
    onAgentBell: () => {
      if (state.busyTimer) { clearTimeout(state.busyTimer); state.busyTimer = undefined; }
      state.busy = false;
      if (state.win.webContents.id !== activeStateId) {
        state.unread = true;
        preferences.writeUnread(state.options.root, true);
      }
      sendAgentActivity();
    },
    unread: preferences.readUnread(options.root), // an answer you never read is still unread tomorrow
    busy: false,
    bootStarted: false,
    buildSeq: 0,
    perf,
    lastDiffSig: "",
    reviewBase: undefined,
    reviewUpstream: undefined,
    disposeWindowSurfaceRecovery: () => {},
  };
  state.ensureFullIndex = () => ensureFullProjectIndex(state);
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
    // Killing a persistent pane's pty only detaches its tmux client — the session and the agent inside it
    // keep running, which is the whole point. Sessions are killed on explicit pane close (pty-kill), not here.
    for (const t of state.terms.values()) ptyReaper.kill(t);
    state.terms.clear();
    state.termSessions.clear();
    state.commandBuffers.clear();
    clearWatchTimers(state);
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

// Stop this window's pollers. Idempotent, and clears the handles so a re-arm on window reuse can't leak the
// previous set.
function clearWatchTimers(state: WinState): void {
  if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = undefined; }
  if (state.commentsTimer) { clearInterval(state.commentsTimer); state.commentsTimer = undefined; }
}

// Arm this window's pollers (clearing any prior set first): the --watch diff refresh (opt-in), the
// agent-answers sync, and the Explain annotations poll — all independent of --watch, since an agent can write
// answers/notes whether or not the diff itself is being polled. The one immediate answers sync catches up on
// anything written before this window existed (annotations have no such backlog concern).
function armWatchTimers(state: WinState): void {
  clearWatchTimers(state);
  if (state.options.watch) state.refreshTimer = setInterval(() => { if (isVisibleWorkspace(state)) void refreshIfChanged(state); }, WATCH_INTERVAL_MS);
  state.commentsTimer = setInterval(() => { if (isVisibleWorkspace(state)) syncCommentsFile(state); }, WATCH_INTERVAL_MS);
  syncCommentsFile(state);
}

// Only the workspace on screen is worth polling. A hidden one produced nothing a user could see while its
// --watch tick shelled out to `git diff` over the whole worktree every second — N open workspaces meant N
// permanent per-second walks of N trees, forever (issue #24). Every poller compares a signature, so a hidden
// workspace simply catches up on its first tick after it becomes visible; activateWorkspace kicks one
// immediately so the switch itself stays instant.
function isVisibleWorkspace(state: WinState): boolean {
  if (state.win.isDestroyed()) return false;
  // A minimized host shows nothing, whether it is the shell or a detached window. Without this a minimized
  // app kept every visible workspace's per-second `git diff` running, and a detached workspace counted as
  // on screen forever — the two paths that slipped past the first pass at issue #24.
  if (state.win.isMinimized()) return false;
  return state.win.isDetached() || state.win.webContents.id === activeStateId;
}

// Reclaim a workspace's language servers once it has been off screen for a while. Arm the countdown when it
// goes off screen and let it run — re-arming on every switch measured "nobody switched recently" rather than
// "this workspace has been hidden a while", so with a few workspaces in rotation nothing was ever reclaimed.
// Every way a workspace can leave the screen routes here, so a detached or minimized one is reclaimed too.
function reconcileIdleSuspend(state: WinState): void {
  if (state.win.isDestroyed()) return;
  if (isVisibleWorkspace(state)) {
    if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = undefined; }
    return;
  }
  if (state.idleTimer || state.analysisSuspended) return;
  state.idleTimer = setTimeout(() => {
    state.idleTimer = undefined;
    state.analysis.dispose();
    state.analysisSuspended = true;
    state.sourceFiles.clear();
    state.bodyCache.clear();
    // Main just dropped this workspace's caches, so a rebuild is owed on the way back in either way. The
    // renderer holds the same review a second time, as DOM — 169 MB for a 130-file diff, and Chromium cannot
    // purge live DOM behind a hidden view — so ask for that back too, and let the same rebuild repaint it.
    // Only a workspace that got as far as painting a review has one to give.
    state.viewReleased = true;
    if (state.bootStarted && !state.win.isDestroyed()) state.win.webContents.send("kakapo:release-view");
  }, ANALYSIS_IDLE_SUSPEND_MS);
  state.idleTimer.unref?.();
}

function reconcileAllIdleSuspend(): void {
  for (const state of states.values()) reconcileIdleSuspend(state);
}

// Only the session's FIRST window gets the full-size startup mark; see loadingHtml.
let firstWindowBooted = false;
// Paint the animated mark immediately, then build the (potentially heavy) review off the first paint and swap it
// in. Building before the window exists left the screen blank for the first few seconds of startup.
async function bootWindow(state: WinState, themeLight: boolean): Promise<void> {
  const compact = firstWindowBooted;
  firstWindowBooted = true;
  await state.win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(loadingHtml(themeLight, compact)));
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
      if (app.isPackaged && !isGitRepository(state.options.root)) {
        // ...but ONLY when there is nothing else to show. This check predates the workspace rail, when a
        // window with no repo meant the app had nothing to do. It now also catches a workspace whose folder
        // has gone — the one you just deleted, or a worktree removed outside the app — and answering that
        // with "choose a folder to review" hid every workspace still open behind a screen offering the one
        // action the user had not asked for. A missing folder is a disconnected workspace, which the rail
        // already knows how to draw; drop the window and let it.
        const alive = Array.from(states.values()).filter((other) => other !== state && !other.win.isDestroyed());
        if (alive.length) {
          state.win.webContents.close();
          if (state.win.webContents.id === activeStateId) activateWorkspace(alive[0].win.webContents.id);
          return;
        }
        void showWelcome(state);
        return;
      }
      state.commentsFile = commentsFilePath(state.options.root);
      state.knowledgeFile = knowledgeFilePath(state.options.root);
      // Diff-first: paint the diff + changed-file sources now; the full project index is materialized on
      // demand (ensureFullProjectIndex) so a large tree's enumeration never blocks first paint. The build
      // runs off-main in the worker, so the boot spinner keeps animating while it works.
      const firstBuild = await buildReview(state, true);
      if (!firstBuild) return; // window closed mid-build, or superseded
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
      armWatchTimers(state);
    } catch (error) {
      // One window's build failure shouldn't take down the whole app (other windows may be fine); log and
      // leave this window on the loading mark rather than quitting.
      console.error(errorMessage(error));
    }
  }, 60);
}

// Rebuild the review and push the compact diff-update to the renderer in place (no window reload), then warm
// analysis. Shared by the watch tick and the compare-bar handlers — the one place that owned this sequence in
// four copies. `force` skips the signature guard for a base/target/compare change, which always warrants it.
async function rebuildAndPushUpdate(state: WinState, force = false): Promise<void> {
  const prevSignature = state.signature;
  const snapshot = await buildReview(state, false);
  if (!snapshot) return; // window closed or a newer build superseded this one — nothing to push
  if (!force && !shouldPushUpdate(prevSignature, snapshot.signature)) return;
  state.signature = snapshot.signature;
  if (snapshot.update && !state.win.isDestroyed()) state.win.webContents.send("kakapo:diff-update", snapshot.update);
  scheduleAnalysisPrewarm(state);
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
    // Refresh the diff in place instead of reloading the window so review context remains stable; the update
    // is only pushed when the review signature actually changed (rebuildAndPushUpdate's default guard). The
    // build runs off-main (worker) and `state.refreshing` stays held across the await, serializing ticks.
    await rebuildAndPushUpdate(state);
  } catch (error) {
    console.error(errorMessage(error));
  } finally {
    state.refreshing = false;
  }
}

// Apply a worker-built review snapshot to this window's state. Split from the build call so the (async,
// off-main) build and the (sync, main-thread) state mutation are separable, and a superseded build's result
// can be dropped without touching state. Mirrors the state updates the old sync writeReviewFile did.
function applySnapshot(state: WinState, snapshot: BuildSnapshot): void {
  state.reviewBase = snapshot.reviewBase;
  state.reviewTarget = snapshot.reviewTarget;
  state.reviewUpstream = snapshot.reviewUpstream;
  // The review artifact mirrors the workspace's absolute folder structure below userData. Different
  // repositories, nested monorepo packages, and worktrees therefore never share a file or touch source.
  state.bodyDiffs = snapshot.bodyDiffs;
  state.bodyCache.clear();
  // Retain native records from the workspace snapshot instead of serializing and parsing the whole project
  // index (which can approach the source budget on large repositories).
  state.sourceFiles = new Map(snapshot.sourceFiles.map((file) => [file.path, file]));
  // Diff-first: this build carried only the changed files (fullIndexDeferred). Mark the full index owed so the
  // first project-index pull materializes it. A full build (deferFullIndex=false) clears the flag outright.
  state.fullIndexPending = snapshot.fullIndexDeferred;
  state.analysis.invalidate();
}

// Build (or rebuild) this window's review OFF the main process, via the shared worker, then apply the result.
// The main thread only pays the compact snapshot clone (~7-14ms for a 6k-file index) instead of the full
// ~90-180ms build, so a rebuild never freezes IPC/terminal handling. Returns null when the window closed or a
// newer build superseded this one (buildSeq) — the caller then leaves state untouched. The worker writes the
// review HTML file itself, so callers that reload/loadFile can do so once this resolves.
async function buildReview(state: WinState, deferFullIndex = false): Promise<BuildSnapshot | null> {
  const seq = ++state.buildSeq;
  const started = performance.now();
  state.perf.mark("review-build-start");
  let snapshot: BuildSnapshot;
  try {
    snapshot = await reviewBuilder.build(reviewPath(state.options.root), state.options, APP_TITLE, deferFullIndex);
  } catch (error) {
    console.error(errorMessage(error));
    return null;
  }
  if (state.win.isDestroyed() || seq !== state.buildSeq) return null; // window closed, or a newer build won
  // workerMs is wall-clock spent in the worker (the main loop was free the whole time); mainBlockMs is the
  // only stretch the main loop was actually blocked — the snapshot handoff. The old sync build blocked main
  // for the entire workerMs, so this split is what makes the off-main win legible in the trace.
  const workerMs = Math.round((performance.now() - started) * 10) / 10;
  const applyStarted = performance.now();
  applySnapshot(state, snapshot);
  state.perf.mark("review-build-complete", {
    workerMs,
    mainBlockMs: Math.round((performance.now() - applyStarted) * 10) / 10,
    sourceFiles: state.sourceFiles.size,
    diffBodies: state.bodyDiffs.length,
  });
  return snapshot;
}

// Diff-first startup: materialize the deferred full project index into state.sourceFiles the first time the
// renderer needs it (project-index pull, or a get-source for a file outside the changed set). Runs in the
// worker too, so opening the tree on a large repo doesn't freeze main. Idempotent + deduped: concurrent pulls
// share one in-flight build, and any watch rebuild that clears fullIndexPending first makes the result a
// no-op. state.signature is intentionally left at the first-paint (changed-only) value — that is what the
// renderer pulled the index against, and its installProjectIndex guard requires the pulled signature to match.
function ensureFullProjectIndex(state: WinState): Promise<void> {
  if (!state.fullIndexPending) return Promise.resolve();
  if (state.fullIndexInFlight) return state.fullIndexInFlight;
  const started = performance.now();
  state.fullIndexInFlight = reviewBuilder.index(state.options, state.reviewBase, state.reviewTarget)
    .then((full) => {
      if (state.win.isDestroyed() || !state.fullIndexPending) return; // closed, or a full rebuild beat us to it
      state.sourceFiles = new Map(full.map((file) => [file.path, file]));
      state.fullIndexPending = false;
      state.perf.mark("full-index-materialized", {
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        sourceFiles: state.sourceFiles.size,
      });
    })
    .catch((error) => { console.error(errorMessage(error)); })
    .finally(() => { state.fullIndexInFlight = undefined; });
  return state.fullIndexInFlight;
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
  writeFileSync(welcomePath, renderWelcomeHtml(isLightTheme(), recent, tr(), currentLocale()));
  await state.win.loadFile(welcomePath);
}

// Load a chosen git repo into an existing window — the welcome screen's folder picker, or File > Open
// Folder. Repoints the window's root, (re)writes the review, swaps the page, and re-arms its watch timer.
// No process.chdir: root is threaded through buildReview/refreshIfChanged per window.
async function openReview(state: WinState, root: string): Promise<void> {
  if (state.analysisWarmTimer) { clearTimeout(state.analysisWarmTimer); state.analysisWarmTimer = undefined; }
  state.analysis.dispose();
  state.options.root = resolve(root);
  state.perf = new ReviewPerformanceTrace(state.options.root, app.getPath("userData"));
  state.perf.mark("review-opened");
  state.analysis = makeAnalysis(state.options.root, () => state);
  preferences.recordRecentProject(state.options.root); // remember it for the welcome screen's Recent Projects
  state.lastDiffSig = ""; // new repo -> force the next watch tick to rebuild
  clearWatchTimers(state); // stop the previous repo's pollers before switching this window to the new repo
  state.commentsFile = commentsFilePath(state.options.root); // new repo -> that worktree's own thread
  state.knowledgeFile = knowledgeFilePath(state.options.root); // ...but its knowledge is the repository's
  state.commentsSig = undefined;
  state.knowledgeSig = undefined;
  // Diff-first, same as the cold boot: reusing this window for another repo paints its diff without waiting
  // on the new tree's full enumeration; the full index is pulled on demand (state.ensureFullIndex persists).
  const build = await buildReview(state, true);
  if (!build) return; // window closed mid-build, or superseded by another switch
  state.signature = build.signature;
  if (!state.win.isDestroyed()) await state.win.loadFile(reviewPath(state.options.root));
  armWatchTimers(state);
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
// validate (the welcome flow reports not-git in-page; the File menu shows the custom overlay via pickRepo).
async function pickDirectory(parent: BrowserWindow | undefined, defaultPath?: string): Promise<string | undefined> {
  const dialogOptions: Electron.OpenDialogOptions = {
    properties: ["openDirectory"],
    title: tr()("dialog.openRepo.title"),
    ...(defaultPath ? { defaultPath } : {}),
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  return result.canceled ? undefined : (result.filePaths[0] || undefined);
}

// File-menu picker: a directory that's a validated git repo, or undefined (canceled, or not-git with a
// custom overlay message). Used by Open Folder / Open in New Window, which have no in-page error surface.
async function pickRepo(parent: BrowserWindow | undefined, defaultPath?: string): Promise<string | undefined> {
  const root = await pickDirectory(parent, defaultPath);
  if (!root) return undefined;
  if (!isGitRepository(root)) {
    const t = tr();
    const title = t("dialog.notGit.title");
    const message = t("dialog.notGit.message", { path: root });
    const r = await showOverlayConfirm({ title, message, buttons: [t("dialog.ok")] });
    if (!r.presented) dialog.showErrorBox(title, message); // fallback if there's no window to host the overlay
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
