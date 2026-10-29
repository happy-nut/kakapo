import { closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolve a path the renderer asked for, inside `root`, or undefined if it leaves the root.
 *
 * A lexical check alone (resolve + relative + "../") is not enough, because the reviewed repository can
 * track a symlink: `leak.png -> ../../../../.ssh/id_rsa` keeps the LINK inside the root, and every reader in
 * node_fs follows it. So the containment question is asked about the canonical path, and the canonical path
 * is what gets returned and read. Returns undefined for anything that does not resolve (a dangling link,
 * a missing file), which every caller already treats as "nothing to show".
 */
export function containedRealPath(root: string, requested: string): string | undefined {
  if (!requested || isAbsolute(requested)) return undefined;
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(resolve(root));
    realTarget = realpathSync(resolve(realRoot, requested));
  } catch {
    return undefined;
  }
  const within = relative(realRoot, realTarget);
  if (!within || within === ".." || within.startsWith("../") || within.startsWith("..\\") || isAbsolute(within)) {
    return undefined;
  }
  return realTarget;
}

export function stripHtmlTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

// Normalize an unknown thrown value to a message string — the `catch (error)` idiom used throughout the app.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&");
}

/**
 * Undo git's C-style quoting of a path it prints.
 *
 * `core.quotePath=false` (RAW_PATHS in git.ts) stops git escaping non-ASCII bytes, but it does NOT stop the
 * quoting of a path containing `"`, `\`, a tab or a newline — git wraps those in double quotes and escapes
 * the offending bytes whatever quotePath says. Left raw, a file named `quo"te.ts` arrived as the literal
 * `"b/quo\"te.ts"`: the leading quote hid the `b/` prefix from stripDiffPath, the tree grew a phantom `"b`
 * directory, nothing could stat the file, and the record came back "file is not present in the working
 * tree" — which is the exact string commentFileIsKnownMissing matches, so every comment on that file was
 * deleted and saved away.
 */
export function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "\\") { out += body[i]; continue; }
    const next = body[i + 1];
    if (next === undefined) break;
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      // Non-ASCII bytes come through as one escape per BYTE, so collect the whole run and decode it as
      // UTF-8 in one go — decoding each byte on its own would mangle every multi-byte character.
      const bytes: number[] = [];
      while (/^\\[0-7]{3}/.test(body.slice(i, i + 4))) {
        bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
        i += 4;
      }
      i -= 1;
      out += Buffer.from(bytes).toString("utf8");
      continue;
    }
    out += next === "t" ? "\t" : next === "n" ? "\n" : next === "r" ? "\r" : next;
    i += 1;
  }
  return out;
}

/**
 * Whether a repository-relative path stays inside the root it is about to be joined to. Pure string math:
 * it runs over every changed path on the way to first paint, and the path may not exist yet.
 *
 * Every path kakapo indexes comes from git, and git never writes `..` or an absolute path in a diff header
 * — which is exactly why nothing checked. Then one line of a reviewed file could reach a header (an added
 * `++ b/…` line, read as `+++ b/…`; see parseUnifiedDiff) and the content of the repository under review
 * chose which file the index read. A parser is a trust boundary when what it parses is not the author's.
 */
export function isContainedRelativePath(path: string): boolean {
  const normalized = String(path || "").replace(/\\/g, "/");
  if (!normalized || isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

export function stripDiffPath(value: string): string {
  if (value === "/dev/null") {
    return value;
  }
  return unquoteGitPath(value).replace(/^[ab]\//, "");
}

export function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".sass")) return "css";
  // Single-file component formats are HTML with <script>/<style> blocks, so they read as markup — which
  // hljs resolves to its `xml` grammar, and that grammar hands the script block to javascript and the style
  // block to css as sublanguages. No dedicated Svelte/Vue grammar ships with highlight.js.
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xml") || lower.endsWith(".svg")
    || lower.endsWith(".svelte") || lower.endsWith(".vue")) return "markup";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  // Kotlin used to ride along as "java", which cost it its own vocabulary everywhere this value is read:
  // the source view painted `fun`, `override` and `companion object` as plain text (and `type`, an ordinary
  // Kotlin parameter name, as a keyword), and hljs needed a special case here to reach its kotlin grammar.
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".http") || lower.endsWith(".rest")) return "http";
  return "text";
}

/**
 * The encoding a byte-order mark declares, or null when there is none (or when it declares one we cannot
 * read). A BOM is a file saying what it is, and two places here would otherwise get it wrong: the NUL sniff
 * below, because every other byte of UTF-16 text IS a NUL, and the read itself, because a UTF-8 read of
 * UTF-16 is mojibake. PowerShell redirection and a good deal of Windows tooling still write UTF-16 — a
 * MANIFEST.MF or .properties produced that way is perfectly readable text that kakapo refused as binary.
 *
 * UTF-32 deliberately returns null: its NULs are not an encoding artefact we can undo with swap16, so the
 * sniff should go on calling it binary rather than show four bytes per character.
 */
