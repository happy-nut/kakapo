import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { delimiter, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markServerCacheUsed, serverCacheDirectory } from "./server-cache.js";
import { errorMessage, executable, languageForPath, readTextFile } from "./util.js";

export type AnalysisFoldingRange = {
  startLine: number;
  endLine: number;
  kind: string;
};

export type AnalysisSelectionRange = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
};

export type AnalysisHighlight = {
  lineIndex: number;
  startColumn: number;
  endColumn: number;
  kind: "read" | "write" | "text";
};

export type AnalysisCodeLens = {
  lineIndex: number;
  title: string;
};

export type AnalysisInlayHint = {
  lineIndex: number;
  column: number;
  label: string;
  kind: "type" | "parameter" | "";
  paddingLeft: boolean;
  paddingRight: boolean;
};

export const SEMANTIC_TOKEN_TYPES = [
  "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable",
  "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment",
  "string", "number", "regexp", "operator", "decorator",
];

export const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification",
  "documentation", "defaultLibrary",
];

export type AnalysisSemanticToken = {
  lineIndex: number;
  startColumn: number;
  length: number;
  type: string;
  modifiers?: string[];
};

export type AnalysisSymbol = {
  name: string;
  detail?: string;
  kind: string;
  lineIndex: number;
  column: number;
  endLineIndex: number;
  depth: number;
  container?: string;
};

export type AnalysisLocation = {
  path: string;
  lineIndex: number;
  column: number;
  endLineIndex?: number;
  endColumn?: number;
  name?: string;
  kind?: number;
  text?: string;
  library?: true;
  external?: true;
};

