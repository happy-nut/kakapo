import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { FlowConfig } from "./types.js";
import { CONFIG_FILE, DECISIONS_FILE, FLOW_DIR, GITIGNORE_FILE, STATE_FILE } from "./constants.js";
import { readOption } from "./util.js";
import { git } from "./git.js";

const nodeRequire = createRequire(import.meta.url);

// monacori is a single command: open the desktop review app for the current repository. `mo` and
// `monacori` (with or without flags) all do the same thing. `--cwd <path>` reviews another repo (used by
// `npm run dev -- --cwd <path>`); `--no-watch` / `--foreground` are dev/internal knobs. `--help` prints help.
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
    console.error(`monacori: ${message}`);
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
  ensureWritableFlowState();

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
  // In dev only (`npm run dev` sets MONACORI_DEV=1) announce which build is launching, so a local checkout
  // is distinguishable from the installed package. Normal `mo` runs stay silent.
  if (process.env.MONACORI_DEV === "1") {
    console.error(`monacori: launching ${appMainPath()}`);
  }
  if (args.includes("--foreground")) {
    const result = spawnSync(electronBinary, appArgs, { stdio: "inherit" });
    process.exit(result.status ?? 0);
  }

  const child = spawn(electronBinary, appArgs, { detached: true, stdio: "ignore" });
  child.unref();
  console.log("Opened monacori review app.");
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

// Create .monacori/ on first run (the app auto-initializes; there is no separate `init` command).
function initFlow(): void {
  const root = process.cwd();
  const flowPath = join(root, FLOW_DIR);
  mkdirSync(flowPath, { recursive: true });
  mkdirSync(join(flowPath, "reports"), { recursive: true });
  mkdirSync(join(flowPath, "logs"), { recursive: true });
  mkdirSync(join(flowPath, "diffs"), { recursive: true });

  const config: FlowConfig = {
    version: 1,
    projectName: basename(root),
    verification: { commands: detectVerificationCommands(root) },
    diff: { context: 12, includeUntracked: false },
  };

  writeIfMissing(join(flowPath, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  writeIfMissing(join(flowPath, STATE_FILE), initialState(config));
  writeIfMissing(join(flowPath, DECISIONS_FILE), initialDecisions());
  ensureMonacoriGitignore(root);
}

function initialState(config: FlowConfig): string {
  return [
    "# Monacori Validation State",
    "",
    `Project: ${config.projectName}`,
    "",
    "## Goal",
    "- Keep AI-generated changes reviewable, test-backed, and easy to inspect.",
    "",
    "## Checks",
    "",
    "## Reports",
    "",
  ].join("\n");
}

function initialDecisions(): string {
  return [
    "# Monacori Decisions",
    "",
    "Record durable review decisions here so they do not depend on chat memory.",
    "",
  ].join("\n");
}

function ensureWritableFlowState(): void {
  if (!existsSync(join(process.cwd(), FLOW_DIR, CONFIG_FILE))) {
    initFlow();
    return;
  }
  ensureMonacoriGitignore(process.cwd());
}

function writeIfMissing(path: string, content: string): void {
  if (existsSync(path)) {
    return;
  }
  writeFileSync(path, content);
}

function ensureMonacoriGitignore(root: string): void {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return;
  }

  const path = join(root, GITIGNORE_FILE);
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const hasEntry = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === FLOW_DIR || line === `${FLOW_DIR}/`);
  if (hasEntry) {
    return;
  }

  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, `${content}${prefix}# monacori local validation artifacts\n${FLOW_DIR}/\n`);
}

function detectVerificationCommands(root: string): string[] {
  const commands = new Set<string>();
  const packagePath = join(root, "package.json");
  if (existsSync(packagePath)) {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const packageManager = detectPackageManager(root);
    const scripts = packageJson.scripts ?? {};
    for (const script of ["typecheck", "lint", "test", "build"]) {
      if (scripts[script]) {
        commands.add(packageScriptCommand(packageManager, script));
      }
    }
  }

  if (existsSync(join(root, "pyproject.toml"))) {
    commands.add(existsSync(join(root, "poetry.lock")) ? "poetry run pytest" : "pytest");
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    commands.add("cargo test");
  }
  if (existsSync(join(root, "go.mod"))) {
    commands.add("go test ./...");
  }

  return Array.from(commands);
}

function detectPackageManager(root: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  return "npm";
}

function packageScriptCommand(manager: "npm" | "pnpm" | "yarn" | "bun", script: string): string {
  if (manager === "npm") {
    return script === "test" ? "npm test" : `npm run ${script}`;
  }
  if (manager === "yarn") {
    return `yarn ${script}`;
  }
  if (manager === "bun") {
    return `bun run ${script}`;
  }
  return `pnpm ${script}`;
}

function printHelp(): void {
  console.log(`monacori — desktop review app for AI-generated code changes.

Usage:
  mo            open the review app for the current repository

Diff review keys:
  F7 / Shift+F7     next / previous changed hunk
  Cmd/Ctrl+0 / +1   focus the Changes / Files panel (arrows + Enter to open a file)
  Shift Shift       file search across project files
  Cmd/Ctrl+Shift+F  project-wide content search (file:line:column)
  Cmd/Ctrl+E        recent files
  Cmd/Ctrl+B        definition / usages (LSP first, regex fallback)
  Cmd/Ctrl+Down     jump to symbol under cursor
  Cmd/Ctrl+Alt+B    go to implementation
  Cmd/Ctrl+Alt+O    workspace symbol search
  Cmd/Ctrl+8        change impact for the current symbol
`);
}
