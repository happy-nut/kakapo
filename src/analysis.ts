import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  AnalysisLocation,
  type AnalysisCodeLens,
  type AnalysisFoldingRange,
  type AnalysisInlayHint,
  type AnalysisSemanticToken,
  type AnalysisHighlight,
  type AnalysisSymbol,
  LspClient,
  lspSymbolKindName,
  resolveBundledLanguageServer,
  resolveLanguageServer,
  type LanguageServerCommand,
  type LspDiagnostic,
} from "./lsp.js";
import { searchProject } from "./search.js";
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
export type AnalysisKind =
  | "definition"
  | "references"
  | "implementation"
  // Where the TYPE of the thing under the caret is declared, rather than the thing itself — IntelliJ's
  // Go to Type Declaration. The same request shape as the three above.
  | "typeDefinition"
  | "workspaceSymbol"
  // The open file's own structure: what the structure popup lists, what the breadcrumb reads the enclosing
  // symbol from, and what next/previous-symbol walks. Answered in `symbols`, not in `locations`.
  | "documentSymbol"
  // The two hierarchies, one direction each: who calls this / what this calls, and what this extends /
  // what extends it. A server that does not implement them says so, which is not the same answer as
  // "nothing found" — see fallbackReason.
  | "callers"
  | "callees"
  | "supertypes"
  | "subtypes"
  // What the thing under the caret IS, in prose — `textDocument/hover`. The only question in this list
  // whose answer is not a position, and the one two IntelliJ actions were missing for: Quick Documentation
  // renders the whole answer, Expression Type takes its first line. Answered in `hover`.
  | "hover"
  // Where the file folds, and every occurrence of one symbol inside its own file. Both are about the file
  // rather than about a position in the index, and both are answered only by a language server — an index
  // of names cannot tell a fold from a brace or a read from a write. Answered in `folds` / `highlights`.
  | "foldingRange"
  | "documentHighlight"
  // What the server would write above a declaration and inside a line — IntelliJ's Code Vision and its
  // inlay hints. Decoration, not navigation: answered in `lenses` / `hints`.
  | "codeLens"
  | "inlayHint"
  // The file's tokens as the language's own parser sees them, which is what the source view's hand-written
  // tokenizer can only approximate. Answered in `tokens`.
  | "semanticTokens";

