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

// Icon parity with the Changes tree and the eager Files tree: the deferred/virtual tree must use the SAME
// folder glyph and category-based file glyphs as render-tree.ts (fileTypeIcon / FOLDER_ICON), not a bare "›"
// chevron and a single generic document. These mirror render-tree.ts exactly (the client cannot import it).
var VIRTUAL_FOLDER_ICON = '<span class="folder-icon"><svg class="folder-ic fi-closed" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg><svg class="folder-ic fi-open" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H21a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg></span>';

function virtualFileExt(path) {
  var base = String(path || '').split('/').pop() || String(path || '');
  var dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : (base.charAt(0) === '.' ? base.slice(1).toLowerCase() : '');
}
function virtualFileColor(ext) {
  var map = {
    ts:'#3178c6', tsx:'#3178c6', mts:'#3178c6', cts:'#3178c6',
    js:'#e8bf6a', jsx:'#e8bf6a', mjs:'#e8bf6a', cjs:'#e8bf6a',
    json:'#cbcb41', jsonc:'#cbcb41',
    yaml:'#cb9b41', yml:'#cb9b41', toml:'#cb9b41', ini:'#cb9b41', env:'#cb9b41', conf:'#cb9b41',
    lock:'#9aa0a6', gitignore:'#9aa0a6', npmrc:'#9aa0a6', editorconfig:'#9aa0a6',
    html:'#e44d26', htm:'#e44d26', vue:'#41b883', svelte:'#ff3e00', xml:'#e8bf6a', svg:'#e8bf6a',
    css:'#42a5f5', scss:'#c6538c', sass:'#c6538c', less:'#2a6db5',
    md:'#9aa0a6', mdx:'#9aa0a6', txt:'#9aa0a6', rst:'#9aa0a6',
    go:'#00add8', rs:'#dea584', py:'#3572a5', rb:'#cc342d', java:'#b07219',
    kt:'#a97bff', kts:'#a97bff', php:'#8892bf', swift:'#ff8a00', cs:'#9b59b6',
    c:'#7aa6da', h:'#7aa6da', cpp:'#f34b7d', hpp:'#f34b7d',
    sh:'#89e051', bash:'#89e051', zsh:'#89e051',
    png:'#26a269', jpg:'#26a269', jpeg:'#26a269', gif:'#26a269', webp:'#26a269', ico:'#26a269', bmp:'#26a269'
  };
  return map[ext] || '#7f868d';
}
function virtualFileCategory(ext) {
  var sets = {
    code: ['ts','tsx','mts','cts','js','jsx','mjs','cjs','go','rs','py','rb','java','kt','kts','php','c','h','cpp','hpp','cs','swift','sh','bash','zsh'],
    data: ['json','jsonc','yaml','yml','toml','ini','env','conf','lock','xml'],
    markup: ['html','htm','vue','svelte'],
    style: ['css','scss','sass','less'],
    doc: ['md','mdx','txt','rst'],
    image: ['png','jpg','jpeg','gif','webp','ico','bmp','svg']
  };
  for (var cat in sets) { if (sets[cat].indexOf(ext) !== -1) return cat; }
  return 'generic';
}
function virtualTypeIcon(path) {
  var ext = virtualFileExt(path);
  var c = virtualFileColor(ext);
  var stroke = 'fill="none" stroke="' + c + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  var inner;
  switch (virtualFileCategory(ext)) {
    case 'code':
      inner = '<path d="M6 4.6 3 8l3 3.4M10 4.6 13 8l-3 3.4" ' + stroke + '/>';
      break;
    case 'markup':
      inner = '<path d="M5.6 4.6 2.8 8l2.8 3.4M10.4 4.6 13.2 8l-2.8 3.4M9.3 3.6 6.7 12.4" ' + stroke + '/>';
      break;
    case 'data':
      inner = '<path d="M7.4 3.6C6.3 3.6 6.3 4.8 6.3 5.8 6.3 6.8 5.6 7.4 4.8 7.4 5.6 7.4 6.3 8 6.3 9 6.3 10 6.3 11.4 7.4 11.4M8.6 3.6C9.7 3.6 9.7 4.8 9.7 5.8 9.7 6.8 10.4 7.4 11.2 7.4 10.4 7.4 9.7 8 9.7 9 9.7 10 9.7 11.4 8.6 11.4" fill="none" stroke="' + c + '" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>';
      break;
    case 'style':
      inner = '<path d="M6.4 4 5.2 12M10.2 4 9 12M3.9 6.6 12 6.6M3.4 9.4 11.5 9.4" ' + stroke + '/>';
      break;
    case 'doc':
      inner = '<path d="M4.5 2.5h4.4L11.5 5v8a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z" fill="' + c + '" fill-opacity="0.16" stroke="' + c + '" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.8 2.6V5h2.6M5.8 8h4M5.8 10.2h2.7" fill="none" stroke="' + c + '" stroke-width="1.2" stroke-linecap="round"/>';
      break;
    case 'image':
      inner = '<rect x="3" y="3.6" width="10" height="8.8" rx="1.4" fill="' + c + '" fill-opacity="0.14" stroke="' + c + '" stroke-width="1.2"/><circle cx="6" cy="6.4" r="1.05" fill="none" stroke="' + c + '" stroke-width="1.1"/><path d="M3.6 11.8 6.7 8.4l2 2.1 1.9-2.2 2.4 2.7" fill="none" stroke="' + c + '" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>';
      break;
    default:
      inner = '<path d="M4 2.25a1 1 0 0 1 1-1h4.3L12.5 4.7v9.05a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" fill="' + c + '" fill-opacity="0.2" stroke="' + c + '" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.2 1.4v2.8a1 1 0 0 0 1 1h2.6" fill="none" stroke="' + c + '" stroke-width="1.1" stroke-linejoin="round"/>';
  }
  return '<svg class="ftype" viewBox="0 0 16 16" aria-hidden="true">' + inner + '</svg>';
}

