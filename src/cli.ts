#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { html as renderDiff2HtmlMarkup } from "diff2html";
import hljs from "highlight.js";

type FlowConfig = {
  version: 1;
  projectName: string;
  verification: {
    commands: string[];
  };
  diff: {
    context: number;
    includeUntracked: boolean;
  };
};

type GitSnapshot = {
  branch: string;
  status: string;
  diffStat: string;
  recentCommits: string;
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

type SourceFile = {
  path: string;
  name: string;
  language: string;
  content: string;
  size: number;
  changed: boolean;
  embedded: boolean;
  signature: string;
  skippedReason?: string;
};

type SourceTreeNode = {
  name: string;
  path: string;
  children: Map<string, SourceTreeNode>;
  file?: SourceFile;
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

type VerificationRun = {
  commands: string[];
  failed: boolean;
  skipped: boolean;
  logPath?: string;
};

type ReviewFileState = {
  path: string;
  signature: string;
};

const FLOW_DIR = ".monacori";
const GITIGNORE_FILE = ".gitignore";
const CONFIG_FILE = "config.json";
const STATE_FILE = "state.md";
const DECISIONS_FILE = "decisions.md";
const AGENT_SNIPPET_FILE = "agent-snippet.md";
const SOURCE_MAX_FILE_BYTES = 220_000;
const SOURCE_MAX_TOTAL_BYTES = 5_000_000;
const SOURCE_MAX_FILES = 1200;
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
      case "check":
      case "go":
        runCheck(args);
        break;
      case "verify":
        runVerification(args);
        break;
      case "diff":
        renderDiffReview(args);
        break;
      case "app":
      case "review":
        launchReviewApp(args);
        break;
      case "open":
        openCurrentRepository(args);
        break;
      case "status":
        printStatus();
        break;
      case "report":
        recordReport(args);
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
    console.log("Next: run `monacori app --include-untracked` to inspect changes, then `monacori check --include-untracked` to record verification.");
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

function runCheck(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printCheckHelp();
    return;
  }
  ensureWritableFlowState();

  const config = loadConfig();
  const separator = args.indexOf("--");
  const commandArgs = separator >= 0 ? args.slice(separator + 1) : [];
  const optionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const noVerify = optionArgs.includes("--no-verify");
  const noDiff = optionArgs.includes("--no-diff");
  const openInBrowser = optionArgs.includes("--open");
  const includeUntracked = optionArgs.includes("--include-untracked") || config.diff.includeUntracked;
  const staged = optionArgs.includes("--staged");
  const base = readOption(optionArgs, "--base");
  const contextValue = readOption(optionArgs, "--context");
  const context = contextValue ? parsePositiveInteger(contextValue, "--context") : config.diff.context;

  const verification = noVerify
    ? { commands: [], failed: false, skipped: true } satisfies VerificationRun
    : executeVerification(commandArgs.join(" "));

  let review: DiffReviewResult | undefined;
  if (!noDiff) {
    review = createDiffReview({
      base,
      staged,
      includeUntracked,
      context,
      output: join(process.cwd(), FLOW_DIR, "diffs", `${timestampForFile()}-check.html`),
      title: "monacori validation diff",
    });
    if (openInBrowser) {
      spawnSync("open", [review.path], { stdio: "ignore" });
    }
  }

  const reportPath = writeCheckReport({ verification, review });
  console.log("# monacori check");
  console.log(`Verification: ${verification.skipped ? "skipped" : verification.failed ? "failed" : "passed"}`);
  if (verification.logPath) {
    console.log(`Log: ${relative(process.cwd(), verification.logPath)}`);
  }
  if (review) {
    console.log(`Diff review: ${relative(process.cwd(), review.path)}`);
    console.log(`Files: ${review.files}`);
    console.log(`Hunks: ${review.hunks}`);
  }
  console.log(`Report: ${relative(process.cwd(), reportPath)}`);
  if (verification.failed) {
    process.exit(1);
  }
}

function runVerification(args: string[]): void {
  const separator = args.indexOf("--");
  const explicitCommand = separator >= 0 ? args.slice(separator + 1).join(" ") : "";
  const result = executeVerification(explicitCommand, { requireCommands: true });
  if (result.logPath) {
    console.log(`Verification log: ${relative(process.cwd(), result.logPath)}`);
  }
  if (result.failed) {
    console.error("Verification failed.");
    process.exit(1);
  }
  console.log("Verification passed.");
}

function renderDiffReview(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printDiffHelp();
    return;
  }
  ensureWritableFlowState();

  const config = loadConfig();
  const contextValue = readOption(args, "--context");
  const context = contextValue ? parsePositiveInteger(contextValue, "--context") : config.diff.context;
  const base = readOption(args, "--base");
  const staged = args.includes("--staged");
  const includeUntracked = args.includes("--include-untracked") || config.diff.includeUntracked;
  const openInBrowser = args.includes("--open");
  const watch = args.includes("--watch");

  if (watch) {
    serveDiffWatch({
      base,
      staged,
      includeUntracked,
      context,
      openInBrowser,
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
    title: "monacori diff review",
  });

  if (openInBrowser) {
    spawnSync("open", [result.path], { stdio: "ignore" });
  }

  console.log(`Diff review: ${relative(process.cwd(), result.path)}`);
  console.log(`URL: ${result.url}`);
  console.log(`Files: ${result.files}`);
  console.log(`Hunks: ${result.hunks}`);
  console.log("Keys: F7 next hunk, Shift+F7 previous hunk, Shift Shift search files, Cmd/Ctrl+E recent files, Cmd/Ctrl+Down jump to symbol.");
}

function launchReviewApp(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    printAppHelp();
    return;
  }
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

function printStatus(): void {
  ensureInitialized();
  const config = loadConfig();
  const git = readGitSnapshot(process.cwd());
  const reports = listRecentFiles(join(process.cwd(), FLOW_DIR, "reports"), 5);
  const logs = listRecentFiles(join(process.cwd(), FLOW_DIR, "logs"), 5);

  console.log(`# ${config.projectName} validation status`);
  console.log("");
  console.log(`Branch: ${git.branch || "(unknown)"}`);
  console.log("");
  console.log("## Git status");
  console.log(git.status || "clean");
  console.log("");
  console.log("## Diff stat");
  console.log(git.diffStat || "no diff");
  console.log("");
  console.log("## Verification commands");
  const commands = getVerificationCommands(config);
  if (commands.length === 0) {
    console.log("none configured");
  } else {
    for (const command of commands) {
      console.log(`- ${command}`);
    }
  }
  console.log("");
  console.log("## Recent reports");
  console.log(reports.length === 0 ? "none" : reports.map((path) => `- ${relative(process.cwd(), path)}`).join("\n"));
  console.log("");
  console.log("## Recent logs");
  console.log(logs.length === 0 ? "none" : logs.map((path) => `- ${relative(process.cwd(), path)}`).join("\n"));
}

function recordReport(args: string[]): void {
  ensureWritableFlowState();
  const file = readOption(args, "--file");
  const label = readOption(args, "--label") ?? "manual";
  const body = file ? readFileSync(file, "utf8") : readStdin();
  if (body.trim().length === 0) {
    throw new Error("No report content provided. Pass --file or pipe report text on stdin.");
  }

  const timestamp = timestampForFile();
  const reportDir = join(process.cwd(), FLOW_DIR, "reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${timestamp}-${sanitizeFilePart(label)}.md`);
  writeFileSync(reportPath, [
    `# Monacori Report: ${label}`,
    "",
    `Recorded: ${new Date().toISOString()}`,
    "",
    body.trim(),
    "",
  ].join("\n"));
  appendToState(`\n## Report ${timestamp} (${label})\n\n${summarizeForState(body)}\n`);
  console.log(`Recorded ${relative(process.cwd(), reportPath)}`);
}

function executeVerification(explicitCommand = "", options: { requireCommands?: boolean } = {}): VerificationRun {
  ensureWritableFlowState();
  const config = loadConfig();
  const commands = explicitCommand.trim() ? [explicitCommand.trim()] : getVerificationCommands(config);
  if (commands.length === 0) {
    if (options.requireCommands) {
      throw new Error(`No verification commands found. Add them to ${FLOW_DIR}/${CONFIG_FILE} or pass \`-- <command>\`.`);
    }
    return { commands: [], failed: false, skipped: true };
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
      maxBuffer: 1024 * 1024 * 100,
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
  return { commands, failed, skipped: false, logPath };
}

function writeCheckReport(input: {
  verification: VerificationRun;
  review?: DiffReviewResult;
}): string {
  const timestamp = timestampForFile();
  const git = readGitSnapshot(process.cwd());
  const reportDir = join(process.cwd(), FLOW_DIR, "reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `${timestamp}-check.md`);
  const verificationStatus = input.verification.skipped
    ? "skipped"
    : input.verification.failed
      ? "failed"
      : "passed";
  const report = [
    "# Monacori Validation Check",
    "",
    `Recorded: ${new Date().toISOString()}`,
    `Branch: ${git.branch || "(unknown)"}`,
    `Verification: ${verificationStatus}`,
    input.verification.logPath ? `Log: ${relative(process.cwd(), input.verification.logPath)}` : "",
    input.review ? `Diff review: ${relative(process.cwd(), input.review.path)}` : "",
    input.review ? `Changed files: ${input.review.files}` : "",
    input.review ? `Changed hunks: ${input.review.hunks}` : "",
    "",
    "## Commands",
    input.verification.commands.length === 0
      ? "- none"
      : input.verification.commands.map((command) => `- \`${command}\``).join("\n"),
    "",
    "## Git Status",
    codeBlock(git.status || "clean"),
    "",
    "## Diff Stat",
    codeBlock(git.diffStat || "no diff"),
    "",
  ].filter((line) => line !== "").join("\n");
  writeFileSync(reportPath, report);
  appendToState(`\n## Check ${timestamp}\n\n- Verification: ${verificationStatus}\n${input.review ? `- Diff review: ${relative(process.cwd(), input.review.path)}\n` : ""}`);
  return reportPath;
}

export function buildDiffReview(input: {
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  title: string;
  watch?: boolean;
}): DiffReviewBuild {
  if (!isGitRepository(process.cwd())) {
    return {
      html: renderNotGitRepoHtml(process.cwd()),
      files: 0,
      hunks: 0,
      signature: "not-a-git-repo",
      generatedAt: new Date().toISOString(),
    };
  }
  const diffText = readUnifiedDiff({
    base: input.base,
    staged: input.staged,
    context: input.context,
    includeUntracked: input.includeUntracked,
  });
  const files = parseUnifiedDiff(diffText);
  const sourceFiles = collectSourceFiles(files);
  const fileStates = collectReviewFileStates(files, sourceFiles);
  const hunks = files.reduce((sum, file) => sum + file.hunks.length, 0);
  const generatedAt = new Date().toISOString();
  const diffHtml = renderDiff2Html(diffText);
  const signature = createHash("sha1")
    .update(diffText)
    .update("\n")
    .update(sourceFiles.map((file) => `${file.path}\0${file.size}\0${file.embedded ? file.content : file.skippedReason ?? ""}`).join("\n"))
    .digest("hex");
  const html = renderDiffHtml({
    files,
    diffHtml,
    sourceFiles,
    fileStates,
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

function renderDiff2Html(diffText: string): string {
  if (diffText.trim().length === 0) {
    return "";
  }

  const markup = renderDiff2HtmlMarkup(diffText, {
    outputFormat: "side-by-side",
    drawFileList: false,
    matching: "lines",
  });
  return highlightDiffHtml(markup);
}

function highlightDiffHtml(markup: string): string {
  const parts = markup.split(/(?=<div [^>]*class="d2h-file-wrapper")/);
  if (parts.length <= 1) {
    return markup;
  }
  return parts
    .map((part) => (part.includes('class="d2h-file-wrapper"') ? highlightDiffWrapper(part) : part))
    .join("");
}

function highlightDiffWrapper(wrapper: string): string {
  const nameMatch = wrapper.match(/<span class="d2h-file-name">([\s\S]*?)<\/span>/);
  const path = nameMatch ? decodeEntities(stripHtmlTags(nameMatch[1])).trim() : "";
  const language = hljsLanguageForPath(path);
  if (!language) {
    return wrapper;
  }
  return wrapper.replace(
    /(<span class="d2h-code-line-ctn">)([\s\S]*?)(<\/span>\s*<\/div>)/g,
    (whole: string, open: string, content: string, close: string) => {
      const highlighted = highlightCtnSegments(content, language);
      return highlighted === null ? whole : `${open}${highlighted}${close}`;
    },
  );
}

// Apply hljs to a code-line container while preserving diff2html word-level
// change markup (e.g. <span class="d2h-change">...): tags are kept verbatim and
// only the text segments between them are syntax-highlighted.
function highlightCtnSegments(content: string, language: string): string | null {
  if (content.trim().length === 0) {
    return null;
  }
  if (content.indexOf("<") < 0) {
    const text = decodeEntities(content);
    if (text.trim().length === 0) {
      return null;
    }
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }
  let changed = false;
  const out = content.replace(/(<[^>]+>)|([^<]+)/g, (_match: string, tag: string, text: string) => {
    if (tag) {
      return tag;
    }
    const decoded = decodeEntities(text);
    if (decoded.trim().length === 0) {
      return text;
    }
    try {
      changed = true;
      return hljs.highlight(decoded, { language, ignoreIllegals: true }).value;
    } catch {
      return text;
    }
  });
  return changed ? out : null;
}

function hljsLanguageForPath(path: string): string {
  if (!path) {
    return "";
  }
  const lower = path.toLowerCase();
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) {
    return "kotlin";
  }
  const base = languageForPath(path);
  const mapped = base === "markup" ? "xml" : base === "text" ? "" : base;
  return mapped && hljs.getLanguage(mapped) ? mapped : "";
}

function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
}

function isGitRepository(root: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && (result.stdout ?? "").trim() === "true";
}

function renderNotGitRepoHtml(root: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>monacori</title>",
    "<style>",
    "* { box-sizing: border-box; }",
    "body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #2b2b2b; color: #a9b7c6; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }",
    ".card { max-width: 560px; padding: 40px; text-align: center; }",
    ".card .badge { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #808080; }",
    ".card h1 { font-size: 22px; margin: 10px 0 16px; color: #ffc66d; }",
    ".card p { font-size: 14px; line-height: 1.7; margin: 10px 0; }",
    ".card code { background: #3c3f41; padding: 3px 9px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #6a8759; }",
    ".card .path { color: #808080; font-size: 12px; word-break: break-all; margin-top: 22px; }",
    "</style>",
    "</head>",
    "<body>",
    '<div class="card">',
    '<div class="badge">monacori</div>',
    "<h1>Not a Git repository</h1>",
    "<p>monacori reviews changes tracked by Git, but this folder isn't a Git repository yet.</p>",
    "<p>Open a terminal here, run <code>git init</code>, then reopen monacori.</p>",
    `<p class="path">${escapeHtml(root)}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
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
  port?: string;
}): void {
  const host = "127.0.0.1";
  const port = input.port ? parsePositiveInteger(input.port, "--port") : 0;
  const build = () => buildDiffReview({
    base: input.base,
    staged: input.staged,
    includeUntracked: input.includeUntracked,
    context: input.context,
    title: "monacori live diff",
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
    console.error(`monacori: diff watch server failed: ${message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const url = `http://${host}:${actualPort}/review`;
    console.log(`Live diff review: ${url}`);
    console.log("Watching working tree. Press Ctrl+C to stop.");
    if (input.openInBrowser) {
      spawnSync("open", [url], { stdio: "ignore" });
    }
  });
}

function renderDiffHtml(input: {
  files: DiffFile[];
  diffHtml: string;
  sourceFiles: SourceFile[];
  fileStates: ReviewFileState[];
  title: string;
  subtitle: string;
  watch?: boolean;
  signature?: string;
  generatedAt?: string;
}): string {
  const totalHunks = input.files.reduce((sum, file) => sum + file.hunks.length, 0);
  const fileNav = renderDiffTree(input.files);
  const sourceNav = renderSourceTree(input.sourceFiles);
  const embeddedFiles = input.sourceFiles.filter((file) => file.embedded).length;

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="icon" href="data:,">',
    `<title>${escapeHtml(input.title)}</title>`,
    "<style>",
    diff2HtmlCss(),
    diffCss(),
    "</style>",
    "</head>",
    "<body>",
    '<aside class="sidebar" aria-label="Review navigation">',
    '<label class="search"><span class="visually-hidden">Search</span><input id="review-search" type="search" placeholder="Search files or code"></label>',
    '<div class="tabs"><button type="button" class="tab" data-tab="changes">Changes</button><button type="button" class="tab active" data-tab="files">Files</button></div>',
    `<div class="tab-panel hidden" id="changes-panel">${fileNav}</div>`,
    `<div class="tab-panel" id="files-panel">${sourceNav}</div>`,
    "</aside>",
    '<div class="sidebar-resizer" aria-hidden="true"></div>',
    '<main class="content">',
    '<section id="diff-view" class="hidden">',
    '<div class="toolbar">',
    `<div class="review-status"><span>${input.files.length} files</span><span>${totalHunks} hunks</span><span>${embeddedFiles}/${input.sourceFiles.length} indexed</span><span class="live-status ${input.watch ? "watching" : ""}" id="live-status">${input.watch ? "watching" : escapeHtml(input.generatedAt ?? new Date().toISOString())}</span></div>`,
    `<div class="counter"><span id="file-counter" class="file-counter"></span><span id="hunk-counter">0</span> / ${totalHunks}</div>`,
    "</div>",
    `<div id="diff2html-container" class="diff2html-container">${input.diffHtml || '<div class="empty">No diff to review.</div>'}</div>`,
    "</section>",
    '<section id="source-viewer" class="source-viewer">',
    '<div class="toolbar source-toolbar">',
    '<div class="source-file-meta"><span id="source-title">Source</span><span id="source-meta">Select a file from the Files tab.</span></div>',
    '<button type="button" id="back-to-diff" class="plain-button">Diff</button>',
    "</div>",
    '<div id="source-body" class="source-body empty">Select a file from the Files tab.</div>',
    "</section>",
    "</main>",
    '<div id="quick-open" class="quick-open hidden" role="dialog" aria-modal="true" aria-label="Quick open">',
    '<div class="quick-open-panel">',
    '<div class="quick-open-title"><span id="quick-open-mode">Search files</span></div>',
    '<input id="quick-open-input" type="search" autocomplete="off" spellcheck="false" placeholder="Search files">',
    '<div id="quick-open-results" class="quick-open-results"></div>',
    '<div id="quick-open-preview" class="quick-open-preview"></div>',
    "</div>",
    "</div>",
    `<script type="application/json" id="review-meta" data-watch="${input.watch ? "true" : "false"}" data-signature="${escapeAttr(input.signature ?? "")}" data-generated-at="${escapeAttr(input.generatedAt ?? "")}">{}</script>`,
    `<script type="application/json" id="source-files-data">${jsonForScript(input.sourceFiles)}</script>`,
    `<script type="application/json" id="file-state-data">${jsonForScript(input.fileStates)}</script>`,
    "<script>",
    diffScript(),
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function renderDiffTree(files: DiffFile[]): string {
  if (files.length === 0) {
    return '<div class="empty-nav">No changed files</div>';
  }

  const root: DiffTreeNode = { name: "", path: "", children: new Map() };
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

  let labelNode: DiffTreeNode = node;
  const names = [node.name];
  for (;;) {
    const entries = Array.from(labelNode.children.values());
    if (entries.length !== 1 || entries[0].file) break;
    names.push(entries[0].name);
    labelNode = entries[0];
  }

  return [
    `<details class="tree-dir" open style="--depth:${depth}">`,
    `<summary><span class="folder-icon">v</span><span class="path">${escapeHtml(names.join("/"))}</span></summary>`,
    renderTreeChildren(labelNode, depth + 1),
    "</details>",
  ].join("\n");
}

function renderSourceTree(files: SourceFile[]): string {
  if (files.length === 0) {
    return '<div class="empty-nav">No source files indexed</div>';
  }

  const root: SourceTreeNode = { name: "", path: "", children: new Map() };
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
    ].filter(Boolean).join(" | ");
    return [
      `<button type="button" class="file-link source-link tree-file" data-source-file="${escapeAttr(file.path)}" style="--depth:${depth}">`,
      `<span class="status status-${file.changed ? "modified" : "source"}">${file.changed ? "diff" : "file"}</span>`,
      `<span class="path" title="${escapeAttr(file.path)}">${escapeHtml(node.name)}</span>`,
      `<span class="count">${escapeHtml(flags || file.language)}</span>`,
      "</button>",
    ].join("");
  }

  let labelNode: SourceTreeNode = node;
  const names = [node.name];
  for (;;) {
    const entries = Array.from(labelNode.children.values());
    if (entries.length !== 1 || entries[0].file) break;
    names.push(entries[0].name);
    labelNode = entries[0];
  }

  return [
    `<details class="tree-dir source-dir" open style="--depth:${depth}">`,
    `<summary><span class="folder-icon">v</span><span class="path">${escapeHtml(names.join("/"))}</span></summary>`,
    renderSourceChildren(labelNode, depth + 1),
    "</details>",
  ].join("\n");
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
        `Binary files /dev/null and b/${file} differ`,
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
      signature: "",
    };

    if (!existsSync(absolute)) {
      const skippedReason = "file is not present in the working tree";
      sourceFiles.push({ ...base, signature: hashText(`${path}\0missing\0${skippedReason}`), skippedReason });
      continue;
    }

    const stats = statSync(absolute);
    if (!stats.isFile()) {
      continue;
    }

    if (isLikelyBinary(absolute)) {
      const skippedReason = "binary file";
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0binary\0${stats.size}`), skippedReason });
      continue;
    }

    if (stats.size > SOURCE_MAX_FILE_BYTES) {
      const skippedReason = `larger than ${formatBytes(SOURCE_MAX_FILE_BYTES)}`;
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0large\0${stats.size}`), skippedReason });
      continue;
    }

    if (embeddedFiles >= SOURCE_MAX_FILES || embeddedBytes + stats.size > SOURCE_MAX_TOTAL_BYTES) {
      const skippedReason = "source index budget reached";
      sourceFiles.push({ ...base, size: stats.size, signature: hashText(`${path}\0budget\0${stats.size}`), skippedReason });
      continue;
    }

    const content = readFileSync(absolute, "utf8");
    sourceFiles.push({
      ...base,
      content,
      size: stats.size,
      embedded: true,
      signature: hashText(`${path}\0${content}`),
    });
    embeddedFiles += 1;
    embeddedBytes += stats.size;
  }

  return sourceFiles;
}

