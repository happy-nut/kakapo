import { existsSync, readFileSync, statSync } from "node:fs";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { kakapoGitDataFile } from "./git.js";

// The window state the Explain spec watcher needs: the BrowserWindow to push updates to, the repo root
// used to resolve this window's spec-file path, and the last-seen signature/spec/timestamp so repeat
// polls with no change are near-free.
export type ExplainIpcState = {
  win: { isDestroyed(): boolean; webContents: WebContents };
  options: { root: string };
  explainSig: string;
  explainSpec: unknown;
  explainUpdatedAt: number | null;
  annotationsSig: string;
  annotationNotes: unknown[];
};

type ExplainEvent = IpcMainEvent | IpcMainInvokeEvent;
type ExplainStateResolver = (event: ExplainEvent) => ExplainIpcState | undefined;

// `.git/worktrees/<name>/kakapo/explain-spec.json` (or `.git/kakapo/explain-spec.json` for a non-worktree
// clone) — the same location and rationale as answersFilePath (answers-ipc.ts, issue #10): git never
// tracks its own `.git/` contents, so this never shows up in `git status`, but it still sits inside the
// worktree filesystem a cwd-sandboxed coding agent can reach — unlike a path under Electron's userData
// directory, which sits entirely outside the repo and may be unwritable from inside such a sandbox.
// Undefined outside a git repo.
export function explainSpecFilePath(root: string): string | undefined {
  return kakapoGitDataFile(root, "explain-spec.json");
}

// Agent-written inline diff annotations (the "explain this change like I'm 12" prompt writes these). Same
// watched-JSON-file-inside-.git mechanism and rationale as the Explain spec above — different payload:
// note cards anchored to {path, line} rather than one standalone document.
export function annotationsFilePath(root: string): string | undefined {
  return kakapoGitDataFile(root, "annotations.json");
}

function isValidExplainSpec(value: unknown): value is { sections: unknown[] } {
  return !!value && typeof value === "object" && Array.isArray((value as { sections?: unknown }).sections);
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
 * Explain view: an external AI agent writes a content-spec JSON file; kakapo polls it (see
 * refreshExplainIfChanged) and pushes the parsed spec to the renderer.
 */
export function registerExplainIpc(ipc: IpcMain, stateFromEvent: ExplainStateResolver): void {
  ipc.handle("kakapo:explain-read", (event) => {
    const state = stateFromEvent(event);
    if (!state) return { path: "", spec: null, updatedAt: null };
    return {
      path: explainSpecFilePath(state.options.root) ?? "",
      spec: state.explainSpec,
      updatedAt: state.explainUpdatedAt,
    };
  });
  ipc.handle("kakapo:annotations-read", (event) => {
    const state = stateFromEvent(event);
    if (!state) return { path: "", notes: [] };
    return { path: annotationsFilePath(state.options.root) ?? "", notes: state.annotationNotes };
  });
}

export function refreshExplainIfChanged(state: ExplainIpcState): void {
  if (state.win.isDestroyed()) return;
  const changed = readChangedJson(explainSpecFilePath(state.options.root), state.explainSig);
  if (!changed || !isValidExplainSpec(changed.value)) return;
  state.explainSig = changed.sig;
  state.explainSpec = changed.value;
  state.explainUpdatedAt = Date.now();
  state.win.webContents.send("kakapo:explain-update", { spec: changed.value, updatedAt: state.explainUpdatedAt });
}

// Same poll for annotations.json. The whole note list is replaced on every write — the agent rewrites the
// file wholesale each round, and the renderer's annotation store is likewise not merged but swapped.
export function refreshAnnotationsIfChanged(state: ExplainIpcState): void {
  if (state.win.isDestroyed()) return;
  const changed = readChangedJson(annotationsFilePath(state.options.root), state.annotationsSig);
  if (!changed) return;
  const notes = (changed.value as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(notes)) return;
  state.annotationsSig = changed.sig;
  state.annotationNotes = notes;
  state.win.webContents.send("kakapo:annotations-update", { notes });
}