export type AnalysisRequest = {
  kind: AnalysisKind;
  path?: string;
  line?: number;
  column?: number;
  query?: string;
  symbol?: string;
  limit?: number;
  /**
   * Only for kind "workspaceSymbol": keep types only — IntelliJ's Go to Class, as opposed to its Go to
   * Symbol. Filtered HERE rather than in the page because the two engines label a kind differently: a
   * language server sends LSP's numeric SymbolKind and the regex index sends its own word, and the page
   * would need both tables to tell a class from a function.
   */
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
  /** Only for kind "documentSymbol": the file's structure, flattened in reading order. */
  symbols?: AnalysisSymbol[];
  /** Only for kind "hover": Markdown. Empty when neither the server nor the index had anything to say. */
  hover?: string;
  /** Only for kind "foldingRange". Absent (not empty) when the server does not implement the request. */
  folds?: AnalysisFoldingRange[];
  /** Only for kind "documentHighlight", each occurrence labelled read / write / neither. */
  highlights?: AnalysisHighlight[];
  /** Only for kind "codeLens": one entry per declaration the server has something to say about. */
  lenses?: AnalysisCodeLens[];
  /** Only for kind "inlayHint". */
  hints?: AnalysisInlayHint[];
  /** Only for kind "semanticTokens". Absent when the server registered no legend for them. */
  tokens?: AnalysisSemanticToken[];
  fallbackReason?: string;
  error?: string;
  /**
   * Set whenever this answer describes a REVISION rather than the working tree, whether or not it found
   * anything. Such an answer can only ever come from the index — no language server can be pointed at a
   * revision — so it is name-matched by construction, and the reviewer has to be told that in different
   * words from "still indexing": nothing is indexing, and no better answer is coming later.
   */
  revision?: string;
  /**
   * Set when the question could not be asked at all, as opposed to asked and answered with nothing.
   * `"revision"`: that revision could not be read, so an empty answer would mean "nothing there" when it
   * actually means "nothing was looked at".
   */
  declined?: "revision";
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

// `indexing` is the window this app used to have no name for: the server has answered `initialize` and is
// building its model, so navigation works but answers from the regex index rather than semantically. It is
// the state a reviewer hits on their first keystroke after opening a project, and the one worth saying out
// loud — both while it lasts and when it ends.
export type AnalysisPhase = "idle" | "starting" | "indexing" | "ready" | "fallback" | "failed";

export type AnalysisStatus = {
  generation: number;
  phase: AnalysisPhase;
  family?: string;
  server?: string;
  serverSource?: LanguageServerCommand["source"];
  fallbackReason?: string;
  error?: string;
  // Did the server confirm it had analysed the warm-up file, or did the index budget simply run out? The
  // chip reads the same either way; this is here so a reviewer who asks can be told which it was.
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
};

// What syncIndex needs from one of the review's file records. Structural rather than importing SourceFile,
// so the analysis layer keeps knowing nothing about how a review is built.
export type IndexedFileState = {
  path: string;
  signature: string;
  content?: string;
  skippedReason?: string;
};

const MAX_LOCATIONS = 500;
// How many files syncIndex will read from disk itself before handing the job back to buildProjectIndex.
// Matched to that builder's own read batch: one batch is work worth doing inline, and anything larger is a
// base change or a branch switch dressed up as a save, where a batched, yielding rebuild is cheaper.
const MAX_INLINE_INDEX_READS = 32;

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

// The server-identity fields every analysis status carries, projected once from a language-server command
// (family/name/source -> family/server/serverSource) so a shape change touches one place, not five setStatus calls.
function serverFields(server: LanguageServerCommand): { family: string; server: string; serverSource: LanguageServerCommand["source"] } {
  return { family: server.family, server: server.name, serverSource: server.source };
}

// Where a location's file actually is. A definition OUTSIDE the review root carries an absolute path —
// a stdlib header, a gem, a crate in ~/.cargo, site-packages, GOROOT — and join(root, "/usr/include/x.h")
// silently produces "<root>/usr/include/x.h", a path that exists nowhere. Every read of a library location
// failed that way, which left it with no text, which got it dropped by the text filter in
// navigationLocations. The server had answered with a real file on disk and the reviewer was told the
// definition could not be found. Every language with dependencies outside the project was affected; the
// JVM `jrt:`/`jar:` case was the same failure reached by a different route.
function locationFilePath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * Is the review showing something other than the working tree?
 *
 * `undefined` and the literal `"worktree"` both mean the files on disk, which is what this analyzer reads.
 * Anything else is an A→B compare whose right side is a revision (app-main.ts: "exact right/new side
 * revision for an A→B compare"), and the same test already guards path existence in app-path-ipc.ts.
 */
function readingARevision(target: string | undefined): target is string {
  return Boolean(target) && target !== "worktree";
}

export class ProjectAnalysis {
  private indexPromise?: Promise<RegexIndex>;
  /**
   * The revision the review is currently showing, when it is not the working tree.
   *
   * Everything this class reads comes from `locationFilePath`, i.e. from disk, so when the canvas is
   * showing revision B the index describes a DIFFERENT text than the one being read. That mismatch has two
   * shapes and the second is the dangerous one: a symbol that was renamed answers with nothing (which at
   * least looks like an answer of "none"), while a symbol that merely MOVED answers with the file it lives
   * in today — a file that may not have existed in the revision on screen — and nothing distinguishes that
   * from a correct jump. So navigation declines here rather than guessing.
   */
  private reviewTarget?: string;
  /** Built indexes keyed by revision. A revision's tree is immutable, so these never need invalidating. */
  private revisionIndexes = new Map<string, Promise<RegexIndex>>();
  private clients = new Map<string, LspClient>();
  private failedServers = new Set<string>();
  private readonly resolveServer: (root: string, path: string) => LanguageServerCommand | undefined;
  // How long the background warm-up waits for a server to confirm it has analysed the file. Generous
  // because nothing is waiting on it, bounded because a server that never diagnoses must not leave the
  // status chip saying "indexing" forever. Overridable so tests do not spend a minute on it.
  private readonly indexBudgetMs: number;
  // How long one navigation question waits for a server that has NOT said it is ready yet. Small, because
  // during that window the server usually has no answer at all and the regex index does — see
  // withDeadlineWhileIndexing.
  private readonly coldQueryBudgetMs: number;
  private readonly fixedFiles?: IndexedFile[];
  private readonly onStatus?: (status: AnalysisStatus) => void;
  private generation = 0;
  // What the built index holds, path → the review's signature for it. The index itself does not carry these:
  // buildProjectIndex reads the tree directly and has no cheaper hash to offer than the content it just read.
  private indexedSignatures = new Map<string, string>();
  private syncChain: Promise<void> = Promise.resolve();
  private status: AnalysisStatus = { generation: 0, phase: "idle", updatedAt: new Date().toISOString() };

  constructor(readonly root: string, options: AnalysisOptions = {}) {
    this.resolveServer = options.resolveServer ?? resolveLanguageServer;
    this.indexBudgetMs = options.indexBudgetMs ?? 90_000;
    this.coldQueryBudgetMs = options.coldQueryBudgetMs ?? 400;
    this.fixedFiles = options.files;
    this.onStatus = options.onStatus;
  }

  /**
   * Bring the built symbol index back in line with the review's own file records, re-indexing only what
   * actually changed.
   *
   * This replaces invalidate() on the rebuild path. Discarding the index meant the next question rebuilt it
   * from scratch: ripgrep walk, read every file, scan every line — 210ms on this repository, ~1,900ms of
   * scan alone on a 3,000-file one, in the main process, once per save, because one file changed.
   *
   * The review's records are the right authority for this. Measured on this repository, every file the index
   * holds appears in them (191 of 212; the other 21 are markdown and images the index skips), and all 212
   * carry a signature — a content hash for files the build read, mtime+size for the ones it deferred past
   * its byte budget. So comparing signatures says exactly which files moved, and a changed file's content is
   * already in hand: the build keeps changed files regardless of that budget, so the common save needs no
   * disk read at all.
   *
   * Returns what it did, so a test can tell a real patch from an accidental full rebuild.
   */
  syncIndex(files: IndexedFileState[]): Promise<"seeded" | "unchanged" | "patched" | "rebuilt"> {
    // Saves happen in the working tree. A revision's tree cannot change, so there is nothing to patch and
    // patching would touch the OTHER index — the working-tree one, which is not what is being served.
    if (this.reviewTarget) return Promise.resolve("unchanged");
    // One at a time. Rebuilds arrive as fast as files are saved — a watch session, or an agent writing a
    // directory — and two overlapping syncs read the same signature map before either writes it, so the
    // second records its content under the first's signature and the NEXT save sees "unchanged" and skips a
    // file that really did move. Patching twice is harmless; losing a signature is a stale index.
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

    // Nothing built yet: the lazy build will read the working tree itself, so these signatures describe what
    // it is about to produce. Recording them is the whole of the work.
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

    // An unchanged file whose signature moved is one the build read and then dropped to stay inside its
    // byte budget, so its content has to come off disk. One batch of those is worth doing here; more than
    // that is a base change wearing a save's clothing, and buildProjectIndex reads in batches and yields.
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

  /**
   * Tell the analyzer which revision the review is showing. Called wherever the review's target is applied,
   * so the two cannot drift: a compare that moves to a revision silently is exactly the state this exists
   * to make visible. `undefined` or "worktree" restores ordinary navigation.
   */
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

  dispose(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }

  /** Every live language-server process this analysis has spawned, with its family — the memory watchdog
   *  (app-main.ts) weighs fleets by pid and exempts families whose bulk is by design (the JVM Kotlin server
   *  is 1.3 GB when healthy; trading its restart for memory is a known bad deal). */
  serverPids(): { pid: number; family: string }[] {
    const out: { pid: number; family: string }[] = [];
    for (const client of this.clients.values()) {
      const pid = client.serverPid();
      if (pid) out.push({ pid, family: client.server.family });
    }
    return out;
  }

  // Start at most one process per resolved language-server command and open one changed document. The app
  // schedules this only after its review page loads, so semantic navigation is warm without delaying paint.
  async prewarm(paths: string[]): Promise<void> {
    // Start the regex index first, and do not wait for it.
    //
    // The index is what answers navigation WHILE the servers are still reading the project — that is its
    // whole job. Building it lazily meant the reviewer's first keystroke in exactly that window paid to
    // build it, on top of whatever it had already spent waiting for the server. Measured on this
    // repository: 155 ms for 189 files and 2.4 MB, and it scales with the project, so the repositories
    // where the warm-up window is longest are also the ones where the fallback costs most to produce.
    //
    // Nothing awaits this. prewarm runs after the review has painted, so the work lands where no keystroke
    // is waiting on it; by the time one is, the index is already built and getIndex() returns the same
    // settled promise. The catch is only so a failure here cannot surface as an unhandled rejection —
    // queries await the same promise and handle it themselves.
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
    // A language server reads the working tree, so on a revision its diagnostics describe different text:
    // the line numbers still land, which is what makes it bad — squiggles appear on revision-B lines for
    // problems in the file as it is today. `available: false` is the existing way to say "nothing can
    // judge this file", and that is exactly true here.
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
    // A language server reads the working tree and cannot be pointed at a revision without materializing
    // files, so on a revision it is not asked at all: an answer from a server about today's text, offered
    // while the canvas shows commit B, is the confident-but-wrong jump this whole branch exists to stop.
    // The index, by contrast, is built FROM the revision (see getIndex), so it answers about what is on
    // screen — heuristically, which is the honest grade for a name-matching index and is already how this
    // app labels an index answer.
    const revision = this.reviewTarget;
    const onRevision = Boolean(revision);
    // (B) introduced a new way to be silently empty: a revision whose tree could not be read at all yields
    // an index with no files, and then every answer is `[]` — "nothing there" when the truth is "nothing was
    // looked at". That is the exact failure this branch set out to remove, so it is declined by name.
    if (revision && (await this.getIndex()).files.size === 0) {
      return { ok: false, engine: "index", confidence: "heuristic", locations: [], revision, declined: "revision" };
    }
    try {
      if (request.kind === "workspaceSymbol") return await this.workspaceSymbols(path, request.query ?? request.symbol ?? "", request.limit, request.types === true);
      if (!path) return { ok: false, engine: "index", confidence: "heuristic", locations: [], revision, error: "A project-relative source path is required" };
      // A file's structure is about the file, not about a position in it, so it skips symbolContext (which
      // exists to work out what the caret is on) and has its own index fallback.
      if (request.kind === "documentSymbol") return await this.documentSymbols(path, onRevision);
      // Both are language-server-only questions, and both are about the file rather than the index, so
      // they take the same shape as the structure above: ask the client for this path, or answer "not
      // supported" so the caller can keep its own fallback rather than read an empty list as a fact.
      if (request.kind === "foldingRange") return await this.foldingRanges(path, onRevision);
      if (request.kind === "documentHighlight") return await this.documentHighlights(path, request, onRevision);
      if (request.kind === "codeLens" || request.kind === "inlayHint" || request.kind === "semanticTokens") {
        return await this.decoration(request.kind, path, request, onRevision);
      }
      if (request.kind === "callers" || request.kind === "callees"
        || request.kind === "supertypes" || request.kind === "subtypes") {
        return await this.hierarchy(request.kind, path, request, onRevision);
      }
      const context = await this.symbolContext(path, request.line, request.column, request.symbol);
      if (!context.symbol) return { ok: true, engine: "index", confidence: "heuristic", locations: [], revision, symbol: "" };
      if (request.kind === "hover") return await this.hoverAt(path, context, onRevision, revision);
      const method = request.kind === "definition"
        ? "textDocument/definition"
        : request.kind === "references"
          ? "textDocument/references"
          : request.kind === "typeDefinition"
            ? "textDocument/typeDefinition"
            : "textDocument/implementation";
      const lsp = onRevision
        ? { locations: [], server: undefined, serverSource: undefined, fallbackReason: `Reading ${this.reviewTarget}, which no language server can be pointed at` }
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
          // A type declaration is a declaration: the name index cannot tell a type's from a value's, so the
          // heuristic answer is the same set of declarations the definition fallback offers.
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
    // On a revision the index is built FROM that revision, so every answer below describes the text on
    // screen. Cached per revision because a compare is switched back and forth while reading, and because
    // a revision's tree cannot change under us — unlike the working tree, which is why only this side of
    // the branch needs syncIndex and invalidate at all.
    if (this.reviewTarget) {
      const revision = this.reviewTarget;
      const cached = this.revisionIndexes.get(revision);
      if (cached) return cached;
      const pending = buildProjectIndexAtRevision(this.root, revision);
      this.revisionIndexes.set(revision, pending);
      return pending;
    }
    if (!this.indexPromise) this.indexPromise = this.fixedFiles
      ? Promise.resolve(buildRegexSymbolIndex(this.fixedFiles))
      : buildProjectIndex(this.root);
    return this.indexPromise;
  }

  /**
   * One file's text, from whatever the review is actually showing.
   *
   * This is the routing point. Four call sites used to read `locationFilePath(root, path)` directly — the
   * working tree — so on a revision they resolved the symbol under the caret, filtered candidates and
   * built result previews from a different text than the one on screen. They all come through here now,
   * and nothing downstream had to learn about revisions.
   *
   * On a revision the answer comes from the index rather than from git: `RegexIndex.files` already holds
   * the content of every indexed file (the masking cache next door relies on the same property), so there
   * is no second read and no process to spawn. A path the index does not hold — not code, over the size
   * cap, absent from this revision — returns undefined, which is what the old `catch` produced too.
   */
  private async readSource(path: string): Promise<string | undefined> {
    if (this.reviewTarget) return (await this.getIndex()).files.get(path);
    try { return await readFile(locationFilePath(this.root, path), "utf8"); } catch { return undefined; }
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
        this.setStatus("starting", serverFields(server));
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
        // Up and talking, not yet useful: say so, then get the indexing over with here rather than under
        // the reviewer's first keystroke. Nothing waits on this — prewarm is called after the review paints.
        this.setStatus("indexing", serverFields(client.server));
        const analysed = await client.awaitAnalysed(path, this.indexBudgetMs);
        // Budget expiry is not a failure: the server is up and answering, and some servers never diagnose
        // some files. Either way this is as ready as it is going to say it is.
        this.setStatus("ready", { ...serverFields(client.server), indexed: analysed });
        return;
      } catch (error) {
        this.quarantine(client, error);
        client = this.clientFor(path);
      }
    }
    this.setStatus("fallback", { fallbackReason: `No language server is available for ${path}` });
  }

  // A cold server answers its first questions only after it has read the project — tens of seconds on a
  // large Gradle/Kotlin workspace — and REQUEST_TIMEOUT_MS lets one question sit there for eight of them.
  // Every navigation key pressed in that window paid the whole wait and then usually got the regex index's
  // answer anyway, because the server had nothing to give yet. So while the server has not reported
  // `ready`, stop WAITING at a deadline and let the index answer now.
  //
  // The request is not cancelled. It keeps running, which is exactly what warms the server up, and the
  // first question asked after `ready` waits as long as it needs to.
  //
  // `onLateSuccess` is how the NEXT question gets to skip the deadline. An answer that arrives after the
  // budget is still an answer: it is the server saying it can read this project now. Dropping it on the
  // floor left the phase wherever warm-up had put it, so every following keystroke was deadlined too — and
  // warm-up's own signal is one file's diagnostics publish, bounded at 90 seconds. A session trace on this
  // repository sat at `indexing` for 90,002ms twice, answering from the regex index the whole time while a
  // server that could answer sat beside it. One cold keystroke is the price; ninety seconds of them is a
  // lost signal.
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
      // One timer left armed held this project's whole test suite open for six hours. Nothing here is
      // worth keeping the process alive for.
      if (typeof timer.unref === "function") timer.unref();
      work.then(
        (value) => {
          if (done) { onLateSuccess?.(); return; }
          done = true;
          clearTimeout(timer);
          resolve({ settled: true, value });
        },
        // A rejection after the deadline has already passed belongs to the warm-up, not to this question;
        // the handler is still attached so it cannot surface as an unhandled rejection.
        (error) => { if (done) return; done = true; clearTimeout(timer); reject(error); },
      );
    });
  }

  // Is this line, in this file, something the regex index also calls a declaration of this symbol?
  //
  // That is the test for "the server sent me the real thing" — and its opposite is the test for an
  // indirection worth following. No declaration pattern in analysis-index.ts matches an `import`, so an
  // import binding can never answer true here, including the one shape no single-line pattern can see: a
  // name on its own inside a multi-line `import { … }`.
  //
  // An index with no record of the symbol ANYWHERE has no opinion and says yes, so a language the regex
  // patterns do not cover keeps the server's answer untouched instead of paying a follow-up on every jump.
  private async isIndexedDeclaration(location: AnalysisLocation, symbol: string): Promise<boolean> {
    if (!symbol) return true;
    const index = await this.getIndex();
    const records = index.definitions.get(symbol) ?? [];
    if (!records.length) return true;
    return records.some((record) => record.path === location.path && record.lineIndex === location.lineIndex);
  }

  /**
   * What the caret is on, in prose.
   *
   * A revision skips the server outright — no language server can be pointed at one — and takes the index
   * answer, which is the same arrangement every other kind here uses. That is not a decline: the
   * declaration line IS an answer about a revision, and a reader asking "what is this" gets the signature
   * rather than a refusal.
   */
  private async hoverAt(
    path: string,
    context: { symbol?: string; lineIndex: number; column: number },
    onRevision: boolean,
    revision?: string,
  ): Promise<AnalysisResult> {
    const lsp = onRevision
      ? { hover: "", fallbackReason: `Reading ${this.reviewTarget}, which no language server can be pointed at` }
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
    // The index knows the line a symbol was declared on, which is the part of a hover a reader is usually
    // after. Fenced, so the renderer highlights it as the code it is rather than as a paragraph.
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
      // Hover is an optional capability and a server that lacks it must not be quarantined for saying so —
      // the same reasoning the location path applies to `implementation`.
      return { hover: "", fallbackReason: errorMessage(error) };
    }
  }

  private async lspLocations(
    path: string,
    line: number,
    column: number,
    method: "textDocument/definition" | "textDocument/references" | "textDocument/implementation" | "textDocument/typeDefinition",
    symbol = "",
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
        const server = client;
        const answer = await this.withDeadlineWhileIndexing(
          client.locations(method, path, line, column),
          () => this.setStatus("ready", serverFields(server.server)),
        );
        if (!answer.settled) {
          // Not an error and not a dead end: the server simply has not read enough of the project yet.
          // Returning no locations drops through to the regex index below, and `fallbackReason` is what
          // makes the renderer label it as the partial answer rather than as the whole truth.
          return { locations: [], fallbackReason: "The language server is still reading the project" };
        }
        let locations = uniqueLocations(answer.value);
        // tsserver and friends commonly report the local import BINDING rather than the declaration it
        // points at. Go-to-definition that lands on `import { thing } from …` has not answered the
        // question, so follow the indirection here instead of making the reviewer press the key twice.
        //
        // This used to fire only when the server returned EXACTLY ONE location, and only when a regex
        // matched that one line as an import statement — so it missed both of the shapes that actually
        // turn up: a server that returns the binding alongside something else, and a binding inside a
        // multi-line `import {\n  thing,\n} from …`, whose line is just `  thing,` and matches nothing.
        // Asking the index what counts as a declaration covers every shape and every language it knows.
        //
        // Following a location that really was the declaration is harmless by construction: the server
        // sends back the same place, the filter below drops it, and the original answer stands. The bound
        // is there so a server returning a long list cannot turn one keystroke into a dozen round trips.
        if (method === "textDocument/definition" && locations.length && locations.length <= 4) {
          const resolved: AnalysisLocation[] = [];
          for (const candidate of locations) {
            if (await this.isIndexedDeclaration(candidate, symbol)) { resolved.push(candidate); continue; }
            let followed: AnalysisLocation[] = [];
            if (client.server.family === "typescript") {
              try { followed = uniqueLocations(await client.sourceDefinitions(path, line, column)); } catch { /* standard LSP below */ }
            }
            if (!followed.length) {
              followed = uniqueLocations(await client.locations(method, candidate.path, candidate.lineIndex, candidate.column));
            }
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
        };
      } catch (error) {
        // A server may legitimately omit one capability (commonly implementation). Keep it alive for
        // definition/references; only quarantine transport/process failures that cannot recover in-window.
        if (!this.transportFailure(error)) {
          const fallbackReason = errorMessage(error);
          return { locations: [], fallbackReason };
        }
        lastError = errorMessage(error);
        this.quarantine(client, error);
        // A failed explicit/project-local server is followed by the packaged sidecar in clientFor().
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
          const answered = uniqueLocations(await client.workspaceSymbols(query), Math.max(1, Math.min(Number(limit) || 200, 500)));
          const locations = typesOnly ? answered.filter(isTypeLocation) : answered;
          const codeLocations = await this.navigationLocations(locations, Math.max(1, Math.min(Number(limit) || 200, 500)));
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

  /**
   * The open file's structure.
   *
   * The language server is asked first and the regex index answers when it cannot — which is the same
   * arrangement as every other query here, and matters more for this one: the structure popup is how a
   * reader moves through a large file, and a file in a language with no bundled server still has functions
   * in it. The index answer is flat (it reads declarations line by line, so it has no nesting to report)
   * and labelled heuristic, which is the honest grade.
   */
  /**
   * Where the open file folds. No index fallback: the viewer keeps its own brace walk for exactly the case
   * this cannot answer, and an empty list from here would be indistinguishable from "this file has no
   * folds", which would silently take the folds away from every C-like file while a server was starting.
   */
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

  /**
   * The two decoration requests, which are one method because they are one shape: ask the server about the
   * open file, hand back what it said, and say so plainly when it has no such provider. Neither has an
   * index fallback — a regex index cannot infer a parameter name or count a usage, and drawing a guess as
   * if the compiler had said it is the one thing decoration must never do.
   */
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
          : await client.inlayHints(path, request.line ?? 0, request.limit ?? (request.line ?? 0) + 2000);
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

  /** Every occurrence of the caret's symbol in its own file, labelled read / write / neither. */
  private async documentHighlights(path: string, request: AnalysisRequest, onRevision: boolean): Promise<AnalysisResult> {
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

  private async documentSymbols(path: string, onRevision: boolean): Promise<AnalysisResult> {
    let fallbackReason = onRevision
      ? `Reading ${this.reviewTarget}, which no language server can be pointed at`
      : "Language server returned no structure for this file";
    let attempted = false;
    if (!onRevision) {
      while (true) {
        const client = this.clientFor(path);
        if (!client) {
          // Only when nothing was ever tried. A server that started and then failed has already put its
          // own reason here, and replacing it with "no language server is available" says the opposite of
          // what happened — which is what a Ruby file reported after sorbet died on it.
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
    // One file through the same declaration scanner the project index is built with, so the popup lists
    // what Find Usages would have found in this file and nothing invented for the occasion.
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

  /**
   * The call and type hierarchies.
   *
   * Each direction is one question, asked of the language server and — when it cannot answer — of the
   * regex index, with one exception named below. A server that does not implement the request is reported
   * as such rather than as an empty answer: "clangd has no call hierarchy" and "nothing calls this" are
   * different facts, and a reader who cannot tell them apart will believe the wrong one.
   */
  private async hierarchy(
    kind: "callers" | "callees" | "supertypes" | "subtypes",
    path: string,
    request: AnalysisRequest,
    onRevision: boolean,
  ): Promise<AnalysisResult> {
    const context = await this.symbolContext(path, request.line, request.column, request.symbol);
    if (!context.symbol) return { ok: true, engine: "index", confidence: "heuristic", locations: [], symbol: "" };
    let fallbackReason = onRevision
      ? `Reading ${this.reviewTarget}, which no language server can be pointed at`
      : "";
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
          const answer = kind === "callers" || kind === "callees"
            ? await client.callHierarchy(path, context.lineIndex, context.column, kind === "callers" ? "incoming" : "outgoing")
            : await client.typeHierarchy(path, context.lineIndex, context.column, kind === "supertypes" ? "supertypes" : "subtypes");
          this.setStatus("ready", serverFields(client.server));
          if (!answer.supported) {
            fallbackReason = `${client.server.name} does not offer ${kind === "callers" || kind === "callees" ? "a call hierarchy" : "a type hierarchy"}`;
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
          // The server answered, and the answer is "none". Say so as a semantic answer rather than
          // falling through to a heuristic that will invent neighbours for it.
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
          if (!this.transportFailure(error)) break;
          this.quarantine(client, error);
        }
      }
    }
    // Heuristic answers. Callers are references, which the index can find. Callees cannot be done this
    // way at all: a name index knows where names appear, not which of them are calls made from inside
    // this body, and a list of every identifier in a function is not a call hierarchy.
    if (kind === "callees") {
      return {
        ok: true,
        engine: "index",
        confidence: "heuristic",
        symbol: context.symbol,
        locations: [],
        revision: this.reviewTarget,
        // BOTH facts: why the server did not answer, and why the index cannot stand in for it. Either
        // alone leaves the reader to conclude that the function calls nothing.
        fallbackReason: (fallbackReason ? fallbackReason + "; " : "")
          + "a name index cannot tell a call from a mention",
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
    };
  }

  /**
   * Supertypes and subtypes read off declaration TEXT, for the languages whose syntax says it on the line:
   * `class Foo extends Bar implements Baz`, `class Foo(Bar):`, `struct Foo: Bar`.
   *
   * Heuristic and labelled as such — it reads a line, not a type system, so a generic parameter named like
   * a base class will be reported. That is still the difference between an answer and nothing for the
   * languages whose bundled server has no type hierarchy at all.
   */
  private async typeRelatives(name: string, direction: "supertypes" | "subtypes"): Promise<AnalysisLocation[]> {
    const index = await this.getIndex();
    // Rust states the relationship in a block of its own rather than on the type's line:
    // `impl Runnable for Store`. Those lines are read from the FILES rather than from the symbol index,
    // which records declarations and not relationships — and changing what the index records to suit one
    // query would change what every other query sees. Measured: without this, every Rust type reported no
    // supertypes at all whenever rust-analyzer was not answering (it offers no type hierarchy either).
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
      // Everything after extends/implements, or inside the parentheses of a Python class header, up to the
      // body. Names only — generics, commas and qualifiers are separators here.
      const tail = /(?:\bextends\b|\bimplements\b|\bis\b)([^{;]*)/.exec(text)?.[1]
        ?? /\bclass\s+\w+\s*\(([^)]*)\)/.exec(text)?.[1]
        ?? "";
      for (const candidate of tail.split(/[^A-Za-z0-9_$.]+/)) {
        const base = candidate.split(".").pop() ?? "";
        if (base && base !== name && !/^(public|private|protected|final|abstract|static|object|metaclass)$/i.test(base)) bases.add(base);
      }
    }
    // …and the same blocks in the other direction: what this type is given by an `impl X for Name`.
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

  // Drop server-reported locations that don't point at code (a comment/string/blank line). This needs the
  // MASKED form of each result line — but only for the result files, so mask those directly instead of
  // building (and, on every LSP-success nav, rebuilding) the whole-repo symbol index. Masking full file
  // content keeps multi-line comment/string awareness; each result file is read once for text + mask.
  private async navigationLocations(locations: AnalysisLocation[], limit = MAX_LOCATIONS): Promise<AnalysisLocation[]> {
    if (!locations.length) return [];
    const unique = uniqueLocations(locations, limit);
    const rawByPath = new Map<string, string[]>();
    const maskedByPath = new Map<string, string[]>();
    await Promise.all(Array.from(new Set(unique.map((item) => item.path))).map(async (path) => {
      if (documentPath(path)) return; // non-code doc target — filtered out below without a read
      // Unreadable (absent from this revision, over the cap, not code) leaves both maps unset, and the
      // filter below falls back to per-line masking of item.text — the old catch's behaviour.
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
        // Nothing to read and nothing to judge: an external target has no text by definition, and the
        // "does this line have visible characters" test below would drop every one of them.
        if (item.external) return true;
        const codeLine = maskedByPath.get(item.path)?.[item.lineIndex] ?? maskNonCode(item.text ?? "", item.path)[0] ?? "";
        const start = Math.max(0, Number(item.column) || 0);
        // Some servers report the beginning of indentation rather than the identifier itself. Looking from
        // that point to the end keeps those valid locations while a comment/string range remains all spaces.
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

// What counts as a type for Go to Class. The two engines answer differently and both are read: a language
// server sends LSP's numeric SymbolKind (mapped by name here so the list is readable), and the regex index
// sends the word its declaration patterns matched.
const TYPE_KIND_NAMES = new Set(["class", "interface", "struct", "enum", "object", "trait"]);
function isTypeLocation(item: AnalysisLocation & { symbolKind?: string }): boolean {
  if (typeof item.symbolKind === "string" && item.symbolKind) return TYPE_KIND_NAMES.has(item.symbolKind);
  if (item.kind === undefined) return false;
  return TYPE_KIND_NAMES.has(lspSymbolKindName(item.kind));
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
