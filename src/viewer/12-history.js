
var HISTORY_LANE_W = 16, HISTORY_DOT_R = 3.8, HISTORY_ROW_H = 26;
var HISTORY_LANE_CAP = 20;
var HISTORY_COLORS = ['#43a5ff', '#ef4fb3', '#55d66b', '#f2a93b', '#a875ff', '#24c7bd', '#f06f62', '#91a4ff'];
var historyCommits = [];
var historyGraph = [];
var historyMaxLane = 0;
var historyActiveSha = '';
var historyLoading = false;
var EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
var historyDetailSha = '';
var historyFilesCollapsed = false;
var historyScope = null;
var historyKind = 'commits';
var historyFilters = { text: '', author: '', path: '', branch: '', content: '', since: '', until: '', currentBranchOnly: false };
var historyFilterTimer = 0;
var historyGotoRevision = null;
var historyLoadSeq = 0;
var historyAnchorSha = '';

function computeHistoryGraph(commits) {
  var lanes = [];
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
    var seen = {};
    lanes = working.filter(function (lane) {
      if (!lane || seen[lane.hash]) return false;
      seen[lane.hash] = true;
      return true;
    });
    var topEdges = [];
    for (var a = 0; a < incoming.length; a++) {
      if (introduced && a === myLane) continue;
      topEdges.push({ from: a, to: incoming[a].hash === c.hash ? myLane : a, color: incoming[a].color });
    }
    var bottomEdges = [];
    for (var b = 0; b < incoming.length; b++) {
      var through = incoming[b];
      if (through.hash === c.hash) continue;
      var throughTo = lanes.indexOf(through);
      if (throughTo >= 0) bottomEdges.push({ from: b, to: throughTo, color: through.color });
    }
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
if (typeof window !== 'undefined') window.computeHistoryGraph = computeHistoryGraph;

function historyLaneX(l) { return 10 + Math.min(l, HISTORY_LANE_CAP) * HISTORY_LANE_W; }
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
  var m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? m[1] + ' ' + m[2] : String(iso).slice(0, 16);
}

function renderHistoryList() {
  var list = document.getElementById('history-list');
  if (!list) return;
  if (!historyCommits.length) {
    list.innerHTML = historyLoading
      ? loadingStateHtml(t('history.loading'), 'quick-open-empty')
      : '<div class="quick-open-empty">' + escapeHtml(t(historyEmptyKey())) + '</div>';
    updateHistoryEmptyChrome();
    return;
  }
  updateHistoryEmptyChrome();
  list.style.setProperty('--hgraph-w', historyUsesLanes() ? (historyLaneX(historyMaxLane) + 10) + 'px' : '28px');
  list.innerHTML = historyCommits.map(function (c, i) {
    var refs = historyRefBadges(c.refs);
    var mergeClass = c.parents && c.parents.length > 1 ? ' merge-commit' : '';
    return '<button type="button" class="hrow' + mergeClass + (c.hash === historyActiveSha ? ' active' : '') + '" tabindex="-1" data-sha="' + escapeHtml(c.hash) + '" title="' + escapeHtml(c.hash.slice(0, 12) + '  ' + c.subject) + '">'
      + '<span class="hgraph-cell">' + (historyUsesLanes() ? historyRowSvg(historyGraph[i]) : historyLineRowSvg()) + '</span>'
      + '<span class="hmsg">' + (refs ? '<span class="hrefs">' + refs + '</span>' : '')
      + (c.selector ? '<span class="hselector">' + escapeHtml(c.selector) + '</span>' : '')
      + '<span class="hsubject">' + escapeHtml(c.action || c.subject) + '</span></span>'
      + '<span class="hauthor">' + escapeHtml(c.author) + '</span>'
      + '<span class="hdate">' + escapeHtml(historyShortDate(c.date)) + '</span>'
      + '</button>';
  }).join('');
}

function historyEmptyKey() {
  if (historyScope) return historyScope.line > 0 ? 'history.emptyLine' : 'history.emptyFile';
  if (historyKind === 'reflog') return 'history.emptyReflog';
  if (historyKind === 'stashes') return 'history.emptyStashes';
  return historyFiltered() ? 'history.noMatch' : 'history.empty';
}