function bomEncodingOf(head: Buffer): "utf16le" | "utf16be" | "utf8" | null {
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xfe && head[2] === 0x00 && head[3] === 0x00) return null;
  if (head.length >= 4 && head[0] === 0x00 && head[1] === 0x00 && head[2] === 0xfe && head[3] === 0xff) return null;
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return "utf16le";
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return "utf16be";
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return "utf8";
  return null;
}

/**
 * Decode a file's bytes as text, honouring its BOM and dropping it. The mark has to go: left in the string
 * it is an invisible first character of the first line, which shows up as a phantom column in the gutter,
 * in find, and in every offset a language server is given.
 */
export function decodeTextBuffer(buf: Buffer): string {
  switch (bomEncodingOf(buf)) {
    case "utf16le": return buf.subarray(2).toString("utf16le");
    // swap16 mutates and needs an even length, so copy and drop a trailing odd byte rather than throw on a
    // truncated file.
    case "utf16be": {
      const body = buf.subarray(2, 2 + (((buf.length - 2) >> 1) << 1));
      return Buffer.from(body).swap16().toString("utf16le");
    }
    case "utf8": return buf.subarray(3).toString("utf8");
    default: return buf.toString("utf8");
  }
}

export function readTextFile(path: string): string {
  return decodeTextBuffer(readFileSync(path));
}

export function isLikelyBinary(path: string): boolean {
  // Read only the first 8KB — a NUL byte in the head is our binary heuristic. The previous version read
  // the WHOLE file just to slice 8KB off it, which on a large repo means re-reading every tracked file
  // in full on each build (a major chunk of the per-second watch cost).
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, 8000, 0);
    const head = buf.subarray(0, n);
    if (bomEncodingOf(head)) return false; // a BOM says text, whatever NULs its encoding needs
    return head.includes(0);
  } finally {
    closeSync(fd);
  }
}

export function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

export function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return parsed;
}

// The GitHub owner (user/org) in a git remote URL — handles https://github.com/<owner>/<repo>(.git),
// git@github.com:<owner>/<repo>.git, and ssh://git@github.com/<owner>/<repo>. Returns undefined for a
// non-GitHub or unparseable remote. Pure string parse (the caller reads the remote URL from git).
export function githubOwnerFromUrl(url: string): string | undefined {
  const match = url.match(/github\.com[:/]+([^/]+)\/[^/]+/i);
  return match ? match[1] : undefined;
}

export function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }
  return `${(kib / 1024).toFixed(1)} MiB`;
}

// A Map that forgets. Long-lived caches in the main process are keyed by path and hold whole file bodies, so
// without a ceiling they retain everything the process ever touched — heap that only ever grows as the
// reviewer moves between worktrees. Insertion order makes the Map its own LRU queue: a hit re-inserts at the
// back, and an overflowing insert drops from the front until the budget is met.
export class ByteBudgetCache<V> {
  private readonly entries = new Map<string, { value: V; bytes: number }>();
  private total = 0;

  constructor(private readonly limitBytes: number, private readonly sizeOf: (value: V) => number) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit); // most recently used is evicted last
    return hit.value;
  }

  set(key: string, value: V): void {
    const previous = this.entries.get(key);
    if (previous) this.total -= previous.bytes;
    const bytes = this.sizeOf(value);
    this.entries.delete(key);
    this.entries.set(key, { value, bytes });
    this.total += bytes;
    for (const [oldest, held] of this.entries) {
      if (this.total <= this.limitBytes || oldest === key) break; // never evict what was just stored
      this.entries.delete(oldest);
      this.total -= held.bytes;
    }
  }

  // What it is holding right now. The budget is only meaningful if something can see it.
  stats(): { entries: number; bytes: number; limit: number } {
    return { entries: this.entries.size, bytes: this.total, limit: this.limitBytes };
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}

// --- Persistent terminals ----------------------------------------------------------------------------
// A pty lives in our main process, so quitting kakapo closes its master and SIGHUPs whatever ran inside —

