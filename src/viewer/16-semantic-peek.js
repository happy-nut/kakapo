// Caret-local semantic navigation for the single Review renderer. Project analysis still runs through
// the main-process LSP/regex adapter; this slice only presents multiple locations without opening a
// second code surface.
var semanticPeekItems = [];
var semanticPeekActive = 0;

// Test code, as the PROJECT says rather than as the path looks: 14-project-layout.js asks the declared
// test roots first (an `.iml`'s `isTestSource`, a Maven `src/test`) and falls back to the path pattern
// this used to be. Every surface that sorts tests below production code reads it through here.
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

/**
 * The locations worth showing, in the order worth showing them: documentation and comment-only lines out,
 * tests below production code, the analyzer's own order kept inside each group.
 *
 * `kind` is read for one reason: a list whose answers ARE comments. A region marker (`// region Hooks`) is
 * a comment by construction, so the filter below would drop every row and the list would come up empty —
 * which is what it did the first time. The filter is about noise around an answer, not about answers.
 */
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
    // Keep the analyzer/LSP relevance order inside each group, but move test evidence below production
    // code so a long green test block never interrupts the primary definition/usage scan.
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
  // The noun was built in English by a conditional here, in an app that ships in two languages. It is a
  // user-facing string, so it lives in i18n.ts with the rest of them.
  var key = kind === 'definition' ? 'peek.definitions' : kind === 'implementation' ? 'peek.implementations' : 'peek.usages';
  if (title) title.textContent = t(key).replace('{n}', String(semanticPeekItems.length)) + ' · ' + name;
  if (meta) {
    var bits = [response && response.confidence || response && response.engine || 'semantic'];
    if (response && response.server) bits.push(response.server + (response.serverSource ? ' (' + response.serverSource + ')' : ''));
    // No generation counter here. 'g1' is the analysis index's internal revision — it means nothing to a
    // reader looking for a symbol, and it was taking room from the one thing in this heading that does.
    // It is still on the response for anyone debugging, and the duration below is the part that tells a
    // reader whether the answer is fresh or a fallback.
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

// Shared with the caret hint — see caretAnchorElement in 07-comments.js for why the candidate list is
// gated on which view is showing rather than on geometry.
function semanticPeekAnchorRect() {
  var el = caretAnchorElement();
  return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
}

function positionSemanticPeekAtCaret() {
  positionPanelAtCaret(document.getElementById('semantic-peek'));
}

/**
 * Put a caret-anchored panel where the caret is: below it when there is room, above it when there is not,
 * clamped to the window on both axes.
 *
 * Generalised from the peek's own positioning when Quick Documentation needed the same thing. One
 * function, two panels — the alternative was a second copy of the four-way fallback below, which is the
 * part of this that is actually hard to get right.
 */
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

// A usage row shows a line of code, so it reads like code: the same tokenizer the source view uses, keyed
// off the language of the file the line came from. A path the review has no entry for stays plain text.
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
    // Each row needs an id so the listbox can point at the active one: focus stays on the list while the
    // arrows move the selection, so without aria-activedescendant a screen reader heard "Semantic
    // locations, listbox" and then nothing at all as the reader arrowed through it — and Enter opened a
    // row they were never told about.
    // Which module, in a workspace where two files share a name — the same tag every other list here
    // carries (14-project-layout.js). The test is already said by `is-test`, so only the module. The row
    // claims its third grid track only when it has something to put in it.
    var tags = projectRowTagsHtml(item.path, 'module');
    return '<button type="button" role="option" id="semantic-peek-item-' + index + '" aria-selected="' + (index === semanticPeekActive ? 'true' : 'false')
      + '" class="semantic-peek-item' + (item.isTest ? ' is-test' : '') + (tags ? ' has-tags' : '') + (index === semanticPeekActive ? ' active' : '') + '" data-index="' + index + '" title="' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '">'
      + '<span class="semantic-peek-item-path">' + escapeHtml(semanticFileLabel(item.path, item.lineIndex)) + '</span>'
      + '<span class="semantic-peek-item-code">' + semanticCodeHtml(item.path, item.text.trim().slice(0, 180)) + '</span>'
      + tags
      + '</button>';
  }).join('') + '<div class="semantic-peek-list-hint">' + escapeHtml(t('monaco.peekHint')) + '</div>';
  // Rebuilt every time the selection moves, so the pointer is reset with it.
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
  // Hand the keyboard back. The panel takes focus when it opens and never gave it up: Escape left
  // document.activeElement on <body>, so the next Tab started from the top of the document and an
  // assistive technology's cursor went with it. The CSS two rules up has always said "Escape returns to
  // the original caret"; this is the half of that which was missing.
  var hadFocus = panel.contains(document.activeElement);
  panel.classList.add('hidden');
  panel.style.left = panel.style.top = panel.style.bottom = panel.style.width = panel.style.maxHeight = '';
  if (!hadFocus) return;
  var body = document.getElementById('source-body');
  if (body && body.offsetParent !== null && typeof body.focus === 'function') { body.focus({ preventScroll: true }); return; }
  var diff = document.getElementById('diff2html-container');
  if (diff && typeof diff.focus === 'function') diff.focus({ preventScroll: true });
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
