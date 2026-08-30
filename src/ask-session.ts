// ===== The session the reviewer never sees: kakapo's own agent, one per workspace.
//
// A question left on a line used to travel the same road as a change request — merged into one hand-off
// document, staged in the terminal composer, sent by hand to the agent the reviewer is already talking to.
// Two things are wrong with that for a QUESTION. The reviewer has to stop reviewing, go to the terminal and
// send something before any answer exists; and the agent that answers is the one that WROTE the change, so
// "is this right?" gets the author defending its own work, out of a context full of the doing — abandoned
// approaches, failed edits, build logs — none of which is about the line being asked about.
//
// So kakapo keeps its own agent. Headless (`claude -p`), read-only about the code, resumed by id so a run of
// questions about one change compounds instead of starting from nothing each time. Measured on this
// repository: a fork of the reviewer's own terminal session re-reads ~320k tokens per question; this one
// settles around ~50k, and it is a second reader rather than the author.
//
// Two rules hold the design up:
//
//   1. IT MAY NOT EDIT THE CODE. A session with no window cannot ask for approval, so anything it is allowed
//      to write it writes where nobody can see it happen. It gets the repository read-only plus git's
//      read-only verbs, and write access to kakapo's own data directory and nothing else (allowedTools
//      below). Change requests still go to the visible terminal, where a human presses the key.
//   2. ONE AT A TIME PER WORKSPACE. Two `--resume` runs against the same session id append to the same
//      transcript. The queue below is the whole of that guarantee.
//
// The answer comes back as stdout and kakapo appends it to the review thread itself (app-main.ts). The agent
// is never asked to write the answer into a file in a particular shape: a file the app writes cannot be
// written wrong, and stdout is already exactly the answer.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentKind } from "./agent-resume.js";
import { kakapoGitDataFile } from "./git.js";
import { ensureUtf8Locale, resolveBin, sanitizeTerminalEnv } from "./util.js";

// An Explain run over a large diff genuinely takes minutes, and the cost of guessing low is a killed run
// that looks like a silent failure. The cost of guessing high is a stuck spinner nobody is waiting on.
const ASK_TIMEOUT_MS = 20 * 60 * 1000;
const ASK_MAX_OUTPUT = 32 * 1024 * 1024;

// The tools the hidden session gets. Not a convenience list — this IS the boundary that makes an invisible
// agent safe to run at all, so it is written out rather than inherited from whatever the CLI defaults to.
// `git diff` is here because every explanation prompt starts by reading the change under review.
//
// There is no write rule of any kind, and the way that came about is worth keeping written down. The first
// design let it append its notes to kakapo's own data directory under a path-scoped rule, which fails twice:
// the CLI rejects `Write(path)` rules outright ("only Edit(path) rules are matched by file permission
// checks"), and even a correct `Edit()` rule does not get you into `.git/` — the CLI asks for approval there
// regardless, and a headless run has nobody to ask. So the session prints its records instead and kakapo
// appends them (collectPrintedRecords, app-main.ts). That is the better shape anyway: the id space spans two
// files and an agent only ever sees one, which is the mistake the thread file's own header spends four lines
// warning about. Ours is the only counter that can be right — and "read-only" is now simply true.
// kakapo's own MCP tools are the exception to "no write rule of any kind", and they are not a hole in it.
// The server is a separate process that owns one file — the reader's vocabulary — and validates every word
// against the rules that make it worth reading (mcp-server.ts). Nothing here reaches the working tree.
//
// Without them the session cannot see the vocabulary AT ALL: the CLI's allowlist is exhaustive, so an
// unlisted MCP tool is simply absent. `kakapo_words` says "read this before explaining anything about this
// repository" — and this is the session that now does most of the explaining.
const ALLOWED_TOOLS = [
  "Read", "Grep", "Glob",
  "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(git blame:*)",
  "mcp__kakapo__kakapo_words", "mcp__kakapo__kakapo_keep_word", "mcp__kakapo__kakapo_map",
].join(",");

// Which agent answers. Not the workspace's own choice: that is recorded as a launch command for a terminal
// pane, and a pane can be closed, re-opened with something else, or never opened at all. Whatever is
// installed answers, claude first because it is the one whose `--session-id` lets US name the conversation
// and therefore resume it (see below).
export function askAgent(env: NodeJS.ProcessEnv = process.env): { kind: AgentKind; bin: string } | undefined {
  const claude = resolveBin("claude", env);
  if (claude) return { kind: "claude", bin: claude };
  const codex = resolveBin("codex", env);
  return codex ? { kind: "codex", bin: codex } : undefined;
}

// The conversation id lives beside the workspace's own thread file, inside the git dir — so it is never
// committed, it dies with the worktree it belongs to, and a second window on the same workspace resumes the
// same conversation instead of opening a rival one.
function sessionIdFile(root: string): string | undefined {
  return kakapoGitDataFile(root, "ask-session");
}
function readSessionId(root: string): string | undefined {
  const file = sessionIdFile(root);
  if (!file || !existsSync(file)) return undefined;
  try {
    const id = readFileSync(file, "utf8").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
function writeSessionId(root: string, id: string): void {
  const file = sessionIdFile(root);
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, id + "\n");
  } catch { /* the next ask starts a new session; nothing is lost but the cache */ }
}

