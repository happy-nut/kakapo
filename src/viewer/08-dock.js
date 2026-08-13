// ===== Bottom dock: merged-prompt and memo share one docked slot below the editor =====
// Only one is visible at a time. Cmd/Ctrl+Shift+' maximizes the active dock over the editor area.
var dockHeightKey = 'kakapo-dock-height';
var dockMaximized = false;
// Assigned once the settings panel is built (see below); read by the KEY_OWNERS table in 05-keymap.js,
// which loads first and so tests it with `typeof`.
var handleSettingsKey;
function applyDockHeight(px) {
  var h = Math.max(140, Math.min(px, window.innerHeight - 120));
  document.documentElement.style.setProperty('--dock-height', h + 'px');
}
(function () { var s = parseInt(persistRead(dockHeightKey) || localStorage.getItem(dockHeightKey) || '', 10); if (s) applyDockHeight(s); })();
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
// "The keys belong to a panel, not to the editor." The terminal counts: every keystroke there is going to a
// running program, so the global shortcuts below the keymap's focus guard must stand down — Cmd+E used to
// drop the Recent-files dialog over a shell mid-command, and that dialog is a modal keyboard scope, so it
// then swallowed everything until dismissed. The shortcuts placed ABOVE that guard (Cmd+0/1/7/8/9, the dock
// toggles) still work from the terminal, as does Ctrl+` — that one is the shell window's, not the page's.
function isDockFocused() {
  var ae = document.activeElement;
  return !!(ae && ae.closest && (ae.closest('.dock-panel') || ae.closest('.terminal-panel')));
}
// Close the merged/memo docks.
function closeMergedMemoDocks() {
  var m = document.getElementById('mc-merged-panel');
  var n = document.getElementById('mc-memo-panel');
  var hadDock = !!(m || n);
  [m, n].forEach(function (panel) {
    if (!panel) return;
    try { if (typeof panel.__kakapoBeforeClose === 'function') panel.__kakapoBeforeClose(); } catch (e) {}
    panel.remove();
  });
  document.querySelectorAll('.dock-backdrop').forEach(function (b) { b.remove(); });
  document.body.classList.toggle('dock-open', !!activeDockPanel());
  document.body.classList.toggle('floating-dock', !!(document.getElementById('mc-merged-panel') || document.getElementById('mc-memo-panel')));
  applyDockMaximized();
  if (typeof syncRail === 'function') syncRail(); // clear the rail icon for the closed dock(s)
  // The merged view reconciles/prunes comments while open; re-render the diff/source cards so the reviewer's
  // comments are visible again the instant the dock closes and never appear to vanish behind it.
  if (hadDock && typeof refreshComments === 'function') { try { refreshComments(); } catch (e) {} }
}
window.__kakapoCloseDocks = closeMergedMemoDocks;
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
// Opening it closes the integrated terminal so the docked slot stays exclusive.
function mountDock(id, titleText) {
  if (window.__kakapoTerminal && typeof window.__kakapoTerminal.close === 'function') {
    try { window.__kakapoTerminal.close(); } catch (e) {}
  }
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
  maxBtn.dataset.keyhint = "⌘⇧'";
  maxBtn.setAttribute('data-i18n-title', 'dock.maximize');
  maxBtn.title = t('dock.maximize');
  maxBtn.textContent = '⤢'; // ⤢ maximize glyph
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dock-btn dock-close';
  closeBtn.dataset.keyhint = 'Esc';
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
  function close() { closeMergedMemoDocks(); }
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
      if (cur) persistSave(dockHeightKey, String(cur));
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

function openMergedView() {
  if (pruneCommentsForMissingFiles()) refreshComments();
  // Claim Cmd+A/Cmd+C from the app menu's native accelerators (role: "editMenu" in app-main.ts) for as long
  // as this dock is open, so only this panel's own keydown handling responds — see handleMergedKeydown and
  // the setIgnoreMenuShortcuts IPC handler in app-main.ts for why the native accelerator otherwise races it.
  if (window.kakapoApp && typeof window.kakapoApp.setIgnoreMenuShortcuts === 'function') window.kakapoApp.setIgnoreMenuShortcuts(true);
  var dock = mountDock('mc-merged-panel', t('merged.title'));
  var mergedBody = document.createElement('div');
  mergedBody.className = 'mc-merged-body';
  var host = document.createElement('div');
  host.className = 'mc-inline-editor-host mc-merged-editor-host';
  host.innerHTML = loadingStateHtml(t('history.loading'), 'mc-memo-empty');
  mergedBody.appendChild(host);
  dock.body.appendChild(mergedBody);
  var validatingCommentFiles = true;
  var blocks = [];   // mergedBlocks() snapshot captured once, at build time
  var editors = [];  // [{ region, editor }] — one per block's prose, in document order
  var selectedCard = null;

  // The alternating top-level children of `host`: an editor region per block, one non-editable card per
  // comment right after it. Arrow-key handoff and Enter both walk this list, not reviewComments directly,
  // so behavior always matches what's actually on screen.
  function regionNodes() { return Array.prototype.slice.call(host.children); }
  function siblingRegion(node, dir) {
    var kids = regionNodes();
    var i = kids.indexOf(node);
    return i < 0 ? null : (kids[i + dir] || null);
  }
  function editorEntryForRegion(region) {
    return editors.find(function (entry) { return entry.region === region; });
  }
  function deselectCard() {
    if (!selectedCard) return;
    selectedCard.classList.remove('selected');
    selectedCard.setAttribute('aria-selected', 'false');
    selectedCard = null;
  }
  function selectCard(card, shouldFocus) {
    deselectCard();
    if (!card) return;
    selectedCard = card;
    card.classList.add('selected');
    card.setAttribute('aria-selected', 'true');
    if (shouldFocus) { card.focus(); card.scrollIntoView({ block: 'nearest' }); }
  }
  function clearSelectAll() { host.classList.remove('mc-merged-select-all'); }
  // Land on whichever kind of region comes next: a card is selected outright; an editor is focused at the
  // edge you're entering from (its 'start' when arriving from above, 'end' from below) so the caret picks up
  // exactly where a real multi-block document would put it.
  function focusRegion(node, edge) {
    if (!node) return;
    if (node.classList.contains('mc-merged-card')) { selectCard(node, true); return; }
    var entry = editorEntryForRegion(node);
    if (entry) { deselectCard(); entry.editor.focus(edge); }
  }
  function terminalAvailable() {
    return !!(window.__kakapoTerminal && typeof window.__kakapoTerminal.enterSendMode === 'function');
  }
  // Assemble the CURRENT text: each block's prose is read live from its editor (so in-panel edits to the
  // agent contracts are respected), each comment's body is read straight from reviewComments (comments are
  // never edited by typing here — see mergedCardHtml). Mirrors buildMergedText's exact line structure.
  function currentMergedText() {
    var nl = String.fromCharCode(10);
    var lines = [];
    blocks.forEach(function (block, index) {
      var entry = editors[index];
      var prose = entry ? entry.editor.getMarkdown() : block.prose;
      if (!prose && !block.items.length) return;
      if (prose) { lines.push(prose); lines.push(''); }
      block.items.forEach(function (c) { lines.push.apply(lines, mergedItemLines(c)); });
    });
    return lines.join(nl);
  }
  // Send the merged prompt into a terminal pane (v0.2.7): arrows choose the pane, Enter sends. Available
  // whenever the integrated terminal exists; if no pane is open yet, one is created first.
  //
  // Issue #10: the document leads with the path of the thread file (comments-file.ts) and how to answer into
  // it — the agent appends one line per reply, which lands back in the thread beside the code it is about,
  // instead of an answer that only ever existed as terminal output. The file itself is already up to date
  // (saveThread runs on every comment change), so nothing has to be written here. The text is captured
  // BEFORE dock.close() — closing destroys the live editors currentMergedText() reads from.
  //
  // What crosses into the pane is the PATH of that document, not the document. Every byte of it was already on
  // disk, so pasting the whole thing sent the review a second time — and once a comment had a few turns quoted
  // under it, that paste was kilobytes of composer input for a request the agent can open in one read. Writing
  // it out first also means the agent reads the state at the moment it looks, not at the moment you pressed
  // send. Where there is no file to write to (a non-git root, or the CLI's browser viewer), the document goes
  // over as text exactly as it always did.
  function sendWholeDocToTerminal() {
    var text = currentMergedText();
    dock.close();
    var path = typeof annotationsPath === 'string' ? annotationsPath : '';
    var doc = path ? t('mergePrompt.answersFile') + '\n' + path + '\n\n' + text : text;
    var writeRequest = window.kakapoComments && typeof window.kakapoComments.writeRequest === 'function'
      ? window.kakapoComments.writeRequest(doc)
      : Promise.resolve(null);
    writeRequest.catch(function () { return null; }).then(function (result) {
      var ok = result && result.ok && result.path;
      window.__kakapoTerminal.enterSendMode(ok ? t('mergePrompt.requestFile') + ' ' + result.path : doc);
    });
  }
  // Shared by the Copy-all button and Cmd+C-after-Cmd+A (see handleMergedKeydown) so both paths copy the
  // exact same assembled text.
  function copyMergedText() {
    var copied = typeof copyTextToClipboard === 'function' && copyTextToClipboard(currentMergedText());
    if (typeof showToast === 'function') showToast(t(copied ? 'merged.copied' : 'merged.copyFailed'));
  }
  // The app menu keeps the standard Edit role so real text fields still get native Cut/Paste/Undo (see
  // app-main.ts) — but that means Cmd+C is ALSO a native accelerator that fires webContents.copy()
  // independently of this panel's own keydown handling; a renderer-side preventDefault on keydown cannot
  // stop it. Rather than race that native copy, hijack its actual 'copy' ClipboardEvent (fired by
  // execCommand('copy') regardless of which path triggered it) and force our own payload onto it whenever
  // the fake select-all state is active, so Cmd+C is correct no matter what the real DOM selection is.
  function handleNativeCopy(event) {
    if (!host.classList.contains('mc-merged-select-all')) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', currentMergedText());
    if (typeof showToast === 'function') showToast(t('merged.copied'));
  }
  // Deleting the selected card removes it from reviewComments (with the same shared undo stack the
  // diff/source view's row-Backspace uses — Cmd/Ctrl+Z restores it, see 05-keymap.js), then rebuilds the
  // panel so it never shows a stale card list. reselectIndex carries the deleted card's position across the
  // rebuild so the selection lands on whatever now occupies that slot instead of being lost.
  function deleteSelectedCard(card) {
    var cards = Array.prototype.slice.call(host.querySelectorAll('.mc-merged-card'));
    var index = cards.indexOf(card);
    removeComments([parseInt(card.dataset.commentSeq, 10)]);
    refreshComments();
    initializeMergedEditor({ reselectIndex: index });
  }
  function handleMergedKeydown(event) {
    // Holding Cmd between tapping A and C (the normal way to chord Cmd+A -> Cmd+C) makes macOS/Chromium
    // redeliver a bare keydown for the Meta/Control key itself mid-hold — not a real second keystroke. Treating
    // that as "some other key was pressed" cleared the select-all flag before the real Cmd+C keydown arrived,
    // so Cmd+C silently did nothing. A held modifier alone should never count as a deselecting keystroke.
    if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') return;
    var isCmd = event.metaKey || event.ctrlKey;
    if (isCmd && !event.altKey && !event.shiftKey && (event.key === 'a' || event.key === 'A' || event.code === 'KeyA')) {
      event.preventDefault();
      host.classList.add('mc-merged-select-all');
      return;
    }
    if (host.classList.contains('mc-merged-select-all')) {
      if (isCmd && !event.altKey && !event.shiftKey && (event.key === 'c' || event.key === 'C' || event.code === 'KeyC')) {
        event.preventDefault();
        copyMergedText();
        return;
      }
      clearSelectAll();
    }
    // ⌥⏎ hands the whole document over wherever the focus sits inside the panel — the bar's own button, a
    // card, an editor. Scoping it to the card/editor branches below made it dead everywhere else, which is
    // half of why the hand-off looked gone.
    if (event.altKey && (event.key === 'Enter' || event.code === 'Enter') && terminalAvailable()) {
      event.preventDefault();
      sendWholeDocToTerminal();
      return;
    }
    var target = event.target;
    var card = target && target.closest ? target.closest('.mc-merged-card') : null;
    if (card) {
      if (!event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        focusRegion(siblingRegion(card, event.key === 'ArrowDown' ? 1 : -1), event.key === 'ArrowDown' ? 'start' : 'end');
        return;
      }
      if (!event.altKey && (event.key === 'Enter' || event.code === 'Enter')) {
        event.preventDefault();
        var seq = parseInt(card.dataset.commentSeq, 10);
        dock.close();
        navigateToCommentAndEdit(seq);
        return;
      }
      if (!event.altKey && (event.key === 'Backspace' || event.key === 'Delete')) {
        event.preventDefault();
        deleteSelectedCard(card);
        return;
      }
      return;
    }
    var region = target && target.closest ? target.closest('.mc-merged-editor-region') : null;
    var entry = region && editorEntryForRegion(region);
    if (entry) {
      if (!event.altKey && !event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        var dir = event.key === 'ArrowDown' ? 'down' : 'up';
        if (entry.editor.atBoundary(dir)) {
          var sib = siblingRegion(region, dir === 'down' ? 1 : -1);
          if (sib) { event.preventDefault(); focusRegion(sib, dir === 'down' ? 'start' : 'end'); }
        }
        return;
      }
    }
  }
  function handleMergedClick(event) {
    clearSelectAll();
    var card = event.target && event.target.closest ? event.target.closest('.mc-merged-card') : null;
    if (card) { selectCard(card, false); return; }
    deselectCard(); // a click into an editor's prose ends any card selection
  }
  var copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'dock-btn mc-copy-all';
  copyBtn.setAttribute('data-i18n', 'merged.copyAll');
  copyBtn.textContent = t('merged.copyAll');
  copyBtn.disabled = true;
  copyBtn.addEventListener('click', copyMergedText);
  dock.bar.insertBefore(copyBtn, dock.bar.querySelector('.dock-max'));
  // The visible half of the hand-off. Without it the only route into the pane picker was ⌥⏎ with the right
  // thing focused, so "send the merged prompt to a terminal" read as a feature that had been removed.
  var sendBtn = null;
  if (terminalAvailable()) {
    sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'dock-btn mc-send-terminal';
    sendBtn.dataset.keyhint = '⌥⏎';
    sendBtn.setAttribute('data-i18n', 'merged.sendToTerminal');
    sendBtn.textContent = t('merged.sendToTerminal');
    sendBtn.disabled = true;
    sendBtn.addEventListener('click', sendWholeDocToTerminal);
    dock.bar.insertBefore(sendBtn, copyBtn);
  }
  // Registered once (not per-rebuild inside initializeMergedEditor) so a Backspace-delete rebuild never
  // stacks a second copy of either listener.
  host.addEventListener('click', handleMergedClick);
  // Capture so this wins the race against ProseMirror's own keymap for Alt+Enter/Cmd+A.
  dock.panel.addEventListener('keydown', handleMergedKeydown, true);
  document.addEventListener('copy', handleNativeCopy);
  function handlePrunedComments(event) {
    if (validatingCommentFiles) return;
    var removed = event && event.detail && Array.isArray(event.detail.comments) ? event.detail.comments : [];
    if (removed.length) dock.close(); // the one panel now represents every comment, of either kind
  }
  document.addEventListener('kakapo:comments-pruned', handlePrunedComments);
  dock.panel.__kakapoBeforeClose = function () {
    document.removeEventListener('kakapo:comments-pruned', handlePrunedComments);
    document.removeEventListener('copy', handleNativeCopy);
    if (window.kakapoApp && typeof window.kakapoApp.setIgnoreMenuShortcuts === 'function') window.kakapoApp.setIgnoreMenuShortcuts(false);
    editors.forEach(function (entry) { entry.editor.destroy(); });
  };
  // A round where the agent both answers and edits can remove EVERY comment's anchor line at once, so
  // remapComments flags them all "possibly addressed" and mergedBlocks filters them all out — the panel comes
  // up blank while the reviewer can still see their comments sitting in the code. That guess must not silently
  // eat the hand-off document: say what happened and offer the one action that undoes it.
  function renderAllAddressedNote() {
    if (host.querySelector('.mc-merged-card')) return;
    var flagged = reviewComments.filter(function (c) { return c.addressed; });
    if (!flagged.length) return;
    var note = document.createElement('div');
    note.className = 'mc-merged-empty-note';
    var label = document.createElement('span');
    label.textContent = t('merged.allAddressed').replace('{n}', String(flagged.length));
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'mc-merged-reopen-all';
    button.textContent = t('merged.reopenAll');
    button.onclick = function () {
      flagged.forEach(function (c) { reopenComment(c.seq); });
      initializeMergedEditor();
    };
    note.appendChild(label);
    note.appendChild(button);
    host.appendChild(note);
  }
  // options.reselectIndex, when given, means this rebuild followed a card deletion: reselect whatever card
  // now sits at that position (clamped — the deleted card's neighbors shift down by one) instead of the
  // normal open-time behavior of focusing the first prose region.
  function initializeMergedEditor(options) {
    if (!dock.panel.isConnected) return;
    var reselectIndex = options && typeof options.reselectIndex === 'number' ? options.reselectIndex : null;
    blocks = mergedBlocks();
    loadInlineMarkdownEditor().then(function (factory) {
      if (!dock.panel.isConnected) return;
      host.innerHTML = '';
      editors = [];
      selectedCard = null;
      blocks.forEach(function (block) {
        var region = document.createElement('div');
        region.className = 'mc-merged-editor-region';
        host.appendChild(region);
        editors.push({
          region: region,
          editor: factory.create({ element: region, markdown: block.prose, className: 'mc-merged-preview', placeholder: t('merged.title') }),
        });
        block.items.forEach(function (comment) { host.insertAdjacentHTML('beforeend', mergedCardHtml(comment)); });
      });
      renderAllAddressedNote();
      copyBtn.disabled = false;
      if (sendBtn) sendBtn.disabled = false;
      if (reselectIndex !== null) {
        var cards = Array.prototype.slice.call(host.querySelectorAll('.mc-merged-card'));
        if (cards.length) { selectCard(cards[Math.min(reselectIndex, cards.length - 1)], true); return; }
      }
      var firstSurface = editors.length ? editors[0].region.querySelector('.mc-inline-editor') : host;
      focusDockField(firstSurface, '#mc-merged-panel');
    }).catch(function () {
      host.innerHTML = '<div class="mc-memo-empty">' + escapeHtml(t('memo.loadFailed')) + '</div>';
      showToast(t('memo.loadFailed'));
    });
  }
  // Defer the (heavy) editor mount by one frame so the panel's entrance animation paints smoothly first
  // instead of stuttering while ProseMirror initializes.
  function startMergedEditor() {
    validatingCommentFiles = false;
    requestAnimationFrame(initializeMergedEditor);
  }
  verifyCommentFilesExist().then(startMergedEditor, startMergedEditor);
}

// One Notion-style Markdown document per worktree. Electron persists it below app.getPath('userData'); the
// static fallback uses a review-path localStorage key only for browser tests. No memo enters the repository.
var memoFallbackKey = 'kakapo-memo-document:' + location.pathname;
function fallbackMemoDocument() {
  try {
    var value = JSON.parse(localStorage.getItem(memoFallbackKey) || '{}');
    return value && typeof value.body === 'string' ? value : { version: 1, worktreePath: location.pathname, body: '', updatedAt: null };
  } catch (e) { return { version: 1, worktreePath: location.pathname, body: '', updatedAt: null }; }
}
function readMemoDocument() {
  if (window.kakapoMemo && typeof window.kakapoMemo.read === 'function') return window.kakapoMemo.read();
  return Promise.resolve(fallbackMemoDocument());
}
function writeMemoDocument(body) {
  if (window.kakapoMemo && typeof window.kakapoMemo.write === 'function') return window.kakapoMemo.write(body);
  var document = { version: 1, worktreePath: location.pathname, body: String(body || ''), updatedAt: new Date().toISOString() };
  try { localStorage.setItem(memoFallbackKey, JSON.stringify(document)); } catch (e) {}
  return Promise.resolve(document);
}
function deleteMemoDocument() {
  if (window.kakapoMemo && typeof window.kakapoMemo.remove === 'function') return window.kakapoMemo.remove();
  try { localStorage.removeItem(memoFallbackKey); } catch (e) {}
  return Promise.resolve({ ok: true });
}
var inlineMarkdownEditorLoad = null;
function loadInlineMarkdownEditor() {
  if (window.KakapoMarkdownEditor) return Promise.resolve(window.KakapoMarkdownEditor);
  if (inlineMarkdownEditorLoad) return inlineMarkdownEditorLoad;
  inlineMarkdownEditorLoad = new Promise(function (resolve, reject) {
    var script = document.createElement('script');
    script.src = 'kakapo-asset://app/markdown-editor.js';
    script.async = true;
    script.addEventListener('load', function () {
      if (window.KakapoMarkdownEditor) resolve(window.KakapoMarkdownEditor);
      else reject(new Error('inline Markdown editor did not register'));
    });
    script.addEventListener('error', function () { reject(new Error('inline Markdown editor failed to load')); });
    document.head.appendChild(script);
  }).catch(function (error) { inlineMarkdownEditorLoad = null; throw error; });
  return inlineMarkdownEditorLoad;
}
function openMemoView() {
  if (document.getElementById('mc-memo-panel')) { closeMergedMemoDocks(); return; } // the shortcut toggles: 2nd press closes
  var dock = mountDock('mc-memo-panel', t('memo.title'));
  var editor = null;
  var memoDirty = false;
  var saveTimer = 0;
  var saveState = document.createElement('span'); saveState.className = 'mc-memo-save-state';
  var clearBtn = document.createElement('button'); clearBtn.type = 'button'; clearBtn.className = 'dock-btn mc-memo-delete'; clearBtn.textContent = t('memo.clear'); clearBtn.disabled = true;
  dock.bar.insertBefore(saveState, dock.bar.querySelector('.dock-max'));
  dock.bar.insertBefore(clearBtn, dock.bar.querySelector('.dock-max'));
  var memoBody = document.createElement('div'); memoBody.className = 'mc-memo-body';
  var host = document.createElement('div'); host.className = 'mc-inline-editor-host';
  host.innerHTML = loadingStateHtml(t('memo.loading'), 'mc-memo-empty');
  memoBody.appendChild(host);
  dock.body.appendChild(memoBody);
  function flushMemo() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    if (!editor || !memoDirty) return;
    var savingBody = editor.getMarkdown();
    memoDirty = false;
    writeMemoDocument(savingBody).then(function () {
      if (!memoDirty) saveState.textContent = t('memo.saved');
    }).catch(function () { memoDirty = true; saveState.textContent = t('memo.saveFailed'); });
  }
  function scheduleSave() {
    memoDirty = true;
    saveState.textContent = t('memo.saving');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushMemo, 220);
  }
  clearBtn.addEventListener('click', function () {
    if (!editor || !window.confirm(t('memo.clearConfirm'))) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
    memoDirty = false;
    deleteMemoDocument().then(function (result) {
      if (!result || result.ok === false) throw new Error('delete failed');
      editor.setMarkdown('');
      saveState.textContent = '';
      editor.focus();
    }).catch(function () { showToast(t('memo.deleteFailed')); });
  });
  dock.panel.__kakapoBeforeClose = function () { flushMemo(); if (editor) editor.destroy(); };
  readMemoDocument().then(function (memoDocument) {
    if (!document.getElementById('mc-memo-panel')) return;
    return loadInlineMarkdownEditor().then(function (factory) {
      if (!document.getElementById('mc-memo-panel')) return;
      host.innerHTML = '';
      editor = factory.create({
        element: host,
        markdown: memoDocument && typeof memoDocument.body === 'string' ? memoDocument.body : '',
        placeholder: t('memo.placeholder'),
        onUpdate: scheduleSave,
      });
      clearBtn.disabled = false;
      saveState.textContent = memoDocument && memoDocument.updatedAt ? t('memo.saved') : '';
      requestAnimationFrame(function () { if (editor) editor.focus(); });
    });
  }).catch(function () {
    host.innerHTML = '<div class="mc-memo-empty">' + escapeHtml(t('memo.loadFailed')) + '</div>';
    showToast(t('memo.loadFailed'));
  });
}

