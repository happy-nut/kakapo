var semanticPeekItems = [];
var semanticPeekSymbol = '';
var semanticPeekGuess = null;
var semanticPeekActive = 0;

function semanticTestPath(path) {
  return projectIsTestPath(path);
}

function semanticDocumentPath(path) {
  return /\.(?:md|mdx|txt|rst|adoc)$/i.test(String(path || ''))
    || /(^|\/)(docs?|documentation|notes?|release-notes)(\/|$)/i.test(String(path || ''));
}

function semanticFileLabel(path, lineIndex) {
  var parts = String(path || '').replace(/\\/g, '/').split('/');
  return (parts[parts.length - 1] || path || '') + ':' + ((Number(lineIndex) || 0) + 1);
}

function semanticCommentOnlyLine(text) {
  var trimmed = String(text || '').trim();
  return /^(?:\/\/|\/\*|\*\/|\*|#|--|<!--|\"\"\"|''')/.test(trimmed);
}

var SEMANTIC_COMMENT_KINDS = { region: true };

function semanticNavigationLocations(locations, kind) {
  if (SEMANTIC_COMMENT_KINDS[kind] === true) {
    return (locations || []).filter(function (item) { return item && item.path; });
  }
  return (locations || []).map(function (item, index) {
    return { item: item, index: index, test: item && semanticTestPath(item.path) };
  }).filter(function (entry) {
    var item = entry.item;
    return item && item.path && !semanticDocumentPath(item.path) && !semanticCommentOnlyLine(item.text);
  }).sort(function (a, b) {
    return Number(a.test) - Number(b.test) || a.index - b.index;
  }).map(function (entry) { return entry.item; });
}

function analysisGenerationIsCurrent(response) {
  if (!response || !Number.isFinite(Number(response.generation))) return true;
  var status = document.getElementById('analysis-status');
  var currentGeneration = status ? Number(status.dataset.generation) : 0;
  return !currentGeneration || Number(response.generation) === currentGeneration;
}

function withoutImportUsages(name, kind, items) {
  if (kind === 'definition' || kind === 'implementation') return items;
  var kept = items.filter(function (item) {
    return classifyUsage(name, item.text, item.column, item.path) !== 'import';
  });
  return kept.length ? kept : items;
}

function openSemanticPeek(name, locations, response, kind) {
  var panel = document.getElementById('semantic-peek');
  if (!panel) { openAnalysisUsagesFallback(name, locations, kind); return; }
  semanticPeekItems = semanticNavigationLocations(locations, kind).map(function (item) {
    return { path: item.path, lineIndex: Number(item.lineIndex) || 0, column: Number(item.column) || 0, text: String(item.text || ''), isTest: semanticTestPath(item.path) };
  });
  semanticPeekItems = withoutImportUsages(name, kind, semanticPeekItems);
  if (!semanticPeekItems.length) { showSemanticNavigationFailure(kind || 'references', name); return; }
  semanticPeekActive = 0;
  var title = document.getElementById('semantic-peek-title');
  var meta = document.getElementById('semantic-peek-meta');
  var key = kind === 'definition' ? 'peek.definitions' : kind === 'implementation' ? 'peek.implementations' : 'peek.usages';
  if (title) title.textContent = t(key, { n: semanticPeekItems.length }) + ' · ' + name;
  semanticPeekSymbol = name;
  semanticPeekTrail = null;
  semanticPeekRoot = null;
  if (meta) {
    var bits = [response && response.confidence || response && response.engine || 'semantic'];
    if (response && response.server) bits.push(response.server + (response.serverSource ? ' (' + response.serverSource + ')' : ''));
    if (response && Number.isFinite(Number(response.durationMs))) bits.push(Number(response.durationMs).toFixed(1) + 'ms');
    meta.textContent = bits.join(' · ');
    meta.title = response && response.fallbackReason ? String(response.fallbackReason) : '';
  }
  semanticPeekGuess = guessedAnalysisQuestionFor(response);
  renderSemanticPeekResults();
  panel.classList.remove('hidden');
  positionSemanticPeekAtCaret();
  var results = document.getElementById('semantic-peek-results');
  if (results && typeof results.focus === 'function') results.focus({ preventScroll: true });
}

function semanticPeekIsOpen() {
  var panel = document.getElementById('semantic-peek');
  return Boolean(panel) && !panel.classList.contains('hidden');
}

function refreshGuessedSemanticPeek() {
  var question = semanticPeekGuess;
  if (!question || !semanticPeekIsOpen()) return;
  semanticPeekGuess = null;
  queryProjectAnalysis(question.kind, question.symbol, question.loc, question.extra).then(function (response) {
    if (!semanticPeekIsOpen() || !response || !response.ok) return;
    var locations = semanticNavigationLocations(response.locations || [], question.kind);
    if (!locations.length) {
      closeSemanticPeek();
      showSemanticNavigationFailure(question.kind, question.symbol, response);
      return;
    }
    openSemanticPeek(question.symbol, locations, response, question.kind);
  });
}

function openAnalysisUsagesFallback(name, locations, kind) {
  usageItems = semanticNavigationLocations(locations, kind).map(function (item) {
    return { path: item.path, lineIndex: Number(item.lineIndex) || 0, column: Number(item.column) || 0, text: String(item.text || ''), isTest: semanticTestPath(item.path) };
  });
  if (usageItems.length === 1) { openUsageItem(usageItems[0]); return; }
  if (!usageItems.length) { showSemanticNavigationFailure(kind || 'references', name); return; }
  usageActive = 0;
  showUsages(name, usageItems.length);
}

function semanticPeekAnchorRect() {
  var el = caretAnchorElement();
  return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
}

function positionSemanticPeekAtCaret() {
  positionPanelAtCaret(document.getElementById('semantic-peek'));
}

function positionPanelAtCaret(panel) {
  if (!panel || panel.classList.contains('hidden')) return;
  var rect = semanticPeekAnchorRect();
  var margin = 8, gap = 6, vw = window.innerWidth, vh = window.innerHeight;
  var width = Math.min(640, Math.max(280, vw - margin * 2));
  var left = rect ? Math.min(Math.max(margin, rect.left), vw - width - margin) : Math.max(margin, (vw - width) / 2);
  panel.style.width = width + 'px';
  panel.style.left = Math.round(left) + 'px';
  panel.style.top = panel.style.bottom = '';
  if (!rect) { panel.style.top = '64px'; panel.style.maxHeight = Math.max(160, vh - 72) + 'px'; return; }
  var below = vh - rect.bottom - gap - margin;
  var above = rect.top - gap - margin;
  if (below >= 150 || below >= above) {
    panel.style.top = Math.round(rect.bottom + gap) + 'px';
    panel.style.maxHeight = Math.max(120, Math.min(320, below)) + 'px';
  } else {
    panel.style.bottom = Math.round(vh - rect.top + gap) + 'px';
    panel.style.maxHeight = Math.max(120, Math.min(320, above)) + 'px';
  }
}

function semanticCodeHtml(path, code) {
  var file = typeof sourceByPath !== 'undefined' ? sourceByPath.get(path) : null;
  var language = (file && file.language) || '';
  if (!language || language === 'text') return escapeHtml(code);
  try { return highlightLine(code, language); } catch (e) { return escapeHtml(code); }
}

function renderSemanticPeekResults() {
  var results = document.getElementById('semantic-peek-results');
  if (!results) return;
  if (semanticPeekInGraph()) { renderSemanticPeekGraph(results); return; }
  if (!semanticPeekItems.length) { results.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('monaco.noResults')) + '</div>'; return; }
  results.innerHTML = semanticPeekItems.map(function (item, index) {
    var tags = projectRowTagsHtml(item.path, 'module');
    return '<button type="button" role="option" id="semantic-peek-item-' + index + '" aria-selected="' + (index === semanticPeekActive ? 'true' : 'false')
      + '" class="semantic-peek-item' + (item.isTest ? ' is-test' : '') + (tags ? ' has-tags' : '') + (index === semanticPeekActive ? ' active' : '') + '" data-index="' + index + '" title="' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '">'
      + '<span class="semantic-peek-item-path">' + escapeHtml(semanticFileLabel(item.path, item.lineIndex)) + '</span>'
      + '<span class="semantic-peek-item-code">' + semanticCodeHtml(item.path, item.text.trim().slice(0, 180)) + '</span>'
      + tags
      + '</button>';
  }).join('') + '<div class="semantic-peek-list-hint">' + escapeHtml(t('monaco.peekHint')) + '</div>';
  if (semanticPeekItems.length) results.setAttribute('aria-activedescendant', 'semantic-peek-item-' + semanticPeekActive);
  else results.removeAttribute('aria-activedescendant');
}

