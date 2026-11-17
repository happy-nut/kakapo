var semanticPeekItems = [];
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

function openSemanticPeek(name, locations, response, kind) {
  var panel = document.getElementById('semantic-peek');
  if (!panel) { openAnalysisUsagesFallback(name, locations, kind); return; }
  semanticPeekItems = semanticNavigationLocations(locations, kind).map(function (item) {
    return { path: item.path, lineIndex: Number(item.lineIndex) || 0, column: Number(item.column) || 0, text: String(item.text || ''), isTest: semanticTestPath(item.path) };
  });
  if (!semanticPeekItems.length) { showSemanticNavigationFailure(kind || 'references', name); return; }
  semanticPeekActive = 0;
  var title = document.getElementById('semantic-peek-title');
  var meta = document.getElementById('semantic-peek-meta');
  var key = kind === 'definition' ? 'peek.definitions' : kind === 'implementation' ? 'peek.implementations' : 'peek.usages';
  if (title) title.textContent = t(key, { n: semanticPeekItems.length }) + ' · ' + name;
  if (meta) {
    var bits = [response && response.confidence || response && response.engine || 'semantic'];
    if (response && response.server) bits.push(response.server + (response.serverSource ? ' (' + response.serverSource + ')' : ''));
    if (response && Number.isFinite(Number(response.durationMs))) bits.push(Number(response.durationMs).toFixed(1) + 'ms');
    meta.textContent = bits.join(' · ');
    meta.title = response && response.fallbackReason ? String(response.fallbackReason) : '';
  }
  renderSemanticPeekResults();
  panel.classList.remove('hidden');
  positionSemanticPeekAtCaret();
  var results = document.getElementById('semantic-peek-results');
  if (results && typeof results.focus === 'function') results.focus({ preventScroll: true });
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
  if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); showSemanticPeekItem(semanticPeekActive + 1); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); showSemanticPeekItem(semanticPeekActive - 1); return true; }
  if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); openActiveSemanticPeekSource(); return true; }
  return false;
}
document.addEventListener('mousedown', function (event) {
  var panel = document.getElementById('semantic-peek');
  if (panel && !panel.classList.contains('hidden') && !panel.contains(event.target)) closeSemanticPeek();
}, true);
window.addEventListener('resize', positionSemanticPeekAtCaret);
