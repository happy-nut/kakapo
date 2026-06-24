import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { FlowConfig } from "./types.js";
import { AGENT_SNIPPET_FILE, CONFIG_FILE, DECISIONS_FILE, FLOW_DIR, GITIGNORE_FILE, STATE_FILE } from "./constants.js";
import { parsePositiveInteger, readOption } from "./util.js";
import { git } from "./git.js";

const nodeRequire = createRequire(import.meta.url);

export function main(): void {
  const rawArgs = process.argv.slice(2);
  const [command, ...args] = rawArgs;

  try {
    if (!command) {
      openCurrentRepository([]);
      return;
    }
    if (command !== "--help" && command !== "-h" && command.startsWith("-")) {
      openCurrentRepository(rawArgs);
      return;
    }

    switch (command) {
      case "init":
        initFlow(args);
        break;
      case "install":
        installFlow(args);
        break;
      case "app":
      case "review":
        launchReviewApp(args);
        break;
      case "open":
        openCurrentRepository(args);
        break;
      case "--help":
      case "-h":
      case "help":
        printHelp();
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`monacori: ${message}`);
    process.exit(1);
  }
}

function initFlow(args: string[]): void {
  const force = args.includes("--force");
  const quiet = args.includes("--quiet");
  const root = process.cwd();
  const flowPath = join(root, FLOW_DIR);
  mkdirSync(flowPath, { recursive: true });
  mkdirSync(join(flowPath, "reports"), { recursive: true });
  mkdirSync(join(flowPath, "logs"), { recursive: true });
  mkdirSync(join(flowPath, "diffs"), { recursive: true });

  const config: FlowConfig = {
    version: 1,
    projectName: basename(root),
    verification: {
      commands: detectVerificationCommands(root),
    },
    diff: {
      context: 12,
      includeUntracked: false,
    },
  };

  writeIfMissing(join(flowPath, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, force);
  writeIfMissing(join(flowPath, STATE_FILE), initialState(config), force);
  writeIfMissing(join(flowPath, DECISIONS_FILE), initialDecisions(), force);
  const ignored = ensureMonacoriGitignore(root);

  if (!quiet) {
    console.log(`Initialized ${FLOW_DIR}/ in ${root}`);
    if (ignored) {
      console.log(`Updated ${GITIGNORE_FILE} to ignore ${FLOW_DIR}/ validation artifacts.`);
    }
    console.log("Next: run `mo` to open the diff review app.");
  }
}

function installFlow(args: string[]): void {
  const force = args.includes("--force");
  const applyAgentDocs = args.includes("--apply-agent-docs");
  initFlow(["--quiet"]);
  writeIfMissing(join(process.cwd(), FLOW_DIR, AGENT_SNIPPET_FILE), agentSnippet(), force);
  if (applyAgentDocs) {
    applyAgentDocSnippet("AGENTS.md");
    applyAgentDocSnippet("CLAUDE.md");
  }

  console.log("Installed monacori validation instructions.");
  console.log(`- ${FLOW_DIR}/${AGENT_SNIPPET_FILE}`);
  if (applyAgentDocs) {
    console.log("- Updated AGENTS.md / CLAUDE.md validation snippets where available.");
  } else {
    console.log(`Next: add ${FLOW_DIR}/${AGENT_SNIPPET_FILE} to your agent instructions if desired.`);
  }
}

function launchReviewApp(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printAppHelp();
    return;
  }
  // Review the directory given by --cwd, so `mo --cwd <path>` (or `npm run dev -- --cwd <path>`) can
  // open ANY repo from anywhere; defaults to the current directory. chdir up front so the flow state,
  // config, and the launched app all resolve against the same repo.
  const targetCwd = resolve(readOption(args, "--cwd") ?? process.cwd());
  if (!existsSync(targetCwd)) {
    throw new Error(`Directory does not exist: ${targetCwd}`);
  }
  process.chdir(targetCwd);
  ensureWritableFlowState();

  const config = loadConfig();
  const contextValue = readOption(args, "--context");
  const context = contextValue ? parsePositiveInteger(contextValue, "--context") : config.diff.context;
  const appArgs = [
    appMainPath(),
    "--cwd",
    process.cwd(),
    "--context",
    String(context),
  ];
  const base = readOption(args, "--base");
  if (base) appArgs.push("--base", base);
  if (args.includes("--staged")) appArgs.push("--staged");
  if (args.includes("--include-untracked") || config.diff.includeUntracked) appArgs.push("--include-untracked");
  if (args.includes("--no-watch")) appArgs.push("--no-watch");

  const electronBinary = resolveElectronBinary();
  // In dev only (`npm run dev` sets MONACORI_DEV=1) announce which build is launching, so a local
  // checkout is distinguishable from the installed package. Normal `mo` runs stay silent — the shell
  // should be clean, not littered with our internal path.
  if (process.env.MONACORI_DEV === "1") {
    console.error(`monacori: launching ${appMainPath()}`);
  }
  if (args.includes("--foreground")) {
    const result = spawnSync(electronBinary, appArgs, { stdio: "inherit" });
    process.exit(result.status ?? 0);
  }

  const child = spawn(electronBinary, appArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log("Opened monacori review app.");
}

function openCurrentRepository(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printOpenHelp();
    return;
  }

  const appArgs = args.filter((arg) => arg !== "--tracked-only");
  if (!args.includes("--tracked-only") && !args.includes("--staged") && !args.includes("--include-untracked")) {
    appArgs.push("--include-untracked");
  }
  launchReviewApp(appArgs);
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

function initialState(config: FlowConfig): string {
  return [
    "# Monacori Validation State",
    "",
    `Project: ${config.projectName}`,
    `Initialized: ${new Date().toISOString()}`,
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

function agentSnippet(): string {
  return [
    "<!-- MONACORI:START -->",
    "## monacori Diff Review",
    "",
    "This repository uses monacori to help humans review AI-generated code changes side-by-side.",
    "",
    "After making code changes:",
    "",
    "- The user can run `mo` to open the diff review app and inspect your changes.",
    "- Inspect changed hunks with F7 / Shift+F7.",
    "- Use Shift Shift in the diff review to search indexed files, including unchanged files.",
    "- In source previews, use Cmd/Ctrl+Down to jump to the declaration-like match under the cursor.",
    "- Inline comments left in the review are bundled into a prompt and sent back to the session.",
    "<!-- MONACORI:END -->",
    "",
  ].join("\n");
}

function applyAgentDocSnippet(fileName: string): void {
  const path = join(process.cwd(), fileName);
  const snippet = agentSnippet();
  if (!existsSync(path)) {
    writeFileSync(path, `# ${fileName}\n\n${snippet}`);
    return;
  }

  const current = readFileSync(path, "utf8");
  const markerPattern = /<!-- MONACORI:START -->[\s\S]*?<!-- MONACORI:END -->\n?/;
  const next = markerPattern.test(current)
    ? current.replace(markerPattern, snippet)
    : `${current.trimEnd()}\n\n${snippet}`;
  writeFileSync(path, next);
}

function ensureInitialized(): void {
  if (!existsSync(join(process.cwd(), FLOW_DIR, CONFIG_FILE))) {
    throw new Error(`Missing ${FLOW_DIR}/. Run \`monacori init\` first.`);
  }
}

function ensureWritableFlowState(): void {
  if (!existsSync(join(process.cwd(), FLOW_DIR, CONFIG_FILE))) {
    initFlow(["--quiet"]);
    return;
  }
  ensureMonacoriGitignore(process.cwd());
}

function loadConfig(): FlowConfig {
  ensureInitialized();
  const raw = JSON.parse(readFileSync(join(process.cwd(), FLOW_DIR, CONFIG_FILE), "utf8")) as Partial<FlowConfig>;
  return {
    version: 1,
    projectName: raw.projectName ?? basename(process.cwd()),
    verification: {
      commands: Array.isArray(raw.verification?.commands) ? raw.verification.commands : [],
    },
    diff: {
      context: typeof raw.diff?.context === "number" ? raw.diff.context : 12,
      includeUntracked: typeof raw.diff?.includeUntracked === "boolean" ? raw.diff.includeUntracked : false,
    },
  };
}

function writeIfMissing(path: string, content: string, force: boolean): void {
  if (!force && existsSync(path)) {
    return;
  }
  writeFileSync(path, content);
}

function ensureMonacoriGitignore(root: string): boolean {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return false;
  }

  const path = join(root, GITIGNORE_FILE);
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  const hasEntry = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === FLOW_DIR || line === `${FLOW_DIR}/`);
  if (hasEntry) {
    return false;
  }

  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, `${content}${prefix}# monacori local validation artifacts\n${FLOW_DIR}/\n`);
  return true;
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
  console.log(`monacori

Desktop review app for AI-generated code changes.

Usage:
  mo
  monacori open [--base HEAD] [--staged] [--tracked-only]
  monacori app [--base HEAD] [--staged] [--include-untracked]
  monacori init [--force]
  monacori install [--force] [--apply-agent-docs]

Diff review keys:
  F7         next changed hunk
  Shift+F7  previous changed hunk
  Shift Shift file search across indexed files
  Cmd/Ctrl+E recent files
  Cmd/Ctrl+Down jump to symbol under cursor
`);
}

function printOpenHelp(): void {
  console.log(`monacori open

Open the local desktop review app for the current directory. This is the default command behind \`mo\` and \`monacori\` with no arguments.

It auto-initializes .monacori/ when needed, makes sure .monacori/ is ignored in Git worktrees, and includes untracked files by default so new AI-created files are visible.

Usage:
  mo
  monacori open [--base HEAD] [--staged] [--tracked-only] [--context 12] [--no-watch] [--foreground]

Options:
  --tracked-only  inspect tracked changes only
`);
}

function printAppHelp(): void {
  console.log(`monacori app

Launch the local desktop review app. The app reads Git diff and source files directly from this repository, writes a local review file under .monacori/, and refreshes when the working tree changes. It does not start an HTTP server.

Usage:
  monacori app [--base HEAD] [--staged] [--include-untracked] [--context 12] [--no-watch] [--foreground]

Aliases:
  mo
  monacori open
  monacori review
`);
}
