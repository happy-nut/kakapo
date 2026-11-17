function isTextEntry(el) {
  return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}
function inTextField() { return isTextEntry(document.activeElement); }
function keyboardScope() {
  var settings = document.getElementById('settings-modal');
  if (settings && !settings.classList.contains('hidden')) return 'modal';
  var gotoLine = document.getElementById('goto-line');
  if (gotoLine && gotoLine.contains(document.activeElement)) return 'modal';
  var prPrompt = document.getElementById('pr-prompt');
  if (prPrompt && (prPrompt.contains(document.activeElement) || prPrompt.querySelector('input:disabled'))) return 'modal';
  var history = document.getElementById('history-view');
  if (history && !history.classList.contains('hidden')) return 'history';
  if (isDockFocused()) return 'panel';
  if (inTextField()) return 'field';
  return 'content';
}
function isFloatingModalOpen() { return keyboardScope() !== 'content'; }

function leaveFullScreenPanels() {
  closeHistoryIfOpen();
  closeMergedDock();
}

function activateChangesView(navigateToDiff) {
  leaveFullScreenPanels();
  if (isDiffViewVisible()) {
    if (reviewSidebarCollapsed) { setReviewSidebarCollapsed(false, { focusSidebar: true }); return; }
    if (treeFocusIndex >= 0 && activeSidebarTab() === 'changes') { toggleReviewSidebar(); return; }
    setTab('changes');
    focusOpenFileInTree();
    return;
  }
  setSourceSidebarCollapsed(false);
  setReviewSidebarCollapsed(false);
  if (navigateToDiff) showDiffView(false);
  setTab('changes');
  focusOpenFileInTree();
}

function activateFilesView() {
  leaveFullScreenPanels();
  if (isSourceViewerVisible()) {
    if (sourceSidebarCollapsed) { setSourceSidebarCollapsed(false, { focusSidebar: true }); return; }
    if (treeFocusIndex >= 0 && activeSidebarTab() === 'files') { toggleSourceSidebar(); return; }
    setTab('files');
    focusOpenFileInTree();
    return;
  }
  setSourceSidebarCollapsed(false);
  if (isDiffViewVisible()) {
    var wrapper = diffActiveWrapper();
    var path = (diffCursor && diffCursor.path) || (wrapper ? diffWrapperPathKey(wrapper) : '');
    if (path && sourceByPath.has(path)) {
      openSourceFile(path);
    } else {
      showSourceView();
      if (path && REVIEW_LAZY_LOAD && !projectIndexLoaded) {
        ensureProjectIndex().then(function () {
          if (sourceByPath.has(path)) openSourceFile(path);
          focusOpenFileInTree();
        });
      }
    }
  }
  if (!isSourceViewerVisible()) showSourceView();
  setTab('files');
  focusOpenFileInTree();
}
var KEY_OWNERS = [
  { name: 'settings', handle: function (event) { return typeof handleSettingsKey === 'function' && handleSettingsKey(event); } },
  { name: 'semantic-peek', handle: function (event) { return handleSemanticPeekKey(event); } },
  { name: 'compare-menu', handle: function (event) { return handleCompareMenuKey(event); } },
  { name: 'quick-open', handle: function (event) {
    if (quickOpen?.classList.contains('hidden')) return false;
    handleQuickOpenKey(event);
    event.stopImmediatePropagation();
    return true;
  } },
  { name: 'usages', handle: function (event) {
    var box = document.getElementById('usages');
    if (!box || box.classList.contains('hidden')) return false;
    return handleUsagesKey(event);
  } },
  { name: 'file-find', handle: function (event) { return handleFileFindKey(event); } },
  { name: 'lightbox', handle: function (event) {
    if (event.key !== 'Escape' || !lightboxOpen()) return false;
    event.preventDefault();
    event.stopPropagation();
    closeLightbox();
    return true;
  } },
  { name: 'quick-doc', handle: function (event) {
    if (event.key !== 'Escape') return false;
    if (!closeQuickDoc()) return false;
    event.preventDefault();
    return true;
  } },
  { name: 'usage-marks', handle: function (event) {
    if (event.key !== 'Escape' || !(typeof usageMarks !== 'undefined' && usageMarks.length)) return false;
    event.preventDefault();
    clearUsageHighlights();
    return true;
  } },
];

