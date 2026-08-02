// Local usage snapshot for the shell's bottom status bar. Reads on-disk agent logs only — no network, no API
// keys — so it shows whatever the CLIs already recorded locally:
//   • Claude: today's token total, summed from ~/.claude/projects/**/*.jsonl (message.usage per turn). Claude's
//     server rate-limit % is NOT persisted locally, so we report the token magnitude (ccusage-style) instead.
//   • Codex:  the freshest rate-limit snapshot (primary/secondary used_percent + reset time) that the Codex CLI
//     wrote into its session logs (event_msg → payload.rate_limits), which mirrors what its TUI shows.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexLimit { usedPercent: number; windowMinutes: number; resetsAt: number; }
export interface UsageStats {
  claude?: { tokensToday: number; messagesToday: number };
  codex?: { primary: CodexLimit; secondary?: CodexLimit; planType?: string; capturedAt: number };
  updatedAt: number;
}

const HOME = homedir();

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

// Best-effort local usage snapshot; each side is independent so one missing CLI never breaks the other.
export function collectUsageStats(): UsageStats {
  const now = Date.now();
  const sod = new Date(now);
  sod.setHours(0, 0, 0, 0);
  const startOfDay = sod.getTime();
  let claude: UsageStats["claude"];
  let codex: UsageStats["codex"];
  try { claude = claudeUsage(startOfDay); } catch { /* best-effort */ }
  try { codex = codexUsage(); } catch { /* best-effort */ }
  return { claude, codex, updatedAt: now };
}
