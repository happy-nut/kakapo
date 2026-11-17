import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SymbolCache } from "./analysis-cache.js";
import {
  AnalysisLocation,
  type AnalysisCodeLens,
  type AnalysisFoldingRange,
  type AnalysisSelectionRange,
  type AnalysisInlayHint,
  type AnalysisSemanticToken,
  type AnalysisHighlight,
  type AnalysisSymbol,
  externalUriSampleFile,
  isKnownExternalUri,
  isKnownLibraryPath,
  LspClient,
  lspSymbolKindName,
  resolveBundledLanguageServer,
  resolveLanguageServer,
  type LanguageServerCommand,
  type LspDiagnostic,
} from "./lsp.js";
import { searchProject } from "./search.js";
import { readLibrarySourceFile } from "./library-source.js";
import { errorMessage } from "./util.js";
import {
  buildProjectIndex,
  buildProjectIndexAtRevision,
  buildRegexSymbolIndex,
  documentPath,
  identifierSpanAt,
  indexablePath,
  maskNonCode,
  patchProjectIndex,
  safeRelativePath,
  type IndexedFile,
  type RegexIndex,
  type SymbolRecord,
} from "./analysis-index.js";
export { buildRegexSymbolIndex } from "./analysis-index.js";
import { collectEndpoints, type Endpoint } from "./endpoints.js";
export type { Endpoint } from "./endpoints.js";
export type AnalysisKind =
  | "definition"
  | "references"
  | "implementation"
  | "typeDefinition"
  | "workspaceSymbol"
  | "documentSymbol"
  | "callers"
  | "callees"
  | "supertypes"
  | "subtypes"
  | "hover"
  | "foldingRange"
  | "documentHighlight"
  | "selectionRange"
  | "endpoints"
  | "codeLens"
  | "inlayHint"
  | "semanticTokens";

const FILE_LEVEL_KINDS = new Set(["documentSymbol", "foldingRange", "codeLens", "inlayHint", "semanticTokens", "workspaceSymbol"]);

export type AnalysisRequest = {
  kind: AnalysisKind;
  path?: string;
  line?: number;
  column?: number;
  query?: string;
  symbol?: string;
  limit?: number;
  side?: string;
  types?: boolean;
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
  symbols?: AnalysisSymbol[];
  hover?: string;
  folds?: AnalysisFoldingRange[];
  selection?: AnalysisSelectionRange[];
  endpoints?: Endpoint[];
  highlights?: AnalysisHighlight[];
  lenses?: AnalysisCodeLens[];
  hints?: AnalysisInlayHint[];
  tokens?: AnalysisSemanticToken[];
  fallbackReason?: string;
  unsupported?: boolean;
  serverAnswered?: boolean;
  noServer?: boolean;
  baseSide?: boolean;
  error?: string;
  revision?: string;
  declined?: "revision";
};

export type DiagnosticsResponse = {
  ok: boolean;
  generation: number;
  available: boolean;
  engine: "lsp" | "index";
  diagnostics: LspDiagnostic[];
  server?: string;
  serverSource?: LanguageServerCommand["source"];
  error?: string;
};

export type AnalysisPhase = "idle" | "starting" | "indexing" | "ready" | "fallback" | "failed";

export type AnalysisStatus = {
  generation: number;
  phase: AnalysisPhase;
  family?: string;
  server?: string;
  serverSource?: LanguageServerCommand["source"];
  fallbackReason?: string;
  error?: string;
  indexed?: boolean;
  updatedAt: string;
};

type AnalysisResult = Omit<AnalysisResponse, "generation" | "durationMs">;

type AnalysisOptions = {
  resolveServer?: (root: string, path: string) => LanguageServerCommand | undefined;
  indexBudgetMs?: number;
  coldQueryBudgetMs?: number;
  files?: IndexedFile[];
  onStatus?: (status: AnalysisStatus) => void;
  symbolCache?: SymbolCache;
};

export type IndexedFileState = {
  path: string;
  signature: string;
  content?: string;
  skippedReason?: string;
};

const MAX_LOCATIONS = 500;
const MAX_INLINE_INDEX_READS = 32;

const SERVER_RESTART_BASE_MS = 1_000;
const SERVER_RESTART_MAX_MS = 60_000;

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

function serverFields(server: LanguageServerCommand): { family: string; server: string; serverSource: LanguageServerCommand["source"] } {
  return { family: server.family, server: server.name, serverSource: server.source };
}

function locationFilePath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

function readingARevision(target: string | undefined): target is string {
  return Boolean(target) && target !== "worktree";
}

