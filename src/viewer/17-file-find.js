// Current-file search shared by Review source and side-by-side diff views. Project-wide content search
// remains Cmd/Ctrl+Shift+F; this deliberately never walks hidden files/wrappers.
var fileFindPanel = document.getElementById('file-find');
var fileFindInput = document.getElementById('file-find-input');
var fileFindCount = document.getElementById('file-find-count');
var fileFindPrev = document.getElementById('file-find-prev');
var fileFindNext = document.getElementById('file-find-next');
var fileFindClose = document.getElementById('file-find-close');
var fileFindResults = [];
var fileFindActive = -1;
var fileFindRevision = 0;
var fileFindRestoreFocus = null;
var fileFindRefreshTimer = 0;
var fileFindHighlightFrame = 0;
var fileFindHighlightedRows = [];
var FILE_FIND_LIMIT = 5000;
var FILE_FIND_DEBOUNCE_MS = 90;
var FILE_FIND_HIGHLIGHT_LIMIT = 200;
var FILE_FIND_SHORT_QUERY_HIGHLIGHT_LIMIT = 48;

function isFileFindOpen() {
  return Boolean(fileFindPanel && !fileFindPanel.classList.contains('hidden'));
}

function fileFindSurface() {
  if (isDiffViewVisible()) return 'diff';
  if (isSourceViewerVisible()) return 'source';
  return '';
}

function fileFindSurfacePath() {
  if (isSourceViewerVisible()) return document.getElementById('source-viewer')?.dataset.openPath || '';
  var wrapper = diffActiveWrapper();
  return wrapper ? diffWrapperPathKey(wrapper) : '';
}

function positionFileFind() {
  if (!fileFindPanel || !isFileFindOpen()) return;
  var surface = isDiffViewVisible() ? document.getElementById('diff2html-container') : document.getElementById('source-body');
  var rect = surface && surface.getBoundingClientRect ? surface.getBoundingClientRect() : null;
  var width = Math.min(360, Math.max(220, window.innerWidth - 24));
  var right = rect && rect.right > rect.left ? Math.max(12, window.innerWidth - rect.right + 12) : 12;
  var top = rect && rect.bottom > rect.top ? Math.max(12, rect.top + 8) : 12;
  fileFindPanel.style.width = width + 'px';
  fileFindPanel.style.right = Math.round(right) + 'px';
  fileFindPanel.style.top = Math.round(top) + 'px';
}

function clearFileFindHighlights() {
  fileFindHighlightedRows.forEach(function (row) {
    row.classList.remove('file-find-row-match', 'file-find-row-active');
  });
  fileFindHighlightedRows = [];
  try {
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete('kakapo-file-find');
      CSS.highlights.delete('kakapo-file-find-active');
    }
  } catch (e) {}
}

function fileFindDomPoint(container, offset) {
  if (!container) return null;
  var remaining = Math.max(0, Number(offset) || 0);
  var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode())) {
    var length = (node.textContent || '').length;
    if (remaining <= length) return { node: node, offset: remaining };
    remaining -= length;
  }
  return null;
}

function fileFindRange(container, start, length) {
  var from = fileFindDomPoint(container, start);
  var to = fileFindDomPoint(container, start + length);
  if (!from || !to) return null;
  try {
    var range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  } catch (e) { return null; }
}

function sourceFindRow(lineIndex) {
  var body = document.getElementById('source-body');
  if (!body) return null;
  var exact = body.querySelector('.source-row[data-line-index="' + lineIndex + '"]');
  if (exact) return exact;
  return Array.prototype.find.call(body.querySelectorAll('.source-row[data-line-index]'), function (row) {
    var start = Number(row.dataset.lineIndex) || 0;
    var end = row.dataset.lineEnd == null ? start : Number(row.dataset.lineEnd);
    return lineIndex >= start && lineIndex <= end;
  }) || null;
}

function fileFindResultContainer(result) {
  if (result.kind === 'diff') return result.row && diffCellCtn(result.row);
  var row = sourceFindRow(result.lineIndex);
  return row && (row.querySelector('.source-code') || row);
}

