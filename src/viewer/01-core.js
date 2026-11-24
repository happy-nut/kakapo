function kakapoMarkHtml(extraClass) {
  return '<span class="kakapo-mark' + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true"></span>';
}
function kakapoLoaderHtml(extraClass) {
  return '<span class="kakapo-loader' + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true">'
    + kakapoMarkHtml() + '</span>';
}

function loadingStateHtml(message, extraClass) {
  return '<div class="mc-loading-state' + (extraClass ? ' ' + extraClass : '') + '" role="status" aria-live="polite">'
    + kakapoLoaderHtml('kakapo-loader-inline') + '<span>' + escapeHtml(message) + '</span></div>';
}

const REVIEW_LAZY = document.getElementById('review-meta')?.dataset.lazy === 'true';
const REVIEW_LAZY_LOAD = document.getElementById('review-meta')?.dataset.lazyLoad === 'true';
const REVIEW_OPEN_PATH = document.getElementById('review-meta')?.dataset.openPath || '';
var diffImportOpenPaths = Object.create(null);

var REVIEW_FOCUS_PANEL_SELECTOR = [
  '.activity-rail', '.sidebar', '.content', '#diff2html-container', '.source-body',
  '.semantic-peek', '.history-list',
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
function flashReviewPanelFocus(node, force) {
  var panel = reviewFocusPanelFor(node);
  if (!panel || panel.classList.contains('hidden')) return;
  panel.setAttribute('data-mc-focus-panel', 'true');
  if (reviewFocusInputModality === 'pointer') return;
  if (!force && reviewFocusedPanel === panel && panel.isConnected) return;
  if (reviewFocusedPanel) reviewFocusedPanel.classList.remove('mc-panel-focus-flash');
  if (reviewFocusFlashTimer) clearTimeout(reviewFocusFlashTimer);
  reviewFocusedPanel = panel;
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
document.addEventListener('mousedown', function (event) {
  reviewFocusInputModality = 'pointer';
  clearReviewPanelFocusFlash();
}, true);
document.addEventListener('focusin', function (event) { flashReviewPanelFocus(event.target); }, true);

// Main hands keyboard focus back to the page with webContents.focus() — closing a dialog, re-activating
// the app. That restores the PAGE's focus while the focused ELEMENT never changes, so the renderer has no
// new input state to publish, and macOS' input method — which dropped this field when the window lost
// focus — stops composing into it: every keystroke commits on its own and 한글 arrives as ㅎ ㅏ ㄴ instead
// of 한. Only a real element focus change re-binds it, which is exactly why clicking another field and back
// fixed it by hand. Do that round trip here instead, for every composer alike.
// The blur and the focus must land in DIFFERENT frames: within one, the state at frame end is the state it
// started with and nothing is published — the whole point of the round trip.
// Inputs and textareas only — a contenteditable's blur can commit an edit behind the user's back.
window.addEventListener('focus', function () {
  var refocusEl = document.activeElement;
  if (!refocusEl || (refocusEl.tagName !== 'TEXTAREA' && refocusEl.tagName !== 'INPUT')) return;
  try { refocusEl.blur(); } catch (e) {}
  requestAnimationFrame(function () {
    var landed = document.activeElement;
    if (!refocusEl.isConnected || (landed && landed !== document.body)) return;
    try { refocusEl.focus({ preventScroll: true }); } catch (e) { try { refocusEl.focus(); } catch (ignore) {} }
  });
});

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
  return t(kind === 'imports' ? 'fold.imports' : 'fold.block', { count: count || 0 });
}
function codeFoldExpandTitle() {
  return t('fold.expand');
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
  var path = diffWrapperPathKey(wrapper);
  if (path && diffImportOpenPaths[path]) return;
  var oldLines = oldRows.map(function (row) { return isDiffCodeRow(row) ? diffLineText(row) : null; });
  var newLines = newRows.map(function (row) { return isDiffCodeRow(row) ? diffLineText(row) : null; });
  var oldRange = findImportRange(oldLines), newRange = findImportRange(newLines);
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
  var path = diffWrapperPathKey(wrapper);
  if (path) diffImportOpenPaths[path] = true;
  clearSelectedDiffFold();
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
  return t(key, { count: count || 0 });
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
  row.setAttribute('aria-hidden', 'true');
  delete row.dataset.contextHunk;
  delete row.dataset.contextLoading;
  ['contextOldStart', 'contextOldEnd', 'contextNewStart', 'contextNewEnd'].forEach(function (key) { delete row.dataset[key]; });
  var line = row.querySelector('.d2h-code-side-line');
  if (line) line.textContent = '';
}
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
  clearSelectedDiffFold();
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
    refreshComments();
    syncDiffReviewChrome(request.path);
  }).catch(function () {
    peers.forEach(function (peer) { delete peer.dataset.contextLoading; }); refreshDiffContextFoldLabels();
    showToast(diffContextMessage('diff.contextUnavailable'));
  });
}

