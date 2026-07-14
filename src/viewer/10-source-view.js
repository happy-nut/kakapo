function filterNavigation(rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  links.forEach((link) => {
    const path = link.dataset.file || '';
    const source = sourceByPath.get(path);
    const haystack = (path + '\n' + (source?.content || '')).toLowerCase();
    link.hidden = query.length > 0 && !haystack.includes(query);
  });
  sourceLinks.forEach((link) => {
    const path = link.dataset.sourceFile || '';
    const source = sourceByPath.get(path);
    const haystack = (path + '\n' + (source?.content || '')).toLowerCase();
    link.hidden = query.length > 0 && !haystack.includes(query);
  });
  updateTreeVisibility(document.getElementById('changes-panel'), query);
  updateTreeVisibility(document.getElementById('files-panel'), query);
}

function updateTreeVisibility(root, query) {
  if (!root) return;
  Array.from(root.querySelectorAll('details')).reverse().forEach((details) => {
    const hasVisibleLeaf = Array.from(details.children).some((child) => {
      if (child.tagName === 'SUMMARY') return false;
      return !child.hidden;
    });
    details.hidden = query.length > 0 && !hasVisibleLeaf;
    if (query.length > 0 && hasVisibleLeaf) details.open = true;
  });
}

function openDefaultSourceFile() {
  const isReadme = (candidate) => /^readme(\.|$)/i.test(candidate.name || '');
  const depthOf = (candidate) => (candidate.path || '').split('/').length;
  // Prefer the TOP-MOST README (root before any nested one), not just the first match in tree order.
  const rootReadme = sourceFiles
    .filter((candidate) => candidate.embedded && isReadme(candidate))
    .sort((a, b) => depthOf(a) - depthOf(b))[0];
  const file = sourceFiles.find((candidate) => candidate.changed && candidate.embedded)
    || rootReadme // top-most README when nothing changed
    || sourceFiles.find((candidate) => candidate.embedded)
    || sourceFiles.find((candidate) => candidate.changed)
    || sourceFiles[0];
  if (file) {
    openSourceFile(file.path);
    return;
  }
  if (hunkTotal() > 0) setActive(0, false);
}

function handleSourceCopy(event) {
  const selection = window.getSelection();
  const sourceBody = document.getElementById('source-body');
  const viewer = document.getElementById('source-viewer');
  if (!selection || selection.isCollapsed || !sourceBody || !viewer || viewer.classList.contains('hidden')) return;
  if (!selection.anchorNode || !selection.focusNode) return;
  if (!sourceBody.contains(selection.anchorNode) || !sourceBody.contains(selection.focusNode)) return;

  const path = viewer.dataset.openPath || '';
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const rows = selectedSourceRows(selection);
  if (rows.length === 0) return;

  const lineNumbers = rows
    .map((row) => Number(row.dataset.lineIndex || 0) + 1)
    .filter((line) => Number.isFinite(line))
    .sort((a, b) => a - b);
  const startLine = lineNumbers[0];
  const endLine = lineNumbers[lineNumbers.length - 1];
  if (!startLine || !endLine) return;

  const selectedText = cleanSelectedSourceText(selection.toString(), rows);
  const code = selectedText || sourceLinesForRows(file, rows);
  if (!code.trim()) return;

  const reference = path + ':' + (startLine === endLine ? String(startLine) : startLine + '-' + endLine);
  const language = file.language && file.language !== 'text' ? file.language : '';
  const fence = String.fromCharCode(96).repeat(3);
  const payload = reference + '\n\n' + fence + language + '\n' + code.replace(/\s+$/g, '') + '\n' + fence;
  event.clipboardData?.setData('text/plain', payload);
  event.preventDefault();
}

function selectedSourceRows(selection) {
  if (!selection.rangeCount) return [];
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  return Array.from(document.querySelectorAll('#source-body .source-row'))
    .filter((row) => ranges.some((range) => {
      try {
        return range.intersectsNode(row);
      } catch {
        return false;
      }
    }))
    .sort((a, b) => Number(a.dataset.lineIndex || 0) - Number(b.dataset.lineIndex || 0));
}

function cleanSelectedSourceText(text, rows) {
  const value = String(text || '').replace(/\r/g, '').replace(/\u200b/g, '');
  if (!value.trim()) return '';
  const lineNumbers = rows.map((row) => Number(row.dataset.lineIndex || 0) + 1);
  const lines = value.split('\n');
  if (lines.length >= lineNumbers.length) {
    return lines
      .map((line, index) => {
        const lineNumber = lineNumbers[index];
        return lineNumber ? line.replace(new RegExp('^\\s*' + lineNumber + '\\s+'), '') : line;
      })
      .join('\n')
      .trimEnd();
  }
  return value.trimEnd();
}

function sourceLinesForRows(file, rows) {
  const lines = file.content.split(/\r?\n/);
  return rows
    .map((row) => lines[Number(row.dataset.lineIndex || 0)] || '')
    .join('\n')
    .trimEnd();
}

