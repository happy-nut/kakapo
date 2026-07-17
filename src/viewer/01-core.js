// Shared Kakapo artwork. The CSS variable points at a tiny derivative of the real application icon, so
// every brand mark and wait state reuses one cached image instead of carrying a parallel logo/spinner.
function kakapoMarkHtml(extraClass) {
  return '<span class="kakapo-mark' + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true"></span>';
}
function kakapoLoaderHtml(extraClass) {
  return '<span class="kakapo-loader' + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true">'
    + kakapoMarkHtml() + '</span>';
}

// Shared delayed-work state. Keeping one compact visual vocabulary for indexing, file hydration, history,
// and editor startup makes genuine waits legible without animating already-responsive interactions.
function loadingStateHtml(message, extraClass) {
  return '<div class="mc-loading-state' + (extraClass ? ' ' + extraClass : '') + '" role="status" aria-live="polite">'
    + kakapoLoaderHtml('kakapo-loader-inline') + '<span>' + escapeHtml(message) + '</span></div>';
}

const REVIEW_LAZY = document.getElementById('review-meta')?.dataset.lazy === 'true';
// lazy-LOAD (Phase 2): file bodies are NOT embedded; they are fetched on demand (serve: GET /file,
// Electron: window.kakapoFile.get) so the initial HTML stays small. Implies REVIEW_LAZY (shells).
const REVIEW_LAZY_LOAD = document.getElementById('review-meta')?.dataset.lazyLoad === 'true';
var diffImportOpenPaths = Object.create(null);

// Focus belongs to a review panel, not permanently to whichever scroll container happened to receive DOM
// focus last. Give each panel one short arrival flash, then remove it; logical cursors (the file tree and
// read-only code carets) call the same function even though they intentionally do not move native focus.
var REVIEW_FOCUS_PANEL_SELECTOR = [
  '.activity-rail', '.sidebar', '.content', '#diff2html-container', '.source-body',
  '.impact-panel', '.semantic-peek', '.history-list', '.history-detail',
  '.dock-panel', '.settings-panel', '.quick-open-panel', '.mc-modal-panel',
].join(',');
var reviewFocusedPanel = null;
var reviewFocusFlashTimer = 0;
var reviewFocusInputModality = 'programmatic';
function reviewFocusPanelFor(node) {
  if (!node) return null;
  if (node.nodeType !== 1) node = node.parentElement;
  if (!node || !node.closest) return null;
  return node.matches(REVIEW_FOCUS_PANEL_SELECTOR) ? node : node.closest(REVIEW_FOCUS_PANEL_SELECTOR);
}
function flashReviewPanelFocus(node) {
  var panel = reviewFocusPanelFor(node);
  if (!panel || panel.classList.contains('hidden')) return;
  panel.setAttribute('data-mc-focus-panel', 'true');
  // Pointer placement already makes its destination obvious. Reserve the arrival flash for keyboard and
  // programmatic navigation, where the user's eyes otherwise have no direct spatial cue.
  if (reviewFocusInputModality === 'pointer') return;
  if (reviewFocusedPanel === panel && panel.isConnected) return;
  if (reviewFocusedPanel) reviewFocusedPanel.classList.remove('mc-panel-focus-flash');
  if (reviewFocusFlashTimer) clearTimeout(reviewFocusFlashTimer);
  reviewFocusedPanel = panel;
  // Restart the CSS animation when returning to a panel that was focused earlier.
  panel.classList.remove('mc-panel-focus-flash');
  void panel.offsetWidth;
  panel.classList.add('mc-panel-focus-flash');
  reviewFocusFlashTimer = setTimeout(function () {
    panel.classList.remove('mc-panel-focus-flash');
    reviewFocusFlashTimer = 0;
  }, 560);
}
function clearReviewPanelFocusFlash() {
  if (reviewFocusFlashTimer) clearTimeout(reviewFocusFlashTimer);
  reviewFocusFlashTimer = 0;
  document.querySelectorAll('.mc-panel-focus-flash').forEach(function (panel) {
    panel.classList.remove('mc-panel-focus-flash');
  });
  reviewFocusedPanel = null;
}
function setPanelClassNamePreservingFocus(panel, className) {
  if (!panel) return;
  var flashing = panel.classList.contains('mc-panel-focus-flash');
  panel.className = className;
  if (flashing) panel.classList.add('mc-panel-focus-flash');
}
document.addEventListener('keydown', function () { reviewFocusInputModality = 'keyboard'; }, true);
document.addEventListener('mousedown', function () {
  reviewFocusInputModality = 'pointer';
  clearReviewPanelFocusFlash();
}, true);
document.addEventListener('focusin', function (event) { flashReviewPanelFocus(event.target); }, true);

