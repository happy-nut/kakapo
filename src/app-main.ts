import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, shell } from "electron";
import { isGitRepository, validateReviewBase } from "./git.js";
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
import { installWindowSurfaceRecovery } from "./window-layout.js";

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
  disposeWindowSurfaceRecovery: () => void;
};

// `npm run dev` sets KAKAPO_DEV=1 so a locally-built app announces itself — a window-title suffix
// plus a boot log with its on-disk path — making it obvious whether `kakapo` launched THIS checkout or
// the globally-installed package (their version numbers can be identical; the path is the tell).
const DEV_BUILD = process.env.KAKAPO_DEV === "1";
const APP_NAME = "Kakapo";
const APP_TITLE = DEV_BUILD ? `${APP_NAME} (dev)` : APP_NAME;
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

// Development argv is `[electron, app-main.js, ...flags]`; a packaged app is
// `[Kakapo, ...flags]`. Dropping two entries unconditionally erased `--cwd` from the installed app,
// so scripted relaunches landed on the welcome/recent-project screen instead of the requested folder.
const runtimeArgs = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
const options = parseArgs(runtimeArgs);
const states = new Map<number, WinState>();
const preferences = new AppPreferences(app.getPath("userData"), isGitRepository);
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
// Welcome screen's "Open Folder" button: pick a directory; load it into the window that asked if it's a
// git repo, else return the "not-git" code so the welcome renderer can show its inline hint (it keys off
// r.error === "not-git"). This flow reports errors in-page, so — unlike the File menu — no native box.
ipcMain.handle("kakapo:open-folder", async (event) => {
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

app.whenReady().then(async () => {
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
      { label: "All questions", accelerator: "Control+Command+Shift+/", click: () => sendToFocused("kakapo:merged-view", "q") },
      { label: "All change requests", accelerator: "Control+Command+Shift+.", click: () => sendToFocused("kakapo:merged-view", "c") },
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

// Create a window for `root`, register its WinState, wire teardown, and boot it (animated mark ->
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
    perf,
    lastDiffSig: "",
    reviewBase: undefined,
    reviewUpstream: undefined,
    disposeWindowSurfaceRecovery: installWindowSurfaceRecovery(win),
  };
  const id = win.id;
  states.set(id, state);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("did-finish-load", () => {
    const url = win.webContents.getURL();
    const document = url.startsWith("data:") ? "loading" : url.includes(REVIEW_FILE) ? "review" : "welcome";
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
    state.disposeWindowSurfaceRecovery();
    state.analysis.dispose();
    states.delete(id);
  });

  void bootWindow(state, themeLight);
  return state;
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
      const firstBuild = writeReviewFile(state);
      state.signature = firstBuild.signature;
      preferences.recordRecentProject(state.options.root); // remember the launched/new-window repo for the welcome screen
      if (!state.win.isDestroyed()) void state.win.loadFile(reviewPath(state.options.root));
      if (state.options.watch) state.refreshTimer = setInterval(() => void refreshIfChanged(state), WATCH_INTERVAL_MS);
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
  const root = resolve(readOption(args, "--cwd") ?? process.cwd());
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
