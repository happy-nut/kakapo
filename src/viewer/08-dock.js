var dockMaximized = false;
var handleSettingsKey;
function activeDockPanel() {
  return document.getElementById('mc-merged-panel');
}
function applyDockMaximized() {
  if (!activeDockPanel()) dockMaximized = false;
  document.body.classList.toggle('dock-maximized', dockMaximized);
}
function toggleDockMaximized() {
  if (treeFocusIndex >= 0) return false;
  var ae = document.activeElement;
  if (!(ae && ae.closest && ae.closest('.dock-panel'))) {
    if (activeDockPanel()) { showCaretHint(t('dock.notFocused')); return true; }
    return false;
  }
  if (!activeDockPanel()) return false;
  dockMaximized = !dockMaximized;
  applyDockMaximized();
  return true;
}
function isDockFocused() {
  var ae = document.activeElement;
  return !!(ae && ae.closest && ae.closest('.dock-panel'));
}
claimsMenuChords('hand-off dock', function () { return !!activeDockPanel(); });
var mergedDockRefresh = null;
function refreshMergedDock() {
  if (mergedDockRefresh) mergedDockRefresh();
}
function closeMergedDock() {
  var m = document.getElementById('mc-merged-panel');
  var hadDock = !!m;
  mergedDockRefresh = null;
  if (m) {
    try { if (typeof m.__kakapoBeforeClose === 'function') m.__kakapoBeforeClose(); } catch (e) {}
    m.remove();
  }
  document.querySelectorAll('.dock-backdrop').forEach(function (b) { b.remove(); });
  document.body.classList.toggle('dock-open', !!activeDockPanel());
  document.body.classList.toggle('floating-dock', !!activeDockPanel());
  applyDockMaximized();
  if (hadDock) { try { refreshComments(); } catch (e) {} }
}
window.__kakapoCloseDocks = closeMergedDock;
function toggleMergedView() {
  if (document.getElementById('mc-merged-panel')) { closeMergedDock(); return; }
  openMergedView();
}
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
function mountDock(id, titleText) {
  closeHistoryIfOpen();
  closeMergedDock();
  var panel = document.createElement('div');
  panel.id = id;
  panel.className = 'dock-panel';
  panel.tabIndex = -1;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', titleText);
  var backdrop = document.createElement('div');
  backdrop.className = 'dock-backdrop';
  var bar = document.createElement('div');
  bar.className = 'dock-bar';
  var title = document.createElement('span');
  title.className = 'dock-title';
  title.textContent = titleText;
  var maxBtn = document.createElement('button');
  maxBtn.type = 'button';
  maxBtn.className = 'dock-btn dock-max';
  maxBtn.dataset.keyhintId = 'maximizePanel';
  maxBtn.setAttribute('data-i18n-title', 'dock.maximize');
  maxBtn.title = t('dock.maximize');
  maxBtn.textContent = '⤢';
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dock-btn dock-close';
  closeBtn.dataset.keyhintId = 'closeDialog';
  closeBtn.setAttribute('data-i18n', 'merged.close');
  closeBtn.textContent = t('merged.close');
  var body = document.createElement('div');
  body.className = 'dock-body';
  bar.appendChild(title);
  bar.appendChild(maxBtn);
  bar.appendChild(closeBtn);
  panel.appendChild(bar);
  panel.appendChild(body);
  panel.addEventListener('keydown', function (event) { trapTabWithin(panel, event); });
  applyKeyHints(panel);
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  function close() { closeMergedDock(); }
  maxBtn.addEventListener('click', function () { toggleDockMaximized(); });
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  document.body.classList.add('dock-open');
  document.body.classList.add('floating-dock');
  applyDockMaximized();
  return { panel: panel, body: body, bar: bar, close: close };
}