// Shared lightweight import detection for the read-only source renderer and the diff. It deliberately
// recognizes only top-level dependency declarations: an indented Python import inside a function or a
// dynamic `import()` call remains ordinary code. Multiline `{ ... }`, `( ... )`, and `[ ... ]` imports are
// consumed as one statement, while comments/package declarations may precede the import header.
function isTopLevelImportLine(raw) {
  var text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
  if (/^\s/.test(text)) return false;
  return /^(?:import\b(?!\s*\()|from\s+\S+\s+import\b|use\s+|using\s+|#\s*include\b|require\s*\(|(?:const|let|var)\s+[^=]+?=\s*require\s*\(|export\s+(?:\{|\*)[^;]*\bfrom\b)/.test(text);
}
function importHeaderLine(raw) {
  var text = String(raw == null ? '' : raw).trim();
  return !text || /^(?:\/\/|\/\*|\*|\*\/|#(?!\s*include\b)|#!|package\b|namespace\b|module\b|@file:|['"]use strict['"])/.test(text);
}
function importBracketDelta(raw) {
  var text = String(raw == null ? '' : raw), delta = 0, quote = '', escaped = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i), next = text.charAt(i + 1);
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && next === '/') break;
    if (ch === '#') break;
    if (ch === '(' || ch === '[' || ch === '{') delta += 1;
    else if (ch === ')' || ch === ']' || ch === '}') delta -= 1;
  }
  return delta;
}
function findImportRange(lines) {
  var first = -1, last = -1, limit = Math.min((lines || []).length, 300);
  for (var i = 0; i < limit; i++) {
    var raw = lines[i];
    if (raw == null) { if (first >= 0) break; continue; }
    if (isTopLevelImportLine(raw)) {
      if (first < 0) first = i;
      var depth = importBracketDelta(raw);
      last = i;
      while ((depth > 0 || /\\\s*$/.test(String(raw))) && i + 1 < limit && lines[i + 1] != null) {
        i += 1;
        raw = lines[i];
        depth += importBracketDelta(raw);
        last = i;
      }
      continue;
    }
    if (importHeaderLine(raw)) continue;
    break;
  }
  return first >= 0 && last >= first ? { start: first, end: last } : null;
}
function codeFoldMessage(kind, count) {
  var messages = (typeof I18N !== 'undefined' && I18N)
    ? (I18N[(typeof locale !== 'undefined' && locale) || 'en'] || I18N.en || {})
    : {};
  var key = kind === 'imports' ? 'fold.imports' : 'fold.block';
  var fallback = kind === 'imports' ? 'Imports · {count} lines' : '{count} folded lines';
  return String(messages[key] || fallback).replace('{count}', String(count || 0));
}
function codeFoldExpandTitle() {
  var messages = (typeof I18N !== 'undefined' && I18N)
    ? (I18N[(typeof locale !== 'undefined' && locale) || 'en'] || I18N.en || {})
    : {};
  return String(messages['fold.expand'] || 'Expand folded code');
}
function refreshCodeFoldLabels(root) {
  var scope = root && root.querySelectorAll ? root : document;
  Array.prototype.forEach.call(scope.querySelectorAll('.mc-code-fold-button'), function (button) {
    var kind = button.dataset.foldKind || 'block';
    var count = Number(button.dataset.foldCount) || 0;
    var label = codeFoldMessage(kind, count);
    var text = button.querySelector('.mc-code-fold-label');
    if (text) text.textContent = label;
    button.title = codeFoldExpandTitle() + (kind === 'block' ? ' (⌘.)' : '');
  });
}
function resetDiffImportFolds(wrapper) {
  if (!wrapper) return;
  Array.prototype.forEach.call(wrapper.querySelectorAll('.mc-import-fold-row, .mc-import-fold-hidden'), function (row) {
    row.classList.remove('mc-import-fold-row', 'mc-import-fold-hidden');
  });
  Array.prototype.forEach.call(wrapper.querySelectorAll('.d2h-code-line-ctn'), function (line) {
    if (line.__mcImportFoldHtml == null) return;
    line.innerHTML = line.__mcImportFoldHtml;
    delete line.__mcImportFoldHtml;
  });
}
function diffImportRangeHasChange(rows, range) {
  if (!range) return false;
  for (var i = range.start; i <= range.end; i++) {
    var row = rows[i];
    if (row && (row.classList.contains('mc-diff-change')
      || row.querySelector('td.d2h-ins:not(.d2h-emptyplaceholder), td.d2h-del:not(.d2h-emptyplaceholder)'))) return true;
  }
  return false;
}
function paintDiffImportFoldRow(row, count) {
  if (!row) return;
  row.classList.add('mc-import-fold-row');
  var line = row.querySelector('.d2h-code-line-ctn');
  if (!line) return;
  line.__mcImportFoldHtml = line.innerHTML;
  line.textContent = '';
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'mc-code-fold-button mc-import-fold';
  button.dataset.importExpand = '1';
  button.dataset.foldKind = 'imports';
  button.dataset.foldCount = String(count);
  button.dataset.keyhint = 'Space';
  var icon = document.createElement('span'); icon.className = 'mc-code-fold-icon'; icon.textContent = '›';
  var label = document.createElement('span'); label.className = 'mc-code-fold-label';
  button.appendChild(icon); button.appendChild(label); line.appendChild(button);
  refreshCodeFoldLabels(row);
}
function decorateDiffImportFold(wrapper, oldRows, newRows) {
  if (!wrapper) return;
  var path = (wrapper.dataset && wrapper.dataset.path)
    || ((wrapper.querySelector('.d2h-file-name') || {}).textContent || '').trim();
  if (path && diffImportOpenPaths[path]) return;
  var oldLines = oldRows.map(function (row) { return isDiffCodeRow(row) ? diffLineText(row) : null; });
  var newLines = newRows.map(function (row) { return isDiffCodeRow(row) ? diffLineText(row) : null; });
  var oldRange = findImportRange(oldLines), newRange = findImportRange(newLines);
  // An added/deleted/misaligned import header is itself review evidence, so leave the entire header open.
  if (!oldRange || !newRange || oldRange.start !== newRange.start || oldRange.end !== newRange.end) return;
  if (diffImportRangeHasChange(oldRows, oldRange) || diffImportRangeHasChange(newRows, newRange)) return;
  var count = oldRange.end - oldRange.start + 1;
  paintDiffImportFoldRow(oldRows[oldRange.start], count);
  paintDiffImportFoldRow(newRows[newRange.start], count);
  for (var i = oldRange.start + 1; i <= oldRange.end; i++) {
    if (oldRows[i]) oldRows[i].classList.add('mc-import-fold-hidden');
    if (newRows[i]) newRows[i].classList.add('mc-import-fold-hidden');
  }
}
function openDiffImportFold(row) {
  var wrapper = row && row.closest ? row.closest('.d2h-file-wrapper') : null;
  if (!wrapper) return;
  var path = (wrapper.dataset && wrapper.dataset.path)
    || ((wrapper.querySelector('.d2h-file-name') || {}).textContent || '').trim();
  if (path) diffImportOpenPaths[path] = true;
  if (typeof clearSelectedDiffFold === 'function') clearSelectedDiffFold();
  resetDiffImportFolds(wrapper);
  invalidateDiffRows(wrapper);
  invalidateAsymmetricDiffGeometry(wrapper);
  scheduleAsymmetricDiffScroll();
  if (diffCursor && diffCursor.path === path) renderDiffCaret();
}


