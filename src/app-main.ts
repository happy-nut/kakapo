import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch as watchFs, writeFileSync } from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from "electron";
import type { WebContents } from "electron";
import { git, gitAsync, isCommitSha, isGitRepository, resolveWorkspaceRoot, validateReviewBase } from "./git.js";
import { renderWelcomeHtml } from "./render.js";
import { makeTranslator, normalizeLocale, type Locale } from "./i18n.js";
import { relaunchUpdatedApp, selfUpdateInstallAttempts } from "./self-update.js";
import { bundlePathFor, installPackagedUpdate, isNewerVersion, macDmgAsset } from "./app-update.js";
import { ProjectAnalysis } from "./analysis.js";
import { ReviewPerformanceTrace } from "./perf.js";
import type { SourceFile } from "./types.js";
import { workspaceDataDirectory, workspaceReviewFile } from "./workspace-data.js";
import { kakapoIconCssVariable, kakapoIconHtml } from "./brand.js";
import { reviewBodyCount, reviewDiffSignature } from "./review-bodies.js";
import { ReviewBuilder, type BuildSnapshot } from "./review-builder.js";
import { decideWatchTick, shouldPushUpdate } from "./watch-decision.js";
import { parseReviewArgs, readOption } from "./cli-args.js";
import { ByteBudgetCache, errorMessage } from "./util.js";
import { AppPreferences } from "./app-preferences.js";
import { compareDefaultRef, registerReviewIpc } from "./app-review-ipc.js";
import { registerSettingsIpc } from "./app-settings-ipc.js";
import { registerProjectPathIpc } from "./app-path-ipc.js";
import { registerCommentsIpc, syncCommentsFile, commentsFilePath } from "./comments-file.js";
import { installWindowSurfaceRecovery } from "./window-layout.js";
import { UI_SCALES } from "./constants.js";

