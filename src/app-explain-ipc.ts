import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { absoluteGitDir } from "./git.js";

// The window state the Explain spec watcher needs: the BrowserWindow to push updates to, the repo root
// used to resolve this window's spec-file path, and the last-seen signature/spec/timestamp so repeat
// polls with no change are near-free.
export type ExplainIpcState = {
  win: { isDestroyed(): boolean; webContents: WebContents };
  options: { root: string };
  explainSig: string;
  explainSpec: unknown;
  explainUpdatedAt: number | null;
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
  const gitDir = absoluteGitDir(root);
  return gitDir ? join(gitDir, "kakapo", "explain-spec.json") : undefined;
}

function isValidExplainSpec(value: unknown): value is { sections: unknown[] } {
  return !!value && typeof value === "object" && Array.isArray((value as { sections?: unknown }).sections);
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
}

// Mirrors refreshIfChanged()'s cheap-check-before-expensive-work shape, but inverted: there the git diff
// hash is cheap and the rebuild is expensive; here reading+parsing the spec file is the expensive step,
// so a bare stat (mtime+size) gates it rather than a content hash.
export function refreshExplainIfChanged(state: ExplainIpcState): void {
  if (state.win.isDestroyed()) return;
  const file = explainSpecFilePath(state.options.root);
  if (!file || !existsSync(file)) return;
  let sig: string;
  try {
    const stat = statSync(file);
    sig = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return;
  }
  if (sig === state.explainSig) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return; // the agent may still be mid-write — retry next tick, don't advance explainSig
  }
  if (!isValidExplainSpec(parsed)) return;
  state.explainSig = sig;
  state.explainSpec = parsed;
  state.explainUpdatedAt = Date.now();
  state.win.webContents.send("kakapo:explain-update", { spec: parsed, updatedAt: state.explainUpdatedAt });
}
