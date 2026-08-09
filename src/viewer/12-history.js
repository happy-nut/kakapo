// ===== Git history view (Cmd+9): commit list with graph lanes + per-commit diff. =====
// Data comes from the main process (window.kakapoGit.log / .commitDiff); the lane layout is computed
// here from each commit's parents. Read-only — the per-commit diff is static diff2html HTML.

var HISTORY_LANE_W = 16, HISTORY_DOT_R = 3.8, HISTORY_ROW_H = 26;
var HISTORY_COLORS = ['#43a5ff', '#ef4fb3', '#55d66b', '#f2a93b', '#a875ff', '#24c7bd', '#f06f62', '#91a4ff'];
var historyCommits = [];
var historyGraph = [];
var historyMaxLane = 0;
var historyActiveSha = '';
var historyLoading = false;
var historyFocus = 'commits'; // commits | files | diff
var historyDiffState = null;
var historyDetailSha = '';
var historyFilesCollapsed = false;
var historyScope = null; // null | { path, line } — right-clicked source line history
var historyLoadSeq = 0;
var historyDirectDetail = false; // a gutter attribution opened one commit diff without the graph first
var historyDirectPath = '';
var historyAnchorSha = ''; // shift-select range anchor; the other end is historyActiveSha (the focus)

// Lane layout. Walk commits newest-first (git --topo-order) and track the parent hash each open lane is
// waiting for. A lane is an object rather than just a hash so its color survives merges. Once a branch
// joins another branch its dead lane is removed immediately; the remaining lanes curve into their compact
// positions in the lower half of that commit row instead of leaving ever-widening holes.
function computeHistoryGraph(commits) {
  var lanes = []; // { hash, color } in their position at the top of the next row
  var nextColor = 0;
  function newLane(hash, color) {
    return { hash: hash, color: color == null ? nextColor++ : color };
  }
  var rows = [];
  var maxLane = 0;
  for (var ci = 0; ci < commits.length; ci++) {
    var c = commits[ci];
    var incoming = lanes.slice();
    var myLane = incoming.findIndex(function (lane) { return lane.hash === c.hash; });
    var introduced = myLane < 0;
    if (myLane < 0) {
      // A tip from another ref (or a history page boundary) begins at the right edge so it never shifts
      // an already-visible branch before the first connecting curve is drawn.
      myLane = incoming.length;
      incoming.push(newLane(c.hash));
    }
    var myColor = incoming[myLane].color;
    var parents = c.parents || [];
    var working = incoming.map(function (lane) { return lane.hash === c.hash ? null : lane; });
    var parentRecords = [];
    for (var p = 0; p < parents.length; p++) {
      var parent = parents[p];
      var existing = working.find(function (lane) { return lane && lane.hash === parent; });
      if (existing) {
        parentRecords.push(existing);
        continue;
      }
      var record = newLane(parent, p === 0 ? myColor : null);
      parentRecords.push(record);
      if (p === 0 && working[myLane] == null) working[myLane] = record;
      else working.splice(Math.min(working.length, myLane + p), 0, record);
    }
    // A criss-cross merge may mention the same parent more than once. Keep one physical lane per hash.
    var seen = {};
    lanes = working.filter(function (lane) {
      if (!lane || seen[lane.hash]) return false;
      seen[lane.hash] = true;
      return true;
    });
    var topEdges = [];
    for (var a = 0; a < incoming.length; a++) {
      if (introduced && a === myLane) continue; // a ref tip begins at its dot; no dangling line above it
      topEdges.push({ from: a, to: incoming[a].hash === c.hash ? myLane : a, color: incoming[a].color });
    }
    var bottomEdges = [];
    // Unrelated lanes pass through the row and curve left when the consumed merge lane disappears.
    for (var b = 0; b < incoming.length; b++) {
      var through = incoming[b];
      if (through.hash === c.hash) continue;
      var throughTo = lanes.indexOf(through);
      if (throughTo >= 0) bottomEdges.push({ from: b, to: throughTo, color: through.color });
    }
    // Every parent leaves the commit node. Existing parents keep their branch color; the first newly
    // opened parent inherits the commit color, matching the mainline convention used by IDE graphs.
    var emittedParents = {};
    for (var q = 0; q < parentRecords.length; q++) {
      var parentRecord = parentRecords[q];
      var parentTo = lanes.indexOf(parentRecord);
      if (parentTo < 0 || emittedParents[parentRecord.hash]) continue;
      emittedParents[parentRecord.hash] = true;
      bottomEdges.push({ from: myLane, to: parentTo, color: parentRecord.color });
    }
    maxLane = Math.max(maxLane, myLane, incoming.length - 1, lanes.length - 1);
    rows.push({ hash: c.hash, myLane: myLane, color: myColor, topEdges: topEdges, bottomEdges: bottomEdges, isMerge: parents.length > 1, isRoot: parents.length === 0 });
  }
  rows.maxLane = maxLane;
  return rows;
}
if (typeof window !== 'undefined') window.computeHistoryGraph = computeHistoryGraph; // exposed for tests