function applyFileFindHighlights() {
  clearFileFindHighlights();
  if (!fileFindResults.length || !fileFindInput?.value) return;
  var query = fileFindInput.value.toLocaleLowerCase();
  var allRanges = [], activeRanges = [];
  var rowSet = new Set();
  var limit = query.length < 2 ? FILE_FIND_SHORT_QUERY_HIGHLIGHT_LIMIT : FILE_FIND_HIGHLIGHT_LIMIT;
  var indexes = [];
  for (var i = 0; i < Math.min(fileFindResults.length, limit); i++) indexes.push(i);
  if (fileFindActive >= limit) indexes.push(fileFindActive);
  indexes.forEach(function (index) {
    var result = fileFindResults[index];
    var container = fileFindResultContainer(result);
    var row = result.kind === 'diff' ? result.row : sourceFindRow(result.lineIndex);
    if (row && !rowSet.has(row)) {
      rowSet.add(row);
      fileFindHighlightedRows.push(row);
      row.classList.add('file-find-row-match');
    }
    if (index === fileFindActive && row) row.classList.add('file-find-row-active');
    if (!container) return;
    var shown = (container.textContent || '').toLocaleLowerCase();
    var start = result.kind === 'diff' ? result.column : shown.indexOf(query);
    if (start < 0 || shown.slice(start, start + query.length) !== query) start = shown.indexOf(query);
    if (start < 0) return;
    var range = fileFindRange(container, start, query.length);
    if (!range) return;
    allRanges.push(range);
    if (index === fileFindActive) activeRanges.push(range);
  });
  try {
    if (window.CSS && CSS.highlights && typeof window.Highlight === 'function') {
      CSS.highlights.set('kakapo-file-find', new window.Highlight(...allRanges));
      CSS.highlights.set('kakapo-file-find-active', new window.Highlight(...activeRanges));
    }
  } catch (e) {}
}

function scheduleFileFindHighlights() {
  if (fileFindHighlightFrame) cancelAnimationFrame(fileFindHighlightFrame);
  fileFindHighlightFrame = requestAnimationFrame(function () {
    fileFindHighlightFrame = 0;
    applyFileFindHighlights();
  });
}

function updateFileFindChrome() {
  var total = fileFindResults.length;
  if (fileFindCount) {
    fileFindCount.classList.toggle('is-empty', Boolean(fileFindInput?.value) && total === 0);
    fileFindCount.textContent = !fileFindInput?.value ? '0/0'
      : total ? (fileFindActive + 1) + '/' + total : t('find.noResults');
  }
  if (fileFindPrev) fileFindPrev.disabled = total === 0;
  if (fileFindNext) fileFindNext.disabled = total === 0;
}

function appendFileFindMatches(results, text, query, makeResult) {
  var haystack = String(text || '').toLocaleLowerCase();
  var from = 0;
  while (results.length < FILE_FIND_LIMIT) {
    var column = haystack.indexOf(query, from);
    if (column < 0) break;
    results.push(makeResult(column));
    from = column + Math.max(1, query.length);
  }
}

function collectSourceFindResults(query) {
  var path = document.getElementById('source-viewer')?.dataset.openPath || '';
  var file = sourceByPath.get(path);
  var results = [];
  if (!file || !file.embedded || file.image) return results;
  String(file.content || '').split(/\r?\n/).some(function (line, lineIndex) {
    appendFileFindMatches(results, line, query, function (column) {
      return { kind: 'source', path: path, lineIndex: lineIndex, column: column };
    });
    return results.length >= FILE_FIND_LIMIT;
  });
  return results;
}

