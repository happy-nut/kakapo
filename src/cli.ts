#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

type AgentName = "manual" | "codex" | "claude";
type PromptRole = "worker" | "reviewer";
type SessionRole = "planner" | "worker" | "reviewer";

type FlowConfig = {
  version: 1;
  projectName: string;
  defaultAgent: AgentName;
  verification: {
    commands: string[];
  };
};

type GitSnapshot = {
  branch: string;
  status: string;
  diffStat: string;
  recentCommits: string;
};

type Task = {
  id: string;
  title: string;
  done: boolean;
  raw: string;
};

type DiffLine = {
  kind: "context" | "add" | "delete";
  oldLine?: number;
  newLine?: number;
  text: string;
};

type DiffHunk = {
  header: string;
  title: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

type DiffFile = {
  oldPath: string;
  newPath: string;
  displayPath: string;
  status: string;
  binary: boolean;
  hunks: DiffHunk[];
};

type DiffTreeNode = {
  name: string;
  path: string;
  children: Map<string, DiffTreeNode>;
  file?: {
    index: number;
    firstHunk: number;
    hunkCount: number;
    status: string;
    displayPath: string;
  };
};

type DiffReviewResult = {
  path: string;
  url: string;
  files: number;
  hunks: number;
};

type DiffReviewBuild = {
  html: string;
  files: number;
  hunks: number;
  signature: string;
  generatedAt: string;
};

type SourceFile = {
  path: string;
  name: string;
  language: string;
  content: string;
  size: number;
  changed: boolean;
  embedded: boolean;
  skippedReason?: string;
};

type SourceTreeNode = {
  name: string;
  path: string;
  children: Map<string, SourceTreeNode>;
  file?: SourceFile;
};

const FLOW_DIR = ".ai-flow";
const GITIGNORE_FILE = ".gitignore";
const CONFIG_FILE = "config.json";
const STATE_FILE = "state.md";
const TASKS_FILE = "tasks.md";
const DECISIONS_FILE = "decisions.md";
const AGENT_SNIPPET_FILE = "agent-snippet.md";
const CMUX_FILE = "cmux.md";
const ROLES_DIR = "roles";
const SOURCE_MAX_FILE_BYTES = 220_000;
const SOURCE_MAX_TOTAL_BYTES = 5_000_000;
const SOURCE_MAX_FILES = 1200;

function main(): void {
  const [command = "--help", ...args] = process.argv.slice(2);

  try {
    switch (command) {
      case "init":
        initFlow(args);
        break;
      case "install":
        installFlow(args);
        break;
      case "go":
        bootstrapPlanner(args);
        break;
      case "start":
        startSession(args);
        break;
      case "finish":
        finishSession(args);
        break;
      case "dispatch":
        dispatchSession(args);
        break;
      case "doctor":
        printDoctor();
        break;
      case "diff":
        renderDiffReview(args);
        break;
      case "status":
        printStatus();
        break;
      case "next":
        printNext(args);
        break;
      case "prompt":
        printPromptCommand(args);
        break;
      case "report":
        recordReport(args);
        break;
      case "verify":
        runVerification(args);
        break;
      case "run":
        runAgent(args);
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
    console.error(`ai-flow: ${message}`);
    process.exit(1);
  }
}

function initFlow(args: string[]): void {
  const force = args.includes("--force");
  const quiet = args.includes("--quiet");
  const root = process.cwd();
  const flowPath = join(root, FLOW_DIR);
  mkdirSync(flowPath, { recursive: true });
  mkdirSync(join(flowPath, "prompts"), { recursive: true });
  mkdirSync(join(flowPath, "reports"), { recursive: true });
  mkdirSync(join(flowPath, "logs"), { recursive: true });
  mkdirSync(join(flowPath, "diffs"), { recursive: true });
  mkdirSync(join(flowPath, ROLES_DIR), { recursive: true });

  const config: FlowConfig = {
    version: 1,
    projectName: basename(root),
    defaultAgent: "manual",
    verification: {
      commands: detectVerificationCommands(root),
    },
  };

  writeIfMissing(
    join(flowPath, CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
    force,
  );
  writeIfMissing(join(flowPath, STATE_FILE), initialState(config), force);
  writeIfMissing(join(flowPath, TASKS_FILE), initialTasks(), force);
  writeIfMissing(join(flowPath, DECISIONS_FILE), initialDecisions(), force);
  const ignored = ensureAiFlowGitignore(root);

  if (!quiet) {
    console.log(`Initialized ${FLOW_DIR}/ in ${root}`);
    if (ignored) {
      console.log(`Updated ${GITIGNORE_FILE} to ignore ${FLOW_DIR}/ local orchestration state.`);
    }
    console.log("Next: run `ai-flow install --apply-agent-docs` for role-based sessions.");
  }
}

function installFlow(args: string[]): void {
  const force = args.includes("--force");
  const applyAgentDocs = args.includes("--apply-agent-docs");
  initFlow(["--quiet"]);
  writeRoleFiles(force);
  writeIfMissing(join(process.cwd(), FLOW_DIR, CMUX_FILE), cmuxGuide(), force);
  writeIfMissing(
    join(process.cwd(), FLOW_DIR, AGENT_SNIPPET_FILE),
    agentSnippet(),
    force,
  );
  if (applyAgentDocs) {
    applyAgentDocSnippet("AGENTS.md");
    applyAgentDocSnippet("CLAUDE.md");
  }

  console.log("Installed ai-flow role sessions.");
  console.log(`- ${FLOW_DIR}/${ROLES_DIR}/planner.md`);
  console.log(`- ${FLOW_DIR}/${ROLES_DIR}/worker.md`);
  console.log(`- ${FLOW_DIR}/${ROLES_DIR}/reviewer.md`);
  console.log(`- ${FLOW_DIR}/${CMUX_FILE}`);
  if (applyAgentDocs) {
    console.log("- Updated AGENTS.md / CLAUDE.md role trigger snippets where available.");
  } else {
    console.log(`Next: add ${FLOW_DIR}/${AGENT_SNIPPET_FILE} to your agent instructions.`);
  }
}

function bootstrapPlanner(args: string[]): void {
  const dryRun = args.includes("--dry-run");
  const noCmux = args.includes("--no-cmux");
  const applyAgentDocs = args.includes("--apply-agent-docs");
  const force = args.includes("--force");
  const explicitAgent = readOption(args, "--agent");
  const objective = readFreeformObjective(args, new Set(["--agent", "--message"]));
  const message = readOption(args, "--message") ?? objective;

  initFlow(["--quiet"]);
  writeRoleFiles(force);
  writeIfMissing(join(process.cwd(), FLOW_DIR, CMUX_FILE), cmuxGuide(), force);
  writeIfMissing(join(process.cwd(), FLOW_DIR, AGENT_SNIPPET_FILE), agentSnippet(), force);
  if (applyAgentDocs) {
    applyAgentDocSnippet("AGENTS.md");
    applyAgentDocSnippet("CLAUDE.md");
  }

  const agent = selectPlannerAgent(explicitAgent);
  const prompt = plannerBootPrompt({
    agent,
    objective: message,
    autoDispatch: !args.includes("--no-auto-dispatch"),
  });
  const promptPath = savePrompt("planner", "planner", agent, prompt);
  const launchCommand = buildAgentReadPromptCommand(agent, "planner", promptPath);
  const cmuxAvailable = commandExists("cmux");
  const inCmux = Boolean(currentCmuxWorkspace());

  if (dryRun) {
    console.log("# ai-flow go");
    console.log("");
    console.log(`Agent: ${agent}`);
    console.log(`Prompt: ${relative(process.cwd(), promptPath)}`);
    console.log(`cmux: ${cmuxAvailable ? "available" : "missing"}`);
    console.log(`inside cmux: ${inCmux ? "yes" : "no"}`);
    console.log("");
    console.log("## Planner command");
    console.log(codeBlock(launchCommand));
    return;
  }

  if (!noCmux && cmuxAvailable && !inCmux) {
    const workspace = openPlannerInCmux(launchCommand);
    if (workspace) {
      appendToState(
        `\n## Planner Boot ${timestampForFile()}\n\n- Agent: ${agent}\n- Prompt: ${relative(process.cwd(), promptPath)}\n- cmux workspace: ${workspace}\n`,
      );
      console.log(`Opened Planner in cmux workspace ${workspace}.`);
      return;
    }
    console.log("cmux is installed, but ai-flow could not create a workspace. Starting Planner in this terminal instead.");
  }

  appendToState(
    `\n## Planner Boot ${timestampForFile()}\n\n- Agent: ${agent}\n- Prompt: ${relative(process.cwd(), promptPath)}\n- cmux workspace: ${inCmux ? currentCmuxWorkspace() : "none"}\n`,
  );
  runInteractiveShell(launchCommand);
}

function startSession(args: string[]): void {
  const [roleArg = "planner", ...rest] = args;
  const role = parseSessionRole(roleArg);
  if (!existsSync(join(process.cwd(), FLOW_DIR, CONFIG_FILE))) {
    initFlow(["--quiet"]);
    writeRoleFiles(false);
  }

  const agent = parseAgent(readOption(rest, "--agent") ?? loadConfig().defaultAgent);
  const taskId = readOption(rest, "--task");
  const save = !rest.includes("--no-save");
  const brief = role === "planner"
    ? plannerBrief({ agent })
    : buildPrompt({ agent, role, taskId, save: false });

  if (save) {
    const promptPath = join(
      process.cwd(),
      FLOW_DIR,
      "prompts",
      `${timestampForFile()}-${role}-${agent}.md`,
    );
    writeFileSync(promptPath, brief);
  }

  console.log(brief);
}

function finishSession(args: string[]): void {
  const [roleArg = "worker", ...rest] = args;
  const role = parseSessionRole(roleArg);
  ensureInitialized();
  const taskId = readOption(rest, "--task") ?? currentTaskId();
  const file = readOption(rest, "--file");
  const complete = rest.includes("--complete");
  const openDiff = role === "worker" && !rest.includes("--no-diff");
  const body = file ? readFileSync(file, "utf8") : readStdin();
  if (body.trim().length === 0) {
    throw new Error("No finish report provided. Pass --file or pipe report text on stdin.");
  }

  const timestamp = timestampForFile();
  const reportPath = saveReport(role, taskId, body, timestamp);
  if (complete) {
    markTaskComplete(taskId);
  }
  appendToState(
    `\n## ${capitalize(role)} Finish ${timestamp} (${taskId})\n\n${summarizeForState(body)}\n`,
  );
  console.log(`Recorded ${relative(process.cwd(), reportPath)}`);
  if (complete) {
    console.log(`Marked ${taskId} complete.`);
  }
  if (openDiff) {
    openDiffReviewAfterWorker(taskId);
  }
}

function dispatchSession(args: string[]): void {
  ensureInitialized();
  const [roleArg = "worker", ...rest] = args;
  const role = parseRole(roleArg);
  const agent = parseAgent(readOption(rest, "--agent") ?? loadConfig().defaultAgent);
  if (agent === "manual") {
    throw new Error("Use --agent codex or --agent claude with dispatch.");
  }

  const taskId = readOption(rest, "--task");
  const dryRun = rest.includes("--dry-run");
  const noCmux = rest.includes("--no-cmux");
  const tasks = parseTasks(readFlowFile(TASKS_FILE));
  const task = selectTask(tasks, taskId);
  const prompt = buildPrompt({ agent, role, taskId: task.id, save: false });
  const promptPath = savePrompt(role, task.id, agent, prompt);
  const launchCommand = buildAgentReadPromptCommand(agent, role, promptPath);

  if (dryRun || noCmux) {
    console.log(`# ai-flow dispatch ${role} (${task.id})`);
    console.log("");
    console.log(`Prompt: ${relative(process.cwd(), promptPath)}`);
    console.log("");
    console.log("## Agent command");
    console.log(codeBlock(launchCommand));
    console.log("");
    console.log("## cmux behavior");
    console.log("When cmux is available, ai-flow creates a right-side terminal pane and sends that command there.");
    return;
  }

  const result = dispatchToCmux(launchCommand, role, task.id);
  appendToState(
    `\n## Dispatch ${timestampForFile()} (${task.id})\n\n- Role: ${role}\n- Agent: ${agent}\n- Prompt: ${relative(process.cwd(), promptPath)}\n- cmux workspace: ${result.workspace}\n- cmux surface: ${result.surface}\n`,
  );
  console.log(`Dispatched ${role} ${task.id} to cmux ${result.surface}.`);
  console.log(`Prompt: ${relative(process.cwd(), promptPath)}`);
}

function printDoctor(): void {
  const cmux = commandExists("cmux");
  const codex = commandExists("codex");
  const claude = commandExists("claude");
  const inCmux = Boolean(process.env.CMUX_WORKSPACE_ID || process.env.CMUX_SURFACE_ID);

  console.log("# ai-flow doctor");
  console.log("");
  console.log(`cmux: ${cmux ? "found" : "missing"}`);
  console.log(`inside cmux workspace: ${inCmux ? "yes" : "no"}`);
  console.log(`codex CLI: ${codex ? "found" : "missing"}`);
  console.log(`claude CLI: ${claude ? "found" : "missing"}`);
  console.log("");

  if (!cmux) {
    console.log("Next: install cmux from https://cmux.com/ or with Homebrew:");
    console.log(codeBlock("brew tap manaflow-ai/cmux\nbrew install --cask cmux"));
  } else if (!inCmux) {
    console.log("Next: open this repository in cmux, start one Planner agent session there, then tell it what you want built.");
  } else if (!codex && !claude) {
    console.log("Next: install either Codex CLI or Claude Code so Planner can dispatch Worker sessions.");
  } else {
    console.log("Ready: tell the current agent to use Planner mode. The Planner can dispatch Worker/Reviewer sessions for you.");
  }
}

function renderDiffReview(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printDiffHelp();
    return;
  }

  if (!existsSync(join(process.cwd(), FLOW_DIR, CONFIG_FILE))) {
    initFlow(["--quiet"]);
  }

  const contextValue = readOption(args, "--context");
  const context = contextValue ? parsePositiveInteger(contextValue, "--context") : 12;
  const base = readOption(args, "--base");
  const staged = args.includes("--staged");
  const includeUntracked = args.includes("--include-untracked");
  const openInBrowser = args.includes("--open");
  const openInCmux = args.includes("--cmux");
  const watch = args.includes("--watch");

  if (watch) {
    serveDiffWatch({
      base,
      staged,
      includeUntracked,
      context,
      openInBrowser,
      openInCmux,
      port: readOption(args, "--port"),
    });
    return;
  }

  const output = readOption(args, "--output") ??
    join(process.cwd(), FLOW_DIR, "diffs", `${timestampForFile()}-review.html`);
  const result = createDiffReview({
    base,
    staged,
    includeUntracked,
    context,
    output,
    title: "ai-flow diff review",
  });

  if (openInCmux) {
    openCmuxBrowser(result.url);
  }
  if (openInBrowser) {
    spawnSync("open", [result.path], { stdio: "ignore" });
  }

  console.log(`Diff review: ${relative(process.cwd(), result.path)}`);
  console.log(`URL: ${result.url}`);
  console.log(`Files: ${result.files}`);
  console.log(`Hunks: ${result.hunks}`);
  console.log("Keys: F7 next change, Shift+F7 previous change, [ and ] as fallbacks.");
}

function printStatus(): void {
  ensureInitialized();
  const config = loadConfig();
  const git = readGitSnapshot(process.cwd());
  const tasks = parseTasks(readFlowFile(TASKS_FILE));
  const active = tasks.find((task) => !task.done);
  const completed = tasks.filter((task) => task.done).length;
  const reports = listRecentFiles(join(process.cwd(), FLOW_DIR, "reports"), 5);

  console.log(`# ${config.projectName} status`);
  console.log("");
  console.log(`Branch: ${git.branch || "(unknown)"}`);
  console.log(`Tasks: ${completed}/${tasks.length} complete`);
  console.log(`Next task: ${active ? `${active.id} ${active.title}` : "none"}`);
  console.log("");
  console.log("## Git status");
  console.log(git.status || "clean");
  console.log("");
  console.log("## Diff stat");
  console.log(git.diffStat || "no diff");
  console.log("");
  console.log("## Verification commands");
  for (const command of getVerificationCommands(config)) {
    console.log(`- ${command}`);
  }
  console.log("");
  console.log("## Recent reports");
  if (reports.length === 0) {
    console.log("none");
  } else {
    for (const report of reports) {
      console.log(`- ${relative(process.cwd(), report)}`);
    }
  }
}

function printNext(args: string[]): void {
  ensureInitialized();
  const agent = parseAgent(readOption(args, "--agent") ?? loadConfig().defaultAgent);
  const role = parseRole(readOption(args, "--role") ?? "worker");
  const taskId = readOption(args, "--task");
  const save = !args.includes("--no-save");
  const prompt = buildPrompt({ agent, role, taskId, save });
  console.log(prompt);
}

function printPromptCommand(args: string[]): void {
  const [roleArg = "worker", ...rest] = args;
  const role = parseRole(roleArg);
  const agent = parseAgent(readOption(rest, "--agent") ?? loadConfig().defaultAgent);
  const taskId = readOption(rest, "--task");
  const save = !rest.includes("--no-save");
  const prompt = buildPrompt({ agent, role, taskId, save });
  console.log(prompt);
}

function recordReport(args: string[]): void {
  ensureInitialized();
  const file = readOption(args, "--file");
  const taskId = readOption(args, "--task") ?? "unknown-task";
  const body = file ? readFileSync(file, "utf8") : readStdin();
  if (body.trim().length === 0) {
    throw new Error("No report content provided. Pass --file or pipe report text on stdin.");
  }

  const timestamp = timestampForFile();
  const reportPath = saveReport("worker", taskId, body, timestamp);
  appendToState(`\n## Report ${timestamp} (${taskId})\n\n${summarizeForState(body)}\n`);
  console.log(`Recorded ${relative(process.cwd(), reportPath)}`);
}

function runVerification(args: string[]): void {
  ensureInitialized();
  const separator = args.indexOf("--");
  const explicitCommand = separator >= 0 ? args.slice(separator + 1).join(" ") : "";
  const config = loadConfig();
  const commands = explicitCommand ? [explicitCommand] : getVerificationCommands(config);
  if (commands.length === 0) {
    throw new Error("No verification commands found. Add them to .ai-flow/config.json.");
  }

  const logPath = join(process.cwd(), FLOW_DIR, "logs", `verify-${timestampForFile()}.log`);
  const chunks: string[] = [];
  let failed = false;

  for (const command of commands) {
    chunks.push(`$ ${command}\n`);
    const result = spawnSync(command, {
      cwd: process.cwd(),
      shell: true,
      encoding: "utf8",
      env: process.env,
    });
    chunks.push(result.stdout ?? "");
    chunks.push(result.stderr ?? "");
    chunks.push(`\nexit: ${result.status ?? 1}\n\n`);
    if ((result.status ?? 1) !== 0) {
      failed = true;
      break;
    }
  }

  writeFileSync(logPath, chunks.join(""));
  console.log(`Verification log: ${relative(process.cwd(), logPath)}`);
  if (failed) {
    console.error("Verification failed.");
    process.exit(1);
  }
  console.log("Verification passed.");
}

function runAgent(args: string[]): void {
  ensureInitialized();
  const [roleArg = "worker", ...rest] = args;
  const role = parseRole(roleArg);
  const agent = parseAgent(readOption(rest, "--agent") ?? loadConfig().defaultAgent);
  if (agent === "manual") {
    throw new Error("Use --agent codex or --agent claude with `run`, or use `prompt` for manual copy.");
  }

  const taskId = readOption(rest, "--task");
  const dryRun = rest.includes("--dry-run");
  const nonInteractive = rest.includes("--print") || rest.includes("--non-interactive");
  const prompt = buildPrompt({ agent, role, taskId, save: true });
  const launch = buildLaunch(agent, prompt, nonInteractive);

  if (dryRun) {
    console.log([launch.command, ...launch.args.map(shellQuote)].join(" "));
    return;
  }

  const result = spawnSync(launch.command, launch.args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function buildPrompt(options: {
  agent: AgentName;
  role: PromptRole;
  taskId?: string;
  save: boolean;
}): string {
  ensureInitialized();
  const root = process.cwd();
  const config = loadConfig();
  const git = readGitSnapshot(root);
  const tasksText = readFlowFile(TASKS_FILE);
  const tasks = parseTasks(tasksText);
  const task = selectTask(tasks, options.taskId);
  const commands = getVerificationCommands(config);
  const state = readFlowFile(STATE_FILE);
  const decisions = readFlowFile(DECISIONS_FILE);

  const prompt =
    options.role === "reviewer"
      ? reviewerPrompt({ config, git, task, commands, state, decisions })
      : workerPrompt({ config, git, task, commands, state, decisions, agent: options.agent });

  if (options.save) {
    savePrompt(options.role, task.id, options.agent, prompt);
  }

  return prompt;
}

function workerPrompt(input: {
  config: FlowConfig;
  git: GitSnapshot;
  task: Task;
  commands: string[];
  state: string;
  decisions: string;
  agent: AgentName;
}): string {
  return [
    `# AI Flow Worker Task (${input.task.id})`,
    "",
    "You are the implementation worker for this repository. Complete exactly one slice, verify it, and then stop.",
    "",
    "## Task",
    `${input.task.id}: ${input.task.title}`,
    "",
    "## Operating Rules",
    "- Inspect the relevant code before editing.",
    "- Do not expand scope beyond this task unless the current code makes that impossible.",
    "- Prefer existing project patterns over new abstractions.",
    "- Keep the diff small and reviewable.",
    "- Run the listed verification commands, or explain precisely why a command cannot run.",
    "- Finish with the required report format. Do not claim completion without verification evidence.",
    "",
    "## Current Repository State",
    `Project: ${input.config.projectName}`,
    `Branch: ${input.git.branch || "(unknown)"}`,
    "",
    "### Git Status",
    codeBlock(truncateText(input.git.status || "clean", 5000)),
    "",
    "### Diff Stat",
    codeBlock(truncateText(input.git.diffStat || "no diff", 3500)),
    "",
    "## Durable State",
    truncateMarkdown(input.state, 2400),
    "",
    "## Decisions",
    truncateMarkdown(input.decisions, 1600),
    "",
    "## Verification",
    input.commands.length > 0
      ? input.commands.map((command) => `- \`${command}\``).join("\n")
      : "- No commands detected. Identify and run the smallest meaningful validation.",
    "",
    "## Required Final Report",
    "- Changed files",
    "- Verification commands and results",
    "- Behavior completed",
    "- Remaining risks or follow-up tasks",
    "",
    "When you record completion with `ai-flow finish worker`, ai-flow creates a visual diff review automatically and opens it in cmux when available.",
    "",
  ].join("\n");
}

function reviewerPrompt(input: {
  config: FlowConfig;
  git: GitSnapshot;
  task: Task;
  commands: string[];
  state: string;
  decisions: string;
}): string {
  return [
    `# AI Flow Reviewer Task (${input.task.id})`,
    "",
    "You are the read-focused reviewer. Review the current repository state against the assigned task and report findings first.",
    "",
    "## Review Target",
    `${input.task.id}: ${input.task.title}`,
    "",
    "## Rules",
    "- Do not edit files unless explicitly asked in a later prompt.",
    "- Prioritize correctness bugs, regressions, missing tests, and scope creep.",
    "- Ground each finding in a file path and line number when possible.",
    "- If there are no findings, say that clearly and name the residual risk.",
    "",
    "## Current Repository State",
    `Project: ${input.config.projectName}`,
    `Branch: ${input.git.branch || "(unknown)"}`,
    "",
    "### Git Status",
    codeBlock(truncateText(input.git.status || "clean", 5000)),
    "",
    "### Diff Stat",
    codeBlock(truncateText(input.git.diffStat || "no diff", 3500)),
    "",
    "## Durable State",
    truncateMarkdown(input.state, 2200),
    "",
    "## Decisions",
    truncateMarkdown(input.decisions, 1400),
    "",
    "## Suggested Verification",
    input.commands.length > 0
      ? input.commands.map((command) => `- \`${command}\``).join("\n")
      : "- No commands detected. Suggest targeted validation.",
    "",
    "## Required Output",
    "Findings first, ordered by severity. Then list test gaps and a short summary.",
    "",
  ].join("\n");
}

function plannerBrief(input: { agent: AgentName }): string {
  ensureInitialized();
  const config = loadConfig();
  const git = readGitSnapshot(process.cwd());
  const tasks = parseTasks(readFlowFile(TASKS_FILE));
  const active = tasks.find((task) => !task.done);
  const commands = getVerificationCommands(config);
  const state = readFlowFile(STATE_FILE);
  const decisions = readFlowFile(DECISIONS_FILE);

  return [
    "# AI Flow Planner Session",
    "",
    "You are the planning and coordination session for this repository. The user should not need to know or run ai-flow commands.",
    "",
    "## Mission",
    "- Read the repo state, durable state, and current task queue.",
    "- Decide what is already done, what is risky, and what the next small verifiable slice should be.",
    "- Update `.ai-flow/tasks.md`, `.ai-flow/state.md`, and `.ai-flow/decisions.md` when needed.",
    "- Produce a Worker-ready brief with scope, success criteria, and verification commands.",
    "- When a Worker or Reviewer should run separately, use `ai-flow dispatch worker|reviewer --agent codex|claude` so cmux handles the session split.",
    "- Do not implement product code unless the user explicitly changes this session into a Worker session.",
    "",
    "## Current Repository State",
    `Project: ${config.projectName}`,
    `Agent adapter: ${input.agent}`,
    `Branch: ${git.branch || "(unknown)"}`,
    `Next task: ${active ? `${active.id} ${active.title}` : "none"}`,
    "",
    "### Git Status",
    codeBlock(truncateText(git.status || "clean", 5000)),
    "",
    "### Diff Stat",
    codeBlock(truncateText(git.diffStat || "no diff", 3500)),
    "",
    "## Durable State",
    truncateMarkdown(state, 2600),
    "",
    "## Decisions",
    truncateMarkdown(decisions, 1600),
    "",
    "## Verification Available",
    commands.length > 0
      ? commands.map((command) => `- \`${command}\``).join("\n")
      : "- No root verification detected. Infer scoped validation from the touched subproject.",
    "",
    "## Required Planner Output",
    "- Current state in 3-7 bullets",
    "- Next Worker slice with a task id",
    "- Scope boundaries and files/areas to inspect",
    "- Acceptance criteria",
    "- Verification commands",
    "- Any risks or user decisions needed",
    "",
    "## Cleanup",
    "Before ending, write a short planner report and record it with `ai-flow finish planner --file <report-file>`.",
    "",
  ].join("\n");
}

function plannerBootPrompt(input: {
  agent: AgentName;
  objective: string;
  autoDispatch: boolean;
}): string {
  ensureInitialized();
  const config = loadConfig();
  const git = readGitSnapshot(process.cwd());
  const tasks = parseTasks(readFlowFile(TASKS_FILE));
  const active = tasks.find((task) => !task.done);
  const commands = getVerificationCommands(config);
  const state = readFlowFile(STATE_FILE);
  const decisions = readFlowFile(DECISIONS_FILE);
  const objective = input.objective.trim();
  return [
    "# AI Flow Planner Boot",
    "",
    "You are already in Planner mode. The user should not need to type an activation phrase or know cmux.",
    "",
    "## User-Facing Behavior",
    "- Do not print a formal `Planner Brief` unless the user explicitly asks for one.",
    "- Do not dump old `.ai-flow` progress on first contact. Treat it as private context.",
    "- If no user objective is provided, ask one concise question: what should we build or fix?",
    "- If there is existing `.ai-flow` progress and no objective, mention only that you can either resume existing work or start fresh. Do not list old tasks unless asked.",
    "- If a user objective is provided, create/update small verifiable tasks and start orchestration immediately.",
    input.autoDispatch
      ? `- When the first Worker slice is clear and no user decision is needed, immediately run \`ai-flow dispatch worker --agent ${input.agent} --task <task-id>\`; do not ask for confirmation just to create the Worker pane.`
      : "- Auto-dispatch is disabled. Prepare the first Worker slice, then wait for the user.",
    "- For active review while edits may still change, open `ai-flow diff --watch --cmux`; inspect changed hunks with F7 / Shift+F7.",
    "- Keep your visible response short: current action, Worker status if dispatched, and any question that genuinely blocks progress.",
    "",
    "## User Objective",
    objective || "(none provided yet)",
    "",
    "## Private Repository Context",
    `Project: ${config.projectName}`,
    `Agent adapter: ${input.agent}`,
    `Branch: ${git.branch || "(unknown)"}`,
    `Active task: ${active ? `${active.id} ${active.title}` : "none"}`,
    "",
    "### Git Status",
    codeBlock(truncateText(git.status || "clean", 5000)),
    "",
    "### Diff Stat",
    codeBlock(truncateText(git.diffStat || "no diff", 3500)),
    "",
    "### Durable State",
    truncateMarkdown(state, 2200),
    "",
    "### Decisions",
    truncateMarkdown(decisions, 1400),
    "",
    "### Verification Available",
    commands.length > 0
      ? commands.map((command) => `- \`${command}\``).join("\n")
      : "- No root verification detected. Infer scoped validation from the touched subproject.",
    "",
  ].join("\n");
}

function writeRoleFiles(force: boolean): void {
  const rolesPath = join(process.cwd(), FLOW_DIR, ROLES_DIR);
  mkdirSync(rolesPath, { recursive: true });
  writeIfMissing(join(rolesPath, "planner.md"), plannerRoleDoc(), force);
  writeIfMissing(join(rolesPath, "worker.md"), workerRoleDoc(), force);
  writeIfMissing(join(rolesPath, "reviewer.md"), reviewerRoleDoc(), force);
}

function plannerRoleDoc(): string {
  return [
    "# ai-flow Planner Role",
    "",
    "When the user says this is a Planner session, run the lifecycle yourself. Do not ask the user to run CLI commands.",
    "",
    "## Start",
    "Run:",
    "",
    "```bash",
    "ai-flow start planner",
    "```",
    "",
    "If `.ai-flow/` is missing, `start` initializes it.",
    "",
    "## Work",
    "- Inspect the current repo state and relevant code.",
    "- Update `.ai-flow/tasks.md`, `.ai-flow/state.md`, and `.ai-flow/decisions.md` as needed.",
    "- Keep tasks small, verifiable, and suitable for one Worker session.",
    "- Define acceptance criteria and validation commands.",
    "- If cmux is available, dispatch Workers and Reviewers with `ai-flow dispatch worker|reviewer --agent codex|claude`; do not make the user create panes manually.",
    "- For live review while edits may still change, open `ai-flow diff --watch --cmux`. Use F7/Shift+F7 to move by changed hunk, not just by file.",
    "- Do not edit product code unless the user explicitly changes this session into a Worker session.",
    "",
    "## Finish",
    "Write a short report and record it:",
    "",
    "```bash",
    "ai-flow finish planner --file <report-file>",
    "```",
    "",
  ].join("\n");
}

function workerRoleDoc(): string {
  return [
    "# ai-flow Worker Role",
    "",
    "When the user says this is a Worker session, run the lifecycle yourself. Do not ask the user to run CLI commands.",
    "",
    "## Start",
    "Run:",
    "",
    "```bash",
    "ai-flow start worker",
    "```",
    "",
    "## Work",
    "- Complete exactly one task slice.",
    "- Inspect the code before editing.",
    "- Keep the diff small and scoped.",
    "- Run the requested verification plus any subproject-specific checks.",
    "- Do not claim completion without verification evidence.",
    "",
    "## Finish",
    "Write a report with changed files, verification, completed behavior, and remaining risks. Then run:",
    "",
    "```bash",
    "ai-flow finish worker --task <task-id> --file <report-file> --complete",
    "```",
    "",
    "This automatically creates a visual diff review and opens it in cmux when available. Pass `--no-diff` only when the Planner explicitly does not need a visual review.",
    "",
    "Omit `--complete` if the task is not actually complete.",
    "",
  ].join("\n");
}

function reviewerRoleDoc(): string {
  return [
    "# ai-flow Reviewer Role",
    "",
    "When the user says this is a Reviewer session, run the lifecycle yourself. Do not ask the user to run CLI commands.",
    "",
    "## Start",
    "Run:",
    "",
    "```bash",
    "ai-flow start reviewer",
    "```",
    "",
    "## Work",
    "- Stay read-focused unless the user explicitly asks for fixes.",
    "- Review the current diff against `.ai-flow/tasks.md`, `.ai-flow/state.md`, and `.ai-flow/decisions.md`.",
    "- Prefer `ai-flow diff --watch --cmux` for live visual review. Use F7 for the next changed hunk and Shift+F7 for the previous changed hunk.",
    "- Findings first, ordered by severity.",
    "- Identify missing tests, scope creep, and risky assumptions.",
    "",
    "## Finish",
    "Write a review report and record it:",
    "",
    "```bash",
    "ai-flow finish reviewer --task <task-id> --file <report-file>",
    "```",
    "",
  ].join("\n");
}

function agentSnippet(): string {
  return [
    "<!-- AI-FLOW:START -->",
    "## ai-flow Role Sessions",
    "",
    "This repository uses ai-flow for role-based AI coding sessions.",
    "",
    "When the user says the session is `Planner`, `Worker`, or `Reviewer`, do not ask the user to run ai-flow commands. Run the matching lifecycle yourself:",
    "",
    "- Planner: read `.ai-flow/roles/planner.md`, then run `ai-flow start planner`.",
    "- Worker: read `.ai-flow/roles/worker.md`, then run `ai-flow start worker`.",
    "- Reviewer: read `.ai-flow/roles/reviewer.md`, then run `ai-flow start reviewer`.",
    "",
    "The normal user experience is: the user talks only to Planner. Planner uses `.ai-flow/cmux.md` and `ai-flow dispatch worker|reviewer --agent codex|claude` to create separate cmux sessions when available.",
    "For live review, use `ai-flow diff --watch --cmux`; use F7 for next changed hunk and Shift+F7 for previous changed hunk.",
    "",
    "At the end of the session, write a concise report and record it with `ai-flow finish <role> --file <report-file>`. Workers should pass `--complete` only after verification succeeds.",
    "",
    "The user-facing contract is role selection and review of results; CLI details are agent-internal.",
    "<!-- AI-FLOW:END -->",
    "",
  ].join("\n");
}

function cmuxGuide(): string {
  return [
    "# ai-flow cmux Guide",
    "",
    "This file is for agents, not end users.",
    "",
    "## User Experience",
    "- The user should only talk to the Planner session.",
    "- The user should not need to know cmux panes, surfaces, sockets, or ai-flow commands.",
    "- Planner is responsible for splitting work into small verified slices and dispatching Worker or Reviewer sessions.",
    "",
    "## Planner Dispatch",
    "Use:",
    "",
    "```bash",
    "ai-flow dispatch worker --agent codex --task <task-id>",
    "ai-flow dispatch reviewer --agent codex --task <task-id>",
    "ai-flow diff --watch --cmux",
    "```",
    "",
    "Use `--agent claude` when Claude Code is the preferred worker.",
    "",
    "## cmux Safety Rules",
    "- Prefer the current cmux workspace from `CMUX_WORKSPACE_ID`.",
    "- Do not change focus, switch workspaces, or close panes unless the user explicitly asks.",
    "- Dispatch should create or use helper terminal space without requiring the user to manage panes.",
    "- Use `ai-flow diff --watch --cmux` for a live review pane while edits may still change.",
    "- Navigate changed hunks with F7 / Shift+F7. The sidebar groups files as a folder tree.",
    "- If cmux is missing, run `ai-flow doctor` and explain the one missing setup step in plain language.",
    "",
    "## Completion Contract",
    "- Worker sessions must run scoped verification before `ai-flow finish worker --complete`.",
    "- Reviewer sessions stay read-focused and report findings first.",
    "- Planner reads reports and decides whether the slice is accepted, needs another Worker pass, or needs user input.",
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
  const markerPattern = /<!-- AI-FLOW:START -->[\s\S]*?<!-- AI-FLOW:END -->\n?/;
  const next = markerPattern.test(current)
    ? current.replace(markerPattern, snippet)
    : `${current.trimEnd()}\n\n${snippet}`;
  writeFileSync(path, next);
}

function buildLaunch(
  agent: Exclude<AgentName, "manual">,
  prompt: string,
  nonInteractive: boolean,
): { command: string; args: string[] } {
  if (agent === "codex") {
    return nonInteractive
      ? { command: "codex", args: ["exec", "--cd", process.cwd(), prompt] }
      : { command: "codex", args: ["--cd", process.cwd(), prompt] };
  }

  return nonInteractive
    ? { command: "claude", args: ["-p", prompt] }
    : { command: "claude", args: [prompt] };
}

function ensureInitialized(): void {
  if (!existsSync(join(process.cwd(), FLOW_DIR, CONFIG_FILE))) {
    throw new Error(`Missing ${FLOW_DIR}/. Run \`ai-flow init\` first.`);
  }
}

function loadConfig(): FlowConfig {
  ensureInitialized();
  return JSON.parse(readFlowFile(CONFIG_FILE)) as FlowConfig;
}

function getVerificationCommands(config: FlowConfig): string[] {
  return config.verification.commands.filter((command) => command.trim().length > 0);
}

function readFlowFile(name: string): string {
  return readFileSync(join(process.cwd(), FLOW_DIR, name), "utf8");
}

function writeIfMissing(path: string, content: string, force: boolean): void {
  if (!force && existsSync(path)) {
    return;
  }
  writeFileSync(path, content);
}

function ensureAiFlowGitignore(root: string): boolean {
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

  const prefix = content.length === 0
    ? ""
    : content.endsWith("\n")
      ? "\n"
      : "\n\n";
  writeFileSync(
    path,
    `${content}${prefix}# ai-flow local orchestration state\n${FLOW_DIR}/\n`,
  );
  return true;
}

function initialState(config: FlowConfig): string {
  return [
    "# AI Flow State",
    "",
    `Project: ${config.projectName}`,
    `Initialized: ${new Date().toISOString()}`,
    "",
    "## Goal",
    "- Define the current outcome in one or two sentences.",
    "",
    "## Current Status",
    "- Initialized ai-flow.",
    "",
    "## Completed",
    "",
    "## Active",
    "",
    "## Known Risks",
    "",
    "## Reports",
    "",
  ].join("\n");
}

function initialTasks(): string {
  return [
    "# AI Flow Tasks",
    "",
    "Use one checkbox per small vertical slice. Keep each task verifiable.",
    "",
    "- [ ] T001: Define the first implementation slice.",
    "",
  ].join("\n");
}

function initialDecisions(): string {
  return [
    "# AI Flow Decisions",
    "",
    "Record durable project decisions here so new sessions do not depend on chat memory.",
    "",
  ].join("\n");
}

function readGitSnapshot(root: string): GitSnapshot {
  return {
    branch: git(root, ["branch", "--show-current"]),
    status: git(root, ["status", "--short"]),
    diffStat: git(root, ["diff", "--stat"]),
    recentCommits: git(root, ["log", "--oneline", "-5"]),
  };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

function readUnifiedDiff(options: {
  base?: string;
  staged: boolean;
  context: number;
  includeUntracked: boolean;
}): string {
  const args = ["diff", "--no-ext-diff", "--find-renames", `--unified=${options.context}`];
  if (options.staged) {
    args.push("--cached");
  } else {
    args.push(options.base ?? "HEAD");
  }
  args.push("--");

  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "git diff failed");
  }

  const chunks = [result.stdout ?? ""];
  if (options.includeUntracked && !options.staged) {
    chunks.push(readUntrackedDiff(options.context));
  }
  return chunks.filter(Boolean).join("\n");
}

function readUntrackedDiff(context: number): string {
  const files = git(process.cwd(), ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(`${FLOW_DIR}/`));
  const chunks: string[] = [];

  for (const file of files) {
    const absolute = join(process.cwd(), file);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      continue;
    }
    const size = statSync(absolute).size;
    if (size > 500_000 || isLikelyBinary(absolute)) {
      chunks.push([
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "Binary files /dev/null and b/" + file + " differ",
      ].join("\n"));
      continue;
    }

    const content = readFileSync(absolute, "utf8");
    const lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }
    const limited = context > 0 ? lines : lines;
    chunks.push([
      `diff --git a/${file} b/${file}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file}`,
      `@@ -0,0 +1,${limited.length} @@`,
      ...limited.map((line) => `+${line}`),
    ].join("\n"));
  }

  return chunks.join("\n");
}

function collectSourceFiles(diffFiles: DiffFile[]): SourceFile[] {
  const changed = new Set(
    diffFiles
      .map((file) => file.displayPath)
      .filter((path) => path && path !== "/dev/null"),
  );
  const paths = new Set<string>();
  const gitFiles = git(process.cwd(), ["ls-files", "--cached", "--others", "--exclude-standard"]);
  for (const file of gitFiles.split(/\r?\n/)) {
    const path = file.trim();
    if (path && isSourceCandidate(path)) {
      paths.add(path);
    }
  }
  for (const path of changed) {
    if (isSourceCandidate(path)) {
      paths.add(path);
    }
  }

  const sourceFiles: SourceFile[] = [];
  let embeddedFiles = 0;
  let embeddedBytes = 0;

  for (const path of Array.from(paths).sort((a, b) => a.localeCompare(b))) {
    const absolute = join(process.cwd(), path);
    const base: SourceFile = {
      path,
      name: basename(path),
      language: languageForPath(path),
      content: "",
      size: 0,
      changed: changed.has(path),
      embedded: false,
    };

    if (!existsSync(absolute)) {
      sourceFiles.push({ ...base, skippedReason: "file is not present in the working tree" });
      continue;
    }

    const stats = statSync(absolute);
    if (!stats.isFile()) {
      continue;
    }

    if (isLikelyBinary(absolute)) {
      sourceFiles.push({ ...base, size: stats.size, skippedReason: "binary file" });
      continue;
    }

    if (stats.size > SOURCE_MAX_FILE_BYTES) {
      sourceFiles.push({ ...base, size: stats.size, skippedReason: `larger than ${formatBytes(SOURCE_MAX_FILE_BYTES)}` });
      continue;
    }

    if (embeddedFiles >= SOURCE_MAX_FILES || embeddedBytes + stats.size > SOURCE_MAX_TOTAL_BYTES) {
      sourceFiles.push({ ...base, size: stats.size, skippedReason: "source index budget reached" });
      continue;
    }

    sourceFiles.push({
      ...base,
      content: readFileSync(absolute, "utf8"),
      size: stats.size,
      embedded: true,
    });
    embeddedFiles += 1;
    embeddedBytes += stats.size;
  }

  return sourceFiles;
}

function isSourceCandidate(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith(`${FLOW_DIR}/`)) {
    return false;
  }
  const blocked = [
    ".git/",
    ".omc/",
    ".claude/",
    ".playwright-mcp/",
    "node_modules/",
    "dist/",
    "build/",
    "coverage/",
    "test-results/",
    "release/",
    ".next/",
    ".turbo/",
    ".cache/",
    ".granite/",
    ".pytest_cache/",
    "__pycache__/",
    "tmp/",
    "vendor/",
  ];
  if (blocked.some((part) => normalized === part.slice(0, -1) || normalized.includes(`/${part}`) || normalized.startsWith(part))) {
    return false;
  }
  const fileName = basename(normalized);
  if (fileName === ".DS_Store" || fileName.endsWith(".lockb")) {
    return false;
  }
  return true;
}

function parseUnifiedDiff(content: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const oldPath = match?.[1] ?? "unknown";
      const newPath = match?.[2] ?? oldPath;
      current = {
        oldPath,
        newPath,
        displayPath: newPath === "/dev/null" ? oldPath : newPath,
        status: "modified",
        binary: false,
        hunks: [],
      };
      files.push(current);
      hunk = undefined;
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("new file mode ")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length);
      current.displayPath = current.newPath;
      continue;
    }
    if (line.startsWith("--- ")) {
      current.oldPath = stripDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = stripDiffPath(line.slice(4));
      current.displayPath = current.newPath === "/dev/null" ? current.oldPath : current.newPath;
      continue;
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      hunk = {
        header: line,
        title: hunkMatch[5]?.trim() ?? "",
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      continue;
    }

    if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "delete", oldLine, text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      hunk.lines.push({ kind: "context", oldLine, newLine, text: line.slice(1) });
      oldLine += 1;
      newLine += 1;
    }
  }

  return files.filter((file) => file.binary || file.hunks.length > 0);
}