function historyLaneX(l) { return 10 + l * HISTORY_LANE_W; }
function historyColor(i) { return HISTORY_COLORS[i % HISTORY_COLORS.length]; }
function historyRowSvg(row) {
  var w = historyLaneX(historyMaxLane) + 10, h = HISTORY_ROW_H, mid = h / 2;
  var s = '<svg class="hgraph" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">';
  var edge = function (e, y1, y2) {
    var x1 = historyLaneX(e.from), x2 = historyLaneX(e.to);
    var c1 = (y1 + y2) / 2;
    return '<path d="M' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + c1 + ', ' + x2 + ' ' + c1 + ', ' + x2 + ' ' + y2 + '" stroke="' + historyColor(e.color) + '" fill="none" stroke-width="2" stroke-linecap="round"/>';
  };
  row.topEdges.forEach(function (e) { s += edge(e, 0, mid); });
  row.bottomEdges.forEach(function (e) { s += edge(e, mid, h); });
  s += '<circle class="hgraph-dot' + (row.isMerge ? ' merge' : '') + (row.isRoot ? ' root' : '') + '" cx="' + historyLaneX(row.myLane) + '" cy="' + mid + '" r="' + HISTORY_DOT_R + '" fill="' + historyColor(row.color) + '" stroke="var(--chrome-panel)" stroke-width="1.2"/></svg>';
  return s;
}
function historyLineRowSvg() {
  return '<svg class="hgraph hline-graph" width="28" height="26" viewBox="0 0 28 26" aria-hidden="true">'
    + '<path d="M14 0V26" stroke="' + historyColor(0) + '" fill="none" stroke-width="2"/>'
    + '<circle cx="14" cy="13" r="' + HISTORY_DOT_R + '" fill="' + historyColor(0) + '" stroke="var(--chrome-panel)" stroke-width="1.2"/></svg>';
}

function historyRefIcon(kind) {
  if (kind === 'tag') return '<svg class="href-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.3v4.3l5.9 5.9 5.1-5.1-5.9-5.9H3.3a.8.8 0 0 0-.8.8Z"/><circle cx="5.6" cy="5.6" r="1"/></svg>';
  return '<svg class="href-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.2" r="1.7"/><circle cx="4" cy="12.8" r="1.7"/><circle cx="12" cy="5.8" r="1.7"/><path d="M4 4.9v6.2M5.7 11.1c3.3-.5 5.2-1.7 6-3.6"/></svg>';
}

