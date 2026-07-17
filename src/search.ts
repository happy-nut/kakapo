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
  extensions?: string[];
  excludeCommentsAndTests?: boolean;
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

export function normalizeProjectSearchExtensions(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  return values
    .map((value) => String(value ?? "").trim().toLowerCase().replace(/^\*?\./, ""))
    .filter((value) => {
      if (!value || !/^[a-z0-9][a-z0-9._+-]{0,31}$/.test(value) || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, 20);
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
  const extensions = normalizeProjectSearchExtensions(options.extensions);
  const path = match.path.toLowerCase();
  if (extensions.length && !extensions.some((extension) => path.endsWith(`.${extension}`))) return false;
  if (!options.excludeCommentsAndTests) return true;
  return !isTestPath(match.path) && !isLikelyCommentMatch(match);
}

export function searchProject(root: string, query: string, limit = 500, options: ProjectSearchOptions = {}): Promise<ProjectSearchResult> {
  const needle = String(query ?? "").slice(0, 500);
  const maxResults = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const extensions = normalizeProjectSearchExtensions(options.extensions);
  const normalizedOptions: ProjectSearchOptions = {
    extensions,
    excludeCommentsAndTests: options.excludeCommentsAndTests === true,
  };
  if (!needle) return Promise.resolve({ available: true, engine: "ripgrep", matches: [], truncated: false });

  const binary = findRipgrepBinary();
  if (!binary) {
    return Promise.resolve({ available: false, engine: "fallback", matches: [], truncated: false, error: "ripgrep is not installed" });
  }

  return new Promise((resolve) => {
    const matches: ProjectSearchMatch[] = [];
    let pending = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    const args = ["--json", "--no-config", "--smart-case", "--fixed-strings"];
    for (const extension of extensions) args.push("--glob", `*.${extension}`);
    if (normalizedOptions.excludeCommentsAndTests) {
      for (const glob of ["!**/test/**", "!**/tests/**", "!**/__tests__/**", "!**/test_*", "!**/*_test.*", "!**/*.test.*", "!**/*.spec.*"]) {
        args.push("--glob", glob);
      }
    }
    args.push("--", needle, ".");
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
