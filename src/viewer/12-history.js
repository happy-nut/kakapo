// ===== Git history view (Cmd+9): commit list with graph lanes + per-commit diff. =====
// Data comes from the main process (window.monacoriGit.log / .commitDiff); the lane layout is computed
// here from each commit's parents. Read-only — the per-commit diff is static diff2html HTML.

var HISTORY_LANE_W = 14, HISTORY_DOT_R = 3.5, HISTORY_ROW_H = 24;
var HISTORY_COLORS = ['#6c9fd4', '#7faf6b', '#d4a857', '#c77dd4', '#d36c6c', '#5bb6b6', '#b0884f', '#8d8df0'];
var historyCommits = [];
var historyGraph = [];
var historyMaxLane = 0;
var historyActiveSha = '';
var historyLoading = false;
var historyFocus = 'commits'; // commits | files | diff
var historyDiffState = null;

// Lane layout. Walks commits newest-first, tracking open edges (lanes) by the hash each expects next.
// Returns per-row { hash, myLane, color, topEdges, bottomEdges } using LANE INDICES + COLOR INDICES (px-free,
// so it's unit-testable). First parent inherits the commit's color so a branch keeps one hue down its line.
function computeHistoryGraph(commits) {
  var lanes = [];           // lane index -> hash the lane is waiting to reach (open edge from above)
  var colorOf = {};         // hash -> color index
  var next = 0;
  function colorFor(h) { if (colorOf[h] == null) colorOf[h] = next++; return colorOf[h]; }
  function freeLane() { for (var i = 0; i < lanes.length; i++) if (lanes[i] == null) return i; lanes.push(null); return lanes.length - 1; }
  var rows = [];
  var maxLane = 0;
  for (var ci = 0; ci < commits.length; ci++) {
    var c = commits[ci];
    var incoming = lanes.slice();
    var myLane = lanes.indexOf(c.hash);
    if (myLane === -1) myLane = freeLane();
    var myColor = colorFor(c.hash);
    lanes[myLane] = c.hash;
    for (var i = 0; i < lanes.length; i++) if (i !== myLane && lanes[i] === c.hash) lanes[i] = null; // merge other edges in
    var parents = c.parents || [];
    var parentLanes = {};
    if (parents.length === 0) {
      lanes[myLane] = null; // root commit — the lane ends here
    } else {
      lanes[myLane] = parents[0];
      if (colorOf[parents[0]] == null) colorOf[parents[0]] = myColor; // first parent keeps the hue
      parentLanes[myLane] = true;
      for (var p = 1; p < parents.length; p++) {
        var ex = lanes.indexOf(parents[p]);
        var l = ex !== -1 ? ex : freeLane();
        lanes[l] = parents[p];
        colorFor(parents[p]);
        parentLanes[l] = true;
      }
    }
    var outgoing = lanes.slice();
    var topEdges = [];
    for (var a = 0; a < incoming.length; a++) {
      if (incoming[a] == null) continue;
      topEdges.push({ from: a, to: incoming[a] === c.hash ? myLane : a, color: colorOf[incoming[a]] });
    }
    var bottomEdges = [];
    for (var b = 0; b < outgoing.length; b++) {
      if (outgoing[b] == null) continue;
      bottomEdges.push({ from: parentLanes[b] ? myLane : b, to: b, color: colorOf[outgoing[b]] });
    }
    for (var m = 0; m < Math.max(incoming.length, outgoing.length); m++) {
      if (incoming[m] != null || outgoing[m] != null) maxLane = Math.max(maxLane, m);
    }
    maxLane = Math.max(maxLane, myLane);
    rows.push({ hash: c.hash, myLane: myLane, color: myColor, topEdges: topEdges, bottomEdges: bottomEdges });
  }
  rows.maxLane = maxLane;
  return rows;
}
if (typeof window !== 'undefined') window.computeHistoryGraph = computeHistoryGraph; // exposed for tests

