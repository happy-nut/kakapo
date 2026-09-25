import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { errorMessage, readOption } from "./util.js";
import { applicationsBundlePath, installApp, uninstallApp } from "./install-app.js";

const nodeRequire = createRequire(import.meta.url);

// Kakapo is a single command: open the desktop review app for the current repository. `--cwd <path>`
// reviews another repo (used by `npm run dev -- --cwd <path>`); `--no-watch` / `--foreground` are
// development/internal knobs. `--help` prints help.
export function main(): void {
  const rawArgs = process.argv.slice(2);
  try {
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      printHelp();
      return;
    }
    if (rawArgs[0] === "install-app") { runInstallApp(); return; }
    if (rawArgs[0] === "uninstall-app") { runUninstallApp(); return; }
    launchReviewApp(rawArgs);
  } catch (error) {
    const message = errorMessage(error);
    console.error(`kakapo: ${message}`);
    process.exit(1);
  }
}

function packageVersion(): string {
  try {
    const pkg = nodeRequire(join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch { return "0.0.0"; }
}

function runInstallApp(): void {
  const { path, replaced } = installApp({ version: packageVersion() });
  process.stdout.write(`${replaced ? "Updated" : "Installed"} ${path}\n`);
  process.stdout.write("Kakapo is now in Spotlight and Launchpad. Opening it with no repository shows the folder picker.\n");
  // The icon is cached per bundle path, and a rewritten bundle at the same path keeps the stale one until
  // Finder is nudged. Cheap, best-effort, and never worth failing the install over.
  spawnSync("touch", [path], { stdio: "ignore" });
}

function runUninstallApp(): void {
  const path = applicationsBundlePath();
  process.stdout.write(uninstallApp(path) ? `Removed ${path}\n` : `Nothing to remove at ${path}\n`);
}

// Keep the initial diff DOM compact. Omitted ranges can be expanded in-place from the reviewed revisions,
// so shipping whole files up front only makes startup and caret navigation slower on large changes.
export const DEFAULT_DIFF_CONTEXT = 12;

// Options whose value is the NEXT argument. A positional path has to skip over those values, or
// `kakapo --base main` would read `main` as the thing to open.
const VALUE_OPTIONS = new Set(["--cwd", "--base", "--context"]);

/** The first bare argument: the file or folder to open. `kakapo <path>` is the short form of `--cwd <path>`. */
function positionalPath(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_OPTIONS.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function launchReviewApp(args: string[]): void {
  // What to open: `--cwd <path>`, a bare path, or the current directory. A FILE is legal — kakapo opens the
  // folder around it and lands on the file, which is how you read a design note that lives outside any repo
  // (`kakapo ~/.claude/projects/…/PLAN.md`). chdir up front so the launched app resolves to one place.
  // Did the user name a place, or are we just inheriting a cwd? A GUI launch (Launchpad, Spotlight, the
  // Applications icon) inherits "/" — and --cwd is passed inward either way, so without this marker the app
  // reads "/" as a deliberate choice and tries to index the whole filesystem instead of showing the picker.
  const named = readOption(args, "--cwd") ?? positionalPath(args);
  const requested = resolve(named ?? process.cwd());
  if (!existsSync(requested)) {
    throw new Error(`Path does not exist: ${requested}`);
  }
  const openFile = statSync(requested).isFile() ? requested : undefined;
  const targetCwd = openFile ? dirname(openFile) : requested;
  process.chdir(targetCwd);

  const appArgs = [
    appMainPath(),
    "--cwd",
    process.cwd(),
    "--include-untracked", // new AI-created files are visible by default
  ];
  if (named !== undefined) appArgs.push("--opened");
  if (openFile) appArgs.push("--open", openFile);
  // Forward the review flags. They used to stop here: `--help` and the README documented --base/--staged/
  // --ignore-whitespace, and the app never saw any of them — only --cwd and the default context were passed
  // on, so `kakapo --base main` silently reviewed the working tree instead.
  const base = readOption(args, "--base");
  if (base !== undefined) appArgs.push("--base", base);
  const context = readOption(args, "--context");
  appArgs.push("--context", context ?? String(DEFAULT_DIFF_CONTEXT));
  for (const flag of ["--staged", "--ignore-whitespace", "--no-watch"]) {
    if (args.includes(flag)) appArgs.push(flag);
  }

  ensureElectronRuntimeBranded();
  const electronBinary = resolveElectronBinary();
  // In dev only (`npm run dev` sets KAKAPO_DEV=1) announce which build is launching, so a local checkout
  // is distinguishable from the installed package. Normal `kakapo` runs stay silent.
  if (process.env.KAKAPO_DEV === "1") {
    console.error(`kakapo: launching ${appMainPath()}`);
  }
  if (args.includes("--foreground")) {
    const result = spawnSync(electronBinary, appArgs, { stdio: "inherit" });
    process.exit(result.status ?? 0);
  }

  const child = spawn(electronBinary, appArgs, { detached: true, stdio: "ignore" });
  child.unref();
  console.log("Opened kakapo review app.");
}

type ElectronBrandDeps = {
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: typeof existsSync;
  spawnSync?: typeof spawnSync;
};

export function ensureElectronRuntimeBranded(deps: ElectronBrandDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return;

  const patchScript = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "patch-electron-name.mjs");
  const exists = deps.existsSync ?? existsSync;
  if (!exists(patchScript)) return;

  try {
    (deps.spawnSync ?? spawnSync)(deps.execPath ?? process.execPath, [patchScript], {
      env: deps.env ?? process.env,
      stdio: "ignore",
    });
  } catch {
    // Best effort: postinstall covers normal installs. Never retry after Electron starts because changing
    // a live macOS app bundle can crash Chromium during didFinishLaunching.
  }
}

function resolveElectronBinary(): string {
  const electronModule = nodeRequire("electron") as unknown;
  if (typeof electronModule === "string") {
    return electronModule;
  }
  if (electronModule && typeof electronModule === "object" && "default" in electronModule) {
    const value = (electronModule as { default?: unknown }).default;
    if (typeof value === "string") {
      return value;
    }
  }
  throw new Error("Electron runtime is not available. Run `npm install` and try again.");
}

function appMainPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "app-main.js");
}

