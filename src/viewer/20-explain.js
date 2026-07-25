// ===== Explain view (⌘7): an AI agent writes a content-spec JSON file; this file renders it into
// kakapo's own components (sections/blocks/diagrams/quiz) so the agent never hand-writes HTML/CSS. =====

var explainCurrentSpec = null;
var explainSpecPath = '';

// ----- view lifecycle (same shape as History's isHistoryOpen/openHistory/closeHistory/toggleHistory) -----
function isExplainViewVisible() {
  var v = document.getElementById('explain-view');
  return !!(v && !v.classList.contains('hidden'));
}
function closeExplainView() {
  var v = document.getElementById('explain-view');
  if (v) v.classList.add('hidden');
  if (typeof syncRail === 'function') syncRail();
}
function openExplainView() {
  var v = document.getElementById('explain-view');
  if (!v) return;
  v.classList.remove('hidden');
  if (typeof syncRail === 'function') syncRail();
  updateExplainPromptTextarea();
  requestExplainSpec();
  updateExplainToolbarVisibility();
  if (typeof updateExplainSendCommentsButton === 'function') { try { updateExplainSendCommentsButton(); } catch (e) {} }
}
// Once a doc is rendered, the prompt is no longer the point of the view — hide the prompt-only actions
// (copy/send) so the toolbar isn't cluttered with buttons for a step the user already finished. They
// reappear if the doc is ever cleared back to the empty/waiting state (e.g. a workspace switch).
function updateExplainToolbarVisibility() {
  var doc = document.getElementById('explain-doc');
  var showPromptActions = !(doc && !doc.classList.contains('hidden'));
  var copyBtn = document.getElementById('explain-copy-prompt');
  var sendBtn = document.getElementById('explain-send-prompt');
  if (copyBtn) copyBtn.classList.toggle('hidden', !showPromptActions);
  if (sendBtn) sendBtn.classList.toggle('hidden', !showPromptActions);
}
function toggleExplainView() { if (isExplainViewVisible()) closeExplainView(); else openExplainView(); }
if (typeof window !== 'undefined') {
  window.__kakapoExplain = { open: openExplainView, close: closeExplainView, toggle: toggleExplainView, isOpen: isExplainViewVisible };
}

// ----- prompt: settings-editable default (same shape as mergePromptFor/saveMergePrompt) -----
function defaultExplainPrompt() { return t('explain.prompt.default'); }
var explainPromptKey = 'kakapo-explain-prompt';
function loadExplainPrompt() {
  var b = persistRead(explainPromptKey);
  if (typeof b === 'string' && b.trim()) return b;
  try { var ls = localStorage.getItem(explainPromptKey); if (ls && ls.trim()) return ls; } catch (e) {}
  return defaultExplainPrompt();
}
function saveExplainPrompt(text) { persistSave(explainPromptKey, text || ''); }
function currentExplainPromptText() {
  return loadExplainPrompt().split('{{SPEC_PATH}}').join(explainSpecPath || '');
}
function updateExplainPromptTextarea() {
  var ta = document.getElementById('explain-prompt-text');
  if (ta) ta.value = currentExplainPromptText();
}
function copyExplainPrompt() {
  var ok = copyTextToClipboard(currentExplainPromptText());
  if (typeof showToast === 'function') showToast(t(ok ? 'explain.copied' : 'explain.copyFailed'));
}
function sendExplainPromptToTerminal() {
  if (!window.__kakapoTerminal || typeof window.__kakapoTerminal.enterSendMode !== 'function') return;
  window.__kakapoTerminal.enterSendMode(currentExplainPromptText());
}

