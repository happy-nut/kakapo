// ===== Patch-set compare bar: pick base (A) and target (B) to compare (issue #11). =====
// Left dropdown picks the base; right dropdown picks the target — a patch set, or "Working tree · latest"
// (the default, = today's base-vs-working-tree). Data comes from window.kakapoGit.patchSets(); selecting
// calls setReviewBase / setReviewTarget and the resulting in-place kakapo:diff-update repaints the diff.
// Electron only — the bar markup is gated on input.app and window.kakapoGit is absent in browser/serve.

var patchSetData = null; // last { activeBase, activeTarget, branchPoint, upstream, head, commits[] }
var patchSetPopoverWhich = null; // null | 'base' | 'target' — which dropdown the popover is open for

function patchSetBarEl() { return document.getElementById('patchset-bar'); }
function patchSetBaseBtn() { return document.getElementById('patchset-base-btn'); }
function patchSetTargetBtn() { return document.getElementById('patchset-target-btn'); }

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
function patchSetCommitBySha(data, sha) {
  for (var i = 0; i < data.commits.length; i++) if (data.commits[i].sha === sha) return { commit: data.commits[i], index: i };
  return null;
}

// Button labels for the two active selections.
function patchSetBaseLabel(data) {
  var active = data.activeBase || 'auto';
  if (active === 'auto') return data.branchPoint ? patchSetShortRef(data.branchPoint.label) : 'HEAD';
  if (data.branchPoint && active === data.branchPoint.sha) return patchSetShortRef(data.branchPoint.label);
  var hit = patchSetCommitBySha(data, active);
  return hit ? hit.commit.shortSha : patchSetShortRef(active);
}
function patchSetTargetLabel(data) {
  var active = data.activeTarget || 'worktree';
  if (active === 'worktree') return t('patchset.workingTree');
  var hit = patchSetCommitBySha(data, active);
  return hit ? hit.commit.shortSha : patchSetShortRef(active);
}

// Refresh both button faces. Hidden when the branch has no patch sets ahead (nothing to compare).
function renderPatchSetBar() {
  var bar = patchSetBarEl();
  if (!bar) return;
  // Show whenever there are patch sets to pick, OR the review is in an A→B compare (target set — e.g. a range
  // opened from the Cmd+9 history), so the reviewer always sees what's being compared and can exit.
  var inCompare = !!patchSetData && (patchSetData.activeTarget || 'worktree') !== 'worktree';
  if (!patchSetData || (!patchSetData.commits.length && !inCompare)) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  var b = document.getElementById('patchset-current');
  if (b) b.textContent = patchSetBaseLabel(patchSetData);
  var tg = document.getElementById('patchset-target-current');
  if (tg) tg.textContent = patchSetTargetLabel(patchSetData);
  var reset = document.getElementById('patchset-reset');
  if (reset) reset.classList.toggle('hidden', !inCompare); // exit-compare only shown while comparing A→B
}

function patchSetRow(ref, title, meta, active) {
  return '<button type="button" class="patchset-option' + (active ? ' active' : '') + '" role="option"'
    + ' aria-selected="' + (active ? 'true' : 'false') + '" data-ref="' + escapeHtml(ref) + '">'
    + '<span class="patchset-option-check" aria-hidden="true">' + (active ? '✓' : '') + '</span>'
    + '<span class="patchset-option-body">'
    + '<span class="patchset-option-title">' + escapeHtml(title) + '</span>'
    + (meta ? '<span class="patchset-option-meta">' + escapeHtml(meta) + '</span>' : '')
    + '</span></button>';
}
function patchSetCommitRow(data, index, activeRef) {
  var c = data.commits[index];
  var title = t('patchset.set') + ' ' + (index + 1) + ' · ' + c.subject;
  var meta = c.shortSha + (c.date ? ' · ' + patchSetShortDate(c.date) : '');
  return patchSetRow(c.sha, title, meta, c.sha === activeRef);
}