document.addEventListener('click', function (event) {
  var t = event.target;
  if (!t || !t.closest) return;
  var reopen = t.closest('.mc-reopen');
  if (reopen) { event.preventDefault(); reopenComment(parseInt(reopen.dataset.seq, 10)); return; }
  // A file path inside an agent's prose (linkifyPathCode in 23-annotations.js) navigates to that file.
  var pathCode = t.closest('.mc-path-code');
  if (pathCode) { event.preventDefault(); openPathReference(pathCode.textContent || ''); return; }
  // The waiting box at the end of an ongoing thread (replyStubHtml) opens the same composer the ↩ button
  // does: on the thread's last card, whoever wrote it.
  var stub = t.closest('.mc-reply-stub');
  if (stub) { event.preventDefault(); openReplyComposer(parseInt(stub.dataset.seq, 10)); return; }
  var reply = t.closest('.mc-reply');
  if (reply) { event.preventDefault(); openReplyComposer(parseInt(reply.dataset.seq, 10)); return; }
  var del = t.closest('.mc-del');
  if (del) { event.preventDefault(); deleteComment(parseInt(del.dataset.seq, 10)); return; }
  if (t.closest('.mc-save')) { event.preventDefault(); saveComposer(); return; }
  if (t.closest('.mc-cancel')) { event.preventDefault(); closeComposer(); return; }
});
document.addEventListener('keydown', function (event) {
  var t = event.target;
  if (!t || !t.classList || !t.classList.contains('mc-input')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeComposer(); returnCaretAfterComposer(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveComposer(t); return; }
}, true);

pruneCommentsForMissingFiles();
refreshComments();


// In Electron, the Review menu's Cmd/Ctrl+Shift+/ and +. accelerators arrive here via IPC
// (macOS reserves Cmd+? for its Help search, so the menu claims it and routes to these views).
if (window.kakapoMenu && typeof window.kakapoMenu.onMergedView === 'function') {
  window.kakapoMenu.onMergedView(function () { openMergedView(); });
}
if (window.kakapoMenu && typeof window.kakapoMenu.onOpenMemo === 'function') {
  // Cmd/Ctrl+Shift+N from the Review menu -> open/close the prompt memo.
  window.kakapoMenu.onOpenMemo(function () { openMemoView(); });
}
if (window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function') {
  // Electron watch: refresh review data in place so comments and navigation context stay stable.
  window.kakapoMenu.onDiffUpdate(function (html) { try { applyDiffUpdate(html); } catch (e) {} });
}
if (window.kakapoMenu && typeof window.kakapoMenu.onCloseTab === 'function') {
  // Cmd/Ctrl+W: close whatever the focus is on. A focused terminal pane closes just that pane (the last
  // pane collapses the panel); otherwise close the active Files-mode tab (no-op outside the source viewer).
  window.kakapoMenu.onCloseTab(function () {
    var term = window.__kakapoTerminal;
    if (term && term.isOpen() && term.hasFocus()) { term.closeActivePane(); return; }
    if (isSourceViewerVisible()) closeActiveSourceTab();
  });
}

(function checkForUpdate() {
  var current = window.__KAKAPO_VERSION__ || '';
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
    if (status) status.classList.remove('is-loading');
    if (isNewer(latest, current)) {
      var flag = document.getElementById('app-update-flag');
      if (flag) flag.classList.remove('hidden');
      // One-click auto-update needs the Electron main process (it spawns npm). When available, reveal the
      // button so a click installs + restarts; otherwise (browser/static export) name the command instead.
      var ub = document.getElementById('app-info-update');
      if (ub && window.kakapoUpdate && typeof window.kakapoUpdate.run === 'function') {
        ub.textContent = t('settings.updateRestart') + ' (v' + latest + ')';
        ub.classList.remove('hidden');
        if (status) { status.textContent = t('settings.updateAvailable') + ': v' + latest; status.classList.add('has-update'); }
      } else if (status) {
        status.textContent = t('settings.updateAvailable') + ': v' + latest + ' — github.com/happy-nut/kakapo/releases';
        status.classList.add('has-update');
      }
    } else if (status) {
      status.textContent = t('settings.upToDate') + ' (v' + current + ')';
    }
  };
  // Cache the npm result for the session so watch-mode reloads reuse it instead of refetching.
  var cached = '';
  try { cached = sessionStorage.getItem('kakapo-update-latest') || ''; } catch (e) {}
  if (cached) { apply(cached); return; }
  if (typeof fetch !== 'function') return;
  // GitHub Releases is where kakapo actually ships (release.yml attaches the dmg and the Linux tarballs;
  // there is no npm publish). This used to ask the npm registry, which answers 404 for this package — so the
  // check silently failed forever and no update was ever offered.
  fetch('https://api.github.com/repos/happy-nut/kakapo/releases/latest', { cache: 'no-store', headers: { accept: 'application/vnd.github+json' } })
    .then(function (res) { return res && res.ok ? res.json() : null; })
    .then(function (data) {
      data = data && data.tag_name ? { version: String(data.tag_name).replace(/^v/, '') } : null;
      if (!data || !data.version) {
        var status = document.getElementById('app-info-status');
        if (status) { status.classList.remove('is-loading'); status.textContent = 'v' + current; }
        return;
      }
      try { sessionStorage.setItem('kakapo-update-latest', data.version); } catch (e) {}
      apply(data.version);
    })
    .catch(function () {
      var status = document.getElementById('app-info-status');
      if (status) { status.classList.remove('is-loading'); status.textContent = 'v' + current; }
    });
})();

