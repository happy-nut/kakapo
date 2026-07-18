// diff2html remains the patch parser and code-markup producer, but its per-row table cells are no longer
// the visible line-number UI. A pane owns one gutter layer, built from a compact row model, and that layer
// shares the same vertical transform as the code table. Horizontal pinning is therefore one native sticky
// operation per pane instead of hundreds of independently composited sticky <td>s.
var diffViewportResizing = false;
var diffViewportResizeTimer = 0;

function visibleDiffWrappersAfterResize() {
  return Array.prototype.filter.call(
    document.querySelectorAll('.d2h-file-wrapper:not(.df-inactive)'),
    function (wrapper) { return wrapper.getClientRects().length > 0; }
  );
}

function settleDiffViewportResize() {
  diffViewportResizeTimer = 0;
  diffViewportResizing = false;
  // A viewport resize changes every wrapped row, but only the active review (and possibly the single
  // History detail) is painted. Rebuild those layers once after native resizing settles. Measuring every
  // row on every intermediate BrowserWindow frame left Chromium unable to paint the newly exposed strip.
  visibleDiffWrappersAfterResize().forEach(function (wrapper) {
    wrapper.__mcDiffLayersDirty = true;
    if (typeof invalidateAsymmetricDiffGeometry === 'function') invalidateAsymmetricDiffGeometry(wrapper);
    scheduleLayeredDiffGutters(wrapper);
  });
  if (typeof scheduleAsymmetricDiffScroll === 'function') scheduleAsymmetricDiffScroll();
}

window.addEventListener('resize', function () {
  diffViewportResizing = true;
  if (diffViewportResizeTimer) clearTimeout(diffViewportResizeTimer);
  diffViewportResizeTimer = setTimeout(settleDiffViewportResize, 140);
}, { passive: true });

function buildDiffRowModel(side) {
  var table = side && side.querySelector('.d2h-diff-table');
  var rows = table ? Array.prototype.slice.call(table.querySelectorAll('tr')) : [];
  return rows.map(function (row, index) {
    var number = row.querySelector('.d2h-code-side-linenumber');
    var code = row.querySelector('.d2h-code-line-ctn');
    return {
      index: index,
      row: row,
      number: number,
      lineNumber: number ? String(number.textContent || '').trim() : '',
      code: code,
      text: code ? String(code.textContent || '') : '',
      hidden: getComputedStyle(row).display === 'none',
    };
  });
}

function ensureLayeredDiffSide(side) {
  if (!side) return null;
  var stack = side.querySelector(':scope > .mc-diff-layer-stack');
  if (!stack) {
    var codeWrapper = side.querySelector(':scope > .d2h-code-wrapper');
    if (!codeWrapper) return null;
    stack = document.createElement('div');
    stack.className = 'mc-diff-layer-stack';
    side.insertBefore(stack, codeWrapper);
    stack.appendChild(codeWrapper);
  }
  var gutter = stack.querySelector(':scope > .mc-diff-gutter-layer');
  if (!gutter) {
    gutter = document.createElement('div');
    gutter.className = 'mc-diff-gutter-layer';
    gutter.setAttribute('aria-hidden', 'true');
    stack.appendChild(gutter);
  }
  side.classList.add('mc-layered-diff-side');
  var table = stack.querySelector('.d2h-diff-table');
  if (table && typeof ResizeObserver === 'function' && !side.__mcDiffLayerResizeObserver) {
    side.__mcDiffLayerResizeObserver = new ResizeObserver(function () {
      var wrapper = side.closest('.d2h-file-wrapper') || side.parentElement;
      // Hidden file bodies can still receive ResizeObserver delivery after lazy hydration or comment
      // reconciliation. Measuring their rows does no visible work and, on a large review, can monopolize
      // the renderer for seconds. Mark the layer dirty; showOnlyFile refreshes it when the file becomes the
      // active editor again.
      if (wrapper && wrapper.classList && wrapper.classList.contains('df-inactive')) {
        wrapper.__mcDiffLayersDirty = true;
        return;
      }
      // BrowserWindow maximize/drag can deliver a ResizeObserver callback for each native resize frame.
      // Keep the currently painted CSS responsive, but defer the O(rows) gutter projection until the final
      // viewport size is stable; settleDiffViewportResize refreshes every visible wrapper exactly once.
      if (diffViewportResizing) {
        if (wrapper) wrapper.__mcDiffLayersDirty = true;
        return;
      }
      if (typeof syncDiffCommentSpacerHeights === 'function') syncDiffCommentSpacerHeights(wrapper);
      if (typeof invalidateAsymmetricDiffGeometry === 'function') invalidateAsymmetricDiffGeometry(wrapper);
      scheduleLayeredDiffGutters(wrapper);
      if (typeof scheduleAsymmetricDiffScroll === 'function') scheduleAsymmetricDiffScroll();
    });
    side.__mcDiffLayerResizeObserver.observe(table);
  }
  return { stack: stack, gutter: gutter, table: table };
}