function updateHistoryEmptyChrome() {
  var empty = document.getElementById('history-empty');
  if (empty) empty.classList.add('hidden');
  var selectBar = document.querySelector('#history-view .history-select-bar');
  if (selectBar && !historyCommits.length) selectBar.classList.add('hidden');
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
    r.tabIndex = on ? 0 : -1;
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
  clearHistoryRange();
  historyAnchorSha = rows[idx].dataset.sha;
  selectHistoryCommit(rows[idx].dataset.sha, true);
}

function historyIndexOfSha(sha) {
  for (var i = 0; i < historyCommits.length; i++) if (historyCommits[i].hash === sha) return i;
  return -1;
}
function clearHistoryRange() {
  historyAnchorSha = '';
  var list = document.getElementById('history-list');
  if (list) list.querySelectorAll('.hrow.in-range').forEach(function (r) { r.classList.remove('in-range', 'range-end'); });
  updateHistorySelectBar();
}
function historyRangeEndpoints() {
  var a = historyIndexOfSha(historyAnchorSha);
  var b = historyIndexOfSha(historyActiveSha);
  if (a < 0 || b < 0) return null;
  var lo = Math.min(a, b), hi = Math.max(a, b);
  return {
    olderSha: historyCommits[hi].hash,
    newerSha: historyCommits[lo].hash,
    baseSha: historyCompareBase(historyCommits[hi]),
    count: hi - lo + 1,
    isRange: hi > lo,
  };
}
function selectHistoryRange(focusSha, shouldScroll) {
  if (!focusSha) return;
  if (!historyAnchorSha) historyAnchorSha = historyActiveSha || focusSha;
  var a = historyIndexOfSha(historyAnchorSha);
  var b = historyIndexOfSha(focusSha);
  if (a < 0 || b < 0) {
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
function historyCompareBase(commit) {
  return (commit && Array.isArray(commit.parents) && commit.parents[0]) || EMPTY_TREE_SHA;
}
function historyBaseLabel(sha) {
  return sha === EMPTY_TREE_SHA ? t('history.emptyTree') : String(sha || '').slice(0, 7);
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
  requestDiffViewOnNextCompare();
  Promise.resolve(window.kakapoGit.setReviewCompare(ep.baseSha, ep.newerSha, scope)).then(function (res) {
    if (res && res.ok) closeHistory();
  }).catch(function () {});
}
function openHistoryCurrentSelection() { reviewHistoryInMain(); }
function updateHistorySelectBar() {
  var bar = document.getElementById('history-select-bar');
  if (!bar) return;
  if (!isHistoryOpen() || historyScope) { bar.classList.add('hidden'); bar.classList.remove('has-range'); bar.innerHTML = ''; return; }
  var ep = historyRangeEndpoints();
  if (ep && ep.isRange) {
    bar.classList.remove('hidden');
    bar.classList.add('has-range');
    bar.innerHTML = '<span class="hsel-info"><span class="hsel-kind">' + escapeHtml(t('history.rangeCompare')) + '</span>'
      + '<span class="hsel-sha">' + escapeHtml(historyBaseLabel(ep.baseSha)) + '</span>'
      + '<span class="hsel-arrow" aria-hidden="true">→</span>'
      + '<span class="hsel-sha">' + escapeHtml((ep.newerSha || '').slice(0, 7)) + '</span>'
      + '<span class="hsel-count">' + escapeHtml(ep.count + ' ' + t(ep.count === 1 ? 'history.commit' : 'history.commits')) + '</span></span>'
      + '<span class="hsel-actions">'
      + '<button type="button" id="hsel-review" class="hsel-btn hsel-open" data-keyhint-id="historyNavigate:1">' + escapeHtml(t('history.reviewCompare')) + '</button>'
      + '<button type="button" id="hsel-clear" class="hsel-btn">' + escapeHtml(t('history.clearRange')) + '</button></span>';
  } else if (historyGotoRevision) {
    bar.classList.remove('hidden');
    bar.classList.remove('has-range');
    bar.innerHTML = '<span class="hsel-info"><span class="hsel-kind">' + escapeHtml(t('history.goto')) + '</span>'
      + '<span class="hsel-sha">' + escapeHtml(historyGotoRevision.short) + '</span>'
      + '<span class="hsel-count">' + escapeHtml(historyGotoRevision.subject) + '</span></span>'
      + '<span class="hsel-actions"><button type="button" id="hsel-goto" class="hsel-btn hsel-open">'
      + escapeHtml(t('history.gotoOpen')) + '</button></span>';
  } else if (historyActiveSha) {
    bar.classList.remove('hidden');
    bar.classList.remove('has-range');
    bar.innerHTML = '<span class="hsel-hint">' + escapeHtml(t('history.selectHint')) + '</span>';
  } else {
    bar.classList.add('hidden');
    bar.classList.remove('has-range');
    bar.innerHTML = '';
  }
  try { applyKeyHints(bar); } catch (e) {}
}
function moveHistoryRange(delta) {
  var rows = historyVisibleRows();
  if (!rows.length) return;
  if (!historyAnchorSha) historyAnchorSha = historyActiveSha || rows[0].dataset.sha;
  var idx = rows.findIndex(function (r) { return r.dataset.sha === historyActiveSha; });
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
  selectHistoryRange(rows[idx].dataset.sha, true);
}

function applyHistoryFilter() {
  var value = function (id) { var el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  var checked = function (id) { var el = document.getElementById(id); return Boolean(el && el.checked); };
  historyFilters = {
    text: value('history-search'),
    author: value('history-filter-author'),
    path: value('history-filter-path'),
    branch: value('history-filter-branch'),
    content: value('history-filter-content'),
    since: value('history-filter-since'),
    until: value('history-filter-until'),
    currentBranchOnly: checked('history-filter-current'),
  };
  if (historyFilterTimer) clearTimeout(historyFilterTimer);
  historyFilterTimer = setTimeout(function () {
    historyFilterTimer = 0;
    if (!isHistoryOpen()) return;
    loadHistoryPage();
    resolveHistoryGoto();
  }, 220);
}

function historyFiltered() {
  return Boolean(historyFilters.text || historyFilters.author || historyFilters.path
    || historyFilters.branch || historyFilters.content || historyFilters.since || historyFilters.until
    || historyFilters.currentBranchOnly);
}

var historyDiffAlignmentRaf = 0;

function isHistoryOpen() {
  var v = document.getElementById('history-view');
  return !!(v && !v.classList.contains('hidden'));
}
function closeHistory() {
  historyLoadSeq += 1;
  var v = document.getElementById('history-view');
  if (!v) return;
  var wasOpen = !v.classList.contains('hidden');
  v.classList.add('hidden');
  v.classList.remove('history-direct-diff');
  restoreOverlayFocus(v, wasOpen);
}
function historyScopeLabel() {
  if (!historyScope) return '';
  return historyScope.line > 0 ? historyScope.path + ':L' + historyScope.line : historyScope.path;
}
function updateHistoryScopeChrome() {
  var title = document.querySelector('#history-view .history-title');
  var scope = document.getElementById('history-scope');
  if (title) {
    title.textContent = t(historyScope
      ? (historyScope.line > 0 ? 'history.lineTitle' : 'history.fileTitle')
      : 'history.title');
  }
  if (scope) {
    var label = historyScopeLabel();
    scope.textContent = label;
    scope.classList.toggle('hidden', !label);
    if (label) scope.setAttribute('title', label);
    else scope.removeAttribute('title');
  }
  var kinds = document.querySelector('#history-view .history-kinds');
  if (kinds) kinds.classList.toggle('hidden', Boolean(historyScope));
  var toggle = document.getElementById('history-filter-toggle');
  if (toggle) toggle.classList.toggle('hidden', Boolean(historyScope));
}
function openHistory(scope) {
  var v = document.getElementById('history-view');
  if (!v) return;
  if (!window.kakapoGit) return;
  leaveFullScreenPanels();
  rememberOverlayFocus(v);
  v.classList.remove('history-direct-diff');
  historyScope = scope && scope.path
    ? { path: String(scope.path), line: Number(scope.line) >= 1 ? Math.trunc(Number(scope.line)) : 0 }
    : null;
  updateHistoryScopeChrome();
  v.classList.remove('hidden');
  clearHistoryFilterInputs();
  loadHistoryPage();
  setTimeout(function () { try { v.focus(); } catch (e) {} }, 0);
}

function historyPageRequest() {
  var bridge = window.kakapoGit;
  if (historyScope && historyScope.line > 0 && typeof bridge.lineLog === 'function') {
    return bridge.lineLog({ path: historyScope.path, line: historyScope.line, limit: 300 });
  }
  if (historyScope) return bridge.log({ limit: 300, path: historyScope.path, follow: true });
  if (historyKind === 'reflog' && typeof bridge.reflog === 'function') return bridge.reflog({ limit: 300 });
  if (historyKind === 'stashes' && typeof bridge.stashes === 'function') return bridge.stashes();
  return bridge.log({
    limit: 300,
    text: historyFilters.text,
    author: historyFilters.author,
    path: historyFilters.path,
    branch: historyFilters.branch,
    content: historyFilters.content,
    since: historyFilters.since,
    until: historyFilters.until,
    currentBranchOnly: historyFilters.currentBranchOnly,
  });
}

function normalizeHistoryRow(row) {
  return {
    hash: String((row && row.hash) || ''),
    parents: row && Array.isArray(row.parents) ? row.parents : [],
    author: String((row && row.author) || ''),
    email: String((row && row.email) || ''),
    date: String((row && row.date) || ''),
    refs: String((row && row.refs) || ''),
    subject: String((row && row.subject) || ''),
    selector: String((row && row.selector) || ''),
    action: String((row && row.action) || ''),
  };
}

function historyUsesLanes() {
  return !historyScope && historyKind === 'commits';
}

function loadHistoryPage() {
  var v = document.getElementById('history-view');
  if (!v || !window.kakapoGit) return;
  historyLoading = true;
  historyCommits = [];
  historyGraph = [];
  historyMaxLane = 0;
  historyActiveSha = '';
  historyAnchorSha = '';
  renderHistoryList();
  var seq = ++historyLoadSeq;
  Promise.resolve(historyPageRequest()).then(function (rows) {
    if (seq !== historyLoadSeq || !isHistoryOpen()) return;
    historyLoading = false;
    historyCommits = (Array.isArray(rows) ? rows : []).map(normalizeHistoryRow).filter(function (row) { return row.hash; });
    historyGraph = computeHistoryGraph(historyCommits);
    historyMaxLane = historyGraph.maxLane || 0;
    renderHistoryList();
    if (historyCommits[0]) { historyAnchorSha = historyCommits[0].hash; selectHistoryCommit(historyCommits[0].hash, false); }
    updateHistorySelectBar();
  }, function () { if (seq === historyLoadSeq) { historyLoading = false; renderHistoryList(); } });
}

function setHistoryKind(kind) {
  if (historyKind === kind) return;
  historyKind = kind;
  document.querySelectorAll('#history-view .history-kind').forEach(function (button) {
    var active = button.dataset.historyKind === kind;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  var filters = document.getElementById('history-filters');
  if (filters && kind !== 'commits') setHistoryFiltersOpen(false);
  var toggle = document.getElementById('history-filter-toggle');
  if (toggle) toggle.classList.toggle('hidden', kind !== 'commits');
  var search = document.getElementById('history-search');
  if (search) search.classList.toggle('hidden', kind !== 'commits');
  loadHistoryPage();
}

function setHistoryFiltersOpen(open) {
  var filters = document.getElementById('history-filters');
  var toggle = document.getElementById('history-filter-toggle');
  if (filters) filters.classList.toggle('hidden', !open);
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function clearHistoryFilterInputs() {
  ['history-search', 'history-filter-author', 'history-filter-path', 'history-filter-branch',
    'history-filter-content', 'history-filter-since', 'history-filter-until'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
  var current = document.getElementById('history-filter-current');
  if (current) current.checked = false;
  historyFilters = { text: '', author: '', path: '', branch: '', content: '', since: '', until: '', currentBranchOnly: false };
  historyGotoRevision = null;
}

function resolveHistoryGoto() {
  var query = historyFilters.text;
  historyGotoRevision = null;
  if (!query || !window.kakapoGit || typeof window.kakapoGit.resolveRevision !== 'function') {
    updateHistorySelectBar();
    return;
  }
  var seq = historyLoadSeq;
  Promise.resolve(window.kakapoGit.resolveRevision(query)).then(function (revision) {
    if (seq !== historyLoadSeq || !isHistoryOpen()) return;
    historyGotoRevision = revision && revision.hash ? revision : null;
    if (historyGotoRevision && historyIndexOfSha(historyGotoRevision.hash) >= 0) {
      selectHistoryCommit(historyGotoRevision.hash, true);
      historyGotoRevision = null;
    }
    updateHistorySelectBar();
  }, function () {});
}
function openLineHistory(path, line) {
  if (!window.kakapoGit || typeof window.kakapoGit.lineLog !== 'function') return;
  openHistory({ path: path, line: line });
}
function openFileHistory(path) {
  if (!path || !window.kakapoGit) return false;
  openHistory({ path: path, line: 0 });
  return true;
}
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
if (typeof window !== 'undefined') window.__kakapoHistory = { open: openHistory, openLine: openLineHistory, openFile: openFileHistory, openCommit: openHistoryCommitFromSource, close: closeHistory, toggle: toggleHistory, isOpen: isHistoryOpen };

function handleHistoryKey(e) {
  if (!isHistoryOpen()) return false;
  var ae = document.activeElement;
  var inSearch = ae && ae.id === 'history-search';
  if (ae && !inSearch
    && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)
    && !(ae.closest && ae.closest('#history-view'))) return false;
  if (isShortcut(e, 'openHistory')) {
    e.preventDefault(); e.stopPropagation(); closeHistory(); return true;
  }
  if (isShortcut(e, 'filesChangesTab')) {
    var toChanges = shortcutMatchIndex === 1;
    e.preventDefault(); e.stopPropagation();
    closeHistory();
    if (toChanges) activateChangesView(false);
    else activateFilesView();
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
    if (e.shiftKey) moveHistoryRange(delta);
    else moveHistoryCommit(delta);
    return true;
  }
  if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    reviewHistoryInMain();
    return true;
  }
  if (isShortcut(e, 'copyRevision')) {
    if (!historyActiveSha || inSearch) return false;
    e.preventDefault(); e.stopPropagation();
    if (copyTextToClipboard(historyActiveSha)) showToast(t('history.copiedRevision').replace('{sha}', historyActiveSha.slice(0, 12)));
    return true;
  }
  return false;
}

(function wireHistory() {
  var list = document.getElementById('history-list');
  if (list) list.addEventListener('click', function (e) {
    var row = e.target.closest && e.target.closest('.hrow[data-sha]');
    if (!row) return;
    if (e.shiftKey) { e.preventDefault(); selectHistoryRange(row.dataset.sha, false); }
    else { clearHistoryRange(); historyAnchorSha = row.dataset.sha; selectHistoryCommit(row.dataset.sha, false); updateHistorySelectBar(); }
  });
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
    if (e.target.closest && e.target.closest('#hsel-review')) reviewHistoryInMain();
    else if (e.target.closest && e.target.closest('#hsel-clear')) clearHistoryRange();
    else if (e.target.closest && e.target.closest('#hsel-goto') && historyGotoRevision) {
      openHistoryCommitFromSource(historyGotoRevision.hash, '');
    }
  });
  var search = document.getElementById('history-search');
  if (search) search.addEventListener('input', applyHistoryFilter);
  var filters = document.getElementById('history-filters');
  if (filters) {
    filters.addEventListener('input', applyHistoryFilter);
    filters.addEventListener('change', applyHistoryFilter);
    filters.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#history-filter-clear')) {
        clearHistoryFilterInputs();
        loadHistoryPage();
      }
    });
  }
  var filterToggle = document.getElementById('history-filter-toggle');
  if (filterToggle) filterToggle.addEventListener('click', function () {
    setHistoryFiltersOpen(document.getElementById('history-filters')?.classList.contains('hidden'));
  });
  var kinds = document.querySelector('#history-view .history-kinds');
  if (kinds) kinds.addEventListener('click', function (e) {
    var button = e.target.closest && e.target.closest('.history-kind');
    if (button && button.dataset.historyKind) setHistoryKind(button.dataset.historyKind);
  });
  var closeBtn = document.getElementById('history-close');
  if (closeBtn) closeBtn.addEventListener('click', closeHistory);
  var view = document.getElementById('history-view');
  if (view) view.setAttribute('tabindex', '-1');
  document.addEventListener('keydown', function (e) {
    if (isHistoryOpen()) handleHistoryKey(e);
  }, true);
})();
