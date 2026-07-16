import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  AnalysisLocation,
  LspClient,
  resolveBundledLanguageServer,
  resolveLanguageServer,
  type LanguageServerCommand,
} from "./lsp.js";
import { findRipgrepBinary, searchProject } from "./search.js";

export type AnalysisKind = "definition" | "references" | "implementation" | "workspaceSymbol" | "impact";

export type AnalysisRequest = {
  kind: AnalysisKind;
  path?: string;
  line?: number;
  column?: number;
  query?: string;
  symbol?: string;
  limit?: number;
};

export type ImpactEvidence = "semantic" | "heuristic";

export type ImpactItem = AnalysisLocation & {
  relation?: string;
  evidence: ImpactEvidence;
};
type RawImpactItem = Omit<ImpactItem, "evidence">;

export type ChangeImpact = {
  symbol: string;
  origin?: AnalysisLocation;
  callers: ImpactItem[];
  dependencies: ImpactItem[];
  implementations: ImpactItem[];
  tests: ImpactItem[];
  contracts: ImpactItem[];
  mentions: ImpactItem[];
};

export type AnalysisResponse = {
  ok: boolean;
  generation: number;
  durationMs: number;
  engine: "lsp" | "index";
  confidence: "semantic" | "mixed" | "heuristic";
  server?: string;
  serverSource?: LanguageServerCommand["source"];
  symbol?: string;
  locations: AnalysisLocation[];
  impact?: ChangeImpact;
  fallbackReason?: string;
  error?: string;
};

export type AnalysisPhase = "idle" | "starting" | "ready" | "fallback" | "failed";

export type AnalysisStatus = {
  generation: number;
  phase: AnalysisPhase;
  family?: string;
  server?: string;
  serverSource?: LanguageServerCommand["source"];
  fallbackReason?: string;
  error?: string;
  updatedAt: string;
};

type AnalysisResult = Omit<AnalysisResponse, "generation" | "durationMs">;

type SymbolRecord = AnalysisLocation & { name: string; symbolKind: string; declaration: string };
type IndexedFile = { path: string; content: string };
type RegexIndex = {
  files: Map<string, string>;
  definitions: Map<string, SymbolRecord[]>;
  symbols: SymbolRecord[];
};

type AnalysisOptions = {
  resolveServer?: (root: string, path: string) => LanguageServerCommand | undefined;
  files?: IndexedFile[];
  onStatus?: (status: AnalysisStatus) => void;
};

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".php", ".cs", ".swift", ".scala", ".vue", ".svelte",
  ".graphql", ".gql", ".proto", ".sql", ".json", ".yaml", ".yml", ".toml",
]);
const MAX_INDEX_FILES = 30_000;
const MAX_INDEX_FILE_BYTES = 1_000_000;
const MAX_LOCATIONS = 500;

const DECLARATION_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "class", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|annotation|static|export|default|expect|actual|value)\s+)*(class|interface|object|enum|trait|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "type", re: /^\s*(?:export\s+)?(interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "variable", re: /^\s*(?:export\s+)?(?:const|let|var|val)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "function", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\s+)*(?:fun|def|fn|func)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "method", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^=]+)?\s*(?:\{|=>)/ },
];

function declarationFromLine(path: string, line: string, lineIndex: number): SymbolRecord | undefined {
  for (const pattern of DECLARATION_PATTERNS) {
    const match = pattern.re.exec(line);
    if (!match) continue;
    const name = match[2] && ["class", "interface", "object", "enum", "trait", "struct", "type"].includes(match[1]) ? match[2] : match[1];
    if (!name || /^(if|for|while|switch|catch)$/.test(name)) continue;
    return {
      path,
      lineIndex,
      column: Math.max(0, line.indexOf(name)),
      name,
      symbolKind: pattern.kind === "class" ? String(match[1] || "class") : pattern.kind,
      declaration: line,
      text: line,
    };
  }
  return undefined;
}

export function buildRegexSymbolIndex(files: IndexedFile[]): RegexIndex {
  const fileMap = new Map<string, string>();
  const definitions = new Map<string, SymbolRecord[]>();
  const symbols: SymbolRecord[] = [];
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    fileMap.set(path, file.content);
    const lines = file.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const record = declarationFromLine(path, lines[lineIndex], lineIndex);
      if (!record) continue;
      symbols.push(record);
      const entries = definitions.get(record.name) ?? [];
      entries.push(record);
      definitions.set(record.name, entries);
    }
  }
  return { files: fileMap, definitions, symbols };
}

