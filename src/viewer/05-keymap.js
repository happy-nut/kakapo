function isFloatingModalOpen() {
  var sm = document.getElementById('settings-modal');
  if (sm && !sm.classList.contains('hidden')) return true;
  var hv = document.getElementById('history-view');
  if (hv && !hv.classList.contains('hidden')) return true; // history overlay owns the keys (Esc/filter/click)
  if (document.getElementById('goto-line')) return true; // go-to-line prompt owns the keys until Enter/Esc
  // The merged/memo panels are now docked (inline), not overlays — but while one OWNS focus we still stand
  // down the global nav shortcuts so typing / ▲▼ inside it isn't hijacked. Focus elsewhere -> shortcuts run.
  return isDockFocused();
}
document.addEventListener('keydown', (event) => {
  if (!quickOpen?.classList.contains('hidden')) {
    if (handleQuickOpenKey(event)) return;
  }
  var usagesBox = document.getElementById('usages');
  if (usagesBox && !usagesBox.classList.contains('hidden')) {
    if (handleUsagesKey(event)) return;
  }

  // Dock controls fire regardless of focus (merged / memo) — they sit ABOVE the focus guard so
  // they still work from inside a dock panel. Cmd/Ctrl+Shift+' maximizes the active dock; Cmd/Ctrl+Shift+/
  // and +. open the merged views; Cmd/Ctrl+Shift+N toggles the memo. (Match event.code so IME/layout never
  // swallows the combo.) Settings is a true overlay, so these stand down while it is up.
  var settingsUp = (function () { var s = document.getElementById('settings-modal'); return !!(s && !s.classList.contains('hidden')); })();
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === 'Quote') {
    event.preventDefault();
    toggleDockMaximized();
    return;
  }
  if (!settingsUp && (event.metaKey || event.ctrlKey) && !event.altKey && (event.code === 'Slash' || event.code === 'Period' || event.key === '?' || event.key === '>')) {
    event.preventDefault();
    openMergedView((event.code === 'Slash' || event.key === '?') ? 'q' : 'c');
    return;
  }
  if (!settingsUp && (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && (event.code === 'KeyN' || event.key === 'n' || event.key === 'N')) {
    event.preventDefault();
    openMemoView();
    return;
  }
  // Cmd/Ctrl+9 toggles the git history view (above the focus guard so a 2nd press closes it from inside).
  if (!settingsUp && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.code === 'Digit9' || event.key === '9') && typeof toggleHistory === 'function') {
    event.preventDefault();
    toggleHistory();
    return;
  }
  // Cmd/Ctrl+8 toggles the read-only Change Impact inspector. It remains available while the panel is
  // focused because a second press is the quickest way to dismiss it.
  if (!settingsUp && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.code === 'Digit8' || event.key === '8') && typeof toggleImpact === 'function') {
    event.preventDefault();
    toggleImpact();
    return;
  }
  if (event.key === 'Escape' && typeof isImpactOpen === 'function' && isImpactOpen()) {
    event.preventDefault();
    closeImpact();
    return;
  }
  if (typeof isHistoryOpen === 'function' && isHistoryOpen() && typeof handleHistoryKey === 'function' && handleHistoryKey(event)) return;

  // Settings overlay (or a focused merged/memo dock) captures keys: stand down the rest of the global
  // shortcuts (Cmd+1, F7, Cmd+[/], Cmd+B, …). Each has its own Esc + editing handlers.
  if (isFloatingModalOpen()) return;

  // Cmd/Ctrl+A in the diff/source view selects ONLY that view's content (the browser default reached into
  // the sidebar). In an editable field, let the default select-within-field stand.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.key === 'a' || event.key === 'A')) {
    var aae = document.activeElement;
    if (!(aae && (aae.tagName === 'INPUT' || aae.tagName === 'TEXTAREA' || aae.tagName === 'SELECT')) && selectAllInView()) {
      event.preventDefault();
      return;
    }
  }

  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === '1') {
    event.preventDefault();
    // Coming from the diff: open the file you were viewing as source so Cmd+1 lands ON it (not a stale/blank
    // source pane), and the tree below points at the same file. Capture the path BEFORE openSourceFile flips
    // the view (isDiffViewVisible would then be false).
    if (isDiffViewVisible()) {
      var dw1 = diffActiveWrapper();
      var dn1 = dw1 && dw1.querySelector('.d2h-file-name');
      var dpath1 = (diffCursor && diffCursor.path) || (dn1 ? (dn1.textContent || '').trim() : '');
      if (dpath1 && sourceByPath.has(dpath1)) openSourceFile(dpath1);
    }
    setTab('files');
    focusOpenFileInTree();
    return;
  }
  // Cmd/Ctrl+L = go to line (numeric prompt); Cmd/Ctrl+K = copy the caret's file:line. Skip when an
  // editable field owns focus (a comment composer textarea) so we don't hijack the user's typing.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.key === 'l' || event.key === 'L')) {
    var lkae = document.activeElement;
    if (!(lkae && (lkae.tagName === 'INPUT' || lkae.tagName === 'TEXTAREA' || lkae.tagName === 'SELECT'))) {
      event.preventDefault();
      openGotoLine();
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.key === 'k' || event.key === 'K')) {
    var kkae = document.activeElement;
    if (!(kkae && (kkae.tagName === 'INPUT' || kkae.tagName === 'TEXTAREA' || kkae.tagName === 'SELECT'))) {
      event.preventDefault();
      copyCaretLocation();
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === '0') {
    event.preventDefault();
    setTab('changes');
    focusOpenFileInTree();
    return;
  }

  // Tab / Shift+Tab move the "cursor" horizontally between the left sidebar and the right content pane.
  if (event.key === 'Tab') {
    const activeEl = document.activeElement;
    const inField = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
    if (!inField) {
      event.preventDefault();
      if (event.shiftKey) {
        // In the diff view, Shift+Tab toggles the caret between the old/new panes (this change owns
        // Shift+Tab L/R; plain arrows stay in-pane and Cmd/Ctrl+Arrows also cross — see diff nav).
        if (isDiffViewVisible() && diffCursor) {
          const tabSide = diffCursor.side === 'new' ? 'old' : 'new';
          const tabWrap = diffWrapperByPath(diffCursor.path);
          const tabRow = tabWrap ? diffRowAt(tabWrap, tabSide, diffCursor.rowIndex) : null;
          if (isDiffCodeRow(tabRow)) setDiffCursor(diffCursor.path, tabSide, diffCursor.rowIndex, 0, true);
          return;
        }
        focusTree(treeFocusIndex >= 0 ? treeFocusIndex : 0); // ← left: focus sidebar tree
      } else {
        clearTreeFocus(); // → right: hand focus back to the content pane (source caret / diff nav)
        const openPath = document.getElementById('source-viewer')?.dataset.openPath || '';
        if (isSourceViewerVisible() && openPath && (!viewerCursor || viewerCursor.path !== openPath)) {
          setSourceCursor(openPath, viewerCursor ? viewerCursor.lineIndex : 0, 0, false, -1);
        }
      }
      return;
    }
  }

  // (Merged views Cmd/Ctrl+Shift+/ +. and the memo Cmd/Ctrl+Shift+N are handled above the focus guard so
  // they work from inside a dock too.)
  // "?" = question, ">" = change-request composer on the current line/selection (no modifier).
  if (!event.altKey && !event.metaKey && !event.ctrlKey && (event.key === '?' || event.key === '>')) {
    const ce = document.activeElement;
    const inEditable = ce && (ce.tagName === 'INPUT' || ce.tagName === 'TEXTAREA' || ce.tagName === 'SELECT');
    if (!inEditable) {
      event.preventDefault();
      openComposer(event.key === '?' ? 'q' : 'c');
      return;
    }
  }

  // "<" (Shift+,) toggles "viewed" for the current file (source openPath, else active diff file).
  if (!event.altKey && !event.metaKey && !event.ctrlKey && event.key === '<') {
    const ce2 = document.activeElement;
    const inEditable2 = ce2 && (ce2.tagName === 'INPUT' || ce2.tagName === 'TEXTAREA' || ce2.tagName === 'SELECT');
    if (!inEditable2) {
      let vp = isSourceViewerVisible() ? (document.getElementById('source-viewer')?.dataset.openPath || '') : '';
      if (!vp && typeof diffActiveWrapper === 'function') {
        const vw = diffActiveWrapper();
        const vn = vw && vw.querySelector('.d2h-file-name');
        if (vn && vn.textContent) vp = vn.textContent.trim();
      }
      if (vp && currentFileSignature(vp)) {
        event.preventDefault();
        const willView = !isFileViewed(vp);
        setFileViewed(vp, willView);
        // Marking viewed hides this file's diff body — don't strand the caret on the now-blank file.
        // Auto-advance to the next unviewed change (the user's flow: mark viewed -> jump to next).
        // Unmarking stays put. If every file is viewed, gotoNextUnviewedFile is a no-op.
        if (willView) gotoNextUnviewedFile(vp);
        return;
      }
    }
  }

  // Opt/Alt + Left/Right: word-wise caret jump (source or diff view).
  if (event.altKey && !event.metaKey && !event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    var wae = document.activeElement;
    var wInField = wae && (wae.tagName === 'INPUT' || wae.tagName === 'TEXTAREA' || wae.tagName === 'SELECT');
    if (!wInField && treeFocusIndex < 0) {
      var wdir = event.key === 'ArrowRight' ? 1 : -1;
      if (isSourceViewerVisible() && viewerCursor) { event.preventDefault(); moveSourceWord(wdir, event.shiftKey); return; }
      if (isDiffViewVisible() && diffCursor) { event.preventDefault(); moveDiffWord(wdir, event.shiftKey); return; }
    }
  }

  // PageUp/Down scroll the diff/source view. There's no focusable scroller (the diff caret is a JS cursor),
  // and d2h-file-side-diff's horizontal scrollport even swallows vertical wheel, so handle paging explicitly.
  // Only when the tree isn't focused — the tree pages itself in handleTreeKey below.
  if (treeFocusIndex < 0 && (event.key === 'PageDown' || event.key === 'PageUp') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    if (isSourceViewerVisible() && isMonacoSourceActive()) return;
    var psc = isDiffViewVisible() ? document.getElementById('diff2html-container') : (isSourceViewerVisible() ? document.getElementById('source-body') : null);
    if (psc) { event.preventDefault(); psc.scrollTop += (event.key === 'PageDown' ? 0.9 : -0.9) * psc.clientHeight; return; }
  }
  // A non-Shift keystroke between the two Shifts cancels the pending double-Shift quick-open. Without this,
  // "Shift → type something → Shift" within 300ms still popped the search, so it fired on nearly every other
  // keystroke. Reset BEFORE the caret handlers below (they swallow arrows) so arrow keys break it too.
  if (event.key !== 'Shift') { lastShiftAt = 0; lastShiftSide = 0; }
  if (treeFocusIndex >= 0 && handleTreeKey(event)) return;
  if (treeFocusIndex < 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isSourceViewerVisible() && handleSourceCaretKey(event)) return;
  if (treeFocusIndex < 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isDiffViewVisible() && handleDiffCaretKey(event)) return;

  if (event.key === 'Shift' && !event.repeat) {
    const now = performance.now();
    // event.location: 1 = left Shift, 2 = right Shift, 0 = unspecified.
    // Require the SAME physical side twice (left+right never counts) within a
    // tight 300ms window so quick-open doesn't fire on accidental or mixed
    // Shift presses. The side !== 0 guard keeps an unknown location from ever
    // matching itself and triggering.
    const side = event.location;
    if (side !== 0 && side === lastShiftSide && now - lastShiftAt < 300) {
      event.preventDefault();
      lastShiftAt = 0;
      lastShiftSide = 0;
      openQuickOpen('all');
      return;
    }
    lastShiftAt = now;
    lastShiftSide = side;
  }

  if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openQuickOpen('content');
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    openQuickOpen('recent');
    return;
  }

  if ((event.metaKey || event.altKey) && event.key === 'Enter' && isSourceViewerVisible()) {
    const enterPath = document.getElementById('source-viewer')?.dataset.openPath || '';
    if (isHttpFile(enterPath)) {
      event.preventDefault();
      runHttpAtCaret();
      return;
    }
  }

  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    if (isSourceViewerVisible()) goToSymbolUnderCursor();
    else openDiffFileAtCaret();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && (event.code === 'KeyO' || event.key.toLowerCase() === 'o')) {
    event.preventDefault();
    openWorkspaceSymbols();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && (event.code === 'KeyB' || event.key.toLowerCase() === 'b')) {
    var aeImpl = document.activeElement;
    if (aeImpl && (aeImpl.tagName === 'INPUT' || aeImpl.tagName === 'TEXTAREA' || aeImpl.tagName === 'SELECT')) return;
    event.preventDefault();
    goToImplementation();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.key === 'b' || event.key === 'B')) {
    var aeB = document.activeElement;
    if (aeB && (aeB.tagName === 'INPUT' || aeB.tagName === 'TEXTAREA' || aeB.tagName === 'SELECT')) return;
    event.preventDefault();
    if (isSourceViewerVisible()) goToSymbolUnderCursor();
    else if (isDiffViewVisible()) goToSymbolFromDiff();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isSourceViewerVisible() && viewerCursor) {
    event.preventDefault();
    const lineEdgeFile = sourceByPath.get(viewerCursor.path);
    if (lineEdgeFile && lineEdgeFile.embedded) {
      const lineEdgeLines = lineEdgeFile.content.split(/\r?\n/);
      const lineEdgeCol = event.key === 'ArrowLeft' ? 0 : (lineEdgeLines[viewerCursor.lineIndex] || '').length;
      if (event.shiftKey) { if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column }; }
      else selectionAnchor = null;
      setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, lineEdgeCol, true, -1);
      applySourceSelection();
    }
    return;
  }

  // Diff view: Cmd/Ctrl + Left/Right goes to the line start / end; pressing it again AT the
  // edge crosses to the adjacent pane (Left -> old, Right -> new). Plain arrows never cross.
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isDiffViewVisible() && diffCursor) {
    event.preventDefault();
    const edgeWrap = diffWrapperByPath(diffCursor.path);
    const edgeRow = edgeWrap ? diffRowAt(edgeWrap, diffCursor.side, diffCursor.rowIndex) : null;
    const edgeLen = edgeRow ? diffLineText(edgeRow).length : 0;
    if (event.key === 'ArrowLeft') {
      if (diffCursor.column > 0) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, 0, true); // -> line start
      } else if (diffCursor.side === 'new') { // already at start -> cross to old (left)
        const oldRow = edgeWrap ? diffRowAt(edgeWrap, 'old', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(oldRow)) setDiffCursor(diffCursor.path, 'old', diffCursor.rowIndex, diffLineText(oldRow).length, true);
      }
    } else { // ArrowRight
      if (diffCursor.column < edgeLen) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, edgeLen, true); // -> line end
      } else if (diffCursor.side === 'old') { // already at end -> cross to new (right)
        const newRow = edgeWrap ? diffRowAt(edgeWrap, 'new', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(newRow)) setDiffCursor(diffCursor.path, 'new', diffCursor.rowIndex, 0, true);
      }
    }
    return;
  }

  // Cmd/Ctrl+[ / ] walk the cursor-position history (back / forward), like an editor's Go Back/Forward.
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && (event.key === '[' || event.key === ']' || event.key === '{' || event.key === '}')) {
    if (isSourceViewerVisible() && sourceTabs.length > 1) { event.preventDefault(); cycleSourceTab((event.key === '[' || event.key === '{') ? -1 : 1); return; }
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === '[' || event.key === ']')) {
    var navEl = document.activeElement;
    var navInField = navEl && (navEl.tagName === 'INPUT' || navEl.tagName === 'TEXTAREA' || navEl.tagName === 'SELECT');
    if (!navInField) {
      event.preventDefault();
      if (event.key === '[') navBack(); else navForward();
      return;
    }
  }

  if (event.key === 'F7' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    const delta = event.shiftKey ? -1 : 1;
    const sourceViewer = document.getElementById('source-viewer');
    // Forward F7 from the source view enters the diff at the open file's own hunk, so the reviewer lands
    // where they were reading. Shift+F7 — and any file with no hunk of its own — falls through to plain
    // prev/next-change navigation across the whole diff.
    if (delta > 0 && sourceViewer && !sourceViewer.classList.contains('hidden')) {
      const sp = sourceViewer.dataset.openPath || '';
      const sourceHunk = firstHunkForPath(sp);
      // Enter the diff at the open file's own hunk — UNLESS it's already viewed. A viewed file's diff body
      // is hidden (display:none), so landing on it blanks the content and F7 appears stuck; fall through to
      // next() instead so we skip to an unviewed change.
      if (sourceHunk >= 0 && !isFileViewed(sp)) {
        setActive(sourceHunk);
        return;
      }
    }
    next(delta);
  }
});