function historyLaneX(l) { return 9 + l * HISTORY_LANE_W; }
function historyColor(i) { return HISTORY_COLORS[i % HISTORY_COLORS.length]; }
function historyRowSvg(row) {
  var w = historyLaneX(historyMaxLane) + 9, h = HISTORY_ROW_H, mid = h / 2;
  var s = '<svg class="hgraph" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">';
  var edge = function (e, y1, y2) {
    var x1 = historyLaneX(e.from), x2 = historyLaneX(e.to);
    var c1 = (y1 + y2) / 2;
    return '<path d="M' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + c1 + ', ' + x2 + ' ' + c1 + ', ' + x2 + ' ' + y2 + '" stroke="' + historyColor(e.color) + '" fill="none" stroke-width="1.6"/>';
  };
  row.topEdges.forEach(function (e) { s += edge(e, 0, mid); });
  row.bottomEdges.forEach(function (e) { s += edge(e, mid, h); });
  s += '<circle cx="' + historyLaneX(row.myLane) + '" cy="' + mid + '" r="' + HISTORY_DOT_R + '" fill="' + historyColor(row.color) + '"/></svg>';
  return s;
}

// "HEAD -> main, origin/main, tag: v1" -> small badges (HEAD/branch/tag styled distinctly).
function historyRefBadges(refs) {
  if (!refs || !refs.trim()) return '';
  return refs.split(',').map(function (r) {
    r = r.trim();
    if (!r) return '';
    var cls = 'href-branch', label = r;
    if (r.indexOf('tag:') === 0) { cls = 'href-tag'; label = r.replace('tag:', '').trim(); }
    else if (r.indexOf('HEAD') === 0) { cls = 'href-head'; }
    else if (r.indexOf('origin/') === 0 || r.indexOf('/') !== -1) { cls = 'href-remote'; }
    return '<span class="href ' + cls + '">' + escapeHtml(label) + '</span>';
  }).join('');
}

function historyShortDate(iso) {
  if (!iso) return '';
  // 2026-06-20T21:03:11+09:00 -> "2026-06-20 21:03"
  var m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? m[1] + ' ' + m[2] : String(iso).slice(0, 16);
}

function renderHistoryList() {
  var list = document.getElementById('history-list');
  if (!list) return;
  if (!historyCommits.length) {
    list.innerHTML = historyLoading
      ? loadingStateHtml(t('history.loading'), 'quick-open-empty')
      : '<div class="quick-open-empty">' + escapeHtml(t('history.empty')) + '</div>';
    return;
  }
  list.style.setProperty('--hgraph-w', (historyLaneX(historyMaxLane) + 9) + 'px');
  list.innerHTML = historyCommits.map(function (c, i) {
    return '<button type="button" class="hrow' + (c.hash === historyActiveSha ? ' active' : '') + '" data-sha="' + escapeHtml(c.hash) + '">'
      + '<span class="hgraph-cell">' + historyRowSvg(historyGraph[i]) + '</span>'
      + '<span class="hmsg">' + historyRefBadges(c.refs) + escapeHtml(c.subject) + '</span>'
      + '<span class="hauthor">' + escapeHtml(c.author) + '</span>'
      + '<span class="hdate">' + escapeHtml(historyShortDate(c.date)) + '</span>'
      + '</button>';
  }).join('');
}

