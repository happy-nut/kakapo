// ===== Bottom dock: merged-prompt and memo share one docked slot below the editor =====
// Only one is visible at a time. Cmd/Ctrl+Shift+' maximizes the active dock over the editor area.
var dockHeightKey = 'monacori-dock-height';
var dockMaximized = false;
function applyDockHeight(px) {
  var h = Math.max(140, Math.min(px, window.innerHeight - 120));
  document.documentElement.style.setProperty('--dock-height', h + 'px');
}
(function () { var s = parseInt(localStorage.getItem(dockHeightKey) || '', 10); if (s) applyDockHeight(s); })();
function activeDockPanel() {
  return document.getElementById('mc-merged-panel') || document.getElementById('mc-memo-panel');
}
function applyDockMaximized() {
  if (!activeDockPanel()) dockMaximized = false; // nothing docked -> can't stay maximized
  document.body.classList.toggle('dock-maximized', dockMaximized);
}
function toggleDockMaximized() {
  // Maximize only the merged/memo panel that currently owns focus.
  if (treeFocusIndex >= 0) return;
  var ae = document.activeElement;
  if (!(ae && ae.closest && ae.closest('.dock-panel'))) return;
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
    try { if (typeof panel.__monacoriBeforeClose === 'function') panel.__monacoriBeforeClose(); } catch (e) {}
    panel.remove();
  });
  document.querySelectorAll('.dock-backdrop').forEach(function (b) { b.remove(); });
  document.body.classList.toggle('dock-open', !!activeDockPanel());
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
function mountDock(id, titleText) {
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
  var mergedBody = document.createElement('div');
  mergedBody.className = 'mc-merged-body';
  var preview = document.createElement('div');
  preview.className = 'mc-merged-preview markdown-body';
  preview.tabIndex = 0;
  var sourceText = '';
  var activeSeq = null;
  function mergedItems() { return reviewComments.filter(function (comment) { return comment.kind === kind; }); }
  function selectMergedComment(seq, shouldFocus) {
    activeSeq = seq;
    preview.querySelectorAll('.mc-merged-comment-anchor').forEach(function (heading) {
      heading.classList.toggle('active', String(heading.dataset.commentSeq) === String(seq));
      heading.setAttribute('aria-selected', String(String(heading.dataset.commentSeq) === String(seq)));
    });
    var activeHeading = preview.querySelector('.mc-merged-comment-anchor.active');
    if (shouldFocus && activeHeading) { activeHeading.focus(); activeHeading.scrollIntoView({ block: 'center' }); }
  }
  function renderMergedDocument(closeWhenEmpty) {
    var items = mergedItems();
    if (!items.length && closeWhenEmpty) { dock.close(); return; }
    sourceText = buildMergedText(kind);
    preview.innerHTML = renderMarkdownHtml(sourceText);
    var headings = Array.from(preview.querySelectorAll('h3'));
    items.forEach(function (comment) {
      var expected = commentTargetLabel(comment);
      var heading = headings.find(function (candidate) { return !candidate.dataset.commentSeq && candidate.textContent.trim() === expected; });
      if (!heading) return;
      heading.classList.add('mc-merged-comment-anchor');
      heading.dataset.commentSeq = String(comment.seq);
      heading.tabIndex = -1;
    });
    if (!items.some(function (comment) { return comment.seq === activeSeq; })) activeSeq = items.length ? items[0].seq : null;
    selectMergedComment(activeSeq, false);
  }
  function moveMergedComment(dir) {
    var items = mergedItems();
    if (!items.length) return;
    var index = items.findIndex(function (comment) { return comment.seq === activeSeq; });
    if (index < 0) index = 0;
    selectMergedComment(items[Math.max(0, Math.min(items.length - 1, index + dir))].seq, true);
  }
  function openMergedActions() {
    if (activeSeq == null) return;
    var heading = preview.querySelector('.mc-merged-comment-anchor.active');
    if (!heading) return;
    var rect = heading.getBoundingClientRect();
    var seq = activeSeq;
    showCustomDropdown(rect.left + 8, rect.bottom + 4, [
      { label: t('dropdown.navigate'), onSelect: function () { dock.close(); navigateToComment(seq); } },
      { label: t('dropdown.remove'), onSelect: function () { deleteComment(seq); renderMergedDocument(true); } },
    ], rect.top);
  }
  preview.addEventListener('click', function (event) {
    var heading = event.target && event.target.closest ? event.target.closest('.mc-merged-comment-anchor') : null;
    if (heading) selectMergedComment(parseInt(heading.dataset.commentSeq, 10), false);
  });
  preview.addEventListener('keydown', function (event) {
    if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); event.stopPropagation(); moveMergedComment(event.key === 'ArrowDown' ? 1 : -1); return;
    }
    if (event.altKey && (event.key === 'Enter' || event.code === 'Enter')) {
      event.preventDefault(); event.stopPropagation(); openMergedActions();
    }
  });
  var copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'dock-btn mc-copy-all';
  copyBtn.setAttribute('data-i18n', 'merged.copyAll');
  copyBtn.textContent = t('merged.copyAll');
  copyBtn.addEventListener('click', function () {
    var copied = typeof copyTextToClipboard === 'function' && copyTextToClipboard(sourceText);
    if (typeof showToast === 'function') showToast(t(copied ? 'merged.copied' : 'merged.copyFailed'));
  });
  dock.bar.insertBefore(copyBtn, dock.bar.querySelector('.dock-max'));
  mergedBody.appendChild(preview);
  dock.body.appendChild(mergedBody);
  renderMergedDocument(false);
  focusDockField(preview, '#mc-merged-panel');
}