function buildDiffReview(input: {
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  title: string;
  watch?: boolean;
}): DiffReviewBuild {
  const diffText = readUnifiedDiff({
    base: input.base,
    staged: input.staged,
    context: input.context,
    includeUntracked: input.includeUntracked,
  });
  const files = parseUnifiedDiff(diffText);
  const sourceFiles = collectSourceFiles(files);
  const hunks = files.reduce((sum, file) => sum + file.hunks.length, 0);
  const generatedAt = new Date().toISOString();
  const signature = createHash("sha1")
    .update(diffText)
    .update("\n")
    .update(sourceFiles.map((file) => `${file.path}\0${file.size}\0${file.embedded ? file.content : file.skippedReason ?? ""}`).join("\n"))
    .digest("hex");
  const html = renderDiffHtml({
    files,
    sourceFiles,
    title: input.title,
    subtitle: diffSubtitle(input),
    watch: Boolean(input.watch),
    signature,
    generatedAt,
  });

  return {
    html,
    files: files.length,
    hunks,
    signature,
    generatedAt,
  };
}

function createDiffReview(input: {
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  output: string;
  title: string;
}): DiffReviewResult {
  const outputPath = resolve(input.output);
  const build = buildDiffReview({
    base: input.base,
    staged: input.staged,
    includeUntracked: input.includeUntracked,
    context: input.context,
    title: input.title,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, build.html);
  return {
    path: outputPath,
    url: pathToFileURL(outputPath).href,
    files: build.files,
    hunks: build.hunks,
  };
}

function serveDiffWatch(input: {
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  openInBrowser: boolean;
  openInCmux: boolean;
  port?: string;
}): void {
  const host = "127.0.0.1";
  const port = input.port ? parsePositiveInteger(input.port, "--port") : 0;
  const build = () => buildDiffReview({
    base: input.base,
    staged: input.staged,
    includeUntracked: input.includeUntracked,
    context: input.context,
    title: "ai-flow live diff",
    watch: true,
  });

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    try {
      if (requestUrl.pathname === "/__ai_flow_state") {
        const latest = build();
        writeHttpJson(response, {
          signature: latest.signature,
          generatedAt: latest.generatedAt,
          files: latest.files,
          hunks: latest.hunks,
        });
        return;
      }

      if (requestUrl.pathname === "/" || requestUrl.pathname === "/review") {
        const latest = build();
        writeHttp(response, 200, "text/html; charset=utf-8", latest.html);
        return;
      }

      writeHttp(response, 404, "text/plain; charset=utf-8", "Not found\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeHttp(response, 500, "text/plain; charset=utf-8", `${message}\n`);
    }
  });

  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ai-flow: diff watch server failed: ${message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const url = `http://${host}:${actualPort}/review`;
    console.log(`Live diff review: ${url}`);
    console.log("Watching working tree. Press Ctrl+C to stop.");
    if (input.openInCmux) {
      try {
        openCmuxBrowser(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`Could not open cmux diff pane: ${message}`);
      }
    }
    if (input.openInBrowser) {
      spawnSync("open", [url], { stdio: "ignore" });
    }
  });
}

