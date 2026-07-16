import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readOption } from "./util.js";

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
    launchReviewApp(rawArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`kakapo: ${message}`);
    process.exit(1);
  }
}

// Keep the initial diff DOM compact. Omitted ranges can be expanded in-place from the reviewed revisions,
// so shipping whole files up front only makes startup and caret navigation slower on large changes.
export const DEFAULT_DIFF_CONTEXT = 12;

function launchReviewApp(args: string[]): void {
  // Review the directory given by --cwd (defaults to the current one), so `npm run dev -- --cwd <path>` can
  // open ANY repo from anywhere. chdir up front so the flow state and the launched app resolve to one repo.
  const targetCwd = resolve(readOption(args, "--cwd") ?? process.cwd());
  if (!existsSync(targetCwd)) {
    throw new Error(`Directory does not exist: ${targetCwd}`);
  }
  process.chdir(targetCwd);

  const appArgs = [
    appMainPath(),
    "--cwd",
    process.cwd(),
    "--context",
    String(DEFAULT_DIFF_CONTEXT),
    "--include-untracked", // new AI-created files are visible by default
  ];
  if (args.includes("--no-watch")) appArgs.push("--no-watch");

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

Diff review keys:
  F7 / Shift+F7     next / previous changed hunk
  Cmd/Ctrl+0 / +1   focus the Changes / Files panel (arrows + Enter to open a file)
  Shift Shift       file search across project files
  Cmd/Ctrl+F        search the open file (Enter / Shift+Enter to navigate)
  Cmd/Ctrl+Shift+F  project-wide content search (file:line:column)
  Cmd/Ctrl+E        recent files
  Cmd/Ctrl+B        definition / usages (LSP first, regex fallback)
  Cmd/Ctrl+Down     jump to symbol under cursor
  Cmd/Ctrl+Alt+B    go to implementation
  Cmd/Ctrl+Alt+O    workspace symbol search
  Cmd/Ctrl+8        change impact for the current symbol
`);
}