var SHORTCUT_ACTIONS = {
  maximizePanel: function () { return toggleDockMaximized() ? undefined : false; },
  allComments: function () { toggleMergedView(); },
  openHistory: function () { toggleHistory(); },
  filesChangesTab: function (event, i) { if (i) activateChangesView(false); else activateFilesView(); },
  undoCommentRemoval: function () {
    if (inTextField()) {
      if (commentRemovalPending()) showCaretHint(t('comment.undoInField'));
      return false;
    }
    return undoLastCommentRemoval() ? undefined : false;
  },
  revealInTree: function () { revealOpenFileInTree(); },

  nextChange: function () { stepToChange(1); },
  prevChange: function () { stepToChange(-1); },
  nextComment: function (event, i) { clearTreeFocus(); gotoComment(i ? -1 : 1); },

  gotoDiagnostic: function (event, i) { return gotoDiagnostic(i ? -1 : 1) ? undefined : false; },
  errorDescription: function () {
    if (treeFocusIndex >= 0) return false;
    return showErrorDescriptionAtCaret() ? undefined : false;
  },
  problemsView: function () {
    var qo = document.getElementById('quick-open');
    if (qo && !qo.classList.contains('hidden') && quickMode === 'problems') { closeQuickOpen(); return; }
    return openProblemsView() ? undefined : false;
  },
  quickDoc: function () {
    if (treeFocusIndex >= 0 || !quickDocPanel()) return false;
    openQuickDocumentation();
  },
  expressionType: function () {
    if (treeFocusIndex >= 0) return false;
    showExpressionType();
  },
  toggleFold: function () {
    if (isDiffViewVisible()) return toggleDiffFileCollapse() ? undefined : false;
    return toggleCurrentSourceFold() ? undefined : false;
  },
  collapseAll: function () {
    if (isDiffViewVisible()) return setAllDiffFilesCollapsed(true) ? undefined : false;
    return collapseAllSourceFolds() ? undefined : false;
  },
  expandAll: function () {
    if (isDiffViewVisible()) return setAllDiffFilesCollapsed(false) ? undefined : false;
    return expandAllSourceFolds() ? undefined : false;
  },
  collapseRecursively: function () { return collapseSourceFoldRecursively() ? undefined : false; },
  diffFileStep: function (event, i) { return goToDiffFile(i ? -1 : 1) ? undefined : false; },
  selectEditor: function () { return selectAllInView() ? undefined : false; },
  gotoLine: function () { return openGotoLine() ? undefined : false; },
  copyLocation: function () { return copyCaretLocation() ? undefined : false; },
  addComment: function () { openComposer('c'); },
  recentFiles: function () {
    var qo = document.getElementById('quick-open');
    if (qo && !qo.classList.contains('hidden') && quickMode === 'recent') closeQuickOpen();
    else openQuickOpen('recent', true);
  },
  findInFiles: function () { openQuickOpen('content'); },
  searchExtensions: function () { openQuickOpen('content'); setTimeout(focusContentSearchExtensions, 0); },
  excludeSearchNoise: function () { openQuickOpen('content'); toggleContentSearchNoise(); },
  compareMode: function (event, i) { pickCompareMode(['all', 'uncommitted', 'tip', 'since'][i] || 'all'); },
  openPullRequest: function () { return openPullRequestPrompt() ? undefined : false; },
  patchSetStep: function (event, i) { return stepPatchSet(i ? -1 : 1) ? undefined : false; },
  compareRef: function () { openCompareBranchPicker(); },
  goToDef: function (event, i) {
    if (isSourceViewerVisible() || i === 0) goToDefinitionUnderCursor();
    else openDiffFileAtCaret();
  },
  quickDefinition: function () {
    if (treeFocusIndex >= 0 || !quickDocPanel()) return false;
    openQuickDefinition();
  },
  findAction: function () {
    var qo = document.getElementById('quick-open');
    if (qo && !qo.classList.contains('hidden') && quickMode === 'actions') { closeQuickOpen(); return; }
    return openFindAction() ? undefined : false;
  },
  workspaceSymbol: function () { openWorkspaceSymbols(false); },
  goToClass: function () { openWorkspaceSymbols(true); },
  relatedSymbol: function () { return goToRelatedSymbol() ? undefined : false; },
  customRegion: function () {
    if (treeFocusIndex >= 0) return false;
    return openCustomRegions() ? undefined : false;
  },
  lastChange: function () {
    if (treeFocusIndex >= 0) return false;
    return jumpToLastChange() ? undefined : false;
  },
  goToImplementation: function () { goToImplementation(); },
  defUsages: function () { findUsagesUnderCursor(); },
  findUsages: function () {
    if (treeFocusIndex >= 0) return false;
    return openFindUsages() ? undefined : false;
  },
  highlightUsages: function () {
    if (treeFocusIndex >= 0) return false;
    return highlightUsagesInFile() ? undefined : false;
  },
  nextPrevOccurrence: function (event, i) {
    if (treeFocusIndex >= 0 || isFloatingModalOpen()) return false;
    return stepUsageOccurrence(i ? -1 : 1) ? undefined : false;
  },
  prevNextTab: function (event, i) {
    if (!isSourceViewerVisible() || sourceTabs.length <= 1) return false;
    cycleSourceTab(i ? 1 : -1);
  },
  cursorBackForward: function (event, i) {
    clearTreeFocus();
    return (i ? navForward() : navBack()) ? undefined : false;
  },
  toggleRendered: function () {
    var open = sourceOpenPath();
    if (!open || !isRenderToggleable(open) || !isSourceViewerVisible()) return false;
    toggleRenderMode();
  },
  toggleLineWrap: function () { return toggleLineWrap() ? undefined : false; },
  showWhitespace: function () { return isCodeSurfaceVisible() ? toggleRenderToggle('showWhitespace') : false; },
  indentGuides: function () { return isCodeSurfaceVisible() ? toggleRenderToggle('indentGuides') : false; },
  stickyLines: function () { return isCodeSurfaceVisible() ? toggleRenderToggle('stickyLines') : false; },
  focusMode: function () { return isCodeSurfaceVisible() ? toggleRenderToggle('focusMode') : false; },
  essentialHighlighting: function () { return toggleRenderToggle('essentialHighlighting'); },
  alignChanges: function () { return toggleRenderToggle('alignChanges'); },
  codeVision: function () { return isCodeSurfaceVisible() ? toggleRenderToggle('codeVision') : false; },
  inlayHints: function () { return isCodeSurfaceVisible() ? toggleRenderToggle('inlayHints') : false; },
  copyAsPatch: function () { return copyActiveFileAsPatch() ? undefined : false; },
  compareClipboard: function () { return compareClipboardWithFile() ? undefined : false; },
  runHttp: function (event, i) {
    if (treeFocusIndex >= 0) return false;
    var enterPath = isSourceViewerVisible() ? sourceOpenPath() : '';
    if (enterPath && isHttpFile(enterPath)) { runHttpAtCaret(); return; }
    if (!isSourceViewerVisible() && isDiffViewVisible() && runDiffHttpAtCaret()) return;
    if (i === 1 && createFixCommentAtCaret()) return;
    return false;
  },
  typeDeclaration: function () {
    if (treeFocusIndex >= 0) return false;
    goToTypeDeclaration();
  },
  fileStructure: function () {
    if (treeFocusIndex >= 0) return false;
    return openFileStructure() ? undefined : false;
  },
  nextPrevSymbol: function (event, i) {
    if (treeFocusIndex >= 0 || isFloatingModalOpen()) return false;
    return goToNextSymbol(i ? -1 : 1) ? undefined : false;
  },
  extendShrinkSelection: function (event, i) {
    if (treeFocusIndex >= 0 || isFloatingModalOpen()) return false;
    return extendShrinkSelection(i === 0) ? undefined : false;
  },
  endpointsView: function () {
    if (treeFocusIndex >= 0) return false;
    return openEndpoints() ? undefined : false;
  },
  recentLocations: function () { return openRecentLocations() ? undefined : false; },
  searchFiles: function () { openQuickOpen('all'); },
  searchEverywhere: function () { switchQuickLauncherSection('everywhere'); },
  goToTest: function () { return goToTestCounterpart() ? undefined : false; },
  typeHierarchy: function () {
    if (treeFocusIndex >= 0) return false;
    return openHierarchy('supertypes') ? undefined : false;
  },
  callHierarchy: function () {
    if (treeFocusIndex >= 0) return false;
    return openHierarchy('callers') ? undefined : false;
  },
  methodHierarchy: function () {
    if (treeFocusIndex >= 0) return false;
    return openHierarchy('implementation') ? undefined : false;
  },
  goToSuper: function () {
    if (treeFocusIndex >= 0) return false;
    goToSuperDeclaration();
  },
  toggleBookmark: function () { return toggleBookmarkAtCaret() ? undefined : false; },
  showBookmarks: function () { return openBookmarks() ? undefined : false; },
  assignBookmark: function (event, i) { return assignBookmarkMnemonic(i + 1) ? undefined : false; },
  jumpBookmark: function (event, i) { return goToBookmarkMnemonic(i + 1) ? undefined : false; },

  runHttpAll: function () {
    var path = httpOpenPath();
    if (!path || treeFocusIndex >= 0 || !httpRequestsByPath.get(path)) return false;
    runHttpFile();
  },
  copyHttpCurl: function () {
    var path = httpOpenPath();
    if (!path || treeFocusIndex >= 0) return false;
    var chosen = httpRequestIndexAtCaret(path);
    if (chosen < 0) return false;
    copyHttpAsCurl(chosen, path);
  },
};

