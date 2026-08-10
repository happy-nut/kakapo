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
        node.classList.add('mermaid-zoomable');
        node.title = t('diagram.zoom');
      }).catch(function () {
        node.textContent = t('explain.diagramInvalid');
      });
    });
  }).catch(function () {
    nodes.forEach(function (node) { node.textContent = t('explain.diagramLoadFailed'); });
  });
}

// A diagram is a picture, and a picture in a 700px card is often too small to read — so any of them, whatever
// kind, opens full-size on click. The rendered SVG is turned into a data URL and handed to the same lightbox
// the image preview uses, rather than growing a second overlay that would need its own Escape and backdrop.
//
// A node can also be a LINK into the code: the codebase prompt asks for `click A "#kakapo:path:line"`, which
// mermaid renders as an ordinary anchor. Following it here (rather than through mermaid's `call` callback,
// which securityLevel 'strict' rightly refuses for agent-written content) keeps the diagram source as data
// we parse, never as script we run.
function mermaidSvgDataUrl(svg) {
  try { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.outerHTML || ''); } catch (e) { return ''; }
}
document.addEventListener('click', function (event) {
  var target = event.target;
  if (!target || !target.closest) return;
  var host = target.closest('.mermaid');
  if (!host) return;
  var link = target.closest('a[href]');
  var href = link ? (link.getAttribute('href') || '') : '';
  var at = href.indexOf('#kakapo:');
  if (at >= 0) {
    event.preventDefault();
    var parts = href.slice(at + '#kakapo:'.length).split(':');
    var line = parseInt(parts.pop(), 10);
    var path = decodeURIComponent(parts.join(':'));
    if (path && typeof navigateToLine === 'function') navigateToLine(path, line > 0 ? line : 1);
    return;
  }
  if (link) return; // an ordinary link in a diagram keeps its own meaning
  var svg = host.querySelector('svg');
  var url = svg ? mermaidSvgDataUrl(svg) : '';
  if (url && typeof openLightbox === 'function') { event.preventDefault(); openLightbox(url, t('diagram.zoom')); }
});
