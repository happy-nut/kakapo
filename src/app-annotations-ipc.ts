import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

  // Dismissing a note has to reach the FILE, not just the renderer's copy: the list is re-read from
  // annotations.json on every poll tick, so a delete that lived only in memory would reappear a second
  // later. Rewriting the file is also what makes it stick across a restart — the same durability a deleted
  // comment has. A later Explain run rewrites the file wholesale and may bring the note back, which is the
  // honest behaviour: you asked for a fresh set of explanations.
  ipc.handle("kakapo:annotations-delete", (event, request: { path?: string; line?: number; text?: string }) => {
    const state = stateFromEvent(event);
    const file = state ? annotationsFilePath(state.options.root) : undefined;
    if (!state || !file || !existsSync(file)) return { ok: false };
    try {
      const doc = JSON.parse(readFileSync(file, "utf8")) as { notes?: unknown[] };
      const notes = Array.isArray(doc.notes) ? doc.notes : [];
      const kept = notes.filter((note) => {
        const item = note as { path?: unknown; line?: unknown; text?: unknown };
        return !(String(item.path ?? "") === String(request?.path ?? "")
          && Number(item.line ?? 0) === Number(request?.line ?? -1)
          && String(item.text ?? "") === String(request?.text ?? ""));
      });
      if (kept.length === notes.length) return { ok: false };
      writeFileSync(file, JSON.stringify({ ...doc, notes: kept }, null, 2));
      // Push the new list now rather than waiting for the next poll tick, so the card disappears on click.
      state.annotationsSig = ""; // force the next read to treat the file as changed
      refreshAnnotationsIfChanged(state);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
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
