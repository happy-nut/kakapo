import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AnalysisLocation } from "./lsp.js";
import { findRipgrepBinary } from "./search.js";

export type SymbolRecord = AnalysisLocation & {
  name: string;
  symbolKind: string;
  declaration: string;
  container?: string;
};

export type IndexedFile = { path: string; content: string };

export type RegexIndex = {
  files: Map<string, string>;
  codeLines: CodeLines;
  definitions: Map<string, SymbolRecord[]>;
  symbols: SymbolRecord[];
};

// Comment/string-masked source, one file at a time — which is the only way its four call sites ever read it
// (a path, then a line). Retaining the masked copy of every indexed file was a second full copy of the
// project's source held as ~930k individual line strings: 77MB on a 6k-file repo, per window, for lookups
// that touch the file under the cursor. `files` already holds the content, and masking one file is a single
// pass over it, so recompute on demand behind a small LRU instead.
// ponytail: fixed 32-file window, no byte accounting. Navigation works a file at a time; if a caller ever
// sweeps the whole project through here, give it a byte budget like ByteBudgetCache.
const CODE_LINES_CACHE = 32;
export class CodeLines {
  private readonly cache = new Map<string, string[]>();
  constructor(private readonly files: Map<string, string>) {}
  get(path: string): string[] | undefined {
    const hit = this.cache.get(path);
    if (hit) {
      this.cache.delete(path); // re-insert: insertion order is the LRU queue
      this.cache.set(path, hit);
      return hit;
    }
    const content = this.files.get(path);
    if (content === undefined) return undefined; // not indexed (or a document path the build skipped)
    const masked = maskNonCode(content, path);
    this.cache.set(path, masked);
    if (this.cache.size > CODE_LINES_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    return masked;
  }
  // The masked copy is keyed by path, so re-indexing a file in place has to evict it or every later
  // lookup reads the previous revision's lines.
  forget(path: string): void {
    this.cache.delete(path);
  }
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".php", ".cs", ".swift", ".scala", ".vue", ".svelte",
  ".graphql", ".gql", ".proto", ".sql", ".json", ".yaml", ".yml", ".toml",
]);
const MAX_INDEX_FILES = 30_000;
const MAX_INDEX_FILE_BYTES = 1_000_000;

// Which files the symbol index holds. listProjectFiles applies this to ripgrep's output and patchProjectIndex
// applies it to the review's records, so the two can never disagree about what belongs in the index — the
// whole point of patching is that what is left alone is still correct.
export function indexablePath(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase()) && !documentPath(path);
}

export function indexableContent(content: string): boolean {
  return Buffer.byteLength(content, "utf8") <= MAX_INDEX_FILE_BYTES && !content.includes("\0");
}

const DECLARATION_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "class", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|enum|annotation|static|export|default|expect|actual|value)\s+)*(class|interface|object|enum|trait|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "type", re: /^\s*(?:export\s+)?(interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "variable", re: /^\s*(?:export\s+)?(?:const|let|var|val)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "function", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\s+)*(?:fun|def|fn|func)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "method", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^=]+)?\s*(?:\{|=>)/ },
];

const HASH_COMMENT_EXTENSIONS = new Set([".py", ".rb", ".yaml", ".yml", ".toml"]);
const DOUBLE_DASH_COMMENT_EXTENSIONS = new Set([".sql"]);