function collectDiffFindResults(wrapper, query) {
  var results = [];
  var path = wrapper ? diffWrapperPathKey(wrapper) : '';
  // Imports are initially folded when unchanged. Searching the current file must still include them;
  // opening the paired marker restores the original rows on both panes before collecting occurrences.
  // A one-character query can match nearly every import and should not mutate the diff while the user is
  // still typing. Once the query is meaningful, restore imports so their contents remain searchable.
  var importFold = query.length >= 2 && wrapper && wrapper.querySelector('.mc-import-fold-row');
  if (importFold) openDiffImportFold(importFold);
  ['old', 'new'].some(function (side) {
    var rows = diffRowsOf(diffSideTable(wrapper, side));
    return rows.some(function (row, rowIndex) {
      if (!isDiffCodeRow(row)) return false;
      appendFileFindMatches(results, diffLineText(row), query, function (column) {
        return { kind: 'diff', path: path, side: side, rowIndex: rowIndex, column: column, row: row };
      });
      return results.length >= FILE_FIND_LIMIT;
    });
  });
  return results;
}

function finishFileFindResults(revision, results, options) {
  if (revision !== fileFindRevision || !isFileFindOpen()) return;
  var previous = options && options.preserveActive && fileFindResults[fileFindActive];
  fileFindResults = results;
  fileFindActive = results.length ? 0 : -1;
  if (previous) {
    var same = results.findIndex(function (result) {
      return result.kind === previous.kind && result.path === previous.path
        && (result.kind === 'source'
          ? result.lineIndex === previous.lineIndex && result.column === previous.column
          : result.side === previous.side && result.rowIndex === previous.rowIndex && result.column === previous.column);
    });
    if (same >= 0) fileFindActive = same;
  }
  updateFileFindChrome();
  if (results.length && options && options.revealFirst) revealFileFindResult(fileFindActive);
  else scheduleFileFindHighlights();
}

function refreshFileFindResults(options) {
  if (!isFileFindOpen()) return;
  var revision = ++fileFindRevision;
  var query = String(fileFindInput?.value || '').toLocaleLowerCase();
  if (!query) { finishFileFindResults(revision, [], options); return; }
  if (isSourceViewerVisible()) {
    finishFileFindResults(revision, collectSourceFindResults(query), options);
    return;
  }
  var wrapper = diffActiveWrapper();
  if (!wrapper) { finishFileFindResults(revision, [], options); return; }
  whenFileReady(wrapper, function () {
    finishFileFindResults(revision, collectDiffFindResults(wrapper, query), options);
  });
}

function cancelScheduledFileFindRefresh() {
  if (!fileFindRefreshTimer) return;
  clearTimeout(fileFindRefreshTimer);
  fileFindRefreshTimer = 0;
}

function scheduleFileFindRefresh(options) {
  cancelScheduledFileFindRefresh();
  var revision = ++fileFindRevision;
  clearFileFindHighlights();
  fileFindResults = [];
  fileFindActive = -1;
  if (!fileFindInput?.value) {
    refreshFileFindResults(options);
    return;
  }
  if (fileFindCount) {
    fileFindCount.classList.remove('is-empty');
    fileFindCount.textContent = '…';
  }
  if (fileFindPrev) fileFindPrev.disabled = true;
  if (fileFindNext) fileFindNext.disabled = true;
  fileFindRefreshTimer = setTimeout(function () {
    fileFindRefreshTimer = 0;
    if (revision !== fileFindRevision || !isFileFindOpen()) return;
    refreshFileFindResults(options);
  }, FILE_FIND_DEBOUNCE_MS);
}

function expandSourceFindResult(result) {
  var file = sourceByPath.get(result.path);
  if (!file || !file.embedded) return false;
  var changed = false;
  sourceFoldRanges(file).forEach(function (fold) {
    if (result.lineIndex < fold.start || result.lineIndex > fold.end || result.lineIndex === fold.start) return;
    if (fold.kind === 'imports') sourceImportOpenPaths[result.path] = true;
    else {
      var stored = sourceManualFoldKeys[result.path] || Object.create(null);
      delete stored[fold.start + ':' + fold.end];
      sourceManualFoldKeys[result.path] = stored;
    }
    changed = true;
  });
  if (changed) openSourceFile(result.path, false);
  return changed;
}