function openMergedView() {
  if (pruneCommentsForMissingFiles()) refreshComments();
  var dock = mountDock('mc-merged-panel', t('merged.title'));
  syncMenuChords();
  var mergedBody = document.createElement('div');
  mergedBody.className = 'mc-merged-body';
  var host = document.createElement('div');
  host.className = 'mc-inline-editor-host mc-merged-editor-host';
  host.innerHTML = loadingStateHtml(t('history.loading'), 'mc-merged-empty');
  mergedBody.appendChild(host);
  dock.body.appendChild(mergedBody);
  var validatingCommentFiles = true;
  var blocks = [];
  var selectedCard = null;

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
  var copyArchivePending = false;
  function focusRegion(node) {
    if (node && node.classList.contains('mc-merged-card')) selectCard(node, true);
  }
  function mergedTextFor(items) {
    var nl = String.fromCharCode(10);
    var lines = [];
    items.forEach(function (item) { lines.push.apply(lines, mergedItemLines(item)); });
    return lines.join(nl);
  }
  function currentMergedText() {
    var nl = String.fromCharCode(10);
    var lines = [];
    blocks.forEach(function (block) {
      block.items.forEach(function (c) { lines.push.apply(lines, mergedItemLines(c)); });
    });
    return lines.join(nl);
  }
  function allMergedItems() {
    var items = [];
    blocks.forEach(function (block) {
      block.items.forEach(function (item) { if (item && item.seq != null) items.push(item); });
    });
    return items;
  }
  function itemForCard(card) {
    var seq = card && card.dataset ? parseInt(card.dataset.commentSeq, 10) : NaN;
    if (!(seq >= 0)) return null;
    var found = null;
    allMergedItems().forEach(function (item) { if (item.seq === seq) found = item; });
    return found;
  }
  function copyAndArchiveMerged(items) {
    var picked = items && items.length ? items : allMergedItems();
    if (!copyTextToClipboard(mergedTextFor(picked))) { showToast(t('merged.copyFailed')); return; }
    archiveMergedItems(picked);
  }
  function archiveMergedItems(picked) {
    var byId = {};
    reviewComments.forEach(function (c) { byId[c.seq] = c; });
    var seqs = [];
    picked.forEach(function (item) {
      commentSubtreeSeqs(commentThreadRoot(item, byId)).forEach(function (seq) {
        if (seqs.indexOf(seq) < 0) seqs.push(seq);
      });
    });
    var archived = archiveComments(seqs);
    if (window.kakapoGit && typeof window.kakapoGit.markRead === 'function') {
      try { Promise.resolve(window.kakapoGit.markRead()).catch(function () {}); } catch (e) { }
    }
    refreshComments();
    if (!document.querySelector('.mc-merged-card')) closeMergedDock();
    showToast(t('merged.copiedAndArchived', { count: archived, key: shortcutLabel('undoCommentRemoval') }));
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
    if (!copyArchivePending) {
      copyArchivePending = true;
      setTimeout(function () { copyArchivePending = false; }, 0);
      archiveMergedItems(allMergedItems());
    } else {
      showToast(t('merged.copied'));
    }
  }
  function deleteSelectedCard(card) {
    var cards = Array.prototype.slice.call(host.querySelectorAll('.mc-merged-card'));
    var index = cards.indexOf(card);
    removeComments([parseInt(card.dataset.commentSeq, 10)]);
    refreshComments();
    initializeMergedEditor({ reselectIndex: index });
    showToast(t('comment.removedUndo'));
  }
  function handleMergedKeydown(event) {
    // Holding Cmd between tapping A and C (the normal way to chord Cmd+A -> Cmd+C) makes macOS/Chromium
    // redeliver a bare keydown for the Meta/Control key itself mid-hold — not a real second keystroke. Treating
    // that as "some other key was pressed" cleared the select-all flag before the real Cmd+C keydown arrived,
    // so Cmd+C silently did nothing. A held modifier alone should never count as a deselecting keystroke.
    if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') return;
    var isCmd = event.metaKey || event.ctrlKey;
    if (event.altKey && !isCmd && !event.shiftKey && (event.key === 'Enter' || event.code === 'Enter')) {
      event.preventDefault();
      clearSelectAll();
      copyAndArchiveMerged();
      return;
    }
    if (isCmd && !event.altKey && !event.shiftKey && (event.key === 'a' || event.key === 'A' || event.code === 'KeyA')) {
      event.preventDefault();
      host.classList.add('mc-merged-select-all');
      return;
    }
    if (host.classList.contains('mc-merged-select-all')) {
      if (isCmd && !event.altKey && !event.shiftKey && (event.key === 'c' || event.key === 'C' || event.code === 'KeyC')) {
        event.preventDefault();
        clearSelectAll();
        if (!copyArchivePending) {
          copyArchivePending = true;
          setTimeout(function () { copyArchivePending = false; }, 0);
          copyAndArchiveMerged(allMergedItems());
        }
        return;
      }
      clearSelectAll();
    }
    var target = event.target;
    var card = target && target.closest ? target.closest('.mc-merged-card') : null;
    if (card) {
      if (isCmd && !event.altKey && !event.shiftKey && (event.key === 'c' || event.key === 'C' || event.code === 'KeyC')) {
        event.preventDefault();
        var item = itemForCard(card);
        if (item && !copyArchivePending) {
          copyArchivePending = true;
          setTimeout(function () { copyArchivePending = false; }, 0);
          copyAndArchiveMerged([item]);
        }
        return;
      }
      if (!event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        focusRegion(siblingRegion(card, event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (!event.altKey && (event.key === 'Home' || event.key === 'End')) {
        event.preventDefault();
        var all = Array.prototype.slice.call(host.querySelectorAll('.mc-merged-card'));
        if (all.length) focusRegion(event.key === 'Home' ? all[0] : all[all.length - 1]);
        return;
      }
      if (!event.altKey && (event.key === 'PageDown' || event.key === 'PageUp')) {
        event.preventDefault();
        var rows = Array.prototype.slice.call(host.querySelectorAll('.mc-merged-card'));
        var at = rows.indexOf(card);
        if (at < 0 || !rows.length) return;
        var viewport = mergedBody.clientHeight || host.clientHeight;
        var step = 0, used = 0;
        for (var i = at; i >= 0 && i < rows.length; i += (event.key === 'PageDown' ? 1 : -1)) {
          used += rows[i].getBoundingClientRect().height;
          if (used > viewport && step > 0) break;
          step++;
        }
        var to = at + (event.key === 'PageDown' ? 1 : -1) * Math.max(1, step - 1);
        focusRegion(rows[Math.max(0, Math.min(rows.length - 1, to))]);
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
  copyBtn.setAttribute('data-i18n', 'merged.copyAndArchive');
  copyBtn.dataset.keyhintId = 'mergedSend';
  copyBtn.textContent = t('merged.copyAndArchive');
  copyBtn.disabled = true;
  copyBtn.addEventListener('click', copyAndArchiveMerged);
  dock.bar.insertBefore(copyBtn, dock.bar.querySelector('.dock-max'));
  applyKeyHints(dock.bar);
  host.addEventListener('click', handleMergedClick);
  dock.panel.addEventListener('keydown', function (event) {
    handleMergedKeydown(event);
    if (event.defaultPrevented) event.stopPropagation();
  }, true);
  document.addEventListener('copy', handleNativeCopy);
  function handlePrunedComments(event) {
    if (validatingCommentFiles) return;
    var removed = event && event.detail && Array.isArray(event.detail.comments) ? event.detail.comments : [];
    if (removed.length) dock.close();
  }
  document.addEventListener('kakapo:comments-pruned', handlePrunedComments);
  dock.panel.__kakapoBeforeClose = function () {
    document.removeEventListener('kakapo:comments-pruned', handlePrunedComments);
    document.removeEventListener('copy', handleNativeCopy);
    afterFocusSettles(syncMenuChords);
  };
  function renderAllAddressedNote() {
    if (host.querySelector('.mc-merged-card')) return;
    var flagged = reviewComments.filter(function (c) { return c.addressed; });
    var note = document.createElement('div');
    note.className = 'mc-merged-empty-note';
    var label = document.createElement('span');
    if (!flagged.length) {
      if (!reviewComments.some(function (c) { return c.by !== 'agent'; })) {
        var parts = t('merged.empty').split('{key}');
        label.appendChild(document.createTextNode(parts[0]));
        var keys = document.createElement('span');
        keys.className = 'coach-keys';
        var key = document.createElement('kbd');
        key.textContent = shortcutLabel('addComment') || '?';
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
    label.textContent = t('merged.allAddressed', { n: flagged.length });
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
  function initializeMergedEditor(options) {
    if (!dock.panel.isConnected) return;
    var reselectIndex = options && typeof options.reselectIndex === 'number' ? options.reselectIndex : null;
    var quiet = !!(options && options.keepSelection);
    var takeFocus = !quiet || dock.panel.contains(document.activeElement);
    if (reselectIndex === null && options && options.keepSelection) {
      var open = Array.prototype.slice.call(host.querySelectorAll('.mc-merged-card'));
      var at = open.indexOf(selectedCard);
      if (at >= 0) reselectIndex = at;
    }
    blocks = mergedBlocks();
    host.innerHTML = '';
    selectedCard = null;
    blocks.forEach(function (block) {
      block.items.forEach(function (comment) { host.insertAdjacentHTML('beforeend', mergedCardHtml(comment)); });
    });
    renderAllAddressedNote();
    var isList = !!host.querySelector('.mc-merged-card');
    if (isList) { host.setAttribute('role', 'listbox'); host.setAttribute('aria-label', t('merged.title')); }
    else { host.removeAttribute('role'); host.removeAttribute('aria-label'); }
    copyBtn.disabled = !host.querySelector('.mc-merged-card');
    var cards = Array.prototype.slice.call(host.querySelectorAll('.mc-merged-card'));
    if (reselectIndex !== null && cards.length) {
      selectCard(cards[Math.min(reselectIndex, cards.length - 1)], takeFocus);
      return;
    }
    if (cards.length) selectCard(cards[0], takeFocus);
    else focusDockField(dock.panel, '#mc-merged-panel');
  }
  function startMergedEditor() {
    validatingCommentFiles = false;
    requestAnimationFrame(initializeMergedEditor);
  }
  mergedDockRefresh = function () { initializeMergedEditor({ keepSelection: true }); };
  verifyCommentFilesExist().then(startMergedEditor, startMergedEditor);
}

document.addEventListener('click', function (event) {
  var t = event.target;
  if (!t || !t.closest) return;
  var reopen = t.closest('.mc-reopen');
  if (reopen) { event.preventDefault(); reopenComment(parseInt(reopen.dataset.seq, 10)); return; }
  var pathEllipsis = t.closest('.mc-path-ell');
  if (pathEllipsis) {
    event.preventDefault();
    if (pathEllipsis.parentNode) pathEllipsis.parentNode.classList.add('mc-path-open');
    return;
  }
  var pathCode = t.closest('.mc-path-code');
  if (pathCode) { event.preventDefault(); openPathReference(pathCode.dataset.path || pathCode.textContent || ''); return; }
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

if (window.kakapoMenu && typeof window.kakapoMenu.onMergedView === 'function') {
  window.kakapoMenu.onMergedView(function () { toggleMergedView(); });
}
if (window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function') {
  window.kakapoMenu.onDiffUpdate(function (html) { try { applyDiffUpdate(html); } catch (e) {} });
}
if (window.kakapoMenu && typeof window.kakapoMenu.onReleaseView === 'function') {
  window.kakapoMenu.onReleaseView(function () { try { releaseDiffView(); } catch (e) {} });
}
if (window.kakapoMenu && typeof window.kakapoMenu.onCloseTab === 'function') {
  window.kakapoMenu.onCloseTab(function () {
    if (isSourceViewerVisible()) closeActiveSourceTab();
  });
}

var UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
function updateIsNewer(a, b) {
  var pa = String(a).split('.'), pb = String(b).split('.');
  for (var i = 0; i < 3; i++) {
    var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}
function paintUpdateStatus(latest) {
  var current = window.__KAKAPO_VERSION__ || '';
  if (!latest || !current) return;
  var status = document.getElementById('app-info-status');
  if (status) status.classList.remove('is-loading');
  if (updateIsNewer(latest, current)) {
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
}
function repaintUpdateStatus() {
  var latest = '';
  try { latest = sessionStorage.getItem('kakapo-update-latest') || ''; } catch (e) {}
  if (latest) paintUpdateStatus(latest);
}
function checkForUpdate() {
  var current = window.__KAKAPO_VERSION__ || '';
  if (!current) return;
  var apply = paintUpdateStatus;
  var cached = '', cachedAt = 0;
  try {
    cached = sessionStorage.getItem('kakapo-update-latest') || '';
    cachedAt = Number(sessionStorage.getItem('kakapo-update-checked-at')) || 0;
  } catch (e) {}
  if (cached) apply(cached);
  if (cached && Date.now() - cachedAt < UPDATE_CHECK_MS) return;
  if (typeof fetch !== 'function') return;
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

(function setupSettings() {
  var modal = document.getElementById('settings-modal');
  if (!modal) return;
  var gearBtn = document.getElementById('app-info-btn');
  var closeBtn = document.getElementById('settings-close');
  var updateBtn = document.getElementById('app-info-update');
  if (window.kakapoUpdate && typeof window.kakapoUpdate.onProgress === 'function') {
    window.kakapoUpdate.onProgress(function (p) {
      var status = document.getElementById('app-info-status');
      if (!status || !p || p.done) return;
      status.classList.remove('is-loading');
      status.textContent = t('update.downloading', { n: p.percent });
    });
  }
  var cats = Array.prototype.slice.call(modal.querySelectorAll('.settings-cat'));
  var secs = Array.prototype.slice.call(modal.querySelectorAll('.settings-section'));
  function showCat(cat) {
    cats.forEach(function (c) { c.classList.toggle('active', c.dataset.cat === cat); });
    secs.forEach(function (s) { s.classList.toggle('hidden', s.dataset.cat !== cat); });
  }
  function open(cat) {
    if (cat) showCat(cat);
    rememberOverlayFocus(modal);
    modal.classList.remove('hidden');
    var first = modal.querySelector('.settings-cat.active')
      || modal.querySelector('.settings-cat')
      || modal.querySelector('#settings-close');
    if (first && typeof first.focus === 'function') first.focus();
  }
  function close() {
    endShortcutCapture();
    var wasOpen = !modal.classList.contains('hidden');
    modal.classList.add('hidden');
    restoreOverlayFocus(modal, wasOpen);
  }
  if (gearBtn) gearBtn.addEventListener('click', function (e) { e.stopPropagation(); if (modal.classList.contains('hidden')) open('general'); else close(); });
  if (closeBtn) closeBtn.addEventListener('click', close);
  cats.forEach(function (c) { c.addEventListener('click', function () { showCat(c.dataset.cat); }); });
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  modal.addEventListener('keydown', function (e) { trapTabWithin(modal, e); });
  handleSettingsKey = function (e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) { e.stopPropagation(); e.preventDefault(); close(); return true; }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === ',' || e.code === 'Comma')) {
      if (modal.classList.contains('hidden') && document.getElementById('mc-modal')) return false;
      e.preventDefault(); e.stopPropagation();
      if (modal.classList.contains('hidden')) open('general'); else close();
      return true;
    }
    return false;
  };
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
  function applyLocale(next) {
    if (next !== 'en' && next !== 'ko') return;
    if (next === locale) return;
    locale = next;
    persistSave(LOCALE_KEY, locale);
    applyI18n();
    try { refreshComments(); } catch (e) {}
    if (document.getElementById('mc-merged-panel')) openMergedView();
  }
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
  diffHighlightSelectRef = setupCustomSelect('settings-diff-highlight',
    function () {
      return DIFF_HIGHLIGHT_MODES.map(function (mode) {
        return { value: mode, label: t('settings.diffHighlight.' + mode) };
      });
    },
    function () { return diffHighlightMode; },
    function (next) { applyDiffHighlight(next); });
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
        + ' tabindex="' + (on ? '0' : '-1') + '"'
        + ' aria-checked="' + (on ? 'true' : 'false') + '" data-theme-id="' + entry.id + '">'
        + '<span class="theme-swatch" data-swatch="' + entry.id + '" aria-hidden="true"></span>'
        + '<span class="theme-card-name">' + escapeHtml(t('theme.name.' + entry.id)) + '</span></button>';
    }).join('');
  }
  themeSelectRef = syntaxThemeSelectRef = registerLocalizedPaint({ render: renderThemeGrid });
  renderThemeGrid();
  var themeGrid = document.getElementById('settings-theme-grid');
  if (themeGrid) themeGrid.addEventListener('click', function (event) {
    var card = event.target.closest && event.target.closest('.theme-card');
    if (!card) return;
    var entry = THEMES.filter(function (x) { return x.id === card.dataset.themeId; })[0];
    if (!entry) return;
    var hadFocus = document.activeElement === card;
    if (entry.family) applySyntaxThemePref(entry.family);
    applyThemePref(entry.mode);
    renderThemeGrid();
    if (hadFocus) {
      var replacement = themeGrid.querySelector('.theme-card[data-theme-id="' + entry.id + '"]')
        || themeGrid.querySelector('.theme-card[tabindex="0"]');
      if (replacement) replacement.focus();
    }
  });
  if (themeGrid) themeGrid.addEventListener('keydown', function (event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    var cards = [].slice.call(themeGrid.querySelectorAll('.theme-card'));
    var at = cards.indexOf(document.activeElement);
    if (at < 0) return;
    var top = cards[0].getBoundingClientRect().top;
    var perRow = cards.filter(function (c) { return Math.abs(c.getBoundingClientRect().top - top) < 1; }).length || 1;
    var to = at;
    if (event.key === 'ArrowRight') to = at + 1;
    else if (event.key === 'ArrowLeft') to = at - 1;
    else if (event.key === 'ArrowDown') to = at + perRow;
    else if (event.key === 'ArrowUp') to = at - perRow;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = cards.length - 1;
    else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); cards[at].click(); return; }
    else return;
    if (to < 0 || to >= cards.length) return;
    event.preventDefault();
    cards.forEach(function (c, i) { c.tabIndex = i === to ? 0 : -1; });
    cards[to].focus();
  });

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
