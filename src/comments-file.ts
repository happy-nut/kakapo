import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kakapoGitDataFile, kakapoSharedDataFile } from "./git.js";

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
  // The two notes that carry a change's story: where it goes wrong ("problem") and where that is beaten
  // ("fix"). Absent on everything else, which is most notes — the point of marking them is that a reviewer
  // with two minutes reads these and stops. The viewer draws them louder (agentCardHtml, 23-annotations.js).
  role?: "problem" | "fix";
  // Which part of the explanation this note belongs to. The reader walks notes group by group, and inside a
  // group in the order they were appended — that order is the argument the agent is making, and it is not the
  // order the lines happen to sit in the file. Absent on a reviewer's own comment, which keeps file order.
  group?: number;
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

// The agent's NOTES live one level up, in the git dir the repository shares with all of its worktrees. A
// workspace is created for a task and deleted when the task is done — so knowledge written beside the
// conversation died with the worktree that happened to be open when it was learned, and the next Explain
// started from nothing. What was learned about the codebase outlives any one task; the conversation about a
// particular diff does not, and stays where it was.
export function knowledgeFilePath(root: string): string | undefined {
  return kakapoSharedDataFile(root, "knowledge.jsonl");
}

// Knowledge is shared by every worktree of a repository, but a note is ANCHORED — it names a file and a line.
// A note written about a file that does not exist in this workspace has nothing to attach to here: the card
// cannot render, yet the count on the tree still counted it and F8 still walked to it, which sent the caret to
// a file it could not open and left it at the top. So a shared note arrives only where its file does.
//
// Same-file drift (the line moved, or this branch changed it) is a different problem and already has an
// answer: the record carries the text of the line it was written on, and the renderer re-finds it.
function notesForWorkspace(records: ThreadRecord[], root: string): ThreadRecord[] {
  return records.filter((record) => {
    if (!record.path) return true; // a note with no anchor belongs to the repository, not to a file
    return existsSync(join(root, record.path));
  });
}

// A record is knowledge when the agent wrote it about the code on its own — not a reply, not a question. Its
// replies stay with the conversation they belong to, so a note can be discussed in one workspace without that
// discussion following the note into every other one.
export function isKnowledge(record: ThreadRecord): boolean {
  return record.by === "agent" && record.kind === "note" && record.re == null;
}

// The file teaches its own format, so the prompt handed to an agent only has to name the path.
const HEADER = [
  "# kakapo review thread — one JSON object per line, oldest first. Lines starting with # are ignored.",
  '# Reply to a comment:  {"id":<highest id + 1>,"re":<id you are answering>,"by":"agent","text":"markdown"}',
  '# Leave a note of your own:  {"id":<highest id + 1>,"by":"agent","kind":"note","path":"repo/relative.ts","line":42,"text":"markdown"}',
  '# Notes are read group by group, in the order appended:  add "group":1 to each note (see the Explain prompt).',
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
  knowledgeFile?: string;
  knowledgeSig?: string;
};

type CommentsEvent = IpcMainEvent | IpcMainInvokeEvent;
type CommentsStateResolver = (event: CommentsEvent) => CommentsIpcState | undefined;

export function registerCommentsIpc(ipc: IpcMain, stateFromEvent: CommentsStateResolver): void {
  ipc.handle("kakapo:comments-read", (event) => {
    const state = stateFromEvent(event);
    if (!state || !state.commentsFile) return { path: "", notesPath: "", exists: false, records: [], legacyNotes: [] };
    const exists = existsSync(state.commentsFile);
    state.commentsSig = fileSignature(state.commentsFile);
    state.knowledgeSig = fileSignature(state.knowledgeFile);
    // Two files, one list. The renderer has always worked from a single thread and assigns the next id from
    // the highest it can see, so merging on read is what keeps the id space global across both of them.
    return {
      path: state.commentsFile,
      notesPath: state.knowledgeFile ?? state.commentsFile,
      exists: exists || existsSync(state.knowledgeFile ?? ""),
      records: readThread(state.commentsFile).concat(notesForWorkspace(readThread(state.knowledgeFile), state.options.root)),
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
    // Split on the way out, exactly as they were merged on the way in: what the agent learned about the code
    // goes to the shared file, the conversation stays with this workspace. Each file keeps whatever arrived in
    // it since the renderer last looked.
    // No shared file (a repo git could not resolve) means no split: everything goes where it always went,
    // rather than knowledge being filtered out of the only file there is and lost.
    const shared = state.knowledgeFile;
    const mine = shared ? payload.records.filter((record) => !isKnowledge(record)) : payload.records;
    const learned = shared ? payload.records.filter(isKnowledge) : [];
    const arrivedHere = readThread(state.commentsFile).filter((record) => record.id > knownMaxId);
    writeThread(state.commentsFile, mine.concat(arrivedHere));
    state.commentsSig = fileSignature(state.commentsFile); // our own write must not come back as a change
    let arrivedShared: ThreadRecord[] = [];
    if (shared) {
      arrivedShared = readThread(shared).filter((record) => record.id > knownMaxId);
      writeThread(shared, learned.concat(arrivedShared));
      state.knowledgeSig = fileSignature(shared);
    }
    return { ok: true, path: state.commentsFile, arrived: arrivedHere.concat(arrivedShared) };
  });

  // The hand-off document goes to disk beside the thread file, so the terminal only has to carry the line that
  // names it (sendWholeDocToTerminal, 08-dock.js). Every byte of that document was already on disk anyway —
  // pasting it back was a copy of the review, and a thread with a few turns quoted per comment made the copy
  // kilobytes long. Overwritten on every send: it is the CURRENT request, not a log.
  ipc.handle("kakapo:comments-request-write", (event, payload: { text?: string; name?: string }) => {
    const state = stateFromEvent(event);
    if (!state || !state.commentsFile || typeof payload?.text !== "string") return { ok: false };
    // A name so the two kinds of hand-off cannot overwrite each other: a review request and an Explain
    // instruction are both "the current request", but they are sent from different places and an agent may
    // still be reading one when the other is sent. Sanitised to a plain basename — this path is built from
    // renderer input, and the only thing it may choose is which of OUR files it is.
    const wanted = typeof payload.name === "string" ? payload.name.replace(/[^a-z0-9._-]/gi, "") : "";
    const file = join(dirname(state.commentsFile), wanted && wanted.endsWith(".md") ? wanted : "request.md");
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, payload.text.endsWith("\n") ? payload.text : payload.text + "\n");
    } catch {
      return { ok: false }; // the renderer pastes the document itself instead
    }
    return { ok: true, path: file };
  });
}

// Polled on an independent timer by app-main.ts (not gated by --watch): an agent writes into this file
// whether or not the diff itself is being watched. The whole list is pushed — it is small, and a full swap
// cannot drift the way a delta can.
export function syncCommentsFile(state: CommentsIpcState): void {
  if (!state.commentsFile || state.win.isDestroyed()) return;
  // Either file changing is news: an agent in ANOTHER workspace can add knowledge while this one is open, and
  // that is the whole point of the shared file — it should arrive here without a reload.
  const sig = fileSignature(state.commentsFile);
  const shared = fileSignature(state.knowledgeFile);
  if (sig === state.commentsSig && shared === state.knowledgeSig) return;
  if (!sig && !shared) return;
  state.commentsSig = sig;
  state.knowledgeSig = shared;
  state.win.webContents.send("kakapo:comments-update", {
    records: readThread(state.commentsFile).concat(notesForWorkspace(readThread(state.knowledgeFile), state.options.root)),
  });
}