var WINDOW_SHORTCUT_IDS = ['maximizePanel', 'allComments', 'openHistory', 'filesChangesTab', 'undoCommentRemoval', 'revealInTree', 'findAction'];
var REVIEW_SHORTCUT_IDS = ['nextChange', 'prevChange', 'nextComment'];

function runShortcut(event, ids) {
  var hits = shortcutHits(event);
  for (var i = 0; i < hits.length; i += 1) {
    if (ids.indexOf(hits[i].id) < 0) continue;
    var action = SHORTCUT_ACTIONS[hits[i].id];
    if (!action || action(event, hits[i].index) === false) continue;
    event.preventDefault();
    return true;
  }
  return false;
}
function contentShortcutIds() {
  if (!contentShortcutIdsCache) {
    contentShortcutIdsCache = Object.keys(SHORTCUT_ACTIONS)
      .filter(function (id) { return WINDOW_SHORTCUT_IDS.indexOf(id) < 0 && REVIEW_SHORTCUT_IDS.indexOf(id) < 0; });
  }
  return contentShortcutIdsCache;
}
var contentShortcutIdsCache;

function stepToChange(delta) {
  clearTreeFocus();
  if (delta > 0 && isSourceViewerVisible()) {
    var sp = sourceOpenPath();
    var sourceHunk = firstHunkForPath(sp);
    if (sourceHunk >= 0 && !isFileViewed(sp)) { setActive(sourceHunk); return; }
  }
  next(delta);
}