quickInput?.addEventListener('input', () => renderQuickOpenResults());
quickResults?.addEventListener('mousemove', (event) => {
  const item = event.target.closest?.('.quick-open-item');
  if (!item) return;
  quickActive = Number(item.dataset.index || 0);
  updateQuickActive();
});
quickResults?.addEventListener('click', (event) => {
  const item = event.target.closest?.('.quick-open-item');
  if (!item) return;
  const index = Number(item.dataset.index || 0);
  openQuickItem(quickItems[index]);
});
quickOpen?.addEventListener('click', (event) => {
  if (event.target === quickOpen) closeQuickOpen();
});
document.getElementById('usages-results')?.addEventListener('mousemove', function (event) {
  var it = event.target.closest && event.target.closest('.usage-item');
  if (!it) return;
  usageActive = Number(it.dataset.index || 0);
  updateUsageActive();
});
document.getElementById('usages-results')?.addEventListener('click', function (event) {
  var it = event.target.closest && event.target.closest('.usage-item');
  if (!it) return;
  openUsageItem(usageItems[Number(it.dataset.index || 0)]);
});
document.getElementById('usages')?.addEventListener('click', function (event) {
  if (event.target && event.target.id === 'usages') closeUsages();
});

// Delegated (like #files-panel below) so it survives the in-place diff update that re-captures `links`
// on every watch tick — per-element listeners would be lost on the new nodes, and then Cmd+0 → arrow →
// Enter (which calls row.click()) would silently do nothing.
document.getElementById('changes-panel')?.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('.file-link') : null;
  if (!link) return;
  showDiffView(false);
  const target = Number(link.dataset.hunk);
  if (!Number.isNaN(target) && target >= 0 && target < hunkTotal()) {
    event.preventDefault();
    setActive(target);
  }
});

