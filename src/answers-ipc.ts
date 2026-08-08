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
  // Present only on a follow-up comment: the exchange it continues, oldest first. The checklist is rewritten
  // wholesale every round, so without this an agent would read "why did you do it that way?" with no record
  // of the question it answers. Read-only context — the agent still fills in `answer` for this item alone.
  thread?: { prompt: string; answer: string | null }[];
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

export function registerAnswersIpc(ipc: IpcMain, stateFromEvent: AnswersStateResolver): void {
  // The merged panel calls this once, right when it sends a prompt to the terminal (Alt+Enter): write a
  // fresh checklist for whatever's currently open. A resend overwrites wholesale with a new reviewId —
  // each send is a new round, not a merge with whatever the agent already answered from a prior round.
  ipc.handle("kakapo:answers-write", (event, items: unknown): { ok: boolean; path?: string } => {
    const state = stateFromEvent(event);
    if (!state || !state.answersFile || !Array.isArray(items)) return { ok: false };
    const doc: AnswersDoc = { version: 1, reviewId: Date.now(), items: items as AnswersItem[] };
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
