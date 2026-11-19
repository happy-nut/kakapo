import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { SymbolCache } from "./analysis-cache.js";
import type { AnalysisLocation } from "./lsp.js";
import { findRipgrepBinary } from "./search.js";
import { listRevisionFiles, readRevisionBlobs } from "./git-tree.js";

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

const CODE_LINES_CACHE = 32;
export class CodeLines {
  private readonly cache = new Map<string, string[]>();
  constructor(private readonly files: Map<string, string>) {}
  get(path: string): string[] | undefined {
    const hit = this.cache.get(path);
    if (hit) {
      this.cache.delete(path);
      this.cache.set(path, hit);
      return hit;
    }
    const content = this.files.get(path);
    if (content === undefined) return undefined;
    const masked = maskNonCode(content, path);
    this.cache.set(path, masked);
    if (this.cache.size > CODE_LINES_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    return masked;
  }
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

export function indexablePath(path: string): boolean {
  return CODE_EXTENSIONS.has(extname(path).toLowerCase()) && !documentPath(path);
}

export function indexableContent(content: string): boolean {
  return Buffer.byteLength(content, "utf8") <= MAX_INDEX_FILE_BYTES && !content.includes("\0");
}

const NOT_A_TYPE = "new|return|await|yield|throw|else|do|case|assert|delete|typeof|instanceof|export|import|function";
const RETURN_TYPE_BEFORE_NAME =
  `(?!(?:${NOT_A_TYPE})\\b)[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:<(?:[^<>()]|<[^<>()]*>)*>)?(?:\\[\\s*\\]|[*?])*`;
const RETURN_TYPE_BEFORE_NAME_EXTENSIONS = new Set([
  ".java", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx",
]);

const DECLARATION_PATTERNS: Array<{ kind: string; re: RegExp; extensions?: Set<string> }> = [
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "class", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|enum|annotation|static|export|default|expect|actual|value|pub(?:\([^)]*\))?)\s+)*(?<keyword>class|interface|object|enum|trait|struct)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "type", re: /^\s*(?:export\s+)?(?<keyword>interface|type|enum)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "variable", re: /^\s*(?:export\s+)?(?:const|let|var|val)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "function", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\s+)*(?:fun|def|fn|func)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "method", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\s+)*(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*\((?<parameters>[^)]*)\)\s*(?::\s*[^=]+)?\s*(?:\{|=>)/ },
  {
    kind: "method",
    extensions: RETURN_TYPE_BEFORE_NAME_EXTENSIONS,
    re: new RegExp(
      `^\\s*(?:${RETURN_TYPE_BEFORE_NAME}\\s+)+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\\s*\\((?<parameters>[^)]*)\\)\\s*(?::\\s*[^=]+)?\\s*(?:\\{|=>|;)`,
    ),
  },
];

const NOT_A_DECLARED_NAME = /^(?:if|for|while|switch|catch|with|function|return|new|typeof|void|delete|throw|await|yield)$/;

function isParameterList(text: string): boolean {
  for (let at = text.indexOf("("); at >= 0; at = text.indexOf("(", at + 1)) {
    if (!text.slice(0, at).trimEnd().endsWith(":")) return false;
  }
  return true;
}

const HASH_COMMENT_EXTENSIONS = new Set([".py", ".rb", ".yaml", ".yml", ".toml"]);
const DOUBLE_DASH_COMMENT_EXTENSIONS = new Set([".sql"]);

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