type AppOptions = {
  root: string;
  base?: string;
  baseLabel?: string; // what the toolbar pill calls `base` — set when the reader picked a branch by name
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
  focus(): void;
  loadURL(url: string): Promise<void>;
  loadFile(path: string): Promise<void>;
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
  commentsTimer?: NodeJS.Timeout;
  // WHERE this build's per-file diffs are, not the diffs. They are the biggest thing a build makes — 106 MB
  // for a 1,352-file compare — and holding them per workspace is what put main's heap in gigabyte territory.
  // readReviewBody reads one slice when a body is actually asked for (review-workspace.ts).
  bodies: { file: string; offsets: number[] };
  // Rendered per-file diff bodies, scoped to the current build. BOUNDED: body HTML is about 17x the diff
  // text it comes from, and this used to keep one for every file ever opened, per workspace, until the next
  // rebuild. On a 1,352-file review that is ~1.8 GB in main — measured 2.1 GB of main heap for one such
  // workspace, and V8 aborting the whole app at 2.7 GB once a second one was opened. Re-rendering an evicted
  // body is one renderLazyDiffBody call on the file the reader just asked for.
  bodyCache: ByteBudgetCache<string>;
  sourceFiles: Map<string, SourceFile>; // source content stays in main; renderer requests one open file at a time
  analysis: ProjectAnalysis; // LSP-first project analysis + main-process regex fallback
  analysisSuspended: boolean;
  // The idle timer dropped this window's caches (main) and its diff DOM (renderer). Cleared once the
  // rebuild on the way back has repainted the view.
  viewReleased: boolean;
  idleTimer?: NodeJS.Timeout;
  bootStarted: boolean;
  perf: ReviewPerformanceTrace; // local startup/analysis evidence under this workspace's app-data mirror
  lastDiffSig: string; // watch fast-path: hash of the last git diff, to skip rebuilds when unchanged
  reviewBase?: string; // exact base used by the latest build (may be an automatic upstream merge-base)
  reviewTarget?: string; // exact right/new side revision for an A→B compare (undefined = working tree)
  // Commits of the range opened from the Cmd+9 history (oldest→newest). While set, the compare bar's two
  // dropdowns pick base/target from THIS list, so B..D within an opened A..F is selectable. Cleared on exit.
  compareScope?: { sha: string; shortSha: string; subject: string; date: string }[];
  compareRef?: string; // compare dropdown: the branch "All changes" measures against (persisted per repo)
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
// What one workspace may hold in rendered diff bodies. Enough for the run of files a reading pass actually
// walks; past that the oldest goes and is re-rendered if the reader comes back to it.
const BODY_CACHE_BYTES = 64_000_000;
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
// The persisted theme (set by the renderer via kakapoSettings): 'light' or 'dark', nothing else. It used to
// also accept 'system', which answered two questions at once — which palette, and who decides — so every
// reader had to resolve it before it meant anything. A stored 'system' resolves once, in the renderer, to
// whatever the OS was saying then. Mirrored into nativeTheme.themeSource (see syncNativeThemeSource) so the native
// window chrome (traffic lights, menus) and prefers-color-scheme both track the choice.
type ThemePreference = "light" | "dark";
function themePreference(): ThemePreference {
  try {
    const value = preferences.readGlobal()["kakapo-theme"];
    // Default dark (as before System existed), so users who never set a theme keep the UI they had.
    // A pre-existing "system" is not a theme any more; dark is the default it always fell back to.
    return value === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
// The light/dark used by the loading screen, window backgrounds, hub, and welcome page.
function isLightTheme(): boolean {
  return themePreference() === "light";
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
if (process.env.KAKAPO_REMOTE_DEBUG) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.KAKAPO_REMOTE_DEBUG);
  // A harness-driven window is usually behind the operator's own windows, and macOS marks an occluded
  // page `hidden` — which holds terminal output and parks rAF, so the very paths under test never run.
  // Verification needs the page to behave as if watched; normal runs keep the occlusion savings.
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}
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
let quitConfirmed = false;
const preferences = new AppPreferences(app.getPath("userData"), isGitRepository);

if (!existsSync(options.root)) {
  throw new Error(`Repository path does not exist: ${options.root}`);
}

// Resolve the WinState for an IPC call by mapping its sender back to a window — this is how get-file /
// source/analysis requests are routed to the right window's state instead of a shared global.
function stateFromEvent(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): WinState | undefined {
  return states.get(event.sender.id);
}
function focusedState(): WinState | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    for (const state of states.values()) {
      if (!state.win.isDestroyed() && state.win.webContents.id === focused.webContents.id) return state;
    }
  }
  // No OS-focused window (a menu accelerator can fire just after a focus change): fall back to the only
  // window when there is exactly one, which is the ordinary case for a single-repo launch.
  const live = Array.from(states.values()).filter((state) => !state.win.isDestroyed());
  return live.length === 1 ? live[0] : undefined;
}
// Menu accelerators are application-global, so they act on whichever window is focused.
function sendToFocused(channel: string, payload?: unknown): void {
  const state = focusedState();
  if (state && !state.win.isDestroyed()) state.win.webContents.send(channel, payload);
}

// The composition root supplies window-scoped state; the adapter owns review/query IPC details.
registerReviewIpc(ipcMain, stateFromEvent);
registerProjectPathIpc(ipcMain, shell, stateFromEvent);
registerCommentsIpc(ipcMain, stateFromEvent);
// One UI scale for the whole app. Each surface is its own WebContents (the rail, every review view, the modal
// overlay), so a CSS-only setting would have to be replicated into three documents — and would still miss the
// px-based layout the diff caret and gutters measure. Chromium's zoom factor scales all of it uniformly.
// Per-repo, not global: which branch is worth comparing against is a property of the repository you opened,
// and carrying one repo's answer into the next would silently review the wrong thing.
const COMPARE_REF_KEY = "kakapo-compare-ref";
function restoreCompareRef(state: WinState): void {
  const saved = preferences.readWorkspace(state.options.root)[COMPARE_REF_KEY];
  state.compareRef = typeof saved === "string" && saved ? saved : undefined;
}
const UI_SCALE_KEY = "kakapo-ui-scale";
function uiScale(): number {
  const raw = Number(preferences.readGlobal()[UI_SCALE_KEY]);
  return Number.isFinite(raw) && raw >= 0.8 && raw <= 1.6 ? raw : 1;
}
// ⌘+ / ⌘− / ⌘0. Chromium swallows these before a renderer keydown sees them, so they are menu accelerators
// like the terminal's — and main owns the zoom anyway. Stepping through the SAME list the dropdown offers
// keeps the two agreeing: the next keystroke and the next dropdown row are the same size.
function stepUiScale(delta: number): void {
  const current = uiScale();
  const at = UI_SCALES.indexOf(current);
  const from = at >= 0 ? at : UI_SCALES.indexOf(1);
  const next = UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, from + delta))];
  setUiScale(next);
}
function setUiScale(next: number): void {
  if (!UI_SCALES.includes(next) || next === uiScale()) return;
  const settings = preferences.readGlobal();
  settings[UI_SCALE_KEY] = next;
  preferences.writeGlobal(settings);
  applyUiScale();
  // The Settings dropdown reads its value from the renderer's own copy, so tell every view what happened —
  // otherwise the keyboard and the panel would disagree about the current size.
  // Every view is TOLD (their Settings dropdown has to agree with the keyboard), but only the visible ones
  // are re-zoomed above — a hidden workspace hears the number and pays for it when it is next shown.
  for (const state of states.values()) {
    if (!state.win.isDestroyed()) state.win.webContents.send("kakapo:ui-scale", next);
  }
}
// Zooming a view is not free: Chromium re-lays out the whole document, and a review document is a diff of
// every changed file plus however many terminals. Doing that to EVERY open workspace on one ⌘+ meant paying
// for six of them at once — six full relayouts, six sets of ResizeObservers, six terminals refitting and
// telling tmux to repaint — while the reviewer sat looking at one of them. That is the thirty-second freeze.
//
// So only the views the reviewer can actually see are zoomed now, and a hidden workspace takes its new size
// when it is next activated (activateWorkspace). The scale is read from preferences there, so a workspace
// that was hidden through three zoom steps arrives at the right size in one relayout instead of three.
function applyUiScale(target?: WebContents): void {
  const factor = uiScale();
  const set = (wc: WebContents | undefined): void => { if (wc && !wc.isDestroyed()) wc.setZoomFactor(factor); };
  if (target) { set(target); return; }
  for (const state of states.values()) set(state.win.webContents);
}