function diffContextHeader(row) {
  var raw = row && (row.dataset.hunkHeader || (row.textContent || '').trim());
  var match = String(raw || '').match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  if (row && !row.dataset.hunkHeader) row.dataset.hunkHeader = raw;
  return { oldStart: Number(match[1]), newStart: Number(match[3]) };
}
function diffContextMessage(key, count) {
  var messages = (typeof I18N !== 'undefined' && I18N)
    ? (I18N[(typeof locale !== 'undefined' && locale) || 'en'] || I18N.en || {})
    : {};
  var fallback = key === 'diff.contextLoading' ? 'Loading context…'
    : key === 'diff.contextUnavailable' ? 'Context could not be loaded.'
      : '{count} unchanged lines · expand';
  return String(messages[key] || fallback).replace('{count}', String(count || 0));
}
function paintDiffContextFoldRow(row, count, hunkIndex) {
  if (!row) return;
  row.classList.remove('mc-context-expanded-marker');
  row.removeAttribute('aria-hidden');
  row.classList.add('mc-context-fold-row');
  row.dataset.contextHunk = String(hunkIndex);
  var line = row.querySelector('.d2h-code-side-line');
  if (!line) return;
  // diff2html emits the omitted-range marker as a normal two-cell source row. Let the control own the
  // complete row instead: otherwise its natural containing block starts after one gutter on the working
  // side, so a viewport-wide sticky button is already off-centre before the user even scrolls.
  var cell = line.closest('td');
  if (cell) {
    cell.colSpan = Math.max(1, row.children.length);
    Array.prototype.forEach.call(row.children, function (peer) {
      if (peer !== cell) peer.classList.add('mc-context-fold-companion');
    });
  }
  line.textContent = '';
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'mc-context-fold';
  button.dataset.contextExpand = '1';
  button.dataset.keyhint = 'Space';
  var icon = document.createElement('span'); icon.className = 'mc-context-fold-icon'; icon.textContent = '⋯';
  var label = document.createElement('span'); label.className = 'mc-context-fold-label'; label.textContent = diffContextMessage('diff.contextFold', count);
  button.title = label.textContent;
  button.appendChild(icon); button.appendChild(label); line.appendChild(button);
}
function finishDiffContextFoldRow(row) {
  if (!row) return;
  row.classList.remove('mc-context-fold-row');
  row.classList.add('mc-context-expanded-marker');
  // Keep the @@ row in the DOM as the stable F7/hunk id, but remove it from the table layout. Leaving a
  // nominal 1px row let diff2html's cell line-height expand it into an empty horizontal bar after context
  // was opened. Navigation lands on the following code row, so the marker itself never needs to paint.
  row.setAttribute('aria-hidden', 'true');
  delete row.dataset.contextHunk;
  delete row.dataset.contextLoading;
  ['contextOldStart', 'contextOldEnd', 'contextNewStart', 'contextNewEnd'].forEach(function (key) { delete row.dataset[key]; });
  var line = row.querySelector('.d2h-code-side-line');
  if (line) line.textContent = '';
}
// Every @@ separator that actually hides lines becomes a keyboard-accessible expansion control. The
// side-by-side tables are positional peers, so both controls share one hunk key and expand atomically.
function decorateDiffContextFolds(wrapper, oldRows, newRows) {
  if (!wrapper) return;
  oldRows = oldRows || diffRowsOf(diffSideTable(wrapper, 'old'));
  newRows = newRows || diffRowsOf(diffSideTable(wrapper, 'new'));
  var previousOld = 0, previousNew = 0;
  for (var i = 0; i < oldRows.length; i++) {
    var oldMarker = oldRows[i];
    var header = diffContextHeader(oldMarker);
    var newMarker = newRows[i] || null;
    if (!header) {
      var visibleOld = diffLineNumber(oldMarker), visibleNew = diffLineNumber(newMarker);
      if (visibleOld != null) previousOld = visibleOld;
      if (visibleNew != null) previousNew = visibleNew;
      continue;
    }
    var oldStart = previousOld + 1;
    var newStart = previousNew + 1;
    var oldEnd = header.oldStart - 1;
    var newEnd = header.newStart - 1;
    var count = Math.max(oldEnd >= oldStart ? oldEnd - oldStart + 1 : 0, newEnd >= newStart ? newEnd - newStart + 1 : 0);
    var hunkIndex = oldMarker.dataset.hunkIndex || oldMarker.dataset.reviewHunkIndex || String(i);
    if (!count) { finishDiffContextFoldRow(oldMarker); finishDiffContextFoldRow(newMarker); continue; }
    [oldMarker, newMarker].forEach(function (row) {
      if (!row) return;
      row.dataset.contextOldStart = String(oldStart);
      row.dataset.contextOldEnd = String(oldEnd);
      row.dataset.contextNewStart = String(newStart);
      row.dataset.contextNewEnd = String(newEnd);
      paintDiffContextFoldRow(row, count, hunkIndex);
    });
  }
}
function refreshDiffContextFoldLabels() {
  document.querySelectorAll('.mc-context-fold-row').forEach(function (row) {
    var oldStart = Number(row.dataset.contextOldStart), oldEnd = Number(row.dataset.contextOldEnd);
    var newStart = Number(row.dataset.contextNewStart), newEnd = Number(row.dataset.contextNewEnd);
    var count = Math.max(oldEnd >= oldStart ? oldEnd - oldStart + 1 : 0, newEnd >= newStart ? newEnd - newStart + 1 : 0);
    var label = row.querySelector('.mc-context-fold-label');
    if (label) label.textContent = row.dataset.contextLoading === '1'
      ? diffContextMessage('diff.contextLoading') : diffContextMessage('diff.contextFold', count);
    var button = row.querySelector('.mc-context-fold');
    if (button && label) {
      button.title = label.textContent;
      button.setAttribute('data-tooltip', label.textContent);
      button.disabled = row.dataset.contextLoading === '1';
    }
  });
}
function diffContextRequestForRow(row) {
  var take = 1000;
  var oldStart = Number(row.dataset.contextOldStart), oldEnd = Number(row.dataset.contextOldEnd);
  var newStart = Number(row.dataset.contextNewStart), newEnd = Number(row.dataset.contextNewEnd);
  return {
    path: diffWrapperPathKey(row.closest('.d2h-file-wrapper')),
    oldStart: oldStart, oldEnd: Math.min(oldEnd, oldStart + take - 1),
    newStart: newStart, newEnd: Math.min(newEnd, newStart + take - 1),
  };
}
function fallbackDiffContext(request) {
  return loadSourceFile(request.path).then(function (file) {
    if (!file || !file.embedded || typeof file.content !== 'string') return { ok: false };
    var lines = file.content.split(/\r?\n/); if (lines[lines.length - 1] === '') lines.pop();
    var newLines = lines.slice(request.newStart - 1, request.newEnd);
    // A folded gap is unchanged. Standalone HTML only embeds the working source, so use that text with
    // old-side line numbers; Electron/browser-watch fetch both reviewed revisions from the host.
    return { ok: true, oldStart: request.oldStart, newStart: request.newStart, oldLines: newLines.slice(), newLines: newLines };
  });
}
function loadDiffContext(request) {
  if (window.kakapoFile && typeof window.kakapoFile.getDiffContext === 'function') {
    return Promise.resolve(window.kakapoFile.getDiffContext(request));
  }
  if (REVIEW_LAZY_LOAD && typeof fetch !== 'undefined') {
    var query = Object.keys(request).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(request[key]); }).join('&');
    return fetch('diff-context?' + query).then(function (response) { return response.ok ? response.json() : { ok: false }; });
  }
  return fallbackDiffContext(request);
}
function createExpandedContextRow(lineNumber, text, language) {
  if (lineNumber == null || text == null) {
    var empty = document.createElement('tr'); empty.className = 'mc-expanded-context-row';
    empty.innerHTML = '<td class="d2h-code-side-linenumber d2h-emptyplaceholder"></td><td class="d2h-code-side-emptyplaceholder d2h-emptyplaceholder"></td>';
    return empty;
  }
  var row = document.createElement('tr'); row.className = 'mc-expanded-context-row';
  var number = document.createElement('td'); number.className = 'd2h-code-side-linenumber d2h-cntx'; number.textContent = String(lineNumber);
  var code = document.createElement('td'); code.className = 'd2h-cntx';
  var line = document.createElement('div'); line.className = 'd2h-code-side-line';
  var prefix = document.createElement('span'); prefix.className = 'd2h-code-line-prefix'; prefix.textContent = ' ';
  var content = document.createElement('span'); content.className = 'd2h-code-line-ctn'; content.innerHTML = highlightLine(String(text), language || 'text');
  line.appendChild(prefix); line.appendChild(content); code.appendChild(line); row.appendChild(number); row.appendChild(code);
  return row;
}
function restoreDiffCursorAfterContext(wrapper, snapshot) {
  if (!snapshot || !diffCursor || diffCursor.path !== snapshot.path) return;
  var rows = diffRowsOf(diffSideTable(wrapper, snapshot.side));
  var index = rows.findIndex(function (row) {
    return diffLineNumber(row) === snapshot.line && (!snapshot.text || diffLineText(row) === snapshot.text);
  });
  if (index < 0) return;
  diffCursor.rowIndex = index;
  diffCursor.column = Math.min(snapshot.column, diffLineText(rows[index]).length);
  renderDiffCaret(); applyDiffSelection();
}
function expandDiffContext(row) {
  if (!row || row.dataset.contextLoading === '1') return;
  if (typeof clearSelectedDiffFold === 'function') clearSelectedDiffFold();
  var wrapper = row.closest('.d2h-file-wrapper');
  var key = row.dataset.contextHunk;
  if (!wrapper || key == null) return;
  var peers = wrapper.querySelectorAll('.mc-context-fold-row[data-context-hunk="' + key + '"]');
  var request = diffContextRequestForRow(row);
  var cursorRow = diffCursor && diffCursor.path === request.path ? diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex) : null;
  var cursorSnapshot = diffCursor && diffCursor.path === request.path ? {
    path: diffCursor.path, side: diffCursor.side, line: diffLineNumber(cursorRow), text: diffLineText(cursorRow), column: diffCursor.column,
  } : null;
  peers.forEach(function (peer) { peer.dataset.contextLoading = '1'; }); refreshDiffContextFoldLabels();
  loadDiffContext(request).then(function (result) {
    if (!result || result.ok === false) throw new Error(result && result.error || 'context unavailable');
    var oldLines = Array.isArray(result.oldLines) ? result.oldLines : [];
    var newLines = Array.isArray(result.newLines) ? result.newLines : [];
    if (!oldLines.length && !newLines.length) throw new Error('empty context');
    var oldSide = diffSideTable(wrapper, 'old');
    var oldMarker = Array.prototype.find.call(peers, function (peer) { return peer.closest('.d2h-file-side-diff') === oldSide; });
    var newMarker = Array.prototype.find.call(peers, function (peer) { return peer !== oldMarker; });
    var file = sourceByPath.get(request.path);
    var language = file ? file.language : 'text';
    var count = Math.max(oldLines.length, newLines.length);
    var oldFragment = document.createDocumentFragment(), newFragment = document.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      oldFragment.appendChild(createExpandedContextRow(i < oldLines.length ? request.oldStart + i : null, oldLines[i], language));
      newFragment.appendChild(createExpandedContextRow(i < newLines.length ? request.newStart + i : null, newLines[i], language));
    }
    if (oldMarker && oldMarker.parentNode) oldMarker.parentNode.insertBefore(oldFragment, oldMarker);
    if (newMarker && newMarker.parentNode) newMarker.parentNode.insertBefore(newFragment, newMarker);
    invalidateDiffRows(wrapper);
    wrapper.__reviewAnchorsOld = null; wrapper.__reviewAnchorsNew = null;
    annotateDiffHunkRows(wrapper);
    restoreDiffCursorAfterContext(wrapper, cursorSnapshot);
    if (typeof refreshComments === 'function') refreshComments();
    syncDiffReviewChrome(request.path);
  }).catch(function () {
    peers.forEach(function (peer) { delete peer.dataset.contextLoading; }); refreshDiffContextFoldLabels();
    if (typeof showToast === 'function') showToast(diffContextMessage('diff.contextUnavailable'));
  });
}