function markWrapperHunks(wrapper) {
  var base = parseInt(wrapper.dataset.firstHunk || '0', 10) || 0;
  var fileName = diffWrapperPathKey(wrapper);
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
var bodyCache = {};
var bodyPromise = {};
function loadBodyHtml(index) {
  if (bodyCache[index]) return Promise.resolve(bodyCache[index]);
  var p;
  if (typeof window !== 'undefined' && window.kakapoFile && typeof window.kakapoFile.get === 'function') {
    p = Promise.resolve().then(function () { return window.kakapoFile.get(Number(index), 'diff'); });
  } else if (typeof fetch !== 'undefined') {
    p = fetch('file?index=' + index).then(function (r) { return r.ok ? r.text() : ''; });
  } else {
    p = Promise.resolve('');
  }
  return p.then(function (html) { if (html) bodyCache[index] = html; return html || ''; }, function () { return ''; });
}
function materializeBody(wrapper, html) {
  var body = wrapper.querySelector('.d2h-files-diff[data-lazy]');
  if (!body) return;
  body.removeAttribute('data-loading');
  if (!html) return;
  body.innerHTML = html;
  body.removeAttribute('data-lazy');
  delete bodyCache[(wrapper.id || '').replace('file-', '')];
  invalidateDiffRows(wrapper);
  markWrapperHunks(wrapper);
  if (diffBootDone && typeof reviewComments !== 'undefined' && reviewComments.length) { try { refreshComments(); } catch (e) {} }
}
function ensureFileReady(wrapper) {
  if (!wrapper) return null;
  var body = wrapper.querySelector('.d2h-files-diff[data-lazy]');
  if (!body) return wrapper;
  var idx = (wrapper.id || '').replace('file-', '');
  if (REVIEW_LAZY_LOAD) {
    if (!bodyPromise[idx]) {
      body.setAttribute('data-loading', '1');
      bodyPromise[idx] = loadBodyHtml(idx).then(function (html) {
        materializeBody(wrapper, html);
        if (!html) delete bodyPromise[idx];
        return wrapper;
      });
    }
    return wrapper;
  }
  var island = document.getElementById('diff-body-' + idx);
  if (island) materializeBody(wrapper, island.textContent || '');
  return wrapper;
}
function whenFileReady(wrapper, cb) {
  if (!wrapper) { cb(); return; }
  ensureFileReady(wrapper);
  var body = wrapper.querySelector('.d2h-files-diff');
  if (!body || !body.hasAttribute('data-lazy')) { cb(); return; }
  var idx = (wrapper.id || '').replace('file-', '');
  if (bodyPromise[idx]) { bodyPromise[idx].then(function () { cb(); }); return; }
  cb();
}
function setupLazyDiff() {
  var container = document.getElementById('diff2html-container');
  if (!container) return;
  ensureFileReady(container.querySelector('.d2h-file-wrapper'));
}
if (REVIEW_LAZY) { setupLazyDiff(); setTimeout(function () { diffBootDone = true; }, 0); }
let links = Array.from(document.querySelectorAll('#changes-panel .file-link'));
let sourceLinks = Array.from(document.querySelectorAll('.source-link'));
let sourceFiles = JSON.parse(document.getElementById('source-files-data')?.textContent || '[]');
var I18N = JSON.parse(document.getElementById('i18n-data')?.textContent || '{}');
var persistWrittenHere = {};
function persistRead(key) {
  if (key in persistWrittenHere) return persistWrittenHere[key];
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
  persistWrittenHere[key] = value;
  try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) {}
  try { if (window.kakapoSettings) window.kakapoSettings.set(key, value); } catch (e2) {}
}
var LOCALE_KEY = 'kakapo-locale';
var locale = (function () {
  var v = persistRead(LOCALE_KEY);
  if (v !== 'ko' && v !== 'en') { try { v = localStorage.getItem(LOCALE_KEY); } catch (e) {} }
  return (v === 'ko' || v === 'en') ? v : 'en';
})();
function t(key, values) {
  var all = (typeof I18N !== 'undefined' && I18N) || {};
  var table = all[locale] || all.en || {};
  var text = String((key in table) ? table[key] : ((all.en && all.en[key]) || key));
  if (!values) return text;
  var chosen = text.replace(/\{\{(\w+):([^|{}]*)\|([^|{}]*)\}\}/g, function (_whole, name, one, many) {
    return Number(values[name]) === 1 ? one : many;
  });
  return chosen.replace(/\{(\w+)\}/g, function (whole, name) {
    return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole;
  });
}
function resultsLabel(shown) {
  return t('quickopen.results', { n: shown });
}
// A panel that wants a chord the application menu owns — ⌘A over cards rather than page text, every key
// at once while a shortcut is being recorded — asks main to ignore menu accelerators. That switch is the
// whole window: while it is on, ⌘V, ⌘X and ⌘Z reach nothing, because the page implements none of them. It
// was held per panel, each with its own flag and its own idea of when to let go, and the dock's idea was
// "until I close" — so an open dock killed pasting into the find box, into a composer, into any field.
//
// So no panel holds it. A panel declares that it is up, and this decides: the chords are taken only while
// no caret is in a field, where every one of them belongs to the field instead. Recording a shortcut is
// the one case that needs them while typing, and says so by name.
var menuChordClaims = [];
var menuChordsHeld = false;
function claimsMenuChords(name, isUp, options) {
  menuChordClaims.push({ name: name, isUp: isUp, takesFieldEditingKeys: !!(options && options.takesFieldEditingKeys) });
  syncMenuChords();
}
function menuChordsWanted() {
  var active = document.activeElement;
  var typing = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
  for (var i = 0; i < menuChordClaims.length; i += 1) {
    var claim = menuChordClaims[i];
    if (claim.isUp() && (claim.takesFieldEditingKeys || !typing)) return true;
  }
  return false;
}
function syncMenuChords() {
  var wanted = menuChordsWanted();
  if (wanted === menuChordsHeld) return;
  menuChordsHeld = wanted;
  if (window.kakapoApp && typeof window.kakapoApp.setIgnoreMenuShortcuts === 'function') {
    window.kakapoApp.setIgnoreMenuShortcuts(wanted);
  }
}
function afterFocusSettles(run) { setTimeout(run, 0); }
function layoutRectOf(range) {
  return typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
}
function placeCaretSpan(span, cell, range) {
  span.classList.add('code-cursor-placed');
  cell.appendChild(span);
  var at = layoutRectOf(range);
  if (!at) return span;
  var box = cell.getBoundingClientRect();
  span.style.left = (at.left - box.left + cell.scrollLeft) + 'px';
  span.style.top = (at.top - box.top + cell.scrollTop) + 'px';
  return span;
}
document.addEventListener('focusin', function () { syncMenuChords(); });
document.addEventListener('focusout', function () { afterFocusSettles(syncMenuChords); });
var langSelectRef = null, themeSelectRef = null, syntaxThemeSelectRef = null;
var localizedPaints = [];
function registerLocalizedPaint(ref) {
  if (ref && typeof ref.render === 'function' && localizedPaints.indexOf(ref) < 0) localizedPaints.push(ref);
  return ref;
}
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
    }), r.top - 4, undefined, el);
  });
  render();
  return registerLocalizedPaint({ render: render });
}
function applyKeyHints(root) {
  (root || document).querySelectorAll('[data-keyhint-id]').forEach(function (el) {
    var ref = el.getAttribute('data-keyhint-id').split(':');
    var chord = shortcutKeys(ref[0])[Number(ref[1] || 0)];
    if (!chord) return;
    el.setAttribute('data-keyhint', chord);
    var titleKey = el.getAttribute('data-i18n-title');
    if (titleKey) el.setAttribute('title', t(titleKey) + ' (' + chord + ')');
  });
}
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  document.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  applyKeyHints(document);
  document.documentElement.lang = locale;
  localizedPaints.forEach(function (ref) { try { ref.render(); } catch (e) {} });
  refreshDiffContextFoldLabels();
  refreshCodeFoldLabels();
  paintDiffFileCollapse();
  paintTreeRowAriaLabels();
  renderCommentBadges();
  paintAnalysisStatusTitle();
  repaintUpdateStatus();
  paintComparePillTitle();
  paintQuickOpenMode();
  forgetFindActionItems();
  syncDiffReviewChrome();
}
var THEME_KEY = 'kakapo-theme';
var theme = (function () {
  var v = persistRead(THEME_KEY);
  if (v !== 'light' && v !== 'dark' && v !== 'system') { try { v = localStorage.getItem(THEME_KEY); } catch (e) {} }
  if (v === 'system') {
    var dark = true;
    try { dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) {}
    v = dark ? 'dark' : 'light';
    persistSave(THEME_KEY, v);
  }
  return v === 'light' ? 'light' : 'dark';
})();
function resolvedTheme() { return theme === 'light' ? 'light' : 'dark'; }
function applyTheme() {
  beginDiffViewportChurn();
  document.documentElement.setAttribute('data-theme', resolvedTheme());
  if (themeSelectRef) themeSelectRef.render();
}
applyTheme();
var DIFF_HIGHLIGHT_KEY = 'kakapo-diff-highlight';
var DIFF_HIGHLIGHT_MODES = ['word', 'line', 'none'];
var diffHighlightSelectRef = null;
var diffHighlightMode = (function () {
  var saved = persistRead(DIFF_HIGHLIGHT_KEY);
  if (typeof saved !== 'string') { try { saved = localStorage.getItem(DIFF_HIGHLIGHT_KEY) || ''; } catch (e) { saved = ''; } }
  return DIFF_HIGHLIGHT_MODES.indexOf(saved) >= 0 ? saved : 'word';
})();
function applyDiffHighlight(next) {
  if (DIFF_HIGHLIGHT_MODES.indexOf(next) < 0) return;
  diffHighlightMode = next;
  persistSave(DIFF_HIGHLIGHT_KEY, diffHighlightMode);
  document.documentElement.setAttribute('data-diff-highlight', diffHighlightMode);
  if (diffHighlightSelectRef) diffHighlightSelectRef.render();
}
applyDiffHighlight(diffHighlightMode);

