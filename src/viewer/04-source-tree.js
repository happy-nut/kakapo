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
    if (el) { el.classList.add('tree-focus'); scrolloffReveal(el, document.querySelector('.sidebar-scroll'), 0.15); }
  });
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
function treeOpenKey() { return 'monacori-tree-open:' + location.pathname; }
function loadTreeOpen() { try { return new Set(JSON.parse(sessionStorage.getItem(treeOpenKey()) || '[]')); } catch (e) { return new Set(); } }
function saveTreeOpen(set) { try { sessionStorage.setItem(treeOpenKey(), JSON.stringify(Array.from(set))); } catch (e) {} }
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
// Expand a file's ancestor folders so it is visible in the tree (transient — not persisted), then
// scroll its row into view. Called whenever a source file opens (tree click, go-to-definition, etc.).
function revealTreeFor(path) {
  if (!path) return;
  treeRevealing = true;
  document.querySelectorAll('.source-dir').forEach(function (d) {
    var dir = d.dataset.dir || '';
    if (dir && (path === dir || path.indexOf(dir + '/') === 0) && !d.open) d.open = true;
  });
  setTimeout(function () { treeRevealing = false; }, 0);
  var active = document.querySelector('.source-link.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
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
  if (event.key === 'Enter' && event.altKey) {
    event.preventDefault();
    if (row && typeof openTreeRowMenu === 'function') openTreeRowMenu(row); // copy path / Finder
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
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX) && e.deltaY !== 0) { dsc.scrollTop += e.deltaY; e.preventDefault(); }
  }, { passive: false });
})();
// A floating, focus-grabbing overlay (merged-comments, prompt memo, settings) is open. While one is up it
// owns focus AND the only caret, so global shortcuts stand down until Esc/close — we must not navigate a
// panel the user can't even see behind the overlay (nor leave a second blinking caret in it).
