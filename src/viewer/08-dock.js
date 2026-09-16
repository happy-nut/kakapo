// ===== Bottom dock: the merged review-comments document, in a docked slot below the editor =====
// Cmd/Ctrl+Shift+' maximizes it over the editor area.
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
  return document.getElementById('mc-merged-panel');
}
function applyDockMaximized() {
  if (!activeDockPanel()) dockMaximized = false; // nothing docked -> can't stay maximized
  document.body.classList.toggle('dock-maximized', dockMaximized);
}
function toggleDockMaximized() {
  // Maximize only the panel you're FOCUSED in. From the sidebar tree (treeFocusIndex >= 0) or the
  // diff/source content this is a no-op.
  if (treeFocusIndex >= 0) return;
  var ae = document.activeElement;
  if (!(ae && ae.closest && ae.closest('.dock-panel'))) return;
  if (!activeDockPanel()) return; // nothing docked -> nothing to maximize
  dockMaximized = !dockMaximized;
  applyDockMaximized();
}
// "The keys belong to a panel, not to the editor." While the dock holds focus the global shortcuts below
// the keymap's focus guard stand down; the ones placed ABOVE it (Cmd+0/1/7/8/9, the dock toggles) still work.
function isDockFocused() {
  var ae = document.activeElement;
  return !!(ae && ae.closest && ae.closest('.dock-panel'));
}
// Close the merged dock.
function closeMergedDock() {
  var m = document.getElementById('mc-merged-panel');
  var hadDock = !!m;
  if (m) {
    try { if (typeof m.__kakapoBeforeClose === 'function') m.__kakapoBeforeClose(); } catch (e) {}
    m.remove();
  }
  document.querySelectorAll('.dock-backdrop').forEach(function (b) { b.remove(); });
  document.body.classList.toggle('dock-open', !!activeDockPanel());
  document.body.classList.toggle('floating-dock', !!activeDockPanel());
  applyDockMaximized();
  // The merged view reconciles/prunes comments while open; re-render the diff/source cards so the reviewer's
  // comments are visible again the instant the dock closes and never appear to vanish behind it.
  if (hadDock) { try { refreshComments(); } catch (e) {} }
}
window.__kakapoCloseDocks = closeMergedDock;
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
function mountDock(id, titleText) {
  // Full-screen surfaces switch, never stack: the dock floats above History (z78 vs 75), and closing the
  // dock later must not drop the reviewer back into an overlay they left minutes ago.
  closeHistoryIfOpen();
  closeMergedDock();
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
  function close() { closeMergedDock(); }
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
  host.innerHTML = loadingStateHtml(t('history.loading'), 'mc-merged-empty');
  mergedBody.appendChild(host);
  dock.body.appendChild(mergedBody);
  var validatingCommentFiles = true;
  var blocks = [];   // mergedBlocks() snapshot captured once, at build time
  var selectedCard = null;

  // The top-level children of `host`: one non-editable card per comment, in document order. Arrow-key
  // handoff walks this list, not reviewComments directly, so behavior always matches what is on screen.
  function regionNodes() { return Array.prototype.slice.call(host.children); }
  function siblingRegion(node, dir) {
    var kids = regionNodes();
    var i = kids.indexOf(node);
    return i < 0 ? null : (kids[i + dir] || null);
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
  // Land on the next card. Every region in this panel is a card now, so there is nothing else to land on.
  function focusRegion(node) {
    if (node && node.classList.contains('mc-merged-card')) selectCard(node, true);
  }
  // Assemble the CURRENT text: the reviewer's own comments and nothing else. No instructions are prepended
  // — what leaves this panel is the review, and what to do with it is the reader's to say wherever they
  // paste it. Mirrors buildMergedText's exact line structure.
  function currentMergedText() {
    var nl = String.fromCharCode(10);
    var lines = [];
    blocks.forEach(function (block) {
      block.items.forEach(function (c) { lines.push.apply(lines, mergedItemLines(c)); });
    });
    return lines.join(nl);
  }
  // Shared by the Copy-all button and Cmd+C-after-Cmd+A (see handleMergedKeydown) so both paths copy the
  // exact same assembled text.
  function copyMergedText() {
    var copied = copyTextToClipboard(currentMergedText());
    showToast(t(copied ? 'merged.copied' : 'merged.copyFailed'));
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
    showToast(t('merged.copied'));
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
    var target = event.target;
    var card = target && target.closest ? target.closest('.mc-merged-card') : null;
    if (card) {
      if (!event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        focusRegion(siblingRegion(card, event.key === 'ArrowDown' ? 1 : -1));
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
  }
  function handleMergedClick(event) {
    clearSelectAll();
    var card = event.target && event.target.closest ? event.target.closest('.mc-merged-card') : null;
    if (card) { selectCard(card, false); return; }
    deselectCard();
  }
  var copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'dock-btn mc-copy-all';
  copyBtn.setAttribute('data-i18n', 'merged.copyAll');
  copyBtn.textContent = t('merged.copyAll');
  copyBtn.disabled = true;
  copyBtn.addEventListener('click', copyMergedText);
  dock.bar.insertBefore(copyBtn, dock.bar.querySelector('.dock-max'));
  // Registered once (not per-rebuild inside initializeMergedEditor) so a Backspace-delete rebuild never
  // stacks a second copy of either listener.
  host.addEventListener('click', handleMergedClick);
  // Capture so this panel wins the race for Cmd+A. A key this panel
  // claimed must also not reach the window keymap: ⌥⏎ and ⏎-on-a-card close the dock synchronously, so by
  // the time the event bubbles to document the "a dock is focused, stand down" guard (isDockFocused) is
  // already false — and the still-focused Changes row answered the same keystroke by opening its row menu.
  dock.panel.addEventListener('keydown', function (event) {
    handleMergedKeydown(event);
    if (event.defaultPrevented) event.stopPropagation();
  }, true);
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
  };
  // A round where the agent both answers and edits can remove EVERY comment's anchor line at once, so
  // remapComments flags them all "possibly addressed" and mergedBlocks filters them all out — the panel comes
  // up blank while the reviewer can still see their comments sitting in the code. That guess must not silently
  // eat the hand-off document: say what happened and offer the one action that undoes it.
  //
  // The other way it comes up blank is now the ORDINARY end of a round: the agent has answered everything and
  // the reviewer has not written back yet, so mergedBlocks holds every thread (07-comments.js). That is not a
  // guess to undo, it is a finished conversation — so it gets the same explanation and no button, because the
  // action is to go and reply to one of the answers.
  function renderAllAddressedNote() {
    if (host.querySelector('.mc-merged-card')) return;
    var flagged = reviewComments.filter(function (c) { return c.addressed; });
    var note = document.createElement('div');
    note.className = 'mc-merged-empty-note';
    var label = document.createElement('span');
    if (!flagged.length) {
      // A review with nothing in it. The panel's whole job is to hand comments off, so an empty one has to
      // say where comments come from — a blank sheet with a Copy-all button reads like something is broken.
      if (!reviewComments.some(function (c) { return c.by !== 'agent'; })) {
        var parts = t('merged.empty').split('{key}');
        label.appendChild(document.createTextNode(parts[0]));
        var keys = document.createElement('span');
        keys.className = 'coach-keys'; // the shortcut-coach key chip, so one kind of key looks one way
        var key = document.createElement('kbd');
        key.textContent = '?';
        keys.appendChild(key);
        label.appendChild(keys);
        label.appendChild(document.createTextNode(parts[1] || ''));
        note.appendChild(label);
        host.appendChild(note);
        return;
      }
      label.textContent = t('merged.allAnswered');
      note.appendChild(label);
      host.appendChild(note);
      return;
    }
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
    host.innerHTML = '';
    selectedCard = null;
    blocks.forEach(function (block) {
      block.items.forEach(function (comment) { host.insertAdjacentHTML('beforeend', mergedCardHtml(comment)); });
    });
    renderAllAddressedNote();
    copyBtn.disabled = false;
    var cards = Array.prototype.slice.call(host.querySelectorAll('.mc-merged-card'));
    if (reselectIndex !== null && cards.length) {
      selectCard(cards[Math.min(reselectIndex, cards.length - 1)], true);
      return;
    }
    if (cards.length) selectCard(cards[0], true);
    // Nothing to select (a review with no open comments). The panel itself takes the keyboard — it is
    // tabIndex -1 for exactly this — so Esc still closes it and ⌘⇧' still maximizes it. Before, the empty
    // prose editor happened to hold focus here; without one, an empty panel answered no keys at all.
    else focusDockField(dock.panel, '#mc-merged-panel');
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
document.addEventListener('click', function (event) {
  var t = event.target;
  if (!t || !t.closest) return;
  var reopen = t.closest('.mc-reopen');
  if (reopen) { event.preventDefault(); reopenComment(parseInt(reopen.dataset.seq, 10)); return; }
  // The (…) standing in for the folded directories is its own control: it unfolds the path rather than
  // following it. One way only — once the path is open there is nothing left to click to fold it, and a
  // reader who wanted it open is not asking to put it back.
  var pathEllipsis = t.closest('.mc-path-ell');
  if (pathEllipsis) {
    event.preventDefault();
    if (pathEllipsis.parentNode) pathEllipsis.parentNode.classList.add('mc-path-open');
    return;
  }
  // dataset.path, not textContent: the folded directory is still in the DOM and the (…) is in there with it.
  var pathCode = t.closest('.mc-path-code');
  if (pathCode) { event.preventDefault(); openPathReference(pathCode.dataset.path || pathCode.textContent || ''); return; }
  // The card's own prev/next. Same walk the keys drive, so the mouse and F8 cannot disagree about where
  // "next" is — both go through gotoComment.
  var step = t.closest('.mc-walk-step');
  if (step) { event.preventDefault(); gotoComment(Number(step.dataset.walk) < 0 ? -1 : 1); return; }
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
if (window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function') {
  // Electron watch: refresh review data in place so comments and navigation context stay stable.
  window.kakapoMenu.onDiffUpdate(function (html) { try { applyDiffUpdate(html); } catch (e) {} });
}
if (window.kakapoMenu && typeof window.kakapoMenu.onReleaseView === 'function') {
  // This workspace has been off screen long enough that its diff DOM is worth more as free memory; the
  // rebuild on the way back in repaints it. See releaseDiffView.
  window.kakapoMenu.onReleaseView(function () { try { releaseDiffView(); } catch (e) {} });
}
if (window.kakapoMenu && typeof window.kakapoMenu.onCloseTab === 'function') {
  // Cmd/Ctrl+W closes the active Files-mode tab (no-op outside the source viewer).
  window.kakapoMenu.onCloseTab(function () {
    if (isSourceViewerVisible()) closeActiveSourceTab();
  });
}

// Checked on a timer, not once at startup. This app is left running for days, so a check that only ran at
// page load meant a release published afterwards was invisible until something happened to reload the page. The version you are told about must not depend on
// when you last restarted.
var UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
function checkForUpdate() {
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
      // One-click auto-update needs the Electron main process (it spawns npm). When available, reveal the
      // button so a click installs + restarts; otherwise (browser/static export) name the command instead.
      var ub = document.getElementById('app-info-update');
      if (ub && window.kakapoUpdate && typeof window.kakapoUpdate.run === 'function') {
        ub.textContent = t('settings.updateRestart');
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
  // Cached for the session so watch-mode reloads reuse it instead of refetching — but with an age now, or the
  // cache would answer every later check with the same stale version and the timer below would buy nothing.
  var cached = '', cachedAt = 0;
  try {
    cached = sessionStorage.getItem('kakapo-update-latest') || '';
    cachedAt = Number(sessionStorage.getItem('kakapo-update-checked-at')) || 0;
  } catch (e) {}
  if (cached) apply(cached); // show what we know immediately; a fetch below may replace it
  if (cached && Date.now() - cachedAt < UPDATE_CHECK_MS) return;
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
      try {
        sessionStorage.setItem('kakapo-update-latest', data.version);
        sessionStorage.setItem('kakapo-update-checked-at', String(Date.now()));
      } catch (e) {}
      apply(data.version);
    })
    .catch(function () {
      var status = document.getElementById('app-info-status');
      if (status) { status.classList.remove('is-loading'); status.textContent = 'v' + current; }
    });
}
checkForUpdate();
setInterval(checkForUpdate, UPDATE_CHECK_MS);

// Unified settings modal: the sidebar-footer gear opens it (General category by default), with
// About/update/shortcuts under General and the merge-prompt editor under Merge prompts.
(function setupSettings() {
  var modal = document.getElementById('settings-modal');
  if (!modal) return;
  var gearBtn = document.getElementById('app-info-btn');
  var closeBtn = document.getElementById('settings-close');
  var updateBtn = document.getElementById('app-info-update');
  // The download is the long part of an update, so say how far it has got. The row is already the one place
  // that reports what the update is doing, which is why the percentage belongs there and not on the button.
  if (window.kakapoUpdate && typeof window.kakapoUpdate.onProgress === 'function') {
    window.kakapoUpdate.onProgress(function (p) {
      var status = document.getElementById('app-info-status');
      if (!status || !p || p.done) return;
      status.classList.remove('is-loading');
      status.textContent = t('update.downloading').replace('{n}', String(p.percent));
    });
  }
  var cats = Array.prototype.slice.call(modal.querySelectorAll('.settings-cat'));
  var secs = Array.prototype.slice.call(modal.querySelectorAll('.settings-section'));
  function showCat(cat) {
    cats.forEach(function (c) { c.classList.toggle('active', c.dataset.cat === cat); });
    secs.forEach(function (s) { s.classList.toggle('hidden', s.dataset.cat !== cat); });
  }
  function open(cat) { if (cat) showCat(cat); modal.classList.remove('hidden'); }
  function close() { modal.classList.add('hidden'); }
  if (gearBtn) gearBtn.addEventListener('click', function (e) { e.stopPropagation(); if (modal.classList.contains('hidden')) open('general'); else close(); });
  if (closeBtn) closeBtn.addEventListener('click', close);
  cats.forEach(function (c) { c.addEventListener('click', function () { showCat(c.dataset.cat); }); });
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  // Settings is the first row of KEY_OWNERS (05-keymap.js), which is what makes its Esc beat the lightbox
  // and the composer. That used to be a capture-phase listener whose only statement of precedence was a
  // comment here; the ordering now lives in the one table that ranks every such surface.
  handleSettingsKey = function (e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) { e.stopPropagation(); e.preventDefault(); close(); return true; }
    // Cmd/Ctrl+, (the standard "Preferences" accelerator) toggles the settings panel from anywhere — but not
    // while the merged overlay owns focus; that one must be Esc'd first.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === ',' || e.code === 'Comma')) {
      if (modal.classList.contains('hidden') && document.getElementById('mc-modal')) return false;
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
        status.innerHTML = kakapoLoaderHtml('kakapo-loader-micro') + '<span>' + escapeHtml(t('settings.updating')) + '</span>';
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
  // Language: live-switch the whole UI (no reload). Factored out so the cross-window chrome broadcast (below)
  // replays the exact same steps when another review window changes the shared locale.
  function applyLocale(next) {
    if (next !== 'en' && next !== 'ko') return;
    if (next === locale) return;
    locale = next;
    persistSave(LOCALE_KEY, locale);
    applyI18n();
    try { refreshComments(); } catch (e) {}
    // Reopening runs mountDock's own closeMergedDock() first, so the outgoing panel still gets its
    // __kakapoBeforeClose flush.
    if (document.getElementById('mc-merged-panel')) openMergedView();
  }
  // Theme is light or dark; applyTheme() writes it to data-theme.
  function applyThemePref(next) {
    if (next !== 'light' && next !== 'dark') return;
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
  // A palette is a CSS block, a row here, and a name in SYNTAX_FAMILIES (01-core.js, which is also where a
  // stored preference is checked against it — this list used to be duplicated here and fell out of step).
  // The first four are deliberately quiet and, between them, near-identical: two greys and two whites, one
  // blue accent. The last three are the ones that answer "give me a theme with actual colour" — Solarized and
  // Dracula bring a coloured ground, High Contrast brings the opposite of a mood.
  var THEMES = [
    { id: 'default-dark', family: 'default', mode: 'dark' },
    { id: 'default-light', family: 'default', mode: 'light' },
    { id: 'darcula-dark', family: 'darcula', mode: 'dark' },
    { id: 'darcula-light', family: 'darcula', mode: 'light' },
    { id: 'github-dark', family: 'github', mode: 'dark' },
    { id: 'github-light', family: 'github', mode: 'light' },
    { id: 'solarized-dark', family: 'solarized', mode: 'dark' },
    { id: 'solarized-light', family: 'solarized', mode: 'light' },
    { id: 'dracula-dark', family: 'dracula', mode: 'dark' },
    { id: 'dracula-light', family: 'dracula', mode: 'light' },
    { id: 'contrast-dark', family: 'contrast', mode: 'dark' },
    { id: 'contrast-light', family: 'contrast', mode: 'light' },
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
      var on = entry.family === syntaxTheme && entry.mode === theme;
      return '<button type="button" class="theme-card' + (on ? ' is-active' : '') + '" role="radio"'
        + ' aria-checked="' + (on ? 'true' : 'false') + '" data-theme-id="' + entry.id + '">'
        + '<span class="theme-swatch" data-swatch="' + entry.id + '" aria-hidden="true"></span>'
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
