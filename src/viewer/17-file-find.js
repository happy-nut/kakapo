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
// The file the open bar belongs to. A search is ABOUT one file: carrying "value" onto the next file and
// silently re-running it there hands the reviewer a match count for something they did not ask about, and a
// bar whose contents no longer describe what is on screen.
var fileFindPath = '';
var fileFindRefreshTimer = 0;
var fileFindHighlightFrame = 0;
var fileFindHighlightedRows = [];
var FILE_FIND_LIMIT = 5000;
var FILE_FIND_DEBOUNCE_MS = 90;
var FILE_FIND_HIGHLIGHT_LIMIT = 200;
var FILE_FIND_SHORT_QUERY_HIGHLIGHT_LIMIT = 48;
// The field, the count, four toggles and three buttons on one line — IntelliJ's toolbar is one line too.
var FILE_FIND_WIDTH = 468;

// ---- IntelliJ's find-toolbar toggles ------------------------------------------------------------
// Cc / W / .* and Search In Selection: the four the editor's own find bar carries, as
// platform/lang-impl/.../find/editorHeaderActions/Toggle{MatchCase,WholeWordsOnly,Regex,FindInSelection}.
// IntelliJ keeps the editor search's case/words settings SEPARATE from the ones Find in Files uses
// (FindSettings.LOCAL_CASE_SENSITIVE_SEARCH / LOCAL_WHOLE_WORDS_ONLY, both off by default), and so does
// this — "is this word in this file" and "is this string in the project" are not asked with the same
// precision. Session-scoped, like Find in Files' own three in 03-quick-open.js.
var fileFindMatchCase = false;
var fileFindWholeWords = false;
var fileFindRegex = false;
var fileFindInSelection = false;
// The lines In Selection was switched on over. Captured once, not read live: the selection is dropped the
// moment the reviewer clicks into the find field, and a scope that evaporates on its way to being used is
// not a scope.
var fileFindSelectionLines = null;
var fileFindPatternError = '';
// IntelliJ's Search History (FindBundle's find.search.history), which its toolbar opens as a dropdown from
// the field. One line of bar has no room for a dropdown, so ⌥↓/⌥↑ — the keys IntelliJ puts the history on —
// step through it in place. They answer only while the FIELD holds the keyboard, which is how the code
// surface keeps its own ⌥↓ (next symbol) while the bar is merely open.
var fileFindHistory = [];
var fileFindHistoryIndex = -1;
var FILE_FIND_HISTORY_MAX = 20;
var fileFindMatchCaseButton = document.getElementById('file-find-match-case');
var fileFindWholeWordsButton = document.getElementById('file-find-whole-words');
var fileFindRegexButton = document.getElementById('file-find-regex');
var fileFindInSelectionButton = document.getElementById('file-find-in-selection');

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
  flushSourceRows(); // a match can be anywhere in the file, not only in the painted window
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
  var allRanges = [], activeRanges = [];
  var rowSet = new Set();
  var limit = fileFindInput.value.length < 2 ? FILE_FIND_SHORT_QUERY_HIGHLIGHT_LIMIT : FILE_FIND_HIGHLIGHT_LIMIT;
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
    var shown = container.textContent || '';
    var start = result.column;
    // The painted cell is not always the string the match was found in — a rendered markdown or CSV row, a
    // diff cell carrying its own prefix column. Look for the matched text where the offset does not hold it.
    // With a pattern this cannot be the query itself, which is why each result remembers what it matched.
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

// Typing is the one thing this bar must never interrupt, and publishing results is not a small act: it
// reveals a file, expands a fold, repaints a window of a large file and scrolls. Any of that may take DOM
// focus, and the code surfaces bind no plain letters — so a field that quietly lost the keyboard looks
// exactly like a field that stopped accepting input, with every following keystroke going nowhere.
// One invariant at the single place every refresh passes through, rather than a guard per caller: if the
// field held the keyboard before the work and the bar is still open, it holds it after.
function keepFileFindFocus(owned) {
  if (!owned || !fileFindInput || !isFileFindOpen()) return;
  if (document.activeElement === fileFindInput) return;
  try { fileFindInput.focus({ preventScroll: true }); } catch (e) { try { fileFindInput.focus(); } catch (ignore) {} }
}

// Where the keyboard goes when the bar closes because the reviewer left the file it was about. Navigation
// already decided which surface they are on; this hands it the keys so they answer.
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
    // The compiler's own words, where they can be read without taking a line of the bar.
    fileFindCount.title = fileFindPatternError;
  }
  if (fileFindPrev) fileFindPrev.disabled = total === 0;
  if (fileFindNext) fileFindNext.disabled = total === 0;
}