// Preserve offsets while blanking comments and strings. Every heuristic consumer shares this one lexical
// policy, so definitions, references, and workspace symbols cannot silently disagree about what is code.
export function maskNonCode(content: string, path: string): string[] {
  const extension = extname(path).toLowerCase();
  const hashComments = HASH_COMMENT_EXTENSIONS.has(extension);
  const doubleDashComments = DOUBLE_DASH_COMMENT_EXTENSIONS.has(extension);
  const tripleQuotes = extension === ".py";
  let blockComment = false;
  let tripleQuote = "";
  return content.split(/\r?\n/).map((line) => {
    const out = line.split("");
    let quote = "";
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const nextTwo = line.slice(index, index + 2);
      const nextThree = line.slice(index, index + 3);
      if (blockComment) {
        out[index] = " ";
        if (nextTwo === "*/") {
          out[index + 1] = " ";
          index += 1;
          blockComment = false;
        }
        continue;
      }
      if (tripleQuote) {
        out[index] = " ";
        if (nextThree === tripleQuote) {
          out[index + 1] = out[index + 2] = " ";
          index += 2;
          tripleQuote = "";
        }
        continue;
      }
      if (quote) {
        out[index] = " ";
        if (escaped) escaped = false;
        else if (line[index] === "\\") escaped = true;
        else if (line[index] === quote) quote = "";
        continue;
      }
      if (tripleQuotes && (nextThree === '\"\"\"' || nextThree === "'''")) {
        tripleQuote = nextThree;
        out[index] = out[index + 1] = out[index + 2] = " ";
        index += 2;
        continue;
      }
      if (nextTwo === "/*") {
        out[index] = out[index + 1] = " ";
        index += 1;
        blockComment = true;
        continue;
      }
      if (nextTwo === "//" || (doubleDashComments && nextTwo === "--") || (hashComments && line[index] === "#")) {
        for (let rest = index; rest < out.length; rest += 1) out[rest] = " ";
        break;
      }
      if (line[index] === "'" || line[index] === '\"' || line[index] === "`") {
        quote = line[index];
        out[index] = " ";
      }
    }
    return out.join("");
  });
}

// An enum entry declares itself by standing alone on its line — `DONE,` — which matches none of the shapes
// above, so Cmd+B on one used to dead-end ("Definition not found") even though its usages were indexed. The
// shape is too weak to trust on its own (a bare name in a `setOf(...)` list looks identical), so it only
// counts inside an enum body, and only in the SCREAMING_SNAKE the convention uses.
const ENUM_ENTRY = /^\s*([A-Z][A-Z0-9_$]*)\s*(?:[,;(]|\{|$)/;

function declarationFromLine(path: string, line: string, lineIndex: number, sourceLine = line, inEnumBody = false): SymbolRecord | undefined {
  if (inEnumBody) {
    const entry = ENUM_ENTRY.exec(line);
    if (entry) {
      return {
        path,
        lineIndex,
        column: Math.max(0, line.indexOf(entry[1])),
        name: entry[1],
        symbolKind: "constant",
        declaration: sourceLine,
        text: sourceLine,
      };
    }
  }
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
      declaration: sourceLine,
      text: sourceLine,
    };
  }
  return undefined;
}

type IndexSink = {
  fileMap: Map<string, string>;
  definitions: Map<string, SymbolRecord[]>;
  symbols: SymbolRecord[];
};