function handleSourceClick(event) {
  const target = event.target;
  const runBtn = target?.closest?.('.http-run');
  if (runBtn) {
    event.preventDefault();
    runHttpRequest(Number(runBtn.dataset.req));
    return;
  }
  const respToggle = target?.closest?.('.http-resp-toggle');
  if (respToggle) {
    event.preventDefault();
    const panel = respToggle.closest('.http-response')?.querySelector('.http-resp-headers');
    if (panel) panel.classList.toggle('hidden');
    return;
  }
  const row = target?.closest?.('.source-row');
  if (!row) return;
  clearTreeFocus();
  const viewer = document.getElementById('source-viewer');
  const path = viewer?.dataset.openPath || '';
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const lineIndex = Number(row.dataset.lineIndex || 0);
  const lines = file.content.split(/\r?\n/);
  const line = lines[lineIndex] || '';
  const codeCell = row.querySelector('.source-code');
  const column = estimateColumnFromClick(codeCell, event, line);
  setSourceCursor(path, lineIndex, column, false, -1);
}

function estimateColumnFromClick(codeCell, event, line) {
  if (!codeCell) return 0;
  const rect = codeCell.getBoundingClientRect();
  const style = getComputedStyle(codeCell);
  const paddingLeft = Number.parseFloat(style.paddingLeft || '0') || 0;
  const x = event.clientX - rect.left - paddingLeft;
  const width = measuredCharWidth || measureCharWidth(codeCell);
  const column = Math.round(x / Math.max(width, 1));
  return Math.max(0, Math.min(line.length, column));
}

function measureCharWidth(element) {
  const probe = document.createElement('span');
  probe.textContent = 'mmmmmmmmmm';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.font = getComputedStyle(element).font;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  measuredCharWidth = width || 7;
  return measuredCharWidth;
}

var caretBusyTimer = null;
// While the caret is actively moving (held arrow key, typing), keep it solid and only resume the
// blink animation after a short idle. Otherwise key-repeat exposes the blink's "off" frames between
// moves and the caret appears to vanish intermittently.
function markCaretBusy() {
  document.body.classList.add('caret-busy');
  if (caretBusyTimer) clearTimeout(caretBusyTimer);
  caretBusyTimer = setTimeout(function () { document.body.classList.remove('caret-busy'); }, 650);
}

function setSourceCursor(path, lineIndex, column, shouldReveal = false, targetLine = -1) {
  markCaretBusy();
  selectedCommentRow = null; // any explicit caret placement (click/move) ends a comment-box selection
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const lines = file.content.split(/\r?\n/);
  const boundedLine = Math.max(0, Math.min(lineIndex, Math.max(lines.length - 1, 0)));
  const boundedColumn = Math.max(0, Math.min(column, (lines[boundedLine] || '').length));

  const prev = viewerCursor;
  const viewer = document.getElementById('source-viewer');
  // Fast path: the file is already on screen and only the caret moved. Re-rendering the whole
  // file on every keystroke blocks the main thread on large files, so patch just the previous
  // and new caret lines in place instead.
  // sourceBodyPath (the file actually painted in the body) must match too — dataset.openPath/viewerCursor
  // are metadata that can be set before the body repaints (lazy fetch in flight, fast file switch, watch
  // refresh), so without this the caret patches a STALE body and one file's content shows under another's
  // breadcrumb. On mismatch we fall through to openSourceFile, which re-renders the body for `path`.
  const sameFileOpen = Boolean(viewer && viewer.dataset.openPath === path && !viewer.classList.contains('hidden')
    && prev && prev.path === path && !isHttpFile(path) && sourceBodyPath === path);

  viewerCursor = { path, lineIndex: boundedLine, column: boundedColumn, targetLine };

  if (isMonacoSourceActive(path)) {
    updateMonacoSourcePosition(boundedLine, boundedColumn, shouldReveal, targetLine);
    recordNav(navEntryOf('source'));
    return;
  }

  if (sameFileOpen) {
    // Coalesce caret render + scroll into ONE frame on reveal (ArrowDown) so a fast key-repeat doesn't run
    // the caret several rows ahead of the lagging (rAF) scroll and snap ~one viewport at a time ("stutter
    // every ~26 lines"). Click (no reveal) stays instant.
    if (shouldReveal) scheduleSourceReveal(prev);
    else updateSourceCaret(prev, lines, file.language || 'text');
  } else {
    const shouldSwitch = !viewer || viewer.dataset.openPath !== path || viewer.classList.contains('hidden');
    openSourceFile(path, shouldSwitch);
    if (shouldReveal) scheduleScrollIntoView(document.querySelector('.source-row.cursor-line'), document.getElementById('source-body'), 0.15);
  }
  recordNav(navEntryOf('source'));
}
var sourceRevealRaf = 0, sourceRevealPrev = null;
// Source rows are a fixed monospace height, so the caret-follow scroll can be computed from
// lineIndex*rowHeight instead of reading the caret's getBoundingClientRect — which forces a full reflow on
// every move (~15ms on a 400-line file; the main caret-follow stutter). Cached; invalidated on resize.
var _srcRowH = 0;
function sourceRowHeight() {
  if (_srcRowH > 0) return _srcRowH;
  var r = document.querySelector('#source-body .source-row');
  if (r) { var h = r.offsetHeight; if (h > 0) _srcRowH = h; }
  return _srcRowH;
}
if (typeof window !== 'undefined') window.addEventListener('resize', function () { _srcRowH = 0; });
function scheduleSourceReveal(prev) {
  // First prev of a coalesced burst wins: a fast ArrowDown updates viewerCursor many times before the frame
  // fires; render the caret once (first prev -> final viewerCursor) and scroll in the SAME frame so caret and
  // scroll stay locked together instead of the scroll snapping a viewport behind.
  if (!sourceRevealRaf) sourceRevealPrev = prev;
  if (sourceRevealRaf) return;
  sourceRevealRaf = requestAnimationFrame(function () {
    sourceRevealRaf = 0;
    var p = sourceRevealPrev; sourceRevealPrev = null;
    var f = sourceByPath.get(viewerCursor.path);
    if (!f || !f.embedded) return;
    var lines = f.content.split(/\r?\n/);
    updateSourceCaret(p, lines, f.language || 'text');
    var sb = document.getElementById('source-body');
    var rowH = sourceRowHeight();
    if (rowH > 0 && sb && !sb.classList.contains('rendered-body')) {
      // Scrolloff, not follow: scroll ONLY when the caret would otherwise leave the viewport, keeping it
      // within a 15% margin of the top/bottom edge. While the caret moves comfortably inside that band the
      // view stays put — continuous follow was dizzying (the file slid even when everything was visible) and
      // it forced a scroll/reflow on every move. lineIndex*rowH avoids getBoundingClientRect entirely, and
      // skipping the scroll when it's unnecessary removes the reflow on most moves too.
      // Raw code rows are fixed-height/no-wrap, so the arithmetic path avoids a full-layout read on every
      // key repeat. Comment/HTTP response rows add variable height between code lines; in that case use the
      // real cursor row geometry or lineIndex*rowHeight can put the caret below the viewport.
      if (sb.querySelector('.mc-comment-row, .http-response')) revealSourceCursorWithMargin();
      else {
        var caretTop = viewerCursor.lineIndex * rowH;
        var ch = sb.clientHeight;
        var margin = Math.round(ch * 0.15);
        var vTop = sb.scrollTop;
        if (caretTop < vTop + margin) sb.scrollTop = Math.max(0, caretTop - margin);
        else if (caretTop + rowH > vTop + ch - margin) sb.scrollTop = caretTop + rowH - ch + margin;
      }
    } else {
      revealSourceCursorWithMargin();
    }
  });
}

