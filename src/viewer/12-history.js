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
var EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's empty tree — the base for a root commit
var historyDetailSha = '';
var historyFilesCollapsed = false;
var historyScope = null; // null | { path, line } — right-clicked source line history
var historyLoadSeq = 0;
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
// Open whatever is selected in the MAIN review — where the comment system, F7 and the file tree already are
// — and close the overlay. This is the only way anything opens from here now. It used to be the RANGE path
// only, with a single commit falling back to a read-only pane inside the overlay: half the width, no
// comments, and a second diff implementation that had to be kept in step with the real one. There is nothing
// about one commit that needs its own viewer, and "the commits I already made" is what a review is for.
// Serve mode (no window.kakapoGit) has no way to repoint the review, so it does nothing rather than
// pretending — the commit list itself still reads.
// What a commit is compared AGAINST: its first parent. The first commit in a repository has no parent, so it
// is the one commit with nothing to diff against — git's empty-tree hash is how you say "before anything
// existed", and it opens as what it actually is, every file added.
function historyCompareBase(commit) {
  return (commit && Array.isArray(commit.parents) && commit.parents[0]) || EMPTY_TREE_SHA;
}
function reviewHistoryInMain() {
  var ep = historyRangeEndpoints();
  if (!ep || !window.kakapoGit || typeof window.kakapoGit.setReviewCompare !== 'function') return;
  var a = historyIndexOfSha(historyAnchorSha), b = historyIndexOfSha(historyActiveSha);
  var lo = Math.min(a, b), hi = Math.max(a, b);
  if (!ep.isRange) {
    var only = historyCommits[lo];
    if (!only) return;
    requestDiffViewOnNextCompare();
    Promise.resolve(window.kakapoGit.setReviewCompare(historyCompareBase(only), only.hash, [
      { sha: only.hash, shortSha: (only.hash || '').slice(0, 7), subject: only.subject, date: only.date },
    ])).then(function (res) { if (res && res.ok) closeHistory(); }).catch(function () {});
    return;
  }
  var scope = [];
  for (var i = hi; i >= lo; i--) {
    var c = historyCommits[i];
    scope.push({ sha: c.hash, shortSha: (c.hash || '').slice(0, 7), subject: c.subject, date: c.date });
  }
  requestDiffViewOnNextCompare(); // land on the diff, not a stale source pane
  // The base is what came BEFORE the oldest selected commit, exactly as it is for a single one. Comparing
  // from the oldest commit itself left that commit's own changes out of its own compare, so two selected
  // commits opened showing only the newer one — and the bar still said "2 commits".
  Promise.resolve(window.kakapoGit.setReviewCompare(historyCompareBase(historyCommits[hi]), ep.newerSha, scope)).then(function (res) {
    if (res && res.ok) closeHistory();
  }).catch(function () {});
}
// Nothing opens here any more — every selection goes to the main review (reviewHistoryInMain). Kept as the
// name the Open button and Enter both call, so there is one door rather than three.
function openHistoryCurrentSelection() { reviewHistoryInMain(); }
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
  selectHistoryRange(rows[idx].dataset.sha, true);
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




var historyDiffAlignmentRaf = 0;