// Delegated so it works whether the tree is inline (small repos) or materialized later (big repos).
document.getElementById('files-panel')?.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('.source-link') : null;
  if (link && link.dataset.sourceFile) openSourceFile(link.dataset.sourceFile);
});

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => setTab(button.dataset.tab || 'changes'));
});

// Activity rail (IntelliJ-style): click an icon to navigate/toggle its view. The settings button carries
// no data-view and keeps its own id-based handler.
document.querySelector('.activity-rail')?.addEventListener('click', (event) => {
  const btn = event.target.closest && event.target.closest('.rail-btn[data-view]');
  if (!btn) return;
  const view = btn.dataset.view;
  if (view === 'changes') { setTab('changes'); if (!isDiffViewVisible()) showDiffView(false); }
  else if (view === 'files') { setTab('files'); }
  else if (view === 'q' || view === 'c') { toggleMergedRail(view); }
  else if (view === 'memo') { openMemoView(); } // openMemoView already toggles
  else if (view === 'impact') { toggleImpact(); }
  else if (view === 'history') { toggleHistory(); }
  syncRail();
});

document.getElementById('back-to-diff')?.addEventListener('click', () => showDiffView(true));
document.getElementById('source-tabs')?.addEventListener('click', function (event) {
  var closeBtn = event.target && event.target.closest && event.target.closest('.source-tab-close');
  if (closeBtn) { event.stopPropagation(); event.preventDefault(); closeSourceTab(closeBtn.getAttribute('data-close-path')); return; }
  var tab = event.target && event.target.closest && event.target.closest('.source-tab');
  if (tab) openSourceFile(tab.getAttribute('data-tab-path'));
});
document.getElementById('diff-viewed-toggle')?.addEventListener('click', function () {
  var btn = document.getElementById('diff-viewed-toggle');
  var path = btn ? (btn.dataset.file || '') : '';
  if (path) setFileViewed(path, !isFileViewed(path));
});
document.getElementById('source-body')?.addEventListener('click', handleSourceClick);
document.getElementById('source-body')?.addEventListener('click', function (event) {
  var img = event.target && event.target.closest && event.target.closest('.image-preview');
  if (img) openLightbox(img.getAttribute('src'), img.getAttribute('alt'));
});
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && lightboxOpen()) { event.preventDefault(); event.stopPropagation(); closeLightbox(); }
}, true);
document.addEventListener('copy', handleSourceCopy);