// Keep the source caret inside a 15% scroll-off band. This geometry path is used for rendered documents,
// variable-height comment/HTTP rows, and atomic live-refresh restoration; ordinary fixed-height source
// movement stays on the cheaper arithmetic path above.
function revealSourceCursorWithMargin() {
  var body = document.getElementById('source-body');
  if (!body || !viewerCursor) return;
  var row = body.querySelector('.source-row[data-line-index="' + viewerCursor.lineIndex + '"]')
    || body.querySelector('.source-row.cursor-line');
  scrolloffReveal(row, body, 0.15);
}

// Move the caret by patching only the affected line cells, never the whole <table>. This keeps
// large files responsive (no full re-highlight per keystroke) and, because the new caret line is
// rebuilt with a fresh .code-cursor span, restarts the blink animation so the caret is solid the
// instant it moves and only resumes blinking when idle.
function updateSourceCaret(prev, lines, language) {
  const body = document.getElementById('source-body');
  if (!body) return;
  // Markdown/CSV render to HTML cells (.rendered-body): the caret is a whole-row highlight there,
  // so never rewrite a cell's innerHTML (that would replace the rendered block with raw text).
  const rendered = body.classList.contains('rendered-body');
  const rowFor = (idx) => body.querySelector('.source-row[data-line-index="' + idx + '"]');
  // Restore the line the caret left: drop the caret span, re-highlight the full line.
  if (prev && prev.lineIndex !== viewerCursor.lineIndex) {
    const prevRow = rowFor(prev.lineIndex);
    if (prevRow) prevRow.classList.remove('cursor-line');
  }
  // Drop the old caret span WITHOUT re-highlighting the line — re-tokenizing a line on every caret move is
  // what made holding an arrow key stutter. (The diff caret already works this way: insert/remove a span.)
  if (!rendered) body.querySelectorAll('.code-cursor').forEach((s) => { const p = s.parentNode; if (p) { p.removeChild(s); if (p.normalize) p.normalize(); } });
  // Reconcile the go-to-definition highlight (set only on symbol jumps, cleared on plain moves).
  body.querySelectorAll('.source-row.symbol-target').forEach((r) => r.classList.remove('symbol-target'));
  if (viewerCursor.targetLine >= 0) rowFor(viewerCursor.targetLine)?.classList.add('symbol-target');
  const row = rowFor(viewerCursor.lineIndex);
  if (!row) { if (!rendered) openSourceFile(viewerCursor.path, false); return; } // line not in the DOM — full re-render (eager source only)
  row.classList.add('cursor-line');
  if (!rendered) insertSourceCaret(row, viewerCursor.column);
}
// Insert the caret span at `column` of `row` via a real DOM range into the already-highlighted line — the
// same cheap technique the diff caret uses, so holding an arrow key never re-tokenizes a line.
function insertSourceCaret(row, column) {
  var cell = row.querySelector('.source-code');
  if (!cell) return;
  var pos = diffCaretDomPosition(cell, column); // empty line: returns {node: cell, offset: 0} so the caret still shows
  if (!pos) return;
  var span = document.createElement('span');
  span.className = 'code-cursor';
  span.setAttribute('aria-hidden', 'true');
  try {
    var off = pos.node.nodeType === 3 ? Math.min(pos.offset, (pos.node.textContent || '').length) : pos.offset;
    var range = document.createRange();
    range.setStart(pos.node, off); range.collapse(true);
    range.insertNode(span);
  } catch (e) {}
}

