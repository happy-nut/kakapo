import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { executable } from "./util.js";
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
  masks?: string[];
  extensions?: string[];
  excludeCommentsAndTests?: boolean;
  matchCase?: boolean;
  wholeWords?: boolean;
  regex?: boolean;
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

export function normalizeProjectSearchMasks(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .map((value) => {
      const negated = value.startsWith("!");
      const body = negated ? value.slice(1).trim() : value;
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

function maskMatchesName(mask: string, name: string): boolean {
  let m = 0;
  let n = 0;
  let star = -1;
  let afterStar = 0;
  while (n < name.length) {
    const ch = m < mask.length ? mask[m] : "";
    if (ch === "*") {
      m += 1;
      star = m;
      afterStar = n;
    } else if (ch && (ch === "?" || ch === name[n])) {
      m += 1;
      n += 1;
    } else if (star >= 0) {
      m = star;
      afterStar += 1;
      n = afterStar;
    } else {
      return false;
    }
  }
  while (mask[m] === "*") m += 1;
  return m === mask.length;
}

export function projectSearchMaskAllows(path: string, masks: string[]): boolean {
  if (!masks.length) return true;
  const name = path.replace(/\\/g, "/").toLowerCase().split("/").pop() || "";
  const include = masks.filter((mask) => !mask.startsWith("!"));
  const exclude = masks.filter((mask) => mask.startsWith("!")).map((mask) => mask.slice(1));
  if (exclude.some((mask) => maskMatchesName(mask, name))) return false;
  return !include.length || include.some((mask) => maskMatchesName(mask, name));
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
    const args = ["--json", "--no-config", normalizedOptions.matchCase ? "--case-sensitive" : "--smart-case"];
    if (!normalizedOptions.regex) args.push("--fixed-strings");
    if (normalizedOptions.wholeWords) args.push("--word-regexp");
    for (const mask of masks) args.push("--glob", mask);
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
