function paintTreeRowAriaLabels(root) {
  (root || document).querySelectorAll('a.file-link[data-file]').forEach(function (row) {
    var match = /\bch-([a-z]+)\b/.exec(row.className || '');
    var status = match ? match[1] : 'modified';
    var added = Number(row.getAttribute('data-added')) || 0;
    var deleted = Number(row.getAttribute('data-deleted')) || 0;
    var stat = added || deleted ? ', +' + added + ' −' + deleted : '';
    row.setAttribute('aria-label', row.getAttribute('data-file') + ' — ' + t('tree.status.' + status) + stat);
  });
}

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

var virtualSourceRoot = null;
var virtualSourceNodeByPath = new Map();
var virtualSourceDetailsByPath = new Map();

function buildVirtualSourceTree(files) {
  var root = { name: '', path: '', children: new Map(), file: null };
  virtualSourceNodeByPath = new Map();
  var modules = projectLayoutData().modules || [];
  (files || []).forEach(function (file) {
    var entry = moduleEntryFor(file.path, modules);
    var parts = String((entry ? entry.rest : file.path) || '').split('/').filter(Boolean);
    if (!parts.length) return;
    var node = root, current = '';
    if (entry) {
      var key = '\0module:' + entry.root;
      var group = root.children.get(key);
      if (!group) {
        group = { name: entry.name, path: entry.root, children: new Map(), file: null, module: entry.name };
        root.children.set(key, group);
        virtualSourceNodeByPath.set(entry.root, group);
      }
      node = group;
      current = entry.root;
    }
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
    if (Boolean(a.module) !== Boolean(b.module)) return a.module ? -1 : 1;
    if (Boolean(a.file) !== Boolean(b.file)) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

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
      + '<span class="path" title="' + escapeHtml(node.name) + '">' + leafNameHtml(node.name) + '</span></button>';
  }
  return '<details class="tree-dir source-dir mc-virtual-dir' + (node.module ? ' tree-module-node' : '') + '"'
    + ' data-dir="' + escapeHtml(node.path) + '"' + (node.module ? ' data-module="' + escapeHtml(node.module) + '"' : '')
    + ' style="--depth:' + depth + '">'
    + '<summary>' + VIRTUAL_FOLDER_ICON + '<span class="path">' + escapeHtml(node.name) + '</span></summary>'
    + '<div class="mc-virtual-children" data-depth="' + (depth + 1) + '"></div></details>';
}

function expandUntilFiles(details, budget) {
  if (!details) return;
  materializeVirtualSourceDirectory(details);
  var scope = details.querySelector(':scope > .mc-virtual-children') || details;
  if (scope.querySelector(':scope > .tree-file')) return;
  var dirs = Array.prototype.slice.call(scope.querySelectorAll(':scope > .tree-dir'));
  if (dirs.length !== 1 || budget <= 0) return;
  dirs[0].open = true;
  expandUntilFiles(dirs[0], budget - 1);
}
function expandUntilFilesTransient(details) {
  if (treeRevealing) return;
  treeRevealing = true;
  try { expandUntilFiles(details, 50); } finally { setTimeout(function () { treeRevealing = false; }, 0); }
}

function materializeVirtualSourceChildren(container, node, depth) {
  if (!container || container.dataset.materialized === 'true') return;
  container.innerHTML = virtualSourceChildren(node).map(function (child) { return virtualSourceNodeHtml(child, depth); }).join('');
  container.dataset.materialized = 'true';
  container.querySelectorAll('.mc-virtual-dir').forEach(function (details) {
    virtualSourceDetailsByPath.set(details.dataset.dir || '', details);
  });
  sourceLinks = Array.from(document.querySelectorAll('.source-link'));
  markProjectLayoutInTrees();
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
    if (!details) continue;
    materializeVirtualSourceDirectory(details);
    details.open = true;
  }
  setTimeout(function () { treeRevealing = false; }, 0);
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
    if (details.open) expandUntilFilesTransient(details);
  }, true);
  var saved = loadTreeOpen();
  saved.forEach(openVirtualSourceDirectory);
  var openPath = sourceOpenPath();
  if (openPath.indexOf('/') >= 0) openVirtualSourceDirectory(openPath.slice(0, openPath.lastIndexOf('/')));
  sourceLinks = Array.from(document.querySelectorAll('.source-link'));
  markProjectLayoutInTrees();
  sourceLinks.forEach(function (link) { link.classList.toggle('active', link.dataset.sourceFile === openPath); });
  if (openPath) setSourceTypeIcon(openPath);
}
function treeRows() {
  const panel = document.querySelector('.tab-panel:not(.hidden)');
  if (!panel) return [];
  return Array.from(panel.querySelectorAll('summary, .file-link')).filter(isTreeRowVisible);
}

