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

const FLOW_DIR = ".ai-flow";
const CONFIG_FILE = "config.json";
const STATE_FILE = "state.md";
const TASKS_FILE = "tasks.md";
const DECISIONS_FILE = "decisions.md";
const AGENT_SNIPPET_FILE = "agent-snippet.md";
const CMUX_FILE = "cmux.md";
const ROLES_DIR = "roles";

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

  if (!quiet) {
    console.log(`Initialized ${FLOW_DIR}/ in ${root}`);
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
  const output = readOption(args, "--output") ??
    join(process.cwd(), FLOW_DIR, "diffs", `${timestampForFile()}-review.html`);
  const outputPath = resolve(output);
  const diffText = readUnifiedDiff({ base, staged, context, includeUntracked });
  const files = parseUnifiedDiff(diffText);
  const html = renderDiffHtml({
    files,
    title: "ai-flow diff review",
    subtitle: diffSubtitle({ base, staged, includeUntracked, context }),
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html);
  const url = pathToFileURL(outputPath).href;

  if (openInCmux) {
    openCmuxBrowser(url);
  }
  if (openInBrowser) {
    spawnSync("open", [outputPath], { stdio: "ignore" });
  }

  console.log(`Diff review: ${relative(process.cwd(), outputPath)}`);
  console.log(`URL: ${url}`);
  console.log(`Files: ${files.length}`);
  console.log(`Hunks: ${files.reduce((sum, file) => sum + file.hunks.length, 0)}`);
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
    "- After a Worker finishes, open the diff review with `ai-flow diff --cmux` when cmux is available. Use F7/Shift+F7 to move by changed hunk, not just by file.",
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
    "- Prefer `ai-flow diff --cmux` for visual review. Use F7 for the next changed hunk and Shift+F7 for the previous changed hunk.",
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
    "For Worker review, Planner opens `ai-flow diff --cmux`; use F7 for next changed hunk and Shift+F7 for previous changed hunk.",
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
    "ai-flow diff --cmux",
    "```",
    "",
    "Use `--agent claude` when Claude Code is the preferred worker.",
    "",
    "## cmux Safety Rules",
    "- Prefer the current cmux workspace from `CMUX_WORKSPACE_ID`.",
    "- Do not change focus, switch workspaces, or close panes unless the user explicitly asks.",
    "- Dispatch should create or use helper terminal space without requiring the user to manage panes.",
    "- For Worker review, open `ai-flow diff --cmux` and navigate changed hunks with F7 / Shift+F7.",
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

function renderDiffHtml(input: { files: DiffFile[]; title: string; subtitle: string }): string {
  const totalHunks = input.files.reduce((sum, file) => sum + file.hunks.length, 0);
  const totalLines = input.files.reduce(
    (sum, file) => sum + file.hunks.reduce((inner, hunk) => inner + hunk.lines.length, 0),
    0,
  );
  let hunkIndex = 0;
  const fileNav = input.files.map((file, index) => {
    const firstHunk = hunkIndex;
    hunkIndex += file.hunks.length;
    return [
      `<a class="file-link" href="#file-${index}" data-hunk="${firstHunk}">`,
      `<span class="status status-${escapeAttr(file.status)}">${escapeHtml(file.status)}</span>`,
      `<span class="path">${escapeHtml(file.displayPath)}</span>`,
      `<span class="count">${file.hunks.length}</span>`,
      "</a>",
    ].join("");
  }).join("\n");

  hunkIndex = 0;
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
    `<div class="summary">${input.files.length} files · ${totalHunks} hunks · ${totalLines} lines</div>`,
    '<div class="keymap"><kbd>F7</kbd> next hunk<br><kbd>Shift</kbd>+<kbd>F7</kbd> previous<br><kbd>]</kbd>/<kbd>[</kbd> fallback</div>',
    `<nav>${fileNav || '<div class="empty-nav">No changed files</div>'}</nav>`,
    "</aside>",
    '<main class="content">',
    '<div class="toolbar">',
    `<div><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.subtitle)}</p></div>`,
    `<div class="counter"><span id="hunk-counter">0</span> / ${totalHunks}</div>`,
    "</div>",
    files || '<div class="empty">No diff to review.</div>',
    "</main>",
    "<script>",
    diffScript(),
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function renderHunk(file: DiffFile, hunk: DiffHunk, index: number): string {
  const rows = hunk.lines.map((line) => {
    const oldNumber = line.oldLine ? String(line.oldLine) : "";
    const newNumber = line.newLine ? String(line.newLine) : "";
    if (line.kind === "add") {
      return [
        '<tr class="line add">',
        '<td class="num old"></td><td class="code old-code"></td>',
        `<td class="num new">${escapeHtml(newNumber)}</td><td class="code new-code"><span class="marker">+</span>${escapeHtml(line.text)}</td>`,
        "</tr>",
      ].join("");
    }
    if (line.kind === "delete") {
      return [
        '<tr class="line delete">',
        `<td class="num old">${escapeHtml(oldNumber)}</td><td class="code old-code"><span class="marker">-</span>${escapeHtml(line.text)}</td>`,
        '<td class="num new"></td><td class="code new-code"></td>',
        "</tr>",
      ].join("");
    }
    return [
      '<tr class="line context">',
      `<td class="num old">${escapeHtml(oldNumber)}</td><td class="code old-code">${escapeHtml(line.text)}</td>`,
      `<td class="num new">${escapeHtml(newNumber)}</td><td class="code new-code">${escapeHtml(line.text)}</td>`,
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
nav { display: grid; gap: 4px; }
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
.binary, .empty {
  padding: 24px;
  color: var(--muted);
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
  return `
const hunks = Array.from(document.querySelectorAll('.hunk'));
const links = Array.from(document.querySelectorAll('.file-link'));
let current = -1;

function setActive(index, shouldScroll = true) {
  if (hunks.length === 0) return;
  current = ((index % hunks.length) + hunks.length) % hunks.length;
  hunks.forEach((hunk, i) => hunk.classList.toggle('active', i === current));
  const active = hunks[current];
  const file = active.dataset.file;
  links.forEach((link) => link.classList.toggle('active', link.querySelector('.path')?.textContent === file));
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
    const target = Number(link.dataset.hunk);
    if (!Number.isNaN(target)) {
      event.preventDefault();
      setActive(target);
    }
  });
});

const initial = location.hash.match(/^#hunk-(\\d+)$/);
if (initial) {
  setActive(Number(initial[1]), false);
} else if (hunks.length > 0) {
  setActive(0, false);
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
  role: PromptRole,
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

function currentCmuxWorkspace(): string | undefined {
  if (process.env.CMUX_WORKSPACE_ID) {
    return normalizeCmuxRef("workspace", process.env.CMUX_WORKSPACE_ID);
  }

  const identify = runCmux(["--json", "identify"]);
  if (identify.status !== 0) {
    return undefined;
  }
  return findCmuxRef(identify.stdout, "workspace");
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

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/\s+/g, "-");
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
  ai-flow init [--force]
  ai-flow install [--force] [--apply-agent-docs]
  ai-flow start planner|worker|reviewer [--agent manual|codex|claude] [--task T001] [--no-save]
  ai-flow finish planner|worker|reviewer [--task T001] [--file report.md] [--complete]
  ai-flow dispatch worker|reviewer --agent codex|claude [--task T001] [--dry-run]
  ai-flow diff [--base HEAD] [--staged] [--include-untracked] [--open] [--cmux]
  ai-flow doctor
  ai-flow status
  ai-flow next [--agent manual|codex|claude] [--role worker|reviewer] [--task T001] [--no-save]
  ai-flow prompt worker|reviewer [--agent manual|codex|claude] [--task T001] [--no-save]
  ai-flow report [--task T001] [--file report.md]
  ai-flow verify [-- <command>]
  ai-flow run worker|reviewer --agent codex|claude [--task T001] [--dry-run] [--print]

Workflow:
  1. ai-flow install --apply-agent-docs
  2. Open one Planner session in cmux and say what you want built
  3. Planner dispatches Worker/Reviewer sessions with cmux when needed
  4. Planner opens Worker changes with ai-flow diff --cmux; use F7 / Shift+F7 to move by hunk

For people who do not know cmux:
  ai-flow doctor

Legacy/manual:
  ai-flow next --agent codex
  ai-flow run worker --agent claude
  ai-flow verify
`);
}

main();
