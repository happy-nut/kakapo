function firstCodeRowOfHunk(hunkRow) {
  let row = hunkRow.nextElementSibling;
  let firstRow = null;
  while (row && !row.classList.contains('hunk') && !row.classList.contains('hunk-peer')) {
    if (row.querySelector && row.querySelector('.d2h-code-side-line')) {
      if (!firstRow) firstRow = row;
      if (row.querySelector('.d2h-ins, .d2h-del, ins, del')) return row;
    }
    row = row.nextElementSibling;
  }
  return firstRow || hunkRow;
}

// First row in a hunk to land the caret on. F7 should track the NEW (right) file, so prefer the
// first change on the new side anywhere in the hunk (additions / modifications) and only fall back
// to the old side for a pure-deletion hunk that has nothing on the new side. The .hunk marker sits
// on the OLD side and the two side tables are positionally aligned row-for-row, so the new-side row
// at the same index is the counterpart. Without this, a hunk that begins with deletions lands the
// caret on the old-side deletion instead of the added lines below it.
function isChangeCodeRow(row) {
  return !!(row && isDiffCodeRow(row) && row.querySelector('.d2h-ins, .d2h-del, ins, del'));
}
function firstChangeRowForCaret(hunkRow) {
  const wrapper = hunkRow.closest('.d2h-file-wrapper');
  const sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  const hunkSideEl = hunkRow.closest('.d2h-file-side-diff');
  if (sides.length >= 2 && hunkSideEl) {
    const hunkRows = Array.from(hunkSideEl.querySelectorAll('tr')); // old side (carries the .hunk marker)
    const otherEl = hunkSideEl === sides[0] ? sides[1] : sides[0];   // new side
    const otherRows = Array.from(otherEl.querySelectorAll('tr'));
    let fallbackOld = null;
    for (let i = hunkRows.indexOf(hunkRow) + 1; i < hunkRows.length; i++) {
      const hr = hunkRows[i];
      if (hr.classList.contains('hunk') || hr.classList.contains('hunk-peer')) break;
      if (isChangeCodeRow(otherRows[i])) return otherRows[i]; // first new-side change wins (track the new file)
      if (fallbackOld === null && isChangeCodeRow(hr)) fallbackOld = hr; // remember the first old-side change
    }
    if (fallbackOld) return fallbackOld; // pure-deletion hunk: nothing added, so land on the deletion
  }
  return firstCodeRowOfHunk(hunkRow);
}
function focusDiffRow(row) {
  if (activeDiffRow) activeDiffRow.classList.remove('diff-active-row');
  activeDiffRow = row || null;
  if (!row) return;
  row.classList.add('diff-active-row');
  // move the diff caret to follow hunk navigation (F7 / Shift+F7 / [ / ])
  const navInfo = diffRowInfoFromNode(row);
  if (navInfo && navInfo.path) {
    let navSide = navInfo.side;
    if (navSide === 'old') { // prefer the new (modified) side when it has a real line at this row
      const navWrap = diffWrapperByPath(navInfo.path);
      if (isDiffCodeRow(navWrap ? diffRowAt(navWrap, 'new', navInfo.rowIndex) : null)) navSide = 'new';
    }
    setDiffCursor(navInfo.path, navSide, navInfo.rowIndex, 0, false);
  }
}

function renderBreadcrumb(container, path) {
  if (!container) return;
  container.textContent = '';
  const parts = (path || '').split('/').filter(Boolean);
  parts.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      container.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = i === parts.length - 1 ? 'crumb crumb-leaf' : 'crumb';
    span.textContent = seg;
    container.appendChild(span);
  });
}

// IntelliJ-style diff chrome follows the keyboard caret, not merely the selected file. A unified hunk
// can contain several separated edit blocks, so the counter is derived from contiguous change rows in
// the active pane — the same review stops F7 uses inside a file.
function diffReviewAnchors(wrapper, side) {
  if (!wrapper) return [];
  var cacheKey = side === 'old' ? '__reviewAnchorsOld' : '__reviewAnchorsNew';
  if (wrapper[cacheKey]) return wrapper[cacheKey];
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  if (!rows.length) return [];
  var anchors = [];
  var previousWasChange = false;
  for (var i = 0; i < rows.length; i++) {
    var changed = isChangeCodeRow(rows[i]);
    if (changed && !previousWasChange) anchors.push(i);
    previousWasChange = changed;
  }
  wrapper[cacheKey] = anchors;
  return anchors;
}

