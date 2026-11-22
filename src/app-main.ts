import { appendFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, watch as watchFs, writeFileSync } from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from "electron";
import type { WebContents } from "electron";
import { git, gitAsync, isBranchRef, isCommitSha, isGitRepository, isLinkedWorktree, resolveWorkspaceRoot, validateReviewBase } from "./git.js";
import { renderWelcomeHtml } from "./render.js";
import { makeTranslator, normalizeLocale, type Locale } from "./i18n.js";
import { relaunchUpdatedApp, selfUpdateInstallAttempts } from "./self-update.js";
import { bundlePathFor, installPackagedUpdate, isNewerVersion, macDmgAsset } from "./app-update.js";
import { openSymbolCache } from "./analysis-cache.js";
import { reclaimServerCaches, RECLAIM_UNUSED_DAYS } from "./server-cache.js";
import { ProjectAnalysis } from "./analysis.js";
import { ReviewPerformanceTrace } from "./perf.js";
import type { SourceFile, WhitespaceMode } from "./types.js";
import { repositorySymbolCacheFile, workspaceDataDirectory, workspaceReviewFile } from "./workspace-data.js";
import { kakapoIconCssVariable, kakapoIconHtml } from "./brand.js";
import { reviewBodyCount, reviewDiffSignature } from "./review-bodies.js";
import { ReviewBuilder, type BuildSnapshot } from "./review-builder.js";
import { resolveReadMark, usableCompareBase } from "./patch-sets.js";
import { handoffRoot } from "./handoff.js";
import { fetchPullRequest, localRevisionFor, lookupPullRequest, parsePullRequestRef, remoteSlug } from "./github-pr.js";
import { decideWatchTick, shouldPushUpdate } from "./watch-decision.js";
import { compareSelectionFor, parseReviewArgs, readOption, runtimeArgv } from "./cli-args.js";
import { ByteBudgetCache, errorMessage, escapeAttr, escapeHtml } from "./util.js";
import { AppPreferences } from "./app-preferences.js";
import { compareDefaultRef, registerReviewIpc } from "./app-review-ipc.js";
import { registerSettingsIpc } from "./app-settings-ipc.js";
import { externalUrl, registerProjectPathIpc } from "./app-path-ipc.js";
import { registerCommentsIpc, syncCommentsFile, attachThreadFiles } from "./comments-file.js";
import type { CommentsIpcState } from "./comments-file.js";
import { installWindowSurfaceRecovery } from "./window-layout.js";
import { UI_SCALES } from "./constants.js";
import { electronAcceleratorFor, setShortcutOverrides } from "./shortcuts.js";
import { applyLaunchOnly, withoutLaunchOnly } from "./launch-options.js";

type AppOptions = {
  root: string;
  base?: string;
  baseLabel?: string;
  openPath?: string;
  pullRequest?: string;
  explicitRoot: boolean;
  target?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  watch: boolean;
  ignoreWhitespace: boolean;
  whitespace: WhitespaceMode;
};

const DIFF_CONTEXT_CHOICES = [3, 12, 50, 100_000] as const;

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