// Assign global hunk ids/classes to a freshly materialized file body, keyed off its shell's
// data-first-hunk so indices stay globally consistent with the eager numbering.
function markWrapperHunks(wrapper) {
  var base = parseInt(wrapper.dataset.firstHunk || '0', 10) || 0;
  var fileName = ((wrapper.querySelector('.d2h-file-name') || {}).textContent || '').trim();
  var headerToIndex = new Map();
  var local = 0;
  Array.prototype.forEach.call(wrapper.querySelectorAll('tr'), function (row) {
    var header = row.dataset.hunkHeader || (row.textContent || '').trim();
    if (header.indexOf('@@') !== 0) return;
    row.dataset.hunkHeader = header;
    var index = headerToIndex.get(header);
    if (index === undefined) { index = base + local; headerToIndex.set(header, index); row.classList.add('hunk'); row.id = 'hunk-' + index; local += 1; }
    else { row.classList.add('hunk-peer'); }
    row.dataset.hunkIndex = String(index);
    row.dataset.file = fileName;
  });
  annotateDiffHunkRows(wrapper);
}
var bodyCache = {};   // file index -> diff body html (lazy-LOAD cache)
var bodyPromise = {}; // file index -> Promise that resolves once the body is materialized
function loadBodyHtml(index) {
  if (bodyCache[index] != null) return Promise.resolve(bodyCache[index]);
  var p;
  if (typeof window !== 'undefined' && window.kakapoFile && typeof window.kakapoFile.get === 'function') {
    p = Promise.resolve().then(function () { return window.kakapoFile.get(Number(index), 'diff'); });
  } else if (typeof fetch !== 'undefined') {
    p = fetch('file?index=' + index).then(function (r) { return r.ok ? r.text() : ''; });
  } else {
    p = Promise.resolve('');
  }
  return p.then(function (html) { bodyCache[index] = html || ''; return bodyCache[index]; }, function () { bodyCache[index] = ''; return ''; });
}
function materializeBody(wrapper, html) {
  var body = wrapper.querySelector('.d2h-files-diff[data-lazy]');
  if (!body) return;
  body.innerHTML = html || '';
  body.removeAttribute('data-lazy');
  body.removeAttribute('data-loading');
  invalidateDiffRows(wrapper);
  markWrapperHunks(wrapper);
  if (diffBootDone && typeof reviewComments !== 'undefined' && reviewComments.length) { try { refreshComments(); } catch (e) {} }
}
// Materialize a lazily-emitted file body. Phase 1 reads it from an inert embedded island (sync);
// Phase 2 lazy-LOAD fetches it on demand (async) — callers that then need rows must use whenFileReady().
function ensureFileReady(wrapper) {
  if (!wrapper) return null;
  var body = wrapper.querySelector('.d2h-files-diff[data-lazy]');
  if (!body) return wrapper; // already materialized (or eager mode)
  var idx = (wrapper.id || '').replace('file-', '');
  if (REVIEW_LAZY_LOAD) {
    if (!bodyPromise[idx]) {
      body.setAttribute('data-loading', '1');
      bodyPromise[idx] = loadBodyHtml(idx).then(function (html) { materializeBody(wrapper, html); return wrapper; });
    }
    return wrapper;
  }
  var island = document.getElementById('diff-body-' + idx);
  if (island) materializeBody(wrapper, island.textContent || '');
  return wrapper;
}
// Run cb once the wrapper's body is materialized — synchronously when it already is (eager / Phase 1
// island / cached), or after the fetch resolves (cold lazy-LOAD). Lets navigation stay correct without
// turning every caller async.
function whenFileReady(wrapper, cb) {
  if (!wrapper) { cb(); return; }
  ensureFileReady(wrapper);
  var body = wrapper.querySelector('.d2h-files-diff');
  if (!body || !body.hasAttribute('data-lazy')) { cb(); return; }
  var idx = (wrapper.id || '').replace('file-', '');
  if (bodyPromise[idx]) { bodyPromise[idx].then(function () { cb(); }); return; }
  cb();
}
var lazyIO = null; // remembered so each setupLazyDiff (re-run on every watch refresh) disconnects the prior
                   // observer instead of leaving a new one bound to detached wrappers — otherwise observers
                   // (and the old DOM they retain) pile up over a long-running session and slowly choke it.