var RENDER_TOGGLES = {
  showWhitespace: { key: 'kakapo-show-whitespace', attr: 'data-show-whitespace', on: false },
  indentGuides: { key: 'kakapo-indent-guides', attr: 'data-indent-guides', on: false },
  stickyLines: { key: 'kakapo-sticky-lines', attr: 'data-sticky-lines', on: true },
  focusMode: { key: 'kakapo-focus-mode', attr: 'data-focus-mode', on: false },
  essentialHighlighting: { key: 'kakapo-essential-highlighting', attr: 'data-essential-highlighting', on: false },
  alignChanges: { key: 'kakapo-align-changes', attr: 'data-align-changes', on: true },
  codeVision: { key: 'kakapo-code-vision', attr: 'data-code-vision', on: true },
  inlayHints: { key: 'kakapo-inlay-hints', attr: 'data-inlay-hints', on: true },
};
Object.keys(RENDER_TOGGLES).forEach(function (name) {
  var entry = RENDER_TOGGLES[name];
  var saved = persistRead(entry.key);
  if (typeof saved !== 'string') { try { saved = localStorage.getItem(entry.key); } catch (e) {} }
  if (saved === '1' || saved === '0') entry.on = saved === '1';
});
function isCodeSurfaceVisible() {
  return isSourceViewerVisible() || isDiffViewVisible();
}
function renderToggleOn(name) {
  var entry = RENDER_TOGGLES[name];
  return Boolean(entry && entry.on);
}
function paintRenderToggle(name) {
  var entry = RENDER_TOGGLES[name];
  if (!entry) return;
  document.documentElement.setAttribute(entry.attr, entry.on ? 'on' : 'off');
}
function setRenderToggle(name, on) {
  var entry = RENDER_TOGGLES[name];
  if (!entry) return false;
  entry.on = Boolean(on);
  persistSave(entry.key, entry.on ? '1' : '0');
  paintRenderToggle(name);
  if (name === 'stickyLines') refreshStickyLines();
  if (name === 'focusMode') refreshFocusMode();
  if (name === 'alignChanges') refreshDiffAlignment();
  if (name === 'essentialHighlighting') refreshDiagnosticsFilter();
  if (name === 'codeVision' || name === 'inlayHints') paintSourceDecorations();
  return true;
}
function toggleRenderToggle(name) {
  return setRenderToggle(name, !renderToggleOn(name));
}
Object.keys(RENDER_TOGGLES).forEach(paintRenderToggle);