function syncDiffReviewChrome(path) {
  var activePath = path || (diffCursor && diffCursor.path) || hunkPathAt(current) || '';
  var beforePath = document.getElementById('diff-before-path');
  var afterPath = document.getElementById('diff-after-path');
  if (beforePath) { beforePath.textContent = activePath; beforePath.title = activePath; }
  if (afterPath) { afterPath.textContent = activePath; afterPath.title = activePath; }

  var counter = document.getElementById('diff-change-counter');
  var previous = document.getElementById('diff-prev-change');
  var nextButton = document.getElementById('diff-next-change');
  var openSource = document.getElementById('diff-open-source');
  var disabled = hunkTotal() === 0 || !activePath;
  if (previous) previous.disabled = disabled;
  if (nextButton) nextButton.disabled = disabled;
  if (openSource) openSource.disabled = disabled;
  if (!counter) return;

  var cursor = diffCursor && diffCursor.path === activePath ? diffCursor : null;
  var wrapper = diffWrapperByPath(activePath);
  var anchors = cursor && wrapper ? diffReviewAnchors(wrapper, cursor.side) : [];
  if (!cursor || !anchors.length) {
    counter.textContent = disabled ? t('diff.noChange') : '—';
    counter.title = counter.textContent;
    return;
  }
  var selected = 0;
  for (var ai = 0; ai < anchors.length; ai++) {
    if (anchors[ai] <= cursor.rowIndex) selected = ai;
    else break;
  }
  var label = t('diff.changeCounter')
    .replace('{current}', String(selected + 1))
    .replace('{total}', String(anchors.length));
  counter.textContent = label;
  counter.title = label;
}

// Coalesce diff-nav scrolls: hammering F7 / [ / ] schedules at most one
// scrollIntoView per frame (to the latest target) instead of forcing a
// synchronous reflow on every keystroke.
var pendingDiffScrollRow = null;
var diffScrollRaf = 0;
function scheduleDiffScroll(row) {
  pendingDiffScrollRow = row || null;
  if (diffScrollRaf) return;
  diffScrollRaf = requestAnimationFrame(function () {
    diffScrollRaf = 0;
    var r = pendingDiffScrollRow;
    pendingDiffScrollRow = null;
    if (r && r.scrollIntoView) r.scrollIntoView({ block: 'center' });
  });
}

