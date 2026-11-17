
var compareMenuState = null;
var compareMenuBranchFilter = '';
var compareMenuBranchScope = null;

function paintComparePillTitle() {
  document.querySelectorAll('.compare-pill').forEach(function (pill) {
    var refs = pill.querySelector('.compare-refs');
    var detail = refs
      ? Array.prototype.map.call(refs.children, function (c) { return (c.textContent || '').trim(); })
        .filter(Boolean).join(' ')
      : '';
    pill.setAttribute('title', detail ? t('compare.title') + '\n' + detail : t('compare.title'));
  });
}

function compareMenuEl() { return document.getElementById('compare-menu'); }
function compareMenuOpen() {
  var el = compareMenuEl();
  return !!el && !el.classList.contains('hidden');
}
function compareMenuAvailable() {
  return !!(window.kakapoGit && typeof window.kakapoGit.compareMenu === 'function');
}

function compareMenuRows() {
  var el = compareMenuEl();
  if (!el) return [];
  var branches = document.getElementById('compare-menu-branches');
  var inBranches = branches && !branches.classList.contains('hidden');
  return Array.prototype.slice.call(el.querySelectorAll(inBranches ? '.compare-branch-item' : '.compare-menu-main .compare-menu-row:not(.hidden)'));
}

function compareMenuActiveRef() {
  return String((compareMenuState && compareMenuState.ref) || '');
}
function renderCompareMenu() {
  var el = compareMenuEl();
  if (!el || !compareMenuState) return;
  var data = compareMenuState;
  var against = document.getElementById('compare-menu-against');
  var activeRef = compareMenuActiveRef();
  if (against) against.textContent = activeRef ? t('compare.menu.against').replace('{ref}', activeRef) : '';
  var refEl = document.getElementById('compare-menu-ref');
  if (refEl) refEl.textContent = activeRef;
  var sinceRow = el.querySelector('.compare-menu-since');
  if (sinceRow) {
    var mark = data.readMark;
    sinceRow.classList.toggle('hidden', !mark);
    var sinceNote = document.getElementById('compare-menu-since-note');
    if (sinceNote) sinceNote.textContent = mark ? t('compare.menu.sinceNote', { n: mark.commits }) : '';
  }
  el.querySelectorAll('.compare-menu-row[data-mode]').forEach(function (row) {
    var on = row.getAttribute('data-mode') === data.mode;
    row.classList.toggle('active', on);
    row.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  renderCompareBranchList();
}

// 'local', or the name of the remote the ref belongs to.
//
// Against the repository's actual remote list, never against the slash. The first version of this read
// everything before the first slash as a remote, which made `feature/dropdown` — a local branch, and the
// way most branches are named — a remote called "feature". The main process enumerates refs/heads and
// refs/remotes separately and then flattens the two into one list, so the distinction has to be carried
// over (compareMenuState.remotes) rather than recovered from the string, which cannot hold it.
function branchScopeOf(name) {
  var remotes = (compareMenuState && compareMenuState.remotes) || [];
  for (var i = 0; i < remotes.length; i += 1) {
    if (name.indexOf(remotes[i] + '/') === 0) return remotes[i];
  }
  return 'local';
}

function compareBranchScopes() {
  var seen = {};
  var out = [];
  (compareMenuState && compareMenuState.branches || []).forEach(function (name) {
    var scope = branchScopeOf(name);
    if (seen[scope]) { seen[scope].count += 1; return; }
    seen[scope] = { name: scope, count: 1 };
    out.push(seen[scope]);
  });
  return out.sort(function (a, b) {
    if (a.name === 'local') return -1;
    if (b.name === 'local') return 1;
    return 0;
  });
}

function compareScopeLabel(scope) {
  return scope === 'local' ? t('compare.menu.scopeLocal') : scope;
}

function renderCompareScopeRows(list, scopes) {
  list.innerHTML = scopes.map(function (scope) {
    return '<button type="button" class="compare-branch-item compare-branch-scope" role="option"'
      + ' aria-selected="false" data-scope="' + escapeHtml(scope.name) + '">'
      + '<span class="compare-branch-name">' + escapeHtml(compareScopeLabel(scope.name)) + '</span>'
      + '<span class="compare-branch-note">' + escapeHtml(t('compare.menu.scopeCount', { n: scope.count })) + '</span>'
      + '<span class="compare-menu-chevron" aria-hidden="true">\u203a</span>'
      + '</button>';
  }).join('');
}

function renderCompareBranchList() {
  var list = document.getElementById('compare-branch-list');
  if (!list || !compareMenuState) return;
  var needle = compareMenuBranchFilter.toLowerCase();
  var activeRef = compareMenuActiveRef();
  var scopes = compareBranchScopes();
  if (!needle && compareMenuBranchScope === null && scopes.length > 1) {
    renderCompareScopeRows(list, scopes);
    return;
  }
  var branches = (compareMenuState.branches || []).filter(function (name) {
    if (needle) return name.toLowerCase().indexOf(needle) >= 0;
    if (compareMenuBranchScope === null) return true;
    return branchScopeOf(name) === compareMenuBranchScope;
  });
  if (!branches.length) {
    list.innerHTML = '<div class="compare-branch-empty">' + escapeHtml(t('compare.menu.noBranch')) + '</div>';
    return;
  }
  var back = !needle && compareMenuBranchScope !== null && scopes.length > 1
    ? '<button type="button" class="compare-branch-item compare-branch-back" role="option" aria-selected="false" data-back="1">'
      + '<span class="compare-menu-chevron" aria-hidden="true">\u2039</span>'
      + '<span class="compare-branch-name">' + escapeHtml(t('compare.menu.scopeBack', { scope: compareScopeLabel(compareMenuBranchScope) })) + '</span>'
      + '</button>'
    : '';
  list.innerHTML = back + branches.map(function (name) {
    var current = !!activeRef && name === activeRef;
    var note = name === compareMenuState.defaultRef ? '<span class="compare-branch-note">' + escapeHtml(t('compare.menu.default')) + '</span>' : '';
    return '<button type="button" class="compare-branch-item' + (current ? ' active' : '') + '" role="option"'
      + ' aria-selected="' + (current ? 'true' : 'false') + '" data-ref="' + escapeHtml(name) + '">'
      + '<span class="compare-branch-name">' + escapeHtml(name) + '</span>'
      + note
      + '<span class="compare-menu-check" aria-hidden="true"></span>'
      + '</button>';
  }).join('');
}

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
  compareMenuBranchScope = null;
  var search = document.getElementById('compare-branch-search');
  if (search) { search.value = ''; setTimeout(function () { search.focus(); }, 0); }
  renderCompareBranchList();
  positionCompareMenu();
}

function enterCompareBranchScope(scope) {
  compareMenuBranchScope = scope;
  compareMenuBranchFilter = '';
  var search = document.getElementById('compare-branch-search');
  if (search) { search.value = ''; search.focus(); }
  renderCompareBranchList();
  positionCompareMenu();
}

function closeCompareMenu() {
  var el = compareMenuEl();
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

function announceCompareMode(settled, ref) {
  var against = (settled === 'all' || settled === 'tip') ? (ref || '') : '';
  showToast(t('compare.menu.' + settled)
    + (against ? ' · ' + t('compare.menu.against').replace('{ref}', against) : ''));
}
function applyCompareMode(mode, ref, announce) {
  if (!window.kakapoGit || typeof window.kakapoGit.setCompareMode !== 'function') return;
  if (mode === 'since' && !(compareMenuState && compareMenuState.readMark)) {
    closeCompareMenu();
    showToast(t('compare.menu.sinceNone'));
    return;
  }
  var sameRef = !ref || (compareMenuState && compareMenuState.ref === ref && compareMenuState.pinned);
  if (compareMenuState && compareMenuState.mode === mode && sameRef) {
    closeCompareMenu();
    if (announce) announceCompareMode(mode, compareMenuState.ref);
    return;
  }
  requestDiffViewOnNextCompare();
  var previous = compareMenuState
    ? { mode: compareMenuState.mode, ref: compareMenuState.ref, pinned: compareMenuState.pinned }
    : null;
  var restore = function () {
    cancelDiffViewOnNextCompare();
    if (!compareMenuState || !previous) return;
    compareMenuState.mode = previous.mode;
    compareMenuState.ref = previous.ref;
    compareMenuState.pinned = previous.pinned;
    renderCompareMenu();
  };
  if (compareMenuState) {
    compareMenuState.mode = mode;
    if (ref) { compareMenuState.ref = ref; compareMenuState.pinned = true; }
    renderCompareMenu();
  }
  closeCompareMenu();
  Promise.resolve(window.kakapoGit.setCompareMode(mode, ref)).then(function (res) {
    if (res && res.ok && compareMenuState) {
      compareMenuState.mode = res.mode || mode;
      compareMenuState.ref = res.ref || compareMenuState.ref;
      if (ref) compareMenuState.pinned = true;
      renderCompareMenu();
    } else if (res && res.error === 'no-read-mark') {
      restore();
      showToast(t('compare.menu.sinceNone'));
    } else if (!res || !res.ok) {
      restore();
    }
    if (!announce || !pageAlive()) return;
    if (!res || !res.ok) return;
    announceCompareMode(res.mode || mode, res.ref);
  }).catch(restore);
}

function pickCompareMode(mode) {
  if (!compareMenuAvailable()) return;
  if (!compareMenuState) {
    refreshCompareMenu().then(function () { applyCompareMode(mode, undefined, true); });
    return;
  }
  applyCompareMode(mode, undefined, true);
}

function openCompareBranchPicker() {
  if (!compareMenuAvailable()) return;
  if (!compareMenuOpen()) openCompareMenu();
  if (compareMenuState) showCompareBranchPanel(true);
  else refreshCompareMenu().then(function () { if (compareMenuOpen()) showCompareBranchPanel(true); });
}

function handleCompareMenuKey(event) {
  if (!compareMenuOpen()) return false;
  if (event.key === 'Escape') {
    event.preventDefault();
    var panel = document.getElementById('compare-menu-branches');
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
  if (event.key === 'Enter' && document.activeElement && document.activeElement.id === 'compare-branch-search') {
    var first = document.querySelector('.compare-branch-item[data-ref]');
    if (first) { event.preventDefault(); applyCompareMode('all', first.getAttribute('data-ref')); }
    return true;
  }
  return false;
}

function initCompareMenu() {
  document.addEventListener('click', function (event) {
    var closest = event.target.closest;
    if (!closest) return;
    if (event.target.closest('#compare-pill')) {
      event.preventDefault();
      if (compareMenuOpen()) closeCompareMenu(); else openCompareMenu();
      return;
    }
    var scopeRow = event.target.closest('.compare-branch-item[data-scope]');
    if (scopeRow) { enterCompareBranchScope(scopeRow.getAttribute('data-scope')); return; }
    if (event.target.closest('.compare-branch-item[data-back]')) { enterCompareBranchScope(null); return; }
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
  if (compareMenuEl() && window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function') {
    window.kakapoMenu.onDiffUpdate(function () { if (compareMenuState) refreshCompareMenu(); });
  }
}

if (typeof window !== 'undefined') {
  window.__kakapoCompareMenu = { open: openCompareMenu, close: closeCompareMenu, pick: pickCompareMode, branches: openCompareBranchPicker, refresh: refreshCompareMenu };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initCompareMenu);
  else initCompareMenu();
}
