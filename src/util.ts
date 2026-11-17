import { accessSync, closeSync, constants, openSync, readFileSync, readSync, realpathSync } from "node:fs";
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

export function isContainedRelativePath(path: string): boolean {
  const normalized = String(path || "").replace(/\\/g, "/");
  if (!normalized || isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

export function stripDiffPath(value: string): string {
  if (value === "/dev/null") {
    return value;
  }
  // `--- a/<path>` carries a TRAILING TAB whenever the path contains a space — git's column separator, which
  // it omits for a quoted path because the quotes already delimit it. Left on, the tab rode into the path and
  // out through every map keyed by one: the file rendered in the diff and then could not be opened ("file is
  // not present in the working tree"), looked up in the tree, or asked about by the language server, while
  // the `diff --git` line's correct spelling and this one made the SAME file appear twice in Quick Open.
  // Cut it before unquoting, or a quoted value no longer ends with its closing quote and comes back raw.
  // A path that genuinely ended in a tab would arrive C-quoted, so an unquoted one is always the separator.
  return unquoteGitPath(value.replace(/\t.*$/, "")).replace(/^[ab]\//, "");
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
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  // "bash", not "shell": highlight.js's `shell` grammar is Shell SESSION — a pasted transcript, where the
  // only thing it colours is the prompt in front of a command. Handed an actual script it emits no tokens
  // at all, so every .sh in a diff rendered flat. `bash` is the grammar for the file. Two siblings read
  // this name: markdownLanguage() for a fenced block's tag, and lineCommentPrefixes() for `#`.
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "bash";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".http") || lower.endsWith(".rest")) return "http";
  const extra = EXTRA_LANGUAGE_BY_EXTENSION.get(extensionOf(lower)) ?? FILENAME_LANGUAGE.get(baseNameOf(lower));
  return extra ?? "text";
}

export function extensionOf(lowerPath: string): string {
  const base = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}
function baseNameOf(lowerPath: string): string {
  return lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
}

const EXTRA_LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ["groovy", "groovy"], ["gradle", "groovy"],
  ["c", "c"], ["h", "c"],
  ["cc", "cpp"], ["cpp", "cpp"], ["cxx", "cpp"], ["hpp", "cpp"], ["hh", "cpp"], ["hxx", "cpp"],
  ["cs", "csharp"], ["swift", "swift"], ["scala", "scala"], ["sc", "scala"],
  ["dart", "dart"], ["m", "objectivec"], ["mm", "objectivec"],
  ["proto", "protobuf"], ["graphql", "graphql"], ["gql", "graphql"],
  ["fs", "fsharp"], ["fsx", "fsharp"], ["v", "verilog"], ["sv", "verilog"],
  ["pl", "perl"], ["pm", "perl"], ["r", "r"], ["jl", "julia"],
  ["ex", "elixir"], ["exs", "elixir"], ["ps1", "powershell"], ["psm1", "powershell"],
  ["mk", "makefile"], ["ini", "ini"], ["cfg", "ini"], ["conf", "ini"], ["properties", "ini"],
  ["feature", "gherkin"], ["nginx", "nginx"],
  ["lua", "lua"], ["hs", "haskell"], ["vhd", "vhdl"], ["vhdl", "vhdl"],
  ["erl", "erlang"], ["hrl", "erlang"], ["tex", "latex"], ["m4", "latex"],
  ["clj", "clojure"], ["cljs", "clojure"], ["cljc", "clojure"],
  ["ml", "ocaml"], ["mli", "ocaml"],
]);

const FILENAME_LANGUAGE = new Map<string, string>([
  ["makefile", "makefile"], ["gnumakefile", "makefile"],
  ["dockerfile", "dockerfile"], ["containerfile", "dockerfile"],
]);

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

export function isLikelyBinaryHead(head: Buffer): boolean {
  if (bomEncodingOf(head)) return false;
  return head.subarray(0, 8000).includes(0);
}

export function isLikelyBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, 8000, 0);
    return isLikelyBinaryHead(buf.subarray(0, n));
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

export function githubOwnerFromUrl(url: string): string | undefined {
  const match = url.match(/github\.com[:/]+([^/]+)\/[^/]+/i);
  return match ? match[1] : undefined;
}

export function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

export class ByteBudgetCache<V> {
  private readonly entries = new Map<string, { value: V; bytes: number }>();
  private total = 0;

  constructor(private readonly limitBytes: number, private readonly sizeOf: (value: V) => number) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
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
      if (this.total <= this.limitBytes || oldest === key) break;
      this.entries.delete(oldest);
      this.total -= held.bytes;
    }
  }

  stats(): { entries: number; bytes: number; limit: number } {
    return { entries: this.entries.size, bytes: this.total, limit: this.limitBytes };
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}

export function markWhitespaceRuns(html: string): string {
  if (!html || !/[ \t]/.test(html)) return html;
  const parts = html.split(/(<[^>]*>)/);
  const textAt: number[] = [];
  for (let i = 0; i < parts.length; i += 1) if (i % 2 === 0 && parts[i]) textAt.push(i);
  if (!textAt.length) return html;

  const kindOf = (run: string) => (run.includes("\t") ? (run.includes(" ") ? "mixed" : "tabs") : "spaces");
  const wrap = (run: string, className: string) =>
    `<span class="${className}" data-ws="${kindOf(run)}">${run}</span>`;

  const claimed = new Map<number, { lead: number; trail: number }>();
  const claimOf = (index: number) => {
    let entry = claimed.get(index);
    if (!entry) { entry = { lead: 0, trail: 0 }; claimed.set(index, entry); }
    return entry;
  };
  const free = (index: number) => parts[index].length - claimOf(index).lead - claimOf(index).trail;

  for (let n = textAt.length - 1; n >= 0; n -= 1) {
    const index = textAt[n];
    const text = parts[index];
    const run = /[ \t]*$/.exec(text)![0].length;
    claimOf(index).trail = Math.min(run, free(index));
    if (run < text.length) break;
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