function setupLazyDiff() {
  var container = document.getElementById('diff2html-container');
  if (!container) return;
  if (lazyIO) { try { lazyIO.disconnect(); } catch (e) {} lazyIO = null; }
  var wrappers = Array.prototype.slice.call(container.querySelectorAll('.d2h-file-wrapper'));
  if (typeof IntersectionObserver !== 'undefined') {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { ensureFileReady(e.target); io.unobserve(e.target); } });
    }, { root: null, rootMargin: '600px 0px' });
    lazyIO = io; // track this observer so the NEXT setupLazyDiff can disconnect it (callback keeps using local io)
    wrappers.forEach(function (w) { io.observe(w); });
  } else {
    wrappers.forEach(function (w) { ensureFileReady(w); }); // no IntersectionObserver -> materialize all
  }
  if (wrappers[0]) ensureFileReady(wrappers[0]); // first file ready so the initial caret has a row to land on
}
if (REVIEW_LAZY) { setupLazyDiff(); setTimeout(function () { diffBootDone = true; }, 0); }
let links = Array.from(document.querySelectorAll('#changes-panel .file-link')); // re-captured on in-place diff update
let sourceLinks = Array.from(document.querySelectorAll('.source-link')); // re-captured when a deferred tree materializes
let sourceFiles = JSON.parse(document.getElementById('source-files-data')?.textContent || '[]');
// i18n: the message catalog (en + ko) is emitted server-side; the locale lives in localStorage and the
// whole UI switches live (no reload). t() feeds dynamically-built text; applyI18n() rewrites the static
// chrome (data-i18n / -ph / -title / -aria). English is the first-paint default.
var I18N = JSON.parse(document.getElementById('i18n-data')?.textContent || '{}');
// Cross-reopen persistence. Electron persists via the main process (window.kakapoSettings — survives
// app restart; file:// localStorage doesn't); browser/serve falls back to localStorage. persistRead
// returns the bridge value (native) if present, else undefined so callers parse localStorage themselves.
function persistRead(key) {
  // window.kakapoSettings.all crosses Electron's contextBridge, which DEEP-FREEZES every value it
  // exposes. Returning that frozen object/array directly breaks callers that mutate the result —
  // reviewComments.push(...) and mergePrompts[kind]=... both throw "object is not extensible". Hand
  // back a mutable deep copy so the persisted snapshot is a starting point, not a locked one.
  try {
    if (window.kakapoSettings && window.kakapoSettings.all && key in window.kakapoSettings.all) {
      var v = window.kakapoSettings.all[key];
      return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    }
  } catch (e) {}
  return undefined;
}
function persistSave(key, value) {
  try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) {}
  try { if (window.kakapoSettings) window.kakapoSettings.set(key, value); } catch (e2) {}
}
var LOCALE_KEY = 'kakapo-locale';
var locale = (function () {
  var v = persistRead(LOCALE_KEY);
  if (v !== 'ko' && v !== 'en') { try { v = localStorage.getItem(LOCALE_KEY); } catch (e) {} }
  return (v === 'ko' || v === 'en') ? v : 'en';
})();
function t(key) { var m = (I18N[locale] || I18N.en || {}); return (m && key in m) ? m[key] : ((I18N.en && I18N.en[key]) || key); }
var langSelectRef = null, themeSelectRef = null, syntaxThemeSelectRef = null;
// Replace a native <select> with a button that opens our custom dropdown (consistent with the comment
// dropdown + themable; native <select> popups ignore the app theme). getOptions() -> [{value,label}];
// returns { render } so localized labels can be refreshed on a language switch.
function setupCustomSelect(id, getOptions, getCurrent, onPick) {
  var el = document.getElementById(id);
  if (!el) return null;
  function render() {
    var cur = getCurrent();
    var match = getOptions().filter(function (o) { return o.value === cur; })[0];
    el.textContent = match ? match.label : cur;
  }
  el.addEventListener('click', function (e) {
    e.preventDefault();
    var r = el.getBoundingClientRect(), cur = getCurrent();
    showCustomDropdown(r.left, r.bottom + 4, getOptions().map(function (o) {
      return { label: (o.value === cur ? '✓  ' : '  ') + o.label, onSelect: function () { onPick(o.value); render(); } };
    }), r.top - 4);
  });
  render();
  return { render: render };
}
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  document.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  document.documentElement.lang = locale;
  if (langSelectRef) langSelectRef.render();
  if (themeSelectRef) themeSelectRef.render(); // theme labels are localized — refresh on a language switch too
  if (syntaxThemeSelectRef) syntaxThemeSelectRef.render();
  if (typeof refreshDiffContextFoldLabels === 'function') refreshDiffContextFoldLabels();
  if (typeof refreshCodeFoldLabels === 'function') refreshCodeFoldLabels();
  if (typeof syncDiffReviewChrome === 'function') syncDiffReviewChrome();
}
// Theme mirrors the locale pattern: persisted choice, applied by toggling data-theme on <html> so the
// :root[data-theme="light"] palette takes over. Dark is the default (matches the inline :root). Applied
// immediately at script start to minimize a first-paint flash from the dark default to light.
var THEME_KEY = 'kakapo-theme';
var theme = (function () {
  var v = persistRead(THEME_KEY);
  if (v !== 'light' && v !== 'dark') { try { v = localStorage.getItem(THEME_KEY); } catch (e) {} }
  return (v === 'light' || v === 'dark') ? v : 'dark';
})();
function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
  if (themeSelectRef) themeSelectRef.render();
  // Theme families own both app chrome and Review code colors.
}
applyTheme();
// The persisted syntax choice is a complete theme family rather than a code-only palette. `theme` selects
// the family's dark/light member, keeping navigation chrome, diff, raw source, and HTTP coherent.
var SYNTAX_THEME_KEY = 'kakapo-syntax-theme';
var syntaxTheme = (function () {
  var v = persistRead(SYNTAX_THEME_KEY);
  if (v !== 'default' && v !== 'darcula') { try { v = localStorage.getItem(SYNTAX_THEME_KEY); } catch (e) {} }
  return (v === 'darcula' || v === 'default') ? v : 'default';
})();
function applySyntaxTheme() {
  document.documentElement.setAttribute('data-syntax-theme', syntaxTheme);
  if (syntaxThemeSelectRef) syntaxThemeSelectRef.render();
}
applySyntaxTheme();
let fileStates = JSON.parse(document.getElementById('file-state-data')?.textContent || '[]');
let httpEnvironments = JSON.parse(document.getElementById('http-env-data')?.textContent || '{}');
let httpEnvNames = Object.keys(httpEnvironments);
const httpEnvKey = 'kakapo-http-env:' + location.pathname;
const httpRequestsByPath = new Map();
const httpVarsByPath = new Map();
let sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
var projectIndexLoaded = !REVIEW_LAZY_LOAD;
var projectIndexPromise = null;
var projectIndexPayload = null;

