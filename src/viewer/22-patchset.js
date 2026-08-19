// ===== Patch-set compare bar: numbered patch-set buttons, base-left / target-right (issue #11). =====
// Each patch set is a numbered button (1..N, oldest→newest); hovering shows its commit message. The base
// group sits on the left, the target group on the right, matching the side-by-side diff (old | new). Base
// also offers "All" (the branch point) and target offers "WT" (working tree · latest) in the normal local
// case; a range opened from Cmd+9 lists only that range's own commits on both sides. Selecting refreshes
// the diff via kakapo:diff-update. Electron only — window.kakapoGit is absent in browser/serve.

var patchSetData = null; // last { activeBase, activeTarget, branchPoint, upstream, head, commits[], scoped }

function patchSetBarEl() { return document.getElementById('patchset-bar'); }

// What the diff toolbar's breadcrumb leads with while the review is pointed at commits rather than at the
// working tree. Returns null in the ordinary case, which is what keeps the toolbar quiet when nothing needs
// saying — the whole point of marking this state is lost if it marks every state.
//
// A single commit has a subject and that is the best thing to call it. A RANGE has no subject: naming it
// after one of its commits promotes that commit over the others, and across unrelated work the line at the
// top of the screen would be half a lie. So the newest commit's subject leads and the rest are counted, which
// is honest about which one the words came from. Narrowing the range down to one commit drops the count on
// its own — one rule, both ends of it: name it when there is exactly one to name, otherwise count.
function compareCommitLead() {
  var data = patchSetData;
  if (!data || !data.scoped || !Array.isArray(data.commits) || !data.commits.length) return null;
  var target = data.activeTarget;
  if (!target || target === 'worktree') return null; // the right side is the working tree — nothing committed to name
  var at = -1, baseAt = -1;
  for (var i = 0; i < data.commits.length; i++) {
    if (data.commits[i].sha === target) at = i;
    if (data.commits[i].sha === data.activeBase) baseAt = i;
  }
  if (at < 0) return null;
  var newest = data.commits[at];
  // commits are oldest → newest, and the base is the commit BEFORE the first one shown, so the span is the
  // half-open (base, target]. An unknown base (auto, a branch point outside this scope) counts as one.
  var span = baseAt >= 0 && baseAt < at ? at - baseAt : 1;
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

// Thirty-three patch sets wrapped the bar onto a second row and every number stopped being findable — the
// list had become a wall rather than a control. Show a window instead: the two at each end, the one you are
// on with its neighbours, and an ellipsis for each run that was left out. Seven numbers, whatever the branch
// length, and the ends stay reachable in one click because "the beginning" and "HEAD" are the two places a
// reviewer jumps to blind.
// The wide entries ("All" / "WT") are not patch sets and never fold away — they are the exits.
var PATCHSET_EDGE = 2;   // how many at each end
var PATCHSET_AROUND = 1; // how many either side of the active one
function patchSetWindow(opts) {
  var numbers = opts.filter(function (o) { return !o.wide; });
  if (numbers.length <= PATCHSET_EDGE * 2 + PATCHSET_AROUND * 2 + 1) return opts;
  var at = -1;
  for (var i = 0; i < numbers.length; i++) if (numbers[i].active) at = i;
  // Nothing active on this side (base is "All", target is the working tree): the ends are all there is to say.
  var keep = {};
  for (var e = 0; e < PATCHSET_EDGE; e++) { keep[e] = true; keep[numbers.length - 1 - e] = true; }
  if (at >= 0) for (var d = -PATCHSET_AROUND; d <= PATCHSET_AROUND; d++) {
    var k = at + d;
    if (k >= 0 && k < numbers.length) keep[k] = true;
  }
  var out = [], gap = false;
  numbers.forEach(function (o, index) {
    if (keep[index]) { out.push(o); gap = false; return; }
    if (!gap) { out.push({ ellipsis: true, from: index }); gap = true; }
  });
  // Put the wide exits back where they were: base leads with "All", target ends with "WT".
  var lead = opts.filter(function (o) { return o.wide && opts.indexOf(o) === 0; });
  var tail = opts.filter(function (o) { return o.wide && opts.indexOf(o) !== 0; });
  return lead.concat(out, tail);
}

function patchSetNumButton(which, opt) {
  // A fold is not a control: it says how many were left out and answers a hover, nothing more. Clicking it
  // would have to guess which of the hidden commits you meant.
  if (opt.ellipsis) return '<span class="patchset-gap" aria-hidden="true">…</span>';
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
  if (baseWrap) baseWrap.innerHTML = patchSetWindow(patchSetBaseOptions(patchSetData)).map(function (o) { return patchSetNumButton('base', o); }).join('');
  if (targetWrap) targetWrap.innerHTML = patchSetWindow(patchSetTargetOptions(patchSetData)).map(function (o) { return patchSetNumButton('target', o); }).join('');
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
