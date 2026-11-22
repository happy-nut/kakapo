function activeSidebarTab() {
  return document.querySelector('.sidebar-switch-item.active')?.dataset.tab || 'changes';
}

function setTab(name) {
  if (name === 'files') ensureTreeRendered();
  document.querySelectorAll('.sidebar-switch-item').forEach((button) => {
    var on = button.dataset.tab === name;
    button.classList.toggle('active', on);
    button.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.getElementById('changes-panel')?.classList.toggle('hidden', name !== 'changes');
  document.getElementById('files-panel')?.classList.toggle('hidden', name !== 'files');
}

var reviewSidebarCollapsed = false;
var sourceSidebarCollapsed = false;
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
    var wrapper = diffActiveWrapper();
    if (wrapper && isDiffViewVisible()) {
      invalidateAsymmetricDiffGeometry(wrapper);
      refreshLayeredDiffGutters(wrapper);
      scrollAsymmetricDiff();
    }
    positionFileFind();
  });
}
function scheduleViewerAfterSidebarLayout() {
  if (sidebarLayoutRefreshTimer) clearTimeout(sidebarLayoutRefreshTimer);
  sidebarLayoutRefreshTimer = setTimeout(refreshViewerAfterSidebarLayout, 220);
}
document.body.addEventListener('transitionend', function (event) {
  if (event.target === document.body && event.propertyName === 'grid-template-columns') {
    refreshViewerAfterSidebarLayout();
  }
});
function syncReviewSidebarVisibility() {
  var diffCollapsed = !!reviewSidebarCollapsed && isDiffViewVisible();
  var sourceCollapsed = !!sourceSidebarCollapsed && isSourceViewerVisible();
  var collapsed = !!(diffCollapsed || sourceCollapsed);
  var changed = document.body.classList.contains('sidebar-collapsed') !== collapsed;
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  if (changed) scheduleViewerAfterSidebarLayout();
  var sidebar = document.querySelector('.sidebar');
  if (sidebar) {
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
    button.setAttribute('data-i18n-title', key);
    button.setAttribute('data-i18n-aria', key);
    applyKeyHints(button.parentNode || document);
  }
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
  if (!diffCursor) ensureDiffCursor();
  else setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, diffCursor.column, true);
}
function setReviewSidebarCollapsed(collapsed, options) {
  reviewSidebarCollapsed = !!collapsed;
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
  if (viewerCursor) setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, viewerCursor.column, true);
}
function setSourceSidebarCollapsed(collapsed, options) {
  sourceSidebarCollapsed = !!collapsed;
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
      markProjectLayoutInTrees();
      try { refreshComments(); } catch (e) {}
    }, 0);
    return Promise.resolve();
  }
  panel.innerHTML = loadingStateHtml(t('source.buildingTree'), 'empty-nav');
  return ensureProjectIndex().then(function (payload) {
    if (REVIEW_LAZY_LOAD && payload) renderDeferredSourceTree(sourceFiles);
    else panel.innerHTML = payload && payload.filesTree ? payload.filesTree : '<div class="empty-nav">' + escapeHtml(t('source.selectFile')) + '</div>';
    panel.dataset.projectIndex = 'loaded';
    sourceLinks = Array.from(document.querySelectorAll('.source-link'));
    markProjectLayoutInTrees();
    try { refreshComments(); } catch (e) {}
  });
}

function showDiffView(shouldScroll) {
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  updateDiffLineWrapToggle();
  refreshDiffLineWrapLayout();
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
        refreshFileFindForActiveView();
      }
    });
  }
}

function showSourceView() {
  document.getElementById('diff-view')?.classList.add('hidden');
  document.getElementById('source-viewer')?.classList.remove('hidden');
  setTab('files');
  syncReviewSidebarVisibility();
  scheduleSourceTabOverflow(sourceOpenPath());
  setTimeout(refreshFileFindForActiveView, 0);
}

