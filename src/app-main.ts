import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell } from "electron";
import { buildDiffReview, performHttpRequest, type HttpSendRequest } from "./cli.js";
import { sanitizeTerminalEnv, ensureUtf8Locale } from "./util.js";
import { readGitLog, readCommitDiff } from "./git-log.js";
import { readUnifiedDiff } from "./diff.js";
import { isGitRepository } from "./git.js";
import { renderWelcomeHtml } from "./render.js";
import { createHash } from "node:crypto";
import { spawn as spawnPty, type IPty } from "node-pty";

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
// lazily-served diff bodies/source, last-diff hash, and the integrated-terminal ptys) now lives here, keyed
// by BrowserWindow.id, so two windows reviewing different repos don't trample each other's state.
type WinState = {
  win: BrowserWindow;
  options: AppOptions; // this window's repo + diff flags (root + ignoreWhitespace are per-window)
  signature: string;
  refreshing: boolean;
  refreshTimer?: NodeJS.Timeout;
  bodies: string[]; // Phase 2 lazy-LOAD: per-file diff bodies served to THIS window's renderer on demand
  sourceData: string; // Phase 2b lazy-LOAD: full source-files JSON served on demand
  lastDiffSig: string; // watch fast-path: hash of the last git diff, to skip rebuilds when unchanged
  terms: Map<number, IPty>; // integrated-terminal ptys owned by this window
};

// `npm run dev` sets MONACORI_DEV=1 so a locally-built app announces itself — a window-title suffix
// plus a boot log with its on-disk path — making it obvious whether `mo` launched THIS checkout or
// the globally-installed package (their version numbers can be identical; the path is the tell).
const DEV_BUILD = process.env.MONACORI_DEV === "1";
const APP_TITLE = DEV_BUILD ? "monacori (dev)" : "monacori";
const FLOW_DIR = ".monacori";
const REVIEW_FILE = "app-review.html";
const WATCH_INTERVAL_MS = 1000;

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

app.setName("monacori");
// Best-effort re-brand at startup. macOS shows the Dock / Cmd+Tab / menu-bar name from Electron.app's
// CFBundleName + executable name, which app.setName() CANNOT change — only scripts/patch-electron-name.mjs
// (run at postinstall) renames them. That postinstall step can be skipped (npm --ignore-scripts) or fail on
// perms, leaving "Electron" everywhere. Re-run the patch here in a Node context (ELECTRON_RUN_AS_NODE) so a
// fresh install self-heals; it's idempotent and takes effect on the NEXT launch.
if (process.platform === "darwin") {
  try {
    const patchScript = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "patch-electron-name.mjs");
    if (existsSync(patchScript)) {
      spawn(process.execPath, [patchScript], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore", detached: true }).unref();
    }
  } catch { /* best-effort — postinstall remains the primary path */ }
}

const iconPath = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon.png");
const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.cjs");

const options = parseArgs(process.argv.slice(2));
const states = new Map<number, WinState>();
let nextPtyId = 0; // global so pty ids never collide across windows; each window holds only its own in WinState.terms

if (!existsSync(options.root)) {
  throw new Error(`Repository path does not exist: ${options.root}`);
}

// Resolve the WinState for an IPC call by mapping its sender back to a window — this is how get-file /
// get-source-data / pty-* are routed to the right window's state instead of a shared global.
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

ipcMain.handle("monacori:http-send", (_event, request: HttpSendRequest) => performHttpRequest(request));

// Phase 2 lazy-LOAD: serve a single file's diff body to the calling window's renderer on demand. Retained
// from that window's most recent writeReviewFile() build so navigation/scroll can materialize bodies.
ipcMain.handle("monacori:get-file", (event, request: { index?: number }) => {
  const state = stateFromEvent(event);
  if (!state) return "";
  const i = Number(request?.index);
  return Number.isInteger(i) && i >= 0 && i < state.bodies.length ? state.bodies[i] : "";
});
// Phase 2b lazy-LOAD: serve the full source files JSON (with content) for the calling window on demand.
ipcMain.handle("monacori:get-source-data", (event) => stateFromEvent(event)?.sourceData ?? "[]");