var UI_SCALE_KEY = 'kakapo-ui-scale';
var UI_SCALES = [0.9, 1, 1.1, 1.25, 1.5];
var uiScaleSelectRef = null;
var uiScale = (function () {
  var v = Number(persistRead(UI_SCALE_KEY));
  if (!isFinite(v) || v <= 0) { try { v = Number(localStorage.getItem(UI_SCALE_KEY)); } catch (e) {} }
  return UI_SCALES.indexOf(v) >= 0 ? v : 1;
})();
function paintUiScale() {
  beginDiffViewportChurn();
  if (window.kakapoSettings) return;
  try { document.documentElement.style.zoom = uiScale === 1 ? '' : String(uiScale); } catch (e) {}
}
function applyUiScale(next) {
  if (UI_SCALES.indexOf(next) < 0) return;
  uiScale = next;
  persistSave(UI_SCALE_KEY, next);
  paintUiScale();
  if (uiScaleSelectRef) uiScaleSelectRef.render();
}
if (window.kakapoMenu && typeof window.kakapoMenu.onUiScale === 'function') {
  window.kakapoMenu.onUiScale(function (next) {
    if (UI_SCALES.indexOf(next) < 0) return;
    noteKakapoActivity('zoom');
    beginDiffViewportChurn();
    uiScale = next;
    if (uiScaleSelectRef) uiScaleSelectRef.render();
  });
}
paintUiScale();
var SYNTAX_THEME_KEY = 'kakapo-syntax-theme';
var SYNTAX_FAMILIES = ['default', 'darcula', 'github', 'solarized', 'dracula', 'contrast'];
var syntaxTheme = (function () {
  var v = persistRead(SYNTAX_THEME_KEY);
  if (SYNTAX_FAMILIES.indexOf(v) < 0) { try { v = localStorage.getItem(SYNTAX_THEME_KEY); } catch (e) {} }
  return SYNTAX_FAMILIES.indexOf(v) >= 0 ? v : 'default';
})();
function applySyntaxTheme() {
  beginDiffViewportChurn();
  document.documentElement.setAttribute('data-syntax-theme', syntaxTheme);
  if (syntaxThemeSelectRef) syntaxThemeSelectRef.render();
}
applySyntaxTheme();
let fileStates = JSON.parse(document.getElementById('file-state-data')?.textContent || '[]');
let httpEnvironments = JSON.parse(document.getElementById('http-env-data')?.textContent || '{}');
let httpEnvNames = Object.keys(httpEnvironments).filter(function (name) { return name.charAt(0) !== '$'; });
const httpEnvKey = 'kakapo-http-env:' + location.pathname;
const httpRequestsByPath = new Map();
const httpVarsByPath = new Map();
const httpImportsByPath = new Map();
const httpRunStack = [];
const httpGlobalsKey = 'kakapo-http-globals:' + location.pathname;
let httpGlobals = (function () {
  const saved = persistRead(httpGlobalsKey);
  return saved && typeof saved === 'object' ? saved : {};
})();
const httpRequestVars = new Map();
const httpResponsesByName = new Map();
const httpScriptLogByRequest = new Map();
let sourceByPath = rebuildSourceByPath(sourceFiles, new Map());
var projectIndexLoaded = !REVIEW_LAZY_LOAD;
var projectIndexPromise = null;
var projectIndexPayload = null;