function openSourceAt(path, lineIndex, column) {
  var file = sourceByPath.get(path);
  if (file && !sourceContentLoaded(file)) {
    openSourceFile(path);
    loadSourceFile(path).then(function () { setSourceCursor(path, lineIndex, column, true, lineIndex); });
    return;
  }
  setSourceCursor(path, lineIndex, column, true, lineIndex);
}

function isSourceViewerVisible() {
  const viewer = document.getElementById('source-viewer');
  return Boolean(viewer && !viewer.classList.contains('hidden'));
}

// Cmd/Ctrl+A scoped to the current view: select the source body, or the active diff file's content —
// NOT the whole page (the browser default reached into the sidebar). Returns false if there's
// no view target so the caller can fall back to the default.
function selectAllInView() {
  var target = null;
  if (isSourceViewerVisible() && isMonacoSourceActive()) {
    selectAllMonacoSource();
    return true;
  }
  if (isSourceViewerVisible()) target = document.getElementById('source-body');
  else if (typeof isDiffViewVisible === 'function' && isDiffViewVisible()) {
    target = document.querySelector('#diff2html-container .d2h-file-wrapper:not(.df-inactive)') || document.getElementById('diff2html-container');
  }
  if (!target) return false;
  try {
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) { return false; }
  return true;
}

function openDiffFileAtCaret() {
  if (diffCursor && isDiffViewVisible()) {
    const dwrap = diffWrapperByPath(diffCursor.path);
    const drow = dwrap ? diffRowAt(dwrap, diffCursor.side, diffCursor.rowIndex) : null;
    const dline = drow ? diffLineNumber(drow) : null;
    if (sourceByPath.has(diffCursor.path)) { setSourceCursor(diffCursor.path, dline != null ? dline - 1 : 0, 0, true, -1); return; }
    openSourceFile(diffCursor.path); return;
  }
  const sel = window.getSelection();
  const node = sel && sel.anchorNode;
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  const wrapper = (el && el.closest && el.closest('.d2h-file-wrapper')) || document.querySelector('.d2h-file-wrapper:not(.df-inactive)');
  if (!wrapper) return;
  const fileName = (wrapper.querySelector('.d2h-file-name')?.textContent || '').trim();
  if (!fileName) return;
  if (!sourceByPath.has(fileName)) { openSourceFile(fileName); return; }
  let lineIndex = 0;
  const lineEl = el && el.closest && el.closest('.d2h-code-side-line');
  if (lineEl) {
    const row = lineEl.closest('tr');
    const numEl = row && row.querySelector('.d2h-code-side-linenumber');
    const num = numEl ? parseInt((numEl.textContent || '').trim(), 10) : NaN;
    if (Number.isFinite(num)) lineIndex = Math.max(0, num - 1);
  }
  setSourceCursor(fileName, lineIndex, 0, true, -1);
}

// ----- Comment-box navigation: a box attached to a line is a selectable stop while moving the caret -----
function commentRowSiblingOf(lineIndex, dir) {
  var cur = document.querySelector('#source-body .source-row[data-line-index="' + lineIndex + '"]');
  if (!cur) return null;
  var sib = dir < 0 ? cur.previousElementSibling : cur.nextElementSibling;
  return (sib && sib.classList && sib.classList.contains('mc-comment-row')) ? sib : null;
}
function selectCommentRow(row) {
  if (selectedCommentRow && selectedCommentRow !== row) selectedCommentRow.classList.remove('mc-row-selected');
  selectedCommentRow = row || null;
  if (!selectedCommentRow) return;
  selectedCommentRow.classList.add('mc-row-selected');
  // Keep the caret visible: the box's active outline (.mc-row-selected) already shows the selection, and the
  // caret must never be hidden ("어떤 경우에도 커서는 가려지면 안 됨"). Previously this removed cursor-line +
  // code-cursor, so Go-to-comment → ArrowDown (which selects the comment box on that line) made the caret vanish.
}
function deleteCommentsInRow(row) {
  if (!row) return;
  var seqs = Array.prototype.slice.call(row.querySelectorAll('.mc-del')).map(function (b) { return parseInt(b.dataset.seq, 10); });
  selectedCommentRow = null;
  if (seqs.length) {
    reviewComments = reviewComments.filter(function (c) { return seqs.indexOf(c.seq) < 0; });
    saveComments();
  }
  refreshComments(); // remaining comment rows re-injected; the caret stays hidden until the next arrow press
}
// Open the composer in EDIT mode for the first comment in `row`, pre-filled with its text. threadHtml renders
// the composer in place of that card (via composerState.editSeq), and saveComposer routes editSeq through
// updateComment instead of addComment. Triggered by `e` while a comment box is selected.
function editCommentInRow(row) {
  if (!row) return;
  var del = row.querySelector('.mc-del');
  if (!del) return;
  var seq = parseInt(del.dataset.seq, 10);
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  row.classList.remove('mc-row-selected');
  selectedCommentRow = null;
  composerState = {
    kind: c.kind, path: c.path, line: c.line, code: c.code, anchorCode: c.anchorCode,
    from: c.from, to: c.to, side: c.side,
    editSeq: seq, editText: c.text,
  };
  refreshComments();
}
function handleSourceCaretKey(event) {
  if (!viewerCursor) return false;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return false;
  const extend = event.shiftKey;
  // A comment box is selected (caret hidden): Backspace/Delete removes it; an arrow steps off it.
  if (selectedCommentRow) {
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); deleteCommentsInRow(selectedCommentRow); return true; }
    if (event.key === 'e' || event.key === 'E') { event.preventDefault(); editCommentInRow(selectedCommentRow); return true; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Escape') {
      var dir = event.key === 'ArrowUp' ? -1 : (event.key === 'ArrowDown' ? 1 : 0);
      var sib = dir < 0 ? selectedCommentRow.previousElementSibling : (dir > 0 ? selectedCommentRow.nextElementSibling : null);
      selectedCommentRow.classList.remove('mc-row-selected');
      selectedCommentRow = null;
      event.preventDefault();
      if (sib && sib.classList && sib.classList.contains('source-row')) {
        var li = parseInt(sib.dataset.lineIndex, 10);
        if (isFinite(li)) { setSourceCursor(viewerCursor.path, li, 0, true, -1); return true; }
      }
      setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, viewerCursor.column, false, -1); // restore caret where it was
      return true;
    }
    return false;
  }
  // Plain Up/Down: a comment box between the caret line and the next line becomes a selectable stop.
  if (!extend && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    var box = commentRowSiblingOf(viewerCursor.lineIndex, event.key === 'ArrowUp' ? -1 : 1);
    if (box) { event.preventDefault(); selectCommentRow(box); return true; }
  }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveSourceCursor(1, 0, extend); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveSourceCursor(-1, 0, extend); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveSourceCursor(0, -1, extend); return true; }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveSourceCursor(0, 1, extend); return true; }
  return false;
}

