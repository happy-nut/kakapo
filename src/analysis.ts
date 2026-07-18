import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AnalysisLocation,
  LspClient,
  resolveBundledLanguageServer,
  resolveLanguageServer,
  type LanguageServerCommand,
  type LspDiagnostic,
} from "./lsp.js";
import { searchProject } from "./search.js";
import {
  buildProjectIndex,
  buildRegexSymbolIndex,
  documentPath,
  identifierAt,
  maskNonCode,
  safeRelativePath,
  type IndexedFile,
  type RegexIndex,
  type SymbolRecord,
} from "./analysis-index.js";
import {
  buildChangeImpact,
  type ChangeImpact,
  type ImpactEvidence,
} from "./analysis-impact.js";

export { buildRegexSymbolIndex } from "./analysis-index.js";
export type { ChangeImpact, ImpactEvidence, ImpactItem } from "./analysis-impact.js";

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

export type DiagnosticsResponse = {
  ok: boolean;
  generation: number;
  available: boolean; // false when no language server covers this file — the regex fallback cannot diagnose
  engine: "lsp" | "index";
  diagnostics: LspDiagnostic[];
  server?: string;
  serverSource?: LanguageServerCommand["source"];
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

type AnalysisOptions = {
  resolveServer?: (root: string, path: string) => LanguageServerCommand | undefined;
  files?: IndexedFile[];
  onStatus?: (status: AnalysisStatus) => void;
};

const MAX_LOCATIONS = 500;

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

  // Diagnostics for a single file, sourced only from a real language server. Unlike navigation there is no
  // regex fallback: heuristics cannot judge correctness, so an unsupported language reports available:false
  // rather than a misleading empty "no problems". A transport failure quarantines the server like navigation.
  async diagnostics(path: string): Promise<DiagnosticsResponse> {
    const generation = this.generation;
    const relative = safeRelativePath(this.root, path);
    if (!relative) {
      return { ok: false, generation, available: false, engine: "index", diagnostics: [], error: "A project-relative source path is required" };
    }
    const client = this.clientFor(relative);
    if (!client) return { ok: true, generation, available: false, engine: "index", diagnostics: [] };
    try {
      const diagnostics = await client.diagnosticsFor(relative);
      return { ok: true, generation, available: true, engine: "lsp", diagnostics, server: client.server.name, serverSource: client.server.source };
    } catch (error) {
      if (this.transportFailure(error)) this.quarantine(client, error);
      return { ok: false, generation, available: true, engine: "lsp", diagnostics: [], error: error instanceof Error ? error.message : String(error) };
    }
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
      const semanticLocations = await this.navigationLocations(lsp.locations);
      if (semanticLocations.length) {
        return {
          ok: true,
          engine: "lsp",
          confidence: "semantic",
          server: lsp.server,
          serverSource: lsp.serverSource,
          symbol: context.symbol,
          locations: semanticLocations,
        };
      }
      const locations = request.kind === "definition"
        ? await this.fallbackDefinitions(context.symbol, path, context.lineIndex, context.column)
        : request.kind === "references"
          ? await this.fallbackReferences(context.symbol, true, path, context.lineIndex)
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
    if (primary?.source && primary.source !== "bundled") {
      const bundled = resolveBundledLanguageServer(path, this.root);
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
        // A failed explicit/project-local server is followed by the packaged sidecar in clientFor().
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
          const codeLocations = await this.navigationLocations(locations, Math.max(1, Math.min(Number(limit) || 200, 500)));
          this.setStatus("ready", {
            family: client.server.family,
            server: client.server.name,
            serverSource: client.server.source,
          });
          if (codeLocations.length) {
            return {
              ok: true,
              engine: "lsp",
              confidence: "semantic",
              server: client.server.name,
              serverSource: client.server.source,
              locations: codeLocations,
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

  private pythonEnclosingClass(index: RegexIndex, path: string, line: number): string | undefined {
    if (!path.toLowerCase().endsWith(".py")) return undefined;
    const lines = index.codeLines.get(path) ?? [];
    const indentOf = (text: string) => (text.match(/^[ \t]*/)?.[0].replace(/\t/g, "    ").length ?? 0);
    const classes = index.symbols
      .filter((item) => item.path === path && item.symbolKind === "class" && item.lineIndex < line)
      .sort((a, b) => b.lineIndex - a.lineIndex);
    for (const candidate of classes) {
      const classIndent = indentOf(lines[candidate.lineIndex] ?? "");
      let inside = true;
      for (let at = candidate.lineIndex + 1; at <= line; at += 1) {
        const code = lines[at] ?? "";
        if (!code.trim() || code.trimStart().startsWith("@")) continue;
        if (indentOf(code) <= classIndent) { inside = false; break; }
      }
      if (inside) return candidate.name;
    }
    return undefined;
  }

  private pythonBindings(index: RegexIndex, path: string, container: string): Set<string> {
    const lines = index.codeLines.get(path) ?? [];
    const escaped = escapeRegExp(container);
    const bindings = new Set<string>();
    const annotation = new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*:\\s*[^=,)]*\\b${escaped}\\b`, "g");
    const construction = new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\\s*(?::[^=]+)?=\\s*(?:await\\s+)?${escaped}\\s*\\(`, "g");
    for (const line of lines) {
      let match: RegExpExecArray | null;
      while ((match = annotation.exec(line))) bindings.add(match[1]);
      while ((match = construction.exec(line))) bindings.add(match[1]);
    }
    // Propagate one common constructor-injection shape: `self.runner = runner` where `runner: Runner`.
    for (const line of lines) {
      const alias = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
      if (alias && bindings.has(alias[2])) bindings.add(alias[1]);
    }
    return bindings;
  }

  private inferPythonMethodContainer(index: RegexIndex, hits: SymbolRecord[], path: string, line: number, column: number): string | undefined {
    if (!path.toLowerCase().endsWith(".py")) return undefined;
    const code = index.codeLines.get(path)?.[line] ?? "";
    const symbol = hits[0]?.name ?? "";
    const symbolStart = symbol ? code.lastIndexOf(symbol, Math.max(0, column)) : -1;
    const before = code.slice(0, symbolStart >= 0 ? symbolStart : Math.max(0, column));
    const direct = /([A-Z][A-Za-z0-9_]*)\s*\([^)]*\)\s*\.\s*$/.exec(before)?.[1];
    if (direct && hits.some((item) => item.container === direct)) return direct;
    const receiver = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\.\s*$/.exec(before)?.[1];
    if (receiver === "self" || receiver === "cls") return this.pythonEnclosingClass(index, path, line);
    if (!receiver) return this.pythonEnclosingClass(index, path, line);
    const owners = Array.from(new Set(hits.map((item) => item.container).filter((item): item is string => Boolean(item))));
    const inferred = owners.filter((owner) => this.pythonBindings(index, path, owner).has(receiver));
    return inferred.length === 1 ? inferred[0] : undefined;
  }

  private async fallbackDefinitions(symbol: string, currentPath: string, line: number, column = 0): Promise<AnalysisLocation[]> {
    const index = await this.getIndex();
    const hits = index.definitions.get(symbol) ?? [];
    const exact = hits.filter((item) => item.path === currentPath && item.lineIndex === line);
    if (exact.length) return exact.map((item) => ({ ...item }));
    const owner = this.inferPythonMethodContainer(index, hits, currentPath, line, column);
    if (owner) {
      const owned = hits.filter((item) => item.container === owner);
      if (owned.length) return owned.map((item) => ({ ...item }));
    }
    const sameFile = hits.filter((item) => item.path === currentPath);
    if (sameFile.length === 1) return sameFile.map((item) => ({ ...item }));
    // A common Python method name (`execute`, `run`, `get`, …) is not a definition identity. Returning every
    // class that happens to declare it makes heuristic output look authoritative while being mostly noise.
    // Fail closed unless receiver/class context above identifies an owner; a language server can still
    // provide complete polymorphic results when one is available.
    const pythonMethods = hits.filter((item) => item.path.endsWith(".py") && Boolean(item.container));
    if (pythonMethods.length > 1) {
      const standalone = hits.filter((item) => !item.path.endsWith(".py") || !item.container);
      return standalone.length <= 10 ? standalone.map((item) => ({ ...item })) : [];
    }
    if (hits.length > 40) return [];
    return hits
      .slice()
      .sort((a, b) => Number(b.path === currentPath) - Number(a.path === currentPath) || Math.abs(a.lineIndex - line) - Math.abs(b.lineIndex - line))
      .map((item) => ({ ...item }));
  }

  private async fallbackReferences(symbol: string, codeOnly = true, originPath?: string, originLine?: number): Promise<AnalysisLocation[]> {
    const index = codeOnly ? await this.getIndex() : undefined;
    const origin = index && originPath != null && originLine != null
      ? (index.definitions.get(symbol) ?? []).find((item) => item.path === originPath && item.lineIndex === originLine && item.path.endsWith(".py") && item.container)
      : undefined;
    // Generic names such as `execute` can exceed the normal display cap before ripgrep reaches the one
    // receiver-qualified call we need. Scan a larger bounded set only when a Python owner is known, then
    // apply the strict receiver filter below and still return at most MAX_LOCATIONS.
    const result = await searchProject(this.root, symbol, origin ? 2000 : MAX_LOCATIONS + 1);
    const bindings = new Map<string, Set<string>>();
    const matches = result.matches.filter((match) => {
      const before = match.text.charAt(match.column - 2);
      const after = match.text.charAt(match.endColumn - 1);
      if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) return false;
      if (!codeOnly) return true;
      if (documentPath(match.path)) return false;
      const codeLine = index?.codeLines.get(match.path)?.[match.line - 1] ?? "";
      if (!codeLine.slice(Math.max(0, match.column - 1), Math.max(match.column, match.endColumn - 1)).trim()) return false;
      if (!origin?.container || !index) return true;
      if (match.path === origin.path && match.line - 1 === origin.lineIndex) return true;
      const prefix = codeLine.slice(0, Math.max(0, match.column - 1));
      if (new RegExp(`\\b${escapeRegExp(origin.container)}\\s*\\([^)]*\\)\\s*\\.\\s*$`).test(prefix)) return true;
      const receiver = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\.\s*$/.exec(prefix)?.[1];
      if (!receiver) return this.pythonEnclosingClass(index, match.path, match.line - 1) === origin.container;
      if (receiver === "self" || receiver === "cls") return this.pythonEnclosingClass(index, match.path, match.line - 1) === origin.container;
      let fileBindings = bindings.get(match.path);
      if (!fileBindings) {
        fileBindings = this.pythonBindings(index, match.path, origin.container);
        bindings.set(match.path, fileBindings);
      }
      return fileBindings.has(receiver);
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
      definitionLsp.locations.length ? this.withText(definitionLsp.locations) : this.fallbackDefinitions(symbol, path, line, column),
      referenceLsp.locations.length ? this.withText(referenceLsp.locations) : this.fallbackReferences(symbol, false, path, line),
      implementationLsp.locations.length ? this.withText(implementationLsp.locations) : this.fallbackImplementations(symbol),
      this.getIndex(),
    ]);
    const origin = definitions[0] ?? {
      path,
      lineIndex: line,
      column,
      text: (index.files.get(path) ?? "").split(/\r?\n/)[line] ?? "",
    };
    const referenceEvidence: ImpactEvidence = referenceLsp.locations.length ? "semantic" : "heuristic";
    const implementationEvidence: ImpactEvidence = implementationLsp.locations.length ? "semantic" : "heuristic";
    const impact = buildChangeImpact({
      symbol,
      origin,
      references,
      implementations,
      index,
      referenceEvidence,
      implementationEvidence,
    });
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

  private async navigationLocations(locations: AnalysisLocation[], limit = MAX_LOCATIONS): Promise<AnalysisLocation[]> {
    if (!locations.length) return [];
    const [enriched, index] = await Promise.all([
      this.withText(uniqueLocations(locations, limit)),
      this.getIndex(),
    ]);
    return enriched.filter((item) => {
      if (documentPath(item.path)) return false;
      const indexedLine = index.codeLines.get(item.path)?.[item.lineIndex];
      const codeLine = indexedLine ?? maskNonCode(item.text ?? "", item.path)[0] ?? "";
      const start = Math.max(0, Number(item.column) || 0);
      // Some servers report the beginning of indentation rather than the identifier itself. Looking from
      // that point to the end keeps those valid locations while a comment/string range remains all spaces.
      return /\S/.test(codeLine.slice(start));
    });
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