export class ProjectAnalysis {
  private indexPromise?: Promise<RegexIndex>;
  private reviewTarget?: string;
  private revisionIndexes = new Map<string, Promise<RegexIndex>>();
  private clients = new Map<string, LspClient>();
  private failedServers = new Map<string, { attempts: number; at: number }>();
  private readonly resolveServer: (root: string, path: string) => LanguageServerCommand | undefined;
  private readonly indexBudgetMs: number;
  private readonly coldQueryBudgetMs: number;
  private readonly fixedFiles?: IndexedFile[];
  private readonly symbolCache?: SymbolCache;
  private readonly onStatus?: (status: AnalysisStatus) => void;
  private generation = 0;
  private indexedSignatures = new Map<string, string>();
  private syncChain: Promise<void> = Promise.resolve();
  private status: AnalysisStatus = { generation: 0, phase: "idle", updatedAt: new Date().toISOString() };

  constructor(readonly root: string, options: AnalysisOptions = {}) {
    this.resolveServer = options.resolveServer ?? resolveLanguageServer;
    this.indexBudgetMs = options.indexBudgetMs ?? 90_000;
    this.coldQueryBudgetMs = options.coldQueryBudgetMs ?? 400;
    this.fixedFiles = options.files;
    this.symbolCache = options.symbolCache;
    this.onStatus = options.onStatus;
  }

