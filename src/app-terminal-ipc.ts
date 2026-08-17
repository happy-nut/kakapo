import { app, BrowserWindow, Notification } from "electron";
import type { WebContents } from "electron";
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { spawn as spawnPty, type IPty } from "node-pty";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sanitizeTerminalEnv, ensureUtf8Locale, tmuxSessionName, tmuxSessionsForRoot, nextTerminalOrdinal, tmuxSpawnArgs, createPtyReaper, endTmuxSession, tmuxPaneCommand } from "./util.js";
import { resumeCommandForInput } from "./agent-resume.js";

// A GUI launch (Finder, Dock, Spotlight) inherits a minimal PATH with no Homebrew prefix, so `tmux` is
// usually invisible to us even when the user's own shell finds it. Check PATH first, then the standard
// prefixes. Never cached: `brew install tmux` from the settings panel has to take effect without a restart.
export function resolveTmux(env: NodeJS.ProcessEnv): string | undefined {
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
  commentsFile?: string;
  // Persistent terminals: pty id -> the tmux session it is attached to. Quitting the app only drops the
  // client and the session (with the agent in it) runs on; closing the pane with ⌘W ends it.
  termSessions?: Map<number, string>;
  commandBuffers?: Map<number, string>;
  onResumeCommand?: (command: string | undefined) => void;
  onAgentFinished?: () => void;
  // Rail activity indicators: onAgentOutput fires on every pty output chunk (drives the "working" spinner via a
  // debounce in main); onAgentBell fires when a TUI rings the bell (Claude Code finished a turn / needs input),
  // which lights the "needs attention" dot on the workspace tile.
  onAgentOutput?: () => void;
  onAgentBell?: () => void;
  // Whether THIS workspace is the one on screen. Workspaces are views inside one window, so "a window is
  // focused" cannot answer it — and that was the question the bell was asking before suppressing itself.
  isOnScreen?: () => boolean;
};

type TerminalEvent = IpcMainEvent | IpcMainInvokeEvent;
type TerminalStateResolver = (event: TerminalEvent) => TerminalIpcState | undefined;

let nextPtyId = 0; // global so pty ids never collide across windows; each window holds only its own in state.terms

// pty id -> the moment its post-resize echo stops counting as agent activity (see kakapo:pty-resize). Keyed by
// the globally unique pty id, so one map serves every window; entries are dropped when the pty exits.
const resizeEchoUntil = new Map<number, number>();
const RESIZE_ECHO_MS = 250;

// Every pty kill in the app goes through this (window close, workspace removal, pane close, quit) so quit can
// wait for the native exit deliveries instead of aborting on them — see createPtyReaper.
export const ptyReaper = createPtyReaper();

/**
 * Integrated terminal: own node-pty sessions in the main process (the sandboxed renderer can't spawn
 * them) and relay bytes to the renderer's xterm panes. Each pty is owned by the window that spawned it
 * (state.terms), so closing one window kills only its terminals and pty data routes back to it alone.
 */