function rebuildSourceByPath(records, previous) {
  var next = new Map(records.map(function (file) { return [file.path, file]; }));
  previous.forEach(function (file, path) {
    if (file && file.library && !next.has(path)) next.set(path, file);
  });
  return next;
}

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
  sourceByPath = rebuildSourceByPath(records, previousByPath);
  if (Array.isArray(payload.fileStates) && payload.fileStates.length) {
    fileStates = payload.fileStates.slice();
    fileSignatureByPath = new Map(fileStates.map(function (file) { return [file.path, file.signature]; }));
  } else {
    records.forEach(function (file) {
      if (!fileSignatureByPath.has(file.path)) fileSignatureByPath.set(file.path, '');
    });
  }
  projectIndexLoaded = true;
  projectIndexPayload = payload;
  if (pruneCommentsForMissingFiles()) refreshComments();
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
sourceFiles.forEach(function (file) { file.__loaded = !REVIEW_LAZY_LOAD || !file.embedded; });
var sourceLoadPromises = Object.create(null);
var bulkSourcePromise = null;
var sourceGeneration = 0;
var sourceBodyPath = null;
function sourceOpenPath() {
  var viewer = document.getElementById('source-viewer');
  return (viewer && viewer.dataset.openPath) || '';
}
var sourceTabs = [];
var sourceImportOpenPaths = Object.create(null);
var sourceManualFoldKeys = Object.create(null);
function sourceContentLoaded(file) {
  return Boolean(file && (!REVIEW_LAZY_LOAD || !file.embedded || file.__loaded));
}
function mergeSourceRecord(record) {
  if (!record || !record.path) return null;
  var file = sourceByPath.get(record.path);
  if (!file) return null;
  Object.assign(file, record);
  file.content = String(record.content || '');
  file.__loaded = true;
  return file;
}
var libraryLoadPromises = Object.create(null);
function loadLibrarySourceFile(path) {
  if (sourceByPath.has(path)) return Promise.resolve(sourceByPath.get(path));
  if (libraryLoadPromises[path]) return libraryLoadPromises[path];
  if (!(typeof window !== 'undefined' && window.kakapoFile && typeof window.kakapoFile.getSource === 'function')) {
    return Promise.resolve(null);
  }
  var promise = Promise.resolve()
    .then(function () { return window.kakapoFile.getSource(path); })
    .then(function (record) {
      if (!record || !record.path) { delete libraryLoadPromises[path]; return null; }
      record.__loaded = true;
      sourceByPath.set(record.path, record);
      return sourceByPath.get(path) || null;
    }, function () { delete libraryLoadPromises[path]; return null; });
  libraryLoadPromises[path] = promise;
  return promise;
}
function isLibrarySourcePath(path) {
  var file = sourceByPath.get(path);
  return Boolean(file && file.library);
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
      var merged = mergeSourceRecord(record);
      if (!merged) file.__loaded = true;
      return merged || file;
    });
  } else {
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
const quickMatchCaseButton = document.getElementById('quick-open-match-case');
const quickWholeWordsButton = document.getElementById('quick-open-whole-words');
const quickRegexButton = document.getElementById('quick-open-regex');
const quickScopeSelect = document.getElementById('quick-open-scope');
let current = -1;
let checkingForUpdates = false;
let quickMode = 'all';
let quickItems = [];
let quickActive = 0;

function clampQuickActive() {
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
}
function setQuickFilterChip(busy, label, busyLabel) {
  if (!quickFilterEl) return;
  quickFilterEl.className = 'quick-open-filter' + (busy ? ' is-loading' : '');
  quickFilterEl.innerHTML = busy
    ? kakapoLoaderHtml('kakapo-loader-micro') + '<span>' + escapeHtml(busyLabel || t('quickopen.searching')) + '</span>'
    : escapeHtml(label);
}
function showQuickLoading() {
  if (quickResults) quickResults.innerHTML = loadingStateHtml(t('quickopen.searching'), 'quick-open-empty');
  renderQuickPreview(null);
}
function showQuickEmpty(text, note) {
  if (quickResults) {
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(text)
      + (note ? '<span class="quick-open-why">' + escapeHtml(note) + '</span>' : '') + '</div>';
  }
  renderQuickPreview(null);
}
let recentFilter = '';
let contentSearchItems = [];
let contentSearchQuery = '';
let contentSearchSeq = 0;
let contentSearchTimer = null;
let contentSearchBusy = false;
let contentSearchTruncated = false;
let contentSearchEngine = 'local';
let contentSearchExcludeNoise = false;
let contentSearchMatchCase = false;
let contentSearchWholeWords = false;
let contentSearchRegex = false;
let contentSearchScope = 'all';
let workspaceSymbolItems = [];
let workspaceSymbolQuery = '';
let workspaceSymbolSeq = 0;
let workspaceSymbolTimer = null;
let workspaceSymbolBusy = false;
let workspaceSymbolEngine = 'index';
let workspaceSymbolTypesOnly = false;
let usageItems = [];
let usageActive = 0;
let viewerCursor = null;
let selectedCommentRow = null;
let selectedDiffFoldRow = null;
let currentHttpEnvName = (function () {
  let saved = persistRead(httpEnvKey);
  if (typeof saved !== 'string') { try { saved = localStorage.getItem(httpEnvKey) || ''; } catch (error) { saved = ''; } }
  if (saved && httpEnvNames.indexOf(saved) >= 0) return saved;
  return httpEnvNames.length ? httpEnvNames[0] : '';
})();
let treeFocusIndex = -1;
let selectionAnchor = null;
let diffCursor = null;
let navList = [];
let navPos = -1;
let navSuppress = false;
var NAV_JUMP_LINES = 8;
var NAV_MAX = 60;
let diffSelectionAnchor = null;
let measuredCharWidth = 0;

var COMMENTS_KEY = 'kakapo-comments:' + location.pathname;
var reviewComments = [];
reviewComments = (function () { var b = persistRead(COMMENTS_KEY); if (Array.isArray(b)) return b; try { return JSON.parse(localStorage.getItem(COMMENTS_KEY) || '[]'); } catch (commentsErr) { return []; } })();
if (!Array.isArray(reviewComments)) reviewComments = [];
var archivedComments = [];
reviewComments.forEach(function (c) { if (c && c.kind !== 'note') c.kind = 'c'; });
var commentSeq = reviewComments.reduce(function (max, c) { return Math.max(max, c.seq || 0); }, 0);
var composerState = null;

function prepareDiff2HtmlHunks() {
  const wrappers = Array.from(document.querySelectorAll('.d2h-file-wrapper'));
  let globalHunkIndex = 0;
  wrappers.forEach((wrapper, fileIndex) => {
    wrapper.id = 'file-' + fileIndex;
    const fileName = diffWrapperPathKey(wrapper);
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
  var runButton = event.target && event.target.closest ? event.target.closest('.http-run-diff') : null;
  if (runButton) {
    event.preventDefault();
    event.stopPropagation();
    runDiffHttpRequest(runButton);
    return;
  }
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
  return Boolean(signature && typeof viewed[path] === 'string' && viewed[path] === signature);
}

function setFileViewed(path, viewed) {
  const state = loadViewedState();
  if (viewed) {
    const signature = currentFileSignature(path);
    if (signature) state[path] = signature;
  }
  else delete state[path];
  saveViewedState(state);
  applyViewedState();
}

function applyViewedState() {
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    const fileName = diffWrapperPathKey(wrapper);
    const viewed = isFileViewed(fileName);
    wrapper.classList.toggle('file-viewed', viewed);
  });
  links.forEach((link) => {
    const viewed = isFileViewed(link.dataset.file || '');
    link.classList.toggle('viewed', viewed);
    link.querySelector('.viewed-box')?.setAttribute('aria-checked', viewed ? 'true' : 'false');
  });
}

let activeDiffRow = null;