function historyShortRefName(ref) {
  return String(ref || '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\//, '')
    .replace(/^refs\/tags\//, '');
}

// "HEAD -> main, origin/main, tag: v1" -> IDE-style ref chips with branch/tag glyphs. HEAD's target is
// the useful label, while the full relationship remains available to accessibility and hover text.
function historyRefBadges(refs) {
  if (!refs || !refs.trim()) return '';
  return refs.split(',').map(function (r) {
    r = r.trim();
    if (!r) return '';
    var cls = 'href-branch', kind = 'branch', label = r, title = r;
    if (r.indexOf('tag:') === 0) { cls = 'href-tag'; kind = 'tag'; label = historyShortRefName(r.replace('tag:', '').trim()); }
    else if (r.indexOf('HEAD ->') === 0) { cls = 'href-head'; label = historyShortRefName(r.slice(r.indexOf('->') + 2).trim()); title = 'HEAD → ' + label; }
    else if (r.indexOf('refs/remotes/') === 0) {
      cls = 'href-remote';
      label = historyShortRefName(r.indexOf('->') >= 0 ? r.slice(r.indexOf('->') + 2).trim() : r);
    }
    else if (r.indexOf('refs/heads/') === 0) { cls = 'href-branch'; label = historyShortRefName(r); }
    else if (/^[^/]+\//.test(r)) { cls = 'href-remote'; } // compatibility with short decorations
    return '<span class="href ' + cls + '" title="' + escapeHtml(title) + '">' + historyRefIcon(kind) + '<span class="href-label">' + escapeHtml(label) + '</span></span>';
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
      : '<div class="quick-open-empty">' + escapeHtml(t(historyScope ? 'history.emptyLine' : 'history.empty')) + '</div>';
    return;
  }
  list.style.setProperty('--hgraph-w', historyScope ? '28px' : (historyLaneX(historyMaxLane) + 10) + 'px');
  list.innerHTML = historyCommits.map(function (c, i) {
    var refs = historyRefBadges(c.refs);
    var mergeClass = c.parents && c.parents.length > 1 ? ' merge-commit' : '';
    return '<button type="button" class="hrow' + mergeClass + (c.hash === historyActiveSha ? ' active' : '') + '" data-sha="' + escapeHtml(c.hash) + '" title="' + escapeHtml(c.hash.slice(0, 12) + '  ' + c.subject) + '">'
      + '<span class="hgraph-cell">' + (historyScope ? historyLineRowSvg() : historyRowSvg(historyGraph[i])) + '</span>'
      + '<span class="hmsg">' + (refs ? '<span class="hrefs">' + refs + '</span>' : '') + '<span class="hsubject">' + escapeHtml(c.subject) + '</span></span>'
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
  clearHistoryRange(); // a plain move collapses any shift-selection back to a single commit
  historyAnchorSha = rows[idx].dataset.sha;
  selectHistoryCommit(rows[idx].dataset.sha, true);
}

// ===== Shift-select: compare two commits (patch sets) as one combined diff. =====
function historyIndexOfSha(sha) {
  for (var i = 0; i < historyCommits.length; i++) if (historyCommits[i].hash === sha) return i;
  return -1;
}
// Drop the range highlight and anchor, returning to single-commit selection.
function clearHistoryRange() {
  historyAnchorSha = '';
  var list = document.getElementById('history-list');
  if (list) list.querySelectorAll('.hrow.in-range').forEach(function (r) { r.classList.remove('in-range', 'range-end'); });
  updateHistorySelectBar();
}
// The two endpoints of the current selection, or null. historyCommits is newest-first, so the lower
// index is the newer commit. isRange is false when the anchor and focus are the same commit.
function historyRangeEndpoints() {
  var a = historyIndexOfSha(historyAnchorSha);
  var b = historyIndexOfSha(historyActiveSha);
  if (a < 0 || b < 0) return null;
  var lo = Math.min(a, b), hi = Math.max(a, b);
  return { olderSha: historyCommits[hi].hash, newerSha: historyCommits[lo].hash, count: hi - lo + 1, isRange: hi > lo };
}
// Extend the selection from the anchor to focusSha and highlight the span. Selection only — never opens
// the diff; the reviewer opens it with Enter, double-click, or the compare bar's Open button.
function selectHistoryRange(focusSha, shouldScroll) {
  if (!focusSha) return;
  if (!historyAnchorSha) historyAnchorSha = historyActiveSha || focusSha;
  var a = historyIndexOfSha(historyAnchorSha);
  var b = historyIndexOfSha(focusSha);
  if (a < 0 || b < 0) { // anchor/focus scrolled out of the loaded page — fall back to single
    historyAnchorSha = focusSha;
    selectHistoryCommit(focusSha, shouldScroll);
    updateHistorySelectBar();
    return;
  }
  var lo = Math.min(a, b), hi = Math.max(a, b);
  historyActiveSha = focusSha;
  var inRange = {};
  for (var i = lo; i <= hi; i++) inRange[historyCommits[i].hash] = true;
  var list = document.getElementById('history-list');
  var active = null;
  if (list) list.querySelectorAll('.hrow').forEach(function (r) {
    var sha = r.dataset.sha;
    r.classList.toggle('active', sha === focusSha);
    r.classList.toggle('in-range', !!inRange[sha]);
    r.classList.toggle('range-end', sha === historyAnchorSha || sha === focusSha);
    if (sha === focusSha) active = r;
  });
  if (shouldScroll !== false && active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  updateHistorySelectBar();
}
// Open the shift-selected range in the MAIN review (git diff older..newer), where the full comment system
// applies, and close the history overlay. This is how an already-committed / merged range becomes a
// comment-able review. Falls back to the read-only in-history detail for a single commit or in serve mode.
function reviewHistoryRangeInMain() {
  var ep = historyRangeEndpoints();
  if (!ep || !ep.isRange || !window.kakapoGit || typeof window.kakapoGit.setReviewCompare !== 'function') {
    openHistoryCurrentSelection();
    return;
  }
  // Pass every commit in the selected span (oldest → newest) as the compare scope, so the main review's two
  // dropdowns can then pick any B..D within this opened A..F.
  var a = historyIndexOfSha(historyAnchorSha), b = historyIndexOfSha(historyActiveSha);
  var lo = Math.min(a, b), hi = Math.max(a, b);
  var scope = [];
  for (var i = hi; i >= lo; i--) {
    var c = historyCommits[i];
    scope.push({ sha: c.hash, shortSha: (c.hash || '').slice(0, 7), subject: c.subject, date: c.date });
  }
  if (typeof requestDiffViewOnNextCompare === 'function') requestDiffViewOnNextCompare(); // land on the diff, not a stale source pane
  Promise.resolve(window.kakapoGit.setReviewCompare(ep.olderSha, ep.newerSha, scope)).then(function (res) {
    if (res && res.ok) closeHistory();
  }).catch(function () {});
}
// Open whatever is currently selected: the range diff when a span is selected, else the single commit.
function openHistoryCurrentSelection() {
  var ep = historyRangeEndpoints();
  if (ep && ep.isRange) { openHistoryRange(ep.olderSha, ep.newerSha); return; }
  var sha = historyActiveSha;
  if (!sha) { var rows = historyVisibleRows(); sha = rows[0] && rows[0].dataset.sha; }
  if (sha) openHistoryCommit(sha);
}
// The selection/compare strip below the history bar. Shows a discoverability hint for a single commit,
// and the pending two-commit compare (with Open / Clear) once a range is selected. Hidden in line-history
// scope, where arbitrary-commit compare does not apply.
function updateHistorySelectBar() {
  var bar = document.getElementById('history-select-bar');
  if (!bar) return;
  if (!isHistoryOpen() || historyScope) { bar.classList.add('hidden'); bar.classList.remove('has-range'); bar.innerHTML = ''; return; }
  var ep = historyRangeEndpoints();
  if (ep && ep.isRange) {
    bar.classList.remove('hidden');
    bar.classList.add('has-range');
    bar.innerHTML = '<span class="hsel-info"><span class="hsel-kind">' + escapeHtml(t('history.rangeCompare')) + '</span>'
      + '<span class="hsel-sha">' + escapeHtml((ep.olderSha || '').slice(0, 7)) + '</span>'
      + '<span class="hsel-arrow" aria-hidden="true">→</span>'
      + '<span class="hsel-sha">' + escapeHtml((ep.newerSha || '').slice(0, 7)) + '</span>'
      + '<span class="hsel-count">' + escapeHtml(ep.count + ' ' + t(ep.count === 1 ? 'history.commit' : 'history.commits')) + '</span></span>'
      + '<span class="hsel-actions">'
      + '<button type="button" id="hsel-review" class="hsel-btn hsel-open" data-keyhint="⏎">' + escapeHtml(t('history.reviewCompare')) + '</button>'
      + '<button type="button" id="hsel-open" class="hsel-btn">' + escapeHtml(t('history.quickLook')) + '</button>'
      + '<button type="button" id="hsel-clear" class="hsel-btn">' + escapeHtml(t('history.clearRange')) + '</button></span>';
  } else if (historyActiveSha) {
    bar.classList.remove('hidden');
    bar.classList.remove('has-range');
    bar.innerHTML = '<span class="hsel-hint">' + escapeHtml(t('history.selectHint')) + '</span>';
  } else {
    bar.classList.add('hidden');
    bar.classList.remove('has-range');
    bar.innerHTML = '';
  }
}
// Shift+Arrow variant of moveHistoryCommit: keep the anchor, move the focus, re-diff the span.
function moveHistoryRange(delta) {
  var rows = historyVisibleRows();
  if (!rows.length) return;
  if (!historyAnchorSha) historyAnchorSha = historyActiveSha || rows[0].dataset.sha;
  var idx = rows.findIndex(function (r) { return r.dataset.sha === historyActiveSha; });
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
  historyFocus = 'commits';
  selectHistoryRange(rows[idx].dataset.sha, true);
}
// Fetch + render the combined diff for a two-commit span (older → newer).
function openHistoryRange(olderSha, newerSha) {
  if (!olderSha || !newerSha || !window.kakapoGit || typeof window.kakapoGit.rangeDiff !== 'function') return;
  var key = olderSha + '..' + newerSha;
  historyDetailSha = key;
  setHistoryDetailOpen(true);
  var detail = document.getElementById('history-detail');
  if (detail) detail.innerHTML = loadingStateHtml(t('history.loading'), 'quick-open-empty');
  Promise.resolve(window.kakapoGit.rangeDiff(olderSha, newerSha)).then(function (d) {
    if (!d || historyDetailSha !== key || !isHistoryDetailOpen()) return;
    renderHistoryRangeDetail(d);
  }, function () {});
}
function renderHistoryRangeDetail(d) {
  var detail = document.getElementById('history-detail');
  if (!detail) return;
  var countLabel = (d.count || 0) + ' ' + t(d.count === 1 ? 'history.commit' : 'history.commits');
  var head = '<div class="history-detail-head">'
    + '<div class="history-detail-copy"><div class="hd-summary"><div class="hd-subject hd-range" title="'
    + escapeHtml((d.oldShort || '') + ' → ' + (d.newShort || '')) + '">'
    + '<span class="hd-range-kind">' + escapeHtml(t('history.rangeCompare')) + '</span> '
    + '<span class="hd-hash">' + escapeHtml(d.oldShort || (d.oldHash || '').slice(0, 7)) + '</span>'
    + '<span class="hd-range-arrow" aria-hidden="true"> → </span>'
    + '<span class="hd-hash">' + escapeHtml(d.newShort || (d.newHash || '').slice(0, 7)) + '</span>'
    + '</div></div>'
    + '<div class="hd-meta"><span class="hd-range-count">' + escapeHtml(countLabel) + '</span></div></div>'
    + '<button type="button" id="history-detail-close" class="dock-btn history-detail-close" data-keyhint="Esc" aria-label="' + escapeHtml(t('history.close')) + '"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>';
  var body = (d.diffHtml && d.diffHtml.trim())
    ? '<div class="history-workspace"><aside id="history-files" class="history-files"></aside><div id="history-diff-container" class="history-diff diff2html-container" tabindex="0" aria-readonly="true">' + d.diffHtml + '</div></div>'
    : '<div class="quick-open-empty">' + escapeHtml(t('history.noDiff')) + '</div>';
  detail.innerHTML = head + body;
  setHistoryDetailOpen(true);
  setupHistoryDiffWorkspace(d.newHash || historyActiveSha, d.fileStatus);
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
  if (!sha || !window.kakapoGit) return;
  selectHistoryCommit(sha, true);
  historyDetailSha = sha;
  setHistoryDetailOpen(true);
  var detail = document.getElementById('history-detail');
  if (detail) detail.innerHTML = loadingStateHtml(t('history.loading'), 'quick-open-empty');
  Promise.resolve(window.kakapoGit.commitDiff(sha)).then(function (d) {
    if (!d || historyActiveSha !== sha || historyDetailSha !== sha || !isHistoryDetailOpen()) return;
    renderHistoryDetail(d);
  }, function () {});
}

function renderHistoryDetail(d) {
  var detail = document.getElementById('history-detail');
  if (!detail) return;
  var message = String(d.message || '');
  var messageLines = message.split(/\r?\n/);
  var subject = messageLines.shift() || '';
  var messageBody = messageLines.join('\n').trim();
  var messageToggle = messageBody
    ? '<button type="button" id="history-message-toggle" class="dock-btn history-message-toggle" data-keyhint="M" data-tooltip="' + escapeHtml(t('history.showMessage')) + '" aria-expanded="false" aria-controls="history-message-body" aria-label="' + escapeHtml(t('history.showMessage')) + '"><svg class="history-message-chevron" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.25 8 10l4-3.75"/></svg></button>'
    : '';
  var head = '<div class="history-detail-head">'
    + '<div class="history-detail-copy"><div class="hd-summary"><div class="hd-subject" title="' + escapeHtml(subject) + '">' + escapeHtml(subject) + '</div>' + messageToggle + '</div>'
    + (messageBody ? '<div id="history-message-body" class="hd-body" aria-hidden="true">' + escapeHtml(messageBody).replace(/\n/g, '<br>') + '</div>' : '')
    + '<div class="hd-meta"><span class="hd-hash">' + escapeHtml((d.hash || '').slice(0, 10)) + '</span>'
    + '<span class="hd-author">' + escapeHtml(d.author) + (d.email ? ' &lt;' + escapeHtml(d.email) + '&gt;' : '') + '</span>'
    + '<span class="hd-date">' + escapeHtml(historyShortDate(d.date)) + '</span>'
    + historyRefBadges(d.refs) + '</div></div>'
    + '<button type="button" id="history-detail-close" class="dock-btn history-detail-close" data-keyhint="Esc" aria-label="' + escapeHtml(t('history.close')) + '"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>';
  var body = (d.diffHtml && d.diffHtml.trim())
    ? '<div class="history-workspace"><aside id="history-files" class="history-files"></aside><div id="history-diff-container" class="history-diff diff2html-container" tabindex="0" aria-readonly="true">' + d.diffHtml + '</div></div>'
    : '<div class="quick-open-empty">' + escapeHtml(t(d.isMerge ? 'history.merge' : 'history.noDiff')) + '</div>';
  detail.innerHTML = head + body;
  setHistoryDetailOpen(true);
  setupHistoryDiffWorkspace(d.hash || historyActiveSha, d.fileStatus);
  var preferredPath = historyDirectPath || (historyScope && historyScope.path) || '';
  if (preferredPath && historyWrapperByPath(preferredPath)) historyShowFile(preferredPath, undefined, true);
}

function toggleHistoryCommitMessage(force) {
  var head = document.querySelector('#history-detail .history-detail-head');
  var button = document.getElementById('history-message-toggle');
  var body = document.getElementById('history-message-body');
  if (!head || !button || !body) return false;
  var expanded = typeof force === 'boolean' ? force : !head.classList.contains('message-expanded');
  var label = t(expanded ? 'history.hideMessage' : 'history.showMessage');
  head.classList.toggle('message-expanded', expanded);
  button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  button.setAttribute('aria-label', label);
  button.setAttribute('data-tooltip', label);
  body.setAttribute('aria-hidden', expanded ? 'false' : 'true');
  return true;
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
// Real per-status badge for the changed-files tree, mirroring render-tree.ts's changeStatusBadge exactly
// (the client cannot import it). Falls back to the "modified" icon for any status readCommitDiff couldn't
// resolve — e.g. a rename, whose diff2html file-name label doesn't match the fileStatus lookup key.
function historyStatusBadge(status) {
  var label = status ? status[0].toUpperCase() + status.slice(1) : 'Modified';
  var icon;
  switch (status) {
    case 'added': icon = '<path d="M8 3.5v9M3.5 8h9"/>'; break;
    case 'deleted': icon = '<path d="M3.5 8h9"/>'; break;
    case 'renamed': icon = '<path d="M3 5h8m-2.5-2.5L11 5 8.5 7.5M13 11H5m2.5-2.5L5 11l2.5 2.5"/>'; break;
    default: icon = '<path d="m3.2 11.8.6-2.7 6.6-6.6a1.2 1.2 0 0 1 1.7 0l1.4 1.4a1.2 1.2 0 0 1 0 1.7L6.9 12.2l-2.7.6zM9.5 3.4l3.1 3.1"/>';
  }
  return '<span class="status status-' + escapeHtml(status || 'modified') + '" role="img" aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icon + '</svg></span>';
}
// Groups the flat, DOM-walk-ordered `files` list (built below in setupHistoryDiffWorkspace) into a folder
// tree — the same nesting/single-child-chain shape as render-tree.ts's renderDiffTree/Changes tree, reusing
// its exact "changes-dir"/"tree-file"/"change-row" classes and the Files tree's virtualTypeIcon/
// VIRTUAL_FOLDER_ICON glyphs (04-source-tree.js) so no new CSS is needed and the History tree looks and
// collapses identically to Cmd+0's. Order is preserved (not re-sorted alphabetically like the Changes
// tree) so historyDiffState.files stays index-aligned with the rendered .history-file DOM order —
// historySetFileFocus/historyShowFile/historySetActiveHunk all index into that array by DOM position.
function buildHistoryFileTree(files) {
  var root = { name: '', path: '', children: new Map() };
  files.forEach(function (file, index) {
    var parts = String(file.path || '').split('/').filter(Boolean);
    var node = root, current = '';
    for (var i = 0; i < parts.length - 1; i++) {
      current = current ? current + '/' + parts[i] : parts[i];
      var child = node.children.get(parts[i]);
      if (!child) { child = { name: parts[i], path: current, children: new Map() }; node.children.set(parts[i], child); }
      node = child;
    }
    var leaf = parts[parts.length - 1] || file.path;
    node.children.set(leaf + '\0' + file.path, { name: leaf, path: file.path, children: new Map(), file: file, fileIndex: index });
  });
  return root;
}
function historyFileTreeChildrenHtml(node, depth) {
  return Array.from(node.children.values()).map(function (child) { return historyFileTreeNodeHtml(child, depth); }).join('');
}
function historyFileTreeNodeHtml(node, depth) {
  if (node.file) {
    var file = node.file;
    return '<button type="button" class="file-link history-file change-row tree-file" data-index="' + node.fileIndex + '" data-file="' + escapeHtml(file.path) + '" data-hunk="' + file.hunk + '" style="--depth:' + depth + '" aria-label="' + escapeHtml(file.path) + '">'
      + virtualTypeIcon(file.path)
      + historyStatusBadge(file.status)
      + '<span class="change-name"><span class="path" title="' + escapeHtml(file.path) + '">' + escapeHtml(node.name) + '</span></span></button>';
  }
  // Collapse single-child directory chains ("a/b/c") into one summary row, exactly as the Changes tree does.
  var labelNode = node;
  var names = [node.name];
  for (;;) {
    var entries = Array.from(labelNode.children.values());
    if (entries.length !== 1 || entries[0].file) break;
    names.push(entries[0].name);
    labelNode = entries[0];
  }
  return '<details class="tree-dir changes-dir" data-dir="' + escapeHtml(labelNode.path) + '" style="--depth:' + depth + '" open>'
    + '<summary>' + VIRTUAL_FOLDER_ICON + '<span class="path">' + escapeHtml(names.join('/')) + '</span></summary>'
    + historyFileTreeChildrenHtml(labelNode, depth + 1)
    + '</details>';
}
function renderHistoryFileTree(files) {
  if (!files.length) return '';
  return '<nav class="tree changes-tree">' + historyFileTreeChildrenHtml(buildHistoryFileTree(files), 0) + '</nav>';
}
function setupHistoryDiffWorkspace(sha, fileStatus) {
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
    files.push({ path: path, hunk: first, count: hunkIndex - first, status: (fileStatus && fileStatus[path]) || 'modified' });
  });
  historyDiffState = { sha: sha, container: container, filesEl: filesEl, wrappers: wrappers, files: files, hunks: hunks, currentHunk: -1, cursor: null, fileFocusIndex: 0 };
  historyFilesCollapsed = false;
  filesEl.innerHTML = renderHistoryFileTree(files);
  syncHistoryFilesVisibility();
  container.addEventListener('click', function (event) {
    var info = historyDiffRowInfoFromNode(event.target);
    if (info && info.path) {
      historyFocus = 'diff';
      historySetDiffCursor(info.path, info.side, info.rowIndex, 0, false);
    }
  });
  container.addEventListener('scroll', function () {
    var wrapper = historyActiveDiffWrapper();
    var state = wrapper && wrapper.__asymmetricDiffState;
    if (state) state.scrollDriven = true;
    scheduleHistoryDiffAlignment();
  }, { passive: true });
  container.addEventListener('wheel', function (event) {
    var wrapper = historyActiveDiffWrapper();
    var state = wrapper && wrapper.__asymmetricDiffState;
    if (!state) return;
    var side = typeof asymmetricDiffSideFromTarget === 'function' ? asymmetricDiffSideFromTarget(event.target) : '';
    if (side) state.wheelSide = side;
    state.pendingScrollBudget = (Number(state.pendingScrollBudget) || 0) + Math.abs(Number(event.deltaY) || 0);
    state.scrollDriven = true;
  }, { passive: true });
  container.addEventListener('pointermove', function (event) {
    var wrapper = historyActiveDiffWrapper();
    var state = wrapper && wrapper.__asymmetricDiffState;
    if (state && typeof asymmetricDiffSideFromTarget === 'function') state.pointerSide = asymmetricDiffSideFromTarget(event.target);
  }, { passive: true });
  container.addEventListener('pointerleave', function () {
    var wrapper = historyActiveDiffWrapper();
    var state = wrapper && wrapper.__asymmetricDiffState;
    if (state) state.pointerSide = '';
  }, { passive: true });
  if (files[0]) historyShowFile(files[0].path, files[0].hunk, false);
  focusHistoryDiff();
}
var historyDiffAlignmentRaf = 0;
function historyActiveDiffWrapper() {
  if (!historyDiffState) return null;
  return historyWrapperByPath(historyCurrentFile())
    || historyDiffState.wrappers.find(function (wrapper) { return !wrapper.classList.contains('df-inactive'); })
    || null;
}
function scheduleHistoryDiffAlignment() {
  if (historyDiffAlignmentRaf || !historyDiffState) return;
  historyDiffAlignmentRaf = requestAnimationFrame(function () {
    historyDiffAlignmentRaf = 0;
    if (!historyDiffState || typeof scrollAsymmetricDiffSurface !== 'function') return;
    scrollAsymmetricDiffSurface(historyDiffState.container, historyActiveDiffWrapper(), historyDiffState.cursor);
  });
}
function prepareHistoryReviewDiff(wrapper) {
  if (!wrapper || wrapper.__historyReviewDiffPrepared) return;
  wrapper.__historyReviewDiffPrepared = true;
  // Reuse the exact Review pipeline: semantic row classification, centre gutters, compact asymmetric
  // peers, curved hunk connectors, import/context folding, and synchronized scroll geometry.
  if (typeof annotateDiffHunkRows === 'function') annotateDiffHunkRows(wrapper);
  else if (typeof installLayeredDiffGutters === 'function') installLayeredDiffGutters(wrapper);
  if (typeof syncDiffBlameWrapper === 'function') syncDiffBlameWrapper(wrapper);
  requestAnimationFrame(function () {
    if (!wrapper.isConnected) return;
    if (typeof refreshLayeredDiffGutters === 'function') refreshLayeredDiffGutters(wrapper);
    if (typeof invalidateAsymmetricDiffGeometry === 'function') invalidateAsymmetricDiffGeometry(wrapper);
    scheduleHistoryDiffAlignment();
  });
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
function syncHistoryFilesVisibility() {
  var workspace = document.querySelector('#history-detail .history-workspace');
  var filesEl = historyDiffState ? historyDiffState.filesEl : document.getElementById('history-files');
  if (workspace) workspace.classList.toggle('history-files-collapsed', historyFilesCollapsed);
  if (filesEl) {
    if (historyFilesCollapsed) {
      filesEl.setAttribute('inert', '');
      filesEl.setAttribute('aria-hidden', 'true');
    } else {
      filesEl.removeAttribute('inert');
      filesEl.removeAttribute('aria-hidden');
    }
  }
}
function setHistoryFilesCollapsed(collapsed, options) {
  if (!historyDiffState) return false;
  historyFilesCollapsed = !!collapsed;
  syncHistoryFilesVisibility();
  if (historyFilesCollapsed) focusHistoryDiff();
  else if (!options || options.focusFiles !== false) focusHistoryFiles();
  return true;
}
// Match the main review sidebar contract: from the diff Cmd+0 moves focus into the file list; a repeated
// Cmd+0 while that list owns the logical focus collapses it. When collapsed, Cmd+0 restores and focuses it.
function activateHistoryFiles() {
  if (!historyDiffState) return false;
  if (historyFilesCollapsed) return setHistoryFilesCollapsed(false, { focusFiles: true });
  if (historyFocus === 'files') return setHistoryFilesCollapsed(true);
  focusHistoryFiles();
  return true;
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
  prepareHistoryReviewDiff(historyWrapperByPath(path));
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
  prepareHistoryReviewDiff(historyWrapperByPath(h.path));
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
  scheduleHistoryDiffAlignment();
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
function isHistoryDetailOpen() {
  var detail = document.getElementById('history-detail');
  return !!(detail && !detail.classList.contains('hidden'));
}
function setHistoryDetailOpen(open) {
  var view = document.getElementById('history-view');
  var detail = document.getElementById('history-detail');
  var backdrop = document.getElementById('history-detail-backdrop');
  if (view) view.classList.toggle('history-diff-open', !!open);
  if (detail) {
    detail.classList.toggle('hidden', !open);
    detail.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
  if (backdrop) {
    backdrop.classList.toggle('hidden', !open);
    backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
  }
}
function closeHistoryDetail(restoreFocus) {
  if (historyDirectDetail && restoreFocus !== false) {
    closeHistory();
    return;
  }
  historyDetailSha = '';
  historyDiffState = null;
  historyFocus = 'commits';
  clearHistoryRange(); // closing the diff drops any shift-select compare range
  setHistoryDetailOpen(false);
  var detail = document.getElementById('history-detail');
  if (detail) detail.innerHTML = '';
  if (restoreFocus !== false) {
    var view = document.getElementById('history-view');
    setTimeout(function () { try { if (view) view.focus(); } catch (e) {} }, 0);
  }
}
function closeHistory() {
  historyLoadSeq += 1;
  historyDirectDetail = false;
  historyDirectPath = '';
  var v = document.getElementById('history-view');
  if (v) { v.classList.add('hidden'); v.classList.remove('history-direct-diff'); }
  closeHistoryDetail(false);
  if (typeof syncRail === 'function') syncRail();
}
function updateHistoryScopeChrome() {
  var title = document.querySelector('#history-view .history-title');
  var scope = document.getElementById('history-scope');
  if (title) title.textContent = t(historyScope ? 'history.lineTitle' : 'history.title');
  if (scope) {
    scope.textContent = historyScope ? historyScope.path + ':L' + historyScope.line : '';
    scope.classList.toggle('hidden', !historyScope);
    if (historyScope) scope.setAttribute('title', historyScope.path + ':L' + historyScope.line);
    else scope.removeAttribute('title');
  }
}
function openHistory(scope) {
  var v = document.getElementById('history-view');
  if (!v) return;
  if (!window.kakapoGit) return; // browser/serve mode: no git bridge
  historyDirectDetail = false;
  historyDirectPath = '';
  v.classList.remove('history-direct-diff');
  historyScope = scope && scope.path && Number(scope.line) >= 1
    ? { path: String(scope.path), line: Math.trunc(Number(scope.line)) }
    : null;
  updateHistoryScopeChrome();
  v.classList.remove('hidden');
  if (typeof syncRail === 'function') syncRail();
  var search = document.getElementById('history-search');
  if (search) { search.value = ''; }
  applyHistoryFilter();
  historyLoading = true;
  historyCommits = [];
  historyGraph = [];
  historyMaxLane = 0;
  historyActiveSha = '';
  historyAnchorSha = '';
  historyFocus = 'commits';
  historyDiffState = null;
  closeHistoryDetail(false);
  renderHistoryList();
  var seq = ++historyLoadSeq;
  var request = historyScope && typeof window.kakapoGit.lineLog === 'function'
    ? window.kakapoGit.lineLog({ path: historyScope.path, line: historyScope.line, limit: 300 })
    : window.kakapoGit.log({ limit: 300 });
  Promise.resolve(request).then(function (commits) {
    if (seq !== historyLoadSeq || !isHistoryOpen()) return;
    historyLoading = false;
    historyCommits = Array.isArray(commits) ? commits : [];
    historyGraph = computeHistoryGraph(historyCommits);
    historyMaxLane = historyGraph.maxLane || 0;
    renderHistoryList();
    var detail = document.getElementById('history-detail');
    if (detail) detail.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('history.selectCommit')) + '</div>';
    if (historyCommits[0]) { historyAnchorSha = historyCommits[0].hash; selectHistoryCommit(historyCommits[0].hash, false); }
    updateHistorySelectBar(); // show the compare hint as soon as the list is ready
    setTimeout(function () { try { v.focus(); } catch (e) {} }, 0);
  }, function () { if (seq === historyLoadSeq) { historyLoading = false; renderHistoryList(); } });
}
function openLineHistory(path, line) {
  if (!window.kakapoGit || typeof window.kakapoGit.lineLog !== 'function') return;
  openHistory({ path: path, line: line });
}
function openHistoryCommitFromSource(sha, path) {
  if (!sha || !window.kakapoGit || typeof window.kakapoGit.commitDiff !== 'function') return;
  var v = document.getElementById('history-view');
  if (!v) return;
  historyLoadSeq += 1;
  closeHistoryDetail(false);
  historyDirectDetail = true;
  historyDirectPath = path ? String(path) : '';
  historyScope = null;
  updateHistoryScopeChrome();
  historyCommits = [];
  historyGraph = [];
  historyActiveSha = sha;
  historyFocus = 'diff';
  v.classList.add('history-direct-diff');
  v.classList.remove('hidden');
  if (typeof syncRail === 'function') syncRail();
  openHistoryCommit(sha);
}
function toggleHistory() { if (isHistoryOpen()) closeHistory(); else openHistory(); }
if (typeof window !== 'undefined') window.__kakapoHistory = { open: openHistory, openLine: openLineHistory, openCommit: openHistoryCommitFromSource, close: closeHistory, toggle: toggleHistory, isOpen: isHistoryOpen };

function handleHistoryKey(e) {
  if (!isHistoryOpen()) return false;
  var ae = document.activeElement;
  var inSearch = ae && ae.id === 'history-search';
  // This also runs from a CAPTURE listener (see wireHistory), i.e. before the focused element sees the key at
  // all. So it has to stand down for anything genuinely being typed into outside History's own chrome — above
  // all the integrated terminal, whose xterm keeps a hidden textarea focused: with History open, its Enter
  // never reached the shell. History's own search box is inside #history-view and keeps its keys.
  if (ae && !inSearch
    && ((ae.closest && ae.closest('.terminal-panel'))
      || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)
    && !(ae.closest && ae.closest('#history-view'))) return false;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.code === 'Digit9' || e.key === '9')) {
    e.preventDefault(); e.stopPropagation(); closeHistory(); return true;
  }
  // Cmd/Ctrl+1 has no History-local meaning, so honor the global "Files" shortcut: leave History and reveal
  // the source tree. Without this the fallthrough ran activateFilesView() under the still-open overlay, so
  // the switch was invisible.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.code === 'Digit1' || e.key === '1')) {
    e.preventDefault(); e.stopPropagation();
    closeHistory();
    if (typeof activateFilesView === 'function') activateFilesView();
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if (isHistoryDetailOpen()) closeHistoryDetail(true);
    else closeHistory();
    return true;
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === '0') {
    if (historyDiffState) { e.preventDefault(); e.stopPropagation(); activateHistoryFiles(); return true; }
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.code === 'KeyA' || e.key === 'a' || e.key === 'A') && historyFocus === 'diff') {
    e.preventDefault(); e.stopPropagation(); historySelectAllDiff(); return true;
  }
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    var scroller = historyFocus === 'diff' && historyDiffState ? historyDiffState.container : document.getElementById('history-list');
    if (scroller) { e.preventDefault(); e.stopPropagation(); scroller.scrollTop += (e.key === 'PageDown' ? 0.9 : -0.9) * scroller.clientHeight; return true; }
  }
  if (e.key === 'F7' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault(); e.stopPropagation(); historyNextHunk(e.shiftKey ? -1 : 1); return true;
  }
  if (!inSearch && isHistoryDetailOpen() && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    && (e.code === 'KeyM' || e.key === 'm' || e.key === 'M')) {
    e.preventDefault(); e.stopPropagation(); toggleHistoryCommitMessage(); return true;
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); e.stopPropagation();
    var delta = e.key === 'ArrowDown' ? 1 : -1;
    if (historyFocus === 'files') historySetFileFocus((historyDiffState ? historyDiffState.fileFocusIndex : 0) + delta);
    else if (historyFocus === 'diff' && historyDiffState) historyMoveDiffCursor(delta, 0);
    else if (e.shiftKey) moveHistoryRange(delta); // Shift+Arrow extends the compare range
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
      reviewHistoryRangeInMain(); // Enter: open the range in the main review (comments); single commit -> read-only
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
    if (!row) return;
    historyFocus = 'commits';
    if (e.shiftKey) { e.preventDefault(); selectHistoryRange(row.dataset.sha, false); } // extend the compare range
    else { clearHistoryRange(); historyAnchorSha = row.dataset.sha; selectHistoryCommit(row.dataset.sha, false); updateHistorySelectBar(); } // select only; open on double-click/Enter
  });
  // Double-click activates: open the compare range when the row is inside it, else that single commit.
  if (list) list.addEventListener('dblclick', function (e) {
    var row = e.target.closest && e.target.closest('.hrow[data-sha]');
    if (!row) return;
    e.preventDefault();
    historyFocus = 'commits';
    var ep = historyRangeEndpoints();
    if (ep && ep.isRange && row.classList.contains('in-range')) { openHistoryRange(ep.olderSha, ep.newerSha); return; }
    clearHistoryRange(); historyAnchorSha = row.dataset.sha; selectHistoryCommit(row.dataset.sha, false); updateHistorySelectBar();
    openHistoryCommit(row.dataset.sha);
  });
  var selBar = document.getElementById('history-select-bar');
  if (selBar) selBar.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#hsel-review')) reviewHistoryRangeInMain(); // open in main review (comments)
    else if (e.target.closest && e.target.closest('#hsel-open')) openHistoryCurrentSelection(); // read-only quick look
    else if (e.target.closest && e.target.closest('#hsel-clear')) clearHistoryRange();
  });
  var search = document.getElementById('history-search');
  if (search) search.addEventListener('input', applyHistoryFilter);
  var closeBtn = document.getElementById('history-close');
  if (closeBtn) closeBtn.addEventListener('click', closeHistory);
  var view = document.getElementById('history-view');
  if (view) view.setAttribute('tabindex', '-1');
  // The commit diff uses read-only logical carets and Chromium can leave native focus on a descendant (or
  // even the document body after a render). Capture at document scope while History is open so its local
  // shortcuts never depend on that incidental DOM focus. Handled keys stop propagation in handleHistoryKey.
  document.addEventListener('keydown', function (e) {
    if (isHistoryOpen()) handleHistoryKey(e);
  }, true);
  var detail = document.getElementById('history-detail');
  if (detail) detail.addEventListener('click', function (e) {
    var close = e.target.closest && e.target.closest('#history-detail-close');
    if (close) { e.preventDefault(); closeHistoryDetail(true); return; }
    var messageToggle = e.target.closest && e.target.closest('#history-message-toggle');
    if (messageToggle) { e.preventDefault(); toggleHistoryCommitMessage(); return; }
    var file = e.target.closest && e.target.closest('.history-file[data-file]');
    if (file && historyDiffState) {
      e.preventDefault();
      historyShowFile(file.dataset.file, Number(file.dataset.hunk), true);
      focusHistoryDiff();
    }
  });
  var backdrop = document.getElementById('history-detail-backdrop');
  if (backdrop) backdrop.addEventListener('click', function () { closeHistoryDetail(true); });
})();
