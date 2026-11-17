
var patchSetData = null;

function patchSetBarEl() { return document.getElementById('patchset-bar'); }

function compareCommitLead() {
  var data = patchSetData;
  if (!data || !data.scoped || !Array.isArray(data.commits) || !data.commits.length) return null;
  var target = data.activeTarget;
  if (!target || target === 'worktree') return null;
  var at = -1, baseAt = -1;
  for (var i = 0; i < data.commits.length; i++) {
    if (data.commits[i].sha === target) at = i;
    if (data.commits[i].sha === data.activeBase) baseAt = i;
  }
  if (at < 0) return null;
  var newest = data.commits[at];
  var span = data.activeBase === EMPTY_TREE_SHA ? at + 1
    : baseAt >= 0 && baseAt < at ? at - baseAt
      : 1;
  return { sha: newest.shortSha || String(newest.sha).slice(0, 7), subject: newest.subject || '', others: Math.max(0, span - 1) };
}

function patchSetShortRef(ref) {
  if (!ref) return '';
  var trimmed = String(ref).replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
  return trimmed.length > 28 ? trimmed.slice(0, 27) + '…' : trimmed;
}
function patchSetShortDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  var now = new Date();
  var opts = d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' };
  try { return d.toLocaleDateString(locale, opts); } catch (e) { return iso.slice(0, 10); }
}
function patchSetCommitTitle(index, c) {
  var meta = c.shortSha + (c.date ? ' · ' + patchSetShortDate(c.date) : '');
  return (index + 1) + '. ' + c.subject + '  (' + meta + ')';
}

function patchSetBaseOptions(data) {
  var opts = [];
  var active = data.activeBase || 'auto';
  if (data.scoped && active === EMPTY_TREE_SHA) {
    opts.push({ ref: EMPTY_TREE_SHA, label: t('history.emptyTree'), wide: true, title: t('history.emptyTree'), active: true });
  }
  if (!data.scoped && data.branchPoint) {
    opts.push({
      ref: 'auto', label: t('patchset.allShort'), wide: true,
      title: t('patchset.allChanges') + ' · ' + patchSetShortRef(data.branchPoint.label),
      active: active === 'auto' || active === data.branchPoint.sha,
    });
  }
  for (var i = 0; i < data.commits.length; i++) {
    var c = data.commits[i];
    opts.push({ ref: c.sha, label: String(i + 1), title: patchSetCommitTitle(i, c), active: c.sha === active });
  }
  return opts;
}
function patchSetTargetOptions(data) {
  var opts = [];
  var active = data.activeTarget || 'worktree';
  for (var i = 0; i < data.commits.length; i++) {
    var c = data.commits[i];
    opts.push({ ref: c.sha, label: String(i + 1), title: patchSetCommitTitle(i, c), active: c.sha === active });
  }
  if (!data.scoped) {
    opts.push({
      ref: 'worktree', label: t('patchset.workingTreeShort'), wide: true,
      title: t('patchset.workingTree') + ' · ' + t('patchset.latest'), active: active === 'worktree',
    });
  }
  return opts;
}

var PATCHSET_EDGE = 2;
var PATCHSET_AROUND = 1;
var patchSetExpanded = { base: false, target: false };
function patchSetWindow(opts, which) {
  var numbers = opts.filter(function (o) { return !o.wide; });
  if (patchSetExpanded[which]) return opts;
  if (numbers.length <= PATCHSET_EDGE * 2 + PATCHSET_AROUND * 2 + 1) return opts;
  var at = -1;
  for (var i = 0; i < numbers.length; i++) if (numbers[i].active) at = i;
  var keep = {};
  for (var e = 0; e < PATCHSET_EDGE; e++) { keep[e] = true; keep[numbers.length - 1 - e] = true; }
  if (at >= 0) for (var d = -PATCHSET_AROUND; d <= PATCHSET_AROUND; d++) {
    var k = at + d;
    if (k >= 0 && k < numbers.length) keep[k] = true;
  }
  var out = [], gap = false;
  numbers.forEach(function (o, index) {
    if (keep[index]) { out.push(o); gap = false; return; }
    if (!gap) { out.push({ ellipsis: true, from: index, hidden: 0 }); gap = true; }
    if (gap) out[out.length - 1].hidden += 1;
  });
  var lead = opts.filter(function (o) { return o.wide && opts.indexOf(o) === 0; });
  var tail = opts.filter(function (o) { return o.wide && opts.indexOf(o) !== 0; });
  return lead.concat(out, tail);
}

