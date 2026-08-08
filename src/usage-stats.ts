// Local usage snapshot for the shell's bottom status bar. Reads on-disk agent logs only — no network, no API
// keys — so it shows whatever the CLIs already recorded locally:
//   • Claude: today's token total, summed from ~/.claude/projects/**/*.jsonl (message.usage per turn). Claude's
//     server rate-limit % is NOT persisted locally, so we report the token magnitude (ccusage-style) instead.
//   • Codex:  the freshest rate-limit snapshot (primary/secondary used_percent + reset time) that the Codex CLI
//     wrote into its session logs (event_msg → payload.rate_limits), which mirrors what its TUI shows.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexLimit { usedPercent: number; windowMinutes: number; resetsAt: number; }
// `label` is the model a scoped weekly cap applies to ("Fable"); empty for the plain session/weekly windows,
// which the viewer names in the user's language from `kind`.
export interface ClaudeLimit { kind: "session" | "weekly"; label: string; usedPercent: number; resetsAt: number; }
export interface UsageStats {
  claude?: { tokensToday: number; messagesToday: number; limits?: ClaudeLimit[]; quotaAt?: number };
  codex?: { primary: CodexLimit; secondary?: CodexLimit; planType?: string; capturedAt: number };
  updatedAt: number;
}

const HOME = homedir();

// Claude's real rate-limit % isn't written to any local log (only token counts are), so — with the user's
// consent — read it from the same OAuth-authenticated endpoint the `claude` CLI's /usage uses, reusing the
// access token Claude Code already stores. The token is re-read from disk each call so we pick up Claude Code's
// refreshes.
//
// The endpoint rate-limits, and every window polls once a minute: with the old 15s cache that was a request per
// window per minute, and one 429 dropped the whole widget back to a raw token count. So cache for the length of
// the poll, back off instead of retrying every minute, and once a % has been read, keep showing it — a stale
// percentage is still the answer to "how much is left", and the widget carries its age so it can say how old.
const QUOTA_TTL_MS = 60_000;
const QUOTA_BACKOFF_MS = 5 * 60_000;
export interface QuotaCache { at: number; value: ClaudeLimit[] }
let claudeQuotaCache: QuotaCache | undefined;
let claudeQuotaRetryAt = 0;

// A failed refresh keeps the previous snapshot — never downgrades a live % back to a raw token count.
export function nextQuotaCache(now: number, prev: QuotaCache | undefined, fresh: ClaudeLimit[] | undefined): QuotaCache | undefined {
  return fresh ? { at: now, value: fresh } : prev;
}

// On macOS Claude Code keeps its OAuth token in the login Keychain and refreshes it there; the
// ~/.claude/.credentials.json copy is only written on other platforms and goes stale (an expired token there is
// why the % silently fell back to a raw token count). Keychain first, file as the cross-platform fallback.
type ClaudeOauth = { accessToken?: string; expiresAt?: number };
function claudeOauth(): ClaudeOauth | undefined {
  const parse = (raw: string): ClaudeOauth | undefined => (JSON.parse(raw) as { claudeAiOauth?: ClaudeOauth }).claudeAiOauth;
  if (process.platform === "darwin") {
    try {
      return parse(execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 3000 }));
    } catch { /* not in the Keychain (or access denied) — try the file */ }
  }
  const credPath = join(HOME, ".claude", ".credentials.json");
  try { return existsSync(credPath) ? parse(readFileSync(credPath, "utf8")) : undefined; } catch { return undefined; }
}

// The /usage payload lists EVERY limit that can actually block you under `limits` — the 5h session, the weekly
// all-models cap, and per-model weekly caps (e.g. Fable) that bite long before either. Reading only five_hour,
// as this did, reported "90% left" while the binding Fable window sat at 86% used. Worst-first, so the caller
// can take [0] as the one that decides when work stops. `limits` is newer than five_hour/seven_day, so those
// stay as the fallback for an older endpoint.
export function claudeLimits(body: ClaudeUsageBody): ClaudeLimit[] {
  const ms = (s?: string | null): number => (s ? Date.parse(s) || 0 : 0);
  const out: ClaudeLimit[] = [];
  for (const l of body.limits || []) {
    if (typeof l?.percent !== "number") continue;
    out.push({ kind: l.kind === "session" ? "session" : "weekly", label: l.scope?.model?.display_name || "", usedPercent: l.percent, resetsAt: ms(l.resets_at) });
  }
  if (!out.length) {
    for (const [kind, w] of [["session", body.five_hour], ["weekly", body.seven_day]] as const) {
      if (w && typeof w.utilization === "number") out.push({ kind, label: "", usedPercent: w.utilization, resetsAt: ms(w.resets_at) });
    }
  }
  return out.sort((a, b) => b.usedPercent - a.usedPercent);
}

interface ClaudeUsageBody {
  limits?: ({ kind?: string; percent?: number; resets_at?: string | null; scope?: { model?: { display_name?: string } } | null } | null)[];
  five_hour?: { utilization?: number; resets_at?: string } | null;
  seven_day?: { utilization?: number; resets_at?: string } | null;
}

