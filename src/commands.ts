import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { errorMessage, readOption } from "./util.js";
import { parseReviewArgs } from "./cli-args.js";
import { isGitRepository, validateReviewBase } from "./git.js";
import { parsePullRequestRef, remoteSlug } from "./github-pr.js";
import { applicationsBundlePath, installApp, uninstallApp } from "./install-app.js";
import { CLI_COMMANDS, CLI_OPTIONS, cliValueOptions, commandsHelp, optionsHelp } from "./cli-surface.js";

const nodeRequire = createRequire(import.meta.url);

export function main(): void {
  const rawArgs = process.argv.slice(2);
  try {
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      printHelp();
      return;
    }
    if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
      console.log(packageVersion());
      return;
    }
    const command = CLI_COMMANDS.find((entry) => entry.name === rawArgs[0]);
    if (command) { COMMAND_RUNNERS[command.name](); return; }
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

const COMMAND_RUNNERS: Record<string, () => void> = {
  "install-app": () => runInstallApp(),
  "uninstall-app": () => runUninstallApp(),
};

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

export const DEFAULT_DIFF_CONTEXT = 12;

const VALUE_OPTIONS = cliValueOptions();

function positionalPath(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_OPTIONS.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

function pullRequestArgument(value: string | undefined, root: string): string | undefined {
  if (!value || existsSync(value)) return undefined;
  return parsePullRequestRef(value, remoteSlug(root)) ? value : undefined;
}

function launchReviewApp(args: string[]): void {
  const positional = positionalPath(args);
  const cwdOption = readOption(args, "--cwd");
  const pullRequestRoot = resolve(cwdOption ?? process.cwd());
  const pullRequest = readOption(args, "--pull-request") ?? pullRequestArgument(positional, pullRequestRoot);
  const namedPullRequest = pullRequest !== undefined && pullRequest === positional;
  if (pullRequest && !isGitRepository(pullRequestRoot)) {
    throw new Error(`A pull request is read into a clone of its repository, and ${pullRequestRoot} is not one.`);
  }
  const named = cwdOption ?? (namedPullRequest ? undefined : positional);
  const requested = resolve(named ?? process.cwd());
  if (!existsSync(requested)) {
    throw new Error(`Path does not exist: ${requested}`);
  }
  const openFile = statSync(requested).isFile() ? requested : undefined;
  const targetCwd = openFile ? dirname(openFile) : requested;
  process.chdir(targetCwd);

  parseReviewArgs(args);
  const requestedBase = readOption(args, "--base");
  if (requestedBase !== undefined && isGitRepository(process.cwd())) {
    validateReviewBase(process.cwd(), requestedBase);
  }

  const appArgs = [
    appMainPath(),
    "--cwd",
    process.cwd(),
    "--include-untracked",
  ];
  appArgs.push("--opened");
  if (pullRequest) appArgs.push("--pull-request", pullRequest);
  if (openFile) appArgs.push("--open", openFile);
  for (const option of CLI_OPTIONS) {
    if (option.forward === "boolean" && args.includes(option.flag)) appArgs.push(option.flag);
    if (option.forward !== "value") continue;
    const value = readOption(args, option.flag);
    if (value !== undefined) appArgs.push(option.flag, value);
  }
  if (readOption(args, "--context") === undefined) appArgs.push("--context", String(DEFAULT_DIFF_CONTEXT));

  ensureElectronRuntimeBranded();
  const electronBinary = resolveElectronBinary();
  if (process.env.KAKAPO_DEV === "1") {
    console.error(`kakapo: launching ${appMainPath()}`);
  }
  // The child is the APP, not another node process. When this CLI is itself running as Electron-hosted node
  // — which is how the packaged bundle's `kakapo` runs — that variable is in our own environment, and the
  // child would execute app-main.js as a bare script and open no window at all.
  const appEnv = { ...process.env };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  if (args.includes("--foreground")) {
    const result = spawnSync(electronBinary, appArgs, { stdio: "inherit", env: appEnv });
    process.exit(result.status ?? 0);
  }

  const child = spawn(electronBinary, appArgs, { detached: true, stdio: "ignore", env: appEnv });
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
  }
}

function resolveElectronBinary(): string {
  let electronModule: unknown;
  try { electronModule = nodeRequire("electron"); } catch { electronModule = undefined; }
  if (typeof electronModule === "string") {
    return electronModule;
  }
  if (electronModule && typeof electronModule === "object" && "default" in electronModule) {
    const value = (electronModule as { default?: unknown }).default;
    if (typeof value === "string") {
      return value;
    }
  }
  if (process.versions.electron) {
    return process.execPath;
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
  kakapo <pr link>  review a GitHub pull request from this clone: its commits are
                    fetched and the diff opens against its merge base. Also
                    owner/repo#12 and #12. Needs the GitHub CLI (gh).

${commandsHelp()}

${optionsHelp()}

Diff review keys:
  F7 / Shift+F7     next / previous change — each edit, deleted lines included
  Cmd/Ctrl+2        focus the Changes panel (arrows + Enter to open a file)
  Cmd/Ctrl+F        search the open file (Enter / Shift+Enter to navigate)
  Cmd/Ctrl+Shift+F  project search — its section rail also holds file search + recent files
  Alt/Option+A / +U all changes on the branch / only what is not committed yet
  Alt/Option+C      choose the branch those "all changes" are measured against
  Alt/Option+L      paste a pull request link to review it
  Cmd/Ctrl+B        definition / usages (LSP first, regex fallback)
  Cmd/Ctrl+Down     jump to symbol under cursor
  Cmd/Ctrl+Alt+B    go to implementation
  Cmd/Ctrl+Alt+O    workspace symbol search
`);
}
