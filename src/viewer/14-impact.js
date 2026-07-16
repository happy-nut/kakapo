var impactRequestSeq = 0;
var impactLocations = [];
var impactCurrentTarget = null;
var impactLastResponse = null;
var impactReturnFocus = null;
var impactActiveIndex = -1;
var impactCandidatesExpanded = false;
var IMPACT_CANDIDATE_PREVIEW_LIMIT = 8;

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
  var engine = document.getElementById('impact-engine');
  if (!panel || !body) return;
  if (!isImpactOpen()) impactReturnFocus = document.activeElement;
  panel.classList.remove('hidden');
  syncRail();
  impactCurrentTarget = currentImpactTarget();
  impactLastResponse = null;
  impactCandidatesExpanded = false;
  impactActiveIndex = -1;
  if (engine) engine.textContent = '';
  if (!impactCurrentTarget || !impactCurrentTarget.loc.path) {
    body.innerHTML = '<div class="impact-empty">' + escapeHtml(t('impact.empty')) + '</div>';
    document.getElementById('impact-close')?.focus();
    return;
  }
  var seq = ++impactRequestSeq;
  body.innerHTML = '<div class="impact-empty impact-loading"><span class="boot-spinner"></span>' + escapeHtml(t('impact.loading')) + '</div>';
  var response = await queryProjectAnalysis('impact', impactCurrentTarget.symbol, impactCurrentTarget.loc);
  if (seq !== impactRequestSeq || !isImpactOpen()) return;
  if (!response || !response.ok || !response.impact) {
    body.innerHTML = '<div class="impact-empty">' + escapeHtml(response && response.error || t('impact.noResults')) + '</div>';
    document.getElementById('impact-close')?.focus();
    return;
  }
  impactLastResponse = response;
  renderImpact(response, true);
}

function impactRelationLabel(relation) {
  if (!relation) return '';
  var key = 'impact.relation.' + relation;
  var translated = t(key);
  return translated === key ? relation : translated;
}

function impactSections(impact) {
  return [
    ['callers', 'impact.callers'],
    ['dependencies', 'impact.dependencies'],
    ['implementations', 'impact.implementations'],
    ['tests', 'impact.tests'],
    ['contracts', 'impact.contracts'],
    ['mentions', 'impact.mentions'],
  ].map(function (entry) {
    return { key: entry[0], title: entry[1], items: Array.isArray(impact[entry[0]]) ? impact[entry[0]] : [] };
  });
}

function impactEvidence(item) {
  // Older analysis responses did not retain item-level provenance. Treating unknown evidence as a
  // candidate is deliberately conservative: the UI must never upgrade a regex hit to confirmed impact.
  return item && item.evidence === 'semantic' ? 'semantic' : 'heuristic';
}

function renderImpactHeader(response) {
  var engine = document.getElementById('impact-engine');
  if (!engine || !response.impact) return;
  var impact = response.impact;
  var origin = impact.origin || (impactCurrentTarget && impactCurrentTarget.loc) || {};
  var symbol = impact.symbol || (impactCurrentTarget && impactCurrentTarget.symbol) || baseName(origin.path || '');
  var location = origin.path ? origin.path + ':' + (Number(origin.lineIndex || 0) + 1) : '';
  var analyzer = response.engine === 'lsp' ? (response.server || 'LSP') : 'regex index';
  if (response.engine === 'lsp' && response.serverSource) analyzer += ' (' + t('impact.server.' + response.serverSource) + ')';
  var timing = Number.isFinite(Number(response.durationMs)) ? Number(response.durationMs).toFixed(1) + 'ms' : '';
  engine.innerHTML = '<span class="impact-target-row"><span class="impact-target-label">' + escapeHtml(t('impact.target')) + '</span>'
    + '<span class="impact-target-symbol">' + escapeHtml(symbol) + '</span>'
    + (location ? '<span class="impact-target-path">' + escapeHtml(location) + '</span>' : '') + '</span>'
    + '<span class="impact-analyzer-row"><span>' + escapeHtml(analyzer) + '</span>'
    + (timing ? '<span aria-hidden="true">·</span><span>' + escapeHtml(timing) + '</span>' : '')
    + '<span class="impact-keyboard-help">' + escapeHtml(t('impact.keyboardHelp')) + '</span></span>';
  engine.title = response.fallbackReason ? String(response.fallbackReason) : '';
}