// Deleting the workspace deletes this session too. The id FILE needs no help — it sits in the worktree's own
// git dir and `git worktree remove` takes that directory whole — but the transcript it points at is not in
// the repository at all: the CLI files sessions under `~/.claude/projects/<cwd-slug>/<id>.jsonl`, keyed by a
// working directory that is about to stop existing. Nothing ever collects those, so they pile up per deleted
// worktree for as long as the machine is used.
//
// Only ours. The visible terminal's agent files its transcripts in the same directory (same cwd), and those
// are the CLI's own history — kakapo did not create them and does not know which they are. The one session id
// we wrote down is the one session we clean up.
// Where the CLI keeps every session it has ever run, one directory per working directory. Read through
// CLAUDE_CONFIG_DIR because a reviewer who has moved their config has moved their transcripts with it — and
// because it is what lets the sweeps below be tested against a temporary directory instead of a real home.
export function claudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

export function forgetSession(root: string): void {
  queues.delete(root);
  const id = readSessionId(root);
  if (!id) return;
  const projects = claudeProjectsDir();
  let dirs: string[] = [];
  try { dirs = readdirSync(projects); } catch { return; } // no CLI history on this machine — nothing to clean
  for (const dir of dirs) {
    const file = join(projects, dir, `${id}.jsonl`);
    if (!existsSync(file)) continue;
    // A session is a transcript plus a sibling directory of its own state; both are named for the id.
    try { rmSync(file, { force: true }); rmSync(join(projects, dir, id), { recursive: true, force: true }); }
    catch { /* a leftover transcript is not worth failing a workspace deletion over */ }
    return;
  }
}

// ===== The reviewer's conversations, as files the hidden session can read. The knowledge-graph harvest
// used to require the terminal: only the agent that HELD the conversation could look back over it. But the
// conversation is on disk — both CLIs keep a full JSONL transcript of every session — so the hidden session
// can read the record instead, and the reviewer never has to lend their composer to a harvest again.
//
// Two agents, two filing systems. Claude slugs the working directory into one directory name and puts every
// session of that cwd inside; codex files rollouts by date and stamps the cwd inside each file's first line.

// Where codex keeps its rollouts. CODEX_HOME for the same reason claudeProjectsDir reads CLAUDE_CONFIG_DIR:
// a moved config moved the transcripts, and tests point it at a temporary directory.
export function codexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

// The CLI's own encoding of a cwd into a directory name: every non-alphanumeric becomes a dash.
function claudeSlug(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, "-");
}

// The newest claude session of this workspace that is NOT our own hidden one — newest because that is the
// conversation the reviewer is having now. ponytail: newest only; a second concurrent claude pane goes
// unharvested until it is the newest.
function newestClaudeTranscript(root: string): string | undefined {
  const dir = join(claudeProjectsDir(), claudeSlug(root));
  const own = readSessionId(root);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return undefined; }
  let best: { path: string; mtime: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".jsonl") || (own && name === `${own}.jsonl`)) continue;
    const path = join(dir, name);
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path;
}

// First bytes of a file without reading the rest — rollouts run to megabytes and only line one matters.
function headOf(path: string, bytes: number): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      return buffer.toString("utf8", 0, readSync(fd, buffer, 0, bytes, 0));
    } finally { closeSync(fd); }
  } catch { return ""; }
}

// The newest codex rollout whose session_meta names this workspace as its cwd. ponytail: stats every rollout
// on disk and sniffs the newest 200 — flat and dumb; walk newest day-directories first if a machine with
// years of rollouts ever makes this measurable.
function newestCodexTranscript(root: string): string | undefined {
  const files: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (depth < 3) walk(path, depth + 1);
      else if (name.endsWith(".jsonl")) {
        try { files.push({ path, mtime: statSync(path).mtimeMs }); } catch { /* raced away */ }
      }
    }
  };
  walk(codexSessionsDir(), 0);
  files.sort((a, b) => b.mtime - a.mtime);
  const stamp = `"cwd":${JSON.stringify(root)}`;
  for (const file of files.slice(0, 200)) {
    const head = headOf(file.path, 4096);
    // Our own hidden session runs `codex exec` when claude is absent, and its rollouts land here with this
    // same cwd — a harvest must not read kakapo's own errands back as the reviewer's words. The claude side
    // excludes by session id; codex gives us only the originator. ponytail: matches codex's current exec
    // originator string; if codex renames it the cost is one wasted harvest of a machine-generated session.
    if (head.includes(stamp) && !head.includes('"originator":"codex_exec"')) return file.path;
  }
  return undefined;
}

