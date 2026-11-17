
function enclosingSymbols(path, line) {
  var cached = structureCache.get(path);
  if (!cached || cached.generation !== analysisGeneration()) {
    fileStructureSymbols(path);
    return [];
  }
  var symbols = cached.value && Array.isArray(cached.value.symbols) ? cached.value.symbols : [];
  return symbols
    .filter(function (s) {
      return s && typeof s.lineIndex === 'number'
        && s.lineIndex <= line && (s.endLineIndex >= line || s.lineIndex === line);
    })
    .sort(function (a, b) { return a.lineIndex - b.lineIndex; });
}

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
    overlay.setAttribute('aria-hidden', 'true');
    host.insertBefore(overlay, body);
  }
  return overlay;
}
function refreshStickyLines() {
  var body = document.getElementById('source-body');
  var overlay = stickyLinesOverlay(body);
  if (!overlay) return;
  var path = sourceOpenPath();
  var off = !renderToggleOn('stickyLines') || !path || !isSourceViewerVisible()
    || body.classList.contains('rendered-body');
  if (off) { overlay.classList.add('hidden'); overlay.innerHTML = ''; return; }
  var rowHeight = sourceRowHeight();
  if (!rowHeight) { overlay.classList.add('hidden'); return; }
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
    clone.removeAttribute('data-line-index');
    clone.dataset.stickyLine = String(symbol.lineIndex);
    tbody.appendChild(clone);
  });
  if (!tbody.childNodes.length) { overlay.classList.add('hidden'); overlay.innerHTML = ''; return; }
  table.appendChild(tbody);
  overlay.innerHTML = '';
  overlay.appendChild(table);
  overlay.style.top = (body.offsetTop || 0) + 'px';
  overlay.classList.remove('hidden');
}
function scheduleStickyLines() {
  if (stickyLinesRaf) return;
  stickyLinesRaf = requestAnimationFrame(function () { stickyLinesRaf = 0; refreshStickyLines(); });
}
document.addEventListener('click', function (event) {
  var row = event.target && event.target.closest ? event.target.closest('#sticky-lines .source-row') : null;
  if (!row) return;
  var path = sourceOpenPath();
  var line = Number(row.dataset.stickyLine);
  if (!path || !isFinite(line)) return;
  event.preventDefault();
  setSourceCursor(path, line, 0, true, -1);
});
document.getElementById('source-body')?.addEventListener('scroll', scheduleStickyLines, { passive: true });

function refreshFocusMode() {
  var body = document.getElementById('source-body');
  if (!body) return;
  var path = sourceOpenPath();
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
      if (!value) { decorationCacheMap().delete(key); return; }
      decorationCacheMap().set(key, { generation: analysisGeneration(), value: value, pending: false });
      if (sourceOpenPath() === path) paintSourceDecorations();
    }, function () {
      if (pageAlive()) decorationCacheMap().delete(key);
    });
  return null;
}

function clearSourceDecorations(body) {
  Array.prototype.forEach.call(body.querySelectorAll('.code-vision-row'), function (row) { row.remove(); });
  Array.prototype.forEach.call(body.querySelectorAll('.inlay-hint'), function (span) { span.remove(); });
}

function insertInlayHint(cell, column, text, kind, paddingLeft, paddingRight) {
  var walker = sourceTextWalker(cell);
  var seen = 0;
  var node = null;
  while ((node = walker.nextNode())) {
    var length = node.nodeValue ? node.nodeValue.length : 0;
    if (seen + length >= column) {
      var span = document.createElement('span');
      span.className = 'inlay-hint';
      span.setAttribute('aria-hidden', 'true');
      if (kind) span.dataset.inlayKind = kind;
      span.textContent = (paddingLeft ? ' ' : '') + text + (paddingRight ? ' ' : '');
      var at = column - seen;
      if (at <= 0) node.parentNode.insertBefore(span, node);
      else if (at >= length) {
        var after = node.nextSibling;
        while (after && after.classList && after.classList.contains('inlay-hint')) after = after.nextSibling;
        node.parentNode.insertBefore(span, after);
      }
      else node.parentNode.insertBefore(span, node.splitText(at));
      return true;
    }
    seen += length;
  }
  cell.appendChild(document.createElement('span')).className = 'inlay-hint';
  cell.lastChild.textContent = text;
  return true;
}

var CODE_VISION_LINE_MAX = 3;
function codeVisionLineText(titles) {
  if (titles.length <= CODE_VISION_LINE_MAX) return titles.join(' · ');
  return titles.slice(0, CODE_VISION_LINE_MAX).join(' · ')
    + ' · ' + t('vision.more', { n: titles.length - CODE_VISION_LINE_MAX });
}

function paintSourceDecorations() {
  var body = document.getElementById('source-body');
  if (!body) return;
  var path = sourceOpenPath();
  clearSourceDecorations(body);
  if (!path || !isSourceViewerVisible() || body.classList.contains('rendered-body')) return;

  if (renderToggleOn('codeVision')) {
    var byLine = new Map();
    (decorationsFor('codeLens', path) || []).forEach(function (lens) {
      if (!byLine.has(lens.lineIndex)) byLine.set(lens.lineIndex, []);
      byLine.get(lens.lineIndex).push(lens.title);
    });
    byLine.forEach(function (titles, lineIndex) {
      var row = body.querySelector('.source-row[data-line-index="' + lineIndex + '"]');
      if (!row || !row.parentNode) return;
      var vision = document.createElement('tr');
      vision.className = 'code-vision-row';
      vision.setAttribute('aria-hidden', 'true');
      var gutter = document.createElement('td');
      gutter.className = 'num';
      var text = document.createElement('td');
      text.className = 'source-code code-vision-text';
      text.textContent = codeVisionLineText(titles);
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
