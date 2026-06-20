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

type SourceFile = {
  path: string;
  name: string;
  language: string;
  content: string;
  size: number;
  changed: boolean;
  embedded: boolean;
  changedLines: number[];
  signature: string;
  skippedReason?: string;
};

export type HttpSendRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

export type HttpSendResult = {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  durationMs: number;
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
const SOURCE_MAX_TOTAL_BYTES = 50_000_000;
const SOURCE_MAX_FILES = 20000;
const nodeRequire = createRequire(import.meta.url);

const packageVersion: string = (() => {
  try {
    const pkg = nodeRequire("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
})();

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
  const httpEnvironments = collectHttpEnvironments(process.cwd());
  const hunks = files.reduce((sum, file) => sum + file.hunks.length, 0);
  const generatedAt = new Date().toISOString();
  const diffHtml = renderDiff2Html(diffText);
  const signature = createHash("sha1")
    .update(diffText)
    .update("\n")
    .update(sourceFiles.map((file) => `${file.path}\0${file.size}\0${file.embedded ? file.content : file.skippedReason ?? ""}`).join("\n"))
    .update("\n")
    .update(JSON.stringify(httpEnvironments))
    .digest("hex");
  const html = renderDiffHtml({
    files,
    diffHtml,
    sourceFiles,
    fileStates,
    httpEnvironments,
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

      if (requestUrl.pathname === "/__http_send" && request.method === "POST") {
        void handleHttpProxy(request, response);
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

// Performs an HTTP request on behalf of the sandboxed renderer. Used by both the
// Electron IPC handler (app-main.ts) and the browser-mode proxy below.
export async function performHttpRequest(request: HttpSendRequest): Promise<HttpSendResult> {
  const startedAt = Date.now();
  const method = (request.method || "GET").toUpperCase();
  try {
    const hasBody = typeof request.body === "string" && request.body.length > 0
      && method !== "GET" && method !== "HEAD";
    const response = await fetch(request.url, {
      method,
      headers: request.headers ?? {},
      body: hasBody ? request.body : undefined,
      redirect: "follow",
    });
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function handleHttpProxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HttpSendRequest;
    const result = await performHttpRequest(payload);
    writeHttpJson(response, result);
  } catch (error) {
    writeHttpJson(response, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: 0,
    });
  }
}

function renderDiffHtml(input: {
  files: DiffFile[];
  diffHtml: string;
  sourceFiles: SourceFile[];
  fileStates: ReviewFileState[];
  httpEnvironments: Record<string, Record<string, string>>;
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
    '<div class="breadcrumb" id="diff-breadcrumb"></div>',
    `<div class="review-status"><span>${input.files.length} files</span><span>${totalHunks} hunks</span><span>${embeddedFiles}/${input.sourceFiles.length} indexed</span><span class="live-status ${input.watch ? "watching" : ""}" id="live-status">${input.watch ? "watching" : escapeHtml(input.generatedAt ?? new Date().toISOString())}</span></div>`,
    `<div class="counter"><span id="file-counter" class="file-counter"></span><span id="hunk-counter">0</span> / ${totalHunks}</div>`,
    "</div>",
    `<div id="diff2html-container" class="diff2html-container">${input.diffHtml || '<div class="empty">No diff to review.</div>'}</div>`,
    "</section>",
    '<section id="source-viewer" class="source-viewer">',
    '<div class="toolbar source-toolbar">',
    '<div class="source-file-meta"><span id="source-title">Source</span><span id="source-meta">Select a file from the Files tab.</span></div>',
    '<select id="http-env-select" class="http-env-select hidden" title="HTTP Client environment" aria-label="HTTP environment"></select>',
    '<button type="button" id="source-viewed-toggle" class="plain-button source-viewed-toggle" aria-pressed="false" title="Mark this file as viewed" hidden>Viewed</button>',
    '<button type="button" id="back-to-diff" class="plain-button">Diff</button>',
    "</div>",
    '<div id="source-body" class="source-body empty">Select a file from the Files tab.</div>',
    "</section>",
    "</main>",
    '<div id="update-badge" class="update-badge hidden" title="npm install -g @happy-nut/monacori"></div>',
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
    `<script type="application/json" id="http-env-data">${jsonForScript(input.httpEnvironments)}</script>`,
    `<script>window.__MONACORI_VERSION__=${JSON.stringify(packageVersion)};</script>`,
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

  let hunkIndex = 0;
  const rows = files.map((file, fileIndex) => {
    const firstHunk = hunkIndex;
    hunkIndex += file.hunks.length;
    let adds = 0;
    let dels = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") adds += 1;
        else if (line.kind === "delete") dels += 1;
      }
    }
    const slash = file.displayPath.lastIndexOf("/");
    const name = slash >= 0 ? file.displayPath.slice(slash + 1) : file.displayPath;
    const dir = slash > 0 ? file.displayPath.slice(0, slash) : "";
    return [
      `<a class="file-link change-row" href="#file-${fileIndex}" data-hunk="${firstHunk}" data-file="${escapeAttr(file.displayPath)}">`,
      `<span class="status status-${escapeAttr(file.status)}">${escapeHtml(file.status)}</span>`,
      `<span class="change-name"><span class="path" title="${escapeAttr(file.displayPath)}">${escapeHtml(name)}</span>${dir ? `<span class="change-dir">${escapeHtml(dir)}</span>` : ""}</span>`,
      `<span class="diffstat">${adds ? `<span class="adds">+${adds}</span>` : ""}${dels ? `<span class="dels">−${dels}</span>` : ""}</span>`,
      "</a>",
    ].join("");
  });
  return `<nav class="tree changes-flat">${rows.join("")}</nav>`;
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
  const changedLinesByPath = new Map<string, number[]>();
  for (const file of diffFiles) {
    if (!file.displayPath || file.displayPath === "/dev/null") continue;
    const nums: number[] = [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add" && typeof line.newLine === "number") nums.push(line.newLine);
      }
    }
    changedLinesByPath.set(file.displayPath, nums);
  }
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
      changedLines: changedLinesByPath.get(path) || [],
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

// Reads IntelliJ-style HTTP Client environment files from the project root and
// merges them into { envName: { varName: value } }. The private file overrides
// the public one so secrets stay out of source control.
function collectHttpEnvironments(root: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const fileName of ["http-client.env.json", "http-client.private.env.json"]) {
    const filePath = join(root, fileName);
    if (!existsSync(filePath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [envName, rawVars] of Object.entries(parsed as Record<string, unknown>)) {
      if (!rawVars || typeof rawVars !== "object") continue;
      const target = result[envName] ?? (result[envName] = {});
      for (const [key, value] of Object.entries(rawVars as Record<string, unknown>)) {
        if (typeof value === "string") target[key] = value;
        else if (typeof value === "number" || typeof value === "boolean") target[key] = String(value);
      }
    }
  }
  return result;
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
.tabs { display: none; }
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
.update-badge {
  position: fixed;
  left: 12px;
  bottom: 10px;
  z-index: 60;
  font-size: 11px;
  line-height: 1;
  padding: 5px 11px;
  border-radius: 11px;
  background: var(--active);
  color: #fff;
  font-weight: 500;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.diff2html-container { min-width: 0; caret-color: transparent; }
.mc-diff-cursor-row .d2h-code-side-line { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--active) 70%, transparent); }
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
  /* left pad must exceed the 58px absolutely-positioned line-number, else the +/- prefix renders behind it and looks clipped */
  padding: 0 0.6em 0 64px;
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
.d2h-diff-table tr.diff-active-row td { background: rgba(74, 136, 199, 0.16) !important; }
.d2h-diff-table tr.diff-active-row td.d2h-code-side-linenumber { box-shadow: inset 2px 0 0 var(--active); }
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
.tree { display: grid; gap: 1px; font-size: 11.5px; font-family: Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.tree-dir { display: grid; gap: 1px; }
.tree-dir summary {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: center;
  gap: 4px;
  min-height: 18px;
  padding: 1px 5px 1px calc(7px + (var(--depth) * 14px));
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
.file-link.tree-file { padding-left: calc(8px + (var(--depth) * 14px)); }
.tree-focus { box-shadow: inset 0 0 0 1px var(--active); border-radius: 6px; }
summary.tree-focus { background: var(--bg); }
.file-link {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  min-height: 18px;
  padding: 1px 6px;
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
.change-name { display: flex; align-items: baseline; gap: 7px; min-width: 0; overflow: hidden; }
.change-dir { color: var(--muted); opacity: 0.5; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.diffstat { display: flex; gap: 6px; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.diffstat .adds { color: #6ab04c; }
.diffstat .dels { color: #cf6679; }
.file-link.viewed .status::after { content: '✓'; margin-left: 4px; color: #6ab04c; font-weight: 700; }
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
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  font: 13px Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.crumb { color: var(--muted); }
.crumb-leaf { color: var(--text); font-weight: 500; }
.crumb-sep { color: var(--muted); opacity: 0.55; }
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
.source-viewed-toggle.is-viewed { border-color: #6ab04c; color: #6ab04c; }
.source-viewed-toggle[hidden] { display: none; }
.source-viewed-toggle { caret-color: transparent; -webkit-user-select: none; user-select: none; }
.source-file-meta {
  display: flex;
  flex: 1;
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
/* perf: let the browser skip layout/paint for off-screen rows in large files/diffs.
   DOM is unchanged (nav, search, comment anchoring still query every row); degrades
   gracefully where unsupported. contain-intrinsic-size keeps the scrollbar stable. */
.source-row { content-visibility: auto; contain-intrinsic-size: auto 19px; }
.d2h-diff-table tr { content-visibility: auto; contain-intrinsic-size: auto 18px; }
.source-row.search-hit .source-code { background: color-mix(in srgb, var(--active) 14%, transparent); }
.source-row.changed-line .source-code { background: color-mix(in srgb, var(--active) 9%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--active) 55%, transparent); }
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
  margin: -1px -1px;
  background: #fff;
  vertical-align: text-bottom;
  pointer-events: none;
  animation: cursor-blink 1.06s step-end infinite;
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
/* Review comments (questions / change-requests) — per-file sidebar count badges (no emoji) */
.change-row, .source-link { grid-template-columns: auto minmax(0, 1fr) auto auto; }
.mc-file-badge { display: inline-flex; gap: 4px; align-items: center; }
.mc-fb { font-size: 10px; line-height: 1; padding: 1px 6px; border-radius: 999px; font-weight: 700; font-variant-numeric: tabular-nums; border: 1px solid transparent; }
.mc-fb-q { color: var(--token-number); background: color-mix(in srgb, var(--token-number) 16%, transparent); border-color: color-mix(in srgb, var(--token-number) 38%, transparent); }
.mc-fb-c { color: var(--token-tag); background: color-mix(in srgb, var(--token-tag) 16%, transparent); border-color: color-mix(in srgb, var(--token-tag) 38%, transparent); }
/* Lines kept highlighted while composing a comment on a drag selection */
.mc-sel-line .d2h-code-side-line { background: color-mix(in srgb, var(--active) 20%, transparent); }
.source-row.mc-sel-line .source-code { background: color-mix(in srgb, var(--active) 20%, transparent); }
/* A comment box "selected" while navigating with arrows (caret hidden; Backspace deletes it) */
.mc-comment-row.mc-row-selected .mc-card { box-shadow: 0 0 0 2px var(--active); }
.mc-comment-row td { padding: 0; background: var(--bg); }
.mc-thread-cell { padding: 4px 12px 8px 64px; }
.source-table .mc-thread-cell { padding: 4px 12px 8px 66px; }
.mc-card {
  border: 1px solid var(--border); border-left: 3px solid var(--muted);
  border-radius: 6px; background: var(--panel); margin: 6px 0; max-width: 760px;
  font: 12px/1.5 Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.mc-card.mc-q { border-left-color: var(--token-number); }
.mc-card.mc-c { border-left-color: var(--token-tag); }
.mc-card-head { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-bottom: 1px solid var(--border); color: var(--muted); }
.mc-kind { font-weight: 650; color: var(--text); }
.mc-del { margin-left: auto; background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 15px; line-height: 1; padding: 0 2px; }
.mc-del:hover { color: var(--del-strong); }
.mc-card-body { padding: 7px 10px; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; }
.mc-input {
  display: block; box-sizing: border-box; resize: vertical;
  margin: 8px 10px; width: calc(100% - 20px); min-height: 56px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px;
  font: 12px/1.5 Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.mc-input:focus { outline: none; border-color: var(--active); }
.mc-actions { display: flex; align-items: center; gap: 8px; padding: 0 10px 9px; }
.mc-btn { background: var(--active); color: #fff; border: 0; border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
.mc-btn:hover { filter: brightness(1.1); }
.mc-btn.mc-ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
.mc-hint { color: var(--muted); font-size: 11px; }
.mc-modal { position: fixed; inset: 0; z-index: 60; display: grid; place-items: start center; padding-top: min(10vh, 80px); background: color-mix(in srgb, #000 32%, transparent); }
.mc-modal.hidden { display: none; }
.mc-modal-panel { width: min(900px, calc(100vw - 40px)); height: 80vh; max-height: 80vh; display: grid; grid-template-rows: auto minmax(0, 1fr); border: 1px solid var(--border); border-radius: 10px; background: var(--panel); overflow: hidden; }
.mc-modal-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text); font-weight: 650; }
.mc-modal-head span { margin-right: auto; }
.mc-modal-text { width: 100%; height: 100%; box-sizing: border-box; resize: none; border: 0; padding: 12px; background: var(--bg); color: var(--text); font: 12px/1.55 Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.mc-modal-text:focus { outline: none; }
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
.http-env-select {
  margin-left: auto;
  background: var(--panel);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 12px;
}
.http-gutter { white-space: nowrap; }
.http-run {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  margin-right: 4px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: #59a869;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  vertical-align: middle;
}
.http-run:hover { background: color-mix(in srgb, #59a869 28%, transparent); color: #6cc17b; }
.http-request-line .source-code { font-weight: 600; }
.http-method { color: var(--token-keyword); font-weight: 700; }
.http-sep { color: var(--muted); }
.http-var { border-radius: 3px; padding: 0 1px; }
.http-var.known { color: var(--token-string); background: color-mix(in srgb, var(--token-string) 15%, transparent); }
.http-var.unknown { color: #e06c75; background: color-mix(in srgb, #e06c75 16%, transparent); text-decoration: underline dotted; }
.http-response-row td { padding: 0 14px 0 0; border: 0; background: transparent; }
.http-response {
  margin: 6px 0 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--active) 5%, var(--panel));
  overflow: hidden;
  font-size: 12px;
}
.http-response.loading { padding: 10px 12px; color: var(--muted); font-style: italic; }
.http-resp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--active) 8%, transparent);
}
.http-status { font-weight: 700; }
.http-status.ok { color: #59a869; }
.http-status.warn { color: #d9a343; }
.http-status.bad { color: #e06c75; }
.http-resp-meta { color: var(--muted); }
.http-resp-toggle {
  margin-left: auto;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}
.http-resp-toggle:hover { border-color: var(--active); color: var(--active); }
.http-resp-headers {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  display: grid;
  gap: 3px;
  max-height: 180px;
  overflow: auto;
}
.http-resp-headers.hidden { display: none; }
.http-h { display: flex; gap: 10px; }
.http-h-k { color: var(--token-keyword); min-width: 170px; flex-shrink: 0; }
.http-h-v { color: var(--fg); word-break: break-all; }
.http-resp-body {
  margin: 0;
  padding: 10px 12px;
  max-height: 460px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.55;
}
.http-resp-empty { color: var(--muted); font-style: italic; }
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
const httpEnvironments = JSON.parse(document.getElementById('http-env-data')?.textContent || '{}');
const httpEnvNames = Object.keys(httpEnvironments);
const httpEnvKey = 'monacori-http-env:' + location.pathname;
const httpRequestsByPath = new Map();
const httpVarsByPath = new Map();
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
let selectedCommentRow = null; // a comment box "selected" while navigating with arrows (caret hidden); Backspace deletes it
let currentHttpEnvName = (function () {
  let saved = '';
  try { saved = localStorage.getItem(httpEnvKey) || ''; } catch (error) { saved = ''; }
  if (saved && httpEnvNames.indexOf(saved) >= 0) return saved;
  return httpEnvNames.length ? httpEnvNames[0] : '';
})();
let treeFocusIndex = -1;
let selectionAnchor = null;
let diffCursor = null; // { path, side: 'old'|'new', rowIndex, column } — keyboard caret in the side-by-side diff
let diffSelectionAnchor = null; // { side, rowIndex, column } — Shift+Arrow drag-select origin in the diff
let measuredCharWidth = 0;

// Review-comment state — initialized here (early) so saved comments are loaded before
// restoreUiState()/openDefaultSourceFile() run on startup and try to render them.
var COMMENTS_KEY = 'monacori-comments:' + location.pathname;
var reviewComments = [];
try { reviewComments = JSON.parse(localStorage.getItem(COMMENTS_KEY) || '[]'); } catch (commentsErr) { reviewComments = []; }
if (!Array.isArray(reviewComments)) reviewComments = [];
var commentSeq = reviewComments.reduce(function (max, c) { return Math.max(max, c.seq || 0); }, 0);
var composerState = null;

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
  sourceLinks.forEach((link) => {
    link.classList.toggle('viewed', isFileViewed(link.dataset.sourceFile || ''));
  });
  refreshSourceViewedToggle();
}

function refreshSourceViewedToggle() {
  const toggle = document.getElementById('source-viewed-toggle');
  if (!toggle) return;
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  const known = Boolean(path && currentFileSignature(path));
  toggle.hidden = !known;
  const viewed = known && isFileViewed(path);
  toggle.classList.toggle('is-viewed', viewed);
  toggle.setAttribute('aria-pressed', viewed ? 'true' : 'false');
  toggle.textContent = viewed ? '✓ Viewed' : 'Viewed';
}

let activeDiffRow = null;
function firstCodeRowOfHunk(hunkRow) {
  let row = hunkRow.nextElementSibling;
  let firstRow = null;
  while (row && !row.classList.contains('hunk') && !row.classList.contains('hunk-peer')) {
    if (row.querySelector && row.querySelector('.d2h-code-side-line')) {
      if (!firstRow) firstRow = row;
      if (row.querySelector('.d2h-ins, .d2h-del, ins, del')) return row;
    }
    row = row.nextElementSibling;
  }
  return firstRow || hunkRow;
}

// First row in a hunk that is an actual change (add/del). The .hunk marker sits on the OLD side,
// and diff2html does NOT repeat the @@ text on the NEW side (so there is no .hunk-peer to scan).
// The two side tables ARE positionally aligned row-for-row, so walk the hunk by index and prefer
// the OPPOSITE side, where additions live — landing F7 on the added line, not the leading context.
function isChangeCodeRow(row) {
  return !!(row && isDiffCodeRow(row) && row.querySelector('.d2h-ins, .d2h-del, ins, del'));
}
function firstChangeRowForCaret(hunkRow) {
  const wrapper = hunkRow.closest('.d2h-file-wrapper');
  const sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  const hunkSideEl = hunkRow.closest('.d2h-file-side-diff');
  if (sides.length >= 2 && hunkSideEl) {
    const hunkRows = Array.from(hunkSideEl.querySelectorAll('tr'));
    const otherEl = hunkSideEl === sides[0] ? sides[1] : sides[0];
    const otherRows = Array.from(otherEl.querySelectorAll('tr'));
    for (let i = hunkRows.indexOf(hunkRow) + 1; i < hunkRows.length; i++) {
      const hr = hunkRows[i];
      if (hr.classList.contains('hunk') || hr.classList.contains('hunk-peer')) break;
      if (isChangeCodeRow(otherRows[i])) return otherRows[i];
      if (isChangeCodeRow(hr)) return hr;
    }
  }
  return firstCodeRowOfHunk(hunkRow);
}
function focusDiffRow(row) {
  if (activeDiffRow) activeDiffRow.classList.remove('diff-active-row');
  activeDiffRow = row || null;
  if (!row) return;
  row.classList.add('diff-active-row');
  // move the diff caret to follow hunk navigation (F7 / Shift+F7 / [ / ])
  const navInfo = diffRowInfoFromNode(row);
  if (navInfo && navInfo.path) {
    let navSide = navInfo.side;
    if (navSide === 'old') { // prefer the new (modified) side when it has a real line at this row
      const navWrap = diffWrapperByPath(navInfo.path);
      if (isDiffCodeRow(navWrap ? diffRowAt(navWrap, 'new', navInfo.rowIndex) : null)) navSide = 'new';
    }
    setDiffCursor(navInfo.path, navSide, navInfo.rowIndex, 0, false);
  }
}

function renderBreadcrumb(container, path) {
  if (!container) return;
  container.textContent = '';
  const parts = (path || '').split('/').filter(Boolean);
  parts.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      container.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = i === parts.length - 1 ? 'crumb crumb-leaf' : 'crumb';
    span.textContent = seg;
    container.appendChild(span);
  });
}

function setActive(index, shouldScroll = true) {
  if (hunks.length === 0) return;
  current = ((index % hunks.length) + hunks.length) % hunks.length;
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  setTab('changes');
  const active = hunks[current];
  const file = active.dataset.file;
  showOnlyFile(file);
  hunks.forEach((hunk, i) => hunk.classList.toggle('active', i === current));
  hunkPeers.forEach((hunk) => hunk.classList.toggle('active', Number(hunk.dataset.hunkIndex) === current));
  links.forEach((link) => link.classList.toggle('active', link.dataset.file === file));
  renderBreadcrumb(document.getElementById('diff-breadcrumb'), file);
  document.getElementById('hunk-counter').textContent = String(current + 1);
  const targetRow = firstChangeRowForCaret(active);
  focusDiffRow(targetRow);
  if (shouldScroll) targetRow.scrollIntoView({ block: 'center' });
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
  ensureDiffCursor();
}

function next(delta) {
  if (hunks.length === 0) return;
  let idx = current < 0 ? initialHunkForNavigation(delta) : current + delta;
  for (let step = 0; step < hunks.length; step++) {
    const norm = ((idx % hunks.length) + hunks.length) % hunks.length;
    if (!isFileViewed(hunks[norm].dataset.file || '')) { setActive(norm); return; }
    idx += delta;
  }
  setActive((((current < 0 ? 0 : current + delta) % hunks.length) + hunks.length) % hunks.length);
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
  quickModeLabel.textContent = mode === 'recent' ? 'Recent files' : mode === 'content' ? 'Find in Files' : 'Search files';
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
      if (quickMode === 'content') {
        const file = sourceByPath.get(item.path);
        return Boolean(file && file.embedded && file.content.toLowerCase().includes(query));
      }
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
  if (sourceByPath.has(item.path)) {
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

// Focus the tree row for the currently open file (source openPath, else the active diff file);
// falls back to the first row when nothing is open or no matching row exists.
function focusOpenFileInTree() {
  const rows = treeRows();
  if (rows.length === 0) return;
  let openPath = document.getElementById('source-viewer')?.dataset.openPath || '';
  if (!openPath && typeof diffActiveWrapper === 'function') {
    const w = diffActiveWrapper();
    const n = w && w.querySelector('.d2h-file-name');
    if (n && n.textContent) openPath = n.textContent.trim();
  }
  let idx = 0;
  if (openPath) {
    for (let i = 0; i < rows.length; i++) {
      const ds = rows[i].dataset || {};
      if (ds.sourceFile === openPath || ds.file === openPath) { idx = i; break; }
    }
  }
  focusTree(idx);
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
    if (row && row.classList.contains('file-link')) { row.click(); clearTreeFocus(); }
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
    setTab('files');
    focusOpenFileInTree();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === '0') {
    event.preventDefault();
    setTab('changes');
    focusOpenFileInTree();
    return;
  }

  // Tab / Shift+Tab move the "cursor" horizontally between the left sidebar and the right content pane.
  if (event.key === 'Tab') {
    const activeEl = document.activeElement;
    const inField = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
    if (!inField) {
      event.preventDefault();
      if (event.shiftKey) {
        // In the diff view, Shift+Tab toggles the caret between the old/new panes (this change owns
        // Shift+Tab L/R; plain arrows stay in-pane and Cmd/Ctrl+Arrows also cross — see diff nav).
        if (isDiffViewVisible() && diffCursor) {
          const tabSide = diffCursor.side === 'new' ? 'old' : 'new';
          const tabWrap = diffWrapperByPath(diffCursor.path);
          const tabRow = tabWrap ? diffRowAt(tabWrap, tabSide, diffCursor.rowIndex) : null;
          if (isDiffCodeRow(tabRow)) setDiffCursor(diffCursor.path, tabSide, diffCursor.rowIndex, 0, true);
          return;
        }
        focusTree(treeFocusIndex >= 0 ? treeFocusIndex : 0); // ← left: focus sidebar tree
      } else {
        clearTreeFocus(); // → right: hand focus back to the content pane (source caret / diff nav)
        const openPath = document.getElementById('source-viewer')?.dataset.openPath || '';
        if (isSourceViewerVisible() && openPath && (!viewerCursor || viewerCursor.path !== openPath)) {
          setSourceCursor(openPath, viewerCursor ? viewerCursor.lineIndex : 0, 0, false, -1);
        }
      }
      return;
    }
  }

  // Merged comment views — see every saved comment of one kind at once + copy-all to paste into a prompt:
  //   Cmd/Ctrl+Shift+/ ("?") = all questions, Cmd/Ctrl+Shift+. (">") = all change-requests.
  // Match the PHYSICAL key (event.code) so macOS/IME/layout never swallows the combo; fires in any focus.
  if ((event.metaKey || event.ctrlKey) && (event.code === 'Slash' || event.code === 'Period' || event.key === '?' || event.key === '>')) {
    event.preventDefault();
    openMergedView((event.code === 'Slash' || event.key === '?') ? 'q' : 'c');
    return;
  }
  // "?" = question, ">" = change-request composer on the current line/selection (no modifier).
  if (!event.altKey && !event.metaKey && !event.ctrlKey && (event.key === '?' || event.key === '>')) {
    const ce = document.activeElement;
    const inEditable = ce && (ce.tagName === 'INPUT' || ce.tagName === 'TEXTAREA' || ce.tagName === 'SELECT');
    if (!inEditable) {
      event.preventDefault();
      openComposer(event.key === '?' ? 'q' : 'c');
      return;
    }
  }

  // "<" (Shift+,) toggles "viewed" for the current file (source openPath, else active diff file).
  if (!event.altKey && !event.metaKey && !event.ctrlKey && event.key === '<') {
    const ce2 = document.activeElement;
    const inEditable2 = ce2 && (ce2.tagName === 'INPUT' || ce2.tagName === 'TEXTAREA' || ce2.tagName === 'SELECT');
    if (!inEditable2) {
      let vp = isSourceViewerVisible() ? (document.getElementById('source-viewer')?.dataset.openPath || '') : '';
      if (!vp && typeof diffActiveWrapper === 'function') {
        const vw = diffActiveWrapper();
        const vn = vw && vw.querySelector('.d2h-file-name');
        if (vn && vn.textContent) vp = vn.textContent.trim();
      }
      if (vp && currentFileSignature(vp)) {
        event.preventDefault();
        setFileViewed(vp, !isFileViewed(vp));
        return;
      }
    }
  }

  // Opt/Alt + Left/Right: word-wise caret jump (source or diff view).
  if (event.altKey && !event.metaKey && !event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    var wae = document.activeElement;
    var wInField = wae && (wae.tagName === 'INPUT' || wae.tagName === 'TEXTAREA' || wae.tagName === 'SELECT');
    if (!wInField && treeFocusIndex < 0) {
      var wdir = event.key === 'ArrowRight' ? 1 : -1;
      if (isSourceViewerVisible() && viewerCursor) { event.preventDefault(); moveSourceWord(wdir, event.shiftKey); return; }
      if (isDiffViewVisible() && diffCursor) { event.preventDefault(); moveDiffWord(wdir, event.shiftKey); return; }
    }
  }

  if (treeFocusIndex >= 0 && handleTreeKey(event)) return;
  if (treeFocusIndex < 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isSourceViewerVisible() && handleSourceCaretKey(event)) return;
  if (treeFocusIndex < 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isDiffViewVisible() && handleDiffCaretKey(event)) return;

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

  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openQuickOpen('content');
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    openQuickOpen('recent');
    return;
  }

  if ((event.metaKey || event.altKey) && event.key === 'Enter' && isSourceViewerVisible()) {
    const enterPath = document.getElementById('source-viewer')?.dataset.openPath || '';
    if (isHttpFile(enterPath)) {
      event.preventDefault();
      runHttpAtCaret();
      return;
    }
  }

  if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowDown') {
    event.preventDefault();
    if (isSourceViewerVisible()) goToSymbolUnderCursor();
    else openDiffFileAtCaret();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isSourceViewerVisible() && viewerCursor) {
    event.preventDefault();
    const lineEdgeFile = sourceByPath.get(viewerCursor.path);
    if (lineEdgeFile && lineEdgeFile.embedded) {
      const lineEdgeLines = lineEdgeFile.content.split(/\r?\n/);
      const lineEdgeCol = event.key === 'ArrowLeft' ? 0 : (lineEdgeLines[viewerCursor.lineIndex] || '').length;
      if (event.shiftKey) { if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column }; }
      else selectionAnchor = null;
      setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, lineEdgeCol, true, -1);
      applySourceSelection();
    }
    return;
  }

  // Diff view: Cmd/Ctrl + Left/Right goes to the line start / end; pressing it again AT the
  // edge crosses to the adjacent pane (Left -> old, Right -> new). Plain arrows never cross.
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isDiffViewVisible() && diffCursor) {
    event.preventDefault();
    const edgeWrap = diffWrapperByPath(diffCursor.path);
    const edgeRow = edgeWrap ? diffRowAt(edgeWrap, diffCursor.side, diffCursor.rowIndex) : null;
    const edgeLen = edgeRow ? diffLineText(edgeRow).length : 0;
    if (event.key === 'ArrowLeft') {
      if (diffCursor.column > 0) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, 0, true); // -> line start
      } else if (diffCursor.side === 'new') { // already at start -> cross to old (left)
        const oldRow = edgeWrap ? diffRowAt(edgeWrap, 'old', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(oldRow)) setDiffCursor(diffCursor.path, 'old', diffCursor.rowIndex, diffLineText(oldRow).length, true);
      }
    } else { // ArrowRight
      if (diffCursor.column < edgeLen) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, edgeLen, true); // -> line end
      } else if (diffCursor.side === 'old') { // already at end -> cross to new (right)
        const newRow = edgeWrap ? diffRowAt(edgeWrap, 'new', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(newRow)) setDiffCursor(diffCursor.path, 'new', diffCursor.rowIndex, 0, true);
      }
    }
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
document.getElementById('source-viewed-toggle')?.addEventListener('click', () => {
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  if (path) setFileViewed(path, !isFileViewed(path));
});
document.getElementById('source-body')?.addEventListener('click', handleSourceClick);
document.addEventListener('copy', handleSourceCopy);

searchInput?.addEventListener('input', () => {
  filterNavigation(searchInput.value);
  const openPath = document.getElementById('source-viewer')?.dataset.openPath;
  if (openPath) openSourceFile(openPath, false);
});

populateHttpEnvSelect();
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
  // No contenteditable: the diff caret is the JS diffCursor. A native contenteditable caret
  // would render a second blinking cursor alongside it. Text selection (for comment capture)
  // still works on non-editable content.
  container.setAttribute('aria-readonly', 'true');
  container.querySelectorAll('.d2h-code-side-linenumber, .d2h-code-linenumber, .d2h-code-line-prefix').forEach((el) => el.setAttribute('contenteditable', 'false'));
  const inComment = (event) => Boolean(event.target && event.target.closest && event.target.closest('.mc-comment-row'));
  const block = (event) => { if (inComment(event)) return; event.preventDefault(); };
  container.addEventListener('focusin', (event) => { if (!inComment(event)) clearTreeFocus(); });
  container.addEventListener('mousedown', (event) => { if (!inComment(event)) clearTreeFocus(); });
  container.addEventListener('beforeinput', block);
  container.addEventListener('paste', block);
  container.addEventListener('drop', block);
  container.addEventListener('dragstart', block);
  container.addEventListener('keydown', (event) => {
    if (inComment(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Tab') {
      event.preventDefault();
    }
  });
  container.addEventListener('click', (event) => {
    if (inComment(event)) return;
    const info = diffRowInfoFromNode(event.target);
    if (info && info.path) setDiffCursor(info.path, info.side, info.rowIndex, 0, false);
  });
  ensureDiffCursor();
})();

// ===== Side-by-side diff caret (keyboard navigation across the old/new panes) =====
function isDiffViewVisible() {
  var d = document.getElementById('diff-view');
  return Boolean(d && !d.classList.contains('hidden'));
}
function diffActiveWrapper() {
  return document.querySelector('#diff2html-container .d2h-file-wrapper:not(.df-inactive)')
    || document.querySelector('#diff2html-container .d2h-file-wrapper');
}
function diffWrapperByPath(path) {
  var ws = document.querySelectorAll('#diff2html-container .d2h-file-wrapper');
  for (var i = 0; i < ws.length; i++) {
    var n = ws[i].querySelector('.d2h-file-name');
    if (n && (n.textContent || '').trim() === path) return ws[i];
  }
  return null;
}
function diffSideTables(wrapper) {
  var sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  return { left: sides[0] || null, right: sides[sides.length - 1] || null };
}
function diffSideTable(wrapper, side) {
  var t = diffSideTables(wrapper);
  return side === 'old' ? t.left : t.right;
}
function diffRowsOf(sideTable) {
  if (!sideTable) return [];
  return Array.prototype.slice.call(sideTable.querySelectorAll('tr')).filter(function (r) {
    return !r.classList.contains('mc-comment-row') && !r.classList.contains('mc-spacer-row');
  });
}
function diffRowAt(wrapper, side, rowIndex) {
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  return rows[rowIndex] || null;
}
function diffCellCtn(row) {
  return row ? row.querySelector('.d2h-code-line-ctn') : null;
}
function diffLineText(row) {
  var ctn = diffCellCtn(row);
  return ctn ? (ctn.textContent || '') : '';
}
function diffLineNumber(row) {
  var n = row ? row.querySelector('.d2h-code-side-linenumber') : null;
  var v = n ? parseInt((n.textContent || '').trim(), 10) : NaN;
  return isFinite(v) ? v : null;
}
function diffRowInfoFromNode(node) {
  var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  if (!el || !el.closest) return null;
  var wrapper = el.closest('.d2h-file-wrapper');
  var sideEl = el.closest('.d2h-file-side-diff');
  var row = el.closest('tr');
  if (!wrapper || !sideEl || !row) return null;
  var nameEl = wrapper.querySelector('.d2h-file-name');
  var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
  var t = diffSideTables(wrapper);
  var side = sideEl === t.left ? 'old' : 'new';
  if (!isDiffCodeRow(row)) return null;
  var rowIndex = diffRowsOf(sideEl).indexOf(row);
  if (!path || rowIndex < 0) return null;
  return { path: path, side: side, rowIndex: rowIndex };
}
function diffCaretDomPosition(ctn, column) {
  if (!ctn) return null;
  var remaining = column;
  var walker = document.createTreeWalker(ctn, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode())) {
    var len = node.textContent.length;
    if (remaining <= len) return { node: node, offset: remaining };
    remaining -= len;
  }
  return { node: ctn, offset: ctn.childNodes.length };
}
var diffCaretSpan = null;
function clearDiffCaret() {
  var container = document.getElementById('diff2html-container');
  if (container) {
    container.querySelectorAll('.mc-diff-cursor-row').forEach(function (r) { r.classList.remove('mc-diff-cursor-row'); });
    // remove ALL caret spans (not just the tracked one) so a stray indicator never lingers
    container.querySelectorAll('.code-cursor').forEach(function (s) { var p = s.parentNode; if (p) { p.removeChild(s); if (p.normalize) p.normalize(); } });
  }
  diffCaretSpan = null;
}
function renderDiffCaret() {
  clearDiffCaret();
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  if (!row) return;
  row.classList.add('mc-diff-cursor-row');
  var ctn = diffCellCtn(row);
  if (!ctn) return;
  // Empty line (ctn is just a <br>): the row highlight marks the caret. Inserting a caret span
  // next to the <br> would push it onto a second visual line and break the row's height.
  if ((ctn.textContent || '').length === 0) return;
  var pos = diffCaretDomPosition(ctn, diffCursor.column);
  if (!pos) return;
  var span = document.createElement('span');
  span.className = 'code-cursor';
  span.setAttribute('aria-hidden', 'true');
  try {
    var off = pos.node.nodeType === 3 ? Math.min(pos.offset, (pos.node.textContent || '').length) : pos.offset;
    var range = document.createRange();
    range.setStart(pos.node, off);
    range.collapse(true);
    range.insertNode(span);
    diffCaretSpan = span;
  } catch (e) { diffCaretSpan = null; }
}
function setDiffCursor(path, side, rowIndex, column, reveal) {
  var wrapper = diffWrapperByPath(path);
  if (!wrapper) return;
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  if (!rows.length) return;
  var ri = Math.max(0, Math.min(rowIndex, rows.length - 1));
  var col = Math.max(0, Math.min(column, diffLineText(rows[ri]).length));
  diffCursor = { path: path, side: side, rowIndex: ri, column: col };
  diffSelectionAnchor = null; // any direct caret placement (click/F7/Cmd-arrow) drops the selection; Shift+Arrow re-sets it
  renderDiffCaret();
  applyDiffSelection();
  if (reveal) {
    var r = diffRowAt(wrapper, side, ri);
    if (r && r.scrollIntoView) requestAnimationFrame(function () { try { r.scrollIntoView({ block: 'nearest' }); } catch (e) {} });
  }
}
function applyDiffSelection() {
  var sel = window.getSelection();
  if (!sel) return;
  // Selection only makes sense within one pane and one file; otherwise clear it.
  if (!diffSelectionAnchor || !diffCursor || diffSelectionAnchor.side !== diffCursor.side) { try { sel.removeAllRanges(); } catch (e) {} return; }
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) { try { sel.removeAllRanges(); } catch (e) {} return; }
  var aCtn = diffCellCtn(diffRowAt(wrapper, diffSelectionAnchor.side, diffSelectionAnchor.rowIndex));
  var cCtn = diffCellCtn(diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex));
  var a = aCtn ? diffCaretDomPosition(aCtn, diffSelectionAnchor.column) : null;
  var c = cCtn ? diffCaretDomPosition(cCtn, diffCursor.column) : null;
  if (a && c) { try { sel.setBaseAndExtent(a.node, a.offset, c.node, c.offset); } catch (e) {} }
}
function isDiffCodeRow(row) {
  if (!row) return false;
  if (row.querySelector('.d2h-emptyplaceholder, .d2h-code-side-emptyplaceholder')) return false; // added/removed counterpart — no real line
  if (!row.querySelector('.d2h-code-line-ctn')) return false;
  var num = row.querySelector('.d2h-code-side-linenumber');
  return !!num && (num.textContent || '').trim().length > 0; // real code line has a line number (excludes hunk-info rows)
}
function firstDiffCodeRow(wrapper, side) {
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  for (var i = 0; i < rows.length; i++) { if (isDiffCodeRow(rows[i])) return i; }
  return -1;
}
function ensureDiffCursor() {
  if (!isDiffViewVisible()) return;
  var wrapper = diffActiveWrapper();
  if (!wrapper) return;
  var nameEl = wrapper.querySelector('.d2h-file-name');
  var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
  if (!path) return;
  if (diffCursor && diffCursor.path === path) { renderDiffCaret(); return; }
  var ri = firstDiffCodeRow(wrapper, 'new');
  if (ri < 0) return;
  setDiffCursor(path, 'new', ri, 0, false);
}
function moveDiffCursor(dLine, dColumn, extend) {
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var side = diffCursor.side;
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  var ri = diffCursor.rowIndex;
  var col = diffCursor.column;
  var text = diffLineText(rows[ri]);
  // Shift extends a text selection from where the caret sat before the first shifted move.
  var anchor = extend ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column }) : null;
  // Plain arrows stay within the current pane (no auto pane-crossing — that is Cmd+Left/Right).
  if (dColumn < 0) {
    if (col > 0) { col -= 1; }
    else { // at line start: end of previous code line in the SAME pane
      var p = ri - 1; while (p >= 0 && !isDiffCodeRow(rows[p])) p -= 1;
      if (p >= 0) { ri = p; col = diffLineText(rows[p]).length; }
    }
  } else if (dColumn > 0) {
    if (col < text.length) { col += 1; }
    else { // at line end: start of next code line in the SAME pane
      var nx = ri + 1; while (nx < rows.length && !isDiffCodeRow(rows[nx])) nx += 1;
      if (nx < rows.length) { ri = nx; col = 0; }
    }
  }
  if (dLine !== 0) {
    var rows2 = diffRowsOf(diffSideTable(wrapper, side));
    var step = dLine > 0 ? 1 : -1;
    var cand = ri + step;
    while (cand >= 0 && cand < rows2.length && !isDiffCodeRow(rows2[cand])) cand += step;
    if (cand >= 0 && cand < rows2.length) { ri = cand; col = Math.min(col, diffLineText(rows2[ri]).length); }
  }
  setDiffCursor(diffCursor.path, side, ri, col, true); // clears diffSelectionAnchor + native selection
  if (anchor) { diffSelectionAnchor = anchor; applyDiffSelection(); } // re-establish the Shift selection
}
function moveDiffWord(dir, extend) {
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  var text = diffLineText(row);
  var ncol = nextWordBoundary(text, diffCursor.column, dir);
  if (ncol === diffCursor.column) return; // already at the line edge — plain arrows change lines
  var anchor = extend ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column }) : null;
  setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, ncol, true);
  if (anchor) { diffSelectionAnchor = anchor; applyDiffSelection(); }
}
function handleDiffCaretKey(event) {
  if (!isDiffViewVisible() || !diffCursor) return false;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return false;
  var extend = event.shiftKey;
  if (event.key === 'ArrowDown') { event.preventDefault(); moveDiffCursor(1, 0, extend); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveDiffCursor(-1, 0, extend); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveDiffCursor(0, -1, extend); return true; }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveDiffCursor(0, 1, extend); return true; }
  return false;
}