applyI18n(); // first paint already shows English (inline); this swaps to the saved locale before the rest of init renders dynamic text
populateHttpEnvSelect();
const restored = restoreUiState();
if (!restored) {
  const initial = location.hash.match(/^#hunk-(\d+)$/);
  const hasDiff = Boolean(document.querySelector('#diff2html-container .d2h-file-wrapper'));
  if (initial) setActive(Number(initial[1]), false);
  // Clean tree (nothing to review): open a file (README first) instead of staring at an empty diff.
  else if (!hasDiff) openDefaultSourceFile();
  else if (REVIEW_LAZY_LOAD) showDiffView(false); // big repos with changes: open to the diff (Changes); the source tree stays deferred until the Files tab is opened
  else openDefaultSourceFile();
}
initSourceTreeFolds();
syncRail(); // reflect the initial view on the activity rail
// Electron receives live updates over IPC (monacoriMenu.onDiffUpdate); only serve/browser needs the HTTP
// poller. Under file:// its fetch just fails every 1.5s for the app's whole life, so skip it in Electron.
if (watchEnabled && !(window.monacoriMenu && typeof window.monacoriMenu.onDiffUpdate === 'function')) {
  setInterval(checkForLiveUpdate, 1500);
}
window.addEventListener('beforeunload', saveUiState);

// First render has painted — drop the boot overlay (it bridged the blank gap right after loadFile). Two
// rAFs so the spinner stays until the diff/tree are actually on screen, then a short fade-out.
(function () {
  var ov = document.getElementById('boot-overlay');
  if (!ov) return;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      try {
        if (window.monacoriPerf && typeof window.monacoriPerf.mark === 'function') {
          window.monacoriPerf.mark('first-review-paint', {
            lazy: Boolean(REVIEW_LAZY),
            lazyLoad: Boolean(REVIEW_LAZY_LOAD),
          });
        }
      } catch (e) {}
      ov.classList.add('hide');
      setTimeout(function () { ov.remove(); }, 240);
    });
  });
})();

