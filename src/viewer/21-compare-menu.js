// ===== Compare dropdown: the two questions a reader actually switches between ========================
// The toolbar pill says what the diff is comparing; this makes it a control. Two rows — everything on this
// branch, and what is not committed yet — plus the branch the first of them is measured against.
//
// It does NOT replace the patch-set bar below it. That bar picks a base/target PAIR out of the branch's
// commits, which is the right tool once you are reading a specific commit's work; this is the tool for the
// two states you leave the app sitting in. Overlapping controls, different granularity, on purpose.
//
// Electron only: window.kakapoGit.compareMenu is the git process behind it, and a static export has none.

var compareMenuState = null; // last { mode, ref, defaultRef, branches[] } from main
var compareMenuBranchFilter = '';

function compareMenuEl() { return document.getElementById('compare-menu'); }
function compareMenuOpen() {
  var el = compareMenuEl();
  return !!el && !el.classList.contains('hidden');
}
function compareMenuAvailable() {
  return !!(window.kakapoGit && typeof window.kakapoGit.compareMenu === 'function');
}

// Rows currently reachable by arrow keys: the mode rows and the branch opener, or the branch list once that
// panel is showing. Rebuilt on each keystroke rather than cached — the branch list is filtered as you type.
function compareMenuRows() {
  var el = compareMenuEl();
  if (!el) return [];
  var branches = document.getElementById('compare-menu-branches');
  var inBranches = branches && !branches.classList.contains('hidden');
  return Array.prototype.slice.call(el.querySelectorAll(inBranches ? '.compare-branch-item' : '.compare-menu-main .compare-menu-row'));
}

