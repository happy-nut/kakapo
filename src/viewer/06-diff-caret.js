function isDiffViewVisible() {
  var d = document.getElementById('diff-view');
  return Boolean(d && !d.classList.contains('hidden'));
}
function diffActiveWrapper() {
  return document.querySelector('#diff2html-container .d2h-file-wrapper:not(.df-inactive)')
    || document.querySelector('#diff2html-container .d2h-file-wrapper');
}
var wrapperPathMap = null;
function diffWrapperPathKey(w) {
  return (w.dataset && w.dataset.path) || ((w.querySelector('.d2h-file-name') || {}).textContent || '').trim();
}
function diffWrapperByPath(path) {
  if (wrapperPathMap) {
    var hit = wrapperPathMap.get(path);
    if (hit && hit.isConnected) return hit;
  }
  wrapperPathMap = new Map();
  var ws = document.querySelectorAll('#diff2html-container .d2h-file-wrapper');
  for (var i = 0; i < ws.length; i++) {
    var key = diffWrapperPathKey(ws[i]);
    if (key) wrapperPathMap.set(key, ws[i]);
  }
  return wrapperPathMap.get(path) || null;
}
function diffSideTables(wrapper) {
  var sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  return { left: sides[0] || null, right: sides[sides.length - 1] || null };
}
function diffSideTable(wrapper, side) {
  var t = diffSideTables(wrapper);
  return side === 'old' ? t.left : t.right;
}
var diffRowsCache;
function diffRowsOf(sideTable) {
  if (!sideTable) return [];
  if (!diffRowsCache) diffRowsCache = new WeakMap();
  var cached = diffRowsCache.get(sideTable);
  if (cached) return cached;
  var rows = Array.prototype.slice.call(sideTable.querySelectorAll('tr')).filter(function (r) {
    return !r.classList.contains('mc-comment-row') && !r.classList.contains('mc-spacer-row');
  });
  diffRowsCache.set(sideTable, rows);
  return rows;
}
var diffLineIndexCache;
function diffLineIndexOf(sideTable) {
  if (!sideTable) return null;
  if (!diffLineIndexCache) diffLineIndexCache = new WeakMap();
  var cached = diffLineIndexCache.get(sideTable);
  if (cached) return cached;
  var rows = diffRowsOf(sideTable);
  var index = new Map();
  for (var i = 0; i < rows.length; i++) {
    var line = diffLineNumber(rows[i]);
    if (line != null && !index.has(line)) index.set(line, i);
  }
  diffLineIndexCache.set(sideTable, index);
  return index;
}
function invalidateDiffRows(root) {
  if (!root) return;
  var drop = function (table) {
    if (diffRowsCache) diffRowsCache.delete(table);
    if (diffLineIndexCache) diffLineIndexCache.delete(table);
  };
  if (root.classList && root.classList.contains('d2h-file-side-diff')) drop(root);
  if (root.querySelectorAll) root.querySelectorAll('.d2h-file-side-diff').forEach(drop);
}
function diffRowAt(wrapper, side, rowIndex) {
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  return rows[rowIndex] || null;
}
function diffRowIndexForLine(wrapper, side, line) {
  var index = diffLineIndexOf(diffSideTable(wrapper, side));
  if (!index) return -1;
  var at = index.get(line);
  return at === undefined ? -1 : at;
}
function diffCellCtn(row) {
  return row ? row.querySelector('.d2h-code-line-ctn') : null;
}
function diffLineText(row) {
  var ctn = diffCellCtn(row);
  return ctn ? (ctn.textContent || '') : '';
}
function diffLineNumber(row) {
  var n = row ? row.querySelector('.d2h-code-side-linenumber') : null;
  var v = n ? parseInt((n.textContent || '').trim(), 10) : NaN;
  return isFinite(v) ? v : null;
}
function diffRowInfoFromNode(node) {
  var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  if (!el || !el.closest) return null;
  var wrapper = el.closest('.d2h-file-wrapper');
  var sideEl = el.closest('.d2h-file-side-diff');
  var row = el.closest('tr');
  if (!wrapper || !sideEl || !row) return null;
  var path = diffWrapperPathKey(wrapper);
  var t = diffSideTables(wrapper);
  var side = sideEl === t.left ? 'old' : 'new';
  if (!isDiffCodeRow(row)) return null;
  var rowIndex = diffRowsOf(sideEl).indexOf(row);
  if (!path || rowIndex < 0) return null;
  return { path: path, side: side, rowIndex: rowIndex };
}
function diffCaretDomPosition(ctn, column) {
  if (!ctn) return null;
  var remaining = column;
  var walker = sourceTextWalker(ctn);
  var node;
  while ((node = walker.nextNode())) {
    var len = node.textContent.length;
    if (remaining <= len) return { node: node, offset: remaining };
    remaining -= len;
  }
  return { node: ctn, offset: ctn.childNodes.length };
}
function codeWordBounds(text, column) {
  var value = String(text || '');
  if (!value.length) return null;
  var at = Math.max(0, Math.min(Number(column) || 0, value.length - 1));
  var isWord = function (char) { return /[$_\p{L}\p{N}\p{M}]/u.test(char || ''); };
  if (!isWord(value[at]) && at > 0 && isWord(value[at - 1])) at -= 1;
  if (!isWord(value[at])) return { start: at, end: Math.min(value.length, at + 1) };
  var start = at, end = at + 1;
  while (start > 0 && isWord(value[start - 1])) start -= 1;
  while (end < value.length && isWord(value[end])) end += 1;
  return { start: start, end: end };
}
function selectCodeWord(container, text, column) {
  if (!container) return false;
  var bounds = codeWordBounds(text, column);
  if (bounds && selectedText().length > bounds.end - bounds.start) return false;
  container.querySelectorAll('.code-cursor').forEach(function (span) {
    var parent = span.parentNode;
    if (parent) { parent.removeChild(span); if (parent.normalize) parent.normalize(); }
  });
  if (diffCaretSpan && !diffCaretSpan.isConnected) diffCaretSpan = null;
  var start = bounds && diffCaretDomPosition(container, bounds.start);
  var end = bounds && diffCaretDomPosition(container, bounds.end);
  var selection = window.getSelection && window.getSelection();
  if (!bounds || !start || !end || !selection) return false;
  try {
    var range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch (e) { return false; }
}
var diffCaretSpan = null;
function clearDiffCaret() {
  var container = document.getElementById('diff2html-container');
  if (container) {
    container.querySelectorAll('.mc-diff-cursor-row').forEach(function (r) { r.classList.remove('mc-diff-cursor-row'); });
    container.querySelectorAll('.code-cursor').forEach(function (s) { var p = s.parentNode; if (p) { p.removeChild(s); if (p.normalize) p.normalize(); } });
  }
  diffCaretSpan = null;
}
function renderDiffCaret() {
  clearDiffCaret();
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  if (!row) return;
  row.classList.add('mc-diff-cursor-row');
  var ctn = diffCellCtn(row);
  if (!ctn) return;
  if ((ctn.textContent || '').length === 0) {
    var espan = document.createElement('span');
    espan.className = 'code-cursor code-cursor-empty';
    espan.setAttribute('aria-hidden', 'true');
    ctn.appendChild(espan);
    diffCaretSpan = espan;
    return;
  }
  var pos = diffCaretDomPosition(ctn, diffCursor.column);
  if (!pos) return;
  var span = document.createElement('span');
  span.className = 'code-cursor';
  span.setAttribute('aria-hidden', 'true');
  try {
    var off = pos.node.nodeType === 3 ? Math.min(pos.offset, (pos.node.textContent || '').length) : pos.offset;
    var range = document.createRange();
    range.setStart(pos.node, off);
    range.collapse(true);
    range.insertNode(span);
    diffCaretSpan = span;
  } catch (e) { diffCaretSpan = null; }
}
function setDiffCursor(path, side, rowIndex, column, reveal) {
  markCaretBusy();
  clearSelectedDiffFold();
  var wrapper = diffWrapperByPath(path);
  if (!wrapper) return;
  if (wrapper.classList && wrapper.classList.contains('df-inactive')) revealDiffFile(path);
  if (wrapper.classList && wrapper.classList.contains('file-collapsed')) {
    delete diffCollapsedFileSet()[path];
    paintDiffFileCollapse();
  }
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  if (!rows.length) return;
  flashReviewPanelFocus(document.getElementById('diff2html-container'));
  var ri = Math.max(0, Math.min(rowIndex, rows.length - 1));
  var col = Math.max(0, Math.min(column, diffLineText(rows[ri]).length));
  diffCursor = { path: path, side: side, rowIndex: ri, column: col };
  syncActiveDiffHunk(hunkIndexAtCaret());
  syncDiffReviewChrome(path);
  pendingFileBoundary = null;
  hideCaretHint();
  diffSelectionAnchor = null;
  if (reveal) {
    scheduleDiffReveal(wrapper, side, ri);
  } else {
    renderDiffCaret();
    applyDiffSelection();
  }
  recordNav(navEntryOf('diff'));
}
var diffRevealRaf = 0, diffRevealTarget = null;
function scheduleDiffReveal(wrapper, side, ri) {
  diffRevealTarget = { wrapper: wrapper, side: side, ri: ri };
  if (diffRevealRaf) return;
  diffRevealRaf = requestAnimationFrame(function () {
    diffRevealRaf = 0;
    var t = diffRevealTarget; diffRevealTarget = null;
    renderDiffCaret();
    applyDiffSelection();
    repositionCaretHint();
    if (!t) return;
    var row = diffRowAt(t.wrapper, t.side, t.ri);
    scrolloffReveal(row, document.getElementById('diff2html-container'), 0.15);
    revealCaretColumn(diffCaretSpan);
  });
}
function navEntryOf(kind) {
  if (kind === 'diff') {
    if (!diffCursor) return null;
    return { kind: 'diff', path: diffCursor.path, side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column, line: diffCursor.rowIndex };
  }
  if (!viewerCursor) return null;
  return { kind: 'source', path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: viewerCursor.column, line: viewerCursor.lineIndex };
}
function navSamePos(a, b) {
  return !!(a && b && a.kind === b.kind && a.path === b.path && a.line === b.line && (a.kind !== 'diff' || a.side === b.side));
}
function recordNav(entry) {
  if (navSuppress || !entry) return;
  var cur = navPos >= 0 ? navList[navPos] : null;
  if (navSamePos(cur, entry)) { navList[navPos] = entry; return; }
  var small = cur && cur.kind === entry.kind && cur.path === entry.path && Math.abs(cur.line - entry.line) < NAV_JUMP_LINES;
  if (small) { navList[navPos] = entry; return; }
  navList = navList.slice(0, navPos + 1);
  navList.push(entry);
  navPos = navList.length - 1;
  if (navList.length > NAV_MAX) { navList.shift(); navPos -= 1; }
}
function revealDiffFile(path) {
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  setTab('changes');
  showOnlyFile(path);
  links.forEach(function (link) { link.classList.toggle('active', link.dataset.file === path); });
  syncDiffReviewChrome(path);
}
function restoreNav(entry) {
  if (!entry) return;
  navSuppress = true;
  try {
    if (entry.kind === 'diff') {
      revealDiffFile(entry.path);
      setDiffCursor(entry.path, entry.side, entry.rowIndex, entry.column, true);
    } else {
      setSourceCursor(entry.path, entry.lineIndex, entry.column, true, -1);
    }
  } finally {
    navSuppress = false;
  }
}
function navBack() {
  if (navPos < 0) return;
  var live = navEntryOf(isSourceViewerVisible() ? 'source' : 'diff');
  if (live && !navSamePos(live, navList[navPos])) { restoreNav(navList[navPos]); return true; }
  if (navPos <= 0) return false;
  navPos -= 1;
  restoreNav(navList[navPos]);
  return true;
}
function navForward() {
  if (navPos >= navList.length - 1) return false;
  navPos += 1;
  restoreNav(navList[navPos]);
  return true;
}
function applyDiffSelection() {
  var sel = window.getSelection();
  if (!sel) return;
  if (!diffSelectionAnchor || !diffCursor || diffSelectionAnchor.side !== diffCursor.side) { try { sel.removeAllRanges(); } catch (e) {} return; }
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) { try { sel.removeAllRanges(); } catch (e) {} return; }
  var aCtn = diffCellCtn(diffRowAt(wrapper, diffSelectionAnchor.side, diffSelectionAnchor.rowIndex));
  var cCtn = diffCellCtn(diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex));
  var a = aCtn ? diffCaretDomPosition(aCtn, diffSelectionAnchor.column) : null;
  var c = cCtn ? diffCaretDomPosition(cCtn, diffCursor.column) : null;
  if (a && c) { try { sel.setBaseAndExtent(a.node, a.offset, c.node, c.offset); } catch (e) {} }
}
function isDiffCodeRow(row) {
  if (!row) return false;
  if (row.classList.contains('mc-import-fold-row') || row.classList.contains('mc-import-fold-hidden')) return false;
  if (row.querySelector('.d2h-emptyplaceholder, .d2h-code-side-emptyplaceholder')) return false;
  if (!row.querySelector('.d2h-code-line-ctn')) return false;
  var num = row.querySelector('.d2h-code-side-linenumber');
  return !!num && (num.textContent || '').trim().length > 0;
}
function firstDiffCodeRow(wrapper, side) {
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  for (var i = 0; i < rows.length; i++) { if (isDiffCodeRow(rows[i])) return i; }
  return -1;
}
function ensureDiffCursor() {
  if (!isDiffViewVisible()) return;
  var wrapper = diffActiveWrapper();
  if (!wrapper) return;
  whenFileReady(wrapper, function () {
    var path = diffWrapperPathKey(wrapper);
    if (!path) return;
    if (diffCursor && diffCursor.path === path) { renderDiffCaret(); return; }
    var ri = firstDiffCodeRow(wrapper, 'new');
    if (ri < 0) return;
    setDiffCursor(path, 'new', ri, 0, false);
  });
}
function moveDiffCursor(dLine, dColumn, extend) {
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var side = diffCursor.side;
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  var ri = diffCursor.rowIndex;
  var col = diffCursor.column;
  var text = diffLineText(rows[ri]);
  var anchor = extend ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column }) : null;
  if (dColumn < 0) {
    if (col > 0) { col -= 1; }
    else {
      var p = ri - 1; while (p >= 0 && !isDiffCodeRow(rows[p])) p -= 1;
      if (p >= 0) { ri = p; col = diffLineText(rows[p]).length; }
    }
  } else if (dColumn > 0) {
    if (col < text.length) { col += 1; }
    else {
      var nx = ri + 1; while (nx < rows.length && !isDiffCodeRow(rows[nx])) nx += 1;
      if (nx < rows.length) { ri = nx; col = 0; }
    }
  }
  if (dLine !== 0) {
    var step = dLine > 0 ? 1 : -1;
    var cand = ri + step;
    while (cand >= 0 && cand < rows.length && !isDiffCodeRow(rows[cand])) cand += step;
    if (cand >= 0 && cand < rows.length) { ri = cand; col = Math.min(col, diffLineText(rows[ri]).length); }
  }
  setDiffCursor(diffCursor.path, side, ri, col, true);
  if (anchor) { diffSelectionAnchor = anchor; applyDiffSelection(); }
}
function moveDiffWord(dir, extend) {
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  var text = diffLineText(row);
  var ncol = nextWordBoundary(text, diffCursor.column, dir);
  if (ncol === diffCursor.column) return;
  var anchor = extend ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column }) : null;
  setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, ncol, true);
  if (anchor) { diffSelectionAnchor = anchor; applyDiffSelection(); }
}
function diffCommentBoxSiblingOf(dir) {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return null;
  var order = diffCursor.side === 'old' ? ['old', 'new'] : ['new', 'old'];
  for (var i = 0; i < order.length; i++) {
    var row = diffRowsOf(diffSideTable(wrapper, order[i]))[diffCursor.rowIndex];
    var sib = row ? (dir < 0 ? row.previousElementSibling : row.nextElementSibling) : null;
    if (sib && sib.classList && sib.classList.contains('mc-comment-row')) return sib;
  }
  return null;
}
function diffFoldBetween(dir) {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  var table = wrapper ? diffSideTable(wrapper, diffCursor.side) : null;
  var rows = diffRowsOf(table);
  var step = dir < 0 ? -1 : 1;
  for (var i = diffCursor.rowIndex + step; i >= 0 && i < rows.length; i += step) {
    if (isDiffCodeRow(rows[i])) return null;
    if (rows[i].classList.contains('mc-context-fold-row') || rows[i].classList.contains('mc-import-fold-row')) return rows[i];
  }
  return null;
}
function clearSelectedDiffFold() {
  if (selectedDiffFoldRow && selectedDiffFoldRow.classList) selectedDiffFoldRow.classList.remove('mc-row-selected');
  selectedDiffFoldRow = null;
}
function selectDiffFold(row) {
  clearSelectedDiffFold();
  if (selectedCommentRow) { selectedCommentRow.classList.remove('mc-row-selected'); selectedCommentRow = null; }
  selectedDiffFoldRow = row || null;
  if (!selectedDiffFoldRow) return;
  selectedDiffFoldRow.classList.add('mc-row-selected');
  scrolloffReveal(selectedDiffFoldRow, document.getElementById('diff2html-container'), 0.15);
}
function moveFromSelectedDiffFold(dir) {
  var row = selectedDiffFoldRow;
  if (!row || !diffCursor) { clearSelectedDiffFold(); return false; }
  var table = row.closest('.d2h-file-side-diff');
  var rows = diffRowsOf(table);
  var at = rows.indexOf(row);
  var step = dir < 0 ? -1 : 1;
  clearSelectedDiffFold();
  for (var i = at + step; i >= 0 && i < rows.length; i += step) {
    if (!isDiffCodeRow(rows[i])) continue;
    setDiffCursor(diffCursor.path, diffCursor.side, i, 0, true);
    return true;
  }
  setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, diffCursor.column, false);
  return true;
}
function handleDiffCaretKey(event) {
  if (!isDiffViewVisible() || !diffCursor) return false;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return false;
  var extend = event.shiftKey;
  if (selectedDiffFoldRow && !selectedDiffFoldRow.isConnected) selectedDiffFoldRow = null;
  if (selectedDiffFoldRow) {
    if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      var fold = selectedDiffFoldRow;
      clearSelectedDiffFold();
      if (fold.classList.contains('mc-import-fold-row')) openDiffImportFold(fold);
      else expandDiffContext(fold);
      return true;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      return moveFromSelectedDiffFold(event.key === 'ArrowUp' ? -1 : 1);
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Escape') {
      event.preventDefault();
      clearSelectedDiffFold();
      setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, diffCursor.column, false);
      return true;
    }
    return false;
  }
  if (selectedCommentRow) {
    return handleSelectedCommentRowKey(event, function (sib) {
      var at = diffRowInfoFromNode(sib);
      if (!at) return false;
      setDiffCursor(at.path, at.side, at.rowIndex, 0, true);
      return true;
    }, function () {
      setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, diffCursor.column, false);
    });
  }
  if (!extend && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    var box = diffCommentBoxSiblingOf(event.key === 'ArrowUp' ? -1 : 1);
    if (box) { event.preventDefault(); selectCommentRow(box, event.key === 'ArrowUp'); return true; }
    var foldRow = diffFoldBetween(event.key === 'ArrowUp' ? -1 : 1);
    if (foldRow) { event.preventDefault(); selectDiffFold(foldRow); return true; }
  }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveDiffCursor(1, 0, extend); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveDiffCursor(-1, 0, extend); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveDiffCursor(0, -1, extend); return true; }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveDiffCursor(0, 1, extend); return true; }
  return false;
}