function closeHistoryIfOpen() {
  if (isHistoryOpen()) closeHistory();
}
document.addEventListener('keydown', (event) => {
  for (var oi = 0; oi < KEY_OWNERS.length; oi += 1) {
    if (KEY_OWNERS[oi].handle(event)) return;
  }

  var scope = keyboardScope();
  if (scope !== 'modal' && runShortcut(event, WINDOW_SHORTCUT_IDS)) return;

  if ((scope === 'content' || scope === 'field') && runShortcut(event, REVIEW_SHORTCUT_IDS)) return;

  if (isFloatingModalOpen()) return;

  if (runShortcut(event, contentShortcutIds())) return;

  if (event.key === 'Tab') {
    const activeEl = document.activeElement;
    const inField = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
    if (!inField) {
      event.preventDefault();
      if (event.shiftKey) {
        if (isDiffViewVisible() && diffCursor) {
          const tabSide = diffCursor.side === 'new' ? 'old' : 'new';
          const tabWrap = diffWrapperByPath(diffCursor.path);
          const tabRow = tabWrap ? diffRowAt(tabWrap, tabSide, diffCursor.rowIndex) : null;
          if (isDiffCodeRow(tabRow)) setDiffCursor(diffCursor.path, tabSide, diffCursor.rowIndex, 0, true);
          else showCaretHint(t(tabSide === 'old' ? 'diff.noBaseLine' : 'diff.noWorkingLine'));
          return;
        }
        focusTree(treeFocusIndex >= 0 ? treeFocusIndex : 0);
      } else {
        clearTreeFocus();
        const openPath = sourceOpenPath();
        if (isSourceViewerVisible() && openPath && (!viewerCursor || viewerCursor.path !== openPath)) {
          setSourceCursor(openPath, viewerCursor ? viewerCursor.lineIndex : 0, 0, false, -1);
        }
        flashReviewPanelFocus(isSourceViewerVisible()
          ? document.getElementById('source-body')
          : document.getElementById('diff2html-container'), true);
      }
      return;
    }
  }

  if (event.altKey && !event.metaKey && !event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    var wae = document.activeElement;
    var wInField = wae && (wae.tagName === 'INPUT' || wae.tagName === 'TEXTAREA' || wae.tagName === 'SELECT');
    if (!wInField && treeFocusIndex < 0) {
      var wdir = event.key === 'ArrowRight' ? 1 : -1;
      if (isSourceViewerVisible() && viewerCursor) { event.preventDefault(); moveSourceWord(wdir, event.shiftKey); return; }
      if (isDiffViewVisible() && diffCursor) { event.preventDefault(); moveDiffWord(wdir, event.shiftKey); return; }
    }
  }

  if (treeFocusIndex < 0 && (event.key === 'PageDown' || event.key === 'PageUp') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    var psc = isDiffViewVisible() ? document.getElementById('diff2html-container') : (isSourceViewerVisible() ? document.getElementById('source-body') : null);
    if (psc) { event.preventDefault(); psc.scrollTop += (event.key === 'PageDown' ? 0.9 : -0.9) * psc.clientHeight; return; }
  }
  if (treeFocusIndex >= 0 && handleTreeKey(event)) return;
  if (treeFocusIndex < 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isSourceViewerVisible() && handleSourceCaretKey(event)) return;
  if (treeFocusIndex < 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isDiffViewVisible() && handleDiffCaretKey(event)) return;

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

  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isDiffViewVisible() && diffCursor) {
    event.preventDefault();
    const edgeWrap = diffWrapperByPath(diffCursor.path);
    const edgeRow = edgeWrap ? diffRowAt(edgeWrap, diffCursor.side, diffCursor.rowIndex) : null;
    const edgeLen = edgeRow ? diffLineText(edgeRow).length : 0;
    const edgeExtend = event.shiftKey;
    const edgeAnchor = edgeExtend
      ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column })
      : null;
    if (event.key === 'ArrowLeft') {
      if (diffCursor.column > 0) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, 0, true);
      } else if (!edgeExtend && diffCursor.side === 'new') {
        const oldRow = edgeWrap ? diffRowAt(edgeWrap, 'old', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(oldRow)) setDiffCursor(diffCursor.path, 'old', diffCursor.rowIndex, diffLineText(oldRow).length, true);
      }
    } else {
      if (diffCursor.column < edgeLen) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, edgeLen, true);
      } else if (!edgeExtend && diffCursor.side === 'old') {
        const newRow = edgeWrap ? diffRowAt(edgeWrap, 'new', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(newRow)) setDiffCursor(diffCursor.path, 'new', diffCursor.rowIndex, 0, true);
      }
    }
    if (edgeAnchor) { diffSelectionAnchor = edgeAnchor; applyDiffSelection(); }
    return;
  }
});