const ENUM_ENTRY = /^\s*([A-Z][A-Z0-9_$]*)\s*(?:[,;(]|\{|$)/;

function declarationFromLine(path: string, extension: string, line: string, lineIndex: number, sourceLine = line, inEnumBody = false): SymbolRecord | undefined {
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
    if (pattern.extensions && !pattern.extensions.has(extension)) continue;
    const match = pattern.re.exec(line);
    if (!match) continue;
    const name = match.groups?.name ?? "";
    if (!name || NOT_A_DECLARED_NAME.test(name)) continue;
    const parameters = match.groups?.parameters;
    if (parameters !== undefined && !isParameterList(parameters)) continue;
    return {
      path,
      lineIndex,
      column: Math.max(0, line.indexOf(name)),
      name,
      symbolKind: pattern.kind === "class" ? (match.groups?.keyword ?? "class") : pattern.kind,
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

function pushSymbol(sink: IndexSink, record: SymbolRecord): void {
  sink.symbols.push(record);
  const entries = sink.definitions.get(record.name) ?? [];
  entries.push(record);
  sink.definitions.set(record.name, entries);
}

function indexOneFile(file: IndexedFile, sink: IndexSink, cache?: SymbolCache): void {
  const { fileMap, symbols } = sink;
  const path = file.path.replace(/\\/g, "/");
  if (documentPath(path)) return;
  fileMap.set(path, file.content);
  const lines = file.content.split(/\r?\n/);
  const key = cache?.entryKey(path, file.content) ?? "";
  const cached = key ? cache?.get(key, path, lines) : undefined;
  if (cached) {
    for (const record of cached) pushSymbol(sink, record);
    return;
  }
  const scannedFrom = symbols.length;
  const masked = maskNonCode(file.content, path);
  const extension = extname(path).toLowerCase();
  const python = extension === ".py";
  const pythonClasses: Array<{ name: string; indent: number }> = [];
  let enumIndent = -1;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const code = masked[lineIndex];
    const trimmed = code.trim();
    const indent = code.match(/^[ \t]*/)?.[0].replace(/\t/g, "    ").length ?? 0;
    if (python && trimmed && !trimmed.startsWith("@")) {
      while (pythonClasses.length && indent <= pythonClasses[pythonClasses.length - 1].indent) pythonClasses.pop();
    }
    if (enumIndent >= 0 && trimmed && indent <= enumIndent && trimmed.startsWith("}")) enumIndent = -1;
    const record = declarationFromLine(path, extension, code, lineIndex, lines[lineIndex], enumIndent >= 0 && indent > enumIndent);
    if (enumIndent >= 0 && trimmed === ";") enumIndent = -1;
    if (!record) continue;
    if (record.symbolKind === "enum" || /\benum\s+(class\s+)?[A-Za-z_$]/.test(trimmed)) enumIndent = indent;
    if (python && pythonClasses.length && indent > pythonClasses[pythonClasses.length - 1].indent) {
      record.container = pythonClasses[pythonClasses.length - 1].name;
      if (record.symbolKind === "function") record.symbolKind = "method";
    }
    pushSymbol(sink, record);
    if (python && record.symbolKind === "class") pythonClasses.push({ name: record.name, indent });
  }
  if (key) cache?.put(key, symbols.slice(scannedFrom));
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

export async function buildRegexSymbolIndexChunked(
  files: IndexedFile[],
  budget = 128 * 1024,
  cache?: SymbolCache,
): Promise<RegexIndex> {
  const sink = emptySink();
  let pending = 0;
  for (const file of files) {
    indexOneFile(file, sink, cache);
    pending += file.content.length;
    if (pending >= budget) {
      pending = 0;
      await new Promise<void>((resolveChunk) => setImmediate(resolveChunk));
    }
  }
  cache?.flush();
  return asRegexIndex(sink);
}

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

export async function buildProjectIndex(root: string, cache?: SymbolCache): Promise<RegexIndex> {
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
  return buildRegexSymbolIndexChunked(files, undefined, cache);
}

export async function buildProjectIndexAtRevision(root: string, revision: string, cache?: SymbolCache): Promise<RegexIndex> {
  const paths = listRevisionFiles(root, revision)
    .filter((path) => indexablePath(path))
    .slice(0, MAX_INDEX_FILES);
  const blobs = await readRevisionBlobs(root, revision, paths, { maxBytes: MAX_INDEX_FILE_BYTES });
  return buildRegexSymbolIndexChunked(blobs, undefined, cache);
}

export function safeRelativePath(root: string, path: string | undefined): string | undefined {
  if (!path || isAbsolute(path)) return undefined;
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const absolute = resolve(root, normalized);
  const rel = relative(root, absolute).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../")) return undefined;
  return rel;
}

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