// ===== Review comments: questions ("?") and change-requests (">") =====
// (COMMENTS_KEY / reviewComments / commentSeq / composerState are declared near the top of the script)
function saveComments() {
  try { localStorage.setItem(COMMENTS_KEY, JSON.stringify(reviewComments)); } catch (e) {}
}
function commentsAt(path, line) {
  return reviewComments.filter(function (c) { return c.path === path && c.line === line; });
}
function commentKindLabel(kind) {
  return kind === 'q' ? '❓ Question' : '✎ Change request';
}
function relevantLines(path) {
  var set = {};
  reviewComments.forEach(function (c) { if (c.path === path) set[c.line] = true; });
  if (composerState && composerState.path === path) set[composerState.line] = true;
  return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
}
function addComment(kind, path, line, code, text) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return;
  commentSeq += 1;
  reviewComments.push({ seq: commentSeq, kind: kind, path: path, line: line, code: String(code || ''), text: trimmed });
  saveComments();
}
function deleteComment(seq) {
  reviewComments = reviewComments.filter(function (c) { return c.seq !== seq; });
  saveComments();
  refreshComments();
}

function sourceRowLineOf(node) {
  var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  var row = el && el.closest ? el.closest('.source-row') : null;
  if (!row) return null;
  var v = parseInt(row.dataset.lineIndex, 10);
  return isFinite(v) ? v : null;
}
function currentCommentTarget() {
  var sel = window.getSelection();
  var selText = (sel && sel.toString) ? sel.toString() : '';
  var hasSel = !!sel && !sel.isCollapsed && selText.trim().length > 0;
  // Source view: anchor BELOW the selection (its last line) so the box sits under the drag.
  // Derive the span from the actual DOM range so MOUSE drags work (they don't move the JS caret).
  if (isSourceViewerVisible() && viewerCursor) {
    if (hasSel) {
      var srng = sel.rangeCount ? sel.getRangeAt(0) : null;
      var sa = srng ? sourceRowLineOf(srng.startContainer) : null;
      var sb = srng ? sourceRowLineOf(srng.endContainer) : null;
      if (sa == null || sb == null) { sa = selectionAnchor ? selectionAnchor.lineIndex : viewerCursor.lineIndex; sb = viewerCursor.lineIndex; }
      var f = Math.min(sa, sb), t = Math.max(sa, sb);
      return { path: viewerCursor.path, line: t + 1, code: selText, from: f + 1, to: t + 1, side: null };
    }
    return { path: viewerCursor.path, line: viewerCursor.lineIndex + 1, code: '', from: null, to: null, side: null };
  }
  // Diff view: prefer the explicit diff caret when there is no text selection.
  if (!hasSel && diffCursor && isDiffViewVisible()) {
    var dwrap = diffWrapperByPath(diffCursor.path);
    var drow = dwrap ? diffRowAt(dwrap, diffCursor.side, diffCursor.rowIndex) : null;
    var dline = drow ? diffLineNumber(drow) : null;
    if (dline != null) return { path: diffCursor.path, line: dline, code: '', from: null, to: null, side: null };
  }
  // Diff view with a selection (or click): anchor at the LAST line so the composer drops BELOW the
  // drag; capture the selected code + line span (used to keep the drag highlighted via .mc-sel-line).
  var rng = (sel && sel.rangeCount) ? sel.getRangeAt(0) : null;
  var fromNode = rng ? rng.startContainer : (sel ? sel.anchorNode : null);
  var toNode = rng ? rng.endContainer : (sel ? sel.anchorNode : null);
  var fromEl = fromNode ? (fromNode.nodeType === 1 ? fromNode : fromNode.parentElement) : null;
  var toEl = toNode ? (toNode.nodeType === 1 ? toNode : toNode.parentElement) : null;
  var wrapper = (toEl && toEl.closest && toEl.closest('.d2h-file-wrapper')) || document.querySelector('#diff2html-container .d2h-file-wrapper:not(.df-inactive)');
  if (!wrapper) return null;
  var nameEl = wrapper.querySelector('.d2h-file-name');
  var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
  if (!path) return null;
  var toRow = toEl && toEl.closest ? toEl.closest('tr') : null;
  if (!toRow || !toRow.querySelector('.d2h-code-side-linenumber')) {
    var sides0 = wrapper.querySelectorAll('.d2h-file-side-diff');
    var right0 = sides0[sides0.length - 1];
    var firstNum = right0 ? right0.querySelector('.d2h-code-side-linenumber') : null;
    toRow = firstNum ? firstNum.closest('tr') : null;
  }
  if (!toRow) return null;
  var toLine = diffLineNumber(toRow);
  if (toLine == null) return null;
  var fromRow = (hasSel && fromEl && fromEl.closest) ? fromEl.closest('tr') : null;
  var fromLine = fromRow ? diffLineNumber(fromRow) : null;
  if (fromLine == null) fromLine = toLine;
  var sideEl = toEl && toEl.closest ? toEl.closest('.d2h-file-side-diff') : null;
  var st = diffSideTables(wrapper);
  var side = (sideEl && sideEl === st.left) ? 'old' : 'new';
  return { path: path, line: toLine, code: hasSel ? selText : '', from: hasSel ? Math.min(fromLine, toLine) : null, to: hasSel ? Math.max(fromLine, toLine) : null, side: side };
}