quickInput?.addEventListener('input', () => renderQuickOpenResults());
quickExtensionInput?.addEventListener('input', restartContentSearch);
quickExcludeNoiseButton?.addEventListener('click', function () {
  if (quickMode === 'usages') toggleUsageViewNoise();
  else toggleContentSearchNoise();
});
quickMatchCaseButton?.addEventListener('click', function () { toggleContentSearchModifier('matchCase'); });
quickWholeWordsButton?.addEventListener('click', function () { toggleContentSearchModifier('wholeWords'); });
quickRegexButton?.addEventListener('click', function () { toggleContentSearchModifier('regex'); });
quickResults?.addEventListener('mousemove', (event) => {
  const item = event.target.closest?.('.quick-open-item');
  if (!item) return;
  const next = Number(item.dataset.index || 0);
  if (next === quickActive) return;
  quickActive = next;
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

document.getElementById('changes-panel')?.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('.file-link') : null;
  if (!link) return;
  if (event.target.closest('.viewed-box')) {
    event.preventDefault();
    event.stopPropagation();
    const viewedFile = link.dataset.file || '';
    if (viewedFile && currentFileSignature(viewedFile)) setFileViewed(viewedFile, !isFileViewed(viewedFile));
    return;
  }
  if (event.shiftKey && extendTreeSelectionToRow(link)) {
    event.preventDefault();
    return;
  }
  const pointerSelection = reviewFocusInputModality === 'pointer';
  showDiffView(false);
  const target = diffHunkForLink(link);
  if (target >= 0) {
    event.preventDefault();
    setActive(target, true, true);
  } else if (activateDiffFile(link.dataset.file, true)) {
    event.preventDefault();
  }
  if (pointerSelection) focusTreeRowFromPointer(link);
});