// Merge the lazily-fetched project index without discarding source bodies that are already open. Electron's
// contextBridge freezes returned records, so clone each one before the renderer annotates it with __loaded.
function installProjectIndex(payload) {
  if (!payload || !Array.isArray(payload.sourceFilesMeta)) return null;
  if (payload.signature && currentSignature && payload.signature !== currentSignature) return null;
  var previousByPath = sourceByPath;
  var records = payload.sourceFilesMeta.map(function (record) {
    var file = Object.assign({}, record, { content: String(record.content || ''), image: record.image || '' });
    file.__loaded = !REVIEW_LAZY_LOAD || !file.embedded;
    var previous = previousByPath.get(file.path);
    if (previous && previous.__loaded) {
      file.content = previous.content;
      if (previous.image) file.image = previous.image;
      file.__loaded = true;
    }
    return file;
  });
  sourceFiles = records;
  sourceByPath = new Map(records.map(function (file) { return [file.path, file]; }));
  fileStates = Array.isArray(payload.fileStates) && payload.fileStates.length
    ? payload.fileStates.slice()
    : records.map(function (file) { return { path: file.path, signature: file.signature || '' }; });
  fileSignatureByPath = new Map(fileStates.map(function (file) { return [file.path, file.signature]; }));
  projectIndexLoaded = true;
  projectIndexPayload = payload;
  if (typeof pruneCommentsForMissingFiles === 'function' && pruneCommentsForMissingFiles()) refreshComments();
  return payload;
}

