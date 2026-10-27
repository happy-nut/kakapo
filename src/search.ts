import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { rgPath as bundledRipgrepPath } from "@vscode/ripgrep";

export type ProjectSearchMatch = {
  path: string;
  line: number;
  column: number;
  endColumn: number;
  text: string;
  matchText: string;
};

export type ProjectSearchResult = {
  available: boolean;
  engine: "ripgrep" | "fallback";
  matches: ProjectSearchMatch[];
  truncated: boolean;
  error?: string;
};

export type ProjectSearchOptions = {
  /**
   * IntelliJ's file mask: comma-separated globs over the file name, `!` to exclude (`*.ts, !*.d.ts`).
   * `extensions` is the name it had when it only took `ts`; both are read so a standalone review built by
   * an older build keeps filtering.
   */
  masks?: string[];
  extensions?: string[];
  excludeCommentsAndTests?: boolean;
  /**
   * IntelliJ's three Find in Files toggles — `Cc`, `W`, `.*`. Each is one ripgrep flag, and the default
   * (all three off) is what this searcher always did: smart-case, literal, anywhere in the line.
   *
   * `regex: true` hands the query to ripgrep as a pattern. A pattern that does not compile makes ripgrep
   * exit 2 with its own message on stderr, which already becomes `error` below — the one place in this
   * file where "the search failed" and "nothing matched" were already told apart.
   */
  matchCase?: boolean;
  wholeWords?: boolean;
  regex?: boolean;
  /**
   * IntelliJ's Find in Files scope, as the directory prefixes it comes down to: "Project Production
   * Files" is the project minus its test roots, a module scope is one directory, and the renderer knows
   * which those are (it holds the project layout) so it sends them rather than a scope name.
   *
   * A NARROWING, not the whole filter. ripgrep is asked for at most `limit` matches, so a scope applied
   * only to the answer would cut the wrong 500 rows first; the renderer applies the exact rule to what
   * comes back (14-project-layout.js knows about path conventions this cannot express as a glob).
   */
  includePaths?: string[];
  excludePaths?: string[];
};

type EncodedText = { text?: string; bytes?: string } | undefined;

function decodeText(value: EncodedText): string {
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.bytes === "string") {
    try { return Buffer.from(value.bytes, "base64").toString("utf8"); } catch { return ""; }
  }
  return "";
}

function jsColumnAtUtf8Byte(text: string, byteOffset: number): number {
  const bytes = Buffer.from(text, "utf8");
  return bytes.subarray(0, Math.max(0, Math.min(byteOffset, bytes.length))).toString("utf8").length;
}

// ripgrep's --json stream emits one `match` message per matching line, with one or more byte-offset
// submatches. Convert each submatch into the occurrence-level shape the renderer consumes.
export function parseRipgrepJsonLine(line: string): ProjectSearchMatch[] {
  let event: {
    type?: string;
    data?: {
      path?: EncodedText;
      lines?: EncodedText;
      line_number?: number;
      submatches?: Array<{ match?: EncodedText; start?: number; end?: number }>;
    };
  };
  try { event = JSON.parse(line) as typeof event; } catch { return []; }
  if (event.type !== "match" || !event.data) return [];

  const rawPath = decodeText(event.data.path);
  const path = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const text = decodeText(event.data.lines).replace(/\r?\n$/, "");
  const lineNumber = Number(event.data.line_number);
  if (!path || !Number.isInteger(lineNumber) || lineNumber < 1) return [];

  return (event.data.submatches ?? []).map((submatch) => {
    const start = Number(submatch.start) || 0;
    const end = Number(submatch.end) || start;
    return {
      path,
      line: lineNumber,
      column: jsColumnAtUtf8Byte(text, start) + 1,
      endColumn: jsColumnAtUtf8Byte(text, end) + 1,
      text,
      matchText: decodeText(submatch.match),
    };
  });
}