function writeHttp(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

function writeHttpJson(response: ServerResponse, body: unknown): void {
  writeHttp(response, 200, "application/json; charset=utf-8", JSON.stringify(body));
}

function openDiffReviewAfterWorker(taskId: string): void {
  try {
    const result = createDiffReview({
      staged: false,
      includeUntracked: true,
      context: 12,
      output: join(process.cwd(), FLOW_DIR, "diffs", `${timestampForFile()}-${sanitizeFilePart(taskId)}-worker-review.html`),
      title: `ai-flow Worker diff (${taskId})`,
    });
    console.log(`Diff review: ${relative(process.cwd(), result.path)}`);
    console.log(`URL: ${result.url}`);
    if (!commandExists("cmux")) {
      return;
    }
    if (!process.env.CMUX_WORKSPACE_ID) {
      console.log("cmux workspace not detected; open the URL above or run `ai-flow diff --open`.");
      return;
    }
    try {
      openCmuxBrowser(result.url);
      console.log("Opened diff review in cmux.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Could not open cmux diff pane: ${message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`Could not create automatic diff review: ${message}`);
  }
}

function renderDiffHtml(input: {
  files: DiffFile[];
  sourceFiles: SourceFile[];
  title: string;
  subtitle: string;
  watch?: boolean;
  signature?: string;
  generatedAt?: string;
}): string {
  const totalHunks = input.files.reduce((sum, file) => sum + file.hunks.length, 0);
  const totalLines = input.files.reduce(
    (sum, file) => sum + file.hunks.reduce((inner, hunk) => inner + hunk.lines.length, 0),
    0,
  );
  const fileNav = renderDiffTree(input.files);
  const sourceNav = renderSourceTree(input.sourceFiles);
  const embeddedFiles = input.sourceFiles.filter((file) => file.embedded).length;

  let hunkIndex = 0;
  const files = input.files.map((file, fileIndex) => {
    const hunks = file.binary
      ? `<div class="binary">Binary file changed.</div>`
      : file.hunks.map((hunk) => renderHunk(file, hunk, hunkIndex++)).join("\n");
    return [
      `<section class="file" id="file-${fileIndex}">`,
      `<header class="file-header"><span class="status status-${escapeAttr(file.status)}">${escapeHtml(file.status)}</span><h2>${escapeHtml(file.displayPath)}</h2></header>`,
      hunks,
      "</section>",
    ].join("\n");
  }).join("\n");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="icon" href="data:,">',
    `<title>${escapeHtml(input.title)}</title>`,
    "<style>",
    diffCss(),
    "</style>",
    "</head>",
    "<body>",
    '<aside class="sidebar">',
    `<div class="brand">ai-flow diff</div>`,
    `<div class="summary">${input.files.length} changed · ${totalHunks} hunks · ${embeddedFiles}/${input.sourceFiles.length} files searchable</div>`,
    `<div class="live-status ${input.watch ? "watching" : ""}" id="live-status">${input.watch ? "Live: watching for changes" : `Generated: ${escapeHtml(input.generatedAt ?? new Date().toISOString())}`}</div>`,
    '<label class="search"><span>Search</span><input id="review-search" type="search" placeholder="Path or file content"></label>',
    '<div class="tabs"><button type="button" class="tab active" data-tab="changes">Changes</button><button type="button" class="tab" data-tab="files">Files</button></div>',
    '<div class="keymap"><kbd>F7</kbd> next hunk<br><kbd>Shift</kbd>+<kbd>F7</kbd> previous<br><kbd>]</kbd>/<kbd>[</kbd> fallback</div>',
    `<div class="tab-panel" id="changes-panel">${fileNav}</div>`,
    `<div class="tab-panel hidden" id="files-panel">${sourceNav}</div>`,
    "</aside>",
    '<main class="content">',
    '<section id="diff-view">',
    '<div class="toolbar">',
    `<div><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.subtitle)}; ${escapeHtml(String(totalLines))} diff lines</p></div>`,
    `<div class="counter"><span id="hunk-counter">0</span> / ${totalHunks}</div>`,
    "</div>",
    files || '<div class="empty">No diff to review.</div>',
    "</section>",
    '<section id="source-viewer" class="source-viewer hidden">',
    '<div class="toolbar source-toolbar">',
    '<div><h1 id="source-title">Source</h1><p id="source-meta">Select a file from the Files tab.</p></div>',
    '<button type="button" id="back-to-diff" class="plain-button">Back to diff</button>',
    "</div>",
    '<div id="source-body" class="source-body empty">Select a file from the Files tab.</div>',
    "</section>",
    "</main>",
    `<script type="application/json" id="review-meta" data-watch="${input.watch ? "true" : "false"}" data-signature="${escapeAttr(input.signature ?? "")}" data-generated-at="${escapeAttr(input.generatedAt ?? "")}">{}</script>`,
    `<script type="application/json" id="source-files-data">${jsonForScript(input.sourceFiles)}</script>`,
    "<script>",
    diffScript(),
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function renderHunk(file: DiffFile, hunk: DiffHunk, index: number): string {
  const language = languageForPath(file.displayPath);
  const rows = hunk.lines.map((line) => {
    const oldNumber = line.oldLine ? String(line.oldLine) : "";
    const newNumber = line.newLine ? String(line.newLine) : "";
    const code = highlightCodeLine(line.text, language);
    if (line.kind === "add") {
      return [
        '<tr class="line add">',
        '<td class="num old"></td><td class="code old-code"></td>',
        `<td class="num new">${escapeHtml(newNumber)}</td><td class="code new-code"><span class="marker">+</span>${code}</td>`,
        "</tr>",
      ].join("");
    }
    if (line.kind === "delete") {
      return [
        '<tr class="line delete">',
        `<td class="num old">${escapeHtml(oldNumber)}</td><td class="code old-code"><span class="marker">-</span>${code}</td>`,
        '<td class="num new"></td><td class="code new-code"></td>',
        "</tr>",
      ].join("");
    }
    return [
      '<tr class="line context">',
      `<td class="num old">${escapeHtml(oldNumber)}</td><td class="code old-code">${code}</td>`,
      `<td class="num new">${escapeHtml(newNumber)}</td><td class="code new-code">${code}</td>`,
      "</tr>",
    ].join("");
  }).join("\n");

  const title = hunk.title ? ` · ${hunk.title}` : "";
  return [
    `<section class="hunk" id="hunk-${index}" data-hunk-index="${index}" data-file="${escapeAttr(file.displayPath)}">`,
    '<div class="hunk-header">',
    `<span class="hunk-index">#${index + 1}</span>`,
    `<span>${escapeHtml(hunk.header)}${escapeHtml(title)}</span>`,
    "</div>",
    '<table class="diff-table"><tbody>',
    rows,
    "</tbody></table>",
    "</section>",
  ].join("\n");
}

function renderDiffTree(files: DiffFile[]): string {
  if (files.length === 0) {
    return '<div class="empty-nav">No changed files</div>';
  }

  const root: DiffTreeNode = {
    name: "",
    path: "",
    children: new Map(),
  };
  let hunkIndex = 0;

  files.forEach((file, fileIndex) => {
    const parts = file.displayPath.split("/").filter(Boolean);
    let node = root;
    let currentPath = "";
    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: currentPath, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }

    const leafName = parts[parts.length - 1] ?? file.displayPath;
    const firstHunk = hunkIndex;
    hunkIndex += file.hunks.length;
    node.children.set(`${leafName}\0${fileIndex}`, {
      name: leafName,
      path: file.displayPath,
      children: new Map(),
      file: {
        index: fileIndex,
        firstHunk,
        hunkCount: file.hunks.length,
        status: file.status,
        displayPath: file.displayPath,
      },
    });
  });

  return `<nav class="tree">${renderTreeChildren(root, 0)}</nav>`;
}

function renderTreeChildren(node: DiffTreeNode, depth: number): string {
  return Array.from(node.children.values())
    .sort((a, b) => {
      if (Boolean(a.file) !== Boolean(b.file)) {
        return a.file ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    })
    .map((child) => renderTreeNode(child, depth))
    .join("\n");
}

function renderTreeNode(node: DiffTreeNode, depth: number): string {
  if (node.file) {
    const file = node.file;
    return [
      `<a class="file-link tree-file" href="#file-${file.index}" data-hunk="${file.firstHunk}" data-file="${escapeAttr(file.displayPath)}" style="--depth:${depth}">`,
      `<span class="status status-${escapeAttr(file.status)}">${escapeHtml(file.status)}</span>`,
      `<span class="path" title="${escapeAttr(file.displayPath)}">${escapeHtml(node.name)}</span>`,
      `<span class="count">${file.hunkCount}</span>`,
      "</a>",
    ].join("");
  }

  return [
    `<details class="tree-dir" open style="--depth:${depth}">`,
    `<summary><span class="folder-icon">▾</span><span class="path">${escapeHtml(node.name)}</span></summary>`,
    renderTreeChildren(node, depth + 1),
    "</details>",
  ].join("\n");
}

function renderSourceTree(files: SourceFile[]): string {
  if (files.length === 0) {
    return '<div class="empty-nav">No source files indexed</div>';
  }

  const root: SourceTreeNode = {
    name: "",
    path: "",
    children: new Map(),
  };

  files.forEach((file) => {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    let currentPath = "";
    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: currentPath, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }

    const leafName = parts[parts.length - 1] ?? file.path;
    node.children.set(`${leafName}\0${file.path}`, {
      name: leafName,
      path: file.path,
      children: new Map(),
      file,
    });
  });

  return `<nav class="tree source-tree">${renderSourceChildren(root, 0)}</nav>`;
}

function renderSourceChildren(node: SourceTreeNode, depth: number): string {
  return Array.from(node.children.values())
    .sort((a, b) => {
      if (Boolean(a.file) !== Boolean(b.file)) {
        return a.file ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    })
    .map((child) => renderSourceNode(child, depth))
    .join("\n");
}

function renderSourceNode(node: SourceTreeNode, depth: number): string {
  if (node.file) {
    const file = node.file;
    const flags = [
      file.changed ? "changed" : "",
      file.embedded ? "" : "not embedded",
    ].filter(Boolean).join(" · ");
    return [
      `<button type="button" class="file-link source-link tree-file" data-source-file="${escapeAttr(file.path)}" style="--depth:${depth}">`,
      `<span class="status status-${file.changed ? "modified" : "source"}">${file.changed ? "diff" : "file"}</span>`,
      `<span class="path" title="${escapeAttr(file.path)}">${escapeHtml(node.name)}</span>`,
      `<span class="count">${escapeHtml(flags || file.language)}</span>`,
      "</button>",
    ].join("");
  }

  return [
    `<details class="tree-dir source-dir" open style="--depth:${depth}">`,
    `<summary><span class="folder-icon">▾</span><span class="path">${escapeHtml(node.name)}</span></summary>`,
    renderSourceChildren(node, depth + 1),
    "</details>",
  ].join("\n");
}

function diffCss(): string {
  return `
:root {
  color-scheme: light dark;
  --bg: #f6f8fa;
  --panel: #ffffff;
  --text: #1f2328;
  --muted: #656d76;
  --border: #d0d7de;
  --line: #f6f8fa;
  --add: #dafbe1;
  --del: #ffebe9;
  --add-strong: #aceebb;
  --del-strong: #ffcecb;
  --active: #0969da;
  --sidebar: #ffffff;
  --token-comment: #6a737d;
  --token-keyword: #cf222e;
  --token-string: #0a3069;
  --token-number: #0550ae;
  --token-literal: #8250df;
  --token-tag: #116329;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --text: #e6edf3;
    --muted: #8b949e;
    --border: #30363d;
    --line: #0d1117;
    --add: #12361f;
    --del: #3d1515;
    --add-strong: #1f6f3a;
    --del-strong: #8e2c2c;
    --active: #58a6ff;
    --sidebar: #161b22;
    --token-comment: #8b949e;
    --token-keyword: #ff7b72;
    --token-string: #a5d6ff;
    --token-number: #79c0ff;
    --token-literal: #d2a8ff;
    --token-tag: #7ee787;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: auto;
  border-right: 1px solid var(--border);
  background: var(--sidebar);
  padding: 16px;
}
.brand { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
.summary, .keymap { color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 14px; }
.live-status {
  margin: 0 0 12px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
.live-status.watching {
  color: var(--active);
}
.search {
  display: grid;
  gap: 6px;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 12px;
}
.search input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--text);
  background: var(--bg);
  font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-bottom: 12px;
}
.tab, .plain-button {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
  color: var(--text);
  background: var(--panel);
  font: 12px ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
.tab.active, .plain-button:hover {
  border-color: var(--active);
  color: var(--active);
}
.hidden { display: none !important; }
kbd {
  display: inline-block;
  min-width: 20px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 1px 5px;
  font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--text);
  background: var(--bg);
}
.tree {
  display: grid;
  gap: 2px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tree-dir {
  display: grid;
  gap: 2px;
}
.tree-dir summary {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr);
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 4px 6px 4px calc(6px + (var(--depth) * 14px));
  color: var(--muted);
  border-radius: 6px;
  cursor: default;
  list-style: none;
}
.tree-dir summary::-webkit-details-marker { display: none; }
.tree-dir summary:hover { background: var(--bg); }
.tree-dir:not([open]) .folder-icon { transform: rotate(-90deg); }
.folder-icon {
  display: inline-grid;
  place-items: center;
  font-size: 10px;
  color: var(--muted);
  transition: transform 120ms ease;
}
.tree-file {
  padding-left: calc(8px + (var(--depth) * 14px));
}
.file-link {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 8px;
  color: var(--text);
  text-decoration: none;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  width: 100%;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.file-link:hover, .file-link.active {
  background: var(--bg);
  border-color: var(--border);
}
.path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.count { color: var(--muted); font-size: 12px; }
.status {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  border-radius: 4px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  background: var(--line);
  color: var(--muted);
}
.status-added { background: var(--add); color: #1a7f37; }
.status-deleted { background: var(--del); color: #cf222e; }
.status-renamed { background: #fff8c5; color: #9a6700; }
.status-source { background: var(--line); color: var(--muted); }
.content { min-width: 0; padding: 20px 24px 80px; }
.toolbar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin: -20px -24px 20px;
  padding: 14px 24px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
h1 { margin: 0; font-size: 18px; }
.toolbar p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.counter {
  min-width: 96px;
  text-align: right;
  color: var(--muted);
  font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.file {
  margin: 0 0 28px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}
.file-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--line);
}
.file-header h2 {
  margin: 0;
  font-size: 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
}
.hunk {
  scroll-margin-top: 76px;
  border-bottom: 1px solid var(--border);
}
.hunk:last-child { border-bottom: 0; }
.hunk.active {
  outline: 2px solid var(--active);
  outline-offset: -2px;
}
.hunk-header {
  display: flex;
  gap: 10px;
  padding: 8px 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  background: var(--line);
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.hunk-index { color: var(--active); font-weight: 700; }
.diff-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.diff-table td {
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.45;
}
.num {
  width: 58px;
  user-select: none;
  text-align: right;
  color: var(--muted);
  background: var(--line);
  border-right: 1px solid var(--border);
  padding: 2px 8px;
}
.code { width: calc(50% - 58px); padding: 2px 10px; }
.old-code { border-right: 1px solid var(--border); }
.line.add .new-code, .line.add .new { background: var(--add); }
.line.delete .old-code, .line.delete .old { background: var(--del); }
.line.add .marker { color: #1a7f37; font-weight: 700; margin-right: 6px; }
.line.delete .marker { color: #cf222e; font-weight: 700; margin-right: 6px; }
.hunk.active .line.add .new-code { background: var(--add-strong); }
.hunk.active .line.delete .old-code { background: var(--del-strong); }
.tok-comment { color: var(--token-comment); font-style: italic; }
.tok-keyword { color: var(--token-keyword); font-weight: 650; }
.tok-string { color: var(--token-string); }
.tok-number { color: var(--token-number); }
.tok-literal { color: var(--token-literal); }
.tok-tag { color: var(--token-tag); font-weight: 650; }
.binary, .empty {
  padding: 24px;
  color: var(--muted);
}
.source-viewer {
  min-height: 100vh;
}
.source-toolbar {
  margin-bottom: 0;
}
.source-body {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: auto;
  background: var(--panel);
}
.source-table {
  width: 100%;
  border-collapse: collapse;
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.source-table td {
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.45;
}
.source-row.search-hit .source-code {
  background: color-mix(in srgb, var(--active) 14%, transparent);
}
.source-code {
  padding: 2px 10px;
}
@media (max-width: 900px) {
  body { grid-template-columns: 1fr; }
  .sidebar { position: relative; height: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .content { padding: 16px; }
  .toolbar { margin: -16px -16px 16px; padding: 12px 16px; }
}
`;
}

function diffScript(): string {
  return String.raw`
const hunks = Array.from(document.querySelectorAll('.hunk'));
const links = Array.from(document.querySelectorAll('#changes-panel .file-link'));
const sourceLinks = Array.from(document.querySelectorAll('.source-link'));
const sourceFiles = JSON.parse(document.getElementById('source-files-data')?.textContent || '[]');
const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
const searchInput = document.getElementById('review-search');
const reviewMeta = document.getElementById('review-meta');
const watchEnabled = reviewMeta?.dataset.watch === 'true';
const currentSignature = reviewMeta?.dataset.signature || '';
const uiStateKey = 'ai-flow-diff-ui:' + location.pathname;
let current = -1;
let checkingForUpdates = false;

function setActive(index, shouldScroll = true) {
  if (hunks.length === 0) return;
  showDiffView(false);
  current = ((index % hunks.length) + hunks.length) % hunks.length;
  hunks.forEach((hunk, i) => hunk.classList.toggle('active', i === current));
  const active = hunks[current];
  const file = active.dataset.file;
  links.forEach((link) => link.classList.toggle('active', link.dataset.file === file));
  document.getElementById('hunk-counter').textContent = String(current + 1);
  if (shouldScroll) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  history.replaceState(null, '', '#hunk-' + current);
}

function next(delta) {
  setActive(current < 0 ? 0 : current + delta);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'F7') {
    event.preventDefault();
    next(event.shiftKey ? -1 : 1);
  } else if (event.key === ']') {
    event.preventDefault();
    next(1);
  } else if (event.key === '[') {
    event.preventDefault();
    next(-1);
  }
});

links.forEach((link) => {
  link.addEventListener('click', (event) => {
    showDiffView(false);
    const target = Number(link.dataset.hunk);
    if (!Number.isNaN(target) && target >= 0 && target < hunks.length) {
      event.preventDefault();
      setActive(target);
    }
  });
});

sourceLinks.forEach((link) => {
  link.addEventListener('click', () => {
    const path = link.dataset.sourceFile;
    if (path) openSourceFile(path);
  });
});

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => setTab(button.dataset.tab || 'changes'));
});

document.getElementById('back-to-diff')?.addEventListener('click', () => showDiffView(true));

searchInput?.addEventListener('input', () => {
  filterNavigation(searchInput.value);
  const openPath = document.getElementById('source-viewer')?.dataset.openPath;
  if (openPath) openSourceFile(openPath, false);
});

const initial = location.hash.match(/^#hunk-(\\d+)$/);
if (initial) {
  setActive(Number(initial[1]), false);
} else if (hunks.length > 0) {
  setActive(0, false);
}
restoreUiState();
if (watchEnabled) {
  setInterval(checkForLiveUpdate, 1500);
}
window.addEventListener('beforeunload', saveUiState);

function setTab(name) {
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  document.getElementById('changes-panel')?.classList.toggle('hidden', name !== 'changes');
  document.getElementById('files-panel')?.classList.toggle('hidden', name !== 'files');
}

function showDiffView(shouldScroll) {
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  if (shouldScroll && current >= 0 && hunks[current]) {
    hunks[current].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function showSourceView() {
  document.getElementById('diff-view')?.classList.add('hidden');
  document.getElementById('source-viewer')?.classList.remove('hidden');
  setTab('files');
}

function saveUiState() {
  const activeTab = document.querySelector('.tab.active')?.dataset.tab || 'changes';
  const sourcePath = document.getElementById('source-viewer')?.dataset.openPath || '';
  sessionStorage.setItem(uiStateKey, JSON.stringify({
    search: searchInput?.value || '',
    tab: activeTab,
    sourcePath,
    hash: location.hash,
  }));
}

function restoreUiState() {
  const raw = sessionStorage.getItem(uiStateKey);
  if (!raw) return;
  try {
    const state = JSON.parse(raw);
    if (searchInput && state.search) {
      searchInput.value = state.search;
      filterNavigation(state.search);
    }
    if (state.sourcePath && sourceByPath.has(state.sourcePath)) {
      openSourceFile(state.sourcePath);
    } else if (state.tab) {
      setTab(state.tab);
    }
  } catch {
    sessionStorage.removeItem(uiStateKey);
  }
}

async function checkForLiveUpdate() {
  if (checkingForUpdates) return;
  checkingForUpdates = true;
  const liveStatus = document.getElementById('live-status');
  try {
    const response = await fetch('/__ai_flow_state', { cache: 'no-store' });
    if (!response.ok) return;
    const state = await response.json();
    if (liveStatus && state.generatedAt) {
      liveStatus.textContent = 'Live: updated ' + new Date(state.generatedAt).toLocaleTimeString();
    }
    if (state.signature && state.signature !== currentSignature) {
      saveUiState();
      location.reload();
    }
  } catch {
    if (liveStatus) liveStatus.textContent = 'Live: waiting for diff server';
  } finally {
    checkingForUpdates = false;
  }
}

function filterNavigation(rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  links.forEach((link) => {
    const path = link.dataset.file || '';
    const source = sourceByPath.get(path);
    const haystack = (path + '\n' + (source?.content || '')).toLowerCase();
    link.hidden = query.length > 0 && !haystack.includes(query);
  });
  sourceLinks.forEach((link) => {
    const path = link.dataset.sourceFile || '';
    const source = sourceByPath.get(path);
    const haystack = (path + '\n' + (source?.content || '')).toLowerCase();
    link.hidden = query.length > 0 && !haystack.includes(query);
  });
  updateTreeVisibility(document.getElementById('changes-panel'), query);
  updateTreeVisibility(document.getElementById('files-panel'), query);
}

function updateTreeVisibility(root, query) {
  if (!root) return;
  Array.from(root.querySelectorAll('details')).reverse().forEach((details) => {
    const hasVisibleLeaf = Array.from(details.children).some((child) => {
      if (child.tagName === 'SUMMARY') return false;
      return !child.hidden;
    });
    details.hidden = query.length > 0 && !hasVisibleLeaf;
    if (query.length > 0 && hasVisibleLeaf) details.open = true;
  });
}

function openSourceFile(path, shouldSwitch = true) {
  const file = sourceByPath.get(path);
  if (!file) return;
  document.getElementById('source-viewer').dataset.openPath = path;
  sourceLinks.forEach((link) => link.classList.toggle('active', link.dataset.sourceFile === path));
  document.getElementById('source-title').textContent = path;
  const meta = [
    file.language || 'text',
    formatBytes(file.size || 0),
    file.changed ? 'changed' : 'unchanged',
    file.embedded ? 'searchable' : file.skippedReason || 'not embedded',
  ].join(' · ');
  document.getElementById('source-meta').textContent = meta;
  const body = document.getElementById('source-body');
  if (!file.embedded) {
    body.className = 'source-body empty';
    body.textContent = file.skippedReason ? 'Source preview unavailable: ' + file.skippedReason + '.' : 'Source preview unavailable.';
    if (shouldSwitch) showSourceView();
    return;
  }
  body.className = 'source-body';
  body.innerHTML = renderSourceTable(file, searchInput?.value || '');
  if (shouldSwitch) showSourceView();
}

function renderSourceTable(file, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  const rows = lines.map((line, index) => {
    const hit = normalizedQuery.length > 0 && line.toLowerCase().includes(normalizedQuery);
    return [
      '<tr class="source-row' + (hit ? ' search-hit' : '') + '">',
      '<td class="num">' + String(index + 1) + '</td>',
      '<td class="source-code">' + highlightLine(line, file.language || 'text') + '</td>',
      '</tr>',
    ].join('');
  }).join('');
  return '<table class="source-table"><tbody>' + rows + '</tbody></table>';
}

function highlightLine(text, language) {
  if (language === 'text') return escapeHtml(text);
  if (language === 'markup') {
    return escapeHtml(text).replace(/(&lt;\/?)([\w:-]+)([^&]*?)(\/?&gt;)/g, '$1<span class="tok-tag">$2</span>$3$4');
  }
  if (language === 'markdown') {
    const escaped = escapeHtml(text);
    if (/^\s{0,3}#{1,6}\s/.test(text)) return '<span class="tok-keyword">' + escaped + '</span>';
    return escaped.replace(new RegExp(String.fromCharCode(96) + '[^' + String.fromCharCode(96) + ']+' + String.fromCharCode(96), 'g'), '<span class="tok-string">$&</span>');
  }
  const keywords = new Set(['as','async','await','break','case','catch','class','const','continue','def','default','defer','do','else','enum','export','extends','final','finally','fn','for','from','func','function','go','if','impl','import','in','interface','let','match','module','new','package','private','protected','public','return','select','static','struct','switch','throw','try','type','val','var','while','yield']);
  const literals = new Set(['False','None','True','false','nil','null','self','this','true','undefined']);
  const commentPrefixes = ['python','ruby','shell','yaml','toml'].includes(language) ? ['#'] : ['//'];
  let output = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const commentPrefix = commentPrefixes.find((prefix) => rest.startsWith(prefix));
    if (commentPrefix) {
      output += '<span class="tok-comment">' + escapeHtml(rest) + '</span>';
      break;
    }
    const char = text[index];
    if (char === '"' || char === "'" || char === String.fromCharCode(96)) {
      const quote = char;
      let end = index + 1;
      let escaped = false;
      while (end < text.length) {
        const currentChar = text[end];
        if (currentChar === quote && !escaped) {
          end += 1;
          break;
        }
        escaped = currentChar === '\\' && !escaped;
        if (currentChar !== '\\') escaped = false;
        end += 1;
      }
      output += '<span class="tok-string">' + escapeHtml(text.slice(index, end)) + '</span>';
      index = end;
      continue;
    }
    const number = rest.match(/^\b\d+(?:\.\d+)?\b/);
    if (number) {
      output += '<span class="tok-number">' + escapeHtml(number[0]) + '</span>';
      index += number[0].length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_$][\w$-]*/);
    if (identifier) {
      const value = identifier[0];
      if (keywords.has(value)) output += '<span class="tok-keyword">' + escapeHtml(value) + '</span>';
      else if (literals.has(value)) output += '<span class="tok-literal">' + escapeHtml(value) + '</span>';
      else output += escapeHtml(value);
      index += value.length;
      continue;
    }
    output += escapeHtml(char);
    index += 1;
  }
  return output;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const kib = bytes / 1024;
  if (kib < 1024) return kib.toFixed(1) + ' KiB';
  return (kib / 1024).toFixed(1) + ' MiB';
}
`;
}

function diffSubtitle(options: {
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
}): string {
  const source = options.staged ? "staged changes" : `working tree vs ${options.base ?? "HEAD"}`;
  const untracked = options.includeUntracked ? "including untracked files" : "tracked files only";
  return `${source}; ${untracked}; ${options.context} context lines`;
}

function openCmuxBrowser(url: string): void {
  if (!commandExists("cmux")) {
    throw new Error("cmux is not installed. Run `ai-flow doctor` for setup.");
  }
  const result = runCmux(["browser", "open", url]);
  if (result.status !== 0) {
    throw new Error(`cmux could not open diff review: ${result.stderr || result.stdout}`);
  }
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

function parseTasks(content: string): Task[] {
  const tasks: Task[] = [];
  for (const line of content.split(/\r?\n/)) {
    const checkbox = line.match(/^\s*[-*]\s+\[([ xX])\]\s*(?:(T\d+|[A-Za-z][\w-]*)[:.)-]?\s*)?(.*)$/);
    const plain = line.match(/^\s*(T\d+)[:.)-]\s+(.+)$/);
    if (checkbox) {
      const id = checkbox[2] ?? `T${String(tasks.length + 1).padStart(3, "0")}`;
      const title = checkbox[3]?.trim() || "Untitled task";
      tasks.push({ id, title, done: checkbox[1].toLowerCase() === "x", raw: line });
    } else if (plain) {
      tasks.push({ id: plain[1], title: plain[2].trim(), done: false, raw: line });
    }
  }
  return tasks;
}

function selectTask(tasks: Task[], taskId?: string): Task {
  if (tasks.length === 0) {
    throw new Error(`No tasks found in ${FLOW_DIR}/${TASKS_FILE}.`);
  }
  if (taskId) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }
  const next = tasks.find((task) => !task.done);
  if (!next) {
    throw new Error("All tasks are complete.");
  }
  return next;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function readFreeformObjective(args: string[], optionsWithValues: Set<string>): string {
  const chunks: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (optionsWithValues.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) {
      continue;
    }
    chunks.push(value);
  }
  return chunks.join(" ").trim();
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return parsed;
}

function parseAgent(value: string): AgentName {
  if (value === "manual" || value === "codex" || value === "claude") {
    return value;
  }
  throw new Error(`Unsupported agent: ${value}`);
}

function selectPlannerAgent(value?: string): Exclude<AgentName, "manual"> {
  if (value) {
    const parsed = parseAgent(value);
    if (parsed === "manual") {
      throw new Error("Planner boot requires --agent codex or --agent claude.");
    }
    return parsed;
  }

  if (existsSync(join(process.cwd(), FLOW_DIR, CONFIG_FILE))) {
    const configured = loadConfig().defaultAgent;
    if (configured !== "manual" && commandExists(configured)) {
      return configured;
    }
  }

  if (commandExists("codex")) {
    return "codex";
  }
  if (commandExists("claude")) {
    return "claude";
  }
  throw new Error("No supported agent CLI found. Install Codex CLI or Claude Code first.");
}

function parseRole(value: string): PromptRole {
  if (value === "worker" || value === "reviewer") {
    return value;
  }
  throw new Error(`Unsupported role: ${value}`);
}

function parseSessionRole(value: string): SessionRole {
  if (value === "planner" || value === "worker" || value === "reviewer") {
    return value;
  }
  throw new Error(`Unsupported session role: ${value}`);
}

function currentTaskId(): string {
  const tasks = parseTasks(readFlowFile(TASKS_FILE));
  const active = tasks.find((task) => !task.done);
  if (active) {
    return active.id;
  }
  if (tasks[0]) {
    return tasks[0].id;
  }
  return "unknown-task";
}

function saveReport(
  role: SessionRole,
  taskId: string,
  body: string,
  timestamp = timestampForFile(),
): string {
  const reportDir = join(process.cwd(), FLOW_DIR, "reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${timestamp}-${role}-${sanitizeFilePart(taskId)}.md`);
  const report = [
    `# ${capitalize(role)} Report: ${taskId}`,
    "",
    `Recorded: ${new Date().toISOString()}`,
    "",
    body.trim(),
    "",
  ].join("\n");
  writeFileSync(reportPath, report);
  return reportPath;
}

function stripDiffPath(value: string): string {
  if (value === "/dev/null") {
    return value;
  }
  return value.replace(/^[ab]\//, "");
}

function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".sass")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xml") || lower.endsWith(".svg")) return "markup";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java") || lower.endsWith(".kt") || lower.endsWith(".kts")) return "java";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".sql")) return "sql";
  return "text";
}