document.getElementById('files-panel')?.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('.source-link') : null;
  if (!link || !link.dataset.sourceFile) return;
  const pointerSelection = reviewFocusInputModality === 'pointer';
  openSourceFile(link.dataset.sourceFile, true, { scrollTree: !pointerSelection });
  if (pointerSelection) focusTreeRowFromPointer(link);
});

document.querySelectorAll('.sidebar-switch-item').forEach((button) => {
  button.addEventListener('click', () => {
    if ((button.dataset.tab || 'changes') === 'files') activateFilesView();
    else activateChangesView(true);
  });
});

document.getElementById('back-to-diff')?.addEventListener('click', () => showDiffView(true));
document.getElementById('source-tabs')?.addEventListener('click', function (event) {
  var closeBtn = event.target && event.target.closest && event.target.closest('.source-tab-close');
  if (closeBtn) { event.stopPropagation(); event.preventDefault(); closeSourceTab(closeBtn.getAttribute('data-close-path')); return; }
  var overflow = event.target && event.target.closest && event.target.closest('.source-tab-overflow');
  if (overflow) { event.stopPropagation(); event.preventDefault(); showSourceTabOverflowMenu(overflow); return; }
  var tab = event.target && event.target.closest && event.target.closest('.source-tab');
  if (tab) openSourceFile(tab.getAttribute('data-tab-path'));
});
document.addEventListener('click', function (event) {
  if (event.target && event.target.closest && event.target.closest('#compare-open-history')) openHistory();
});
document.getElementById('diff-prev-change')?.addEventListener('click', function () { next(-1); });
document.getElementById('diff-next-change')?.addEventListener('click', function () { next(1); });
document.getElementById('diff-prev-file')?.addEventListener('click', function () { goToDiffFile(-1); });
document.getElementById('diff-next-file')?.addEventListener('click', function () { goToDiffFile(1); });
document.getElementById('diff-open-source')?.addEventListener('click', function () { openDiffFileAtCaret(); });
document.getElementById('diff-sidebar-toggle')?.addEventListener('click', function () { toggleReviewSidebar(); });
document.getElementById('source-body')?.addEventListener('mousemove', updateCmdLink);
document.getElementById('source-body')?.addEventListener('mouseleave', hideCmdLink);
document.addEventListener('keyup', function (event) { if (event.key === 'Meta' || event.key === 'Control') hideCmdLink(); });
document.getElementById('source-body')?.addEventListener('scroll', hideCmdLink, true);
document.getElementById('source-body')?.addEventListener('click', handleSourceClick);
document.getElementById('source-body')?.addEventListener('dblclick', handleSourceDoubleClick);
document.getElementById('source-body')?.addEventListener('click', function (event) {
  var img = event.target && event.target.closest && event.target.closest('.image-preview');
  if (img) openLightbox(img.getAttribute('src'), img.getAttribute('alt'));
});

