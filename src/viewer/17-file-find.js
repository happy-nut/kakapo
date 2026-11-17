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
var fileFindPath = '';
var fileFindRefreshTimer = 0;
var fileFindHighlightFrame = 0;
var fileFindHighlightedRows = [];
var FILE_FIND_LIMIT = 5000;
var FILE_FIND_DEBOUNCE_MS = 90;
var FILE_FIND_HIGHLIGHT_LIMIT = 200;
var FILE_FIND_SHORT_QUERY_HIGHLIGHT_LIMIT = 48;
var FILE_FIND_WIDTH = 468;

var fileFindMatchCase = false;
var fileFindWholeWords = false;
var fileFindRegex = false;
var fileFindInSelection = false;
var fileFindChangesOnly = false;
var fileFindSelectionLines = null;
var fileFindPatternError = '';
var fileFindHistory = [];
var fileFindHistoryIndex = -1;
var FILE_FIND_HISTORY_MAX = 20;
var fileFindMatchCaseButton = document.getElementById('file-find-match-case');
var fileFindWholeWordsButton = document.getElementById('file-find-whole-words');
var fileFindRegexButton = document.getElementById('file-find-regex');
var fileFindInSelectionButton = document.getElementById('file-find-in-selection');
var fileFindChangesOnlyButton = document.getElementById('file-find-changes-only');

function isFileFindOpen() {
  return Boolean(fileFindPanel && !fileFindPanel.classList.contains('hidden'));
}

function fileFindSurface() {
  if (isDiffViewVisible()) return 'diff';
  if (isSourceViewerVisible()) return 'source';
  return '';
}

function fileFindSurfacePath() {
  if (isSourceViewerVisible()) return sourceOpenPath();
  var wrapper = diffActiveWrapper();
  return wrapper ? diffWrapperPathKey(wrapper) : '';
}

