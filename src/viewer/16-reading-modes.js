// Two ways of reading the same file that IntelliJ keeps as switches, and that cost nothing to add here
// because the answer they need is already cached: Show Sticky Lines and Highlight Only Current Declaration
// (its Focus Mode). Both ask "which declaration is this line inside?", and `structureCache` (16-structure.js)
// already holds every symbol of the open file with its `lineIndex`, `endLineIndex` and `depth` — the same
// `textDocument/documentSymbol` answer the ⌘F12 structure popup and ⌥↑/⌥↓ stepping read. Neither mode
// makes a request of its own; a file the reader has not opened a structure for simply warms the cache and
// draws nothing until the next keystroke, which is what stepping already does.

/** The enclosing declarations of `line`, outermost first — what IntelliJ pins, and what Focus Mode keeps. */
function enclosingSymbols(path, line) {
  var cached = structureCache.get(path);
  if (!cached || cached.generation !== analysisGeneration()) {
    fileStructureSymbols(path); // warm it; the next caret move or scroll frame will find it
    return [];
  }
  var symbols = cached.value && Array.isArray(cached.value.symbols) ? cached.value.symbols : [];
  return symbols
    .filter(function (s) {
      return s && typeof s.lineIndex === 'number'
        && s.lineIndex <= line && (s.endLineIndex >= line || s.endLineIndex === s.lineIndex);
    })
    .sort(function (a, b) { return a.lineIndex - b.lineIndex; });
}

// ---- Sticky lines -----------------------------------------------------------------------------------
// The enclosing declarations' own rows, held at the top of the scroll container while their bodies run off
// it. They are CLONES of the real rows rather than rebuilt markup: a clone carries the same cells, the same
// highlighting and the same column widths, so the pinned header lines up with the code under it without a
// single measurement. Only rows that have actually been rendered can be cloned, which is the right
// behaviour on a progressively-filled file — a declaration above the fill point is simply not pinned yet.
var STICKY_DEPTH_LIMIT = 3;
var stickyLinesRaf = 0;
function stickyLinesOverlay(body) {
  var host = body && body.parentNode;
  if (!host) return null;
  var overlay = document.getElementById('sticky-lines');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sticky-lines';
    overlay.className = 'sticky-lines';
    overlay.setAttribute('aria-hidden', 'true'); // the real rows are below it and are what a reader navigates
    host.insertBefore(overlay, body);
  }
  return overlay;
}
function refreshStickyLines() {
  var body = document.getElementById('source-body');
  var overlay = stickyLinesOverlay(body);
  if (!overlay) return;
  var viewer = document.getElementById('source-viewer');
  var path = viewer && viewer.dataset.openPath;
  var off = !renderToggleOn('stickyLines') || !path || !isSourceViewerVisible()
    || body.classList.contains('rendered-body');
  if (off) { overlay.classList.add('hidden'); overlay.innerHTML = ''; return; }
  var rowHeight = sourceRowHeight();
  if (!rowHeight) { overlay.classList.add('hidden'); return; }
  // The first line actually under the top edge. Rows are a fixed monospace height, which is the same
  // assumption the caret-follow scroll makes (scheduleSourceReveal) — no getBoundingClientRect, no reflow.
  var firstVisible = Math.floor((body.scrollTop || 0) / rowHeight);
  var chain = enclosingSymbols(path, firstVisible).filter(function (s) { return s.lineIndex < firstVisible; });
  if (chain.length > STICKY_DEPTH_LIMIT) chain = chain.slice(chain.length - STICKY_DEPTH_LIMIT);
  if (!chain.length) { overlay.classList.add('hidden'); overlay.innerHTML = ''; return; }
  var table = document.createElement('table');
  table.className = 'source-table';
  var tbody = document.createElement('tbody');
  chain.forEach(function (symbol) {
    var row = body.querySelector('.source-row[data-line-index="' + symbol.lineIndex + '"]');
    if (!row) return;
    var clone = row.cloneNode(true);
    clone.classList.remove('cursor-line', 'symbol-target', 'search-hit');
    clone.removeAttribute('id');
    // The clone keeps .source-row so it is styled and measured like the row it copies, which is the whole
    // point of cloning — but it must never ANSWER for that row. The overlay is outside #source-body, where
    // every `.source-row[data-line-index]` query in the app is rooted, and the index comes off the clone so
    // that a stray unrooted query cannot find a second row claiming line 40 either.
    clone.removeAttribute('data-line-index');
    clone.dataset.stickyLine = String(symbol.lineIndex);
    tbody.appendChild(clone);
  });
  if (!tbody.childNodes.length) { overlay.classList.add('hidden'); overlay.innerHTML = ''; return; }
  table.appendChild(tbody);
  overlay.innerHTML = '';
  overlay.appendChild(table);
  // The overlay is a sibling of the scroll container, not a child of it, so it is placed at the container's
  // own top rather than the viewer's — the toolbar above it is not something to paint over.
  overlay.style.top = (body.offsetTop || 0) + 'px';
  overlay.classList.remove('hidden');
}
function scheduleStickyLines() {
  if (stickyLinesRaf) return;
  stickyLinesRaf = requestAnimationFrame(function () { stickyLinesRaf = 0; refreshStickyLines(); });
}
// Clicking a pinned line goes to it, as IntelliJ's does — the one thing the header is good for besides
// saying where you are.
document.addEventListener('click', function (event) {
  var row = event.target && event.target.closest ? event.target.closest('#sticky-lines .source-row') : null;
  if (!row) return;
  var viewer = document.getElementById('source-viewer');
  var path = viewer && viewer.dataset.openPath;
  var line = Number(row.dataset.stickyLine);
  if (!path || !isFinite(line)) return;
  event.preventDefault();
  setSourceCursor(path, line, 0, true, -1);
});
document.getElementById('source-body')?.addEventListener('scroll', scheduleStickyLines, { passive: true });