(function setupSidebarResize() {
  const resizer = document.querySelector('.sidebar-resizer');
  if (!resizer) return;
  const sidebarKey = 'monacori-sidebar-width:' + location.pathname;
  const saved = localStorage.getItem(sidebarKey);
  if (saved) document.documentElement.style.setProperty('--sidebar-width', saved);
  let resizing = false;
  resizer.addEventListener('mousedown', (event) => {
    resizing = true;
    resizer.classList.add('resizing');
    document.body.style.userSelect = 'none';
    event.preventDefault();
  });
  document.addEventListener('mousemove', (event) => {
    if (!resizing) return;
    // Subtract the activity rail's width: the sidebar starts to its right, so its width is the cursor X
    // minus the rail offset (not clientX itself, which would over-size it by the rail width).
    const railW = parseFloat(getComputedStyle(document.body).getPropertyValue('--rail-width')) || 0;
    const width = Math.min(640, Math.max(180, event.clientX - railW));
    document.documentElement.style.setProperty('--sidebar-width', width + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    resizer.classList.remove('resizing');
    document.body.style.userSelect = '';
    try { localStorage.setItem(sidebarKey, getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim()); } catch (e) {}
  });
})();

(function setupDiffCaret() {
  const container = document.getElementById('diff2html-container');
  if (!container) return;
  // No contenteditable: the diff caret is the JS diffCursor. A native contenteditable caret
  // would render a second blinking cursor alongside it. Text selection (for comment capture)
  // still works on non-editable content.
  container.setAttribute('aria-readonly', 'true');
  container.querySelectorAll('.d2h-code-side-linenumber, .d2h-code-linenumber, .d2h-code-line-prefix').forEach((el) => el.setAttribute('contenteditable', 'false'));
  const inComment = (event) => Boolean(event.target && event.target.closest && event.target.closest('.mc-comment-row'));
  const block = (event) => { if (inComment(event)) return; event.preventDefault(); };
  container.addEventListener('focusin', (event) => { if (!inComment(event)) clearTreeFocus(); });
  container.addEventListener('mousedown', (event) => { if (!inComment(event)) clearTreeFocus(); });
  container.addEventListener('beforeinput', block);
  container.addEventListener('paste', block);
  container.addEventListener('drop', block);
  container.addEventListener('dragstart', block);
  container.addEventListener('keydown', (event) => {
    if (inComment(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Tab') {
      event.preventDefault();
    }
  });
  container.addEventListener('click', (event) => {
    if (inComment(event)) return;
    const info = diffRowInfoFromNode(event.target);
    if (info && info.path) setDiffCursor(info.path, info.side, info.rowIndex, 0, false);
  });
  ensureDiffCursor();
})();
