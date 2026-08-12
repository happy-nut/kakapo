import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

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

export function stripDiffPath(value: string): string {
  if (value === "/dev/null") {
    return value;
  }
  return value.replace(/^[ab]\//, "");
}

export function languageForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".sass")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".xml") || lower.endsWith(".svg")) return "markup";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java") || lower.endsWith(".kt") || lower.endsWith(".kts")) return "java";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".http") || lower.endsWith(".rest")) return "http";
  return "text";
}

export function isLikelyBinary(path: string): boolean {
  // Read only the first 8KB — a NUL byte in the head is our binary heuristic. The previous version read
  // the WHOLE file just to slice 8KB off it, which on a large repo means re-reading every tracked file
  // in full on each build (a major chunk of the per-second watch cost).
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, 8000, 0);
    return buf.subarray(0, n).includes(0);
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

export function readStdin(): string {
  if (process.stdin.isTTY) {
    return "";
  }
  return readFileSync(0, "utf8");
}

export function summarizeForState(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  return lines.map((line) => `- ${line.replace(/^-+\s*/, "")}`).join("\n");
}

export function codeBlock(content: string): string {
  return ["```", content, "```"].join("\n");
}

export function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

export function sanitizeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
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

export function listRecentFiles(dir: string, limit: number): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);
}
// The integrated terminal spawns the user's shell inheriting the environment kakapo was launched with.
// When started through npm (`npm run dev`, or a global install run via an npm
// shim), npm injects npm_config_* / npm_lifecycle_* / npm_package_* vars into our process. Inheriting
// them into the pty leaks our run's npm config into the user's shell and, with nvm, triggers:
//   "nvm is not compatible with the npm_config_prefix environment variable …"
// Strip every npm_*-injected var (npm_config_prefix is the one nvm rejects) and drop undefined holes,
// so the shell starts clean. Returns a fresh object; the input is not mutated.
//
// Same class of leak: if kakapo itself was launched from inside a Claude Code session (`npm run dev` from
// its bash tool, `kakapo` from an agent shell), our env carries CLAUDE_CODE_CHILD_SESSION=1 — the marker
// Claude Code sets on children so a nested run doesn't double-write transcripts. Inherited into the pty it
// makes `claude` there disable transcript saving ("Transcript saving is off — inherited
// CLAUDE_CODE_CHILD_SESSION marker"), so the session never shows up in --resume. Drop it: a shell the user
// typed into is a top-level session, not our child.
export function sanitizeTerminalEnv(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const out: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("npm_")) continue;
    if (key === "CLAUDE_CODE_CHILD_SESSION") continue;
    out[key] = value;
  }
  return out;
}

// GUI launches (Finder double-click, Spotlight, the `mo` relauncher) often start with no LANG/LC_* at
// all, so the pty's shell — and tools it runs, notably git's `less` pager — fall back to the C locale and
// render UTF-8 text (e.g. Korean commit messages) as escaped bytes like "<EA><B5><AD>". Force a UTF-8
// codeset unless the inherited locale already is one. Mutates and returns the given object.
export function ensureUtf8Locale(env: { [key: string]: string }): { [key: string]: string } {
  const isUtf8 = (value?: string): boolean => !!value && /utf-?8/i.test(value);
  // LC_ALL overrides LANG and every LC_* category; a non-UTF-8 LC_ALL (e.g. "C") would defeat the LANG we
  // set below, so drop it and let LANG win.
  if (env.LC_ALL && !isUtf8(env.LC_ALL)) delete env.LC_ALL;
  if (isUtf8(env.LC_ALL) || isUtf8(env.LC_CTYPE) || isUtf8(env.LANG)) return env;
  // Same reasoning for a stray non-UTF-8 LC_CTYPE — it overrides LANG for character handling.
  if (env.LC_CTYPE && !isUtf8(env.LC_CTYPE)) delete env.LC_CTYPE;
  // Preserve the user's region when LANG names a real locale (ko_KR -> ko_KR.UTF-8); otherwise (C/POSIX/
  // empty) fall back to en_US.UTF-8, which always exists on macOS.
  const base = env.LANG && /^[A-Za-z]{2}_[A-Za-z]{2}/.test(env.LANG) ? env.LANG.split(".")[0] : "en_US";
  env.LANG = base + ".UTF-8";
  return env;
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
}

// --- Persistent terminals ----------------------------------------------------------------------------
// A pty lives in our main process, so quitting kakapo closes its master and SIGHUPs whatever ran inside —
// an agent session (claude/codex) dies with the app. Running the shell inside a tmux session moves the
// process under tmux's own server, which outlives us; a relaunched pane re-attaches to the live session
// instead of starting over. Every pane gets one whenever tmux is installed: a workspace's terminals belong
// to the workspace, and only deleting the workspace ends them.