function escapeFileFindLiteral(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What the field is asking for, compiled once per query rather than once per line.
 *
 * `{ empty }` when there is nothing to search for, `{ error }` when the pattern will not compile — which
 * IntelliJ reports as "Bad pattern" (find.incorrect.regexp) rather than as no matches, because a typo in a
 * pattern answering "nothing matched" is the wrong answer and the one a reviewer would believe.
 *
 * Literal and case-insensitive stays on indexOf over a folded line: that is the shape a one-character
 * query takes over a 9000-row diff (measured at 10ms, and it runs on every keystroke). The toggles are
 * what bring a RegExp in, each of them exactly one thing IntelliJ's own toggle does.
 */
function fileFindQuery() {
  var raw = String(fileFindInput && fileFindInput.value || '');
  if (!raw) return { empty: true };
  var flags = fileFindMatchCase ? 'g' : 'gi';
  if (fileFindRegex) {
    // IntelliJ wraps the pattern for Words rather than the text, so `\bfoo|bar\b` means the whole thing.
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
];

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
  // -1 is the query the reviewer was typing before they started walking back; past the oldest, stay put.
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
        : fileFindInSelectionButton;
}

function syncFileFindOptions() {
  FILE_FIND_OPTIONS.forEach(function (option) {
    var button = fileFindOptionButton(option.id);
    if (!button) return;
    button.setAttribute('aria-pressed', option.get() ? 'true' : 'false');
    button.classList.toggle('active', option.get());
  });
  // Nothing is selected: the toggle is still there and still says what it would do, the way IntelliJ
  // disables it outside a search session rather than hiding it.
  if (fileFindInSelectionButton) fileFindInSelectionButton.disabled = !fileFindInSelection && !fileFindHasSelection();
}

function toggleFileFindOption(id) {
  var option = FILE_FIND_OPTIONS.find(function (entry) { return entry.id === id; });
  if (!option) return false;
  if (id === 'inSelection') {
    if (!fileFindInSelection) {
      var lines = fileFindHasSelection() ? fileFindSelectedLines() : null;
      if (!lines) return true; // nothing to narrow to; the press is consumed, the scope is unchanged
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
      // A pattern that can match nothing (`a*`, `^`) would otherwise sit on one offset forever. IntelliJ
      // declines those outright ("Regular expression matches empty string"); stepping past is gentler and
      // keeps a half-typed `(` from freezing the field.
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

/**
 * The lines Search In Selection covers, from whichever view owns the selection.
 *
 * Line granularity, where IntelliJ restricts to the exact selected offsets. Both views here select by
 * row — the source view is a table of rows and the diff carries its own row/column cursor — so the first
 * and last line are covered whole. Stated in the READMEs rather than left to be discovered.
 */
/**
 * Is there a selection at all — the cheap question, asked before the expensive one.
 *
 * fileFindSelectedLines goes through selectedSourceRows, which calls flushSourceRows: it finishes painting
 * the WHOLE file so a selection reaching past the painted window can be read. That is the right thing for
 * a selection a reviewer actually made, and the wrong thing to do on every ⌘F and every toggle — measured
 * at 782ms on a 30k-line file, which is a freeze on the one key that must never stutter.
 */
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
  var path = document.getElementById('source-viewer')?.dataset.openPath || '';
  var file = sourceByPath.get(path);
  var results = [];
  if (!file || !file.embedded || file.image) return results;
  String(file.content || '').split(/\r?\n/).some(function (line, lineIndex) {
    if (!withinFileFindSelection(lineIndex, '')) return false;
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
      if (!isDiffCodeRow(row) || !withinFileFindSelection(rowIndex, side)) return false;
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

// Same question the caret asks on every move, same answer — see expandSourceFoldsAt in 10-source-view.js.
// This one repaints as well, because a find result is revealed without going through setSourceCursor.
function expandSourceFindResult(result) {
  var changed = expandSourceFoldsAt(result.path, result.lineIndex);
  if (changed) openSourceFile(result.path, false);
  return changed;
}

function fileFindIndexAt(index) {
  return ((index % fileFindResults.length) + fileFindResults.length) % fileFindResults.length;
}

// IntelliJ's "Scroll to results during typing" (FindSettings.SCROLL_TO_RESULTS_DURING_TYPING, on by
// default): while the query is still being typed the VIEW follows the first match. It does not place the
// editor caret there — EditorSearchSession passes that setting as `allowedToChangedEditorSelection`, and
// restores the caret it started from when the field is cleared.
//
// kakapo called setDiffCursor/setSourceCursor on every keystroke instead, which is not a scroll: it moved
// the caret, dropped any selection, re-asserted the active hunk, cleared the caret hint, and pushed one
// entry per CHARACTER into the ⌘[/⌘] history — so a six-letter query cost six positions, and going back
// walked the word backwards. The caret is where the reviewer is; a query they are still typing is not a
// position yet. It moves on Enter / ⌘G / the arrow buttons, and once more when the bar closes.
function previewFileFindResult(index) {
  if (!fileFindResults.length) return;
  fileFindActive = fileFindIndexAt(index);
  var result = fileFindResults[fileFindActive];
  if (result.kind === 'diff') {
    var wrapper = diffWrapperByPath(result.path);
    // Same reason setDiffCursor does it: a match in a file that is not the visible one has nothing on
    // screen to scroll to, and revealing also materializes a lazy body so its rows exist to be found.
    if (wrapper && wrapper.classList && wrapper.classList.contains('df-inactive')) revealDiffFile(result.path);
    var row = wrapper && diffRowAt(wrapper, result.side, result.rowIndex);
    if (row) scrolloffReveal(row, document.getElementById('diff2html-container'), 0.15);
  } else {
    expandSourceFindResult(result); // a match inside a folded region is not shown until the fold opens
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
  // IntelliJ's moveCursor calls addTextToRecent before it moves: stepping to a match is the moment a query
  // stops being something half-typed and becomes one the reviewer used.
  rememberFileFindQuery(fileFindInput && fileFindInput.value);
  revealFileFindResult(fileFindActive + (direction < 0 ? -1 : 1));
}

function openFileFind() {
  if (!fileFindPanel || !fileFindInput || !fileFindSurface() || !fileFindSurfacePath()) return false;
  if (!isFileFindOpen()) fileFindRestoreFocus = document.activeElement;
  fileFindPath = fileFindSurfacePath();
  fileFindPanel.classList.remove('hidden');
  // Unchanged imports are folded away, so their text is not in the DOM and cannot be matched. Restore them
  // now, while opening, rather than part-way through the query: this used to run at exactly two characters,
  // which meant the diff rebuilt its rows, invalidated its geometry and re-ran its scroll BETWEEN a
  // reviewer's first and second keystroke — a stall landing on the one action that must never stutter, and
  // on a boundary nobody could predict. The work is the same; it just belongs to the deliberate ⌘F now.
  if (isDiffViewVisible()) {
    var openWrapper = diffActiveWrapper();
    var importFold = openWrapper && openWrapper.querySelector('.mc-import-fold-row');
    if (importFold) openDiffImportFold(importFold);
  }
  // IntelliJ turns Search In Selection on by itself when ⌘F opens over a selection that spans more than
  // one line: a reviewer who selected a block and reached for find meant that block. A selection inside one
  // line is a word they want to search FOR, not a range to search in — which is why only multi-line counts.
  var selected = fileFindHasSelection() ? fileFindSelectedLines() : null;
  if (selected && selected.to > selected.from) {
    fileFindInSelection = true;
    fileFindSelectionLines = selected;
  }
  syncFileFindOptions();
  positionFileFind();
  // The keyboard moves first, THEN the search runs. The other order looks equivalent and is not: the first
  // refresh schedules the highlight pass, and that pass asks "did the field own the keyboard" to decide
  // whether to keep it — asked before the focus call, the answer was no, so the one paint that lands while
  // the reviewer is typing their first characters was the one paint allowed to leave focus elsewhere.
  fileFindInput.focus({ preventScroll: true });
  fileFindInput.select();
  if (fileFindInput.value) scheduleFileFindRefresh({ preserveActive: true });
  else refreshFileFindResults({ preserveActive: true });
  return true;
}

function closeFileFind(restoreFocus) {
  if (!fileFindPanel) return;
  // Esc ends the search AT the match, the way IntelliJ does: typing only scrolled the view, so without this
  // a reviewer who typed, found the line and pressed Esc would be returned to where they started with
  // nothing to show for it. A close caused by LEAVING the file (restoreFocus === false) places nothing —
  // the match belongs to a file that is no longer on screen.
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
  // The toggles survive the bar (they are the reviewer's preference), the SCOPE does not: it described a
  // selection in a file this search is done with.
  fileFindInSelection = false;
  fileFindSelectionLines = null;
  fileFindPatternError = '';
  syncFileFindOptions();
}

function refreshFileFindForActiveView() {
  if (!isFileFindOpen()) return;
  // Moved to another file: the search ends with the file it was about. Closing without restoring focus is
  // deliberate — navigation already decided where the reviewer is, and pulling focus back to whatever held it
  // when ⌘F opened would undo that.
  //
  // But "not pulling focus back" was implemented as leaving it NOWHERE: the field was hidden while it still
  // held the keyboard, so focus fell to <body>, which binds no plain letters. Everything typed next went
  // nowhere — the field had not stopped accepting input, it had stopped existing while still holding the
  // keys. Hand them to the surface navigation chose.
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
  // Cc / W / .* / In Selection, asked through the shortcut table rather than spelled here, so the Settings
  // sheet and these branches cannot drift apart. The first three share their row with Find in Files: same
  // chord, same meaning, a different surface — which is what `where: "find"` is for.
  for (var oi = 0; oi < FILE_FIND_OPTIONS.length; oi += 1) {
    if (!isShortcut(event, FILE_FIND_OPTIONS[oi].shortcut)) continue;
    event.preventDefault();
    event.stopPropagation();
    return toggleFileFindOption(FILE_FIND_OPTIONS[oi].id);
  }
  // ⌥↓ walks back through recent searches, ⌥↑ forward to the one being typed. Only while the field holds
  // the keyboard — with the bar merely open, ⌥↓ is still the code surface's next symbol.
  if (fileFindOwnsKeyboard() && isShortcut(event, 'findHistory')) {
    event.preventDefault();
    event.stopPropagation();
    return stepFileFindHistory(shortcutMatchIndex ? -1 : 1);
  }
  // ⌘G / ⌘⇧G are one row of the table with two combinations; shortcutMatchIndex says which one fired.
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