function executable(path: string): boolean {
  try { accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
}

// The VS Code ripgrep package ships a verified, platform-specific binary with kakapo, so search never
// depends on the user's PATH. KAKAPO_RG_PATH remains an explicit development escape hatch; PATH and
// common install locations are only resilience fallbacks for a damaged/incomplete package install.
export function findRipgrepBinary(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const fileName = platform === "win32" ? "rg.exe" : "rg";
  const candidates: string[] = [];
  if (env.KAKAPO_RG_PATH) candidates.push(env.KAKAPO_RG_PATH);
  candidates.push(bundledRipgrepPath);
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push(join(dir, fileName));
  if (platform === "darwin") candidates.push("/opt/homebrew/bin/rg", "/usr/local/bin/rg");
  else if (platform !== "win32") candidates.push("/usr/bin/rg", "/usr/local/bin/rg");
  return Array.from(new Set(candidates)).find((candidate) => existsSync(candidate) && executable(candidate));
}

/**
 * IntelliJ's file mask (FindBundle's `find.popup.filemask`), as the globs it comes down to.
 *
 * It used to take bare EXTENSIONS: every entry was stripped to its last component and matched with
 * `endsWith`, so `*.ts` worked, `*Service*.java` matched nothing and `!*.min.js` was dropped on the floor
 * without a word. IntelliJ's mask is a comma-separated list of globs where a leading `!` excludes, and
 * ripgrep's own `--glob` speaks exactly that — so the mask passes through rather than being reduced.
 *
 * Kept deliberately narrow: a mask names FILES, so a `/` would be a path filter, which is what the scope
 * is for (and what includePaths/excludePaths carry). Anything with a slash, a `..`, or beyond the length
 * budget is dropped, as before.
 */
export function normalizeProjectSearchMasks(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .map((value) => {
      const negated = value.startsWith("!");
      const body = negated ? value.slice(1).trim() : value;
      // A bare extension is still a mask — `.ts`, `ts` and `*.ts` all mean the same thing to a reviewer.
      const glob = /^\.?[a-z0-9][a-z0-9._+-]*$/.test(body) && !body.includes("*")
        ? `*.${body.replace(/^\./, "")}`
        : body;
      return (negated ? "!" : "") + glob;
    })
    .filter((value) => {
      const body = value.startsWith("!") ? value.slice(1) : value;
      if (!body || body.length > 48 || body.includes("/") || body.includes("..") || seen.has(value)) return false;
      if (!/^[a-z0-9*?._+\-\[\]{},]+$/.test(body)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, 20);
}

/** One mask as a regular expression over the file's NAME. `*` and `?` only — ripgrep does the real work. */
function maskToRegExp(mask: string): RegExp {
  const pattern = mask
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${pattern}$`);
}

/**
 * Does this path pass the mask list?
 *
 * The same rule ripgrep applies, mirrored for the standalone HTML review that has no ripgrep to ask: a
 * path must match at least one including mask (or there must be none), and no excluding one.
 */
export function projectSearchMaskAllows(path: string, masks: string[]): boolean {
  if (!masks.length) return true;
  const name = path.replace(/\\/g, "/").toLowerCase().split("/").pop() || "";
  const include = masks.filter((mask) => !mask.startsWith("!"));
  const exclude = masks.filter((mask) => mask.startsWith("!")).map((mask) => mask.slice(1));
  if (exclude.some((mask) => maskToRegExp(mask).test(name))) return false;
  return !include.length || include.some((mask) => maskToRegExp(mask).test(name));
}

function isTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  const name = segments.at(-1) ?? "";
  return segments.some((segment) => segment === "test" || segment === "tests" || segment === "__tests__")
    || /(^test_.*|_test\.[^.]+$|\.(test|spec)\.[^.]+$)/.test(name);
}

function isLikelyCommentMatch(match: ProjectSearchMatch): boolean {
  const text = match.text;
  const path = match.path.toLowerCase();
  const matchIndex = Math.max(0, match.column - 1);
  const trimmed = text.trimStart();
  if (/^(\/\/|\/\*|\*|#|--|;|<!--)/.test(trimmed)) return true;
  const markers = /\.(py|pyi|rb|sh|bash|zsh|fish|ya?ml|toml|ini|conf)$/i.test(path)
    ? ["#"]
    : /\.(sql|lua)$/i.test(path) ? ["--"] : ["//", "/*"];
  return markers.some((marker) => {
    const at = text.indexOf(marker);
    return at >= 0 && at < matchIndex;
  });
}

export function projectSearchMatchAllowed(match: ProjectSearchMatch, options: ProjectSearchOptions = {}): boolean {
  const masks = normalizeProjectSearchMasks(options.masks ?? options.extensions);
  if (!projectSearchMaskAllows(match.path, masks)) return false;
  const include = normalizeSearchPaths(options.includePaths);
  const exclude = normalizeSearchPaths(options.excludePaths);
  if (include.length && !include.some((prefix) => underSearchPath(match.path, prefix))) return false;
  if (exclude.some((prefix) => underSearchPath(match.path, prefix))) return false;
  if (!options.excludeCommentsAndTests) return true;
  return !isTestPath(match.path) && !isLikelyCommentMatch(match);
}

/** Repo-relative directory prefixes, de-duplicated. Anything absolute or climbing out is dropped. */
export function normalizeSearchPaths(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const relative = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!relative || relative.split("/").includes("..") || seen.size >= 200) continue;
    seen.add(relative);
  }
  return Array.from(seen);
}

function underSearchPath(path: string, prefix: string): boolean {
  const relative = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return relative === prefix || relative.startsWith(`${prefix}/`);
}

/**
 * A directory name as a glob that means only itself.
 *
 * A repo-relative prefix is a path, not a pattern, and `app/[slug]` is a directory in every Next.js app
 * there is. Handed to ripgrep unescaped it is a character class — `--glob 'app/[slug]/**'` looks for
 * `app/s/`, `app/l/`, `app/u/`, `app/g/` and matches nothing at all, so the scope silently returned no
 * results. A one-character class is the portable way to say "this character, literally": globset's
 * backslash escape is off by default on Windows, `[[]` is not.
 */
export function searchGlobLiteral(path: string): string {
  return path.replace(/[*?[\]{}]/g, (character) => `[${character}]`);
}

export function searchProject(root: string, query: string, limit = 500, options: ProjectSearchOptions = {}): Promise<ProjectSearchResult> {
  const needle = String(query ?? "").slice(0, 500);
  const maxResults = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const masks = normalizeProjectSearchMasks(options.masks ?? options.extensions);
  const normalizedOptions: ProjectSearchOptions = {
    masks,
    excludeCommentsAndTests: options.excludeCommentsAndTests === true,
    matchCase: options.matchCase === true,
    wholeWords: options.wholeWords === true,
    regex: options.regex === true,
    includePaths: normalizeSearchPaths(options.includePaths),
    excludePaths: normalizeSearchPaths(options.excludePaths),
  };
  if (!needle) return Promise.resolve({ available: true, engine: "ripgrep", matches: [], truncated: false });

  const binary = findRipgrepBinary();
  if (!binary) {
    return Promise.resolve({ available: false, engine: "fallback", matches: [], truncated: false, error: "ripgrep is not installed" });
  }

  // The scope's directories, as the places ripgrep is pointed AT rather than as more globs.
  //
  // ripgrep's positive globs are an OR: `--glob '*.ts' --glob 'sub/**'` returns every .ts anywhere AND
  // every file under sub/, so a scope used to switch the file-type filter off. A directory is not a
  // filter on the walk, it is where the walk starts, and starting it in the scope's directories ANDs
  // with `--glob '*.ts'` the way the two controls read on screen.
  //
  // Dropped if it is not there: ripgrep exits 2 on a path that does not exist, and this searcher reads a
  // non-zero exit as "the search failed". A scope whose every directory has gone (a module deleted since
  // the layout was read) searches nothing rather than quietly searching the whole repository.
  // `./dir` rather than `dir` only because `.` is what the one argument used to be — ripgrep echoes the
  // argument it was given into every match path, and parseRipgrepJsonLine strips a leading `./` from all
  // of them, so what the rest of the app sees is the same repo-relative path either way.
  const wanted = normalizedOptions.includePaths ?? [];
  const searchRoots = wanted.filter((prefix) => existsSync(join(root, prefix))).map((prefix) => `./${prefix}`);
  if (wanted.length && !searchRoots.length) {
    return Promise.resolve({ available: true, engine: "ripgrep", matches: [], truncated: false });
  }

  return new Promise((resolve) => {
    const matches: ProjectSearchMatch[] = [];
    let pending = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    // --smart-case is the default this app has always had: a lower-case query ignores case, a query with
    // a capital in it does not. `Cc` replaces the guess with the answer.
    const args = ["--json", "--no-config", normalizedOptions.matchCase ? "--case-sensitive" : "--smart-case"];
    if (!normalizedOptions.regex) args.push("--fixed-strings");
    if (normalizedOptions.wholeWords) args.push("--word-regexp");
    // ripgrep reads `!glob` as an exclusion itself, which is the same spelling IntelliJ's mask uses.
    for (const mask of masks) args.push("--glob", mask);
    // An exclusion has to stay a glob — there is no "search everywhere but here" path argument — so the
    // directory name is escaped into one that means only itself.
    for (const prefix of normalizedOptions.excludePaths ?? []) args.push("--glob", `!${searchGlobLiteral(prefix)}/**`);
    if (normalizedOptions.excludeCommentsAndTests) {
      for (const glob of ["!**/test/**", "!**/tests/**", "!**/__tests__/**", "!**/test_*", "!**/*_test.*", "!**/*.test.*", "!**/*.spec.*"]) {
        args.push("--glob", glob);
      }
    }
    args.push("--", needle, ...(searchRoots.length ? searchRoots : ["."]));
    const child = spawn(binary, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (result: ProjectSearchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const consume = (line: string) => {
      if (!line || truncated) return;
      for (const match of parseRipgrepJsonLine(line)) {
        if (!projectSearchMatchAllowed(match, normalizedOptions)) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          child.kill();
          break;
        }
        matches.push(match);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.once("error", (error) => {
      finish({ available: false, engine: "fallback", matches: [], truncated: false, error: error.message });
    });
    child.once("close", (code) => {
      if (pending && !truncated) consume(pending);
      // ripgrep exits 1 when there are no matches. A process we deliberately killed after reaching the
      // result cap is also successful from the searcher's point of view.
      if (truncated || code === 0 || code === 1) {
        finish({ available: true, engine: "ripgrep", matches, truncated });
      } else {
        finish({ available: false, engine: "fallback", matches: [], truncated: false, error: stderr.trim() || `ripgrep exited ${code}` });
      }
    });
  });
}
