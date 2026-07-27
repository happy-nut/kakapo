import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, shell, WebContentsView } from "electron";
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
import { AppPreferences } from "./app-preferences.js";
import { registerReviewIpc } from "./app-review-ipc.js";
import { registerProjectPathIpc } from "./app-path-ipc.js";
import { registerTerminalIpc } from "./app-terminal-ipc.js";
import { registerAnswersIpc, syncAnswersFile, answersFilePath } from "./answers-ipc.js";
import { registerExplainIpc, refreshExplainIfChanged } from "./app-explain-ipc.js";
import type { IPty } from "node-pty";
import { installWindowSurfaceRecovery } from "./window-layout.js";
import { createManagedWorkspaceAsync, defaultBase, removalRisk, removeManagedWorkspace, workspaceRecord, workspaceSlug } from "./workspaces.js";

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
  unread: boolean;
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
const HUB_WIDTH = 52;
// Expanded (⌘⇧E / hover / pinned) the rail widens to show each workspace's full name + branch. The review
// views can't overlay the shell page (it renders behind them), so expansion PUSHES them right by this width.
const HUB_EXPANDED = 232;
let hubWidth = HUB_WIDTH; // current rail width the review views are laid out against
// A full-width title strip gives the macOS traffic lights their own clean band, so no vertical divider
// runs up into them. The review views sit below it; the active workspace's name lives in the strip.
const TITLEBAR_H = 38;
let hubOpen = true;
// True while a shell-page modal (the New-workspace dialog) is up. Suppresses the "return keyboard focus to
// the review view" behavior so the dialog keeps focus.
let modalOpen = false;
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
function animateHubWidth(target: number): void {
  if (hubAnimTimer) { clearInterval(hubAnimTimer); hubAnimTimer = undefined; }
  const start = hubWidth;
  if (start === target) { hubWidth = target; layoutWorkspaceViews(); return; }
  const t0 = Date.now(), dur = 170;
  hubAnimTimer = setInterval(() => {
    const p = Math.min(1, (Date.now() - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic — matches the shell rail's CSS transition
    hubWidth = Math.round(start + (target - start) * eased);
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
});

// A shell-page modal (the New-workspace dialog, the tile context menu) is painted UNDER the review
// WebContentsViews, so it is invisible behind them except over the rail. Hide the review views while the
// modal is up so it is fully visible and clickable. Keyboard focus otherwise stays on the (now hidden)
// active view, so Esc/typing never reach the dialog — hand focus to the shell page while modal, and give it
// back to the review view when it closes.
ipcMain.on("kakapo:hub-modal", (_event, open: unknown) => {
  modalOpen = !!open;
  setReviewViewsVisible(!open);
  if (modalOpen) shellWindow?.webContents.focus();
  else focusActiveReviewView();
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
  shellWindow.on("focus", focusActiveReviewView); // re-activating the app returns keys to the review viewer
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
  });
  void shellWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(hubHtml(light)));
  shellWindow.webContents.on("did-finish-load", renderHub);
  shellWindow.once("ready-to-show", () => shellWindow?.show());
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
}

// Show or hide the docked review views (used while a shell-page modal is open). When restoring, only the
// active workspace's view becomes visible again — matching the normal single-visible-view invariant.
function setReviewViewsVisible(visible: boolean): void {
  if (!shellWindow || shellWindow.isDestroyed()) return;
  for (const state of states.values()) {
    if (state.win.isDetached()) continue;
    const view = shellWindow.contentView.children.find(
      (child): child is WebContentsView => child instanceof WebContentsView && child.webContents.id === state.win.webContents.id,
    );
    view?.setVisible(visible && state.win.webContents.id === activeStateId);
  }
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
      const rebuilt = writeReviewFile(activated);
      activated.signature = rebuilt.signature;
      if (rebuilt.update) activated.win.webContents.send("kakapo:diff-update", rebuilt.update);
      scheduleAnalysisPrewarm(activated);
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
  focusActiveReviewView(); // keyboard belongs to the review viewer, not the rail
  // The rail stays put — selecting a workspace does not collapse anything, so there is no "return" step.
  persistWorkspaceSession(states.get(id)?.options.root);
  sendRailPushed(); // the newly active view collapses its sidebar too while the rail is expanded
  renderHub();
}

function renderHub(): void {
  if (!shellWindow || shellWindow.isDestroyed()) return;
  const saved = savedWorkspaceMetadata();
  const live = Array.from(states.values()).map((state) => {
    const current = workspaceRecord(state.options.root);
    const metadata = saved.find((item) => resolveWorkspaceRoot(item.path) === current.path);
    const dirtyCount = git(current.path, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
    return { id: state.win.webContents.id, ...current, alias: metadata?.alias, memo: metadata?.memo,
      base: metadata?.base, fetchWarning: metadata?.fetchWarning, openedAt: metadata?.openedAt, dirtyCount,
      active: state.win.webContents.id === activeStateId, running: state.terms.size > 0,
      resume: state.resumeCommand, unread: state.unread, detached: state.win.isDetached() };
  });
  const disconnected = saved.filter((item) => !existsSync(item.path)).map((item, index) => ({
    ...item, id: -(index + 1), active: false, running: false, unread: false, disconnected: true,
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

function hubHtml(light: boolean): string {
  const bg = light ? "#f4f4f4" : "#252526", fg = light ? "#242424" : "#ddd", line = light ? "#d0d0d0" : "#454545";
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:${bg};color:${fg};font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{display:flex;flex-direction:column}
#titlebar{height:${TITLEBAR_H}px;flex:none;-webkit-app-region:drag;display:flex;align-items:center;gap:8px;padding:0 12px 0 84px;border-bottom:1px solid ${line};background:${light ? "#ececec" : "#1b1e25"}}
#wsname{-webkit-app-region:no-drag;display:flex;align-items:center;gap:7px;max-width:72%;font-weight:600;color:${fg};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#wsname .wsdot{width:6px;height:6px;border-radius:50%;background:#4d9a51;flex:none}#wsname .rp{color:${light ? "#888" : "#7d828c"};font-weight:400}
.tb-spacer{flex:1;align-self:stretch}
#tools{-webkit-app-region:no-drag;display:flex;align-items:center;gap:2px;flex:none}
#tools .tb-sep{width:1px;height:16px;background:${line};margin:0 5px}
#tools button.tb{width:28px;height:26px;border:0;border-radius:6px;color:${light ? "#5f6470" : "#9aa0ab"};display:grid;place-items:center;padding:0;background:transparent}
#tools button.tb:hover{background:${light ? "#dfe7f5" : "#373d49"};color:${fg}}
#tools button.tb.active{color:#4d86d9;background:${light ? "#dfe7f5" : "#2a3446"}}
#tools button.tb.hidden{display:none!important}
#tools button.tb svg{width:17px;height:17px}
#hub{width:${HUB_WIDTH}px;flex:1;min-height:0;border-right:1px solid ${line};display:flex;flex-direction:column;align-items:center;gap:2px;overflow:hidden;transition:width 170ms cubic-bezier(.215,.61,.355,1)}
body.rail-exp #hub{width:${HUB_EXPANDED}px;align-items:stretch}
button{border:1px solid ${line};background:transparent;color:inherit;border-radius:6px;padding:4px 8px}
#list{flex:1;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;align-items:center;gap:5px;padding:4px 0;width:100%}
body.rail-exp #list{align-items:stretch;padding:4px 6px}
.repo-sep{width:24px;height:1px;background:${line};margin:3px 0;flex:none}
body.rail-exp .repo-sep{width:auto;margin:5px 4px}
.ws{position:relative;flex:none;display:flex;align-items:center;justify-content:center;gap:9px;border:0;background:transparent;padding:0;width:36px;height:36px;border-radius:9px}
body.rail-exp .ws{width:100%;height:40px;justify-content:flex-start;padding:0 5px}
body.rail-exp .ws:hover{background:${light ? "#e4eaf6" : "#2b303a"}}
body.rail-exp .ws.active{background:${light ? "#dfe7f5" : "#2a3446"}}
.ws-badge{position:relative;width:36px;height:36px;flex:none;border:1px solid ${line};background:${light ? "#e6e6e6" : "#2d2d30"};color:${light ? "#555" : "#b9bcc4"};border-radius:9px;display:grid;place-items:center;font-weight:700;font-size:12px;letter-spacing:.02em}
.ws:hover .ws-badge{border-color:#4d86d9;color:${fg}}
.ws.active .ws-badge{border-color:#4d86d9;color:#4d86d9;background:${light ? "#dfe7f5" : "#2a3446"};box-shadow:0 0 0 1px #4d86d9}
.ws.disc{opacity:.5}
.ws-badge .rundot{position:absolute;top:-3px;right:-3px;width:10px;height:10px;border-radius:50%;background:#4d9a51;border:2px solid ${bg}}
.ws-badge .unread{position:absolute;top:-3px;left:-3px;width:9px;height:9px;border-radius:50%;background:#e0a54b;border:2px solid ${bg}}
.ws-label{display:none;flex-direction:column;min-width:0;text-align:left;line-height:1.25}
body.rail-exp .ws-label{display:flex}
.ws-label .n{font-size:12px;font-weight:600;color:${fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ws-label .s{font-size:10.5px;color:${light ? "#888" : "#7d828c"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ws.active .ws-label .n{color:#4d86d9}
#railfoot{display:flex;flex-direction:column;align-items:center;gap:5px;padding:7px 0;border-top:1px solid ${line};width:100%;flex:none}
body.rail-exp #railfoot{flex-direction:row;justify-content:flex-end;padding:7px 6px;gap:4px}
#railfoot button{width:34px;height:32px;border:0;border-radius:8px;font-size:17px;color:${light ? "#666" : "#999"};display:grid;place-items:center;padding:0}
#railfoot button:hover{background:${light ? "#dfe7f5" : "#373d49"};color:${fg}}
#pin svg{width:16px;height:16px;transition:transform 170ms cubic-bezier(.215,.61,.355,1)}
body.rail-exp #pin svg{transform:rotate(180deg)}
body.rail-exp #pin{color:#4d86d9}
#railfoot #new{border:1px dashed ${line}}
dialog#create{border:1px solid ${line};border-radius:14px;background:${light ? "#fbfbfc" : "#242529"};color:${fg};width:456px;max-width:calc(100vw - 40px);padding:0;box-shadow:0 30px 90px #000a}
dialog#create::backdrop{background:#0009}
#create .dh{display:flex;align-items:center;justify-content:space-between;padding:18px 20px 2px}
#create .dh b{font-size:15.5px;font-weight:650}
#create .dx{width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:${light ? "#888" : "#8a8f99"};font-size:14px;display:grid;place-items:center;padding:0}
#create .dx:hover{background:${light ? "#eaeaea" : "#33383f"};color:${fg}}
#create .db{padding:6px 20px 20px}
#create label{display:block;margin:15px 0 7px;color:${light ? "#6b7280" : "#8a8f99"};font-size:11.5px;font-weight:600;letter-spacing:.02em}
#create .field{width:100%;display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid ${line};border-radius:10px;background:${light ? "#fff" : "#2c2d31"};color:inherit;text-align:left;font-size:13.5px}
#create .field:hover{border-color:#4d86d9}
#create .field .fi{flex:none;color:${light ? "#9aa0ab" : "#8a8f99"};display:grid;place-items:center}
#create .field .fv{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#create .field .fv.ph{color:${light ? "#9aa0ab" : "#71767f"}}
#create input.tin{width:100%;padding:11px 12px;border:1px solid ${line};border-radius:10px;background:${light ? "#fff" : "#2c2d31"};color:inherit;font-size:13.5px}
#create input.tin:focus{outline:none;border-color:#4d86d9}
#create input.tin::placeholder{color:${light ? "#9aa0ab" : "#71767f"}}
#create #preview{margin-top:11px;font-size:11px;color:${light ? "#6b7280" : "#8a8f99"};line-height:1.65;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
#create .error{color:#e0736b;min-height:15px;margin-top:11px;font-size:12px}
#create .actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:20px}
#create .dbtn{border:1px solid ${line};background:transparent;color:inherit;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:550}
#create .dbtn:hover{background:${light ? "#eee" : "#33383f"}}
#create .dbtn.pri{background:${light ? "#1a1a1a" : "#f0f0f2"};color:${light ? "#fff" : "#1a1a1a"};border-color:transparent;display:inline-flex;align-items:center;gap:8px}
#create .dbtn.pri:hover{opacity:.9}#create .dbtn.pri:disabled{opacity:.5}
#create .dbtn.pri kbd{font:11px ui-monospace,monospace;background:#00000022;border-radius:5px;padding:1px 5px;opacity:.8}
.context-menu{position:fixed;z-index:20;width:172px;padding:5px;background:${bg};border:1px solid ${line};border-radius:8px;box-shadow:0 12px 30px #0008}
.context-menu button{display:block;width:100%;border:0;text-align:left;padding:7px 9px}.context-menu button:hover{background:${light ? "#dfe7f5" : "#373d49"}}.context-menu .danger{color:#df6868}.hidden{display:none!important}</style>
<div id="titlebar"><span id="wsname"></span><span class="tb-spacer"></span><div id="tools"><button class="tb" data-act="changes" title="Changes (⌘0)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><line x1="3.5" y1="12" x2="8.8" y2="12"/><line x1="15.2" y1="12" x2="20.5" y2="12"/></svg></button><button class="tb" data-act="files" title="Files (⌘1)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5C4 6.7 4.7 6 5.5 6h3.2c.5 0 .9.2 1.2.6L11 8h7.3c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C4.7 19 4 18.3 4 17.5z"/></svg></button><span class="tb-sep"></span><button class="tb hidden" data-act="terminal" title="Terminal (⌃\`)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l4 5-4 5"/><path d="M13 17h6"/></svg></button><button class="tb" data-act="history" title="History (⌘9)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.3"/><path d="M12 7.4v5l3.2 1.9"/></svg></button><button class="tb" data-act="more" title="More review tools"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></button></div></div><main id="hub"><section id="list"></section><div id="railfoot"><button id="pin" title="Expand workspace rail (⌘⇧E)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l6 6-6 6"/><path d="M13 6l6 6-6 6"/></svg></button><button id="new" title="New workspace (⌘N)">＋</button><button id="settings" title="Settings — v${APP_VERSION}">⚙</button></div></main>
<dialog id="create"><div class="dh"><b>New workspace</b><button class="dx" id="dlgClose" aria-label="Close">✕</button></div><div class="db"><label>Project</label><button id="choose" class="field"><span class="fi"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5C4 6.7 4.7 6 5.5 6h3.2c.5 0 .9.2 1.2.6L11 8h7.3c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-13C4.7 19 4 18.3 4 17.5z"/></svg></span><span id="repoName" class="fv ph">Choose a Git repository…</span></button><input type="hidden" id="repo"><label>Task name</label><input id="label" class="tin" placeholder="e.g. fix-login-crash" autocomplete="off" spellcheck="false"><div id="preview"></div><div class="error" id="createError"></div><div class="actions"><button id="cancelCreate" class="dbtn">Cancel</button><button id="doCreate" class="dbtn pri"><span class="dcl">Fetch &amp; create</span><kbd>⌘↵</kbd></button></div></div></dialog>
<div id="workspaceMenu" class="context-menu hidden" role="menu"><button data-action="activate">Switch</button><button data-action="resume" class="hidden">Resume session</button><button data-action="rename">Rename…</button><button data-action="memo">Edit memo…</button><button data-action="detach">Open in new window</button><button data-action="close">Close workspace</button><button data-action="delete" class="danger">Delete worktree…</button></div>
<script>
const list=document.querySelector("#list"),dlg=document.querySelector("#create"),menu=document.querySelector("#workspaceMenu"),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let menuCard=null;
let creating=false;const openCreate=()=>{dlg.showModal();window.kakapoHub.modal(true);setTimeout(()=>{(document.querySelector("#repo").value?document.querySelector("#label"):document.querySelector("#choose")).focus();},0)};dlg.addEventListener('close',()=>window.kakapoHub.modal(false));document.querySelector("#new").onclick=openCreate;document.querySelector("#cancelCreate").onclick=()=>{if(creating)window.kakapoHub.cancelCreate();else dlg.close()};
document.querySelector("#settings").onclick=()=>window.kakapoHub.settings();
const tools=document.getElementById('tools');
tools.addEventListener('click',e=>{const b=e.target.closest('button.tb');if(!b)return;window.kakapoHub.railAction(b.dataset.act)});
window.kakapoHub.onRailState(s=>{s=s||{};const active=s.active||[];for(const b of tools.querySelectorAll('button.tb')){const a=b.dataset.act;if(a==='terminal'){b.classList.toggle('hidden',!s.terminal);}b.classList.toggle('active',active.indexOf(a)>=0);}});
window.kakapoHub.onToggle(open=>document.body.classList.toggle('closed',!open));window.kakapoHub.onNew(openCreate);
// Rail expand: ⌘⇧E or the » button toggles it open; main then pushes the review views right (they render over
// the shell page, so the rail can't overlay them) and collapses the active view's file tree to make room.
let railExp=false;const pinBtn=document.getElementById('pin');
function applyRail(){document.body.classList.toggle('rail-exp',railExp);window.kakapoHub.setHubExpanded(railExp);}
pinBtn.onclick=()=>{railExp=!railExp;applyRail();};
window.kakapoHub.onToggleExpand(()=>{railExp=!railExp;applyRail();});
async function preview(){const r=await window.kakapoHub.preview(document.querySelector("#repo").value,document.querySelector("#label").value);document.querySelector("#preview").innerHTML=r.ok?'slug: '+esc(r.slug)+'<br>base: '+esc(r.base)+'<br>branch: '+esc(r.branch)+'<br>'+esc(r.path):''}
document.querySelector("#choose").onclick=async()=>{const r=await window.kakapoHub.chooseRepo();if(r.ok){document.querySelector("#repo").value=r.repo;const n=document.querySelector("#repoName");n.textContent=r.repo.split('/').filter(Boolean).pop()||r.repo;n.classList.remove('ph');preview()}};
document.querySelector("#label").oninput=preview;
document.querySelector("#dlgClose").onclick=()=>{if(!creating)dlg.close()};
dlg.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();document.querySelector("#doCreate").click();}});
document.querySelector("#doCreate").onclick=async()=>{const btn=document.querySelector("#doCreate"),lbl=btn.querySelector('.dcl'),err=document.querySelector("#createError");if(creating)return;if(!document.querySelector("#repo").value){err.textContent="Choose a repository first.";return;}creating=true;btn.disabled=true;lbl.textContent="Fetching base…";err.textContent="";
const r=await window.kakapoHub.create(document.querySelector("#repo").value,document.querySelector("#label").value);creating=false;btn.disabled=false;lbl.textContent="Fetch & create";if(r.ok)dlg.close();else err.textContent=r.error||"Could not create workspace"};
const ago=value=>{const seconds=Math.max(0,Math.floor((Date.now()-Number(value||Date.now()))/1000));return seconds<60?'now':seconds<3600?Math.floor(seconds/60)+'m ago':seconds<86400?Math.floor(seconds/3600)+'h ago':Math.floor(seconds/86400)+'d ago'};
window.kakapoHub.onState(items=>{const groups=new Map;for(const w of items){if(!groups.has(w.repoName))groups.set(w.repoName,[]);groups.get(w.repoName).push(w)}
const _a=items.find(w=>w.active);const _wn=document.getElementById('wsname');if(_wn)_wn.innerHTML=_a?'<span class="wsdot"></span>'+esc(_a.alias||_a.branch)+' <span class="rp">· '+esc(_a.repoName)+'</span>':'';
const initials=w=>{const s=String(w.alias||w.branch||w.repoName||'?').replace(/^(feature|fix|chore|bugfix|hotfix|release)[\\/-]/i,'');const p=s.split(/[^a-z0-9]+/i).filter(Boolean);return((p[0]?p[0][0]:'?')+(p[1]?p[1][0]:(p[0]&&p[0][1]?p[0][1]:''))).toUpperCase()};
const tip=w=>(w.alias||w.branch)+' · '+w.repoName+(w.dirtyCount?' · '+w.dirtyCount+' changed':'')+(w.running?' · ● running':w.resume?' · resumable':w.disconnected?' · disconnected':'');
list.innerHTML=[...groups].map(([repo,ws],gi)=>(gi>0?'<div class="repo-sep"></div>':'')+ws.map(w=>'<button class="ws '+(w.active?'active':'')+(w.disconnected?' disc':'')+'" title="'+esc(tip(w))+'" data-id="'+w.id+'" data-path="'+encodeURIComponent(w.path)+'" data-name="'+esc(w.alias||w.branch)+'" data-disconnected="'+!!w.disconnected+'" data-resume="'+(w.resume&&!w.running?'1':'')+'"><span class="ws-badge">'+esc(initials(w))+(w.running?'<span class="rundot"></span>':'')+(w.unread?'<span class="unread"></span>':'')+'</span><span class="ws-label"><span class="n">'+esc(w.alias||w.branch)+'</span><span class="s">'+esc(w.repoName)+'</span></span></button>').join('')).join('');
for(const el of list.querySelectorAll('.ws')){el.onclick=async()=>{const id=Number(el.dataset.id),path=decodeURIComponent(el.dataset.path);if(el.dataset.disconnected==='true'){const action=prompt('reconnect | remove','reconnect');if(action==='remove')window.kakapoHub.forget(path);else if(action==='reconnect'){const r=await window.kakapoHub.chooseRepo();if(r.ok)window.kakapoHub.reconnect(path,r.repo)}return}window.kakapoHub.activate(id)};}
});
// The menu is a shell-page element, which renders BEHIND the review views — so hide them (modal) while it is
// open, exactly like the New-workspace dialog, otherwise the menu is painted under the active view.
function openWorkspaceMenu(card){menuCard=card;const r=card.getBoundingClientRect();menu.querySelector('[data-action="resume"]').classList.toggle('hidden',card.dataset.resume!=='1');menu.style.left=Math.min(r.right+4,innerWidth-180)+'px';menu.style.top=Math.min(r.top,innerHeight-250)+'px';menu.classList.remove('hidden');window.kakapoHub.modal(true)}
function closeWorkspaceMenu(){if(!menu.classList.contains('hidden')){menu.classList.add('hidden');window.kakapoHub.modal(false)}}
menu.onclick=e=>{const action=e.target.dataset.action,card=menuCard;if(!action||!card)return;menu.classList.add('hidden');const id=Number(card.dataset.id),name=card.dataset.name||'';if(action==='rename'){const alias=prompt('Workspace alias',name);window.kakapoHub.modal(false);if(alias!==null)window.kakapoHub.rename(id,alias)}else if(action==='memo'){const memo=prompt('One-line memo','');window.kakapoHub.modal(false);if(memo!==null)window.kakapoHub.rename(id,undefined,memo)}else{window.kakapoHub.modal(false);if(action==='activate')window.kakapoHub.activate(id);else if(action==='resume')window.kakapoHub.resume(id);else if(action==='detach')window.kakapoHub.detach(id);else if(action==='close')window.kakapoHub.remove(id,'close');else if(action==='delete')removeWorkspace(id)}};
document.addEventListener('click',e=>{if(!menu.contains(e.target)&&!e.target.classList.contains('more'))closeWorkspaceMenu()});
async function removeWorkspace(id){const delBranch=confirm('Also delete the local branch?\\nOK deletes it; Cancel keeps it.');let r=await window.kakapoHub.remove(id,'delete',false,delBranch);if(r.needsConfirmation){const x=r.risk;if(confirm('Delete worktree?'+(x.dirty?'\\n• uncommitted changes':'')+(x.unpushed?'\\n• '+x.unpushed+' unpushed commits':'')+(x.runningProcesses?'\\n• running terminal/agent':'')+'\\n\\nThis cannot be undone.'))r=await window.kakapoHub.remove(id,'delete',true,delBranch)}if(!r.ok&&!r.needsConfirmation)alert(r.error||'Delete failed')}
document.addEventListener('contextmenu',e=>{const card=e.target.closest&&e.target.closest('.ws');if(card){e.preventDefault();openWorkspaceMenu(card)}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.altKey&&/^[1-9]$/.test(e.key)){e.preventDefault();window.kakapoHub.activateIndex(Number(e.key)-1)}});
document.addEventListener('click',e=>{if(!e.target.closest('button,input,textarea,dialog,#wsname'))window.kakapoHub.refocusReview()});
window.kakapoHub.requestState();
</script>`;
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
    onAgentFinished: () => { state.unread = state.win.webContents.id !== activeStateId; renderHub(); },
    unread: false,
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
  setTimeout(() => {
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
      if (!state.win.isDestroyed()) void state.win.loadFile(reviewPath(state.options.root));
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
    // The first watch tick establishes the baseline for the review that boot/openReview just built.
    // Without this guard, lastDiffSig starts empty and an unchanged repository is rebuilt once about a
    // second after first paint — exactly when the reviewer starts interacting with it.
    if (!state.lastDiffSig) {
      state.lastDiffSig = diffSig;
      return;
    }
    if (diffSig === state.lastDiffSig) return;
    state.lastDiffSig = diffSig;
    const next = writeReviewFile(state);
    if (next.signature !== state.signature) {
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
  const requestedRoot = resolve(readOption(args, "--cwd") ?? process.cwd());
  const root = isGitRepository(requestedRoot) ? resolveWorkspaceRoot(requestedRoot) : requestedRoot;
  const contextValue = readOption(args, "--context");
  const staged = args.includes("--staged");
  const baseValue = readOption(args, "--base");
  if (staged && baseValue !== undefined) {
    throw new Error("Use either --staged or --base, not both: --staged compares the index against HEAD.");
  }
  // Default (neither flag): diff the working tree against an automatic base — the upstream merge-base when the
  // branch has unpushed commits, otherwise HEAD. --base <ref> reviews the working tree against any branch/tag/
  // commit (e.g. the whole AI feature branch: --base main). --staged reviews the index against HEAD.
  const base = baseValue !== undefined && isGitRepository(root)
    ? validateReviewBase(root, baseValue)
    : baseValue;
  return {
    root,
    base,
    staged,
    includeUntracked: args.includes("--include-untracked"),
    context: contextValue ? parsePositiveInteger(contextValue, "--context") : 12,
    watch: !args.includes("--no-watch"),
    ignoreWhitespace: args.includes("--ignore-whitespace"),
  };
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return parsed;
}