// --- Whitespace runs ---------------------------------------------------------------------------------
// Whitespace a reader cannot see is still whitespace a diff counts. kakapo's ⌘⇧W chooses whether it COUNTS
// as a change; this is the other half — whether you can SEE it. IntelliJ spells them Show Whitespaces and
// Show Indent Guides, two settings over the same thing: the run of blanks at the start of a line, and the
// run nobody meant to leave at the end.
//
// Both halves of the app render code, and both go through here, so there is one definition of what a
// whitespace run is: `src/highlight.ts` for the diff (built in main) and the viewer's renderSourceTable for
// the source view, which gets this exact function emitted into its bundle by scripts/copy-viewer-assets.mjs.
//
// Only the LEADING and TRAILING runs are marked, never the gaps between tokens. A span per inner gap would
// be a span per word on every line of every file, and this app's DOM size is already a measured constraint
// (169 MB for a 130-file diff). Leading and trailing are also the two that carry information: how deep the
// line sits, and what was left behind. CSS draws them — one dot per column cell, guides every N columns —
// so turning either display on re-paints and never re-renders.
//
// `data-ws` says what the leading run is MADE of, which no amount of dots can show: a file that mixes tabs
// and spaces reads identically until something else parses it.
export function markWhitespaceRuns(html: string): string {
  if (!html || !/[ \t]/.test(html)) return html;
  // Tags are kept verbatim; only the text between them is examined. Text segments are already escaped, so
  // no `<` can appear inside one and this split cannot cut a tag in half.
  const parts = html.split(/(<[^>]*>)/);
  const textAt: number[] = [];
  for (let i = 0; i < parts.length; i += 1) if (i % 2 === 0 && parts[i]) textAt.push(i);
  if (!textAt.length) return html;

  const kindOf = (run: string) => (run.includes("\t") ? (run.includes(" ") ? "mixed" : "tabs") : "spaces");
  const wrap = (run: string, className: string) =>
    `<span class="${className}" data-ws="${kindOf(run)}">${run}</span>`;

  // A run can cross a tag: a highlighter may put the indentation outside the first span and the code
  // inside it, so "the leading run" is a walk over text segments, not a regex on the first one. Each
  // whole-blank segment is taken entirely and the walk continues; the first segment with real text ends
  // the run inside itself. `claimed` is how many characters of each segment a run has already taken, so
  // the two runs cannot both claim the same blank on a line that is nothing but blanks.
  const claimed = new Map<number, { lead: number; trail: number }>();
  const claimOf = (index: number) => {
    let entry = claimed.get(index);
    if (!entry) { entry = { lead: 0, trail: 0 }; claimed.set(index, entry); }
    return entry;
  };
  const free = (index: number) => parts[index].length - claimOf(index).lead - claimOf(index).trail;

  // Trailing first: on an all-blank line it should win, because "left behind" is the truer reading of it.
  for (let n = textAt.length - 1; n >= 0; n -= 1) {
    const index = textAt[n];
    const text = parts[index];
    const run = /[ \t]*$/.exec(text)![0].length;
    claimOf(index).trail = Math.min(run, free(index));
    if (run < text.length) break;                      // this segment has real text: the run ends here
  }
  for (let n = 0; n < textAt.length; n += 1) {
    const index = textAt[n];
    const text = parts[index];
    const run = /^[ \t]*/.exec(text)![0].length;
    claimOf(index).lead = Math.min(run, free(index));
    if (run < text.length) break;
  }

  for (const [index, { lead, trail }] of claimed) {
    if (!lead && !trail) continue;
    const text = parts[index];
    const middle = text.slice(lead, text.length - trail);
    parts[index] = (lead ? wrap(text.slice(0, lead), "ws-lead") : "")
      + middle
      + (trail ? wrap(text.slice(text.length - trail), "ws-trail") : "");
  }
  return parts.join("");
}

/**
 * Which module a path belongs to, and what is left of the path inside it.
 *
 * IntelliJ's Project window makes the module the top node and hangs the content root's files under it, so
 * a reviewer reads "which module changed" before "which folder". All three of this app's trees are path
 * tries (renderDiffTree, renderSourceTree, buildVirtualSourceTree), so grouping is this one decision taken
 * at insert time: start at the module's node and insert what is left of the path under it. The decision is
 * shared — this function is emitted into the viewer bundle beside markWhitespaceRuns — because a module
 * boundary answered differently by two trees would put the same file in two places.
 *
 * The longest root wins, so a module nested inside another takes its own files. Fewer than two modules is
 * not a division, and a module rooted at the repository itself ("") would hold every path, so neither
 * groups: that is the same rule projectHasModules() applies to the badges.
 */
export function moduleEntryFor(
  path: string,
  modules: Array<{ name: string; root: string }> | undefined,
): { name: string; root: string; rest: string } | null {
  if (!Array.isArray(modules) || modules.length < 2) return null;
  const clean = String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  let best: { name: string; root: string; rest: string } | null = null;
  for (const module of modules) {
    if (!module || !module.name) continue;
    const root = String(module.root || "")
      .replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!root || clean.indexOf(root + "/") !== 0) continue;
    if (best && root.length <= best.root.length) continue;
    best = { name: String(module.name), root, rest: clean.slice(root.length + 1) };
  }
  return best;
}