function highlightCodeLine(text: string, language: string): string {
  if (language === "text") {
    return escapeHtml(text);
  }
  if (language === "markup") {
    return escapeHtml(text).replace(/(&lt;\/?)([\w:-]+)([^&]*?)(\/?&gt;)/g, "$1<span class=\"tok-tag\">$2</span>$3$4");
  }
  if (language === "markdown") {
    const escaped = escapeHtml(text);
    if (/^\s{0,3}#{1,6}\s/.test(text)) {
      return `<span class="tok-keyword">${escaped}</span>`;
    }
    return escaped.replace(/(`[^`]+`)/g, '<span class="tok-string">$1</span>');
  }

  const keywords = new Set([
    "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default",
    "defer", "do", "else", "enum", "export", "extends", "final", "finally", "fn", "for", "from", "func",
    "function", "go", "if", "impl", "import", "in", "interface", "let", "match", "module", "new", "package",
    "private", "protected", "public", "return", "select", "static", "struct", "switch", "throw", "try", "type",
    "val", "var", "while", "yield",
  ]);
  const literals = new Set(["False", "None", "True", "false", "nil", "null", "self", "this", "true", "undefined"]);
  const commentPrefixes = language === "python" || language === "ruby" || language === "shell" || language === "yaml" || language === "toml"
    ? ["#"]
    : ["//"];

  let output = "";
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const commentPrefix = commentPrefixes.find((prefix) => rest.startsWith(prefix));
    if (commentPrefix) {
      output += `<span class="tok-comment">${escapeHtml(rest)}</span>`;
      break;
    }

    const char = text[index];
    if (char === "\"" || char === "'" || char === "`") {
      const quote = char;
      let end = index + 1;
      let escaped = false;
      while (end < text.length) {
        const current = text[end];
        if (current === quote && !escaped) {
          end += 1;
          break;
        }
        escaped = current === "\\" && !escaped;
        if (current !== "\\") {
          escaped = false;
        }
        end += 1;
      }
      output += `<span class="tok-string">${escapeHtml(text.slice(index, end))}</span>`;
      index = end;
      continue;
    }

    const number = rest.match(/^\b\d+(?:\.\d+)?\b/);
    if (number) {
      output += `<span class="tok-number">${escapeHtml(number[0])}</span>`;
      index += number[0].length;
      continue;
    }

    const identifier = rest.match(/^[A-Za-z_$][\w$-]*/);
    if (identifier) {
      const value = identifier[0];
      if (keywords.has(value)) {
        output += `<span class="tok-keyword">${escapeHtml(value)}</span>`;
      } else if (literals.has(value)) {
        output += `<span class="tok-literal">${escapeHtml(value)}</span>`;
      } else {
        output += escapeHtml(value);
      }
      index += value.length;
      continue;
    }

    output += escapeHtml(char);
    index += 1;
  }

  return output;
}