function moveSourceCursor(dLine, dColumn, extend) {
  if (!viewerCursor) return;
  const file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return;
  // Markdown/CSV rendered view: rows are blocks (sparse data-line-index), so any arrow steps to the
  // adjacent block row rather than into a (non-existent) raw line. No text column / selection there.
  const renderedBody = document.getElementById('source-body');
  if (renderedBody && renderedBody.classList.contains('rendered-body')) {
    const rows = Array.from(renderedBody.querySelectorAll('.source-row'));
    if (!rows.length) return;
    let ci = rows.indexOf(renderedBody.querySelector('.source-row[data-line-index="' + viewerCursor.lineIndex + '"]'));
    if (ci < 0) ci = 0;
    const step = (dLine || 0) + (dColumn > 0 ? 1 : dColumn < 0 ? -1 : 0);
    const ni = Math.max(0, Math.min(rows.length - 1, ci + (step || 0)));
    selectionAnchor = null;
    setSourceCursor(viewerCursor.path, Number(rows[ni].dataset.lineIndex) || 0, 0, true, -1);
    return;
  }
  const lines = file.content.split(/\r?\n/);
  let line = viewerCursor.lineIndex;
  let col = viewerCursor.column;
  if (dColumn < 0) {
    if (col > 0) col -= 1;
    else if (line > 0) { line -= 1; col = (lines[line] || '').length; }
  } else if (dColumn > 0) {
    if (col < (lines[line] || '').length) col += 1;
    else if (line < lines.length - 1) { line += 1; col = 0; }
  }
  if (dLine !== 0) {
    line = Math.max(0, Math.min(lines.length - 1, line + dLine));
    col = Math.min(col, (lines[line] || '').length);
  }
  if (extend) {
    if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  } else {
    selectionAnchor = null;
  }
  setSourceCursor(viewerCursor.path, line, col, true, -1);
  applySourceSelection();
}
// Word boundary in text from col in direction dir (+1 next, -1 prev): skip non-word, then word.
function nextWordBoundary(text, col, dir) {
  // Classify like vim's word motions: 0 = whitespace, 1 = word char, 2 = punctuation.
  // A run of word chars and a run of punctuation are each their own "word", so the
  // caret lands on the START of the next word/punctuation run (vim 'w'), or the start
  // of the previous one (vim 'b') -- never stranded in the middle of whitespace.
  var classOf = function (ch) {
    if (ch === '' || /\s/.test(ch)) return 0;
    if (/[A-Za-z0-9_$]/.test(ch)) return 1;
    return 2;
  };
  var i = col;
  if (dir > 0) {
    var cf = classOf(text.charAt(i));
    if (cf !== 0) { while (i < text.length && classOf(text.charAt(i)) === cf) i++; }
    while (i < text.length && classOf(text.charAt(i)) === 0) i++;
  } else {
    i--;
    while (i > 0 && classOf(text.charAt(i)) === 0) i--;
    var cb = classOf(text.charAt(i));
    while (i > 0 && classOf(text.charAt(i - 1)) === cb) i--;
    if (i < 0) i = 0;
  }
  return i;
}
function moveSourceWord(dir, extend) {
  if (!viewerCursor) return;
  var file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return;
  var lines = file.content.split(/\r?\n/);
  var line = viewerCursor.lineIndex, col = viewerCursor.column;
  var text = lines[line] || '';
  if (dir > 0) {
    var fwd = nextWordBoundary(text, col, 1);
    if (fwd < text.length || line >= lines.length - 1) { col = fwd; }
    else { line += 1; var nt = lines[line] || ''; var m = nt.search(/\S/); col = m < 0 ? 0 : m; }
  } else {
    var back = nextWordBoundary(text, col, -1);
    if (back < col && /\S/.test(text.charAt(back))) { col = back; }
    else if (line > 0) { line -= 1; var pt = lines[line] || ''; col = pt.length > 0 ? nextWordBoundary(pt, pt.length, -1) : 0; }
    else { col = back; }
  }
  if (extend) { if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column }; }
  else selectionAnchor = null;
  setSourceCursor(viewerCursor.path, line, col, true, -1);
  applySourceSelection();
}