function saveUiState() {
  const activeTab = document.querySelector('.sidebar-switch-item.active')?.dataset.tab || 'changes';
  const sourcePath = sourceOpenPath();
  var state = {
    tab: activeTab,
    view: document.getElementById('source-viewer')?.classList.contains('hidden') ? 'diff' : 'source',
    sourcePath,
    hash: location.hash,
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
    if (Array.isArray(state.tabs)) sourceTabs = state.tabs.filter(function (p) { return sourceByPath.has(p); });
    if (state.view === 'diff') {
      const match = String(state.hash || location.hash || '').match(/^#hunk-(\d+)$/);
      var folded = Object.keys(diffCollapsedFileSet());
      setActive(match ? Number(match[1]) : current >= 0 ? current : 0, false);
      if (state.diffCursor && state.diffCursor.path) {
        var dc = state.diffCursor;
        setTimeout(function () {
          try { setDiffCursor(dc.path, dc.side, dc.rowIndex, dc.column, true); } catch (e) {}
          setDiffCollapsedFileSet(folded);
        }, 60);
      } else setDiffCollapsedFileSet(folded);
      return true;
    }
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

var TYPING_IDLE_MS = 450;
var pageComposing = false;
if (typeof document !== 'undefined') {
  document.addEventListener('compositionstart', function () { pageComposing = true; }, true);
  document.addEventListener('compositionend', function () { pageComposing = false; }, true);
}
function pageTypingAgeMs() {
  return pageComposing ? 0 : Infinity;
}
var refreshCommentsTimer = null;
function refreshCommentsWhenNotTyping() {
  var age = pageTypingAgeMs();
  if (age >= TYPING_IDLE_MS) {
    if (refreshCommentsTimer) { clearTimeout(refreshCommentsTimer); refreshCommentsTimer = null; }
    refreshComments();
    return;
  }
  if (refreshCommentsTimer) return;
  refreshCommentsTimer = setTimeout(function () {
    refreshCommentsTimer = null;
    refreshCommentsWhenNotTyping();
  }, TYPING_IDLE_MS - age + 20);
}
var pendingDiffUpdate = null;
var pendingDiffTimer = null;
function holdDiffUpdateFor(u, delay) {
  pendingDiffUpdate = u;
  if (pendingDiffTimer) clearTimeout(pendingDiffTimer);
  pendingDiffTimer = setTimeout(function () { pendingDiffTimer = null; flushPendingDiffUpdate(); }, delay);
}
function flushPendingDiffUpdate() {
  if (pendingDiffTimer) { clearTimeout(pendingDiffTimer); pendingDiffTimer = null; }
  if (!pendingDiffUpdate) return;
  var u = pendingDiffUpdate;
  pendingDiffUpdate = null;
  try { applyDiffUpdate(u); } catch (e) {}
}
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
  if (newW.length !== oldW.length) return false;
  for (var i = 0; i < oldW.length; i++) {
    if (diffWrapperPathKey(oldW[i]) !== diffWrapperPathKey(newW[i])) return false;
  }
  for (var j = 0; j < oldW.length; j++) {
    var ow = oldW[j], nw = newW[j], p = diffWrapperPathKey(ow);
    if ((oldSigByPath.get(p) || '') !== (newSigByPath.get(p) || '')) {
      if (p === preservePath && !ow.classList.contains('df-inactive')) {
        syncDiffWrapperShellMetadata(ow, nw);
        deferredVisibleSwaps.push({ oldWrapper: ow, newWrapper: nw, path: p });
        continue;
      }
      var nidx = (nw.id || '').replace('file-', '');
      delete bodyCache[nidx];
      delete bodyPromise[nidx];
      ow.parentNode.replaceChild(nw, ow);
    } else {
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
  loadSourceFile(path).then(function (file) {
    var body = document.getElementById('source-body');
    if (!file || !sourceContentLoaded(file) || !body || sourceOpenPath() !== path || !isSourceViewerVisible()) return;
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
var forceDiffViewOnNextCompare = false;
function requestDiffViewOnNextCompare() { forceDiffViewOnNextCompare = true; }
function cancelDiffViewOnNextCompare() { forceDiffViewOnNextCompare = false; }

function applyDiffUpdate(u) {
  if (!u || !u.signature || u.signature === currentSignature) return false;
  if (composerState) { pendingDiffUpdate = u; return false; }
  var typingAge = pageTypingAgeMs();
  if (typingAge < TYPING_IDLE_MS) { holdDiffUpdateFor(u, TYPING_IDLE_MS - typingAge + 20); return false; }

  var openPath = sourceOpenPath();
  var wasSource = isSourceViewerVisible();
  var container = document.getElementById('diff2html-container');
  var diffScrollTop = container ? container.scrollTop : 0;
  var prevActivePath = current >= 0 ? hunkPathAt(current) : '';
  var visibleDiffPath = !wasSource && ((diffCursor && diffCursor.path) || prevActivePath || '');
  var diffCursorSnapshot = captureDiffRefreshCursor(visibleDiffPath);
  var sourceCursorSnapshot = captureSourceRefreshCursor(openPath);
  var prevOpenSig = openPath ? (fileSignatureByPath.get(openPath) || '') : '';
  var previousSourceByPath = sourceByPath;
  var previousSignatureByPath = fileSignatureByPath;

  var newSigByPath = new Map((u.fileStates || []).map(function (f) { return [f.path, f.signature]; }));
  var fastPath = false;
  var deferredVisibleSwaps = [];
  var refreshGeneration = ++diffRefreshGeneration;
  if (REVIEW_LAZY && container && u.diffContainer) {
    fastPath = reconcileDiffWrappers(container, u.diffContainer, fileSignatureByPath, newSigByPath, visibleDiffPath, deferredVisibleSwaps);
  }

  var prevBodies = {};
  if (!fastPath && REVIEW_LAZY && container) {
    container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
      var b = w.querySelector('.d2h-files-diff');
      if (!b || b.hasAttribute('data-lazy')) return;
      var p = diffWrapperPathKey(w);
      if (p) prevBodies[p] = { sig: fileSignatureByPath.get(p) || '', html: b.innerHTML };
    });
  }

  if (container && !fastPath) container.innerHTML = u.diffContainer || '';
  if (container && !fastPath) {
    container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
      w.classList.toggle('df-inactive', diffWrapperPathKey(w) !== visibleDiffPath);
    });
  }
  if (container) refreshDiffMediaPreviews();
  var changesPanel = document.getElementById('changes-panel');
  if (changesPanel) { changesPanel.innerHTML = u.changesPanel || ''; paintTreeRowAriaLabels(changesPanel); }
  var filesIsland = document.getElementById('files-tree-html');
  if (filesIsland) filesIsland.textContent = u.filesTree || '';
  var filesPanel = document.getElementById('files-panel');
  if (filesPanel && u.filesTree && (!REVIEW_LAZY || filesPanel.innerHTML.trim())) filesPanel.innerHTML = u.filesTree;
  var statusEl = document.querySelector('.review-status');
  if (statusEl) { statusEl.innerHTML = u.reviewStatus || ''; paintComparePillTitle(); }
  var compareWhy = document.getElementById('compare-why');
  if (compareWhy) compareWhy.innerHTML = u.compareBanner || '';
  document.querySelectorAll('.brand-branch-name').forEach(function (branchName) {
    applyBranchChip(branchName, u.branch || '');
    var chip = branchName.closest && branchName.closest('.brand-branch');
    if (chip) chip.classList.toggle('hidden', !u.branch);
  });
  if (reviewMeta) { reviewMeta.setAttribute('data-signature', u.signature); if (u.generatedAt) reviewMeta.setAttribute('data-generated-at', u.generatedAt); }

  fileStates = u.fileStates || [];
  fileSignatureByPath = new Map(fileStates.map(function (f) { return [f.path, f.signature]; }));
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
  sourceByPath = rebuildSourceByPath(sourceFiles, previousSourceByPath);
  projectIndexLoaded = true;
  projectIndexPayload = {
    signature: u.signature || '',
    filesTree: u.filesTree || '',
    fileStates: fileStates,
    sourceFilesMeta: sourceFiles,
  };
  pruneCommentsForMissingFiles();
  resetEndpoints();
  if (filesPanel && filesPanel.dataset.projectIndex === 'loaded' && REVIEW_LAZY_LOAD) renderDeferredSourceTree(sourceFiles);
  httpEnvironments = u.httpEnvironments || {};
  httpEnvNames = Object.keys(httpEnvironments);
  setProjectLayout(u.projectLayout);
  currentSignature = u.signature;
  links = Array.from(document.querySelectorAll('#changes-panel .file-link'));
  sourceLinks = Array.from(document.querySelectorAll('.source-link'));
  markProjectLayoutInTrees();
  applyViewedState();

  var activeFilePreserved = false;
  if (prevActivePath) {
    var reHunk = firstHunkForPath(prevActivePath);
    if (reHunk >= 0) { current = reHunk; activeFilePreserved = true; }
    else current = -1;
  }

  bodyCache = {};
  bodyPromise = {};
  diffBootDone = false;
  sourceGeneration += 1;
  sourceLoadPromises = Object.create(null);
  bulkSourcePromise = null;
  if (openFileChanged) sourceBodyPath = null;

  if (!fastPath && REVIEW_LAZY && container) {
    container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
      var p = diffWrapperPathKey(w);
      var prev = p ? prevBodies[p] : null;
      if (!prev || !prev.sig || prev.sig !== (fileSignatureByPath.get(p) || '')) return;
      var shell = w.querySelector('.d2h-files-diff[data-lazy]');
      if (!shell) return;
      var idx = (w.id || '').replace('file-', '');
      materializeBody(w, prev.html);
      bodyPromise[idx] = Promise.resolve(w);
    });
  }
  refreshHunkIndex();
  paintDiffFileCollapse();
  clearUsageHighlights();
  if (REVIEW_LAZY) { setupLazyDiff(); setTimeout(function () { diffBootDone = true; }, 0); }
  else { diffBootDone = true; }
  applyI18n();
  populateHttpEnvSelect();
  initSourceTreeFolds();
  initChangesTreeFolds();
  autoViewTrivial();
  remapComments();
  refreshComments();

  var forceDiff = forceDiffViewOnNextCompare;
  forceDiffViewOnNextCompare = false;
  if (!forceDiff && wasSource && openPath && sourceByPath.has(openPath)) {
    if (openFileChanged) refreshOpenSourceAfterUpdate(openPath, sourceCursorSnapshot);
  } else if (container) {
    showDiffView(forceDiff);
    container.scrollTop = activeFilePreserved ? diffScrollTop : 0;
  }
  hydrateVisibleDiffSwaps(deferredVisibleSwaps, diffCursorSnapshot, refreshGeneration);
  return true;
}

function releaseDiffView() {
  var container = document.getElementById('diff2html-container');
  if (!container || !container.querySelector('.d2h-file-wrapper')) return false;
  if (typeof composerState !== 'undefined' && composerState) return false;
  container.innerHTML = '';
  bodyCache = {};
  bodyPromise = {};
  wrapperPathMap = null;
  diffCursor = null;
  diffBootDone = false;
  currentSignature = '';
  refreshHunkIndex();
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
      liveStatus.textContent = t('status.live.updated') + ' ' + new Date(state.generatedAt).toLocaleTimeString(locale);
    }
    if (state.signature && state.signature !== currentSignature) {
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

var kakapoActivity = { zoomAt: 0, longest: null };
function noteKakapoActivity(kind) {
  if (kind === 'zoom') kakapoActivity.zoomAt = performance.now();
}
(function trackMainThreadStalls() {
  var perf = window.kakapoPerf;
  if (!perf || typeof perf.mark !== 'function') return;
  try {
    {
      new PerformanceObserver(function (entries) {
        entries.getEntries().forEach(function (entry) {
          if (!kakapoActivity.longest || entry.duration > kakapoActivity.longest.duration) {
            var blame = (entry.attribution && entry.attribution[0]) || {};
            kakapoActivity.longest = {
              duration: Math.round(entry.duration),
              name: String(entry.name || ''),
              containerType: String(blame.containerType || ''),
              containerId: String(blame.containerId || ''),
              containerName: String(blame.containerName || ''),
            };
          }
        });
      }).observe({ entryTypes: ['longtask'] });
    }
  } catch (e) {}
  var TICK_MS = 1000, STALL_MS = 1500;
  var last = performance.now();
  var hiddenSinceLastTick = document.visibilityState === 'hidden';
  setInterval(function () {
    var now = performance.now();
    var late = now - last - TICK_MS;
    var wasHidden = hiddenSinceLastTick;
    hiddenSinceLastTick = document.visibilityState === 'hidden';
    last = now;
    // A minimized window is a hidden page, and Chromium throttles a hidden page's timers to about one tick
    // a minute — so a parked window filed 60-second "stalls", and the first tick after it came back filed
    // the throttled gap as one too. Neither is the renderer failing to answer; they were noise on top of
    // the real stalls, which is what this exists to find.
    if (late >= STALL_MS - TICK_MS && !wasHidden && !hiddenSinceLastTick) {
      var worst = kakapoActivity.longest || {};
      perf.mark('renderer-stall', {
        blockedMs: Math.round(late + TICK_MS),
        hidden: document.visibilityState === 'hidden',
        diffFiles: document.querySelectorAll('#diff2html-container .d2h-file-wrapper').length,
        sinceZoomMs: kakapoActivity.zoomAt ? Math.round(now - kakapoActivity.zoomAt) : -1,
        longTaskMs: worst.duration || 0,
        longTaskIn: (worst.containerType || '') + (worst.containerId ? '#' + worst.containerId : ''),
      });
      kakapoActivity.longest = null;
    }
  }, TICK_MS);
})();