(function installButtonShortcutHints() {
  var hint = document.createElement('div');
  hint.id = 'mc-button-hint';
  hint.className = 'mc-button-hint hidden';
  hint.setAttribute('role', 'tooltip');
  hint.innerHTML = '<span class="mc-button-hint-label"></span><kbd></kbd>';
  document.body.appendChild(hint);
  var owner = null;
  function buttonFor(target) {
    var button = target && target.closest ? target.closest('button') : null;
    return button && button.hasAttribute('data-keyhint')
      && !button.classList.contains('rail-btn') && !button.classList.contains('mc-select')
      && !button.classList.contains('quick-open-side-item')
      && !button.classList.contains('file-link') ? button : null;
  }
  function buttonLabel(button) {
    return button.getAttribute('data-tooltip') || button.getAttribute('aria-label')
      || button.getAttribute('data-hint-title') || button.getAttribute('title')
      || (button.textContent || '').trim() || 'Action';
  }
  function place(button) {
    if (!button || !button.isConnected) return;
    owner = button;
    hint.querySelector('.mc-button-hint-label').textContent = buttonLabel(button);
    if (button.hasAttribute('title')) {
      button.setAttribute('data-hint-title', button.getAttribute('title') || '');
      button.removeAttribute('title');
    }
    hint.querySelector('kbd').textContent = button.getAttribute('data-keyhint');
    hint.classList.remove('hidden');
    var rect = button.getBoundingClientRect();
    var box = hint.getBoundingClientRect();
    var left = Math.max(8, Math.min(window.innerWidth - box.width - 8, rect.left + rect.width / 2 - box.width / 2));
    var top = rect.bottom + 8;
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 8);
    hint.style.left = left + 'px'; hint.style.top = top + 'px';
  }
  function hide(button) {
    if (button && owner && button !== owner) return;
    owner = null; hint.classList.add('hidden');
  }
  document.addEventListener('mouseover', function (event) { var button = buttonFor(event.target); if (button) place(button); });
  document.addEventListener('mouseout', function (event) {
    var button = buttonFor(event.target);
    if (button && (!event.relatedTarget || !button.contains(event.relatedTarget))) hide(button);
  });
  document.addEventListener('focusin', function (event) { var button = buttonFor(event.target); if (button) place(button); });
  document.addEventListener('focusout', function (event) { var button = buttonFor(event.target); if (button) hide(button); });
  document.addEventListener('click', function () { hide(); }, true);
  window.addEventListener('scroll', function () { hide(); }, true);
  window.addEventListener('resize', function () { if (owner) place(owner); });
  // Composer and other dynamic controls are replaced by innerHTML. Removing a hovered/focused button does
  // not reliably emit mouseout/focusout in Chromium, so its shortcut bubble could remain orphaned after the
  // comment box closed. A single batched observer is cheaper and more robust than teaching every renderer
  // to know about this global tooltip.
  if (window.MutationObserver) {
    new window.MutationObserver(function () {
      if (owner && !owner.isConnected) hide();
    }).observe(document.body, { childList: true, subtree: true });
  }
})();

// Chromium's custom scrollbar styling disables macOS' native overlay fade. Restore that behavior for
// every current and future scroll surface without changing its reserved gutter (which would shift code).
(function installAutoHidingScrollbars() {
  var idleTimers = new WeakMap();
  var idleMs = 900;
  document.addEventListener('scroll', function (event) {
    var target = event.target === document ? document.documentElement : event.target;
    if (!target || !target.classList) return;
    target.classList.add('mc-scroll-active');
    var previous = idleTimers.get(target);
    if (previous) clearTimeout(previous);
    idleTimers.set(target, setTimeout(function () {
      target.classList.remove('mc-scroll-active');
      idleTimers.delete(target);
    }, idleMs));
  }, { capture: true, passive: true });
})();