// Unified settings modal: the sidebar-footer gear opens it (General category by default), with
// About/update/shortcuts under General and the merge-prompt editor under Merge prompts.
(function setupSettings() {
  var modal = document.getElementById('settings-modal');
  if (!modal) return;
  var gearBtn = document.getElementById('app-info-btn');
  var closeBtn = document.getElementById('settings-close');
  var flag = document.getElementById('app-update-flag');
  var updateBtn = document.getElementById('app-info-update');
  var pta = document.getElementById('settings-prompt-plan');
  var qta = document.getElementById('settings-prompt-q');
  var cta = document.getElementById('settings-prompt-c');
  var resetBtn = document.getElementById('settings-reset');
  var savedMsg = document.getElementById('settings-saved');
  var annotateTa = document.getElementById('settings-prompt-annotate');
  var codebaseTa = document.getElementById('settings-prompt-codebase');
  var cats = Array.prototype.slice.call(modal.querySelectorAll('.settings-cat'));
  var secs = Array.prototype.slice.call(modal.querySelectorAll('.settings-section'));
  function showCat(cat) {
    cats.forEach(function (c) { c.classList.toggle('active', c.dataset.cat === cat); });
    secs.forEach(function (s) { s.classList.toggle('hidden', s.dataset.cat !== cat); });
  }
  function fill() {
    var s = loadMergePrompts();
    // Defaults are real editable values, not placeholders. This makes the effective prompt visible
    // before the first edit and lets a reviewer verify exactly what was saved after reopening Settings.
    if (pta) { pta.value = (typeof s.plan === 'string' && s.plan.trim()) ? s.plan : defaultMergePrompt('plan'); pta.placeholder = ''; }
    if (qta) { qta.value = (typeof s.q === 'string' && s.q.trim()) ? s.q : defaultMergePrompt('q'); qta.placeholder = ''; }
    if (cta) { cta.value = (typeof s.c === 'string' && s.c.trim()) ? s.c : defaultMergePrompt('c'); cta.placeholder = ''; }
    if (annotateTa && typeof loadAnnotatePrompt === 'function') { annotateTa.value = loadAnnotatePrompt(); annotateTa.placeholder = ''; }
    if (codebaseTa && typeof loadCodebasePrompt === 'function') { codebaseTa.value = loadCodebasePrompt(); codebaseTa.placeholder = ''; }
  }
  function open(cat) { fill(); if (cat) showCat(cat); modal.classList.remove('hidden'); }
  function close() { modal.classList.add('hidden'); }
  var flashTimer = null;
  function flash() { if (!savedMsg) return; savedMsg.textContent = t('settings.saved'); if (flashTimer) clearTimeout(flashTimer); flashTimer = setTimeout(function () { savedMsg.textContent = ''; }, 1200); }
  if (gearBtn) gearBtn.addEventListener('click', function (e) { e.stopPropagation(); if (modal.classList.contains('hidden')) open('general'); else close(); });
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (flag) flag.addEventListener('click', function (e) { e.stopPropagation(); open('general'); });
  cats.forEach(function (c) { c.addEventListener('click', function () { showCat(c.dataset.cat); }); });
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  // Settings is the first row of KEY_OWNERS (05-keymap.js), which is what makes its Esc beat the lightbox
  // and the composer. That used to be a capture-phase listener whose only statement of precedence was a
  // comment here; the ordering now lives in the one table that ranks every such surface.
  handleSettingsKey = function (e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) { e.stopPropagation(); e.preventDefault(); close(); return true; }
    // Cmd/Ctrl+, (the standard "Preferences" accelerator) toggles the settings panel from anywhere — but not
    // while another floating overlay (merged / memo) owns focus; that one must be Esc'd first.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === ',' || e.code === 'Comma')) {
      if (modal.classList.contains('hidden') && (document.getElementById('mc-modal') || document.getElementById('mc-memo'))) return false;
      e.preventDefault(); e.stopPropagation();
      if (modal.classList.contains('hidden')) open('general'); else close();
      return true;
    }
    return false;
  };
  // One-click self-update (Electron only): install latest globally via the main process, then relaunch.
  if (updateBtn && window.kakapoUpdate && typeof window.kakapoUpdate.run === 'function') {
    updateBtn.addEventListener('click', function () {
      if (updateBtn.disabled) return;
      updateBtn.disabled = true;
      var status = document.getElementById('app-info-status');
      if (status) {
        status.classList.add('has-update', 'is-loading');
        status.innerHTML = kakapoLoaderHtml('kakapo-loader-inline') + '<span>' + escapeHtml(t('settings.updating')) + '</span>';
      }
      window.kakapoUpdate.run().then(function (r) {
        if (r && r.ok) { if (status) { status.classList.remove('is-loading'); status.textContent = t('settings.updated'); } }
        else {
          updateBtn.disabled = false;
          if (status) {
            status.classList.remove('is-loading');
            status.textContent = t('settings.updateFailed');
            status.title = r && r.error ? String(r.error) : '';
          }
          if (r && r.error) console.warn('kakapo update failed:', r.error);
        }
      }).catch(function (error) {
        updateBtn.disabled = false;
        if (status) {
          status.classList.remove('is-loading');
          status.textContent = t('settings.updateFailed');
          status.title = error ? String(error) : '';
        }
        if (error) console.warn('kakapo update failed:', error);
      });
    });
  }
  if (pta) pta.addEventListener('input', function () { saveMergePrompt('plan', pta.value); flash(); });
  if (qta) qta.addEventListener('input', function () { saveMergePrompt('q', qta.value); flash(); });
  if (cta) cta.addEventListener('input', function () { saveMergePrompt('c', cta.value); flash(); });
  if (resetBtn) resetBtn.addEventListener('click', function () {
    saveMergePrompt('plan', ''); saveMergePrompt('q', ''); saveMergePrompt('c', '');
    if (typeof saveAnnotatePrompt === 'function') saveAnnotatePrompt('');
    fill(); flash();
  });
  if (annotateTa) annotateTa.addEventListener('input', function () { if (typeof saveAnnotatePrompt === 'function') saveAnnotatePrompt(annotateTa.value); flash(); });
  if (codebaseTa) codebaseTa.addEventListener('input', function () { if (typeof saveCodebasePrompt === 'function') saveCodebasePrompt(codebaseTa.value); flash(); });
  // Language: live-switch the whole UI (no reload). Factored out so the cross-window chrome broadcast (below)
  // replays the exact same steps when another review window changes the shared locale.
  function applyLocale(next) {
    if (next !== 'en' && next !== 'ko') return;
    if (next === locale) return;
    locale = next;
    persistSave(LOCALE_KEY, locale);
    applyI18n();
    fill(); // unsaved merge-prompt defaults follow the active locale
    try { if (typeof refreshComments === 'function') refreshComments(); } catch (e) {}
    // Reopening runs mountDock's own closeMergedMemoDocks() first, so the outgoing panel still gets its
    // __kakapoBeforeClose flush instead of being yanked out from under the editor.
    if (document.getElementById('mc-merged-panel')) openMergedView();
  }
  // Theme is a preference ('system'|'light'|'dark'); applyTheme() resolves it to the light/dark data-theme.
  function applyThemePref(next) {
    if (next !== 'system' && next !== 'light' && next !== 'dark') return;
    if (next === theme) return;
    theme = next;
    persistSave(THEME_KEY, theme);
    applyTheme();
  }
  langSelectRef = setupCustomSelect('settings-language',
    function () { return [{ value: 'en', label: 'English' }, { value: 'ko', label: '한국어' }]; },
    function () { return locale; },
    function (next) { applyLocale(next); });
  uiScaleSelectRef = setupCustomSelect('settings-ui-scale',
    function () { return UI_SCALES.map(function (v) { return { value: String(v), label: Math.round(v * 100) + '%' }; }); },
    function () { return String(uiScale); },
    function (next) { applyUiScale(Number(next)); });
  // ----- theme grid. A theme is one named thing that is ALREADY light or dark — Darcula is a dark theme,
  // IntelliJ Light is a light one; neither has an "appearance" to pick separately. So the grid is a flat
  // list of the four real palettes, plus System, which is the one genuinely automatic choice (it follows
  // the OS and keeps whichever family you last chose).
  //
  // The two preferences stay separately persisted ('kakapo-theme' / 'kakapo-syntax-theme') and keep their
  // existing values — only the UI is flattened, so a stored setting, the cross-window broadcast below, and
  // applyTheme/applySyntaxTheme are all untouched.
  // The families a stored preference may name. A palette is a CSS block plus a row here — nothing else.
  var SYNTAX_FAMILIES = ['default', 'darcula', 'github'];
  var THEMES = [
    { id: 'system', mode: 'system' },
    { id: 'default-dark', family: 'default', mode: 'dark' },
    { id: 'default-light', family: 'default', mode: 'light' },
    { id: 'darcula-dark', family: 'darcula', mode: 'dark' },
    { id: 'darcula-light', family: 'darcula', mode: 'light' },
    { id: 'github-dark', family: 'github', mode: 'dark' },
    { id: 'github-light', family: 'github', mode: 'light' },
  ];
  function applySyntaxThemePref(next) {
    if (SYNTAX_FAMILIES.indexOf(next) < 0 || next === syntaxTheme) return;
    syntaxTheme = next;
    persistSave(SYNTAX_THEME_KEY, syntaxTheme);
    applySyntaxTheme();
  }
  function renderThemeGrid() {
    var grid = document.getElementById('settings-theme-grid');
    if (!grid) return;
    grid.innerHTML = THEMES.map(function (entry) {
      // System wins whenever the appearance is automatic, whatever family is underneath it.
      var on = theme === 'system' ? entry.id === 'system' : (entry.family === syntaxTheme && entry.mode === theme);
      // The System swatch previews the current family's own light and dark halves — the two it flips between.
      var swatch = entry.id === 'system' ? syntaxTheme + '-system' : entry.id;
      return '<button type="button" class="theme-card' + (on ? ' is-active' : '') + '" role="radio"'
        + ' aria-checked="' + (on ? 'true' : 'false') + '" data-theme-id="' + entry.id + '">'
        + '<span class="theme-swatch" data-swatch="' + swatch + '" aria-hidden="true"></span>'
        + '<span class="theme-card-name">' + escapeHtml(t('theme.name.' + entry.id)) + '</span></button>';
    }).join('');
  }
  // Both refs point at the one renderer: applyI18n(), applyTheme() and applySyntaxTheme() each re-render
  // through them (01-core.js), and the grid is the single surface all three used to update separately.
  themeSelectRef = syntaxThemeSelectRef = { render: renderThemeGrid };
  renderThemeGrid();
  var themeGrid = document.getElementById('settings-theme-grid');
  if (themeGrid) themeGrid.addEventListener('click', function (event) {
    var card = event.target.closest && event.target.closest('.theme-card');
    if (!card) return;
    var entry = THEMES.filter(function (x) { return x.id === card.dataset.themeId; })[0];
    if (!entry) return;
    if (entry.family) applySyntaxThemePref(entry.family); // System keeps the family it is already using
    applyThemePref(entry.mode);
    renderThemeGrid(); // applyTheme/applySyntaxTheme skip their re-render when only the OTHER axis moved
  });
  // Integrated-terminal bell → native notification opt-out. Default on; the terminal client reads the same
  // key ('kakapo-terminal-bell-notify') before raising a notification.
  var bellCb = document.getElementById('set-bell-notify');
  if (bellCb) {
    bellCb.checked = persistRead('kakapo-terminal-bell-notify') !== false;
    bellCb.addEventListener('change', function () { persistSave('kakapo-terminal-bell-notify', bellCb.checked); });
  }
  // Terminal sessions always run inside tmux when it is installed, so agents survive quitting kakapo. tmux
  // isn't on macOS by default, so this row reports whether persistence is actually in effect — and, with
  // Homebrew present, installs it right here with brew's output streamed into the log below the button.
  var setup = document.getElementById('tmux-setup');
  var setupStatus = document.getElementById('tmux-setup-status');
  var installBtn = document.getElementById('tmux-install');
  var setupLog = document.getElementById('tmux-setup-log');
  if (setup && window.kakapoPty && typeof window.kakapoPty.tmuxStatus === 'function') {
    window.kakapoPty.tmuxStatus().then(function (s) {
      var ready = !!(s && s.tmux);
      setupStatus.textContent = t(ready ? 'settings.tmuxReady' : (s && s.brew) ? 'settings.tmuxMissing' : 'settings.tmuxNoBrew');
      installBtn.classList.toggle('hidden', ready || !(s && s.brew));
    });
    installBtn.addEventListener('click', function () {
      installBtn.disabled = true;
      setupLog.textContent = '';
      setupLog.classList.remove('hidden');
      setupStatus.textContent = t('settings.tmuxInstalling');
      window.kakapoPty.installTmux();
    });
    window.kakapoPty.onTmuxInstallOutput(function (chunk) {
      setupLog.textContent += chunk;
      setupLog.scrollTop = setupLog.scrollHeight;
    });
    window.kakapoPty.onTmuxInstallDone(function (r) {
      installBtn.disabled = false;
      setupStatus.textContent = t(r && r.ok ? 'settings.tmuxReady' : 'settings.tmuxInstallFailed');
      installBtn.classList.toggle('hidden', !!(r && r.ok));
    });
  }
  // Cross-window sync: theme + locale are GLOBAL settings. When another review window (or the OS, relayed by the
  // main process) changes one, main broadcasts it here so every open review follows live — no reload, no drift.
  try {
    if (window.kakapoChrome && typeof window.kakapoChrome.onChange === 'function') {
      window.kakapoChrome.onChange(function (payload) {
        if (!payload) return;
        if (payload.theme) applyThemePref(payload.theme);
        if (payload.locale) applyLocale(payload.locale);
      });
    }
  } catch (e) {}
})();
