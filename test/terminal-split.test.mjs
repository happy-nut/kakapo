// Cmd+D splits the terminal side by side; Cmd+Shift+D stacks the panes top/bottom. The panes are xterm
// instances, which don't boot under jsdom, so this pins the chain that made the shortcut a no-op instead:
// the accelerator has to exist, the direction has to survive main -> preload -> client, and the column
// layout has to actually be expressible in CSS (a flex column whose children have no min-height collapses
// every pane to zero, which looks exactly like "the split did nothing").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const appMain = read("src/app-main.ts");
const preload = read("src/preload.cts");
const client = read("src/viewer/19-terminal.js");
const css = read("src/viewer.css");

test("both split directions are bound to accelerators and carry a direction", () => {
  const right = appMain.match(/accelerator: "CommandOrControl\+D".*/)?.[0];
  const down = appMain.match(/accelerator: "CommandOrControl\+Shift\+D".*/)?.[0];
  assert.ok(right, "Cmd+D is still bound");
  assert.ok(down, "Cmd+Shift+D is bound at all — it previously matched nothing, so the key did nothing");
  assert.match(right, /kakapo:terminal-split", "row"/, "Cmd+D asks for a side-by-side split");
  assert.match(down, /kakapo:terminal-split", "column"/, "Cmd+Shift+D asks for a stacked split");
});

test("the preload forwards the direction and defaults anything unexpected to a side-by-side split", () => {
  const handler = preload.match(/onTerminalSplit:[\s\S]*?\n  \},/)?.[0];
  assert.ok(handler, "onTerminalSplit bridge exists");
  assert.match(handler, /\(_event, direction\)/, "the direction is read off the IPC event, not dropped");
  assert.match(handler, /direction === "column" \? "column" : "row"/,
    "an unknown/missing direction falls back to the old behavior rather than silently stacking");
});

// A stacked split must act on the pane you are IN. The panel used to carry a single axis for every pane, so
// Cmd+Shift+D flipped the whole panel — two side-by-side panes suddenly became two stacked ones. Panes now
// live in cells (the panel is a row of cells, a cell is a column of panes), so a stacked split adds to the
// focused pane's own cell and leaves every other pane where it was.
test("a stacked split nests inside the focused pane's cell instead of re-orienting the panel", () => {
  const split = client.match(/function split\(direction\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(split, "split takes a direction");
  assert.match(split, /direction === 'column' && active[\s\S]{0,80}active\.el\.parentNode : makeCell\(\)/,
    "column splits reuse the active pane's cell; row splits open a new one");
  assert.doesNotMatch(split, /is-column/, "no panel-wide axis flag survives");
  assert.match(split, /scheduleFitAll\(\)/,
    "xterm is re-fitted after the new layout (one frame later), not against the pre-split geometry");
  assert.match(client, /onTerminalSplit\(split\)/, "the bridge is wired to it");
  // An emptied cell would keep its share of the row and read as a gap where the pane used to be.
  assert.match(client, /!cell\.children\.length[\s\S]{0,60}removeChild\(cell\)/,
    "closing the last pane of a cell removes the cell");
});

test("cells and panes can both actually shrink, so a stacked split shows two panes", () => {
  const cell = css.match(/^\.terminal-cell \{[^}]*\}/m)?.[0];
  assert.ok(cell, ".terminal-cell rule exists");
  assert.match(cell, /flex-direction: column/, "a cell stacks its panes");
  assert.match(cell, /min-height: 0/, "and can shrink inside the row");
  assert.match(cell, /flex: 1 1 0/, "cells share the row evenly");
  const pane = css.match(/^\.terminal-pane \{[^}]*\}/m)?.[0];
  assert.ok(pane, ".terminal-pane rule exists");
  assert.match(pane, /min-height: 0/,
    "without min-height a flex-column child cannot shrink and the stacked panes collapse to nothing");
  assert.match(pane, /flex: 1 1 0/, "panes still share their cell evenly");
});

// Cmd+0 / Cmd+1 reveal the Changes / Files tree, and the floating terminal covers exactly that — leaving it
// open made the shortcut look like it had done nothing. Both funnels (keyboard and the activity-rail icons)
// go through these two functions, so the close belongs there rather than in the key handler.
const keymap = read("src/viewer/05-keymap.js");

test("switching to Changes or Files puts an open terminal away", () => {
  for (const fn of ["activateChangesView", "activateFilesView"]) {
    const body = keymap.match(new RegExp(`function ${fn}\\([^)]*\\) \\{\\n([^\\n]*\\n){0,2}`))?.[0];
    assert.ok(body, `${fn} exists`);
    assert.match(body, /closeTerminalForViewSwitch\(\)/, `${fn} closes the terminal first`);
  }
});

test("the close never toggles a closed terminal back on", () => {
  const helper = keymap.match(/function closeTerminalForViewSwitch\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "helper exists");
  assert.match(helper, /if \(api\.isOpen\(\)\) api\.close\(\)/,
    "guarded on isOpen — close() is a plain close, but the guard keeps this honest if it ever becomes a toggle");
  assert.match(helper, /typeof api\.isOpen !== 'function'/, "no-ops when the terminal bundle never booted");
});

// Esc belongs to whatever is RUNNING in the pane, never to the panel. The panel used to take it — at once at
// a plain prompt, and on a second press inside a window in a fullscreen TUI — and both cost the program its
// key: vi-mode leaves insert with Esc, readline reads it as the Meta prefix, and Claude Code binds double-Esc
// itself, which was precisely the gesture the panel listened for.
const terminal = read("src/viewer/19-terminal.js");

test("Escape is never intercepted by the terminal panel", () => {
  assert.doesNotMatch(terminal, /e\.key === 'Escape'[\s\S]{0,400}setOpen\(false\)/,
    "no Escape path closes the panel");
  for (const gone of ["ESC_CLOSE_MS", "lastEscAt"]) {
    assert.ok(!terminal.includes(gone), `the double-Esc window is gone with it: ${gone}`);
  }
  // The panel still has to be closable without it: the toggle is a menu accelerator (Ctrl+` / Alt+F12 in
  // app-main.ts, because Chromium swallows those before the page sees them) plus the footer button.
  assert.match(terminal, /kakapoMenu\.onTerminalToggle/, "the menu toggle still reaches the panel");
  assert.match(terminal, /getElementById\('terminal-toggle'\)/, "and the footer button is still wired");
});

// The terminal's whole runtime is inlined as one island (assets.ts -> render.ts), so what that island
// exposes IS the terminal's feature set: xterm itself, the fit addon that keeps it sized to the pane, and
// the link addon 19-terminal.js hands clicked URLs from. A missing addon must not be able to take the
// terminal with it — the renderer already skips the link addon when its global is absent.
test("the xterm island carries the terminal runtime, and links stay optional", async () => {
  const { xtermScript } = await import("../dist/assets.js");
  const island = xtermScript();
  assert.ok(island.length > 100_000, "the island is the real xterm bundle, not an empty fallback");
  for (const global of ["Terminal", "FitAddon", "WebLinksAddon"]) {
    assert.ok(island.includes(global), `the island exposes window.${global}`);
  }
});

// Terminal output is untrusted: any command can print a string that becomes a clickable link. The click has
// to leave the renderer (which cannot reach the OS) and be re-checked in main before the browser opens.
test("a clicked link in the terminal leaves for the default browser through the checked main-process path", () => {
  assert.match(client, /new window\.WebLinksAddon\.WebLinksAddon\(/, "link detection is the xterm addon's job");
  assert.match(client, /kakapoApp\.openExternal\(uri\)/, "a click hands the URI to main, not to window.open");
  assert.match(client, /event\.button !== 0/, "only a primary click follows the link");

  const preload = read("src/preload.cts");
  assert.match(preload, /openExternal:.*invoke\("kakapo:open-external", \{ url \}\)/, "the bridge forwards only the url");

  const pathIpc = read("src/app-path-ipc.ts");
  assert.match(pathIpc, /ipc\.handle\("kakapo:open-external"/, "main owns the handler");
  assert.match(pathIpc, /const url = externalUrl\(request\?\.url\)/, "every URL goes through the scheme check");

  const xtermBundle = read("src/assets.ts");
  assert.match(xtermBundle, /addon-web-links\/lib\/addon-web-links\.js/, "the addon ships with the inlined xterm bundle");
});


// Panes are the app's view of tmux sessions, and those outlive the app. Reopening the panel after a restart
// therefore has to come back with the panes that are still running: two agents used to return as ONE pane,
// and opening "a new pane" then landed on the second agent — the app losing track of its own terminals.
test("reopening after a restart restores one pane per live session, by ordinal", () => {
  const main = readFileSync(new URL("../src/app-terminal-ipc.ts", import.meta.url), "utf8");
  assert.match(main, /kakapo:pty-sessions[\s\S]{0,700}tmuxSessionsForRoot\(state\.options\.root/,
    "main reports this workspace's live sessions");
  assert.match(main, /ordinals[\s\S]{0,200}sort\(\(a, b\) => a - b\)/, "lowest ordinal first, so the panes come back in order");
  assert.match(main, /Number\.isInteger\(size\?\.ordinal\)[\s\S]{0,160}nextTerminalOrdinal/,
    "a spawn may name the ordinal it re-attaches to; anything else takes the lowest free one");

  assert.match(client, /function restorePanes\(\)/, "the client restores rather than assuming one pane");
  assert.match(client, /ordinals\.slice\(0, MAX_PANES\)/, "and never exceeds the pane cap");
  assert.match(client, /ordinal: pane\.restoreOrdinal/, "each restored pane asks for its own session");
  assert.match(client, /if \(ordinals\.length < 2\) return;/,
    "one session (or none) is left to the plain open path, which already makes exactly one pane");
  // The ordinal has to reach the pane BEFORE it spawns. Assigning it afterwards (makePane(); pane.x = n) meant
  // every restored pane asked for `undefined` and got the lowest FREE ordinal instead: with sessions 1 and 3
  // alive, the restore attached to 1 and then CREATED a new session 2, orphaning 3. The next launch found
  // three sessions and opened three panes — one of them empty — and it grew by one every restart after that.
  assert.match(client, /function makePane\(cell, restoreOrdinal\)/, "makePane takes the ordinal as an argument");
  assert.ok(client.includes("restoreOrdinal: restoreOrdinal")
    && client.indexOf("restoreOrdinal: restoreOrdinal") < client.indexOf("ordinal: pane.restoreOrdinal"),
    "…and sets it on the pane before spawning, not after");
  assert.match(client, /makePane\(null, ordinal\)/, "restorePanes passes the session it is re-attaching to");
});


// One action, one re-flow. A split, a restore and an open each fitted twice — immediately, then again on the
// next frame — so the terminal laid out against the geometry it was LEAVING and then against the one it
// arrived at: two visible jolts for one action ("리사이즈가 딱 딱 두 번 끊긴다"). A live window drag went
// through the same path once per ResizeObserver callback.
test("the terminal re-flows once per frame, not twice per action", () => {
  assert.match(client, /function scheduleFitAll\(\)[\s\S]{0,160}requestAnimationFrame/,
    "fits are coalesced into one animation frame");
  assert.doesNotMatch(client, /fitAll\(\);\s*\n\s*requestAnimationFrame\(fitAll\)/,
    "no path fits immediately and again on the next frame");
  for (const path of ["ResizeObserver(function () { if (isOpen()) scheduleFitAll(); })",
    "window.addEventListener('resize', function () { if (isOpen()) scheduleFitAll(); })"]) {
    assert.ok(client.includes(path), `resize path goes through the scheduler: ${path}`);
  }
});

// The rail's "working" spinner means an agent is producing output. A resize is SIGWINCH, and a shell answers
// SIGWINCH by reprinting its prompt — output on the same channel, from a workspace doing nothing. Switching
// workspaces fires a fit as the view becomes visible, so every idle pane answered at once and every idle tile
// spun: "에이전트가 실행 중이지 않는데 스피너가 도는 경우가 있네".
test("a pane's own resize echo does not count as agent activity", () => {
  const ipc = readFileSync(new URL("../src/app-terminal-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /kakapo:pty-resize[\s\S]{0,1400}resizeEchoUntil\.set\(msg\.id[\s\S]{0,80}t\.resize\(/,
    "the quiet window is stamped before the resize that causes the echo, not after");
  const onData = ipc.match(/t\.onData\(\(data\) => \{[\s\S]*?\n {4}\}\);/)?.[0];
  assert.ok(onData, "output still flows through one place");
  assert.match(onData, /deliver\("kakapo:pty-data"[\s\S]{0,200}resizeEchoUntil\.get\(id\)/,
    "the bytes are delivered either way — only the activity signal is gated");
  assert.match(onData, /if \(!\(quiet && Date\.now\(\) < quiet\)\) state\.onAgentOutput/,
    "an echo inside the window raises no spinner; anything after it does");
  assert.match(ipc, /t\.onExit[\s\S]{0,400}resizeEchoUntil\.delete\(id\)/,
    "and the map does not outlive the pty it belongs to");
});

// Typing 가 is several keystrokes with a live composition in between, and re-flowing xterm's rows during one
// makes macOS commit the half-built syllable as ㄱ ㅏ. Becoming visible again fires the ResizeObserver, so a
// workspace you switch INTO fits at the exact moment you arrive at its already-open terminal and start
// typing — and Korean came out ㄱㅏㄴㅏㄷㅏ. The watch refresh already stands down for this; the fit did not.
test("a re-flow waits for an in-flight IME composition instead of splitting the syllable", () => {
  const scheduler = client.match(/function scheduleFitAll\(\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(scheduler, "scheduleFitAll is still the single path every fit runs through");
  assert.match(scheduler, /composingPanes\.size/, "it stands down while a syllable is being assembled");
  assert.match(scheduler, /fitDeferred = true/, "and remembers the fit it owes");
  assert.match(client, /compositionend'[\s\S]{0,160}flushDeferredFit\(\)/,
    "the syllable committing runs the fit that was held back");
  assert.match(client, /'blur'[\s\S]{0,120}flushDeferredFit\(\)/,
    "and so does losing focus mid-syllable, so a deferred fit is never dropped for good");
});

// A prompt sent to a pane is a PASTE, not typing. Codex enables bracketed paste (DECSET 2004) and reads a
// bare newline as Enter, so a raw multi-line write submitted the first line and typed the rest into a busy
// composer — "선택해서 붙여넣기가 안 된다". Wrap it when the pane's app asked for the mode, and only then:
// a plain shell without it would show the markers as literal "[200~" text.
test("text sent to a pane is wrapped as a bracketed paste when the app enabled that mode", () => {
  const write = client.match(/function writeToPane\(p, text\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(write, "writeToPane is still the single path prompts reach a pane by");
  assert.match(write, /p\.term\.modes\.bracketedPasteMode/, "the pane's own mode decides, not a guess about the agent");
  assert.match(write, /'\\x1b\[200~' \+ text \+ '\\x1b\[201~'/, "the text goes out framed as a paste");
  assert.match(write, /bracketed \? [^:]+ : text/, "an app that never asked for it still gets the bytes unwrapped");
});


// Sending a prompt opens the pane picker AND focuses a pane — and xterm cancels the keys it handles from a
// textarea below the document-level KEY_OWNERS listener, which runs in the bubble phase. So the confirming
// Enter never reached the picker: it went to the agent in that pane as a bare newline, and the prompt was
// never written. The picker has to outrank the terminal's own key handling while it is up.
test("the pane picker outranks xterm's key handling, so Enter confirms instead of hitting the agent", () => {
  const handler = client.match(/attachCustomKeyEventHandler\(function \(e\) \{[\s\S]*?\n      \/\/ Escape/)?.[0];
  assert.ok(handler, "the terminal still filters keys through a custom handler");
  assert.match(handler, /if \(sendModeText != null\) return false;/,
    "a live pick releases every key to the document handler that owns it");
  assert.ok(/attachCustomKeyEventHandler\(function \(e\) \{\s*\/\/[\s\S]{0,700}?if \(sendModeText != null\) return false;/.test(client),
    "and it releases them FIRST — a later branch would already have consumed Enter or Escape");
});

// The reflow was coalesced to one per frame; the pty resize beside it was not conditioned on anything. A drag
// crosses a character-row boundary every ~17px, so most frames measured the SAME cols/rows and sent SIGWINCH
// anyway — and a full-screen TUI (an agent's own interface) repaints itself on each one. Sixty full repaints
// a second is what a resize felt like.
test("a pty hears about a resize only when the character grid changed", () => {
  assert.match(client, /p\.sentCols === p\.term\.cols && p\.sentRows === p\.term\.rows\)\s*return/,
    "an unchanged grid returns before the resize IPC");
  assert.match(client, /p\.sentCols = p\.term\.cols[\s\S]{0,120}kakapoPty\.resize/,
    "what was sent is recorded with the send, so the next frame can compare against it");
  assert.match(client, /pane\.id = r && r\.id[\s\S]{0,220}sentCols = pane\.sentRows = 0/,
    "a fresh pty forgets what the previous one was told, so it is sized even at an unchanged size");
});

// Opening the panel does not open a terminal: main still has to list the tmux sessions that outlived the app,
// attach a pty per pane, and wait for tmux to redraw. Measured on a trivial session that is ~400ms of empty
// black rectangle, and longer with real agent panes in it — indistinguishable from a hang unless something
// says otherwise.
// Connecting is a PER-PANE state. A split can have one pane still attaching while the one beside it is
// already printing an agent's output, and a single arc in the middle of the panel described neither of them.
// It also has to LAST as long as the wait: attaching to tmux echoes a few bytes at once and the redraw of the
// session's screen lands a second or more later, so ending on the first byte took the overlay away after
// ~100ms and left the rest as an empty pane — the part actually waited through.
test("each pane owns its own connecting overlay, with a way out when nothing prints", () => {
  const setter = client.match(/function setPaneConnecting\(p, on\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(setter, "the state belongs to a pane");
  assert.match(setter, /p\.el\.classList\.toggle\('is-connecting', !!on\)/, "worn by that pane's own element");
  assert.match(setter, /setTimeout\(function \(\) \{ setPaneConnecting\(p, false\); \}, 4000\)/,
    "a session that prints nothing still has a way out");

  // What output MEANS is pinned by its own test below: the first byte ends the wait.
  assert.match(client, /noteConnectingOutput\(panes\[k\]\); panes\[k\]\.term\.write/,
    "and it is the pane that produced the byte which hears about it");

  // A pane is waiting from the moment its rectangle exists; the panel-wide overlay only covers the sliver
  // before any pane does, and steps aside as soon as one appears.
  assert.match(client, /setPaneConnecting\(pane, true\);\s*\n\s*setConnecting\(false\);/,
    "a new pane takes the wait over from the panel");
  assert.match(client, /setConnecting\(true\);\s*\n\s*restorePanes\(\)/,
    "which the panel raised before the restore started");

  // Both halves, on both surfaces, must clear xterm's own layers (z-index up to 10 in xterm.css).
  const placed = (css.match(/is-connecting(?:[^{]*)::(?:before|after) \{[^}]*\}/g) || [])
    .filter((rule) => rule.includes("position: absolute"));
  assert.equal(placed.length, 4, "an arc and a label, on the pane and on the empty panel");
  for (const rule of placed) {
    assert.ok(Number(rule.match(/z-index: (\d+)/)?.[1]) > 10, "each sits above the terminal it covers");
  }
  assert.match(css, /\.terminal-pane\.is-connecting::before \{\s*content: var\(--terminal-connecting, ""\)/,
    "the label is a translation handed to CSS, and nothing when absent");
});

test("a pty hears about a resize only when the character grid changed", () => {
  assert.match(client, /p\.sentCols === p\.term\.cols && p\.sentRows === p\.term\.rows\)\s*return/,
    "an unchanged grid returns before the resize IPC");
  assert.match(client, /p\.sentCols = p\.term\.cols[\s\S]{0,120}kakapoPty\.resize/,
    "what was sent is recorded with the send, so the next frame can compare against it");
  assert.match(client, /pane\.id = r && r\.id[\s\S]{0,220}sentCols = pane\.sentRows = 0/,
    "a fresh pty forgets what the previous one was told, so it is sized even at an unchanged size");
});


// A turn finishing in a workspace you are NOT looking at is the case you most need telling about — you cannot
// see its terminal. It was the one case that stayed silent: any focused kakapo window suppressed the
// notification, and workspaces are views inside one window, so "a window is focused" says which app you are
// in and never which workspace.
test("the bell notifies for a workspace you are not looking at", () => {
  const ipc = read("src/app-terminal-ipc.ts");
  const handler = ipc.match(/ipc\.on\("kakapo:bell"[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(handler, "the bell handler is still there");
  assert.match(handler, /state\.isOnScreen\?\.\(\) !== false/,
    "it asks whether the RINGING workspace is on screen, not merely whether a window is focused");
  assert.doesNotMatch(handler, /if \(win\?\.isFocused\(\)\) return;/,
    "the old any-window check is gone");
  // main answers with the test it already uses for everything else that means "on screen".
  assert.match(read("src/app-main.ts"), /isOnScreen: \(\) => isVisibleWorkspace\(state\)/,
    "and main answers it with isVisibleWorkspace");
});

// Hangul in a pane. xterm commits a composition by slicing its textarea with offsets it recorded while the
// composition ran, and a macOS Hangul composition runs to the end of the WORD, rewriting that value on every
// keystroke: the offsets go stale and the word arrives truncated ("해야" -> "야") or, when the agent prints
// something mid-composition, not at all. The client takes the commit instead. Two things must hold — the
// committed word goes out whole, and xterm's own queued send is stood down so no keystroke is ever doubled.
test("a Hangul composition commits whole, and exactly once", async () => {
  const src = client.match(/function takeCompositionCommit\(term, event\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(src, "the composition commit takeover is still in the client");
  const takeCommit = new Function(`${src}; return takeCompositionCommit;`)();

  const sent = [];
  const helper = { _isSendingComposition: true, _isComposing: true, _dataAlreadySent: "해" };
  const term = {
    textarea: { value: "해야" },
    _core: { _compositionHelper: helper, coreService: { triggerDataEvent: (d) => sent.push(d) } },
  };
  // xterm's own send, as it schedules it: next tick, and only if nothing cancelled it.
  setTimeout(() => {
    if (helper._isSendingComposition) sent.push(term.textarea.value.substring(helper._dataAlreadySent.length));
  }, 0);
  takeCommit(term, { data: "해야" });
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(sent, ["해야"], "the whole word went out once — not truncated, not doubled by xterm's send");
  assert.equal(term.textarea.value, "해야",
    "the textarea is left to xterm — clearing it here raced the next composition and ate fast typing");

  // An xterm whose private shape we no longer recognise keeps its own commit. That commit is wrong for
  // Hangul, but sending our own on top of one we failed to cancel would double every keystroke.
  const bare = [];
  takeCommit({ textarea: { value: "해" }, _core: {} }, { data: "해" });
  takeCommit({ _core: { _compositionHelper: {}, coreService: { triggerDataEvent: (d) => bare.push(d) } } }, { data: "해" });
  assert.deepEqual(bare, [], "no send when the send we meant to cancel could not be found");
});

// "Session connecting…" must answer to the pty, not to a lull in its output. The overlay used to clear only
// after 220ms of QUIET, a condition the most important pane never meets: re-attaching to a session whose
// agent is mid-stream produces output continuously, so the overlay sat until its 4s ceiling and the
// workspace read as slow to open when the pty had answered in about 20ms.
test("a pane stops saying 'connecting' as soon as the pty answers, even while output keeps coming", () => {
  const setSrc = client.match(/function setPaneConnecting\(p, on\)[\s\S]*?\n  \}/)?.[0];
  const noteSrc = client.match(/function noteConnectingOutput\(p\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(setSrc && noteSrc, "both halves of the per-pane connecting overlay are still there");
  const fns = new Function(`
    function paneLabel() { return '"connecting"'; }
    ${setSrc}
    ${noteSrc}
    return { setPaneConnecting, noteConnectingOutput };
  `)();

  const classes = new Set();
  const pane = { el: {
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    style: { setProperty() {}, removeProperty() {} },
  } };

  fns.setPaneConnecting(pane, true);
  assert.ok(classes.has("is-connecting"), "a pane that has just been created is waiting on its pty");

  fns.noteConnectingOutput(pane); // the attach repaint starts — and does not stop
  fns.noteConnectingOutput(pane);
  fns.noteConnectingOutput(pane);
  assert.ok(!classes.has("is-connecting"),
    "the overlay is gone on the first byte; a busy agent must not hold it up to the ceiling");
  assert.ok(!pane.settleTimer && !pane.connectTimer, "no timer is left running to uncover the pane later");
});

// A pane that is not on screen has no grid to measure, but the fit addon answers anyway — and its answer,
// made out of zero, goes to the pty as a real resize. tmux redraws its window to that shape and the shape
// outlives the pane coming back: the split stays broken until the session is restarted. It happens whenever
// the panel is measured while it is not being shown — switching away from a workspace, or a zoom step
// arriving at a hidden view.
test("a pane with no size on screen is not measured, and a degenerate grid is never sent to the pty", () => {
  const fit = client.match(/function fitPane\(p\)[\s\S]*?\n  \}/)[0];
  assert.match(fit, /clientWidth|clientHeight/, "it asks whether the pane has a size before measuring");
  assert.ok(
    fit.indexOf("clientWidth") < fit.indexOf("p.fit.fit()"),
    "and asks BEFORE fitting, not after the bad number already exists",
  );
  assert.match(fit, /cols > 1 && p\.term\.rows > 1/, "a 1x1 grid is not something to tell a shell about");
  assert.ok(
    fit.indexOf("rows > 1") < fit.indexOf("kakapoPty.resize"),
    "and that check comes before the resize goes out",
  );
});

// What a pane row SAYS it is running. The identity used to come only from an in-memory pty -> tmux session
// map; when that drifted, the pty underneath answered "tmux" or the login shell and the rail called a pane
// with a working agent in it a shell. tmux always knows, so it is the backstop.
test("a pane whose session is not known falls back to what tmux says is running there", () => {
  const main = read("src/app-main.ts");
  const body = main.match(/function panesForWorkspace\([\s\S]*?\n\}/)[0];
  assert.match(body, /command === "tmux"/, '"tmux" — what a tmux-backed pty says about itself — is not an answer');
  assert.match(body, /spare\.shift\(\)/, "an unclaimed session for this workspace is handed to the pane");
  assert.ok(
    body.indexOf("spare.shift()") < body.indexOf("agent: agentForCommand(command)"),
    "and the fallback happens before the row decides which agent it is",
  );
  // …and a session handed out that way must not ALSO appear as a detached row of its own.
  assert.match(body, /!spare\.includes\(session\)/, "a session already used as a fallback does not get a second row");
});

// Opening a terminal produces output before anything has been asked to do anything: the shell prints its
// prompt, and a tmux-backed pane repaints the whole session it just attached to. Both were read as an agent
// starting work, so every freshly opened terminal claimed to be working for a second and a half.
test("the first moments of a pane's life do not count as an agent working", () => {
  const ipc = read("src/app-terminal-ipc.ts");
  assert.match(ipc, /SPAWN_ECHO_MS/, "there is a quiet window at spawn");
  const spawn = ipc.match(/state\.terms\.set\(id, t\);[\s\S]{0,200}/)[0];
  assert.match(spawn, /resizeEchoUntil\.set\(id, Date\.now\(\) \+ SPAWN_ECHO_MS\)/,
    "and it is armed the moment the pty exists, not after the first chunk has already counted");
});
