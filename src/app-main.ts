import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, nativeImage } from "electron";
import { buildDiffReview } from "./cli.js";

type AppOptions = {
  root: string;
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  watch: boolean;
};

const FLOW_DIR = ".monacori";
const REVIEW_FILE = "app-review.html";
const WATCH_INTERVAL_MS = 1000;

app.setName("monacori");

const iconPath = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon.png");

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
  Menu.setApplicationMenu(null);

  const appIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin" && app.dock && !appIcon.isEmpty()) {
    app.dock.setIcon(appIcon);
  }

  const firstBuild = writeReviewFile(options);
  currentSignature = firstBuild.signature;

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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadFile(reviewPath());

  if (options.watch) {
    refreshTimer = setInterval(refreshIfChanged, WATCH_INTERVAL_MS);
  }
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (refreshTimer) clearInterval(refreshTimer);
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
    title: "monacori review",
  });
  writeFileSync(reviewPath(), build.html);
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