function positionFileFind() {
  if (!fileFindPanel || !isFileFindOpen()) return;
  var surface = isDiffViewVisible() ? document.getElementById('diff2html-container') : document.getElementById('source-body');
  var rect = surface && surface.getBoundingClientRect ? surface.getBoundingClientRect() : null;
  var width = Math.min(FILE_FIND_WIDTH, Math.max(240, window.innerWidth - 24));
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

function fileFindDomPoint(container, offset, preferAfter) {
  if (!container) return null;
  var remaining = Math.max(0, Number(offset) || 0);
  var walker = sourceTextWalker(container);
  var node;
  var boundary = null;
  while ((node = walker.nextNode())) {
    var length = (node.textContent || '').length;
    if (remaining < length) return { node: node, offset: remaining };
    if (remaining === length) {
      // On the seam between two nodes. Both ends of the seam are the same column, and which one to take
      // depends on which end of a RANGE is being placed: a label drawn at this column sits between them,
      // so a start taken before it paints over the label and an end taken after it does the same. The
      // text selection does not have this problem — `user-select: none` keeps a label out of it — but a
      // CSS custom highlight ignores that and paints whatever its range covers, which is how ⌘F7 came to
      // mark `x: startLine` instead of `startLine`.
      boundary = { node: node, offset: remaining };
      if (!preferAfter) return boundary;
      remaining = 0;
      continue;
    }
    remaining -= length;
  }
  return boundary;
}

function fileFindRange(container, start, length) {
  var from = fileFindDomPoint(container, start, true);
  var to = fileFindDomPoint(container, start + length, false);
  if (!from || !to) return null;
  try {
    var range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  } catch (e) { return null; }
}

function paintedSourceRow(lineIndex) {
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

function sourceFindRow(lineIndex) {
  flushSourceRows();
  return paintedSourceRow(lineIndex);
}

function fileFindResultContainer(result) {
  if (result.kind === 'diff') return result.row && diffCellCtn(result.row);
  var row = paintedSourceRow(result.lineIndex);
  return row && (row.querySelector('.source-code') || row);
}

function applyFileFindHighlights() {
  clearFileFindHighlights();
  if (!fileFindResults.length || !fileFindInput?.value) return;
  var allRanges = [], activeRanges = [];
  var rowSet = new Set();
  var limit = fileFindInput.value.length < 2 ? FILE_FIND_SHORT_QUERY_HIGHLIGHT_LIMIT : FILE_FIND_HIGHLIGHT_LIMIT;
  var indexes = [];
  for (var i = 0; i < Math.min(fileFindResults.length, limit); i++) indexes.push(i);
  if (fileFindActive >= limit) indexes.push(fileFindActive);
  indexes.forEach(function (index) {
    var result = fileFindResults[index];
    var container = fileFindResultContainer(result);
    var row = result.kind === 'diff' ? result.row : paintedSourceRow(result.lineIndex);
    if (row && !rowSet.has(row)) {
      rowSet.add(row);
      fileFindHighlightedRows.push(row);
      row.classList.add('file-find-row-match');
    }
    if (index === fileFindActive && row) row.classList.add('file-find-row-active');
    if (!container) return;
    var shown = sourceCellText(container);
    var start = result.column;
    if (shown.substr(start, result.length) !== result.text) {
      start = shown.indexOf(result.text);
      if (start < 0) return;
    }
    var range = fileFindRange(container, start, result.length);
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
  var owned = fileFindOwnsKeyboard();
  fileFindHighlightFrame = requestAnimationFrame(function () {
    fileFindHighlightFrame = 0;
    applyFileFindHighlights();
    keepFileFindFocus(owned);
  });
}

function fileFindOwnsKeyboard() {
  return Boolean(fileFindInput && document.activeElement === fileFindInput);
}

function keepFileFindFocus(owned) {
  if (!owned || !fileFindInput || !isFileFindOpen()) return;
  if (document.activeElement === fileFindInput) return;
  try { fileFindInput.focus({ preventScroll: true }); } catch (e) { try { fileFindInput.focus(); } catch (ignore) {} }
}

function focusFileFindSurface() {
  var content = isSourceViewerVisible()
    ? document.getElementById('source-body')
    : document.getElementById('diff2html-container');
  if (!content) return;
  content.tabIndex = -1;
  try { content.focus({ preventScroll: true }); } catch (e) { try { content.focus(); } catch (ignore) {} }
}

function updateFileFindChrome() {
  var total = fileFindResults.length;
  var typed = Boolean(fileFindInput?.value);
  if (fileFindCount) {
    fileFindCount.classList.toggle('is-empty', Boolean(fileFindPatternError) || (typed && total === 0));
    fileFindCount.textContent = fileFindPatternError ? t('find.badPattern')
      : !typed ? '0/0'
        : total ? (fileFindActive + 1) + '/' + total : t('find.noResults');
    fileFindCount.title = fileFindPatternError;
  }
  if (fileFindPrev) fileFindPrev.disabled = total === 0;
  if (fileFindNext) fileFindNext.disabled = total === 0;
}

function escapeFileFindLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fileFindQuery() {
  var raw = String(fileFindInput && fileFindInput.value || '');
  if (!raw) return { empty: true };
  var flags = fileFindMatchCase ? 'g' : 'gi';
  if (fileFindRegex) {
    var source = fileFindWholeWords ? '\\b(?:' + raw + ')\\b' : raw;
    try { return { regex: new RegExp(source, flags) }; } catch (error) { return { error: String(error && error.message || error) }; }
  }
  if (fileFindWholeWords) return { regex: new RegExp('\\b' + escapeFileFindLiteral(raw) + '\\b', flags) };
  if (fileFindMatchCase) return { literal: raw, fold: false };
  return { literal: raw.toLocaleLowerCase(), fold: true };
}

var FILE_FIND_OPTIONS = [
  { id: 'matchCase', shortcut: 'searchMatchCase', get: function () { return fileFindMatchCase; }, set: function (on) { fileFindMatchCase = on; } },
  { id: 'wholeWords', shortcut: 'searchWholeWords', get: function () { return fileFindWholeWords; }, set: function (on) { fileFindWholeWords = on; } },
  { id: 'regex', shortcut: 'searchRegex', get: function () { return fileFindRegex; }, set: function (on) { fileFindRegex = on; } },
  { id: 'inSelection', shortcut: 'findInSelection', get: function () { return fileFindInSelection; }, set: function (on) { fileFindInSelection = on; } },
  { id: 'changesOnly', shortcut: 'searchChangesOnly', get: function () { return fileFindChangesOnly; }, set: function (on) { fileFindChangesOnly = on; } },
];

function withinFileFindChanges(lineIndex, row) {
  if (!fileFindChangesOnly) return true;
  if (row) return isChangeCodeRow(row);
  var file = sourceByPath.get(sourceOpenPath());
  if (!file || !Array.isArray(file.changedLines)) return false;
  return file.changedLines.indexOf(lineIndex + 1) >= 0;
}

function rememberFileFindQuery(text) {
  var query = String(text || '').trim();
  if (!query) return;
  fileFindHistory = [query]
    .concat(fileFindHistory.filter(function (entry) { return entry !== query; }))
    .slice(0, FILE_FIND_HISTORY_MAX);
  fileFindHistoryIndex = -1;
}

function stepFileFindHistory(direction) {
  if (!fileFindInput || !fileFindHistory.length) return false;
  var next = fileFindHistoryIndex + (direction < 0 ? -1 : 1);
  if (next < -1 || next >= fileFindHistory.length) return true;
  fileFindHistoryIndex = next;
  fileFindInput.value = next < 0 ? '' : fileFindHistory[next];
  fileFindInput.select();
  scheduleFileFindRefresh({ revealFirst: true });
  return true;
}

function fileFindOptionButton(id) {
  return id === 'matchCase' ? fileFindMatchCaseButton
    : id === 'wholeWords' ? fileFindWholeWordsButton
      : id === 'regex' ? fileFindRegexButton
        : id === 'inSelection' ? fileFindInSelectionButton
          : id === 'changesOnly' ? fileFindChangesOnlyButton
            : null;
}

function syncFileFindOptions() {
  FILE_FIND_OPTIONS.forEach(function (option) {
    var button = fileFindOptionButton(option.id);
    if (!button) return;
    button.setAttribute('aria-pressed', option.get() ? 'true' : 'false');
    button.classList.toggle('active', option.get());
  });
  if (fileFindInSelectionButton) fileFindInSelectionButton.disabled = !fileFindInSelection && !fileFindHasSelection();
}

function toggleFileFindOption(id) {
  var option = FILE_FIND_OPTIONS.find(function (entry) { return entry.id === id; });
  if (!option) return false;
  if (id === 'inSelection') {
    if (!fileFindInSelection) {
      var lines = fileFindHasSelection() ? fileFindSelectedLines() : null;
      if (!lines) { showCaretHint(t('find.inSelection.none')); return true; }
      fileFindSelectionLines = lines;
    } else {
      fileFindSelectionLines = null;
    }
  }
  option.set(!option.get());
  syncFileFindOptions();
  scheduleFileFindRefresh({ revealFirst: true });
  return true;
}

function appendFileFindMatches(results, text, query, makeResult) {
  var line = String(text || '');
  if (query.regex) {
    query.regex.lastIndex = 0;
    var match;
    while (results.length < FILE_FIND_LIMIT && (match = query.regex.exec(line))) {
      if (!match[0].length) { query.regex.lastIndex = match.index + 1; continue; }
      results.push(makeResult(match.index, match[0].length, match[0]));
      if (query.regex.lastIndex <= match.index) query.regex.lastIndex = match.index + 1;
    }
    return;
  }
  var haystack = query.fold ? line.toLocaleLowerCase() : line;
  var from = 0;
  while (results.length < FILE_FIND_LIMIT) {
    var column = haystack.indexOf(query.literal, from);
    if (column < 0) break;
    results.push(makeResult(column, query.literal.length, line.substr(column, query.literal.length)));
    from = column + Math.max(1, query.literal.length);
  }
}

function fileFindHasSelection() {
  if (!isSourceViewerVisible()) return Boolean(diffSelectionAnchor && diffCursor);
  var selection = window.getSelection && window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount);
}

function fileFindSelectedLines() {
  if (isSourceViewerVisible()) {
    var selection = window.getSelection && window.getSelection();
    var body = document.getElementById('source-body');
    if (!selection || selection.isCollapsed || !body || !selection.anchorNode || !selection.focusNode) return null;
    if (!body.contains(selection.anchorNode) || !body.contains(selection.focusNode)) return null;
    var lines = selectedSourceRows(selection)
      .map(function (row) { return Number(row.dataset.lineIndex) || 0; })
      .sort(function (a, b) { return a - b; });
    if (!lines.length) return null;
    return { from: lines[0], to: lines[lines.length - 1] };
  }
  if (!diffSelectionAnchor || !diffCursor || diffSelectionAnchor.side !== diffCursor.side) return null;
  return {
    from: Math.min(diffSelectionAnchor.rowIndex, diffCursor.rowIndex),
    to: Math.max(diffSelectionAnchor.rowIndex, diffCursor.rowIndex),
    side: diffCursor.side,
  };
}

function withinFileFindSelection(line, side) {
  if (!fileFindInSelection || !fileFindSelectionLines) return true;
  if (fileFindSelectionLines.side && side && fileFindSelectionLines.side !== side) return false;
  return line >= fileFindSelectionLines.from && line <= fileFindSelectionLines.to;
}

function collectSourceFindResults(query) {
  var path = sourceOpenPath();
  var file = sourceByPath.get(path);
  var results = [];
  if (!file || !file.embedded || file.image) return results;
  String(file.content || '').split(/\r?\n/).some(function (line, lineIndex) {
    if (!withinFileFindSelection(lineIndex, '') || !withinFileFindChanges(lineIndex, null)) return false;
    appendFileFindMatches(results, line, query, function (column, length, text) {
      return { kind: 'source', path: path, lineIndex: lineIndex, column: column, length: length, text: text };
    });
    return results.length >= FILE_FIND_LIMIT;
  });
  return results;
}

function collectDiffFindResults(wrapper, query) {
  var results = [];
  var path = wrapper ? diffWrapperPathKey(wrapper) : '';
  ['old', 'new'].some(function (side) {
    var rows = diffRowsOf(diffSideTable(wrapper, side));
    return rows.some(function (row, rowIndex) {
      if (!isDiffCodeRow(row) || !withinFileFindSelection(rowIndex, side) || !withinFileFindChanges(rowIndex, row)) return false;
      appendFileFindMatches(results, diffLineText(row), query, function (column, length, text) {
        return { kind: 'diff', path: path, side: side, rowIndex: rowIndex, column: column, length: length, text: text, row: row };
      });
      return results.length >= FILE_FIND_LIMIT;
    });
  });
  return results;
}

function finishFileFindResults(revision, results, options) {
  if (revision !== fileFindRevision || !isFileFindOpen()) return;
  var owned = fileFindOwnsKeyboard();
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
  if (results.length && options && options.revealFirst) previewFileFindResult(fileFindActive);
  else scheduleFileFindHighlights();
  keepFileFindFocus(owned);
}

function refreshFileFindResults(options) {
  if (!isFileFindOpen()) return;
  var revision = ++fileFindRevision;
  var query = fileFindQuery();
  fileFindPatternError = query.error || '';
  if (query.empty || query.error) { finishFileFindResults(revision, [], options); return; }
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
  var changed = expandSourceFoldsAt(result.path, result.lineIndex);
  if (changed) openSourceFile(result.path, false);
  return changed;
}

function fileFindIndexAt(index) {
  return ((index % fileFindResults.length) + fileFindResults.length) % fileFindResults.length;
}

function previewFileFindResult(index) {
  if (!fileFindResults.length) return;
  fileFindActive = fileFindIndexAt(index);
  var result = fileFindResults[fileFindActive];
  if (result.kind === 'diff') {
    var wrapper = diffWrapperByPath(result.path);
    if (wrapper && wrapper.classList && wrapper.classList.contains('df-inactive')) revealDiffFile(result.path);
    if (wrapper && wrapper.classList && wrapper.classList.contains('file-collapsed')) {
      delete diffCollapsedFileSet()[result.path];
      paintDiffFileCollapse();
    }
    var row = wrapper && diffRowAt(wrapper, result.side, result.rowIndex);
    if (row) scrolloffReveal(row, document.getElementById('diff2html-container'), 0.15);
  } else {
    expandSourceFindResult(result);
    var sourceRow = sourceFindRow(result.lineIndex);
    if (sourceRow) scrolloffReveal(sourceRow, document.getElementById('source-body'), 0.15);
  }
  updateFileFindChrome();
  scheduleFileFindHighlights();
}

function revealFileFindResult(index) {
  if (!fileFindResults.length) return;
  fileFindActive = fileFindIndexAt(index);
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
  rememberFileFindQuery(fileFindInput && fileFindInput.value);
  revealFileFindResult(fileFindActive + (direction < 0 ? -1 : 1));
}

function openFileFind() {
  if (!fileFindPanel || !fileFindInput || !fileFindSurface() || !fileFindSurfacePath()) return false;
  if (!isFileFindOpen()) fileFindRestoreFocus = document.activeElement;
  fileFindPath = fileFindSurfacePath();
  fileFindPanel.classList.remove('hidden');
  if (isDiffViewVisible()) {
    var openWrapper = diffActiveWrapper();
    var importFold = openWrapper && openWrapper.querySelector('.mc-import-fold-row');
    if (importFold) openDiffImportFold(importFold);
  }
  var selected = fileFindHasSelection() ? fileFindSelectedLines() : null;
  if (selected && selected.to > selected.from) {
    fileFindInSelection = true;
    fileFindSelectionLines = selected;
  }
  syncFileFindOptions();
  positionFileFind();
  fileFindInput.focus({ preventScroll: true });
  fileFindInput.select();
  if (fileFindInput.value) scheduleFileFindRefresh({ preserveActive: true });
  else refreshFileFindResults({ preserveActive: true });
  return true;
}

function closeFileFind(restoreFocus) {
  if (!fileFindPanel) return;
  if (restoreFocus !== false && fileFindActive >= 0 && fileFindResults[fileFindActive]) {
    var landing = fileFindResults[fileFindActive];
    if (landing.kind === 'diff') setDiffCursor(landing.path, landing.side, landing.rowIndex, landing.column, true);
    else setSourceCursor(landing.path, landing.lineIndex, landing.column, true, landing.lineIndex);
  }
  if (fileFindResults.length) rememberFileFindQuery(fileFindInput && fileFindInput.value);
  fileFindHistoryIndex = -1;
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
  fileFindPath = '';
  fileFindInSelection = false;
  fileFindSelectionLines = null;
  fileFindPatternError = '';
  syncFileFindOptions();
}

function refreshFileFindForActiveView() {
  if (!isFileFindOpen()) return;
  if (fileFindSurfacePath() !== fileFindPath) {
    var owned = fileFindOwnsKeyboard();
    closeFileFind(false);
    if (owned) focusFileFindSurface();
    return;
  }
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
  if (isShortcut(event, 'findInFile')) {
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
  for (var oi = 0; oi < FILE_FIND_OPTIONS.length; oi += 1) {
    if (!isShortcut(event, FILE_FIND_OPTIONS[oi].shortcut)) continue;
    event.preventDefault();
    event.stopPropagation();
    return toggleFileFindOption(FILE_FIND_OPTIONS[oi].id);
  }
  if (fileFindOwnsKeyboard() && isShortcut(event, 'findHistory')) {
    event.preventDefault();
    event.stopPropagation();
    return stepFileFindHistory(shortcutMatchIndex ? -1 : 1);
  }
  if (isShortcut(event, 'findNextPrev')) {
    event.preventDefault(); event.stopPropagation(); stepFileFind(shortcutMatchIndex ? -1 : 1); return true;
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

FILE_FIND_OPTIONS.forEach(function (option) {
  var button = fileFindOptionButton(option.id);
  if (!button) return;
  button.addEventListener('click', function () {
    toggleFileFindOption(option.id);
    fileFindInput?.focus({ preventScroll: true });
  });
});
syncFileFindOptions();

if (typeof window !== 'undefined') window.__kakapoFileFind = {
  open: openFileFind,
  close: closeFileFind,
  refresh: refreshFileFindForActiveView,
  results: function () { return fileFindResults.slice(); },
  active: function () { return fileFindActive; },
  toggle: toggleFileFindOption,
  history: function () { return fileFindHistory.slice(); },
  options: function () {
    return {
      matchCase: fileFindMatchCase,
      wholeWords: fileFindWholeWords,
      regex: fileFindRegex,
      inSelection: fileFindInSelection,
      selectionLines: fileFindSelectionLines && { from: fileFindSelectionLines.from, to: fileFindSelectionLines.to },
      patternError: fileFindPatternError,
    };
  },
};
