import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { kakapoGitDataFile, kakapoSharedDataFile } from "./git.js";

export type ThreadRecord = {
  id: number;
  re?: number;
  by?: "me" | "agent";
  kind?: "q" | "c" | "note";
  path?: string;
  line?: number;
  from?: number;
  to?: number;
  side?: "old" | "new";
  anchor?: string;
  title?: string;
  role?: "key" | "problem" | "fix";
  view?: "diff" | "source";
  group?: number;
  addressed?: boolean;
  text: string;
};

export function commentsFilePath(root: string): string | undefined {
  return kakapoGitDataFile(root, "comments.jsonl");
}

export function knowledgeFilePath(root: string): string | undefined {
  return kakapoSharedDataFile(root, "knowledge.jsonl");
}

function notesForWorkspace(records: ThreadRecord[], root: string): ThreadRecord[] {
  return records.filter((record) => {
    if (!record.path) return true;
    return existsSync(join(root, record.path));
  });
}

export function isKnowledge(record: ThreadRecord): boolean {
  return record.by === "agent" && record.kind === "note" && record.re == null;
}

function headerFor(nextId: number): string[] {
  return [
    "# kakapo review thread — one JSON object per line, oldest first. Lines starting with # are ignored.",
    `# NEXT FREE ID: ${nextId}. Ids are shared with the other kakapo thread file, so use this, not the highest id below.`,
    '# Reply to a comment:  {"id":<next free id>,"re":<id you are answering>,"by":"agent","text":"markdown"}',
    '# Leave a note of your own:  {"id":<next free id>,"by":"agent","kind":"note","path":"repo/relative.ts","line":42,"text":"markdown"}',
    '# Notes are read group by group, in the order appended:  add "group":1 to each note (see the Explain prompt).',
    "# Appending more than one line? Keep counting up from the next free id.",
    "# APPEND only. Never rewrite, reorder or renumber the lines already here.",
  ];
}

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
      if (record && typeof record === "object" && Number.isFinite(record.id)) records.push(record);
    } catch {
    }
  }
  return records;
}

export function writeThread(file: string, records: ThreadRecord[], nextId?: number): void {
  const floor = records.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0) + 1;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, headerFor(Math.max(floor, Number(nextId) || 0)).concat(records.map((record) => JSON.stringify(record))).join("\n") + "\n");
}
export function nextThreadId(...records: ThreadRecord[][]): number {
  return records.reduce((max, list) => list.reduce((m, r) => Math.max(m, Number(r.id) || 0), max), 0) + 1;
}

function fileSignature(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

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
  delivered?: Set<string>;
};

export function attachThreadFiles(state: CommentsIpcState, root: string): void {
  state.commentsFile = commentsFilePath(root);
  state.knowledgeFile = knowledgeFilePath(root);
  state.commentsSig = undefined;
  state.knowledgeSig = undefined;
  state.delivered = undefined;
}

function deliver(state: CommentsIpcState, records: ThreadRecord[]): ThreadRecord[] {
  const delivered = (state.delivered ??= new Set<string>());
  for (const record of records) delivered.add(JSON.stringify(record));
  return records;
}

type CommentsEvent = IpcMainEvent | IpcMainInvokeEvent;
type CommentsStateResolver = (event: CommentsEvent) => CommentsIpcState | undefined;