function showSemanticPeekItem(index) {
  if (!semanticPeekItems.length) return;
  semanticPeekActive = Math.max(0, Math.min(index, semanticPeekItems.length - 1));
  renderSemanticPeekResults();
  var active = document.querySelector('#semantic-peek-results .semantic-peek-item.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function closeSemanticPeek() {
  var panel = document.getElementById('semantic-peek');
  if (!panel) return;
  var hadFocus = panel.contains(document.activeElement);
  panel.classList.add('hidden');
  semanticPeekTrail = null;
  semanticPeekRoot = null;
  panel.style.left = panel.style.top = panel.style.bottom = panel.style.width = panel.style.maxHeight = '';
  if (!hadFocus) return;
  focusReadingSurface();
}

function openActiveSemanticPeekSource() {
  var item = semanticPeekItems[semanticPeekActive];
  if (!item) return;
  closeSemanticPeek();
  openSourceAt(item.path, item.lineIndex, item.column);
}

document.getElementById('semantic-peek-results')?.addEventListener('click', function (event) {
  var step = event.target && event.target.closest && event.target.closest('.semantic-peek-node.is-step');
  if (step && semanticPeekInGraph()) {
    var depth = Number(step.dataset.step) || 0;
    while (semanticPeekTrail.length > depth) semanticPeekTrail.pop();
    if (!semanticPeekTrail.length) leaveSemanticPeekGraph(); else renderSemanticPeekResults();
    return;
  }
  var node = event.target && event.target.closest && event.target.closest('.semantic-peek-node');
  if (node && semanticPeekInGraph()) {
    var level = Number(node.dataset.level);
    while (semanticPeekTrail.length > level) semanticPeekTrail.pop();
    var current = semanticPeekLevel();
    if (current) current.active = Number(node.dataset.index) || 0;
    if (!semanticPeekTrail.length) { leaveSemanticPeekGraph(); return; }
    openActiveSemanticPeekCaller();
    return;
  }
  var item = event.target && event.target.closest && event.target.closest('.semantic-peek-item');
  if (item) {
    semanticPeekActive = Number(item.dataset.index) || 0;
    openActiveSemanticPeekSource();
  }
});
document.getElementById('semantic-peek-results')?.addEventListener('mousemove', function (event) {
  var item = event.target && event.target.closest && event.target.closest('.semantic-peek-item');
  if (!item) return;
  var index = Number(item.dataset.index) || 0;
  if (index !== semanticPeekActive) showSemanticPeekItem(index);
});
function handleSemanticPeekKey(event) {
  var panel = document.getElementById('semantic-peek');
  if (!panel || panel.classList.contains('hidden')) return false;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSemanticPeek(); return true; }
  if (event.key === 'ArrowRight') {
    event.preventDefault(); event.stopPropagation();
    if (semanticPeekInGraph()) stepIntoSemanticPeekCaller(); else enterSemanticPeekGraph();
    return true;
  }
  if (event.key === 'ArrowLeft' && semanticPeekInGraph()) { event.preventDefault(); event.stopPropagation(); stepOutOfSemanticPeekCaller(); return true; }
  if (event.key === 'ArrowDown') {
    event.preventDefault(); event.stopPropagation();
    if (semanticPeekInGraph()) moveSemanticPeekGraph(1); else showSemanticPeekItem(semanticPeekActive + 1);
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault(); event.stopPropagation();
    if (semanticPeekInGraph()) moveSemanticPeekGraph(-1); else showSemanticPeekItem(semanticPeekActive - 1);
    return true;
  }
  if (event.key === 'Enter') {
    event.preventDefault(); event.stopPropagation();
    if (semanticPeekInGraph()) openActiveSemanticPeekCaller(); else openActiveSemanticPeekSource();
    return true;
  }
  return false;
}
document.addEventListener('mousedown', function (event) {
  var panel = document.getElementById('semantic-peek');
  if (panel && !panel.classList.contains('hidden') && !panel.contains(event.target)) closeSemanticPeek();
}, true);
window.addEventListener('resize', positionSemanticPeekAtCaret);
document.addEventListener('scroll', function (event) {
  var panel = document.getElementById('semantic-peek');
  if (!panel || panel.classList.contains('hidden')) return;
  var target = event.target;
  if (target && target.nodeType === 1 && panel.contains(target)) return;
  closeSemanticPeek();
}, true);