function renderPatchSetPopover() {
  var pop = document.getElementById('patchset-popover');
  if (!pop || !patchSetData) return;
  var rows = [];
  var i;
  if (patchSetPopoverWhich === 'target') {
    var at = patchSetData.activeTarget || 'worktree';
    rows.push(patchSetRow('worktree', t('patchset.workingTree'), t('patchset.latest'), at === 'worktree'));
    for (i = 0; i < patchSetData.commits.length; i++) rows.push(patchSetCommitRow(patchSetData, i, at));
  } else {
    var ab = patchSetData.activeBase || 'auto';
    if (patchSetData.branchPoint) {
      var allRef = patchSetData.branchPoint.sha;
      var allMeta = t('patchset.branchPoint') + ' · ' + patchSetShortRef(patchSetData.branchPoint.label);
      rows.push(patchSetRow(allRef, t('patchset.allChanges'), allMeta, ab === allRef));
    }
    for (i = 0; i < patchSetData.commits.length; i++) rows.push(patchSetCommitRow(patchSetData, i, ab));
  }
  pop.innerHTML = rows.join('');
}

function patchSetActiveBtn() { return patchSetPopoverWhich === 'target' ? patchSetTargetBtn() : patchSetBaseBtn(); }

function positionPatchSetPopover() {
  var pop = document.getElementById('patchset-popover');
  var btn = patchSetActiveBtn();
  if (!pop || !btn) return;
  var r = btn.getBoundingClientRect();
  pop.style.top = Math.round(r.bottom + 4) + 'px';
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.minWidth = Math.round(r.width) + 'px';
}

function closePatchSetPopover() {
  var pop = document.getElementById('patchset-popover');
  if (pop) pop.classList.add('hidden');
  var b = patchSetBaseBtn(); if (b) b.setAttribute('aria-expanded', 'false');
  var tg = patchSetTargetBtn(); if (tg) tg.setAttribute('aria-expanded', 'false');
  patchSetPopoverWhich = null;
}

function openPatchSetPopover(which) {
  if (!patchSetData) return;
  patchSetPopoverWhich = which;
  var pop = document.getElementById('patchset-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'patchset-popover';
    pop.className = 'patchset-popover hidden';
    pop.setAttribute('role', 'listbox');
    document.body.appendChild(pop);
    pop.addEventListener('click', function (e) {
      var opt = e.target.closest ? e.target.closest('.patchset-option') : null;
      if (!opt) return;
      var ref = opt.getAttribute('data-ref');
      var which = patchSetPopoverWhich;
      closePatchSetPopover();
      if (ref) selectPatchSet(which, ref);
    });
  }
  renderPatchSetPopover();
  pop.classList.remove('hidden');
  positionPatchSetPopover();
  var btn = patchSetActiveBtn();
  if (btn) btn.setAttribute('aria-expanded', 'true');
}

function togglePatchSetPopover(which) {
  if (patchSetPopoverWhich === which) closePatchSetPopover(); else openPatchSetPopover(which);
}

// Ask main to switch the base or target, then refresh the bar face. The diff repaints via kakapo:diff-update.
function selectPatchSet(which, ref) {
  if (!window.kakapoGit) return;
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
    if (patchSetPopoverWhich) { renderPatchSetPopover(); positionPatchSetPopover(); }
  }).catch(function () { patchSetData = null; renderPatchSetBar(); });
}

function initPatchSetBar() {
  var baseBtn = patchSetBaseBtn();
  var targetBtn = patchSetTargetBtn();
  if ((!baseBtn && !targetBtn) || !window.kakapoGit) return; // browser/serve mode, or bar not present
  if (baseBtn) baseBtn.addEventListener('click', function (e) { e.stopPropagation(); togglePatchSetPopover('base'); });
  if (targetBtn) targetBtn.addEventListener('click', function (e) { e.stopPropagation(); togglePatchSetPopover('target'); });
  var resetBtn = document.getElementById('patchset-reset');
  if (resetBtn) resetBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!window.kakapoGit || typeof window.kakapoGit.setReviewCompare !== 'function') return;
    Promise.resolve(window.kakapoGit.setReviewCompare('auto', 'worktree')).then(function () { refreshPatchSets(); }).catch(function () {});
  });
  document.addEventListener('click', function (e) {
    if (!patchSetPopoverWhich) return;
    var pop = document.getElementById('patchset-popover');
    if (pop && pop.contains(e.target)) return;
    if (baseBtn && baseBtn.contains(e.target)) return;
    if (targetBtn && targetBtn.contains(e.target)) return;
    closePatchSetPopover();
  });
  document.addEventListener('keydown', function (e) {
    if (patchSetPopoverWhich && (e.key === 'Escape' || e.key === 'Esc')) closePatchSetPopover();
  });
  window.addEventListener('resize', function () { if (patchSetPopoverWhich) positionPatchSetPopover(); });
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
