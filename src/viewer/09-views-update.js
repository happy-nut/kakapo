function setTab(name) {
  if (name === 'files') ensureTreeRendered();
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  document.getElementById('changes-panel')?.classList.toggle('hidden', name !== 'changes');
  document.getElementById('files-panel')?.classList.toggle('hidden', name !== 'files');
  syncRail();
}

// Each primary review surface owns its sidebar preference: Cmd+0 toggles Changes while the diff is open,
// and Cmd+1 toggles Files while a source file is open. Collapsing moves actual DOM focus out of the sidebar
// before the grid animates so a hidden row never keeps receiving Arrow/Enter; expanding restores the
// logical tree cursor to the open file.
var reviewSidebarCollapsed = false;
var reviewSidebarStateKey = 'kakapo:diff-sidebar:' + location.pathname;
var sourceSidebarCollapsed = false;
var sourceSidebarStateKey = 'kakapo:source-sidebar:' + location.pathname;
try { reviewSidebarCollapsed = (persistRead(reviewSidebarStateKey) || localStorage.getItem(reviewSidebarStateKey)) === 'collapsed'; } catch (e) {}
try { sourceSidebarCollapsed = (persistRead(sourceSidebarStateKey) || localStorage.getItem(sourceSidebarStateKey)) === 'collapsed'; } catch (e) {}
var sidebarLayoutRefreshTimer = 0;
var sidebarLayoutRefreshRaf = 0;
function refreshViewerAfterSidebarLayout() {
  if (sidebarLayoutRefreshTimer) {
    clearTimeout(sidebarLayoutRefreshTimer);
    sidebarLayoutRefreshTimer = 0;
  }
  if (sidebarLayoutRefreshRaf) cancelAnimationFrame(sidebarLayoutRefreshRaf);
  sidebarLayoutRefreshRaf = requestAnimationFrame(function () {
    sidebarLayoutRefreshRaf = 0;
    // Horizontal connector placement follows the CSS midpoint throughout the transition. Once the grid
    // reaches its final width, refresh the width/row-dependent caches exactly once; continuously measuring
    // every animation frame made large diffs stutter and still allowed the overlay to lag by one frame.
    var wrapper = typeof diffActiveWrapper === 'function' ? diffActiveWrapper() : null;
    if (wrapper && isDiffViewVisible()) {
      if (typeof invalidateAsymmetricDiffGeometry === 'function') invalidateAsymmetricDiffGeometry(wrapper);
      if (typeof refreshLayeredDiffGutters === 'function') refreshLayeredDiffGutters(wrapper);
      if (typeof scrollAsymmetricDiff === 'function') scrollAsymmetricDiff();
    }
    if (typeof positionFileFind === 'function') positionFileFind();
  });
}
function scheduleViewerAfterSidebarLayout() {
  if (sidebarLayoutRefreshTimer) clearTimeout(sidebarLayoutRefreshTimer);
  // transitionend is the normal path. The timeout covers reduced motion, interrupted transitions, and
  // test/webview environments that do not dispatch CSS transition events.
  sidebarLayoutRefreshTimer = setTimeout(refreshViewerAfterSidebarLayout, 220);
}
document.body.addEventListener('transitionend', function (event) {
  if (event.target === document.body && event.propertyName === 'grid-template-columns') {
    refreshViewerAfterSidebarLayout();
  }
});
function syncReviewSidebarVisibility() {
  var diffCollapsed = reviewSidebarCollapsed && isDiffViewVisible();
  var sourceCollapsed = sourceSidebarCollapsed && isSourceViewerVisible();
  var collapsed = diffCollapsed || sourceCollapsed;
  var changed = document.body.classList.contains('sidebar-collapsed') !== collapsed;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  if (changed) scheduleViewerAfterSidebarLayout();
  var sidebar = document.querySelector('.sidebar');
  if (sidebar) {
    // Keep the DOM painted while the grid track closes; inert/aria-hidden remove the clipped tree from
    // keyboard and accessibility navigation without `visibility:hidden` blanking it before the animation.
    if (collapsed) { sidebar.setAttribute('inert', ''); sidebar.setAttribute('aria-hidden', 'true'); }
    else { sidebar.removeAttribute('inert'); sidebar.removeAttribute('aria-hidden'); }
  }
  var button = document.getElementById('diff-sidebar-toggle');
  if (button) {
    var key = diffCollapsed ? 'diff.showSidebar' : 'diff.hideSidebar';
    var label = t(key);
    button.setAttribute('aria-pressed', diffCollapsed ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tooltip', label);
    button.title = label + ' (⌘0)';
  }
  syncRail();
}
function focusDiffAfterSidebarCollapse() {
  clearTreeFocus();
  var sidebar = document.querySelector('.sidebar');
  var active = document.activeElement;
  if (sidebar && active && sidebar.contains(active)) {
    var content = document.getElementById('diff2html-container');
    if (content) {
      content.tabIndex = -1;
      try { content.focus({ preventScroll: true }); } catch (e) { try { content.focus(); } catch (ignore) {} }
    }
  }
  if (!diffCursor && typeof ensureDiffCursor === 'function') ensureDiffCursor();
}
function setReviewSidebarCollapsed(collapsed, options) {
  reviewSidebarCollapsed = !!collapsed;
  persistSave(reviewSidebarStateKey, reviewSidebarCollapsed ? 'collapsed' : 'expanded');
  syncReviewSidebarVisibility();
  if (reviewSidebarCollapsed) focusDiffAfterSidebarCollapse();
  else if (options && options.focusSidebar) { setTab('changes'); focusOpenFileInTree(); }
}
function toggleReviewSidebar() {
  if (!isDiffViewVisible()) return false;
  setReviewSidebarCollapsed(!reviewSidebarCollapsed, { focusSidebar: reviewSidebarCollapsed });
  return true;
}
function focusSourceAfterSidebarCollapse() {
  clearTreeFocus();
  var sidebar = document.querySelector('.sidebar');
  var active = document.activeElement;
  if (sidebar && active && sidebar.contains(active)) {
    var content = document.getElementById('source-body');
    if (content) {
      content.tabIndex = -1;
      try { content.focus({ preventScroll: true }); } catch (e) { try { content.focus(); } catch (ignore) {} }
    }
  }
}
function setSourceSidebarCollapsed(collapsed, options) {
  sourceSidebarCollapsed = !!collapsed;
  persistSave(sourceSidebarStateKey, sourceSidebarCollapsed ? 'collapsed' : 'expanded');
  syncReviewSidebarVisibility();
  if (!isSourceViewerVisible()) return;
  if (sourceSidebarCollapsed) focusSourceAfterSidebarCollapse();
  else if (options && options.focusSidebar) { setTab('files'); focusOpenFileInTree(); }
}
function toggleSourceSidebar() {
  if (!isSourceViewerVisible()) return false;
  setSourceSidebarCollapsed(!sourceSidebarCollapsed, { focusSidebar: sourceSidebarCollapsed });
  return true;
}
// Reflect the current view and dock state on the activity rail icons.
function syncRail() {
  var rail = document.querySelector('.activity-rail');
  if (!rail) return;
  var setOn = function (view, on) {
    var btn = rail.querySelector('[data-view="' + view + '"]');
    if (btn) btn.classList.toggle('is-active', !!on);
  };
  setOn('changes', !document.getElementById('changes-panel')?.classList.contains('hidden'));
  setOn('files', !document.getElementById('files-panel')?.classList.contains('hidden'));
  var merged = document.getElementById('mc-merged-panel');
  setOn('q', !!(merged && merged.dataset.kind === 'q'));
  setOn('c', !!(merged && merged.dataset.kind === 'c'));
  setOn('memo', !!document.getElementById('mc-memo-panel'));
  var hv = document.getElementById('history-view');
  setOn('history', !!(hv && !hv.classList.contains('hidden')));
  var impact = document.getElementById('impact-panel');
  setOn('impact', !!(impact && !impact.classList.contains('hidden')));
}
// Rail click for the merged views toggles: a 2nd click on the open kind closes it (memo already toggles).
function toggleMergedRail(kind) {
  var m = document.getElementById('mc-merged-panel');
  if (m && m.dataset.kind === kind) { closeMergedMemoDocks(); return; }
  openMergedView(kind);
}
// Big repos ship the source tree as an inert island (see render.ts); build it the first time the Files
// tab is opened so the (potentially huge) tree never blocks startup. No-op for inline (small) trees.
function ensureTreeRendered() {
  var panel = document.getElementById('files-panel');
  var island = document.getElementById('files-tree-html');
  if (!REVIEW_LAZY) return Promise.resolve();
  if (!panel || (panel.dataset.projectIndex === 'loaded' && panel.innerHTML.trim())) return Promise.resolve();
  if (island) {
    var html = island.textContent || '';
    island.parentNode && island.parentNode.removeChild(island);
    panel.innerHTML = loadingStateHtml(t('source.buildingTree'), 'empty-nav');
    setTimeout(function () {
      panel.innerHTML = html;
      panel.dataset.projectIndex = 'loaded';
      sourceLinks = Array.from(document.querySelectorAll('.source-link'));
      if (typeof refreshComments === 'function') { try { refreshComments(); } catch (e) {} }
    }, 0);
    return Promise.resolve();
  }
  panel.innerHTML = loadingStateHtml(t('source.buildingTree'), 'empty-nav');
  return ensureProjectIndex().then(function (payload) {
    if (REVIEW_LAZY_LOAD && payload) renderDeferredSourceTree(sourceFiles);
    else panel.innerHTML = payload && payload.filesTree ? payload.filesTree : '<div class="empty-nav">' + escapeHtml(t('source.selectFile')) + '</div>';
    panel.dataset.projectIndex = 'loaded';
    sourceLinks = Array.from(document.querySelectorAll('.source-link'));
    if (typeof refreshComments === 'function') { try { refreshComments(); } catch (e) {} } // re-render per-file badges
  });
}

function showDiffView(shouldScroll) {
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  if (typeof updateDiffLineWrapToggle === 'function') updateDiffLineWrapToggle();
  if (typeof refreshDiffLineWrapLayout === 'function') refreshDiffLineWrapLayout();
  setTab('changes');
  syncReviewSidebarVisibility();
  if (current < 0 && hunkTotal()) {
    setActive(0, shouldScroll);
    return;
  }
  if (current >= 0) {
    const cidx = current;
    whenFileReady(diffWrapperByPath(hunkPathAt(cidx)), function () {
      const curRow = document.getElementById('hunk-' + cidx);
      if (curRow) {
        showOnlyFile(hunkPathAt(cidx));
        if (shouldScroll) curRow.scrollIntoView({ block: 'start' });
        if (typeof refreshFileFindForActiveView === 'function') refreshFileFindForActiveView();
      }
    });
  }
}

function showSourceView() {
  document.getElementById('diff-view')?.classList.add('hidden');
  document.getElementById('source-viewer')?.classList.remove('hidden');
  setTab('files');
  syncReviewSidebarVisibility();
  if (typeof scheduleSourceTabOverflow === 'function') scheduleSourceTabOverflow(currentSourceTabPath());
  if (typeof refreshFileFindForActiveView === 'function') setTimeout(refreshFileFindForActiveView, 0);
}

function saveUiState() {
  const activeTab = document.querySelector('.tab.active')?.dataset.tab || 'changes';
  const sourcePath = document.getElementById('source-viewer')?.dataset.openPath || '';
  var state = {
    tab: activeTab,
    view: document.getElementById('source-viewer')?.classList.contains('hidden') ? 'diff' : 'source',
    sourcePath,
    hash: location.hash,
    // Preserve open tabs + the exact caret across watch reloads (otherwise the caret resets to the
    // hunk's first change / file top every time the working tree changes).
    tabs: sourceTabs,
    diffCursor: diffCursor,
    viewerCursor: viewerCursor,
  };
  persistSave(uiStateKey, state);
  sessionStorage.setItem(uiStateKey, JSON.stringify(state));
}

function restoreUiState() {
  const persisted = persistRead(uiStateKey);
  const raw = persisted && typeof persisted === 'object' ? JSON.stringify(persisted) : sessionStorage.getItem(uiStateKey);
  if (!raw) return false;
  try {
    const state = JSON.parse(raw);
    // Restore Files-mode tabs first so a watch reload doesn't drop the open tabs.
    if (Array.isArray(state.tabs)) sourceTabs = state.tabs.filter(function (p) { return sourceByPath.has(p); });
    if (state.view === 'diff') {
      const match = String(state.hash || location.hash || '').match(/^#hunk-(\d+)$/);
      setActive(match ? Number(match[1]) : current >= 0 ? current : 0, false);
      // Restore the exact diff caret (setActive only lands on the hunk's first change).
      if (state.diffCursor && state.diffCursor.path) {
        var dc = state.diffCursor;
        setTimeout(function () { try { setDiffCursor(dc.path, dc.side, dc.rowIndex, dc.column, true); } catch (e) {} }, 60);
      }
      return true;
    }
    // Source view. Open the saved file — or fall back to the first restored tab when that file is gone
    // (filtered out above) or wasn't recorded. Otherwise we'd render the tab bar but leave the body on its
    // "select a file" placeholder, which looks broken (a tab is clearly open). No openable tab → drop the
    // stale tabs and let the init fallback pick a sensible default.
    var requestedPath = state.sourcePath || (state.tabs && state.tabs[0]) || '';
    if (requestedPath && !sourceByPath.has(requestedPath) && REVIEW_LAZY_LOAD && !projectIndexLoaded) {
      ensureProjectIndex().then(function () {
        var restoredPath = sourceByPath.has(requestedPath) ? requestedPath : (sourceTabs[0] || '');
        if (!restoredPath) { showDiffView(false); return; }
        openSourceFile(restoredPath);
        if (state.viewerCursor && state.viewerCursor.path === restoredPath) {
          var delayedCursor = state.viewerCursor;
          setTimeout(function () { try { setSourceCursor(restoredPath, delayedCursor.lineIndex, delayedCursor.column, true, -1); } catch (e) {} }, 60);
        }
      });
      return true;
    }
    var openPath = (state.sourcePath && sourceByPath.has(state.sourcePath)) ? state.sourcePath : (sourceTabs[0] || '');
    if (openPath) {
      openSourceFile(openPath);
      // Restore the exact source caret/scroll (openSourceFile alone resets it to the top).
      if (state.viewerCursor && state.viewerCursor.path === openPath) {
        var vc = state.viewerCursor;
        setTimeout(function () { try { setSourceCursor(openPath, vc.lineIndex, vc.column, true, -1); } catch (e) {} }, 60);
      }
      return true;
    }
    sourceTabs = [];
  } catch {
    sessionStorage.removeItem(uiStateKey);
  }
  return false;
}

// In-place diff refresh (instead of a full window reload): apply a compact payload of just the changed
// regions (diff container, sidebar trees, status, data) and re-run the bootstrap steps. The window never
// reloads, so review comments and navigation context survive a watch refresh. Electron's
// main pushes the payload over IPC (kakapo:diff-update); serve mode's poller fetches /__ai_flow_update.
// Live watch refreshes are HELD while a comment composer is open. applyDiffUpdate rebuilds the diff DOM, so
// applying it mid-compose would destroy the composer textarea every watch tick — input stalls and characters
// arrive in bursts — and flicker the page. Keep only the latest pending payload; flush it on close/save.
var pendingDiffUpdate = null;
function flushPendingDiffUpdate() {
  if (!pendingDiffUpdate) return;
  var u = pendingDiffUpdate;
  pendingDiffUpdate = null;
  try { applyDiffUpdate(u); } catch (e) {}
}
// Flicker-saver for the live-watch refresh. The default path replaces the WHOLE diff DOM
// (container.innerHTML = …), which re-renders the file you're looking at even when only an OFF-SCREEN file
// changed. When the file set AND order are identical, reconcile per-file instead: keep every unchanged
// wrapper's DOM node untouched (no flicker — including the visible one), swap changed off-screen wrappers,
// and defer a changed VISIBLE wrapper until its new body is hydrated off-DOM. Returns false (caller does the
// full innerHTML swap) for risky add/remove/reorder cases so that proven path still handles index shifts.
function syncDiffWrapperShellMetadata(oldWrapper, newWrapper) {
  var baseChanged = oldWrapper.getAttribute('data-first-hunk') !== newWrapper.getAttribute('data-first-hunk');
  oldWrapper.id = newWrapper.id;
  ['data-path', 'data-first-hunk', 'data-hunk-count'].forEach(function (name) {
    if (newWrapper.hasAttribute(name)) oldWrapper.setAttribute(name, newWrapper.getAttribute(name));
    else oldWrapper.removeAttribute(name);
  });
  var body = oldWrapper.querySelector('.d2h-files-diff');
  if (baseChanged && body && !body.hasAttribute('data-lazy')) markWrapperHunks(oldWrapper);
}
function reconcileDiffWrappers(container, newDiffHtml, oldSigByPath, newSigByPath, preservePath, deferredVisibleSwaps) {
  var oldW = Array.prototype.slice.call(container.querySelectorAll('.d2h-file-wrapper'));
  if (!oldW.length) return false;
  var tmp = document.createElement('div');
  tmp.innerHTML = newDiffHtml;
  var newW = Array.prototype.slice.call(tmp.querySelectorAll('.d2h-file-wrapper'));
  if (newW.length !== oldW.length) return false; // add/remove → full swap (global hunk indices shift)
  for (var i = 0; i < oldW.length; i++) {
    if (diffWrapperPathKey(oldW[i]) !== diffWrapperPathKey(newW[i])) return false; // reordered → full swap
  }
  for (var j = 0; j < oldW.length; j++) {
    var ow = oldW[j], nw = newW[j], p = diffWrapperPathKey(ow);
    if ((oldSigByPath.get(p) || '') !== (newSigByPath.get(p) || '')) {
      if (p === preservePath && !ow.classList.contains('df-inactive')) {
        // The file under the caret changed. Keep its fully-painted old body on screen while the NEW lazy
        // body is fetched. Swapping to `nw` here would expose an empty shell for a frame (or longer over
        // IPC), reset scrollTop, and make the caret appear to jump to the file top. The caller hydrates
        // `nw` off-DOM and replaces this node atomically when it is ready.
        syncDiffWrapperShellMetadata(ow, nw);
        deferredVisibleSwaps.push({ oldWrapper: ow, newWrapper: nw, path: p });
        continue;
      }
      // Changed file (off-screen): drop in the fresh shell and clear its cached body so it refetches the
      // new content when it next scrolls into view. Replacing an off-screen node is invisible.
      var nidx = (nw.id || '').replace('file-', '');
      delete bodyCache[nidx];
      delete bodyPromise[nidx];
      ow.parentNode.replaceChild(nw, ow);
    } else {
      // Unchanged file: keep its DOM node (no flicker). An earlier file's changed hunk count can shift the
      // global numbering, so sync the index attrs and renumber a materialized body's hunk ids (id/class
      // changes only — invisible, no flicker).
      syncDiffWrapperShellMetadata(ow, nw);
    }
  }
  return true;
}
var diffRefreshGeneration = 0;
function captureDiffRefreshCursor(path) {
  if (!diffCursor || diffCursor.path !== path) return null;
  var wrapper = diffWrapperByPath(path);
  var row = wrapper ? diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex) : null;
  return {
    path: path,
    side: diffCursor.side,
    rowIndex: diffCursor.rowIndex,
    column: diffCursor.column,
    lineNumber: row ? diffLineNumber(row) : null,
    text: row ? diffLineText(row) : '',
  };
}
function nearestDiffRowIndex(rows, snapshot) {
  if (!rows.length) return -1;
  var best = -1, bestDistance = Infinity;
  for (var i = 0; i < rows.length; i++) {
    if (!isDiffCodeRow(rows[i])) continue;
    var sameLine = snapshot.lineNumber != null && diffLineNumber(rows[i]) === snapshot.lineNumber;
    var sameText = snapshot.text && diffLineText(rows[i]) === snapshot.text;
    if (!sameLine && !sameText) continue;
    var distance = Math.abs(i - snapshot.rowIndex) + (sameLine ? 0 : 1000);
    if (distance < bestDistance) { best = i; bestDistance = distance; }
  }
  if (best >= 0) return best;
  var clamped = Math.max(0, Math.min(snapshot.rowIndex, rows.length - 1));
  if (isDiffCodeRow(rows[clamped])) return clamped;
  for (var step = 1; step < rows.length; step++) {
    if (clamped + step < rows.length && isDiffCodeRow(rows[clamped + step])) return clamped + step;
    if (clamped - step >= 0 && isDiffCodeRow(rows[clamped - step])) return clamped - step;
  }
  return -1;
}
function hydrateVisibleDiffSwaps(swaps, cursorSnapshot, generation) {
  if (!swaps.length) return;
  swaps.forEach(function (swap) {
    var idx = (swap.newWrapper.id || '').replace('file-', '');
    loadBodyHtml(idx).then(function (html) {
      if (generation !== diffRefreshGeneration || !swap.oldWrapper.isConnected) return;
      materializeBody(swap.newWrapper, html);
      var container = document.getElementById('diff2html-container');
      var scrollTop = container ? container.scrollTop : 0;
      var liveCursor = diffCursor && diffCursor.path === swap.path
        ? captureDiffRefreshCursor(swap.path) || cursorSnapshot
        : cursorSnapshot;
      swap.oldWrapper.parentNode.replaceChild(swap.newWrapper, swap.oldWrapper);
      wrapperPathMap = null;
      refreshHunkIndex();
      refreshComments();
      if (container) container.scrollTop = scrollTop;
      if (liveCursor && liveCursor.path === swap.path) {
        var rows = diffRowsOf(diffSideTable(swap.newWrapper, liveCursor.side));
        var rowIndex = nearestDiffRowIndex(rows, liveCursor);
        if (rowIndex >= 0) {
          navSuppress = true;
          try { setDiffCursor(swap.path, liveCursor.side, rowIndex, liveCursor.column, false); }
          finally { navSuppress = false; }
          if (container) container.scrollTop = scrollTop;
          requestAnimationFrame(function () {
            var row = diffRowAt(swap.newWrapper, liveCursor.side, rowIndex);
            scrolloffReveal(row, container, 0.15);
          });
        }
      }
    });
  });
}
function captureSourceRefreshCursor(path) {
  if (!viewerCursor || viewerCursor.path !== path) return null;
  var file = sourceByPath.get(path);
  var lines = file && typeof file.content === 'string' ? file.content.split(/\r?\n/) : [];
  // During a lazy live refresh sourceByPath already points at the NEW record while #source-body still
  // intentionally paints the OLD one. Read the visible raw row first so line matching follows the user's
  // actual caret, not whatever text now occupies the same numeric line in the incoming file.
  var body = document.getElementById('source-body');
  var visibleRow = body && !body.classList.contains('rendered-body')
    ? body.querySelector('.source-row[data-line-index="' + viewerCursor.lineIndex + '"] .source-code')
    : null;
  return {
    path: path,
    lineIndex: viewerCursor.lineIndex,
    column: viewerCursor.column,
    targetLine: viewerCursor.targetLine,
    text: visibleRow ? (visibleRow.textContent || '') : (lines[viewerCursor.lineIndex] || ''),
  };
}
function remapSourceRefreshLine(file, snapshot) {
  var lines = String(file && file.content || '').split(/\r?\n/);
  if (!lines.length) return 0;
  var oldIndex = Math.max(0, Math.min(snapshot.lineIndex, lines.length - 1));
  if (!snapshot.text || lines[oldIndex] === snapshot.text) return oldIndex;
  var best = -1, bestDistance = Infinity;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i] !== snapshot.text) continue;
    var distance = Math.abs(i - snapshot.lineIndex);
    if (distance < bestDistance) { best = i; bestDistance = distance; }
  }
  return best >= 0 ? best : oldIndex;
}
function refreshOpenSourceAfterUpdate(path, cursorSnapshot) {
  // Do not call openSourceFile until the changed source record has arrived. Its lazy branch deliberately
  // paints a Loading placeholder, which is correct for a NEW tab but causes a large flash and resets the
  // scroll position when a live update refreshes the file already under review.
  loadSourceFile(path).then(function (file) {
    var viewer = document.getElementById('source-viewer');
    var body = document.getElementById('source-body');
    if (!file || !sourceContentLoaded(file) || !viewer || !body || viewer.dataset.openPath !== path || !isSourceViewerVisible()) return;
    var scrollTop = body.scrollTop;
    var liveCursor = captureSourceRefreshCursor(path) || cursorSnapshot;
    if (liveCursor && cursorSnapshot && !liveCursor.text) liveCursor.text = cursorSnapshot.text;
    openSourceFile(path, false);
    if (body) body.scrollTop = scrollTop;
    if (liveCursor) {
      var lineIndex = remapSourceRefreshLine(file, liveCursor);
      navSuppress = true;
      try { setSourceCursor(path, lineIndex, liveCursor.column, false, liveCursor.targetLine); }
      finally { navSuppress = false; }
      body.scrollTop = scrollTop;
      requestAnimationFrame(function () { revealSourceCursorWithMargin(); });
    }
  });
}
function applyDiffUpdate(u) {
  if (!u || !u.signature || u.signature === currentSignature) return false; // unchanged — nothing to do
  if (composerState) { pendingDiffUpdate = u; return false; } // composing a comment — hold the refresh until close/save

  // Remember what to restore after the swap (comments/viewed persist on their own; these don't).
  var sv = document.getElementById('source-viewer');
  var openPath = (sv && sv.dataset.openPath) || '';
  var wasSource = isSourceViewerVisible();
  var container = document.getElementById('diff2html-container');
  var diffScrollTop = container ? container.scrollTop : 0;
  // The active hunk's file path BEFORE the swap (hunkMeta/hunks still hold the old build here). After a commit
  // the old active file can vanish from the new diff, so we re-anchor `current` to it below — otherwise it
  // dangles at a stale index and showDiffView renders blank with a stale breadcrumb.
  var prevActivePath = current >= 0 ? hunkPathAt(current) : '';
  var visibleDiffPath = !wasSource && ((diffCursor && diffCursor.path) || prevActivePath || '');
  var diffCursorSnapshot = captureDiffRefreshCursor(visibleDiffPath);
  var sourceCursorSnapshot = captureSourceRefreshCursor(openPath);
  // Did the file the user is CURRENTLY viewing actually change in this build? If not, we must not re-render
  // the source view — an unrelated file's edit would otherwise flicker the pane they're reading. Capture the
  // open file's signature BEFORE fileSignatureByPath is rebuilt below.
  var prevOpenSig = openPath ? (fileSignatureByPath.get(openPath) || '') : '';
  var previousSourceByPath = sourceByPath;
  var previousSignatureByPath = fileSignatureByPath;

  // Fast-path: when the file set + order are unchanged, reconcile per-file so an off-screen change never
  // flickers the file you're viewing. Falls back to the full swap (below) for add/remove/reorder or eager.
  var newSigByPath = new Map((u.fileStates || []).map(function (f) { return [f.path, f.signature]; }));
  var fastPath = false;
  var deferredVisibleSwaps = [];
  var refreshGeneration = ++diffRefreshGeneration;
  if (REVIEW_LAZY && container && u.diffContainer) {
    fastPath = reconcileDiffWrappers(container, u.diffContainer, fileSignatureByPath, newSigByPath, visibleDiffPath, deferredVisibleSwaps);
  }

  // Full-swap path only: snapshot already-materialized bodies (keyed by path + signature) BEFORE the swap so
  // UNCHANGED files re-fill synchronously afterwards — otherwise the swap blanks every wrapper into an empty
  // lazy shell until its body reloads over IPC (the "flicker"). The fast-path keeps those nodes, so skip it.
  var prevBodies = {};
  if (!fastPath && REVIEW_LAZY && container) {
    container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
      var b = w.querySelector('.d2h-files-diff');
      if (!b || b.hasAttribute('data-lazy')) return; // only bodies that are actually materialized
      var p = diffWrapperPathKey(w);
      if (p) prevBodies[p] = { sig: fileSignatureByPath.get(p) || '', html: b.innerHTML };
    });
  }

  // 1) Replace the visible regions straight from the payload (no full-HTML parse) — unless the fast-path
  // already reconciled the diff DOM in place.
  if (container && !fastPath) container.innerHTML = u.diffContainer || '';
  var changesPanel = document.getElementById('changes-panel');
  if (changesPanel) changesPanel.innerHTML = u.changesPanel || '';
  // Files tree: keep the inert island (lazy, not yet opened) in sync, and refresh the live panel when it's
  // already materialized — or always, in eager mode where the panel holds the tree directly.
  var filesIsland = document.getElementById('files-tree-html');
  if (filesIsland) filesIsland.textContent = u.filesTree || '';
  var filesPanel = document.getElementById('files-panel');
  if (filesPanel && u.filesTree && (!REVIEW_LAZY || filesPanel.innerHTML.trim())) filesPanel.innerHTML = u.filesTree;
  var statusEl = document.querySelector('.review-status');
  if (statusEl) statusEl.innerHTML = u.reviewStatus || '';
  // Branch can change between watch ticks (checkout/commit) — keep the sidebar chip current.
  var branchName = document.getElementById('brand-branch-name');
  if (branchName) {
    branchName.textContent = u.branch || '';
    var branchChip = branchName.closest && branchName.closest('.brand-branch');
    if (branchChip) branchChip.classList.toggle('hidden', !u.branch);
  }
  if (reviewMeta) { reviewMeta.setAttribute('data-signature', u.signature); if (u.generatedAt) reviewMeta.setAttribute('data-generated-at', u.generatedAt); }

  // 2) Re-derive module-level state directly from the payload objects.
  fileStates = u.fileStates || [];
  fileSignatureByPath = new Map(fileStates.map(function (f) { return [f.path, f.signature]; }));
  // The open file changed iff its signature moved (or it vanished from the new build). Drives whether we
  // re-render the source view below.
  var openFileChanged = !openPath || prevOpenSig !== (fileSignatureByPath.get(openPath) || '');
  sourceFiles = u.sourceFilesMeta || [];
  sourceFiles.forEach(function (file) {
    file.__loaded = !REVIEW_LAZY_LOAD || !file.embedded;
    var previous = previousSourceByPath.get(file.path);
    if (previous && previous.__loaded && previousSignatureByPath.get(file.path) === fileSignatureByPath.get(file.path)) {
      file.content = previous.content;
      if (previous.image) file.image = previous.image;
      file.__loaded = true;
    }
  });
  sourceByPath = new Map(sourceFiles.map(function (f) { return [f.path, f]; }));
  projectIndexLoaded = true;
  projectIndexPayload = {
    signature: u.signature || '',
    filesTree: u.filesTree || '',
    fileStates: fileStates,
    sourceFilesMeta: sourceFiles,
  };
  if (typeof pruneCommentsForMissingFiles === 'function') pruneCommentsForMissingFiles();
  if (filesPanel && filesPanel.dataset.projectIndex === 'loaded' && REVIEW_LAZY_LOAD) renderDeferredSourceTree(sourceFiles);
  httpEnvironments = u.httpEnvironments || {};
  httpEnvNames = Object.keys(httpEnvironments);
  currentSignature = u.signature;
  links = Array.from(document.querySelectorAll('#changes-panel .file-link'));
  sourceLinks = Array.from(document.querySelectorAll('.source-link'));
  // The Changes tree was just replaced. Reapply persisted per-file review marks immediately; otherwise
  // F7 consults isFileViewed() and skips files whose rows still look like ordinary blue "modified" items.
  applyViewedState();

  // Reconcile the active hunk against the new build (uses the just-rebuilt `links`). A committed/removed file
  // reshuffles or shrinks the diff: re-anchor `current` to the same file's new hunk when it survives, else
  // drop to -1 so the diff lands on the first change rather than a dangling index that paints nothing.
  var activeFilePreserved = false;
  if (prevActivePath) {
    var reHunk = firstHunkForPath(prevActivePath);
    if (reHunk >= 0) { current = reHunk; activeFilePreserved = true; }
    else current = -1;
  }

  // 3) Reset lazy materialization. Source analysis/indexing lives in Electron's main process; the renderer
  // keeps only per-file bodies it has actually opened, preserving unchanged ones across watch refreshes.
  // bodyCache is keyed by file INDEX, not content — after a watch rebuild the same index maps to the new
  // body, so it MUST be dropped too. Clearing only bodyPromise left loadBodyHtml() returning the cached
  // OLD body, so a watch change never showed up in the diff until a full reload.
  bodyCache = {};
  bodyPromise = {};
  diffBootDone = false;
  sourceGeneration += 1;
  sourceLoadPromises = Object.create(null);
  bulkSourcePromise = null;
  // Force a source body re-render on next open ONLY if the open file actually changed; otherwise keep
  // sourceBodyPath so the already-painted (unchanged) source view is left exactly as-is — no flicker.
  if (openFileChanged) sourceBodyPath = null;

  // 3b) Re-fill UNCHANGED files' bodies synchronously from the snapshot so they don't blank-then-reload (the
  // flicker). Runs BEFORE setupLazyDiff so the IntersectionObserver sees them already materialized and never
  // re-fetches them. The fresh wrapper carries the correct data-first-hunk + file index, so materializeBody
  // numbers hunks exactly as a normal lazy load would. Changed/new files stay shells and lazy-load as usual.
  if (!fastPath && REVIEW_LAZY && container) {
    container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
      var p = diffWrapperPathKey(w);
      var prev = p ? prevBodies[p] : null;
      if (!prev || !prev.sig || prev.sig !== (fileSignatureByPath.get(p) || '')) return; // changed/new -> lazy-load
      var shell = w.querySelector('.d2h-files-diff[data-lazy]');
      if (!shell) return;
      var idx = (w.id || '').replace('file-', '');
      materializeBody(w, prev.html);           // fills the body + markWrapperHunks (uses the new data-first-hunk)
      bodyCache[idx] = prev.html;              // keep the index cache consistent so it never refetches
      bodyPromise[idx] = Promise.resolve(w);
    });
  }
  refreshHunkIndex(); // rebuild hunks/hunkMeta from the swapped-in DOM so hunkTotal()/hunkPathAt() aren't stale
  if (REVIEW_LAZY) { setupLazyDiff(); setTimeout(function () { diffBootDone = true; }, 0); }
  else { diffBootDone = true; }
  // 4) Re-run the DOM-dependent bootstrap steps.
  applyI18n();
  populateHttpEnvSelect();
  initSourceTreeFolds();
  initChangesTreeFolds(); // #changes-panel was just replaced, so its folder listeners must be reattached
  remapComments(); // follow/drop comments whose anchor line moved or vanished in the new build
  refreshComments();

  // 5) Best-effort restore of what the user was looking at. Re-render the source view only when the open file
  // actually changed; an unchanged file stays painted as-is, so an unrelated edit doesn't flicker the pane.
  if (wasSource && openPath && sourceByPath.has(openPath)) {
    if (openFileChanged) refreshOpenSourceAfterUpdate(openPath, sourceCursorSnapshot);
  } else if (container) {
    showDiffView(false);
    // Same active file survived → keep the user's exact scroll. If it was committed away (current reset to
    // -1, showDiffView landed on the first change), restoring the old, now-out-of-range scrollTop would push
    // the shorter new diff off-screen and look blank — so reset to the top instead.
    container.scrollTop = activeFilePreserved ? diffScrollTop : 0;
  }
  hydrateVisibleDiffSwaps(deferredVisibleSwaps, diffCursorSnapshot, refreshGeneration);
  if (typeof isImpactOpen === 'function' && isImpactOpen()) openImpact();
  return true;
}

async function checkForLiveUpdate() {
  if (checkingForUpdates) return;
  checkingForUpdates = true;
  const liveStatus = document.getElementById('live-status');
  try {
    const response = await fetch('/__ai_flow_state', { cache: 'no-store' });
    if (!response.ok) return;
    const state = await response.json();
    if (liveStatus && state.generatedAt) {
      liveStatus.textContent = t('status.live.updated') + ' ' + new Date(state.generatedAt).toLocaleTimeString();
    }
    if (state.signature && state.signature !== currentSignature) {
      // serve mode: fetch just the compact update payload and refresh in place (same path Electron uses
      // over IPC) rather than reloading, preserving the current review context.
      try {
        var fresh = await fetch('__ai_flow_update', { cache: 'no-store' });
        if (fresh.ok) applyDiffUpdate(await fresh.json());
      } catch (e) {}
    }
  } catch {
    if (liveStatus) liveStatus.textContent = t('status.live.waiting');
  } finally {
    checkingForUpdates = false;
  }
}