function threadHtml(path, line) {
  var html = '';
  commentsAt(path, line).forEach(function (c) {
    html += '<div class="mc-card mc-' + c.kind + '">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindLabel(c.kind) + '</span>'
      + '<button type="button" class="mc-del" data-seq="' + c.seq + '" title="Delete">×</button></div>'
      + '<div class="mc-card-body">' + escapeHtml(c.text) + '</div></div>';
  });
  if (composerState && composerState.path === path && composerState.line === line) {
    var ph = composerState.kind === 'q' ? 'Ask a question about this line' : 'Request a change for this line';
    html += '<div class="mc-card mc-' + composerState.kind + ' mc-composer">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindLabel(composerState.kind) + '</span></div>'
      + '<textarea class="mc-input" rows="3" placeholder="' + ph + '"></textarea>'
      + '<div class="mc-actions"><button type="button" class="mc-btn mc-save">Comment</button>'
      + '<button type="button" class="mc-btn mc-ghost mc-cancel">Cancel</button>'
      + '<span class="mc-hint">Cmd/Ctrl+Enter to save, Esc to cancel</span></div></div>';
  }
  return html;
}

function injectThreadRow(anchorRow, path, line) {
  if (!anchorRow || !anchorRow.parentNode) return;
  var tr = document.createElement('tr');
  tr.className = 'mc-comment-row';
  var td = document.createElement('td');
  td.colSpan = 2;
  td.className = 'mc-thread-cell';
  td.innerHTML = threadHtml(path, line);
  tr.appendChild(td);
  anchorRow.parentNode.insertBefore(tr, anchorRow.nextSibling);
}