// Where the last harvest stopped, per transcript: { "<path>": <lines read> }. Beside the session id in the
// git dir, for the same reasons — never committed, dies with the worktree.
function harvestStateFile(root: string): string | undefined {
  return kakapoGitDataFile(root, "terms-harvest");
}
function readHarvested(root: string): Record<string, number> {
  const file = harvestStateFile(root);
  if (!file || !existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch { return {}; }
}

function countLines(path: string): number {
  try {
    const text = readFileSync(path, "utf8");
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  } catch { return 0; }
}

export type HarvestTranscript = { path: string; fromLine: number; lines: number };

// What the next harvest should read: each agent's current transcript, from the first line the last harvest
// did not see. `found` distinguishes "no transcript at all" (the caller falls back to the terminal) from
// "transcripts exist but hold nothing new" (there is nothing to do and nowhere useful to fall back to).
export function harvestTranscripts(root: string): { files: HarvestTranscript[]; found: boolean } {
  const done = readHarvested(root);
  const files: HarvestTranscript[] = [];
  let found = false;
  for (const path of [newestClaudeTranscript(root), newestCodexTranscript(root)]) {
    if (!path) continue;
    found = true;
    const lines = countLines(path);
    const read = Number(done[path]) || 0;
    if (read < lines) files.push({ path, fromLine: read + 1, lines });
  }
  return { files, found };
}

// After a harvest ran: the next one starts where this one stopped. The line counts were taken before the
// run, so anything said DURING it stays unread rather than skipped. Old entries are kept — a session the
// reviewer resumes later becomes the newest again, and its offset is exactly what makes that cheap.
export function markHarvested(root: string, transcripts: HarvestTranscript[]): void {
  const file = harvestStateFile(root);
  if (!file || !transcripts.length) return;
  const state = readHarvested(root);
  for (const t of transcripts) state[t.path] = t.lines;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state) + "\n");
  } catch { /* the next harvest re-reads from the old offset; words are deduped by the MCP server anyway */ }
}

function runAgent(bin: string, args: string[], root: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    // sanitizeTerminalEnv drops CLAUDE_CODE_CHILD_SESSION, and that is load-bearing here rather than
    // cosmetic: kakapo is often launched FROM an agent shell, and a child session refuses to save its
    // transcript — so every `--resume` would miss and the hidden session would never remember anything.
    const env = ensureUtf8Locale(sanitizeTerminalEnv(process.env));
    execFile(bin, args, { cwd: root, env, maxBuffer: ASK_MAX_OUTPUT, timeout: ASK_TIMEOUT_MS }, (error, stdout, stderr) => {
      const text = String(stdout ?? "").trim();
      resolve(error || !text ? { ok: false, text: String(stderr ?? "").trim() || text } : { ok: true, text });
    });
  });
}

// One in flight per workspace. A rejected link must not break the chain — the next question is unrelated to
// the one that failed — so the stored tail always swallows its own errors.
const queues = new Map<string, Promise<unknown>>();

export function ask(root: string, prompt: string, model?: string): Promise<string> {
  const tail = queues.get(root) ?? Promise.resolve();
  const next = tail.then(() => askNow(root, prompt, model), () => askNow(root, prompt, model));
  queues.set(root, next.catch(() => undefined));
  return next;
}

async function askNow(root: string, prompt: string, model?: string): Promise<string> {
  const agent = askAgent();
  if (!agent) return "";
  // Undefined means "say nothing", which is not the same as a default: the CLI then uses whatever the
  // reviewer configured for themselves, and kakapo has no opinion to impose (askModel, app-main.ts).
  const pick = model ? ["--model", model] : [];
  if (agent.kind === "codex") {
    // ponytail: `codex exec` has no caller-chosen session id, so every question here starts cold — no
    // compounding context, and no per-path write scoping either (codex owns its own sandbox flags). Parse the
    // id codex prints and move to `codex exec resume <id>` if the repeat context turns out to matter.
    const once = await runAgent(agent.bin, ["exec", ...(model ? ["-m", model] : []), prompt], root);
    return once.ok ? once.text : "";
  }
  // The prompt goes FIRST. `--allowedTools` is variadic, so a prompt after it is swallowed as one more tool
  // name and the run dies on "Input must be provided either through stdin or as a prompt argument".
  const existing = readSessionId(root);
  if (existing) {
    const resumed = await runAgent(agent.bin, ["-p", prompt, ...pick, "--resume", existing, "--allowedTools", ALLOWED_TOOLS], root);
    if (resumed.ok) return resumed.text;
    // The transcript is gone — a worktree that moved (sessions are filed by working directory), or the CLI's
    // own retention sweeping a session older than its window. Start a new one rather than reporting a failure
    // nobody can act on: what that session held is a CACHE of a conversation whose record is the thread file.
  }
  const fresh = randomUUID();
  const started = await runAgent(agent.bin, ["-p", prompt, ...pick, "--session-id", fresh, "--allowedTools", ALLOWED_TOOLS], root);
  if (!started.ok) return "";
  writeSessionId(root, fresh);
  return started.text;
}
