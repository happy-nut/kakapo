import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeImage } from "electron";
import { buildDiffReview, performHttpRequest, type HttpSendRequest } from "./cli.js";
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

const FLOW_DIR = ".monacori";
const REVIEW_FILE = "app-review.html";
const WATCH_INTERVAL_MS = 1000;

// Painted immediately while the first review build + HTML render run, so startup shows a spinner instead
// of a blank window. Inlined as a data: URL so it needs no file on disk and appears before any review work.
const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100vh;background:#2b2b2b;color:#9aa4af;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:18px;
    font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .s{width:34px;height:34px;border:3px solid #3a3a3a;border-top-color:#4a9eff;border-radius:50%;
    animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div class="s"></div><div>monacori</div></body></html>`;

app.setName("monacori");

ipcMain.handle("monacori:http-send", (_event, request: HttpSendRequest) => performHttpRequest(request));

// Phase 2 lazy-LOAD: serve a single file's diff body to the renderer on demand. Retained from the
// most recent writeReviewFile() build so navigation/scroll can materialize bodies without embedding.
let currentBodies: string[] = [];
let currentSourceData = "[]";
ipcMain.handle("monacori:get-file", (_event, request: { index?: number }) => {
  const i = Number(request?.index);
  return Number.isInteger(i) && i >= 0 && i < currentBodies.length ? currentBodies[i] : "";
});
// Phase 2b lazy-LOAD: serve the full source files JSON (with content) on demand.
ipcMain.handle("monacori:get-source-data", () => currentSourceData);

// Self-update: install the latest published package globally, then relaunch so the updated code loads.
// Runs in the main process because the sandboxed renderer can't spawn npm. Returns {ok:true} (and
// relaunches shortly after) or {ok:false,error} so the renderer can fall back to the manual command.
ipcMain.handle("monacori:self-update", () => {
  const result = spawnSync("npm", ["install", "-g", "@happy-nut/monacori@latest"], {
    encoding: "utf8",
    shell: true,
    env: process.env,
    timeout: 5 * 60 * 1000,
  });
  if ((result.status ?? 1) === 0) {
    // Let the renderer paint "Restarting…" before we relaunch with the new code.
    setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
    return { ok: true };
  }
  const detail = (result.stderr || result.stdout || (result.error && result.error.message) || "npm install failed").trim();
  return { ok: false, error: detail.slice(-600) };
});

// Integrated terminal: own node-pty sessions in the main process (the sandboxed renderer can't spawn
// them) and relay bytes to the renderer's xterm panes. Each split pane gets its own pty, keyed by id, so
// the renderer can route data/resize/kill per pane.
const terms = new Map<number, IPty>();
let nextPtyId = 0;
ipcMain.handle("monacori:pty-spawn", (_event, size: { cols?: number; rows?: number }) => {
  const id = ++nextPtyId;
  const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
  const t = spawnPty(shell, [], {
    name: "xterm-color",
    cols: size?.cols ?? 80,
    rows: size?.rows ?? 24,
    cwd: options.root,
    env: process.env as { [key: string]: string },
  });
  terms.set(id, t);
  // mainWindow?. only guards null, NOT a *destroyed* window — sending to a closed window's webContents
  // throws "Object has been destroyed". The pty can outlive the window (close races pty teardown), so
  // guard every relay with isDestroyed().
  const deliver = (channel: string, payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  t.onData((data) => deliver("monacori:pty-data", { id, data }));
  t.onExit(() => { terms.delete(id); deliver("monacori:pty-exit", { id }); });
  return { ok: true, id };
});
ipcMain.on("monacori:pty-write", (_event, msg: { id: number; data: string }) => { terms.get(msg?.id)?.write(msg.data); });
ipcMain.on("monacori:pty-resize", (_event, msg: { id: number; cols: number; rows: number }) => {
  try { terms.get(msg?.id)?.resize(msg.cols, msg.rows); } catch { /* resize can race the pty teardown — ignore */ }
});
ipcMain.on("monacori:pty-kill", (_event, msg: { id: number }) => {
  const t = terms.get(msg?.id);
  if (t) { try { t.kill(); } catch { /* already exited */ } terms.delete(msg.id); }
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

const iconPath = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon.png");
const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.cjs");

const options = parseArgs(process.argv.slice(2));
let mainWindow: BrowserWindow | undefined;
let currentSignature = "";
let refreshTimer: NodeJS.Timeout | undefined;
let refreshing = false;

if (!existsSync(options.root)) {
  throw new Error(`Repository path does not exist: ${options.root}`);
}

app.whenReady().then(async () => {
  process.chdir(options.root);
  mkdirSync(FLOW_DIR, { recursive: true });
  // Keep the standard Edit/Window roles so Cmd+C/V/X/A (copy comments into prompts) and Cmd+Q work.
  // The in-window menu bar stays hidden on Windows/Linux via autoHideMenuBar; macOS shows it in the top bar.
  const sendMerged = (kind: "q" | "c") => mainWindow?.webContents.send("monacori:merged-view", kind);
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [];
  if (process.platform === "darwin") menuTemplate.push({ role: "appMenu" });
  menuTemplate.push({ role: "editMenu" });
  // Ctrl+Cmd+Shift+/ ("?") and Ctrl+Cmd+Shift+. (">") open the merged question / change-request views.
  // ? and > are Shift+/ and Shift+. so Shift is part of the combo; Ctrl+Cmd avoids macOS's Cmd+? Help grab.
  menuTemplate.push({
    label: "Review",
    submenu: [
      { label: "All questions", accelerator: "Control+Command+Shift+/", click: () => sendMerged("q") },
      { label: "All change requests", accelerator: "Control+Command+Shift+.", click: () => sendMerged("c") },
      { type: "separator" },
      // Whitespace-ignore re-runs git diff with --ignore-all-space and reloads (main-process action,
      // so a menu checkbox is simpler than a renderer IPC round-trip).
      {
        label: "Ignore whitespace",
        type: "checkbox",
        checked: options.ignoreWhitespace,
        accelerator: "CommandOrControl+Shift+W",
        click: (item) => {
          options.ignoreWhitespace = item.checked;
          currentSignature = writeReviewFile(options).signature;
          mainWindow?.webContents.reloadIgnoringCache();
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
      { label: "Close Tab", accelerator: "CommandOrControl+W", click: () => mainWindow?.webContents.send("monacori:close-tab") },
      { label: "Close Window", click: () => mainWindow?.close() },
    ],
  });
  // Terminal toggle/split as menu accelerators: Chromium swallows Cmd+D before it reaches the renderer
  // (Cmd+A and friends arrive fine), so route the split — and the toggles — through the menu instead.
  menuTemplate.push({
    label: "Terminal",
    submenu: [
      { label: "Toggle Terminal", accelerator: "Control+`", click: () => mainWindow?.webContents.send("monacori:terminal-toggle") },
      { label: "Toggle Terminal (F12)", accelerator: "Alt+F12", click: () => mainWindow?.webContents.send("monacori:terminal-toggle") },
      { label: "Split Terminal", accelerator: "CommandOrControl+D", click: () => mainWindow?.webContents.send("monacori:terminal-split") },
      { type: "separator" },
      { label: "Focus Previous Pane", accelerator: "CommandOrControl+Alt+[", click: () => mainWindow?.webContents.send("monacori:terminal-pane-focus", -1) },
      { label: "Focus Next Pane", accelerator: "CommandOrControl+Alt+]", click: () => mainWindow?.webContents.send("monacori:terminal-pane-focus", 1) },
      { label: "Rename Pane", accelerator: "CommandOrControl+Alt+R", click: () => mainWindow?.webContents.send("monacori:terminal-pane-rename") },
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

  const appIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin" && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "monacori",
    icon: iconPath,
    backgroundColor: "#2b2b2b",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  // Paint the window with a spinner immediately, then build the (potentially heavy) review off the first
  // paint and swap it in. The first build used to run synchronously *before* the window existed, so the
  // screen stayed blank for the first few seconds of startup; now the user sees a loading screen instead.
  await mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(LOADING_HTML));
  setImmediate(() => {
    try {
      const firstBuild = writeReviewFile(options);
      currentSignature = firstBuild.signature;
      if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.loadFile(reviewPath());
      if (options.watch) refreshTimer = setInterval(refreshIfChanged, WATCH_INTERVAL_MS);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      app.quit();
    }
  });
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  for (const t of terms.values()) { try { t.kill(); } catch { /* already exited */ } }
  terms.clear();
  app.quit();
});