applyI18n();
(function () {
  document.querySelectorAll('.brand-branch-name').forEach(function (chip) {
    applyBranchChip(chip, chip.textContent || '');
  });
}());
populateHttpEnvSelect();
const restored = REVIEW_OPEN_PATH ? (openSourceFile(REVIEW_OPEN_PATH), true) : restoreUiState();
if (!restored) {
  const initial = location.hash.match(/^#hunk-(\d+)$/);
  const hasDiff = Boolean(document.querySelector('#diff2html-container .d2h-file-wrapper'));
  if (initial) setActive(Number(initial[1]), false);
  else if (!hasDiff) openDefaultSourceFile();
  else if (REVIEW_LAZY_LOAD) showDiffView(false);
  else openDefaultSourceFile();
}
initSourceTreeFolds();
initChangesTreeFolds();
if (watchEnabled && !(window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function')) {
  setInterval(checkForLiveUpdate, 1500);
}
window.addEventListener('beforeunload', saveUiState);

if (window.kakapoMenu && typeof window.kakapoMenu.onReadingAction === 'function') {
  window.kakapoMenu.onReadingAction(function (id, index) {
    var action = SHORTCUT_ACTIONS[id];
    if (!action) return;
    action(new KeyboardEvent('keydown'), Number(index) || 0);
  });
}

(function () {
  var ov = document.getElementById('boot-overlay');
  if (!ov) return;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      try {
        if (window.kakapoPerf && typeof window.kakapoPerf.mark === 'function') {
          window.kakapoPerf.mark('first-review-paint', {
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
  const sidebarKey = 'kakapo-sidebar-width:' + location.pathname;
  const saved = persistRead(sidebarKey) || localStorage.getItem(sidebarKey);
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
    const railW = parseFloat(getComputedStyle(document.body).getPropertyValue('--rail-width')) || 0;
    const width = Math.min(640, Math.max(180, event.clientX - railW));
    document.documentElement.style.setProperty('--sidebar-width', width + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    resizer.classList.remove('resizing');
    document.body.style.userSelect = '';
    persistSave(sidebarKey, getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim());
  });
})();

(function setupDiffCaret() {
  const container = document.getElementById('diff2html-container');
  if (!container) return;
  container.setAttribute('aria-readonly', 'true');
  container.querySelectorAll('.d2h-code-side-linenumber, .d2h-code-linenumber, .d2h-code-line-prefix').forEach((el) => el.setAttribute('contenteditable', 'false'));
  const inComment = (event) => Boolean(event.target && event.target.closest && event.target.closest('.mc-comment-row'));
  const block = (event) => { if (inComment(event)) return; event.preventDefault(); };
  container.addEventListener('focusin', (event) => { if (!inComment(event)) clearTreeFocus(); });
  container.addEventListener('mousedown', (event) => { if (!inComment(event)) clearTreeFocus(); });
  container.addEventListener('beforeinput', block);
  container.addEventListener('paste', block);
  container.addEventListener('drop', block);
  container.addEventListener('keydown', (event) => {
    if (inComment(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Tab') {
      event.preventDefault();
    }
  });
  container.addEventListener('click', (event) => {
    if (inComment(event)) return;
    if (Number(event.detail) > 1) return;
    if (selectedText()) return;
    const info = diffRowInfoFromNode(event.target);
    if (!info || !info.path) return;
    const code = event.target?.closest?.('.d2h-code-line-ctn');
    const row = code?.closest?.('tr');
    const column = code && row && isDiffCodeRow(row) ? estimateColumnFromClick(code, event, diffLineText(row)) : 0;
    setDiffCursor(info.path, info.side, info.rowIndex, column, false);
  });
  container.addEventListener('dblclick', (event) => {
    if (inComment(event)) return;
    const code = event.target?.closest?.('.d2h-code-line-ctn');
    const row = code?.closest?.('tr');
    if (!code || !row || !isDiffCodeRow(row)) return;
    const text = diffLineText(row);
    const column = estimateColumnFromClick(code, event, text);
    diffSelectionAnchor = null;
    if (selectCodeWord(code, text, column)) event.preventDefault();
  });
  ensureDiffCursor();
})();