var treeSelectionAnchor = -1;
function treeSelectionRange() {
  if (treeSelectionAnchor < 0 || treeFocusIndex < 0) return null;
  var lo = Math.min(treeSelectionAnchor, treeFocusIndex);
  var hi = Math.max(treeSelectionAnchor, treeFocusIndex);
  return hi > lo ? { lo: lo, hi: hi } : null;
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
function extendTreeSelectionToRow(row) {
  var rows = treeRows();
  var index = rows.indexOf(row);
  if (index < 0) return false;
  if (treeSelectionAnchor < 0) treeSelectionAnchor = treeFocusIndex >= 0 ? treeFocusIndex : index;
  treeFocusIndex = index;
  renderTreeSelection();
  flashReviewPanelFocus(row.closest('.sidebar'));
  try { row.focus({ preventScroll: true }); } catch (e) {}
  return true;
}
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

function focusTreeRowFromPointer(row) {
  if (!row) return;
  const rows = treeRows();
  const index = rows.indexOf(row);
  if (index < 0) return;
  clearTreeSelection();
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
  var active = document.activeElement;
  if (active && active.matches && active.matches('.sidebar summary, .sidebar .file-link')) active.blur();
}

function focusOpenFileInTree() {
  const rows = treeRows();
  if (rows.length === 0) return;
  let openPath = sourceOpenPath();
  if (!openPath) {
    const w = diffActiveWrapper();
    if (w) openPath = diffWrapperPathKey(w);
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

function revealOpenFileInTree() {
  if (isHistoryOpen()) closeHistory();
  closeMergedDock();

  var srcOn = isSourceViewerVisible();
  var diffOn = isDiffViewVisible();
  if (!srcOn && !diffOn) { showSourceView(); srcOn = true; }
  setTab('files');
  if (srcOn) setSourceSidebarCollapsed(false);
  else if (diffOn) setReviewSidebarCollapsed(false);

  requestAnimationFrame(function () {
    var openPath = sourceOpenPath();
    if (!openPath) {
      var w = diffActiveWrapper();
      if (w) openPath = diffWrapperPathKey(w);
    }
    if (!openPath) return;
    revealTreeFor(openPath, false);
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
      flashReviewPanelFocus(target.closest('.sidebar'));
    });
  });
}
document.addEventListener('click', function (event) {
  var btn = event.target && event.target.closest && event.target.closest('#brand-reveal');
  if (btn) { event.preventDefault(); revealOpenFileInTree(); }
});

function treePageSize() {
  var scroller = document.querySelector('.sidebar-scroll');
  var h = scroller ? scroller.clientHeight : 320;
  return Math.max(1, Math.floor(h / 20) - 1);
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
var treeRevealing = false;
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
  var openPath = sourceOpenPath();
  dirs.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (treeRevealing) return;
      persistTreeToggle(d);
      if (d.open) expandUntilFilesTransient(d);
    });
  });
  treeRevealing = true;
  dirs.forEach(function (d) {
    var dir = d.dataset.dir || '';
    var reveal = openPath && (openPath === dir || openPath.indexOf(dir + '/') === 0);
    d.open = saved.has(dir) || !!reveal;
  });
  setTimeout(function () { treeRevealing = false; }, 0);
}
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
  var applying = true;
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
function revealTreeFor(path, shouldScroll) {
  if (!path) return;
  if (document.querySelector('.mc-virtual-source-tree')) {
    var slash = path.lastIndexOf('/');
    if (slash > 0) openVirtualSourceDirectory(path.slice(0, slash));
    sourceLinks = Array.from(document.querySelectorAll('.source-link'));
    markProjectLayoutInTrees();
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
function openFocusedTreeRow() {
  var row = treeRows()[treeFocusIndex];
  if (!row || !row.classList.contains('file-link')) return false;
  row.click();
  clearTreeFocus();
  return true;
}

function handleTreeKey(event) {
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return false;
  const rows = treeRows();
  if (rows.length === 0) return false;
  if (treeFocusIndex >= rows.length) treeFocusIndex = rows.length - 1;
  const row = rows[treeFocusIndex];
  const isFolder = row && row.tagName === 'SUMMARY';
  const treeNav = !event.metaKey && !event.ctrlKey;
  if (treeNav && event.key === 'ArrowDown') { event.preventDefault(); focusTree(treeFocusIndex + 1, event.shiftKey); return true; }
  if (treeNav && event.key === 'ArrowUp') { event.preventDefault(); focusTree(treeFocusIndex - 1, event.shiftKey); return true; }
  if (treeNav && event.key === 'PageDown') { event.preventDefault(); focusTree(treeFocusIndex + treePageSize(), event.shiftKey); return true; }
  if (treeNav && event.key === 'PageUp') { event.preventDefault(); focusTree(treeFocusIndex - treePageSize(), event.shiftKey); return true; }
  if (event.key === ' ' || event.code === 'Space') {
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
    if (row) openTreeRowMenu(row);
    return true;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!openFocusedTreeRow() && isFolder && row.parentElement) row.parentElement.open = !row.parentElement.open;
    return true;
  }
  if (treeNav && event.key === 'ArrowRight') {
    event.preventDefault();
    if (isFolder && row.parentElement && !row.parentElement.open) row.parentElement.open = true;
    else focusTree(treeFocusIndex + 1);
    return true;
  }
  if (treeNav && event.key === 'ArrowLeft') {
    event.preventDefault();
    if (isFolder && row.parentElement && row.parentElement.open) row.parentElement.open = false;
    else focusTree(treeFocusIndex - 1);
    return true;
  }
  if (event.key === 'Escape') { event.preventDefault(); clearTreeFocus(); return true; }
  return false;
}

(function () {
  var dsc = document.getElementById('diff2html-container');
  if (dsc) dsc.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX) && e.deltaY !== 0) {
      prepareAsymmetricDiffWheel(e);
      dsc.scrollTop += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
})();

var trivialSeenKey = 'kakapo-trivial-seen:' + location.pathname;
function loadTrivialSeen() {
  var seen = persistRead(trivialSeenKey);
  if (seen && typeof seen === 'object') return seen;
  try { var raw = localStorage.getItem(trivialSeenKey); if (raw) return JSON.parse(raw); } catch (e) {}
  return {};
}
function autoViewTrivial() {
  var rows = document.querySelectorAll('#changes-panel .change-row[data-trivial]');
  if (!rows.length) return;
  var seen = loadTrivialSeen();
  var changed = false;
  Array.prototype.forEach.call(rows, function (row) {
    var path = row.dataset.file || '';
    var signature = path ? currentFileSignature(path) : '';
    if (!signature || seen[path] === signature) return;
    seen[path] = signature;
    changed = true;
    if (!isFileViewed(path)) setFileViewed(path, true);
  });
  if (changed) persistSave(trivialSeenKey, seen);
}
autoViewTrivial();
