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
  //
  // git's EMPTY TREE is not an unknown base — it is "nothing was there yet", which a range opened from the
  // ROOT commit gets, and it means every commit up to the target is inside the span. Counted as one, the
  // chip read `1fe2700 work` with no "+2 더" beside it for a three-commit range.
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
  // The app's locale, not the OS's. Passing undefined let a window running in English print a Korean
  // date inside an English sentence (observed: "(sha0 · 10월 1일)").
  try { return d.toLocaleDateString(locale, opts); } catch (e) { return iso.slice(0, 10); }
}
function patchSetCommitTitle(index, c) {
  var meta = c.shortSha + (c.date ? ' · ' + patchSetShortDate(c.date) : '');
  return (index + 1) + '. ' + c.subject + '  (' + meta + ')';
}

// Option list for each side: [{ ref, label, title, wide, active }].
function patchSetBaseOptions(data) {
  var opts = [];
  var active = data.activeBase || 'auto';
  // A ⌘9 range opened from the root commit is based on git's empty tree, which is in no commit list — so
  // the base side had no button to mark and the bar came out as `기준 ⟨nothing⟩ 1 2 3 대상` with an empty
  // summary beside it. It is a real base and it has a name the history bar already uses for it.
  if (data.scoped && active === EMPTY_TREE_SHA) {
    opts.push({ ref: EMPTY_TREE_SHA, label: t('history.emptyTree'), wide: true, title: t('history.emptyTree'), active: true });
  }
  if (!data.scoped && data.branchPoint) {
    opts.push({
      // "auto", not the branch point's sha — they resolve to the same diff, and only one of them is
      // reversible. Sending the sha set `options.base` to a literal commit, so the toolbar pill stopped
      // saying `main` and said `54d784f` forever: the bar still looked unchanged (the option is marked
      // active for either value), while the pill and the patch-set summary had started naming the same
      // base differently, six pixels apart. app-main understands "auto" on both compare paths.
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

// Thirty-three patch sets wrapped the bar onto a second row and every number stopped being findable — the
// list had become a wall rather than a control. Show a window instead: the two at each end, the one you are
// on with its neighbours, and an ellipsis for each run that was left out. Seven numbers, whatever the branch
// length, and the ends stay reachable in one click because "the beginning" and "HEAD" are the two places a
// reviewer jumps to blind.
// The wide entries ("All" / "WT") are not patch sets and never fold away — they are the exits.
var PATCHSET_EDGE = 2;   // how many at each end
var PATCHSET_AROUND = 1; // how many either side of the active one
// Which sides the reader has asked to see in full. The fold is still not a guess — it does not pick a
// commit for you — it just stops hiding them. Without this the window advanced by one per click, so
// reaching the middle of a thirty-three commit branch took sixteen selections and sixteen diff rebuilds,
// each one a full `git diff`, to arrive somewhere two clicks should have reached.
var patchSetExpanded = { base: false, target: false };
function patchSetWindow(opts, which) {
  var numbers = opts.filter(function (o) { return !o.wide; });
  if (patchSetExpanded[which]) return opts;
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
    if (!gap) { out.push({ ellipsis: true, from: index, hidden: 0 }); gap = true; }
    if (gap) out[out.length - 1].hidden += 1;
  });
  // Put the wide exits back where they were: base leads with "All", target ends with "WT".
  var lead = opts.filter(function (o) { return o.wide && opts.indexOf(o) === 0; });
  var tail = opts.filter(function (o) { return o.wide && opts.indexOf(o) !== 0; });
  return lead.concat(out, tail);
}

/** "Show the 1 patch set folded away here" — the form that is right for the count. */
function patchSetShowAllLabel(opt) {
  var n = opt.hidden || 0;
  return t('patchset.showAll', { n: n });
}
function patchSetNumButton(which, opt) {
  // A fold is not a control: it says how many were left out and answers a hover, nothing more. Clicking it
  // would have to guess which of the hidden commits you meant.
  // A fold is a control after all — not one that guesses which hidden commit you meant, one that stops
  // hiding them. It also says how many it is holding, which the comment above has always claimed and the
  // markup never did: it rendered a bare aria-hidden ellipsis with no count and no title.
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

// Fill both groups. Hidden when there are no patch sets to pick and no active A→B compare.
/**
 * ⌥] / ⌥[ : step the BASE through the patch sets the bar lists, in the order it lists them.
 *
 * The base, not the target, because the base is the question the row of numbers answers — "compare against
 * this one" — and the target side is the working tree in every ordinary reading. Stepping walks the FULL
 * option list rather than the numbers currently on screen: patchSetWindow folds the middle of a long list
 * away, and a key that stopped at the edge of what happens to be drawn would stop in a different place on
 * a different window.
 *
 * At either end it says so rather than silently doing nothing, which is the same bargain F7 makes at a file
 * boundary. In between it stays quiet: the bar marks the active number and rewrites its own summary, so a
 * sentence per press would be saying what is already on screen.
 */
function stepPatchSet(delta) {
  var bar = patchSetBarEl();
  if (!bar || bar.classList.contains('hidden') || !patchSetData) return false;
  var opts = patchSetBaseOptions(patchSetData);
  if (!opts.length) return false;
  var at = -1;
  for (var i = 0; i < opts.length; i += 1) if (opts[i].active) { at = i; break; }
  // Nothing marked (a base outside this list): enter from the end the direction comes from, so the first
  // press lands somewhere rather than guessing at a position the reader is not in.
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

// The sentence in the middle of the bar: which two things the diff below is the difference between. Built
// from the same option lists the buttons are, so it can never name something the bar does not offer.
function patchSetSideLabel(opts, active) {
  for (var i = 0; i < opts.length; i++) {
    if (!opts[i].active) continue;
    // The title already reads "3. subject (sha · date)" for a commit and "All changes · main" for an end;
    // its leading "N. " is the number on the button right beside it, so it is dropped here.
    return String(opts[i].title || opts[i].label).replace(/^\d+\.\s*/, '');
  }
  // Nothing matched, which happens in two perfectly ordinary states: a `kakapo --base main` launch carries
  // the REF NAME as activeBase, and ⌥U sets it to "HEAD" — neither is one of these options, which are shas.
  // The summary then came out EMPTY while the toolbar pill beside it named the base without difficulty, and
  // a bar that says nothing about the state it is in reads as a bar that is broken. Name the value itself.
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

// Switch base or target, then refresh the bar. The diff repaints via kakapo:diff-update.
function selectPatchSet(which, ref) {
  if (!window.kakapoGit || !ref) return;
  // NOT here. This arms a one-shot "jump back to the diff on the next rebuild", and every no-op return
  // below used to leave it armed — so a click that changed nothing was spent by the next UNRELATED watch
  // rebuild, which in this app is the agent saving any file, pulling the reader out of whatever they were
  // reading. It belongs next to each call that actually asks for a change.
  // In a Cmd+9-opened range, both sides are commits in the scope; set them together so B..D shows.
  // Each of these three moves activeBase/activeTarget, which is what compareCommitLead() reads — so each
  // changes the toolbar's commit chip and must repaint it. They repainted only the bar and relied on a
  // diff-update event arriving afterwards; where one does not, the chip goes on naming the old commit,
  // which is the disagreement refreshPatchSets was changed to end, reached from the control that causes it.
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
    // "All changes" is the same thing ⌥A means, so it has to go the same way ⌥A goes. Sending `auto` down
    // the patch-set path cleared `options.base`, and automatic resolution DECLINES on a dirty worktree
    // (resolveAutomaticReviewBase, src/git.ts: unpushed commits are only the base when there is nothing
    // uncommitted), so the build fell back to HEAD — and a button labelled `전체 변경 · main` narrowed the
    // review to uncommitted changes, the exact opposite of what it says, whenever anything was uncommitted.
    // setCompareMode resolves the branch point explicitly and records the branch in `baseLabel`, which is
    // both right and reversible; `auto` was chosen for reversibility alone, without asking what it meant.
    // "Already there?" FIRST, and asked the way the bar asks it — which is the only way the two can agree.
    // The backend sends `activeBase` as the sha the build resolved, so comparing it with the option's own
    // `ref` held only while that ref was a sha too; the moment "all" started sending "auto" it went dead,
    // and clicking the already-active "all" ran a full rebuild — a git diff and a source re-index — for a
    // state that did not change. It has to sit ABOVE the branch below, because `auto` is produced by that
    // one option and nothing else: put under it, the guard was written for a ref it could never see.
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
  // The toolbar's commit chip is a function of THIS data (compareCommitLead reads patchSetData), and it
  // arrives asynchronously after a rebuild — so the chrome painted during the rebuild was painted from
  // the previous answer. Coming back from a History commit with ⌥A left "61139ee feat(lsp): …" sitting
  // beside "all changes · origin/main → Working tree": two statements about what you are reading,
  // disagreeing, until you happened to open another file. syncDiffReviewChrome compares the lead it
  // last drew, so this repaints only when the answer really moved.
  var settle = function () { renderPatchSetBar(); syncDiffReviewChrome(); };
  Promise.resolve(window.kakapoGit.patchSets()).then(function (data) {
    patchSetData = (data && Array.isArray(data.commits)) ? data : null;
    settle();
  }).catch(function () { patchSetData = null; settle(); });
}

// ---- The ledger ---------------------------------------------------------------------------------
// The list the bar's numbers are a summary of. The bar answers "which one"; it cannot answer "which one
// is 3?", because a subject, a file count and a date do not fit on a button — and that is the question a
// reviewer coming back to a worktree actually has.
//
// Its data is a SECOND call (kakapoGit.patchSetLedger), not the one the bar refreshes on. The figures
// cost a `--numstat` walk of the branch and the bar refreshes on every diff update, so the ledger pays
// for its own numbers and a reviewer who never opens it pays nothing.
var patchSetLedgerData = null;

function patchSetLedgerEl() { return document.getElementById('patchset-ledger'); }
function patchSetLedgerOpen() {
  var el = patchSetLedgerEl();
  return !!el && !el.classList.contains('hidden');
}

/** "2 files · +8 −2", or nothing at all when this patch set's figures were not asked for. */
function patchSetLedgerStat(stat) {
  if (!stat) return '';
  return '<span class="patchset-ledger-stat">'
    + escapeHtml(t('patchset.files', { n: stat.files })) + ' '
    + '<span class="ps-add">+' + escapeHtml(String(stat.added)) + '</span> '
    + '<span class="ps-del">−' + escapeHtml(String(stat.removed)) + '</span>'
    + '</span>';
}

/**
 * Which patch sets arrived after the reviewer stopped reading.
 *
 * The mark is a commit, and `commits` is oldest → newest, so everything AFTER the mark's position is
 * unread — not "everything whose date is later", because a rebase rewrites dates and an agent amending
 * its own work would then mark read work unread. With no mark nothing is unread: a review nobody has
 * handed off has no "since", and marking the whole branch unread would be a claim this does not have.
 */
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

  // The two ends first and last, the way the mock reads them: "all of it" above the list, "the working
  // tree" below it. They are not patch sets — they are the exits — so they carry no read state.
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
        // Marked read/unread only where the question has an answer. Without a hand-off there is no
        // reading position, and painting every row "read" would say something nobody told us.
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
  // The shared slot (00-util.js), not a bare btn.focus(). It knows the one thing a hand-rolled restore
  // keeps getting wrong: by the time a close runs focus has usually already left — a click outside blurs
  // on mousedown — so "does it hold focus now" is the wrong question and "was it up" is the right one.
  // It also falls back to the reading surface when the opener is gone.
  restoreOverlayFocus(el, wasOpen);
}

function openPatchSetLedger() {
  var el = patchSetLedgerEl();
  if (!el || !window.kakapoGit || typeof window.kakapoGit.patchSetLedger !== 'function') return;
  // Before anything moves focus into it, so the slot holds the control the reader came from.
  rememberOverlayFocus(el);
  el.classList.remove('hidden');
  var btn = document.getElementById('patchset-ledger-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  // Paint from the last answer at once so it never opens empty, then correct it from git.
  renderPatchSetLedger();
  Promise.resolve(window.kakapoGit.patchSetLedger()).then(function (data) {
    if (!patchSetLedgerOpen()) return; // closed while the numstat walk was running
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

/** Arrows walk the rows, Enter picks, Esc closes — the same bargain every list in this app makes. */
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
  if (!bar || !window.kakapoGit) return; // browser/serve mode, or bar not present
  bar.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#patchset-ledger-btn')) { togglePatchSetLedger(); return; }
    // A ledger row picks the BASE, the same thing the numbers do and for the same reason: the base is the
    // question this control answers ("compare against this one"), and the target is the working tree in
    // every ordinary reading. Picking closes the ledger — the answer is now in the diff behind it.
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
  // Esc and the arrows, on the bar itself: the rows are focused while it is open, so the events arrive
  // here and never reach the page's own keymap — which is what keeps Esc from closing something else.
  bar.addEventListener('keydown', function (e) { handlePatchSetLedgerKey(e); });
  // Anywhere else closes it, like every other popover in this window. Capture, because a click on a diff
  // row stops propagating before it would reach the document in the bubble phase.
  document.addEventListener('mousedown', function (e) {
    if (!patchSetLedgerOpen()) return;
    if (e.target.closest && e.target.closest('#patchset-ledger, #patchset-ledger-btn')) return;
    closePatchSetLedger();
  }, true);
  if (window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function') {
    window.kakapoMenu.onDiffUpdate(function () {
      try {
        refreshPatchSets();
        // The branch moved under an open ledger — an agent committed while it was up. Re-ask rather than
        // leave a list that no longer describes the branch it is a list of.
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
