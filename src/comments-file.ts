import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { kakapoGitDataFile } from "./git.js";

// ONE store for the whole review conversation. A reviewer's question, an agent's answer, an agent's Explain
// note and a follow-up to any of them are the same thing — a comment with an author and, optionally, a parent
// — so they live in one file as one list, instead of the three stores this replaces (comments in the app's
// settings blob, answers.json, annotations.json), each with its own shape, lifetime and sync path.
//
// JSONL, not JSON: an agent replies by APPENDING one line, which is the write it is least likely to get
// wrong (no in-place field edit inside a nested array, no chance of truncating someone else's turn), and a
// half-written trailing line costs one record instead of the whole file. It is also far cheaper to read into
// an agent's context than an indented document that repeats every key.
export type ThreadRecord = {
  id: number;
  re?: number; // the record this replies to; absent on a root comment
  by?: "me" | "agent"; // absent = the reviewer
  kind?: "q" | "c" | "note"; // absent = "q"; "note" is an agent's unprompted explanation
  path?: string;
  line?: number;
  from?: number;
  to?: number;
  side?: "old" | "new";
  anchor?: string; // the commented line's text, so the comment can follow it when the file changes
  title?: string;
  addressed?: boolean;
  text: string;
};

// `.git/worktrees/<name>/kakapo/comments.jsonl` (or `.git/kakapo/comments.jsonl` for a non-worktree clone).
// git never tracks its own `.git/` contents, so this never shows up in `git status`, but it still sits inside
// the worktree filesystem a cwd-sandboxed coding agent can reach — unlike a path under Electron's userData
// directory, which sits outside the repo entirely. Undefined outside a git repo (the renderer then falls
// back to its own localStorage copy, which is all a browser/static build ever had).
export function commentsFilePath(root: string): string | undefined {
  return kakapoGitDataFile(root, "comments.jsonl");
}

// The file teaches its own format, so the prompt handed to an agent only has to name the path.
const HEADER = [
  "# kakapo review thread — one JSON object per line, oldest first. Lines starting with # are ignored.",
  '# Reply to a comment:  {"id":<highest id + 1>,"re":<id you are answering>,"by":"agent","text":"markdown"}',
  '# Leave a note of your own:  {"id":<highest id + 1>,"by":"agent","kind":"note","path":"repo/relative.ts","line":42,"text":"markdown"}',
  "# APPEND only. Never rewrite, reorder or renumber the lines already here.",
];

export function readThread(file: string | undefined): ThreadRecord[] {
  if (!file || !existsSync(file)) return [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: ThreadRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      const record = JSON.parse(trimmed) as ThreadRecord;
      // A line the agent is still writing parses as garbage: drop that ONE record and keep the rest, rather
      // than throwing away a conversation because its last line arrived half-formed.
      if (record && typeof record === "object" && Number.isFinite(record.id)) records.push(record);
    } catch {
      /* skip this line */
    }
  }
  return records;
}

export function writeThread(file: string, records: ThreadRecord[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, HEADER.concat(records.map((record) => JSON.stringify(record))).join("\n") + "\n");
}

// mtime+size: a bare stat gates the read+parse, so an idle poll tick costs one syscall.
function fileSignature(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

// Legacy notes, read once: a workspace that was annotated before the stores were unified still has an
// annotations.json, and its notes are folded into the new file the first time the renderer asks for it.
function legacyNotes(root: string): Array<{ path?: string; line?: number; title?: string; text?: string }> {
  const file = kakapoGitDataFile(root, "annotations.json");
  if (!file || !existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { notes?: unknown };
    return Array.isArray(doc.notes) ? (doc.notes as Array<{ path?: string; line?: number; title?: string; text?: string }>) : [];
  } catch {
    return [];
  }
}

export type CommentsIpcState = {
  win: { isDestroyed(): boolean; webContents: WebContents };
  options: { root: string };
  commentsFile?: string;
  commentsSig?: string;
};

type CommentsEvent = IpcMainEvent | IpcMainInvokeEvent;
type CommentsStateResolver = (event: CommentsEvent) => CommentsIpcState | undefined;

export function registerCommentsIpc(ipc: IpcMain, stateFromEvent: CommentsStateResolver): void {
  ipc.handle("kakapo:comments-read", (event) => {
    const state = stateFromEvent(event);
    if (!state || !state.commentsFile) return { path: "", exists: false, records: [], legacyNotes: [] };
    const exists = existsSync(state.commentsFile);
    state.commentsSig = fileSignature(state.commentsFile);
    return {
      path: state.commentsFile,
      exists,
      records: readThread(state.commentsFile),
      legacyNotes: exists ? [] : legacyNotes(state.options.root),
    };
  });

  // The renderer owns editing and sends the whole list it knows about. Anything on disk with a HIGHER id than
  // the renderer has seen is a turn an agent appended in the meantime — keep it, or saving an unrelated
  // comment would silently swallow the answer that arrived a moment earlier.
  ipc.handle("kakapo:comments-write", (event, payload: { records?: ThreadRecord[]; knownMaxId?: number }) => {
    const state = stateFromEvent(event);
    if (!state || !state.commentsFile || !Array.isArray(payload?.records)) return { ok: false };
    const knownMaxId = Number(payload.knownMaxId) || 0;
    const arrived = readThread(state.commentsFile).filter((record) => record.id > knownMaxId);
    writeThread(state.commentsFile, payload.records.concat(arrived));
    state.commentsSig = fileSignature(state.commentsFile); // our own write must not come back as a change
    return { ok: true, path: state.commentsFile, arrived };
  });
}

// Polled on an independent timer by app-main.ts (not gated by --watch): an agent writes into this file
// whether or not the diff itself is being watched. The whole list is pushed — it is small, and a full swap
// cannot drift the way a delta can.
export function syncCommentsFile(state: CommentsIpcState): void {
  if (!state.commentsFile || state.win.isDestroyed()) return;
  const sig = fileSignature(state.commentsFile);
  if (!sig || sig === state.commentsSig) return;
  state.commentsSig = sig;
  state.win.webContents.send("kakapo:comments-update", { records: readThread(state.commentsFile) });
}