function renderImpactItem(item, tier) {
  var index = impactLocations.length;
  impactLocations.push(item);
  var name = item.name || baseName(item.path);
  var relationText = impactRelationLabel(item.relation);
  var relation = relationText ? '<span class="impact-relation">' + escapeHtml(relationText) + '</span>' : '';
  var text = String(item.text || '').trim().slice(0, 180);
  return '<button type="button" class="impact-item impact-nav impact-item-' + tier + '" data-impact-index="' + index + '" tabindex="-1">'
    + '<span class="impact-item-head"><span class="impact-item-name">' + escapeHtml(name) + '</span>' + relation + '</span>'
    + '<span class="impact-item-path">' + escapeHtml(item.path + ':' + (Number(item.lineIndex) + 1)) + '</span>'
    + (text ? '<span class="impact-item-code">' + escapeHtml(text) + '</span>' : '')
    + '</button>';
}

function renderImpactTier(sections, evidence, total, response) {
  var confirmed = evidence === 'semantic';
  var title = confirmed ? t('impact.confirmed') : t('impact.candidates');
  var description = confirmed ? t('impact.confirmed.desc') : t('impact.candidates.desc');
  var remainingPreview = !confirmed && !impactCandidatesExpanded && total > IMPACT_CANDIDATE_PREVIEW_LIMIT
    ? IMPACT_CANDIDATE_PREVIEW_LIMIT
    : Infinity;
  var body = sections.map(function (section) {
    var all = section.items.filter(function (item) { return impactEvidence(item) === evidence; });
    if (!all.length) return '';
    var visible = all.slice(0, remainingPreview);
    remainingPreview -= visible.length;
    var rows = visible.map(function (item) { return renderImpactItem(item, confirmed ? 'confirmed' : 'candidate'); }).join('');
    if (!rows) return '';
    return '<section class="impact-section"><div class="impact-section-title"><span>' + escapeHtml(t(section.title)) + '</span>'
      + '<span class="impact-count">' + all.length + '</span></div>' + rows + '</section>';
  }).join('');
  var empty = total ? '' : '<div class="impact-tier-empty">' + escapeHtml(t(confirmed ? 'impact.noConfirmed' : 'impact.noCandidates')) + '</div>';
  var unavailable = !confirmed && response.engine !== 'lsp' && response.fallbackReason
    ? '<div class="impact-fallback"><strong>' + escapeHtml(t('impact.semanticUnavailable')) + '</strong><span>' + escapeHtml(response.fallbackReason) + '</span></div>'
    : '';
  var toggle = !confirmed && total > IMPACT_CANDIDATE_PREVIEW_LIMIT
    ? '<button type="button" class="impact-candidate-toggle impact-nav" tabindex="-1" aria-expanded="' + String(impactCandidatesExpanded) + '">'
      + escapeHtml(t(impactCandidatesExpanded ? 'impact.showFewer' : 'impact.showAll')) + '<span>' + total + '</span></button>'
    : '';
  return '<section class="impact-tier impact-tier-' + (confirmed ? 'confirmed' : 'candidates') + '">'
    + '<div class="impact-tier-head"><span class="impact-tier-mark" aria-hidden="true">' + (confirmed ? '✓' : '?') + '</span>'
    + '<span class="impact-tier-copy"><span class="impact-tier-title">' + escapeHtml(title) + '</span><span class="impact-tier-desc">' + escapeHtml(description) + '</span></span>'
    + '<span class="impact-tier-count">' + total + '</span></div>'
    + unavailable + empty + body + toggle + '</section>';
}