function virtualSourceNodeHtml(node, depth) {
  if (node.file) {
    var file = node.file;
    var classes = ['file-link', 'source-link', 'tree-file', file.embedded ? '' : 'not-embedded', file.vcs ? 'vcs-' + file.vcs : ''].filter(Boolean).join(' ');
    return '<button type="button" class="' + classes + '" data-source-file="' + escapeHtml(file.path) + '" style="--depth:' + depth + '" aria-label="' + escapeHtml(file.path) + '">'
      + virtualTypeIcon(file.path)
      + '<span class="path">' + escapeHtml(node.name) + '</span></button>';
  }
  return '<details class="tree-dir source-dir mc-virtual-dir" data-dir="' + escapeHtml(node.path) + '" style="--depth:' + depth + '">'
    + '<summary>' + VIRTUAL_FOLDER_ICON + '<span class="path">' + escapeHtml(node.name) + '</span></summary>'
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

function focusTree(index) {
  const rows = treeRows();
  if (rows.length === 0) return;
  treeFocusIndex = Math.max(0, Math.min(rows.length - 1, index));
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
// The Changes tree is the inverse of the source tree: folders default OPEN (every change should be visible
// without a click), so we persist only the folders the reviewer explicitly COLLAPSED — otherwise a watch-tick
// rebuild (which replaces #changes-panel wholesale, dropping per-element listeners) would re-expand them.
function changesCollapsedKey() { return 'kakapo-changes-collapsed:' + location.pathname; }
function loadChangesCollapsed() {
  try {
    var stored = persistRead(changesCollapsedKey());
    if (Array.isArray(stored)) return new Set(stored);
    return new Set(JSON.parse(sessionStorage.getItem(changesCollapsedKey()) || '[]'));
  } catch (e) { return new Set(); }
}
function saveChangesCollapsed(set) {
  var paths = Array.from(set);
  persistSave(changesCollapsedKey(), paths);
  try { sessionStorage.setItem(changesCollapsedKey(), JSON.stringify(paths)); } catch (e) {}
}
function initChangesTreeFolds() {
  var dirs = Array.prototype.slice.call(document.querySelectorAll('#changes-panel .changes-dir'));
  if (!dirs.length) return;
  var collapsed = loadChangesCollapsed();
  var applying = true; // the initial d.open below must not be mistaken for a user toggle
  dirs.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (applying) return;
      var set = loadChangesCollapsed();
      var dir = d.dataset.dir || '';
      if (d.open) set.delete(dir); else set.add(dir);
      saveChangesCollapsed(set);
    });
    d.open = !collapsed.has(d.dataset.dir || '');
  });
  setTimeout(function () { applying = false; }, 0);
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
  if (event.key === 'ArrowDown') { event.preventDefault(); focusTree(treeFocusIndex + 1); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); focusTree(treeFocusIndex - 1); return true; }
  if (event.key === 'PageDown') { event.preventDefault(); focusTree(treeFocusIndex + treePageSize()); return true; }
  if (event.key === 'PageUp') { event.preventDefault(); focusTree(treeFocusIndex - treePageSize()); return true; }
  // Viewed is a review-queue property, so it may only be changed from the keyboard-selected Changes row.
  // Space in the code canvas keeps its existing editor/fold meaning and Files/source rows remain untouched.
  if ((event.key === ' ' || event.code === 'Space') && row && row.classList.contains('change-row')) {
    event.preventDefault();
    var viewedPath = row.dataset.file || '';
    if (viewedPath && currentFileSignature(viewedPath)) setFileViewed(viewedPath, !isFileViewed(viewedPath));
    return true;
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