function patchSetShowAllLabel(opt) {
  var n = opt.hidden || 0;
  return t('patchset.showAll', { n: n });
}
function patchSetNumButton(which, opt) {
  if (opt.ellipsis) {
    return '<button type="button" class="patchset-gap" data-expand="' + which + '"'
      + ' title="' + escapeHtml(patchSetShowAllLabel(opt)) + '"'
      + ' aria-label="' + escapeHtml(patchSetShowAllLabel(opt)) + '">'
      + escapeHtml(String(opt.hidden || 0)) + '…</button>';
  }
  return '<button type="button" class="patchset-num' + (opt.active ? ' active' : '') + (opt.wide ? ' patchset-num-wide' : '') + '"'
    + ' data-which="' + which + '" data-ref="' + escapeHtml(opt.ref) + '" title="' + escapeHtml(opt.title) + '"'
    + ' aria-pressed="' + (opt.active ? 'true' : 'false') + '">' + escapeHtml(opt.label) + '</button>';
}

function stepPatchSet(delta) {
  var bar = patchSetBarEl();
  if (!bar || bar.classList.contains('hidden') || !patchSetData) return false;
  var opts = patchSetBaseOptions(patchSetData);
  if (!opts.length) return false;
  var at = -1;
  for (var i = 0; i < opts.length; i += 1) if (opts[i].active) { at = i; break; }
  var next = at < 0 ? (delta > 0 ? 0 : opts.length - 1) : at + delta;
  if (next < 0 || next >= opts.length) {
    showCaretHint(t(delta > 0 ? 'patchset.atLast' : 'patchset.atFirst'));
    return true;
  }
  selectPatchSet('base', opts[next].ref);
  return true;
}

function renderPatchSetBar() {
  var bar = patchSetBarEl();
  if (!bar) return;
  var inCompare = !!patchSetData && (patchSetData.activeTarget || 'worktree') !== 'worktree';
  if (!patchSetData || (!patchSetData.commits.length && !inCompare)) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  var baseWrap = document.getElementById('patchset-base-nums');
  var targetWrap = document.getElementById('patchset-target-nums');
  if (baseWrap) {
    baseWrap.innerHTML = patchSetWindow(patchSetBaseOptions(patchSetData), 'base').map(function (o) { return patchSetNumButton('base', o); }).join('');
    baseWrap.classList.toggle('is-expanded', patchSetExpanded.base);
  }
  if (targetWrap) {
    targetWrap.innerHTML = patchSetWindow(patchSetTargetOptions(patchSetData), 'target').map(function (o) { return patchSetNumButton('target', o); }).join('');
    targetWrap.classList.toggle('is-expanded', patchSetExpanded.target);
  }
  var reset = document.getElementById('patchset-reset');
  if (reset) reset.classList.toggle('hidden', !inCompare);
  renderPatchSetSummary();
}

function patchSetSideLabel(opts, active) {
  for (var i = 0; i < opts.length; i++) {
    if (!opts[i].active) continue;
    return String(opts[i].title || opts[i].label).replace(/^\d+\.\s*/, '');
  }
  var ref = String(active || '');
  if (!ref) return '';
  if (ref === 'worktree') return t('patchset.latest');
  if (ref === 'HEAD') return t('patchset.workingTree');
  return patchSetShortRef(ref);
}
function renderPatchSetSummary() {
  var el = document.getElementById('patchset-summary');
  if (!el) return;
  if (!patchSetData) { el.textContent = ''; return; }
  var base = patchSetSideLabel(patchSetBaseOptions(patchSetData), patchSetData.activeBase);
  var target = patchSetSideLabel(patchSetTargetOptions(patchSetData), patchSetData.activeTarget);
  el.textContent = (base && target) ? t('patchset.comparing').replace('{base}', base).replace('{target}', target) : '';
  el.title = el.textContent;
}

