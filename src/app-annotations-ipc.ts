import { existsSync, readFileSync, statSync } from "node:fs";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { kakapoGitDataFile } from "./git.js";

// The window state the annotations watcher needs: the BrowserWindow to push updates to, the repo root used
// to resolve this window's notes-file path, and the last-seen signature/notes so repeat polls with no change
// are near-free.
export type AnnotationsIpcState = {
  win: { isDestroyed(): boolean; webContents: WebContents };
  options: { root: string };
  annotationsSig: string;
  annotationNotes: unknown[];
};

type AnnotationsEvent = IpcMainEvent | IpcMainInvokeEvent;
type AnnotationsStateResolver = (event: AnnotationsEvent) => AnnotationsIpcState | undefined;

// Agent-written inline diff annotations — the Explain feature's whole payload (⌘7 stages the prompt; the
// agent writes note cards anchored to {path, line}, which render on the diff lines they explain).
//
// `.git/worktrees/<name>/kakapo/annotations.json` (or `.git/kakapo/annotations.json` for a non-worktree
// clone) — the same location and rationale as answersFilePath (answers-ipc.ts, issue #10): git never
// tracks its own `.git/` contents, so this never shows up in `git status`, but it still sits inside the
// worktree filesystem a cwd-sandboxed coding agent can reach — unlike a path under Electron's userData
// directory, which sits entirely outside the repo and may be unwritable from inside such a sandbox.
// Undefined outside a git repo.
export function annotationsFilePath(root: string): string | undefined {
  return kakapoGitDataFile(root, "annotations.json");
}

// mtime+size of `file`, or undefined when it can't be stat'ed. A bare stat gates the (expensive) read+parse
// below — the inverse of refreshIfChanged()'s cheap-hash-then-rebuild shape, where the read is the cheap part.
function fileSignature(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

// Parse `file` only if its signature moved off `sig`. A parse failure returns undefined WITHOUT advancing the
// caller's signature, so a half-written file (the agent is mid-save) simply retries on the next tick.
function readChangedJson(file: string | undefined, sig: string): { sig: string; value: unknown } | undefined {
  const next = fileSignature(file);
  if (!next || next === sig) return undefined;
  try {
    return { sig: next, value: JSON.parse(readFileSync(file as string, "utf8")) };
  } catch {
    return undefined;
  }
}

/**
 * Explain: an external AI agent writes annotations.json; kakapo polls it (see refreshAnnotationsIfChanged)
 * and pushes the parsed note list to the renderer, which anchors each note to its diff line.
 */
export function registerAnnotationsIpc(ipc: IpcMain, stateFromEvent: AnnotationsStateResolver): void {
  ipc.handle("kakapo:annotations-read", (event) => {
    const state = stateFromEvent(event);
    if (!state) return { path: "", notes: [] };
    return { path: annotationsFilePath(state.options.root) ?? "", notes: state.annotationNotes };
  });
}

// The whole note list is replaced on every write — the agent rewrites the file wholesale each round, and the
// renderer's annotation store is likewise not merged but swapped.
export function refreshAnnotationsIfChanged(state: AnnotationsIpcState): void {
  if (state.win.isDestroyed()) return;
  const changed = readChangedJson(annotationsFilePath(state.options.root), state.annotationsSig);
  if (!changed) return;
  const notes = (changed.value as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(notes)) return;
  state.annotationsSig = changed.sig;
  state.annotationNotes = notes;
  state.win.webContents.send("kakapo:annotations-update", { notes });
}
