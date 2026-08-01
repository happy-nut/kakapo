import { app, BrowserWindow, Notification } from "electron";
import type { WebContents } from "electron";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { spawn as spawnPty, type IPty } from "node-pty";
import { sanitizeTerminalEnv, ensureUtf8Locale } from "./util.js";
import { resumeCommandForInput } from "./agent-resume.js";

// The window state the terminal needs: the BrowserWindow to relay pty output to, the repo root the shell
// starts in, and the per-window map of live ptys (so closing a window kills only its own terminals).
export type TerminalIpcState = {
  win: { isDestroyed(): boolean; webContents: WebContents; show(): void; focus(): void };
  options: { root: string };
  terms: Map<number, IPty>;
  // Absolute path to this window's answers-exchange file (see answers-ipc.ts), passed into every pty
  // spawned in this window so an agent can find it without depending on the prompt text being intact.
  answersFile?: string;
  commandBuffers?: Map<number, string>;
  onResumeCommand?: (command: string | undefined) => void;
  onAgentFinished?: () => void;
  // Rail activity indicators: onAgentOutput fires on every pty output chunk (drives the "working" spinner via a
  // debounce in main); onAgentBell fires when a TUI rings the bell (Claude Code finished a turn / needs input),
  // which lights the "needs attention" dot on the workspace tile.
  onAgentOutput?: () => void;
  onAgentBell?: () => void;
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
      env: ensureUtf8Locale({
        ...sanitizeTerminalEnv(process.env),
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...(state.answersFile ? { KAKAPO_ANSWERS_FILE: state.answersFile } : {}),
      }),
    });
    state.terms.set(id, t);
    state.commandBuffers?.set(id, "");
    // Guard every relay with isDestroyed(): a pty can outlive its window (close races pty teardown), and
    // sending to a closed window's webContents throws "Object has been destroyed".
    const deliver = (channel: string, payload: unknown) => {
      if (!state.win.isDestroyed()) state.win.webContents.send(channel, payload);
    };
    // Relay pty output to the renderer immediately, one IPC per chunk. (A coalescing buffer was tried as an
    // optimization but it broke terminal I/O — the shell prompt and echo stopped appearing — so it's removed.)
    // node-pty escalates ANY exception thrown out of an onData/onExit callback into a native SIGABRT that takes
    // the whole process down — it is NOT a catchable JS error at the caller. A pty keeps firing these while its
    // window is mid-teardown; deliver()'s isDestroyed guard usually skips, but the webContents can still be torn
    // down between the guard and the .send() (which then throws "Object has been destroyed"). Wrap the whole
    // callback body so nothing can reach node-pty's C++ boundary.
    t.onData((data) => {
      try { deliver("kakapo:pty-data", { id, data }); state.onAgentOutput?.(); } catch { /* window torn down mid-drain */ }
    });
    t.onExit(() => {
      try {
        state.terms.delete(id);
        state.commandBuffers?.delete(id);
        state.onAgentFinished?.();
        deliver("kakapo:pty-exit", { id });
      } catch { /* teardown race — ignore */ }
    });
    return { ok: true, id };
  });

  ipc.on("kakapo:pty-write", (event, msg: { id: number; data: string }) => {
    const state = stateFromEvent(event);
    state?.terms.get(msg?.id)?.write(msg.data);
    if (!state?.commandBuffers || typeof msg?.data !== "string") return;
    const next = (state.commandBuffers.get(msg.id) ?? "") + msg.data;
    if (!/[\r\n]/.test(next)) { state.commandBuffers.set(msg.id, next.slice(-500)); return; }
    state.commandBuffers.set(msg.id, "");
    const resume = resumeCommandForInput(next);
    if (resume) state.onResumeCommand?.(resume);
  });
  ipc.on("kakapo:pty-resize", (event, msg: { id: number; cols: number; rows: number }) => {
    try { stateFromEvent(event)?.terms.get(msg?.id)?.resize(msg.cols, msg.rows); } catch { /* resize can race the pty teardown — ignore */ }
  });
  ipc.on("kakapo:pty-kill", (event, msg: { id: number }) => {
    const state = stateFromEvent(event);
    const t = state?.terms.get(msg?.id);
    if (t) { try { t.kill(); } catch { /* already exited */ } state!.terms.delete(msg.id); }
    state?.commandBuffers?.delete(msg.id);
  });

  // Whether a pane is running a foreground process (an agent/command) rather than sitting idle at the shell
  // prompt. node-pty's `process` reports the pty's foreground process name; when it's no longer the shell,
  // something is running — the renderer uses this to confirm before ⌘W kills the pane out from under it.
  ipc.handle("kakapo:pty-foreground", (event, msg: { id?: number }) => {
    const state = stateFromEvent(event);
    const t = typeof msg?.id === "number" ? state?.terms.get(msg.id) : undefined;
    if (!t) return { running: false, name: "" };
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const shellName = shell.split(/[\\/]/).pop() || shell;
    let fg = "";
    try { fg = t.process || ""; } catch { /* pty may have exited mid-query */ }
    const name = fg.replace(/^-/, ""); // login shells surface as "-zsh"
    return { running: !!name && name !== shellName, name };
  });

  // A TUI in the integrated terminal rang the bell (e.g. Claude Code finished a turn / needs input). Raise a
  // native notification when the window ISN'T focused — while you're watching, the bell itself is enough — plus
  // a dock bounce / taskbar flash. Clicking the notification brings the window forward.
  ipc.on("kakapo:bell", (event, msg: { title?: string; body?: string }) => {
    const state = stateFromEvent(event);
    if (!state || state.win.isDestroyed()) return;
    // Light the tile's attention dot whenever a background turn finishes — even if the app is focused on a
    // different workspace. This runs before the focus check below, which only gates the native notification.
    state.onAgentBell?.();
    const win = BrowserWindow.getFocusedWindow();
    if (win?.isFocused()) return;
    try {
      if (Notification.isSupported()) {
        const note = new Notification({ title: msg?.title || "kakapo", body: msg?.body || "Terminal task finished" });
        note.on("click", () => { if (!state.win.isDestroyed()) { state.win.show(); state.win.focus(); } });
        note.show();
      }
    } catch { /* notifications are best-effort */ }
    try { BrowserWindow.getAllWindows()[0]?.flashFrame(true); } catch { /* taskbar flash — Windows/Linux */ }
    if (process.platform === "darwin" && app.dock) { try { app.dock.bounce("informational"); } catch { /* best-effort */ } }
  });
}