function selectPatchSet(which, ref) {
  if (!window.kakapoGit || !ref) return;
  if (patchSetData && patchSetData.scoped && typeof window.kakapoGit.setReviewCompare === 'function') {
    var base = which === 'base' ? ref : patchSetData.activeBase;
    var target = which === 'target' ? ref : patchSetData.activeTarget;
    if (base === patchSetData.activeBase && target === patchSetData.activeTarget) return;
    requestDiffViewOnNextCompare();
    Promise.resolve(window.kakapoGit.setReviewCompare(base, target)).then(function (res) {
      if (res && res.ok && patchSetData) { patchSetData.activeBase = res.activeBase || base; patchSetData.activeTarget = res.activeTarget || target; renderPatchSetBar(); syncDiffReviewChrome(); }
    }).catch(function () {});
    return;
  }
  if (which === 'target') {
    if (typeof window.kakapoGit.setReviewTarget !== 'function') return;
    if (patchSetData && (patchSetData.activeTarget || 'worktree') === ref) return;
    requestDiffViewOnNextCompare();
    Promise.resolve(window.kakapoGit.setReviewTarget(ref)).then(function (res) {
      if (res && res.ok && patchSetData) { patchSetData.activeTarget = res.activeTarget || ref; renderPatchSetBar(); syncDiffReviewChrome(); }
    }).catch(function () {});
  } else {
    var picked = patchSetData ? patchSetBaseOptions(patchSetData).filter(function (option) {
      return option.ref === ref;
    })[0] : null;
    if (picked && picked.active) return;
    if (ref === 'auto') { applyCompareMode('all', '', false); return; }
    if (typeof window.kakapoGit.setReviewBase !== 'function') return;
    requestDiffViewOnNextCompare();
    Promise.resolve(window.kakapoGit.setReviewBase(ref)).then(function (res) {
      if (res && res.ok && patchSetData) { patchSetData.activeBase = res.activeBase || ref; renderPatchSetBar(); syncDiffReviewChrome(); }
    }).catch(function () {});
  }
}

function refreshPatchSets() {
  if (!window.kakapoGit || typeof window.kakapoGit.patchSets !== 'function') return;
  var settle = function () { renderPatchSetBar(); syncDiffReviewChrome(); };
  Promise.resolve(window.kakapoGit.patchSets()).then(function (data) {
    patchSetData = (data && Array.isArray(data.commits)) ? data : null;
    settle();
  }).catch(function () { patchSetData = null; settle(); });
}

var patchSetLedgerData = null;

function patchSetLedgerEl() { return document.getElementById('patchset-ledger'); }
function patchSetLedgerOpen() {
  var el = patchSetLedgerEl();
  return !!el && !el.classList.contains('hidden');
}

function patchSetLedgerStat(stat) {
  if (!stat) return '';
  return '<span class="patchset-ledger-stat">'
    + escapeHtml(t('patchset.files', { n: stat.files })) + ' '
    + '<span class="ps-add">+' + escapeHtml(String(stat.added)) + '</span> '
    + '<span class="ps-del">−' + escapeHtml(String(stat.removed)) + '</span>'
    + '</span>';
}

function patchSetUnreadFrom(data) {
  if (!data || !data.readMark || !Array.isArray(data.commits)) return -1;
  for (var i = 0; i < data.commits.length; i += 1) if (data.commits[i].sha === data.readMark.sha) return i + 1;
  return -1;
}

function patchSetLedgerRow(opt, extra) {
  var cls = 'patchset-ledger-row' + (opt.active ? ' active' : '') + (extra && extra.cls ? ' ' + extra.cls : '');
  return '<button type="button" class="' + cls + '" role="option"'
    + ' aria-selected="' + (opt.active ? 'true' : 'false') + '"'
    + ' data-which="base" data-ref="' + escapeHtml(opt.ref) + '">'
    + '<span class="patchset-ledger-dot" aria-hidden="true"></span>'
    + '<span class="patchset-ledger-num">' + escapeHtml(extra && extra.num ? extra.num : '') + '</span>'
    + '<span class="patchset-ledger-subject">' + escapeHtml(opt.subject || opt.label) + '</span>'
    + (extra && extra.stat ? extra.stat : '<span class="patchset-ledger-stat"></span>')
    + '<span class="patchset-ledger-when">' + escapeHtml(extra && extra.when ? extra.when : '') + '</span>'
    + '</button>';
}

function renderPatchSetLedger() {
  var el = patchSetLedgerEl();
  if (!el) return;
  var data = patchSetLedgerData;
  if (!data || !Array.isArray(data.commits) || !data.commits.length) {
    el.innerHTML = '<div class="patchset-ledger-empty">' + escapeHtml(t('patchset.ledgerEmpty')) + '</div>';
    return;
  }
  var active = data.activeBase || 'auto';
  var stats = data.stats || {};
  var unreadFrom = patchSetUnreadFrom(data);
  var html = [];

  if (!data.scoped && data.branchPoint) {
    html.push(patchSetLedgerRow(
      { ref: 'auto', subject: t('patchset.allChanges') + ' · ' + patchSetShortRef(data.branchPoint.label),
        active: active === 'auto' || active === data.branchPoint.sha },
      { num: '' }));
    html.push('<div class="patchset-ledger-sep" role="presentation"></div>');
  }

  data.commits.forEach(function (c, i) {
    var unread = unreadFrom >= 0 && i >= unreadFrom;
    html.push(patchSetLedgerRow(
      { ref: c.sha, subject: c.subject, active: c.sha === active },
      {
        num: String(i + 1),
        stat: patchSetLedgerStat(stats[c.sha]),
        when: patchSetShortDate(c.date),
        cls: unreadFrom < 0 ? '' : (unread ? 'is-unread' : 'is-read'),
      }));
  });
  el.innerHTML = html.join('');
}