// Theme + locale are global settings: re-theme the native chrome (menu labels follow the locale) and tell
// every open review to repaint itself in the new one.
function refreshChrome(): void {
  syncNativeThemeSource();
  const light = isLightTheme();
  const payload = { theme: themePreference(), resolved: light ? "light" : "dark", locale: currentLocale() };
  buildApplicationMenu();
  for (const state of states.values()) {
    if (!state.win.isDestroyed()) state.win.webContents.send("kakapo:chrome", payload);
  }
}
registerSettingsIpc(ipcMain, preferences, stateFromEvent, (key) => {
  if (key === "kakapo-theme" || key === "kakapo-locale") refreshChrome();
  if (key === UI_SCALE_KEY) applyUiScale();
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
    state.options.baseLabel = undefined; // a patch-set pick names a commit; the pill shows the SHA it is
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
    state.options.baseLabel = undefined;
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

// Compare dropdown (the pill in the diff toolbar): the two rows the reader actually switches between, and
// the branch the first of them is measured against. It is a narrower control than the patch-set bar on
// purpose — "everything on this branch" and "what I have not committed yet" are the two questions asked all
// day, and reaching them through a base/target pair spelled the answer as coordinates instead of as a choice.
//
// "All changes" uses the MERGE-BASE with the chosen branch, not the branch tip: `git diff main` against a
// main that has moved on shows their commits as your deletions, and the review would blame you for work you
// never touched. The merge-base is the point the two actually agree on.
ipcMain.handle("kakapo:set-compare-mode", async (event, payload: { mode?: unknown; ref?: unknown }) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const mode = payload?.mode === "uncommitted" ? "uncommitted" : "all";
  const rawRef = typeof payload?.ref === "string" ? payload.ref.trim() : "";
  try {
    if (rawRef) {
      state.compareRef = validateReviewBase(state.options.root, rawRef);
      preferences.setRendererSetting(state.options.root, COMPARE_REF_KEY, state.compareRef);
    }
    state.compareScope = undefined; // leaving any Cmd+9 range the pill cannot describe
    state.options.target = undefined;
    state.options.staged = false;
    if (mode === "uncommitted") {
      state.options.base = "HEAD";
      state.options.baseLabel = undefined;
    } else {
      const ref = state.compareRef || compareDefaultRef(state.options.root);
      // No upstream and no conventional default branch: leave the base unset and let the automatic
      // resolution have it back, which is the only honest answer to "all changes" in that repository.
      state.options.base = (ref && git(state.options.root, ["merge-base", ref, "HEAD"])) || undefined;
      state.options.baseLabel = state.options.base ? ref : undefined;
    }
    state.lastDiffSig = "";
    await rebuildAndPushUpdate(state, true);
    return { ok: true, mode, ref: state.compareRef || compareDefaultRef(state.options.root) };
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
  const root = await pickDirectory(BrowserWindow.getFocusedWindow() ?? undefined, state.options.root);
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
// While ~200MB moves, the Settings panel's update row counts it up. Percent only, and one message per whole
// percent rather than per chunk: a 200MB download is thousands of chunks and the row cannot show more than
// 100 states. `done` releases the row whether the update succeeded or failed.
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
    // Through finishQuit, never `quitConfirmed = true; app.quit()`: setting the flag by hand is exactly what
    // makes before-quit stand aside, so the ptys were never killed or drained and their exits landed in the
    // middle of the Node teardown — an abort, and a macOS crash dialog, on every update. finishQuit sets the
    // same flag itself, so the agents-running prompt still stays out of the way of an update the user asked for.
    return installPackagedUpdate({ dmgPath: downloaded.path, installed, quit: finishQuit });
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
// responds; the dock un-ignores on close so every other Cmd+A/Cmd+C in the app keeps its native behavior.
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

  // Mirror the saved theme into nativeTheme so the OS chrome (traffic lights, menus) and every renderer's
  // prefers-color-scheme track it from the first paint.
  syncNativeThemeSource();

  buildApplicationMenu();

  // The window reviews the CLI-resolved root with the CLI-resolved flags. The repository stays read-only:
  // generated review state is written into its mirrored directory below Electron userData. A packaged app
  // double-clicked from Finder has no useful cwd; bootWindow answers that with the welcome screen.
  // Start the first review NOW, not after the window exists — see pendingFirstBuild. A packaged .app with no
  // repo in cwd shows the welcome screen instead, and has nothing to build.
  if (!app.isPackaged || isGitRepository(options.root)) {
    pendingFirstBuild = reviewBuilder.build(reviewPath(options.root), options, APP_TITLE, true);
    // The window that claims it reports the failure; this only stops an unhandled rejection in the gap before
    // anyone is awaiting it.
    pendingFirstBuild.catch(() => {});
  }

  createWindow(options.root);
  setInterval(watchLspWeight, LSP_WATCHDOG_MS);
}).catch((error: unknown) => {
  console.error(errorMessage(error));
  app.quit();
});
else app.quit();

// Nothing outlives a review window now, so quitting is immediate. Kept as one function because the packaged
// self-update path also needs "quit for real" without going back through the before-quit guard.
function finishQuit(): void {
  quitConfirmed = true;
  app.quit();
}

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
  // Ctrl+Cmd+Shift+/ ("?") opens the merged review-comments view (questions, then change requests).
  // ? is Shift+/ so Shift is part of the combo; Ctrl+Cmd avoids macOS's Cmd+? Help grab.
  menuTemplate.push({
    label: t("menu.review"),
    submenu: [
      { label: t("menu.allReviewComments"), accelerator: "Control+Command+Shift+/", click: () => sendToFocused("kakapo:merged-view") },
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
  // Zoom, for the same reason the terminal shortcuts are here: Chromium takes ⌘+/⌘−/⌘0 before any renderer
  // keydown runs. Both ⌘= and ⌘+ are bound because the key is the same one with and without Shift, and
  // binding only one means the shortcut works on some layouts and not others.
  menuTemplate.push({
    label: t("menu.view"),
    submenu: [
      { label: t("menu.zoomIn"), accelerator: "CommandOrControl+=", click: () => stepUiScale(1) },
      { label: t("menu.zoomIn"), accelerator: "CommandOrControl+Plus", visible: false, click: () => stepUiScale(1) },
      { label: t("menu.zoomOut"), accelerator: "CommandOrControl+-", click: () => stepUiScale(-1) },
      { label: t("menu.zoomReset"), accelerator: "CommandOrControl+0", click: () => setUiScale(1) },
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

// pyright's cost is "how much of the repo it has been asked about", and nothing but a restart returns it —
// measured: 12 files touched → 313 MB, 500 → 1331 MB; heap caps and didClose do nothing (see the memory
// profile note). The 30-minute idle suspend reclaims a MINIMIZED window, but one in active use never sits
// still that long: two zoobox pyrights at ~1 GB each outlived an afternoon of reading. So fleets are also
// recycled by WEIGHT. Over budget and hidden → disposed on the spot, resumed by the same path the idle
// suspend uses. Over budget and visible → a fresh fleet immediately: the next hover pays a warmup instead of
// the machine paying a gigabyte. JVM families are exempt — the Kotlin server is 1.3 GB when HEALTHY, and
// trading its restart for memory is a known bad deal (75s startup grace in lsp.ts).
const LSP_FLEET_BUDGET_MB = 900;
const LSP_WATCHDOG_MS = 5 * 60_000;
const LSP_WEIGHT_EXEMPT_FAMILIES = new Set(["kotlin"]);
function watchLspWeight(): void {
  for (const state of states.values()) {
    if (state.win.isDestroyed() || state.analysisSuspended) continue;
    const pids = state.analysis.serverPids()
      .filter(({ family }) => !LSP_WEIGHT_EXEMPT_FAMILIES.has(family))
      .map(({ pid }) => pid);
    if (!pids.length) continue;
    execFile("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" }, (error, stdout) => {
      if (error && !stdout) return; // ps exits non-zero when some pids are already gone; partial output still counts
      const mb = String(stdout ?? "").split("\n").reduce((sum, line) => sum + (Number(line.trim()) || 0), 0) / 1024;
      if (mb < LSP_FLEET_BUDGET_MB) return;
      console.log(`kakapo: language servers for ${state.options.root} hit ${Math.round(mb)}MB — recycling the fleet`);
      state.analysis.dispose();
      if (isVisibleWorkspace(state)) {
        state.analysis = makeAnalysis(state.options.root, () => state);
        scheduleAnalysisPrewarm(state);
      } else {
        state.analysisSuspended = true; // the next restore rebuilds it, exactly like the idle suspend
      }
    });
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

// Create the window for `root`, register its WinState, wire teardown, and boot it (animated mark ->
// first build, or the welcome screen for a packaged launch with no repo).
function createWindow(root: string): WinState {
  const themeLight = isLightTheme();
  const win = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640, show: false, title: APP_TITLE,
    icon: windowIcon, backgroundColor: themeLight ? "#f5f5f5" : "#202124", autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
      // Chromium's built-in PDF viewer is a "plugin", and Electron ships with plugins off — without this an
      // <embed type="application/pdf"> renders as an empty box. It enables PDFium and nothing else: NPAPI/Flash
      // are long gone from Chromium, so this is not a general extension surface. See renderPdfView.
      plugins: true,
    },
  });
  installWindowSurfaceRecovery(win);
  // Zoom is per-WebContents and resets on navigation, so re-apply the UI scale on every load.
  win.webContents.on("did-finish-load", () => applyUiScale(win.webContents));
  // A minimized window shows nothing; its pollers and language servers can stand down until it is back.
  win.on("minimize", () => reconcileIdleSuspend(states.get(win.webContents.id)));
  win.on("restore", () => reconcileIdleSuspend(states.get(win.webContents.id)));

  const surface: ReviewSurface = {
    webContents: win.webContents,
    // Electron's getter returns undefined once the underlying webContents is destroyed, so guard the read:
    // a timer can fire after the window is gone and `undefined.isDestroyed()` would take main down with it.
    isDestroyed: () => win.isDestroyed() || !win.webContents || win.webContents.isDestroyed(),
    isMinimized: () => win.isDestroyed() || win.isMinimized(),
    restore: () => { if (!win.isDestroyed()) win.restore(); },
    show: () => { if (!win.isDestroyed()) win.show(); },
    focus: () => { if (win.isDestroyed()) return; win.show(); win.focus(); },
    loadURL: (url) => win.webContents.loadURL(url),
    loadFile: (path) => win.webContents.loadFile(path),
  };

  const resolvedRoot = resolve(root);
  const perf = new ReviewPerformanceTrace(resolvedRoot, app.getPath("userData"));
  perf.mark("window-created");
  let state!: WinState;
  const analysis = makeAnalysis(resolvedRoot, () => state);
  state = {
    win: surface,
    options: makeOptions(root),
    signature: "",
    refreshing: false,
    bodies: { file: "", offsets: [] },
    bodyCache: new ByteBudgetCache<string>(BODY_CACHE_BYTES, (body) => body.length),
    sourceFiles: new Map(),
    analysis,
    analysisSuspended: false,
    viewReleased: false,
    bootStarted: false,
    buildSeq: 0,
    perf,
    lastDiffSig: "",
    reviewBase: undefined,
    reviewUpstream: undefined,
    disposeWindowSurfaceRecovery: () => {},
  };
  state.ensureFullIndex = () => ensureFullProjectIndex(state);
  const id = win.webContents.id;
  states.set(id, state);

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
  win.webContents.once("did-finish-load", () => {
    if (DEV_BUILD) win.webContents.openDevTools({ mode: "detach" });
  });
  // Fill the screen. A review is a two-pane diff plus a file tree: at the default 1440x960 the panes are
  // narrow enough that most lines wrap or clip, and the first thing anyone did was maximize the window.
  // Maximize BEFORE show, so it opens at full size rather than opening small and snapping.
  // (width/height above are still the restore-down size, and the OS remembers a later resize as usual.)
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.maximize();
    win.show();
  });
  win.on("closed", () => {
    clearWatchTimers(state);
    if (state.analysisWarmTimer) clearTimeout(state.analysisWarmTimer);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.analysis.dispose();
    states.delete(id);
  });

  state.bootStarted = true;
  void bootWindow(state, themeLight);
  return state;
}

// A second CLI launch joins this app process. Launching from the same repository (including from a nested
// directory) focuses the window already reviewing it; another repository gets its own window.
function openOrFocusWorkspace(root: string): WinState {
  const canonicalRoot = resolveWorkspaceRoot(root);
  const existing = Array.from(states.values()).find(
    (state) => resolveWorkspaceRoot(state.options.root) === canonicalRoot,
  );
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.show();
    existing.win.focus();
    return existing;
  }
  const created = createWindow(canonicalRoot);
  created.win.show();
  created.win.focus();
  return created;
}

// Stop this window's pollers. Idempotent, and clears the handles so a re-arm on window reuse can't leak the
// previous set.
function clearWatchTimers(state: WinState): void {
  if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = undefined; }
  if (state.commentsTimer) { clearInterval(state.commentsTimer); state.commentsTimer = undefined; }
}

// Arm this window's pollers (clearing any prior set first): the --watch diff refresh (opt-in) and the
// comments-file sync, which runs whether or not the diff itself is being polled — a thread can be appended
// to from outside this window. The one immediate sync catches up on anything written before it existed.
function armWatchTimers(state: WinState): void {
  clearWatchTimers(state);
  if (state.options.watch) state.refreshTimer = setInterval(() => { if (isVisibleWorkspace(state)) void refreshIfChanged(state); }, WATCH_INTERVAL_MS);
  state.commentsTimer = setInterval(() => { if (isVisibleWorkspace(state)) syncCommentsFile(state); }, WATCH_INTERVAL_MS);
  syncCommentsFile(state);
}

// Only a window on screen is worth polling. A minimized one shows nothing while its --watch tick shells out
// to `git diff` over the whole worktree every second (issue #24). Every poller compares a signature, so a
// minimized window simply catches up on its first tick after it is restored.
function isVisibleWorkspace(state: WinState): boolean {
  return !state.win.isDestroyed() && !state.win.isMinimized();
}

// Reclaim a window's language servers once it has been minimized for a while. Arm the countdown when it
// leaves the screen and let it run, so a window genuinely parked for half an hour gives its fleet back.
function reconcileIdleSuspend(state: WinState | undefined): void {
  if (!state || state.win.isDestroyed()) return;
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

// Only the session's FIRST window gets the full-size startup mark; see loadingHtml.
let firstWindowBooted = false;
// Cold start: the first window's build depends on nothing the window provides — it is a git read and a render,
// in the worker, keyed by the CLI-resolved root. Kicked off the moment the app is ready (see whenReady) so the
// ~80ms Chromium spends constructing the BrowserWindow and the ~70ms it spends loading the boot mark run
// alongside it instead of in front of it. Claimed once, by the window that matches the root it was started for.
let pendingFirstBuild: Promise<BuildSnapshot> | undefined;
function claimPendingBuild(root: string): Promise<BuildSnapshot> | undefined {
  const pending = pendingFirstBuild;
  if (!pending || resolveWorkspaceRoot(root) !== options.root) return undefined;
  pendingFirstBuild = undefined;
  return pending;
}
// Paint the animated mark immediately, then build the (potentially heavy) review off the first paint and swap it
// in. Building before the window exists left the screen blank for the first few seconds of startup.
async function bootWindow(state: WinState, themeLight: boolean): Promise<void> {
  const compact = firstWindowBooted;
  firstWindowBooted = true;
  // A packaged .app (double-clicked) can launch with no useful cwd repo. Show the welcome screen (an Open
  // Folder button) instead of an empty diff. New windows always get a validated repo.
  const welcome = app.isPackaged && !isGitRepository(state.options.root);
  // Start the build BEFORE the loading document, not after it. It runs in the worker and needs nothing from
  // the window, so the ~75ms Chromium spends loading and painting the mark is build time that was previously
  // spent waiting — and the 60ms "let the animation get a few frames" delay that used to sit between them
  // was paying off a synchronous main-thread build that no longer exists.
  //
  // Diff-first: this build paints the diff + changed-file sources; the full project index is materialized on
  // demand (ensureFullProjectIndex) so a large tree's enumeration never blocks first paint.
  if (!welcome) state.commentsFile = commentsFilePath(state.options.root);
  const building = welcome ? null : buildReview(state, true, claimPendingBuild(state.options.root)).catch((error: unknown) => {
    // One window's build failure shouldn't take down the whole app (other windows may be fine); log and
    // leave this window on the loading mark rather than quitting.
    console.error(errorMessage(error));
    return null;
  });
  await state.win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(loadingHtml(themeLight, compact)));
  state.perf.mark("spinner-loaded"); // stable trace key retained for existing performance histories
  if (welcome) { void showWelcome(state); return; }
  try {
    const firstBuild = await building;
    // Window closed mid-build, or superseded. Its closed handler already tore down state, so loading here is
    // wasted and (critically) arming the watch timer below would re-create an interval nothing will clear.
    if (!firstBuild || state.win.isDestroyed()) return;
    state.signature = firstBuild.signature;
    preferences.recordRecentProject(state.options.root); // remember the launched/new-window repo for the welcome screen
    restoreCompareRef(state);
    await state.win.loadFile(reviewPath(state.options.root));
    // ⌘0/⌘1 (and the other in-view shortcuts) are renderer keydown handlers, so they only fire while the page
    // holds keyboard focus. loadFile swaps the page out from under whatever had it, leaving the freshly
    // painted review looking ready but ignoring its own shortcuts until the user clicks into it.
    if (!state.win.isDestroyed()) state.win.webContents.focus();
    armWatchTimers(state);
  } catch (error) {
    console.error(errorMessage(error));
  }
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
  state.bodies = snapshot.bodies;
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
async function buildReview(state: WinState, deferFullIndex = false, inFlight?: Promise<BuildSnapshot>): Promise<BuildSnapshot | null> {
  const seq = ++state.buildSeq;
  const started = performance.now();
  state.perf.mark("review-build-start");
  let snapshot: BuildSnapshot;
  try {
    snapshot = await (inFlight ?? reviewBuilder.build(reviewPath(state.options.root), state.options, APP_TITLE, deferFullIndex));
  } catch (error) {
    console.error(errorMessage(error));
    return null;
  }
  if (state.win.isDestroyed() || seq !== state.buildSeq) return null; // window closed, or a newer build won
  // workerMs is wall-clock WAITED on the worker (the main loop was free the whole time); mainBlockMs is the
  // only stretch the main loop was actually blocked — the snapshot handoff. The old sync build blocked main
  // for the entire workerMs, so this split is what makes the off-main win legible in the trace.
  //
  // On a cold start the build was already started at app-ready (pendingFirstBuild), so this figure is the
  // REMAINDER of it — the part that outlasted window creation, not the build's own cost. That is the number
  // worth watching: it is what the reader is still waiting for.
  const workerMs = Math.round((performance.now() - started) * 10) / 10;
  const applyStarted = performance.now();
  applySnapshot(state, snapshot);
  state.perf.mark("review-build-complete", {
    workerMs,
    mainBlockMs: Math.round((performance.now() - applyStarted) * 10) / 10,
    sourceFiles: state.sourceFiles.size,
    diffBodies: reviewBodyCount(state.bodies),
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
  restoreCompareRef(state);
  state.lastDiffSig = ""; // new repo -> force the next watch tick to rebuild
  clearWatchTimers(state); // stop the previous repo's pollers before switching this window to the new repo
  state.commentsFile = commentsFilePath(state.options.root); // new repo -> that worktree's own thread
  state.commentsSig = undefined;
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
  const root = await pickRepo(BrowserWindow.getFocusedWindow() ?? undefined, state.options.root);
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
    dialog.showErrorBox(t("dialog.notGit.title"), t("dialog.notGit.message", { path: root }));
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