// Coalesced scrollIntoView for caret/focus moves. Holding an arrow key fires key-repeat faster than a
// reflow-forcing scrollIntoView can run, so collapse them to one (latest element) per animation frame and
// use block:nearest (no per-row center-jump). Shared by the tree, source caret, and diff caret.
var pendingScrollEl = null, scrollElRaf = 0;
// Reveal `el` by keeping it ~fraction of the way down its scroller, scrolling minimally on EVERY move so the
// view follows the caret CONTINUOUSLY. scrollIntoView('nearest') instead leaves the view still until the
// caret reaches the edge and then jumps — stuttering ~every viewport while an arrow key is held.
function revealAt(el, scroller, fraction) {
  if (!el) return;
  if (!scroller || !scroller.clientHeight) { try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (x) {} return; }
  var off = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += off - scroller.clientHeight * fraction;
}
// Scrolloff variant: scroll ONLY when `el` would otherwise leave the viewport, keeping it within `marginFrac`
// of the top/bottom edge. While the row moves comfortably inside that band the view stays put — continuous
// centering scrolled the file even when everything was visible (dizzying). Used by the diff caret and the sidebar tree.
function scrolloffReveal(el, scroller, marginFrac) {
  if (!el || !scroller || !scroller.clientHeight) return;
  var top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  var rowH = el.offsetHeight || 18;
  var ch = scroller.clientHeight;
  var margin = Math.round(ch * marginFrac);
  if (top < margin) scroller.scrollTop += top - margin;
  else if (top + rowH > ch - margin) scroller.scrollTop += (top + rowH) - (ch - margin);
}
function scheduleScrollIntoView(el) {
  pendingScrollEl = el || null;
  if (scrollElRaf) return;
  scrollElRaf = requestAnimationFrame(function () {
    scrollElRaf = 0;
    var e = pendingScrollEl; pendingScrollEl = null;
    if (e && e.scrollIntoView) { try { e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (x) {} }
  });
}

var setActiveRaf = 0, setActiveScrollPending = true;
function setActive(index, shouldScroll = true) {
  if (hunkTotal() === 0) return;
  current = ((index % hunkTotal()) + hunkTotal()) % hunkTotal();
  // Coalesce rapid presses (holding/spamming F7 or Shift+F7) into one DOM apply per animation frame. The
  // key handler returns immediately and `current` updates synchronously (so next()/nav math stays correct),
  // while the heavy DOM work (full link/wrapper sweeps, body materialize) runs at most once per frame
  // instead of once per keystroke — the input queue never blocks and can't pile up on big repos.
  setActiveScrollPending = shouldScroll;
  if (setActiveRaf) return;
  setActiveRaf = requestAnimationFrame(function () {
    setActiveRaf = 0;
    applySetActive(current, setActiveScrollPending);
  });
}
function applySetActive(idx, shouldScroll) {
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  setTab('changes');
  const file = hunkPathAt(idx);
  links.forEach((link) => link.classList.toggle('active', link.dataset.file === file));
  renderBreadcrumb(document.getElementById('diff-breadcrumb'), file);
  syncDiffReviewChrome(file);
  var dvt = document.getElementById('diff-viewed-toggle');
  if (dvt) dvt.dataset.file = file || '';
  updateDiffViewedToggle();
  if (file) rememberRecent(file, 'change');
  history.replaceState(null, '', '#hunk-' + idx);
  // Row-dependent work waits for the file body (sync for eager/Phase 1, async for cold lazy-LOAD).
  whenFileReady(diffWrapperByPath(file), function () {
    showOnlyFile(file, true); // materialize + isolate the file, but leave the caret to focusDiffRow (skip ensureDiffCursor)
    const active = document.getElementById('hunk-' + idx);
    if (!active) return;
    if (REVIEW_LAZY) {
      document.querySelectorAll('#diff2html-container .hunk.active, #diff2html-container .hunk-peer.active').forEach((h) => h.classList.remove('active'));
      document.querySelectorAll('#diff2html-container [data-hunk-index="' + idx + '"]').forEach((h) => h.classList.add('active'));
    } else {
      hunks.forEach((hunk, i) => hunk.classList.toggle('active', i === idx));
      hunkPeers.forEach((hunk) => hunk.classList.toggle('active', Number(hunk.dataset.hunkIndex) === idx));
    }
    const targetRow = firstChangeRowForCaret(active);
    // F7/change navigation moves the caret but must NOT pollute the Cmd+[/] cursor history.
    navSuppress = true;
    try { focusDiffRow(targetRow); } finally { navSuppress = false; }
    // Scroll inline in THIS frame, NOT via scheduleDiffScroll's extra rAF. showOnlyFile just display:none'd
    // the previous file, but the scroll container keeps its old (larger) scrollTop — so for one frame the new
    // file renders at that stale offset (≈ line 146) before a deferred scroll snaps to the change (≈ line 21):
    // the visible 146→21 double jump on F7 across a file boundary. Scrolling synchronously here lands the
    // view on the change before this frame paints, so the new file appears already at its first change.
    if (shouldScroll && targetRow && targetRow.scrollIntoView) targetRow.scrollIntoView({ block: 'center' });
  });
}

function showOnlyFile(fileName, skipCursor) {
  if (REVIEW_LAZY) ensureFileReady(diffWrapperByPath(fileName));
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    wrapper.classList.toggle('df-inactive', diffWrapperPathKey(wrapper) !== fileName);
  });
  // applySetActive passes skipCursor: it sets the caret itself via focusDiffRow(targetRow). Letting
  // ensureDiffCursor run here would first place the caret on the file's FIRST code row, then focusDiffRow
  // overrides it to the change — a visible double jump (the F7 "first line → change" flash).
  if (!skipCursor) ensureDiffCursor();
}

// The hunk the diff caret currently sits in. Arrow keys move the caret without touching the active
// index (the F7 anchor), so navigation must read the caret's real position -- otherwise pressing F7
// after arrowing to the bottom of a file re-treads hunks already passed instead of going to the next file.
function hunkIndexAtCaret() {
  if (!diffCursor) return -1;
  const wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return -1;
  const caretRow = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  const sideEl = caretRow ? caretRow.closest('.d2h-file-side-diff') : null;
  if (!sideEl) return -1;
  let found = -1;
  // @@ markers on the caret's side carry data-hunk-index; the nearest one at or above the caret wins.
  sideEl.querySelectorAll('[data-hunk-index]').forEach((marker) => {
    if (marker === caretRow || (caretRow.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_PRECEDING)) {
      found = Number(marker.dataset.hunkIndex);
    }
  });
  return found;
}

// New-side row indices, one per change block — a run of change rows (ins/del) separated by context.
// A wide context window merges several edits into one @@ hunk; stepping by these stops at each edit.
function changeBlockAnchors(wrapper) {
  if (!wrapper) return [];
  if (wrapper.__anchors) return wrapper.__anchors;
  var right = diffSideTables(wrapper).right;
  if (!right) return []; // body not materialized yet — don't cache an empty result
  var rows = diffRowsOf(right);
  var anchors = [];
  var prev = false;
  for (var i = 0; i < rows.length; i++) {
    var chg = isChangeCodeRow(rows[i]);
    if (chg && !prev) anchors.push(i);
    prev = chg;
  }
  wrapper.__anchors = anchors; // change-block layout is static once materialized
  return anchors;
}

