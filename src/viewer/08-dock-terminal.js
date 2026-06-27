// ===== Bottom dock: merged-prompt / memo / terminal share ONE docked slot below the editor =====
// Only one is visible at a time — opening one closes the others (the terminal included). Cmd/Ctrl+Shift+'
// maximizes the active dock over the editor area (the sidebar stays). A top resizer drags the height.
var dockHeightKey = 'monacori-dock-height';
var dockMaximized = false;
function applyDockHeight(px) {
  var h = Math.max(140, Math.min(px, window.innerHeight - 120));
  document.documentElement.style.setProperty('--dock-height', h + 'px');
}
(function () { var s = parseInt(localStorage.getItem(dockHeightKey) || '', 10); if (s) applyDockHeight(s); })();
// The dock panel currently filling the slot: a merged/memo panel, else the terminal when it's open.
function activeDockPanel() {
  var mm = document.getElementById('mc-merged-panel') || document.getElementById('mc-memo-panel');
  if (mm) return mm;
  var term = document.getElementById('terminal-panel');
  return (term && !term.classList.contains('hidden')) ? term : null;
}
function applyDockMaximized() {
  if (!activeDockPanel()) dockMaximized = false; // nothing docked -> can't stay maximized
  document.body.classList.toggle('dock-maximized', dockMaximized);
}
function toggleDockMaximized() {
  // Maximize only the panel you're FOCUSED in: the merged/memo dock (.dock-panel) or the terminal
  // (.terminal-panel). From the sidebar tree (treeFocusIndex >= 0) or the diff/source content this is a
  // no-op — pressing it there must NOT maximize a terminal you aren't actually in.
  if (treeFocusIndex >= 0) return;
  var ae = document.activeElement;
  if (!(ae && ae.closest && (ae.closest('.dock-panel') || ae.closest('.terminal-panel')))) return;
  if (!activeDockPanel()) return; // nothing docked -> nothing to maximize
  dockMaximized = !dockMaximized;
  applyDockMaximized();
}
function isDockFocused() {
  var ae = document.activeElement;
  return !!(ae && ae.closest && ae.closest('.dock-panel'));
}
// Close the merged/memo docks (the terminal's setOpen also calls this so the slot stays exclusive).
function closeMergedMemoDocks() {
  var m = document.getElementById('mc-merged-panel'); if (m) m.remove();
  var n = document.getElementById('mc-memo-panel'); if (n) n.remove();
  document.querySelectorAll('.dock-backdrop').forEach(function (b) { b.remove(); });
  document.body.classList.toggle('dock-open', !!activeDockPanel());
  // floating-dock tracks merged/memo only (NOT the terminal) so the maximize CSS hides content for a
  // terminal dock but never for these floating panels.
  document.body.classList.toggle('floating-dock', !!(document.getElementById('mc-merged-panel') || document.getElementById('mc-memo-panel')));
  applyDockMaximized();
  if (typeof syncRail === 'function') syncRail(); // clear the rail icon for the closed dock(s)
}
window.__monacoriCloseDocks = closeMergedMemoDocks;
// Retry-focus a docked field (Electron async-restores focus to <body>, so a one-shot focus can lose the race).
function focusDockField(field, panelSel) {
  var tries = 0;
  var tryF = function () {
    if (!document.querySelector(panelSel)) return true;
    if (document.activeElement === field) return true;
    try { field.focus(); } catch (e) {}
    return document.activeElement === field;
  };
  if (!tryF()) { var iv = setInterval(function () { if (tryF() || ++tries > 12) clearInterval(iv); }, 25); }
}
// Build a docked panel shell (resizer + bar with Maximize/Close + body) and mount it below the editor.
// Opening it closes the terminal and any other merged/memo dock (the slot is exclusive). Returns
// { panel, body, bar, close }.
function mountDock(id, titleText) {
  if (window.__monacoriTerminal && typeof window.__monacoriTerminal.close === 'function') {
    try { window.__monacoriTerminal.close(); } catch (e) {}
  }
  var prior = document.getElementById(id);
  if (prior) prior.remove();
  closeMergedMemoDocks();
  var panel = document.createElement('div');
  panel.id = id;
  panel.className = 'dock-panel';
  panel.tabIndex = -1;
  // The panel floats over the editor; a dim backdrop sits behind it (click to dismiss).
  var backdrop = document.createElement('div');
  backdrop.className = 'dock-backdrop';
  var resizer = document.createElement('div');
  resizer.className = 'dock-resizer';
  resizer.setAttribute('aria-hidden', 'true');
  var bar = document.createElement('div');
  bar.className = 'dock-bar';
  var title = document.createElement('span');
  title.className = 'dock-title';
  title.textContent = titleText;
  var maxBtn = document.createElement('button');
  maxBtn.type = 'button';
  maxBtn.className = 'dock-btn dock-max';
  maxBtn.setAttribute('data-i18n-title', 'dock.maximize');
  maxBtn.title = t('dock.maximize');
  maxBtn.textContent = '⤢'; // ⤢ maximize glyph
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dock-btn dock-close';
  closeBtn.setAttribute('data-i18n', 'merged.close');
  closeBtn.textContent = t('merged.close');
  var body = document.createElement('div');
  body.className = 'dock-body';
  bar.appendChild(title);
  bar.appendChild(maxBtn);
  bar.appendChild(closeBtn);
  panel.appendChild(resizer);
  panel.appendChild(bar);
  panel.appendChild(body);
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  function close() { panel.remove(); backdrop.remove(); closeMergedMemoDocks(); }
  maxBtn.addEventListener('click', function () { toggleDockMaximized(); });
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close); // click the dim behind the panel to dismiss
  // Esc closes the dock when focus is inside it; the editor keeps its own handlers otherwise.
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  resizer.addEventListener('mousedown', function (e) {
    e.preventDefault();
    resizer.classList.add('resizing');
    function move(ev) { applyDockHeight(window.innerHeight - ev.clientY); }
    function up() {
      resizer.classList.remove('resizing');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      var cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-height'), 10);
      if (cur) { try { localStorage.setItem(dockHeightKey, String(cur)); } catch (x) {} }
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  document.body.classList.add('dock-open');
  document.body.classList.add('floating-dock'); // scopes the maximize CSS so it doesn't hide the diff
  applyDockMaximized();
  if (typeof syncRail === 'function') syncRail(); // light up the rail icon for the opened dock
  return { panel: panel, body: body, bar: bar, close: close };
}

function openMergedView(kind) {
  var dock = mountDock('mc-merged-panel', kind === 'q' ? t('merged.qTitle') : t('merged.cTitle'));
  dock.panel.dataset.kind = kind; // remembered so a live locale switch can re-render this same view
  var area = document.createElement('textarea');
  area.className = 'mc-modal-text';
  // NOT readOnly: a readOnly textarea hides the caret in Chromium, yet we need it VISIBLE so the user sees
  // which comment Opt+Enter / Opt+Arrow will target. Block every edit via beforeinput instead.
  area.value = buildMergedText(kind);
  area.addEventListener('beforeinput', function (e) { e.preventDefault(); });
  // Opt/Alt+Enter on the merged text: a custom dropdown for the comment under the caret. Opt/Alt+Arrow steps
  // the caret comment-to-comment so each can be acted on without hand-scrolling.
  area.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      e.stopPropagation();
      jumpMergedComment(area, e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (!e.altKey || (e.key !== 'Enter' && e.code !== 'Enter')) return;
    e.preventDefault();
    e.stopPropagation();
    var seqs = mergedCommentSeqs(kind, area.selectionStart, area.selectionEnd);
    if (!seqs.length) return;
    var cxy = mergedCaretXY(area);
    var x = cxy.x, y = cxy.below, flipTop = cxy.top;
    var rerender = function () {
      if (!reviewComments.filter(function (c) { return c.kind === kind; }).length) { dock.close(); return; }
      area.value = buildMergedText(kind);
    };
    if (area.selectionStart !== area.selectionEnd || seqs.length > 1) {
      // Select-all / multi-comment: offer send-to-terminal (the whole merged text) FIRST, then remove-all.
      var multi = [];
      if (window.__monacoriTerminal && typeof window.__monacoriTerminal.paneCount === 'function' && window.__monacoriTerminal.paneCount() > 0) {
        multi.push({ label: t('merged.sendToTerminal'), onSelect: function () { var text = buildMergedText(kind); dock.close(); window.__monacoriTerminal.enterSendMode(text); } });
      }
      multi.push({ label: t('dropdown.remove'), onSelect: function () { seqs.forEach(deleteComment); rerender(); } });
      showCustomDropdown(x, y, multi, flipTop);
    } else {
      var seq = seqs[0];
      showCustomDropdown(x, y, [
        { label: t('dropdown.navigate'), onSelect: function () { dock.close(); navigateToComment(seq); } },
        { label: t('dropdown.remove'), onSelect: function () { deleteComment(seq); rerender(); } },
      ], flipTop);
    }
  });
  dock.body.appendChild(area);
  // Focus the read-only text so the caret is visible and Opt+Arrow / Opt+Enter work; retry (Electron focus race).
  focusDockField(area, '#mc-merged-panel');
}

// Prompt memo (Cmd/Ctrl+Shift+N): one freeform Markdown scratchpad with a live split preview, persisted
// across reopens via the same store as comments/locale. "Send to terminal" hands the current draft to the
// same pane-pick mode the merged views use, so a half-formed prompt can target any live claude/codex session.
var memoKey = 'monacori-memo';
function loadMemo() {
  var v = persistRead(memoKey);
  if (typeof v === 'string') return v;
  try { var s = localStorage.getItem(memoKey); return typeof s === 'string' ? s : ''; } catch (e) { return ''; }
}
function saveMemo(text) { persistSave(memoKey, text || ''); }
function renderMemoMd(text) {
  if (!text || !text.trim()) return '<div class="mc-memo-empty" data-i18n="memo.previewEmpty">' + escapeHtml(t('memo.previewEmpty')) + '</div>';
  return renderMarkdownBlocks(text).map(function (b) { return b.html; }).join('');
}
function openMemoView() {
  if (document.getElementById('mc-memo-panel')) { closeMergedMemoDocks(); return; } // the shortcut toggles: 2nd press closes
  var dock = mountDock('mc-memo-panel', t('memo.title'));
  var memoBody = document.createElement('div');
  memoBody.className = 'mc-memo-body';
  var area = document.createElement('textarea');
  area.className = 'mc-modal-text mc-memo-edit';
  area.spellcheck = false;
  area.setAttribute('data-i18n-ph', 'memo.placeholder');
  area.placeholder = t('memo.placeholder');
  area.value = loadMemo();
  var preview = document.createElement('div');
  preview.className = 'md-cell mc-memo-preview';
  preview.innerHTML = renderMemoMd(area.value);
  area.addEventListener('input', function () {
    saveMemo(area.value);
    preview.innerHTML = renderMemoMd(area.value);
  });
  // Terminal send: hand the current draft to pane-pick mode. Shown only once a terminal pane exists;
  // enterSendMode reopens the terminal (which closes this memo dock — the slot is exclusive).
  if (window.__monacoriTerminal && typeof window.__monacoriTerminal.paneCount === 'function' && window.__monacoriTerminal.paneCount() > 0) {
    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'dock-btn mc-send-term';
    sendBtn.setAttribute('data-i18n', 'merged.sendToTerminal');
    sendBtn.textContent = t('merged.sendToTerminal');
    sendBtn.addEventListener('click', function () {
      var text = area.value;
      dock.close();
      window.__monacoriTerminal.enterSendMode(text);
    });
    dock.bar.insertBefore(sendBtn, dock.bar.querySelector('.dock-max'));
  }
  memoBody.appendChild(area);
  memoBody.appendChild(preview);
  dock.body.appendChild(memoBody);
  focusDockField(area, '#mc-memo-panel');
}

document.addEventListener('click', function (event) {
  var t = event.target;
  if (!t || !t.closest) return;
  var del = t.closest('.mc-del');
  if (del) { event.preventDefault(); deleteComment(parseInt(del.dataset.seq, 10)); return; }
  if (t.closest('.mc-save')) { event.preventDefault(); saveComposer(); return; }
  if (t.closest('.mc-cancel')) { event.preventDefault(); closeComposer(); return; }
});
document.addEventListener('keydown', function (event) {
  var t = event.target;
  if (!t || !t.classList || !t.classList.contains('mc-input')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeComposer(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveComposer(t); return; }
}, true);

refreshComments();


// Integrated terminal (Electron only): xterm panes wired to node-pty sessions in the main process.
// Toggle with Ctrl+` / Opt+F12 / the footer ⌗ button; Cmd/Ctrl+D splits the active pane (side by side,
// no tabs); drag the top edge to resize. window.__monacoriTerminal pipes the merged prompt into the
// active pane. Cmd combos are released back to the app so shortcuts like Cmd+1 don't get stuck typing.
(function setupTerminal() {
  if (!window.monacoriPty) return; // xterm (window.Terminal) is loaded lazily on first open
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
  var MAX_PANES = 4;
  var heightKey = 'monacori-terminal-height';
  var openKey = 'monacori-terminal-open:' + location.pathname;

  function applyHeight(px) {
    var h = Math.max(120, Math.min(px, window.innerHeight - 120));
    document.documentElement.style.setProperty('--terminal-height', h + 'px');
  }
  var savedH = parseInt(localStorage.getItem(heightKey) || '', 10);
  if (savedH) applyHeight(savedH);

  function fitPane(p) {
    if (!p) return;
    try { p.fit.fit(); if (p.id != null) window.monacoriPty.resize({ id: p.id, cols: p.term.cols, rows: p.term.rows }); } catch (e) {}
  }
  function fitAll() { panes.forEach(fitPane); }

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
    try { if (window.monacoriClipboard && window.monacoriClipboard.write) { window.monacoriClipboard.write(text); return; } } catch (e) {}
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text); } catch (e) {}
  }
  function makePane() {
    if (!ensureXterm()) return null; // xterm unavailable — leave the panel empty rather than throw
    var el = document.createElement('div');
    el.className = 'terminal-pane';
    var labelEl = document.createElement('div');
    labelEl.className = 'terminal-pane-label';
    var paneHost = document.createElement('div');
    paneHost.className = 'terminal-pane-host';
    el.appendChild(labelEl);
    el.appendChild(paneHost);
    host.appendChild(el);
    var term = new window.Terminal({
      fontSize: 12,
      fontFamily: 'Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#161616', foreground: '#a9b7c6', cursor: '#a9b7c6', selectionBackground: '#214283' },
      cursorBlink: true,
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(paneHost);
    var pane = { id: null, term: term, fit: fit, el: el, labelEl: labelEl, name: 'Terminal ' + (panes.length + 1) };
    labelEl.textContent = pane.name;
    // Cmd combos are app shortcuts (Cmd+1/0 tab switch, Cmd+B go-to-def, …). Release the terminal and let
    // them bubble to the document handler instead of typing into the shell (fixes "Cmd+1 stuck in term").
    // Exception: keep focus for clipboard/selection combos (Cmd+C/V/X/A) so the terminal's own copy &
    // paste keep working — blurring on Cmd+V drops the textarea focus the paste event needs.
    term.attachCustomKeyEventHandler(function (e) {
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
        try { term.blur(); } catch (x) {}
        return false;
      }
      return true;
    });
    term.onData(function (d) { if (pane.id != null) window.monacoriPty.write({ id: pane.id, data: d }); });
    // Bell from the pane's TUI (e.g. Claude Code finished a turn / needs input): badge the pane when it isn't
    // the one you're looking at, and ask the main process to raise a native notification when the whole window
    // isn't focused. Toggle in Settings ("Notify when a terminal task finishes").
    term.onBell(function () {
      if (pane !== active && pane.labelEl) pane.labelEl.classList.add('has-bell');
      if (persistRead('monacori-terminal-bell-notify') === false) return; // OS notifications disabled
      try { window.monacoriPty.bell({ title: 'monacori', body: pane.name + ' — ' + t('notify.bellBody') }); } catch (e) {}
    });
    el.addEventListener('mousedown', function (e) { if (e.target !== labelEl) setActive(pane); });
    labelEl.addEventListener('dblclick', function () { renamePane(pane); });
    panes.push(pane);
    try { fit.fit(); } catch (e) {}
    window.monacoriPty.spawn({ cols: term.cols || 80, rows: term.rows || 24 }).then(function (r) { pane.id = r && r.id; });
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
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    panes.splice(i, 1);
    if (active === p) setActive(panes[panes.length - 1] || null);
    if (panes.length === 0) setOpen(false);
    else fitAll();
  }
  // Cmd/Ctrl+W inside the terminal: close just the FOCUSED pane (kill its pty), not the whole panel. The
  // last pane closing collapses the panel via removePaneRef -> setOpen(false). Remove the pane immediately
  // (don't wait for the pty's onExit) so the UI responds at once; the later onExit -> removePane no-ops.
  function closeActivePane() {
    var p = active || panes[panes.length - 1];
    if (!p) { setOpen(false); return; }
    if (p.id != null) { try { window.monacoriPty.kill({ id: p.id }); } catch (e) {} }
    removePaneRef(p);
  }

  function split() {
    if (panes.length >= MAX_PANES) return;
    makePane();
    fitAll();
  }
  // Move active focus between split panes (menu accelerators Cmd/Ctrl+Alt+[ and ]).
  function focusPaneByDelta(delta) {
    if (panes.length < 2) return;
    var i = panes.indexOf(active);
    if (i < 0) i = 0;
    setActive(panes[(i + delta + panes.length) % panes.length]);
  }

  // Route per-pane pty output / exit by id (registered once for the window).
  window.monacoriPty.onData(function (msg) {
    for (var k = 0; k < panes.length; k++) { if (panes[k].id === msg.id) { panes[k].term.write(msg.data); return; } }
  });
  window.monacoriPty.onExit(function (msg) { removePane(msg.id); });

  function isOpen() { return !panel.classList.contains('hidden'); }
  function setOpen(open) {
    // The terminal shares the bottom dock slot with merged/memo — opening it closes those (exclusive slot).
    if (open && typeof window.__monacoriCloseDocks === 'function') { try { window.__monacoriCloseDocks(); } catch (e) {} }
    panel.classList.toggle('hidden', !open);
    document.body.classList.toggle('terminal-open', open);
    if (toggleBtn) toggleBtn.classList.toggle('is-active', open);
    try { sessionStorage.setItem(openKey, open ? '1' : '0'); } catch (e) {}
    if (typeof applyDockMaximized === 'function') applyDockMaximized(); // keep Cmd+Shift+' maximize in sync
    if (open) {
      if (panes.length === 0) makePane();
      requestAnimationFrame(function () { fitAll(); if (active) try { active.term.focus(); } catch (e) {} });
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
    if (active) { try { active.term.focus(); } catch (e) {} } // visible but unfocused → just grab focus
  }

  if (toggleBtn) toggleBtn.addEventListener('click', toggle);
  if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
  // Toggle (Ctrl+`/Alt+F12) and split (Cmd+D) arrive from the Terminal menu accelerators (app-main),
  // because Chromium swallows Cmd+D before a renderer keydown would ever see it.
  if (window.monacoriMenu && typeof window.monacoriMenu.onTerminalToggle === 'function') window.monacoriMenu.onTerminalToggle(toggleOrFocus);
  if (window.monacoriMenu && typeof window.monacoriMenu.onTerminalSplit === 'function') window.monacoriMenu.onTerminalSplit(split);
  if (window.monacoriMenu && typeof window.monacoriMenu.onTerminalPaneFocus === 'function') window.monacoriMenu.onTerminalPaneFocus(focusPaneByDelta);
  if (window.monacoriMenu && typeof window.monacoriMenu.onTerminalPaneRename === 'function') window.monacoriMenu.onTerminalPaneRename(function () { renamePane(active); });

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
    panes.forEach(function (p) { if (p.id != null) { try { window.monacoriPty.kill({ id: p.id }); } catch (e) {} } });
  });

  // Hook for the merged-prompt modal: pipe the combined text into a chosen pane (no trailing Enter —
  // the user reviews in the live session, then presses Enter, so multiline prompts stay intact).
  function writeToPane(p, text) {
    if (!p) return;
    setOpen(true);
    if (p.id != null) window.monacoriPty.write({ id: p.id, data: text });
    setActive(p);
    requestAnimationFrame(function () { try { p.term.focus(); } catch (e) {} });
  }
  // Pane-pick mode: triggered from the merged modal's "Send to terminal". The chosen pane is highlighted,
  // the rest are dimmed; arrows change the pick, Enter sends, Esc cancels. Single pane → send at once.
  var sendModeText = null, sendModeIdx = 0;
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
  }
  function enterSendMode(text) {
    if (panes.length === 0) return;
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
  window.__monacoriTerminal = {
    isOpen: isOpen,
    // True when keyboard focus is inside the terminal panel (a pane owns it) — Cmd/Ctrl+W uses this to
    // decide between closing a pane and closing a source tab.
    hasFocus: function () { var ae = document.activeElement; return !!(ae && panel.contains(ae)); },
    open: function () { setOpen(true); },
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

// In Electron, the Review menu's Cmd/Ctrl+Shift+/ and +. accelerators arrive here via IPC
// (macOS reserves Cmd+? for its Help search, so the menu claims it and routes to these views).
if (window.monacoriMenu && typeof window.monacoriMenu.onMergedView === 'function') {
  // Always open the merged-view modal; sending to a terminal pane is a button inside it (per-pane when
  // split), so the user can pick which claude/codex session receives the prompt.
  window.monacoriMenu.onMergedView(function (kind) { openMergedView(kind); });
}
if (window.monacoriMenu && typeof window.monacoriMenu.onOpenMemo === 'function') {
  // Cmd/Ctrl+Shift+N from the Review menu -> open/close the prompt memo.
  window.monacoriMenu.onOpenMemo(function () { openMemoView(); });
}
if (window.monacoriMenu && typeof window.monacoriMenu.onDiffUpdate === 'function') {
  // Electron watch: main rebuilds on working-tree changes and pushes the new HTML so we refresh the diff
  // in place — NO window reload — keeping the integrated terminal's pty sessions (claude/codex) alive.
  window.monacoriMenu.onDiffUpdate(function (html) { try { applyDiffUpdate(html); } catch (e) {} });
}
if (window.monacoriMenu && typeof window.monacoriMenu.onCloseTab === 'function') {
  // Cmd/Ctrl+W: close whatever the focus is on. A focused terminal pane closes just that pane (the last
  // pane collapses the panel); otherwise close the active Files-mode tab (no-op outside the source viewer).
  window.monacoriMenu.onCloseTab(function () {
    var term = window.__monacoriTerminal;
    if (term && term.isOpen() && term.hasFocus()) { term.closeActivePane(); return; }
    if (isSourceViewerVisible()) closeActiveSourceTab();
  });
}

(function checkForUpdate() {
  var current = window.__MONACORI_VERSION__ || '';
  if (!current) return;
  var isNewer = function (a, b) {
    var pa = String(a).split('.'), pb = String(b).split('.');
    for (var i = 0; i < 3; i++) {
      var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  };
  var apply = function (latest) {
    if (!latest) return;
    var status = document.getElementById('app-info-status');
    if (isNewer(latest, current)) {
      var flag = document.getElementById('app-update-flag');
      if (flag) flag.classList.remove('hidden');
      // One-click auto-update needs the Electron main process (it spawns npm). When available, reveal the
      // button so a click installs + restarts; otherwise (browser/static export) name the command instead.
      var ub = document.getElementById('app-info-update');
      if (ub && window.monacoriUpdate && typeof window.monacoriUpdate.run === 'function') {
        ub.textContent = t('settings.updateRestart') + ' (v' + latest + ')';
        ub.classList.remove('hidden');
        if (status) { status.textContent = t('settings.updateAvailable') + ': v' + latest; status.classList.add('has-update'); }
      } else if (status) {
        status.textContent = t('settings.updateAvailable') + ': v' + latest + ' — npm i -g @happy-nut/monacori';
        status.classList.add('has-update');
      }
    } else if (status) {
      status.textContent = t('settings.upToDate') + ' (v' + current + ')';
    }
  };
  // Cache the npm result for the session so watch-mode reloads reuse it instead of refetching.
  var cached = '';
  try { cached = sessionStorage.getItem('monacori-update-latest') || ''; } catch (e) {}
  if (cached) { apply(cached); return; }
  if (typeof fetch !== 'function') return;
  fetch('https://registry.npmjs.org/@happy-nut/monacori/latest', { cache: 'no-store' })
    .then(function (res) { return res && res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.version) return;
      try { sessionStorage.setItem('monacori-update-latest', data.version); } catch (e) {}
      apply(data.version);
    })
    .catch(function () {});
})();

// Unified settings modal: the sidebar-footer gear opens it (General category by default), with
// About/update/shortcuts under General and the merge-prompt editor under Merge prompts.
(function setupSettings() {
  var modal = document.getElementById('settings-modal');
  if (!modal) return;
  var gearBtn = document.getElementById('app-info-btn');
  var flag = document.getElementById('app-update-flag');
  var updateBtn = document.getElementById('app-info-update');
  var qta = document.getElementById('settings-prompt-q');
  var cta = document.getElementById('settings-prompt-c');
  var resetBtn = document.getElementById('settings-reset');
  var savedMsg = document.getElementById('settings-saved');
  var cats = Array.prototype.slice.call(modal.querySelectorAll('.settings-cat'));
  var secs = Array.prototype.slice.call(modal.querySelectorAll('.settings-section'));
  function showCat(cat) {
    cats.forEach(function (c) { c.classList.toggle('active', c.dataset.cat === cat); });
    secs.forEach(function (s) { s.classList.toggle('hidden', s.dataset.cat !== cat); });
  }
  function fill() {
    var s = loadMergePrompts();
    if (qta) { qta.value = typeof s.q === 'string' ? s.q : ''; qta.placeholder = defaultMergePrompt('q'); }
    if (cta) { cta.value = typeof s.c === 'string' ? s.c : ''; cta.placeholder = defaultMergePrompt('c'); }
  }
  function open(cat) { fill(); if (cat) showCat(cat); modal.classList.remove('hidden'); }
  function close() { modal.classList.add('hidden'); }
  var flashTimer = null;
  function flash() { if (!savedMsg) return; savedMsg.textContent = 'Saved'; if (flashTimer) clearTimeout(flashTimer); flashTimer = setTimeout(function () { savedMsg.textContent = ''; }, 1200); }
  if (gearBtn) gearBtn.addEventListener('click', function (e) { e.stopPropagation(); if (modal.classList.contains('hidden')) open('general'); else close(); });
  if (flag) flag.addEventListener('click', function (e) { e.stopPropagation(); open('general'); });
  cats.forEach(function (c) { c.addEventListener('click', function () { showCat(c.dataset.cat); }); });
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  // Capture so closing settings wins over other Escape handlers (lightbox / composer).
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) { e.stopPropagation(); e.preventDefault(); close(); return; }
    // Cmd/Ctrl+, (the standard "Preferences" accelerator) toggles the settings panel from anywhere — but not
    // while another floating overlay (merged / memo) owns focus; that one must be Esc'd first.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === ',' || e.code === 'Comma')) {
      if (modal.classList.contains('hidden') && (document.getElementById('mc-modal') || document.getElementById('mc-memo'))) return;
      e.preventDefault(); e.stopPropagation();
      if (modal.classList.contains('hidden')) open('general'); else close();
    }
  }, true);
  // One-click self-update (Electron only): install latest globally via the main process, then relaunch.
  if (updateBtn && window.monacoriUpdate && typeof window.monacoriUpdate.run === 'function') {
    updateBtn.addEventListener('click', function () {
      if (updateBtn.disabled) return;
      updateBtn.disabled = true;
      var status = document.getElementById('app-info-status');
      if (status) { status.textContent = t('settings.updating'); status.classList.add('has-update'); }
      window.monacoriUpdate.run().then(function (r) {
        if (r && r.ok) { if (status) status.textContent = t('settings.updated'); }
        else { updateBtn.disabled = false; if (status) status.textContent = t('settings.updateFailed'); }
      }).catch(function () { updateBtn.disabled = false; if (status) status.textContent = t('settings.updateFailed'); });
    });
  }
  if (qta) qta.addEventListener('input', function () { saveMergePrompt('q', qta.value); flash(); });
  if (cta) cta.addEventListener('input', function () { saveMergePrompt('c', cta.value); flash(); });
  if (resetBtn) resetBtn.addEventListener('click', function () { saveMergePrompt('q', ''); saveMergePrompt('c', ''); fill(); flash(); });
  // Terminal-bell notification toggle (default ON — persistRead returns undefined when never set).
  var bellCb = document.getElementById('set-bell-notify');
  if (bellCb) {
    bellCb.checked = persistRead('monacori-terminal-bell-notify') !== false;
    bellCb.addEventListener('change', function () { persistSave('monacori-terminal-bell-notify', bellCb.checked); });
  }
  // Language: live-switch the whole UI (no reload). Persist, re-apply the static chrome, then re-render
  // any currently-shown dynamic text (open composer / merged modal / index status) so it follows too.
  langSelectRef = setupCustomSelect('settings-language',
    function () { return [{ value: 'en', label: 'English' }, { value: 'ko', label: '한국어' }]; },
    function () { return locale; },
    function (next) {
      if (next === locale) return;
      locale = next;
      persistSave(LOCALE_KEY, locale);
      applyI18n();
      fill(); // merge-prompt placeholders are locale-dependent defaults
      try { if (typeof refreshComments === 'function') refreshComments(); } catch (e) {}
      var mergedModal = document.getElementById('mc-modal');
      if (mergedModal) { var mk = mergedModal.dataset.kind || 'q'; mergedModal.remove(); openMergedView(mk); }
    });
  themeSelectRef = setupCustomSelect('settings-theme',
    function () { return [{ value: 'dark', label: t('theme.dark') }, { value: 'light', label: t('theme.light') }]; },
    function () { return theme; },
    function (next) {
      if (next === theme) return;
      theme = next;
      persistSave(THEME_KEY, theme);
      applyTheme();
    });
})();