// tmux treats "." and ":" in a target name as window/pane separators, and a bare workspace path would also
// leak into `tmux ls`. Key sessions by a short digest of the root so two workspaces never collide.
export function tmuxSessionPrefix(root: string): string {
  return `kakapo-${createHash("sha1").update(root).digest("hex").slice(0, 8)}-`;
}

export function tmuxSessionName(root: string, ordinal: number): string {
  return `${tmuxSessionPrefix(root)}${ordinal}`;
}

// Every live session belonging to `root`, picked out of `tmux list-sessions` output. Deleting a workspace
// has to end sessions this app run never attached to — panes are not restored on launch, so the in-memory
// pty -> session map only ever knows about the panes reopened by hand since the last start. Matching on the
// workspace's own prefix is what makes the cleanup complete instead of "whatever we happen to remember".
export function tmuxSessionsForRoot(root: string, listOutput: string): string[] {
  const prefix = tmuxSessionPrefix(root);
  return listOutput.split("\n").map((line) => line.trim()).filter((name) => name.startsWith(prefix));
}

// Ordinals are per-workspace and reused lowest-first: after a restart the first pane you open takes ordinal
// 1 again and therefore re-attaches to the session the previous pane 1 left running. Panes are not restored
// automatically — reopening one is what reconnects it.
// ponytail: no pane-layout restore; add one (list live sessions on window load) if reconnecting by hand chafes.
export function nextTerminalOrdinal(used: Iterable<number>): number {
  const taken = new Set(used);
  let ordinal = 1;
  while (taken.has(ordinal)) ordinal += 1;
  return ordinal;
}

// Args for "attach to this workspace's session N, creating it if it doesn't exist yet".
//   -A          attach when the session already exists instead of failing
//   -c          the session's working directory; without it a session created on an already-running tmux
//               server inherits THAT server's cwd, not this workspace's root
//   -e          per-session env; a session attached to a pre-existing server would otherwise see the env of
//               whichever kakapo window happened to start the server first
//   set …       status bar off (the pane should look like a plain shell) and truecolor passed through, so
//               Claude Code's coral logo keeps its exact hue instead of degrading to 256-color
export function tmuxSpawnArgs(session: string, cwd: string, env: { [key: string]: string } = {}): string[] {
  const args = ["new-session", "-A", "-s", session, "-c", cwd];
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  return args.concat([
    ";", "set", "-g", "status", "off",
    ";", "set", "-g", "default-terminal", "tmux-256color",
    ";", "set", "-ga", "terminal-overrides", ",*256col*:Tc",
  ]);
}

// Closing a pane on purpose (⌘W) ends the session with it, and one tmux command takes down everything
// running inside — the pane's processes get the SIGHUP a closed terminal always sends. Best-effort: a
// session that is already gone is not an error worth surfacing, and pane teardown must not wait on it.
export function endTmuxSession(tmux: string, session: string): void {
  try { spawnSync(tmux, ["kill-session", "-t", session], { timeout: 3000 }); } catch { /* already gone */ }
}

type Killable = { kill: (signal?: string) => void };

/**
 * Kill-and-wait bookkeeping for ptys, because quitting used to crash the app.
 *
 * node-pty reaps a pty on a native thread and delivers the exit back through N-API. If that delivery lands
 * after Electron has started tearing the Node environment down (node::FreeEnvironment -> uv_run), the N-API
 * call fails and the addon escalates the failure into a C++ throw with no JS frame to catch it: SIGABRT, i.e.
 * macOS's "Kakapo quit unexpectedly" dialog on an ordinary Cmd+Q. Killing a pty as the window tears down puts
 * the app squarely in that race. So every kill is registered here, and quit waits for the exits to be
 * delivered while the environment is still alive.
 */
export function createPtyReaper(): {
  kill: (pty: Killable) => void;
  settle: (pty: Killable) => void;
  drain: (timeoutMs?: number, pollMs?: number) => Promise<boolean>;
} {
  const pending = new Set<Killable>();
  return {
    kill(pty) {
      pending.add(pty);
      try { pty.kill(); } catch { pending.delete(pty); /* already exited — nothing will be delivered */ }
    },
    // Called from the pty's own exit handler: the native delivery has happened, this one can't bite anymore.
    settle(pty) { pending.delete(pty); },
    // ponytail: a shell that ignores SIGHUP past the timeout still races teardown. Escalate to SIGKILL here
    // if that ever shows up in a crash report — the cap only exists so quit can't hang on a wedged pty.
    drain(timeoutMs = 1500, pollMs = 20) {
      return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const tick = (): void => {
          if (!pending.size) { resolve(true); return; }
          if (Date.now() >= deadline) { pending.clear(); resolve(false); return; }
          setTimeout(tick, pollMs);
        };
        tick();
      });
    },
  };
}
