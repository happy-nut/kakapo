import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { languageForPath } from "./util.js";

export type AnalysisLocation = {
  path: string;
  lineIndex: number;
  column: number;
  endLineIndex?: number;
  endColumn?: number;
  name?: string;
  kind?: number;
  text?: string;
};

export type LanguageServerCommand = {
  family: string;
  name: string;
  command: string;
  args: string[];
  source?: "override" | "project" | "bundled" | "path";
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
const BUNDLED_TYPESCRIPT_SERVER = fileURLToPath(
  new URL("../node_modules/typescript-language-server/lib/cli.mjs", import.meta.url),
);

function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
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
  if (ext === ".rb") return "ruby";
  if (ext === ".php") return "php";
  return undefined;
}

const SERVER_SPECS: Record<string, Array<{ binary: string; args: string[] }>> = {
  typescript: [{ binary: "typescript-language-server", args: ["--stdio"] }],
  python: [{ binary: "pyright-langserver", args: ["--stdio"] }, { binary: "pylsp", args: [] }],
  go: [{ binary: "gopls", args: [] }],
  rust: [{ binary: "rust-analyzer", args: [] }],
  clang: [{ binary: "clangd", args: [] }],
  java: [{ binary: "jdtls", args: [] }],
  kotlin: [{ binary: "kotlin-language-server", args: [] }],
  ruby: [{ binary: "solargraph", args: ["stdio"] }],
  php: [{ binary: "intelephense", args: ["--stdio"] }],
};

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
  if (server.family !== "typescript" || server.name !== "typescript-language-server") return server;
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