function isLikelyBinary(path: string): boolean {
  const sample = readFileSync(path).subarray(0, 8000);
  return sample.includes(0);
}

function savePrompt(role: PromptRole | SessionRole, taskId: string, agent: AgentName, prompt: string): string {
  const promptDir = join(process.cwd(), FLOW_DIR, "prompts");
  mkdirSync(promptDir, { recursive: true });
  const promptPath = join(promptDir, `${timestampForFile()}-${taskId}-${role}-${agent}.md`);
  writeFileSync(promptPath, prompt);
  return promptPath;
}

function buildAgentReadPromptCommand(
  agent: Exclude<AgentName, "manual">,
  role: SessionRole,
  promptPath: string,
): string {
  const instruction = [
    `Read ${promptPath} and follow it exactly.`,
    `This is an ai-flow ${role} session.`,
    "Do not ask the user to run ai-flow or cmux commands.",
  ].join(" ");

  if (agent === "codex") {
    return ["codex", "--cd", process.cwd(), instruction].map(shellQuote).join(" ");
  }

  return ["claude", instruction].map(shellQuote).join(" ");
}

function dispatchToCmux(command: string, role: PromptRole, taskId: string): {
  workspace: string;
  surface: string;
} {
  if (!commandExists("cmux")) {
    throw new Error(
      "cmux is not installed. Run `ai-flow doctor` for the simple setup path.",
    );
  }

  const workspace = currentCmuxWorkspace();
  if (!workspace) {
    throw new Error(
      "cmux is installed, but this Planner is not running inside a cmux workspace. Open the repo in cmux, start Planner there, then dispatch again.",
    );
  }

  const paneResult = runCmux([
    "--json",
    "new-pane",
    "--workspace",
    workspace,
    "--type",
    "terminal",
    "--direction",
    "right",
    "--focus",
    "false",
  ]);
  if (paneResult.status !== 0) {
    throw new Error(`cmux could not create a ${role} pane: ${paneResult.stderr || paneResult.stdout}`);
  }

  const pane = findCmuxRef(paneResult.stdout, "pane");
  const surface =
    findCmuxRef(paneResult.stdout, "surface") ??
    (pane ? newestSurfaceForPane(workspace, pane) : undefined);

  if (!surface) {
    throw new Error("cmux created a pane, but ai-flow could not identify the terminal surface to send the Worker command.");
  }

  bestEffortCmux(["set-status", "ai-flow", `${role} ${taskId}`, "--workspace", workspace, "--color", "#0a84ff"]);
  bestEffortCmux(["log", "--workspace", workspace, "--level", "info", "--", `ai-flow dispatch ${role} ${taskId}`]);

  const sendResult = runCmux(["send", "--workspace", workspace, "--surface", surface, `${command}\n`]);
  if (sendResult.status !== 0) {
    throw new Error(`cmux could not send the ${role} command: ${sendResult.stderr || sendResult.stdout}`);
  }

  return { workspace, surface };
}

