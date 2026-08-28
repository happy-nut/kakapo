// Integrated terminal (Electron only): xterm panes wired to node-pty sessions in the main process.
// Toggle with Ctrl+` / Opt+F12 / the footer ⌗ button; Cmd/Ctrl+D splits the active pane (side by side,
// no tabs); drag the top edge to resize. window.__kakapoTerminal pipes the merged prompt into the
// active pane. Cmd combos are released back to the app so shortcuts like Cmd+1 don't get stuck typing.
// Assigned by setupTerminal; read by the KEY_OWNERS table in 05-keymap.js, which loads first.
var handleTerminalSendModeKey;

// A file path an agent prints should be as clickable as the URL beside it. Same rule and same action as a
// path inside an agent's prose: linkifyPathCode's charset test plus PATH_CODE_EXT (23-annotations.js) decide
// what looks like a file, and openPathReference (07-comments.js) opens it at its `:42`, resolving by exact or
// suffix match — so an absolute path inside the workspace works too. A path this workspace does not have
// stays inert and says so: terminal output is untrusted, and app-path-ipc.ts deliberately refuses to hand it
// to the OS (see externalUrl there, which rejects file:// for exactly this reason).
function terminalPathToken(text) {
  var bare = text.replace(/:\d+$/, '');
  return text.length < 200 && /^[A-Za-z0-9_@.\-/]+$/.test(bare) && PATH_CODE_EXT.test(bare);
}
// A wrapped row is a continuation, not a line of its own, and half a path resolves to nothing. Rebuild the
// whole logical line the hovered row belongs to, the way the web-links addon does before matching URLs.
function terminalLogicalLine(term, row) {
  var buffer = term.buffer.active;
  var start = row, end = row, line;
  while (start > 0 && (line = buffer.getLine(start)) && line.isWrapped) start--;
  while ((line = buffer.getLine(end + 1)) && line.isWrapped && end - start < 32) end++;
  var text = '';
  for (var y = start; y <= end; y++) {
    line = buffer.getLine(y);
    if (line) text += line.translateToString(true);
  }
  return { start: start, text: text };
}
// String index -> buffer cell. A row's string is not its columns — a CJK glyph is one character across two of
// them, and this terminal carries Korean agent output — so an underline drawn at the string offset lands in
// the wrong place. Walk cells instead, same as the addon's own _mapStrIdx.
function terminalCellForIndex(term, startRow, startCol, remaining) {
  var buffer = term.buffer.active;
  var cell = buffer.getNullCell();
  var last = null;
  for (var y = startRow, x = startCol; ; y++, x = 0) {
    var line = buffer.getLine(y);
    // Locating the END of a run means finding the cell one PAST its last character, and that cell does not
    // exist when the run reaches the last row of the buffer. Answer with the column just past the last cell
    // we did see — dropping the link is how a path printed as the terminal's final line, which is where an
    // agent's paths land, stayed stubbornly unclickable while the same path mid-scrollback worked.
    if (!line) return last && { x: last.x + 1, y: last.y };
    for (; x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth()) remaining -= cell.getChars().length || 1;
      if (remaining < 0) return { x: x, y: y };
      last = { x: x, y: y };
    }
  }
}
function terminalPathLinkProvider(term) {
  return {
    provideLinks: function (row, callback) {
      var logical = terminalLogicalLine(term, row - 1); // provideLinks counts rows from 1, the buffer from 0
      var links = [];
      logical.text.split(/(\s+)/).reduce(function (index, token) {
        if (token.trim() && terminalPathToken(token)) {
          var from = terminalCellForIndex(term, logical.start, 0, index);
          var to = from && terminalCellForIndex(term, from.y, from.x, token.length);
          if (from && to) {
            links.push({
              range: { start: { x: from.x + 1, y: from.y + 1 }, end: { x: to.x, y: to.y + 1 } },
              text: token,
              activate: function (event, path) {
                if (event && event.button !== 0) return; // a middle/right click keeps its native meaning
                openPathReference(path);
              },
            });
          }
        }
        return index + token.length;
      }, 0);
      callback(links.length ? links : undefined);
    },
  };
}