function closePatchSetLedger() {
  var el = patchSetLedgerEl();
  if (!el) return;
  var wasOpen = !el.classList.contains('hidden');
  el.classList.add('hidden');
  var btn = document.getElementById('patchset-ledger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  restoreOverlayFocus(el, wasOpen);
}

function openPatchSetLedger() {
  var el = patchSetLedgerEl();
  if (!el || !window.kakapoGit || typeof window.kakapoGit.patchSetLedger !== 'function') return;
  rememberOverlayFocus(el);
  el.classList.remove('hidden');
  var btn = document.getElementById('patchset-ledger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  renderPatchSetLedger();
  Promise.resolve(window.kakapoGit.patchSetLedger()).then(function (data) {
    if (!patchSetLedgerOpen()) return;
    patchSetLedgerData = (data && Array.isArray(data.commits)) ? data : null;
    renderPatchSetLedger();
    var rows = el.querySelectorAll('.patchset-ledger-row');
    var pick = el.querySelector('.patchset-ledger-row.is-unread') || el.querySelector('.patchset-ledger-row.active') || rows[0];
    if (pick) pick.focus();
  }).catch(function () {});
}

function togglePatchSetLedger() {
  if (patchSetLedgerOpen()) closePatchSetLedger(); else openPatchSetLedger();
}

function handlePatchSetLedgerKey(event) {
  if (!patchSetLedgerOpen()) return false;
  var el = patchSetLedgerEl();
  if (event.key === 'Escape') { event.preventDefault(); closePatchSetLedger(); return true; }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
  var rows = Array.prototype.slice.call(el.querySelectorAll('.patchset-ledger-row'));
  if (!rows.length) return false;
  var at = rows.indexOf(document.activeElement);
  var next = at < 0 ? 0 : at + (event.key === 'ArrowDown' ? 1 : -1);
  if (next < 0) next = rows.length - 1;
  if (next >= rows.length) next = 0;
  event.preventDefault();
  rows[next].focus();
  return true;
}

function initPatchSetBar() {
  var bar = patchSetBarEl();
  if (!bar || !window.kakapoGit) return;
  bar.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#patchset-ledger-btn')) { togglePatchSetLedger(); return; }
    var row = e.target.closest && e.target.closest('.patchset-ledger-row[data-ref]');
    if (row) { closePatchSetLedger(); selectPatchSet('base', row.getAttribute('data-ref')); return; }
    var gap = e.target.closest && e.target.closest('.patchset-gap[data-expand]');
    if (gap) { patchSetExpanded[gap.getAttribute('data-expand')] = true; renderPatchSetBar(); return; }
    var num = e.target.closest && e.target.closest('.patchset-num[data-ref]');
    if (num) { selectPatchSet(num.getAttribute('data-which'), num.getAttribute('data-ref')); return; }
    if (e.target.closest && e.target.closest('#patchset-reset')) {
      if (typeof window.kakapoGit.setReviewCompare !== 'function') return;
      requestDiffViewOnNextCompare();
      Promise.resolve(window.kakapoGit.setReviewCompare('auto', 'worktree')).then(function () { refreshPatchSets(); }).catch(function () {});
    }
  });
  bar.addEventListener('keydown', function (e) { handlePatchSetLedgerKey(e); });
  document.addEventListener('mousedown', function (e) {
    if (!patchSetLedgerOpen()) return;
    if (e.target.closest && e.target.closest('#patchset-ledger, #patchset-ledger-btn')) return;
    closePatchSetLedger();
  }, true);
  if (window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function') {
    window.kakapoMenu.onDiffUpdate(function () {
      try {
        refreshPatchSets();
        if (patchSetLedgerOpen()) openPatchSetLedger();
      } catch (err) {}
    });
  }
  refreshPatchSets();
}

if (typeof window !== 'undefined') {
  window.__kakapoPatchSet = { refresh: refreshPatchSets, openLedger: openPatchSetLedger, closeLedger: closePatchSetLedger };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPatchSetBar);
  } else {
    initPatchSetBar();
  }
}