function renderDiffComments() {
  var container = document.getElementById('diff2html-container');
  if (!container) return;
  container.querySelectorAll('.mc-comment-row').forEach(function (r) { r.remove(); });
  container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
    var nameEl = w.querySelector('.d2h-file-name');
    var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
    if (!path) return;
    var lines = relevantLines(path);
    if (!lines.length) return;
    var sides = w.querySelectorAll('.d2h-file-side-diff');
    var right = sides[sides.length - 1];
    if (!right) return;
    var rows = right.querySelectorAll('tr');
    lines.forEach(function (line) {
      for (var i = 0; i < rows.length; i++) {
        var num = rows[i].querySelector('.d2h-code-side-linenumber');
        if (num && (num.textContent || '').trim() === String(line)) { injectThreadRow(rows[i], path, line); break; }
      }
    });
  });
}

function renderSourceComments() {
  var body = document.getElementById('source-body');
  if (!body) return;
  body.querySelectorAll('.mc-comment-row').forEach(function (r) { r.remove(); });
  var viewer = document.getElementById('source-viewer');
  var path = viewer ? (viewer.dataset.openPath || '') : '';
  if (!path) return;
  relevantLines(path).forEach(function (line) {
    var anchor = body.querySelector('.source-row[data-line-index="' + (line - 1) + '"]');
    if (anchor) injectThreadRow(anchor, path, line);
  });
}

