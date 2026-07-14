var impactRequestSeq = 0;
var impactLocations = [];

function isImpactOpen() {
  var panel = document.getElementById('impact-panel');
  return Boolean(panel && !panel.classList.contains('hidden'));
}

function currentImpactTarget() {
  var loc = caretSourceLoc();
  if (loc) {
    var sourceSymbol = isSourceViewerVisible() ? wordAtCursor() : null;
    return { loc: loc, symbol: sourceSymbol ? sourceSymbol.name : wordAtDiffCaret() };
  }
  var viewer = document.getElementById('source-viewer');
  var openPath = viewer && viewer.dataset.openPath;
  if (openPath) return { loc: { path: openPath, lineIndex: 0, column: 0 }, symbol: null };
  var wrapper = typeof diffActiveWrapper === 'function' ? diffActiveWrapper() : null;
  var pathEl = wrapper && wrapper.querySelector('.d2h-file-name');
  var path = pathEl && String(pathEl.textContent || '').trim();
  var row = wrapper && wrapper.querySelector('.d2h-code-side-linenumber[data-line-number], [data-line-number]');
  var line = row ? Number(row.getAttribute('data-line-number')) : 1;
  return path ? { loc: { path: path, lineIndex: Math.max(0, (line || 1) - 1), column: 0 }, symbol: null } : null;
}

async function openImpact() {
  var panel = document.getElementById('impact-panel');
  var body = document.getElementById('impact-body');
  if (!panel || !body) return;
  panel.classList.remove('hidden');
  syncRail();
  var target = currentImpactTarget();
  if (!target || !target.loc.path) {
    body.innerHTML = '<div class="impact-empty">' + escapeHtml(t('impact.empty')) + '</div>';
    return;
  }
  var seq = ++impactRequestSeq;
  body.innerHTML = '<div class="impact-empty impact-loading"><span class="boot-spinner"></span>' + escapeHtml(t('impact.loading')) + '</div>';
  var response = await queryProjectAnalysis('impact', target.symbol, target.loc);
  if (seq !== impactRequestSeq || !isImpactOpen()) return;
  if (!response || !response.ok || !response.impact) {
    body.innerHTML = '<div class="impact-empty">' + escapeHtml(response && response.error || t('impact.noResults')) + '</div>';
    return;
  }
  renderImpact(response);
}

function renderImpact(response) {
  var body = document.getElementById('impact-body');
  var engine = document.getElementById('impact-engine');
  if (!body || !response.impact) return;
  var impact = response.impact;
  if (engine) {
    var confidence = response.confidence || (response.engine === 'lsp' ? 'semantic' : 'heuristic');
    var confidenceLabel = t('impact.confidence.' + confidence);
    var engineLabel = 'regex index';
    if (response.engine === 'lsp') {
      engineLabel = response.server || 'LSP';
      if (response.serverSource) engineLabel += ' (' + t('impact.server.' + response.serverSource) + ')';
    }
    var evidence = [];
    if (Number.isFinite(Number(response.generation))) evidence.push('g' + Number(response.generation));
    if (Number.isFinite(Number(response.durationMs))) evidence.push(Number(response.durationMs).toFixed(1) + 'ms');
    engine.textContent = confidenceLabel + ' · ' + engineLabel + ' · ' + impact.symbol + (evidence.length ? ' · ' + evidence.join(' · ') : '');
    engine.title = response.fallbackReason ? String(response.fallbackReason) : '';
  }
  impactLocations = [];
  var sections = [
    ['callers', 'impact.callers'],
    ['dependencies', 'impact.dependencies'],
    ['implementations', 'impact.implementations'],
    ['tests', 'impact.tests'],
    ['contracts', 'impact.contracts'],
  ];
  var html = sections.map(function (entry) {
    var items = Array.isArray(impact[entry[0]]) ? impact[entry[0]] : [];
    var rows = items.map(function (item) {
      var index = impactLocations.length;
      impactLocations.push(item);
      var name = item.name || baseName(item.path);
      var relation = item.relation ? '<span class="impact-relation">' + escapeHtml(item.relation) + '</span>' : '';
      var text = String(item.text || '').trim().slice(0, 180);
      return '<button type="button" class="impact-item" data-impact-index="' + index + '">'
        + '<span class="impact-item-head"><span class="impact-item-name">' + escapeHtml(name) + '</span>' + relation + '</span>'
        + '<span class="impact-item-path">' + escapeHtml(item.path + ':' + (Number(item.lineIndex) + 1)) + '</span>'
        + (text ? '<span class="impact-item-code">' + escapeHtml(text) + '</span>' : '')
        + '</button>';
    }).join('');
    return '<section class="impact-section"><div class="impact-section-title"><span>' + escapeHtml(t(entry[1])) + '</span><span class="impact-count">' + items.length + '</span></div>'
      + (rows || '<div class="impact-section-empty">' + escapeHtml(t('impact.noResults')) + '</div>') + '</section>';
  }).join('');
  body.innerHTML = html;
}

function closeImpact() {
  impactRequestSeq += 1;
  document.getElementById('impact-panel')?.classList.add('hidden');
  syncRail();
}

function toggleImpact() {
  if (isImpactOpen()) closeImpact();
  else openImpact();
}

document.getElementById('impact-close')?.addEventListener('click', closeImpact);
document.getElementById('impact-body')?.addEventListener('click', function (event) {
  var button = event.target && event.target.closest && event.target.closest('.impact-item');
  if (!button) return;
  var item = impactLocations[Number(button.getAttribute('data-impact-index'))];
  if (item) openSourceAt(item.path, Number(item.lineIndex) || 0, Number(item.column) || 0);
});

if (typeof window !== 'undefined') window.__monacoriImpact = { open: openImpact, close: closeImpact, toggle: toggleImpact };