function applySourceSelection() {
  const sel = window.getSelection();
  if (!sel) return;
  if (!selectionAnchor || !viewerCursor) { sel.removeAllRanges(); return; }
  const a = caretDomPosition(selectionAnchor.lineIndex, selectionAnchor.column);
  const c = caretDomPosition(viewerCursor.lineIndex, viewerCursor.column);
  if (a && c) {
    try { sel.setBaseAndExtent(a.node, a.offset, c.node, c.offset); } catch (e) {}
  }
}

function caretDomPosition(lineIndex, column) {
  const cell = document.querySelector('.source-row[data-line-index="' + lineIndex + '"] .source-code');
  if (!cell) return null;
  let remaining = column;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
  }
  return { node: cell, offset: cell.childNodes.length };
}

function wordAtCursor() {
  if (!viewerCursor) return null;
  const file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return null;
  const line = file.content.split(/\r?\n/)[viewerCursor.lineIndex] || '';
  const column = Math.max(0, Math.min(viewerCursor.column, line.length));
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match = null;
  while ((match = identifier.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (column >= start && column <= end) {
      return { name: match[0], path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: start };
    }
  }
  return null;
}

function goToSymbolUnderCursor() {
  const symbol = wordAtCursor();
  if (symbol) goToDefOrUsages(symbol.name, symbol);
}
// Cmd+B: on a declaration, show its usages (navigate if there's only one); elsewhere, go to the definition.
async function goToDefOrUsages(name, explicitLoc) {
  if (!name) return;
  var loc = explicitLoc || caretSourceLoc();
  var response = await queryProjectAnalysis('definition', name, loc);
  if (response && response.ok) {
    var defs = response.locations || [];
    if (defs.length > 1 && typeof openSemanticPeek === 'function') {
      openSemanticPeek(name, defs, response, 'definition');
      return;
    }
    var def = defs[0];
    if (def && loc && def.path === loc.path && def.lineIndex === loc.lineIndex) {
      var refs = await queryProjectAnalysis('references', name, loc);
      openAnalysisUsages(name, refs && refs.locations || [], refs, 'references');
      return;
    }
    if (def) { openSourceAt(def.path, def.lineIndex, def.column); return; }
  }
  // Standalone HTML has no main-process analyzer. Keep a small in-memory scan for that mode only.
  var def = findSymbolDefinition(name);
  if (def && loc && def.path === loc.path && def.lineIndex === loc.lineIndex) {
    openUsages(name, def);
    return;
  }
  if (def) openSourceAt(def.path, def.lineIndex, def.column);
}
async function goToImplementation() {
  var symbol = isSourceViewerVisible() ? wordAtCursor() : null;
  var name = symbol ? symbol.name : wordAtDiffCaret();
  var loc = symbol || caretSourceLoc();
  if (!name || !loc) return;
  var response = await queryProjectAnalysis('implementation', name, loc);
  var items = response && response.locations || [];
  if (items.length === 1) { openSourceAt(items[0].path, items[0].lineIndex, items[0].column); return; }
  openAnalysisUsages(name, items, response, 'implementation');
}
function queryProjectAnalysis(kind, symbol, loc, extra) {
  if (!window.monacoriAnalysis || typeof window.monacoriAnalysis.query !== 'function') return Promise.resolve(null);
  var request = Object.assign({
    kind: kind,
    symbol: symbol || undefined,
    path: loc && loc.path,
    line: loc && loc.lineIndex,
    column: loc && loc.column,
  }, extra || {});
  return Promise.resolve(window.monacoriAnalysis.query(request)).then(function (response) {
    if (typeof analysisGenerationIsCurrent === 'function' && !analysisGenerationIsCurrent(response)) return null;
    return response;
  }).catch(function () { return null; });
}
// Where the caret sits, mapped to a source (path, lineIndex). In the diff, only the new side maps cleanly.
function caretSourceLoc() {
  if (isSourceViewerVisible() && viewerCursor) return { path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  if (isDiffViewVisible() && diffCursor && diffCursor.side === 'new') {
    var wrap = diffWrapperByPath(diffCursor.path);
    var row = wrap ? diffRowAt(wrap, diffCursor.side, diffCursor.rowIndex) : null;
    var ln = row ? diffLineNumber(row) : null;
    if (ln != null) return { path: diffCursor.path, lineIndex: ln - 1, column: diffCursor.column };
  }
  return null;
}
// All word-boundary occurrences of name across embedded files, excluding the declaration line itself.
function findUsages(name, defPath, defLine) {
  var re;
  try { re = new RegExp('(^|[^A-Za-z0-9_$])' + escapeRegExp(name) + '(?![A-Za-z0-9_$])'); } catch (e) { return []; }
  var out = [];
  for (var fi = 0; fi < sourceFiles.length; fi++) {
    var f = sourceFiles[fi];
    if (!f.embedded) continue;
    var lines = String(f.content).split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      if (f.path === defPath && li === defLine) continue;
      var m = re.exec(lines[li]);
      if (m) {
        out.push({ path: f.path, lineIndex: li, column: m.index + (m[1] ? m[1].length : 0), text: lines[li] });
        if (out.length >= 500) return out;
      }
    }
  }
  return out;
}
function openUsages(name, def) {
  var items = findUsages(name, def.path, def.lineIndex);
  if (items.length === 1) { openSourceAt(items[0].path, items[0].lineIndex, items[0].column); return; }
  usageItems = items;
  usageActive = 0;
  showUsages(name, items.length);
}
function openAnalysisUsages(name, locations, response, kind) {
  if ((locations || []).length > 1 && typeof openSemanticPeek === 'function' && monacoAvailable()) {
    openSemanticPeek(name, locations, response, kind || 'references');
    return;
  }
  openAnalysisUsagesFallback(name, locations);
}
function showUsages(name, count) {
  var box = document.getElementById('usages');
  var title = document.getElementById('usages-title');
  if (!box) return;
  if (title) title.textContent = count + ' usage' + (count === 1 ? '' : 's') + ' of ' + name;
  renderUsages();
  box.classList.remove('hidden');
  positionUsagesAtCaret();
}
// Anchor the usages popup just below (or above, if cramped) the live caret — source OR diff both render a
// `.code-cursor` span. No caret on screen → leave the centered overlay fallback in place.
function positionUsagesAtCaret() {
  var box = document.getElementById('usages');
  if (!box) return;
  var panel = box.querySelector('.quick-open-panel');
  if (!panel) return;
  resetUsagesAnchor(box, panel); // measure from a clean slate
  var caret = document.querySelector('#source-body .code-cursor') || document.querySelector('#diff2html-container .code-cursor');
  if (!caret) return;
  var rect = caret.getBoundingClientRect();
  if (!rect.height && !rect.width && !rect.top) return; // detached / off-layout
  var vw = window.innerWidth, vh = window.innerHeight, gap = 6, margin = 8;
  var pw = Math.min(560, vw - margin * 2);
  var left = Math.min(Math.max(margin, rect.left), vw - pw - margin);
  box.classList.add('anchored');
  panel.style.width = pw + 'px';
  panel.style.left = left + 'px';
  var spaceBelow = vh - rect.bottom - gap - margin;
  var spaceAbove = rect.top - gap - margin;
  if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
    panel.style.top = (rect.bottom + gap) + 'px';
    panel.style.maxHeight = Math.max(120, spaceBelow) + 'px';
  } else {
    panel.style.bottom = (vh - rect.top + gap) + 'px';
    panel.style.maxHeight = Math.max(120, spaceAbove) + 'px';
  }
}
function resetUsagesAnchor(box, panel) {
  box.classList.remove('anchored');
  panel.style.left = panel.style.top = panel.style.bottom = panel.style.width = panel.style.maxHeight = '';
}
function renderUsages() {
  var results = document.getElementById('usages-results');
  if (!results) return;
  if (!usageItems.length) { results.innerHTML = '<div class="quick-open-empty">No usages found.</div>'; return; }
  results.innerHTML = usageItems.map(function (item, index) {
    var fname = item.path.split('/').pop();
    return '<button type="button" class="quick-open-item usage-item' + (index === usageActive ? ' active' : '') + '" data-index="' + index + '">'
      + '<span class="usage-loc">' + escapeHtml(fname) + ':' + (item.lineIndex + 1) + '</span>'
      + '<span class="usage-code">' + escapeHtml(item.text.replace(/^\s+/, '').slice(0, 160)) + '</span>'
      + '</button>';
  }).join('');
  updateUsageActive();
}
function updateUsageActive() {
  var results = document.getElementById('usages-results');
  if (!results) return;
  var items = results.querySelectorAll('.usage-item');
  for (var i = 0; i < items.length; i++) {
    var on = i === usageActive;
    items[i].classList.toggle('active', on);
    if (on && items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
  }
}
function handleUsagesKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); closeUsages(); return true; }
  if (event.key === 'ArrowDown') { event.preventDefault(); usageActive = Math.min(usageActive + 1, usageItems.length - 1); updateUsageActive(); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); usageActive = Math.max(usageActive - 1, 0); updateUsageActive(); return true; }
  if (event.key === 'Enter') { event.preventDefault(); openUsageItem(usageItems[usageActive]); return true; }
  return false;
}
function openUsageItem(item) {
  if (!item) return;
  closeUsages();
  openSourceAt(item.path, item.lineIndex, item.column);
}
function closeUsages() {
  var box = document.getElementById('usages');
  if (!box) return;
  box.classList.add('hidden');
  var panel = box.querySelector('.quick-open-panel');
  if (panel) resetUsagesAnchor(box, panel); // clear inline anchoring so the next open re-measures cleanly
}

