// One memo per terminal session — the caption a reviewer leaves on a pane so that coming back hours later
// (tmux keeps the session alive across app restarts) answers "what was this terminal doing" from the pane
// head itself. Keyed by the tmux session name (kakapo-<ws>-<n>), which is the one identity a pane keeps
// across restarts; stored beside the app's other data, never in the repository.
//
// The whole store is one small JSON object in one file. It is read fresh on every access: memos are written
// a few times an hour at most, and two windows sharing the file through the filesystem beats a cache one of
// them forgot to invalidate.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readTerminalMemos(file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const memos: Record<string, string> = {};
    for (const [key, text] of Object.entries(parsed)) if (typeof text === "string" && text) memos[key] = text;
    return memos;
  } catch {
    return {}; // no file yet, or an unreadable one — either way there are no memos to show
  }
}

// An empty text is a deletion: the ghost placeholder is the empty state, so nothing is stored for it.
export function writeTerminalMemo(file: string, key: string, text: string): void {
  if (!key) return;
  const memos = readTerminalMemos(file);
  const trimmed = text.trim();
  if (trimmed) memos[key] = trimmed.slice(0, 500);
  else delete memos[key];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(memos));
}

// A session that ended took its meaning with it — called with the sessions the terminal reaper just killed
// (and with a ⌘W-closed pane's session), so the file only ever describes sessions that exist.
export function sweepTerminalMemos(file: string, endedSessions: Iterable<string>): void {
  const memos = readTerminalMemos(file);
  let dirty = false;
  for (const key of endedSessions) if (key in memos) { delete memos[key]; dirty = true; }
  if (dirty) writeFileSync(file, JSON.stringify(memos));
}