// ---- Focus mode -------------------------------------------------------------------------------------
// IntelliJ calls the action Highlight Only Current Declaration, which says what it does better than its
// own name for the mode does: everything outside the declaration the caret is in is dimmed, not hidden, so
// the shape of the file is still there to scroll through. Dimming is a class per row, applied over the rows
// that exist — a progressively-filled file re-applies on the next caret move, and a re-render drops the
// classes with the rows that carried them.
function refreshFocusMode() {
  var body = document.getElementById('source-body');
  if (!body) return;
  var viewer = document.getElementById('source-viewer');
  var path = viewer && viewer.dataset.openPath;
  var on = renderToggleOn('focusMode') && path && isSourceViewerVisible()
    && viewerCursor && viewerCursor.path === path;
  if (!on) {
    if (body.querySelector('.focus-dim')) {
      Array.prototype.forEach.call(body.querySelectorAll('.focus-dim'), function (row) { row.classList.remove('focus-dim'); });
    }
    return;
  }
  var chain = enclosingSymbols(path, viewerCursor.lineIndex);
  var inner = chain.length ? chain[chain.length - 1] : null;
  var from = inner ? inner.lineIndex : -1;
  var to = inner ? Math.max(inner.endLineIndex, inner.lineIndex) : -1;
  Array.prototype.forEach.call(body.querySelectorAll('.source-row[data-line-index]'), function (row) {
    var index = Number(row.dataset.lineIndex);
    row.classList.toggle('focus-dim', !inner || index < from || index > to);
  });
}

// ---- Code Vision and inlay hints ----------------------------------------------------------------------
// The two things the language server would have written into the file if the file had been written that
// way: a line above a declaration saying what it is used by (IntelliJ calls the whole family Code Vision),
// and a label inside a line naming a parameter or an inferred type. Both are DECORATION — they never move
// the caret and never change a line's text — and both are switchable, as they are in IntelliJ.
//
// Drawn over the rendered rows rather than built into the markup, for two reasons. The row HTML is already
// highlighted, and splitting highlighted HTML at a character offset to insert a label means parsing it
// back; the browser's own text model does that correctly for free. And a decoration pass that reads the
// DOM can run again when the server answers without re-rendering the file, which is what makes the arrival
// of an answer a repaint instead of a flash.
var decorationCache = new Map();
function decorationCacheMap() {
  if (!decorationCache) decorationCache = new Map();
  return decorationCache;
}
function decorationsFor(kind, path) {
  if (!path) return null;
  var key = kind + '\u0000' + path;
  var cached = decorationCacheMap().get(key);
  if (cached && cached.generation === analysisGeneration()) return cached.pending ? null : cached.value;
  decorationCacheMap().set(key, { generation: analysisGeneration(), value: null, pending: true });
  Promise.resolve(queryProjectAnalysis(kind, null, { path: path, lineIndex: 0, column: 0 }))
    .then(function (response) {
      if (!pageAlive()) return;
      var value = kind === 'codeLens'
        ? (response && Array.isArray(response.lenses) ? response.lenses : null)
        : (response && Array.isArray(response.hints) ? response.hints : null);
      if (!value) { decorationCacheMap().delete(key); return; } // not an answer — see the fold cache
      decorationCacheMap().set(key, { generation: analysisGeneration(), value: value, pending: false });
      var viewer = document.getElementById('source-viewer');
      if (viewer && viewer.dataset.openPath === path) paintSourceDecorations();
    }, function () {
      if (pageAlive()) decorationCacheMap().delete(key);
    });
  return null;
}