function revealFileFindResult(index) {
  if (!fileFindResults.length) return;
  fileFindActive = ((index % fileFindResults.length) + fileFindResults.length) % fileFindResults.length;
  var result = fileFindResults[fileFindActive];
  if (result.kind === 'diff') {
    setDiffCursor(result.path, result.side, result.rowIndex, result.column, true);
  } else {
    expandSourceFindResult(result);
    setSourceCursor(result.path, result.lineIndex, result.column, true, result.lineIndex);
  }
  updateFileFindChrome();
  scheduleFileFindHighlights();
}

function stepFileFind(direction) {
  if (!fileFindResults.length) return;
  revealFileFindResult(fileFindActive + (direction < 0 ? -1 : 1));
}

function openFileFind() {
  if (!fileFindPanel || !fileFindInput || !fileFindSurface() || !fileFindSurfacePath()) return false;
  if (!isFileFindOpen()) fileFindRestoreFocus = document.activeElement;
  fileFindPanel.classList.remove('hidden');
  positionFileFind();
  if (fileFindInput.value) scheduleFileFindRefresh({ preserveActive: true });
  else refreshFileFindResults({ preserveActive: true });
  fileFindInput.focus({ preventScroll: true });
  fileFindInput.select();
  return true;
}

function closeFileFind(restoreFocus) {
  if (!fileFindPanel) return;
  fileFindRevision += 1;
  cancelScheduledFileFindRefresh();
  if (fileFindHighlightFrame) cancelAnimationFrame(fileFindHighlightFrame);
  fileFindHighlightFrame = 0;
  fileFindPanel.classList.add('hidden');
  clearFileFindHighlights();
  fileFindResults = [];
  fileFindActive = -1;
  if (restoreFocus !== false && fileFindRestoreFocus && fileFindRestoreFocus.isConnected
      && typeof fileFindRestoreFocus.focus === 'function') {
    fileFindRestoreFocus.focus({ preventScroll: true });
  }
  fileFindRestoreFocus = null;
}

function refreshFileFindForActiveView() {
  if (!isFileFindOpen()) return;
  positionFileFind();
  scheduleFileFindRefresh({ preserveActive: true });
}

function fileFindBlockedByOverlay() {
  var settings = document.getElementById('settings-modal');
  var history = document.getElementById('history-view');
  return Boolean((settings && !settings.classList.contains('hidden'))
    || (history && !history.classList.contains('hidden')) || isDockFocused());
}

function handleFileFindKey(event) {
  var findChord = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
    && (event.code === 'KeyF' || event.key === 'f' || event.key === 'F');
  if (findChord) {
    var active = document.activeElement;
    var editable = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
    if ((editable && active !== fileFindInput) || fileFindBlockedByOverlay()) return false;
    if (openFileFind()) { event.preventDefault(); event.stopPropagation(); return true; }
    return false;
  }
  if (!isFileFindOpen()) return false;
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); closeFileFind(true); return true;
  }
  if (event.key === 'Enter') {
    event.preventDefault(); event.stopPropagation(); stepFileFind(event.shiftKey ? -1 : 1); return true;
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.code === 'KeyG' || event.key === 'g' || event.key === 'G')) {
    event.preventDefault(); event.stopPropagation(); stepFileFind(event.shiftKey ? -1 : 1); return true;
  }
  return false;
}

fileFindInput?.addEventListener('input', function () {
  scheduleFileFindRefresh({ revealFirst: true });
});
fileFindPrev?.addEventListener('click', function () { stepFileFind(-1); fileFindInput?.focus({ preventScroll: true }); });
fileFindNext?.addEventListener('click', function () { stepFileFind(1); fileFindInput?.focus({ preventScroll: true }); });
fileFindClose?.addEventListener('click', function () { closeFileFind(true); });
window.addEventListener('resize', positionFileFind);

if (typeof window !== 'undefined') window.__kakapoFileFind = {
  open: openFileFind,
  close: closeFileFind,
  refresh: refreshFileFindForActiveView,
  results: function () { return fileFindResults.slice(); },
  active: function () { return fileFindActive; },
};
