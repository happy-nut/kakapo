import { app, BrowserWindow, Notification } from "electron";
import type { WebContents } from "electron";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { spawn as spawnPty, type IPty } from "node-pty";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sanitizeTerminalEnv, ensureUtf8Locale, tmuxSessionName, nextTerminalOrdinal, tmuxSpawnArgs, createPtyReaper } from "./util.js";
import { resumeCommandForInput } from "./agent-resume.js";

// A GUI launch (Finder, Dock, Spotlight) inherits a minimal PATH with no Homebrew prefix, so `tmux` is
// usually invisible to us even when the user's own shell finds it. Check PATH first, then the standard
// prefixes. Never cached: `brew install tmux` from the settings panel has to take effect without a restart.
function resolveTmux(env: NodeJS.ProcessEnv): string | undefined {
  const fromPath = (env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "tmux"));
  for (const candidate of [...fromPath, "/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Ordinals in use by this window's live panes. Sessions left behind by a previous run are deliberately not
// counted: they are exactly what a reopened pane should re-attach to. Two windows on the same workspace do
// land on the same session and mirror each other, which is tmux's normal shared-session behaviour.
function sessionOrdinals(state: TerminalIpcState): number[] {
  const ordinals: number[] = [];
  for (const name of state.termSessions?.values() ?? []) {
    const match = /-(\d+)$/.exec(name);
    if (match) ordinals.push(Number(match[1]));
  }
  return ordinals;
}

function resolveBrew(env: NodeJS.ProcessEnv): string | undefined {
  const fromPath = (env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "brew"));
  for (const candidate of [...fromPath, "/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// The window state the terminal needs: the BrowserWindow to relay pty output to, the repo root the shell
// starts in, and the per-window map of live ptys (so closing a window kills only its own terminals).
export type TerminalIpcState = {
  win: { isDestroyed(): boolean; webContents: WebContents; show(): void; focus(): void };
  options: { root: string };
  terms: Map<number, IPty>;
  // Absolute path to this window's answers-exchange file (see answers-ipc.ts), passed into every pty
  // spawned in this window so an agent can find it without depending on the prompt text being intact.
  answersFile?: string;
  // Persistent terminals: pty id -> the tmux session it is attached to. Closing a pane kills that session;
  // quitting the app just drops the client, leaving the session (and the agent in it) running.
  termSessions?: Map<number, string>;
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

// Every pty kill in the app goes through this (window close, workspace removal, pane close, quit) so quit can
// wait for the native exit deliveries instead of aborting on them — see createPtyReaper.
export const ptyReaper = createPtyReaper();

/**
 * Integrated terminal: own node-pty sessions in the main process (the sandboxed renderer can't spawn
 * them) and relay bytes to the renderer's xterm panes. Each pty is owned by the window that spawned it
 * (state.terms), so closing one window kills only its terminals and pty data routes back to it alone.
 */
// Tear down every pane of a workspace, tmux sessions included. Killing only the ptys would DETACH a
// persistent pane instead of ending it, leaving the session — and whatever agent is running in it — alive
// forever, invisible, with its worktree deleted out from under it. Shared by the pane close path and by
// deleting a workspace (app-main.ts's hub-remove).
export function killWorkspaceTerminals(state: TerminalIpcState): void {
  const tmux = state.termSessions?.size ? resolveTmux(process.env) : undefined;
  for (const [id, session] of state.termSessions ?? []) {
    if (tmux) try { spawnSync(tmux, ["kill-session", "-t", session]); } catch { /* already gone */ }
    state.termSessions?.delete(id);
  }
  for (const [id, term] of state.terms) { ptyReaper.kill(term); state.terms.delete(id); }
  state.commandBuffers?.clear();
}

export function registerTerminalIpc(ipc: IpcMain, stateFromEvent: TerminalStateResolver): void {
  ipc.handle("kakapo:pty-spawn", (event, size: { cols?: number; rows?: number; persist?: boolean }) => {
    const state = stateFromEvent(event);
    if (!state) return { ok: false, id: -1 };
    const id = ++nextPtyId;
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const answersEnv: { [key: string]: string } = state.answersFile ? { KAKAPO_ANSWERS_FILE: state.answersFile } : {};
    // Persistent terminals (Settings > Terminal, off by default): run the shell inside a per-workspace tmux
    // session so it survives the app quitting. The renderer passes the preference it already holds; tmux
    // being absent silently falls back to a plain shell, which is the pre-existing behaviour.
    const tmux = size?.persist ? resolveTmux(process.env) : undefined;
    const session = tmux ? tmuxSessionName(state.options.root, nextTerminalOrdinal(sessionOrdinals(state))) : undefined;
    const t = spawnPty(tmux ?? shell, session ? tmuxSpawnArgs(session, state.options.root, answersEnv) : [], {
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
        ...answersEnv,
      }),
    });
    state.terms.set(id, t);
    if (session) state.termSessions?.set(id, session);
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
        ptyReaper.settle(t);
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
    // Closing a pane means "I'm done with this shell", so a persistent pane's tmux session has to go with it.
    // Killing only the pty would detach instead — the session (and whatever agent is in it) would linger
    // forever, invisible, and the next pane would silently re-attach to it. Quitting the app is the opposite
    // case and needs no handling: the pty dies, the client detaches, the session keeps running.
    const session = state?.termSessions?.get(msg?.id);
    if (session) {
      const tmux = resolveTmux(process.env);
      if (tmux) try { spawnSync(tmux, ["kill-session", "-t", session]); } catch { /* already gone */ }
      state!.termSessions!.delete(msg.id);
    }
    if (t) { ptyReaper.kill(t); state!.terms.delete(msg.id); }
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
    // In a persistent pane the pty's own foreground process is always tmux, which would make every ⌘W warn
    // that "tmux is running". Ask tmux for the command in the session's active pane instead.
    const session = typeof msg?.id === "number" ? state?.termSessions?.get(msg.id) : undefined;
    const tmux = session ? resolveTmux(process.env) : undefined;
    if (session && tmux) {
      try {
        const probe = spawnSync(tmux, ["display-message", "-p", "-t", session, "#{pane_current_command}"], { encoding: "utf8" });
        fg = probe.status === 0 ? String(probe.stdout ?? "").trim() : "";
      } catch { /* server gone — fall through to the empty name below */ }
    } else {
      try { fg = t.process || ""; } catch { /* pty may have exited mid-query */ }
    }
    const name = fg.replace(/^-/, ""); // login shells surface as "-zsh"
    return { running: !!name && name !== shellName, name };
  });

  // Persistent terminals need tmux, which macOS does not ship (its bundled `screen` is a 2006 build that
  // mangles modern TUIs). Settings shows this status and, when Homebrew is present, offers to install it.
  ipc.handle("kakapo:tmux-status", () => ({
    tmux: !!resolveTmux(process.env),
    brew: !!resolveBrew(process.env),
  }));

  // `brew install tmux` streamed into the settings panel's log so the install is visible where it was asked
  // for, instead of opening a terminal pane the user then has to close. One run at a time per window.
  const installing = new WeakSet<object>();
  ipc.on("kakapo:tmux-install", (event) => {
    const state = stateFromEvent(event);
    if (!state || state.win.isDestroyed()) return;
    const brew = resolveBrew(process.env);
    const emit = (channel: string, payload: unknown) => {
      if (!state.win.isDestroyed()) state.win.webContents.send(channel, payload);
    };
    if (!brew) { emit("kakapo:tmux-install-done", { ok: false, reason: "no-brew" }); return; }
    if (installing.has(state)) return;
    installing.add(state);
    // Homebrew writes progress to stderr and only results to stdout; the panel shows both as one log.
    const child = spawn(brew, ["install", "tmux"], { env: sanitizeTerminalEnv(process.env) });
    child.stdout.on("data", (chunk: Buffer) => emit("kakapo:tmux-install-output", String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => emit("kakapo:tmux-install-output", String(chunk)));
    child.on("error", (error) => {
      installing.delete(state);
      emit("kakapo:tmux-install-done", { ok: false, reason: error.message });
    });
    child.on("close", (code) => {
      installing.delete(state);
      // Trust the filesystem over the exit code: brew exits non-zero on a re-install of an already-linked
      // formula, which for our purposes is success.
      emit("kakapo:tmux-install-done", { ok: !!resolveTmux(process.env), reason: code === 0 ? "" : `exit ${code}` });
    });
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
