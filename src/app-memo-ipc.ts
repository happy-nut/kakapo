import type { IpcMain, IpcMainInvokeEvent } from "electron";

// The window state this adapter needs: only the repo root, to scope the memo per worktree.
export type MemoStateResolver = (event: IpcMainInvokeEvent) => { options: { root: string } } | undefined;

// The single Markdown memo is application data, never a repository artifact — main owns the scoping (the
// calling window's canonical worktree) because the sandboxed renderer cannot choose a filesystem path.
// Injected as a small store so the persistence (ProjectMarkdownMemo + legacy import) stays in app-main.
export type MemoStore = {
  read: (root: string) => unknown;
  write: (root: string, body: unknown) => unknown;
  remove: (root: string) => void;
};

export function registerMemoIpc(ipc: IpcMain, memo: MemoStore, stateFromEvent: MemoStateResolver): void {
  ipc.handle("kakapo:memo-read", (event) => {
    const state = stateFromEvent(event);
    return state ? memo.read(state.options.root) : { version: 1, worktreePath: "", body: "", updatedAt: null };
  });
  ipc.handle("kakapo:memo-write", (event, input?: { body?: unknown }) => {
    const state = stateFromEvent(event);
    return state ? memo.write(state.options.root, input?.body) : null;
  });
  ipc.handle("kakapo:memo-delete", (event) => {
    const state = stateFromEvent(event);
    if (!state) return { ok: false };
    memo.remove(state.options.root);
    return { ok: true };
  });
}