// One Notion-style Markdown document per worktree. Electron persists it below app.getPath('userData'); the
// static fallback uses a review-path localStorage key only for browser tests. No memo enters the repository.
var memoFallbackKey = 'monacori-memo-document:' + location.pathname;
function fallbackMemoDocument() {
  try {
    var value = JSON.parse(localStorage.getItem(memoFallbackKey) || '{}');
    return value && typeof value.body === 'string' ? value : { version: 1, worktreePath: location.pathname, body: '', updatedAt: null };
  } catch (e) { return { version: 1, worktreePath: location.pathname, body: '', updatedAt: null }; }
}
function readMemoDocument() {
  if (window.monacoriMemo && typeof window.monacoriMemo.read === 'function') return window.monacoriMemo.read();
  return Promise.resolve(fallbackMemoDocument());
}
function writeMemoDocument(body) {
  if (window.monacoriMemo && typeof window.monacoriMemo.write === 'function') return window.monacoriMemo.write(body);
  var document = { version: 1, worktreePath: location.pathname, body: String(body || ''), updatedAt: new Date().toISOString() };
  try { localStorage.setItem(memoFallbackKey, JSON.stringify(document)); } catch (e) {}
  return Promise.resolve(document);
}
function deleteMemoDocument() {
  if (window.monacoriMemo && typeof window.monacoriMemo.remove === 'function') return window.monacoriMemo.remove();
  try { localStorage.removeItem(memoFallbackKey); } catch (e) {}
  return Promise.resolve({ ok: true });
}
var inlineMarkdownEditorLoad = null;
function loadInlineMarkdownEditor() {
  if (window.MonacoriMarkdownEditor) return Promise.resolve(window.MonacoriMarkdownEditor);
  if (inlineMarkdownEditorLoad) return inlineMarkdownEditorLoad;
  inlineMarkdownEditorLoad = new Promise(function (resolve, reject) {
    var script = document.createElement('script');
    script.src = 'monacori-asset://app/markdown-editor.js';
    script.async = true;
    script.addEventListener('load', function () {
      if (window.MonacoriMarkdownEditor) resolve(window.MonacoriMarkdownEditor);
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
  host.innerHTML = '<div class="mc-memo-empty">' + escapeHtml(t('memo.loading')) + '</div>';
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
  dock.panel.__monacoriBeforeClose = function () { flushMemo(); if (editor) editor.destroy(); };
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


// In Electron, the Review menu's Cmd/Ctrl+Shift+/ and +. accelerators arrive here via IPC
// (macOS reserves Cmd+? for its Help search, so the menu claims it and routes to these views).
if (window.monacoriMenu && typeof window.monacoriMenu.onMergedView === 'function') {
  window.monacoriMenu.onMergedView(function (kind) { openMergedView(kind); });
}
if (window.monacoriMenu && typeof window.monacoriMenu.onOpenMemo === 'function') {
  // Cmd/Ctrl+Shift+N from the Review menu -> open/close the prompt memo.
  window.monacoriMenu.onOpenMemo(function () { openMemoView(); });
}
if (window.monacoriMenu && typeof window.monacoriMenu.onDiffUpdate === 'function') {
  // Electron watch: refresh review data in place so comments and navigation context stay stable.
  window.monacoriMenu.onDiffUpdate(function (html) { try { applyDiffUpdate(html); } catch (e) {} });
}
if (window.monacoriMenu && typeof window.monacoriMenu.onCloseTab === 'function') {
  window.monacoriMenu.onCloseTab(function () {
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
    if (pta) { pta.value = typeof s.plan === 'string' ? s.plan : ''; pta.placeholder = defaultMergePrompt('plan'); }
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
        else {
          updateBtn.disabled = false;
          if (status) {
            status.textContent = t('settings.updateFailed');
            status.title = r && r.error ? String(r.error) : '';
          }
          if (r && r.error) console.warn('monacori update failed:', r.error);
        }
      }).catch(function (error) {
        updateBtn.disabled = false;
        if (status) {
          status.textContent = t('settings.updateFailed');
          status.title = error ? String(error) : '';
        }
        if (error) console.warn('monacori update failed:', error);
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
