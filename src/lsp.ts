import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, extname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { errorMessage, languageForPath } from "./util.js";

export type AnalysisLocation = {
  path: string;
  lineIndex: number;
  column: number;
  endLineIndex?: number;
  endColumn?: number;
  name?: string;
  kind?: number;
  text?: string;
  // The definition lives outside the review root — a dependency, a stdlib, a bundled type stub. `path` is
  // then an absolute filesystem path instead of a repo-relative one, and the file opens read-only.
  library?: true;
  // The definition is not a file at all: a compiled class inside a JDK image (`jrt:`) or a dependency
  // archive (`jar:`), which is what a JVM language server answers with for anything outside the project.
  // `path` is the URI verbatim. There is no source to show, and saying so is the whole point of the flag —
  // the alternative is reporting "definition not found" for an answer the server did give.
  external?: true;
};

// `jrt:/…/jbr/Contents/Home!/java.base/java/time/Instant.class` -> `java.base/java/time/Instant.class`,
// `jar:file:/…/guava-33.jar!/com/google/common/base/Joiner.class` -> `guava-33.jar / com/google/…`.
// Everything before the `!` is where the archive happens to live on this machine, which tells the reviewer
// nothing about the symbol.
export function externalLocationLabel(uri: string): string {
  const bang = uri.indexOf("!/");
  if (bang < 0) return uri.replace(/^[a-z]+:\/*/i, "");
  const inner = uri.slice(bang + 2);
  const archive = uri.slice(0, bang).split("/").pop() || "";
  return archive && /\.(jar|zip)$/i.test(archive) ? `${archive} / ${inner}` : inner;
}

// Every path a language server has pointed at outside the review root. Following a definition into library
// code reads a file the review root does not contain, so the renderer is never allowed to name one itself:
// it may only ask for a path a server already returned in this session. Navigation stays unrestricted —
// this only keeps the library reader from becoming a general "read any absolute path" IPC.
const libraryPaths = new Set<string>();

/** True for a path some language server reported as a definition outside the review root. */
export function isKnownLibraryPath(path: string): boolean {
  return libraryPaths.has(path.replace(/\\/g, "/"));
}

/** Test seam: forget the session's library paths. */
export function resetKnownLibraryPaths(): void {
  libraryPaths.clear();
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

// A language-server diagnostic normalized to Kakapo's 0-based line/column model. The renderer draws these
// as wavy underlines and lets the reviewer step between them; only error/warning are surfaced by default.
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

const DIAGNOSTIC_SEVERITY: DiagnosticSeverity[] = ["error", "warning", "info", "hint"];

function nonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

// LSP `code` may be a string, a number, or a { value } object depending on the server. Normalize to a string.
function diagnosticCode(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  if (raw && typeof raw === "object" && "value" in raw) {
    const value = (raw as { value?: unknown }).value;
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
}

// Import/module-resolution diagnostics depend on the project's runtime environment — the venv, node_modules, or
// interpreter — which Kakapo deliberately does not own: it runs bundled analyzers, never the project's
// toolchain, and does not configure a Python interpreter for Pyright. In a review context these fire on
// perfectly-installed packages ("Import 'pandas' could not be resolved"), so they are dropped as unreliable.
// Everything that does NOT need a resolved environment — syntax errors, undefined names, type mismatches within
// the file — still surfaces. Matched by rule/code first, with a message fallback for server-version drift.
const IMPORT_RESOLUTION_CODES = new Set([
  "reportMissingImports",      // Pyright: "Import \"X\" could not be resolved"
  "reportMissingModuleSource", // Pyright: an installed stub whose source module isn't found
  "2307",                      // tsserver: "Cannot find module 'x' or its type declarations"
  "2792",                      // tsserver: "Cannot find module 'x'. Did you mean to set 'moduleResolution'?"
]);
// The same environment, one step further in. An unresolved @types package does not only break `import`
// statements — it takes the AMBIENT declarations with it, and those fire on ordinary code that names a
// global. Measured on this project's own src/lsp.ts with node_modules absent: 63 errors, of which 42 were
// "Cannot find name 'process'. Do you need to install type definitions for node?" and 12 were "Cannot find
// namespace 'NodeJS'" — 54 of 63 markers, every one of them an artifact of kakapo running a bundled
// tsserver that does not own the project's node_modules. That is the exact condition the codes above were
// chosen for; these messages just were not in the net, so the policy held for imports and leaked
// everywhere else.
//
// Matched on the MESSAGE, not the code: 2591 is "Cannot find name 'x'" in general, which is a real error
// worth seeing. The sentence tsserver appends when it is a missing type package is what distinguishes the
// two, and it is the same sentence in every version that emits it.
const MISSING_TYPE_PACKAGE = /do you need to install type definitions|try `?npm i --save-dev @types\//i;
// Ambient namespaces that only exist because of a type package. Listed rather than pattern-matched: a
// namespace this project's own code defines and misspells should still be reported.
const AMBIENT_TYPE_NAMESPACES = /cannot find namespace '(NodeJS|jest|Mocha|Chai|Cypress|Express|React)'/i;
function isImportResolutionDiagnostic(code: string, message: string): boolean {
  if (code && IMPORT_RESOLUTION_CODES.has(code)) return true;
  if (MISSING_TYPE_PACKAGE.test(message) || AMBIENT_TYPE_NAMESPACES.test(message)) return true;
  return /could not be resolved|cannot find module/i.test(message);
}

// Translate raw LSP `PublishDiagnosticsParams.diagnostics` into the compact renderer shape. Diagnostics with
// no usable range or empty message are dropped rather than guessed at. LSP severity is 1..4 (Error..Hint);
// a missing severity defaults to Error, matching how mainstream editors treat unlabeled diagnostics.
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
    if (isImportResolutionDiagnostic(code, message)) continue; // environment-dependent noise, not a real defect
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
};

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
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
// Starting a bundled native server is materially heavier than an interactive navigation request. Under the
// full parallel test suite (and on a busy review workstation) Phpactor/JDT may spend more than eight seconds
// loading their runtime before replying to initialize. Give startup its own budget while keeping normal
// definition/reference requests fail-fast so a broken server cannot freeze navigation for twenty seconds.
const INITIALIZE_TIMEOUT_MS = 20_000;
// How long a stopped server may take to exit on its own before it is killed outright.
const STOP_GRACE_MS = 2_000;
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_BUNDLED_SERVER_ROOT = join(APP_ROOT, "vendor", "language-servers");

type ServerSpec = { binary: string; args: string[] };
type BundledServerContext = {
  root: string;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
};

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

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

// No --max-old-space-size here, deliberately. Capping a node-hosted server's heap looks like an easy win and
// is not one: over repeat runs on a 3200-file Python repo, pyright's footprint spread 675-956 MB uncapped and
// 722-859 MB under 2048 — the run-to-run spread is wider than the gap between the settings, so the cap buys
// nothing measurable. What it does buy is an abort: 512 dies of heap exhaustion, and a server that dies stays
// dead for the session (failedServers). V8's own default already ceilings the heap.

// Per-family LSP initializationOptions, applied whether the server came from the bundle or from PATH.
// typescript-language-server's automatic type acquisition spawns a third process (typingsInstaller, 34 MB)
// that npm-installs @types packages and watches node_modules for changes — a background download and a pile
// of fs watchers in aid of a read-only review. A whole process gone is a real saving, unlike a heap flag.
const INIT_OPTIONS: Record<string, Record<string, unknown>> = {
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

function projectCacheKey(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
}

// Native sidecars may need OS tools such as git, but never inherit arbitrary user PATH entries.
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
    return {
      family,
      name: "gopls",
      command,
      args: [],
      source: "bundled",
      env: {
        GOROOT: join(base, "go"),
        GOCACHE: join(tmpdir(), "kakapo-go", projectCacheKey(context.root), "build"),
        GOMODCACHE: join(tmpdir(), "kakapo-go", projectCacheKey(context.root), "modules"),
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
    return {
      ...resolvedCommand(family, "rust-analyzer", command, [], "bundled"),
      env: {
        CARGO_HOME: cargoHome,
        RUSTUP_HOME: rustupHome,
        RUSTUP_TOOLCHAIN: "stable",
        CARGO_TARGET_DIR: join(tmpdir(), "kakapo-rust", projectCacheKey(context.root), "target"),
        PATH: `${join(cargoHome, "bin")}${delimiter}${SYSTEM_TOOL_PATH}`,
      },
    };
  }
  if (family === "clang") {
    const command = join(base, "bin", "clangd");
    if (!executable(command)) return undefined;
    // The macOS clangd archive is self-contained; only the Ubuntu build needed LD_LIBRARY_PATH pointed
    // at the runtime closure beside it, and that build went with the Linux packaging.
    return resolvedCommand(family, "clangd", command, [], "bundled");
  }
  if (family === "java") {
    const javaHome = join(base, "jre");
    const java = join(javaHome, "bin", "java");
    const launcher = join(base, "jdtls", "plugins", "org.eclipse.equinox.launcher.jar");
    const configuration = join(base, "jdtls", "config_mac");
    if (!executable(java) || !existsSync(launcher) || !existsSync(configuration)) return undefined;
    const data = join(tmpdir(), "kakapo-jdtls", projectCacheKey(context.root));
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
      env: { JAVA_HOME: javaHome },
    };
  }
  if (family === "kotlin") {
    const command = join(base, "bin", "intellij-server");
    const systemPath = join(tmpdir(), "kakapo-kotlin", projectCacheKey(context.root));
    return executable(command)
      ? resolvedCommand(family, "kotlin-lsp", command, ["--stdio", "--system-path", systemPath], "bundled")
      : undefined;
  }
  if (family === "ruby") {
    const command = join(base, "sorbet");
    return executable(command)
      ? resolvedCommand(family, "sorbet", command, [
        "--lsp", "--disable-watchman", "--cache-dir", join(tmpdir(), "kakapo-sorbet", projectCacheKey(context.root)), "--dir", ".",
      ], "bundled")
      : undefined;
  }
  if (family === "php") {
    const command = join(base, "php");
    const phpactor = join(base, "phpactor.phar");
    const cacheRoot = join(tmpdir(), "kakapo-phpactor", projectCacheKey(context.root));
    return executable(command) && existsSync(phpactor)
      ? {
        ...resolvedCommand(family, "phpactor", command, [phpactor, "language-server"], "bundled"),
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
      // Electron's executable becomes a Node-compatible sidecar host without relying on a GUI app's PATH.
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return bundledNativeCommand(family, { root, env, platform, arch });
}

// An explicit developer override wins. Normal app execution is bundle-first so semantic analysis never
// depends on the shell PATH inherited by a GUI process.
//
// The project-local fallback below — `<root>/node_modules/.bin`, `<root>/.venv/bin`, `<root>/bin` — is a
// developer convenience for a source checkout whose platform sidecar bundle is not installed yet, and it
// resolves an executable from INSIDE the repository being reviewed. kakapo's whole premise is reading code
// you have not read yet, and the analysis prewarm starts a server on its own after the review paints, so a
// repo shipping `bin/gopls` would have run with no click at all. It now takes an explicit opt-in: a
// reviewer who means to run a checkout's own servers says so once, in the environment, the same way the
// per-family KAKAPO_LSP_* overrides work. Without it, "no server available" is the answer.
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

// Process-group leaders of every running server. Quitting tears the app down without visiting each window's
// dispose path, and on POSIX a child outlives its parent — that is how weeks of use accumulate orphaned
// JVMs. An 'exit' handler must be synchronous, so kill the groups outright: the app is already leaving.
const liveServerGroups = new Set<number>();
process.once("exit", () => {
  for (const pid of liveServerGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch { /* already gone */ }
  }
  reapEscapedGradleDaemons();
});

// The bundled Kotlin server's project import runs Gradle, and a Gradle daemon puts itself in a new session
// (observed PPID 1, PGID = its own pid) precisely so it outlives the build that started it. Signalling the
// server's process group therefore cannot reach it: issue #24 left one holding 500 MB for hours, and this
// machine had accumulated 15 daemon logs from our JVM. Nothing but Kakapo runs the JVM we bundle, so match on
// that path — and only on daemons, since a daemon is a restartable cache while a language server is not.
export function reapEscapedGradleDaemons(bundleDir = bundledKotlinDir()): void {
  // Synchronous by necessity: this also runs from an 'exit' handler, where nothing async can still land.
  const found = spawnSync("pgrep", ["-f", `^${bundleDir}/.*GradleDaemon`], { encoding: "utf8" });
  for (const line of found.stdout?.split("\n") ?? []) {
    const pid = Number(line.trim());
    if (!pid) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function bundledKotlinDir(): string {
  return join(bundledRoot(process.env), `${process.platform}-${process.arch}`, "kotlin");
}

export class LspClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private started?: Promise<void>;
  private opened = new Map<string, { mtimeMs: number; version: number }>();
  private documentSync = new Map<string, Promise<void>>();
  private stopped = false;
  private workspaceQuiescent = false;
  private workspaceWaiters = new Set<() => void>();
  private startupGrace?: Promise<void>;
  private initialNavigationSettled = false;
  // Diagnostics are pushed by the server via textDocument/publishDiagnostics, not pulled per request. Keep the
  // latest set per document URI plus per-URI waiters so a first read can await the initial publish once.
  private diagnostics = new Map<string, unknown[]>();
  private publishedUris = new Set<string>();
  private diagnosticWaiters = new Map<string, Set<() => void>>();

  constructor(
    readonly root: string,
    readonly server: LanguageServerCommand,
  ) {}

  /** PID of the live server process, if any — the memory watchdog (app-main.ts) weighs fleets by these. */
  serverPid(): number | undefined {
    const child = this.child;
    return child && child.pid && child.exitCode === null && child.signalCode === null ? child.pid : undefined;
  }

  async locations(
    method: "textDocument/definition" | "textDocument/references" | "textDocument/implementation",
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
      // Both servers may acknowledge initialize while their first workspace scan is still committing its
      // index. An empty first answer is ambiguous, so retry it briefly once per client; later genuine misses
      // remain immediate and never turn ordinary navigation into a polling loop.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 400 * (attempt + 1)));
    }
    return [];
  }

  async workspaceSymbols(query: string): Promise<AnalysisLocation[]> {
    await this.start();
    const result = await this.request("workspace/symbol", { query: String(query ?? "") });
    return normalizeLocationResult(result, this.root);
  }

  async sourceDefinitions(path: string, lineIndex: number, column: number): Promise<AnalysisLocation[]> {
    await this.ensureDocument(path);
    const uri = pathToFileURL(resolve(this.root, path)).href;
    const result = await this.request("workspace/executeCommand", {
      command: "_typescript.goToSourceDefinition",
      arguments: [uri, { line: Math.max(0, lineIndex), character: Math.max(0, column) }],
    });
    return normalizeLocationResult(result, this.root);
  }

  async warmup(path: string): Promise<void> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
  }

  /**
   * Resolves true once the server has PUBLISHED diagnostics for `path` — which it only does after actually
   * analysing the file, so it is the honest signal that the project index exists. `warmup` above gets a
   * server as far as acknowledging `initialize`, and that is a different thing: a cold JDT or rust-analyzer
   * answers the handshake in milliseconds and then spends a long time building its model, during which a
   * definition request either times out or comes back empty.
   *
   * The budget is generous because nothing is waiting on this — it runs after the review has painted, to
   * get the indexing over with before the reviewer's first keystroke rather than during it. False means the
   * budget ran out, not that the server is broken: some servers never diagnose some files.
   */
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

  // Return the latest diagnostics for a document. Opening it triggers the server's first publish; on the very
  // first read we wait (bounded) for that publish so the reviewer isn't shown "no problems" prematurely.
  async diagnosticsFor(path: string): Promise<LspDiagnostic[]> {
    await this.ensureDocument(path);
    await this.waitForWorkspaceReady();
    const uri = pathToFileURL(resolve(this.root, path)).href;
    if (!this.publishedUris.has(uri)) await this.waitForFirstDiagnostics(uri);
    return mapLspDiagnostics(this.diagnostics.get(uri));
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
      // Most servers publish within milliseconds of didOpen; a clean file publishes an empty set. Cap the wait
      // so a server that never diagnoses this document (or is still indexing) cannot stall the request.
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
    try { this.notify("exit", null); } catch { /* best effort */ }
    this.killTree();
    this.failPending(new Error(`${this.server.name} stopped`));
  }

  // Several servers are launchers that fork the real engine as their own child (the bundled Kotlin server
  // runs a JBR JVM; typescript-language-server runs tsserver and typingsInstaller). A well-behaved one
  // tears its children down on SIGTERM — measured: tsserver's two children always went with it. One that
  // does not left the engine running on PPID 1, which is how issue #24 caught a 253 MB Kotlin process
  // outliving by hours the app session that started it. Signalling the group covers both kinds, so a
  // server's cleanup manners stop being load-bearing.
  private killTree(): void {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch { /* already gone */ }
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
      const stat = statSync(absolute);
      const opened = this.opened.get(uri);
      if (opened?.mtimeMs === stat.mtimeMs) return;
      // LSP versions are monotonically increasing signed integers. A millisecond epoch exceeds the
      // 32-bit integer accepted by JetBrains' Kotlin server, so keep mtime only for change detection.
      const version = opened ? opened.version + 1 : 1;
      const text = readFileSync(absolute, "utf8");
      if (!opened) {
        this.notify("textDocument/didOpen", { textDocument: { uri, languageId: lspLanguageId(path), version, text } });
      } else {
        this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
        // The diagnostics held for this uri describe the version that just stopped existing, at ITS line
        // numbers. Keeping them — and keeping the uri in publishedUris, which is what tells diagnosticsFor
        // not to wait — meant the next read answered from the previous version: an agent fixed a type error,
        // the watch rebuild re-read the file, and the squiggle stayed, parked on whatever line had moved
        // into its place. Forget both, so the next read waits for the server's fresh publish.
        this.diagnostics.delete(uri);
        this.publishedUris.delete(uri);
      }
      this.opened.set(uri, { mtimeMs: stat.mtimeMs, version });
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
      const child = spawn(this.server.command, this.server.args, {
        cwd: this.root,
        env: { ...process.env, ...this.server.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Own process group, so killTree() can reap the server's own children (tsserver, the Kotlin JVM)
        // instead of orphaning them. stdio stays piped, so this is not a true detach.
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
        // Opt-in diagnostics are useful for validating a newly bundled server without polluting the app UI.
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
          // Servers push textDocument/publishDiagnostics on didOpen regardless; declaring the client capability
          // just advertises support so servers that gate the notification on it still send it.
          textDocument: {
            definition: { linkSupport: true },
            references: {},
            implementation: { linkSupport: true },
            publishDiagnostics: { relatedInformation: false },
          },
        },
      }).then(() => {
        this.notify("initialized", {});
        this.notify("workspace/didChangeConfiguration", { settings: {} });
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
        // Native servers such as rust-analyzer acknowledge initialize before their workspace model is
        // loaded. Treat only their explicit transient responses as retryable; transport failures still
        // quarantine the process immediately in ProjectAnalysis.
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
      if (message.error) pending.reject(new Error(message.error.message || "language server request failed"));
      else pending.resolve(message.result);
    }
  }

  private replyToServerRequest(message: JsonRpcMessage): void {
    let result: unknown = null;
    if (message.method === "workspace/configuration") {
      const items = Array.isArray((message.params as { items?: unknown[] } | undefined)?.items)
        ? (message.params as { items: unknown[] }).items
        : [];
      result = items.map(() => ({}));
    } else if (message.method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.root).href, name: this.root.split(/[\\/]/).pop() || "workspace" }];
    } else if (message.method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "Kakapo analysis is read-only" };
    }
    try { this.send({ jsonrpc: "2.0", id: message.id, result }); } catch { /* process failure is handled elsewhere */ }
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
    if (message.method !== "experimental/serverStatus") return;
    const status = message.params as { quiescent?: boolean } | undefined;
    if (status?.quiescent !== true) return;
    this.workspaceQuiescent = true;
    for (const resolveWaiter of this.workspaceWaiters) resolveWaiter();
    this.workspaceWaiters.clear();
  }

  private async waitForWorkspaceReady(): Promise<void> {
    // These bundled servers do not publish a portable "workspace ready" notification. Their initialize
    // response only means the protocol is live, not that definitions are queryable. Keep the grace in the
    // background prewarm path so first-use navigation is deterministic on slower workstations.
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
        // Older rust-analyzer builds do not emit experimental/serverStatus to every client. One bounded
        // grace period is enough for initial cargo metadata; never charge the delay again in this process.
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

export function normalizeLocationResult(result: unknown, root: string): AnalysisLocation[] {
  const values = Array.isArray(result) ? result : result && typeof result === "object" ? [result] : [];
  const out: AnalysisLocation[] = [];
  for (const value of values as LspLocationLike[]) {
    const nested = value.location;
    const uri = value.targetUri || value.uri || nested?.uri;
    const range = value.targetSelectionRange || value.targetRange || value.range || nested?.range;
    if (!uri || !range?.start) continue;
    // A non-file URI is not a path, and treating it as one is how this failed: resolve() read
    // "jrt:/…/Instant.class" as a RELATIVE path and prefixed the working directory, producing
    // "<repo>/jrt:/…/Instant.class" — a path that exists nowhere. The read that followed came back empty,
    // and the text filter in navigationLocations dropped the location for having no visible characters.
    // So Kotlin and Java reported "definition not found" for every stdlib and dependency symbol, while the
    // server had answered correctly every time.
    if (!uri.startsWith("file:")) {
      out.push({
        path: uri,
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
    try { absolute = fileURLToPath(uri); } catch { continue; }
    // Language servers commonly canonicalize symlinks (macOS also reports /private/var for /var).
    // Compare canonical paths so an in-workspace result is reported relative to the root, and anything
    // outside it is kept as a library location — an absolute path the reviewer can read but not edit.
    let canonicalRoot: string;
    let canonicalAbsolute: string;
    try { canonicalRoot = realpathSync(root); } catch { canonicalRoot = resolve(root); }
    try { canonicalAbsolute = realpathSync(absolute); } catch { canonicalAbsolute = resolve(absolute); }
    if (canonicalAbsolute === canonicalRoot) continue; // the root directory itself is not a location
    const rel = relative(canonicalRoot, canonicalAbsolute).replace(/\\/g, "/");
    const inside = Boolean(rel) && !rel.startsWith("../") && resolve(canonicalRoot, rel) === canonicalAbsolute;
    const libraryPath = canonicalAbsolute.replace(/\\/g, "/"); // one spelling, so a renderer round-trip still matches
    if (!inside) libraryPaths.add(libraryPath);
    out.push({
      path: inside ? rel : libraryPath,
      ...(inside ? {} : { library: true as const }),
      lineIndex: nonNegativeInt(range.start.line) ?? 0,
      column: nonNegativeInt(range.start.character) ?? 0,
      // `?? fallback`, not `|| fallback`: a range legitimately ENDS at character 0 of the next line, and
      // treating that 0 as missing reported the end at the start's column instead, overshooting the
      // highlight by however far into the line the symbol began.
      endLineIndex: nonNegativeInt(range.end?.line) ?? nonNegativeInt(range.start.line) ?? 0,
      endColumn: nonNegativeInt(range.end?.character) ?? nonNegativeInt(range.start.character) ?? 0,
      name: value.name,
      kind: value.kind,
    });
  }
  return out;
}