// Per-file comment counts as small (no-emoji) badges in BOTH sidebars — the Changes list
// (.change-row, before the diffstat) and the Files tree (.source-link, after the file name).
function renderCommentBadges() {
  document.querySelectorAll('.mc-file-badge').forEach(function (b) { b.remove(); });
  var counts = {};
  reviewComments.forEach(function (x) {
    var k = counts[x.path] || (counts[x.path] = { q: 0, c: 0 });
    if (x.kind === 'q') k.q += 1; else k.c += 1;
  });
  function makeBadge(k) {
    var badge = document.createElement('span');
    badge.className = 'mc-file-badge';
    var html = '';
    if (k.q) html += '<span class="mc-fb mc-fb-q" title="' + k.q + ' question(s)">' + k.q + '</span>';
    if (k.c) html += '<span class="mc-fb mc-fb-c" title="' + k.c + ' change request(s)">' + k.c + '</span>';
    badge.innerHTML = html;
    return badge;
  }
  function inject(selector, keyAttr, refSelector) {
    document.querySelectorAll(selector).forEach(function (row) {
      var k = counts[row.dataset[keyAttr] || ''];
      if (!k) return;
      var ref = row.querySelector(refSelector);
      if (ref) row.insertBefore(makeBadge(k), ref); else row.appendChild(makeBadge(k));
    });
  }
  inject('.change-row', 'file', '.diffstat');
  inject('.source-link', 'sourceFile', '.count');
}