// ----- spec fetch/watch (main polls the workspace's spec file; see app-explain-ipc.ts) -----
function requestExplainSpec() {
  if (!window.kakapoExplain || typeof window.kakapoExplain.read !== 'function') return;
  window.kakapoExplain.read().then(function (result) {
    if (!result) return;
    explainSpecPath = result.path || '';
    updateExplainPromptTextarea();
    if (result.spec) renderExplainSpec(result.spec);
  }).catch(function () {});
}
if (window.kakapoExplain && typeof window.kakapoExplain.onUpdate === 'function') {
  window.kakapoExplain.onUpdate(function (payload) {
    if (payload && payload.spec) renderExplainSpec(payload.spec);
  });
}

// ----- rendering: content spec -> DOM. Every block wrapper carries data-section-id/data-block-id (and
// table rows data-sub-id) — the interface contract 21-explain-comments.js anchors comments against. -----
function isValidExplainSpec(spec) {
  return !!(spec && typeof spec === 'object' && Array.isArray(spec.sections));
}

function explainBlockBodyHtml(block) {
  var type = block && block.type;
  if (type === 'p') return renderMarkdownHtml(block.text);
  if (type === 'callout') {
    var tone = ['info', 'warning', 'danger', 'success'].indexOf(block.tone) >= 0 ? block.tone : 'info';
    var toneClass = tone === 'info' ? '' : ' explain-callout-' + tone;
    var title = block.title ? '<div class="explain-callout-title">' + escapeHtml(String(block.title)) + '</div>' : '';
    return '<div class="explain-callout' + toneClass + '">' + title + renderMarkdownHtml(block.text) + '</div>';
  }
  if (type === 'code') {
    var language = markdownLanguage(block.lang);
    var highlighted = String(block.code || '').split('\n').map(function (line) { return highlightLine(line, language); }).join('\n');
    var caption = block.caption ? '<div class="explain-code-caption">' + escapeHtml(String(block.caption)) + '</div>' : '';
    return caption + '<pre><code>' + highlighted + '</code></pre>';
  }
  if (type === 'table') {
    var headers = Array.isArray(block.headers) ? block.headers : [];
    var rows = Array.isArray(block.rows) ? block.rows : [];
    var thead = '<thead><tr>' + headers.map(function (hd) { return '<th>' + renderMarkdownHtml(String(hd == null ? '' : hd)) + '</th>'; }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (row, ri) {
      var cells = Array.isArray(row) ? row : [];
      return '<tr class="explain-table-row" data-sub-id="r' + ri + '">' + cells.map(function (cell) { return '<td>' + renderMarkdownHtml(String(cell == null ? '' : cell)) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody>';
    var caption = block.caption ? '<caption>' + escapeHtml(String(block.caption)) + '</caption>' : '';
    return '<table>' + caption + thead + tbody + '</table>';
  }
  if (type === 'diagram') return explainDiagramHtml(block);
  return '<pre>' + escapeHtml(JSON.stringify(block, null, 2)) + '</pre>'; // unrecognized block — defensive placeholder, never throws
}

function explainBlockHtml(sectionId, block, index) {
  var blockId = sectionId + '-b' + index;
  // Diagram blocks skip the text reading-width cap (see .explain-block-diagram in viewer.css) — a
  // swimlane/flowchart/context diagram benefits from the full card width; prose does not.
  var extraClass = block && block.type === 'diagram' ? ' explain-block-diagram' : '';
  return '<div class="explain-block' + extraClass + '" data-section-id="' + escapeHtml(sectionId) + '" data-block-id="' + escapeHtml(blockId) + '">'
    + explainBlockBodyHtml(block)
    + '<button type="button" class="explain-comment-affordance" data-section-id="' + escapeHtml(sectionId) + '" data-block-id="' + escapeHtml(blockId) + '" title="' + escapeHtml(t('explain.addComment')) + '" aria-label="' + escapeHtml(t('explain.addComment')) + '">+</button>'
    + '</div>';
}

function explainSectionHtml(section, index) {
  var sectionId = (section && section.id) || ('section-' + index);
  var blocks = Array.isArray(section && section.blocks) ? section.blocks : [];
  var body = blocks.map(function (block, bi) { return explainBlockHtml(sectionId, block, bi); }).join('');
  return '<section class="explain-section" id="explain-sec-' + escapeHtml(sectionId) + '">'
    + '<h2 class="explain-section-h">' + escapeHtml(String((section && section.heading) || sectionId)) + '</h2>'
    + body
    + '</section>';
}

function explainTocHtml(sections, hasQuiz) {
  var items = sections.map(function (section, index) {
    var sectionId = (section && section.id) || ('section-' + index);
    return '<li><a href="#explain-sec-' + escapeHtml(sectionId) + '">' + escapeHtml(String((section && section.heading) || sectionId)) + '</a></li>';
  }).join('');
  if (hasQuiz) items += '<li><a href="#explain-quiz">' + escapeHtml(t('explain.quizHeading')) + '</a></li>';
  return '<div class="explain-toc"><div class="explain-toc-h">' + escapeHtml(t('explain.toc')) + '</div><ul>' + items + '</ul></div>';
}

function explainShuffle(list) {
  var out = list.slice();
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}
function explainQuizQuestionHtml(question, index) {
  var options = Array.isArray(question && question.options) ? explainShuffle(question.options) : [];
  var opts = options.map(function (opt) {
    return '<button type="button" class="explain-quiz-opt" data-correct="' + (opt && opt.correct ? 'true' : 'false') + '" data-feedback="' + escapeHtml(String((opt && opt.feedback) || '')) + '">' + renderMarkdownHtml(opt && opt.text) + '</button>';
  }).join('');
  return '<div class="explain-quiz-q" id="explain-quiz-q' + index + '">'
    + '<div class="explain-quiz-question">' + (index + 1) + '. ' + renderMarkdownHtml(question && question.question) + '</div>'
    + opts
    + '<div class="explain-quiz-feedback"></div>'
    + '</div>';
}
function explainQuizHtml(quiz) {
  if (!Array.isArray(quiz) || !quiz.length) return '';
  return '<section class="explain-section" id="explain-quiz"><h2 class="explain-section-h">' + escapeHtml(t('explain.quizHeading')) + '</h2>'
    + quiz.map(explainQuizQuestionHtml).join('') + '</section>';
}
document.addEventListener('click', function (event) {
  var opt = event.target && event.target.closest && event.target.closest('#explain-doc .explain-quiz-opt');
  if (!opt) return;
  var q = opt.closest('.explain-quiz-q');
  var fb = q && q.querySelector('.explain-quiz-feedback');
  if (!fb) return;
  var correct = opt.dataset.correct === 'true';
  fb.textContent = (correct ? '✅ ' : '❌ ') + (opt.dataset.feedback || '');
  fb.className = 'explain-quiz-feedback ' + (correct ? 'correct' : 'incorrect');
});

function renderExplainSpec(spec) {
  if (!isValidExplainSpec(spec)) return;
  var doc = document.getElementById('explain-doc');
  var empty = document.getElementById('explain-empty');
  if (!doc || !empty) return;
  explainCurrentSpec = spec;
  var sections = Array.isArray(spec.sections) ? spec.sections : [];
  var quiz = Array.isArray(spec.quiz) ? spec.quiz : [];
  var html = '';
  if (spec.title) html += '<div class="explain-doc-title">' + escapeHtml(String(spec.title)) + '</div>';
  if (spec.subtitle) html += '<div class="explain-doc-subtitle">' + escapeHtml(String(spec.subtitle)) + '</div>';
  html += explainTocHtml(sections, quiz.length > 0);
  html += sections.map(explainSectionHtml).join('');
  html += explainQuizHtml(quiz);
  doc.innerHTML = html;
  doc.classList.remove('hidden');
  empty.classList.add('hidden');
  updateExplainToolbarVisibility();
  renderMermaidDiagrams(doc);
  if (typeof refreshExplainComments === 'function') { try { refreshExplainComments(); } catch (e) {} }
}

// ----- diagrams: kind -> data -> markup. "flow"/"ui-mockup" are plain HTML/CSS (simple enough that a
// layout algorithm buys nothing). "context"/"swimlane"/"flowchart" render through Mermaid (vendored,
// lazy-loaded — see loadMermaid below) instead of a hand-rolled SVG layout: real graph/sequence layout
// (label collision avoidance, edge routing) is a genuinely hard problem Mermaid already solves well, and
// the agent already knows Mermaid syntax natively — asking it to write flowchart/sequenceDiagram text
// directly is both less code here and more reliable output than a bespoke JSON node/edge schema. -----
function explainDiagramHtml(block) {
  var kind = block && block.kind;
  var data = (block && block.data) || {};
  var caption = block && block.title ? '<div class="explain-diagram-caption">' + escapeHtml(String(block.title)) + '</div>' : '';
  if (kind === 'flow') return '<div class="explain-diagram">' + explainFlowDiagramHtml(data) + caption + '</div>';
  if (kind === 'ui-mockup') return '<div class="explain-diagram">' + explainUiMockupHtml(data) + caption + '</div>';
  if (kind === 'context' || kind === 'swimlane' || kind === 'flowchart') {
    var src = String((data && data.mermaid) || '').trim();
    if (!src) return '<div class="explain-diagram"><div class="explain-diagram-caption">' + escapeHtml(t('explain.diagramInvalid')) + '</div></div>';
    explainMermaidSeq += 1;
    var id = 'explain-mermaid-' + explainMermaidSeq;
    explainMermaidSources[id] = src;
    return '<div class="explain-diagram"><div class="explain-mermaid" id="' + id + '">' + escapeHtml(t('explain.diagramLoading')) + '</div>' + caption + '</div>';
  }
  return '<div class="explain-diagram"><pre>' + escapeHtml(JSON.stringify(block, null, 2)) + '</pre></div>'; // unrecognized kind — defensive placeholder
}

// Lazy-loads Mermaid the same way 08-dock.js lazy-loads the Tiptap memo editor: a <script> pointed at the
// narrow kakapo-asset:// scheme, so ordinary diff review (which never opens Explain) pays no parse cost
// for a multi-MB library. Cached after the first successful load.
var mermaidLoad = null;
function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoad) return mermaidLoad;
  mermaidLoad = new Promise(function (resolve, reject) {
    var script = document.createElement('script');
    script.src = 'kakapo-asset://app/mermaid.js';
    script.async = true;
    script.addEventListener('load', function () {
      if (window.mermaid) resolve(window.mermaid); else reject(new Error('mermaid did not register'));
    });
    script.addEventListener('error', function () { reject(new Error('mermaid failed to load')); });
    document.head.appendChild(script);
  }).catch(function (error) { mermaidLoad = null; throw error; });
  return mermaidLoad;
}
// Reads kakapo's own theme CSS variables so Mermaid's rendered SVG (dark or light) matches the app chrome
// instead of Mermaid's own default palette — the same "read the live custom properties" trick historyRowSvg
// uses for its halo stroke, just gathered into Mermaid's themeVariables shape.
function explainMermaidThemeVariables() {
  var style = getComputedStyle(document.documentElement);
  function v(name, fallback) { var val = style.getPropertyValue(name); return val ? val.trim() : fallback; }
  var text = v('--text', '#d8e0eb'), elevated = v('--elevated', '#1d232c'), active = v('--active', '#58a6ff');
  var border = v('--border', '#303844'), muted = v('--muted', '#94a0af'), panel = v('--panel', '#171b21');
  return {
    background: panel, primaryColor: elevated, primaryTextColor: text, primaryBorderColor: active,
    lineColor: muted, secondaryColor: elevated, tertiaryColor: elevated, textColor: text,
    actorBkg: elevated, actorBorder: active, actorTextColor: text, actorLineColor: muted,
    signalColor: muted, signalTextColor: text,
    labelBoxBkgColor: elevated, labelBoxBorderColor: border, labelTextColor: text,
    noteBkgColor: elevated, noteBorderColor: border, noteTextColor: text,
  };
}
// Registry of pending Mermaid source strings, keyed by the placeholder div's id — sidesteps HTML-attribute
// escaping entirely for multi-line Mermaid syntax (vs. stuffing it into a data-* attribute).
var explainMermaidSources = {};
var explainMermaidSeq = 0;
function renderMermaidDiagrams(doc) {
  var nodes = Array.prototype.slice.call(doc.querySelectorAll('.explain-mermaid'));
  if (!nodes.length) return;
  loadMermaid().then(function (mermaid) {
    // Re-initialize on every render pass (cheap) so theme variables stay current across a light/dark toggle
    // between one Explain doc and the next, rather than freezing whatever theme was active on first render.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: explainMermaidThemeVariables() });
    nodes.forEach(function (node) {
      var src = explainMermaidSources[node.id];
      if (!src) return;
      mermaid.render(node.id + '-svg', src).then(function (result) {
        node.innerHTML = result.svg;
      }).catch(function () {
        node.textContent = t('explain.diagramInvalid');
      });
    });
  }).catch(function () {
    nodes.forEach(function (node) { node.textContent = t('explain.diagramLoadFailed'); });
  });
}

// "flow": a linear box -> arrow -> box chain. edges.length must equal nodes.length - 1.
function explainFlowDiagramHtml(data) {
  var nodes = Array.isArray(data && data.nodes) ? data.nodes : [];
  var edges = Array.isArray(data && data.edges) ? data.edges : [];
  var out = ['<div class="explain-flow">'];
  nodes.forEach(function (node, i) {
    if (i > 0) {
      var edge = edges[i - 1] || {};
      out.push('<div class="explain-flow-arrow">' + (edge.label ? '<span>' + escapeHtml(String(edge.label)) + '</span>' : '') + '</div>');
    }
    var stateClass = node.state === 'fail' ? ' explain-flow-box-fail' : node.state === 'success' ? ' explain-flow-box-success' : '';
    out.push('<div class="explain-flow-box' + stateClass + '">' + escapeHtml(String(node.label || ''))
      + (node.note ? '<div class="explain-diagram-caption">' + escapeHtml(String(node.note)) + '</div>' : '') + '</div>');
  });
  out.push('</div>');
  return out.join('');
}

// "ui-mockup": nested absolutely-positioned regions inside an abstract unit canvas.
function explainUiRegionHtml(region) {
  var style = 'left:' + (region.x || 0) + 'px;top:' + (region.y || 0) + 'px;width:' + (region.w || 40) + 'px;height:' + (region.h || 24) + 'px;';
  var cls = 'explain-ui-region' + (region.highlight ? ' explain-ui-region-highlight' : '');
  var badge = region.highlight ? '<span class="explain-ui-badge-new">NEW</span>' : '';
  var children = Array.isArray(region.children) ? region.children.map(explainUiRegionHtml).join('') : '';
  return '<div class="' + cls + '" style="' + style + '">' + badge + '<span>' + escapeHtml(String(region.label || '')) + '</span>' + children + '</div>';
}
function explainUiMockupHtml(data) {
  var canvas = (data && data.canvas) || {};
  var regions = Array.isArray(data && data.regions) ? data.regions : [];
  return '<div class="explain-ui-mockup" style="width:' + (canvas.w || 320) + 'px;height:' + (canvas.h || 200) + 'px;">'
    + regions.map(explainUiRegionHtml).join('') + '</div>';
}

(function wireExplainToolbar() {
  var closeBtn = document.getElementById('explain-close');
  if (closeBtn) closeBtn.addEventListener('click', closeExplainView);
  var copyBtn = document.getElementById('explain-copy-prompt');
  if (copyBtn) copyBtn.addEventListener('click', copyExplainPrompt);
  var sendBtn = document.getElementById('explain-send-prompt');
  if (sendBtn) sendBtn.addEventListener('click', sendExplainPromptToTerminal);
})();
