import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, shell } from "electron";
import { buildDiffReview, performHttpRequest, renderLazyDiffBody, type HttpSendRequest } from "./cli.js";
import { readGitLog, readGitLineLog, readCommitDiff } from "./git-log.js";
import { materializeDeferredSourceFile, readUnifiedDiff } from "./diff.js";
import { git, isGitRepository } from "./git.js";
import { renderWelcomeHtml } from "./render.js";
import { relaunchUpdatedApp, selfUpdateInstallAttempts } from "./self-update.js";
import { searchProject } from "./search.js";
import { ProjectAnalysis, type AnalysisRequest } from "./analysis.js";
import { ReviewPerformanceTrace } from "./perf.js";
import { ProjectMarkdownMemo } from "./memos.js";
import { readReviewDiffContext, type DiffContextRequest } from "./diff-context.js";
import type { ProjectIndexPayload, SourceFile } from "./types.js";
import { createHash } from "node:crypto";
import { migrateLegacyProjectData, workspaceDataDirectory, workspaceReviewFile } from "./workspace-data.js";

type AppOptions = {
  root: string;
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  watch: boolean;
  ignoreWhitespace: boolean;
};

// Per-window state. Everything that used to be a module-level global (the review signature, watch timer,
// lazily-served diff bodies/source, and last-diff hash) now lives here, keyed
// by BrowserWindow.id, so two windows reviewing different repos don't trample each other's state.
type WinState = {
  win: BrowserWindow;
  options: AppOptions; // this window's repo + diff flags (root + ignoreWhitespace are per-window)
  signature: string;
  refreshing: boolean;
  refreshTimer?: NodeJS.Timeout;
  analysisWarmTimer?: NodeJS.Timeout;
  bodyDiffs: string[]; // Phase 2 lazy-LOAD: raw per-file diffs rendered for THIS window's renderer on demand
  bodyCache: Map<number, string>; // rendered per-file diff bodies, scoped to the current build
  sourceFiles: Map<string, SourceFile>; // source content stays in main; renderer requests one open file at a time
  analysis: ProjectAnalysis; // LSP-first project analysis + main-process regex fallback
  perf: ReviewPerformanceTrace; // local startup/analysis evidence under this workspace's app-data mirror
  lastDiffSig: string; // watch fast-path: hash of the last git diff, to skip rebuilds when unchanged
  reviewBase?: string; // exact base used by the latest build (may be an automatic upstream merge-base)
  reviewUpstream?: string; // tracking ref behind an automatic base; included in the watch signature
};

// `npm run dev` sets MONACORI_DEV=1 so a locally-built app announces itself — a window-title suffix
// plus a boot log with its on-disk path — making it obvious whether `mo` launched THIS checkout or
// the globally-installed package (their version numbers can be identical; the path is the tell).
const DEV_BUILD = process.env.MONACORI_DEV === "1";
const APP_NAME = "Monacori";
const APP_TITLE = DEV_BUILD ? `${APP_NAME} (dev)` : APP_NAME;
const REVIEW_FILE = "app-review.html";
const WATCH_INTERVAL_MS = 1000;
const ANALYSIS_PREWARM_DELAY_MS = 350;