function historyVisibleRows() {
  var list = document.getElementById('history-list');
  return list ? Array.prototype.slice.call(list.querySelectorAll('.hrow')).filter(function (r) { return !r.classList.contains('hidden'); }) : [];
}
function selectHistoryCommit(sha, shouldScroll) {
  if (!sha) return;
  historyActiveSha = sha;
  var list = document.getElementById('history-list');
  if (!list) return;
  var active = null;
  list.querySelectorAll('.hrow').forEach(function (r) {
    var on = r.dataset.sha === sha;
    r.classList.toggle('active', on);
    if (on) active = r;
  });
  if (shouldScroll !== false && active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}
function moveHistoryCommit(delta) {
  var rows = historyVisibleRows();
  if (!rows.length) return;
  var idx = rows.findIndex(function (r) { return r.dataset.sha === historyActiveSha; });
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
  historyFocus = 'commits';
  selectHistoryCommit(rows[idx].dataset.sha, true);
}

// Text filter (subject / author). The graph only reads right on the full contiguous history, so filtering
// hides the graph column (IntelliJ does the same) and just shows matching rows.
function applyHistoryFilter() {
  var input = document.getElementById('history-search');
  var list = document.getElementById('history-list');
  if (!list) return;
  var q = (input && input.value || '').trim().toLowerCase();
  list.classList.toggle('filtering', q.length > 0);
  var rows = list.querySelectorAll('.hrow');
  for (var i = 0; i < rows.length; i++) {
    var c = historyCommits[i];
    var hit = !q || (c.subject + '\n' + c.author + '\n' + c.hash).toLowerCase().indexOf(q) !== -1;
    rows[i].classList.toggle('hidden', !hit);
  }
  var visible = historyVisibleRows();
  if (visible.length && !visible.some(function (r) { return r.dataset.sha === historyActiveSha; })) {
    selectHistoryCommit(visible[0].dataset.sha, false);
  }
}

function openHistoryCommit(sha) {
  if (!sha || !window.monacoriGit) return;
  selectHistoryCommit(sha, true);
  var detail = document.getElementById('history-detail');
  if (detail) detail.innerHTML = loadingStateHtml(t('history.loading'), 'quick-open-empty');
  Promise.resolve(window.monacoriGit.commitDiff(sha)).then(function (d) {
    if (!d || historyActiveSha !== sha) return; // selection moved on while loading
    renderHistoryDetail(d);
  }, function () {});
}

function renderHistoryDetail(d) {
  var detail = document.getElementById('history-detail');
  if (!detail) return;
  var head = '<div class="history-detail-head">'
    + '<div class="hd-msg">' + escapeHtml(d.message || '').replace(/\n/g, '<br>') + '</div>'
    + '<div class="hd-meta"><span class="hd-hash">' + escapeHtml((d.hash || '').slice(0, 10)) + '</span>'
    + '<span class="hd-author">' + escapeHtml(d.author) + (d.email ? ' &lt;' + escapeHtml(d.email) + '&gt;' : '') + '</span>'
    + '<span class="hd-date">' + escapeHtml(historyShortDate(d.date)) + '</span>'
    + historyRefBadges(d.refs) + '</div></div>';
  var body = (d.diffHtml && d.diffHtml.trim())
    ? '<div class="history-workspace"><aside id="history-files" class="history-files"></aside><div id="history-diff-container" class="history-diff diff2html-container" tabindex="0" aria-readonly="true">' + d.diffHtml + '</div></div>'
    : '<div class="quick-open-empty">' + escapeHtml(t(d.isMerge ? 'history.merge' : 'history.noDiff')) + '</div>';
  detail.innerHTML = head + body;
  setupHistoryDiffWorkspace(d.hash || historyActiveSha);
}

function historyWrapperPathKey(w) {
  return (w.dataset && w.dataset.path) || ((w.querySelector('.d2h-file-name') || {}).textContent || '').trim();
}
function historyWrapperByPath(path) {
  if (!historyDiffState || !path) return null;
  for (var i = 0; i < historyDiffState.wrappers.length; i++) {
    if (historyWrapperPathKey(historyDiffState.wrappers[i]) === path) return historyDiffState.wrappers[i];
  }
  return null;
}
function historySideTables(wrapper) {
  var sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  return { left: sides[0] || null, right: sides[sides.length - 1] || null };
}
function historySideTable(wrapper, side) {
  var t = historySideTables(wrapper);
  return side === 'old' ? t.left : t.right;
}
function historyRowsOf(sideTable) {
  return diffRowsOf(sideTable);
}
function historyRowAt(wrapper, side, rowIndex) {
  return historyRowsOf(historySideTable(wrapper, side))[rowIndex] || null;
}
function historyDiffRowInfoFromNode(node) {
  var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  if (!el || !el.closest) return null;
  var wrapper = el.closest('.d2h-file-wrapper');
  var sideEl = el.closest('.d2h-file-side-diff');
  var row = el.closest('tr');
  if (!wrapper || !sideEl || !row || !isDiffCodeRow(row)) return null;
  var path = historyWrapperPathKey(wrapper);
  var t = historySideTables(wrapper);
  var rowIndex = historyRowsOf(sideEl).indexOf(row);
  if (!path || rowIndex < 0) return null;
  return { path: path, side: sideEl === t.left ? 'old' : 'new', rowIndex: rowIndex };
}
function historyFirstDiffCodeRow(wrapper, side) {
  var rows = historyRowsOf(historySideTable(wrapper, side));
  for (var i = 0; i < rows.length; i++) if (isDiffCodeRow(rows[i])) return i;
  return -1;
}
function historyFirstCodeRowOfHunk(hunkRow) {
  var row = hunkRow.nextElementSibling;
  var firstRow = null;
  while (row && !row.classList.contains('history-hunk') && !row.classList.contains('history-hunk-peer')) {
    if (row.querySelector && row.querySelector('.d2h-code-side-line')) {
      if (!firstRow) firstRow = row;
      if (isChangeCodeRow(row)) return row;
    }
    row = row.nextElementSibling;
  }
  return firstRow || hunkRow;
}
function historyFirstChangeRowForCaret(hunkRow) {
  var wrapper = hunkRow.closest('.d2h-file-wrapper');
  var sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  var hunkSideEl = hunkRow.closest('.d2h-file-side-diff');
  if (sides.length >= 2 && hunkSideEl) {
    var hunkRows = Array.prototype.slice.call(hunkSideEl.querySelectorAll('tr'));
    var otherEl = hunkSideEl === sides[0] ? sides[1] : sides[0];
    var otherRows = Array.prototype.slice.call(otherEl.querySelectorAll('tr'));
    var fallbackOld = null;
    for (var i = hunkRows.indexOf(hunkRow) + 1; i < hunkRows.length; i++) {
      var hr = hunkRows[i];
      if (hr.classList.contains('history-hunk') || hr.classList.contains('history-hunk-peer')) break;
      if (isChangeCodeRow(otherRows[i])) return otherRows[i];
      if (fallbackOld === null && isChangeCodeRow(hr)) fallbackOld = hr;
    }
    if (fallbackOld) return fallbackOld;
  }
  return historyFirstCodeRowOfHunk(hunkRow);
}
function setupHistoryDiffWorkspace(sha) {
  var container = document.getElementById('history-diff-container');
  var filesEl = document.getElementById('history-files');
  if (!container || !filesEl) { historyDiffState = null; return; }
  container.querySelectorAll('.d2h-code-side-linenumber, .d2h-code-linenumber, .d2h-code-line-prefix').forEach(function (el) { el.setAttribute('contenteditable', 'false'); });
  var wrappers = Array.prototype.slice.call(container.querySelectorAll('.d2h-file-wrapper'));
  var files = [], hunks = [];
  var hunkIndex = 0;
  wrappers.forEach(function (wrapper, fileIndex) {
    var path = historyWrapperPathKey(wrapper);
    if (path) wrapper.dataset.path = path;
    wrapper.dataset.historyFileIndex = String(fileIndex);
    var first = hunkIndex;
    var headerToIndex = new Map();
    Array.prototype.forEach.call(wrapper.querySelectorAll('tr'), function (row) {
      var header = (row.textContent || '').trim();
      if (header.indexOf('@@') !== 0) return;
      var idx = headerToIndex.get(header);
      if (idx === undefined) {
        idx = hunkIndex++;
        headerToIndex.set(header, idx);
        row.classList.add('history-hunk');
        hunks[idx] = { path: path, row: row };
      } else {
        row.classList.add('history-hunk-peer');
      }
      row.dataset.historyHunkIndex = String(idx);
      row.dataset.historyFile = path;
    });
    files.push({ path: path, hunk: first, count: hunkIndex - first });
  });
  historyDiffState = { sha: sha, container: container, filesEl: filesEl, wrappers: wrappers, files: files, hunks: hunks, currentHunk: -1, cursor: null, fileFocusIndex: 0 };
  filesEl.innerHTML = files.map(function (file, i) {
    var slash = file.path.lastIndexOf('/');
    var name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
    var dir = slash >= 0 ? file.path.slice(0, slash) : '';
    return '<button type="button" class="file-link history-file" data-index="' + i + '" data-file="' + escapeHtml(file.path) + '" data-hunk="' + file.hunk + '">'
      + '<span class="status status-modified" role="img" aria-label="Modified" title="Modified"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.2 11.8.6-2.7 6.6-6.6a1.2 1.2 0 0 1 1.7 0l1.4 1.4a1.2 1.2 0 0 1 0 1.7L6.9 12.2l-2.7.6zM9.5 3.4l3.1 3.1"/></svg></span><span class="change-name"><span class="path" title="' + escapeHtml(file.path) + '">' + escapeHtml(name) + '</span>'
      + (dir ? '<span class="change-dir">' + escapeHtml(dir) + '</span>' : '') + '</span></button>';
  }).join('');
  container.addEventListener('click', function (event) {
    var info = historyDiffRowInfoFromNode(event.target);
    if (info && info.path) {
      historyFocus = 'diff';
      historySetDiffCursor(info.path, info.side, info.rowIndex, 0, false);
    }
  });
  if (files[0]) historyShowFile(files[0].path, files[0].hunk, false);
  focusHistoryDiff();
}
function historySetFileFocus(index) {
  if (!historyDiffState || !historyDiffState.files.length) return;
  var max = historyDiffState.files.length - 1;
  historyDiffState.fileFocusIndex = Math.max(0, Math.min(max, index));
  historyFocus = 'files';
  var btns = historyDiffState.filesEl.querySelectorAll('.history-file');
  btns.forEach(function (b, i) {
    b.classList.toggle('tree-focus', i === historyDiffState.fileFocusIndex);
    if (i === historyDiffState.fileFocusIndex && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' });
  });
}
function focusHistoryFiles() {
  if (!historyDiffState) return;
  var active = historyDiffState.files.findIndex(function (f) { return f.path === historyCurrentFile(); });
  historySetFileFocus(active >= 0 ? active : 0);
}
function focusHistoryDiff() {
  if (!historyDiffState) return;
  historyFocus = 'diff';
  historyDiffState.filesEl.querySelectorAll('.history-file').forEach(function (b) { b.classList.remove('tree-focus'); });
  try { historyDiffState.container.focus(); } catch (e) {}
}
function historyCurrentFile() {
  if (!historyDiffState) return '';
  var active = historyDiffState.filesEl.querySelector('.history-file.active');
  return active ? active.dataset.file || '' : '';
}
function historyShowFile(path, hunkIndex, shouldScroll) {
  if (!historyDiffState || !path) return;
  historyDiffState.wrappers.forEach(function (wrapper) {
    wrapper.classList.toggle('df-inactive', historyWrapperPathKey(wrapper) !== path);
  });
  historyDiffState.filesEl.querySelectorAll('.history-file').forEach(function (button, i) {
    var on = button.dataset.file === path;
    button.classList.toggle('active', on);
    if (on) historyDiffState.fileFocusIndex = i;
  });
  var file = historyDiffState.files.find(function (f) { return f.path === path; });
  var target = typeof hunkIndex === 'number' && hunkIndex >= 0 ? hunkIndex : (file ? file.hunk : -1);
  if (target >= 0 && historyDiffState.hunks[target]) historySetActiveHunk(target, shouldScroll !== false);
  else historyEnsureDiffCursor(path, shouldScroll !== false);
}
function historyHunkPathAt(index) {
  return historyDiffState && historyDiffState.hunks[index] ? historyDiffState.hunks[index].path : '';
}
function historySetActiveHunk(index, shouldScroll) {
  if (!historyDiffState || !historyDiffState.hunks.length) return;
  var len = historyDiffState.hunks.length;
  var idx = ((index % len) + len) % len;
  var h = historyDiffState.hunks[idx];
  if (!h || !h.path) return;
  historyDiffState.currentHunk = idx;
  historyDiffState.wrappers.forEach(function (wrapper) {
    wrapper.classList.toggle('df-inactive', historyWrapperPathKey(wrapper) !== h.path);
  });
  historyDiffState.filesEl.querySelectorAll('.history-file').forEach(function (button, i) {
    var on = button.dataset.file === h.path;
    button.classList.toggle('active', on);
    if (on) historyDiffState.fileFocusIndex = i;
  });
  historyDiffState.container.querySelectorAll('.history-hunk.active, .history-hunk-peer.active').forEach(function (row) { row.classList.remove('active'); });
  historyDiffState.container.querySelectorAll('[data-history-hunk-index="' + idx + '"]').forEach(function (row) { row.classList.add('active'); });
  var targetRow = historyFirstChangeRowForCaret(h.row);
  if (targetRow) {
    var info = historyDiffRowInfoFromNode(targetRow);
    if (info) historySetDiffCursor(info.path, info.side, info.rowIndex, 0, shouldScroll);
  }
}
function historyEnsureDiffCursor(path, reveal) {
  var wrapper = historyWrapperByPath(path);
  var ri = historyFirstDiffCodeRow(wrapper, 'new');
  if (ri >= 0) historySetDiffCursor(path, 'new', ri, 0, reveal);
}
function historyClearDiffCaret() {
  if (!historyDiffState) return;
  historyDiffState.container.querySelectorAll('.mc-diff-cursor-row').forEach(function (r) { r.classList.remove('mc-diff-cursor-row'); });
  historyDiffState.container.querySelectorAll('.code-cursor').forEach(function (s) { var p = s.parentNode; if (p) { p.removeChild(s); if (p.normalize) p.normalize(); } });
}
function historyRenderDiffCaret() {
  historyClearDiffCaret();
  if (!historyDiffState || !historyDiffState.cursor) return;
  var c = historyDiffState.cursor;
  var wrapper = historyWrapperByPath(c.path);
  var row = wrapper ? historyRowAt(wrapper, c.side, c.rowIndex) : null;
  if (!row) return;
  row.classList.add('mc-diff-cursor-row');
  var ctn = diffCellCtn(row);
  if (!ctn) return;
  if ((ctn.textContent || '').length === 0) {
    var emptySpan = document.createElement('span');
    emptySpan.className = 'code-cursor';
    emptySpan.setAttribute('aria-hidden', 'true');
    emptySpan.style.position = 'absolute';
    ctn.appendChild(emptySpan);
    return;
  }
  var pos = diffCaretDomPosition(ctn, c.column);
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
  } catch (e) {}
}
function historySetDiffCursor(path, side, rowIndex, column, reveal) {
  if (!historyDiffState) return;
  var wrapper = historyWrapperByPath(path);
  if (!wrapper) return;
  var rows = historyRowsOf(historySideTable(wrapper, side));
  if (!rows.length) return;
  var ri = Math.max(0, Math.min(rowIndex, rows.length - 1));
  var col = Math.max(0, Math.min(column, diffLineText(rows[ri]).length));
  historyDiffState.cursor = { path: path, side: side, rowIndex: ri, column: col };
  historyRenderDiffCaret();
  if (reveal) scrolloffReveal(rows[ri], historyDiffState.container, 0.15);
}
function historyMoveDiffCursor(dLine, dColumn) {
  if (!historyDiffState || !historyDiffState.cursor) return;
  var c = historyDiffState.cursor;
  var wrapper = historyWrapperByPath(c.path);
  if (!wrapper) return;
  var rows = historyRowsOf(historySideTable(wrapper, c.side));
  var ri = c.rowIndex, col = c.column;
  var text = diffLineText(rows[ri]);
  if (dColumn < 0) {
    if (col > 0) col -= 1;
    else { var p = ri - 1; while (p >= 0 && !isDiffCodeRow(rows[p])) p -= 1; if (p >= 0) { ri = p; col = diffLineText(rows[p]).length; } }
  } else if (dColumn > 0) {
    if (col < text.length) col += 1;
    else { var n = ri + 1; while (n < rows.length && !isDiffCodeRow(rows[n])) n += 1; if (n < rows.length) { ri = n; col = 0; } }
  }
  if (dLine !== 0) {
    var step = dLine > 0 ? 1 : -1;
    var cand = ri + step;
    while (cand >= 0 && cand < rows.length && !isDiffCodeRow(rows[cand])) cand += step;
    if (cand >= 0 && cand < rows.length) { ri = cand; col = Math.min(col, diffLineText(rows[ri]).length); }
  }
  historySetDiffCursor(c.path, c.side, ri, col, true);
}
function historyNextHunk(delta) {
  if (!historyDiffState || !historyDiffState.hunks.length) return;
  var base = historyDiffState.currentHunk >= 0 ? historyDiffState.currentHunk : 0;
  historySetActiveHunk(base + delta, true);
  focusHistoryDiff();
}
function historySelectAllDiff() {
  if (!historyDiffState) return;
  var sel = window.getSelection();
  if (!sel) return;
  var range = document.createRange();
  range.selectNodeContents(historyDiffState.container);
  sel.removeAllRanges();
  sel.addRange(range);
}
function handleHistoryDiffKey(event) {
  if (!historyDiffState || !historyDiffState.cursor) return false;
  if (event.key === 'Tab' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    var tc = historyDiffState.cursor;
    var tw = historyWrapperByPath(tc.path);
    var otherSide = tc.side === 'new' ? 'old' : 'new';
    var otherRow = tw ? historyRowAt(tw, otherSide, tc.rowIndex) : null;
    if (isDiffCodeRow(otherRow)) historySetDiffCursor(tc.path, otherSide, tc.rowIndex, Math.min(tc.column, diffLineText(otherRow).length), true);
    return true;
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey) {
    if (event.key === 'ArrowDown') { historyMoveDiffCursor(1, 0); return true; }
    if (event.key === 'ArrowUp') { historyMoveDiffCursor(-1, 0); return true; }
    if (event.key === 'ArrowLeft') { historyMoveDiffCursor(0, -1); return true; }
    if (event.key === 'ArrowRight') { historyMoveDiffCursor(0, 1); return true; }
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    var wc = historyDiffState.cursor;
    var ww = historyWrapperByPath(wc.path);
    var wr = ww ? historyRowAt(ww, wc.side, wc.rowIndex) : null;
    var nextCol = typeof nextWordBoundary === 'function'
      ? nextWordBoundary(diffLineText(wr), wc.column, event.key === 'ArrowRight' ? 1 : -1)
      : wc.column;
    historySetDiffCursor(wc.path, wc.side, wc.rowIndex, nextCol, true);
    return true;
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    var c = historyDiffState.cursor;
    var wrapper = historyWrapperByPath(c.path);
    var row = wrapper ? historyRowAt(wrapper, c.side, c.rowIndex) : null;
    var len = diffLineText(row).length;
    if (event.key === 'ArrowLeft') {
      if (c.column > 0) historySetDiffCursor(c.path, c.side, c.rowIndex, 0, true);
      else if (c.side === 'new') { var oldRow = historyRowAt(wrapper, 'old', c.rowIndex); if (isDiffCodeRow(oldRow)) historySetDiffCursor(c.path, 'old', c.rowIndex, diffLineText(oldRow).length, true); }
    } else {
      if (c.column < len) historySetDiffCursor(c.path, c.side, c.rowIndex, len, true);
      else if (c.side === 'old') { var newRow = historyRowAt(wrapper, 'new', c.rowIndex); if (isDiffCodeRow(newRow)) historySetDiffCursor(c.path, 'new', c.rowIndex, 0, true); }
    }
    return true;
  }
  return false;
}

function isHistoryOpen() {
  var v = document.getElementById('history-view');
  return !!(v && !v.classList.contains('hidden'));
}
function closeHistory() {
  var v = document.getElementById('history-view');
  if (v) v.classList.add('hidden');
  historyFocus = 'commits';
  if (typeof syncRail === 'function') syncRail();
}
function openHistory() {
  var v = document.getElementById('history-view');
  if (!v) return;
  if (!window.monacoriGit) return; // browser/serve mode: no git bridge
  v.classList.remove('hidden');
  if (typeof syncRail === 'function') syncRail();
  var search = document.getElementById('history-search');
  if (search) { search.value = ''; }
  applyHistoryFilter();
  historyLoading = true;
  historyFocus = 'commits';
  historyDiffState = null;
  renderHistoryList();
  Promise.resolve(window.monacoriGit.log({ limit: 300 })).then(function (commits) {
    historyLoading = false;
    historyCommits = Array.isArray(commits) ? commits : [];
    historyGraph = computeHistoryGraph(historyCommits);
    historyMaxLane = historyGraph.maxLane || 0;
    renderHistoryList();
    var detail = document.getElementById('history-detail');
    if (detail) detail.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('history.selectCommit')) + '</div>';
    if (historyCommits[0]) selectHistoryCommit(historyCommits[0].hash, false);
    setTimeout(function () { try { v.focus(); } catch (e) {} }, 0);
  }, function () { historyLoading = false; renderHistoryList(); });
}
function toggleHistory() { if (isHistoryOpen()) closeHistory(); else openHistory(); }
if (typeof window !== 'undefined') window.__monacoriHistory = { open: openHistory, close: closeHistory, toggle: toggleHistory, isOpen: isHistoryOpen };

