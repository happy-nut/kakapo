// ===== Mermaid: lazy-loaded diagram rendering for the agent-written explain notes (23-annotations.js)
// and any other Markdown body that embeds a ```mermaid fence. =====
//
// Lazy-loads Mermaid the same way 08-dock.js lazy-loads the Tiptap memo editor: a <script> pointed at the
// narrow kakapo-asset:// scheme, so ordinary diff review (which never renders a diagram) pays no parse cost
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
function mermaidThemeVariables() {
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
var mermaidSources = {};
var mermaidSeq = 0;
// Emit a placeholder for one Mermaid source string; renderMermaidDiagrams() swaps in the SVG afterwards.
function mermaidPlaceholderHtml(src) {
  mermaidSeq += 1;
  var id = 'explain-mermaid-' + mermaidSeq;
  mermaidSources[id] = String(src);
  return '<div class="explain-mermaid" id="' + id + '">' + escapeHtml(t('explain.diagramLoading')) + '</div>';
}
// `root` is any container (usually the whole document, for note cards scattered through the diff).
// Already-rendered nodes are skipped, so calling this after every comment refresh is near-free.
function renderMermaidDiagrams(root) {
  var nodes = Array.prototype.slice.call(root.querySelectorAll('.explain-mermaid')).filter(function (node) {
    return !node.dataset.mermaidDone;
  });
  if (!nodes.length) return;
  loadMermaid().then(function (mermaid) {
    // Re-initialize on every render pass (cheap) so theme variables stay current across a light/dark toggle,
    // rather than freezing whatever theme was active on the first render.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: mermaidThemeVariables() });
    nodes.forEach(function (node) {
      var src = mermaidSources[node.id];
      if (!src) return;
      node.dataset.mermaidDone = '1';
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
