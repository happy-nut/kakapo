// ===== Side-by-side diff caret (keyboard navigation across the old/new panes) =====
function isDiffViewVisible() {
  var d = document.getElementById('diff-view');
  return Boolean(d && !d.classList.contains('hidden'));
}
function diffActiveWrapper() {
  return document.querySelector('#diff2html-container .d2h-file-wrapper:not(.df-inactive)')
    || document.querySelector('#diff2html-container .d2h-file-wrapper');
}
// path -> wrapper, O(1) after the first build. Rebuilt only on a miss/disconnect
// (the wrapper set is stable; only bodies materialize). This is called several times
// per F7 press, so the old O(files) querySelector scan made each keystroke cost scale
// with the file count — the main source of cross-file nav stutter on big diffs.
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
// Diff tables are immutable during normal caret movement. Cache their navigable rows instead of running a
// querySelectorAll + filter several times for every key repeat. Context expansion/body materialization call
// invalidateDiffRows; replaced watch DOM naturally gets a fresh WeakMap key.
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
function invalidateDiffRows(root) {
  if (!diffRowsCache || !root) return;
  if (root.classList && root.classList.contains('d2h-file-side-diff')) diffRowsCache.delete(root);
  if (root.querySelectorAll) root.querySelectorAll('.d2h-file-side-diff').forEach(function (table) { diffRowsCache.delete(table); });
}
function diffRowAt(wrapper, side, rowIndex) {
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  return rows[rowIndex] || null;
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
  var nameEl = wrapper.querySelector('.d2h-file-name');
  var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
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
  var walker = document.createTreeWalker(ctn, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode())) {
    var len = node.textContent.length;
    if (remaining <= len) return { node: node, offset: remaining };
    remaining -= len;
  }
  return { node: ctn, offset: ctn.childNodes.length };
}
var diffCaretSpan = null;
function clearDiffCaret() {
  var container = document.getElementById('diff2html-container');
  if (container) {
    container.querySelectorAll('.mc-diff-cursor-row').forEach(function (r) { r.classList.remove('mc-diff-cursor-row'); });
    // remove ALL caret spans (not just the tracked one) so a stray indicator never lingers
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
  // Empty line (ctn is just a <br>): an inline caret span would wrap onto a 2nd visual line and break the
  // row height, so position the caret absolutely — it shows without affecting the layout.
  if ((ctn.textContent || '').length === 0) {
    var espan = document.createElement('span');
    espan.className = 'code-cursor';
    espan.setAttribute('aria-hidden', 'true');
    espan.style.position = 'absolute';
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
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  if (!rows.length) return;
  var ri = Math.max(0, Math.min(rowIndex, rows.length - 1));
  var col = Math.max(0, Math.min(column, diffLineText(rows[ri]).length));
  diffCursor = { path: path, side: side, rowIndex: ri, column: col };
  syncActiveDiffHunk(hunkIndexAtCaret());
  syncDiffReviewChrome(path);
  pendingFileBoundary = null; // any caret move re-arms the last-change announcement for the next F7 (see next)
  hideCaretHint(); // caret moved (incl. crossing to the next file) → drop the "last change" hint so it never covers the new file
  diffSelectionAnchor = null; // any direct caret placement (click/F7/Cmd-arrow) drops the selection; Shift+Arrow re-sets it
  if (reveal) {
    // Render the caret AND scroll in the SAME animation frame. A fast key-repeat queues several ArrowDowns
    // before one frame; rendering the caret immediately (while the coalesced scroll lags) would push it many
    // rows past the viewport, then the view would snap ~one viewport at a time. Coalescing both keeps the
    // caret and scroll in lockstep, so holding ArrowDown scrolls smoothly instead of jumping every ~15 lines.
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
    if (!t) return;
    var row = diffRowAt(t.wrapper, t.side, t.ri);
    scrolloffReveal(row, document.getElementById('diff2html-container'), 0.15);
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
// Record a caret placement into the back/forward history. Contiguous small moves refresh the
// current entry (so arrowing around does not flood it); a jump (different file or a far line)
// pushes a new entry and drops any forward history.
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
  renderBreadcrumb(document.getElementById('diff-breadcrumb'), path);
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
  // Change-nav (F7) does not record positions. If the caret has drifted past the last recorded
  // spot, the first Cmd+[ returns to it; the next steps further back through the cursor history.
  var live = navEntryOf(isSourceViewerVisible() ? 'source' : 'diff');
  if (live && !navSamePos(live, navList[navPos])) { restoreNav(navList[navPos]); return; }
  if (navPos > 0) { navPos -= 1; restoreNav(navList[navPos]); }
}
function navForward() {
  if (navPos < navList.length - 1) { navPos += 1; restoreNav(navList[navPos]); }
}
function applyDiffSelection() {
  var sel = window.getSelection();
  if (!sel) return;
  // Selection only makes sense within one pane and one file; otherwise clear it.
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
  if (row.querySelector('.d2h-emptyplaceholder, .d2h-code-side-emptyplaceholder')) return false; // added/removed counterpart — no real line
  if (!row.querySelector('.d2h-code-line-ctn')) return false;
  var num = row.querySelector('.d2h-code-side-linenumber');
  return !!num && (num.textContent || '').trim().length > 0; // real code line has a line number (excludes hunk-info rows)
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
    var nameEl = wrapper.querySelector('.d2h-file-name');
    var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
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
  // Shift extends a text selection from where the caret sat before the first shifted move.
  var anchor = extend ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column }) : null;
  // Plain arrows stay within the current pane (no auto pane-crossing — that is Cmd+Left/Right).
  if (dColumn < 0) {
    if (col > 0) { col -= 1; }
    else { // at line start: end of previous code line in the SAME pane
      var p = ri - 1; while (p >= 0 && !isDiffCodeRow(rows[p])) p -= 1;
      if (p >= 0) { ri = p; col = diffLineText(rows[p]).length; }
    }
  } else if (dColumn > 0) {
    if (col < text.length) { col += 1; }
    else { // at line end: start of next code line in the SAME pane
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
  setDiffCursor(diffCursor.path, side, ri, col, true); // clears diffSelectionAnchor + native selection
  if (anchor) { diffSelectionAnchor = anchor; applyDiffSelection(); } // re-establish the Shift selection
}
function moveDiffWord(dir, extend) {
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  var text = diffLineText(row);
  var ncol = nextWordBoundary(text, diffCursor.column, dir);
  if (ncol === diffCursor.column) return; // already at the line edge — plain arrows change lines
  var anchor = extend ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column }) : null;
  setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, ncol, true);
  if (anchor) { diffSelectionAnchor = anchor; applyDiffSelection(); }
}
// Comment boxes are injected on the right(new) side, right after the line's row (see injectThreadRow /
// renderDiffComments). Split-view rows align 1:1 by index, so the caret's row index on the new side finds
// the adjacent box regardless of which side the caret sits on. Mirrors commentRowSiblingOf for the source view.
function diffCommentBoxSiblingOf(dir) {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return null;
  var rows = diffRowsOf(diffSideTable(wrapper, 'new'));
  var row = rows[diffCursor.rowIndex];
  if (!row) return null;
  var sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
  return (sib && sib.classList && sib.classList.contains('mc-comment-row')) ? sib : null;
}
// Omitted-context rows participate in vertical caret navigation just like comment boxes. diffRowsOf keeps
// the fold marker in positional order but moveDiffCursor normally skips non-code rows, so explicitly detect
// a fold between the current line and the next real code line.
function diffFoldBetween(dir) {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  var table = wrapper ? diffSideTable(wrapper, diffCursor.side) : null;
  var rows = diffRowsOf(table);
  var step = dir < 0 ? -1 : 1;
  for (var i = diffCursor.rowIndex + step; i >= 0 && i < rows.length; i += step) {
    if (isDiffCodeRow(rows[i])) return null;
    if (rows[i].classList.contains('mc-context-fold-row')) return rows[i];
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
  // A selected fold owns Space and vertical arrows. The code caret remains on its adjacent source line,
  // matching comment-box navigation, so Escape/left/right can simply return focus to that caret.
  if (selectedDiffFoldRow) {
    if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      var fold = selectedDiffFoldRow;
      clearSelectedDiffFold();
      expandDiffContext(fold);
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
  // A comment box is selected: Backspace/Delete removes it, `e` edits it, an arrow/Escape steps off it.
  // Same contract as the source view (handleSourceCaretKey), but caret moves go through setDiffCursor.
  if (selectedCommentRow) {
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); deleteCommentsInRow(selectedCommentRow); return true; }
    if (event.key === 'e' || event.key === 'E') { event.preventDefault(); editCommentInRow(selectedCommentRow); return true; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Escape') {
      var dir = event.key === 'ArrowUp' ? -1 : (event.key === 'ArrowDown' ? 1 : 0);
      var sib = dir < 0 ? selectedCommentRow.previousElementSibling : (dir > 0 ? selectedCommentRow.nextElementSibling : null);
      selectedCommentRow.classList.remove('mc-row-selected');
      selectedCommentRow = null;
      event.preventDefault();
      var wrapper = diffWrapperByPath(diffCursor.path);
      if (sib && wrapper && isDiffCodeRow(sib)) {
        var rows = diffRowsOf(diffSideTable(wrapper, 'new'));
        var idx = rows.indexOf(sib);
        if (idx >= 0) { setDiffCursor(diffCursor.path, 'new', idx, 0, true); return true; }
      }
      setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, diffCursor.column, false); // restore caret where it was
      return true;
    }
    return false;
  }
  // Plain Up/Down: a comment box attached to the caret line is a selectable stop (caret stays visible).
  if (!extend && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    var box = diffCommentBoxSiblingOf(event.key === 'ArrowUp' ? -1 : 1);
    if (box) { event.preventDefault(); selectCommentRow(box); return true; }
    var foldRow = diffFoldBetween(event.key === 'ArrowUp' ? -1 : 1);
    if (foldRow) { event.preventDefault(); selectDiffFold(foldRow); return true; }
  }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveDiffCursor(1, 0, extend); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveDiffCursor(-1, 0, extend); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveDiffCursor(0, -1, extend); return true; }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveDiffCursor(0, 1, extend); return true; }
  return false;
}