function printHelp(): void {
  console.log(`kakapo — desktop review app for AI-generated code changes.

Usage:
  kakapo            open the review app for the current repository
  kakapo <path>     open a folder, or a single file (lands on it). Git is optional —
                    a folder without a repository opens as its source tree.

Commands:
  install-app       add a Kakapo icon to Applications (Spotlight, Launchpad, Dock).
                    npm installs a CLI only; this is the opt-in that gives it an icon.
  uninstall-app     remove that icon again

Options:
  --cwd <path>      same as the bare <path> form, for a folder
  --base <rev>      compare the working tree against a branch, tag or commit
                    default: the upstream merge-base when the branch has unpushed
                    commits, otherwise HEAD. Changeable in the app — see Alt+A/U/C.
  --staged          compare the index against HEAD instead (not with --base)
  --include-untracked  count files git does not track yet as additions
  --ignore-whitespace  hide changes that are only whitespace
  --context <n>     unchanged lines kept around each hunk; default: 12
  --no-watch        stop refreshing the review when the working tree changes
  -h, --help        this text

Diff review keys:
  F7 / Shift+F7     next / previous changed hunk
  Cmd/Ctrl+8        worktrees — every checkout sharing this repository; Enter opens one
                    in its own window. Shows each one's branch, uncommitted work and
                    drift, plus its open GitHub PR when gh is installed.
  Cmd/Ctrl+0        focus the Changes panel (arrows + Enter to open a file)
  Cmd/Ctrl+F        search the open file (Enter / Shift+Enter to navigate)
  Cmd/Ctrl+Shift+F  project search — its section rail also holds file search + recent files
  Alt/Option+A / +U all changes on the branch / only what is not committed yet
  Alt/Option+C      choose the branch those "all changes" are measured against
  Cmd/Ctrl+B        definition / usages (LSP first, regex fallback)
  Cmd/Ctrl+Down     jump to symbol under cursor
  Cmd/Ctrl+Alt+B    go to implementation
  Cmd/Ctrl+Alt+O    workspace symbol search
`);
}