function diffGutterNumberClass(row) {
  var names = ['mc-diff-gutter-number'];
  ['mc-diff-modified', 'mc-diff-deleted', 'mc-diff-added', 'mc-active-hunk', 'diff-active-row', 'mc-row-selected'].forEach(function (name) {
    if (row.classList.contains(name)) names.push(name);
  });
  return names.join(' ');
}

function refreshLayeredDiffSide(side) {
  var layer = ensureLayeredDiffSide(side);
  if (!layer || !layer.table) return null;
  var model = buildDiffRowModel(side);
  side.__mcDiffRowModel = model;
  var tableRect = layer.table.getBoundingClientRect();
  var tableHeight = Math.max(layer.table.offsetHeight || 0, Number(tableRect.height) || 0);
  // Keep every layout read together. Existing gutter nodes are live DOM; changing their styles or moving
  // one into a fragment invalidates layout. The old read/write/read/write loop therefore forced Chromium
  // to lay out the entire content-visibility table once PER ROW (multi-second freezes around comments).
  // Measuring first preserves sub-pixel row alignment while reducing the refresh to one layout pass.
  var measurements = model.map(function (entry) {
    if (!entry.number || !entry.lineNumber || entry.hidden) return null;
    var rowRect = entry.row.getBoundingClientRect();
    var height = Math.max(entry.row.offsetHeight || 0, Number(rowRect.height) || 0) || 18.6;
    return {
      top: Number(rowRect.top) - Number(tableRect.top),
      height: height,
      hasLayout: !!(Number(rowRect.height) || entry.row.offsetHeight),
    };
  });
  var fallbackTop = 0;
  var wrapped = !!(side.closest && side.closest('#diff2html-container.line-wrap'));
  var fragment = document.createDocumentFragment();
  var existing = new Map();
  layer.gutter.querySelectorAll('.mc-diff-gutter-number').forEach(function (item) {
    existing.set(item.dataset.diffRowIndex || '', item);
  });
  model.forEach(function (entry, index) {
    var measurement = measurements[index];
    if (!measurement) return;
    var height = measurement.height;
    var top = measurement.hasLayout ? measurement.top : fallbackTop;
    var key = String(entry.index);
    var item = existing.get(key) || document.createElement('span');
    item.className = diffGutterNumberClass(entry.row);
    item.dataset.diffRowIndex = key;
    if (typeof decorateDiffBlameGutterItem === 'function') {
      decorateDiffBlameGutterItem(item, entry, side);
    } else if (item.textContent !== entry.lineNumber) {
      item.textContent = entry.lineNumber;
    }
    item.style.top = top + 'px';
    item.style.height = height + 'px';
    // A wrapped source row can span several visual lines. Its logical line number belongs beside the first
    // visual line, not vertically centred across the whole block.
    item.style.lineHeight = wrapped ? '1.55' : height + 'px';
    fragment.appendChild(item);
    fallbackTop = Math.max(fallbackTop, top + height);
  });
  tableHeight = Math.max(tableHeight, fallbackTop);
  layer.gutter.replaceChildren(fragment);
  layer.gutter.style.height = tableHeight + 'px';
  return { model: model, stack: layer.stack, gutter: layer.gutter };
}

function refreshLayeredDiffGutters(wrapper) {
  if (!wrapper) return [];
  if (wrapper.classList && wrapper.classList.contains('df-inactive')) {
    wrapper.__mcDiffLayersDirty = true;
    return [];
  }
  if (typeof syncDiffBlameWrapper === 'function') syncDiffBlameWrapper(wrapper);
  var result = Array.prototype.map.call(wrapper.querySelectorAll('.d2h-file-side-diff'), refreshLayeredDiffSide).filter(Boolean);
  wrapper.__mcDiffLayersDirty = false;
  return result;
}

function installLayeredDiffGutters(wrapper, deferRefresh) {
  if (!wrapper) return [];
  Array.prototype.forEach.call(wrapper.querySelectorAll('.d2h-file-side-diff'), ensureLayeredDiffSide);
  if (deferRefresh) return [];
  return refreshLayeredDiffGutters(wrapper);
}

var layeredDiffGutterRaf = 0;
var layeredDiffGutterTargets = [];
function scheduleLayeredDiffGutters(wrapper) {
  if (wrapper && wrapper.classList && wrapper.classList.contains('df-inactive')) {
    wrapper.__mcDiffLayersDirty = true;
    return;
  }
  if (wrapper && layeredDiffGutterTargets.indexOf(wrapper) < 0) layeredDiffGutterTargets.push(wrapper);
  if (layeredDiffGutterRaf) return;
  layeredDiffGutterRaf = requestAnimationFrame(function () {
    layeredDiffGutterRaf = 0;
    var targets = layeredDiffGutterTargets.splice(0);
    targets.forEach(refreshLayeredDiffGutters);
  });
}