function ensureProjectIndex() {
  if (projectIndexLoaded) return Promise.resolve(projectIndexPayload || { sourceFilesMeta: sourceFiles, filesTree: '' });
  if (projectIndexPromise) return projectIndexPromise;
  var request;
  if (window.kakapoFile && typeof window.kakapoFile.getIndex === 'function') {
    request = Promise.resolve().then(function () { return window.kakapoFile.getIndex(); });
  } else if (typeof fetch !== 'undefined') {
    request = fetch('project-index', { cache: 'no-store' }).then(function (response) { return response.ok ? response.json() : null; });
  } else {
    request = Promise.resolve(null);
  }
  projectIndexPromise = request.then(function (payload) {
    projectIndexPromise = null;
    return installProjectIndex(payload);
  }, function () {
    projectIndexPromise = null;
    return null;
  });
  return projectIndexPromise;
}
// Electron starts with metadata only. Source bodies are fetched one file at a time so opening a large
// project never clones every source file into the renderer. The browser server retains its bulk endpoint
// as a compatibility fallback, but the desktop app always uses kakapoFile.getSource(path).
sourceFiles.forEach(function (file) { file.__loaded = !REVIEW_LAZY_LOAD || !file.embedded; });
var sourceLoadPromises = Object.create(null);
var bulkSourcePromise = null;
var sourceGeneration = 0; // increments on watch refresh so an older IPC response cannot overwrite new source
// The path whose content is ACTUALLY painted in #source-body right now. dataset.openPath is the INTENDED
// path and gets set BEFORE the body paints in the lazy-LOAD branch, so the caret fast-path must check this
// instead — else it patches the caret onto a stale body, leaving one file's content under another's path.
var sourceBodyPath = null;
var sourceTabs = []; // Files-mode tab paths (session-only); see addSourceTab / renderSourceTabs.
var sourceImportOpenPaths = Object.create(null); // imports start folded in Review mode until explicitly opened
var sourceManualFoldKeys = Object.create(null);  // path -> { "start:end": true } for Cmd/Ctrl+. brace folds
function sourceContentLoaded(file) {
  return Boolean(file && (!REVIEW_LAZY_LOAD || !file.embedded || file.__loaded));
}
function mergeSourceRecord(record) {
  if (!record || !record.path) return null;
  var file = sourceByPath.get(record.path);
  if (!file) return null;
  // Copy availability fields too: a deferred file can have become missing, binary, or oversized before
  // it is opened. Conversely, a successful on-demand response clears deferred/skipped metadata.
  Object.assign(file, record);
  file.content = String(record.content || '');
  file.__loaded = true;
  return file;
}
function loadSourceFile(path) {
  var file = sourceByPath.get(path);
  if (!file || sourceContentLoaded(file)) return Promise.resolve(file || null);
  if (sourceLoadPromises[path]) return sourceLoadPromises[path];
  var generation = sourceGeneration;
  var promise;
  if (typeof window !== 'undefined' && window.kakapoFile && typeof window.kakapoFile.getSource === 'function') {
    promise = Promise.resolve().then(function () { return window.kakapoFile.getSource(path); }).then(function (record) {
      if (generation !== sourceGeneration) return sourceByPath.get(path) || null;
      return mergeSourceRecord(record) || file;
    });
  } else {
    // The standalone browser viewer has a single source-data endpoint. Fetch it at most once and mark
    // each returned record loaded; Electron never enters this branch.
    if (!bulkSourcePromise) {
      bulkSourcePromise = (typeof fetch !== 'undefined'
        ? fetch('source-data').then(function (r) { return r.ok ? r.text() : '[]'; })
        : Promise.resolve('[]')).then(function (text) {
          var data = [];
          try { data = JSON.parse(text || '[]'); } catch (e) { data = []; }
          if (generation === sourceGeneration) {
            for (var i = 0; i < data.length; i++) mergeSourceRecord(data[i]);
          }
          return data;
        });
    }
    promise = bulkSourcePromise.then(function () { return sourceByPath.get(path) || file; });
  }
  var tracked = promise.then(function (loaded) {
    if (sourceLoadPromises[path] === tracked) delete sourceLoadPromises[path];
    remapComments();
    return loaded;
  }, function () {
    if (sourceLoadPromises[path] === tracked) delete sourceLoadPromises[path];
    if (generation === sourceGeneration) file.__loaded = true;
    return file;
  });
  sourceLoadPromises[path] = tracked;
  return tracked;
}
let fileSignatureByPath = new Map(fileStates.map((file) => [file.path, file.signature]));
const reviewMeta = document.getElementById('review-meta');
const watchEnabled = reviewMeta?.dataset.watch === 'true';
let currentSignature = reviewMeta?.dataset.signature || '';
const uiStateKey = 'kakapo-diff-ui:' + location.pathname;
const recentKey = 'kakapo-diff-recent:' + location.pathname;
const viewedKey = 'kakapo-diff-viewed:' + location.pathname;
const quickOpen = document.getElementById('quick-open');
const quickInput = document.getElementById('quick-open-input');
const quickResults = document.getElementById('quick-open-results');
const quickModeLabel = document.getElementById('quick-open-mode');
const quickFilterEl = document.getElementById('quick-open-filter');
const quickExtensionInput = document.getElementById('quick-open-extensions');
const quickExcludeNoiseButton = document.getElementById('quick-open-exclude-noise');
let current = -1;
let checkingForUpdates = false;
let lastShiftAt = 0;
let lastShiftSide = 0;
let quickMode = 'all';
let quickItems = [];
let quickActive = 0;
let recentFilter = ''; // IntelliJ-style speed-search: typed letters narrow the Recent list (no search box)
let contentSearchItems = [];
let contentSearchQuery = '';
let contentSearchSeq = 0;
let contentSearchTimer = null;
let contentSearchBusy = false;
let contentSearchTruncated = false;
let contentSearchEngine = 'local';
let contentSearchExcludeNoise = false;
let workspaceSymbolItems = [];
let workspaceSymbolQuery = '';
let workspaceSymbolSeq = 0;
let workspaceSymbolTimer = null;
let workspaceSymbolBusy = false;
let workspaceSymbolEngine = 'index';
let usageItems = []; // find-usages results for the Cmd+B-on-declaration popup
let usageActive = 0;
let viewerCursor = null;
let selectedCommentRow = null; // a comment box "selected" while navigating with arrows (caret hidden); Backspace deletes it
let selectedDiffFoldRow = null; // an omitted-context stop selected with arrows; Space expands both panes
let currentHttpEnvName = (function () {
  let saved = persistRead(httpEnvKey);
  if (typeof saved !== 'string') { try { saved = localStorage.getItem(httpEnvKey) || ''; } catch (error) { saved = ''; } }
  if (saved && httpEnvNames.indexOf(saved) >= 0) return saved;
  return httpEnvNames.length ? httpEnvNames[0] : '';
})();
let treeFocusIndex = -1;
let selectionAnchor = null;
let diffCursor = null; // { path, side: 'old'|'new', rowIndex, column } — keyboard caret in the side-by-side diff
// Cursor-position history for Cmd/Ctrl+[ (back) and Cmd/Ctrl+] (forward), IDE-style.
let navList = [];
let navPos = -1;
let navSuppress = false;
var NAV_JUMP_LINES = 8;
var NAV_MAX = 60;
let diffSelectionAnchor = null; // { side, rowIndex, column } — Shift+Arrow drag-select origin in the diff
let measuredCharWidth = 0;