// Painted immediately while the first review build + HTML render run, so startup shows a spinner instead
// of a blank window. Inlined as a data: URL so it needs no file on disk and appears before any review
// work. Theme-aware so a light-theme user doesn't get a dark flash before the renderer applies the theme.
function loadingHtml(light: boolean): string {
  const bg = light ? "#ffffff" : "#2b2b2b";
  const fg = light ? "#6e7781" : "#9aa4af";
  const ring = light ? "#d0d7de" : "#3a3a3a";
  const accent = light ? "#0969da" : "#4a9eff";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100vh;background:${bg};color:${fg};display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:18px;
    font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .s{width:34px;height:34px;border:3px solid ${ring};border-top-color:${accent};border-radius:50%;
    animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="s"></div><div>monacori</div></body></html>`;
}
// The persisted theme (set by the renderer via monacoriSettings). Read at startup so the native window
// chrome + loading screen match before the renderer boots. Defaults to dark.
function isLightTheme(): boolean {
  try {
    return readSettings()["monacori-theme"] === "light";
  } catch {
    return false;
  }
}

app.setName(APP_NAME);
// The lazy Markdown editor cannot reliably load from the repository's file:// review. A narrow, read-only
// standard scheme serves only production assets copied under the historical dist/monaco directory.
protocol.registerSchemesAsPrivileged([{
  scheme: "monacori-asset",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);
// Never patch or rename Electron.app from inside the running Electron process. The CLI launcher performs
// that repair synchronously before spawning Electron (and postinstall handles the normal install path).
// Mutating the live bundle during macOS didFinishLaunching can terminate Chromium with SIGTRAP.

const iconPath = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon.png");
const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.cjs");

// Development argv is `[electron, app-main.js, ...flags]`; a packaged app is
// `[Monacori, ...flags]`. Dropping two entries unconditionally erased `--cwd` from the installed app,
// so scripted relaunches landed on the welcome/recent-project screen instead of the requested folder.
const runtimeArgs = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
const options = parseArgs(runtimeArgs);
const states = new Map<number, WinState>();
let markdownMemo: ProjectMarkdownMemo | undefined;

if (!existsSync(options.root)) {
  throw new Error(`Repository path does not exist: ${options.root}`);
}

// Resolve the WinState for an IPC call by mapping its sender back to a window — this is how get-file /
// source/analysis requests are routed to the right window's state instead of a shared global.
function stateFromEvent(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): WinState | undefined {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? states.get(win.id) : undefined;
}
function focusedState(): WinState | undefined {
  const win = BrowserWindow.getFocusedWindow();
  return win ? states.get(win.id) : undefined;
}
// Menu accelerators are application-global, so they act on whichever window is focused.
function sendToFocused(channel: string, payload?: unknown): void {
  const win = BrowserWindow.getFocusedWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function memoStore(): ProjectMarkdownMemo {
  if (!markdownMemo) markdownMemo = new ProjectMarkdownMemo(app.getPath("userData"));
  return markdownMemo;
}

function readMemoWithLegacyImport(root: string) {
  let document = memoStore().read(root);
  if (document.body) return document;
  const settings = readSettings();
  const legacy = settings["monacori-memo"];
  if (typeof legacy !== "string" || !legacy.trim() || settings["monacori-memo-migrated-worktree"]) return document;
  document = memoStore().write(root, legacy);
  delete settings["monacori-memo"];
  settings["monacori-memo-migrated-worktree"] = document.worktreePath;
  writeSettings(settings);
  return document;
}

ipcMain.handle("monacori:http-send", (_event, request: HttpSendRequest) => performHttpRequest(request));

// Phase 2 lazy-LOAD: serve a single file's diff body to the calling window's renderer on demand. Retained
// from that window's most recent writeReviewFile() build so navigation/scroll can materialize bodies.
ipcMain.handle("monacori:get-file", (event, request: { index?: number }) => {
  const state = stateFromEvent(event);
  if (!state) return "";
  const i = Number(request?.index);
  if (!Number.isInteger(i) || i < 0 || i >= state.bodyDiffs.length) return "";
  const cached = state.bodyCache.get(i);
  if (cached !== undefined) return cached;
  const body = renderLazyDiffBody(state.bodyDiffs[i]);
  state.bodyCache.set(i, body);
  return body;
});
// Serve one source file on demand. The renderer receives project metadata in the review HTML, but full
// source content stays in the main process until a reviewer actually opens that file.
ipcMain.handle("monacori:get-source", (event, request: { path?: string }) => {
  const state = stateFromEvent(event);
  const path = String(request?.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!state || !path || path.startsWith("../")) return null;
  const record = state.sourceFiles.get(path);
  if (!record) return null;
  if (!record.deferred) return record;
  const materialized = materializeDeferredSourceFile(state.options.root, record);
  state.sourceFiles.set(path, materialized);
  return materialized;
});
// Project-wide metadata and the source tree are intentionally absent from the initial review document.
// Return them as one lazy payload; source contents remain behind the per-file endpoint above.
ipcMain.handle("monacori:get-project-index", (event): ProjectIndexPayload | null => {
  const state = stateFromEvent(event);
  if (!state) return null;
  return {
    signature: state.signature,
    filesTree: "", // Electron builds folder children incrementally from sourceFilesMeta.
    // Omit, rather than blank, heavyweight fields so the structured-clone payload stays compact. Each
    // metadata record already carries its signature; a second project-wide fileStates array is redundant.
    sourceFilesMeta: Array.from(state.sourceFiles.values(), (file) => {
      const { content: _content, image: _image, ...metadata } = file;
      return metadata as SourceFile;
    }),
  };
});
// Expand one omitted unchanged range in the side-by-side diff. Main resolves the exact reviewed
// revisions (base vs worktree, or HEAD vs index for --staged) and returns at most one bounded chunk.
ipcMain.handle("monacori:get-diff-context", (event, request: DiffContextRequest) => {
  const state = stateFromEvent(event);
  if (!state) return { ok: false, oldStart: 0, newStart: 0, oldLines: [], newLines: [], error: "Review window is unavailable" };
  return readReviewDiffContext({
    root: state.options.root,
    base: state.reviewBase ?? state.options.base,
    staged: state.options.staged,
    bodyDiffs: state.bodyDiffs,
    request,
  });
});

// The single Markdown memo is application data, never a repository artifact. Main derives the scope from
// the calling window's canonical worktree; the sandboxed renderer cannot choose a filesystem path.
ipcMain.handle("monacori:memo-read", (event) => {
  const state = stateFromEvent(event);
  return state ? readMemoWithLegacyImport(state.options.root) : { version: 1, worktreePath: "", body: "", updatedAt: null };
});
ipcMain.handle("monacori:memo-write", (event, input?: { body?: unknown }) => {
  const state = stateFromEvent(event);
  return state ? memoStore().write(state.options.root, input?.body) : null;
});
ipcMain.handle("monacori:memo-delete", (event) => {
  const state = stateFromEvent(event);
  if (!state) return { ok: false };
  memoStore().remove(state.options.root);
  return { ok: true };
});

// Definition/references/implementation/workspace-symbol/change-impact analysis. LSP processes and the
// fallback index live outside the renderer and are scoped to the requesting window's repository.
ipcMain.handle("monacori:analysis", async (event, request: AnalysisRequest) => {
  const state = stateFromEvent(event);
  if (!state) return { ok: false, generation: 0, durationMs: 0, engine: "index", confidence: "heuristic", locations: [], error: "Review window is unavailable" };
  const response = await state.analysis.query(request);
  state.perf.mark("analysis-query", {
    kind: request?.kind ?? "unknown",
    generation: response.generation,
    durationMs: response.durationMs,
    engine: response.engine,
    ok: response.ok,
  });
  return response;
});
ipcMain.handle("monacori:analysis-status", (event) => stateFromEvent(event)?.analysis.getStatus() ?? {
  generation: 0,
  phase: "failed",
  error: "Review window is unavailable",
  updatedAt: new Date().toISOString(),
});

// Renderer-owned milestones (notably first-review-paint) complete the startup trace. Names and detail
// values are constrained here so an untrusted review document cannot turn this into an arbitrary writer.
ipcMain.on("monacori:perf-mark", (event, payload: { name?: unknown; details?: unknown }) => {
  const state = stateFromEvent(event);
  const name = typeof payload?.name === "string" ? payload.name : "";
  if (!state || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) return;
  const raw = payload?.details && typeof payload.details === "object" ? payload.details as Record<string, unknown> : {};
  const details: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 20)) {
    if (/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/.test(key) && (value === null || ["string", "number", "boolean"].includes(typeof value))) {
      details[key] = value as string | number | boolean | null;
    }
  }
  state.perf.mark(name, details);
});

// Cmd/Ctrl+Shift+F project search. Resolve the repo from the calling window so multiple open reviews
// never search each other's working trees.
ipcMain.handle("monacori:search", (event, request: { query?: string; limit?: number }) => {
  const state = stateFromEvent(event);
  if (!state) return { available: false, engine: "fallback", matches: [], truncated: false };
  return searchProject(state.options.root, String(request?.query ?? ""), request?.limit);
});

// Git history view (Cmd+9): the log list and a single commit's full diff, for the calling window's repo.
ipcMain.handle("monacori:git-log", (event, request: { limit?: number; skip?: number }) => {
  const state = stateFromEvent(event);
  if (!state) return [];
  try { return readGitLog(state.options.root, { limit: request?.limit, skip: request?.skip }); } catch { return []; }
});
ipcMain.handle("monacori:git-line-log", (event, request: { path?: string; line?: number; limit?: number }) => {
  const state = stateFromEvent(event);
  const path = typeof request?.path === "string" ? request.path : "";
  // Only paths from this window's already-confined source index may reach git -L.
  if (!state || !path || !state.sourceFiles.has(path)) return [];
  try { return readGitLineLog(state.options.root, { path, line: Number(request?.line), limit: request?.limit }); } catch { return []; }
});
ipcMain.handle("monacori:git-commit-diff", (event, request: { sha?: string }) => {
  const state = stateFromEvent(event);
  if (!state || !request?.sha) return null;
  try { return readCommitDiff(state.options.root, request.sha); } catch { return null; }
});

// Sidebar row actions (Opt+Enter menu). Only accept repo-relative paths and keep every resolved target
// inside the calling window's project; a compromised renderer must not turn these shell actions into an
// arbitrary-path launcher.
function resolveProjectRowPath(state: WinState, requestedPath: unknown): string | undefined {
  if (typeof requestedPath !== "string" || !requestedPath.trim() || isAbsolute(requestedPath)) return;
  // Diff/source-tree paths are relative to the folder this window opened, even when that folder lives
  // inside a larger Git repository. Confine file actions to that workspace rather than sibling packages.
  const root = resolve(state.options.root);
  const target = resolve(root, requestedPath);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith("../") || fromRoot.startsWith("..\\") || isAbsolute(fromRoot)) return;
  return target;
}

ipcMain.handle("monacori:absolute-file-path", (event, request: { path?: string }) => {
  const state = stateFromEvent(event);
  const path = state ? resolveProjectRowPath(state, request?.path) : undefined;
  return path ? { ok: true, path } : { ok: false };
});

// Comment anchors may outlive a commit that deletes their file. Check existence in main so renderer-side
// source-index exclusions (.claude, caches, etc.) are never mistaken for deletion. Paths remain confined
// to the calling window's repository by the same resolver used by the sidebar actions.
ipcMain.handle("monacori:existing-project-paths", (event, request: { paths?: unknown[] }) => {
  const state = stateFromEvent(event);
  const requested = Array.isArray(request?.paths) ? request.paths.slice(0, 2000) : [];
  const existing: Record<string, boolean> = {};
  for (const requestedPath of requested) {
    if (typeof requestedPath !== "string" || Object.prototype.hasOwnProperty.call(existing, requestedPath)) continue;
    const path = state ? resolveProjectRowPath(state, requestedPath) : undefined;
    try { existing[requestedPath] = Boolean(path && existsSync(path) && statSync(path).isFile()); }
    catch { existing[requestedPath] = false; }
  }
  return existing;
});

ipcMain.handle("monacori:reveal-in-finder", (event, request: { path?: string }) => {
  const state = stateFromEvent(event);
  const path = state ? resolveProjectRowPath(state, request?.path) : undefined;
  if (!path) return { ok: false };
  try { shell.showItemInFolder(path); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle("monacori:open-terminal", (event, request: { path?: string }) => {
  const state = stateFromEvent(event);
  const path = state ? resolveProjectRowPath(state, request?.path) : undefined;
  if (!path) return { ok: false };
  const directory = dirname(path);
  if (!existsSync(directory)) return { ok: false, error: "missing-directory" };
  try {
    let child;
    if (process.platform === "darwin") {
      child = spawn("open", ["-a", "Terminal", directory], { detached: true, stdio: "ignore" });
    } else if (process.platform === "win32") {
      child = spawn("cmd.exe", ["/c", "start", "", "cmd.exe", "/K", "cd", "/d", directory], { detached: true, stdio: "ignore", windowsHide: true });
    } else {
      child = spawn(process.env.TERMINAL || "x-terminal-emulator", [], { cwd: directory, detached: true, stdio: "ignore" });
    }
    child.once("error", () => {});
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
// Welcome screen's "Open Folder" button: pick a directory; load it into the window that asked if it's a
// git repo, else return the "not-git" code so the welcome renderer can show its inline hint (it keys off
// r.error === "not-git"). This flow reports errors in-page, so — unlike the File menu — no native box.
ipcMain.handle("monacori:open-folder", async (event) => {
  const state = stateFromEvent(event);
  if (!state || state.win.isDestroyed()) return { ok: false };
  const root = await pickDirectory(state.win, state.options.root);
  if (!root) return { ok: false };
  if (!isGitRepository(root)) return { ok: false, error: "not-git" };
  await openReview(state, root);
  return { ok: true };
});

// Welcome screen's Recent Projects list: open the clicked path into the calling window. If it's gone or no
// longer a git repo, drop it from the list and tell the renderer (error: "missing") to remove that row.
ipcMain.handle("monacori:open-recent", async (event, payload: { path?: string }) => {
  const state = stateFromEvent(event);
  const path = typeof payload?.path === "string" ? payload.path : "";
  if (!state || state.win.isDestroyed() || !path) return { ok: false };
  if (!existsSync(path) || !isGitRepository(path)) {
    forgetRecentProject(path);
    return { ok: false, error: "missing" };
  }
  await openReview(state, path);
  return { ok: true };
});

// Self-update: install the latest published package globally, then relaunch so the updated code loads.
// Runs in the main process because the sandboxed renderer can't spawn npm. Returns {ok:true} (and
// relaunches shortly after) or {ok:false,error} so the renderer can fall back to the manual command.
ipcMain.handle("monacori:self-update", (event) => new Promise<{ ok: boolean; error?: string }>((resolve) => {
  // Relaunch the freshly-installed `mo` in the calling window's repo so the user lands back where they were.
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
      // path instead of shelling out to `mo`: GUI apps often have a thin PATH, and a detached shell can fail
      // without a reliable event before our exit timer fires.
      setTimeout(() => {
        try {
          relaunchUpdatedApp(app, process.argv, cwd);
        } catch (error) {
          console.error("monacori: update installed, but relaunch failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }, 250);
    });
  };
  runAttempt(0);
}));

// Persisted global settings (locale, …) live in a JSON file under userData and reach the renderer
// via preload + the two handlers below. The renderer's file:// localStorage is NOT reliably persisted
// across app restarts, so settings that must survive a reopen round-trip through the main process.
function settingsFile(): string {
  return join(app.getPath("userData"), "monacori-settings.json");
}
function workspaceSettingsFile(root: string): string {
  return join(workspaceDataDirectory(app.getPath("userData"), root), "state.json");
}
function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function readWorkspaceSettings(root: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(workspaceSettingsFile(root), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
function writeSettings(settings: Record<string, unknown>): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    /* best-effort: a failed write just means the setting isn't persisted */
  }
}
function writeWorkspaceSettings(root: string, settings: Record<string, unknown>): void {
  try {
    const file = workspaceSettingsFile(root);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    /* best-effort: the review remains usable even if workspace UI state cannot be persisted */
  }
}
const GLOBAL_SETTING_KEYS = new Set([
  "monacori-locale",
  "monacori-theme",
  "monacori-syntax-theme",
  "monacori-merge-prompts",
  "monacori-recent-projects",
  "monacori-dock-height",
  "monacori-memo",
  "monacori-memo-migrated-worktree",
]);
function rendererSettings(root: string): Record<string, unknown> {
  const global = readSettings();
  const workspace = readWorkspaceSettings(root);
  const oldReview = join(resolve(root), ".monacori", REVIEW_FILE);
  const newReview = workspaceReviewFile(app.getPath("userData"), root);
  const pathReplacements = [
    [oldReview, newReview],
    [encodeURI(oldReview), encodeURI(newReview)],
  ];
  let migrated = false;
  // Older releases placed workspace-scoped keys in the global settings JSON and encoded the former
  // project-local review path in each key. Import only keys belonging to this root, preserving other open
  // folders until their own window migrates them.
  for (const [key, value] of Object.entries(global)) {
    if (GLOBAL_SETTING_KEYS.has(key) || (!key.includes(resolve(root)) && !key.includes(encodeURI(resolve(root))))) continue;
    const migratedKey = pathReplacements.reduce((next, pair) => next.replace(pair[0], pair[1]), key);
    if (!(migratedKey in workspace)) workspace[migratedKey] = value;
    delete global[key];
    migrated = true;
  }
  if (migrated) {
    writeWorkspaceSettings(root, workspace);
    writeSettings(global);
  }
  return { ...global, ...workspace };
}
ipcMain.on("monacori:get-settings", (event) => {
  const state = stateFromEvent(event);
  event.returnValue = state ? rendererSettings(state.options.root) : readSettings();
});
ipcMain.on("monacori:set-setting", (event, msg: { key?: string; value?: unknown }) => {
  if (!msg || typeof msg.key !== "string") return;
  const state = stateFromEvent(event);
  if (!state || GLOBAL_SETTING_KEYS.has(msg.key)) {
    const settings = readSettings();
    settings[msg.key] = msg.value;
    writeSettings(settings);
    return;
  }
  const settings = readWorkspaceSettings(state.options.root);
  settings[msg.key] = msg.value;
  writeWorkspaceSettings(state.options.root, settings);
});

// Recent projects (IntelliJ-style): the welcome screen lists repos opened before so they're one click away.
// Persisted in the same userData settings JSON (survives restarts), most-recent-first, deduped, capped.
type RecentProject = { path: string; name: string; openedAt: number };
const RECENT_KEY = "monacori-recent-projects";
const RECENT_MAX = 12;
function readRecentProjects(): RecentProject[] {
  const raw = readSettings()[RECENT_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is RecentProject => !!x && typeof x === "object" && typeof (x as RecentProject).path === "string");
}
function recordRecentProject(root: string): void {
  const path = resolve(root);
  if (!isGitRepository(path)) return; // only remember real repos (bootWindow can build a non-git root)
  const others = readRecentProjects().filter((p) => p.path !== path);
  const next: RecentProject[] = [{ path, name: basename(path) || path, openedAt: Date.now() }, ...others].slice(0, RECENT_MAX);
  const settings = readSettings();
  settings[RECENT_KEY] = next;
  writeSettings(settings);
}
function forgetRecentProject(root: string): void {
  const path = resolve(root);
  const settings = readSettings();
  settings[RECENT_KEY] = readRecentProjects().filter((p) => p.path !== path);
  writeSettings(settings);
}

app.whenReady().then(async () => {
  const assetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "monaco");
  protocol.handle("monacori-asset", (request) => {
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
  console.error(`[monacori] ${DEV_BUILD ? "DEV build" : "build"} — ${app.getAppPath()} (electron ${process.versions.electron})`);

  buildApplicationMenu();

  const appIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin" && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  // First window uses the CLI-resolved root + flags. The repository stays read-only: each window writes
  // generated review state into its mirrored directory below Electron userData.
  createWindow(options.root);
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit();
});

// Each window's "closed" handler clears its timer and deletes its state, so quit once the last window is gone.
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
  // Ctrl+Cmd+Shift+/ ("?") and Ctrl+Cmd+Shift+. (">") open the merged question / change-request views.
  // ? and > are Shift+/ and Shift+. so Shift is part of the combo; Ctrl+Cmd avoids macOS's Cmd+? Help grab.
  menuTemplate.push({
    label: "Review",
    submenu: [
      { label: "All questions", accelerator: "Control+Command+Shift+/", click: () => sendToFocused("monacori:merged-view", "q") },
      { label: "All change requests", accelerator: "Control+Command+Shift+.", click: () => sendToFocused("monacori:merged-view", "c") },
      // Cmd/Ctrl+Shift+N opens (and toggles) the single freeform prompt memo — a Markdown scratchpad.
      { label: "Markdown memo", accelerator: "CommandOrControl+Shift+N", click: () => sendToFocused("monacori:open-memo") },
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
  // Cmd/Ctrl+W closes the active Files-mode tab (routed to the renderer) instead of the window, matching
  // editor/browser tab behavior. Closing the window stays available via the menu item and Cmd/Ctrl+Q.
  menuTemplate.push({
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { type: "separator" },
      { label: "Close Tab", accelerator: "CommandOrControl+W", click: () => sendToFocused("monacori:close-tab") },
      { label: "Close Window", click: () => BrowserWindow.getFocusedWindow()?.close() },
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
}

// Create a window for `root`, register its WinState, wire teardown, and boot it (loading spinner ->
// first build, or the welcome screen for a packaged launch with no repo).
function createWindow(root: string): WinState {
  const themeLight = isLightTheme();
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_TITLE,
    icon: iconPath,
    backgroundColor: themeLight ? "#ffffff" : "#2b2b2b",
    autoHideMenuBar: true,
    // Let the review chrome occupy the otherwise-empty macOS title bar. The renderer keeps the traffic
    // light corner clear and turns its existing file toolbar into the draggable window surface, so we gain
    // vertical room without introducing a second app-specific header. Other platforms keep native chrome.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 13 },
        }
      : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const resolvedRoot = resolve(root);
  migrateLegacyProjectData(app.getPath("userData"), resolvedRoot);
  const perf = new ReviewPerformanceTrace(resolvedRoot, app.getPath("userData"));
  perf.mark("window-created");
  let state!: WinState;
  const analysis = new ProjectAnalysis(resolvedRoot, {
    onStatus: (status) => {
      if (!state || state.win.isDestroyed()) return;
      state.win.webContents.send("monacori:analysis-status", status);
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
    perf,
    lastDiffSig: "",
    reviewBase: undefined,
    reviewUpstream: undefined,
  };
  const id = win.id;
  states.set(id, state);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("did-finish-load", () => {
    const url = win.webContents.getURL();
    const document = url.startsWith("data:") ? "spinner" : url.includes(REVIEW_FILE) ? "review" : "welcome";
    state.perf.mark("document-loaded", { document });
    scheduleAnalysisPrewarm(state);
  });
  win.once("ready-to-show", () => {
    if (state.win.isDestroyed()) return;
    state.win.show();
    if (DEV_BUILD) state.win.webContents.openDevTools({ mode: "detach" });
  });
  // Window teardown: clear this window's watch timer and drop its state.
  win.on("closed", () => {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    if (state.analysisWarmTimer) clearTimeout(state.analysisWarmTimer);
    state.analysis.dispose();
    states.delete(id);
  });

  void bootWindow(state, themeLight);
  return state;
}

// Paint the spinner immediately, then build the (potentially heavy) review off the first paint and swap it
// in. Building before the window exists left the screen blank for the first few seconds of startup.
async function bootWindow(state: WinState, themeLight: boolean): Promise<void> {
  await state.win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(loadingHtml(themeLight)));
  state.perf.mark("spinner-loaded");
  // Give the spinner a few frames to paint before the (synchronous) first build blocks the main process —
  // otherwise the spinner looks frozen until the build finishes. The boot overlay in the review HTML then
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
      const firstBuild = writeReviewFile(state);
      state.signature = firstBuild.signature;
      recordRecentProject(state.options.root); // remember the launched/new-window repo for the welcome screen
      if (!state.win.isDestroyed()) void state.win.loadFile(reviewPath(state.options.root));
      if (state.options.watch) state.refreshTimer = setInterval(() => void refreshIfChanged(state), WATCH_INTERVAL_MS);
    } catch (error) {
      // One window's build failure shouldn't take down the whole app (other windows may be fine); log and
      // leave this window on the spinner rather than quitting.
      console.error(error instanceof Error ? error.message : String(error));
    }
  }, 60);
}

async function refreshIfChanged(state: WinState): Promise<void> {
  if (state.refreshing || state.win.isDestroyed()) return;
  state.refreshing = true;
  try {
    // Fast path: hash only the git diff (~120ms) before the full build (~1s). The vast majority of
    // watch ticks see no change, so skip the heavy buildDiffReview entirely then — keeping the main
    // process free for review/search IPC so the UI never stalls on an unchanged tree.
    const fastBase = state.reviewBase ?? state.options.base;
    const upstreamRevision = state.reviewUpstream
      ? git(state.options.root, ["rev-parse", state.reviewUpstream])
      : "";
    const diffSig = createHash("sha1")
      .update(fastBase ?? "HEAD")
      .update("\n")
      .update(upstreamRevision)
      .update("\n")
      .update(
        readUnifiedDiff({
          base: fastBase,
          staged: state.options.staged,
          context: state.options.context,
          includeUntracked: state.options.includeUntracked,
          ignoreWhitespace: state.options.ignoreWhitespace,
          root: state.options.root,
        }),
      )
      .digest("hex");
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
      if (next.update) state.win.webContents.send("monacori:diff-update", next.update);
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
  const build = buildDiffReview({
    base: state.options.base,
    staged: state.options.staged,
    includeUntracked: state.options.includeUntracked,
    context: state.options.context,
    title: APP_TITLE,
    ignoreWhitespace: state.options.ignoreWhitespace,
    lazyLoad: true, // Electron streams per-file bodies/source over IPC (monacori:get-file / get-source)
    app: true, // enable Electron-only review affordances such as Git history
    root: state.options.root, // review THIS window's repo (no process.chdir; root is threaded through)
  });
  state.reviewBase = build.reviewBase;
  state.reviewUpstream = build.reviewUpstream;
  // The review artifact mirrors the workspace's absolute folder structure below userData. Different
  // repositories, nested monorepo packages, and worktrees therefore never share a file or touch source.
  const target = reviewPath(state.options.root);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, build.html);
  state.bodyDiffs = build.lazyBodyDiffs ?? [];
  state.bodyCache.clear();
  // buildDiffReview runs in this process, so retain its native records instead of serializing and parsing
  // the whole project index (which can approach the source budget on large repositories).
  const sourceFiles: SourceFile[] = build.lazySourceFiles ?? [];
  state.sourceFiles = new Map(sourceFiles.map((file) => [file.path, file]));
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
// the review file under "/") and loaded so preload exposes window.monacoriApp.openFolder to its button.
async function showWelcome(state: WinState): Promise<void> {
  if (state.win.isDestroyed()) return;
  const welcomePath = join(app.getPath("userData"), "welcome.html");
  mkdirSync(dirname(welcomePath), { recursive: true });
  const recent = readRecentProjects().filter((p) => existsSync(p.path)); // hide entries whose folder is gone
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
  migrateLegacyProjectData(app.getPath("userData"), state.options.root);
  state.perf = new ReviewPerformanceTrace(state.options.root, app.getPath("userData"));
  state.perf.mark("review-opened");
  state.analysis = new ProjectAnalysis(state.options.root, {
    onStatus: (status) => {
      if (state.win.isDestroyed()) return;
      state.win.webContents.send("monacori:analysis-status", status);
      state.perf.mark("analysis-status", {
        generation: status.generation,
        phase: status.phase,
        server: status.server ?? "",
        source: status.serverSource ?? "",
      });
    },
  });
  recordRecentProject(state.options.root); // remember it for the welcome screen's Recent Projects
  state.lastDiffSig = ""; // new repo -> force the next watch tick to rebuild
  if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = undefined; }
  const build = writeReviewFile(state);
  state.signature = build.signature;
  if (!state.win.isDestroyed()) await state.win.loadFile(reviewPath(state.options.root));
  if (state.options.watch) state.refreshTimer = setInterval(() => void refreshIfChanged(state), WATCH_INTERVAL_MS);
}

// File > Open Folder (Cmd/Ctrl+O): pick a repo and load it into the focused window.
async function openFolderInCurrent(): Promise<void> {
  const state = focusedState();
  if (!state) return;
  const root = await pickRepo(state.win, state.options.root);
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
  return root;
}

// Clone the CLI-resolved flags for a new window, overriding only the repo root. root + ignoreWhitespace are
// then mutated per window without affecting other windows or the template.
function makeOptions(root: string): AppOptions {
  return { ...options, root: resolve(root) };
}

function parseArgs(args: string[]): AppOptions {
  const root = readOption(args, "--cwd") ?? process.cwd();
  const contextValue = readOption(args, "--context");
  return {
    root: resolve(root),
    // staged review and custom --base were removed from the CLI; always diff the working tree against
    // HEAD (base omitted → defaults to HEAD downstream).
    staged: false,
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
