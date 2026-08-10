// Integrated terminal (Electron only): xterm panes wired to node-pty sessions in the main process.
// Toggle with Ctrl+` / Opt+F12 / the footer ⌗ button; Cmd/Ctrl+D splits the active pane (side by side,
// no tabs); drag the top edge to resize. window.__kakapoTerminal pipes the merged prompt into the
// active pane. Cmd combos are released back to the app so shortcuts like Cmd+1 don't get stuck typing.
(function setupTerminal() {
  if (!window.kakapoPty) return; // xterm (window.Terminal) is loaded lazily on first open
  var panel = document.getElementById('terminal-panel');
  var host = document.getElementById('terminal-host');
  var toggleBtn = document.getElementById('terminal-toggle');
  var closeBtn = document.getElementById('terminal-close');
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
  // Panes with an IME composition in flight (Hangul/Kana/Pinyin mid-syllable). Interrupting one commits the
  // partial input, so a refresh must wait however long the composition takes — no timeout can bound it.
  var composingPanes = new Set();
  // Double-Esc window for closing the panel out of a fullscreen TUI (see the key handler below).
  var ESC_CLOSE_MS = 600;
  var lastEscAt = 0;
  var MAX_PANES = 4;
  var heightKey = 'kakapo-terminal-height';
  var openKey = 'kakapo-terminal-open:' + location.pathname;

  function applyHeight(px) {
    var h = Math.max(120, Math.min(px, window.innerHeight - 120));
    document.documentElement.style.setProperty('--terminal-height', h + 'px');
  }
  var savedH = parseInt(localStorage.getItem(heightKey) || '', 10);
  if (savedH) applyHeight(savedH);

  function fitPane(p) {
    if (!p) return;
    try { p.fit.fit(); if (p.id != null) window.kakapoPty.resize({ id: p.id, cols: p.term.cols, rows: p.term.rows }); } catch (e) {}
  }
  function fitAll() { panes.forEach(fitPane); }
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
  function applyTerminalTheme() {
    var colors = themeColors();
    panes.forEach(function (p) { try { p.term.options.theme = colors; } catch (e) {} });
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
  // Every pane lives in a CELL: the panel is a row of cells, and a cell is a column of panes. One level of
  // nesting is what makes "split the pane I am in" expressible — a single flex axis for the whole panel meant
  // a stacked split re-oriented every pane at once (the old is-column class).
  function makeCell() {
    var cell = document.createElement('div');
    cell.className = 'terminal-cell';
    host.appendChild(cell);
    return cell;
  }
  function makePane(cell) {
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
      fontSize: 12,
      fontFamily: 'Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: themeColors(),
      cursorBlink: true,
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    loadWebLinks(term);
    term.open(paneHost);
    var pane = { id: null, term: term, fit: fit, el: el, labelEl: labelEl, name: 'Terminal ' + (panes.length + 1) };
    labelEl.textContent = pane.name;
    // Cmd combos are app shortcuts (Cmd+1/0 tab switch, Cmd+B go-to-def, …). Release the terminal and let
    // them bubble to the document handler instead of typing into the shell (fixes "Cmd+1 stuck in term").
    // Exception: keep focus for clipboard/selection combos (Cmd+C/V/X/A) so the terminal's own copy &
    // paste keep working — blurring on Cmd+V drops the textarea focus the paste event needs.
    term.attachCustomKeyEventHandler(function (e) {
      // Escape dismisses the floating terminal. At a normal shell prompt one press is enough. A fullscreen TUI
      // (vim, less, claude/codex) runs in xterm's ALTERNATE buffer and needs Esc itself — in Claude Code it is
      // the interrupt — so a single press still goes through to the shell there. A SECOND Esc within
      // ESC_CLOSE_MS closes the panel instead: the app got its interrupt on the first press, and "Esc again to
      // put this away" costs the TUI nothing.
      if (e.type === 'keydown' && e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        var normalBuffer = true;
        try { normalBuffer = !!(term.buffer && term.buffer.active && term.buffer.active.type === 'normal'); } catch (x) {}
        if (normalBuffer) { lastEscAt = 0; setOpen(false); return false; }
        var now = Date.now();
        if (now - lastEscAt < ESC_CLOSE_MS) { lastEscAt = 0; setOpen(false); return false; }
        lastEscAt = now;
        return true; // first press belongs to the TUI
      }
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
      term.textarea.addEventListener('compositionstart', function () { composingPanes.add(pane); lastInputAt = Date.now(); });
      term.textarea.addEventListener('compositionupdate', function () { lastInputAt = Date.now(); });
      term.textarea.addEventListener('compositionend', function () { composingPanes.delete(pane); lastInputAt = Date.now(); });
      term.textarea.addEventListener('blur', function () { composingPanes.delete(pane); });
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
    // pane.restoreOrdinal is set by restorePanes() when this pane stands for a session that is already
    // running; without it main hands out the lowest free ordinal, which is what a genuinely new pane wants.
    window.kakapoPty.spawn({ cols: term.cols || 80, rows: term.rows || 24, ordinal: pane.restoreOrdinal })
      .then(function (r) { pane.id = r && r.id; });
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
    try { p.term.dispose(); } catch (e) {}
    var cell = p.el.parentNode;
    if (cell) {
      cell.removeChild(p.el);
      // An emptied cell would keep its share of the row and show as a gap where the pane used to be.
      if (cell.classList.contains('terminal-cell') && !cell.children.length && cell.parentNode) cell.parentNode.removeChild(cell);
    }
    panes.splice(i, 1);
    if (active === p) setActive(panes[panes.length - 1] || null);
    if (panes.length === 0) setOpen(false);
    else fitAll();
  }
  // Cmd/Ctrl+W inside the terminal: close just the FOCUSED pane (kill its pty), not the whole panel. The
  // last pane closing collapses the panel via removePaneRef -> setOpen(false). Remove the pane immediately
  // (don't wait for the pty's onExit) so the UI responds at once; the later onExit -> removePane no-ops.
  function killPane(p) {
    if (p.id != null) { try { window.kakapoPty.kill({ id: p.id }); } catch (e) {} }
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
    fitAll();
    requestAnimationFrame(fitAll);
  }
  // Move active focus between split panes (menu accelerators Cmd/Ctrl+Alt+[ and ]).
  function focusPaneByDelta(delta) {
    if (panes.length < 2) return;
    var i = panes.indexOf(active);
    if (i < 0) i = 0;
    setActive(panes[(i + delta + panes.length) % panes.length]);
  }

  // Route per-pane pty output / exit by id (registered once for the window).
  window.kakapoPty.onData(function (msg) {
    for (var k = 0; k < panes.length; k++) { if (panes[k].id === msg.id) { panes[k].term.write(msg.data); return; } }
  });
  window.kakapoPty.onExit(function (msg) { removePane(msg.id); });

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
        var pane = makePane(); // one cell each: side by side, the layout a fresh split would give
        if (pane) pane.restoreOrdinal = ordinal;
      });
      fitAll();
      requestAnimationFrame(fitAll);
    }, function () { /* no tmux, no sessions — a plain pane is right */ });
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
    // The terminal shares the exclusive dock slot with merged/memo — opening it closes those.
    if (open && typeof window.__kakapoCloseDocks === 'function') { try { window.__kakapoCloseDocks(); } catch (e) {} }
    panel.classList.toggle('hidden', !open);
    document.body.classList.toggle('terminal-open', open);
    if (toggleBtn) toggleBtn.classList.toggle('is-active', open);
    setBackdrop(open);
    try { sessionStorage.setItem(openKey, open ? '1' : '0'); } catch (e) {}
    if (typeof applyDockMaximized === 'function') applyDockMaximized(); // keep Cmd+Shift+' maximize in sync
    if (open) {
      // The terminal renders above the quick-open launcher, so leaving one open underneath hides a dialog
      // that still owns every keystroke. Close it as the terminal comes up.
      if (typeof closeQuickOpen === 'function' && typeof quickOpen !== 'undefined'
        && quickOpen && !quickOpen.classList.contains('hidden')) closeQuickOpen();
      if (panes.length === 0) {
        restorePanes().then(function () {
          if (panes.length === 0) makePane();
          requestAnimationFrame(function () { fitAll(); focusPane(active); });
        });
      } else {
        requestAnimationFrame(function () { fitAll(); focusPane(active); });
      }
    }
  }
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
  if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
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

  var ro = (typeof ResizeObserver === 'function') ? new ResizeObserver(function () { if (isOpen()) fitAll(); }) : null;
  if (ro) ro.observe(host);
  window.addEventListener('resize', function () { if (isOpen()) fitAll(); });

  if (resizer) {
    resizer.addEventListener('mousedown', function (e) {
      e.preventDefault();
      resizer.classList.add('resizing');
      function move(ev) { applyHeight(window.innerHeight - ev.clientY); }
      function up() {
        resizer.classList.remove('resizing');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        var cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--terminal-height'), 10);
        if (cur) { try { localStorage.setItem(heightKey, String(cur)); } catch (e) {} }
        fitAll();
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
  function writeToPane(p, text) {
    if (!p) return;
    setOpen(true);
    if (p.id != null) window.kakapoPty.write({ id: p.id, data: text });
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
  // Capture phase so the pick keys win over the focused xterm; while picking, every key is swallowed.
  document.addEventListener('keydown', function (e) {
    if (sendModeText == null) return;
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
  }, true);
  window.__kakapoTerminal = {
    isOpen: isOpen,
    // True when keyboard focus is inside the terminal panel (a pane owns it) — Cmd/Ctrl+W uses this to
    // decide between closing a pane and closing a source tab.
    hasFocus: function () { var ae = document.activeElement; return !!(ae && panel.contains(ae)); },
    // When the reviewer last typed into a pane (0 = never). Read by the watch refresh to stay off the
    // keystroke path; see applyDiffUpdate.
    typingAt: function () { return lastInputAt; },
    // True while an IME syllable is still being assembled in some pane.
    isComposing: function () { return composingPanes.size > 0; },
    open: function () { setOpen(true); },
    // Called when the app's theme family changes (see applyTheme in 01-core.js).
    retheme: applyTerminalTheme,
    paneCount: function () { return panes.length; },
    closeActivePane: closeActivePane,
    enterSendMode: enterSendMode,
    send: function (text) { writeToPane(active || panes[0], text); },
    sendToPane: function (i, text) { writeToPane(panes[i] || active || panes[0], text); },
    close: function () { setOpen(false); },
  };

  // Restore the open state across reloads.
  try { if (sessionStorage.getItem(openKey) === '1') setOpen(true); } catch (e) {}
})();
