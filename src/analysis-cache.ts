import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { SymbolRecord } from "./analysis-index.js";

const SCHEMA_VERSION = 1;

// A ceiling, so a year of launches cannot grow this forever: every version of every file that has ever been
// indexed would otherwise keep its entry. Retention is "what this session touched first, then what was there
// before, in the order the file held them" — the live tree always survives a trim.
// ponytail: insertion order as the eviction rule, no access counting. A store that trims every launch on a
// repository this large is a sign to key entries by commit instead, not to start tracking hit counts.
const MAX_ENTRIES = 20_000;

type CachedSymbol = [number, number, string, string] | [number, number, string, string, string];

type CacheFile = {
  schemaVersion: number;
  scanner: string;
  entries: Record<string, CachedSymbol[]>;
};

export type SymbolCache = {
  entryKey(path: string, content: string): string;
  get(key: string, path: string, lines: string[]): SymbolRecord[] | undefined;
  put(key: string, records: SymbolRecord[]): void;
  flush(): void;
  stats(): { hits: number; misses: number };
};

function scannerStamp(): string {
  try {
    const source = readFileSync(new URL("./analysis-index.js", import.meta.url));
    return createHash("sha1").update(source).digest("base64url").slice(0, 16);
  } catch {
    return `unknown-${Date.now()}`;
  }
}

function readCacheFile(file: string, scanner: string): Record<string, CachedSymbol[]> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CacheFile;
    if (parsed?.schemaVersion !== SCHEMA_VERSION || parsed.scanner !== scanner) return {};
    return parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {};
  } catch {
    return {};
  }
}

export function openSymbolCache(file: string): SymbolCache {
  const scanner = scannerStamp();
  const stored = readCacheFile(file, scanner);
  const touched = new Map<string, CachedSymbol[]>();
  let hits = 0;
  let misses = 0;
  let dirty = false;

  return {
    entryKey(path: string, content: string): string {
      if (!content) return "";
      return createHash("sha1")
        .update(extname(path).toLowerCase())
        .update("\0")
        .update(content)
        .digest("base64url")
        .slice(0, 22);
    },

    get(key: string, path: string, lines: string[]): SymbolRecord[] | undefined {
      if (!key) return undefined;
      const entry = touched.get(key) ?? stored[key];
      if (!entry) return undefined;
      const records: SymbolRecord[] = [];
      for (const [lineIndex, column, name, symbolKind, container] of entry) {
        const line = lines[lineIndex] ?? "";
        const record: SymbolRecord = { path, lineIndex, column, name, symbolKind, declaration: line, text: line };
        if (container) record.container = container;
        records.push(record);
      }
      touched.set(key, entry);
      hits += 1;
      return records;
    },

    put(key: string, records: SymbolRecord[]): void {
      if (!key) return;
      misses += 1;
      touched.set(
        key,
        records.map((record) =>
          record.container
            ? [record.lineIndex, record.column, record.name, record.symbolKind, record.container]
            : [record.lineIndex, record.column, record.name, record.symbolKind],
        ),
      );
      dirty = true;
    },

    flush(): void {
      if (!dirty) return;
      dirty = false;
      const entries: Record<string, CachedSymbol[]> = {};
      let count = 0;
      for (const [key, value] of touched) { entries[key] = value; count += 1; }
      for (const [key, value] of Object.entries(stored)) {
        if (count >= MAX_ENTRIES) break;
        if (key in entries) continue;
        entries[key] = value;
        count += 1;
      }
      const payload: CacheFile = { schemaVersion: SCHEMA_VERSION, scanner, entries };
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(temporary, JSON.stringify(payload));
        renameSync(temporary, file);
      } catch {
        try { unlinkSync(temporary); } catch { }
      }
    },

    stats(): { hits: number; misses: number } {
      return { hits, misses };
    },
  };
}
