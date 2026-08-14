// ===== Patch-set compare bar: numbered patch-set buttons, base-left / target-right (issue #11). =====
// Each patch set is a numbered button (1..N, oldest→newest); hovering shows its commit message. The base
// group sits on the left, the target group on the right, matching the side-by-side diff (old | new). Base
// also offers "All" (the branch point) and target offers "WT" (working tree · latest) in the normal local
// case; a range opened from Cmd+9 lists only that range's own commits on both sides. Selecting refreshes
// the diff via kakapo:diff-update. Electron only — window.kakapoGit is absent in browser/serve.

var patchSetData = null; // last { activeBase, activeTarget, branchPoint, upstream, head, commits[], scoped }

function patchSetBarEl() { return document.getElementById('patchset-bar'); }

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
  try { return d.toLocaleDateString(undefined, opts); } catch (e) { return iso.slice(0, 10); }
}
function patchSetCommitTitle(index, c) {
  var meta = c.shortSha + (c.date ? ' · ' + patchSetShortDate(c.date) : '');
  return (index + 1) + '. ' + c.subject + '  (' + meta + ')';
}

// Option list for each side: [{ ref, label, title, wide, active }].
function patchSetBaseOptions(data) {
  var opts = [];
  var active = data.activeBase || 'auto';
  if (!data.scoped && data.branchPoint) {
    opts.push({
      ref: data.branchPoint.sha, label: t('patchset.allShort'), wide: true,
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

function patchSetNumButton(which, opt) {
  return '<button type="button" class="patchset-num' + (opt.active ? ' active' : '') + (opt.wide ? ' patchset-num-wide' : '') + '"'
    + ' data-which="' + which + '" data-ref="' + escapeHtml(opt.ref) + '" title="' + escapeHtml(opt.title) + '"'
    + ' aria-pressed="' + (opt.active ? 'true' : 'false') + '">' + escapeHtml(opt.label) + '</button>';
}

// Fill both groups. Hidden when there are no patch sets to pick and no active A→B compare.
function renderPatchSetBar() {
  var bar = patchSetBarEl();
  if (!bar) return;
  var inCompare = !!patchSetData && (patchSetData.activeTarget || 'worktree') !== 'worktree';
  if (!patchSetData || (!patchSetData.commits.length && !inCompare)) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  var baseWrap = document.getElementById('patchset-base-nums');
  var targetWrap = document.getElementById('patchset-target-nums');
  if (baseWrap) baseWrap.innerHTML = patchSetBaseOptions(patchSetData).map(function (o) { return patchSetNumButton('base', o); }).join('');
  if (targetWrap) targetWrap.innerHTML = patchSetTargetOptions(patchSetData).map(function (o) { return patchSetNumButton('target', o); }).join('');
  var reset = document.getElementById('patchset-reset');
  if (reset) reset.classList.toggle('hidden', !inCompare);
}

// Switch base or target, then refresh the bar. The diff repaints via kakapo:diff-update.
function selectPatchSet(which, ref) {
  if (!window.kakapoGit || !ref) return;
  requestDiffViewOnNextCompare();
  // In a Cmd+9-opened range, both sides are commits in the scope; set them together so B..D shows.
  if (patchSetData && patchSetData.scoped && typeof window.kakapoGit.setReviewCompare === 'function') {
    var base = which === 'base' ? ref : patchSetData.activeBase;
    var target = which === 'target' ? ref : patchSetData.activeTarget;
    if (base === patchSetData.activeBase && target === patchSetData.activeTarget) return;
    Promise.resolve(window.kakapoGit.setReviewCompare(base, target)).then(function (res) {
      if (res && res.ok && patchSetData) { patchSetData.activeBase = res.activeBase || base; patchSetData.activeTarget = res.activeTarget || target; renderPatchSetBar(); }
    }).catch(function () {});
    return;
  }
  if (which === 'target') {
    if (typeof window.kakapoGit.setReviewTarget !== 'function') return;
    if (patchSetData && (patchSetData.activeTarget || 'worktree') === ref) return;
    Promise.resolve(window.kakapoGit.setReviewTarget(ref)).then(function (res) {
      if (res && res.ok && patchSetData) { patchSetData.activeTarget = res.activeTarget || ref; renderPatchSetBar(); }
    }).catch(function () {});
  } else {
    if (typeof window.kakapoGit.setReviewBase !== 'function') return;
    if (patchSetData && (patchSetData.activeBase || 'auto') === ref) return;
    Promise.resolve(window.kakapoGit.setReviewBase(ref)).then(function (res) {
      if (res && res.ok && patchSetData) { patchSetData.activeBase = res.activeBase || ref; renderPatchSetBar(); }
    }).catch(function () {});
  }
}

function refreshPatchSets() {
  if (!window.kakapoGit || typeof window.kakapoGit.patchSets !== 'function') return;
  Promise.resolve(window.kakapoGit.patchSets()).then(function (data) {
    patchSetData = (data && Array.isArray(data.commits)) ? data : null;
    renderPatchSetBar();
  }).catch(function () { patchSetData = null; renderPatchSetBar(); });
}

function initPatchSetBar() {
  var bar = patchSetBarEl();
  if (!bar || !window.kakapoGit) return; // browser/serve mode, or bar not present
  bar.addEventListener('click', function (e) {
    var num = e.target.closest && e.target.closest('.patchset-num[data-ref]');
    if (num) { selectPatchSet(num.getAttribute('data-which'), num.getAttribute('data-ref')); return; }
    if (e.target.closest && e.target.closest('#patchset-reset')) {
      if (typeof window.kakapoGit.setReviewCompare !== 'function') return;
      requestDiffViewOnNextCompare();
      Promise.resolve(window.kakapoGit.setReviewCompare('auto', 'worktree')).then(function () { refreshPatchSets(); }).catch(function () {});
    }
  });
  if (window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function') {
    window.kakapoMenu.onDiffUpdate(function () { try { refreshPatchSets(); } catch (err) {} });
  }
  refreshPatchSets();
}

if (typeof window !== 'undefined') {
  window.__kakapoPatchSet = { refresh: refreshPatchSets };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPatchSetBar);
  } else {
    initPatchSetBar();
  }
}