// Git history view (Cmd+9): the log list and a single commit's full diff, for the calling window's repo.
ipcMain.handle("monacori:git-log", (event, request: { limit?: number; skip?: number }) => {
  const state = stateFromEvent(event);
  if (!state) return [];
  try { return readGitLog(state.options.root, { limit: request?.limit, skip: request?.skip }); } catch { return []; }
});
ipcMain.handle("monacori:git-commit-diff", (event, request: { sha?: string }) => {
  const state = stateFromEvent(event);
  if (!state || !request?.sha) return null;
  try { return readCommitDiff(state.options.root, request.sha); } catch { return null; }
});

// Sidebar row actions (Opt+Enter menu): reveal a file in Finder / open a terminal at its directory.
// `path` is repo-root-relative (the tree's data-source-file / data-file), resolved against this window's root.
ipcMain.handle("monacori:reveal-in-finder", (event, request: { path?: string }) => {
  const state = stateFromEvent(event);
  if (!state || !request?.path) return { ok: false };
  try { shell.showItemInFolder(join(state.options.root, request.path)); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle("monacori:open-terminal-at", (event, request: { path?: string }) => {
  const state = stateFromEvent(event);
  if (!state || !request?.path) return { ok: false };
  const dir = dirname(join(state.options.root, request.path)); // the file's containing directory
  try {
    if (process.platform === "darwin") spawn("open", ["-a", "Terminal", dir], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "win32") spawn("cmd", ["/c", "start", "cmd", "/k", `cd /d "${dir}"`], { detached: true, stdio: "ignore", shell: true }).unref();
    else spawn("x-terminal-emulator", [], { cwd: dir, detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
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
  let child: import("node:child_process").ChildProcess;
  try {
    child = spawn("npm", ["install", "-g", "@happy-nut/monacori@latest"], { shell: true, env: process.env });
  } catch (error) {
    resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  child.stdout?.on("data", (d) => { out += String(d); });
  child.stderr?.on("data", (d) => { out += String(d); });
  child.on("error", (error) => resolve({ ok: false, error: (error instanceof Error ? error.message : String(error)).slice(-600) }));
  child.on("close", (code) => {
    if (code !== 0) { resolve({ ok: false, error: (out || "npm install failed").trim().slice(-600) }); return; }
    resolve({ ok: true });
    // The global install replaced our on-disk dist, so THIS process is stale. Start the freshly-installed
    // CLI as a NEW detached process, then exit. If `mo` isn't on the (GUI) app's PATH it errors or exits
    // non-zero — fall back to app.relaunch() so the user is never left without a restart (the bug: a failed
    // `mo` spawn under detached/unref went unnoticed and the app just exited without relaunching).
    setTimeout(() => {
      let done = false;
      const relaunch = () => { if (done) return; done = true; try { app.relaunch(); } catch { /* nothing else to try */ } app.exit(0); };
      try {
        const c = spawn("mo", [], { cwd, detached: true, stdio: "ignore", env: sanitizeTerminalEnv(process.env), shell: true });
        c.on("error", relaunch);
        c.on("exit", (exitCode) => { if (exitCode && exitCode !== 0) relaunch(); });
        c.unref();
        setTimeout(() => { if (!done) { done = true; app.exit(0); } }, 800); // `mo` launched fine -> hand off and exit
      } catch {
        relaunch();
      }
    }, 600);
  });
}));

// Integrated terminal: own node-pty sessions in the main process (the sandboxed renderer can't spawn
// them) and relay bytes to the renderer's xterm panes. Each pty is owned by the window that spawned it
// (WinState.terms), so closing one window kills only its terminals and pty data routes back to it alone.
ipcMain.handle("monacori:pty-spawn", (event, size: { cols?: number; rows?: number }) => {
  const state = stateFromEvent(event);
  if (!state) return { ok: false, id: -1 };
  const id = ++nextPtyId;
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
  const t = spawnPty(shell, [], {
    // 256-color terminfo + COLORTERM=truecolor so TUIs (e.g. Claude Code's coral logo) emit 24-bit color and
    // xterm.js renders the exact hue. "xterm-color" is 8-color, which downgraded the orange logo to ANSI red.
    name: "xterm-256color",
    cols: size?.cols ?? 80,
    rows: size?.rows ?? 24,
    cwd: state.options.root,
    env: ensureUtf8Locale({ ...sanitizeTerminalEnv(process.env), TERM: "xterm-256color", COLORTERM: "truecolor" }),
  });
  state.terms.set(id, t);
  // Guard every relay with isDestroyed(): a pty can outlive its window (close races pty teardown), and
  // sending to a closed window's webContents throws "Object has been destroyed".
  const deliver = (channel: string, payload: unknown) => {
    if (!state.win.isDestroyed()) state.win.webContents.send(channel, payload);
  };
  // Relay pty output to the renderer immediately, one IPC per chunk. (A coalescing buffer was tried as an
  // optimization but it broke terminal I/O — the shell prompt and echo stopped appearing — so it's removed.)
  t.onData((data) => deliver("monacori:pty-data", { id, data }));
  t.onExit(() => { state.terms.delete(id); deliver("monacori:pty-exit", { id }); });
  return { ok: true, id };
});
ipcMain.on("monacori:pty-write", (event, msg: { id: number; data: string }) => { stateFromEvent(event)?.terms.get(msg?.id)?.write(msg.data); });
ipcMain.on("monacori:pty-resize", (event, msg: { id: number; cols: number; rows: number }) => {
  try { stateFromEvent(event)?.terms.get(msg?.id)?.resize(msg.cols, msg.rows); } catch { /* resize can race the pty teardown — ignore */ }
});
ipcMain.on("monacori:pty-kill", (event, msg: { id: number }) => {
  const state = stateFromEvent(event);
  const t = state?.terms.get(msg?.id);
  if (t) { try { t.kill(); } catch { /* already exited */ } state!.terms.delete(msg.id); }
});

// A TUI in the integrated terminal rang the bell (e.g. Claude Code finished a turn / needs input). Raise a
// native notification when the window ISN'T focused — while you're watching, the bell itself is enough — plus
// a dock bounce / taskbar flash. Clicking the notification brings the window forward.
ipcMain.on("monacori:bell", (event, msg: { title?: string; body?: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win.isFocused()) return;
  try {
    if (Notification.isSupported()) {
      const note = new Notification({ title: msg?.title || "monacori", body: msg?.body || "Terminal task finished" });
      note.on("click", () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
      note.show();
    }
  } catch { /* notifications are best-effort */ }
  try { win.flashFrame(true); } catch { /* taskbar flash — Windows/Linux */ }
  if (process.platform === "darwin" && app.dock) { try { app.dock.bounce("informational"); } catch { /* best-effort */ } }
});

// Persisted global settings (locale, …) live in a JSON file under userData and reach the renderer
// via preload + the two handlers below. The renderer's file:// localStorage is NOT reliably persisted
// across app restarts, so settings that must survive a reopen round-trip through the main process.
function settingsFile(): string {
  return join(app.getPath("userData"), "monacori-settings.json");
}
function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
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
ipcMain.on("monacori:get-settings", (event) => {
  event.returnValue = readSettings();
});
ipcMain.on("monacori:set-setting", (_event, msg: { key?: string; value?: unknown }) => {
  if (!msg || typeof msg.key !== "string") return;
  const settings = readSettings();
  settings[msg.key] = msg.value;
  writeSettings(settings);
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
  // Foreground (`npm run dev` / `mo --foreground`) surfaces this in the terminal; detached `mo` drops
  // it. Either way the path disambiguates a local checkout from the installed package.
  console.error(`[monacori] ${DEV_BUILD ? "DEV build" : "build"} — ${app.getAppPath()} (electron ${process.versions.electron})`);

  buildApplicationMenu();

  const appIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin" && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  // First window uses the CLI-resolved root + flags. No chdir/mkdir here — each window scopes its own
  // repo via options.root, and writeReviewFile() creates that root's .monacori dir on demand.
  createWindow(options.root);
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit();
});

// Each window's "closed" handler already killed its ptys, cleared its timer, and deleted its state, so
// there's nothing global left to tear down — just quit once the last window is gone.
app.on("window-all-closed", () => {
  app.quit();
});

// Keep the Ignore-whitespace menu checkbox honest as focus moves between windows (it's per-window state).
app.on("browser-window-focus", (_event, win) => {
  try { win.flashFrame(false); } catch { /* stop any terminal-bell taskbar flash once the user is back */ }
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
      { label: "Prompt memo", accelerator: "CommandOrControl+Shift+N", click: () => sendToFocused("monacori:open-memo") },
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
  // Terminal toggle/split as menu accelerators: Chromium swallows Cmd+D before it reaches the renderer
  // (Cmd+A and friends arrive fine), so route the split — and the toggles — through the menu instead.
  menuTemplate.push({
    label: "Terminal",
    submenu: [
      { label: "Toggle Terminal", accelerator: "Control+`", click: () => sendToFocused("monacori:terminal-toggle") },
      { label: "Toggle Terminal (F12)", accelerator: "Alt+F12", click: () => sendToFocused("monacori:terminal-toggle") },
      { label: "Split Terminal", accelerator: "CommandOrControl+D", click: () => sendToFocused("monacori:terminal-split") },
      { type: "separator" },
      { label: "Focus Previous Pane", accelerator: "CommandOrControl+Alt+[", click: () => sendToFocused("monacori:terminal-pane-focus", -1) },
      { label: "Focus Next Pane", accelerator: "CommandOrControl+Alt+]", click: () => sendToFocused("monacori:terminal-pane-focus", 1) },
      { label: "Rename Pane", accelerator: "CommandOrControl+Alt+R", click: () => sendToFocused("monacori:terminal-pane-rename") },
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
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  const state: WinState = {
    win,
    options: makeOptions(root),
    signature: "",
    refreshing: false,
    bodies: [],
    sourceData: "[]",
    lastDiffSig: "",
    terms: new Map(),
  };
  const id = win.id;
  states.set(id, state);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => {
    if (state.win.isDestroyed()) return;
    state.win.show();
    if (DEV_BUILD) state.win.webContents.openDevTools({ mode: "detach" });
  });
  // Window teardown: kill this window's ptys, clear its watch timer, and drop its state. This is the
  // per-window analogue of the old global window-all-closed cleanup.
  win.on("closed", () => {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    for (const t of state.terms.values()) { try { t.kill(); } catch { /* already exited */ } }
    state.terms.clear();
    states.delete(id);
  });

  void bootWindow(state, themeLight);
  return state;
}

// Paint the spinner immediately, then build the (potentially heavy) review off the first paint and swap it
// in. Building before the window exists left the screen blank for the first few seconds of startup.
async function bootWindow(state: WinState, themeLight: boolean): Promise<void> {
  await state.win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(loadingHtml(themeLight)));
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
    // process free for IPC/pty so the UI never stalls on an unchanged tree.
    const diffSig = createHash("sha1")
      .update(
        readUnifiedDiff({
          base: state.options.base,
          staged: state.options.staged,
          context: state.options.context,
          includeUntracked: state.options.includeUntracked,
          ignoreWhitespace: state.options.ignoreWhitespace,
          root: state.options.root,
        }),
      )
      .digest("hex");
    if (diffSig === state.lastDiffSig) return;
    state.lastDiffSig = diffSig;
    const next = writeReviewFile(state);
    if (next.signature !== state.signature) {
      state.signature = next.signature;
      // Refresh the diff in place instead of reloading the window. A full reload re-runs the renderer,
      // whose beforeunload kills every pty — so an integrated terminal running claude/codex would die on
      // each working-tree change. We send only the compact update payload (diff/trees/status/data — no
      // xterm blob), and the renderer transplants it + re-fetches per-file bodies/source over the existing
      // IPC (state.bodies/state.sourceData were just refreshed by writeReviewFile above).
      if (next.update) state.win.webContents.send("monacori:diff-update", next.update);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    state.refreshing = false;
  }
}

function writeReviewFile(state: WinState): { signature: string; html: string; update?: import("./types.js").DiffReviewUpdate } {
  const build = buildDiffReview({
    base: state.options.base,
    staged: state.options.staged,
    includeUntracked: state.options.includeUntracked,
    context: state.options.context,
    title: APP_TITLE,
    ignoreWhitespace: state.options.ignoreWhitespace,
    lazyLoad: true, // Electron streams per-file bodies/source over IPC (monacori:get-file / get-source)
    app: true, // gate the integrated terminal (xterm) into the HTML — Electron only
    root: state.options.root, // review THIS window's repo (no process.chdir; root is threaded through)
  });
  // Two windows on the same repo share this path; the content is identical for the same git state, and
  // each window loads its own freshly-written copy right after, so a same-repo race is benign.
  mkdirSync(join(state.options.root, FLOW_DIR), { recursive: true });
  writeFileSync(reviewPath(state.options.root), build.html);
  state.bodies = build.lazyBodies ?? [];
  state.sourceData = build.lazySourceData ?? "[]";
  return { signature: build.signature, html: build.html, update: build.update };
}

function reviewPath(root: string): string {
  return join(root, FLOW_DIR, REVIEW_FILE);
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
  state.options.root = resolve(root);
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
