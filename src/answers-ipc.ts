import type { WebContents } from "electron";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { kakapoGitDataFile } from "./git.js";

// One item in the answers checklist: kakapo pre-fills everything except `answer`/`answeredAt`, which the
// agent fills in by editing the file in place. `seq` is the review comment's own id (07-comments.js), the
// only field stable across a comment's text being edited later.
export type AnswersItem = {
  seq: number;
  kind: string;
  target: string;
  prompt: string;
  answer: string | null;
  answeredAt: string | null;
  // Present only when this comment continues an existing exchange: every earlier turn, oldest first. The
  // checklist is rewritten wholesale every round, so without this an agent would read "why did you do it that
  // way?" with no record of the question it answers. A turn with a null prompt is one the agent started on its
  // own — an explain note (23-annotations.js) the reviewer replied to. Read-only context: the agent still
  // fills in `answer` for this item alone.
  thread?: { prompt: string | null; answer: string | null }[];
};

export type AnswersDoc = {
  version: number;
  reviewId: number;
  items: AnswersItem[];
};

// Narrower than app-main.ts's WinState (same pattern as TerminalIpcState in app-terminal-ipc.ts) — a real
// WinState satisfies this structurally, so app-main.ts can pass its stateFromEvent straight through.
export type AnswersIpcState = {
  win: { isDestroyed(): boolean; webContents: WebContents };
  options: { root: string };
  answersFile?: string;
  answersFileSig?: string;
  lastAnswers?: Map<number, { answer: string | null; answeredAt: string | null }>;
};

type AnswersEvent = IpcMainEvent | IpcMainInvokeEvent;
type AnswersStateResolver = (event: AnswersEvent) => AnswersIpcState | undefined;

// `.git/worktrees/<name>/kakapo/answers.json` (or `.git/kakapo/answers.json` for a non-worktree clone).
// git never tracks its own `.git/` contents, so this never shows up in `git status`, but it's still
// physically inside the worktree filesystem a cwd-sandboxed agent can reach. Undefined outside a git repo.
export function answersFilePath(root: string): string | undefined {
  return kakapoGitDataFile(root, "answers.json");
}

// Tolerant read: a missing file (nothing sent yet) and a half-written file (the agent is mid-save) both
// just skip this tick and self-heal on the next one, same idiom as refreshIfChanged in app-main.ts.
function readAnswersDoc(path: string): AnswersDoc | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && Array.isArray(parsed.items) ? (parsed as AnswersDoc) : undefined;
  } catch {
    return undefined;
  }
}

function writeAnswersDoc(path: string, doc: AnswersDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2));
}

function snapshotItems(items: AnswersItem[]): Map<number, { answer: string | null; answeredAt: string | null }> {
  return new Map(items.map((item) => [item.seq, { answer: item.answer, answeredAt: item.answeredAt }]));
}

// An answer already on disk is the agent's work, not kakapo's to throw away: carry it onto the incoming item
// with the same seq. An edited question is the exception — the text it answered is gone, so the answer goes
// with it and the item reads as pending again.
function mergeAnswers(previous: AnswersDoc | undefined, items: AnswersItem[]): AnswersItem[] {
  const bySeq = new Map((previous?.items ?? []).map((item) => [item.seq, item]));
  return items.map((item) => {
    const old = bySeq.get(item.seq);
    if (!old || old.prompt !== item.prompt || !old.answer) return item;
    return { ...item, answer: old.answer, answeredAt: old.answeredAt };
  });
}

export function registerAnswersIpc(ipc: IpcMain, stateFromEvent: AnswersStateResolver): void {
  // Called on every comment change, not only when the merged panel sends a prompt (Alt+Enter) — a follow-up
  // written after the hand-off used to live only inside the app, so an agent re-reading answers.json found the
  // round it was sent and nothing since ("no item past seq 3"), and the reply was unanswerable. The file is
  // the conversation's disk copy, so it tracks the open comments; merging keeps every answer already written.
  ipc.handle("kakapo:answers-write", (event, items: unknown): { ok: boolean; path?: string } => {
    const state = stateFromEvent(event);
    if (!state || !state.answersFile || !Array.isArray(items)) return { ok: false };
    const previous = readAnswersDoc(state.answersFile);
    const doc: AnswersDoc = {
      version: 1,
      reviewId: previous?.reviewId ?? Date.now(),
      items: mergeAnswers(previous, items as AnswersItem[]),
    };
    writeAnswersDoc(state.answersFile, doc);
    // Seed the poll cache from what was JUST written so the next tick sees "unchanged" instead of
    // re-reporting kakapo's own checklist (all answer: null) back to the renderer as if it were new.
    state.lastAnswers = snapshotItems(doc.items);
    state.answersFileSig = JSON.stringify(doc);
    return { ok: true, path: state.answersFile };
  });
}

// Polled on an independent timer by app-main.ts (not gated by --watch). Reads answers.json, and if it
// changed since the last tick, pushes only the items whose answer/answeredAt actually differ — the
// renderer matches those back to reviewComments by seq (see applyAnswersUpdate in 07-comments.js).
export async function syncAnswersFile(state: AnswersIpcState): Promise<void> {
  if (!state.answersFile || state.win.isDestroyed()) return;
  const doc = readAnswersDoc(state.answersFile);
  if (!doc) return;
  const raw = JSON.stringify(doc);
  if (raw === state.answersFileSig) return;
  state.answersFileSig = raw;
  const lastAnswers = state.lastAnswers ?? new Map<number, { answer: string | null; answeredAt: string | null }>();
  const delta = doc.items.filter((item) => {
    const prev = lastAnswers.get(item.seq);
    return !prev || prev.answer !== item.answer || prev.answeredAt !== item.answeredAt;
  });
  state.lastAnswers = snapshotItems(doc.items);
  if (delta.length && !state.win.isDestroyed()) state.win.webContents.send("kakapo:answers-update", delta);
}
