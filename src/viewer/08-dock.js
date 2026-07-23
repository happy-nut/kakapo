// ===== Bottom dock: merged-prompt and memo share one docked slot below the editor =====
// Only one is visible at a time. Cmd/Ctrl+Shift+' maximizes the active dock over the editor area.
var dockHeightKey = 'kakapo-dock-height';
var dockMaximized = false;
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
function isDockFocused() {
  var ae = document.activeElement;
  return !!(ae && ae.closest && ae.closest('.dock-panel'));
}
// Close the merged/memo docks.
function closeMergedMemoDocks() {
  var m = document.getElementById('mc-merged-panel');
  var n = document.getElementById('mc-memo-panel');
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

function openMergedView(kind) {
  if (pruneCommentsForMissingFiles()) refreshComments();
  var dock = mountDock('mc-merged-panel', kind === 'q' ? t('merged.qTitle') : t('merged.cTitle'));
  dock.panel.dataset.kind = kind; // remembered so a live locale switch can re-render this same view
  var mergedBody = document.createElement('div');
  mergedBody.className = 'mc-merged-body';
  var host = document.createElement('div');
  host.className = 'mc-inline-editor-host mc-merged-editor-host';
  host.innerHTML = loadingStateHtml(t('history.loading'), 'mc-memo-empty');
  var editor = null;
  var preview = null;
  var sourceText = '';
  var activeSeq = null;
  var commentSyncTimer = 0;
  var closingMergedView = false;
  var mergedInitialized = false;
  var validatingCommentFiles = true;
  function mergedItems() { return reviewComments.filter(function (comment) { return comment.kind === kind && !comment.addressed; }); }
  function flushMergedComments() {
    if (commentSyncTimer) { clearTimeout(commentSyncTimer); commentSyncTimer = 0; }
    if (editor) sourceText = editor.getMarkdown();
    return reconcileMergedComments(kind, sourceText);
  }
  function scheduleMergedCommentSync() {
    if (commentSyncTimer) clearTimeout(commentSyncTimer);
    commentSyncTimer = setTimeout(function () {
      commentSyncTimer = 0;
      var result = reconcileMergedComments(kind, sourceText);
      if (!closingMergedView && result.hadComments && !result.remaining) { dock.close(); return; }
      requestAnimationFrame(syncMergedAnchors);
    }, 180);
  }
  function syncMergedAnchors() {
    if (!preview) return;
    var items = mergedItems();
    preview.querySelectorAll('.mc-merged-comment-anchor').forEach(function (heading) {
      var seq = parseInt(heading.dataset.commentSeq, 10);
      if (!items.some(function (comment) { return comment.seq === seq; })) {
        heading.classList.remove('mc-merged-comment-anchor', 'active');
        delete heading.dataset.commentSeq;
        heading.removeAttribute('aria-selected');
      }
    });
    var headings = Array.from(preview.querySelectorAll('h3'));
    items.forEach(function (comment) {
      var existing = preview.querySelector('.mc-merged-comment-anchor[data-comment-seq="' + comment.seq + '"]');
      var expected = commentTargetLabel(comment);
      var heading = existing || headings.find(function (candidate) {
        return !candidate.dataset.commentSeq && candidate.textContent.trim() === expected;
      });
      if (!heading) return;
      heading.classList.add('mc-merged-comment-anchor');
      heading.dataset.commentSeq = String(comment.seq);
      heading.tabIndex = -1;
    });
    if (!items.some(function (comment) { return comment.seq === activeSeq; })) activeSeq = items.length ? items[0].seq : null;
    selectMergedComment(activeSeq, false);
  }
  function selectMergedComment(seq, shouldFocus) {
    activeSeq = seq;
    if (!preview) return;
    preview.querySelectorAll('.mc-merged-comment-anchor').forEach(function (heading) {
      heading.classList.toggle('active', String(heading.dataset.commentSeq) === String(seq));
      heading.setAttribute('aria-selected', String(String(heading.dataset.commentSeq) === String(seq)));
    });
    var activeHeading = preview.querySelector('.mc-merged-comment-anchor.active');
    if (shouldFocus && activeHeading) { activeHeading.focus(); activeHeading.scrollIntoView({ block: 'center' }); }
  }
  // Resolve the review section that contains the actual ProseMirror caret. A caret in the introduction
  // intentionally has no comment action; keyboard-selected headings still fall back to activeSeq.
  function mergedCommentAtNode(node) {
    if (!preview || !node || !preview.contains(node)) return undefined;
    var element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return undefined;
    if (element === preview) return undefined; // focus without an established DOM caret: retain keyboard selection
    var direct = element.closest && element.closest('.mc-merged-comment-anchor');
    if (direct) return parseInt(direct.dataset.commentSeq, 10);
    var candidate = null;
    Array.from(preview.querySelectorAll('.mc-merged-comment-anchor')).forEach(function (heading) {
      if (heading === element || heading.contains(element) || (heading.compareDocumentPosition(element) & 4)) candidate = heading;
    });
    return candidate ? parseInt(candidate.dataset.commentSeq, 10) : null;
  }
  function mergedCommentAtCaret() {
    var editorNode = editor && typeof editor.getCaretElement === 'function' ? editor.getCaretElement() : null;
    var editorSeq = editorNode ? mergedCommentAtNode(editorNode) : undefined;
    if (editorSeq !== undefined) return editorSeq;
    var selection = window.getSelection && window.getSelection();
    return selection && selection.rangeCount ? mergedCommentAtNode(selection.anchorNode) : undefined;
  }
  function moveMergedComment(dir) {
    var items = mergedItems();
    if (!items.length) return;
    var index = items.findIndex(function (comment) { return comment.seq === activeSeq; });
    if (index < 0) index = 0;
    selectMergedComment(items[Math.max(0, Math.min(items.length - 1, index + dir))].seq, true);
  }
  function terminalHasPanes() {
    return !!(window.__kakapoTerminal && typeof window.__kakapoTerminal.paneCount === 'function' && window.__kakapoTerminal.paneCount() > 0);
  }
  function openMergedActions() {
    // Resolve which comment (if any) the caret sits in. Per-comment actions (navigate/remove) need one;
    // "Send to terminal" sends the WHOLE prompt, so it stays available even when the caret isn't on a comment.
    // caret on a comment -> select it; caret explicitly off any comment (null) -> clear; unresolved
    // (undefined, e.g. the editor wasn't precisely focused) -> keep whatever was already active.
    var caretSeq = mergedCommentAtCaret();
    if (typeof caretSeq === 'number' && !isNaN(caretSeq)) selectMergedComment(caretSeq, false);
    else if (caretSeq === null) selectMergedComment(null, false);
    var heading = activeSeq != null ? preview.querySelector('.mc-merged-comment-anchor.active') : null;
    var seq = activeSeq;
    var actions = [];
    if (heading) {
      actions.push({ label: t('dropdown.navigate'), onSelect: function () { flushMergedComments(); dock.close(); navigateToComment(seq); } });
      actions.push({ label: t('dropdown.remove'), onSelect: function () {
        if (editor) sourceText = editor.getMarkdown();
        var sourceWithoutComment = removeMergedCommentSection(kind, sourceText, seq);
        var anchors = Array.from(preview.querySelectorAll('.mc-merged-comment-anchor'));
        var at = anchors.indexOf(heading);
        var nextHeading = at >= 0 ? anchors[at + 1] : null;
        deleteComment(seq);
        var items = mergedItems();
        if (!items.length) { dock.close(); return; }
        var deletedInline = editor && typeof editor.deleteBlockRange === 'function' && editor.deleteBlockRange(heading, nextHeading);
        if (!deletedInline && editor) editor.setMarkdown(sourceWithoutComment);
        sourceText = editor ? editor.getMarkdown() : sourceWithoutComment;
        activeSeq = items[Math.max(0, Math.min(items.length - 1, at))].seq;
        syncMergedAnchors();
      } });
    }
    // Send the whole merged prompt into a terminal pane (arrows choose the pane, Enter sends).
    if (terminalHasPanes()) {
      actions.push({ label: t('merged.sendToTerminal'), onSelect: function () {
        if (editor) sourceText = editor.getMarkdown();
        flushMergedComments();
        var text = buildMergedText(kind);
        dock.close();
        window.__kakapoTerminal.enterSendMode(text);
      } });
    }
    if (!actions.length) return; // nothing to offer (no comment under the caret, no terminal panes)
    var anchor = heading || preview;
    var rect = anchor.getBoundingClientRect();
    showCustomDropdown(rect.left + 8, (heading ? rect.bottom : rect.top + 28) + 4, actions, rect.top);
  }
  function handleMergedClick(event) {
    var seq = mergedCommentAtNode(event.target);
    if (typeof seq === 'number' && !isNaN(seq)) selectMergedComment(seq, false);
  }
  function handleMergedKeydown(event) {
    if (!preview || !(event.target === preview || preview.contains(event.target))) return;
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); event.stopPropagation(); moveMergedComment(event.key === 'ArrowDown' ? 1 : -1); return;
    }
    if (event.altKey && (event.key === 'Enter' || event.code === 'Enter')) {
      event.preventDefault(); event.stopPropagation(); openMergedActions();
    }
  }
  var copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'dock-btn mc-copy-all';
  copyBtn.setAttribute('data-i18n', 'merged.copyAll');
  copyBtn.textContent = t('merged.copyAll');
  copyBtn.disabled = true;
  copyBtn.addEventListener('click', function () {
    if (editor) sourceText = editor.getMarkdown();
    flushMergedComments();
    var copied = typeof copyTextToClipboard === 'function' && copyTextToClipboard(sourceText);
    if (typeof showToast === 'function') showToast(t(copied ? 'merged.copied' : 'merged.copyFailed'));
  });
  dock.bar.insertBefore(copyBtn, dock.bar.querySelector('.dock-max'));
  mergedBody.appendChild(host);
  dock.body.appendChild(mergedBody);
  function handlePrunedComments(event) {
    if (validatingCommentFiles) return;
    var removed = event && event.detail && Array.isArray(event.detail.comments) ? event.detail.comments : [];
    if (removed.some(function (comment) { return comment.kind === kind; })) dock.close();
  }
  document.addEventListener('kakapo:comments-pruned', handlePrunedComments);
  dock.panel.__kakapoBeforeClose = function () {
    closingMergedView = true;
    document.removeEventListener('kakapo:comments-pruned', handlePrunedComments);
    if (mergedInitialized) flushMergedComments();
    if (editor) editor.destroy();
  };
  function initializeMergedEditor() {
    if (!dock.panel.isConnected) return;
    sourceText = buildMergedText(kind);
    mergedInitialized = true;
    loadInlineMarkdownEditor().then(function (factory) {
      if (!dock.panel.isConnected) return;
      host.innerHTML = '';
      editor = factory.create({
        element: host,
        markdown: sourceText,
        className: 'mc-merged-preview',
        placeholder: kind === 'q' ? t('merged.qTitle') : t('merged.cTitle'),
        onUpdate: function (markdown) {
          sourceText = markdown;
          scheduleMergedCommentSync();
          requestAnimationFrame(syncMergedAnchors);
        },
      });
      preview = host.querySelector('.mc-inline-editor');
      if (!preview) throw new Error('inline editor surface is unavailable');
      preview.tabIndex = 0;
      preview.addEventListener('click', handleMergedClick);
      // Capture before ProseMirror's keymap can consume Option+Enter. The editor's own selection adapter
      // above still supplies the exact comment block, so the dropdown follows the visible caret.
      dock.panel.addEventListener('keydown', handleMergedKeydown, true);
      copyBtn.disabled = false;
      syncMergedAnchors();
      focusDockField(preview, '#mc-merged-panel');
    }).catch(function () {
      host.innerHTML = '<div class="mc-memo-empty">' + escapeHtml(t('memo.loadFailed')) + '</div>';
      showToast(t('memo.loadFailed'));
    });
  }
  verifyCommentFilesExist().then(function () {
    validatingCommentFiles = false;
    initializeMergedEditor();
  }, function () {
    validatingCommentFiles = false;
    initializeMergedEditor();
  });
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