export function registerCommentsIpc(ipc: IpcMain, stateFromEvent: CommentsStateResolver): void {
  ipc.handle("kakapo:comments-read", (event) => {
    const state = stateFromEvent(event);
    if (!state || !state.commentsFile) return { path: "", notesPath: "", exists: false, records: [], legacyNotes: [] };
    const exists = existsSync(state.commentsFile);
    state.commentsSig = fileSignature(state.commentsFile);
    state.knowledgeSig = fileSignature(state.knowledgeFile);
    return {
      path: state.commentsFile,
      notesPath: state.knowledgeFile ?? state.commentsFile,
      exists: exists || existsSync(state.knowledgeFile ?? ""),
      conversationExists: exists,
      records: deliver(state, readThread(state.commentsFile).concat(notesForWorkspace(readThread(state.knowledgeFile), state.options.root))),
      legacyNotes: exists ? [] : legacyNotes(state.options.root),
    };
  });

  ipc.handle("kakapo:comments-write", (event, payload: { records?: ThreadRecord[] }) => {
    const state = stateFromEvent(event);
    if (!state || !state.commentsFile || !Array.isArray(payload?.records)) return { ok: false };
    const delivered = state.delivered ?? new Set<string>();
    const undelivered = (file: string | undefined): ThreadRecord[] =>
      readThread(file).filter((record) => !delivered.has(JSON.stringify(record)));
    const sentIds = new Set(payload.records.map((record) => Number(record.id)));
    const keptHere = undelivered(state.commentsFile);
    const keptShared = state.knowledgeFile ? undelivered(state.knowledgeFile) : [];
    let nextFree = [payload.records, keptHere, keptShared]
      .reduce((max, list) => list.reduce((m, r) => Math.max(m, Number(r.id) || 0), max), 0) + 1;
    const remapped = new Map<number, number>();
    const renumberCollisions = (records: ThreadRecord[]): ThreadRecord[] =>
      records.map((record) => {
        if (!sentIds.has(Number(record.id))) return record;
        const id = nextFree++;
        remapped.set(Number(record.id), id);
        return { ...record, id };
      });
    const reparent = (records: ThreadRecord[]): ThreadRecord[] =>
      records.map((record) => {
        const moved = record.re == null ? undefined : remapped.get(Number(record.re));
        return moved === undefined ? record : { ...record, re: moved };
      });
    const shared = state.knowledgeFile;
    const mine = shared ? payload.records.filter((record) => !isKnowledge(record)) : payload.records;
    const learned = shared ? payload.records.filter(isKnowledge) : [];
    let arrivedHere = renumberCollisions(keptHere);
    let arrivedShared = shared ? renumberCollisions(keptShared) : [];
    arrivedHere = reparent(arrivedHere);
    arrivedShared = reparent(arrivedShared);
    const here = mine.concat(arrivedHere);
    const there = shared ? learned.concat(arrivedShared) : [];
    const nextId = nextThreadId(here, there);
    writeThread(state.commentsFile, deliver(state, here), nextId);
    state.commentsSig = fileSignature(state.commentsFile);
    if (shared) {
      writeThread(shared, deliver(state, there), nextId);
      state.knowledgeSig = fileSignature(shared);
    }
    return {
      ok: true,
      path: state.commentsFile,
      arrived: arrivedHere.concat(notesForWorkspace(arrivedShared, state.options.root)),
    };
  });

  ipc.handle("kakapo:comments-request-write", (event, payload: { text?: string; name?: string }) => {
    const state = stateFromEvent(event);
    if (!state || !state.commentsFile || typeof payload?.text !== "string") return { ok: false };
    const wanted = typeof payload.name === "string" ? payload.name.replace(/[^a-z0-9._-]/gi, "") : "";
    const file = join(dirname(state.commentsFile), wanted && wanted.endsWith(".md") ? wanted : "request.md");
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, payload.text.endsWith("\n") ? payload.text : payload.text + "\n");
    } catch {
      return { ok: false };
    }
    return { ok: true, path: file };
  });
}

export function syncCommentsFile(state: CommentsIpcState, force = false): void {
  if (!state.commentsFile || state.win.isDestroyed()) return;
  const sig = fileSignature(state.commentsFile);
  const shared = fileSignature(state.knowledgeFile);
  if (!force && sig === state.commentsSig && shared === state.knowledgeSig) return;
  if (!sig && !shared) return;
  state.commentsSig = sig;
  state.knowledgeSig = shared;
  state.win.webContents.send("kakapo:comments-update", {
    records: deliver(state, readThread(state.commentsFile).concat(notesForWorkspace(readThread(state.knowledgeFile), state.options.root))),
  });
}