// While composing on a drag selection, keep those lines highlighted (.mc-sel-line) so the user
// sees what they are commenting on even though the native selection was cleared.
function applyCommentSelectionHighlight() {
  document.querySelectorAll('.mc-sel-line').forEach(function (r) { r.classList.remove('mc-sel-line'); });
  if (!composerState || composerState.from == null || composerState.to == null) return;
  var from = composerState.from, to = composerState.to;
  if (isDiffViewVisible()) {
    var wrap = diffWrapperByPath(composerState.path);
    if (!wrap) return;
    diffRowsOf(diffSideTable(wrap, composerState.side || 'new')).forEach(function (row) {
      var ln = diffLineNumber(row);
      if (ln != null && ln >= from && ln <= to) row.classList.add('mc-sel-line');
    });
  } else if (isSourceViewerVisible()) {
    for (var ln = from; ln <= to; ln++) {
      var sr = document.querySelector('.source-row[data-line-index="' + (ln - 1) + '"]');
      if (sr) sr.classList.add('mc-sel-line');
    }
  }
}
function refreshComments() {
  renderDiffComments();
  if (isSourceViewerVisible()) renderSourceComments();
  renderCommentBadges();
  applyCommentSelectionHighlight();
  if (composerState) {
    var focusComposerInput = function () {
      var ta = document.querySelector('.mc-composer .mc-input');
      if (ta && document.activeElement !== ta) {
        try { ta.focus({ preventScroll: true }); } catch (e) { try { ta.focus(); } catch (e2) {} }
        try { ta.selectionStart = ta.selectionEnd = ta.value.length; } catch (e3) {}
      }
    };
    // Focus now, next frame, and next task: after a drag the browser may async-restore focus to
    // the body (esp. in Electron), so retry across all three so the textarea reliably wins.
    focusComposerInput();
    requestAnimationFrame(focusComposerInput);
    setTimeout(focusComposerInput, 0);
  }
}

function openComposer(kind) {
  var target = currentCommentTarget();
  if (!target) return;
  composerState = { kind: kind, path: target.path, line: target.line, code: target.code, from: target.from, to: target.to, side: target.side };
  // Keep the dragged code visibly highlighted via the .mc-sel-line class (applyCommentSelectionHighlight),
  // and clear the native selection so its highlight doesn't bleed into the composer/cards below it.
  try { var psel = window.getSelection(); if (psel) psel.removeAllRanges(); } catch (e) {}
  refreshComments();
}
function closeComposer() {
  if (!composerState) return;
  composerState = null;
  refreshComments();
}
function saveComposer(ta) {
  if (!composerState) return;
  var box = ta || document.querySelector('.mc-composer .mc-input');
  if (!box) return;
  addComment(composerState.kind, composerState.path, composerState.line, composerState.code, box.value);
  composerState = null;
  refreshComments();
}

function buildMergedText(kind) {
  var items = reviewComments.filter(function (c) { return c.kind === kind; });
  var nl = String.fromCharCode(10);
  var lines = [];
  lines.push((kind === 'q' ? '# Questions' : '# Change requests') + ' (' + items.length + ')');
  lines.push('');
  items.forEach(function (c) {
    lines.push('### ' + c.path + ':' + c.line);
    if (c.code && c.code.trim()) lines.push('> ' + c.code.trim());
    lines.push(c.text);
    lines.push('');
  });
  return lines.join(nl);
}
// The FULL review (questions + change-requests) as one agent-ready markdown prompt.
function buildReviewPrompt() {
  var nl = String.fromCharCode(10);
  var parts = ['# Code review', '', 'Address the following review comments on the current diff. Each entry gives a file:line, the relevant code (when selected), and the request.', ''];
  if (reviewComments.some(function (c) { return c.kind === 'q'; })) { parts.push(buildMergedText('q')); parts.push(''); }
  if (reviewComments.some(function (c) { return c.kind === 'c'; })) { parts.push(buildMergedText('c')); }
  return parts.join(nl);
}
function savePromptFile(md) {
  if (window.monacoriReview && typeof window.monacoriReview.savePrompt === 'function') {
    return Promise.resolve(window.monacoriReview.savePrompt(md));
  }
  return Promise.reject(new Error('no-ipc'));
}

function openMergedView(kind) {
  var existing = document.getElementById('mc-modal');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'mc-modal';
  modal.className = 'mc-modal';
  var panel = document.createElement('div');
  panel.className = 'mc-modal-panel';
  var head = document.createElement('div');
  head.className = 'mc-modal-head';
  var title = document.createElement('span');
  title.textContent = kind === 'q' ? 'Question comments' : 'Change-request comments';
  var copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'mc-btn';
  copyBtn.textContent = 'Copy all';
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mc-btn mc-ghost';
  closeBtn.textContent = 'Close';
  var area = document.createElement('textarea');
  area.className = 'mc-modal-text';
  area.readOnly = true;
  area.value = buildMergedText(kind);
  copyBtn.addEventListener('click', function () {
    area.focus(); area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    if (navigator.clipboard && navigator.clipboard.writeText) { try { navigator.clipboard.writeText(area.value); ok = true; } catch (e) {} }
    copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(function () { copyBtn.textContent = 'Copy all'; }, 1500);
  });
  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'mc-btn';
  saveBtn.textContent = 'Save prompt';
  saveBtn.title = 'Write the full review (questions + change-requests) to .monacori/review-prompt.md for an agent';
  saveBtn.addEventListener('click', function () {
    savePromptFile(buildReviewPrompt()).then(function (p) {
      var s = String(p || '.monacori/review-prompt.md');
      var i = s.indexOf('.monacori/');
      saveBtn.textContent = 'Saved → ' + (i >= 0 ? s.slice(i) : s);
      setTimeout(function () { saveBtn.textContent = 'Save prompt'; }, 4000);
    }).catch(function () {
      // No file write available (static browser build): fall back to copying the full review.
      area.value = buildReviewPrompt(); area.focus(); area.select();
      try { document.execCommand('copy'); } catch (e) {}
      if (navigator.clipboard && navigator.clipboard.writeText) { try { navigator.clipboard.writeText(area.value); } catch (e) {} }
      saveBtn.textContent = 'Copied (no file)';
      setTimeout(function () { saveBtn.textContent = 'Save prompt'; }, 2000);
    });
  });
  closeBtn.addEventListener('click', function () { modal.remove(); });
  head.appendChild(title);
  head.appendChild(saveBtn);
  head.appendChild(copyBtn);
  head.appendChild(closeBtn);
  panel.appendChild(head);
  panel.appendChild(area);
  modal.appendChild(panel);
  modal.addEventListener('mousedown', function (e) { if (e.target === modal) modal.remove(); });
  modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); modal.remove(); } });
  document.body.appendChild(modal);
  requestAnimationFrame(function () { area.focus(); area.select(); });
}