function indexOneFile(file: IndexedFile, sink: IndexSink): void {
  const { fileMap, definitions, symbols } = sink;
  const path = file.path.replace(/\\/g, "/");
  if (documentPath(path)) return;
  fileMap.set(path, file.content);
  const lines = file.content.split(/\r?\n/);
  const masked = maskNonCode(file.content, path);
  const python = extname(path).toLowerCase() === ".py";
  const pythonClasses: Array<{ name: string; indent: number }> = [];
  // Indent of the `enum class`/`enum` line whose body we are inside, or -1. Entries live at a deeper
  // indent than it, and end at the body's closing brace or at the `;` that separates them from members.
  let enumIndent = -1;
  // `masked` is scanned for declarations below and then dropped — CodeLines re-derives it per file on demand.
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const code = masked[lineIndex];
    const trimmed = code.trim();
    const indent = code.match(/^[ \t]*/)?.[0].replace(/\t/g, "    ").length ?? 0;
    if (python && trimmed && !trimmed.startsWith("@")) {
      while (pythonClasses.length && indent <= pythonClasses[pythonClasses.length - 1].indent) pythonClasses.pop();
    }
    if (enumIndent >= 0 && trimmed && indent <= enumIndent && trimmed.startsWith("}")) enumIndent = -1;
    const record = declarationFromLine(path, code, lineIndex, lines[lineIndex], enumIndent >= 0 && indent > enumIndent);
    if (enumIndent >= 0 && trimmed === ";") enumIndent = -1; // Java/Kotlin: entries end, members begin
    if (!record) continue;
    if (record.symbolKind === "enum" || /\benum\s+(class\s+)?[A-Za-z_$]/.test(trimmed)) enumIndent = indent;
    if (python && pythonClasses.length && indent > pythonClasses[pythonClasses.length - 1].indent) {
      record.container = pythonClasses[pythonClasses.length - 1].name;
      if (record.symbolKind === "function") record.symbolKind = "method";
    }
    symbols.push(record);
    const entries = definitions.get(record.name) ?? [];
    entries.push(record);
    definitions.set(record.name, entries);
    if (python && record.symbolKind === "class") pythonClasses.push({ name: record.name, indent });
  }
}

function emptySink(): IndexSink {
  return { fileMap: new Map(), definitions: new Map(), symbols: [] };
}

const asRegexIndex = (sink: IndexSink): RegexIndex =>
  ({ files: sink.fileMap, codeLines: new CodeLines(sink.fileMap), definitions: sink.definitions, symbols: sink.symbols });

export function buildRegexSymbolIndex(files: IndexedFile[]): RegexIndex {
  const sink = emptySink();
  for (const file of files) indexOneFile(file, sink);
  return asRegexIndex(sink);
}

// The same work, yielding to the event loop as it goes.
//
// The scan is the expensive half and it is pure CPU: measured on a 3,000-file repository, reading every
// file took 152 ms (already batched, already yielding) and scanning them took ~1,900 ms in ONE synchronous
// block. This runs in the main process, so that block stalls IPC, the window and every other query for its
// whole duration — a two-second freeze wherever it happens to land.
//
// Chunking does not make it faster, and is not meant to: on that repository the total was 1,832 ms
// synchronous and 1,769 ms chunked. What changes is the longest single stall, which was the whole
// 1,832 ms before.
//
// The budget is in BYTES, not files. Counting files put one 2 MB file in the same uninterrupted chunk as
// seven neighbours, and the two worst stalls left (136 ms and 98 ms) were exactly that; a byte budget
// gives a big file its own boundary. What it cannot do is split one file — a single file at the
// MAX_INDEX_FILE_BYTES ceiling is the floor on this, and chunking inside a file is not worth the seams.
//
// (A sampling timer reports the synchronous version's worst stall as 0 ms, which is the measurement
// failing rather than the code behaving: the sampler never gets to run during the block it is measuring.)
export async function buildRegexSymbolIndexChunked(files: IndexedFile[], budget = 128 * 1024): Promise<RegexIndex> {
  const sink = emptySink();
  let pending = 0;
  for (const file of files) {
    indexOneFile(file, sink);
    pending += file.content.length;
    if (pending >= budget) {
      pending = 0;
      await new Promise<void>((resolveChunk) => setImmediate(resolveChunk));
    }
  }
  return asRegexIndex(sink);
}

