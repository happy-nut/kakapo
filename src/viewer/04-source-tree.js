function isTreeRowVisible(el) {
  var node = el;
  while (node) {
    var parent = node.parentElement;
    if (!parent || parent.classList.contains('tab-panel')) return true;
    if (parent.tagName === 'DETAILS' && !parent.open && node.tagName !== 'SUMMARY') return false;
    node = parent;
  }
  return true;
}

// Transport-backed reviews receive compact source metadata, not a pre-rendered all-files HTML tree. Build
// only the root rows here; each folder materializes its direct children the first time it opens. The number
// of live DOM nodes therefore follows what the reviewer explores instead of the repository's total size.
var virtualSourceRoot = null;
var virtualSourceNodeByPath = new Map();
var virtualSourceDetailsByPath = new Map();

function buildVirtualSourceTree(files) {
  var root = { name: '', path: '', children: new Map(), file: null };
  virtualSourceNodeByPath = new Map();
  (files || []).forEach(function (file) {
    var parts = String(file.path || '').split('/').filter(Boolean);
    if (!parts.length) return;
    var node = root, current = '';
    for (var i = 0; i < parts.length - 1; i++) {
      current = current ? current + '/' + parts[i] : parts[i];
      var child = node.children.get(parts[i]);
      if (!child) {
        child = { name: parts[i], path: current, children: new Map(), file: null };
        node.children.set(parts[i], child);
        virtualSourceNodeByPath.set(current, child);
      }
      node = child;
    }
    var leaf = parts[parts.length - 1];
    node.children.set(leaf + '\0' + file.path, { name: leaf, path: file.path, children: new Map(), file: file });
  });
  return root;
}