(function setupTerminal() {
  if (!window.kakapoPty) return; // xterm (window.Terminal) is loaded lazily on first open
  var panel = document.getElementById('terminal-panel');
  var host = document.getElementById('terminal-host');
  var toggleBtn = document.getElementById('terminal-toggle');
  var resizer = panel ? panel.querySelector('.terminal-resizer') : null;
  if (!panel || !host) return;
  if (toggleBtn) toggleBtn.classList.remove('hidden'); // reveal the footer toggle in Electron

  // xterm ships as an inert island (id=xterm-code) so ~490KB isn't parsed at startup. Inject it on the
  // first open; returns false if unavailable (e.g. the island is absent), so callers can bail gracefully.
  function ensureXterm() {
    if (typeof window.Terminal === 'function') return true;
    var code = document.getElementById('xterm-code');
    if (!code) return false;
    try {
      var s = document.createElement('script');
      s.textContent = code.textContent;
      document.head.appendChild(s);
      code.remove(); // free the inert text once compiled
    } catch (e) { return false; }
    return typeof window.Terminal === 'function';
  }

  var panes = [];   // { id, term, fit, el }
  var active = null;
  // Timestamp of the last keystroke into any pane. The watch refresh reads it (see applyDiffUpdate) so a
  // diff rebuild — a long synchronous DOM swap on this same main thread — never lands mid-keystroke.
  var lastInputAt = 0;
  // How long a pane has to have been silent before kakapo will press Enter in it (handOff). Long enough that
  // an agent between tool calls does not read as idle, short enough that a reviewer who just stopped typing
  // is not made to wait. An agent mid-turn re-arms it with its next byte, ~16ms later.
  var HANDOFF_QUIET_MS = 1500;
  // Panes with an IME composition in flight (Hangul/Kana/Pinyin mid-syllable). Interrupting one commits the
  // partial input, so a refresh must wait however long the composition takes — no timeout can bound it.
  var composingPanes = new Set();
  // ---- why a syllable broke, recorded while it was breaking -------------------------------------------
  // The jamo failure is a RACE, so it cannot be reproduced on demand and cannot be read off a stack trace
  // after the fact: by the time ㄱ ㅏ is on screen, whatever moved the terminal under the composition has
  // already finished. So each composition carries a tally of what happened during it, and the commit itself
  // is checked — a committed run containing Hangul JAMO (U+1100 block, or the compatibility block a partial
  // commit lands in) is a syllable that was cut in half, and nothing else produces one.
  // Read it with `__kakapoTerminal.imeLog()` in the review window's devtools; the last split also warns.
  var JAMO_CODEPOINTS = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;
  var imeLog = [];        // newest last, capped — a session's worth of compositions is not worth keeping
  var imeNow = null;      // the composition in flight, or null
  // Double-Esc window for closing the panel out of a fullscreen TUI (see the key handler below).
  var MAX_PANES = 4;
  var heightKey = 'kakapo-terminal-height';
  var openKey = 'kakapo-terminal-open:' + location.pathname;

  function applyHeight(px) {
    var h = Math.max(120, Math.min(px, window.innerHeight - 120));
    document.documentElement.style.setProperty('--terminal-height', h + 'px');
  }
  var savedH = parseInt(localStorage.getItem(heightKey) || '', 10);
  if (savedH) applyHeight(savedH);

  // A pty is told about a resize only when the CHARACTER GRID actually changed. Dragging crosses a row
  // boundary every ~17px, but every frame in between measured the same cols/rows and sent a resize anyway —
  // SIGWINCH at 60Hz, and a full-screen TUI (an agent's own interface is one) repaints itself on every single
  // one. That storm is the judder; the xterm reflow beside it was already coalesced to one per frame, so the
  // expensive half was never the one being counted. Sent per pane, since a split moves only some of them.
  function fitPane(p) {
    if (!p) return;
    // A pane with no size on screen has no grid to measure, and the fit addon answers anyway — with whatever
    // its arithmetic makes of zero, which then goes to the pty as a real resize. tmux redraws its window to
    // that shape, and the shape survives the pane coming back: the layout stays broken until the session is
    // restarted. It happens whenever the panel is measured while it is not being shown — a workspace being
    // switched away from, a zoom step arriving at a hidden view — so the measurement is simply skipped there
    // and taken again when the pane has a size.
    var host = p.host || (p.term && p.term.element);
    if (host && (!host.clientWidth || !host.clientHeight)) return;
    try {
      p.fit.fit();
      if (!(p.term.cols > 1 && p.term.rows > 1)) return; // a degenerate grid is not worth telling anyone about
      if (p.id == null) return;
      if (p.sentCols === p.term.cols && p.sentRows === p.term.rows) return;
      p.sentCols = p.term.cols;
      p.sentRows = p.term.rows;
      window.kakapoPty.resize({ id: p.id, cols: p.sentCols, rows: p.sentRows });
    } catch (e) {}
  }
  function fitAll() { panes.forEach(fitPane); }
  // One fit per frame, after the browser has laid out whatever just changed. A split, a restore and an open
  // each used to fit twice — once immediately, once on the next frame — so the terminal re-flowed against the
  // geometry it was LEAVING and then against the one it arrived at: two visible jolts for one action, which
  // is the "it resizes in two clacks" this coalescing removes. A live window drag lands here too, and now
  // costs one reflow (and one pty resize) per frame instead of one per ResizeObserver callback.
  var fitRaf = 0, fitDeferred = false;
  function scheduleFitAll() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(function () {
      fitRaf = 0;
      // Never re-flow while a syllable is still being assembled. A fit rebuilds xterm's rows underneath the
      // IME, and macOS answers that by committing the half-built 가 as ㄱ ㅏ — the same failure the watch
      // refresh already stands down for (isComposing / applyDiffUpdate). The fit did not, and a workspace you
      // switch INTO fires its ResizeObserver as it becomes visible again: exactly when you arrive at an
      // already-open terminal and start typing, which is how Korean came out as ㄱㅏㄴㅏㄷㅏ there. Held until
      // the syllable commits (compositionend/blur below), never dropped.
      if (composingPanes.size) { fitDeferred = true; if (imeNow) imeNow.fitsHeld++; return; }
      // The shell animates the workspace rail by re-bounding this whole view every frame for ~180ms, so the
      // ResizeObserver below fires a dozen times for ONE width change: a dozen xterm re-flows and a dozen pty
      // resizes, each one re-wrapping the pane's text at a width it will not keep. That is the judder. The
      // diff column already sits the animation out behind body.rail-pinning (setRailContentPin); the terminal
      // joins it and takes the settled width once, when the pin lifts.
      if (document.body.classList.contains('rail-pinning')) { fitDeferred = true; return; }
      fitAll();
    });
  }
  // The composition finished, the pane lost focus mid-syllable, or the rail animation settled: run the fit
  // that was waiting on it.
  function flushDeferredFit() {
    if (!fitDeferred || composingPanes.size) return;
    fitDeferred = false;
    scheduleFitAll();
  }
  // Reliably move keyboard focus into a pane's xterm. Opening the panel from a menu accelerator races with
  // Electron restoring focus to <body>, so a single focus() call can lose it — retry until the pane's helper
  // textarea is actually the active element (or we run out of tries), like the dock's focusDockField.
  function focusPane(p) {
    if (!p || !p.term) return;
    var tries = 0;
    var tryF = function () {
      if (!p.term) return true;
      var ae = document.activeElement;
      if (ae && p.el.contains(ae)) return true; // focus already landed inside this pane
      try { p.term.focus(); } catch (e) {}
      var now = document.activeElement;
      return !!(now && p.el.contains(now));
    };
    if (!tryF()) { var iv = setInterval(function () { if (tryF() || ++tries > 12) clearInterval(iv); }, 25); }
  }

  function setActive(p) {
    active = p;
    if (p && p.labelEl) p.labelEl.classList.remove('has-bell'); // viewing the pane clears its bell badge
    panes.forEach(function (q) {
      q.el.classList.toggle('is-active', q === p);
      // 2+ panes: dim every pane but the active one (no border, just a clean focus cue). A lone pane stays full.
      q.el.classList.toggle('is-inactive', panes.length > 1 && q !== p);
    });
    if (p) requestAnimationFrame(function () {
      try {
        if (p.labelEl && p.labelEl.getAttribute('contenteditable') === 'true') return;
        p.term.focus();
      } catch (e) {}
    });
  }

  function copyToClipboard(text) {
    if (!text) return;
    try { if (window.kakapoClipboard && window.kakapoClipboard.write) { window.kakapoClipboard.write(text); return; } } catch (e) {}
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text); } catch (e) {}
  }
  // Pull the terminal colors from the app's own theme variables so the panel matches the editor
  // (a flat #161616 read as "too black" next to the tinted --panel chrome) and follows light/dark + darcula.
  // xterm's default ANSI palette is built for a dark background: its white and bright-white are all but
  // invisible on a light one, and a TUI prints in exactly those. So a light theme brings its own palette;
  // dark keeps xterm's, which already suits it.
  var LIGHT_ANSI = {
    black: '#24292e', red: '#cd3131', green: '#00825d', yellow: '#8a6a00',
    blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#4f5b66',
    brightBlack: '#6b737c', brightRed: '#cd3131', brightGreen: '#00a06a', brightYellow: '#a67a00',
    brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#2f3640',
  };
  function themeColors() {
    var cs = getComputedStyle(document.documentElement);
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    var bg = (cs.getPropertyValue('--panel') || '').trim() || (light ? '#ffffff' : '#1e2229');
    var fg = (cs.getPropertyValue('--text') || '').trim() || (light ? '#1f2328' : '#a9b7c6');
    var colors = { background: bg, foreground: fg, cursor: fg, selectionBackground: light ? '#b9d3f7' : '#214283' };
    if (light) for (var name in LIGHT_ANSI) colors[name] = LIGHT_ANSI[name];
    return colors;
  }
  // The panes read those colors once, when they are constructed, so a theme switch has to be pushed into the
  // live xterm instances — otherwise the app repaints around a terminal still wearing the old palette.
  //
  // The theme object does not reach everything xterm draws: the in-progress IME overlay is a DOM element that
  // xterm's own stylesheet paints #000 on #FFF, unconditionally (.composition-view — the same rule carries a
  // TODO admitting its position is wrong). On a themed terminal that is a black slab behind the half-built
  // word, and because the overlay is a whole CELL tall while the glyph is only font-size tall, it shows as a
  // dark band above and below the letters — which reads as the word being lifted off its own line, the whole
  // time you are composing Hangul. Publish the two colours the overlay needs as custom properties and let CSS
  // pick them up (viewer.css, .composition-view).
  function applyTerminalTheme() {
    var colors = themeColors();
    panes.forEach(function (p) { try { p.term.options.theme = colors; } catch (e) {} });
    try {
      panel.style.setProperty('--terminal-bg', colors.background);
      panel.style.setProperty('--terminal-fg', colors.foreground);
    } catch (e) {}
  }
  // Underline URLs in the scrollback and hand a clicked one to the default browser. The click goes through
  // main (kakapo:open-external), which re-checks the scheme — a command can print any string it likes, so
  // "the terminal said so" is not grounds to hand a URL to the OS.
  function loadWebLinks(term) {
    if (!window.WebLinksAddon || typeof window.WebLinksAddon.WebLinksAddon !== 'function') return;
    try {
      term.loadAddon(new window.WebLinksAddon.WebLinksAddon(function (event, uri) {
        if (event && event.button !== 0) return; // let a middle/right click keep its native meaning
        if (window.kakapoApp && typeof window.kakapoApp.openExternal === 'function') window.kakapoApp.openExternal(uri);
      }));
    } catch (e) {}
  }
  function loadPathLinks(term) {
    if (typeof term.registerLinkProvider !== 'function') return;
    try { term.registerLinkProvider(terminalPathLinkProvider(term)); } catch (e) {}
  }
  // Every pane lives in a CELL: the panel is a row of cells, and a cell is a column of panes. One level of
  // nesting is what makes "split the pane I am in" expressible — a single flex axis for the whole panel meant
  // a stacked split re-oriented every pane at once (the old is-column class).
  function makeCell() {
    var cell = document.createElement('div');
    cell.className = 'terminal-cell';
    host.appendChild(cell);
    return cell;
  }
  // The composing character must look like the character it is about to become, and brightness is the part
  // that was wrong. An agent's composer draws its prompt text DIM (SGR 2), which xterm renders as a 50% blend
  // toward the background — measured off the running app, rgb(120,125,133) where the full foreground is
  // rgb(216,224,235) on a rgb(24,27,33) background, which is 0.5*fg + 0.5*bg to the pixel. The overlay wore
  // the FULL foreground, so the one character being typed sat at twice the brightness of the line it was
  // joining and read as floating above it. Nothing about its position was ever wrong: measured, its glyph
  // centre is within half a CSS pixel of the committed glyphs beside it.
  //
  // So ask the cell. The line's own text is the honest sample — the cell under the cursor is usually still
  // blank — so read the one before it and fall back to the cursor's own.
  function matchCompositionDim(term) {
    var view = term && term.element && term.element.querySelector('.composition-view');
    if (!view) return;
    var dim = false;
    try {
      var buf = term.buffer.active;
      var line = buf.getLine(buf.baseY + buf.cursorY);
      var cell = line && (buf.cursorX > 0 ? line.getCell(buf.cursorX - 1) : null);
      if (!cell || !cell.getChars()) cell = line && line.getCell(buf.cursorX);
      dim = !!(cell && typeof cell.isDim === 'function' && cell.isDim());
    } catch (e) { /* a buffer shape we don't recognise just keeps the full foreground */ }
    view.classList.toggle('is-dim', dim);
  }
  // The half-built syllable floats one physical pixel above the line it will land on — and the TUI's own
  // block caret behind the overlay reads as sagging below the text. Two vertical models disagree: the webgl
  // renderer draws committed ink from a canvas 'ideographic' baseline placed charHeight below char.top,
  // while the overlay is a DOM line box whose baseline comes from the primary font's strut. How far they
  // disagree depends on which fallback font the composing script resolves to (measured in the running app:
  // the whole Hangul glyph 0.5 css px / 1 retina px high at 13px/1.45). Both positions are measurable from
  // the same engines that place the real pixels, so measure per composition and cancel the difference with
  // a transform — the one style xterm's own reposition loop never writes, so nothing fights it.
  // The DOM renderer keeps NO nudge: it draws committed rows with the same line-height model the overlay
  // uses, so there the overlay is already right and the transform is cleared.
  function alignCompositionOverlay(term) {
    try {
      var view = term.element && term.element.querySelector('.composition-view');
      if (!view) return;
      if (!term.__kakapoWebgl) { view.style.transform = ''; return; }
      var dims = term._core && term._core._renderService && term._core._renderService.dimensions;
      if (!dims || !dims.device || !dims.device.char) return;
      var ctx = document.createElement('canvas').getContext('2d');
      if (!ctx || typeof ctx.measureText !== 'function') return;
      ctx.font = term.options.fontSize + 'px ' + term.options.fontFamily;
      var sample = (view.textContent || '').charAt(0) || '가'; // measure the script actually being composed
      ctx.textBaseline = 'ideographic';
      var ideo = ctx.measureText(sample);
      ctx.textBaseline = 'alphabetic';
      var alpha = ctx.measureText(sample);
      // An engine without ink metrics (old Chromium, jsdom) keeps the old behaviour rather than guessing.
      if (!ideo || !alpha || typeof ideo.actualBoundingBoxAscent !== 'number') return;
      view.style.transform = ''; // measure the un-nudged line box
      var probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0';
      view.appendChild(probe);
      var overlayBaseline = probe.offsetTop; // a zero-height inline-block sits ON the line box's baseline
      view.removeChild(probe);
      var dpr = window.devicePixelRatio || 1;
      var committedInkTop = (dims.device.char.top + dims.device.char.height) / dpr - ideo.actualBoundingBoxAscent;
      var overlayInkTop = overlayBaseline - alpha.actualBoundingBoxAscent;
      var dy = committedInkTop - overlayInkTop;
      if (Math.abs(dy) > 0.05) view.style.transform = 'translateY(' + dy.toFixed(2) + 'px)';
    } catch (e) { /* alignment is cosmetic — never let it break composition itself */ }
  }
  // Whether THIS terminal has a composition in flight, read where xterm keeps it. composingPanes is close
  // but not identical: it flips on OUR listeners, which run after xterm's — the key handler below needs the
  // answer xterm's own state machine is acting on. Private reach, same rules as everything else here: a
  // future xterm that changes the shape makes this answer false, and the old behaviour is back.
  function paneIsComposing(term) {
    try {
      var helper = term && term._core && term._core._compositionHelper;
      return !!(helper && helper._isComposing);
    } catch (e) { return false; }
  }
  // Reaching into xterm's private composition helper is deliberate: the send we need to stand down has no
  // public switch. If a future xterm changes that shape, do nothing — xterm keeps its own commit, which is
  // wrong for Hangul but is never a doubled keystroke, and doubling is the worse failure to ship.
  function takeCompositionCommit(term, event) {
    var core = term && term._core;
    var helper = core && core._compositionHelper;
    var service = core && core.coreService;
    if (!helper || !service || typeof service.triggerDataEvent !== 'function') return;
    if (!('_isSendingComposition' in helper)) return;
    helper._isSendingComposition = false; // the send xterm queued for the next tick finds this false and stands down
    helper._isComposing = false;
    helper._dataAlreadySent = '';
    if (event && event.data) service.triggerDataEvent(event.data, true);
    // The textarea is xterm's to manage (it clears on blur, Enter and Ctrl+C). Clearing it here as well
    // bought nothing measurable and raced the next composition: type quickly enough and the deferred clear
    // landed after the following composition had already begun, wiping a value only it still held.
  }
  // The caret is drawn in the very cell the half-built syllable is being assembled in, so it shows UNDER the
  // composition overlay and the unfinished word reads as floating a pixel above its own line — visible for
  // every Hangul word, which composes to the end of the WORD rather than the syllable, so it is on screen
  // most of the time you are typing. Nothing is being typed AT the caret while a composition runs (the
  // overlay is what the reader is looking at), so take it away for the duration and put it back on commit.
  //
  // isCursorHidden is the same flag DECTCEM (\x1b[?25l) sets, which belongs to the program on the other end
  // of the pty — so remember what it was and restore THAT, never a bare `false`: a TUI that hid its own caret
  // must not get one back because a syllable ended. Public field on the core service, unlike the composition
  // reaches below.
  function setCursorHiddenForComposition(term, hidden) {
    var service = term && term._core && term._core.coreService;
    if (!service || typeof service.isCursorHidden !== 'boolean') return;
    if (hidden) {
      if (term.__kakapoCursorWas === undefined) term.__kakapoCursorWas = service.isCursorHidden;
      service.isCursorHidden = true;
    } else {
      if (term.__kakapoCursorWas === undefined) return;
      service.isCursorHidden = term.__kakapoCursorWas;
      term.__kakapoCursorWas = undefined;
    }
    try { var y = term.buffer.active.cursorY; term.refresh(y, y); } catch (e) {}
  }
  // THE ANCHOR MUST NOT MOVE. While a composition is live, xterm re-points its helper textarea at the buffer
  // cursor on a 0ms loop (CompositionHelper.updateCompositionElements: it writes textarea.style.left/top from
  // buffer.x/buffer.y and re-schedules itself until the composition ends). The textarea is what the macOS
  // input context is attached to, so an agent pouring output — every line moving the cursor — drags the
  // anchor out from under a half-built syllable many times a second, and macOS answers by committing it: 가
  // arrives as ㄱ ㅏ. Switching workspace does the same thing once, through changed cell dimensions.
  //
  // The earlier attempt at this held the OUTPUT instead and had to be reverted (see the onData comment): a
  // Hangul composition runs to the end of the word, so holding until compositionend hid the reviewer's own
  // echo until they pressed space. Nothing is held here. The output renders exactly as it always did; only
  // the anchor stays where the composition started, which is where the reader is looking anyway.
  //
  // Reaching into the private helper is deliberate and already the house style here (takeCompositionCommit).
  // If a future xterm changes the shape, this does nothing and the old behaviour is back — never a throw.
  // Close out the composition in flight and, if what it committed is a broken syllable, say so at the moment
  // it broke — with everything that was happening to the terminal while it did. `blur` passes no event: the
  // composition was abandoned rather than committed, which is its own way of splitting one.
  function noteCompositionEnd(event) {
    if (!imeNow) return;
    var entry = imeNow;
    imeNow = null;
    entry.data = event && typeof event.data === 'string' ? event.data : '';
    entry.abandoned = !event;
    entry.ms = Date.now() - entry.at;
    entry.split = JAMO_CODEPOINTS.test(entry.data);
    imeLog.push(entry);
    if (imeLog.length > 30) imeLog.shift();
    // Loud on purpose, and only here: this line is the whole point of the tally. It fires when a syllable was
    // actually cut, never on ordinary typing, so a quiet console means the terminal is behaving.
    if (entry.split) {
      // The one suspect the tally cannot see from here: a renderer stall overlapping the composition. The
      // stall tracker keeps the worst long task since it last reported (kakapoActivity, 09-views-update.js);
      // if a composition broke while one ran, its duration and frame land in the record.
      try {
        var worst = kakapoActivity && kakapoActivity.longest;
        if (worst) { entry.longTaskMs = worst.duration; entry.longTaskIn = (worst.containerType || '') + (worst.containerId ? '#' + worst.containerId : ''); }
      } catch (e) {}
      try {
        console.warn('[kakapo:ime] a syllable was committed as jamo — ' + JSON.stringify(entry)
          + ' (writes = output that arrived mid-composition, anchorPins = anchor drags stopped,'
          + ' fitsHeld = re-flows deferred)');
      } catch (e) {}
      // The in-memory log dies with the window, and the packaged app has no devtools to read it in anyway —
      // so a split is also appended to ime-splits.jsonl beside the app's settings, where it can be read
      // AFTER the session that hit it.
      try { if (window.kakapoPty && typeof window.kakapoPty.imeSplit === 'function') window.kakapoPty.imeSplit(entry); } catch (e) {}
    }
  }
  function pinCompositionAnchor(term) {
    var core = term && term._core;
    var helper = core && core._compositionHelper;
    var textarea = term && term.textarea;
    if (!helper || !textarea || typeof helper.updateCompositionElements !== 'function') return;
    // Every composition pins its OWN anchor. The pin used to be dropped only by a reposition tick that
    // happened to run while not composing — and between two back-to-back compositions no such tick is
    // guaranteed (measured: the next composition then inherited the previous one's cell, and macOS drew
    // its IME UI against a stale rect). The start of a composition clears it, unconditionally.
    helper.__kakapoPinned = null;
    if (helper.__kakapoAnchorPinned) return;
    helper.__kakapoAnchorPinned = true;
    var reposition = helper.updateCompositionElements.bind(helper);
    helper.updateCompositionElements = function (dontRecurse) {
      reposition(dontRecurse);
      if (!helper._isComposing) { helper.__kakapoPinned = null; return; }
      // The first pass of a composition places the anchor; every pass after it is the drag we are here to stop.
      if (!helper.__kakapoPinned) { helper.__kakapoPinned = { left: textarea.style.left, top: textarea.style.top }; return; }
      if (textarea.style.left !== helper.__kakapoPinned.left || textarea.style.top !== helper.__kakapoPinned.top) {
        if (imeNow) imeNow.anchorPins++;
        textarea.style.left = helper.__kakapoPinned.left;
        textarea.style.top = helper.__kakapoPinned.top;
      }
    };
  }
  // Terminal typography is its own preference, not the app-wide zoom: a pane full of an agent's prose wants a
  // bigger glyph and much more room between lines than a diff does. Hangul fills its box top to bottom, so at
  // xterm's default line height of 1.0 the lines touch and long output reads as a wall of text.
  var TERM_FONT_KEY = 'kakapo-terminal-font';
  var TERM_LINE_KEY = 'kakapo-terminal-line';
  var TERM_FONT_SIZES = [11, 12, 13, 14, 15, 16];
  var TERM_LINE_HEIGHTS = [1, 1.15, 1.3, 1.45, 1.6];
  function terminalFontSize() {
    var stored = Number(persistRead(TERM_FONT_KEY));
    return TERM_FONT_SIZES.indexOf(stored) >= 0 ? stored : 13;
  }
  function terminalLineHeight() {
    var stored = Number(persistRead(TERM_LINE_KEY));
    return TERM_LINE_HEIGHTS.indexOf(stored) >= 0 ? stored : 1.45;
  }
  // Applied to every open pane at once: the setting is about the terminal, not about the pane that happened to
  // be focused when it changed. The re-fit is what turns the new metrics into a new row/column count, which is
  // then sent on to tmux like any other resize.
  function applyTerminalTypography() {
    panes.forEach(function (pane) {
      try {
        pane.term.options.fontSize = terminalFontSize();
        pane.term.options.lineHeight = terminalLineHeight();
      } catch (e) {}
    });
    scheduleFitAll();
  }

  // Draw on the GPU when the machine will have it. xterm's default renderer builds a DOM row per line and
  // measures it, and every measurement after a DOM write forces a layout of the whole page — behind a big
  // review that is milliseconds each, and opening the panel spent 2.5 of its 2.6 seconds in exactly that.
  // Best effort in every direction: no addon, no WebGL context, or a context lost later (a GPU reset, a
  // display change) and the terminal falls back to the renderer it has always used.
  //
  // Releasing these while a workspace is off screen was tried and taken out. It cost the panes their content:
  // xterm's buffer survives, but re-attaching an addon only sets the renderer — nothing marks the screen dirty
  // — and the pane you came back to was blank but for whatever cell happened to repaint, which is worse than
  // any amount of memory. flushHiddenOutput covers only panes that RECEIVED output while away, so the quiet
  // ones came back empty. It bought nothing either: the GPU process held ~1 GB with the release in place, so
  // the pane canvases were never where that memory was. Anything attempted here again needs a full repaint on
  // re-attach AND a measurement showing the GPU process actually shrinks.
  function loadWebglRenderer(term) {
    var Addon = window.WebglAddon && window.WebglAddon.WebglAddon;
    if (!Addon) return;
    try {
      var addon = new Addon();
      addon.onContextLoss(function () {
        try { addon.dispose(); } catch (e) {}
        if (term.__kakapoWebgl === addon) term.__kakapoWebgl = null;
        // Disposal only swaps the renderer; nothing marks the screen dirty, so without this the pane keeps
        // showing the dead context's last (or garbage) frame until some output happens to touch every row.
        try { term.refresh(0, term.rows - 1); } catch (e) {}
      });
      term.loadAddon(addon);
      term.__kakapoWebgl = addon; // so a workspace switch can hand the pane a live context (flushHiddenOutput)
    } catch (e) { /* the DOM renderer is still a terminal */ }
  }

  function makePane(cell, restoreOrdinal) {
    if (!ensureXterm()) return null; // xterm unavailable — leave the panel empty rather than throw
    var el = document.createElement('div');
    el.className = 'terminal-pane';
    var labelEl = document.createElement('div');
    labelEl.className = 'terminal-pane-label';
    var paneHost = document.createElement('div');
    paneHost.className = 'terminal-pane-host';
    el.appendChild(labelEl);
    el.appendChild(paneHost);
    (cell || makeCell()).appendChild(el);
    var term = new window.Terminal({
      fontSize: terminalFontSize(),
      lineHeight: terminalLineHeight(),
      // ui-monospace first, not Monaco. Monaco carries no Hangul, so Korean fell to a system fallback while
      // xterm kept sizing the cell grid from Monaco's metrics — every Korean glyph then sat slightly wrong in
      // a box built for something else, and a double-width character shows that twice over.
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      theme: themeColors(),
      cursorBlink: true,
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    loadWebglRenderer(term);
    loadWebLinks(term);
    loadPathLinks(term); // after the URL provider, so a URL is still a URL and not its trailing filename
    term.open(paneHost);
    // restoreOrdinal has to be on the pane BEFORE the spawn below: this used to be assigned by restorePanes()
    // after makePane() returned, so every restored pane spawned with `ordinal: undefined` and main handed out
    // the lowest FREE one instead. With sessions 1 and 3 alive (any pane but the last closed), the restore
    // attached to 1, then created a brand-new session 2 — leaving 3 orphaned and running. The next launch saw
    // three sessions and restored three panes, one of them empty, and the count grew again every time.
    var pane = { id: null, term: term, fit: fit, el: el, host: paneHost, labelEl: labelEl,
      restoreOrdinal: restoreOrdinal, name: 'Terminal ' + (panes.length + 1) };
    labelEl.textContent = pane.name;
    // From the moment the rectangle exists it is a rectangle that is waiting. The panel-wide overlay covered
    // the sliver before any pane existed (main still listing the surviving sessions); now that there is a
    // pane to draw on, it hands over rather than sitting behind this one.
    setPaneConnecting(pane, true);
    setConnecting(false);
    // Cmd combos are app shortcuts (Cmd+1/0 tab switch, Cmd+B go-to-def, …). Release the terminal and let
    // them bubble to the document handler instead of typing into the shell (fixes "Cmd+1 stuck in term").
    // Exception: keep focus for clipboard/selection combos (Cmd+C/V/X/A) so the terminal's own copy &
    // paste keep working — blurring on Cmd+V drops the textarea focus the paste event needs.
    term.attachCustomKeyEventHandler(function (e) {
      // A pane pick is up: every key belongs to the picker, which is what KEY_OWNERS says — but that table is
      // read by a keydown listener on `document`, in the BUBBLE phase, and xterm cancels the keys it handles
      // (preventDefault + stopPropagation) from the textarea below it. Enter never got there. So "send this
      // prompt to a pane" opened the picker, focused a pane, and then the confirming Enter went to the agent
      // running in it as a bare newline instead: the pick never resolved and the prompt was never written.
      // Returning false makes xterm ignore the key so it reaches the picker.
      if (sendModeText != null) return false;
      // A keydown that reaches xterm with a REAL keyCode while a composition is live force-commits the
      // half-built syllable: CompositionHelper.keydown finalizes on any keyCode outside {229, CapsLock,
      // Shift, Ctrl, Alt} — a bare Cmd press is already enough. And after a workspace switch, macOS +
      // Chromium can desync far enough that EVERY key arrives that way while the IME still composes: each
      // keystroke then killed the composition the previous one started, and a word came out one jamo at a
      // time, in bursts (this is the ime-splits.jsonl signature: composition lifetimes of one inter-key gap,
      // splits with writes:0 and anchorPins:0). While a composition is live the IME owns the keys — keep
      // xterm's keydown out entirely; what the keys become arrives through the composition events.
      if (e.type === 'keydown' && e.keyCode !== 229 && paneIsComposing(term)) return false;
      // Escape is the SHELL'S key, always. It used to close the panel — at once on a plain prompt, and on a
      // second press inside a window in a fullscreen TUI. Both of those took a key that belongs to whatever is
      // running: a prompt in vi mode leaves insert with it, readline treats it as the Meta prefix, and a menu
      // completion cancels on it. Worst of all, Claude Code binds DOUBLE Esc itself (jump back to the previous
      // message), which is exactly the gesture the panel was listening for — the second press closed the
      // terminal instead of doing the thing the agent documents. Nothing about "put this panel away" needs the
      // one key the program inside cannot do without: Ctrl+` toggles it, and so does the footer button.
      // F7 / Shift+F7 (diff prev/next-change) and Cmd+F7 / Shift+Cmd+F7 (comment prev/next) are nav keys.
      // Don't let the terminal eat them (it would send an escape sequence to the shell); return false so
      // xterm ignores the key and it bubbles to the document handler. We DON'T blur — both are JS-cursor
      // nav, so they run while the terminal keeps focus.
      if (e.type === 'keydown' && e.key === 'F7' && !e.altKey) return false;
      if (e.type === 'keydown' && e.metaKey) {
        var k = (e.key || '').toLowerCase();
        // The bare modifier press (Cmd goes down BEFORE the letter on macOS) must not blur — blurring
        // here drops the textarea focus the upcoming Cmd+V paste / Cmd+C copy needs, which broke them.
        if (k === 'meta' || k === 'control' || k === 'alt' || k === 'shift') return true;
        // Match the PHYSICAL key (e.code), not e.key: under a non-Latin layout/IME (e.g. Korean 한글)
        // Cmd+V reports e.key as 'ㅍ', so a key-based check misses it — blurring the terminal and
        // breaking paste/copy/cut/select-all whenever the Korean input source is active.
        // Cmd+C with a terminal selection: copy it ourselves — xterm doesn't auto-copy and the menu/native
        // copy misses xterm's own selection, so Cmd+C silently did nothing. No selection -> fall through.
        if (e.code === 'KeyC' && term.hasSelection && term.hasSelection()) { copyToClipboard(term.getSelection()); return false; }
        if (e.code === 'KeyC' || e.code === 'KeyV' || e.code === 'KeyX' || e.code === 'KeyA') return true;
        // Cmd/Ctrl+W is the close-pane menu accelerator. onCloseTab closes the FOCUSED pane only if the
        // terminal still has focus — blurring here first made hasFocus() false, so the focused split pane
        // never closed. Release the key WITHOUT blurring so focus stays and onCloseTab can close it.
        if (e.code === 'KeyW') return false;
        // Cmd+Enter isn't a global app shortcut (only the source viewer binds it, and that view sits behind
        // this floating terminal) and has no shell meaning — but the blur fallback below kicked focus out of
        // the terminal on every Cmd+Enter. Keep focus and swallow it: preventDefault + stopPropagation so it
        // neither submits a line nor bubbles to the document handler (which would run an HTTP file behind us).
        if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); e.stopPropagation(); return false; }
        try { term.blur(); } catch (x) {}
        return false;
      }
      return true;
    });
    term.onData(function (d) { lastInputAt = Date.now(); if (pane.id != null) window.kakapoPty.write({ id: pane.id, data: d }); });
    // onData fires only on COMMITTED input, so under an IME it stays silent for the whole time a syllable is
    // being assembled — several keystrokes during which nothing marked the terminal busy. Watch the helper
    // textarea directly: keydown covers composing keystrokes, and composing/composed brackets the window in
    // which a DOM rebuild or focus change would make macOS commit the half-built syllable, splitting 가 into
    // ㄱ ㅏ. This is why the breakage was intermittent — it needed a refresh to land mid-syllable.
    if (term.textarea) {
      term.textarea.addEventListener('keydown', function () { lastInputAt = Date.now(); }, true);
      term.textarea.addEventListener('compositionstart', function () {
        composingPanes.add(pane);
        lastInputAt = Date.now();
        pinCompositionAnchor(term);
        setCursorHiddenForComposition(term, true);
        matchCompositionDim(term);
        alignCompositionOverlay(term);
        imeNow = { at: Date.now(), writes: 0, bytes: 0, fitsHeld: 0, anchorPins: 0, panes: panes.length, data: '' };
      });
      // Re-checked on update, not only at the start: the agent can repaint its composer between keystrokes.
      term.textarea.addEventListener('compositionupdate', function () { lastInputAt = Date.now(); matchCompositionDim(term); alignCompositionOverlay(term); });
      // xterm commits a composition by slicing its textarea with offsets recorded while the composition ran
      // (start at compositionstart, end on a setTimeout after each update). A macOS Hangul composition runs
      // to the end of the WORD and rewrites the whole value on every keystroke, so those offsets go stale:
      // measured against xterm 6.0, composing "해야" sends only "야", and output arriving mid-composition
      // loses the word outright. compositionend already carries the committed text, so take the commit —
      // cancel xterm's deferred send and write event.data ourselves. Nothing then depends on an offset
      // surviving the composition, which is the part macOS Hangul breaks.
      term.textarea.addEventListener('compositionend', function (event) {
        composingPanes.delete(pane);
        lastInputAt = Date.now();
        setCursorHiddenForComposition(term, false);
        takeCompositionCommit(term, event);
        flushDeferredFit();
        noteCompositionEnd(event);
      });
      // A composition the pane never got to finish — focus left mid-syllable, which is itself a way to split
      // one. Closed out here so the log never shows it as still running.
      term.textarea.addEventListener('blur', function () {
        composingPanes.delete(pane);
        setCursorHiddenForComposition(term, false); // abandoned mid-syllable — the caret is owed back
        if (imeNow) noteCompositionEnd(null);
        flushDeferredFit();
      });
    }
    // Bell from the pane's TUI (e.g. Claude Code finished a turn / needs input): badge the pane when it isn't
    // the one you're looking at, and ask the main process to raise a native notification when the whole window
    // isn't focused. Toggle in Settings ("Notify when a terminal task finishes").
    term.onBell(function () {
      if (pane !== active && pane.labelEl) pane.labelEl.classList.add('has-bell');
      if (persistRead('kakapo-terminal-bell-notify') === false) return; // OS notifications disabled
      try { window.kakapoPty.bell({ title: 'kakapo', body: pane.name + ' — ' + t('notify.bellBody') }); } catch (e) {}
    });
    el.addEventListener('mousedown', function (e) { if (e.target !== labelEl) setActive(pane); });
    labelEl.addEventListener('dblclick', function () { renamePane(pane); });
    panes.push(pane);
    try { fit.fit(); } catch (e) {}
    // Main runs every pane inside this workspace's tmux session when tmux is installed, so the shell outlives
    // the app; there is nothing for the renderer to opt into.
    // pane.restoreOrdinal names the already-running session this pane stands for (restorePanes); without it
    // main hands out the lowest free ordinal, which is what a genuinely new pane wants.
    window.kakapoPty.spawn({ cols: term.cols || 80, rows: term.rows || 24, ordinal: pane.restoreOrdinal })
      .then(function (r) {
        pane.id = r && r.id;
        // A fresh pty has never been sized, whatever the pane was showing before it: clear what we believe we
        // sent, so the next fit tells it even when the grid happens to be unchanged.
        pane.sentCols = pane.sentRows = 0;
        fitPane(pane);
      });
    setActive(pane);
    return pane;
  }
  // Rename a pane inline: the label becomes editable, Enter commits, Esc/blur reverts to the last name.
  function renamePane(pane) {
    if (!pane) { pane = active; }
    if (!pane) return;
    var el = pane.labelEl;
    if (el.getAttribute('contenteditable') === 'true') return;
    setActive(pane);
    el.contentEditable = 'true';
    // Electron asynchronously restores focus to <body> after the keydown, so a one-shot focus loses the
    // race and the label turns editable but never gets the caret — retry until it sticks, then select all
    // (same pattern as the composer/memo). This is why rename "did nothing" before.
    var renameTries = 0;
    var focusLabel = function () {
      if (el.getAttribute('contenteditable') !== 'true') return true; // finished/cancelled meanwhile
      try { el.focus(); } catch (e) {}
      if (document.activeElement !== el) return false;
      try { var range = document.createRange(); range.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); } catch (e) {}
      return true;
    };
    if (!focusLabel()) { var renameIv = setInterval(function () { if (focusLabel() || ++renameTries > 12) clearInterval(renameIv); }, 25); }
    function finish(commit) {
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('blur', onBlur);
      el.contentEditable = 'false';
      if (commit) pane.name = (el.textContent || '').trim() || pane.name;
      el.textContent = pane.name;
      try { if (pane.term) pane.term.focus(); } catch (e) {}
    }
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    }
    function onBlur() { finish(true); }
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onBlur);
  }

  function removePane(id) {
    for (var k = 0; k < panes.length; k++) { if (panes[k].id === id) { removePaneRef(panes[k]); return; } }
  }
  // Remove a pane by object reference (handles panes whose pty id hasn't arrived yet — spawn is async).
  function removePaneRef(p) {
    var i = panes.indexOf(p);
    if (i < 0) return;
    composingPanes.delete(p);
    try { p.term.dispose(); } catch (e) {}
    var cell = p.el.parentNode;
    if (cell) {
      cell.removeChild(p.el);
      // An emptied cell would keep its share of the row and show as a gap where the pane used to be.
      if (cell.classList.contains('terminal-cell') && !cell.children.length && cell.parentNode) cell.parentNode.removeChild(cell);
    }
    panes.splice(i, 1);
    if (active === p) setActive(panes[panes.length - 1] || null);
    // The last pane going away must also forget the settled ensurePanes() promise: it is a single-flight
    // guard, not a cache of "the panel is populated". Left in place, the next open found it already
    // resolved, created nothing, and showed an empty white panel — "the terminal is gone" after closing
    // every pane and coming back to the workspace.
    if (panes.length === 0) { panesReady = null; setOpen(false); }
    else scheduleFitAll();
  }
  // Cmd/Ctrl+W inside the terminal: close just the FOCUSED pane (kill its pty), not the whole panel. The
  // last pane closing collapses the panel via removePaneRef -> setOpen(false). Remove the pane immediately
  // (don't wait for the pty's onExit) so the UI responds at once; the later onExit -> removePane no-ops.
  // endSession: closing a pane on purpose ends what it was running (the tmux session goes with it). Only this
  // path sets it — the unload handler below detaches instead, so quitting the app leaves agents working.
  function killPane(p) {
    if (p.id != null) { try { window.kakapoPty.kill({ id: p.id, endSession: true }); } catch (e) {} }
    removePaneRef(p);
  }
  function closeActivePane() {
    var p = active || panes[panes.length - 1];
    if (!p) { setOpen(false); return; }
    // If an agent/command is running in this pane, confirm before ⌘W kills it. The check is async (main reads
    // the pty's foreground process), so panes with a spawn still in flight or an unavailable probe just close.
    if (p.id != null && window.kakapoPty && typeof window.kakapoPty.foreground === 'function') {
      Promise.resolve(window.kakapoPty.foreground({ id: p.id })).then(function (info) {
        if (info && info.running && !window.confirm(t('terminal.closeRunningConfirm').replace('{name}', info.name || '?'))) return;
        killPane(p);
      }, function () { killPane(p); });
      return;
    }
    killPane(p);
  }

  // Cmd+D splits side by side, Cmd+Shift+D stacks the FOCUSED pane top/bottom: a new cell beside the others,
  // or a second pane inside the focused pane's own cell. Both act on the pane you are in and leave every other
  // pane's geometry alone — the panel used to carry one axis for all of them, so a stacked split silently
  // re-oriented the whole panel.
  // ponytail: one nesting level (a row of stacked cells), which covers MAX_PANES 2x2. A full split tree
  // (columns inside rows inside columns) only if someone wants more than that.
  function split(direction) {
    if (panes.length >= MAX_PANES) return;
    var cell = direction === 'column' && active && active.el.parentNode ? active.el.parentNode : makeCell();
    makePane(cell);
    // Re-fit after the browser has laid the new axis out — fitting against the pre-split geometry leaves
    // xterm sized for the old direction, which shows up as a pane whose rows/cols don't match its box.
    scheduleFitAll();
  }
  // Move active focus between split panes (menu accelerators Cmd/Ctrl+Alt+[ and ]).
  function focusPaneByDelta(delta) {
    if (panes.length < 2) return;
    var i = panes.indexOf(active);
    if (i < 0) i = 0;
    setActive(panes[(i + delta + panes.length) % panes.length]);
  }

  // Route per-pane pty output / exit by id (registered once for the window).
  // This used to HOLD output for a pane with a composition in flight, to stop xterm dragging the IME rect (it
  // pins the composition overlay to the buffer cursor) out from under a half-built syllable. It went out in
  // 0.4.18 and had to come straight back out: a macOS Hangul composition does not end at a syllable, it runs
  // to the end of the WORD, so "hold until compositionend" held the agent's echo for the whole word and the
  // reviewer watched their own typing disappear until they hit space. Whatever the jamo fix turns out to be,
  // it cannot be one that withholds output for the duration of a composition.
  window.kakapoPty.onData(function (msg) {
    for (var k = 0; k < panes.length; k++) {
      if (panes[k].id === msg.id) {
        // Counted, never queued: output arriving mid-composition is the commonest thing happening while a
        // syllable breaks, and this count is how the log gets to say so.
        if (imeNow) { imeNow.writes++; imeNow.bytes += (msg.data || '').length; }
        // What the terminals had just taken, so a renderer stall can say whether it was drowning in output
        // (a tmux repaint after a resize is thousands of bytes) — see trackMainThreadStalls.
        noteKakapoActivity('pty', (msg.data || '').length);
        // When this pane last SAID anything. An agent between turns is silent; one mid-turn is not. It is the
        // only signal in the renderer for "is it safe to press Enter at this thing" (handOff below), and
        // counting bytes here costs a timestamp on a path that is already writing them to xterm.
        panes[k].lastOutputAt = Date.now();
        noteConnectingOutput(panes[k]);
        // A workspace off screen is a hidden PAGE: Chromium throttles this renderer, so every byte written
        // here queues inside xterm instead of being parsed — an agent mid-turn puts megabytes in that queue,
        // and switching back pays for all of it in one task. Stop feeding it, remember only that output
        // happened, and let tmux repaint the current screen on the way back (paneNeedsRepaint below). The
        // scrollback is tmux's and stays there; what the reader wants on arrival is the last screen.
        if (document.visibilityState === 'hidden') { holdHiddenOutput(panes[k]); return; }
        panes[k].term.write(msg.data);
        return;
      }
    }
  });
  window.kakapoPty.onExit(function (msg) { removePane(msg.id); });

  // A workspace off screen is a hidden PAGE, and Chromium throttles a hidden renderer: every byte written to
  // xterm there sits in its queue unparsed, so an agent mid-turn leaves megabytes of it — all of which the
  // switch back pays for in one task. That is the terminal half of "switching workspaces freezes".
  //
  // So a hidden pane's output is HELD instead of written, and the arrival is ordered the way a reader wants
  // it: the most recent screenful goes in first, then tmux repaints the pane's true current screen over it.
  // What is held is bounded — past the cap the oldest is dropped, because a screen you cannot see does not
  // need every byte of a build log kept twice (tmux has the scrollback and always did).
  // Nothing is kept, only the FACT that output happened. Holding the bytes and replaying them was tried and
  // taken out: the held tail was drawn for the width tmux had while the workspace was away, and a pane that
  // came back to a different width (the rail, a window resize, a zoom step) then had that tail poured into a
  // grid it was never wrapped for — text broke mid-word at the wrong column and the pane stayed wrong until
  // the session restarted. tmux holds the real screen and the real scrollback; asking it to repaint is both
  // cheaper and correct, so that is all this does.
  function holdHiddenOutput(pane) {
    pane.hiddenHeld = true;
  }
  // Whether this pane's WebGL context is actually DEAD — the question the re-show path below acts on. The
  // addon being absent means the loss event already fired (onContextLoss nulls it); otherwise ask the
  // context itself: isContextLost() is set by the same GPU-channel signal whether or not the DOM event ever
  // dispatched, which is exactly the "gone but never fired its loss event" case the replace was added for.
  // The reach into addon internals is the house style here (see takeCompositionCommit); a future addon that
  // changes the shape makes this answer "lost", and the old replace-always behaviour is back — never a throw.
  function paneWebglLost(term) {
    var addon = term.__kakapoWebgl;
    if (!addon) return true;
    try {
      var gl = addon._renderer && addon._renderer._gl;
      if (!gl || typeof gl.isContextLost !== 'function') return true;
      return gl.isContextLost();
    } catch (e) { return true; }
  }
  // Fit FIRST, then repaint: the resize is what tells tmux the grid it must wrap to, and a repaint asked for
  // before it would draw the old shape into the new pane.
  function flushHiddenOutput() {
    scheduleFitAll();
    requestAnimationFrame(function () {
      panes.forEach(function (pane) {
        // While the workspace was off screen this pane's WebGL context can die or its canvas go stale
        // (closing another workspace's webContents is enough), and what a dead context shows is whatever was
        // left in that memory — another surface's diff, solid color blocks at the wrong scale. Refreshing
        // into it was tried first and was not enough: a context that is gone but never fired its loss event
        // absorbs the redraw and keeps the garbage on screen. So a DEAD context is REPLACED — a fresh addon
        // draws the whole screen from the buffer on attach, sized to the pane as it is now.
        //
        // Only a dead one. This used to replace the context on EVERY switch, and that unconditional replace
        // was the workspace-switch freeze (issue: ~4s hangs after long uptime): getContext + shader compile +
        // glyph-atlas rebuild are synchronous round-trips to the GPU process from this thread, and once the
        // GPU process is carrying a session's worth of surfaces they run seconds, not milliseconds — the
        // field traces show 1.5–3.6s renderer stalls starting ~25ms after every workspace-activate, always
        // with the terminal open. A healthy context repaints correctly from the refresh below and pays none
        // of that; the garbage-frame case the replace was for is precisely the lost-context case, so asking
        // isContextLost() keeps that fix intact.
        if (paneWebglLost(pane.term)) {
          if (pane.term.__kakapoWebgl) {
            try { pane.term.__kakapoWebgl.dispose(); } catch (e) {}
            pane.term.__kakapoWebgl = null;
          }
          loadWebglRenderer(pane.term);
        }
        if (pane.hiddenHeld) {
          pane.hiddenHeld = false;
          try { pane.term.reset(); } catch (e) {}
        } else {
          try { pane.term.refresh(0, pane.term.rows - 1); } catch (e) {}
        }
        // Every pane, not only the held ones: xterm's buffer is a copy of tmux's screen, and a copy that was
        // wrapped for a stale grid draws a broken layout no local repaint can mend. tmux holds the truth and
        // repainting from it costs a few KB — the same self-heal the held path has always used.
        if (pane.id != null && window.kakapoPty && typeof window.kakapoPty.refresh === 'function') {
          window.kakapoPty.refresh({ id: pane.id });
        }
      });
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') flushHiddenOutput();
  });

  // Panes are the app's view of tmux sessions, and the sessions outlive the app — so opening the panel after
  // a restart must bring back the panes that are still running, not one. Otherwise two agents came back as
  // one pane, and opening "a new pane" silently landed on the second agent, which reads as the app losing
  // track of its own terminals. Each pane re-attaches to a specific ordinal so a gap (session 1 and 3, with
  // 2 closed) restores as those two rather than renumbering them.
  var restored = false;
  function restorePanes() {
    if (restored || panes.length) return Promise.resolve();
    restored = true;
    if (!window.kakapoPty || typeof window.kakapoPty.sessions !== 'function') return Promise.resolve();
    return Promise.resolve(window.kakapoPty.sessions()).then(function (result) {
      var ordinals = (result && result.ordinals) || [];
      if (ordinals.length < 2) return; // one (or none) is what a plain open already does
      ordinals.slice(0, MAX_PANES).forEach(function (ordinal) {
        makePane(null, ordinal); // one cell each: side by side, the layout a fresh split would give
      });
      scheduleFitAll();
    }, function () { /* no tmux, no sessions — a plain pane is right */ });
  }

  // The panel opens before anything is attached to it: main still has to list the surviving tmux sessions, a
  // pty has to be attached per pane, and tmux only redraws once that lands. Until the first byte the panel is
  // an empty rectangle and the wait reads as a hang. Spin until something arrives — and never longer, because
  // a pane attached to a silent session prints nothing at all and the spinner would outlive the thing it is
  // describing, over a terminal that already works.
  var connectingTimer = 0;
  // Connecting is a PER-PANE state: a split can have one pane still attaching while the pane beside it is
  // already showing an agent's output, and a single arc in the middle of the panel described neither of them.
  // Each pane wears its own, so the wait is drawn over exactly the rectangle that is waiting.
  //
  // The FIRST byte is not the end of that wait. Attaching to tmux echoes a handful of bytes at once and the
  // redraw of the session's screen follows a second or more later — clearing on first output took the overlay
  // away after ~100ms and left the rest as an empty pane, which is the wait the reviewer actually sees. Every
  // byte pushes the finish line back instead; the 4s ceiling still ends a session that says nothing at all.
  function paneLabel() {
    try { return JSON.stringify(t('terminal.connecting')); } catch (e) { return '""'; }
  }
  function setPaneConnecting(p, on) {
    if (!p || !p.el) return;
    if (p.settleTimer) { clearTimeout(p.settleTimer); p.settleTimer = 0; }
    if (p.connectTimer) { clearTimeout(p.connectTimer); p.connectTimer = 0; }
    p.el.classList.toggle('is-connecting', !!on);
    // The label reaches CSS as a quoted string: the overlay is a pseudo-element and `content` cannot read a
    // translation itself. Read at this moment rather than at boot, so it follows a locale change.
    try {
      if (on) p.el.style.setProperty('--terminal-connecting', paneLabel());
      else p.el.style.removeProperty('--terminal-connecting');
    } catch (e) {}
    if (on) p.connectTimer = setTimeout(function () { setPaneConnecting(p, false); }, 4000);
  }
  // The first byte IS the connection — the pty answered. This used to wait for output to go QUIET for 220ms,
  // to avoid uncovering a pane mid-repaint, and that condition is never met by the pane you most want to see:
  // re-attaching to a session whose agent is streaming means output never stops, so the overlay sat until the
  // 4s ceiling and the workspace read as slow to open when it had connected in about 20ms.
  function noteConnectingOutput(p) {
    if (!p || !p.el || !p.el.classList.contains('is-connecting')) return;
    setPaneConnecting(p, false);
  }
  function setConnecting(on) {
    if (connectingTimer) { clearTimeout(connectingTimer); connectingTimer = 0; }
    panel.classList.toggle('is-connecting', !!on);
    try {
      if (on) panel.style.setProperty('--terminal-connecting', paneLabel());
      else panel.style.removeProperty('--terminal-connecting');
    } catch (e) {}
    if (on) connectingTimer = setTimeout(function () { setConnecting(false); }, 4000);
  }
  function isOpen() { return !panel.classList.contains('hidden'); }
  // The floating panel dims the app behind it; clicking the backdrop closes the terminal (dock-style).
  function setBackdrop(show) {
    var bd = document.getElementById('terminal-backdrop');
    if (show && !bd) {
      bd = document.createElement('div');
      bd.id = 'terminal-backdrop';
      bd.className = 'terminal-backdrop';
      bd.addEventListener('mousedown', function () { setOpen(false); });
      document.body.appendChild(bd);
    } else if (!show && bd) {
      bd.remove();
    }
  }
  function setOpen(open) {
    // The terminal shares the exclusive dock slot with merged/memo — opening it closes those. History goes
    // too: the panel renders above the overlay (z77+ vs 75), so closing the terminal later would drop the
    // reviewer back into an overlay they never meant to keep. Full-screen surfaces switch, never stack.
    if (open && typeof window.__kakapoCloseDocks === 'function') { try { window.__kakapoCloseDocks(); } catch (e) {} }
    if (open && window.__kakapoHistory && typeof window.__kakapoHistory.close === 'function') { try { window.__kakapoHistory.close(); } catch (e) {} }
    panel.classList.toggle('hidden', !open);
    if (!open) setConnecting(false);
    document.body.classList.toggle('terminal-open', open);
    if (toggleBtn) toggleBtn.classList.toggle('is-active', open);
    setBackdrop(open);
    try { sessionStorage.setItem(openKey, open ? '1' : '0'); } catch (e) {}
    applyDockMaximized(); // keep Cmd+Shift+' maximize in sync
    if (open) {
      // The terminal renders above the quick-open launcher, so leaving one open underneath hides a dialog
      // that still owns every keystroke. Close it as the terminal comes up.
      if (typeof quickOpen !== 'undefined' && quickOpen && !quickOpen.classList.contains('hidden')) closeQuickOpen();
      if (panes.length === 0) {
        setConnecting(true);
        ensurePanes().then(function () {
          requestAnimationFrame(function () { focusPane(active); });
        });
      } else {
        // Opening an existing pane: fit it to the panel it is being shown in, then have tmux repaint what is
        // actually on that session's screen. Without the repaint the pane shows whatever it last drew — which,
        // after time away at another width, is a screen wrapped for a grid that no longer exists.
        scheduleFitAll();
        requestAnimationFrame(function () {
          focusPane(active);
          panes.forEach(function (pane) {
            if (pane.id != null && window.kakapoPty && typeof window.kakapoPty.refresh === 'function') {
              window.kakapoPty.refresh({ id: pane.id });
            }
          });
        });
      }
    }
  }
  // Attaching is what the wait is made of: main lists the surviving tmux sessions, a pty is attached per
  // pane, xterm boots, and tmux only redraws once that lands — several seconds on a workspace whose panes do
  // not exist yet, all of it spent AFTER ⌃` with an empty rectangle on screen. None of it needs the panel to
  // be open, and none of it needs to wait for the reader to ask: a workspace you have switched to is one you
  // are about to work in. So the panes are built the moment this workspace comes on screen, behind the closed
  // panel, and ⌃` becomes what it looks like — showing something that is already there.
  //
  // Only on arrival, never at app boot: a workspace nobody visits should not hold ptys, and a hidden pane's
  // output is held rather than written (the visibilitychange handler above), so warming one costs a tmux
  // client and no parsing.
  // ONE in-flight attach, shared by the warm below and ⌃` — never two. A pane spawned without an ordinal
  // takes the lowest one this window is not already using, and that bookkeeping only lands when main answers:
  // two callers racing therefore both got ordinal 1, both attached to the SAME tmux session, and the panel
  // came back with two panes mirroring each other keystroke for keystroke.
  var panesReady = null;
  function ensurePanes() {
    if (!panesReady) {
      panesReady = restorePanes().then(function () {
        if (panes.length === 0) makePane(); // no surviving session: one plain pane, attached and waiting
        scheduleFitAll();
      }, function () {});
    }
    return panesReady;
  }
  // Attaching on ARRIVAL was tried and taken back out: it does not make the wait smaller, it moves it onto the
  // switch, where it is worse — every workspace you passed through paid an xterm boot before it would draw.
  // The wait belongs to ⌃`, where the reader asked for it, until the boot itself is made cheap.

  function toggle() { setOpen(!isOpen()); }
  // The keyboard shortcut is "focus-first": when the terminal is visible but focus is elsewhere, the first
  // press just moves focus INTO the terminal; only when it already owns focus does another press toggle it
  // closed. (The footer button stays a plain toggle — a mouse click should open/close in one step.)
  function toggleOrFocus() {
    if (!isOpen()) { setOpen(true); return; } // setOpen(true) also focuses the active pane
    var ae = document.activeElement;
    if (ae && panel.contains(ae)) { setOpen(false); return; } // focus already in the terminal → close
    if (active) focusPane(active); // visible but unfocused → just grab focus
  }

  if (toggleBtn) toggleBtn.addEventListener('click', toggle);
  // Toggle (Ctrl+`/Alt+F12) and split (Cmd+D) arrive from the Terminal menu accelerators (app-main),
  // because Chromium swallows Cmd+D before a renderer keydown would ever see it.
  if (window.kakapoMenu && typeof window.kakapoMenu.onTerminalToggle === 'function') window.kakapoMenu.onTerminalToggle(toggleOrFocus);
  if (window.kakapoMenu && typeof window.kakapoMenu.onTerminalSplit === 'function') window.kakapoMenu.onTerminalSplit(split);
  if (window.kakapoMenu && typeof window.kakapoMenu.onTerminalPaneFocus === 'function') window.kakapoMenu.onTerminalPaneFocus(focusPaneByDelta);
  if (window.kakapoMenu && typeof window.kakapoMenu.onTerminalPaneRename === 'function') window.kakapoMenu.onTerminalPaneRename(function () { renamePane(active); });
  if (window.kakapoMenu && typeof window.kakapoMenu.onAgentResume === 'function') window.kakapoMenu.onAgentResume(function (command) {
    setOpen(true);
    var tries = 0, send = function () {
      if (active && active.id != null) { window.kakapoPty.write({ id: active.id, data: String(command || '') + '\r' }); return true; }
      return false;
    };
    if (!send()) { var iv = setInterval(function () { if (send() || ++tries > 40) clearInterval(iv); }, 50); }
  });

  var ro = (typeof ResizeObserver === 'function') ? new ResizeObserver(function () { if (isOpen()) scheduleFitAll(); }) : null;
  if (ro) ro.observe(host);
  window.addEventListener('resize', function () { if (isOpen()) scheduleFitAll(); });

  if (resizer) {
    resizer.addEventListener('mousedown', function (e) {
      e.preventDefault();
      resizer.classList.add('resizing');
      function move(ev) { applyHeight(window.innerHeight - ev.clientY); scheduleFitAll(); }
      function up() {
        resizer.classList.remove('resizing');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        var cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--terminal-height'), 10);
        if (cur) { try { localStorage.setItem(heightKey, String(cur)); } catch (e) {} }
        scheduleFitAll();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // Kill this window's ptys on unload so a reload/close doesn't leak them in the main process.
  window.addEventListener('beforeunload', function () {
    panes.forEach(function (p) { if (p.id != null) { try { window.kakapoPty.kill({ id: p.id }); } catch (e) {} } });
  });

  // Hook for the merged-prompt modal: pipe the combined text into a chosen pane (no trailing Enter —
  // the user reviews in the live session, then presses Enter, so multiline prompts stay intact).
  // `keepFocus` is for the one caller that did not ask for any of this: an automatic hand-off arrives while
  // the reviewer is reading the diff, and taking the keyboard out of the file they are in the middle of is a
  // worse interruption than the thing it is announcing. Every deliberate send still focuses, because there
  // the reviewer is on their way to the terminal anyway.
  function writeToPane(p, text, keepFocus) {
    if (!p) return;
    setOpen(true);
    // Send it as a PASTE, not as typing, whenever the app in the pane asked for bracketed paste (DECSET 2004
    // — Codex, Claude Code, vim, a modern shell). Raw text makes every newline an Enter: Codex submitted the
    // first line and typed the rest into a busy composer, so a multi-line prompt never arrived intact.
    // Claude Code survived it only by guessing from input speed. Plain apps that never enabled the mode still
    // get the bytes unwrapped, or they would see the markers as literal "[200~" garbage.
    if (p.id != null) {
      var bracketed = p.term && p.term.modes && p.term.modes.bracketedPasteMode;
      window.kakapoPty.write({ id: p.id, data: bracketed ? '\x1b[200~' + text + '\x1b[201~' : text });
    }
    if (keepFocus) return;
    setActive(p);
    requestAnimationFrame(function () { try { p.term.focus(); } catch (e) {} });
  }
  // Pane-pick mode: triggered from the merged modal's "Send to terminal". The chosen pane is highlighted,
  // the rest are dimmed; arrows change the pick, Enter sends, Esc cancels. Single pane → send at once.
  var sendModeText = null, sendModeIdx = 0, sendModeWasOpen = false;
  function paintSendMode() {
    panes.forEach(function (p, i) {
      p.el.classList.toggle('is-send-target', i === sendModeIdx);
      p.el.classList.toggle('is-dimmed', i !== sendModeIdx);
    });
  }
  function exitSendMode() {
    if (sendModeText == null) return;
    sendModeText = null;
    panel.classList.remove('send-mode');
    document.body.classList.remove('terminal-send-mode'); // un-dim the rest of the app
    panes.forEach(function (p) { p.el.classList.remove('is-send-target', 'is-dimmed'); });
    // Cancel (Esc): if enterSendMode had to open the panel itself, close it back down so Esc fully undoes
    // the "Send to terminal" action instead of leaving a stray open panel that a second Esc then has to
    // fall through past (to whatever view was behind it). Confirm (Enter) also calls exitSendMode first,
    // but writeToPane() unconditionally re-opens right after, so this never fights that path.
    if (!sendModeWasOpen) setOpen(false);
  }
  function enterSendMode(text) {
    // Capture "was the panel already open" BEFORE anything below can change it — callers open the panel
    // first just to guarantee a pane exists (paneCount() === 0 -> open()), which would otherwise make this
    // read true even when the panel was closed a moment ago, and Esc-cancel would never close it back down.
    sendModeWasOpen = isOpen();
    if (panes.length === 0) makePane();
    if (panes.length === 0) return; // xterm unavailable — nothing to send to
    setOpen(true);
    sendModeText = text;
    sendModeIdx = Math.max(0, panes.indexOf(active));
    panel.classList.add('send-mode');
    document.body.classList.add('terminal-send-mode'); // dim sidebar + file/diff view; only the terminal pops
    paintSendMode();
  }
  // A KEY_OWNERS row (05-keymap.js) rather than a capture listener: while a pick is up every key belongs to
  // it, including over the focused xterm, and that rank is now stated in the table with every other surface.
  handleTerminalSendModeKey = function (e) {
    if (sendModeText == null) return false;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
      sendModeIdx = (sendModeIdx + d + panes.length) % panes.length;
      paintSendMode();
    } else if (e.key === 'Enter') {
      var p = panes[sendModeIdx], text = sendModeText;
      exitSendMode();
      writeToPane(p, text);
    } else if (e.key === 'Escape') {
      exitSendMode();
    }
    return true; // every key while picking belongs to the picker
  };
  // Publish the terminal palette once at startup, not only on a theme CHANGE: the composition overlay reads it
  // from CSS (see applyTerminalTheme), and until this ran it fell back to xterm's hardcoded black.
  applyTerminalTheme();
  window.__kakapoTerminal = {
    isOpen: isOpen,
    // The Settings rows (08-dock.js) own the values; the panel owns what they mean on screen.
    typography: function () { return { size: terminalFontSize(), line: terminalLineHeight(), sizes: TERM_FONT_SIZES, lines: TERM_LINE_HEIGHTS, sizeKey: TERM_FONT_KEY, lineKey: TERM_LINE_KEY }; },
    applyTypography: applyTerminalTypography,
    // True when keyboard focus is inside the terminal panel (a pane owns it) — Cmd/Ctrl+W uses this to
    // decide between closing a pane and closing a source tab.
    hasFocus: function () { var ae = document.activeElement; return !!(ae && panel.contains(ae)); },
    // When the reviewer last typed into a pane (0 = never). Read by the watch refresh to stay off the
    // keystroke path; see applyDiffUpdate.
    typingAt: function () { return lastInputAt; },
    // True while an IME syllable is still being assembled in some pane.
    isComposing: function () { return composingPanes.size > 0; },
    // Run the fit the rail animation was holding (setRailContentPin, 09-views-update.js). Nothing to do when
    // no resize arrived while the pin was up.
    flushFit: flushDeferredFit,
    // The last 30 compositions and what the terminal was doing during each. `split: true` marks one that came
    // out as jamo. Read from the review window's devtools: __kakapoTerminal.imeLog()
    imeLog: function () { return imeLog.slice(); },
    // The active pane's visible screen as plain text — the WebGL renderer leaves no DOM to read, so this is
    // the one way devtools (and the switch-freeze harness) can ask what the pane actually shows.
    screenText: function () {
      var p = active || panes[0];
      if (!p || !p.term) return '';
      try {
        var buffer = p.term.buffer.active, out = [];
        for (var y = buffer.viewportY; y < buffer.viewportY + p.term.rows; y++) {
          var line = buffer.getLine(y);
          if (line) out.push(line.translateToString(true));
        }
        return out.join('\n');
      } catch (e) { return ''; }
    },
    // The active pane's visible screen as plain text — the WebGL renderer leaves no DOM to read, so this is
    // the one way devtools (and the switch-freeze harness) can ask what the pane actually shows.
    screenText: function () {
      var p = active || panes[0];
      if (!p || !p.term) return '';
      try {
        var buffer = p.term.buffer.active, out = [];
        for (var y = buffer.viewportY; y < buffer.viewportY + p.term.rows; y++) {
          var line = buffer.getLine(y);
          if (line) out.push(line.translateToString(true));
        }
        return out.join('\n');
      } catch (e) { return ''; }
    },
    open: function () { setOpen(true); },
    // Called when the app's theme family changes (see applyTheme in 01-core.js).
    retheme: applyTerminalTheme,
    paneCount: function () { return panes.length; },
    closeActivePane: closeActivePane,
    enterSendMode: enterSendMode,
    // "Open terminal here" from the file tree (13-goto.js): cd the integrated terminal into a directory,
    // instead of handing the folder to Terminal.app and leaving the reviewer in a second, unrelated shell.
    //
    // The one thing it must never do is type into a pane that is busy: `cd …` sent to a running agent lands
    // in its composer as a prompt. So it asks the pane what it is running first, and splits a fresh one when
    // the answer is not a bare shell. At the pane cap there is nowhere safe to put it, so it says so rather
    // than interrupting. The retry loop is the same one agent-resume uses — a freshly split pane has no pty
    // id until its spawn returns.
    openAt: function (dir) {
      if (!dir) return;
      setOpen(true);
      var line = 'cd ' + "'" + String(dir).split("'").join("'\\''") + "'\r";
      var writeWhenReady = function () {
        var tries = 0, go = function () {
          if (!(active && active.id != null)) return false;
          window.kakapoPty.write({ id: active.id, data: line });
          focusPane(active);
          return true;
        };
        if (!go()) { var iv = setInterval(function () { if (go() || ++tries > 40) clearInterval(iv); }, 50); }
      };
      var target = active || panes[0];
      if (!target || target.id == null) { writeWhenReady(); return; }
      Promise.resolve(window.kakapoPty.foreground({ id: target.id })).then(function (result) {
        if (!(result && result.running)) { writeWhenReady(); return; }
        if (panes.length >= MAX_PANES) {
          showToast(t('terminal.openHere.busy'));
          return;
        }
        split();
        writeWhenReady();
      }, function () { writeWhenReady(); });
    },
    // Hand work to the agent the reviewer already has open — and press Enter for it. This is the one place
    // kakapo types into a pane on its own initiative, so the conditions are strict and it fails CLOSED: any
    // doubt returns false and the caller stages the text in the composer instead, which is what every other
    // hand-off has always done.
    //
    // "Is it safe" is NOT the question `openAt` asks. There, a running foreground process means "busy, split
    // a new pane" — but here a running `claude` is exactly what we are delegating TO. What must not happen is
    // typing into an agent MID-TURN (it lands in its composer and gets swallowed into whatever it is already
    // doing) or over a reviewer who is mid-keystroke. So the test is silence: nothing typed, nothing composed,
    // and nothing printed for long enough that the pane is plainly sitting at a prompt.
    //
    // The Enter is a SEPARATE write, after the text. Inside a bracketed paste a newline is literal — that is
    // the whole point of the mode (see writeToPane) — so a "\r" appended to the payload would be typed, not
    // pressed.
    handOff: function (text) {
      var p = active || panes[0];
      if (!p || p.id == null || !text) return Promise.resolve(false);
      var quiet = Date.now() - Math.max(lastInputAt, p.lastOutputAt || 0);
      if (composingPanes.size > 0 || quiet < HANDOFF_QUIET_MS) return Promise.resolve(false);
      // …and it has to be an AGENT in there. A bare shell takes the same bytes and the same Enter, and then
      // runs a paragraph of English prose as a command line — which at best prints "command not found" for
      // every word of it. The pane is asked what it is running, and only claude or codex gets typed at.
      return Promise.resolve(window.kakapoPty.foreground({ id: p.id })).then(function (fg) {
        var name = (fg && fg.name ? String(fg.name) : '').replace(/^-/, '').split(/\s+/)[0];
        if (!(fg && fg.running) || (name !== 'claude' && name !== 'codex')) return false;
        writeToPane(p, text, true); // keepFocus: the reviewer is reading the diff, not waiting at a terminal
        window.kakapoPty.write({ id: p.id, data: '\r' });
        return true;
      }, function () { return false; });
    },
    send: function (text) { writeToPane(active || panes[0], text); },
    sendToPane: function (i, text) { writeToPane(panes[i] || active || panes[0], text); },
    close: function () { setOpen(false); },
  };

  // Restore the open state across reloads.
  try { if (sessionStorage.getItem(openKey) === '1') setOpen(true); } catch (e) {}
})();