async function refreshIfChanged(): Promise<void> {
  if (refreshing || !mainWindow || mainWindow.isDestroyed()) return;
  refreshing = true;
  try {
    const next = writeReviewFile(options);
    if (next.signature !== currentSignature) {
      currentSignature = next.signature;
      mainWindow.webContents.reloadIgnoringCache();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    refreshing = false;
  }
}

function writeReviewFile(input: AppOptions): { signature: string } {
  const build = buildDiffReview({
    base: input.base,
    staged: input.staged,
    includeUntracked: input.includeUntracked,
    context: input.context,
    title: "monacori",
    ignoreWhitespace: input.ignoreWhitespace,
    lazyLoad: true, // Electron streams per-file bodies/source over IPC (monacori:get-file / get-source)
    app: true, // gate the integrated terminal (xterm) into the HTML — Electron only
  });
  writeFileSync(reviewPath(), build.html);
  currentBodies = build.lazyBodies ?? [];
  currentSourceData = build.lazySourceData ?? "[]";
  return { signature: build.signature };
}

function reviewPath(): string {
  return join(options.root, FLOW_DIR, REVIEW_FILE);
}

function parseArgs(args: string[]): AppOptions {
  const root = readOption(args, "--cwd") ?? process.cwd();
  const contextValue = readOption(args, "--context");
  return {
    root: resolve(root),
    base: readOption(args, "--base"),
    staged: args.includes("--staged"),
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