pruneCommentsForMissingFiles();
refreshComments();


// In Electron, the Review menu's Cmd/Ctrl+Shift+/ and +. accelerators arrive here via IPC
// (macOS reserves Cmd+? for its Help search, so the menu claims it and routes to these views).
if (window.kakapoMenu && typeof window.kakapoMenu.onMergedView === 'function') {
  window.kakapoMenu.onMergedView(function (kind) { openMergedView(kind); });
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
        status.textContent = t('settings.updateAvailable') + ': v' + latest + ' — npm i -g @happy-nut/kakapo';
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
  fetch('https://registry.npmjs.org/@happy-nut/kakapo/latest', { cache: 'no-store' })
    .then(function (res) { return res && res.ok ? res.json() : null; })
    .then(function (data) {
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
  var flag = document.getElementById('app-update-flag');
  var updateBtn = document.getElementById('app-info-update');
  var pta = document.getElementById('settings-prompt-plan');
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
    // Defaults are real editable values, not placeholders. This makes the effective prompt visible
    // before the first edit and lets a reviewer verify exactly what was saved after reopening Settings.
    if (pta) { pta.value = (typeof s.plan === 'string' && s.plan.trim()) ? s.plan : defaultMergePrompt('plan'); pta.placeholder = ''; }
    if (qta) { qta.value = (typeof s.q === 'string' && s.q.trim()) ? s.q : defaultMergePrompt('q'); qta.placeholder = ''; }
    if (cta) { cta.value = (typeof s.c === 'string' && s.c.trim()) ? s.c : defaultMergePrompt('c'); cta.placeholder = ''; }
  }
  function open(cat) { fill(); if (cat) showCat(cat); modal.classList.remove('hidden'); }
  function close() { modal.classList.add('hidden'); }
  var flashTimer = null;
  function flash() { if (!savedMsg) return; savedMsg.textContent = t('settings.saved'); if (flashTimer) clearTimeout(flashTimer); flashTimer = setTimeout(function () { savedMsg.textContent = ''; }, 1200); }
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
  if (resetBtn) resetBtn.addEventListener('click', function () { saveMergePrompt('plan', ''); saveMergePrompt('q', ''); saveMergePrompt('c', ''); fill(); flash(); });
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
      fill(); // unsaved merge-prompt defaults follow the active locale
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
  syntaxThemeSelectRef = setupCustomSelect('settings-syntax-theme',
    function () { return [{ value: 'default', label: t('syntaxTheme.default') }, { value: 'darcula', label: t('syntaxTheme.darcula') }]; },
    function () { return syntaxTheme; },
    function (next) {
      if (next === syntaxTheme) return;
      syntaxTheme = next;
      persistSave(SYNTAX_THEME_KEY, syntaxTheme);
      applySyntaxTheme();
    });
  // Integrated-terminal bell → native notification opt-out. Default on; the terminal client reads the same
  // key ('kakapo-terminal-bell-notify') before raising a notification.
  var bellCb = document.getElementById('set-bell-notify');
  if (bellCb) {
    bellCb.checked = persistRead('kakapo-terminal-bell-notify') !== false;
    bellCb.addEventListener('change', function () { persistSave('kakapo-terminal-bell-notify', bellCb.checked); });
  }
})();