export function externalLocationLabel(uri: string): string {
  const bang = uri.indexOf("!/");
  if (bang < 0) return uri.replace(/^[a-z]+:\/*/i, "");
  const inner = uri.slice(bang + 2);
  const archive = uri.slice(0, bang).split("/").pop() || "";
  return archive && /\.(jar|zip)$/i.test(archive) ? `${archive} / ${inner}` : inner;
}

const libraryPaths = new Set<string>();

export function isKnownLibraryPath(path: string): boolean {
  return libraryPaths.has(path.replace(/\\/g, "/"));
}

const externalUris = new Set<string>();

export function isKnownExternalUri(uri: string): boolean {
  return externalUris.has(uri);
}

const EXTERNAL_URI_SAMPLE_FILE: Record<string, string> = {
  jdt: "Library.java",
  jrt: "Library.java",
};

export function externalUriSampleFile(uri: string): string | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase();
  return scheme ? EXTERNAL_URI_SAMPLE_FILE[scheme] : undefined;
}

export function resetKnownLibraryPaths(): void {
  libraryPaths.clear();
  externalUris.clear();
}

export type DiagnosticSeverity = "error" | "warning" | "weak";

export type LspDiagnostic = {
  lineIndex: number;
  column: number;
  endLineIndex: number;
  endColumn: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
  code?: string;
};

const DIAGNOSTIC_SEVERITY: DiagnosticSeverity[] = ["error", "warning", "weak", "weak"];

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function diagnosticCode(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  if (raw && typeof raw === "object" && "value" in raw) {
    const value = (raw as { value?: unknown }).value;
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}

const IMPORT_RESOLUTION_CODES = new Set([
  "reportMissingImports",
  "reportMissingModuleSource",
  "2307",
  "2792",
]);
const MISSING_TYPE_PACKAGE = /do you need to install type definitions|try `?npm i --save-dev @types\//i;
const AMBIENT_TYPE_NAMESPACES = /cannot find namespace '(NodeJS|jest|Mocha|Chai|Cypress|Express|React)'/i;
function isImportResolutionDiagnostic(code: string, message: string): boolean {
  if (code && IMPORT_RESOLUTION_CODES.has(code)) return true;
  if (MISSING_TYPE_PACKAGE.test(message) || AMBIENT_TYPE_NAMESPACES.test(message)) return true;
  return /could not be resolved|cannot find module/i.test(message);
}

export function mapLspDiagnostics(raw: unknown): LspDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const mapped: LspDiagnostic[] = [];
  for (const entry of raw) {
    const item = entry as {
      range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } };
      severity?: unknown;
      message?: unknown;
      source?: unknown;
      code?: unknown;
    };
    const lineIndex = nonNegativeInt(item?.range?.start?.line);
    const column = nonNegativeInt(item?.range?.start?.character);
    if (lineIndex === null || column === null) continue;
    const message = typeof item.message === "string" ? item.message.trim() : "";
    if (!message) continue;
    const code = diagnosticCode(item.code);
    if (isImportResolutionDiagnostic(code, message)) continue;
    const endLineIndex = nonNegativeInt(item?.range?.end?.line) ?? lineIndex;
    const endColumn = nonNegativeInt(item?.range?.end?.character) ?? column;
    const severityIndex = typeof item.severity === "number" && item.severity >= 1 && item.severity <= 4
      ? Math.floor(item.severity) - 1
      : 0;
    const diagnostic: LspDiagnostic = {
      lineIndex,
      column,
      endLineIndex: Math.max(endLineIndex, lineIndex),
      endColumn,
      severity: DIAGNOSTIC_SEVERITY[severityIndex],
      message,
    };
    if (typeof item.source === "string" && item.source) diagnostic.source = item.source;
    if (code) diagnostic.code = code;
    mapped.push(diagnostic);
  }
  return mapped;
}

export type LanguageServerCommand = {
  family: string;
  name: string;
  command: string;
  args: string[];
  source?: "override" | "project" | "bundled";
  env?: NodeJS.ProcessEnv;
  cacheDirectory?: string;
};

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
};
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type LspRange = {
  start?: { line?: number; character?: number };
  end?: { line?: number; character?: number };
};

type LspLocationLike = {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetRange?: LspRange;
  targetSelectionRange?: LspRange;
  name?: string;
  kind?: number;
  location?: { uri?: string; range?: LspRange };
};

const REQUEST_TIMEOUT_MS = 8_000;
const INITIALIZE_TIMEOUT_MS = 20_000;
const STOP_GRACE_MS = 2_000;
const CHECK_BUDGET_MS = 60_000;
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_BUNDLED_SERVER_ROOT = join(APP_ROOT, "vendor", "language-servers");

type ServerSpec = { binary: string; args: string[] };
type BundledServerContext = {
  root: string;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
};

function familyForPath(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "typescript";
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rust";
  if ([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx"].includes(ext)) return "clang";
  if (ext === ".java") return "java";
  if ([".kt", ".kts"].includes(ext)) return "kotlin";
  if (ext === ".php") return "php";
  if (ext === ".rb") return "ruby";
  return undefined;
}

const SERVER_SPECS: Record<string, ServerSpec[]> = {
  typescript: [{ binary: "typescript-language-server", args: ["--stdio"] }],
  python: [{ binary: "pyright-langserver", args: ["--stdio"] }, { binary: "pylsp", args: [] }],
  go: [{ binary: "gopls", args: [] }],
  rust: [{ binary: "rust-analyzer", args: [] }],
  clang: [{ binary: "clangd", args: [] }],
  java: [{ binary: "jdtls", args: [] }],
  kotlin: [{ binary: "kotlin-language-server", args: [] }],
  ruby: [{ binary: "solargraph", args: ["stdio"] }],
  php: [{ binary: "phpactor", args: ["language-server"] }],
};

/**
 * What IntelliJ does when you follow a symbol into a dependency, expressed in jdtls's own settings.
 *
 * IntelliJ shows you the real source when a `-sources.jar` is available and decompiled bytecode when it is
 * not, and it fetches the sources jar for you. jdtls can do all three and does none of them unless asked:
 * out of the box a definition in a dependency comes back as a `jdt://` URI whose contents nobody has
 * offered to produce, which is why every JDK and dependency symbol ended at a one-line "it is in
 * rt.jar" message. `includeDecompiledSources` is what makes the class-file content request answer at all;
 * the two downloadSources flags are what make that answer be the library's own source rather than a
 * decompilation of it.
 */
const JAVA_LIBRARY_SETTINGS = {
  maven: { downloadSources: true },
  eclipse: { downloadSources: true },
  references: { includeDecompiledSources: true },
  contentProvider: { preferred: "fernflower" },
};

const INIT_OPTIONS: Record<string, Record<string, unknown>> = {
  java: {
    extendedClientCapabilities: { classFileContentsSupport: true },
    settings: { java: JAVA_LIBRARY_SETTINGS },
  },
  typescript: {
    disableAutomaticTypingAcquisition: true,
    // Pin tsserver to the copy kakapo ships. Without this, typescript-language-server resolves the
    // WORKSPACE TypeScript first — `<root>/node_modules/typescript/lib/tsserver.js` — and forks it. The
    // reviewed repository supplies that file, kakapo hosts language servers as Electron-as-node, and the
    // analysis prewarm starts a server on its own after the review paints: a repo that ships a file at that
    // path would run code on the reviewer's machine with no click at all. A valid user setting
    // short-circuits the workspace lookup entirely (findTypescriptVersion), so the repo's copy is never
    // consulted.
    tsserver: { path: join(APP_ROOT, "node_modules", "typescript", "lib", "tsserver.js") },
  },
};

const TS_READING_SETTINGS = {
  implementationsCodeLens: { enabled: true },
  referencesCodeLens: { enabled: true, showOnAllFunctions: true },
  inlayHints: {
    includeInlayParameterNameHints: "all",
    includeInlayParameterNameHintsWhenArgumentMatchesName: false,
    includeInlayFunctionParameterTypeHints: true,
    includeInlayVariableTypeHints: true,
    includeInlayPropertyDeclarationTypeHints: true,
    includeInlayFunctionLikeReturnTypeHints: true,
    includeInlayEnumMemberValueHints: true,
  },
};

const CODE_LENS_LIMIT = 300;
const CODE_LENS_BATCH = 24;

const WORKSPACE_SETTINGS: Record<string, Record<string, unknown>> = {
  typescript: { typescript: TS_READING_SETTINGS, javascript: TS_READING_SETTINGS },
  go: {
    gopls: {
      staticcheck: true,
      analyses: { nilness: true, unusedwrite: true, unusedparams: true },
      "ui.semanticTokens": true,
      hints: {
        assignVariableTypes: true,
        parameterNames: true,
        rangeVariableTypes: true,
        constantValues: true,
        compositeLiteralTypes: true,
        compositeLiteralFields: true,
        functionTypeParameters: true,
      },
    },
  },
  rust: { "rust-analyzer": { checkOnSave: true, check: { command: "check" } } },
  java: { java: JAVA_LIBRARY_SETTINGS },
};

export function configurationSection(settings: Record<string, unknown>, section: unknown): unknown {
  if (typeof section !== "string" || !section) return settings;
  let cursor: unknown = settings;
  for (const part of section.split(".")) {
    if (!cursor || typeof cursor !== "object" || !(part in (cursor as Record<string, unknown>))) return {};
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

const NODE_SERVER_ENTRIES: Record<string, { name: string; entry: string; args: string[] }> = {
  typescript: {
    name: "typescript-language-server",
    entry: join(APP_ROOT, "node_modules", "typescript-language-server", "lib", "cli.mjs"),
    args: ["--stdio"],
  },
  python: {
    name: "pyright-langserver",
    entry: join(APP_ROOT, "node_modules", "pyright", "langserver.index.js"),
    args: ["--stdio"],
  },
};

function bundledRoot(env: NodeJS.ProcessEnv): string {
  return env.KAKAPO_LSP_BUNDLE_ROOT || DEFAULT_BUNDLED_SERVER_ROOT;
}

const SYSTEM_TOOL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function bundledNativeCommand(family: string, context: BundledServerContext): LanguageServerCommand | undefined {
  const base = join(
    bundledRoot(context.env),
    `${context.platform}-${context.arch}`,
    family,
  );
  if (family === "go") {
    const command = join(base, "go", "bin", "gopls");
    const goBin = join(base, "go", "bin");
    if (!executable(command)) return undefined;
    const cacheDirectory = serverCacheDirectory(family, context.root);
    return {
      family,
      name: "gopls",
      command,
      args: [],
      source: "bundled",
      cacheDirectory,
      env: {
        GOROOT: join(base, "go"),
        GOCACHE: join(cacheDirectory, "build"),
        GOMODCACHE: join(cacheDirectory, "modules"),
        PATH: `${goBin}${delimiter}${SYSTEM_TOOL_PATH}`,
      },
    };
  }
  if (family === "rust") {
    const command = join(base, "rust-analyzer");
    const cargoHome = join(base, "cargo");
    const rustupHome = join(base, "rustup");
    const cargo = join(cargoHome, "bin", "cargo");
    if (!executable(command) || !executable(cargo)) return undefined;
    const cacheDirectory = serverCacheDirectory(family, context.root);
    return {
      ...resolvedCommand(family, "rust-analyzer", command, [], "bundled"),
      cacheDirectory,
      env: {
        CARGO_HOME: cargoHome,
        RUSTUP_HOME: rustupHome,
        RUSTUP_TOOLCHAIN: "stable",
        CARGO_TARGET_DIR: join(cacheDirectory, "target"),
        PATH: `${join(cargoHome, "bin")}${delimiter}${SYSTEM_TOOL_PATH}`,
      },
    };
  }
  if (family === "clang") {
    const command = join(base, "bin", "clangd");
    if (!executable(command)) return undefined;
    return resolvedCommand(family, "clangd", command, [], "bundled");
  }
  if (family === "java") {
    const javaHome = join(base, "jre");
    const java = join(javaHome, "bin", "java");
    const launcher = join(base, "jdtls", "plugins", "org.eclipse.equinox.launcher.jar");
    const configuration = join(base, "jdtls", "config_mac");
    if (!executable(java) || !existsSync(launcher) || !existsSync(configuration)) return undefined;
    const data = serverCacheDirectory(family, context.root);
    return {
      family,
      name: "eclipse-jdtls",
      command: java,
      args: [
        "-Declipse.application=org.eclipse.jdt.ls.core.id1",
        "-Dosgi.bundles.defaultStartLevel=4",
        "-Declipse.product=org.eclipse.jdt.ls.core.product",
        "-Dlog.protocol=false",
        "-Dlog.level=WARNING",
        "-Xmx1G",
        "--add-modules=ALL-SYSTEM",
        "--add-opens", "java.base/java.util=ALL-UNNAMED",
        "--add-opens", "java.base/java.lang=ALL-UNNAMED",
        "-jar", launcher,
        "-configuration", configuration,
        "-data", data,
      ],
      source: "bundled",
      cacheDirectory: data,
      env: { JAVA_HOME: javaHome },
    };
  }
  if (family === "kotlin") {
    const command = join(base, "bin", "intellij-server");
    const systemPath = serverCacheDirectory(family, context.root);
    return executable(command)
      ? { ...resolvedCommand(family, "kotlin-lsp", command, ["--stdio", "--system-path", systemPath], "bundled"), cacheDirectory: systemPath }
      : undefined;
  }
  if (family === "ruby") {
    const command = join(base, "sorbet");
    const sorbetCache = serverCacheDirectory(family, context.root);
    return executable(command)
      ? {
        ...resolvedCommand(family, "sorbet", command, [
          "--lsp", "--disable-watchman", "--cache-dir", sorbetCache, "--dir", ".",
          "--enable-experimental-lsp-document-highlight",
        ], "bundled"),
        cacheDirectory: sorbetCache,
      }
      : undefined;
  }
  if (family === "php") {
    const command = join(base, "php");
    const phpactor = join(base, "phpactor.phar");
    const cacheRoot = serverCacheDirectory(family, context.root);
    return executable(command) && existsSync(phpactor)
      ? {
        ...resolvedCommand(family, "phpactor", command, [phpactor, "language-server"], "bundled"),
        cacheDirectory: cacheRoot,
        env: {
          XDG_CACHE_HOME: join(cacheRoot, "cache"),
          XDG_CONFIG_HOME: join(cacheRoot, "config"),
          XDG_DATA_HOME: join(cacheRoot, "data"),
        },
      }
      : undefined;
  }
  return undefined;
}

function resolvedCommand(
  family: string,
  name: string,
  command: string,
  args: string[],
  source: NonNullable<LanguageServerCommand["source"]>,
): LanguageServerCommand {
  return { family, name, command, args, source };
}

function nodeHostedCommand(server: LanguageServerCommand): LanguageServerCommand {
  let entry = server.command;
  try { entry = realpathSync(server.command); } catch { return server; }
  if (!/\.[cm]?js$/i.test(entry)) return server;
  return {
    ...server,
    command: process.execPath,
    args: [entry, ...server.args],
    env: { ...server.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function resolveBundledLanguageServer(
  path: string,
  root = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): LanguageServerCommand | undefined {
  const family = familyForPath(path);
  if (!family) return undefined;
  const nodeServer = NODE_SERVER_ENTRIES[family];
  if (nodeServer?.entry && existsSync(nodeServer.entry)) {
    return {
      family,
      name: nodeServer.name,
      command: process.execPath,
      args: [nodeServer.entry, ...nodeServer.args],
      source: "bundled",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return bundledNativeCommand(family, { root, env, platform, arch });
}

const PROJECT_SERVERS_OPT_IN = "KAKAPO_LSP_PROJECT_SERVERS";
export function resolveLanguageServer(
  root: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): LanguageServerCommand | undefined {
  const family = familyForPath(path);
  if (!family) return undefined;
  const projectDirs = [
    join(root, "node_modules", ".bin"),
    join(root, ".venv", "bin"),
    join(root, "venv", "bin"),
    join(root, "bin"),
  ];
  const override = env[`KAKAPO_LSP_${family.toUpperCase()}`];
  if (override && existsSync(override) && executable(override)) {
    const spec = SERVER_SPECS[family]?.[0];
    if (spec) return nodeHostedCommand(resolvedCommand(family, spec.binary, override, spec.args, "override"));
  }
  const bundled = resolveBundledLanguageServer(path, root, env, platform, arch);
  if (bundled) return bundled;
  if (!env[PROJECT_SERVERS_OPT_IN]) return undefined;
  for (const spec of SERVER_SPECS[family] ?? []) {
    const command = projectDirs
      .map((dir) => join(dir, spec.binary))
      .find((candidate) => existsSync(candidate) && executable(candidate));
    if (command) return nodeHostedCommand(resolvedCommand(family, spec.binary, command, spec.args, "project"));
  }
  return undefined;
}

export function lspLanguageId(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".tsx") return "typescriptreact";
  if ([".jsx"].includes(ext)) return "javascriptreact";
  if ([".kt", ".kts"].includes(ext)) return "kotlin";
  if ([".c", ".h"].includes(ext)) return "c";
  if ([".cc", ".cpp", ".cxx", ".hpp", ".hxx"].includes(ext)) return "cpp";
  return languageForPath(path);
}

const liveServerGroups = new Set<number>();
process.once("exit", () => {
  for (const pid of liveServerGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch { }
  }
  reapEscapedGradleDaemons();
});

export function reapEscapedGradleDaemons(bundleDir = bundledKotlinDir()): void {
  const found = spawnSync("pgrep", ["-f", `^${bundleDir}/.*GradleDaemon`], { encoding: "utf8" });
  for (const line of found.stdout?.split("\n") ?? []) {
    const pid = Number(line.trim());
    if (!pid) continue;
    try { process.kill(pid, "SIGKILL"); } catch { }
  }
}

function bundledKotlinDir(): string {
  return join(bundledRoot(process.env), `${process.platform}-${process.arch}`, "kotlin");
}

export function assertsNothing(title: string): boolean {
  const numbers = title.match(/\d[\d.,]*/g);
  return numbers !== null && numbers.every((number) => Number(number.replace(/[.,]/g, "")) === 0);
}

export class LspClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private started?: Promise<void>;
  private opened = new Map<string, { mtimeMs: number; version: number; end: { line: number; character: number } }>();
  private documentSync = new Map<string, Promise<void>>();
  private semanticTokenTypes: string[] | null = null;
  private semanticTokenModifiers: string[] = [];
  private stopped = false;
  private workspaceQuiescent = false;
  private workspaceWaiters = new Set<() => void>();
  private startupGrace?: Promise<void>;
  private initialNavigationSettled = false;
  private diagnostics = new Map<string, unknown[]>();
  private publishedUris = new Set<string>();
  private diagnosticWaiters = new Map<string, Set<() => void>>();
  private checksRunning = 0;
  private checkCompleted = false;
  private checkWaiters = new Set<() => void>();

  constructor(
    readonly root: string,
    readonly server: LanguageServerCommand,
  ) {}

  serverPid(): number | undefined {
    const child = this.child;
    return child && child.pid && child.exitCode === null && child.signalCode === null ? child.pid : undefined;
  }

  async locations(
    method: "textDocument/definition" | "textDocument/references" | "textDocument/implementation" | "textDocument/typeDefinition",
    path: string,
    lineIndex: number,
    column: number,
  ): Promise<AnalysisLocation[]> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line: Math.max(0, lineIndex), character: Math.max(0, column) },
    };
    if (method === "textDocument/references") params.context = { includeDeclaration: false };
    const retryInitialEmpty = !this.initialNavigationSettled
      && this.server.source === "bundled"
      && ["kotlin", "php"].includes(this.server.family);
    const attempts = retryInitialEmpty ? 4 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await this.requestAfterWorkspaceReady(method, params);
      const locations = normalizeLocationResult(result, this.root);
      if (locations.length || attempt === attempts - 1) {
        this.initialNavigationSettled = true;
        return locations;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 400 * (attempt + 1)));
    }
    return [];
  }

  async documentSymbols(path: string): Promise<AnalysisSymbol[]> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    const result = await this.requestAfterWorkspaceReady("textDocument/documentSymbol", { textDocument: { uri } });
    return normalizeDocumentSymbols(result);
  }

  async foldingRanges(path: string): Promise<{ supported: boolean; ranges: AnalysisFoldingRange[] }> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    let result: unknown;
    try {
      result = await this.requestAfterWorkspaceReady("textDocument/foldingRange", { textDocument: { uri } });
    } catch (error) {
      if (isMethodNotFound(error)) return { supported: false, ranges: [] };
      throw error;
    }
    const ranges: AnalysisFoldingRange[] = [];
    for (const entry of Array.isArray(result) ? result : []) {
      const row = entry as { startLine?: unknown; endLine?: unknown; kind?: unknown };
      const startLine = Number(row?.startLine);
      const endLine = Number(row?.endLine);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || endLine <= startLine) continue;
      ranges.push({
        startLine: Math.max(0, Math.trunc(startLine)),
        endLine: Math.max(0, Math.trunc(endLine)),
        kind: typeof row?.kind === "string" ? row.kind : "",
      });
    }
    return { supported: true, ranges };
  }

  async selectionRanges(path: string, line: number, character: number): Promise<{ supported: boolean; chain: AnalysisSelectionRange[] }> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    let result: unknown;
    try {
      result = await this.requestAfterWorkspaceReady("textDocument/selectionRange", {
        textDocument: { uri },
        positions: [{ line, character }],
      });
    } catch (error) {
      if (isMethodNotFound(error)) return { supported: false, chain: [] };
      throw error;
    }
    const first = Array.isArray(result) ? result[0] : undefined;
    const chain: AnalysisSelectionRange[] = [];
    const seen = new Set<unknown>();
    let node = first as { range?: unknown; parent?: unknown } | undefined;
    while (node && typeof node === "object" && !seen.has(node) && chain.length < 64) {
      seen.add(node);
      const range = node.range as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } } | undefined;
      const startLine = Number(range?.start?.line);
      const startCharacter = Number(range?.start?.character);
      const endLine = Number(range?.end?.line);
      const endCharacter = Number(range?.end?.character);
      if (Number.isFinite(startLine) && Number.isFinite(startCharacter)
        && Number.isFinite(endLine) && Number.isFinite(endCharacter)) {
        chain.push({
          startLine: Math.max(0, Math.trunc(startLine)),
          startCharacter: Math.max(0, Math.trunc(startCharacter)),
          endLine: Math.max(0, Math.trunc(endLine)),
          endCharacter: Math.max(0, Math.trunc(endCharacter)),
        });
      }
      node = node.parent as { range?: unknown; parent?: unknown } | undefined;
    }
    return { supported: true, chain };
  }

  async documentHighlights(
    path: string, lineIndex: number, column: number,
  ): Promise<{ supported: boolean; highlights: AnalysisHighlight[] }> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    let result: unknown;
    try {
      result = await this.requestAfterWorkspaceReady("textDocument/documentHighlight", {
        textDocument: { uri },
        position: { line: Math.max(0, lineIndex), character: Math.max(0, column) },
      });
    } catch (error) {
      if (isMethodNotFound(error)) return { supported: false, highlights: [] };
      throw error;
    }
    const KINDS: Record<number, AnalysisHighlight["kind"]> = { 1: "text", 2: "read", 3: "write" };
    const highlights: AnalysisHighlight[] = [];
    for (const entry of Array.isArray(result) ? result : []) {
      const row = entry as { range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } }; kind?: unknown };
      const line = Number(row?.range?.start?.line);
      const startColumn = Number(row?.range?.start?.character);
      const endColumn = Number(row?.range?.end?.character);
      if (!Number.isFinite(line) || !Number.isFinite(startColumn)) continue;
      highlights.push({
        lineIndex: Math.max(0, Math.trunc(line)),
        startColumn: Math.max(0, Math.trunc(startColumn)),
        endColumn: Number.isFinite(endColumn) ? Math.max(0, Math.trunc(endColumn)) : Math.max(0, Math.trunc(startColumn)),
        kind: KINDS[Number(row?.kind)] ?? "text",
      });
    }
    return { supported: true, highlights };
  }

  async semanticTokens(path: string): Promise<{ supported: boolean; tokens: AnalysisSemanticToken[] }> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    if (!this.semanticTokenTypes || !this.semanticTokenTypes.length) return { supported: false, tokens: [] };
    const legend = this.semanticTokenTypes;
    const uri = pathToFileURL(resolve(this.root, path)).href;
    let result: unknown;
    try {
      result = await this.requestAfterWorkspaceReady("textDocument/semanticTokens/full", { textDocument: { uri } });
    } catch (error) {
      if (isMethodNotFound(error)) return { supported: false, tokens: [] };
      throw error;
    }
    const data = (result as { data?: unknown })?.data;
    if (!Array.isArray(data)) return { supported: true, tokens: [] };
    const modifierLegend = this.semanticTokenModifiers;
    const tokens: AnalysisSemanticToken[] = [];
    let line = 0;
    let column = 0;
    for (let i = 0; i + 4 < data.length; i += 5) {
      const deltaLine = Number(data[i]);
      const deltaStart = Number(data[i + 1]);
      const length = Number(data[i + 2]);
      const typeIndex = Number(data[i + 3]);
      if (!Number.isFinite(deltaLine) || !Number.isFinite(deltaStart) || !Number.isFinite(length)) break;
      line += deltaLine;
      column = deltaLine === 0 ? column + deltaStart : deltaStart;
      const type = legend[typeIndex];
      if (!type || length <= 0) continue;
      const bits = Number(data[i + 4]);
      const modifiers = Number.isFinite(bits) && bits > 0
        ? modifierLegend.filter((_, index) => (bits & (1 << index)) !== 0)
        : [];
      tokens.push({
        lineIndex: Math.max(0, line),
        startColumn: Math.max(0, column),
        length,
        type,
        ...(modifiers.length ? { modifiers } : {}),
      });
    }
    return { supported: true, tokens };
  }

  async codeLenses(path: string): Promise<{ supported: boolean; lenses: AnalysisCodeLens[] }> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    let result: unknown;
    try {
      result = await this.requestAfterWorkspaceReady("textDocument/codeLens", { textDocument: { uri } });
    } catch (error) {
      if (isMethodNotFound(error)) return { supported: false, lenses: [] };
      throw error;
    }
    const rows = (Array.isArray(result) ? result : []).slice(0, CODE_LENS_LIMIT) as Array<{
      range?: { start?: { line?: unknown } };
      command?: { title?: unknown };
    }>;
    const lenses: AnalysisCodeLens[] = [];
    for (let at = 0; at < rows.length; at += CODE_LENS_BATCH) {
      const batch = rows.slice(at, at + CODE_LENS_BATCH);
      const titles = await Promise.all(batch.map(async (row) => {
        const own = typeof row?.command?.title === "string" ? row.command.title.trim() : "";
        if (own) return own;
        try {
          const resolved = await this.requestAfterWorkspaceReady("codeLens/resolve", row as Record<string, unknown>);
          const title = (resolved as { command?: { title?: unknown } })?.command?.title;
          return typeof title === "string" ? title.trim() : "";
        } catch {
          return "";
        }
      }));
      batch.forEach((row, index) => {
        const line = Number(row?.range?.start?.line);
        if (!Number.isFinite(line) || !titles[index]) return;
        if (assertsNothing(titles[index])) return;
        lenses.push({ lineIndex: Math.max(0, Math.trunc(line)), title: titles[index] });
      });
    }
    return { supported: true, lenses };
  }

  async inlayHints(
    path: string, fromLine: number, toLine: number,
  ): Promise<{ supported: boolean; hints: AnalysisInlayHint[] }> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    let result: unknown;
    try {
      const documentEnd = this.opened.get(uri)?.end;
      const start = { line: Math.max(0, Math.trunc(fromLine)), character: 0 };
      const wanted = { line: Math.max(start.line, Math.trunc(toLine)), character: 0 };
      const end = documentEnd && documentEnd.line <= wanted.line ? documentEnd : wanted;
      result = await this.requestAfterWorkspaceReady("textDocument/inlayHint", {
        textDocument: { uri }, range: { start, end },
      });
    } catch (error) {
      if (isMethodNotFound(error)) return { supported: false, hints: [] };
      throw error;
    }
    const KINDS: Record<number, AnalysisInlayHint["kind"]> = { 1: "type", 2: "parameter" };
    const hints: AnalysisInlayHint[] = [];
    for (const entry of Array.isArray(result) ? result : []) {
      const row = entry as {
        position?: { line?: unknown; character?: unknown };
        label?: unknown;
        kind?: unknown;
        paddingLeft?: unknown;
        paddingRight?: unknown;
      };
      const line = Number(row?.position?.line);
      const column = Number(row?.position?.character);
      if (!Number.isFinite(line) || !Number.isFinite(column)) continue;
      const label = typeof row?.label === "string"
        ? row.label
        : Array.isArray(row?.label)
          ? row.label.map((part) => (typeof part === "string" ? part : String((part as { value?: unknown })?.value ?? ""))).join("")
          : "";
      if (!label.trim()) continue;
      hints.push({
        lineIndex: Math.max(0, Math.trunc(line)),
        column: Math.max(0, Math.trunc(column)),
        label,
        kind: KINDS[Number(row?.kind)] ?? "",
        paddingLeft: row?.paddingLeft === true,
        paddingRight: row?.paddingRight === true,
      });
    }
    return { supported: true, hints };
  }

  async callHierarchy(
    path: string, lineIndex: number, column: number, direction: "incoming" | "outgoing",
  ): Promise<{ supported: boolean; locations: AnalysisLocation[] }> {
    return this.hierarchy(
      path, lineIndex, column,
      "textDocument/prepareCallHierarchy",
      direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
      direction === "incoming" ? "from" : "to",
    );
  }

  async typeHierarchy(
    path: string, lineIndex: number, column: number, direction: "supertypes" | "subtypes",
  ): Promise<{ supported: boolean; locations: AnalysisLocation[] }> {
    return this.hierarchy(
      path, lineIndex, column,
      "textDocument/prepareTypeHierarchy",
      direction === "supertypes" ? "typeHierarchy/supertypes" : "typeHierarchy/subtypes",
      "",
    );
  }

  private async hierarchy(
    path: string, lineIndex: number, column: number, prepareMethod: string, followMethod: string, itemKey: string,
  ): Promise<{ supported: boolean; locations: AnalysisLocation[] }> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    let prepared: unknown;
    try {
      prepared = await this.requestAfterWorkspaceReady(prepareMethod, {
        textDocument: { uri },
        position: { line: Math.max(0, lineIndex), character: Math.max(0, column) },
      });
    } catch (error) {
      if (isMethodNotFound(error)) return { supported: false, locations: [] };
      throw error;
    }
    const items = Array.isArray(prepared) ? prepared : [];
    if (!items.length) return { supported: true, locations: [] };
    let answer: unknown;
    try {
      answer = await this.requestAfterWorkspaceReady(followMethod, { item: items[0] });
    } catch (error) {
      if (isMethodNotFound(error)) return { supported: false, locations: [] };
      throw error;
    }
    const rows = Array.isArray(answer) ? answer : [];
    const normalized = rows.map((row) => {
      const item = (itemKey && row && typeof row === "object" ? (row as Record<string, unknown>)[itemKey] : row) as
        { uri?: string; name?: string; kind?: number; detail?: string; range?: unknown; selectionRange?: unknown } | undefined;
      return {
        uri: item?.uri,
        targetSelectionRange: item?.selectionRange,
        targetRange: item?.range,
        name: item?.detail ? `${item.name} — ${item.detail}` : item?.name,
        kind: item?.kind,
      };
    }).filter((item) => item.uri);
    return { supported: true, locations: normalizeLocationResult(normalized, this.root) };
  }

  async workspaceSymbols(query: string): Promise<AnalysisLocation[]> {
    await this.start();
    const result = await this.request("workspace/symbol", { query: String(query ?? "") });
    return normalizeLocationResult(result, this.root);
  }

  async hover(path: string, lineIndex: number, column: number): Promise<string> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    const result = await this.requestAfterWorkspaceReady("textDocument/hover", {
      textDocument: { uri },
      position: { line: Math.max(0, lineIndex), character: Math.max(0, column) },
    });
    return normalizeHoverResult(result);
  }

  async externalSourceText(uri: string): Promise<string> {
    if (this.server.family !== "java") return "";
    const result = await this.requestAfterWorkspaceReady("java/classFileContents", { uri });
    return typeof result === "string" ? result : "";
  }

  async warmup(path: string): Promise<void> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
  }

  async awaitAnalysed(path: string, budgetMs: number): Promise<boolean> {
    await this.ensureDocument(path);
    const uri = pathToFileURL(resolve(this.root, path)).href;
    if (this.publishedUris.has(uri)) return true;
    return new Promise<boolean>((resolveWait) => {
      let settled = false;
      const finish = (analysed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.diagnosticWaiters.get(uri)?.delete(onPublish);
        resolveWait(analysed);
      };
      const onPublish = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(0, budgetMs));
      timer.unref?.();
      let waiters = this.diagnosticWaiters.get(uri);
      if (!waiters) { waiters = new Set(); this.diagnosticWaiters.set(uri, waiters); }
      waiters.add(onPublish);
    });
  }

  async diagnosticsFor(path: string): Promise<LspDiagnostic[]> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    if (this.server.family === "rust") await this.waitForFirstCheck();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    if (!this.publishedUris.has(uri)) await this.waitForFirstDiagnostics(uri);
    return mapLspDiagnostics(this.diagnostics.get(uri));
  }

  private announceSave(uri: string, text: string): void {
    if (this.server.family !== "rust") return;
    this.checkCompleted = false;
    this.notify("textDocument/didSave", { textDocument: { uri }, text });
  }

  private waitForFirstCheck(): Promise<void> {
    if (this.checkCompleted && this.checksRunning === 0) return Promise.resolve();
    return new Promise<void>((resolveWait) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.checkWaiters.delete(done);
        resolveWait();
      };
      const timer = setTimeout(done, CHECK_BUDGET_MS);
      timer.unref?.();
      this.checkWaiters.add(done);
    });
  }

  private waitForFirstDiagnostics(uri: string): Promise<void> {
    return new Promise<void>((resolveWait) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.diagnosticWaiters.get(uri)?.delete(done);
        resolveWait();
      };
      const timer = setTimeout(done, 2_000);
      timer.unref?.();
      let waiters = this.diagnosticWaiters.get(uri);
      if (!waiters) { waiters = new Set(); this.diagnosticWaiters.set(uri, waiters); }
      waiters.add(done);
    });
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.notify("exit", null); } catch { }
    this.killTree();
    this.failPending(new Error(`${this.server.name} stopped`));
  }

  private killTree(): void {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch { }
    };
    signalGroup("SIGTERM");
    const timer = setTimeout(() => signalGroup("SIGKILL"), STOP_GRACE_MS);
    timer.unref?.();
    child.once("close", () => clearTimeout(timer));
  }

  private async ensureDocument(path: string): Promise<void> {
    await this.start();
    const absolute = resolve(this.root, path);
    const uri = pathToFileURL(absolute).href;
    const pending = this.documentSync.get(uri);
    if (pending) { await pending; return; }
    const sync = Promise.resolve().then(() => {
      const stat = lstatSync(absolute);
      const opened = this.opened.get(uri);
      if (opened?.mtimeMs === stat.mtimeMs) return;
      const version = opened ? opened.version + 1 : 1;
      const text = stat.isSymbolicLink() ? readlinkSync(absolute) : readTextFile(absolute);
      const lines = text.split("\n");
      const end = { line: Math.max(0, lines.length - 1), character: (lines[lines.length - 1] ?? "").length };
      if (!opened) {
        this.notify("textDocument/didOpen", { textDocument: { uri, languageId: lspLanguageId(path), version, text } });
        this.announceSave(uri, text);
      } else {
        this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
        this.diagnostics.delete(uri);
        this.publishedUris.delete(uri);
        this.announceSave(uri, text);
      }
      this.opened.set(uri, { mtimeMs: stat.mtimeMs, version, end });
    });
    this.documentSync.set(uri, sync);
    try {
      await sync;
    } finally {
      if (this.documentSync.get(uri) === sync) this.documentSync.delete(uri);
    }
  }

  private start(): Promise<void> {
    if (this.started) return this.started;
    this.started = new Promise<void>((resolveStart, rejectStart) => {
      let settled = false;
      if (this.server.cacheDirectory) markServerCacheUsed(this.server.cacheDirectory);
      const child = spawn(this.server.command, this.server.args, {
        cwd: this.root,
        env: { ...process.env, ...this.server.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: true,
      });
      this.child = child;
      const pid = child.pid;
      if (pid) {
        liveServerGroups.add(pid);
        child.once("close", () => liveServerGroups.delete(pid));
      }
      child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        if (process.env.KAKAPO_LSP_DEBUG === "1") process.stderr.write(`[${this.server.name}] ${chunk.toString("utf8")}`);
      });
      child.stdin.on("error", (error) => {
        // A server may exit between spawn() and the initialize write. Without an
        // stdin listener Node surfaces that expected fallback race as an uncaught EPIPE.
        if (!settled) { settled = true; rejectStart(error); }
        this.failPending(error);
      });
      child.once("error", (error) => {
        if (!settled) { settled = true; rejectStart(error); }
        this.failPending(error);
      });
      child.once("close", (code) => {
        const error = new Error(`${this.server.name} exited ${code ?? "unknown"}`);
        if (!settled) { settled = true; rejectStart(error); }
        this.failPending(error);
      });
      const rootUri = pathToFileURL(this.root).href;
      this.request("initialize", {
        processId: process.pid,
        clientInfo: { name: "kakapo" },
        rootUri,
        ...(INIT_OPTIONS[this.server.family] ? { initializationOptions: INIT_OPTIONS[this.server.family] } : {}),
        workspaceFolders: [{ uri: rootUri, name: this.root.split(/[\\/]/).pop() || "workspace" }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true, symbol: {} },
          window: { workDoneProgress: true },
          textDocument: {
            definition: { linkSupport: true },
            references: {},
            implementation: { linkSupport: true },
            publishDiagnostics: { relatedInformation: false },
            foldingRange: { lineFoldingOnly: true },
            documentHighlight: {},
            codeLens: {},
            inlayHint: {},
            semanticTokens: {
              requests: { full: true, range: false },
              formats: ["relative"],
              tokenTypes: SEMANTIC_TOKEN_TYPES,
              tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
            },
          },
        },
      }).then((result) => {
        const provider = (result as {
          capabilities?: { semanticTokensProvider?: { legend?: { tokenTypes?: unknown; tokenModifiers?: unknown } } };
        })?.capabilities?.semanticTokensProvider;
        const types = provider?.legend?.tokenTypes;
        const modifiers = provider?.legend?.tokenModifiers;
        this.semanticTokenTypes = Array.isArray(types) ? types.map((entry) => String(entry)) : null;
        this.semanticTokenModifiers = Array.isArray(modifiers) ? modifiers.map((entry) => String(entry)) : [];
        this.notify("initialized", {});
        this.notify("workspace/didChangeConfiguration", { settings: WORKSPACE_SETTINGS[this.server.family] ?? {} });
        if (!settled) { settled = true; resolveStart(); }
      }, (error) => {
        if (!settled) { settled = true; rejectStart(error); }
      });
    });
    return this.started;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child || this.stopped) {
      if (method !== "initialize") return Promise.reject(new Error(`${this.server.name} is not running`));
    }
    const id = ++this.nextId;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeoutMs = method === "initialize" ? INITIALIZE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${this.server.name} timed out during ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async requestAfterWorkspaceReady(method: string, params: unknown): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.request(method, params);
      } catch (error) {
        lastError = error;
        const message = errorMessage(error);
        if (!/file not found|workspace (?:is )?still loading|not (?:yet )?indexed|content modified/i.test(message)) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error(`${this.server.name} input is closed`);
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isInteger(length) || length < 0) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: JsonRpcMessage;
      try { message = JSON.parse(body) as JsonRpcMessage; } catch { continue; }
      if (message.method && message.id !== undefined) {
        this.replyToServerRequest(message);
        continue;
      }
      if (message.method) {
        this.handleNotification(message);
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const failure = new Error(message.error.message || "language server request failed") as Error & { code?: number };
        failure.code = Number(message.error.code);
        pending.reject(failure);
      }
      else pending.resolve(message.result);
    }
  }

  private replyToServerRequest(message: JsonRpcMessage): void {
    let result: unknown = null;
    if (message.method === "workspace/configuration") {
      const items = Array.isArray((message.params as { items?: unknown[] } | undefined)?.items)
        ? (message.params as { items: unknown[] }).items
        : [];
      const settings = WORKSPACE_SETTINGS[this.server.family] ?? {};
      result = items.map((item) => configurationSection(settings, (item as { section?: unknown })?.section));
    } else if (message.method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.root).href, name: this.root.split(/[\\/]/).pop() || "workspace" }];
    } else if (message.method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "Kakapo analysis is read-only" };
    }
    try { this.send({ jsonrpc: "2.0", id: message.id, result }); } catch { }
  }

  private handleNotification(message: JsonRpcMessage): void {
    if (process.env.KAKAPO_LSP_DEBUG === "1" && ["$/progress", "window/logMessage", "window/showMessage"].includes(message.method || "")) {
      process.stderr.write(`[${this.server.name}] ${message.method} ${JSON.stringify(message.params)}\n`);
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as { uri?: unknown; diagnostics?: unknown } | undefined;
      const uri = typeof params?.uri === "string" ? params.uri : "";
      if (!uri) return;
      this.diagnostics.set(uri, Array.isArray(params?.diagnostics) ? params.diagnostics : []);
      this.publishedUris.add(uri);
      const waiters = this.diagnosticWaiters.get(uri);
      if (waiters) for (const notifyWaiter of Array.from(waiters)) notifyWaiter();
      return;
    }
    if (message.method === "$/progress") {
      const params = message.params as { token?: unknown; value?: { kind?: unknown } } | undefined;
      if (typeof params?.token !== "string" || !params.token.includes("flycheck")) return;
      const kind = params.value?.kind;
      if (kind === "begin") this.checksRunning += 1;
      else if (kind === "end") {
        this.checksRunning = Math.max(0, this.checksRunning - 1);
        if (this.checksRunning === 0) {
          this.checkCompleted = true;
          for (const resolveWaiter of this.checkWaiters) resolveWaiter();
          this.checkWaiters.clear();
        }
      }
      return;
    }
    if (message.method !== "experimental/serverStatus") return;
    const status = message.params as { quiescent?: boolean } | undefined;
    if (status?.quiescent !== true) return;
    this.workspaceQuiescent = true;
    for (const resolveWaiter of this.workspaceWaiters) resolveWaiter();
    this.workspaceWaiters.clear();
  }

  private async waitForWorkspaceReady(): Promise<void> {
    const startupGraceMs = this.server.family === "php" ? 6_000 : this.server.family === "kotlin" ? 75_000 : 0;
    if (startupGraceMs) {
      this.startupGrace ??= new Promise<void>((resolveReady) => {
        const timer = setTimeout(resolveReady, startupGraceMs);
        timer.unref?.();
      });
      await this.startupGrace;
    }
    if (this.server.family !== "rust" || this.workspaceQuiescent) return;
    await new Promise<void>((resolveReady) => {
      const timer = setTimeout(() => {
        this.workspaceWaiters.delete(done);
        this.workspaceQuiescent = true;
        resolveReady();
      }, 3_000);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        this.workspaceWaiters.delete(done);
        resolveReady();
      };
      this.workspaceWaiters.add(done);
      if (this.workspaceQuiescent) done();
    });
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function isMethodNotFound(error: unknown): boolean {
  const code = (error as { code?: number } | undefined)?.code;
  if (code === -32601) return true;
  return /unhandled method|method not found|unsupported method|no handler/i.test(errorMessage(error));
}