/** Remove every decoration this pass owns, so a repaint is idempotent and a switch going off is clean. */
function clearSourceDecorations(body) {
  Array.prototype.forEach.call(body.querySelectorAll('.code-vision-row'), function (row) { row.remove(); });
  Array.prototype.forEach.call(body.querySelectorAll('.inlay-hint'), function (span) { span.remove(); });
}

/**
 * Insert `text` into `cell` at character offset `column`, counting only the cell's own text.
 *
 * The offset is a position in the LINE, and the cell's text is split across however many spans the
 * highlighter produced, so the walk is over text nodes. Inserting between them rather than inside one
 * would land the label in the wrong place on any line with a keyword in it.
 */
function insertInlayHint(cell, column, text, kind, paddingLeft, paddingRight) {
  var walker = document.createTreeWalker(cell, 4 /* NodeFilter.SHOW_TEXT */);
  var seen = 0;
  var node = null;
  while ((node = walker.nextNode())) {
    var length = node.nodeValue ? node.nodeValue.length : 0;
    if (seen + length >= column) {
      var span = document.createElement('span');
      span.className = 'inlay-hint';
      if (kind) span.dataset.inlayKind = kind;
      span.textContent = (paddingLeft ? ' ' : '') + text + (paddingRight ? ' ' : '');
      // Never inside a word: the label goes between text nodes, splitting one if the offset falls inside.
      var at = column - seen;
      if (at <= 0) node.parentNode.insertBefore(span, node);
      else if (at >= length) node.parentNode.insertBefore(span, node.nextSibling);
      else node.parentNode.insertBefore(span, node.splitText(at));
      return true;
    }
    seen += length;
  }
  cell.appendChild(document.createElement('span')).className = 'inlay-hint'; // past the end: at the end
  cell.lastChild.textContent = text;
  return true;
}

/** One pass over the rendered rows: the lens lines above, the hint labels inside. */
function paintSourceDecorations() {
  var body = document.getElementById('source-body');
  if (!body) return;
  var viewer = document.getElementById('source-viewer');
  var path = viewer && viewer.dataset.openPath;
  clearSourceDecorations(body);
  if (!path || !isSourceViewerVisible() || body.classList.contains('rendered-body')) return;

  if (renderToggleOn('codeVision')) {
    var lenses = decorationsFor('codeLens', path);
    (lenses || []).forEach(function (lens) {
      var row = body.querySelector('.source-row[data-line-index="' + lens.lineIndex + '"]');
      if (!row || !row.parentNode) return;
      var vision = document.createElement('tr');
      vision.className = 'code-vision-row';
      vision.setAttribute('aria-hidden', 'true'); // the row below is the code; this is a note about it
      var gutter = document.createElement('td');
      gutter.className = 'num';
      var text = document.createElement('td');
      text.className = 'source-code code-vision-text';
      text.textContent = lens.title;
      vision.appendChild(gutter);
      vision.appendChild(text);
      row.parentNode.insertBefore(vision, row);
    });
  }

  if (renderToggleOn('inlayHints')) {
    var hints = decorationsFor('inlayHint', path);
    (hints || []).forEach(function (hint) {
      var row = body.querySelector('.source-row[data-line-index="' + hint.lineIndex + '"]');
      var cell = row && row.querySelector('.source-code');
      if (!cell) return;
      insertInlayHint(cell, hint.column, hint.label, hint.kind, hint.paddingLeft, hint.paddingRight);
    });
  }
}