function virtualSourceChildren(node) {
  return Array.from(node.children.values()).sort(function (a, b) {
    if (Boolean(a.file) !== Boolean(b.file)) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

function virtualFileColor(path) {
  var ext = String(path || '').split('/').pop().split('.').pop().toLowerCase();
  var colors = {
    ts:'#3178c6',tsx:'#3178c6',js:'#e8bf6a',jsx:'#e8bf6a',json:'#cbcb41',yaml:'#cb9b41',yml:'#cb9b41',
    html:'#e44d26',vue:'#41b883',svelte:'#ff3e00',css:'#42a5f5',scss:'#c6538c',md:'#9aa0a6',mdx:'#9aa0a6',
    go:'#00add8',rs:'#dea584',py:'#3572a5',rb:'#cc342d',java:'#b07219',kt:'#a97bff',php:'#8892bf',swift:'#ff8a00',
    c:'#7aa6da',h:'#7aa6da',cpp:'#f34b7d',hpp:'#f34b7d',sh:'#89e051',png:'#26a269',jpg:'#26a269',svg:'#e8bf6a'
  };
  return colors[ext] || '#7f868d';
}

function virtualSourceNodeHtml(node, depth) {
  if (node.file) {
    var file = node.file;
    var classes = ['file-link', 'source-link', 'tree-file', file.embedded ? '' : 'not-embedded', file.vcs ? 'vcs-' + file.vcs : ''].filter(Boolean).join(' ');
    var color = virtualFileColor(file.path);
    return '<button type="button" class="' + classes + '" data-source-file="' + escapeHtml(file.path) + '" style="--depth:' + depth + '" aria-label="' + escapeHtml(file.path) + '">'
      + '<svg class="ftype" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.25a1 1 0 0 1 1-1h4.3L12.5 4.7v9.05a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" fill="' + color + '" fill-opacity=".2" stroke="' + color + '" stroke-width="1.1"/><path d="M9.2 1.4v2.8a1 1 0 0 0 1 1h2.6" fill="none" stroke="' + color + '" stroke-width="1.1"/></svg>'
      + '<span class="path">' + escapeHtml(node.name) + '</span></button>';
  }
  return '<details class="tree-dir source-dir mc-virtual-dir" data-dir="' + escapeHtml(node.path) + '" style="--depth:' + depth + '">'
    + '<summary><span class="folder-icon mc-virtual-folder" aria-hidden="true">›</span><span class="path">' + escapeHtml(node.name) + '</span></summary>'
    + '<div class="mc-virtual-children" data-depth="' + (depth + 1) + '"></div></details>';
}

function materializeVirtualSourceChildren(container, node, depth) {
  if (!container || container.dataset.materialized === 'true') return;
  container.innerHTML = virtualSourceChildren(node).map(function (child) { return virtualSourceNodeHtml(child, depth); }).join('');
  container.dataset.materialized = 'true';
  container.querySelectorAll('.mc-virtual-dir').forEach(function (details) {
    virtualSourceDetailsByPath.set(details.dataset.dir || '', details);
  });
  sourceLinks = Array.from(document.querySelectorAll('.source-link'));
}

function materializeVirtualSourceDirectory(details) {
  if (!details) return;
  var node = virtualSourceNodeByPath.get(details.dataset.dir || '');
  var container = details.querySelector(':scope > .mc-virtual-children');
  if (node && container) materializeVirtualSourceChildren(container, node, Number(container.dataset.depth || 0));
}

function openVirtualSourceDirectory(path) {
  if (!path || !virtualSourceRoot) return;
  treeRevealing = true;
  var parts = String(path).split('/').filter(Boolean), current = '';
  for (var i = 0; i < parts.length; i++) {
    current = current ? current + '/' + parts[i] : parts[i];
    var details = virtualSourceDetailsByPath.get(current);
    if (!details) break;
    materializeVirtualSourceDirectory(details);
    details.open = true;
  }
  setTimeout(function () { treeRevealing = false; }, 0);
}

function materializeAllVirtualSourceFolders() {
  var pending = Array.from(virtualSourceDetailsByPath.values());
  var seen = new Set(pending);
  for (var i = 0; i < pending.length; i++) {
    materializeVirtualSourceDirectory(pending[i]);
    virtualSourceDetailsByPath.forEach(function (details) {
      if (!seen.has(details)) { seen.add(details); pending.push(details); }
    });
  }
}

function renderDeferredSourceTree(files) {
  var panel = document.getElementById('files-panel');
  if (!panel) return;
  virtualSourceRoot = buildVirtualSourceTree(files);
  virtualSourceDetailsByPath = new Map();
  panel.innerHTML = '<nav class="tree source-tree mc-virtual-source-tree"><div class="mc-virtual-root"></div></nav>';
  var root = panel.querySelector('.mc-virtual-root');
  materializeVirtualSourceChildren(root, virtualSourceRoot, 0);
  var nav = panel.querySelector('.mc-virtual-source-tree');
  nav.addEventListener('toggle', function (event) {
    var details = event.target;
    if (!details || !details.classList || !details.classList.contains('mc-virtual-dir')) return;
    if (details.open) materializeVirtualSourceDirectory(details);
    if (!treeRevealing) persistTreeToggle(details);
  }, true);
  var saved = loadTreeOpen();
  saved.forEach(openVirtualSourceDirectory);
  var openPath = (document.getElementById('source-viewer') || {}).dataset?.openPath || '';
  if (openPath.indexOf('/') >= 0) openVirtualSourceDirectory(openPath.slice(0, openPath.lastIndexOf('/')));
  sourceLinks = Array.from(document.querySelectorAll('.source-link'));
  sourceLinks.forEach(function (link) { link.classList.toggle('active', link.dataset.sourceFile === openPath); });
  if (openPath) setSourceTypeIcon(openPath);
}
function treeRows() {
  const panel = document.querySelector('.tab-panel:not(.hidden)');
  if (!panel) return [];
  // isTreeRowVisible walks ancestor <details> (cheap, layout-free) and already excludes rows inside
  // collapsed folders. The previous extra `getClientRects().length > 0` check forced a SYNCHRONOUS
  // reflow per node — 6k forced layouts on every arrow key in a large source tree, which froze input.
  // The details walk makes the rects check redundant, so drop it.
  return Array.from(panel.querySelectorAll('summary, .file-link')).filter(isTreeRowVisible);
}

// Range multi-selection for batch "mark as viewed": Shift+Arrow / Shift+Click select a contiguous run of rows
// from an anchor to the focus; Space then toggles Viewed for every selected changed file at once.
var treeSelectionAnchor = -1;
function treeSelectionRange() {
  if (treeSelectionAnchor < 0 || treeFocusIndex < 0) return null;
  var lo = Math.min(treeSelectionAnchor, treeFocusIndex);
  var hi = Math.max(treeSelectionAnchor, treeFocusIndex);
  return hi > lo ? { lo: lo, hi: hi } : null; // a single row is not a multi-selection
}
function renderTreeSelection() {
  var rows = treeRows();
  var range = treeSelectionRange();
  rows.forEach(function (row, i) {
    row.classList.toggle('tree-selected', !!(range && i >= range.lo && i <= range.hi));
  });
}
function clearTreeSelection() {
  treeSelectionAnchor = -1;
  document.querySelectorAll('.tree-selected').forEach(function (el) { el.classList.remove('tree-selected'); });
}
// Shift+Click: extend from the anchor (or the current focus) to the clicked row, WITHOUT opening the file.
function extendTreeSelectionToRow(row) {
  var rows = treeRows();
  var index = rows.indexOf(row);
  if (index < 0) return false;
  if (treeSelectionAnchor < 0) treeSelectionAnchor = treeFocusIndex >= 0 ? treeFocusIndex : index;
  treeFocusIndex = index;
  renderTreeSelection();
  if (typeof flashReviewPanelFocus === 'function') flashReviewPanelFocus(row.closest('.sidebar'));
  try { row.focus({ preventScroll: true }); } catch (e) {}
  return true;
}
// Space over a multi-selection: mark every selected CHANGED file viewed; if all are already viewed, unview
// them all — so the whole run toggles together ("모두 mark as viewed"). Returns false when there is no range.
function applyViewedToTreeSelection() {
  var range = treeSelectionRange();
  if (!range) return false;
  var rows = treeRows();
  var paths = [];
  for (var i = range.lo; i <= range.hi; i++) {
    var r = rows[i];
    var p = r && r.classList.contains('change-row') ? (r.dataset.file || '') : '';
    if (p && currentFileSignature(p) && paths.indexOf(p) < 0) paths.push(p);
  }
  if (!paths.length) return false;
  var markViewed = paths.some(function (p) { return !isFileViewed(p); });
  paths.forEach(function (p) { setFileViewed(p, markViewed); });
  return true;
}
function focusTree(index, extendSelection) {
  const rows = treeRows();
  if (rows.length === 0) return;
  var prevIndex = treeFocusIndex;
  treeFocusIndex = Math.max(0, Math.min(rows.length - 1, index));
  if (extendSelection) {
    if (treeSelectionAnchor < 0) treeSelectionAnchor = prevIndex >= 0 ? prevIndex : treeFocusIndex;
  } else {
    clearTreeSelection();
  }
  // Render the focus class AND scroll in the SAME frame. A fast key-repeat queues many ArrowDowns before a
  // frame; moving the focus class instantly while the coalesced scroll lags makes the panel jump. Coalescing
  // both keeps focus + scroll in lockstep, and scrolloffReveal scrolls ONLY when the focused row nears the
  // top/bottom edge — a row moving inside the visible band must never drag the whole panel (revealAt did,
  // re-centering on every move so even a mid-list row scrolled the sidebar).
  scheduleTreeFocus();
}
var treeFocusRaf = 0;
function scheduleTreeFocus() {
  if (treeFocusRaf) return;
  treeFocusRaf = requestAnimationFrame(function () {
    treeFocusRaf = 0;
    const rows = treeRows();
    renderTreeSelection();
    if (treeFocusIndex < 0 || treeFocusIndex >= rows.length) return;
    const el = rows[treeFocusIndex];
    document.querySelectorAll('.tree-focus').forEach((e) => { if (e !== el) e.classList.remove('tree-focus'); });
    if (el) {
      el.classList.add('tree-focus');
      flashReviewPanelFocus(el.closest('.sidebar'));
      scrolloffReveal(el, document.querySelector('.sidebar-scroll'), 0.15);
    }
  });
}

// Pointer selection is already visible under the mouse. Keep the logical tree cursor on that exact row so
// Arrow/Enter continue from it, but never reveal/re-center the sidebar: moving a list the user just clicked
// makes the target appear to slip out from under the pointer. This also explicitly focuses the row because
// macOS does not consistently give clicked buttons keyboard focus.
function focusTreeRowFromPointer(row) {
  if (!row) return;
  const rows = treeRows();
  const index = rows.indexOf(row);
  if (index < 0) return;
  clearTreeSelection(); // a plain pointer click starts a fresh single selection
  treeFocusIndex = index;
  if (treeFocusRaf) {
    cancelAnimationFrame(treeFocusRaf);
    treeFocusRaf = 0;
  }
  document.querySelectorAll('.tree-focus').forEach((el) => { if (el !== row) el.classList.remove('tree-focus'); });
  row.classList.add('tree-focus');
  try { row.focus({ preventScroll: true }); } catch (e) { try { row.focus(); } catch (ignore) {} }
  flashReviewPanelFocus(row.closest('.sidebar'));
}

function clearTreeFocus() {
  treeFocusIndex = -1;
  clearTreeSelection();
  document.querySelectorAll('.tree-focus').forEach((el) => el.classList.remove('tree-focus'));
}

// Focus the tree row for the currently open file (source openPath, else the active diff file);
// falls back to the first row when nothing is open or no matching row exists.
function focusOpenFileInTree() {
  const rows = treeRows();
  if (rows.length === 0) return;
  let openPath = document.getElementById('source-viewer')?.dataset.openPath || '';
  if (!openPath && typeof diffActiveWrapper === 'function') {
    const w = diffActiveWrapper();
    const n = w && w.querySelector('.d2h-file-name');
    if (n && n.textContent) openPath = n.textContent.trim();
  }
  let idx = 0;
  if (openPath) {
    for (let i = 0; i < rows.length; i++) {
      const ds = rows[i].dataset || {};
      if (ds.sourceFile === openPath || ds.file === openPath) { idx = i; break; }
    }
  }
  focusTree(idx);
}

// Reveal the currently-open file in the sidebar tree, scrolled to the CENTER of the panel (the header button
// and ⌥F1). Expands the sidebar and ancestor folders first, then centers and flashes the row.
function revealOpenFileInTree() {
  var openPath = (document.getElementById('source-viewer') && document.getElementById('source-viewer').dataset.openPath) || '';
  if (!openPath && typeof diffActiveWrapper === 'function') {
    var w = diffActiveWrapper();
    var n = w && w.querySelector('.d2h-file-name');
    if (n && n.textContent) openPath = n.textContent.trim();
  }
  if (!openPath) return;
  if (typeof isDiffViewVisible === 'function' && isDiffViewVisible() && typeof setReviewSidebarCollapsed === 'function') setReviewSidebarCollapsed(false);
  else if (typeof isSourceViewerVisible === 'function' && isSourceViewerVisible() && typeof setSourceSidebarCollapsed === 'function') setSourceSidebarCollapsed(false);
  if (typeof revealTreeFor === 'function') revealTreeFor(openPath, false); // open ancestor folders; center below
  // Folders may have just opened, so locate + center on the next frame.
  requestAnimationFrame(function () {
    var rows = treeRows();
    var target = null;
    for (var i = 0; i < rows.length; i++) {
      var ds = rows[i].dataset || {};
      if (ds.sourceFile === openPath || ds.file === openPath) { target = rows[i]; treeFocusIndex = i; break; }
    }
    if (!target) return;
    document.querySelectorAll('.tree-focus').forEach(function (el) { if (el !== target) el.classList.remove('tree-focus'); });
    target.classList.add('tree-focus');
    if (target.scrollIntoView) { try { target.scrollIntoView({ block: 'center' }); } catch (e) { target.scrollIntoView(); } }
    if (typeof flashReviewPanelFocus === 'function') flashReviewPanelFocus(target.closest('.sidebar'));
  });
}
document.addEventListener('click', function (event) {
  var btn = event.target && event.target.closest && event.target.closest('#brand-reveal');
  if (btn) { event.preventDefault(); revealOpenFileInTree(); }
});

function treePageSize() {
  var scroller = document.querySelector('.sidebar-scroll');
  var h = scroller ? scroller.clientHeight : 320;
  return Math.max(1, Math.floor(h / 20) - 1); // ~20px per tree row, minus one for overlap
}
function treeOpenKey() { return 'kakapo-tree-open:' + location.pathname; }
function loadTreeOpen() {
  try {
    var stored = persistRead(treeOpenKey());
    if (Array.isArray(stored)) return new Set(stored);
    return new Set(JSON.parse(sessionStorage.getItem(treeOpenKey()) || '[]'));
  } catch (e) { return new Set(); }
}
function saveTreeOpen(set) {
  var paths = Array.from(set);
  persistSave(treeOpenKey(), paths);
  try { sessionStorage.setItem(treeOpenKey(), JSON.stringify(paths)); } catch (e) {}
}
// Folders start collapsed. Restore the folders the user manually opened, plus reveal the open file's
// path. Toggle listeners attach AFTER the initial state so the auto-revealed path is not mistaken for
// a user-opened folder (keeping "collapsed by default" intact on the next load).
var treeRevealing = false; // true while opening folders programmatically, so those opens are not persisted
function persistTreeToggle(d) {
  var set = loadTreeOpen();
  var dir = d.dataset.dir || '';
  if (d.open) set.add(dir); else set.delete(dir);
  saveTreeOpen(set);
}
function initSourceTreeFolds() {
  if (document.querySelector('.mc-virtual-source-tree')) return;
  var dirs = Array.prototype.slice.call(document.querySelectorAll('.source-dir'));
  if (!dirs.length) return;
  var saved = loadTreeOpen();
  var openPath = (document.getElementById('source-viewer') && document.getElementById('source-viewer').dataset.openPath) || '';
  // Only USER toggles persist; the initial state below is applied under treeRevealing so the open
  // file's revealed path stays transient (folders stay "collapsed by default" on the next load).
  dirs.forEach(function (d) {
    d.addEventListener('toggle', function () { if (!treeRevealing) persistTreeToggle(d); });
  });
  treeRevealing = true;
  dirs.forEach(function (d) {
    var dir = d.dataset.dir || '';
    var reveal = openPath && (openPath === dir || openPath.indexOf(dir + '/') === 0);
    d.open = saved.has(dir) || !!reveal;
  });
  setTimeout(function () { treeRevealing = false; }, 0);
}
// Expand a file's ancestor folders so it is visible in the tree (transient — not persisted). Semantic and
// keyboard navigation may also reveal the selected row; a pointer click suppresses that scroll because the
// row is already visible and the sidebar must stay under the mouse.
function revealTreeFor(path, shouldScroll) {
  if (!path) return;
  if (document.querySelector('.mc-virtual-source-tree')) {
    var slash = path.lastIndexOf('/');
    if (slash > 0) openVirtualSourceDirectory(path.slice(0, slash));
    sourceLinks = Array.from(document.querySelectorAll('.source-link'));
    sourceLinks.forEach(function (link) { link.classList.toggle('active', link.dataset.sourceFile === path); });
    setSourceTypeIcon(path);
  }
  treeRevealing = true;
  document.querySelectorAll('.source-dir').forEach(function (d) {
    var dir = d.dataset.dir || '';
    if (dir && (path === dir || path.indexOf(dir + '/') === 0) && !d.open) d.open = true;
  });
  setTimeout(function () { treeRevealing = false; }, 0);
  var active = document.querySelector('.source-link.active');
  if (shouldScroll !== false && active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}
function handleTreeKey(event) {
  const rows = treeRows();
  if (rows.length === 0) return false;
  if (treeFocusIndex >= rows.length) treeFocusIndex = rows.length - 1;
  const row = rows[treeFocusIndex];
  const isFolder = row && row.tagName === 'SUMMARY';
  // Shift+Arrow / Shift+PageUp/Down extend a contiguous multi-selection from the anchor.
  if (event.key === 'ArrowDown') { event.preventDefault(); focusTree(treeFocusIndex + 1, event.shiftKey); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); focusTree(treeFocusIndex - 1, event.shiftKey); return true; }
  if (event.key === 'PageDown') { event.preventDefault(); focusTree(treeFocusIndex + treePageSize(), event.shiftKey); return true; }
  if (event.key === 'PageUp') { event.preventDefault(); focusTree(treeFocusIndex - treePageSize(), event.shiftKey); return true; }
  // Viewed is a review-queue property, so it may only be changed from the keyboard-selected Changes row.
  // Space in the code canvas keeps its existing editor/fold meaning and Files/source rows remain untouched.
  if (event.key === ' ' || event.code === 'Space') {
    // A multi-selection toggles Viewed for the whole run at once; otherwise the single focused change row.
    if (applyViewedToTreeSelection()) { event.preventDefault(); return true; }
    if (row && row.classList.contains('change-row')) {
      event.preventDefault();
      var viewedPath = row.dataset.file || '';
      if (viewedPath && currentFileSignature(viewedPath)) setFileViewed(viewedPath, !isFileViewed(viewedPath));
      return true;
    }
  }
  if (event.key === 'Enter' && event.altKey) {
    event.preventDefault();
    if (row && typeof openTreeRowMenu === 'function') openTreeRowMenu(row); // path / file manager / terminal actions
    return true;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (row && row.classList.contains('file-link')) { row.click(); clearTreeFocus(); }
    else if (isFolder && row.parentElement) row.parentElement.open = !row.parentElement.open;
    return true;
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (isFolder && row.parentElement && !row.parentElement.open) row.parentElement.open = true;
    else focusTree(treeFocusIndex + 1);
    return true;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (isFolder && row.parentElement && row.parentElement.open) row.parentElement.open = false;
    else focusTree(treeFocusIndex - 1);
    return true;
  }
  if (event.key === 'Escape') { event.preventDefault(); clearTreeFocus(); return true; }
  return false;
}

// d2h-file-side-diff is a HORIZONTAL scrollport (overflow-x:auto), so the browser swallows VERTICAL wheel
// there instead of bubbling it to #diff2html-container — the diff wouldn't scroll by mouse wheel at all.
// Redirect vertical wheel to the container; leave horizontal wheel (deltaX) for the side's own h-scroll.
(function () {
  var dsc = document.getElementById('diff2html-container');
  if (dsc) dsc.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX) && e.deltaY !== 0) {
      if (typeof prepareAsymmetricDiffWheel === 'function') prepareAsymmetricDiffWheel(e);
      dsc.scrollTop += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
})();
// A floating, focus-grabbing overlay (merged-comments, prompt memo, settings) is open. While one is up it
// owns focus AND the only caret, so global shortcuts stand down until Esc/close — we must not navigate a
// panel the user can't even see behind the overlay (nor leave a second blinking caret in it).