function renderCompareMenu() {
  var el = compareMenuEl();
  if (!el || !compareMenuState) return;
  var data = compareMenuState;
  var against = document.getElementById('compare-menu-against');
  // "vs main" / "main 대비" — the ref rides inside the phrase because the two languages put it on opposite
  // sides of the word, so a bare span glued on either end would read wrong in one of them.
  if (against) against.textContent = data.ref ? t('compare.menu.against').replace('{ref}', data.ref) : '';
  var refEl = document.getElementById('compare-menu-ref');
  if (refEl) refEl.textContent = data.ref || '';
  el.querySelectorAll('.compare-menu-row[data-mode]').forEach(function (row) {
    var on = row.getAttribute('data-mode') === data.mode;
    row.classList.toggle('active', on);
    row.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  renderCompareBranchList();
}

function renderCompareBranchList() {
  var list = document.getElementById('compare-branch-list');
  if (!list || !compareMenuState) return;
  var needle = compareMenuBranchFilter.toLowerCase();
  var branches = (compareMenuState.branches || []).filter(function (name) {
    return !needle || name.toLowerCase().indexOf(needle) >= 0;
  });
  if (!branches.length) {
    list.innerHTML = '<div class="compare-branch-empty">' + escapeHtml(t('compare.menu.noBranch')) + '</div>';
    return;
  }
  list.innerHTML = branches.map(function (name) {
    var current = name === compareMenuState.ref;
    // The repository's own default is worth marking: it is the answer you get back by picking nothing, and
    // without the mark a list of thirty branches gives no clue which one that is.
    var note = name === compareMenuState.defaultRef ? '<span class="compare-branch-note">' + escapeHtml(t('compare.menu.default')) + '</span>' : '';
    return '<button type="button" class="compare-branch-item' + (current ? ' active' : '') + '" role="option"'
      + ' aria-selected="' + (current ? 'true' : 'false') + '" data-ref="' + escapeHtml(name) + '">'
      + '<span class="compare-branch-name">' + escapeHtml(name) + '</span>'
      + note
      + '<span class="compare-menu-check" aria-hidden="true"></span>'
      + '</button>';
  }).join('');
}

// Keep the popover inside the window. It hangs off the toolbar's meta group, which sits well to the right on
// a wide window, and opening the branch panel adds another 326px to its right edge — enough to run off the
// screen on a 1440-wide window and put the branch list where it cannot be clicked.
function positionCompareMenu() {
  var el = compareMenuEl();
  if (!el || el.classList.contains('hidden')) return;
  el.style.left = '0px';
  var overflow = el.getBoundingClientRect().right - (window.innerWidth - 12);
  if (overflow > 0) el.style.left = (-overflow) + 'px';
}

function showCompareBranchPanel(show) {
  var panel = document.getElementById('compare-menu-branches');
  var opener = document.querySelector('.compare-menu-branch-open');
  if (!panel) return;
  panel.classList.toggle('hidden', !show);
  if (opener) opener.setAttribute('aria-expanded', show ? 'true' : 'false');
  if (!show) { positionCompareMenu(); return; }
  compareMenuBranchFilter = '';
  var search = document.getElementById('compare-branch-search');
  if (search) { search.value = ''; setTimeout(function () { search.focus(); }, 0); }
  renderCompareBranchList();
  positionCompareMenu();
}

function closeCompareMenu() {
  var el = compareMenuEl();
  // Blind-callable: the direct-pick shortcuts (⌥A / ⌥U) route through applyCompareMode whether or not the
  // menu is up, and pulling focus onto the pill from a keystroke that opened nothing would take the caret
  // out of the diff.
  if (!el || el.classList.contains('hidden')) return;
  el.classList.add('hidden');
  showCompareBranchPanel(false);
  var pill = document.getElementById('compare-pill');
  if (pill) { pill.setAttribute('aria-expanded', 'false'); pill.focus(); }
}

function openCompareMenu() {
  var el = compareMenuEl();
  if (!el || !compareMenuAvailable()) return;
  el.classList.remove('hidden');
  showCompareBranchPanel(false);
  var pill = document.getElementById('compare-pill');
  if (pill) pill.setAttribute('aria-expanded', 'true');
  // Paint from the last known state immediately so the menu never opens empty, then correct it from git.
  renderCompareMenu();
  positionCompareMenu();
  var rows = compareMenuRows();
  if (rows.length) rows[0].focus();
  refreshCompareMenu();
}

function refreshCompareMenu() {
  if (!compareMenuAvailable()) return Promise.resolve(null);
  return Promise.resolve(window.kakapoGit.compareMenu()).then(function (data) {
    if (data && typeof data === 'object') { compareMenuState = data; renderCompareMenu(); }
    return compareMenuState;
  }).catch(function () { return compareMenuState; });
}

// Apply a pick. The diff repaints through the normal kakapo:diff-update path, so nothing here touches it.
function applyCompareMode(mode, ref) {
  if (!window.kakapoGit || typeof window.kakapoGit.setCompareMode !== 'function') return;
  requestDiffViewOnNextCompare(); // switch back to the diff for the rebuild, as the patch-set bar does
  // Optimistic: the row ticks now rather than after a rebuild that can take a second on a large tree.
  if (compareMenuState) {
    compareMenuState.mode = mode;
    if (ref) compareMenuState.ref = ref;
    renderCompareMenu();
  }
  closeCompareMenu();
  Promise.resolve(window.kakapoGit.setCompareMode(mode, ref)).then(function (res) {
    if (res && res.ok && compareMenuState) {
      compareMenuState.mode = res.mode || mode;
      compareMenuState.ref = res.ref || compareMenuState.ref;
      renderCompareMenu();
    }
  }).catch(function () {});
}

// ⌥A / ⌥U: go straight to a mode without opening anything. Two keys rather than one toggle, because a toggle
// only tells you where you end up if you already know where you started — and the whole reason to reach for
// this is that you are not sure which of the two the review is currently showing.
function pickCompareMode(mode) {
  if (!compareMenuAvailable()) return;
  applyCompareMode(mode, undefined);
}

// ⌥C: open the menu with the branch list already showing and the filter focused. Choosing the branch is the
// one thing here that needs typing, so the key that opens it should land you where you can type.
function openCompareBranchPicker() {
  if (!compareMenuAvailable()) return;
  if (!compareMenuOpen()) openCompareMenu();
  // The branch list is filled from compareMenuState; on the first press that is still in flight, so show the
  // panel once the data lands rather than opening an empty one.
  if (compareMenuState) showCompareBranchPanel(true);
  else refreshCompareMenu().then(function () { if (compareMenuOpen()) showCompareBranchPanel(true); });
}

// Keyboard while the menu is up. Registered in KEY_OWNERS (05-keymap.js), above the general focus guard, so
// Esc and the arrows work whether the focus sits on a row or in the branch search field.
function handleCompareMenuKey(event) {
  if (!compareMenuOpen()) return false;
  if (event.key === 'Escape') {
    event.preventDefault();
    var panel = document.getElementById('compare-menu-branches');
    // Esc backs out one level at a time: the branch panel first, the menu second.
    if (panel && !panel.classList.contains('hidden')) { showCompareBranchPanel(false); var rows0 = compareMenuRows(); if (rows0.length) rows0[rows0.length - 1].focus(); }
    else closeCompareMenu();
    return true;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    var rows = compareMenuRows();
    if (!rows.length) return true;
    var at = rows.indexOf(document.activeElement);
    var next = event.key === 'ArrowDown' ? at + 1 : at - 1;
    if (next < 0) next = rows.length - 1;
    if (next >= rows.length) next = 0;
    event.preventDefault();
    rows[next].focus();
    return true;
  }
  if (event.key === 'ArrowRight' && document.activeElement && document.activeElement.classList.contains('compare-menu-branch-open')) {
    event.preventDefault();
    showCompareBranchPanel(true);
    return true;
  }
  if (event.key === 'ArrowLeft') {
    var branches = document.getElementById('compare-menu-branches');
    if (branches && !branches.classList.contains('hidden')) {
      event.preventDefault();
      showCompareBranchPanel(false);
      var back = compareMenuRows();
      if (back.length) back[back.length - 1].focus();
      return true;
    }
  }
  // Typing goes to the branch filter whenever that panel is up, even from a focused row.
  if (event.key === 'Enter' && document.activeElement && document.activeElement.id === 'compare-branch-search') {
    var first = document.querySelector('.compare-branch-item');
    if (first) { event.preventDefault(); applyCompareMode('all', first.getAttribute('data-ref')); }
    return true;
  }
  return false;
}

function initCompareMenu() {
  // No availability gate here on purpose: the listeners are inert without the pill (a static export never
  // renders one), and gating the WIRING on window.kakapoGit would lose the menu whenever the bridge lands
  // after DOMContentLoaded — which is exactly what happens under test. The actions gate themselves.
  // Delegated on the toolbar: the pill is re-rendered from scratch on every watch tick (09-views-update.js
  // replaces .review-status wholesale), so a handler bound to the button itself would survive exactly one
  // refresh.
  document.addEventListener('click', function (event) {
    var closest = event.target.closest;
    if (!closest) return;
    if (event.target.closest('#compare-pill')) {
      event.preventDefault();
      if (compareMenuOpen()) closeCompareMenu(); else openCompareMenu();
      return;
    }
    var branch = event.target.closest('.compare-branch-item[data-ref]');
    if (branch) { applyCompareMode('all', branch.getAttribute('data-ref')); return; }
    var opener = event.target.closest('.compare-menu-branch-open');
    if (opener) { showCompareBranchPanel(document.getElementById('compare-menu-branches').classList.contains('hidden')); return; }
    var row = event.target.closest('.compare-menu-row[data-mode]');
    if (row) { applyCompareMode(row.getAttribute('data-mode'), undefined); return; }
    if (compareMenuOpen() && !event.target.closest('#compare-menu')) closeCompareMenu();
  });
  var search = document.getElementById('compare-branch-search');
  if (search) search.addEventListener('input', function () { compareMenuBranchFilter = search.value || ''; renderCompareBranchList(); });
  // The mode can change without anyone touching this menu — commit your work and "uncommitted" empties out.
  // Only worth subscribing where there is a menu to keep current.
  if (compareMenuEl() && window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function') {
    window.kakapoMenu.onDiffUpdate(function () { if (compareMenuState) refreshCompareMenu(); });
  }
}

if (typeof window !== 'undefined') {
  window.__kakapoCompareMenu = { open: openCompareMenu, close: closeCompareMenu, pick: pickCompareMode, branches: openCompareBranchPicker, refresh: refreshCompareMenu };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCompareMenu);
  else initCompareMenu();
}