function renderImpact(response, shouldFocus) {
  var body = document.getElementById('impact-body');
  if (!body || !response.impact) return;
  renderImpactHeader(response);
  impactLocations = [];
  var sections = impactSections(response.impact);
  var confirmedCount = 0;
  var candidateCount = 0;
  sections.forEach(function (section) {
    section.items.forEach(function (item) {
      if (impactEvidence(item) === 'semantic') confirmedCount += 1;
      else candidateCount += 1;
    });
  });
  body.innerHTML = renderImpactTier(sections, 'semantic', confirmedCount, response)
    + renderImpactTier(sections, 'heuristic', candidateCount, response);
  if (shouldFocus) focusImpactNavigation(0);
}

function impactNavigationItems() {
  var panel = document.getElementById('impact-panel');
  return panel ? Array.from(panel.querySelectorAll('.impact-nav')) : [];
}

function focusImpactNavigation(index) {
  var items = impactNavigationItems();
  if (!items.length) {
    document.getElementById('impact-close')?.focus();
    impactActiveIndex = -1;
    return;
  }
  impactActiveIndex = Math.max(0, Math.min(index, items.length - 1));
  items.forEach(function (item, itemIndex) { item.tabIndex = itemIndex === impactActiveIndex ? 0 : -1; });
  items[impactActiveIndex].focus({ preventScroll: true });
  items[impactActiveIndex].scrollIntoView({ block: 'nearest' });
}

function openImpactItem(item) {
  if (!item) return;
  closeImpact(false);
  openSourceAt(item.path, Number(item.lineIndex) || 0, Number(item.column) || 0);
}

function closeImpact(restoreFocus) {
  impactRequestSeq += 1;
  document.getElementById('impact-panel')?.classList.add('hidden');
  syncRail();
  if (restoreFocus !== false && impactReturnFocus && typeof impactReturnFocus.focus === 'function' && document.contains(impactReturnFocus)) {
    impactReturnFocus.focus();
  }
  impactLastResponse = null;
  impactCurrentTarget = null;
  impactLocations = [];
  impactActiveIndex = -1;
}

function toggleImpact() {
  if (isImpactOpen()) closeImpact(true);
  else openImpact();
}

document.getElementById('impact-close')?.addEventListener('click', function () { closeImpact(true); });
document.getElementById('impact-body')?.addEventListener('click', function (event) {
  var toggle = event.target && event.target.closest && event.target.closest('.impact-candidate-toggle');
  if (toggle && impactLastResponse) {
    impactCandidatesExpanded = !impactCandidatesExpanded;
    renderImpact(impactLastResponse, false);
    var nextToggle = document.querySelector('.impact-candidate-toggle');
    if (nextToggle) {
      var nav = impactNavigationItems();
      focusImpactNavigation(Math.max(0, nav.indexOf(nextToggle)));
    }
    return;
  }
  var button = event.target && event.target.closest && event.target.closest('.impact-item');
  if (!button) return;
  openImpactItem(impactLocations[Number(button.getAttribute('data-impact-index'))]);
});
document.getElementById('impact-panel')?.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeImpact(true);
    return;
  }
  var items = impactNavigationItems();
  if (!items.length) return;
  var current = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') focusImpactNavigation(0);
    else if (event.key === 'End') focusImpactNavigation(items.length - 1);
    else focusImpactNavigation(Math.max(0, Math.min(items.length - 1, (current < 0 ? 0 : current) + (event.key === 'ArrowDown' ? 1 : -1))));
  } else if (event.key === 'Enter' && document.activeElement && document.activeElement.classList.contains('impact-item')) {
    event.preventDefault();
    event.stopPropagation();
    openImpactItem(impactLocations[Number(document.activeElement.getAttribute('data-impact-index'))]);
  }
});

if (typeof window !== 'undefined') window.__kakapoImpact = { open: openImpact, close: closeImpact, toggle: toggleImpact };