const LSP_SYMBOL_KINDS = [
  "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
  "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array",
  "object", "key", "null", "enum-member", "struct", "event", "operator", "type-parameter",
];

export function lspSymbolKindName(kind: unknown): string {
  const index = Number(kind) - 1;
  return LSP_SYMBOL_KINDS[index] ?? "symbol";
}

type LspDocumentSymbolLike = {
  name?: unknown;
  detail?: unknown;
  kind?: unknown;
  range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown } };
  selectionRange?: { start?: { line?: unknown; character?: unknown } };
  location?: { range?: { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown } } };
  containerName?: unknown;
  children?: unknown;
};

export function normalizeHoverResult(result: unknown): string {
  const value = result as { contents?: unknown } | undefined;
  if (!value || typeof value !== "object") return "";
  const parts = Array.isArray(value.contents) ? value.contents : [value.contents];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part.trim()) out.push(part);
      continue;
    }
    const marked = part as { kind?: unknown; value?: unknown; language?: unknown } | null;
    if (!marked || typeof marked !== "object" || typeof marked.value !== "string") continue;
    if (!marked.value.trim()) continue;
    if (typeof marked.language === "string" && marked.language) {
      out.push("```" + marked.language + "\n" + marked.value + "\n```");
    } else if (marked.kind === "plaintext") {
      out.push("```\n" + marked.value + "\n```");
    } else {
      out.push(marked.value);
    }
  }
  const seen = new Set<string>();
  return out.filter((entry) => {
    const key = entry.trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n\n").trim();
}

export function normalizeDocumentSymbols(result: unknown): AnalysisSymbol[] {
  const flat = flattenDocumentSymbols(result, 0);
  flat.sort((a, b) => a.lineIndex - b.lineIndex || b.endLineIndex - a.endLineIndex);
  const byContainment = flat.map((symbol) => ({
    ...symbol,
    depth: flat.filter((other) => other !== symbol
      && other.lineIndex <= symbol.lineIndex
      && symbol.endLineIndex <= other.endLineIndex
      && (other.lineIndex < symbol.lineIndex || symbol.endLineIndex < other.endLineIndex)).length,
  }));
  if (byContainment.some((symbol) => symbol.depth > 0)) return byContainment;
  const names = new Set(flat.map((symbol) => symbol.name));
  return byContainment.map((symbol) => ({
    ...symbol,
    depth: symbol.container && symbol.container !== symbol.name && names.has(symbol.container) ? 1 : 0,
  }));
}

function flattenDocumentSymbols(result: unknown, depth: number): AnalysisSymbol[] {
  const values = Array.isArray(result) ? (result as LspDocumentSymbolLike[]) : [];
  const out: AnalysisSymbol[] = [];
  for (const value of values) {
    const name = typeof value?.name === "string" ? value.name : "";
    if (!name) continue;
    const selection = value.selectionRange?.start ?? value.range?.start ?? value.location?.range?.start;
    const end = value.range?.end ?? value.location?.range?.end;
    const lineIndex = Math.max(0, Number(selection?.line) || 0);
    out.push({
      name,
      detail: typeof value.detail === "string" && value.detail ? value.detail : undefined,
      kind: lspSymbolKindName(value.kind),
      lineIndex,
      column: Math.max(0, Number(selection?.character) || 0),
      endLineIndex: Math.max(lineIndex, Number(end?.line) || lineIndex),
      depth,
      container: typeof value.containerName === "string" && value.containerName ? value.containerName : undefined,
    });
    if (Array.isArray(value.children) && value.children.length) {
      out.push(...flattenDocumentSymbols(value.children, depth + 1));
    }
  }
  return out;
}

export function normalizeLocationResult(result: unknown, root: string): AnalysisLocation[] {
  const values = Array.isArray(result) ? result : result && typeof result === "object" ? [result] : [];
  const out: AnalysisLocation[] = [];
  for (const value of values as LspLocationLike[]) {
    const nested = value.location;
    const uri = value.targetUri || value.uri || nested?.uri;
    const range = value.targetSelectionRange || value.targetRange || value.range || nested?.range;
    if (!uri || !range?.start) continue;
    const target = uri.startsWith("phar://") ? `file://${uri.slice("phar://".length)}` : uri;
    if (!target.startsWith("file:")) {
      externalUris.add(target);
      out.push({
        path: target,
        external: true as const,
        lineIndex: nonNegativeInt(range.start.line) ?? 0,
        column: nonNegativeInt(range.start.character) ?? 0,
        endLineIndex: nonNegativeInt(range.end?.line) ?? nonNegativeInt(range.start.line) ?? 0,
        endColumn: nonNegativeInt(range.end?.character) ?? nonNegativeInt(range.start.character) ?? 0,
        name: value.name,
      });
      continue;
    }
    let absolute: string;
    try { absolute = fileURLToPath(target); } catch { continue; }
    let canonicalRoot: string;
    let canonicalAbsolute: string;
    try { canonicalRoot = realpathSync(root); } catch { canonicalRoot = resolve(root); }
    try { canonicalAbsolute = realpathSync(absolute); } catch { canonicalAbsolute = resolve(absolute); }
    if (canonicalAbsolute === canonicalRoot) continue;
    const rel = relative(canonicalRoot, canonicalAbsolute).replace(/\\/g, "/");
    const inside = Boolean(rel) && !rel.startsWith("../") && resolve(canonicalRoot, rel) === canonicalAbsolute;
    const libraryPath = canonicalAbsolute.replace(/\\/g, "/");
    if (!inside) libraryPaths.add(libraryPath);
    out.push({
      path: inside ? rel : libraryPath,
      ...(inside ? {} : { library: true as const }),
      lineIndex: nonNegativeInt(range.start.line) ?? 0,
      column: nonNegativeInt(range.start.character) ?? 0,
      endLineIndex: nonNegativeInt(range.end?.line) ?? nonNegativeInt(range.start.line) ?? 0,
      endColumn: nonNegativeInt(range.end?.character) ?? nonNegativeInt(range.start.character) ?? 0,
      name: value.name,
      kind: value.kind,
    });
  }
  return out;
}