function collectReviewFileStates(diffFiles: DiffFile[], sourceFiles: SourceFile[]): ReviewFileState[] {
  const states = new Map<string, string>();
  for (const file of sourceFiles) {
    states.set(file.path, file.signature);
  }
  for (const file of diffFiles) {
    const hunkText = file.hunks
      .map((hunk) => [
        hunk.header,
        ...hunk.lines.map((line) => `${line.kind}:${line.oldLine ?? ""}:${line.newLine ?? ""}:${line.text}`),
      ].join("\n"))
      .join("\n---\n");
    states.set(file.displayPath, hashText(`${file.displayPath}\0${file.status}\0${file.binary}\0${hunkText}`));
  }
  return Array.from(states.entries())
    .map(([path, signature]) => ({ path, signature }))
    .sort((a, b) => a.path.localeCompare(b.path));
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

function diff2HtmlCss(): string {
  try {
    return readFileSync(nodeRequire.resolve("diff2html/bundles/css/diff2html.min.css"), "utf8");
  } catch {
    return "";
  }
}

function diffCss(): string {
  return `
:root {
  color-scheme: dark;
  --bg: #2b2b2b;
  --panel: #2b2b2b;
  --text: #a9b7c6;
  --muted: #808080;
  --border: #393b3d;
  --line: #313335;
  --add: #2f3d2c;
  --del: #4b3434;
  --add-strong: #3d5238;
  --del-strong: #6b4242;
  --active: #4a88c7;
  --sidebar: #3c3f41;
  --token-comment: #808080;
  --token-keyword: #cc7832;
  --token-string: #6a8759;
  --token-number: #6897bb;
  --token-literal: #cc7832;
  --token-tag: #e8bf6a;
  --d2h-bg-color: var(--panel);
  --d2h-border-color: var(--border);
  --d2h-dim-color: var(--muted);
  --d2h-line-border-color: var(--border);
  --d2h-file-header-bg-color: var(--line);
  --d2h-file-header-border-color: var(--border);
  --d2h-empty-placeholder-bg-color: var(--line);
  --d2h-code-line-bg-color: var(--panel);
  --d2h-code-line-color: var(--text);
  --d2h-code-side-line-border-color: var(--border);
  --d2h-del-bg-color: var(--del);
  --d2h-ins-bg-color: var(--add);
  --d2h-info-bg-color: var(--line);
  --d2h-info-color: var(--muted);
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  display: grid;
  grid-template-columns: var(--sidebar-width, 280px) minmax(0, 1fr);
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
  padding: 12px;
}
.sidebar-resizer {
  position: fixed;
  top: 0;
  left: var(--sidebar-width, 280px);
  width: 9px;
  height: 100vh;
  margin-left: -5px;
  cursor: col-resize;
  z-index: 30;
}
.sidebar-resizer::after {
  content: "";
  position: absolute;
  inset: 0 4px;
  background: transparent;
  transition: background 120ms ease;
}
.sidebar-resizer:hover::after, .sidebar-resizer.resizing::after { background: var(--active); }
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.live-status { color: var(--muted); }
.live-status.watching { color: var(--active); }
.search { display: grid; gap: 6px; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
.search input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 9px;
  color: var(--text);
  background: var(--bg);
  font: 13px Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 10px; }
.tab, .plain-button {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 9px;
  color: var(--text);
  background: var(--panel);
  font: 12px ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
.tab.active, .plain-button:hover { border-color: var(--active); color: var(--active); }
.hidden { display: none !important; }
.diff2html-container { min-width: 0; caret-color: var(--active); }
#diff2html-container[contenteditable] { outline: none; }
#diff2html-container [contenteditable="false"] { caret-color: transparent; }
.d2h-wrapper { background: transparent; color: var(--text); }
.d2h-file-wrapper {
  margin: 0 0 28px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.d2h-file-header {
  border-bottom: 1px solid var(--border);
  background: var(--line);
  color: var(--text);
  font: 12px Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.d2h-file-wrapper.file-viewed {
  opacity: 0.68;
}
.d2h-file-wrapper.file-viewed:hover {
  opacity: 1;
}
.d2h-file-name { color: var(--text); }
.d2h-icon { fill: var(--muted); }
.d2h-tag { border-color: var(--border); }
.d2h-files-diff { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.d2h-file-side-diff { min-width: 0; width: 100%; overflow-x: auto; }
.d2h-file-side-diff:first-child { border-right: 1px solid var(--border); }
.d2h-code-wrapper { width: 100%; }
.d2h-diff-table {
  width: 100%;
  font: 12px Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.d2h-diff-table td { line-height: 1.45; }
.d2h-code-side-linenumber, .d2h-code-linenumber {
  width: 58px;
  color: var(--muted);
  background: var(--line);
  border-color: var(--border);
}
.d2h-code-side-line, .d2h-code-line {
  padding: 0 0.6em 0 4.5em;
  width: 100%;
  color: var(--text);
  cursor: text;
  -webkit-user-select: text;
  user-select: text;
}
.d2h-code-line-prefix { -webkit-user-select: none; user-select: none; }
.d2h-code-side-linenumber, .d2h-code-linenumber { -webkit-user-select: none; user-select: none; }
.d2h-code-line-ctn .hljs-keyword,
.d2h-code-line-ctn .hljs-built_in,
.d2h-code-line-ctn .hljs-literal,
.d2h-code-line-ctn .hljs-selector-tag,
.d2h-code-line-ctn .hljs-section { color: #cc7832; }
.d2h-code-line-ctn .hljs-string,
.d2h-code-line-ctn .hljs-regexp,
.d2h-code-line-ctn .hljs-char.escape_ { color: #6a8759; }
.d2h-code-line-ctn .hljs-number { color: #6897bb; }
.d2h-code-line-ctn .hljs-comment,
.d2h-code-line-ctn .hljs-quote { color: #808080; font-style: italic; }
.d2h-code-line-ctn .hljs-meta,
.d2h-code-line-ctn .hljs-doctag { color: #bbb529; }
.d2h-code-line-ctn .hljs-title,
.d2h-code-line-ctn .hljs-title.function_,
.d2h-code-line-ctn .hljs-function .hljs-title { color: #ffc66d; }
.d2h-code-line-ctn .hljs-title.class_,
.d2h-code-line-ctn .hljs-class .hljs-title,
.d2h-code-line-ctn .hljs-type { color: #a9b7c6; }
.d2h-code-line-ctn .hljs-attr,
.d2h-code-line-ctn .hljs-variable,
.d2h-code-line-ctn .hljs-template-variable,
.d2h-code-line-ctn .hljs-property { color: #9876aa; }
.d2h-code-line-ctn .hljs-attribute { color: #a9b7c6; }
.d2h-code-line-ctn .hljs-tag,
.d2h-code-line-ctn .hljs-name { color: #e8bf6a; }
.d2h-code-line-ctn .hljs-symbol,
.d2h-code-line-ctn .hljs-bullet,
.d2h-code-line-ctn .hljs-link { color: #6897bb; }
.d2h-code-line-ctn .hljs-emphasis { font-style: italic; }
.d2h-code-line-ctn .hljs-strong { font-weight: 700; }
.d2h-info { background: var(--line); color: var(--muted); border-color: var(--border); }
.d2h-info .d2h-code-side-line, .d2h-info .d2h-code-line { color: transparent; user-select: none; }
.d2h-info td, td.d2h-info { border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.d2h-file-wrapper.df-inactive { display: none; }
.d2h-del { background: var(--del); }
.d2h-ins { background: var(--add); }
.d2h-del .d2h-change { background: var(--del-strong); }
.d2h-ins .d2h-change { background: var(--add-strong); }
.d2h-code-line-ctn ins, .d2h-code-line-ctn del {
  text-decoration: none;
  border-radius: 2px;
  padding: 0 1px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
.d2h-code-line-ctn ins { background: var(--add-strong); }
.d2h-code-line-ctn del { background: var(--del-strong); }
.d2h-code-side-linenumber.d2h-del, .d2h-code-linenumber.d2h-del { background: var(--del); }
.d2h-code-side-linenumber.d2h-ins, .d2h-code-linenumber.d2h-ins { background: var(--add); }
.d2h-diff-table tr.hunk, .d2h-diff-table tr.hunk-peer { scroll-margin-top: 76px; }
.d2h-diff-table tr.hunk.active td, .d2h-diff-table tr.hunk-peer.active td {
  box-shadow: none;
}
.file-counter:not(:empty) { margin-right: 14px; color: var(--muted); }
.d2h-file-collapse {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: transparent;
  background: var(--panel);
  overflow: hidden;
  padding: 0;
}
.d2h-file-collapse::after {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: transparent;
}
.d2h-file-wrapper.file-viewed .d2h-file-collapse::after {
  background: var(--active);
}
.d2h-file-collapse-input {
  display: none;
}
.tree { display: grid; gap: 2px; font-family: Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.tree-dir { display: grid; gap: 2px; }
.tree-dir summary {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding: 3px 5px 3px calc(7px + (var(--depth) * 16px));
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
  font-size: 9px;
  color: var(--muted);
  transition: transform 120ms ease;
}
.file-link.tree-file { padding-left: calc(8px + (var(--depth) * 16px)); }
.tree-focus { box-shadow: inset 0 0 0 1px var(--active); border-radius: 6px; }
summary.tree-focus { background: var(--bg); }
.file-link {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 5px 6px;
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
.file-link:hover, .file-link.active { background: var(--bg); border-color: var(--border); }
.file-link.viewed { opacity: 0.58; }
.file-link.viewed:hover, .file-link.viewed.active { opacity: 1; }
.path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.count { color: var(--muted); font-size: 11px; }
.status {
  display: inline-grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  border-radius: 4px;
  padding: 0 3px;
  font-size: 9px;
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
  padding: 10px 24px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}
h1 { margin: 0; font-size: 18px; }
.review-status {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
}
.toolbar p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.counter {
  min-width: 96px;
  text-align: right;
  color: var(--muted);
  font: 13px Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.empty { padding: 24px; color: var(--muted); }
.source-viewer { min-height: 100vh; }
.source-toolbar { margin-bottom: 0; }
.source-file-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
}
.source-file-meta #source-title {
  min-width: 0;
  max-width: min(56vw, 720px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  font: 13px Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.source-file-meta #source-meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-body {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: auto;
  background: var(--panel);
  user-select: text;
}
.source-table {
  width: 100%;
  border-collapse: collapse;
  font: 12px Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.source-table td {
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.45;
}
.source-row.search-hit .source-code { background: color-mix(in srgb, var(--active) 14%, transparent); }
.source-row.cursor-line .source-code {
  background: color-mix(in srgb, var(--active) 10%, transparent);
  box-shadow: inset 2px 0 0 var(--active);
}
.source-row.symbol-target .source-code {
  background: color-mix(in srgb, var(--active) 18%, transparent);
}
.source-code {
  padding: 2px 10px;
  cursor: text;
  user-select: text;
}
.code-cursor {
  display: inline-block;
  width: 2px;
  height: 1.25em;
  margin: -1px 0;
  background: var(--active);
  vertical-align: text-bottom;
  pointer-events: none;
  animation: cursor-blink 1s steps(2, start) infinite;
}
@keyframes cursor-blink {
  50% { opacity: 0; }
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
.tok-comment { color: var(--token-comment); font-style: italic; }
.tok-keyword { color: var(--token-keyword); font-weight: 650; }
.tok-string { color: var(--token-string); }
.tok-number { color: var(--token-number); }
.tok-literal { color: var(--token-literal); }
.tok-tag { color: var(--token-tag); font-weight: 650; }
.quick-open {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: start center;
  padding-top: min(12vh, 96px);
  background: color-mix(in srgb, #000 24%, transparent);
}
.quick-open-panel {
  width: min(720px, calc(100vw - 32px));
  max-height: min(680px, calc(100vh - 64px));
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}
.quick-open-title {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 12px;
}
.quick-open-hint { font-family: Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
#quick-open-input {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--border);
  outline: 0;
  padding: 13px 14px;
  background: var(--bg);
  color: var(--text);
  font: 15px Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.quick-open-results { overflow: auto; padding: 6px; max-height: 232px; }
.quick-open-main { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.quick-open-path { flex: 1 1 auto; }
.quick-open-preview {
  border-top: 1px solid var(--border);
  max-height: 320px;
  overflow: auto;
  background: var(--bg);
}
.qp-head {
  position: sticky;
  top: 0;
  padding: 5px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font: 11px Monaco, ui-monospace, SFMono-Regular, Menlo, monospace;
}
.qp-body { padding: 4px 0; font: 12px Monaco, ui-monospace, SFMono-Regular, Menlo, monospace; }
.qp-line { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 6px; padding: 0 8px; white-space: pre; line-height: 1.5; }
.qp-num { color: var(--muted); text-align: right; user-select: none; }
.qp-hit { background: color-mix(in srgb, var(--active) 20%, transparent); }
.qp-empty { padding: 20px; color: var(--muted); }
.quick-open-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  width: 100%;
  min-height: 24px;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 2px 8px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.quick-open-item.active, .quick-open-item:hover { background: var(--bg); border-color: var(--active); }
.quick-open-main { min-width: 0; }
.quick-open-name {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 13px Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.quick-open-path {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}
.quick-open-badge { align-self: center; color: var(--muted); font-size: 12px; }
.quick-open-empty { padding: 28px 14px; color: var(--muted); font-size: 13px; }
@media (max-width: 900px) {
  body { grid-template-columns: 1fr; }
  .sidebar { position: relative; height: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .content { padding: 16px; }
  .toolbar { margin: -16px -16px 16px; padding: 12px 16px; }
  .d2h-files-diff { grid-template-columns: 1fr; }
  .d2h-file-side-diff:first-child { border-right: 0; border-bottom: 1px solid var(--border); }
}
`;
}

function diffScript(): string {
  return String.raw`
prepareDiff2HtmlHunks();
const hunks = Array.from(document.querySelectorAll('.hunk'));
const hunkPeers = Array.from(document.querySelectorAll('.hunk-peer'));
const links = Array.from(document.querySelectorAll('#changes-panel .file-link'));
const sourceLinks = Array.from(document.querySelectorAll('.source-link'));
const sourceFiles = JSON.parse(document.getElementById('source-files-data')?.textContent || '[]');
const fileStates = JSON.parse(document.getElementById('file-state-data')?.textContent || '[]');
const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
const fileSignatureByPath = new Map(fileStates.map((file) => [file.path, file.signature]));
const searchInput = document.getElementById('review-search');
const reviewMeta = document.getElementById('review-meta');
const watchEnabled = reviewMeta?.dataset.watch === 'true';
const currentSignature = reviewMeta?.dataset.signature || '';
const uiStateKey = 'monacori-diff-ui:' + location.pathname;
const recentKey = 'monacori-diff-recent:' + location.pathname;
const viewedKey = 'monacori-diff-viewed:' + location.pathname;
const quickOpen = document.getElementById('quick-open');
const quickInput = document.getElementById('quick-open-input');
const quickResults = document.getElementById('quick-open-results');
const quickModeLabel = document.getElementById('quick-open-mode');
let current = -1;
let checkingForUpdates = false;
let lastShiftAt = 0;
let quickMode = 'all';
let quickItems = [];
let quickActive = 0;
let viewerCursor = null;
let treeFocusIndex = -1;
let selectionAnchor = null;
let measuredCharWidth = 0;

function prepareDiff2HtmlHunks() {
  const wrappers = Array.from(document.querySelectorAll('.d2h-file-wrapper'));
  let globalHunkIndex = 0;
  wrappers.forEach((wrapper, fileIndex) => {
    wrapper.id = 'file-' + fileIndex;
    const fileName = wrapper.querySelector('.d2h-file-name')?.textContent?.trim() || '';
    const headerToIndex = new Map();
    const rows = Array.from(wrapper.querySelectorAll('tr'));
    rows.forEach((row) => {
      const header = row.textContent.trim();
      if (!header.startsWith('@@')) return;
      let index = headerToIndex.get(header);
      if (index === undefined) {
        index = globalHunkIndex;
        headerToIndex.set(header, index);
        row.classList.add('hunk');
        row.id = 'hunk-' + index;
        globalHunkIndex += 1;
      } else {
        row.classList.add('hunk-peer');
      }
      row.dataset.hunkIndex = String(index);
      row.dataset.file = fileName;
    });
  });
}

prepareViewedControls();

function prepareViewedControls() {
  pruneViewedState();
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    const fileName = wrapper.querySelector('.d2h-file-name')?.textContent?.trim() || '';
    const toggle = wrapper.querySelector('.d2h-file-collapse');
    const input = toggle?.querySelector('input');
    if (!fileName || !toggle || !input) return;
    toggle.title = 'Mark viewed';
    input.tabIndex = -1;
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      setFileViewed(fileName, !isFileViewed(fileName));
    });
  });
  applyViewedState();
}

function loadViewedState() {
  try {
    const value = JSON.parse(localStorage.getItem(viewedKey) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveViewedState(value) {
  try {
    localStorage.setItem(viewedKey, JSON.stringify(value));
  } catch {}
}

function currentFileSignature(path) {
  return fileSignatureByPath.get(path) || '';
}

function isFileViewed(path) {
  const viewed = loadViewedState();
  const signature = currentFileSignature(path);
  return Boolean(signature && viewed[path] === signature);
}

function setFileViewed(path, viewed) {
  const state = loadViewedState();
  if (viewed) {
    const signature = currentFileSignature(path);
    if (signature) state[path] = signature;
  } else {
    delete state[path];
  }
  saveViewedState(state);
  applyViewedState();
}

function pruneViewedState() {
  const state = loadViewedState();
  let changed = false;
  Object.keys(state).forEach((path) => {
    if (state[path] !== currentFileSignature(path)) {
      delete state[path];
      changed = true;
    }
  });
  if (changed) saveViewedState(state);
}

function applyViewedState() {
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    const fileName = wrapper.querySelector('.d2h-file-name')?.textContent?.trim() || '';
    const viewed = isFileViewed(fileName);
    wrapper.classList.toggle('file-viewed', viewed);
    const checkbox = wrapper.querySelector('.d2h-file-collapse-input');
    if (checkbox) checkbox.checked = viewed;
  });
  links.forEach((link) => {
    link.classList.toggle('viewed', isFileViewed(link.dataset.file || ''));
  });
}

function setActive(index, shouldScroll = true) {
  if (hunks.length === 0) return;
  current = ((index % hunks.length) + hunks.length) % hunks.length;
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  const active = hunks[current];
  const file = active.dataset.file;
  showOnlyFile(file);
  hunks.forEach((hunk, i) => hunk.classList.toggle('active', i === current));
  hunkPeers.forEach((hunk) => hunk.classList.toggle('active', Number(hunk.dataset.hunkIndex) === current));
  links.forEach((link) => link.classList.toggle('active', link.dataset.file === file));
  document.getElementById('hunk-counter').textContent = String(current + 1);
  if (shouldScroll) active.scrollIntoView({ block: 'start' });
  if (file) rememberRecent(file, 'change');
  history.replaceState(null, '', '#hunk-' + current);
}

function showOnlyFile(fileName) {
  let activeNum = 0;
  const wrappers = Array.from(document.querySelectorAll('.d2h-file-wrapper'));
  wrappers.forEach((wrapper, i) => {
    const name = wrapper.querySelector('.d2h-file-name')?.textContent?.trim() || '';
    const isActive = name === fileName;
    wrapper.classList.toggle('df-inactive', !isActive);
    if (isActive) activeNum = i + 1;
  });
  const counter = document.getElementById('file-counter');
  if (counter) counter.textContent = activeNum + ' / ' + wrappers.length + ' files';
}

function next(delta) {
  setActive(current < 0 ? initialHunkForNavigation(delta) : current + delta);
}

function initialHunkForNavigation(delta) {
  const openPath = document.getElementById('source-viewer')?.dataset.openPath || '';
  const sourceHunk = firstHunkForPath(openPath);
  if (sourceHunk >= 0) return sourceHunk;
  return delta < 0 ? hunks.length - 1 : 0;
}

function firstHunkForPath(path) {
  if (!path) return -1;
  const link = links.find((candidate) => candidate.dataset.file === path);
  if (!link) return -1;
  const index = Number(link.dataset.hunk);
  return Number.isNaN(index) ? -1 : index;
}

function openQuickOpen(mode) {
  if (!quickOpen || !quickInput || !quickModeLabel) return;
  quickMode = mode;
  quickModeLabel.textContent = mode === 'recent' ? 'Recent files' : 'Search files';
  quickOpen.classList.remove('hidden');
  quickInput.value = '';
  renderQuickOpenResults();
  setTimeout(() => quickInput.focus(), 0);
}

function closeQuickOpen() {
  quickOpen?.classList.add('hidden');
}

function handleQuickOpenKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeQuickOpen();
    return true;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    quickActive = Math.min(quickActive + 1, Math.max(quickItems.length - 1, 0));
    updateQuickActive();
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    quickActive = Math.max(quickActive - 1, 0);
    updateQuickActive();
    return true;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    openQuickItem(quickItems[quickActive]);
    return true;
  }
  return false;
}

function renderQuickOpenResults() {
  if (!quickResults) return;
  const query = quickInput?.value.trim().toLowerCase() || '';
  const candidates = quickMode === 'recent' && query.length === 0 ? recentItems() : allQuickItems();
  quickItems = candidates
    .filter((item) => quickMode !== 'recent' || query.length > 0 || item.recent)
    .filter((item) => {
      if (query.length === 0) return true;
      return (item.path + '\n' + item.name + '\n' + item.detail).toLowerCase().includes(query);
    })
    .sort((a, b) => scoreQuickItem(a, query) - scoreQuickItem(b, query) || a.path.localeCompare(b.path))
    .slice(0, 80);
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
  if (quickItems.length === 0) {
    quickResults.innerHTML = '<div class="quick-open-empty">No files found.</div>';
    return;
  }
  quickResults.innerHTML = quickItems.map((item, index) => [
    '<button type="button" class="quick-open-item' + (index === quickActive ? ' active' : '') + '" data-index="' + index + '">',
    '<span class="quick-open-main">',
    '<span class="quick-open-name">' + escapeHtml(item.name) + '</span>',
    '<span class="quick-open-path">' + escapeHtml(item.path) + '</span>',
    '</span>',
    '<span class="quick-open-badge">' + escapeHtml(item.detail) + '</span>',
    '</button>',
  ].join('')).join('');
  renderQuickPreview(quickItems[quickActive]);
}

function updateQuickActive() {
  quickResults?.querySelectorAll('.quick-open-item').forEach((element, index) => {
    const active = index === quickActive;
    element.classList.toggle('active', active);
    if (active) element.scrollIntoView({ block: 'nearest' });
  });
  renderQuickPreview(quickItems[quickActive]);
}

function renderQuickPreview(item) {
  const preview = document.getElementById('quick-open-preview');
  if (!preview) return;
  if (!item) { preview.innerHTML = ''; return; }
  const file = sourceByPath.get(item.path);
  if (!file || !file.embedded) {
    preview.innerHTML = '<div class="qp-empty">' + escapeHtml(item.path) + '</div>';
    return;
  }
  const query = ((quickInput && quickInput.value) || '').trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  let firstHit = -1;
  const rows = lines.map((line, i) => {
    const hit = query.length > 0 && line.toLowerCase().includes(query);
    if (hit && firstHit < 0) firstHit = i;
    return '<div class="qp-line' + (hit ? ' qp-hit' : '') + '"><span class="qp-num">' + (i + 1) + '</span><span class="qp-code">' + highlightLine(line, file.language || 'text') + '</span></div>';
  }).join('');
  preview.innerHTML = '<div class="qp-head">' + escapeHtml(item.path) + '</div><div class="qp-body">' + rows + '</div>';
  if (firstHit >= 0) {
    const target = preview.querySelectorAll('.qp-line')[firstHit];
    if (target) target.scrollIntoView({ block: 'center' });
  }
}

function openQuickItem(item) {
  if (!item) return;
  closeQuickOpen();
  rememberRecent(item.path, item.kind);
  if (item.kind === 'source' && sourceByPath.has(item.path)) {
    openSourceFile(item.path);
    return;
  }
  const link = links.find((candidate) => candidate.dataset.file === item.path);
  if (!link) return;
  const target = Number(link.dataset.hunk);
  if (!Number.isNaN(target) && target >= 0 && target < hunks.length) {
    setActive(target);
  } else {
    showDiffView(false);
    const targetId = link.getAttribute('href')?.slice(1);
    if (targetId) document.getElementById(targetId)?.scrollIntoView({ block: 'center' });
  }
}

function allQuickItems() {
  const items = sourceFiles.map((file) => ({
    path: file.path,
    name: baseName(file.path),
    detail: [file.changed ? 'changed' : 'file', file.language || 'text'].join(' - '),
    kind: 'source',
    recent: false,
  }));
  links.forEach((link) => {
    const path = link.dataset.file || '';
    if (!path || sourceByPath.has(path)) return;
    items.push({ path, name: baseName(path), detail: 'diff', kind: 'change', recent: false });
  });
  const recent = loadRecent();
  const recentRank = new Map(recent.map((item, index) => [item.path, index]));
  return items.map((item) => ({
    ...item,
    recent: recentRank.has(item.path),
    recentRank: recentRank.get(item.path) ?? 9999,
  }));
}

function recentItems() {
  const all = allQuickItems();
  const byPath = new Map(all.map((item) => [item.path, item]));
  return loadRecent()
    .map((item) => byPath.get(item.path) || {
      path: item.path,
      name: baseName(item.path),
      detail: item.kind === 'change' ? 'diff' : 'file',
      kind: item.kind,
      recent: true,
      recentRank: 0,
    })
    .map((item, index) => ({ ...item, recent: true, recentRank: index }));
}

function scoreQuickItem(item, query) {
  let score = item.recentRank ?? 9999;
  if (!query) return score;
  const path = item.path.toLowerCase();
  const name = item.name.toLowerCase();
  if (name === query) score -= 3000;
  else if (name.startsWith(query)) score -= 2000;
  else if (path.includes('/' + query)) score -= 1000;
  else if (path.includes(query)) score -= 500;
  if (item.recent) score -= 100;
  return score;
}

function loadRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey) || '[]');
    return Array.isArray(value) ? value.filter((item) => item && typeof item.path === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecent(path, kind) {
  if (!path) return;
  const next = [{ path, kind }, ...loadRecent().filter((item) => item.path !== path)].slice(0, 30);
  try {
    localStorage.setItem(recentKey, JSON.stringify(next));
  } catch {}
}

function baseName(path) {
  return String(path).split('/').filter(Boolean).pop() || String(path);
}

function treeRows() {
  const panel = document.querySelector('.tab-panel:not(.hidden)');
  if (!panel) return [];
  return Array.from(panel.querySelectorAll('summary, .file-link')).filter((el) => el.getClientRects().length > 0);
}

function focusTree(index) {
  const rows = treeRows();
  if (rows.length === 0) return;
  treeFocusIndex = Math.max(0, Math.min(rows.length - 1, index));
  rows.forEach((row, i) => row.classList.toggle('tree-focus', i === treeFocusIndex));
  const el = rows[treeFocusIndex];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function clearTreeFocus() {
  treeFocusIndex = -1;
  document.querySelectorAll('.tree-focus').forEach((el) => el.classList.remove('tree-focus'));
}

function handleTreeKey(event) {
  const rows = treeRows();
  if (rows.length === 0) return false;
  if (treeFocusIndex >= rows.length) treeFocusIndex = rows.length - 1;
  const row = rows[treeFocusIndex];
  const isFolder = row && row.tagName === 'SUMMARY';
  if (event.key === 'ArrowDown') { event.preventDefault(); focusTree(treeFocusIndex + 1); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); focusTree(treeFocusIndex - 1); return true; }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (row && row.classList.contains('file-link')) row.click();
    else if (isFolder && row.parentElement) row.parentElement.open = !row.parentElement.open;
    return true;
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (isFolder && row.parentElement && !row.parentElement.open) row.parentElement.open = true;
    else focusTree(treeFocusIndex + 1);
    return true;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (isFolder && row.parentElement && row.parentElement.open) row.parentElement.open = false;
    else focusTree(treeFocusIndex - 1);
    return true;
  }
  if (event.key === 'Escape') { event.preventDefault(); clearTreeFocus(); return true; }
  return false;
}

document.addEventListener('keydown', (event) => {
  if (!quickOpen?.classList.contains('hidden')) {
    if (handleQuickOpenKey(event)) return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key === '1') {
    event.preventDefault();
    focusTree(treeFocusIndex < 0 ? 0 : treeFocusIndex);
    return;
  }
  if (treeFocusIndex >= 0 && handleTreeKey(event)) return;
  if (treeFocusIndex < 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isSourceViewerVisible() && handleSourceCaretKey(event)) return;

  if (event.key === 'Shift' && !event.repeat) {
    const now = performance.now();
    if (now - lastShiftAt < 1000) {
      event.preventDefault();
      lastShiftAt = 0;
      openQuickOpen('all');
      return;
    }
    lastShiftAt = now;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    openQuickOpen('recent');
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowDown') {
    event.preventDefault();
    goToSymbolUnderCursor();
    return;
  }

  if (event.key === 'F7') {
    event.preventDefault();
    if (!document.getElementById('source-viewer')?.classList.contains('hidden')) {
      const sourceHunk = firstHunkForPath(document.getElementById('source-viewer')?.dataset.openPath || '');
      if (sourceHunk >= 0) {
        setActive(sourceHunk);
        return;
      }
    }
    next(event.shiftKey ? -1 : 1);
  } else if (event.key === ']') {
    event.preventDefault();
    next(1);
  } else if (event.key === '[') {
    event.preventDefault();
    next(-1);
  }
});

quickInput?.addEventListener('input', () => renderQuickOpenResults());
quickResults?.addEventListener('mousemove', (event) => {
  const item = event.target.closest?.('.quick-open-item');
  if (!item) return;
  quickActive = Number(item.dataset.index || 0);
  updateQuickActive();
});
quickResults?.addEventListener('click', (event) => {
  const item = event.target.closest?.('.quick-open-item');
  if (!item) return;
  const index = Number(item.dataset.index || 0);
  openQuickItem(quickItems[index]);
});
quickOpen?.addEventListener('click', (event) => {
  if (event.target === quickOpen) closeQuickOpen();
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
document.getElementById('source-body')?.addEventListener('click', handleSourceClick);
document.addEventListener('copy', handleSourceCopy);

searchInput?.addEventListener('input', () => {
  filterNavigation(searchInput.value);
  const openPath = document.getElementById('source-viewer')?.dataset.openPath;
  if (openPath) openSourceFile(openPath, false);
});

const restored = restoreUiState();
if (!restored) {
  const initial = location.hash.match(/^#hunk-(\\d+)$/);
  if (initial) setActive(Number(initial[1]), false);
  else openDefaultSourceFile();
}
if (watchEnabled) setInterval(checkForLiveUpdate, 1500);
window.addEventListener('beforeunload', saveUiState);

(function setupSidebarResize() {
  const resizer = document.querySelector('.sidebar-resizer');
  if (!resizer) return;
  const sidebarKey = 'monacori-sidebar-width:' + location.pathname;
  const saved = localStorage.getItem(sidebarKey);
  if (saved) document.documentElement.style.setProperty('--sidebar-width', saved);
  let resizing = false;
  resizer.addEventListener('mousedown', (event) => {
    resizing = true;
    resizer.classList.add('resizing');
    document.body.style.userSelect = 'none';
    event.preventDefault();
  });
  document.addEventListener('mousemove', (event) => {
    if (!resizing) return;
    const width = Math.min(640, Math.max(180, event.clientX));
    document.documentElement.style.setProperty('--sidebar-width', width + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    resizer.classList.remove('resizing');
    document.body.style.userSelect = '';
    try { localStorage.setItem(sidebarKey, getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim()); } catch (e) {}
  });
})();

(function setupDiffCaret() {
  const container = document.getElementById('diff2html-container');
  if (!container) return;
  container.setAttribute('contenteditable', 'true');
  container.setAttribute('spellcheck', 'false');
  container.setAttribute('aria-readonly', 'true');
  container.querySelectorAll('.d2h-code-side-linenumber, .d2h-code-linenumber, .d2h-code-line-prefix').forEach((el) => el.setAttribute('contenteditable', 'false'));
  const block = (event) => event.preventDefault();
  container.addEventListener('beforeinput', block);
  container.addEventListener('paste', block);
  container.addEventListener('drop', block);
  container.addEventListener('dragstart', block);
  container.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Tab') {
      event.preventDefault();
    }
  });
})();

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
  if (current < 0 && hunks.length) {
    setActive(0, shouldScroll);
    return;
  }
  if (current >= 0 && hunks[current]) {
    showOnlyFile(hunks[current].dataset.file);
    if (shouldScroll) hunks[current].scrollIntoView({ block: 'start' });
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
    view: document.getElementById('source-viewer')?.classList.contains('hidden') ? 'diff' : 'source',
    sourcePath,
    hash: location.hash,
  }));
}

function restoreUiState() {
  const raw = sessionStorage.getItem(uiStateKey);
  if (!raw) return false;
  try {
    const state = JSON.parse(raw);
    if (searchInput && state.search) {
      searchInput.value = state.search;
      filterNavigation(state.search);
    }
    if (state.view === 'diff') {
      const match = String(state.hash || location.hash || '').match(/^#hunk-(\\d+)$/);
      setActive(match ? Number(match[1]) : current >= 0 ? current : 0, false);
      return true;
    }
    if (state.sourcePath && sourceByPath.has(state.sourcePath)) {
      openSourceFile(state.sourcePath);
      return true;
    }
  } catch {
    sessionStorage.removeItem(uiStateKey);
  }
  return false;
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

function openDefaultSourceFile() {
  const file = sourceFiles.find((candidate) => candidate.changed && candidate.embedded)
    || sourceFiles.find((candidate) => candidate.embedded)
    || sourceFiles.find((candidate) => candidate.changed)
    || sourceFiles[0];
  if (file) {
    openSourceFile(file.path);
    return;
  }
  if (hunks.length > 0) setActive(0, false);
}

function handleSourceCopy(event) {
  const selection = window.getSelection();
  const sourceBody = document.getElementById('source-body');
  const viewer = document.getElementById('source-viewer');
  if (!selection || selection.isCollapsed || !sourceBody || !viewer || viewer.classList.contains('hidden')) return;
  if (!selection.anchorNode || !selection.focusNode) return;
  if (!sourceBody.contains(selection.anchorNode) || !sourceBody.contains(selection.focusNode)) return;

  const path = viewer.dataset.openPath || '';
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const rows = selectedSourceRows(selection);
  if (rows.length === 0) return;

  const lineNumbers = rows
    .map((row) => Number(row.dataset.lineIndex || 0) + 1)
    .filter((line) => Number.isFinite(line))
    .sort((a, b) => a - b);
  const startLine = lineNumbers[0];
  const endLine = lineNumbers[lineNumbers.length - 1];
  if (!startLine || !endLine) return;

  const selectedText = cleanSelectedSourceText(selection.toString(), rows);
  const code = selectedText || sourceLinesForRows(file, rows);
  if (!code.trim()) return;

  const reference = path + ':' + (startLine === endLine ? String(startLine) : startLine + '-' + endLine);
  const language = file.language && file.language !== 'text' ? file.language : '';
  const fence = String.fromCharCode(96).repeat(3);
  const payload = reference + '\n\n' + fence + language + '\n' + code.replace(/\s+$/g, '') + '\n' + fence;
  event.clipboardData?.setData('text/plain', payload);
  event.preventDefault();
}

function selectedSourceRows(selection) {
  if (!selection.rangeCount) return [];
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  return Array.from(document.querySelectorAll('#source-body .source-row'))
    .filter((row) => ranges.some((range) => {
      try {
        return range.intersectsNode(row);
      } catch {
        return false;
      }
    }))
    .sort((a, b) => Number(a.dataset.lineIndex || 0) - Number(b.dataset.lineIndex || 0));
}

function cleanSelectedSourceText(text, rows) {
  const value = String(text || '').replace(/\r/g, '').replace(/\u200b/g, '');
  if (!value.trim()) return '';
  const lineNumbers = rows.map((row) => Number(row.dataset.lineIndex || 0) + 1);
  const lines = value.split('\n');
  if (lines.length >= lineNumbers.length) {
    return lines
      .map((line, index) => {
        const lineNumber = lineNumbers[index];
        return lineNumber ? line.replace(new RegExp('^\\s*' + lineNumber + '\\s+'), '') : line;
      })
      .join('\n')
      .trimEnd();
  }
  return value.trimEnd();
}

function sourceLinesForRows(file, rows) {
  const lines = file.content.split(/\r?\n/);
  return rows
    .map((row) => lines[Number(row.dataset.lineIndex || 0)] || '')
    .join('\n')
    .trimEnd();
}

function handleSourceClick(event) {
  const target = event.target;
  const row = target?.closest?.('.source-row');
  if (!row) return;
  const viewer = document.getElementById('source-viewer');
  const path = viewer?.dataset.openPath || '';
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const lineIndex = Number(row.dataset.lineIndex || 0);
  const lines = file.content.split(/\r?\n/);
  const line = lines[lineIndex] || '';
  const codeCell = row.querySelector('.source-code');
  const column = estimateColumnFromClick(codeCell, event, line);
  setSourceCursor(path, lineIndex, column, false, -1);
}

function estimateColumnFromClick(codeCell, event, line) {
  if (!codeCell) return 0;
  const rect = codeCell.getBoundingClientRect();
  const style = getComputedStyle(codeCell);
  const paddingLeft = Number.parseFloat(style.paddingLeft || '0') || 0;
  const x = event.clientX - rect.left - paddingLeft;
  const width = measuredCharWidth || measureCharWidth(codeCell);
  const column = Math.round(x / Math.max(width, 1));
  return Math.max(0, Math.min(line.length, column));
}

function measureCharWidth(element) {
  const probe = document.createElement('span');
  probe.textContent = 'mmmmmmmmmm';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.font = getComputedStyle(element).font;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  measuredCharWidth = width || 7;
  return measuredCharWidth;
}

function setSourceCursor(path, lineIndex, column, shouldReveal = false, targetLine = -1) {
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const lines = file.content.split(/\r?\n/);
  const boundedLine = Math.max(0, Math.min(lineIndex, Math.max(lines.length - 1, 0)));
  const boundedColumn = Math.max(0, Math.min(column, (lines[boundedLine] || '').length));
  viewerCursor = {
    path,
    lineIndex: boundedLine,
    column: boundedColumn,
    targetLine,
  };

  const viewer = document.getElementById('source-viewer');
  const shouldSwitch = !viewer || viewer.dataset.openPath !== path || viewer.classList.contains('hidden');
  openSourceFile(path, shouldSwitch);
  if (shouldReveal) {
    requestAnimationFrame(() => {
      document.querySelector('.source-row.cursor-line')?.scrollIntoView({ block: 'center' });
    });
  }
}

function openSourceAt(path, lineIndex, column) {
  setSourceCursor(path, lineIndex, column, true, lineIndex);
}

function isSourceViewerVisible() {
  const viewer = document.getElementById('source-viewer');
  return Boolean(viewer && !viewer.classList.contains('hidden'));
}

function handleSourceCaretKey(event) {
  if (!viewerCursor) return false;
  const extend = event.shiftKey;
  if (event.key === 'ArrowDown') { event.preventDefault(); moveSourceCursor(1, 0, extend); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveSourceCursor(-1, 0, extend); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveSourceCursor(0, -1, extend); return true; }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveSourceCursor(0, 1, extend); return true; }
  return false;
}

function moveSourceCursor(dLine, dColumn, extend) {
  if (!viewerCursor) return;
  const file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return;
  const lines = file.content.split(/\r?\n/);
  let line = viewerCursor.lineIndex;
  let col = viewerCursor.column;
  if (dColumn < 0) {
    if (col > 0) col -= 1;
    else if (line > 0) { line -= 1; col = (lines[line] || '').length; }
  } else if (dColumn > 0) {
    if (col < (lines[line] || '').length) col += 1;
    else if (line < lines.length - 1) { line += 1; col = 0; }
  }
  if (dLine !== 0) {
    line = Math.max(0, Math.min(lines.length - 1, line + dLine));
    col = Math.min(col, (lines[line] || '').length);
  }
  if (extend) {
    if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  } else {
    selectionAnchor = null;
  }
  setSourceCursor(viewerCursor.path, line, col, true, -1);
  applySourceSelection();
}

function applySourceSelection() {
  const sel = window.getSelection();
  if (!sel) return;
  if (!selectionAnchor || !viewerCursor) { sel.removeAllRanges(); return; }
  const a = caretDomPosition(selectionAnchor.lineIndex, selectionAnchor.column);
  const c = caretDomPosition(viewerCursor.lineIndex, viewerCursor.column);
  if (a && c) {
    try { sel.setBaseAndExtent(a.node, a.offset, c.node, c.offset); } catch (e) {}
  }
}

function caretDomPosition(lineIndex, column) {
  const cell = document.querySelector('.source-row[data-line-index="' + lineIndex + '"] .source-code');
  if (!cell) return null;
  let remaining = column;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
  }
  return { node: cell, offset: cell.childNodes.length };
}

function wordAtCursor() {
  if (!viewerCursor) return null;
  const file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return null;
  const line = file.content.split(/\r?\n/)[viewerCursor.lineIndex] || '';
  const column = Math.max(0, Math.min(viewerCursor.column, line.length));
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match = null;
  while ((match = identifier.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (column >= start && column <= end) {
      return { name: match[0], path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: start };
    }
  }
  return null;
}

function goToSymbolUnderCursor() {
  const symbol = wordAtCursor();
  if (!symbol) return;
  const target = findSymbolDefinition(symbol.name);
  if (!target) return;
  openSourceAt(target.path, target.lineIndex, target.column);
}

function findSymbolDefinition(name) {
  const matchers = definitionMatchers(name);
  const currentPath = viewerCursor?.path || '';
  const orderedFiles = [
    ...sourceFiles.filter((file) => file.path === currentPath),
    ...sourceFiles.filter((file) => file.path !== currentPath),
  ].filter((file) => file.embedded);

  for (const file of orderedFiles) {
    const lines = file.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (matchers.some((matcher) => matcher.test(line))) {
        return { path: file.path, lineIndex, column: Math.max(0, line.indexOf(name)) };
      }
    }
  }
  return null;
}

function definitionMatchers(name) {
  const escaped = escapeRegExp(name);
  const mod = '(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|enum|annotation|static|export|default|expect|actual|value)\\s+)*';
  const funMod = '(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\\s+)*';
  return [
    new RegExp('^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + mod + '(?:class|interface|object|enum|trait|struct)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|val)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + '(?:fun|def|fn|func)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + escaped + '\\s*\\([^)]*\\)\\s*(?::\\s*[^=]+)?\\s*(?:\\{|=>)'),
    new RegExp('^\\s*' + escaped + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)'),
  ];
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function openSourceFile(path, shouldSwitch = true) {
  const file = sourceByPath.get(path);
  if (!file) return;
  rememberRecent(path, 'source');
  document.getElementById('source-viewer').dataset.openPath = path;
  sourceLinks.forEach((link) => link.classList.toggle('active', link.dataset.sourceFile === path));
  document.getElementById('source-title').textContent = path;
  const meta = [
    file.language || 'text',
    formatBytes(file.size || 0),
    file.changed ? 'changed' : 'unchanged',
    file.embedded ? 'searchable' : file.skippedReason || 'not embedded',
  ].join(' | ');
  document.getElementById('source-meta').textContent = meta;
  const body = document.getElementById('source-body');
  if (!file.embedded) {
    body.className = 'source-body empty';
    body.textContent = file.skippedReason ? 'Source preview unavailable: ' + file.skippedReason + '.' : 'Source preview unavailable.';
    if (shouldSwitch) showSourceView();
    return;
  }
  if (!viewerCursor || viewerCursor.path !== path) {
    viewerCursor = { path, lineIndex: 0, column: 0, targetLine: -1 };
  }
  body.className = 'source-body';
  body.innerHTML = renderSourceTable(file, searchInput?.value || '');
  if (shouldSwitch) showSourceView();
}

function renderSourceTable(file, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  const cursor = viewerCursor && viewerCursor.path === file.path ? viewerCursor : null;
  const rows = lines.map((line, index) => {
    const hit = normalizedQuery.length > 0 && line.toLowerCase().includes(normalizedQuery);
    const isCursorLine = Boolean(cursor && cursor.lineIndex === index);
    const isSymbolTarget = Boolean(cursor && cursor.targetLine === index);
    const classes = [
      'source-row',
      hit ? 'search-hit' : '',
      isCursorLine ? 'cursor-line' : '',
      isSymbolTarget ? 'symbol-target' : '',
    ].filter(Boolean).join(' ');
    return [
      '<tr class="' + classes + '" data-line-index="' + index + '">',
      '<td class="num">' + String(index + 1) + '</td>',
      '<td class="source-code">' + (isCursorLine ? renderLineWithCursor(line, file.language || 'text', cursor.column) : highlightLine(line, file.language || 'text')) + '</td>',
      '</tr>',
    ].join('');
  }).join('');
  return '<table class="source-table"><tbody>' + rows + '</tbody></table>';
}

function renderLineWithCursor(text, language, column) {
  const boundedColumn = Math.max(0, Math.min(column, text.length));
  const before = text.slice(0, boundedColumn);
  const after = text.slice(boundedColumn);
  return highlightLine(before, language) + '<span class="code-cursor" aria-hidden="true"></span>' + highlightLine(after, language);
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
    "Record durable validation decisions here so future checks do not depend on chat memory.",
    "",
  ].join("\n");
}

function agentSnippet(): string {
  return [
    "<!-- MONACORI:START -->",
    "## monacori Validation",
    "",
    "This repository uses monacori to verify AI-generated code changes.",
    "",
    "Before claiming completion on a code change:",
    "",
    "- Run `monacori check --include-untracked` or a more specific `monacori verify -- <command>`.",
    "- Use `monacori app --include-untracked` while changes are still moving.",
    "- Inspect changed hunks with F7 / Shift+F7.",
    "- Use Shift Shift in the diff review to search indexed files, including unchanged files.",
    "- In source previews, use Cmd/Ctrl+Down to jump to the declaration-like match under the cursor.",
    "- Report the verification commands, results, and remaining risks.",
    "",
    "Do not claim a change is done without verification evidence or a precise explanation of why verification could not run.",
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

function getVerificationCommands(config: FlowConfig): string[] {
  return config.verification.commands.filter((command) => command.trim().length > 0);
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

function readGitSnapshot(root: string): GitSnapshot {
  return {
    branch: git(root, ["branch", "--show-current"]),
    status: git(root, ["status", "--short"]),
    diffStat: git(root, ["diff", "--stat"]),
    recentCommits: git(root, ["log", "--oneline", "-5"]),
  };
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
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

function isLikelyBinary(path: string): boolean {
  const sample = readFileSync(path).subarray(0, 8000);
  return sample.includes(0);
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

function readStdin(): string {
  if (process.stdin.isTTY) {
    return "";
  }
  return readFileSync(0, "utf8");
}

function appendToState(content: string): void {
  const path = join(process.cwd(), FLOW_DIR, STATE_FILE);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
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

function codeBlock(content: string): string {
  return ["```", content, "```"].join("\n");
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function sanitizeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
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

function printHelp(): void {
  console.log(`monacori

Validation control plane for AI-generated code changes.

Usage:
  mo
  monacori open [--base HEAD] [--staged] [--tracked-only]
  monacori check [--include-untracked] [--open] [--no-verify] [--no-diff] [-- <command>]
  monacori init [--force]
  monacori install [--force] [--apply-agent-docs]
  monacori verify [-- <command>]
  monacori diff [--base HEAD] [--staged] [--include-untracked] [--open] [--watch]
  monacori app [--base HEAD] [--staged] [--include-untracked]
  monacori review [--base HEAD] [--staged] [--include-untracked]
  monacori status
  monacori report [--label manual] [--file report.md]

Default loop:
  1. Let an AI agent edit code.
  2. Run: mo
  3. Run: monacori check --include-untracked
  4. Only accept the change when verification evidence is clear.

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

function printCheckHelp(): void {
  console.log(`monacori check

Run configured verification and create a reviewable diff artifact.

Usage:
  monacori check [--include-untracked] [--staged] [--base HEAD] [--context 12] [--open] [--no-verify] [--no-diff] [-- <command>]

Examples:
  monacori check --include-untracked --open
  monacori check -- npm test
  monacori check --no-verify --include-untracked
`);
}

function printDiffHelp(): void {
  console.log(`monacori diff

Generate a browser-based side-by-side Git diff review.

Usage:
  monacori diff [--base HEAD] [--staged] [--include-untracked] [--context 12] [--output review.html] [--open] [--watch] [--port 0]

Keys in the review page:
  F7         next changed hunk
  Shift+F7  previous changed hunk
  ] / [     fallback hunk navigation
  Shift Shift search indexed files, including unchanged files
  Cmd/Ctrl+E recent files
  Cmd/Ctrl+Down jump to symbol under cursor

The sidebar groups changed files as a folder tree. Use Search to filter paths and indexed file contents.
The Files tab opens read-only source previews, including unchanged files when they fit the local review budget.
Viewed marks are tied to file signatures, so a changed file becomes unviewed again after reload.
Use --watch to serve a live review that reloads when the working tree changes.
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

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isDirectRun()) {
  main();
}