function wordAtDiffCaret() {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return null;
  var text = diffLineText(diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex));
  var column = Math.max(0, Math.min(diffCursor.column, text.length));
  var identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  var match = null;
  while ((match = identifier.exec(text))) {
    if (column >= match.index && column <= match.index + match[0].length) return match[0];
  }
  return null;
}
function goToSymbolFromDiff() {
  goToDefOrUsages(wordAtDiffCaret(), caretSourceLoc());
}
function findSymbolDefinition(name) {
  const matchers = definitionMatchers(name);
  const currentPath = viewerCursor?.path || '';
  const orderedFiles = [
    ...sourceFiles.filter((file) => file.path === currentPath),
    ...sourceFiles.filter((file) => file.path !== currentPath),
  ].filter((file) => file.embedded);

  for (const file of orderedFiles) {
    const lines = file.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (matchers.some((matcher) => matcher.test(line))) {
        return { path: file.path, lineIndex, column: Math.max(0, line.indexOf(name)) };
      }
    }
  }
  return null;
}

function definitionMatchers(name) {
  const escaped = escapeRegExp(name);
  const mod = '(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|enum|annotation|static|export|default|expect|actual|value)\\s+)*';
  const funMod = '(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\\s+)*';
  return [
    new RegExp('^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + mod + '(?:class|interface|object|enum|trait|struct)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|val)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + '(?:fun|def|fn|func)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + escaped + '\\s*\\([^)]*\\)\\s*(?::\\s*[^=]+)?\\s*(?:\\{|=>)'),
    new RegExp('^\\s*' + escaped + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)'),
  ];
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function setSourceTypeIcon(path) {
  var holder = document.getElementById('source-type-icon');
  if (!holder) return;
  var link = sourceLinks.find(function (l) { return l.dataset.sourceFile === path; });
  var icon = link ? link.querySelector('.ftype') : null;
  holder.innerHTML = icon ? icon.outerHTML : '';
}
// Files-mode tabs: each distinct file opened in the source viewer becomes a tab (session-only).
// Cmd/Ctrl+W closes the active tab; Cmd/Ctrl+Shift+[ / ] cycle tabs; the × button closes one.
// (sourceTabs is declared near the other source state up top so early restore-state openSourceFile
// calls run before this block don't see an undefined array.)
function addSourceTab(path) { if (path && sourceTabs.indexOf(path) < 0) sourceTabs.push(path); }
function sourceTabLabel(path) { var p = String(path || ''); var s = p.lastIndexOf('/'); return s >= 0 ? p.slice(s + 1) : p; }
function currentSourceTabPath() { var v = document.getElementById('source-viewer'); return (v && v.dataset.openPath) || ''; }
function renderSourceTabs(activePath) {
  var bar = document.getElementById('source-tabs');
  if (!bar) return;
  if (!sourceTabs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = sourceTabs.map(function (p) {
    var active = p === activePath;
    return '<div class="source-tab' + (active ? ' active' : '') + '" data-tab-path="' + escapeHtml(p) + '" title="' + escapeHtml(p) + '">'
      + '<span class="source-tab-name">' + escapeHtml(sourceTabLabel(p)) + '</span>'
      + '<button type="button" class="source-tab-close" data-close-path="' + escapeHtml(p) + '" aria-label="Close tab" title="Close (⌘W)">×</button>'
      + '</div>';
  }).join('');
  // Scroll the tab bar HORIZONTALLY only. scrollIntoView() walks every scrollable ancestor — on rapid
  // Cmd+Shift+[/] cycling it nudged a vertical ancestor and clipped the tab strip at the top. Adjusting
  // bar.scrollLeft directly keeps the active tab in view without ever touching vertical scroll.
  var act = bar.querySelector('.source-tab.active');
  if (act) {
    var bl = bar.getBoundingClientRect(), al = act.getBoundingClientRect();
    if (al.left < bl.left) bar.scrollLeft -= (bl.left - al.left) + 8;
    else if (al.right > bl.right) bar.scrollLeft += (al.right - bl.right) + 8;
  }
}
function closeSourceTab(path) {
  var idx = sourceTabs.indexOf(path);
  if (idx < 0) return;
  var wasActive = path === currentSourceTabPath();
  sourceTabs.splice(idx, 1);
  if (!wasActive) { renderSourceTabs(currentSourceTabPath()); return; }
  var nextPath = sourceTabs[idx] || sourceTabs[idx - 1] || '';
  if (nextPath) { openSourceFile(nextPath); return; }
  // No tabs left: reset the source view to its empty state.
  var v = document.getElementById('source-viewer'); if (v) v.dataset.openPath = '';
  var body = document.getElementById('source-body');
  var title = document.getElementById('source-title');
  var meta = document.getElementById('source-meta');
  if (title) { title.setAttribute('data-i18n', 'source.title'); title.textContent = t('source.title'); }
  if (meta) { meta.setAttribute('data-i18n', 'source.selectFile'); meta.textContent = t('source.selectFile'); }
  if (body) { body.setAttribute('data-i18n', 'source.selectFile'); body.className = 'source-body empty'; body.textContent = t('source.selectFile'); }
  sourceLinks.forEach(function (l) { l.classList.remove('active'); });
  renderSourceTabs('');
}
function closeActiveSourceTab() { var p = currentSourceTabPath(); if (p) { closeSourceTab(p); return true; } return false; }
function cycleSourceTab(dir) {
  if (sourceTabs.length < 2) return;
  var cur = sourceTabs.indexOf(currentSourceTabPath());
  if (cur < 0) cur = 0;
  openSourceFile(sourceTabs[(cur + dir + sourceTabs.length) % sourceTabs.length]);
}
