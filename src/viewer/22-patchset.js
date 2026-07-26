// ===== Patch-set compare bar: pick an earlier patch set as the diff base (issue #11). =====
// The right side of the review is always the working tree ("latest"); this bar only moves the base.
// Data comes from window.kakapoGit.patchSets(); selecting a row calls setReviewBase(ref), and the
// resulting in-place kakapo:diff-update repaints the diff (same path the watch loop uses). Electron only
// — the bar markup is gated on input.app and the bridge (window.kakapoGit) is absent in browser/serve.

var patchSetData = null; // last { activeBase, branchPoint, upstream, head, commits[] } from main
var patchSetPopoverOpen = false;

function patchSetBarEl() { return document.getElementById('patchset-bar'); }
function patchSetBtnEl() { return document.getElementById('patchset-base-btn'); }

// A compact one-line summary of the active base for the button face.
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
  var opts = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  try { return d.toLocaleDateString(undefined, opts); } catch (e) { return iso.slice(0, 10); }
}

// The label shown on the button for whatever base is currently active.
function patchSetActiveLabel(data) {
  var active = data.activeBase || 'auto';
  if (active === 'auto') return data.branchPoint ? patchSetShortRef(data.branchPoint.label) : 'HEAD';
  if (data.branchPoint && active === data.branchPoint.sha) return patchSetShortRef(data.branchPoint.label);
  for (var i = 0; i < data.commits.length; i++) {
    if (data.commits[i].sha === active) return data.commits[i].shortSha;
  }
  return patchSetShortRef(active); // a CLI --base ref that isn't one of the enumerated patch sets
}

// Refresh the bar face from the latest data. The bar only makes sense when the branch has at least one
// patch set ahead of its branch point; otherwise every option collapses to "vs HEAD", so hide it and
// leave today's plain working-tree-vs-HEAD review untouched.
function renderPatchSetBar() {
  var bar = patchSetBarEl();
  if (!bar) return;
  if (!patchSetData || !patchSetData.commits.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  var current = document.getElementById('patchset-current');
  if (current) current.textContent = patchSetActiveLabel(patchSetData);
}

// Build one selectable row. ref is what setReviewBase receives ("auto" or a commit SHA).
function patchSetRow(ref, title, meta, active) {
  return '<button type="button" class="patchset-option' + (active ? ' active' : '') + '" role="option"'
    + ' aria-selected="' + (active ? 'true' : 'false') + '" data-ref="' + escapeHtml(ref) + '">'
    + '<span class="patchset-option-check" aria-hidden="true">' + (active ? '✓' : '') + '</span>'
    + '<span class="patchset-option-body">'
    + '<span class="patchset-option-title">' + escapeHtml(title) + '</span>'
    + (meta ? '<span class="patchset-option-meta">' + escapeHtml(meta) + '</span>' : '')
    + '</span></button>';
}

function renderPatchSetPopover() {
  var pop = document.getElementById('patchset-popover');
  if (!pop || !patchSetData) return;
  var active = patchSetData.activeBase || 'auto';
  var rows = [];
  // "All changes" — diff the whole branch: branch point → latest working tree. Send the branch-point SHA
  // explicitly (not "auto"): the automatic base falls back to HEAD on a dirty tree or with no upstream,
  // which would hide the committed history. The branch point is resolvable in those cases too.
  if (patchSetData.branchPoint) {
    var allRef = patchSetData.branchPoint.sha;
    var allMeta = t('patchset.branchPoint') + ' · ' + patchSetShortRef(patchSetData.branchPoint.label);
    rows.push(patchSetRow(allRef, t('patchset.allChanges'), allMeta, active === allRef));
  }
  // Each commit ahead of the branch point = one patch set, oldest → newest. Selecting one shows
  // everything after it, up to the latest working tree.
  for (var i = 0; i < patchSetData.commits.length; i++) {
    var c = patchSetData.commits[i];
    var title = t('patchset.set') + ' ' + (i + 1) + ' · ' + c.subject;
    var meta = c.shortSha + (c.date ? ' · ' + patchSetShortDate(c.date) : '');
    rows.push(patchSetRow(c.sha, title, meta, c.sha === active));
  }
  pop.innerHTML = rows.join('');
}

function positionPatchSetPopover() {
  var pop = document.getElementById('patchset-popover');
  var btn = patchSetBtnEl();
  if (!pop || !btn) return;
  var r = btn.getBoundingClientRect();
  pop.style.top = Math.round(r.bottom + 4) + 'px';
  pop.style.left = Math.round(r.left) + 'px';
  pop.style.minWidth = Math.round(r.width) + 'px';
}

function closePatchSetPopover() {
  var pop = document.getElementById('patchset-popover');
  if (pop) pop.classList.add('hidden');
  var btn = patchSetBtnEl();
  if (btn) btn.setAttribute('aria-expanded', 'false');
  patchSetPopoverOpen = false;
}

function openPatchSetPopover() {
  if (!patchSetData) return;
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
      closePatchSetPopover();
      if (ref) selectPatchSetBase(ref);
    });
  }
  renderPatchSetPopover();
  pop.classList.remove('hidden');
  positionPatchSetPopover();
  var btn = patchSetBtnEl();
  if (btn) btn.setAttribute('aria-expanded', 'true');
  patchSetPopoverOpen = true;
}