async function listProjectFiles(root: string): Promise<string[]> {
  const rg = findRipgrepBinary();
  if (!rg) return [];
  return new Promise((resolveFiles) => {
    const child = spawn(rg, ["--files", "--hidden", "--no-messages", "-g", "!.git/**", "-g", "!.monacori/**"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length < 20_000_000) output += chunk;
      else child.kill();
    });
    child.once("error", () => resolveFiles([]));
    child.once("close", () => {
      const files = output.split(/\r?\n/)
        .map((path) => path.trim().replace(/\\/g, "/"))
        .filter((path) => path && CODE_EXTENSIONS.has(extname(path).toLowerCase()))
        .slice(0, MAX_INDEX_FILES);
      resolveFiles(files);
    });
  });
}

async function buildProjectIndex(root: string): Promise<RegexIndex> {
  const paths = await listProjectFiles(root);
  const files: IndexedFile[] = [];
  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = paths.slice(offset, offset + 32);
    const loaded = await Promise.all(batch.map(async (path): Promise<IndexedFile | undefined> => {
      try {
        const content = await readFile(join(root, path), "utf8");
        if (Buffer.byteLength(content, "utf8") > MAX_INDEX_FILE_BYTES || content.includes("\0")) return undefined;
        return { path, content };
      } catch {
        return undefined;
      }
    }));
    for (const file of loaded) if (file) files.push(file);
    // Yield between batches so the Electron main loop can keep serving review/navigation IPC.
    await new Promise<void>((resolveBatch) => setImmediate(resolveBatch));
  }
  return buildRegexSymbolIndex(files);
}

function safeRelativePath(root: string, path: string | undefined): string | undefined {
  if (!path || isAbsolute(path)) return undefined;
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const absolute = resolve(root, normalized);
  const rel = relative(root, absolute).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../")) return undefined;
  return rel;
}

function identifierAt(text: string, column: number): string | undefined {
  const position = Math.max(0, Math.min(column, text.length));
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (position >= match.index && position <= match.index + match[0].length) return match[0];
  }
  return undefined;
}

function uniqueLocations<T extends AnalysisLocation>(items: T[], limit = MAX_LOCATIONS): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = `${item.path}\0${item.lineIndex}\0${item.column}\0${item.name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueImpactItems(items: ImpactItem[], limit = MAX_LOCATIONS): ImpactItem[] {
  const seen = new Set<string>();
  const out: ImpactItem[] = [];
  for (const item of items) {
    // A regex search may find the same symbol several times on one line. Review impact is line-oriented,
    // so showing those as separate relationships creates noise without adding evidence.
    const key = `${item.path}\0${item.lineIndex}\0${item.relation ?? ""}\0${item.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function testPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(path);
}

function contractPath(path: string): boolean {
  return /(^|\/)(types?|api|schema|schemas|config|configs)(\/|$)|(?:openapi|swagger|schema|config)|\.(?:graphql|gql|proto|json|ya?ml|toml)$/i.test(path);
}

function documentPath(path: string): boolean {
  return /\.(?:md|mdx|txt|rst|adoc)$/i.test(path) || /(^|\/)(docs?|documentation|notes?|release-notes)(\/|$)/i.test(path);
}