var semanticPeekTrail = null;
var semanticPeekRoot = null;

function semanticPeekInGraph() {
  return Array.isArray(semanticPeekTrail);
}

function semanticPeekLevel() {
  return semanticPeekTrail && semanticPeekTrail.length ? semanticPeekTrail[semanticPeekTrail.length - 1] : null;
}

var SEMANTIC_PEEK_GRAPH_COLUMNS = 2;

function semanticPeekSpine() {
  var trail = semanticPeekTrail || [];
  var absorbed = Math.max(0, trail.length - SEMANTIC_PEEK_GRAPH_COLUMNS);
  var rows = [{ name: semanticPeekRoot ? semanticPeekRoot.name : '', depth: 0 }];
  for (var i = 0; i < absorbed; i++) {
    var picked = trail[i].items[trail[i].active];
    rows.push({ name: picked ? picked.name : '', depth: i + 1 });
  }
  return rows;
}

function semanticPeekCycleDepth(item, depth) {
  var trail = semanticPeekTrail || [];
  for (var i = 0; i <= depth && i < trail.length; i++) {
    if (trail[i].name !== item.name) continue;
    var at = trail[i].loc && trail[i].loc.path;
    if (i === 0 || !at || at === item.path) return i;
  }
  return -1;
}

function semanticCallSiteOf(item) {
  var sites = item && item.callSites;
  if (!sites || !sites.length) return { lineIndex: item ? item.lineIndex : 0, column: item ? item.column : 0 };
  return { lineIndex: Number(sites[0].lineIndex) || 0, column: Number(sites[0].column) || 0 };
}

