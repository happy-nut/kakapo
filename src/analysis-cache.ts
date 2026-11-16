import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { SymbolRecord } from "./analysis-index.js";

// The symbol scan, kept between launches.
//
// buildProjectIndex re-walks the tree, re-reads every file and re-scans every line on every launch, and the
// scan is almost all of it: measured, walk 21–30 ms, read 24–260 ms, scan 228 ms (294 files) / 2,661 ms
// (3,513) / 2,517 ms (5,551). An agent writes in a worktree and the reviewer opens kakapo there; that scan
// runs again for a tree that moved in 12 of 328 files. Everything it rebuilt but those was identical to what
// the previous launch threw away.
//
// So the derived half is kept and the reading is not. The contents have to be read regardless — the index
// holds them for usage scanning — and reading is the cheap half anyway.
//
// WHY THE KEY IS THE CONTENT, NOT THE PATH. indexOneFile depends on the path in exactly two ways, both of
// them the extension: maskNonCode picks the comment syntax from it, and `.py` gets the class-container pass.
// Everything else comes from the text. So an entry keyed by (extension, content) is valid for that text
// wherever it lives — which is the whole point here: a fresh worktree of the same repository differs in
// 12 of 328 files (0.3–3% measured across three repositories), a renamed file is not a new file, and two
// worktrees at different revisions can share one store without overwriting each other's entries. Keyed by
// path, the second worktree would evict the first's and both would keep missing.
//
// Stored per repository rather than per workspace (app-main keys it off commonGitDir) for the same reason,
// and under the application's user-data mirror, never in the reviewed project.

const SCHEMA_VERSION = 1;

// A ceiling, so a year of launches cannot grow this forever: every version of every file that has ever been
// indexed would otherwise keep its entry. Retention is "what this session touched first, then what was there
// before, in the order the file held them" — the live tree always survives a trim.
// ponytail: insertion order as the eviction rule, no access counting. A store that trims every launch on a
// repository this large is a sign to key entries by commit instead, not to start tracking hit counts.
const MAX_ENTRIES = 20_000;

// One symbol as stored: [lineIndex, column, name, symbolKind, container?].
//
// `declaration` and `text` are both the source line (indexOneFile passes `lines[lineIndex]` as both), and
// `path` is the file being indexed, so all three come back from the content itself. Dropping them is what
// makes this 6 MB for the 180k symbols of a 5,551-file repository rather than four times that.
type CachedSymbol = [number, number, string, string] | [number, number, string, string, string];

type CacheFile = {
  schemaVersion: number;
  // Fingerprint of the scanner that produced these records; see scannerStamp.
  scanner: string;
  entries: Record<string, CachedSymbol[]>;
};

export type SymbolCache = {
  /** Cache key for one file's text, or "" when this file cannot be cached. */
  entryKey(path: string, content: string): string;
  /** The file's symbols, rebuilt from the stored records and the lines they came from. */
  get(key: string, path: string, lines: string[]): SymbolRecord[] | undefined;
  put(key: string, records: SymbolRecord[]): void;
  /** Write the store back, if anything was added. Cheap and idempotent when nothing was. */
  flush(): void;
  /** Entries served from the store, and entries scanned, since this cache was opened (for the trace). */
  stats(): { hits: number; misses: number };
};

/**
 * What produced the stored records.
 *
 * A cache of DERIVED values is only valid while the deriving code is unchanged: add a declaration pattern or
 * fix the masker and every stored entry becomes a wrong answer to "where is this symbol" — the one kind of
 * wrongness this repository treats as worse than slow. Rather than a hand-maintained version that a later
 * change forgets to bump, fingerprint the scanner's own source: it is one file, it is where every pattern
 * lives, and editing it invalidates the store by construction, dev builds included.
 */
function scannerStamp(): string {
  try {
    const source = readFileSync(new URL("./analysis-index.js", import.meta.url));
    return createHash("sha1").update(source).digest("base64url").slice(0, 16);
  } catch {
    // Cannot tell what the scanner is, so cannot tell whether the store matches it: use a stamp nothing can
    // match. A cache that silently serves records from another scanner is the failure this guards.
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

/**
 * Open (or start) the symbol store at `file`.
 *
 * Reading is eager and synchronous: this is called on the index build's own path, the file is a few MB at
 * most, and the alternative is a first query racing the load. A missing, unreadable, truncated or
 * foreign-scanner store simply starts empty — every path here degrades to today's full scan.
 */
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
      // The extension is part of the key because it is the only thing about the path the scan reads.
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
      // Re-record it so a trim keeps what this session actually used.
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
      // tmp + rename: a store half-written by a killed app reads as no store, not as a corrupt one, and two
      // worktrees of the same repository flushing at once lose entries rather than the file.
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(temporary, JSON.stringify(payload));
        renameSync(temporary, file);
      } catch {
        try { unlinkSync(temporary); } catch { /* nothing to clean up */ }
      }
    },

    stats(): { hits: number; misses: number } {
      return { hits, misses };
    },
  };
}