// Review-comment state — initialized here (early) so saved comments are loaded before
// restoreUiState()/openDefaultSourceFile() run on startup and try to render them.
var COMMENTS_KEY = 'kakapo-comments:' + location.pathname;
var reviewComments = [];
reviewComments = (function () { var b = persistRead(COMMENTS_KEY); if (Array.isArray(b)) return b; try { return JSON.parse(localStorage.getItem(COMMENTS_KEY) || '[]'); } catch (commentsErr) { return []; } })();
if (!Array.isArray(reviewComments)) reviewComments = [];
var commentSeq = reviewComments.reduce(function (max, c) { return Math.max(max, c.seq || 0); }, 0);
var composerState = null;

function prepareDiff2HtmlHunks() {
  const wrappers = Array.from(document.querySelectorAll('.d2h-file-wrapper'));
  let globalHunkIndex = 0;
  wrappers.forEach((wrapper, fileIndex) => {
    wrapper.id = 'file-' + fileIndex;
    const fileName = wrapper.querySelector('.d2h-file-name')?.textContent?.trim() || '';
    const headerToIndex = new Map();
    const rows = Array.from(wrapper.querySelectorAll('tr'));
    rows.forEach((row) => {
      const header = row.dataset.hunkHeader || row.textContent.trim();
      if (!header.startsWith('@@')) return;
      row.dataset.hunkHeader = header;
      let index = headerToIndex.get(header);
      if (index === undefined) {
        index = globalHunkIndex;
        headerToIndex.set(header, index);
        row.classList.add('hunk');
        row.id = 'hunk-' + index;
        globalHunkIndex += 1;
      } else {
        row.classList.add('hunk-peer');
      }
      row.dataset.hunkIndex = String(index);
      row.dataset.file = fileName;
    });
    annotateDiffHunkRows(wrapper);
  });
}

document.addEventListener('click', function (event) {
  var importButton = event.target && event.target.closest ? event.target.closest('[data-import-expand]') : null;
  if (importButton) {
    event.preventDefault();
    openDiffImportFold(importButton.closest('.mc-import-fold-row'));
    return;
  }
  var button = event.target && event.target.closest ? event.target.closest('[data-context-expand]') : null;
  if (!button) return;
  event.preventDefault();
  expandDiffContext(button.closest('.mc-context-fold-row'));
});

applyViewedState();

function loadViewedState() {
  try {
    var stored = persistRead(viewedKey);
    const value = stored && typeof stored === 'object' ? stored : JSON.parse(localStorage.getItem(viewedKey) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveViewedState(value) {
  persistSave(viewedKey, value);
}

function currentFileSignature(path) {
  return fileSignatureByPath.get(path) || '';
}

function isFileViewed(path) {
  const viewed = loadViewedState();
  const signature = currentFileSignature(path);
  // A review mark belongs to the exact diff the reviewer inspected, not merely to a path. Keeping a plain
  // boolean here made a later edit to the same file silently remain "viewed": F7 skipped it even though the
  // sidebar (rebuilt by live refresh) looked like an ordinary modified file. Old boolean records are treated
  // as stale once so existing installs recover from that ambiguous state; new records survive restarts and
  // unrelated watch refreshes as long as this file's own diff signature is unchanged.
  return Boolean(signature && typeof viewed[path] === 'string' && viewed[path] === signature);
}

function setFileViewed(path, viewed) {
  const state = loadViewedState();
  // Persist the PER-FILE diff signature. It is stable across restarts and unrelated repository changes,
  // but changes as soon as this file's reviewed patch changes, which correctly puts it back in the queue.
  if (viewed) {
    const signature = currentFileSignature(path);
    if (signature) state[path] = signature;
  }
  else delete state[path];
  saveViewedState(state);
  applyViewedState();
}

// Viewed marks persist across restarts and unrelated refreshes, but only for the exact per-file diff that
// was reviewed. applyViewedState is also rerun after every in-place update so the visible check badge and
// F7's queue filtering can never disagree.
function applyViewedState() {
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    const fileName = wrapper.querySelector('.d2h-file-name')?.textContent?.trim() || '';
    const viewed = isFileViewed(fileName);
    wrapper.classList.toggle('file-viewed', viewed);
  });
  // Viewed is a diff-review concept: only the Changes list shows it, not the Files/source tree.
  links.forEach((link) => {
    link.classList.toggle('viewed', isFileViewed(link.dataset.file || ''));
  });
}

let activeDiffRow = null;