function semanticCallSiteLabel(item) {
  var parts = String(item && item.path || '').replace(/\\/g, '/').split('/');
  var file = parts[parts.length - 1] || '';
  var sites = (item && item.callSites) || [];
  if (!sites.length) return file + ':' + ((Number(item && item.lineIndex) || 0) + 1);
  var lines = sites.slice(0, 4).map(function (site) { return (Number(site.lineIndex) || 0) + 1; });
  return file + ':' + lines.join(', ') + (sites.length > lines.length ? '…' : '');
}

function semanticCallSiteCode(item) {
  var site = semanticCallSiteOf(item);
  var file = typeof sourceByPath !== 'undefined' ? sourceByPath.get(item.path) : null;
  var lines = file ? sourceLinesOf(file) : null;
  var text = (lines && lines[site.lineIndex]) || item.text || '';
  return String(text).trim().slice(0, 180);
}

function semanticPeekLoadCallers(name, loc) {
  var level = { name: name, loc: loc, items: [], active: 0, loading: true };
  semanticPeekTrail.push(level);
  renderSemanticPeekResults();
  var depth = semanticPeekTrail.length;
  Promise.resolve(queryProjectAnalysis('callers', name || null, loc)).then(function (response) {
    if (!semanticPeekInGraph() || semanticPeekTrail.length !== depth || semanticPeekTrail[depth - 1] !== level) return;
    level.loading = false;
    level.items = ((response && response.ok && response.locations) || []).map(function (item) {
      return {
        path: item.path,
        lineIndex: Number(item.lineIndex) || 0,
        column: Number(item.column) || 0,
        name: String(item.name || '').split(' — ')[0] || semanticFileLabel(item.path, item.lineIndex),
        text: String(item.text || ''),
        callSites: item.callSites || [],
        isTest: semanticTestPath(item.path),
      };
    });
    renderSemanticPeekResults();
    semanticPeekLoadCallerSources(level);
  });
}