function togglePatchSetPopover() {
  if (patchSetPopoverOpen) closePatchSetPopover(); else openPatchSetPopover();
}

// Ask main to switch the base, then refresh the bar. The diff itself repaints via kakapo:diff-update.
function selectPatchSetBase(ref) {
  if (!window.kakapoGit || typeof window.kakapoGit.setReviewBase !== 'function') return;
  if (patchSetData && (patchSetData.activeBase || 'auto') === ref) return; // no-op reselection
  Promise.resolve(window.kakapoGit.setReviewBase(ref)).then(function (res) {
    if (res && res.ok && patchSetData) {
      patchSetData.activeBase = res.activeBase || ref;
      renderPatchSetBar();
    }
    // A full refresh follows anyway when the diff-update lands; this keeps the face responsive meanwhile.
  }).catch(function () {});
}

// (Re)load the patch-set list from main and repaint the bar. Called on init and after every diff update
// (a new commit adds a patch set; a base switch changes the active row).
function refreshPatchSets() {
  if (!window.kakapoGit || typeof window.kakapoGit.patchSets !== 'function') return;
  Promise.resolve(window.kakapoGit.patchSets()).then(function (data) {
    patchSetData = (data && Array.isArray(data.commits)) ? data : null;
    renderPatchSetBar();
    if (patchSetPopoverOpen) { renderPatchSetPopover(); positionPatchSetPopover(); }
  }).catch(function () { patchSetData = null; renderPatchSetBar(); });
}

function initPatchSetBar() {
  var btn = patchSetBtnEl();
  if (!btn || !window.kakapoGit) return; // browser/serve mode, or bar not present
  btn.addEventListener('click', function (e) { e.stopPropagation(); togglePatchSetPopover(); });
  // Dismiss on outside click / Escape / scroll of the diff.
  document.addEventListener('click', function (e) {
    if (!patchSetPopoverOpen) return;
    var pop = document.getElementById('patchset-popover');
    if (pop && pop.contains(e.target)) return;
    if (btn.contains(e.target)) return;
    closePatchSetPopover();
  });
  document.addEventListener('keydown', function (e) {
    if (patchSetPopoverOpen && (e.key === 'Escape' || e.key === 'Esc')) { closePatchSetPopover(); }
  });
  window.addEventListener('resize', function () { if (patchSetPopoverOpen) positionPatchSetPopover(); });
  // Refresh the list whenever the diff is rebuilt in place (watch tick or our own base switch).
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
