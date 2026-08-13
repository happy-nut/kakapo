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
}

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx", ".php", ".cs", ".swift", ".scala", ".vue", ".svelte",
  ".graphql", ".gql", ".proto", ".sql", ".json", ".yaml", ".yml", ".toml",
]);
const MAX_INDEX_FILES = 30_000;
const MAX_INDEX_FILE_BYTES = 1_000_000;

const DECLARATION_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "function", re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
  { kind: "class", re: /^\s*(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|annotation|static|export|default|expect|actual|value)\s+)*(class|interface|object|enum|trait|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)/ },
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

function declarationFromLine(path: string, line: string, lineIndex: number, sourceLine = line): SymbolRecord | undefined {
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

export function buildRegexSymbolIndex(files: IndexedFile[]): RegexIndex {
  const fileMap = new Map<string, string>();
  const definitions = new Map<string, SymbolRecord[]>();
  const symbols: SymbolRecord[] = [];
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    if (documentPath(path)) continue;
    fileMap.set(path, file.content);
    const lines = file.content.split(/\r?\n/);
    const masked = maskNonCode(file.content, path);
    const python = extname(path).toLowerCase() === ".py";
    const pythonClasses: Array<{ name: string; indent: number }> = [];
    // `masked` is scanned for declarations below and then dropped — CodeLines re-derives it per file on demand.
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const code = masked[lineIndex];
      const trimmed = code.trim();
      const indent = code.match(/^[ \t]*/)?.[0].replace(/\t/g, "    ").length ?? 0;
      if (python && trimmed && !trimmed.startsWith("@")) {
        while (pythonClasses.length && indent <= pythonClasses[pythonClasses.length - 1].indent) pythonClasses.pop();
      }
      const record = declarationFromLine(path, code, lineIndex, lines[lineIndex]);
      if (!record) continue;
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
  return { files: fileMap, codeLines: new CodeLines(fileMap), definitions, symbols };
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
        .filter((path) => path && CODE_EXTENSIONS.has(extname(path).toLowerCase()) && !documentPath(path))
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
        if (Buffer.byteLength(content, "utf8") > MAX_INDEX_FILE_BYTES || content.includes("\0")) return undefined;
        return { path, content };
      } catch {
        return undefined;
      }
    }));
    for (const file of loaded) if (file) files.push(file);
    await new Promise<void>((resolveBatch) => setImmediate(resolveBatch));
  }
  return buildRegexSymbolIndex(files);
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

export function identifierAt(text: string, column: number): string | undefined {
  return identifierSpanAt(text, column)?.name;
}

export function documentPath(path: string): boolean {
  return /\.(?:md|mdx|txt|rst|adoc)$/i.test(path) || /(^|\/)(docs?|documentation|notes?|release-notes)(\/|$)/i.test(path);
}