document.addEventListener('click', function (event) {
  var t = event.target;
  if (!t || !t.closest) return;
  var del = t.closest('.mc-del');
  if (del) { event.preventDefault(); deleteComment(parseInt(del.dataset.seq, 10)); return; }
  if (t.closest('.mc-save')) { event.preventDefault(); saveComposer(); return; }
  if (t.closest('.mc-cancel')) { event.preventDefault(); closeComposer(); return; }
});
document.addEventListener('keydown', function (event) {
  var t = event.target;
  if (!t || !t.classList || !t.classList.contains('mc-input')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeComposer(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveComposer(t); return; }
}, true);

refreshComments();

// In Electron, the Review menu's Cmd/Ctrl+Shift+/ and +. accelerators arrive here via IPC
// (macOS reserves Cmd+? for its Help search, so the menu claims it and routes to these views).
if (window.monacoriMenu && typeof window.monacoriMenu.onMergedView === 'function') {
  window.monacoriMenu.onMergedView(function (kind) { openMergedView(kind); });
}

(function checkForUpdate() {
  try { if (sessionStorage.getItem('monacori-update-checked')) return; } catch (e) {}
  var current = window.__MONACORI_VERSION__ || '';
  if (!current || typeof fetch !== 'function') return;
  try { sessionStorage.setItem('monacori-update-checked', '1'); } catch (e) {}
  var isNewer = function (a, b) {
    var pa = String(a).split('.'), pb = String(b).split('.');
    for (var i = 0; i < 3; i++) {
      var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  };
  fetch('https://registry.npmjs.org/@happy-nut/monacori/latest', { cache: 'no-store' })
    .then(function (res) { return res && res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.version || !isNewer(data.version, current)) return;
      var badge = document.getElementById('update-badge');
      if (!badge) return;
      badge.textContent = 'Update available: v' + data.version;
      badge.classList.remove('hidden');
    })
    .catch(function () {});
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
  setTab('changes');
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
  const runBtn = target?.closest?.('.http-run');
  if (runBtn) {
    event.preventDefault();
    runHttpRequest(Number(runBtn.dataset.req));
    return;
  }
  const respToggle = target?.closest?.('.http-resp-toggle');
  if (respToggle) {
    event.preventDefault();
    const panel = respToggle.closest('.http-response')?.querySelector('.http-resp-headers');
    if (panel) panel.classList.toggle('hidden');
    return;
  }
  const row = target?.closest?.('.source-row');
  if (!row) return;
  clearTreeFocus();
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
  selectedCommentRow = null; // any explicit caret placement (click/move) ends a comment-box selection
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

function openDiffFileAtCaret() {
  if (diffCursor && isDiffViewVisible()) {
    const dwrap = diffWrapperByPath(diffCursor.path);
    const drow = dwrap ? diffRowAt(dwrap, diffCursor.side, diffCursor.rowIndex) : null;
    const dline = drow ? diffLineNumber(drow) : null;
    if (sourceByPath.has(diffCursor.path)) { setSourceCursor(diffCursor.path, dline != null ? dline - 1 : 0, 0, true, -1); return; }
    openSourceFile(diffCursor.path); return;
  }
  const sel = window.getSelection();
  const node = sel && sel.anchorNode;
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  const wrapper = (el && el.closest && el.closest('.d2h-file-wrapper')) || document.querySelector('.d2h-file-wrapper:not(.df-inactive)');
  if (!wrapper) return;
  const fileName = (wrapper.querySelector('.d2h-file-name')?.textContent || '').trim();
  if (!fileName) return;
  if (!sourceByPath.has(fileName)) { openSourceFile(fileName); return; }
  let lineIndex = 0;
  const lineEl = el && el.closest && el.closest('.d2h-code-side-line');
  if (lineEl) {
    const row = lineEl.closest('tr');
    const numEl = row && row.querySelector('.d2h-code-side-linenumber');
    const num = numEl ? parseInt((numEl.textContent || '').trim(), 10) : NaN;
    if (Number.isFinite(num)) lineIndex = Math.max(0, num - 1);
  }
  setSourceCursor(fileName, lineIndex, 0, true, -1);
}

// ----- Comment-box navigation: a box attached to a line is a selectable stop while moving the caret -----
function commentRowSiblingOf(lineIndex, dir) {
  var cur = document.querySelector('#source-body .source-row[data-line-index="' + lineIndex + '"]');
  if (!cur) return null;
  var sib = dir < 0 ? cur.previousElementSibling : cur.nextElementSibling;
  return (sib && sib.classList && sib.classList.contains('mc-comment-row')) ? sib : null;
}
function selectCommentRow(row) {
  if (selectedCommentRow && selectedCommentRow !== row) selectedCommentRow.classList.remove('mc-row-selected');
  selectedCommentRow = row || null;
  if (!selectedCommentRow) return;
  selectedCommentRow.classList.add('mc-row-selected');
  // hide the text caret while the box is "selected" (no re-render happens during plain selection)
  document.querySelectorAll('#source-body .source-row.cursor-line').forEach(function (r) { r.classList.remove('cursor-line'); });
  document.querySelectorAll('#source-body .code-cursor').forEach(function (s) { var p = s.parentNode; if (p) { p.removeChild(s); if (p.normalize) p.normalize(); } });
}
function deleteCommentsInRow(row) {
  if (!row) return;
  var seqs = Array.prototype.slice.call(row.querySelectorAll('.mc-del')).map(function (b) { return parseInt(b.dataset.seq, 10); });
  selectedCommentRow = null;
  if (seqs.length) {
    reviewComments = reviewComments.filter(function (c) { return seqs.indexOf(c.seq) < 0; });
    saveComments();
  }
  refreshComments(); // remaining comment rows re-injected; the caret stays hidden until the next arrow press
}
function handleSourceCaretKey(event) {
  if (!viewerCursor) return false;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return false;
  const extend = event.shiftKey;
  // A comment box is selected (caret hidden): Backspace/Delete removes it; an arrow steps off it.
  if (selectedCommentRow) {
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); deleteCommentsInRow(selectedCommentRow); return true; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Escape') {
      var dir = event.key === 'ArrowUp' ? -1 : (event.key === 'ArrowDown' ? 1 : 0);
      var sib = dir < 0 ? selectedCommentRow.previousElementSibling : (dir > 0 ? selectedCommentRow.nextElementSibling : null);
      selectedCommentRow.classList.remove('mc-row-selected');
      selectedCommentRow = null;
      event.preventDefault();
      if (sib && sib.classList && sib.classList.contains('source-row')) {
        var li = parseInt(sib.dataset.lineIndex, 10);
        if (isFinite(li)) { setSourceCursor(viewerCursor.path, li, 0, true, -1); return true; }
      }
      setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, viewerCursor.column, false, -1); // restore caret where it was
      return true;
    }
    return false;
  }
  // Plain Up/Down: a comment box between the caret line and the next line becomes a selectable stop.
  if (!extend && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    var box = commentRowSiblingOf(viewerCursor.lineIndex, event.key === 'ArrowUp' ? -1 : 1);
    if (box) { event.preventDefault(); selectCommentRow(box); return true; }
  }
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
// Word boundary in text from col in direction dir (+1 next, -1 prev): skip non-word, then word.
function nextWordBoundary(text, col, dir) {
  var isWord = function (ch) { return /[A-Za-z0-9_$]/.test(ch); };
  var i = col;
  if (dir > 0) {
    while (i < text.length && !isWord(text.charAt(i))) i++;
    while (i < text.length && isWord(text.charAt(i))) i++;
  } else {
    while (i > 0 && !isWord(text.charAt(i - 1))) i--;
    while (i > 0 && isWord(text.charAt(i - 1))) i--;
  }
  return i;
}
function moveSourceWord(dir, extend) {
  if (!viewerCursor) return;
  var file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return;
  var lines = file.content.split(/\r?\n/);
  var line = viewerCursor.lineIndex, col = viewerCursor.column;
  var text = lines[line] || '';
  if (dir > 0) {
    if (col >= text.length) { if (line < lines.length - 1) { line += 1; col = 0; } }
    else col = nextWordBoundary(text, col, 1);
  } else {
    if (col <= 0) { if (line > 0) { line -= 1; col = (lines[line] || '').length; } }
    else col = nextWordBoundary(text, col, -1);
  }
  if (extend) { if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column }; }
  else selectionAnchor = null;
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
  renderBreadcrumb(document.getElementById('source-title'), path);
  const meta = [
    file.language || 'text',
    formatBytes(file.size || 0),
    file.changed ? 'changed' : 'unchanged',
    file.embedded ? 'searchable' : file.skippedReason || 'not embedded',
  ].join(' | ');
  document.getElementById('source-meta').textContent = meta;
  refreshSourceViewedToggle();
  const body = document.getElementById('source-body');
  if (!file.embedded) {
    body.className = 'source-body empty';
    body.textContent = file.skippedReason ? 'Source preview unavailable: ' + file.skippedReason + '.' : 'Source preview unavailable.';
    document.getElementById('http-env-select')?.classList.add('hidden');
    if (shouldSwitch) showSourceView();
    return;
  }
  if (!viewerCursor || viewerCursor.path !== path) {
    viewerCursor = { path, lineIndex: 0, column: 0, targetLine: -1 };
  }
  body.className = 'source-body';
  const httpEnvSelect = document.getElementById('http-env-select');
  if (isHttpFile(path)) {
    body.innerHTML = renderHttpTable(file);
    if (httpEnvSelect) httpEnvSelect.classList.toggle('hidden', httpEnvNames.length === 0);
  } else {
    body.innerHTML = renderSourceTable(file, searchInput?.value || '');
    if (httpEnvSelect) httpEnvSelect.classList.add('hidden');
  }
  renderSourceComments();
  if (shouldSwitch) showSourceView();
}

function isHttpFile(path) {
  return /\.(http|rest)$/i.test(path || '');
}

function currentHttpEnv() {
  return httpEnvironments[currentHttpEnvName] || {};
}

function applyHttpVars(text, env) {
  return String(text == null ? '' : text).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, function (whole, name) {
    if (env && Object.prototype.hasOwnProperty.call(env, name)) return env[name];
    return whole;
  });
}

// Parses an IntelliJ-style .http file into a list of requests. Each request
// tracks the line of its request line (for the gutter Run button) and the line
// span it covers (for placing the inline response and for Cmd/Alt+Enter).
function parseHttpRequests(content) {
  const methods = { GET: 1, POST: 1, PUT: 1, PATCH: 1, DELETE: 1, HEAD: 1, OPTIONS: 1, TRACE: 1, CONNECT: 1 };
  const lines = String(content).split(/\r?\n/);
  const requests = [];
  const vars = {};
  let curr = null;
  let phase = 'pre';
  function flush() {
    if (curr && curr.url) {
      curr.body = curr.bodyLines.join('\n').replace(/\s+$/, '');
      requests.push(curr);
    }
  }
  function start(boundaryLine, name, index) {
    return { name: name, method: '', url: '', headers: [], bodyLines: [], startLine: -1, endLine: index, boundaryLine: boundaryLine };
  }
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (trimmed.indexOf('###') === 0) {
      flush();
      curr = start(i, trimmed.replace(/^#+/, '').trim(), i);
      phase = 'pre';
      continue;
    }
    if (!curr) {
      curr = start(-1, '', i);
      phase = 'pre';
    }
    curr.endLine = i;
    if (phase === 'pre') {
      if (trimmed === '') continue;
      if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) continue;
      const varMatch = /^@([\w.$-]+)\s*=\s*(.*)$/.exec(trimmed);
      if (varMatch) { vars[varMatch[1]] = varMatch[2].trim(); continue; }
      const sp = trimmed.indexOf(' ');
      const firstToken = sp >= 0 ? trimmed.slice(0, sp) : trimmed;
      if (sp >= 0 && methods[firstToken.toUpperCase()]) {
        curr.method = firstToken.toUpperCase();
        curr.url = trimmed.slice(sp + 1).replace(/\s+HTTP\/[\d.]+\s*$/i, '').trim();
      } else {
        curr.method = 'GET';
        curr.url = trimmed.replace(/\s+HTTP\/[\d.]+\s*$/i, '').trim();
      }
      curr.startLine = i;
      phase = 'headers';
      continue;
    }
    if (phase === 'headers') {
      if (trimmed === '') { phase = 'body'; continue; }
      if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) continue;
      const colon = rawLine.indexOf(':');
      if (colon > 0) curr.headers.push({ name: rawLine.slice(0, colon).trim(), value: rawLine.slice(colon + 1).trim() });
      continue;
    }
    curr.bodyLines.push(rawLine);
  }
  flush();
  return { requests: requests, vars: vars };
}