function semanticPeekLoadCallerSources(level) {
  var paths = Object.create(null);
  level.items.forEach(function (item) { paths[item.path] = true; });
  Object.keys(paths).forEach(function (path) {
    Promise.resolve(loadSourceFile(path)).then(function () {
      if (semanticPeekInGraph() && semanticPeekTrail.indexOf(level) >= 0) renderSemanticPeekResults();
    });
  });
}

function enterSemanticPeekGraph() {
  if (semanticPeekInGraph()) return false;
  var anchor = semanticPeekItems[semanticPeekActive] || semanticPeekItems[0];
  if (!anchor) return false;
  semanticPeekRoot = { name: semanticPeekSymbol, loc: anchor };
  semanticPeekTrail = [];
  semanticPeekLoadCallers(semanticPeekSymbol, anchor);
  return true;
}

function leaveSemanticPeekGraph() {
  semanticPeekTrail = null;
  semanticPeekRoot = null;
  renderSemanticPeekResults();
}

function stepIntoSemanticPeekCaller() {
  var level = semanticPeekLevel();
  var item = level && level.items[level.active];
  if (!item) return;
  semanticPeekLoadCallers(item.name, { path: item.path, lineIndex: item.lineIndex, column: item.column });
}

function stepOutOfSemanticPeekCaller() {
  if (!semanticPeekInGraph()) return;
  if (semanticPeekTrail.length > 1) { semanticPeekTrail.pop(); renderSemanticPeekResults(); return; }
  leaveSemanticPeekGraph();
}

function moveSemanticPeekGraph(delta) {
  var level = semanticPeekLevel();
  if (!level || !level.items.length) return;
  level.active = Math.max(0, Math.min(level.active + delta, level.items.length - 1));
  renderSemanticPeekResults();
}

function openActiveSemanticPeekCaller() {
  var level = semanticPeekLevel();
  var item = level && level.items[level.active];
  if (!item) return;
  var site = semanticCallSiteOf(item);
  closeSemanticPeek();
  openSourceAt(item.path, site.lineIndex, site.column);
}

function semanticPeekTrailLabel() {
  var names = [semanticPeekRoot ? semanticPeekRoot.name : ''];
  (semanticPeekTrail || []).forEach(function (level, index) {
    var parent = index === 0 ? null : semanticPeekTrail[index - 1];
    if (parent) names.push(parent.items[parent.active] ? parent.items[parent.active].name : '');
  });
  return names.filter(Boolean).join(' ← ');
}