async function fetchClaudeQuota(): Promise<ClaudeLimit[] | undefined> {
  try {
    const oauth = claudeOauth();
    const token = oauth?.accessToken;
    if (!token) return undefined;
    if (typeof oauth?.expiresAt === "number" && Date.now() > oauth.expiresAt) return undefined; // stale; refreshed on next CLI use
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json", "user-agent": "kakapo (usage bar)" },
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) return undefined;
    const limits = claudeLimits(await res.json() as ClaudeUsageBody);
    return limits.length ? limits : undefined;
  } catch { return undefined; }
}

// Collect *.jsonl files under dir (recursively, bounded depth), newest-mtime first, capped.
function recentJsonl(dir: string, cap: number): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  const walk = (d: string, depth: number): void => {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      const p = join(d, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 6) walk(p, depth + 1); }
      else if (name.endsWith(".jsonl")) out.push({ path: p, mtime: st.mtimeMs });
    }
  };
  walk(dir, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, cap);
}

// Claude: sum every turn's token usage recorded since local midnight.
function claudeUsage(startOfDay: number): UsageStats["claude"] | undefined {
  const root = join(HOME, ".claude", "projects");
  if (!existsSync(root)) return undefined;
  // Only files touched since midnight can hold today's entries — skip the rest without reading them.
  const files = recentJsonl(root, 300).filter((f) => f.mtime >= startOfDay);
  let tokens = 0, messages = 0;
  for (const f of files) {
    let text: string;
    try { text = readFileSync(f.path, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      let o: { timestamp?: string; message?: { usage?: Record<string, number> }; usage?: Record<string, number> };
      try { o = JSON.parse(line); } catch { continue; }
      const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      if (!(ts >= startOfDay)) continue;
      const u = o.message?.usage || o.usage;
      if (!u) continue;
      tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      messages += 1;
    }
  }
  return messages ? { tokensToday: tokens, messagesToday: messages } : undefined;
}

// Codex: the most recent rate-limit snapshot across recent session logs (active + archived).
function codexUsage(): UsageStats["codex"] | undefined {
  const files: { path: string; mtime: number }[] = [];
  for (const d of [join(HOME, ".codex", "sessions"), join(HOME, ".codex", "archived_sessions")]) {
    if (existsSync(d)) files.push(...recentJsonl(d, 12));
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let best: UsageStats["codex"] | undefined;
  for (const f of files.slice(0, 12)) {
    let text: string;
    try { text = readFileSync(f.path, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || line.indexOf('"rate_limits"') === -1) continue;
      let o: { timestamp?: string; payload?: { rate_limits?: { primary?: Record<string, number>; secondary?: Record<string, number>; plan_type?: string } } };
      try { o = JSON.parse(line); } catch { continue; }
      const rl = o.payload?.rate_limits;
      const prim = rl?.primary;
      if (!prim || typeof prim.used_percent !== "number") continue;
      const capturedAt = o.timestamp ? Date.parse(o.timestamp) || 0 : 0;
      const snap: UsageStats["codex"] = {
        primary: { usedPercent: prim.used_percent, windowMinutes: prim.window_minutes || 0, resetsAt: (prim.resets_at || 0) * 1000 },
        planType: rl?.plan_type || undefined,
        capturedAt,
      };
      const sec = rl?.secondary;
      if (sec && typeof sec.used_percent === "number") {
        snap.secondary = { usedPercent: sec.used_percent, windowMinutes: sec.window_minutes || 0, resetsAt: (sec.resets_at || 0) * 1000 };
      }
      if (!best || capturedAt > best.capturedAt) best = snap;
      break; // this file's last rate_limits line is its freshest
    }
  }
  return best;
}

// Best-effort usage snapshot; each side is independent so one missing source never breaks the other. Async
// because Claude's rate-limit % comes from an authenticated API call (token counts + Codex stay local + sync).
export async function collectUsageStats(): Promise<UsageStats> {
  const now = Date.now();
  const sod = new Date(now);
  sod.setHours(0, 0, 0, 0);
  const startOfDay = sod.getTime();
  let claude: UsageStats["claude"];
  let codex: UsageStats["codex"];
  try { claude = claudeUsage(startOfDay); } catch { /* best-effort */ }
  try { codex = codexUsage(); } catch { /* best-effort */ }
  // Claude quota %: one API call per poll interval at most, shared by every window.
  const due = (!claudeQuotaCache || now - claudeQuotaCache.at >= QUOTA_TTL_MS) && now >= claudeQuotaRetryAt;
  const fresh = due ? await fetchClaudeQuota() : undefined;
  if (due && !fresh) claudeQuotaRetryAt = now + QUOTA_BACKOFF_MS;
  claudeQuotaCache = nextQuotaCache(now, claudeQuotaCache, fresh);
  if (claudeQuotaCache) claude = { tokensToday: 0, messagesToday: 0, ...(claude || {}), limits: claudeQuotaCache.value, quotaAt: claudeQuotaCache.at };
  return { claude, codex, updatedAt: now };
}