// Re-index a handful of files inside an index that is otherwise still correct, instead of rebuilding the
// project around them.
//
// buildProjectIndex re-walks the tree with ripgrep, re-reads every file and re-scans every line: 210ms on
// this 212-file repository, and ~1,900ms of scan alone on a 3,000-file one, measured. It ran on every save,
// in the main process, because one file changed. Everything it rebuilt but the changed file was identical to
// what it threw away.
//
// Removing a path's records is the delicate half. `symbols` is the only structure that knows which names a
// path contributed, so it is read BEFORE it is filtered — that keeps the pass over `definitions` to the
// names this path actually touched, and leaving one record behind would mean a jump into a line that no
// longer exists. A wrong answer is worse than a slow one, so the whole removal happens for every touched
// path, including paths being re-indexed rather than dropped.
export function patchProjectIndex(index: RegexIndex, files: IndexedFile[], removed: string[] = []): void {
  const normalize = (path: string) => path.replace(/\\/g, "/");
  const incoming = files
    .map((file) => ({ path: normalize(file.path), content: file.content }))
    .filter((file) => indexablePath(file.path) && indexableContent(file.content));
  const touched = new Set<string>(incoming.map((file) => file.path));
  for (const path of removed) {
    const normalized = normalize(path);
    if (indexablePath(normalized)) touched.add(normalized);
  }
  if (!touched.size) return;

  const names = new Set<string>();
  for (const record of index.symbols) if (touched.has(record.path)) names.add(record.name);
  index.symbols = index.symbols.filter((record) => !touched.has(record.path));
  for (const name of names) {
    const kept = (index.definitions.get(name) ?? []).filter((record) => !touched.has(record.path));
    if (kept.length) index.definitions.set(name, kept);
    else index.definitions.delete(name);
  }
  for (const path of touched) {
    index.files.delete(path);
    index.codeLines.forget(path);
  }

  // The same sink the full build fills, pointed at the live index: `symbols` is the array just filtered, so
  // indexOneFile's pushes land in the index itself.
  const sink: IndexSink = { fileMap: index.files, definitions: index.definitions, symbols: index.symbols };
  for (const file of incoming) indexOneFile(file, sink);
}

async function listProjectFiles(root: string): Promise<string[]> {
  const rg = findRipgrepBinary();
  if (!rg) return [];
  return new Promise((resolveFiles) => {
    const child = spawn(rg, ["--files", "--hidden", "--no-messages", "-g", "!.git/**"], {
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
        .filter((path) => path && indexablePath(path))
        .slice(0, MAX_INDEX_FILES);
      resolveFiles(files);
    });
  });
}

export async function buildProjectIndex(root: string): Promise<RegexIndex> {
  const paths = await listProjectFiles(root);
  const files: IndexedFile[] = [];
  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = paths.slice(offset, offset + 32);
    const loaded = await Promise.all(batch.map(async (path): Promise<IndexedFile | undefined> => {
      try {
        const content = await readFile(join(root, path), "utf8");
        if (!indexableContent(content)) return undefined;
        return { path, content };
      } catch {
        return undefined;
      }
    }));
    for (const file of loaded) if (file) files.push(file);
    await new Promise<void>((resolveBatch) => setImmediate(resolveBatch));
  }
  return buildRegexSymbolIndexChunked(files);
}

export function safeRelativePath(root: string, path: string | undefined): string | undefined {
  if (!path || isAbsolute(path)) return undefined;
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const absolute = resolve(root, normalized);
  const rel = relative(root, absolute).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../")) return undefined;
  return rel;
}

// The identifier under `column`, WITH where it starts. The start is not a nicety: a caller that only gets the
// name has to find it again, and `line.indexOf(name)` finds the wrong one whenever the name also appears
// inside an earlier identifier on that line — `Locale` sits inside `normalizeLocale`, `Path` inside
// `filePath`. Asking a language server about that relocated column answers about the wrong symbol.
export function identifierSpanAt(text: string, column: number): { name: string; start: number } | undefined {
  const position = Math.max(0, Math.min(column, text.length));
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (position >= match.index && position <= match.index + match[0].length) return { name: match[0], start: match.index };
  }
  return undefined;
}

export function documentPath(path: string): boolean {
  return /\.(?:md|mdx|txt|rst|adoc)$/i.test(path) || /(^|\/)(docs?|documentation|notes?|release-notes)(\/|$)/i.test(path);
}