export function resolveBundledLanguageServer(path: string): LanguageServerCommand | undefined {
  if (familyForPath(path) !== "typescript" || !existsSync(BUNDLED_TYPESCRIPT_SERVER)) return undefined;
  return {
    family: "typescript",
    name: "typescript-language-server",
    command: process.execPath,
    args: [BUNDLED_TYPESCRIPT_SERVER, "--stdio"],
    source: "bundled",
    // Electron's executable becomes a Node-compatible sidecar host without relying on a GUI app's PATH.
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

// An explicit override wins, then a project-local server. TypeScript/JavaScript has a packaged sidecar
// so it stays semantic even when the reviewed project has no LSP executable. PATH remains useful for all
// other language environments, and unsupported/unavailable servers fall back in ProjectAnalysis.
export function resolveLanguageServer(
  root: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LanguageServerCommand | undefined {
  const family = familyForPath(path);
  if (!family) return undefined;
  const suffix = platform === "win32" ? ".cmd" : "";
  const projectDirs = [
    join(root, "node_modules", ".bin"),
    join(root, ".venv", platform === "win32" ? "Scripts" : "bin"),
    join(root, "venv", platform === "win32" ? "Scripts" : "bin"),
    join(root, "bin"),
  ];
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const override = env[`MONACORI_LSP_${family.toUpperCase()}`];
  if (override && existsSync(override) && executable(override)) {
    const spec = SERVER_SPECS[family]?.[0];
    if (spec) return nodeHostedCommand(resolvedCommand(family, spec.binary, override, spec.args, "override"));
  }
  for (const spec of SERVER_SPECS[family] ?? []) {
    const command = projectDirs
      .map((dir) => join(dir, spec.binary + suffix))
      .find((candidate) => existsSync(candidate) && executable(candidate));
    if (command) return nodeHostedCommand(resolvedCommand(family, spec.binary, command, spec.args, "project"));
  }
  const bundled = resolveBundledLanguageServer(path);
  if (bundled) return bundled;
  for (const spec of SERVER_SPECS[family] ?? []) {
    const command = pathDirs
      .map((dir) => join(dir, spec.binary + suffix))
      .find((candidate) => existsSync(candidate) && executable(candidate));
    if (command) return nodeHostedCommand(resolvedCommand(family, spec.binary, command, spec.args, "path"));
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

export class LspClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, PendingRequest>();
  private started?: Promise<void>;
  private opened = new Map<string, number>();
  private documentSync = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    readonly root: string,
    readonly server: LanguageServerCommand,
  ) {}

  async locations(
    method: "textDocument/definition" | "textDocument/references" | "textDocument/implementation",
    path: string,
    lineIndex: number,
    column: number,
  ): Promise<AnalysisLocation[]> {
    await this.ensureDocument(path);
    const uri = pathToFileURL(resolve(this.root, path)).href;
    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line: Math.max(0, lineIndex), character: Math.max(0, column) },
    };
    if (method === "textDocument/references") params.context = { includeDeclaration: false };
    const result = await this.request(method, params);
    return normalizeLocationResult(result, this.root);
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
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    try { this.notify("exit", null); } catch { /* best effort */ }
    try { this.child?.kill(); } catch { /* best effort */ }
    this.failPending(new Error(`${this.server.name} stopped`));
  }

  private async ensureDocument(path: string): Promise<void> {
    await this.start();
    const absolute = resolve(this.root, path);
    const uri = pathToFileURL(absolute).href;
    const pending = this.documentSync.get(uri);
    if (pending) { await pending; return; }
    const sync = Promise.resolve().then(() => {
      const stat = statSync(absolute);
      const version = Math.max(1, Math.trunc(stat.mtimeMs));
      if (this.opened.get(uri) === version) return;
      const text = readFileSync(absolute, "utf8");
      if (!this.opened.has(uri)) {
        this.notify("textDocument/didOpen", { textDocument: { uri, languageId: lspLanguageId(path), version, text } });
      } else {
        this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
      }
      this.opened.set(uri, version);
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
      });
      this.child = child;
      child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
      child.stderr.on("data", () => { /* language-server diagnostics are intentionally not surfaced */ });
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
        clientInfo: { name: "monacori" },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: this.root.split(/[\\/]/).pop() || "workspace" }],
        capabilities: {
          workspace: { symbol: {} },
          textDocument: { definition: { linkSupport: true }, references: {}, implementation: { linkSupport: true } },
        },
      }).then(() => {
        this.notify("initialized", {});
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`${this.server.name} timed out during ${method}`));
      }, REQUEST_TIMEOUT_MS);
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

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error(`${this.server.name} input is closed`);
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
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
      result = items.map(() => ({ tabSize: 2, insertSpaces: true }));
    } else if (message.method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.root).href, name: this.root.split(/[\\/]/).pop() || "workspace" }];
    } else if (message.method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "Monacori analysis is read-only" };
    }
    try { this.send({ jsonrpc: "2.0", id: message.id, result }); } catch { /* process failure is handled elsewhere */ }
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
    let absolute: string;
    try { absolute = uri.startsWith("file:") ? fileURLToPath(uri) : uri; } catch { continue; }
    // Language servers commonly canonicalize symlinks (macOS also reports /private/var for /var).
    // Compare canonical paths so valid in-workspace results are not discarded, while still rejecting
    // every location that escapes the review root.
    let canonicalRoot: string;
    let canonicalAbsolute: string;
    try { canonicalRoot = realpathSync(root); } catch { canonicalRoot = resolve(root); }
    try { canonicalAbsolute = realpathSync(absolute); } catch { canonicalAbsolute = resolve(absolute); }
    const rel = relative(canonicalRoot, canonicalAbsolute).replace(/\\/g, "/");
    if (!rel || rel.startsWith("../") || resolve(canonicalRoot, rel) !== canonicalAbsolute) continue;
    out.push({
      path: rel,
      lineIndex: Math.max(0, Number(range.start.line) || 0),
      column: Math.max(0, Number(range.start.character) || 0),
      endLineIndex: Math.max(0, Number(range.end?.line) || Number(range.start.line) || 0),
      endColumn: Math.max(0, Number(range.end?.character) || Number(range.start.character) || 0),
      name: value.name,
      kind: value.kind,
    });
  }
  return out;
}