// Forward F7 at a file's last change announces "last change — press F7 again" once before crossing to the
// next file, giving a beat to mark-viewed. Holds the path we've already announced; any caret move clears it
// (see setDiffCursor), so leaving and returning to the last change re-arms the announcement.
var pendingFileBoundary = null;
function next(delta) {
  if (hunkTotal() === 0) return;
  // Within the caret's (unviewed) file, step change-block by change-block so a context-merged hunk
  // (several separate edits under one @@) stops at every edit instead of skipping to the next file.
  if (diffCursor && isDiffViewVisible()) {
    const w = diffWrapperByPath(diffCursor.path);
    if (w && !isFileViewed(diffCursor.path)) {
      const anchors = changeBlockAnchors(w);
      const cur = diffCursor.rowIndex;
      let target = null;
      if (delta > 0) { for (let a = 0; a < anchors.length; a++) { if (anchors[a] > cur) { target = anchors[a]; break; } } }
      else { for (let b = anchors.length - 1; b >= 0; b--) { if (anchors[b] < cur) { target = anchors[b]; break; } } }
      if (target != null) {
        const row = diffRowAt(w, 'new', target);
        if (row) { navSuppress = true; try { focusDiffRow(row); } finally { navSuppress = false; } scheduleDiffScroll(row); return; }
      }
    }
  }
  // File boundary: no more change blocks in this file. Forward F7 announces "last change — press F7 again
  // to go to the next file" on the FIRST press (a beat to mark-viewed) and only crosses on the SECOND
  // consecutive press. Already-viewed files (and backward nav) cross immediately — no announcement.
  // The `hunkPathAt(current) === diffCursor.path` guard skips the announcement while a cross is still in
  // flight: after setActive moves `current` to the next file but BEFORE its (async, lazy-loaded) caret lands,
  // diffCursor still points at the OLD file — without the guard a quick second F7 re-announced that old
  // boundary instead of letting the cross finish (the "press F7 twice more, no caret" bug).
  if (delta > 0 && diffCursor && isDiffViewVisible() && !isFileViewed(diffCursor.path) && hunkPathAt(current) === diffCursor.path) {
    if (pendingFileBoundary !== diffCursor.path) {
      pendingFileBoundary = diffCursor.path;
      showCaretHint(t('diff.lastHunk'));
      return;
    }
    pendingFileBoundary = null; // second consecutive press on the same file → fall through and cross
  }
  hideCaretHint(); // about to cross files — drop the hint NOW (before the async body load) so it can't cover the next file
  // hunk-level nav to the next/prev unviewed file.
  const caretHunk = hunkIndexAtCaret();
  const base = caretHunk >= 0 ? caretHunk : current;
  let idx = base < 0 ? initialHunkForNavigation(delta) : base + delta;
  for (let step = 0; step < hunkTotal(); step++) {
    const norm = ((idx % hunkTotal()) + hunkTotal()) % hunkTotal();
    if (!isFileViewed(hunkPathAt(norm) || '')) { setActive(norm); return; }
    idx += delta;
  }
  // Every changed file is marked viewed — nothing left to review, so F7/[/] stay put.
}

// Jump to the first change of the next unviewed file after `path` (wrapping). Used right after marking a
// file viewed: its diff body is now hidden, so staying would blank the content — we advance to the next
// change instead. Returns false when every changed file is viewed (nothing to advance to).
function gotoNextUnviewedFile(path) {
  const total = hunkTotal();
  if (total === 0) return false;
  const start = firstHunkForPath(path);
  let idx = (start >= 0 ? start : (current >= 0 ? current : 0)) + 1;
  for (let step = 0; step < total; step++) {
    const norm = ((idx % total) + total) % total;
    if (!isFileViewed(hunkPathAt(norm) || '')) { setActive(norm); return true; }
    idx += 1;
  }
  return false;
}

function initialHunkForNavigation(delta) {
  const openPath = document.getElementById('source-viewer')?.dataset.openPath || '';
  const sourceHunk = firstHunkForPath(openPath);
  if (sourceHunk >= 0) return sourceHunk;
  return delta < 0 ? hunkTotal() - 1 : 0;
}

function firstHunkForPath(path) {
  if (!path) return -1;
  const link = links.find((candidate) => candidate.dataset.file === path);
  if (!link) return -1;
  const index = Number(link.dataset.hunk);
  return Number.isNaN(index) ? -1 : index;
}