function openPlannerInCmux(command: string): string | undefined {
  openCmuxApp();
  waitForCmuxSocket(5000);
  const result = runCmux([
    "new-workspace",
    "--name",
    `ai-flow: ${basename(process.cwd())}`,
    "--cwd",
    process.cwd(),
    "--command",
    command,
    "--focus",
    "true",
  ]);

  if (result.status !== 0) {
    return undefined;
  }

  return findCmuxRef(result.stdout, "workspace") ?? "created";
}

function openCmuxApp(): void {
  spawnSync("open", ["-a", "cmux"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function waitForCmuxSocket(timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runCmux(["workspace", "list", "--json"]);
    if (result.status === 0) {
      return true;
    }
    spawnSync("sleep", ["0.25"]);
  }
  return false;
}

function runInteractiveShell(command: string): void {
  const result = spawnSync(command, {
    cwd: process.cwd(),
    shell: true,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function currentCmuxWorkspace(): string | undefined {
  if (process.env.CMUX_WORKSPACE_ID) {
    return normalizeCmuxRef("workspace", process.env.CMUX_WORKSPACE_ID);
  }
  return undefined;
}

function newestSurfaceForPane(workspace: string, pane: string): string | undefined {
  const result = runCmux(["--json", "list-pane-surfaces", "--workspace", workspace]);
  if (result.status !== 0) {
    return undefined;
  }
  const surfaces = findSurfacesForPane(result.stdout, pane);
  return surfaces[surfaces.length - 1];
}

function runCmux(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("cmux", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    timeout: 5000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr || (result.error instanceof Error ? result.error.message : ""),
  };
}

function bestEffortCmux(args: string[]): void {
  runCmux(args);
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    encoding: "utf8",
  });
  return result.status === 0;
}

function normalizeCmuxRef(kind: string, value: string): string {
  if (value.startsWith(`${kind}:`)) {
    return value;
  }
  return value;
}

function findCmuxRef(output: string, kind: string): string | undefined {
  return findAllCmuxRefs(output, kind)[0];
}

function findAllCmuxRefs(output: string, kind: string): string[] {
  const refs = new Set<string>();
  const refPattern = new RegExp(`\\b${kind}:\\d+\\b`, "g");
  for (const match of output.matchAll(refPattern)) {
    refs.add(match[0]);
  }

  try {
    collectCmuxRefs(JSON.parse(output) as unknown, kind, refs);
  } catch {
    // Plain text output is acceptable; regex extraction above is the fallback.
  }

  return Array.from(refs);
}

function collectCmuxRefs(value: unknown, kind: string, refs: Set<string>): void {
  if (typeof value === "string") {
    const ref = value.match(new RegExp(`\\b${kind}:\\d+\\b`));
    if (ref) {
      refs.add(ref[0]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCmuxRefs(item, kind, refs);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectCmuxRefs(item, kind, refs);
    }
  }
}

function findSurfacesForPane(output: string, pane: string): string[] {
  try {
    const value = JSON.parse(output) as unknown;
    const surfaces = new Set<string>();
    collectSurfacesForPane(value, pane, surfaces);
    if (surfaces.size > 0) {
      return Array.from(surfaces);
    }
  } catch {
    // Fall back to all surface refs below.
  }

  return findAllCmuxRefs(output, "surface");
}

function collectSurfacesForPane(value: unknown, pane: string, surfaces: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSurfacesForPane(item, pane, surfaces);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const text = JSON.stringify(value);
  if (text.includes(pane)) {
    for (const surface of findAllCmuxRefs(text, "surface")) {
      surfaces.add(surface);
    }
  }
  for (const item of Object.values(value)) {
    collectSurfacesForPane(item, pane, surfaces);
  }
}

function markTaskComplete(taskId: string): void {
  const tasksPath = join(process.cwd(), FLOW_DIR, TASKS_FILE);
  const taskPattern = new RegExp(`\\b${escapeRegExp(taskId)}\\b`);
  const current = readFileSync(tasksPath, "utf8");
  let changed = false;
  const next = current
    .split(/\r?\n/)
    .map((line) => {
      if (!changed && taskPattern.test(line) && line.includes("[ ]")) {
        changed = true;
        return line.replace("[ ]", "[x]");
      }
      return line;
    })
    .join("\n");

  if (!changed) {
    throw new Error(`Could not mark task complete: ${taskId}`);
  }

  writeFileSync(tasksPath, next);
}

function listRecentFiles(dir: string, limit: number): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);
}

function readStdin(): string {
  if (process.stdin.isTTY) {
    return "";
  }
  return readFileSync(0, "utf8");
}

function appendToState(content: string): void {
  const path = join(process.cwd(), FLOW_DIR, STATE_FILE);
  const current = readFileSync(path, "utf8");
  writeFileSync(path, `${current.trimEnd()}\n${content}`);
}

function summarizeForState(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  return lines.map((line) => `- ${line.replace(/^-+\s*/, "")}`).join("\n");
}

function truncateMarkdown(content: string, maxChars: number): string {
  return truncateText(content.trim(), maxChars);
}

function truncateText(content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}\n\n...[truncated]`;
}

function codeBlock(content: string): string {
  return ["```", content, "```"].join("\n");
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printHelp(): void {
  console.log(`ai-flow

Lightweight planning and verification control plane for AI coding agents.

Usage:
  ai-flow go [what you want built] [--agent codex|claude] [--dry-run] [--apply-agent-docs]
  ai-flow init [--force]
  ai-flow install [--force] [--apply-agent-docs]
  ai-flow start planner|worker|reviewer [--agent manual|codex|claude] [--task T001] [--no-save]
  ai-flow finish planner|worker|reviewer [--task T001] [--file report.md] [--complete] [--no-diff]
  ai-flow dispatch worker|reviewer --agent codex|claude [--task T001] [--dry-run]
  ai-flow diff [--base HEAD] [--staged] [--include-untracked] [--open] [--cmux] [--watch]
  ai-flow doctor
  ai-flow status
  ai-flow next [--agent manual|codex|claude] [--role worker|reviewer] [--task T001] [--no-save]
  ai-flow prompt worker|reviewer [--agent manual|codex|claude] [--task T001] [--no-save]
  ai-flow report [--task T001] [--file report.md]
  ai-flow verify [-- <command>]
  ai-flow run worker|reviewer --agent codex|claude [--task T001] [--dry-run] [--print]

Workflow:
  1. Run: ai-flow go
  2. Planner opens in cmux when available, or in the current terminal as fallback
  3. Planner dispatches Worker/Reviewer sessions with cmux when needed
  4. Worker finish opens a folder-tree diff review automatically; use F7 / Shift+F7 to move by hunk

For people who do not know cmux:
  ai-flow go

Legacy/manual:
  ai-flow next --agent codex
  ai-flow run worker --agent claude
  ai-flow verify
`);
}

function printDiffHelp(): void {
  console.log(`ai-flow diff

Generate a browser-based side-by-side Git diff review.

Usage:
  ai-flow diff [--base HEAD] [--staged] [--include-untracked] [--context 12] [--output review.html] [--open] [--cmux] [--watch] [--port 0]

Keys in the review page:
  F7         next changed hunk
  Shift+F7  previous changed hunk
  ] / [     fallback hunk navigation

The sidebar groups changed files as a folder tree. Use Search to filter paths and indexed file contents.
The Files tab opens source previews, including unchanged files when they fit the local review budget.
Use --watch to serve a live review that reloads when the working tree changes.
`);
}

main();
