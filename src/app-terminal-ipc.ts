import { app, BrowserWindow, Notification } from "electron";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { spawn as spawnPty, type IPty } from "node-pty";
import { sanitizeTerminalEnv, ensureUtf8Locale } from "./util.js";

// The window state the terminal needs: the BrowserWindow to relay pty output to, the repo root the shell
// starts in, and the per-window map of live ptys (so closing a window kills only its own terminals).
export type TerminalIpcState = {
  win: BrowserWindow;
  options: { root: string };
  terms: Map<number, IPty>;
};

type TerminalEvent = IpcMainEvent | IpcMainInvokeEvent;
type TerminalStateResolver = (event: TerminalEvent) => TerminalIpcState | undefined;

let nextPtyId = 0; // global so pty ids never collide across windows; each window holds only its own in state.terms

/**
 * Integrated terminal: own node-pty sessions in the main process (the sandboxed renderer can't spawn
 * them) and relay bytes to the renderer's xterm panes. Each pty is owned by the window that spawned it
 * (state.terms), so closing one window kills only its terminals and pty data routes back to it alone.
 */
export function registerTerminalIpc(ipc: IpcMain, stateFromEvent: TerminalStateResolver): void {
  ipc.handle("kakapo:pty-spawn", (event, size: { cols?: number; rows?: number }) => {
    const state = stateFromEvent(event);
    if (!state) return { ok: false, id: -1 };
    const id = ++nextPtyId;
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const t = spawnPty(shell, [], {
      // 256-color terminfo + COLORTERM=truecolor so TUIs (e.g. Claude Code's coral logo) emit 24-bit color and
      // xterm.js renders the exact hue. "xterm-color" is 8-color, which downgraded the orange logo to ANSI red.
      name: "xterm-256color",
      cols: size?.cols ?? 80,
      rows: size?.rows ?? 24,
      cwd: state.options.root,
      env: ensureUtf8Locale({ ...sanitizeTerminalEnv(process.env), TERM: "xterm-256color", COLORTERM: "truecolor" }),
    });
    state.terms.set(id, t);
    // Guard every relay with isDestroyed(): a pty can outlive its window (close races pty teardown), and
    // sending to a closed window's webContents throws "Object has been destroyed".
    const deliver = (channel: string, payload: unknown) => {
      if (!state.win.isDestroyed()) state.win.webContents.send(channel, payload);
    };
    // Relay pty output to the renderer immediately, one IPC per chunk. (A coalescing buffer was tried as an
    // optimization but it broke terminal I/O — the shell prompt and echo stopped appearing — so it's removed.)
    t.onData((data) => deliver("kakapo:pty-data", { id, data }));
    t.onExit(() => { state.terms.delete(id); deliver("kakapo:pty-exit", { id }); });
    return { ok: true, id };
  });

  ipc.on("kakapo:pty-write", (event, msg: { id: number; data: string }) => {
    stateFromEvent(event)?.terms.get(msg?.id)?.write(msg.data);
  });
  ipc.on("kakapo:pty-resize", (event, msg: { id: number; cols: number; rows: number }) => {
    try { stateFromEvent(event)?.terms.get(msg?.id)?.resize(msg.cols, msg.rows); } catch { /* resize can race the pty teardown — ignore */ }
  });
  ipc.on("kakapo:pty-kill", (event, msg: { id: number }) => {
    const state = stateFromEvent(event);
    const t = state?.terms.get(msg?.id);
    if (t) { try { t.kill(); } catch { /* already exited */ } state!.terms.delete(msg.id); }
  });

  // A TUI in the integrated terminal rang the bell (e.g. Claude Code finished a turn / needs input). Raise a
  // native notification when the window ISN'T focused — while you're watching, the bell itself is enough — plus
  // a dock bounce / taskbar flash. Clicking the notification brings the window forward.
  ipc.on("kakapo:bell", (event, msg: { title?: string; body?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || win.isFocused()) return;
    try {
      if (Notification.isSupported()) {
        const note = new Notification({ title: msg?.title || "kakapo", body: msg?.body || "Terminal task finished" });
        note.on("click", () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
        note.show();
      }
    } catch { /* notifications are best-effort */ }
    try { win.flashFrame(true); } catch { /* taskbar flash — Windows/Linux */ }
    if (process.platform === "darwin" && app.dock) { try { app.dock.bounce("informational"); } catch { /* best-effort */ } }
  });
}