function renderSemanticPeekGraph(results) {
  var trail = semanticPeekTrail || [];
  var start = Math.max(0, trail.length - SEMANTIC_PEEK_GRAPH_COLUMNS);
  var spine = semanticPeekSpine();
  var level = semanticPeekLevel();
  var html = '<div class="semantic-peek-col semantic-peek-spine">' + spine.map(function (row, i) {
    var last = i === spine.length - 1;
    return '<button type="button" class="semantic-peek-node is-step' + (last ? ' is-picked' : '') + '"'
      + ' data-step="' + row.depth + '" title="' + escapeHtml(row.name) + '">'
      + '<span class="semantic-peek-node-name">' + escapeHtml(row.name) + '</span>'
      + '</button>';
  }).join('') + '</div>';
  html += trail.slice(start).map(function (column, offset) {
    var index = start + offset;
    var isLast = index === trail.length - 1;
    var body;
    if (column.loading) {
      body = '<div class="semantic-peek-col-note">' + escapeHtml(t('peek.loadingCallers')) + '</div>';
    } else if (!column.items.length) {
      body = '<div class="semantic-peek-col-note">' + escapeHtml(t('peek.noCallers')) + '</div>';
    } else {
      body = column.items.map(function (item, i) {
        var picked = i === column.active;
        var cycle = semanticPeekCycleDepth(item, index);
        var cycleTag = cycle < 0 ? '' : ' <span class="row-tag is-cycle">'
          + escapeHtml(t(cycle === index ? 'peek.recursive' : 'peek.cycle')) + '</span>';
        return '<button type="button" role="option" aria-selected="' + (picked && isLast ? 'true' : 'false') + '"'
          + ' class="semantic-peek-node' + (picked ? ' is-picked' : '') + (picked && isLast ? ' is-focus' : '') + (item.isTest ? ' is-test' : '') + (cycle < 0 ? '' : ' is-cycle') + '"'
          + ' data-level="' + (index + 1) + '" data-index="' + i + '"'
          + ' title="' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '">'
          + '<span class="semantic-peek-node-name">' + escapeHtml(item.name) + cycleTag + '</span>'
          + '<span class="semantic-peek-node-where">' + escapeHtml(semanticCallSiteLabel(item)) + '</span>'
          + '<span class="semantic-peek-node-code">' + semanticCodeHtml(item.path, semanticCallSiteCode(item)) + '</span>'
          + '</button>';
      }).join('');
    }
    return '<div class="semantic-peek-col' + (isLast ? ' is-current' : '') + '">' + body + '</div>';
  }).join('');
  results.innerHTML = '<div class="semantic-peek-graph">' + html
    + '<svg class="semantic-peek-wires" aria-hidden="true"></svg></div>'
    + '<div class="semantic-peek-list-hint">' + escapeHtml(t('peek.graphHint')) + '</div>';
  drawSemanticPeekWires(results);
  var meta = document.getElementById('semantic-peek-meta');
  if (meta) {
    var count = level && !level.loading ? level.items.length : null;
    meta.textContent = semanticPeekTrailLabel() + (count === null ? '' : '   ·   ' + t('peek.callers', { n: count }));
  }
}

function drawSemanticPeekWires(results) {
  var graph = results.querySelector('.semantic-peek-graph');
  var wires = graph && graph.querySelector('.semantic-peek-wires');
  if (!graph || !wires || !graph.getBoundingClientRect) return;
  var frame = graph.getBoundingClientRect();
  if (!frame.width || !frame.height) return;
  wires.setAttribute('viewBox', '0 0 ' + frame.width + ' ' + frame.height);
  var columns = Array.from(graph.querySelectorAll('.semantic-peek-col'));
  var paths = '';
  columns.forEach(function (column, index) {
    var next = columns[index + 1];
    var from = column.querySelector('.semantic-peek-node.is-picked');
    if (!next || !from) return;
    var a = from.getBoundingClientRect();
    var x1 = a.right - frame.left, y1 = a.top - frame.top + a.height / 2;
    Array.from(next.querySelectorAll('.semantic-peek-node')).forEach(function (target) {
      var b = target.getBoundingClientRect();
      var x2 = b.left - frame.left, y2 = b.top - frame.top + b.height / 2;
      paths += '<path d="M' + x1 + ',' + y1 + ' C' + (x1 + 14) + ',' + y1 + ' ' + (x2 - 14) + ',' + y2 + ' ' + x2 + ',' + y2 + '"/>';
    });
  });
  wires.innerHTML = paths;
}