function renderHttpTable(file) {
  const parsed = parseHttpRequests(file.content);
  const requests = parsed.requests;
  httpRequestsByPath.set(file.path, requests);
  httpVarsByPath.set(file.path, parsed.vars);
  const env = Object.assign({}, parsed.vars, currentHttpEnv());
  const lines = String(file.content).split(/\r?\n/);
  const cursor = viewerCursor && viewerCursor.path === file.path ? viewerCursor : null;
  const runAtLine = {};
  const respAfterLine = {};
  requests.forEach(function (req, idx) {
    if (req.startLine >= 0) runAtLine[req.startLine] = idx;
    respAfterLine[req.endLine] = idx;
  });
  let rows = '';
  lines.forEach(function (line, index) {
    const hasRun = Object.prototype.hasOwnProperty.call(runAtLine, index);
    const reqIdx = hasRun ? runAtLine[index] : -1;
    const isCursorLine = Boolean(cursor && cursor.lineIndex === index);
    const gutter = hasRun
      ? '<button type="button" class="http-run" data-req="' + reqIdx + '" title="Run request (Cmd/Alt+Enter)" aria-label="Run request">&#9654;</button>'
      : '';
    rows += '<tr class="source-row http-row' + (hasRun ? ' http-request-line' : '') + (isCursorLine ? ' cursor-line' : '') + '" data-line-index="' + index + '">'
      + '<td class="num http-gutter">' + gutter + '<span class="num-text">' + (index + 1) + '</span></td>'
      + '<td class="source-code">' + (isCursorLine ? renderHttpLineWithCursor(line, env, cursor.column) : highlightHttpLine(line, env)) + '</td>'
      + '</tr>';
    if (Object.prototype.hasOwnProperty.call(respAfterLine, index)) {
      const rIdx = respAfterLine[index];
      rows += '<tr class="http-response-row"><td class="num"></td><td class="source-code"><div class="http-response hidden" id="http-resp-' + rIdx + '"></div></td></tr>';
    }
  });
  return '<table class="source-table http-table"><tbody>' + rows + '</tbody></table>';
}
function renderHttpLineWithCursor(text, env, column) {
  var col = Math.max(0, Math.min(column, text.length));
  return highlightHttpLine(text.slice(0, col), env) + '<span class="code-cursor" aria-hidden="true"></span>' + highlightHttpLine(text.slice(col), env);
}

function highlightHttpLine(line, env) {
  const trimmed = line.trim();
  if (trimmed.indexOf('###') === 0) return '<span class="http-sep">' + escapeHtml(line) + '</span>';
  if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) return '<span class="tok-comment">' + escapeHtml(line) + '</span>';
  let html = escapeHtml(line);
  html = html.replace(/^(\s*)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(\s)/, function (whole, pre, method, post) {
    return pre + '<span class="http-method">' + method + '</span>' + post;
  });
  html = html.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, function (whole, name) {
    const known = env && Object.prototype.hasOwnProperty.call(env, name);
    const title = known ? String(env[name]) : 'Undefined variable';
    return '<span class="http-var ' + (known ? 'known' : 'unknown') + '" title="' + escapeHtml(title) + '">' + escapeHtml(whole) + '</span>';
  });
  return html;
}

function sendHttp(request) {
  if (window.monacoriHttp && typeof window.monacoriHttp.send === 'function') {
    return Promise.resolve(window.monacoriHttp.send(request));
  }
  return fetch('/__http_send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }).then(function (response) { return response.json(); });
}

function runHttpRequest(reqIndex) {
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  const requests = httpRequestsByPath.get(path);
  if (!requests || !requests[reqIndex]) return;
  const req = requests[reqIndex];
  const env = Object.assign({}, httpVarsByPath.get(path) || {}, currentHttpEnv());
  const headers = {};
  req.headers.forEach(function (header) {
    const key = applyHttpVars(header.name, env);
    if (key) headers[key] = applyHttpVars(header.value, env);
  });
  const resolved = {
    method: req.method || 'GET',
    url: applyHttpVars(req.url, env),
    headers: headers,
    body: req.body ? applyHttpVars(req.body, env) : undefined,
  };
  const target = document.getElementById('http-resp-' + reqIndex);
  if (target) {
    target.className = 'http-response loading';
    target.textContent = resolved.method + ' ' + resolved.url;
  }
  sendHttp(resolved).then(function (result) {
    if (target) renderHttpResponse(target, result);
  }).catch(function (error) {
    if (target) {
      target.className = 'http-response error';
      target.innerHTML = '<div class="http-resp-head"><span class="http-status bad">Failed</span></div><pre class="http-resp-body">' + escapeHtml(String(error && error.message ? error.message : error)) + '</pre>';
    }
  });
}

function runHttpAtCaret() {
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  const requests = httpRequestsByPath.get(path);
  if (!requests || !requests.length) return;
  const caretLine = viewerCursor && viewerCursor.path === path ? viewerCursor.lineIndex : 0;
  let chosen = -1;
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const from = req.boundaryLine >= 0 ? req.boundaryLine : req.startLine;
    if (from <= caretLine && caretLine <= req.endLine) { chosen = i; break; }
    if (from <= caretLine) chosen = i;
  }
  if (chosen < 0) chosen = 0;
  runHttpRequest(chosen);
}

function renderHttpResponse(target, result) {
  if (!result || !result.ok) {
    target.className = 'http-response error';
    const message = result && result.error ? result.error : 'Request failed';
    target.innerHTML = '<div class="http-resp-head"><span class="http-status bad">Failed</span></div><pre class="http-resp-body">' + escapeHtml(message) + '</pre>';
    return;
  }
  target.className = 'http-response';
  const status = Number(result.status) || 0;
  const statusClass = status >= 200 && status < 300 ? 'ok' : (status >= 400 ? 'bad' : 'warn');
  const headers = result.headers || {};
  const headerKeys = Object.keys(headers).sort();
  const headerHtml = headerKeys.map(function (key) {
    return '<div class="http-h"><span class="http-h-k">' + escapeHtml(key) + '</span><span class="http-h-v">' + escapeHtml(String(headers[key])) + '</span></div>';
  }).join('');
  let contentType = '';
  for (let i = 0; i < headerKeys.length; i++) {
    if (headerKeys[i].toLowerCase() === 'content-type') { contentType = String(headers[headerKeys[i]]); break; }
  }
  const bodyText = result.body == null ? '' : String(result.body);
  const bodyHtml = formatHttpBody(bodyText, contentType);
  target.innerHTML =
    '<div class="http-resp-head">'
    + '<span class="http-status ' + statusClass + '">' + status + (result.statusText ? ' ' + escapeHtml(result.statusText) : '') + '</span>'
    + '<span class="http-resp-meta">' + (Number(result.durationMs) || 0) + ' ms</span>'
    + '<span class="http-resp-meta">' + formatBytes(bodyText.length) + '</span>'
    + (headerKeys.length ? '<button type="button" class="http-resp-toggle">Headers (' + headerKeys.length + ')</button>' : '')
    + '</div>'
    + '<div class="http-resp-headers hidden">' + headerHtml + '</div>'
    + '<pre class="http-resp-body">' + bodyHtml + '</pre>';
}

function formatHttpBody(text, contentType) {
  if (!text) return '<span class="http-resp-empty">(empty body)</span>';
  const looksJson = /json/i.test(contentType) || /^[\[{]/.test(text.trim());
  if (looksJson) {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      return pretty.split(/\r?\n/).map(function (line) { return highlightLine(line, 'json'); }).join('\n');
    } catch (error) {}
  }
  return escapeHtml(text);
}

function populateHttpEnvSelect() {
  const select = document.getElementById('http-env-select');
  if (!select) return;
  let opts = '<option value="">No environment</option>';
  httpEnvNames.forEach(function (name) {
    opts += '<option value="' + escapeHtml(name) + '"' + (name === currentHttpEnvName ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
  });
  select.innerHTML = opts;
  select.addEventListener('change', function () {
    currentHttpEnvName = select.value;
    try { localStorage.setItem(httpEnvKey, currentHttpEnvName); } catch (error) {}
    const path = document.getElementById('source-viewer')?.dataset.openPath || '';
    if (path && isHttpFile(path)) {
      const file = sourceByPath.get(path);
      const body = document.getElementById('source-body');
      if (file && body) body.innerHTML = renderHttpTable(file);
    }
  });
}

function renderSourceTable(file, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  const cursor = viewerCursor && viewerCursor.path === file.path ? viewerCursor : null;
  const changedSet = new Set(file.changedLines || []);
  const rows = lines.map((line, index) => {
    const hit = normalizedQuery.length > 0 && line.toLowerCase().includes(normalizedQuery);
    const isCursorLine = Boolean(cursor && cursor.lineIndex === index);
    const isSymbolTarget = Boolean(cursor && cursor.targetLine === index);
    const isChanged = changedSet.has(index + 1);
    const classes = [
      'source-row',
      hit ? 'search-hit' : '',
      isChanged ? 'changed-line' : '',
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
  if (lower.endsWith(".http") || lower.endsWith(".rest")) return "http";
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