function handleHistoryKey(e) {
  if (!isHistoryOpen()) return false;
  var ae = document.activeElement;
  var inSearch = ae && ae.id === 'history-search';
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.code === 'Digit9' || e.key === '9')) {
    e.preventDefault(); e.stopPropagation(); closeHistory(); return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeHistory(); return true; }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === '0') {
    if (historyDiffState) { e.preventDefault(); e.stopPropagation(); focusHistoryFiles(); return true; }
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'A') && historyFocus === 'diff') {
    e.preventDefault(); e.stopPropagation(); historySelectAllDiff(); return true;
  }
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    var scroller = historyFocus === 'diff' && historyDiffState ? historyDiffState.container : document.getElementById('history-list');
    if (scroller) { e.preventDefault(); e.stopPropagation(); scroller.scrollTop += (e.key === 'PageDown' ? 0.9 : -0.9) * scroller.clientHeight; return true; }
  }
  if (e.key === 'F7' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); e.stopPropagation(); historyNextHunk(e.shiftKey ? -1 : 1); return true;
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); e.stopPropagation();
    var delta = e.key === 'ArrowDown' ? 1 : -1;
    if (historyFocus === 'files') historySetFileFocus((historyDiffState ? historyDiffState.fileFocusIndex : 0) + delta);
    else if (historyFocus === 'diff' && historyDiffState) historyMoveDiffCursor(delta, 0);
    else moveHistoryCommit(delta);
    return true;
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && historyFocus === 'diff') {
    e.preventDefault(); e.stopPropagation(); historyMoveDiffCursor(0, e.key === 'ArrowRight' ? 1 : -1); return true;
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    if (historyFocus === 'diff') {
      return true;
    } else if (historyFocus === 'files' && historyDiffState) {
      var file = historyDiffState.files[historyDiffState.fileFocusIndex];
      if (file) historyShowFile(file.path, file.hunk, true);
      focusHistoryDiff();
    } else {
      var rows = historyVisibleRows();
      var row = rows.find(function (r) { return r.dataset.sha === historyActiveSha; }) || rows[0];
      if (row) openHistoryCommit(row.dataset.sha);
    }
    return true;
  }
  if (historyFocus === 'diff' && handleHistoryDiffKey(e)) { e.preventDefault(); e.stopPropagation(); return true; }
  return !inSearch && historyFocus !== 'commits';
}

(function wireHistory() {
  var list = document.getElementById('history-list');
  if (list) list.addEventListener('click', function (e) {
    var row = e.target.closest && e.target.closest('.hrow[data-sha]');
    if (row) openHistoryCommit(row.dataset.sha);
  });
  var search = document.getElementById('history-search');
  if (search) search.addEventListener('input', applyHistoryFilter);
  var closeBtn = document.getElementById('history-close');
  if (closeBtn) closeBtn.addEventListener('click', closeHistory);
  var view = document.getElementById('history-view');
  if (view) view.setAttribute('tabindex', '-1');
  if (view) view.addEventListener('keydown', function (e) {
    handleHistoryKey(e);
  });
  var detail = document.getElementById('history-detail');
  if (detail) detail.addEventListener('click', function (e) {
    var file = e.target.closest && e.target.closest('.history-file[data-file]');
    if (file && historyDiffState) {
      e.preventDefault();
      historyShowFile(file.dataset.file, Number(file.dataset.hunk), true);
      focusHistoryDiff();
    }
  });
})();