type WinState = Omit<CommentsIpcState, "win" | "options"> & {
  win: ReviewSurface;
  options: AppOptions;
  signature: string;
  refreshing: boolean;
  refreshTimer?: NodeJS.Timeout;
  analysisWarmTimer?: NodeJS.Timeout;
  commentsTimer?: NodeJS.Timeout;
  bodies: { file: string; offsets: number[] };
  bodyCache: ByteBudgetCache<string>;
  sourceFiles: Map<string, SourceFile>;
  analysis: ProjectAnalysis;
  analysisSuspended: boolean;
  viewReleased: boolean;
  idleTimer?: NodeJS.Timeout;
  bootStarted: boolean;
  perf: ReviewPerformanceTrace;
  lastDiffSig: string;
  lastFocusedAt: number;
  compareTip: boolean;
  reviewBase?: string;
  reviewTarget?: string;
  compareScope?: { sha: string; shortSha: string; subject: string; date: string }[];
  compareRef?: string;
  reviewUpstream?: string;
  fullIndexPending?: boolean;
  ensureFullIndex?: () => Promise<void>;
  fullIndexInFlight?: Promise<void>;
  buildSeq: number;
  disposeWindowSurfaceRecovery: () => void;
};

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
const BODY_CACHE_BYTES = 64_000_000;
const ANALYSIS_IDLE_SUSPEND_MS = 30 * 60_000;

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
</style></head><body><span class="kakapo-loader" role="status" aria-label="${escapeAttr(tr()("app.loading"))}">${mark}<span class="sr-only">${escapeHtml(tr()("app.loading"))}</span></span></body></html>`;
}
type ThemePreference = "light" | "dark";
function themePreference(): ThemePreference {
  try {
    const value = preferences.readGlobal()["kakapo-theme"];
    return value === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
function isLightTheme(): boolean {
  return themePreference() === "light";
}
function syncNativeThemeSource(): void {
  try { nativeTheme.themeSource = themePreference(); } catch { }
}
function currentLocale(): Locale {
  try { return normalizeLocale(preferences.readGlobal()["kakapo-locale"]); } catch { return "en"; }
}
function tr(): (key: string, vars?: Record<string, string | number>) => string {
  return makeTranslator(currentLocale());
}

app.setName(APP_NAME);
if (DEV_BUILD) app.setPath("userData", join(app.getPath("userData"), "dev"));
function keepHarnessWindowPaintingWhileOccluded(remoteDebuggingPort: string): void {
  app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}
if (process.env.KAKAPO_REMOTE_DEBUG) keepHarnessWindowPaintingWhileOccluded(process.env.KAKAPO_REMOTE_DEBUG);
protocol.registerSchemesAsPrivileged([{
  scheme: "kakapo-asset",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const iconPath = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon.png");
function windowIconExceptWhereTheBundleSuppliesIt(): string | undefined {
  return process.platform === "darwin" ? undefined : iconPath;
}
const windowIcon = windowIconExceptWhereTheBundleSuppliesIt();
const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.cjs");

const options = parseArgs(runtimeArgv(process.argv, app.isPackaged));
const hasSingleInstanceLock = app.requestSingleInstanceLock({ workspaceRoot: options.root, explicitRoot: options.explicitRoot });
const states = new Map<number, WinState>();
const reviewBuilder = new ReviewBuilder();
let quitConfirmed = false;
function isReviewableFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function belongsInRecentProjects(path: string): boolean {
  return isReviewableFolder(path) && !isLinkedWorktree(path);
}

const preferences = new AppPreferences(app.getPath("userData"), belongsInRecentProjects);

if (!existsSync(options.root)) {
  throw new Error(`Repository path does not exist: ${options.root}`);
}

function stateFromEvent(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): WinState | undefined {
  return states.get(event.sender.id);
}
function focusedOrLoneWindowState(): WinState | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) {
    for (const state of states.values()) {
      if (!state.win.isDestroyed() && state.win.webContents.id === focused.webContents.id) return state;
    }
  }
  const live = Array.from(states.values()).filter((state) => !state.win.isDestroyed());
  return live.length === 1 ? live[0] : undefined;
}
function sendToFocused(channel: string, payload?: unknown): void {
  const state = focusedOrLoneWindowState();
  if (state && !state.win.isDestroyed()) state.win.webContents.send(channel, payload);
}

registerReviewIpc(ipcMain, stateFromEvent, app.getPath("userData"));
registerProjectPathIpc(ipcMain, shell, stateFromEvent);
registerCommentsIpc(ipcMain, stateFromEvent);
ipcMain.on("kakapo:clipboard-write", (_event, msg: { text?: unknown }) => {
  clipboard.writeText(typeof msg?.text === "string" ? msg.text : String(msg?.text ?? ""));
});
ipcMain.on("kakapo:clipboard-read", (event) => {
  try { event.returnValue = clipboard.readText(); } catch { event.returnValue = ""; }
});
const COMPARE_REF_KEY = "kakapo-compare-ref";
const COMPARE_TIP_KEY = "kakapo-compare-tip";
function setCompareTip(state: WinState, tip: boolean): void {
  state.compareTip = tip;
  preferences.setRendererSetting(state.options.root, COMPARE_TIP_KEY, tip);
}

function restoreCompareRef(state: WinState): void {
  const workspace = preferences.readWorkspace(state.options.root);
  const saved = workspace[COMPARE_REF_KEY];
  state.compareRef = typeof saved === "string" && saved ? saved : undefined;
  state.compareTip = false;
}
const UI_SCALE_KEY = "kakapo-ui-scale";
function uiScale(): number {
  const raw = Number(preferences.readGlobal()[UI_SCALE_KEY]);
  return Number.isFinite(raw) && raw >= 0.8 && raw <= 1.6 ? raw : 1;
}
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
  for (const state of states.values()) {
    if (!state.win.isDestroyed()) state.win.webContents.send("kakapo:ui-scale", next);
  }
}
function applyUiScale(target?: WebContents): void {
  const factor = uiScale();
  const set = (wc: WebContents | undefined): void => { if (wc && !wc.isDestroyed()) wc.setZoomFactor(factor); };
  if (target) { set(target); return; }
  for (const state of states.values()) set(state.win.webContents);
}

function refreshChrome(): void {
  syncNativeThemeSource();
  const light = isLightTheme();
  const payload = { theme: themePreference(), resolved: light ? "light" : "dark", locale: currentLocale() };
  buildApplicationMenu();
  for (const state of states.values()) {
    if (!state.win.isDestroyed()) state.win.webContents.send("kakapo:chrome", payload);
  }
}
registerSettingsIpc(ipcMain, preferences, stateFromEvent, (key, value) => {
  if (key === "kakapo-theme" || key === "kakapo-locale") refreshChrome();
  if (key === UI_SCALE_KEY) applyUiScale();
  if (READING_TOGGLE_KEYS.has(key)) buildApplicationMenu();
  if (key === SHORTCUT_OVERRIDES_KEY) { setShortcutOverrides(value); buildApplicationMenu(); }
});
ipcMain.handle("kakapo:set-review-base", async (event, payload: { ref?: unknown }) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const raw = typeof payload?.ref === "string" ? payload.ref.trim() : "";
  if (!raw) return { ok: false };
  try {
    if (raw === "auto") {
      state.options.base = undefined;
    } else {
      state.options.base = validateReviewBase(state.options.root, raw);
    }
    state.options.baseLabel = undefined;
    state.options.staged = false;
    setCompareTip(state, false);
    await rebuildAndPushUpdate(state, true);
    return { ok: true, activeBase: state.options.base ?? "auto" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
});

ipcMain.handle("kakapo:set-review-target", async (event, payload: { ref?: unknown }) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const raw = typeof payload?.ref === "string" ? payload.ref.trim() : "";
  if (!raw) return { ok: false };
  try {
    if (raw === "worktree") {
      state.options.target = undefined;
    } else {
      state.options.target = validateReviewBase(state.options.root, raw);
      state.options.staged = false;
    }
    await rebuildAndPushUpdate(state, true);
    return { ok: true, activeTarget: state.options.target ?? "worktree" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
});

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
    if (rawBase === "auto" || rawTarget === "worktree") state.compareScope = undefined;
    state.options.staged = false;
    setCompareTip(state, false);

    await rebuildAndPushUpdate(state, true);
    return { ok: true, activeBase: state.options.base ?? "auto", activeTarget: state.options.target ?? "worktree" };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
});

type PullRequestOpened =
  | { ok: true; number: number; title: string; base: string; head: string }
  | { ok: false; error: string; detail?: string; ref?: string };

async function openPullRequestIn(state: WinState, text: string): Promise<PullRequestOpened> {
  const root = state.options.root;
  const ref = parsePullRequestRef(text, remoteSlug(root));
  if (!ref) return { ok: false, error: "pr-unreadable" };
  const found = lookupPullRequest(root, ref);
  if (!found.ok) return { ok: false, error: found.error, detail: found.detail };

  const fetched = await fetchPullRequest(root, ref, found.details);
  let base: string | undefined;
  let head: string | undefined;
  if (fetched.ok) {
    ({ base, head } = fetched);
  } else {
    head = localRevisionFor(root, found.details.head, "local");
    base = localRevisionFor(root, found.details.base, "remote");
    if (!head) return { ok: false, error: fetched.error, detail: fetched.detail };
    if (!base) return { ok: false, error: "pr-base-missing", ref: found.details.base };
  }

  state.compareScope = undefined;
  state.compareRef = undefined;
  setCompareTip(state, false);
  state.options.staged = false;
  state.options.base = base;
  state.options.baseLabel = undefined;
  state.options.target = head;
  await rebuildAndPushUpdate(state, true);
  return { ok: true, number: ref.number, title: found.details.title, base, head };
}

ipcMain.handle("kakapo:open-pull-request", async (event, payload: { text?: unknown } | undefined) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false, error: "no-window" };
  try {
    return await openPullRequestIn(state, typeof payload?.text === "string" ? payload.text : "");
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
});

ipcMain.handle("kakapo:mark-read", async (event) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const head = git(state.options.root, ["rev-parse", "HEAD"]);
  if (!head) return { ok: false };
  preferences.setReadMark(state.options.root, head);
  return { ok: true, sha: head };
});

ipcMain.handle("kakapo:set-compare-mode", async (event, payload: { mode?: unknown; ref?: unknown }) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const mode = payload?.mode === "uncommitted" ? "uncommitted"
    : payload?.mode === "tip" ? "tip"
    : payload?.mode === "since" ? "since"
    : "all";
  const rawRef = typeof payload?.ref === "string" ? payload.ref.trim() : "";
  try {
    const sinceBase = mode === "since"
      ? resolveReadMark(state.options.root, preferences.readReadMark(state.options.root))?.sha
      : undefined;
    if (mode === "since" && !sinceBase) return { ok: false, error: "no-read-mark" };
    if (rawRef) {
      const picked = validateReviewBase(state.options.root, rawRef);
      state.compareRef = picked;
      preferences.setRendererSetting(state.options.root, COMPARE_REF_KEY, state.compareRef);
    }
    state.compareScope = undefined;
    state.options.target = undefined;
    state.options.staged = false;
    setCompareTip(state, mode === "tip");
    if (mode === "uncommitted") {
      state.options.base = "HEAD";
      state.options.baseLabel = undefined;
    } else if (mode === "since") {
      state.options.base = sinceBase;
      state.options.baseLabel = undefined;
    } else if (mode === "tip") {
      const ref = state.compareRef || compareDefaultRef(state.options.root);
      state.options.base = ref || undefined;
      state.options.baseLabel = ref || undefined;
    } else {
      const ref = state.compareRef || compareDefaultRef(state.options.root);
      state.options.base = (ref && usableCompareBase(state.options.root, ref)) || undefined;
      state.options.baseLabel = state.options.base ? ref : undefined;
    }
    await rebuildAndPushUpdate(state, true);
    return { ok: true, mode, ref: state.compareRef || compareDefaultRef(state.options.root) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
});

ipcMain.handle("kakapo:open-folder", async (event) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const root = await pickDirectory(BrowserWindow.getFocusedWindow() ?? undefined, state.options.root);
  if (!root) return { ok: false };
  if (!isReviewableFolder(root)) return { ok: false, error: "unopenable" };
  await openReview(state, root);
  return { ok: true };
});

ipcMain.handle("kakapo:open-recent", async (event, payload: { path?: string }) => {
  const state = stateFromEvent(event);
  const path = typeof payload?.path === "string" ? payload.path : "";
  if (!state || state.win.isDestroyed() || !path) return { ok: false };
  if (!preferences.readRecentProjects().some((project) => project.path === resolve(path))) {
    return { ok: false, error: "unknown" };
  }
  if (!isReviewableFolder(path)) {
    preferences.forgetRecentProject(path);
    return { ok: false, error: "missing" };
  }
  await openReview(state, path);
  return { ok: true };
});

function sendUpdateProgress(payload: { percent: number; done?: boolean }): void {
  for (const state of states.values()) {
    if (!state.win.isDestroyed()) state.win.webContents.send("kakapo:update-progress", payload);
  }
}

function downloadUpdateDmg(assetUrl: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  return new Promise((resolve) => {
    const work = mkdtempSync(join(tmpdir(), "kakapo-dmg-"));
    const target = join(work, "kakapo.dmg");
    const file = createWriteStream(target);
    const request = net.request({ url: assetUrl, redirect: "follow" });
    const fail = (error: string) => { try { file.destroy(); } catch { } sendUpdateProgress({ percent: 0, done: true }); resolve({ ok: false, error }); };
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
    return installPackagedUpdate({ dmgPath: downloaded.path, installed, quit: finishQuit });
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

ipcMain.handle("kakapo:self-update", (event) => {
  if (app.isPackaged && process.platform === "darwin") return updatePackagedApp();
  if (!app.isPackaged) return Promise.resolve({ ok: false, error: "running from source — update with git pull" });
  return updateGlobalCli(event);
});

const updateGlobalCli = (event: Electron.IpcMainInvokeEvent) => new Promise<{ ok: boolean; error?: string }>((resolve) => {
  const cwd = stateFromEvent(event)?.options.root ?? options.root;
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

function holdMenuAcceleratorsWhileThePageOwnsTheSameKeys(sender: Electron.WebContents, hold: boolean): void {
  sender.setIgnoreMenuShortcuts(hold);
}
ipcMain.on("kakapo:set-ignore-menu-shortcuts", (event, msg: { ignore?: boolean }) => {
  holdMenuAcceleratorsWhileThePageOwnsTheSameKeys(event.sender, !!(msg && msg.ignore));
});

if (hasSingleInstanceLock) app.on("second-instance", (_event, commandLine, workingDirectory, additionalData) => {
  const root = handoffRoot(
    { additionalData, commandLineRoot: () => readOption(commandLine, "--cwd"), workingDirectory },
    { reviewable: isReviewableFolder, gitRepository: isGitRepository },
  );
  if (!root) return;
  openOrFocusWorkspace(resolveWorkspaceRoot(root));
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
  console.error(`[kakapo] ${DEV_BUILD ? "DEV build" : "build"} — ${app.getAppPath()} (electron ${process.versions.electron})`);

  reviewBuilder.warmUp();

  preferences.pruneRecentProjects();

  syncNativeThemeSource();

  setShortcutOverrides(preferences.readGlobal()[SHORTCUT_OVERRIDES_KEY]);
  buildApplicationMenu();

  if (options.explicitRoot || isGitRepository(options.root)) {
    pendingFirstBuild = reviewBuilder.build(reviewPath(options.root), options, APP_TITLE, true);
    pendingFirstBuild.catch(() => {});
  }

  const first = createWindow(options.root, options.explicitRoot);
  applyLaunchOnly(first.options, options);
  setInterval(watchLspWeight, LSP_WATCHDOG_MS);
  setTimeout(() => {
    reclaimServerCaches().then((reclaimed) => {
      if (reclaimed.length) console.error(`[kakapo] reclaimed ${reclaimed.length} language-server caches unused for ${RECLAIM_UNUSED_DAYS} days`);
    }, () => { });
  }, SERVER_CACHE_RECLAIM_DELAY_MS).unref?.();
}).catch((error: unknown) => {
  console.error(errorMessage(error));
  app.quit();
});
else app.quit();

function finishQuit(): void {
  quitConfirmed = true;
  app.quit();
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("browser-window-focus", (_event, win) => {
  const state = states.get(win.id);
  if (!state) return;
  syncDiffMenu(state.options);
});

function syncDiffMenu(options: AppOptions): void {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const mode of ["none", "trim", "all"] as const) {
    const item = menu.getMenuItemById(`whitespace-${mode}`);
    if (item) item.checked = options.whitespace === mode;
  }
  for (const lines of DIFF_CONTEXT_CHOICES) {
    const item = menu.getMenuItemById(`diff-context-${lines}`);
    if (item) item.checked = options.context === lines;
  }
}

async function rebuildFocusedReview(change: (options: AppOptions) => void): Promise<void> {
  const state = focusedOrLoneWindowState();
  if (!state) return;
  change(state.options);
  syncDiffMenu(state.options);
  const build = await buildReview(state);
  if (!build || state.win.isDestroyed()) return;
  state.signature = build.signature;
  state.win.webContents.reloadIgnoringCache();
}

const SHORTCUT_OVERRIDES_KEY = "kakapo-shortcut-overrides";
const READING_TOGGLE_KEYS = new Set([
  "kakapo-show-whitespace", "kakapo-indent-guides", "kakapo-sticky-lines", "kakapo-focus-mode",
  "kakapo-code-vision", "kakapo-inlay-hints", "kakapo-essential-highlighting", "kakapo-align-changes",
]);

function readingToggleOn(key: string): boolean {
  const state = focusedOrLoneWindowState();
  try {
    const settings = state
      ? preferences.rendererSettings(state.options.root)
      : preferences.readGlobal();
    const value = settings[key];
    if (value === "1") return true;
    if (value === "0") return false;
  } catch { }
  return key === "kakapo-sticky-lines" || key === "kakapo-align-changes"
    || key === "kakapo-code-vision" || key === "kakapo-inlay-hints";
}

function buildApplicationMenu(): void {
  const t = tr();
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [];
  const readingItem = (id: string, index = 0): Electron.MenuItemConstructorOptions => ({
    label: t(`kbd.${id}`),
    accelerator: electronAcceleratorFor(id, index),
    registerAccelerator: false,
    click: () => sendToFocused("kakapo:reading-action", { id, index }),
  });
  const readingToggle = (id: string, key: string): Electron.MenuItemConstructorOptions => ({
    ...readingItem(id),
    type: "checkbox",
    checked: readingToggleOn(key),
  });

  if (process.platform === "darwin") menuTemplate.push({ role: "appMenu" });
  menuTemplate.push({
    label: t("menu.file"),
    submenu: [
      { label: t("menu.openFolder"), accelerator: "CommandOrControl+O", click: () => void openFolderInCurrent() },
      { label: t("menu.openNewWindow"), accelerator: "CommandOrControl+Shift+O", click: () => void openFolderInNewWindow() },
    ],
  });
  menuTemplate.push({ role: "editMenu" });
  menuTemplate.push({
    label: t("menu.review"),
    submenu: [
      { label: t("menu.allReviewComments"), accelerator: "Control+Command+Shift+/", click: () => sendToFocused("kakapo:merged-view") },
    ],
  });
  menuTemplate.push({
    label: t("menu.diff"),
    submenu: [
      ...(["none", "trim", "all"] as const).map((mode) => ({
        id: `whitespace-${mode}`,
        label: t(`menu.whitespace.${mode}`),
        type: "radio" as const,
        checked: options.whitespace === mode,
        click: () => void rebuildFocusedReview((current) => { current.whitespace = mode; }),
      })),
      { type: "separator" },
      ...DIFF_CONTEXT_CHOICES.map((lines) => ({
        id: `diff-context-${lines}`,
        label: lines >= 100_000 ? t("menu.context.wholeFile") : t("menu.context.lines", { n: lines }),
        type: "radio" as const,
        checked: options.context === lines,
        click: () => void rebuildFocusedReview((current) => { current.context = lines; }),
      })),
      {
        label: t("menu.whitespace.cycle"),
        visible: false,
        accelerator: "CommandOrControl+Shift+W",
        click: () => void rebuildFocusedReview((current) => {
          const order: WhitespaceMode[] = ["none", "trim", "all"];
          current.whitespace = order[(order.indexOf(current.whitespace) + 1) % order.length];
        }),
      },
      { type: "separator" },
      readingToggle("alignChanges", "kakapo-align-changes"),
      { type: "separator" },
      readingItem("diffFileStep", 0),
      readingItem("diffFileStep", 1),
      { type: "separator" },
      readingItem("copyAsPatch"),
      readingItem("compareClipboard"),
    ],
  });
  menuTemplate.push({
    label: t("menu.view"),
    submenu: [
      { label: t("menu.zoomIn"), accelerator: "CommandOrControl+=", click: () => stepUiScale(1) },
      { label: t("menu.zoomIn"), accelerator: "CommandOrControl+Plus", visible: false, click: () => stepUiScale(1) },
      { label: t("menu.zoomOut"), accelerator: "CommandOrControl+-", click: () => stepUiScale(-1) },
      { label: t("menu.zoomReset"), accelerator: "CommandOrControl+0", click: () => setUiScale(1) },
      { type: "separator" },
      readingToggle("showWhitespace", "kakapo-show-whitespace"),
      readingToggle("indentGuides", "kakapo-indent-guides"),
      readingToggle("stickyLines", "kakapo-sticky-lines"),
      readingToggle("focusMode", "kakapo-focus-mode"),
      readingToggle("codeVision", "kakapo-code-vision"),
      readingToggle("inlayHints", "kakapo-inlay-hints"),
      readingToggle("essentialHighlighting", "kakapo-essential-highlighting"),
      { type: "separator" },
      {
        label: t("menu.folding"),
        submenu: [
          readingItem("toggleFold"),
          readingItem("collapseAll"),
          readingItem("expandAll"),
          readingItem("collapseRecursively"),
        ],
      },
    ],
  });
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

const LSP_FLEET_BUDGET_MB = 900;
const LSP_TOTAL_BUDGET_MB = 2400;
const SERVER_CACHE_RECLAIM_DELAY_MS = 20_000;
const LSP_WATCHDOG_MS = 5 * 60_000;
const LSP_WEIGHT_EXEMPT_FAMILIES = new Set(["kotlin"]);

function recycleFleet(state: WinState, why: string): void {
  console.log(`kakapo: language servers for ${state.options.root} ${why} — recycling the fleet`);
  state.analysis.dispose();
  if (isVisibleWorkspace(state)) {
    state.analysis = makeAnalysis(state.options.root, () => state);
    scheduleAnalysisPrewarm(state);
  } else {
    state.analysisSuspended = true;
  }
}

function watchLspWeight(): void {
  const fleets: { state: WinState; pids: number[]; weighed: number[] }[] = [];
  for (const state of states.values()) {
    if (state.win.isDestroyed() || state.analysisSuspended) continue;
    const servers = state.analysis.serverPids();
    if (!servers.length) continue;
    fleets.push({
      state,
      pids: servers.map(({ pid }) => pid),
      weighed: servers.filter(({ family }) => !LSP_WEIGHT_EXEMPT_FAMILIES.has(family)).map(({ pid }) => pid),
    });
  }
  if (!fleets.length) return;
  const everyPid = [...new Set(fleets.flatMap((fleet) => fleet.pids))];
  execFile("ps", ["-o", "pid=,rss=", "-p", everyPid.join(",")], { encoding: "utf8" }, (error, stdout) => {
    if (error && !stdout) return; // ps exits non-zero when some pids are already gone; partial output still counts
    const mbByPid = new Map<number, number>();
    for (const line of String(stdout ?? "").split("\n")) {
      const [pid, rss] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(pid) && Number.isFinite(rss)) mbByPid.set(pid, rss / 1024);
    }
    const sum = (pids: number[]) => pids.reduce((total, pid) => total + (mbByPid.get(pid) ?? 0), 0);
    const live = fleets.filter((fleet) => !fleet.state.win.isDestroyed() && !fleet.state.analysisSuspended);

    const remaining: typeof live = [];
    for (const fleet of live) {
      if (sum(fleet.weighed) >= LSP_FLEET_BUDGET_MB) recycleFleet(fleet.state, `hit ${Math.round(sum(fleet.weighed))}MB`);
      else remaining.push(fleet);
    }

    let total = remaining.reduce((mb, fleet) => mb + sum(fleet.pids), 0);
    if (total < LSP_TOTAL_BUDGET_MB) return;
    const inFront = remaining.reduce<typeof remaining[number] | undefined>(
      (newest, fleet) => (!newest || fleet.state.lastFocusedAt > newest.state.lastFocusedAt ? fleet : newest), undefined);
    const coldestFirst = remaining
      .filter((fleet) => fleet !== inFront)
      .sort((a, b) => a.state.lastFocusedAt - b.state.lastFocusedAt);
    for (const fleet of coldestFirst) {
      if (total < LSP_TOTAL_BUDGET_MB) break;
      const mb = sum(fleet.pids);
      recycleFleet(fleet.state, `cold, and all fleets together held ${Math.round(total)}MB`);
      total -= mb;
    }
  });
}

function makeAnalysis(root: string, getState: () => WinState | undefined): ProjectAnalysis {
  const analysis = new ProjectAnalysis(root, {
    symbolCache: openSymbolCache(symbolCacheFile(root)),
    onStatus: (status) => {
      const state = getState();
      if (!state || state.win.isDestroyed()) return;
      state.win.webContents.send("kakapo:analysis-status", status);
      const cache = analysis.symbolCacheStats();
      state.perf.mark("analysis-status", {
        generation: status.generation,
        phase: status.phase,
        server: status.server ?? "",
        source: status.serverSource ?? "",
        cacheHits: cache?.hits ?? 0,
        cacheMisses: cache?.misses ?? 0,
        indexedFiles: status.indexedFiles ?? 0,
        reusedFiles: status.reusedFiles ?? 0,
      });
    },
  });
  return analysis;
}

function symbolCacheFile(root: string): string {
  return repositorySymbolCacheFile(app.getPath("userData"), root);
}

function createWindow(root: string, explicitRoot = true): WinState {
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
    options: makeOptions(root, explicitRoot),
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
    lastFocusedAt: Date.now(),
    compareTip: false,
    reviewBase: undefined,
    reviewUpstream: undefined,
    disposeWindowSurfaceRecovery: () => {},
  };
  state.ensureFullIndex = () => ensureFullProjectIndex(state);
  const id = win.webContents.id;
  states.set(id, state);

  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: "deny" };
  });
  const allowedNavigation = (url: string): boolean =>
    url.startsWith("file://") || url.startsWith("data:text/html") || url.startsWith("kakapo-asset://");
  const blockForeignNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (!allowedNavigation(url)) event.preventDefault();
  };
  win.webContents.on("will-navigate", blockForeignNavigation);
  win.webContents.on("will-redirect", blockForeignNavigation);
  if (DEV_BUILD) {
    win.webContents.on("console-message", ({ message }) => {
      process.stdout.write(`[renderer] ${message}\n`);
    });
  }
  win.webContents.on("did-finish-load", () => {
    const url = win.webContents.getURL();
    const document = url.startsWith("data:") ? "loading" : url.includes(REVIEW_FILE) ? "review" : "welcome";
    state.perf.mark("document-loaded", { document });
    scheduleAnalysisPrewarm(state);
  });
  win.webContents.once("did-finish-load", () => {
    if (DEV_BUILD && !process.env.KAKAPO_NO_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });
  });
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.maximize();
    win.show();
  });
  win.on("focus", () => { state.lastFocusedAt = Date.now(); });
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

function clearWatchTimers(state: WinState): void {
  if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = undefined; }
  if (state.commentsTimer) { clearInterval(state.commentsTimer); state.commentsTimer = undefined; }
}

function armWatchTimers(state: WinState): void {
  clearWatchTimers(state);
  if (state.options.watch) state.refreshTimer = setInterval(() => { if (isVisibleWorkspace(state)) void refreshIfChanged(state); }, WATCH_INTERVAL_MS);
  state.commentsTimer = setInterval(() => { if (isVisibleWorkspace(state)) syncCommentsFile(state); }, WATCH_INTERVAL_MS);
  syncCommentsFile(state);
}

function isVisibleWorkspace(state: WinState): boolean {
  return !state.win.isDestroyed() && !state.win.isMinimized();
}

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
    state.viewReleased = true;
    if (state.bootStarted && !state.win.isDestroyed()) state.win.webContents.send("kakapo:release-view");
  }, ANALYSIS_IDLE_SUSPEND_MS);
  state.idleTimer.unref?.();
}

let firstWindowBooted = false;
let pendingFirstBuild: Promise<BuildSnapshot> | undefined;
function claimPendingBuild(root: string): Promise<BuildSnapshot> | undefined {
  const pending = pendingFirstBuild;
  if (!pending || resolveWorkspaceRoot(root) !== options.root) return undefined;
  pendingFirstBuild = undefined;
  return pending;
}
async function bootWindow(state: WinState, themeLight: boolean): Promise<void> {
  const compact = firstWindowBooted;
  firstWindowBooted = true;
  const welcome = !state.options.explicitRoot && !isGitRepository(state.options.root);
  if (!welcome) attachThreadFiles(state, state.options.root);
  let buildFailure = "";
  const building = welcome ? null : buildReview(state, true, claimPendingBuild(state.options.root)).catch((error: unknown) => {
    buildFailure = errorMessage(error);
    console.error(buildFailure);
    return null;
  });
  await state.win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(loadingHtml(themeLight, compact)));
  state.perf.mark("spinner-loaded");
  if (welcome) { void showWelcome(state); return; }
  try {
    const firstBuild = await building;
    if (state.win.isDestroyed()) return;
    if (!firstBuild) {
      if (buildFailure) await reportBuildFailure(state, buildFailure);
      return;
    }
    state.signature = firstBuild.signature;
    preferences.recordRecentProject(state.options.root);
    restoreCompareRef(state);
    await state.win.loadFile(reviewPath(state.options.root));
    if (!state.win.isDestroyed()) state.win.webContents.focus();
    armWatchTimers(state);
    await openRequestedPullRequest(state);
  } catch (error) {
    console.error(errorMessage(error));
  }
}

async function openRequestedPullRequest(state: WinState): Promise<void> {
  const requested = state.options.pullRequest;
  if (!requested) return;
  state.options.pullRequest = undefined;
  const opened = await openPullRequestIn(state, requested).catch((error: unknown) => {
    return { ok: false as const, error: errorMessage(error) };
  });
  if (opened.ok) return;
  console.error(`[kakapo] ${requested} could not be opened: ${opened.error}${"detail" in opened && opened.detail ? ` — ${opened.detail}` : ""}`);
  if (!state.win.isDestroyed()) state.win.webContents.send("kakapo:pull-request-failed", opened);
}

async function rebuildAndPushUpdate(state: WinState, force = false): Promise<void> {
  const prevSignature = state.signature;
  const snapshot = await buildReview(state, false);
  if (!snapshot) return;
  if (!force && !shouldPushUpdate(prevSignature, snapshot.signature)) return;
  state.signature = snapshot.signature;
  if (snapshot.update && !state.win.isDestroyed()) state.win.webContents.send("kakapo:diff-update", snapshot.update);
  scheduleAnalysisPrewarm(state);
}

async function refreshIfChanged(state: WinState): Promise<void> {
  if (state.refreshing || state.win.isDestroyed()) return;
  state.refreshing = true;
  try {
    const diffSig = reviewDiffSignature(state.options, state.reviewBase, state.reviewUpstream);
    const decision = decideWatchTick(state.lastDiffSig, diffSig);
    if (decision.action === "skip") return;
    state.lastDiffSig = decision.diffSig;
    await rebuildAndPushUpdate(state);
  } catch (error) {
    console.error(errorMessage(error));
  } finally {
    state.refreshing = false;
  }
}

function applySnapshot(state: WinState, snapshot: BuildSnapshot): void {
  state.lastDiffSig = snapshot.watchSignature;
  state.reviewBase = snapshot.reviewBase;
  state.reviewTarget = snapshot.reviewTarget;
  state.analysis.setReviewTarget(snapshot.reviewTarget);
  state.reviewUpstream = snapshot.reviewUpstream;
  state.bodies = snapshot.bodies;
  state.bodyCache.clear();
  state.sourceFiles = new Map(snapshot.sourceFiles.map((file) => [file.path, file]));
  state.fullIndexPending = snapshot.fullIndexDeferred;
  if (snapshot.fullIndexDeferred) state.analysis.invalidate();
  else void state.analysis.syncIndex(snapshot.sourceFiles).then(
    (outcome) => state.perf.mark("analysis-index-sync", { outcome, files: snapshot.sourceFiles.length }),
    () => state.analysis.invalidate(),
  );
}

async function buildReview(state: WinState, deferFullIndex = false, inFlight?: Promise<BuildSnapshot>): Promise<BuildSnapshot | null> {
  const seq = ++state.buildSeq;
  const started = performance.now();
  state.perf.mark("review-build-start");
  let snapshot: BuildSnapshot;
  try {
    snapshot = await (inFlight ?? reviewBuilder.build(reviewPath(state.options.root), state.options, APP_TITLE, deferFullIndex));
    state.options.openPath = undefined;
  } catch (error) {
    console.error(errorMessage(error));
    return null;
  }
  if (state.win.isDestroyed() || seq !== state.buildSeq) return null;
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

function ensureFullProjectIndex(state: WinState): Promise<void> {
  if (!state.fullIndexPending) return Promise.resolve();
  if (state.fullIndexInFlight) return state.fullIndexInFlight;
  const started = performance.now();
  state.fullIndexInFlight = reviewBuilder.index(state.options, state.reviewBase, state.reviewTarget)
    .then((full) => {
      if (state.win.isDestroyed() || !state.fullIndexPending) return;
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

async function showWelcome(state: WinState): Promise<void> {
  if (state.win.isDestroyed()) return;
  const welcomePath = join(app.getPath("userData"), "welcome.html");
  mkdirSync(dirname(welcomePath), { recursive: true });
  const recent = preferences.readRecentProjects().filter((p) => existsSync(p.path));
  writeFileSync(welcomePath, renderWelcomeHtml(isLightTheme(), recent, tr(), currentLocale()));
  await state.win.loadFile(welcomePath);
}

async function reportBuildFailure(state: WinState, message: string): Promise<void> {
  if (state.win.isDestroyed()) return;
  const t = tr();
  dialog.showErrorBox(t("dialog.buildFailed.title"), t("dialog.buildFailed.message", { path: state.options.root, error: message }));
  await showWelcome(state);
}

async function openReview(state: WinState, root: string): Promise<void> {
  if (state.analysisWarmTimer) { clearTimeout(state.analysisWarmTimer); state.analysisWarmTimer = undefined; }
  state.analysis.dispose();
  const previousRoot = state.options.root;
  state.options.root = resolve(root);
  Object.assign(state.options, compareSelectionFor(resolveWorkspaceRoot(previousRoot), resolveWorkspaceRoot(state.options.root), state.options));
  state.perf = new ReviewPerformanceTrace(state.options.root, app.getPath("userData"));
  state.perf.mark("review-opened");
  state.analysis = makeAnalysis(state.options.root, () => state);
  preferences.recordRecentProject(state.options.root);
  restoreCompareRef(state);
  clearWatchTimers(state);
  attachThreadFiles(state, state.options.root);
  let switchFailure = "";
  const build = await buildReview(state, true).catch((error: unknown) => {
    switchFailure = errorMessage(error);
    console.error(switchFailure);
    return null;
  });
  if (!build) {
    if (switchFailure) await reportBuildFailure(state, switchFailure);
    return;
  }
  state.signature = build.signature;
  if (!state.win.isDestroyed()) await state.win.loadFile(reviewPath(state.options.root));
  armWatchTimers(state);
}

async function openFolderInCurrent(): Promise<void> {
  const state = focusedOrLoneWindowState();
  if (!state) return;
  const root = await pickRepo(BrowserWindow.getFocusedWindow() ?? undefined, state.options.root);
  if (root) await openReview(state, root);
}
async function openFolderInNewWindow(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const root = await pickRepo(parent, focusedOrLoneWindowState()?.options.root);
  if (root) createWindow(root);
}
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

async function pickRepo(parent: BrowserWindow | undefined, defaultPath?: string): Promise<string | undefined> {
  const root = await pickDirectory(parent, defaultPath);
  if (!root) return undefined;
  if (!isReviewableFolder(root)) {
    const t = tr();
    dialog.showErrorBox(t("dialog.unopenable.title"), t("dialog.unopenable.message", { path: root }));
    return undefined;
  }
  return resolveWorkspaceRoot(root);
}

function makeOptions(root: string, explicitRoot = true): AppOptions {
  const resolved = resolveWorkspaceRoot(root);
  const compare = compareSelectionFor(resolveWorkspaceRoot(options.root), resolved, options);
  return withoutLaunchOnly({ ...options, ...compare, root: resolved, explicitRoot });
}

function parseArgs(args: string[]): AppOptions {
  const parsed = parseReviewArgs(args);
  const requestedRoot = resolve(parsed.requestedCwd ?? process.cwd());
  const root = isGitRepository(requestedRoot) ? resolveWorkspaceRoot(requestedRoot) : requestedRoot;
  const base = parsed.baseValue !== undefined && isGitRepository(root)
    ? validateReviewBase(root, parsed.baseValue)
    : parsed.baseValue;
  const openPath = parsed.openPath ? relative(root, resolve(parsed.openPath)).replace(/\\/g, "/") : undefined;
  return {
    root,
    base,
    baseLabel: parsed.baseValue && isGitRepository(root) && isBranchRef(root, parsed.baseValue)
      ? parsed.baseValue
      : undefined,
    staged: parsed.staged,
    includeUntracked: parsed.includeUntracked,
    context: parsed.context,
    watch: parsed.watch,
    ignoreWhitespace: parsed.ignoreWhitespace,
    whitespace: parsed.whitespace,
    openPath: openPath && !openPath.startsWith("..") ? openPath : undefined,
    pullRequest: parsed.pullRequest,
    explicitRoot: parsed.openedExplicitly || parsed.openPath !== undefined,
  };
}