// Deleting a workspace ends ALL of its terminals, including the ones this run never opened — ⌘W ends a single
// pane's session, and quitting drops the client without ending anything. So this cannot work off the
// in-memory pty -> session map: panes aren't restored on
// launch, so that map only knows the panes reopened by hand since the last start, and everything else would
// be left running forever, invisible, with its worktree deleted out from under it. Ask tmux which sessions
// belong to this workspace instead. Called from app-main.ts's hub-remove (delete), and nowhere else.
export function killWorkspaceTerminals(state: TerminalIpcState): void {
  const tmux = resolveTmux(process.env);
  if (tmux) {
    let listed = "";
    try {
      const list = spawnSync(tmux, ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
      listed = String(list.stdout ?? ""); // no server running -> non-zero exit, empty stdout, nothing to kill
    } catch { /* tmux unusable — the ptys below still go */ }
    for (const session of tmuxSessionsForRoot(state.options.root, listed)) {
      try { spawnSync(tmux, ["kill-session", "-t", session]); } catch { /* already gone */ }
    }
  }
  state.termSessions?.clear();
  for (const [id, term] of state.terms) { ptyReaper.kill(term); state.terms.delete(id); }
  state.commandBuffers?.clear();
}

export function registerTerminalIpc(ipc: IpcMain, stateFromEvent: TerminalStateResolver): void {
  // The ordinals of this workspace's live tmux sessions, lowest first. A pane reopened after a restart
  // re-attaches by ordinal, so this is what lets the panel come back with the panes it had rather than one:
  // two agents left running are two sessions, and the renderer restores one pane each.
  ipc.handle("kakapo:pty-sessions", (event) => {
    const state = stateFromEvent(event);
    const tmux = state ? resolveTmux(process.env) : undefined;
    if (!state || !tmux) return { ordinals: [] };
    let listed = "";
    try {
      const list = spawnSync(tmux, ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
      listed = String(list.stdout ?? "");
    } catch { /* no server running -> no sessions */ }
    const ordinals = tmuxSessionsForRoot(state.options.root, listed)
      .map((name) => Number(/-(\d+)$/.exec(name)?.[1] ?? 0))
      .filter((ordinal) => ordinal > 0)
      .sort((a, b) => a - b);
    return { ordinals };
  });

  ipc.handle("kakapo:pty-spawn", (event, size: { cols?: number; rows?: number; ordinal?: number }) => {
    const state = stateFromEvent(event);
    if (!state) return { ok: false, id: -1 };
    const id = ++nextPtyId;
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const answersEnv: { [key: string]: string } = state.commentsFile ? { KAKAPO_COMMENTS_FILE: state.commentsFile } : {};
    // Every pane runs inside a per-workspace tmux session, so a terminal belongs to its workspace rather than
    // to this app run: quitting drops the client and the agent keeps working. This used to be an opt-in
    // preference stored PER WORKSPACE while reading as an app-wide setting, so ticking it in one workspace
    // left every other one dying on quit. tmux being absent falls back to a plain shell, as before.
    const tmux = resolveTmux(process.env);
    // A restore asks for the ordinal it is re-attaching to; everything else takes the lowest free one.
    const ordinal = Number.isInteger(size?.ordinal) && (size?.ordinal ?? 0) > 0
      ? Number(size?.ordinal)
      : nextTerminalOrdinal(sessionOrdinals(state));
    const session = tmux ? tmuxSessionName(state.options.root, ordinal) : undefined;
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
      // The bytes always reach the pane — only the ACTIVITY signal is filtered, so a prompt redrawn after our
      // own resize still paints, it just doesn't claim an agent is working here.
      try {
        deliver("kakapo:pty-data", { id, data });
        const quiet = resizeEchoUntil.get(id);
        if (!(quiet && Date.now() < quiet)) state.onAgentOutput?.();
      } catch { /* window torn down mid-drain */ }
    });
    t.onExit(() => {
      try {
        ptyReaper.settle(t);
        state.terms.delete(id);
        state.commandBuffers?.delete(id);
        resizeEchoUntil.delete(id);
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
    try {
      const t = stateFromEvent(event)?.terms.get(msg?.id);
      if (!t) return;
      // A resize is SIGWINCH, and a shell answers SIGWINCH by reprinting its prompt. That output is ours, not
      // an agent's — but it arrives on the same onData channel, so it lit the rail's "working" spinner for a
      // workspace sitting idle at a bare prompt. Switching workspaces is exactly this: the view becomes
      // visible, the ResizeObserver fires a fit, every pane resizes, and every one of them answers. Ignore the
      // echo for a beat. A real agent that happens to be streaming through the window just re-arms the spinner
      // with its next chunk, ~16ms later.
      resizeEchoUntil.set(msg.id, Date.now() + RESIZE_ECHO_MS);
      t.resize(msg.cols, msg.rows);
    } catch { /* resize can race the pty teardown — ignore */ }
  });
  ipc.on("kakapo:pty-kill", (event, msg: { id: number; endSession?: boolean }) => {
    const state = stateFromEvent(event);
    const t = state?.terms.get(msg?.id);
    const session = state?.termSessions?.get(msg?.id);
    // Two ways a pane goes away, and they mean different things. Quitting the app (or closing a window) only
    // DETACHES: the session and the agent in it keep working, and a reopened pane re-attaches by ordinal.
    // Closing the pane yourself with ⌘W is a decision about that terminal, so it ends the session too —
    // otherwise the agent runs on invisibly, holding its tokens, in a pane nobody can see. The renderer asks
    // first when something is running there (pty-foreground below), so a stray ⌘W still can't take an agent
    // out silently.
    const tmux = msg?.endSession && session ? resolveTmux(process.env) : undefined;
    if (tmux && session) endTmuxSession(tmux, session);
    state?.termSessions?.delete(msg?.id);
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
    // A tmux-backed pane used to answer "nothing is running" here, because closing it only detached and the
    // warning would have been a lie. ⌘W ends the session now, so the question is real again — and it has to
    // be put to tmux, which knows what is in the pane, rather than to the pty (that is the tmux client).
    const session = typeof msg?.id === "number" ? state?.termSessions?.get(msg.id) : undefined;
    const tmux = session ? resolveTmux(process.env) : undefined;
    if (session && tmux) {
      const inPane = tmuxPaneCommand(tmux, session).replace(/^-/, "");
      return { running: !!inPane && inPane !== shellName, name: inPane };
    }
    let fg = "";
    try { fg = t.process || ""; } catch { /* pty may have exited mid-query */ }
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
  ipc.on("kakapo:bell", (event, msg: { title?: string; body?: string; seq?: number }) => {
    const state = stateFromEvent(event);
    if (!state || state.win.isDestroyed()) return;
    // Light the tile's attention dot whenever a background turn finishes — even if the app is focused on a
    // different workspace. This runs before the focus check below, which only gates the native notification.
    state.onAgentBell?.();
    // Suppress only when you are looking at the workspace that rang. Any focused kakapo window used to be
    // enough to swallow this, so a turn finishing in ANOTHER workspace — the case you most need telling about,
    // since you cannot see its terminal — announced itself with nothing but a dock bounce. Workspaces are
    // views inside one window, so being focused says which APP you are in, never which workspace.
    const appFocused = !!BrowserWindow.getFocusedWindow()?.isFocused();
    if (appFocused && state.isOnScreen?.() !== false) return;
    try {
      if (Notification.isSupported()) {
        const note = new Notification({ title: msg?.title || "kakapo", body: msg?.body || "Terminal task finished" });
        note.on("click", () => {
          if (state.win.isDestroyed()) return;
          state.win.show();
          state.win.focus();
          // Raising the window drops you wherever you left off, which for a notification about one answer in
          // a long review is not where you meant to go. When the bell named a comment, land on it.
          if (Number.isFinite(msg?.seq)) state.win.webContents.send("kakapo:comments-reveal", { seq: msg?.seq });
        });
        note.show();
      }
    } catch { /* notifications are best-effort */ }
    try { BrowserWindow.getAllWindows()[0]?.flashFrame(true); } catch { /* taskbar flash — Windows/Linux */ }
    if (process.platform === "darwin" && app.dock) { try { app.dock.bounce("informational"); } catch { /* best-effort */ } }
  });
}