function apparentCall(text: string, symbol: string): boolean {
  return new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`).test(text);
}

export class ProjectAnalysis {
  private indexPromise?: Promise<RegexIndex>;
  private clients = new Map<string, LspClient>();
  private failedServers = new Set<string>();
  private readonly resolveServer: (root: string, path: string) => LanguageServerCommand | undefined;
  private readonly fixedFiles?: IndexedFile[];
  private readonly onStatus?: (status: AnalysisStatus) => void;
  private generation = 0;
  private status: AnalysisStatus = { generation: 0, phase: "idle", updatedAt: new Date().toISOString() };

  constructor(readonly root: string, options: AnalysisOptions = {}) {
    this.resolveServer = options.resolveServer ?? resolveLanguageServer;
    this.fixedFiles = options.files;
    this.onStatus = options.onStatus;
  }

  invalidate(): void {
    this.indexPromise = undefined;
    this.generation += 1;
    this.setStatus(this.status.phase, {
      family: this.status.family,
      server: this.status.server,
      serverSource: this.status.serverSource,
      fallbackReason: this.status.fallbackReason,
      error: this.status.error,
    });
  }

  getStatus(): AnalysisStatus {
    return { ...this.status };
  }

  dispose(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }

  // Start at most one process per resolved language-server command and open one changed document. The app
  // schedules this only after its review page loads, so semantic navigation is warm without delaying paint.
  async prewarm(paths: string[]): Promise<void> {
    const seen = new Set<string>();
    const jobs: Promise<void>[] = [];
    let unsupportedPath = "";
    for (const candidate of paths) {
      const path = safeRelativePath(this.root, candidate);
      if (!path) continue;
      const client = this.clientFor(path);
      if (!client) {
        unsupportedPath ||= path;
        continue;
      }
      const key = `${client.server.command}\0${client.server.args.join("\0")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(this.warmClient(path, client, new Set<string>()));
    }
    await Promise.all(jobs);
    if (!jobs.length && unsupportedPath) {
      this.setStatus("fallback", { fallbackReason: `No language server is available for ${unsupportedPath}` });
    }
  }

  async query(request: AnalysisRequest): Promise<AnalysisResponse> {
    const generation = this.generation;
    const started = performance.now();
    const result = await this.runQuery(request);
    return { ...result, generation, durationMs: Math.round((performance.now() - started) * 10) / 10 };
  }

  private async runQuery(request: AnalysisRequest): Promise<AnalysisResult> {
    const path = safeRelativePath(this.root, request.path);
    try {
      if (request.kind === "workspaceSymbol") return await this.workspaceSymbols(path, request.query ?? request.symbol ?? "", request.limit);
      if (!path) return { ok: false, engine: "index", confidence: "heuristic", locations: [], error: "A project-relative source path is required" };
      const context = await this.symbolContext(path, request.line, request.column, request.symbol);
      if (!context.symbol) return { ok: true, engine: "index", confidence: "heuristic", locations: [], symbol: "" };
      if (request.kind === "impact") return await this.impact(path, context.lineIndex, context.column, context.symbol);
      const method = request.kind === "definition"
        ? "textDocument/definition"
        : request.kind === "references"
          ? "textDocument/references"
          : "textDocument/implementation";
      const lsp = await this.lspLocations(path, context.lineIndex, context.column, method);
      if (lsp.locations.length) {
        return {
          ok: true,
          engine: "lsp",
          confidence: "semantic",
          server: lsp.server,
          serverSource: lsp.serverSource,
          symbol: context.symbol,
          locations: await this.withText(lsp.locations),
        };
      }
      const locations = request.kind === "definition"
        ? await this.fallbackDefinitions(context.symbol, path, context.lineIndex)
        : request.kind === "references"
          ? await this.fallbackReferences(context.symbol)
          : await this.fallbackImplementations(context.symbol);
      return {
        ok: true,
        engine: "index",
        confidence: "heuristic",
        symbol: context.symbol,
        locations,
        fallbackReason: lsp.fallbackReason ?? "Language server returned no semantic locations",
      };
    } catch (error) {
      return { ok: false, engine: "index", confidence: "heuristic", locations: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private setStatus(phase: AnalysisPhase, details: Omit<Partial<AnalysisStatus>, "phase" | "generation" | "updatedAt"> = {}): void {
    const next: AnalysisStatus = {
      generation: this.generation,
      phase,
      ...details,
      updatedAt: new Date().toISOString(),
    };
    const comparable = (value: AnalysisStatus) => JSON.stringify({
      generation: value.generation,
      phase: value.phase,
      family: value.family,
      server: value.server,
      serverSource: value.serverSource,
      fallbackReason: value.fallbackReason,
      error: value.error,
    });
    if (comparable(next) === comparable(this.status)) return;
    this.status = next;
    this.onStatus?.({ ...next });
  }

  private getIndex(): Promise<RegexIndex> {
    if (!this.indexPromise) this.indexPromise = this.fixedFiles
      ? Promise.resolve(buildRegexSymbolIndex(this.fixedFiles))
      : buildProjectIndex(this.root);
    return this.indexPromise;
  }

  private async symbolContext(path: string, line = 0, column = 0, explicit?: string): Promise<{ symbol?: string; lineIndex: number; column: number }> {
    const lineIndex = Math.max(0, Number(line) || 0);
    const col = Math.max(0, Number(column) || 0);
    if (explicit) return { symbol: explicit, lineIndex, column: col };
    let content = "";
    try { content = await readFile(join(this.root, path), "utf8"); } catch { /* fall through to index */ }
    const lines = content.split(/\r?\n/);
    const direct = identifierAt(lines[lineIndex] ?? "", col);
    if (direct) return { symbol: direct, lineIndex, column: Math.max(0, (lines[lineIndex] ?? "").indexOf(direct)) };
    const index = await this.getIndex();
    const enclosing = index.symbols
      .filter((item) => item.path === path && item.lineIndex <= lineIndex)
      .sort((a, b) => b.lineIndex - a.lineIndex)[0];
    return enclosing
      ? { symbol: enclosing.name, lineIndex: enclosing.lineIndex, column: enclosing.column }
      : { lineIndex, column: col };
  }

  private clientFor(path: string): LspClient | undefined {
    const primary = this.resolveServer(this.root, path);
    const servers = primary ? [primary] : [];
    if (primary?.family === "typescript" && primary.source && primary.source !== "bundled") {
      const bundled = resolveBundledLanguageServer(path);
      if (bundled) servers.push(bundled);
    }
    for (const server of servers) {
      const key = this.serverKey(server);
      if (this.failedServers.has(key)) continue;
      let client = this.clients.get(key);
      if (!client) {
        client = new LspClient(this.root, server);
        this.clients.set(key, client);
        this.setStatus("starting", {
          family: server.family,
          server: server.name,
          serverSource: server.source,
        });
      }
      return client;
    }
    return undefined;
  }

  private serverKey(server: LanguageServerCommand): string {
    return `${server.command}\0${server.args.join("\0")}`;
  }

  private quarantine(client: LspClient, error?: unknown): void {
    const key = this.serverKey(client.server);
    this.failedServers.add(key);
    this.clients.delete(key);
    client.dispose();
    this.setStatus("failed", {
      family: client.server.family,
      server: client.server.name,
      serverSource: client.server.source,
      error: error instanceof Error ? error.message : error ? String(error) : "Language server stopped",
    });
  }

  private transportFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /exited|stopped|not running|input is closed|timed out|ENOENT|EACCES/i.test(message);
  }

  private async warmClient(path: string, initial: LspClient, attempted: Set<string>): Promise<void> {
    let client: LspClient | undefined = initial;
    while (client) {
      const key = this.serverKey(client.server);
      if (attempted.has(key)) return;
      attempted.add(key);
      try {
        await client.warmup(path);
        this.setStatus("ready", {
          family: client.server.family,
          server: client.server.name,
          serverSource: client.server.source,
        });
        return;
      } catch (error) {
        this.quarantine(client, error);
        client = this.clientFor(path);
      }
    }
    this.setStatus("fallback", { fallbackReason: `No language server is available for ${path}` });
  }

  private async lspLocations(
    path: string,
    line: number,
    column: number,
    method: "textDocument/definition" | "textDocument/references" | "textDocument/implementation",
  ): Promise<{ server?: string; serverSource?: LanguageServerCommand["source"]; locations: AnalysisLocation[]; fallbackReason?: string }> {
    let attempted = false;
    let lastError = "";
    while (true) {
      const client = this.clientFor(path);
      if (!client) {
        const fallbackReason = lastError || (attempted
          ? "All available language servers failed"
          : `No language server is available for ${path}`);
        this.setStatus("fallback", { fallbackReason });
        return { locations: [], fallbackReason };
      }
      attempted = true;
      try {
        let locations = uniqueLocations(await client.locations(method, path, line, column));
        // tsserver commonly reports the local import binding first. Follow a single definition once so
        // Cmd/Ctrl+B reaches the exported declaration directly instead of requiring a second navigation.
        if (method === "textDocument/definition" && locations.length === 1) {
          const first = locations[0];
          const [withText] = await this.withText([first]);
          const importBinding = /^\s*import\b|^\s*export\s+(?:\{|\*)[^;]*\bfrom\b|\brequire\s*\(/.test(withText?.text ?? "");
          if (importBinding) {
            let followed: AnalysisLocation[] = [];
            if (client.server.family === "typescript") {
              try { followed = uniqueLocations(await client.sourceDefinitions(path, line, column)); } catch { /* standard LSP below */ }
            }
            if (!followed.length) {
              followed = uniqueLocations(await client.locations(method, first.path, first.lineIndex, first.column));
            }
            followed = followed.filter((item) => item.path !== first.path || item.lineIndex !== first.lineIndex || item.column !== first.column);
            if (followed.length) locations = followed;
          }
        }
        this.setStatus("ready", {
          family: client.server.family,
          server: client.server.name,
          serverSource: client.server.source,
        });
        return {
          server: client.server.name,
          serverSource: client.server.source,
          locations,
          fallbackReason: locations.length ? undefined : "Language server returned no semantic locations",
        };
      } catch (error) {
        // A server may legitimately omit one capability (commonly implementation). Keep it alive for
        // definition/references; only quarantine transport/process failures that cannot recover in-window.
        if (!this.transportFailure(error)) {
          const fallbackReason = error instanceof Error ? error.message : String(error);
          return { locations: [], fallbackReason };
        }
        lastError = error instanceof Error ? error.message : String(error);
        this.quarantine(client, error);
        // A failed project/PATH TypeScript server is followed by the packaged sidecar in clientFor().
      }
    }
  }

  private async workspaceSymbols(path: string | undefined, query: string, limit = 200): Promise<AnalysisResult> {
    let fallbackReason = path ? "Language server returned no workspace symbols" : "A source file is required to select a language server";
    if (path) {
      while (true) {
        const client = this.clientFor(path);
        if (!client) {
          fallbackReason = `No language server is available for ${path}`;
          this.setStatus("fallback", { fallbackReason });
          break;
        }
        try {
          const locations = uniqueLocations(await client.workspaceSymbols(query), Math.max(1, Math.min(Number(limit) || 200, 500)));
          this.setStatus("ready", {
            family: client.server.family,
            server: client.server.name,
            serverSource: client.server.source,
          });
          if (locations.length) {
            return {
              ok: true,
              engine: "lsp",
              confidence: "semantic",
              server: client.server.name,
              serverSource: client.server.source,
              locations: await this.withText(locations),
            };
          }
          break;
        } catch (error) {
          fallbackReason = error instanceof Error ? error.message : String(error);
          if (!this.transportFailure(error)) break;
          this.quarantine(client, error);
        }
      }
    }
    const needle = query.trim().toLowerCase();
    const index = await this.getIndex();
    const locations = index.symbols
      .filter((item) => !needle || item.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, Math.min(Number(limit) || 200, 500)))
      .map((item) => ({ ...item, kind: undefined }));
    return { ok: true, engine: "index", confidence: "heuristic", locations, fallbackReason };
  }

  private async fallbackDefinitions(symbol: string, currentPath: string, line: number): Promise<AnalysisLocation[]> {
    const index = await this.getIndex();
    const hits = index.definitions.get(symbol) ?? [];
    return hits
      .slice()
      .sort((a, b) => Number(b.path === currentPath) - Number(a.path === currentPath) || Math.abs(a.lineIndex - line) - Math.abs(b.lineIndex - line))
      .map((item) => ({ ...item }));
  }

  private async fallbackReferences(symbol: string): Promise<AnalysisLocation[]> {
    const result = await searchProject(this.root, symbol, MAX_LOCATIONS + 1);
    const matches = result.matches.filter((match) => {
      const before = match.text.charAt(match.column - 2);
      const after = match.text.charAt(match.endColumn - 1);
      return !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
    });
    return uniqueLocations(matches.map((match) => ({
      path: match.path,
      lineIndex: match.line - 1,
      column: match.column - 1,
      endColumn: match.endColumn - 1,
      text: match.text,
    })));
  }

  private async fallbackImplementations(symbol: string): Promise<AnalysisLocation[]> {
    const index = await this.getIndex();
    const re = new RegExp(`\\b(?:extends|implements)\\s+[^\\n{]*\\b${escapeRegExp(symbol)}\\b`);
    return index.symbols
      .filter((item) => re.test(item.declaration) || (item.name === symbol && ["class", "interface", "object", "trait", "struct"].includes(item.symbolKind)))
      .map((item) => ({ ...item }));
  }

  private async impact(path: string, line: number, column: number, symbol: string): Promise<AnalysisResult> {
    const [definitionLsp, referenceLsp, implementationLsp] = await Promise.all([
      this.lspLocations(path, line, column, "textDocument/definition"),
      this.lspLocations(path, line, column, "textDocument/references"),
      this.lspLocations(path, line, column, "textDocument/implementation"),
    ]);
    const engine = definitionLsp.locations.length || referenceLsp.locations.length || implementationLsp.locations.length ? "lsp" : "index";
    const server = definitionLsp.server || referenceLsp.server || implementationLsp.server;
    const serverSource = definitionLsp.serverSource || referenceLsp.serverSource || implementationLsp.serverSource;
    const [definitions, references, implementations, index] = await Promise.all([
      definitionLsp.locations.length ? this.withText(definitionLsp.locations) : this.fallbackDefinitions(symbol, path, line),
      referenceLsp.locations.length ? this.withText(referenceLsp.locations) : this.fallbackReferences(symbol),
      implementationLsp.locations.length ? this.withText(implementationLsp.locations) : this.fallbackImplementations(symbol),
      this.getIndex(),
    ]);
    const origin = definitions[0] ?? { path, lineIndex: line, column, text: this.lineText(index, path, line) };
    const callers: ImpactItem[] = [];
    const tests: ImpactItem[] = [];
    const contracts: ImpactItem[] = [];
    const mentions: ImpactItem[] = [];
    const referenceEvidence: ImpactEvidence = referenceLsp.locations.length ? "semantic" : "heuristic";
    for (const item of references) {
      if (item.path === origin.path && item.lineIndex === origin.lineIndex) continue;
      const text = item.text ?? this.lineText(index, item.path, item.lineIndex);
      const enriched = { ...item, text };
      if (testPath(item.path)) tests.push({ ...enriched, relation: "test", evidence: referenceEvidence });
      else if (contractPath(item.path)) contracts.push({ ...enriched, relation: "contract", evidence: referenceEvidence });
      else if (documentPath(item.path)) mentions.push({ ...enriched, relation: "mention", evidence: referenceEvidence });
      else if (/\b(?:import|require|use|include)\b/.test(text)) {
        callers.push({ ...enriched, relation: "importer", evidence: referenceEvidence });
      } else if (referenceEvidence === "semantic" || apparentCall(text, symbol)) {
        callers.push({ ...enriched, relation: "caller", evidence: referenceEvidence });
      } else {
        // A whole-word regex hit is useful as a review lead, but it is not proof of a call relationship.
        mentions.push({ ...enriched, relation: "mention", evidence: "heuristic" });
      }
    }
    const dependencies = this.outgoingDependencies(index, origin, symbol)
      .map((item) => ({ ...item, evidence: "heuristic" as const }));
    const inheritance: ImpactItem[] = [];
    const originDeclaration = origin.text ?? this.lineText(index, origin.path, origin.lineIndex);
    const inheritanceMatch = /\b(?:extends|implements)\s+([^\n{]+)/.exec(originDeclaration);
    if (inheritanceMatch) {
      const parents = inheritanceMatch[1].match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
      for (const parent of parents) {
        const target = (index.definitions.get(parent) ?? [])[0];
        if (target) inheritance.push({ ...target, name: parent, relation: "inherits", evidence: "heuristic" });
      }
    }
    const signatureTokens = (origin.text ?? this.lineText(index, origin.path, origin.lineIndex)).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    for (const token of signatureTokens) {
      if (token === symbol) continue;
      for (const item of index.definitions.get(token) ?? []) {
        if (item.symbolKind === "type" || item.symbolKind === "interface" || contractPath(item.path)) {
          contracts.push({ ...item, relation: "type", evidence: "heuristic" });
        }
      }
    }
    if (contractPath(origin.path)) contracts.unshift({ ...origin, relation: "changed contract", evidence: "heuristic" });
    const implementationEvidence: ImpactEvidence = implementationLsp.locations.length ? "semantic" : "heuristic";
    const impact: ChangeImpact = {
      symbol,
      origin,
      callers: uniqueImpactItems(callers, 120),
      dependencies: uniqueImpactItems(dependencies, 120),
      implementations: uniqueImpactItems([
        ...implementations
          .filter((item) => item.path !== origin.path || item.lineIndex !== origin.lineIndex)
          .map((item) => ({ ...item, relation: "implementation", evidence: implementationEvidence })),
        ...inheritance,
      ], 120),
      tests: uniqueImpactItems(tests, 120),
      contracts: uniqueImpactItems(contracts, 120),
      mentions: uniqueImpactItems(mentions, 120),
    };
    return {
      ok: true,
      engine,
      confidence: engine === "lsp" ? "mixed" : "heuristic",
      server,
      serverSource,
      symbol,
      locations: definitions,
      impact,
      fallbackReason: engine === "index"
        ? definitionLsp.fallbackReason || referenceLsp.fallbackReason || implementationLsp.fallbackReason || "Language server returned no semantic impact data"
        : undefined,
    };
  }

  private outgoingDependencies(index: RegexIndex, origin: AnalysisLocation, symbol: string): RawImpactItem[] {
    const content = index.files.get(origin.path) ?? "";
    const lines = content.split(/\r?\n/);
    const sameFileDefinitions = index.symbols.filter((item) => item.path === origin.path && item.lineIndex > origin.lineIndex);
    const nextDefinition = sameFileDefinitions.sort((a, b) => a.lineIndex - b.lineIndex)[0]?.lineIndex ?? Math.min(lines.length, origin.lineIndex + 160);
    const out: RawImpactItem[] = [];
    const scopeText = lines.slice(origin.lineIndex, nextDefinition).join("\n");
    // Imports normally live above a function/class declaration. Include a module when one of its bound
    // names is used inside the changed symbol's scope; dynamic/side-effect imports in the scope are handled
    // by the line scan below.
    for (let lineIndex = 0; lineIndex < origin.lineIndex; lineIndex += 1) {
      const text = lines[lineIndex];
      const jsImport = /^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/.exec(text);
      const requireImport = /^\s*(?:const|let|var)\s+(.+?)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]/.exec(text);
      const pythonFrom = /^\s*from\s+([^\s]+)\s+import\s+(.+)/.exec(text);
      const pythonImport = /^\s*import\s+([^\s,]+)/.exec(text);
      const module = jsImport?.[2] || requireImport?.[2] || pythonFrom?.[1] || pythonImport?.[1];
      const bindings = (jsImport?.[1] || requireImport?.[1] || pythonFrom?.[2] || pythonImport?.[1] || "")
        .replace(/\b(?:type|as|default)\b/g, " ")
        .match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
      if (module && bindings.some((binding) => new RegExp(`\\b${escapeRegExp(binding)}\\b`).test(scopeText))) {
        out.push({ path: origin.path, lineIndex, column: Math.max(0, text.indexOf(module)), text, name: module, relation: "module" });
      }
    }
    const keywordCalls = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "super"]);
    for (let lineIndex = origin.lineIndex; lineIndex < Math.min(lines.length, nextDefinition); lineIndex += 1) {
      const text = lines[lineIndex];
      const importMatch = /\b(?:from|require\s*\(|import\s*\(|use\s+)[\s'"]*([^'";)\s]+)/.exec(text);
      if (importMatch) out.push({ path: origin.path, lineIndex, column: Math.max(0, text.indexOf(importMatch[1])), text, name: importMatch[1], relation: "module" });
      const calls = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
      let match: RegExpExecArray | null;
      while ((match = calls.exec(text))) {
        const name = match[1];
        if (name === symbol || keywordCalls.has(name)) continue;
        const target = (index.definitions.get(name) ?? [])[0];
        if (target) out.push({ ...target, name, relation: "call" });
      }
    }
    return uniqueLocations(out);
  }

  private lineText(index: RegexIndex, path: string, line: number): string {
    return (index.files.get(path) ?? "").split(/\r?\n/)[line] ?? "";
  }

  private async withText(locations: AnalysisLocation[]): Promise<AnalysisLocation[]> {
    const byPath = new Map<string, string[]>();
    await Promise.all(Array.from(new Set(locations.map((item) => item.path))).map(async (path) => {
      try { byPath.set(path, (await readFile(join(this.root, path), "utf8")).split(/\r?\n/)); } catch { byPath.set(path, []); }
    }));
    return locations.map((item) => ({ ...item, text: item.text ?? byPath.get(item.path)?.[item.lineIndex] ?? "" }));
  }
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