  syncIndex(files: IndexedFileState[]): Promise<"seeded" | "unchanged" | "patched" | "rebuilt"> {
    if (this.reviewTarget) return Promise.resolve("unchanged");
    const run = this.syncChain.then(() => this.syncIndexNow(files), () => this.syncIndexNow(files));
    this.syncChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async syncIndexNow(files: IndexedFileState[]): Promise<"seeded" | "unchanged" | "patched" | "rebuilt"> {
    const next = new Map<string, IndexedFileState>();
    for (const file of files) {
      const path = safeRelativePath(this.root, file.path);
      if (!path || file.skippedReason || !indexablePath(path)) continue;
      next.set(path, file);
    }

    if (!this.indexPromise) {
      this.indexedSignatures = new Map([...next].map(([path, file]) => [path, file.signature]));
      this.bumpGeneration();
      return "seeded";
    }

    const stale: IndexedFileState[] = [];
    for (const [path, file] of next) {
      if (this.indexedSignatures.get(path) !== file.signature) stale.push(file);
    }
    const removed = [...this.indexedSignatures.keys()].filter((path) => !next.has(path));
    if (!stale.length && !removed.length) {
      this.bumpGeneration();
      return "unchanged";
    }

    const needsRead = stale.filter((file) => typeof file.content !== "string" || !file.content.length);
    if (needsRead.length > MAX_INLINE_INDEX_READS) {
      this.invalidate();
      this.indexedSignatures = new Map([...next].map(([path, file]) => [path, file.signature]));
      return "rebuilt";
    }

    const index = await this.indexPromise;
    const loaded: IndexedFile[] = [];
    for (const file of stale) {
      const path = safeRelativePath(this.root, file.path);
      if (!path) continue;
      let content = typeof file.content === "string" && file.content.length ? file.content : undefined;
      if (content === undefined) {
        try { content = await readFile(locationFilePath(this.root, path), "utf8"); } catch { continue; }
      }
      loaded.push({ path, content });
    }
    patchProjectIndex(index, loaded, removed);
    for (const path of removed) this.indexedSignatures.delete(path);
    for (const file of loaded) {
      const entry = next.get(file.path);
      if (entry) this.indexedSignatures.set(file.path, entry.signature);
    }
    this.bumpGeneration();
    return "patched";
  }

  private bumpGeneration(): void {
    this.generation += 1;
    this.setStatus(this.status.phase, {
      family: this.status.family,
      server: this.status.server,
      serverSource: this.status.serverSource,
      fallbackReason: this.status.fallbackReason,
      error: this.status.error,
    });
  }

  setReviewTarget(target: string | undefined): void {
    this.reviewTarget = readingARevision(target) ? target : undefined;
  }

  invalidate(): void {
    this.indexPromise = undefined;
    this.indexedSignatures.clear();
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

  symbolCacheStats(): { hits: number; misses: number } | undefined {
    return this.symbolCache?.stats();
  }

  dispose(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }

  serverPids(): { pid: number; family: string }[] {
    const out: { pid: number; family: string }[] = [];
    for (const client of this.clients.values()) {
      const pid = client.serverPid();
      if (pid) out.push({ pid, family: client.server.family });
    }
    return out;
  }

  async prewarm(paths: string[]): Promise<void> {
    void this.getIndex().catch(() => undefined);

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
    const baseSide = request.side === "old" && !this.reviewTarget && !FILE_LEVEL_KINDS.has(request.kind)
      ? { baseSide: true }
      : {};
    return { ...result, ...baseSide, generation, durationMs: Math.round((performance.now() - started) * 10) / 10 };
  }

  async diagnostics(path: string): Promise<DiagnosticsResponse> {
    const generation = this.generation;
    const relative = safeRelativePath(this.root, path);
    if (!relative) {
      return { ok: false, generation, available: false, engine: "index", diagnostics: [], error: "A project-relative source path is required" };
    }
    if (this.reviewTarget) {
      return { ok: true, generation, available: false, engine: "index", diagnostics: [] };
    }
    const client = this.clientFor(relative);
    if (!client) return { ok: true, generation, available: false, engine: "index", diagnostics: [] };
    try {
      const diagnostics = await client.diagnosticsFor(relative);
      return { ok: true, generation, available: true, engine: "lsp", diagnostics, server: client.server.name, serverSource: client.server.source };
    } catch (error) {
      if (this.transportFailure(error)) this.quarantine(client, error);
      return { ok: false, generation, available: true, engine: "lsp", diagnostics: [], error: errorMessage(error) };
    }
  }

  private async runQuery(request: AnalysisRequest): Promise<AnalysisResult> {
    const path = safeRelativePath(this.root, request.path);
    const revision = this.reviewTarget;
    const onRevision = Boolean(revision);
    const declineReason = onRevision
      ? `Reading ${revision}, which no language server can be pointed at`
      : request.side === "old"
        ? "This line is in the diff's base pane, not in the working tree a language server reads"
        : "";
    if (revision && (await this.getIndex()).files.size === 0) {
      return { ok: false, engine: "index", confidence: "heuristic", locations: [], revision, declined: "revision" };
    }
    try {
      if (request.kind === "workspaceSymbol") return await this.workspaceSymbols(path, request.query ?? request.symbol ?? "", request.limit, request.types === true);
      if (request.kind === "endpoints") return await this.projectEndpoints();
      if (!path) return { ok: false, engine: "index", confidence: "heuristic", locations: [], revision, error: "A project-relative source path is required" };
      if (request.kind === "documentSymbol") return await this.documentSymbols(path, onRevision);
      if (request.kind === "foldingRange") return await this.foldingRanges(path, onRevision);
      if (request.kind === "selectionRange") return await this.selectionRanges(path, request, onRevision);
      if (request.kind === "documentHighlight") return await this.documentHighlights(path, request, declineReason);
      if (request.kind === "codeLens" || request.kind === "inlayHint" || request.kind === "semanticTokens") {
        return await this.decoration(request.kind, path, request, onRevision);
      }
      if (request.kind === "callers" || request.kind === "callees"
        || request.kind === "supertypes" || request.kind === "subtypes") {
        return await this.hierarchy(request.kind, path, request, declineReason);
      }
      const context = await this.symbolContext(path, request.line, request.column, request.symbol);
      if (!context.symbol) return { ok: true, engine: "index", confidence: "heuristic", locations: [], revision, symbol: "" };
      if (request.kind === "hover") return await this.hoverAt(path, context, declineReason, revision);
      const method = request.kind === "definition"
        ? "textDocument/definition"
        : request.kind === "references"
          ? "textDocument/references"
          : request.kind === "typeDefinition"
            ? "textDocument/typeDefinition"
            : "textDocument/implementation";
      const lsp = declineReason
        ? { locations: [], server: undefined, serverSource: undefined, fallbackReason: declineReason }
        : await this.lspLocations(path, context.lineIndex, context.column, method, context.symbol);
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
          : request.kind === "typeDefinition"
            ? await this.fallbackDefinitions(context.symbol, path, context.lineIndex, context.column)
            : await this.fallbackImplementations(context.symbol);
      return {
        ok: true,
        engine: "index",
        confidence: "heuristic",
        revision,
        symbol: context.symbol,
        locations,
        fallbackReason: lsp.fallbackReason ?? "Language server returned no semantic locations",
        serverAnswered: lsp.answered === true,
        noServer: lsp.noServer === true,
      };
    } catch (error) {
      return { ok: false, engine: "index", confidence: "heuristic", locations: [], error: errorMessage(error) };
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
    if (this.reviewTarget) {
      const revision = this.reviewTarget;
      const cached = this.revisionIndexes.get(revision);
      if (cached) return cached;
      const pending = buildProjectIndexAtRevision(this.root, revision, this.symbolCache);
      this.revisionIndexes.set(revision, pending);
      return pending;
    }
    if (!this.indexPromise) this.indexPromise = this.fixedFiles
      ? Promise.resolve(buildRegexSymbolIndex(this.fixedFiles))
      : buildProjectIndex(this.root, this.symbolCache);
    return this.indexPromise;
  }

  private async readSource(path: string): Promise<string | undefined> {
    if (this.reviewTarget) {
      const indexed = (await this.getIndex()).files.get(path);
      if (indexed !== undefined || !isKnownLibraryPath(path)) return indexed;
    }
    const file = locationFilePath(this.root, path);
    try { return await readFile(file, "utf8"); } catch { }
    return readLibrarySourceFile(file)?.content;
  }

  private async symbolContext(path: string, line = 0, column = 0, explicit?: string): Promise<{ symbol?: string; lineIndex: number; column: number }> {
    const lineIndex = Math.max(0, Number(line) || 0);
    const col = Math.max(0, Number(column) || 0);
    if (explicit) return { symbol: explicit, lineIndex, column: col };
    const content = (await this.readSource(path)) ?? "";
    const lines = content.split(/\r?\n/);
    const direct = identifierSpanAt(lines[lineIndex] ?? "", col);
    if (direct) return { symbol: direct.name, lineIndex, column: direct.start };
    const index = await this.getIndex();
    const enclosing = index.symbols
      .filter((item) => item.path === path && item.lineIndex <= lineIndex)
      .sort((a, b) => b.lineIndex - a.lineIndex)[0];
    return enclosing
      ? { symbol: enclosing.name, lineIndex: enclosing.lineIndex, column: enclosing.column }
      : { lineIndex, column: col };
  }

  async externalSourceText(uri: string): Promise<string> {
    if (!isKnownExternalUri(uri)) return "";
    const sample = externalUriSampleFile(uri);
    if (!sample) return "";
    const client = this.clientFor(sample);
    if (!client) return "";
    try {
      return await client.externalSourceText(uri);
    } catch {
      return "";
    }
  }

  private clientFor(path: string): LspClient | undefined {
    for (const server of this.serverCandidates(path)) {
      const key = this.serverKey(server);
      if (this.restarting(key)) continue;
      let client = this.clients.get(key);
      if (!client) {
        client = new LspClient(this.root, server);
        this.clients.set(key, client);
        this.setStatus("starting", serverFields(server));
      }
      return client;
    }
    return undefined;
  }

  private hasServerFor(path: string): boolean {
    return this.serverCandidates(path).length > 0;
  }

  private serverCandidates(path: string): LanguageServerCommand[] {
    const primary = this.resolveServer(this.root, path);
    const servers = primary ? [primary] : [];
    if (primary?.source && primary.source !== "bundled") {
      const bundled = resolveBundledLanguageServer(path, this.root);
      if (bundled) servers.push(bundled);
    }
    return servers;
  }

  private serverKey(server: LanguageServerCommand): string {
    return `${server.command}\0${server.args.join("\0")}`;
  }

  private restarting(key: string): boolean {
    const failure = this.failedServers.get(key);
    if (!failure) return false;
    const wait = Math.min(SERVER_RESTART_BASE_MS * 2 ** (failure.attempts - 1), SERVER_RESTART_MAX_MS);
    return Date.now() - failure.at < wait;
  }

  private quarantine(client: LspClient, error?: unknown): void {
    const key = this.serverKey(client.server);
    const previous = this.failedServers.get(key);
    this.failedServers.set(key, { attempts: (previous ? previous.attempts : 0) + 1, at: Date.now() });
    this.clients.delete(key);
    client.dispose();
    this.setStatus("failed", {
      ...serverFields(client.server),
      error: error instanceof Error ? error.message : error ? String(error) : "Language server stopped",
    });
  }

  private transportFailure(error: unknown): boolean {
    const message = errorMessage(error);
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
        this.setStatus("indexing", serverFields(client.server));
        const analysed = await client.awaitAnalysed(path, this.indexBudgetMs);
        this.setStatus("ready", { ...serverFields(client.server), indexed: analysed });
        return;
      } catch (error) {
        this.quarantine(client, error);
        client = this.clientFor(path);
      }
    }
    this.setStatus("fallback", { fallbackReason: `No language server is available for ${path}` });
  }

  private withDeadlineWhileIndexing<T>(
    work: Promise<T>,
    onLateSuccess?: () => void,
  ): Promise<{ settled: true; value: T } | { settled: false }> {
    if (this.status.phase === "ready") return work.then((value) => ({ settled: true as const, value }));
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ settled: false });
      }, this.coldQueryBudgetMs);
      if (typeof timer.unref === "function") timer.unref();
      work.then(
        (value) => {
          if (done) { onLateSuccess?.(); return; }
          done = true;
          clearTimeout(timer);
          resolve({ settled: true, value });
        },
        (error) => { if (done) return; done = true; clearTimeout(timer); reject(error); },
      );
    });
  }

  private async hoverAt(
    path: string,
    context: { symbol?: string; lineIndex: number; column: number },
    declineReason: string,
    revision?: string,
  ): Promise<AnalysisResult> {
    const lsp = declineReason
      ? { hover: "", fallbackReason: declineReason }
      : await this.lspHover(path, context.lineIndex, context.column);
    if (lsp.hover) {
      return {
        ok: true,
        engine: "lsp",
        confidence: "semantic",
        server: lsp.server,
        serverSource: lsp.serverSource,
        symbol: context.symbol,
        locations: [],
        hover: lsp.hover,
      };
    }
    const index = await this.getIndex();
    const declaration = (index.definitions.get(context.symbol ?? "") ?? [])[0];
    const text = declaration?.declaration?.trim() ?? "";
    return {
      ok: true,
      engine: "index",
      confidence: "heuristic",
      revision,
      symbol: context.symbol,
      locations: [],
      hover: text ? "```\n" + text + "\n```" : "",
      fallbackReason: lsp.fallbackReason ?? "Language server returned no hover",
    };
  }

  private async lspHover(
    path: string,
    line: number,
    column: number,
  ): Promise<{ server?: string; serverSource?: LanguageServerCommand["source"]; hover: string; fallbackReason?: string }> {
    const client = this.clientFor(path);
    if (!client) {
      const fallbackReason = `No language server is available for ${path}`;
      this.setStatus("fallback", { fallbackReason });
      return { hover: "", fallbackReason };
    }
    try {
      const server = client;
      const answer = await this.withDeadlineWhileIndexing(
        client.hover(path, line, column),
        () => this.setStatus("ready", serverFields(server.server)),
      );
      if (!answer.settled) return { hover: "", fallbackReason: "The language server is still reading the project" };
      this.setStatus("ready", serverFields(client.server));
      return {
        server: client.server.name,
        serverSource: client.server.source,
        hover: answer.value,
        fallbackReason: answer.value ? undefined : "Language server returned no hover",
      };
    } catch (error) {
      return { hover: "", fallbackReason: errorMessage(error) };
    }
  }

  private async lspLocations(
    path: string,
    line: number,
    column: number,
    method: "textDocument/definition" | "textDocument/references" | "textDocument/implementation" | "textDocument/typeDefinition",
    symbol = "",
  ): Promise<{ server?: string; serverSource?: LanguageServerCommand["source"]; locations: AnalysisLocation[]; fallbackReason?: string; answered?: boolean; noServer?: boolean }> {
    let attempted = false;
    let lastError = "";
    while (true) {
      const client = this.clientFor(path);
      if (!client) {
        const fallbackReason = lastError || (attempted
          ? "All available language servers failed"
          : `No language server is available for ${path}`);
        this.setStatus("fallback", { fallbackReason });
        return { locations: [], fallbackReason, noServer: !this.hasServerFor(path) };
      }
      attempted = true;
      try {
        const server = client;
        const answer = await this.withDeadlineWhileIndexing(
          client.locations(method, path, line, column),
          () => this.setStatus("ready", serverFields(server.server)),
        );
        if (!answer.settled) {
          return { locations: [], fallbackReason: "The language server is still reading the project" };
        }
        let locations = uniqueLocations(answer.value);
        if (method === "textDocument/definition" && locations.length && locations.length <= 4) {
          const resolved: AnalysisLocation[] = [];
          for (const candidate of locations) {
            if (candidate.external) { resolved.push(candidate); continue; }
            if (candidate.path !== path) { resolved.push(candidate); continue; }
            let followed = uniqueLocations(
              await client.locations(method, candidate.path, candidate.lineIndex, candidate.column),
            );
            followed = followed.filter((item) => item.path !== candidate.path || item.lineIndex !== candidate.lineIndex || item.column !== candidate.column);
            resolved.push(...(followed.length ? followed : [candidate]));
          }
          locations = uniqueLocations(resolved);
        }
        this.setStatus("ready", serverFields(client.server));
        return {
          server: client.server.name,
          serverSource: client.server.source,
          locations,
          fallbackReason: locations.length ? undefined : "Language server returned no semantic locations",
          answered: true,
        };
      } catch (error) {
        if (!this.transportFailure(error)) {
          const fallbackReason = errorMessage(error);
          return { locations: [], fallbackReason, answered: true };
        }
        lastError = errorMessage(error);
        this.quarantine(client, error);
      }
    }
  }

  private async workspaceSymbols(path: string | undefined, query: string, limit = 200, typesOnly = false): Promise<AnalysisResult> {
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
          const cap = Math.max(1, Math.min(Number(limit) || 200, 500));
          const matched = await client.workspaceSymbols(query);
          const locations = uniqueLocations(typesOnly ? matched.filter(isTypeLocation) : matched, cap);
          const codeLocations = await this.navigationLocations(locations, cap);
          this.setStatus("ready", serverFields(client.server));
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
          fallbackReason = errorMessage(error);
          if (!this.transportFailure(error)) break;
          this.quarantine(client, error);
        }
      }
    }
    const needle = query.trim().toLowerCase();
    const index = await this.getIndex();
    const locations = index.symbols
      .filter((item) => (!needle || item.name.toLowerCase().includes(needle)) && (!typesOnly || isTypeLocation(item)))
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      .slice(0, Math.max(1, Math.min(Number(limit) || 200, 500)))
      .map((item) => ({ ...item, kind: undefined }));
    return { ok: true, engine: "index", confidence: "heuristic", locations, fallbackReason };
  }

  private async foldingRanges(path: string, onRevision: boolean): Promise<AnalysisResult> {
    if (onRevision) {
      return {
        ok: true, engine: "index", confidence: "heuristic", locations: [], revision: this.reviewTarget,
        fallbackReason: `Reading ${this.reviewTarget}, which no language server can be pointed at`,
      };
    }
    const client = this.clientFor(path);
    if (!client) {
      return { ok: true, engine: "index", confidence: "heuristic", locations: [], fallbackReason: `No language server is available for ${path}` };
    }
    try {
      const answer = await client.foldingRanges(path);
      this.setStatus("ready", serverFields(client.server));
      if (!answer.supported) {
        return {
          ok: true, engine: "lsp", confidence: "semantic", server: client.server.name,
          serverSource: client.server.source, locations: [],
          fallbackReason: `${client.server.name} does not implement folding ranges`,
        };
      }
      return {
        ok: true, engine: "lsp", confidence: "semantic", server: client.server.name,
        serverSource: client.server.source, locations: [], folds: answer.ranges,
      };
    } catch (error) {
      if (this.transportFailure(error)) this.quarantine(client, error);
      return { ok: true, engine: "index", confidence: "heuristic", locations: [], fallbackReason: errorMessage(error) };
    }
  }

  private async decoration(
    kind: "codeLens" | "inlayHint" | "semanticTokens", path: string, request: AnalysisRequest, onRevision: boolean,
  ): Promise<AnalysisResult> {
    if (onRevision) {
      return {
        ok: true, engine: "index", confidence: "heuristic", locations: [], revision: this.reviewTarget,
        fallbackReason: `Reading ${this.reviewTarget}, which no language server can be pointed at`,
      };
    }
    const client = this.clientFor(path);
    if (!client) {
      return { ok: true, engine: "index", confidence: "heuristic", locations: [], fallbackReason: `No language server is available for ${path}` };
    }
    try {
      const answer = kind === "codeLens"
        ? await client.codeLenses(path)
        : kind === "semanticTokens"
          ? await client.semanticTokens(path)
          : await client.inlayHints(path, request.line ?? 0, request.limit ?? Number.MAX_SAFE_INTEGER);
      this.setStatus("ready", serverFields(client.server));
      const base = {
        ok: true as const,
        engine: "lsp" as const,
        confidence: "semantic" as const,
        server: client.server.name,
        serverSource: client.server.source,
        locations: [],
      };
      if (!answer.supported) {
        return { ...base, fallbackReason: `${client.server.name} does not implement ${kind}` };
      }
      if (kind === "codeLens") return { ...base, lenses: (answer as { lenses: AnalysisCodeLens[] }).lenses };
      if (kind === "semanticTokens") return { ...base, tokens: (answer as { tokens: AnalysisSemanticToken[] }).tokens };
      return { ...base, hints: (answer as { hints: AnalysisInlayHint[] }).hints };
    } catch (error) {
      if (this.transportFailure(error)) this.quarantine(client, error);
      return { ok: true, engine: "index", confidence: "heuristic", locations: [], fallbackReason: errorMessage(error) };
    }
  }

  private async documentHighlights(path: string, request: AnalysisRequest, declineReason: string): Promise<AnalysisResult> {
    if (declineReason) {
      return {
        ok: true, engine: "index", confidence: "heuristic", locations: [], revision: this.reviewTarget,
        fallbackReason: declineReason,
      };
    }
    const client = this.clientFor(path);
    if (!client) {
      return { ok: true, engine: "index", confidence: "heuristic", locations: [], fallbackReason: `No language server is available for ${path}` };
    }
    try {
      const answer = await client.documentHighlights(path, request.line ?? 0, request.column ?? 0);
      this.setStatus("ready", serverFields(client.server));
      return {
        ok: true, engine: "lsp", confidence: "semantic", server: client.server.name,
        serverSource: client.server.source, locations: [],
        highlights: answer.supported ? answer.highlights : undefined,
        fallbackReason: answer.supported ? undefined : `${client.server.name} does not implement document highlight`,
      };
    } catch (error) {
      if (this.transportFailure(error)) this.quarantine(client, error);
      return { ok: true, engine: "index", confidence: "heuristic", locations: [], fallbackReason: errorMessage(error) };
    }
  }

  private async selectionRanges(path: string, request: AnalysisRequest, onRevision: boolean): Promise<AnalysisResult> {
    if (onRevision) {
      return {
        ok: true, engine: "index", confidence: "heuristic", locations: [], revision: this.reviewTarget,
        fallbackReason: `Reading ${this.reviewTarget}, which no language server can be pointed at`,
      };
    }
    const client = this.clientFor(path);
    if (!client) {
      return { ok: true, engine: "index", confidence: "heuristic", locations: [], fallbackReason: `No language server is available for ${path}` };
    }
    try {
      const answer = await client.selectionRanges(path, request.line ?? 0, request.column ?? 0);
      this.setStatus("ready", serverFields(client.server));
      return {
        ok: true, engine: "lsp", confidence: "semantic", server: client.server.name,
        serverSource: client.server.source, locations: [],
        selection: answer.supported ? answer.chain : undefined,
        fallbackReason: answer.supported ? undefined : `${client.server.name} does not implement selection ranges`,
      };
    } catch (error) {
      if (this.transportFailure(error)) this.quarantine(client, error);
      return { ok: true, engine: "index", confidence: "heuristic", locations: [], fallbackReason: errorMessage(error) };
    }
  }

  private async projectEndpoints(): Promise<AnalysisResult> {
    const index = await this.getIndex();
    const files = [...index.files].map(([path, content]) => ({
      path, content, codeLines: index.codeLines.get(path),
    }));
    return {
      ok: true, engine: "index", confidence: "heuristic", locations: [],
      endpoints: collectEndpoints(files),
    };
  }

  private async documentSymbols(path: string, onRevision: boolean): Promise<AnalysisResult> {
    let fallbackReason = onRevision
      ? `Reading ${this.reviewTarget}, which no language server can be pointed at`
      : "Language server returned no structure for this file";
    let attempted = false;
    if (!onRevision) {
      while (true) {
        const client = this.clientFor(path);
        if (!client) {
          if (!attempted) fallbackReason = `No language server is available for ${path}`;
          this.setStatus("fallback", { fallbackReason });
          break;
        }
        attempted = true;
        try {
          const symbols = await client.documentSymbols(path);
          this.setStatus("ready", serverFields(client.server));
          if (symbols.length) {
            return {
              ok: true,
              engine: "lsp",
              confidence: "semantic",
              server: client.server.name,
              serverSource: client.server.source,
              locations: [],
              symbols,
            };
          }
          break;
        } catch (error) {
          fallbackReason = errorMessage(error);
          if (!this.transportFailure(error)) break;
          this.quarantine(client, error);
        }
      }
    }
    const index = await this.getIndex();
    const content = index.files.get(path);
    if (content === undefined) {
      return { ok: true, engine: "index", confidence: "heuristic", locations: [], symbols: [], revision: this.reviewTarget, fallbackReason };
    }
    const symbols = buildRegexSymbolIndex([{ path, content }]).symbols
      .slice()
      .sort((a, b) => a.lineIndex - b.lineIndex)
      .map((record) => ({
        name: record.name,
        detail: record.declaration || undefined,
        kind: record.symbolKind || "symbol",
        lineIndex: record.lineIndex,
        column: record.column,
        endLineIndex: record.endLineIndex ?? record.lineIndex,
        depth: record.container ? 1 : 0,
      }));
    return {
      ok: true,
      engine: "index",
      confidence: "heuristic",
      locations: [],
      symbols,
      revision: this.reviewTarget,
      fallbackReason,
    };
  }

  private async hierarchy(
    kind: "callers" | "callees" | "supertypes" | "subtypes",
    path: string,
    request: AnalysisRequest,
    declineReason: string,
  ): Promise<AnalysisResult> {
    const context = await this.symbolContext(path, request.line, request.column, request.symbol);
    if (!context.symbol) return { ok: true, engine: "index", confidence: "heuristic", locations: [], symbol: "" };
    let fallbackReason = declineReason;
    let unsupported = false;
    let noServer = false;
    let answeredWithError = false;
    let attempted = false;
    if (!declineReason) {
      while (true) {
        const client = this.clientFor(path);
        if (!client) {
          if (!attempted) {
            fallbackReason = `No language server is available for ${path}`;
            noServer = !this.hasServerFor(path);
          }
          this.setStatus("fallback", { fallbackReason });
          break;
        }
        attempted = true;
        try {
          const answer = kind === "callers" || kind === "callees"
            ? await client.callHierarchy(path, context.lineIndex, context.column, kind === "callers" ? "incoming" : "outgoing")
            : await client.typeHierarchy(path, context.lineIndex, context.column, kind === "supertypes" ? "supertypes" : "subtypes");
          this.setStatus("ready", serverFields(client.server));
          if (!answer.supported) {
            fallbackReason = `${client.server.name} does not offer ${kind === "callers" || kind === "callees" ? "a call hierarchy" : "a type hierarchy"}`;
            unsupported = true;
            answeredWithError = true;
            break;
          }
          const locations = await this.navigationLocations(answer.locations);
          if (locations.length) {
            return {
              ok: true,
              engine: "lsp",
              confidence: "semantic",
              server: client.server.name,
              serverSource: client.server.source,
              symbol: context.symbol,
              locations,
            };
          }
          return {
            ok: true,
            engine: "lsp",
            confidence: "semantic",
            server: client.server.name,
            serverSource: client.server.source,
            symbol: context.symbol,
            locations: [],
          };
        } catch (error) {
          fallbackReason = errorMessage(error);
          if (!this.transportFailure(error)) { answeredWithError = true; break; }
          this.quarantine(client, error);
        }
      }
    }
    if (kind === "callees") {
      return {
        ok: true,
        engine: "index",
        confidence: "heuristic",
        symbol: context.symbol,
        locations: [],
        revision: this.reviewTarget,
        fallbackReason: (fallbackReason ? fallbackReason + "; " : "")
          + "a name index cannot tell a call from a mention",
        unsupported,
        noServer,
        serverAnswered: answeredWithError,
      };
    }
    const locations = kind === "callers"
      ? await this.fallbackReferences(context.symbol, true, path, context.lineIndex)
      : await this.typeRelatives(context.symbol, kind === "supertypes" ? "supertypes" : "subtypes");
    return {
      ok: true,
      engine: "index",
      confidence: "heuristic",
      symbol: context.symbol,
      locations,
      revision: this.reviewTarget,
      fallbackReason,
      unsupported,
      noServer,
      serverAnswered: answeredWithError,
    };
  }

  private async typeRelatives(name: string, direction: "supertypes" | "subtypes"): Promise<AnalysisLocation[]> {
    const index = await this.getIndex();
    const implementations: { trait: string; type: string; path: string; lineIndex: number }[] = [];
    for (const [filePath, content] of index.files) {
      if (!/\.rs$/i.test(filePath) || !content.includes("impl ")) continue;
      content.split(/\r?\n/).forEach((line, lineIndex) => {
        const match = /^\s*impl(?:\s*<[^>]*>)?\s+([A-Za-z_][\w:]*)(?:\s*<[^>]*>)?\s+for\s+([A-Za-z_][\w:]*)/.exec(line);
        if (match) {
          implementations.push({
            trait: match[1].split("::").pop() as string,
            type: match[2].split("::").pop() as string,
            path: filePath,
            lineIndex,
          });
        }
      });
    }
    if (direction === "subtypes") {
      const pattern = new RegExp(`(?:\\bextends\\b|\\bimplements\\b|:|\\()[^{]*\\b${escapeRegExp(name)}\\b`);
      const declared = index.symbols
        .filter((record) => record.name !== name
          && ["class", "interface", "struct", "enum", "type"].includes(record.symbolKind)
          && pattern.test(record.declaration || ""))
        .map((record) => ({ ...record, kind: undefined }));
      const implementers = implementations
        .filter((relation) => relation.trait === name)
        .flatMap((relation) => index.definitions.get(relation.type) ?? [])
        .map((record) => ({ ...record, kind: undefined }));
      return [...declared, ...implementers].slice(0, 200);
    }
    const declarations = index.definitions.get(name) ?? [];
    const bases = new Set<string>();
    for (const record of declarations) {
      const text = record.declaration || "";
      const tail = /(?:\bextends\b|\bimplements\b|\bis\b)([^{;]*)/.exec(text)?.[1]
        ?? /\bclass\s+\w+\s*\(([^)]*)\)/.exec(text)?.[1]
        ?? "";
      for (const candidate of tail.split(/[^A-Za-z0-9_$.]+/)) {
        const base = candidate.split(".").pop() ?? "";
        if (base && base !== name && !/^(public|private|protected|final|abstract|static|object|metaclass)$/i.test(base)) bases.add(base);
      }
    }
    for (const relation of implementations) {
      if (relation.type === name) bases.add(relation.trait);
    }
    const out: AnalysisLocation[] = [];
    for (const base of bases) {
      for (const record of index.definitions.get(base) ?? []) out.push({ ...record, kind: undefined });
    }
    return out.slice(0, 200);
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

  private async navigationLocations(locations: AnalysisLocation[], limit = MAX_LOCATIONS): Promise<AnalysisLocation[]> {
    if (!locations.length) return [];
    const unique = uniqueLocations(locations, limit);
    const rawByPath = new Map<string, string[]>();
    const maskedByPath = new Map<string, string[]>();
    await Promise.all(Array.from(new Set(unique.map((item) => item.path))).map(async (path) => {
      if (documentPath(path)) return;
      const content = await this.readSource(path);
      if (content !== undefined) {
        rawByPath.set(path, content.split(/\r?\n/));
        maskedByPath.set(path, maskNonCode(content, path));
      }
    }));
    return unique
      .map((item) => ({ ...item, text: item.text ?? rawByPath.get(item.path)?.[item.lineIndex] ?? "" }))
      .filter((item) => {
        if (documentPath(item.path)) return false;
        if (item.external) return true;
        const codeLine = maskedByPath.get(item.path)?.[item.lineIndex] ?? maskNonCode(item.text ?? "", item.path)[0] ?? "";
        const start = Math.max(0, Number(item.column) || 0);
        return /\S/.test(codeLine.slice(start));
      });
  }

  private async withText(locations: AnalysisLocation[]): Promise<AnalysisLocation[]> {
    const byPath = new Map<string, string[]>();
    await Promise.all(Array.from(new Set(locations.map((item) => item.path))).map(async (path) => {
      byPath.set(path, ((await this.readSource(path)) ?? "").split(/\r?\n/));
    }));
    return locations.map((item) => ({ ...item, text: item.text ?? byPath.get(item.path)?.[item.lineIndex] ?? "" }));
  }
}

const TYPE_KIND_NAMES = new Set(["class", "interface", "struct", "enum", "object", "trait"]);
function isTypeLocation(item: AnalysisLocation & { symbolKind?: string }): boolean {
  if (typeof item.symbolKind === "string" && item.symbolKind) return TYPE_KIND_NAMES.has(item.symbolKind);
  if (item.kind === undefined) return false;
  return TYPE_KIND_NAMES.has(lspSymbolKindName(item.kind));
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
