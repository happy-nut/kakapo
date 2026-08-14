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
    // A custom-scheme script that neither loads nor errors would leave every diagram on "loading…" forever.
    // Bound the wait so the failure is visible and retryable instead of silent.
    var timer = setTimeout(function () { reject(new Error('mermaid load timed out')); }, 15000);
    var settle = function (fn, value) { clearTimeout(timer); fn(value); };
    var script = document.createElement('script');
    script.src = 'kakapo-asset://app/mermaid.js';
    script.async = true;
    script.addEventListener('load', function () {
      if (window.mermaid) settle(resolve, window.mermaid); else settle(reject, new Error('mermaid did not register'));
    });
    script.addEventListener('error', function () { settle(reject, new Error('mermaid failed to load')); });
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
  // The source also rides along IN the placeholder. The registry above is a module variable: a card
  // re-rendered from cached HTML, or the same note after a reload, arrives with an id whose entry no longer
  // exists — and the renderer then returned silently, leaving "loading…" on screen for good.
  return '<div class="explain-mermaid" id="' + id + '">'
    + '<pre class="explain-mermaid-src" hidden>' + escapeHtml(String(src)) + '</pre>'
    + '<span class="explain-mermaid-status">' + escapeHtml(t('explain.diagramLoading')) + '</span></div>';
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
      var carried = node.querySelector('.explain-mermaid-src');
      var src = mermaidSources[node.id] || (carried ? carried.textContent : '');
      // No source at all is a broken diagram, not a permanent "loading…".
      if (!src) { node.dataset.mermaidDone = '1'; node.textContent = t('explain.diagramInvalid'); return; }
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
// An <img> parses its SVG as standalone XML, which .outerHTML does not produce: that HTML serialization
// carries no namespace declaration and leaves the label markup inside <foreignObject> as HTML, where a single
// unclosed <br> is fatal to an XML parser — hence the broken-image icon in the lightbox. XMLSerializer emits
// well-formed XML and declares the namespaces itself (so setting xmlns by hand only duplicates the attribute,
// which is its own parse error). The size has to be pinned, because Mermaid sizes its root against a
// container the <img> does not have.
function mermaidSvgDataUrl(svg) {
  try {
    var clone = svg.cloneNode(true);
    var box = svg.getBoundingClientRect();
    if (box.width && box.height) {
      clone.setAttribute('width', Math.ceil(box.width));
      clone.setAttribute('height', Math.ceil(box.height));
      clone.style.maxWidth = 'none';
    }
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  } catch (e) { return ''; }
}
document.addEventListener('click', function (event) {
  var target = event.target;
  if (!target || !target.closest) return;
  var host = target.closest('.explain-mermaid');
  if (!host) return;
  var link = target.closest('a[href]');
  var href = link ? (link.getAttribute('href') || '') : '';
  var at = href.indexOf('#kakapo:');
  if (at >= 0) {
    event.preventDefault();
    var parts = href.slice(at + '#kakapo:'.length).split(':');
    var line = parseInt(parts.pop(), 10);
    var path = decodeURIComponent(parts.join(':'));
    if (path) navigateToLine(path, line > 0 ? line : 1);
    return;
  }
  if (link) return; // an ordinary link in a diagram keeps its own meaning
  var svg = host.querySelector('svg');
  var url = svg ? mermaidSvgDataUrl(svg) : '';
  if (url) { event.preventDefault(); openLightbox(url, t('diagram.zoom')); }
});