function isHistoryOpen() {
  var v = document.getElementById('history-view');
  return !!(v && !v.classList.contains('hidden'));
}
function closeHistory() {
  historyLoadSeq += 1;
  var v = document.getElementById('history-view');
  if (v) { v.classList.add('hidden'); v.classList.remove('history-direct-diff'); }
  syncRail();
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
  v.classList.remove('history-direct-diff');
  historyScope = scope && scope.path && Number(scope.line) >= 1
    ? { path: String(scope.path), line: Math.trunc(Number(scope.line)) }
    : null;
  updateHistoryScopeChrome();
  v.classList.remove('hidden');
  syncRail();
  var search = document.getElementById('history-search');
  if (search) { search.value = ''; }
  applyHistoryFilter();
  historyLoading = true;
  historyCommits = [];
  historyGraph = [];
  historyMaxLane = 0;
  historyActiveSha = '';
  historyAnchorSha = '';
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
    if (historyCommits[0]) { historyAnchorSha = historyCommits[0].hash; selectHistoryCommit(historyCommits[0].hash, false); }
    updateHistorySelectBar(); // show the compare hint as soon as the list is ready
    setTimeout(function () { try { v.focus(); } catch (e) {} }, 0);
  }, function () { if (seq === historyLoadSeq) { historyLoading = false; renderHistoryList(); } });
}
function openLineHistory(path, line) {
  if (!window.kakapoGit || typeof window.kakapoGit.lineLog !== 'function') return;
  openHistory({ path: path, line: line });
}
// A blame attribution in the source gutter: "show me the commit that wrote this line". It used to open the
// overlay in a diff-only mode of its own; it is the same act as picking that commit from the list, so it
// takes the same door and never opens the overlay at all.
// `sha^` rather than a looked-up parent — this path has no commit list to look one up in, and git resolves
// it. A root commit has no `^`, so that attempt fails and the empty tree is what "before this" means there.
function openHistoryCommitFromSource(sha, path) {
  if (!sha || !window.kakapoGit || typeof window.kakapoGit.setReviewCompare !== 'function') return;
  var scope = [{ sha: sha, shortSha: String(sha).slice(0, 7), subject: '', date: '' }];
  requestDiffViewOnNextCompare();
  Promise.resolve(window.kakapoGit.setReviewCompare(sha + '^', sha, scope)).then(function (res) {
    if (res && res.ok) { closeHistory(); return null; }
    return window.kakapoGit.setReviewCompare(EMPTY_TREE_SHA, sha, scope).then(function (r2) {
      if (r2 && r2.ok) closeHistory();
    });
  }).catch(function () {});
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
    activateFilesView();
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    closeHistory();
    return true;
  }
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    var scroller = document.getElementById('history-list');
    if (scroller) { e.preventDefault(); e.stopPropagation(); scroller.scrollTop += (e.key === 'PageDown' ? 0.9 : -0.9) * scroller.clientHeight; return true; }
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); e.stopPropagation();
    var delta = e.key === 'ArrowDown' ? 1 : -1;
    if (e.shiftKey) moveHistoryRange(delta); // Shift+Arrow extends the compare range
    else moveHistoryCommit(delta);
    return true;
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    reviewHistoryInMain();
    return true;
  }
  // Everything below this is the review's own, and the review is what Enter just went to. History owns the
  // commit list and nothing else: a key it has no use for belongs to whatever is underneath.
  return false;
}

(function wireHistory() {
  var list = document.getElementById('history-list');
  if (list) list.addEventListener('click', function (e) {
    var row = e.target.closest && e.target.closest('.hrow[data-sha]');
    if (!row) return;
    if (e.shiftKey) { e.preventDefault(); selectHistoryRange(row.dataset.sha, false); } // extend the compare range
    else { clearHistoryRange(); historyAnchorSha = row.dataset.sha; selectHistoryCommit(row.dataset.sha, false); updateHistorySelectBar(); } // select only; open on double-click/Enter
  });
  // Double-click activates: the compare range when the row is inside it, else that single commit. Both go
  // through the same door Enter and the Open button use — the two names this used to call (openHistoryRange,
  // openHistoryCommit) went away with the overlay's own diff pane, so every double-click threw instead.
  if (list) list.addEventListener('dblclick', function (e) {
    var row = e.target.closest && e.target.closest('.hrow[data-sha]');
    if (!row) return;
    e.preventDefault();
    var ep = historyRangeEndpoints();
    if (!(ep && ep.isRange && row.classList.contains('in-range'))) {
      clearHistoryRange(); historyAnchorSha = row.dataset.sha; selectHistoryCommit(row.dataset.sha, false); updateHistorySelectBar();
    }
    openHistoryCurrentSelection();
  });
  var selBar = document.getElementById('history-select-bar');
  if (selBar) selBar.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#hsel-review')) reviewHistoryInMain(); // open in main review (comments)
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
})();
