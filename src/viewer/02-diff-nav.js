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

// First row in a hunk to land the caret on: the first row where EITHER side changes, preferring the new
// (right) side when both change at that row — which is every modification, since diff2html pairs the del
// and the ins on one aligned row. The .hunk marker sits on the OLD side and the two side tables are
// positionally aligned row-for-row, so the new-side row at the same index is the counterpart.
//
// This used to scan the whole hunk for a new-side change first and only fall back to the old side for a
// hunk with nothing added at all. That skipped PAST a leading deletion to the additions below it, and since
// F7 only moves forward from where the caret lands, those deleted lines were then unreachable: entering the
// file already put the caret beyond the hunk's first change. IntelliJ enters at the first difference
// whichever side it is on (ScrollToPolicy.FIRST_CHANGE over a side-agnostic fragment list).
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
    for (let i = hunkRows.indexOf(hunkRow) + 1; i < hunkRows.length; i++) {
      const hr = hunkRows[i];
      if (hr.classList.contains('hunk') || hr.classList.contains('hunk-peer')) break;
      if (isChangeCodeRow(otherRows[i])) return otherRows[i]; // a modification or an addition: track the new file
      if (isChangeCodeRow(hr)) {
        // A deletion at this row. Entering a file is IntelliJ's FIRST_CHANGE scroll, which reads the
        // current side like every other move, so the caret stays in the working tree and lands where the
        // removed text collapsed to. Searched in THIS loop's index space (querySelectorAll('tr')), never
        // with diffRowsOf — the two tables are indexed differently and an index from one is a different
        // row in the other.
        for (let f = i; f < otherRows.length; f++) if (isDiffCodeRow(otherRows[f])) return otherRows[f];
        for (let b = i - 1; b >= 0; b--) if (isDiffCodeRow(otherRows[b])) return otherRows[b];
        return hr; // the new side has no code at all — a file deleted outright
      }
    }
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

// While the review is pointed at commits instead of the working tree, the toolbar says which commit it is
// showing. This is the one place a reader's eyes already go on every file change, which is what makes it the
// place to say "these are not your local changes": opening a commit from Cmd+9 closes the history overlay
// and lands you here, so nothing else on screen would have told you.
//
// Its own component, beside the breadcrumb rather than inside it. They are two different statements — WHICH
// COMMIT you are reading, and WHERE IN IT you are — and running them together as one crumb trail made them
// compete for one ellipsis budget. The CSS admitted as much: the subject was told to give up its width
// first so a long commit title would not push the filename off the end. It also put the file icon in front
// of the commit, so the icon labelled the sha instead of the path it belongs to.
function renderCommitContext(container) {
  if (!container) return;
  container.textContent = '';
  const lead = compareCommitLead();
  container.classList.toggle('hidden', !lead);
  if (!lead) return;
  const mark = document.createElement('span');
  mark.className = 'crumb-commit';
  mark.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"'
    + ' stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1v4M8 11v4"/></svg>'
    + '<span class="crumb-sha"></span>';
  mark.querySelector('.crumb-sha').textContent = lead.sha;
  container.appendChild(mark);
  if (lead.subject) {
    const subject = document.createElement('span');
    subject.className = 'crumb-subject';
    subject.textContent = lead.subject;
    // The full title, since this is the one that gets cut: the breadcrumb beside it keeps its own width.
    subject.title = lead.subject;
    container.appendChild(subject);
  }
  if (lead.others > 0) {
    const more = document.createElement('span');
    more.className = 'crumb-count';
    // t() takes a key and nothing else — the second argument was silently dropped, so this has been
    // rendering the literal "+{n} more" since it was written. Substituted the way every other string
    // with a placeholder in this codebase is.
    more.textContent = t('compare.andMore', { n: lead.others });
    container.appendChild(more);
  }
}
// The file path alone.
function renderBreadcrumb(container, path) {
  if (!container) return;
  container.textContent = '';
  // A library file is addressed absolutely, because no path relative to this project can name it. Splitting
  // it into crumbs read as a project structure that does not exist — `opt › ts › lib › lib.es2022.d.ts` —
  // so it keeps its own shape: the containing directory, then the file, marked as from outside the review.
  if (isLibrarySourcePath(path)) {
    const away = document.createElement('span');
    away.className = 'crumb crumb-library';
    away.textContent = t('source.library');
    container.appendChild(away);
    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '›';
    sep.setAttribute('aria-hidden', 'true');
    container.appendChild(sep);
    const leaf = document.createElement('span');
    leaf.className = 'crumb crumb-leaf';
    // A compiled target is not a path either: `jdt://contents/java.base/java.util/List.class?=javalib/
    // %5C/Users%5C/happynut%5C/repos%5C/…` is 300 characters of which the first 40 are the only ones about
    // the class. externalLocationLabel is the shortening the hint and the peek list already use; the full
    // URI stays in the tooltip, because it is the only exact name this file has.
    // Two characters at least before the colon, so a Windows `C:/opt/...` library path is left alone.
    leaf.textContent = /^[a-z][a-z0-9+.-]+:/i.test(String(path || ''))
      ? externalLocationLabel(String(path).split('?')[0])
      : String(path || '');
    leaf.title = String(path || '');
    container.appendChild(leaf);
    return;
  }
  const parts = (path || '').split('/').filter(Boolean);
  parts.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      sep.setAttribute('aria-hidden', 'true');
      container.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = i === parts.length - 1 ? 'crumb crumb-leaf' : 'crumb';
    span.textContent = seg;
    container.appendChild(span);
  });
  appendBreadcrumbStat(container, path);
}

// How big this change is, for the ONE file the toolbar is about. Read off that file's Changes row rather than
// counted from the rendered diff: bodies materialize on demand (Phase 2 lazy-LOAD), so a file nobody has
// scrolled to yet has no +/- rows in the DOM at all, and counting them would confidently report "+0 -0" for
// the largest change in the review. The row carries the totals the parser already knew (render-tree.ts).
// Matched by dataset rather than a [data-file="..."] selector so a path containing a quote cannot break it.
function appendBreadcrumbStat(container, path) {
  if (!path) return;
  var row = Array.prototype.find.call(document.querySelectorAll('.change-row'), function (el) {
    return el.dataset.file === path;
  });
  var added = Number(row && row.dataset.added) || 0;
  var deleted = Number(row && row.dataset.deleted) || 0;
  if (!added && !deleted) return; // a rename or a binary file has nothing to count, and says so by staying quiet
  var stat = document.createElement('span');
  stat.className = 'crumb-stat';
  var plus = document.createElement('span');
  plus.className = 'crumb-stat-add';
  plus.textContent = '+' + added;
  var minus = document.createElement('span');
  minus.className = 'crumb-stat-del';
  // U+2212, the same minus changeStat() prints in render-tree.ts. This one printed an ASCII hyphen, which
  // in a tabular face is narrower than a digit and sits off the digits' optical centre, so the two
  // spellings of one figure did not line up with each other. Only the glyph is unified here: BOTH sides
  // are always printed, zero included, because the toolbar names a single file and a figure that keeps
  // its shape is one you can read without first working out which half you are looking at. The tree omits
  // a zero for the opposite reason — there the figure is scanned down a column, not read.
  minus.textContent = '\u2212' + deleted;
  stat.appendChild(plus);
  stat.appendChild(minus);
  container.appendChild(stat);
}

/** The path this file had on the BASE side: a rename's old path, or the active path for everything else. */
function diffBaseSidePath(path) {
  if (!path) return path;
  var row = Array.prototype.find.call(document.querySelectorAll('.change-row'), function (el) {
    return el.dataset.file === path;
  });
  return (row && row.dataset.oldPath) || path;
}

// The diff's chrome, all of it, from the one path it is about.
//
// The breadcrumb used to be rendered by each navigation site separately, and setDiffCursor — the caret,
// which crosses files on ⌘↑/↓, on a click in another file and on F7's step — was not one of them. So the
// two pane labels said src/i18n.ts while the title above them still said `src › lsp.ts +171 −11`: two
// answers to "which file am I reading", from two updaters, one of which everything called and one of
// which four places did. One function owns the lot now, and a stale title is not reachable from here.
var diffChromePath = null;
var diffChromeLead = null;
function syncDiffReviewChrome(path) {
  // A compare can land on NOTHING — ⌥U on a clean tree, a patch set that changed nothing. The body says so
  // ("검토할 변경사항이 없습니다") and the tree says so, while this went on naming a file from the review
  // before it: the title row and both pane headers all read `added.txt` with no such file on screen.
  // The caret and the hunk list are both stale at that moment, so the only honest source is the page.
  var empty = !document.querySelector('#diff2html-container .d2h-file-wrapper');
  var activePath = empty ? '' : (path || (diffCursor && diffCursor.path) || hunkPathAt(current) || '');
  var beforePath = document.getElementById('diff-before-path');
  var afterPath = document.getElementById('diff-after-path');
  // The right pane's label is static markup reading "작업 트리", which is true of the ordinary review and
  // false of every A→B compare: a ⌘9 range, or a patch set chosen as the target, puts a COMMIT there and
  // the header went on naming a working tree that is not in the comparison at all. A sha is not a phrase,
  // so the i18n key comes off while one is shown and goes back on when the working tree returns — leaving
  // it would let the next locale switch repaint "작업 트리" over the commit.
  var afterKind = document.getElementById('diff-after-kind');
  if (afterKind) {
    var target = patchSetData && patchSetData.activeTarget;
    if (target && target !== 'worktree') {
      // "대상", not the sha. The left pane says what it IS ("기준") and the right one has to answer the
      // same question, or the header holds two different kinds of noun — `기준 src/foo.ts` beside
      // `1fe2700 src/foo.ts`. Which commit it is is named by the pill and by the patch-set bar, both of
      // which are on screen; what this row is for is which SIDE you are looking at.
      afterKind.setAttribute('data-i18n', 'diff.target');
      afterKind.textContent = t('diff.target');
    } else if (afterKind.getAttribute('data-i18n') !== 'diff.workingTree') {
      afterKind.setAttribute('data-i18n', 'diff.workingTree');
      afterKind.textContent = t('diff.workingTree');
    }
  }
  // A RENAME has two paths, and the left pane holds the one that existed at the base. Printing the new path
  // there named a file the base revision has never had — `Base src/renamed-to.ts` against a revision where
  // only src/renamed-from.ts exists — so the one header that answers "what am I comparing against" was the
  // one header that could not be taken at its word. The old path rides on the change row beside the counts
  // (render-tree.ts); only a rename carries one, and every other file reads the active path as before.
  var basePath = diffBaseSidePath(activePath);
  if (beforePath) { beforePath.textContent = basePath; beforePath.title = basePath; }
  if (afterPath) { afterPath.textContent = activePath; afterPath.title = activePath; }
  // Every arrow key reaches this through setDiffCursor; rebuilding the crumb DOM per keystroke would be
  // the same answer thirty times a second. Two things can change without the path changing, and both
  // must repaint: a locale switch (which calls in with no path) and the COMMIT the review is pointed at.
  // Coming back from a History commit with ⌥A left "61139ee feat(lsp): …" in the toolbar beside "all
  // changes · origin/main → Working tree" — two statements about what you are reading, disagreeing.
  var lead = compareCommitLead();
  var leadKey = lead
    ? String(lead.sha || '') + '\u0000' + String(lead.subject || '') + '\u0000' + String(lead.others || 0)
    : '';
  if (activePath !== diffChromePath || leadKey !== diffChromeLead || !path) {
    diffChromePath = activePath;
    diffChromeLead = leadKey;
    renderCommitContext(document.getElementById('diff-commit-context'));
    renderBreadcrumb(document.getElementById('diff-breadcrumb'), activePath);
    // The diff shows no squiggles, but F2 steps problems here too (18-diagnostics.js) and ⌘6 lists them.
    // Asking as the file becomes the active one means the answer is in the cache by the time a key wants
    // it, instead of the first press reporting "still reading".
    if (activePath) fetchDiagnostics(activePath);
  }

  var previous = document.getElementById('diff-prev-change');
  var nextButton = document.getElementById('diff-next-change');
  var openSource = document.getElementById('diff-open-source');
  var disabled = hunkTotal() === 0 || !activePath;
  if (previous) previous.disabled = disabled;
  if (nextButton) nextButton.disabled = disabled;
  if (openSource) openSource.disabled = disabled;
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
var pendingScrollEl = null, pendingScrollContainer = null, pendingScrollMargin = 0, scrollElRaf = 0;
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
// scrolloffReveal keeps the caret's ROW on screen, which says nothing about where the caret sits along it:
// past the right edge of a long line the caret simply disappeared while the keys kept working. This is the
// horizontal half. The scroller is found by walking up from the caret rather than passed in, because the two
// views hang it in different places — one .d2h-file-side-diff per diff side, .source-body for source — and
// both put a .code-cursor span in the same place relative to it.
function revealCaretColumn(caret) {
  if (!caret || !caret.getBoundingClientRect) return;
  var scroller = caret.parentNode;
  while (scroller && scroller.nodeType === 1 && scroller !== document.body) {
    // scrollWidth > clientWidth alone is also true of a clipped container: scrollLeft would move it, and the
    // reader would watch a wrapped pane slide sideways for no reason. Only an element that actually scrolls
    // horizontally counts, which is what the computed overflow says.
    if (scroller.scrollWidth > scroller.clientWidth + 1) {
      var overflowX = '';
      try { overflowX = window.getComputedStyle(scroller).overflowX; } catch (e) { overflowX = ''; }
      if (overflowX === 'auto' || overflowX === 'scroll') break;
    }
    scroller = scroller.parentNode;
  }
  if (!scroller || scroller.nodeType !== 1 || scroller === document.body) return;
  var width = scroller.clientWidth;
  if (!width) return;
  // A caret one pixel inside the edge reads as already gone. Keep about ten characters of lead so holding
  // ArrowRight scrolls ahead of the caret instead of dragging it along the rim, but never more than a third
  // of a narrow pane, where that lead would be most of the view.
  var margin = Math.min(80, Math.round(width / 3));
  var origin = scroller.getBoundingClientRect().left;
  var rect = caret.getBoundingClientRect();
  var left = rect.left - origin;
  var right = rect.right - origin;
  var delta = 0;
  if (left < margin) delta = left - margin;
  else if (right > width - margin) delta = right - (width - margin);
  if (!delta) return;
  // Clamped rather than left to the browser: a caret at column 0 asks to scroll a full margin past the start
  // of the line, and "whatever the platform does with an out-of-range scrollLeft" is not a thing to depend on.
  var max = Math.max(0, scroller.scrollWidth - width);
  scroller.scrollLeft = Math.max(0, Math.min(scroller.scrollLeft + delta, max));
}

function scheduleScrollIntoView(el, scroller, marginFrac) {
  pendingScrollEl = el || null;
  pendingScrollContainer = scroller || null;
  pendingScrollMargin = Number(marginFrac) || 0;
  if (scrollElRaf) return;
  scrollElRaf = requestAnimationFrame(function () {
    scrollElRaf = 0;
    var e = pendingScrollEl; pendingScrollEl = null;
    var s = pendingScrollContainer; pendingScrollContainer = null;
    var m = pendingScrollMargin; pendingScrollMargin = 0;
    if (e && s && m > 0) scrolloffReveal(e, s, m);
    else if (e && e.scrollIntoView) { try { e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (x) {} }
  });
}

var setActiveRaf = 0, setActiveScrollPending = true, setActiveEnterAtPending = 'first';
// A viewed diff intentionally folds out of the review queue. Any navigation path that tries to activate it
// (startup restore, sidebar click, quick open, etc.) should land on the next unviewed file instead of leaving
// the content pane blank. If the whole queue is viewed, keep the requested file active so its body can remain
// inspectable as the review-complete fallback.
function preferredReviewHunk(index) {
  var total = hunkTotal();
  if (!total) return -1;
  var requested = ((index % total) + total) % total;
  if (!isFileViewed(hunkPathAt(requested) || '')) return requested;
  for (var step = 1; step < total; step++) {
    var candidate = (requested + step) % total;
    if (!isFileViewed(hunkPathAt(candidate) || '')) return candidate;
  }
  return requested;
}
function setActive(index, shouldScroll = true, allowViewed = false, enterAt = 'first') {
  if (hunkTotal() === 0) return;
  var total = hunkTotal();
  var requested = ((index % total) + total) % total;
  // F7/startup restoration follow the unviewed review queue. A direct sidebar click is different: it is
  // an explicit request to inspect that exact file, so callers may allow a viewed target and its body stays
  // visible via mc-active-diff instead of silently redirecting to another file.
  current = allowViewed ? requested : preferredReviewHunk(requested);
  // Coalesce rapid presses (holding/spamming F7 or Shift+F7) into one DOM apply per animation frame. The
  // key handler returns immediately and `current` updates synchronously (so next()/nav math stays correct),
  // while the heavy DOM work (full link/wrapper sweeps, body materialize) runs at most once per frame
  // instead of once per keystroke — the input queue never blocks and can't pile up on big repos.
  setActiveScrollPending = shouldScroll;
  setActiveEnterAtPending = enterAt;
  if (setActiveRaf) return;
  setActiveRaf = requestAnimationFrame(function () {
    setActiveRaf = 0;
    applySetActive(current, setActiveScrollPending, setActiveEnterAtPending);
  });
}
// The hunk a sidebar row really owns, or -1.
//
// Every row carries data-hunk = the index of its FIRST hunk, which for a file with no hunks of its own
// (an empty file added, a pure rename, a mode change) is simply the next file's first index — or one past
// the end when it is last. So the number alone is not enough: it has to belong to this file. Clicking
// "empty-added.txt" opened pic.png, and clicking a trailing rename did nothing, because setActive wraps an
// out-of-range index with a modulo and lands back on hunk 0.
function diffHunkForLink(link) {
  if (!link) return -1;
  const index = Number(link.dataset.hunk);
  if (!Number.isFinite(index) || index < 0 || index >= hunkTotal()) return -1;
  return hunkPathAt(index) === link.dataset.file ? index : -1;
}
// Open a file that has no hunk to aim at. The same work applySetActive does, minus everything that needs a
// hunk: there is no change block to highlight and no changed row to put the caret on.
function activateDiffFile(path, shouldScroll) {
  if (!path) return false;
  const wrapper = diffWrapperByPath(path);
  if (!wrapper) return false;
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  setTab('changes');
  links.forEach((link) => link.classList.toggle('active', link.dataset.file === path));
  syncDiffReviewChrome(path);
  rememberRecent(path, 'change');
  whenFileReady(wrapper, function () {
    showOnlyFile(path, true);
    if (shouldScroll !== false) wrapper.scrollIntoView({ block: 'start' });
  });
  return true;
}
function applySetActive(idx, shouldScroll, enterAt) {
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  setTab('changes');
  const file = hunkPathAt(idx);
  links.forEach((link) => link.classList.toggle('active', link.dataset.file === file));
  syncDiffReviewChrome(file);
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
    // Entering a file BACKWARD lands on its last change, not its first — IntelliJ's ScrollToPolicy.
    // LAST_CHANGE. Without it Shift+F7 entered at the first change and the next press left the file again,
    // so every change block after the first was unreachable going backward: walking the review backward
    // visited fewer changes than walking it forward.
    const wrap = diffWrapperByPath(file);
    const blocks = enterAt === 'last' ? changeBlockAnchors(wrap) : [];
    const lastRow = blocks.length ? changeBlockRow(wrap, blocks[blocks.length - 1]) : null;
    const targetRow = lastRow || firstChangeRowForCaret(active);
    // F7/change navigation moves the caret but must NOT pollute the Cmd+[/] cursor history.
    navSuppress = true;
    try { focusDiffRow(targetRow); } finally { navSuppress = false; }
    // Scroll inline in THIS frame, NOT via scheduleDiffScroll's extra rAF. showOnlyFile just display:none'd
    // the previous file, but the scroll container keeps its old (larger) scrollTop — so for one frame the new
    // file renders at that stale offset (≈ line 146) before a deferred scroll snaps to the change (≈ line 21):
    // the visible 146→21 double jump on F7 across a file boundary. Scrolling synchronously here lands the
    // view on the change before this frame paints, so the new file appears already at its first change.
    if (shouldScroll && targetRow && targetRow.scrollIntoView) targetRow.scrollIntoView({ block: 'center' });
    refreshFileFindForActiveView();
  });
}

// Keep the two halves of a side-by-side diff showing the SAME columns. Each `.d2h-file-side-diff` is its
// own horizontal scroller, so reading past the right edge of a long line moved one side and left the other
// where it was — the two panes stopped lining up exactly when the line was long enough to need comparing,
// which is the one thing a side-by-side view is for. (Measured on a real diff: scrolling Base to 120px left
// Working tree at 0.)
//
// Mirrored on scroll rather than locked with CSS, because each side still has to be able to reach the end
// of its own longest line, which is not the same length on both sides. The guard is a plain re-entry flag:
// setting scrollLeft fires `scroll` again, and without it the two sides push each other.
var diffScrollSyncing = false;
function syncDiffSideScroll(wrapper) {
  if (!wrapper) return;
  var sides = wrapper.querySelectorAll('.d2h-file-side-diff');
  if (sides.length < 2) return;
  sides.forEach(function (side) {
    if (side.dataset.scrollSynced === '1') return;
    side.dataset.scrollSynced = '1';
    side.addEventListener('scroll', function () {
      if (diffScrollSyncing) return;
      diffScrollSyncing = true;
      try {
        var left = side.scrollLeft;
        sides.forEach(function (other) {
          if (other === side) return;
          // Clamp to what the other side can actually reach: its longest line may be shorter, and asking
          // for more would silently park it at its own end while this one keeps going.
          var max = Math.max(0, other.scrollWidth - other.clientWidth);
          var next = Math.max(0, Math.min(left, max));
          if (Math.abs(other.scrollLeft - next) > 1) other.scrollLeft = next;
        });
      } finally {
        diffScrollSyncing = false;
      }
    }, { passive: true });
  });
}

function showOnlyFile(fileName, skipCursor) {
  if (REVIEW_LAZY) ensureFileReady(diffWrapperByPath(fileName));
  var activeWrapper = null;
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    var active = diffWrapperPathKey(wrapper) === fileName;
    wrapper.classList.toggle('df-inactive', !active);
    // When every file is viewed there is nowhere to advance. Keep the chosen reviewed file readable instead
    // of presenting a structurally valid toolbar over an empty canvas.
    wrapper.classList.toggle('mc-active-diff', active);
    if (active) activeWrapper = wrapper;
  });
  syncDiffSideScroll(activeWrapper);
  // Inactive observers deliberately defer gutter projection. Refresh only the newly visible editor; this
  // also ensures its line numbers are ready in the same animation frame as asymmetric scroll alignment.
  if (activeWrapper) scheduleLayeredDiffGutters(activeWrapper);
  scheduleAsymmetricDiffScroll();
  scheduleDiffStripe(); // the overview ruler is this file's; it is redrawn when the file changes
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
  const annotated = caretRow.getAttribute('data-review-hunk-index');
  if (annotated !== null && annotated !== '') {
    const direct = Number(annotated);
    if (Number.isFinite(direct)) return direct;
  }
  let found = -1;
  // @@ markers on the caret's side carry data-hunk-index; the nearest one at or above the caret wins.
  sideEl.querySelectorAll('[data-hunk-index]').forEach((marker) => {
    if (marker === caretRow || (caretRow.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_PRECEDING)) {
      found = Number(marker.dataset.hunkIndex);
    }
  });
  return found;
}

// Keep the whole paired hunk visually tracked as the caret moves. The guard makes ordinary Arrow key
// movement O(1): DOM classes are only rewritten when the caret actually crosses an @@ boundary.
function syncActiveDiffHunk(index) {
  var container = document.getElementById('diff2html-container');
  if (!container) return;
  var normalized = Number.isFinite(index) && index >= 0 ? index : -1;
  if (normalized === activeReviewHunkIndex
      && (normalized < 0 || container.querySelector('.mc-active-hunk[data-review-hunk-index="' + normalized + '"]'))) return;
  container.querySelectorAll('.mc-active-hunk').forEach(function (row) { row.classList.remove('mc-active-hunk'); });
  container.querySelectorAll('.hunk.active, .hunk-peer.active').forEach(function (row) { row.classList.remove('active'); });
  activeReviewHunkIndex = normalized;
  if (normalized < 0) return;
  container.querySelectorAll('[data-review-hunk-index="' + normalized + '"]').forEach(function (row) { row.classList.add('mc-active-hunk'); });
  container.querySelectorAll('[data-hunk-index="' + normalized + '"]').forEach(function (row) { row.classList.add('active'); });
}

// Row indices, one per change block — a run of change rows (ins/del) separated by context. A wide context
// window merges several edits into one @@ hunk (the default is 12 lines, so this is the normal case, not an
// edge one); stepping by these stops at each edit.
//
// A block counts when EITHER side changes at that row. Scanning only the new side skipped every block that
// exists only on the old one: a hunk that deletes a few lines and edits another is one @@ with two blocks,
// and F7 silently stepped over the deletion — a reviewer walking the review with F7 never saw the deleted
// code at all. IntelliJ's difference list is side-agnostic for the same reason (PrevNextDifferenceIterable
// walks LineFragments, each of which may be a pure deletion), so this is also what F7 means there.
function changeBlockAnchors(wrapper) {
  if (!wrapper) return [];
  if (wrapper.__anchors) return wrapper.__anchors;
  var sides = diffSideTables(wrapper);
  if (!sides.right) return []; // body not materialized yet — don't cache an empty result
  var right = diffRowsOf(sides.right);
  var left = sides.left && sides.left !== sides.right ? diffRowsOf(sides.left) : [];
  var anchors = [];
  var prev = false;
  for (var i = 0; i < right.length; i++) {
    var chg = isChangeCodeRow(right[i]) || isChangeCodeRow(left[i]);
    if (chg && !prev) anchors.push(i);
    prev = chg;
  }
  wrapper.__anchors = anchors; // change-block layout is static once materialized
  return anchors;
}

// The row to put the caret on for the change block at `index`: the new side when the change is there, the
// old side when the block is a pure deletion and the new side holds nothing but a filler. Same rule as
// firstChangeRowForCaret applies within a hunk — the caret belongs on the lines that actually changed.
// Where a change puts the caret, given the pane the reader is in. IntelliJ's policy, read off
// SimpleDiffViewer and SimpleDiffChangesHolder rather than guessed:
//
//   - Both sides' change lists hold EVERY change — `addAll` puts the same list in both and the side only
//     decides the sort order — so a deletion is a stop whichever pane you are reading in.
//   - Navigation is driven by the current side throughout: `getNonSkippedDiffChanges(getCurrentSide())`,
//     `getCurrentEditor()`, `change.getStartLine(getCurrentSide())`.
//   - `scrollToChange` moves the caret in BOTH editors and never calls `setCurrentSide`. That call belongs
//     to `scrollToLine` and to the explicit "focus opposite pane" action, which is a thing the reader asks
//     for by name.
//
// So stepping never takes the reader out of the pane they are reading. A change with no line on that side
// — a run of deleted lines asked of the working tree — puts the caret where the removed text collapsed to,
// which is the first real line after it.
//
// This file previously preferred the working-tree side and fell back to the base one, which moved the
// caret across the gutter without being asked. The stop itself is unchanged: changeBlockAnchors still reads
// both sides, and that is what makes a deletion inside an otherwise-edited hunk reachable at all.
// The INDEX, not the row, because the caller compares it with the caret's own row index and the two must
// be in one space. Returning a row and letting each caller find it again is how the backward walk broke:
// with the caret standing at the line a deletion collapsed onto — several rows past the anchor — "is there
// an earlier change" compared the anchor against the caret and found the very block the caret was already
// standing for, so Shift+F7 stepped to where it already was and the walk stopped there.
function changeRowIndexOnSide(wrapper, index, side) {
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  if (isChangeCodeRow(rows[index])) return index;
  for (var i = index; i < rows.length; i += 1) if (isDiffCodeRow(rows[i])) return i;
  // Nothing after it: a deletion at the end of a file collapses onto the line before instead.
  for (var j = index - 1; j >= 0; j -= 1) if (isDiffCodeRow(rows[j])) return j;
  return -1;
}
function changeRowOnSide(wrapper, index, side) {
  var at = changeRowIndexOnSide(wrapper, index, side);
  return at < 0 ? null : diffRowsOf(diffSideTable(wrapper, side))[at];
}
function changeBlockRow(wrapper, index) {
  var side = diffCursor && diffCursor.side === 'old' ? 'old' : 'new';
  var row = changeRowOnSide(wrapper, index, side);
  if (row) return row;
  // That pane has no code at all — a file added or removed outright. The other one is the only answer
  // there is, and standing nowhere would be worse than standing across the gutter.
  var other = changeRowOnSide(wrapper, index, side === 'new' ? 'old' : 'new');
  return other || diffRowAt(wrapper, side, index);
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
      // Each anchor compared at the row it would actually PARK the caret on, in this pane. An anchor and
      // the caret are only in the same space once both have been through changeRowIndexOnSide.
      const side = diffCursor.side === 'old' ? 'old' : 'new';
      const parks = anchors.map(function (anchor) { return changeRowIndexOnSide(w, anchor, side); });
      let target = null;
      if (delta > 0) { for (let a = 0; a < anchors.length; a++) { if (parks[a] > cur) { target = anchors[a]; break; } } }
      else { for (let b = anchors.length - 1; b >= 0; b--) { if (parks[b] >= 0 && parks[b] < cur) { target = anchors[b]; break; } } }
      if (target != null) {
        const row = changeBlockRow(w, target);
        if (row) {
          navSuppress = true;
          try { focusDiffRow(row); } finally { navSuppress = false; }
          scheduleDiffScroll(row);
          return;
        }
      }
    }
  }
  // hunk-level nav to the next/prev unviewed file.
  const caretHunk = hunkIndexAtCaret();
  const base = caretHunk >= 0 ? caretHunk : current;
  // Walked over FILES, not just hunks, so a change with no hunks of its own is not stepped past.
  const next = nextUnviewedTarget(base, activeDiffPath(), delta);
  const target = next && next.hunk >= 0 ? next.hunk : -1;
  // File boundary: no more change blocks in this file this way. The press announces "press again to go to
  // the next/previous file" on the FIRST press (a beat to mark-viewed) and only crosses on the SECOND
  // consecutive press. Already-viewed files cross immediately — no announcement. There is nothing to
  // announce either when this is the LAST file in that direction: the walk has no target, so the promise of
  // another file would be a lie.
  // Both directions announce, as in IntelliJ, which ships the message in both spellings
  // (DiffBundle: press.again.to.go.to.the.next.file / .previous.file). Backward used to cross silently,
  // which made the two keys disagree about what a file boundary is.
  // The arm records the DIRECTION as well as the path: turning around at a boundary is a new question, and
  // a Shift+F7 must not be answered by an F7's arming.
  // The `hunkPathAt(current) === diffCursor.path` guard skips the announcement while a cross is still in
  // flight: after setActive moves `current` to the next file but BEFORE its (async, lazy-loaded) caret lands,
  // diffCursor still points at the OLD file — without the guard a quick second F7 re-announced that old
  // boundary instead of letting the cross finish (the "press F7 twice more, no caret" bug).
  if (target >= 0 && diffCursor && isDiffViewVisible() && !isFileViewed(diffCursor.path)
    && hunkPathAt(current) === diffCursor.path && !diffFileHasNoHunks(activeDiffPath())) {
    const arm = diffCursor.path + (delta > 0 ? '\u0000next' : '\u0000prev');
    if (pendingFileBoundary !== arm) {
      pendingFileBoundary = arm;
      showCaretHint(t(delta > 0 ? 'diff.lastHunk' : 'diff.firstHunk')
        .replace('{key}', shortcutLabel(delta > 0 ? 'nextChange' : 'prevChange')));
      return;
    }
    pendingFileBoundary = null; // second consecutive press the same way → fall through and cross
  }
  hideCaretHint(); // about to cross files — drop the hint NOW (before the async body load) so it can't cover the next file
  // Backward entry lands on the target file's LAST change (IntelliJ's ScrollToPolicy.LAST_CHANGE), so the
  // walk back visits every change the walk forward did.
  if (target >= 0) {
    const crossed = next && next.skipped ? next.skipped : 0;
    setActive(target, true, false, delta < 0 ? 'last' : 'first');
    // After the move, so the hint is anchored to where the caret LANDED rather than where it left.
    if (crossed > 0) {
      showCaretHint(t(crossed === 1 ? 'diff.skippedViewedOne' : 'diff.skippedViewed', { n: crossed }));
    }
    return;
  }
  // A change with nothing to put a caret in: open the file itself.
  if (next && next.hunk < 0 && activateDiffFile(next.path, true)) return;
  // The walk ran off the end of the review. It used to wrap around to the other end, which reads as "the
  // review restarted" — a reviewer stepping through changes had no way to tell the last one from the first.
  // Stop at the edge instead and say why nothing moved.
  if (isDiffViewVisible()) { showCaretHint(t('diff.navEnd')); return; }
  // Every changed file is marked viewed. Inside the diff, staying put is the correct completed-review
  // behavior. From Files/source view, however, a no-op leaves the entire diff unreachable and makes F7
  // look broken. Re-enter the reviewed diff at the open file's own hunk when possible (otherwise the last
  // active hunk); preferredReviewHunk deliberately permits a viewed target when the whole queue is viewed.
  {
    var sourcePath = sourceOpenPath();
    var sourceHunk = sourcePath ? firstHunkForPath(sourcePath) : -1;
    var fallbackHunk = sourceHunk >= 0 ? sourceHunk : (base >= 0 ? base : (current >= 0 ? current : 0));
    setActive(fallbackHunk);
  }
}

// The unviewed file this press lands on, or -1 when there is none left in that direction. Deliberately a
// bounded walk rather than a modulo one: the review has a first and a last change, and F7 has to be able to
// reach the end of it.
// Every changed file in document order, with the hunks it owns.
//
// A file with none still gets a turn. F7 means "show me the next change", and an empty file added, a pure
// rename or a mode change IS a change — it is in the sidebar, the reviewer can see it sitting there. The
// hunk index cannot carry them: it is dense over real hunks and its numbers are baked into the hunk-N
// element ids, so a file with no hunks has no slot and the walk stepped straight past it. With the caret
// on the last real hunk, F7 then said "no more changes this way" while the sidebar plainly showed more.
function diffNavTargets() {
  const out = [];
  document.querySelectorAll('#diff2html-container .d2h-file-wrapper').forEach(function (w) {
    const path = diffWrapperPathKey(w);
    const own = [];
    if (REVIEW_LAZY) {
      // data-first-hunk/data-hunk-count exist only on the shells render.ts rewrites for a lazy review.
      const base = parseInt(w.dataset.firstHunk || '0', 10) || 0;
      const count = parseInt(w.dataset.hunkCount || '0', 10) || 0;
      for (let k = 0; k < count; k += 1) own.push(base + k);
    } else {
      // An eager review has no such attributes — reading them there reported every file as hunkless,
      // which would have turned the whole walk into one target per file and silenced the boundary
      // announcement everywhere. The rows themselves are the source of truth here.
      Array.prototype.forEach.call(w.querySelectorAll('.hunk'), function (row) {
        const index = hunks.indexOf(row);
        if (index >= 0) own.push(index);
      });
    }
    if (own.length) own.forEach(function (h) { out.push({ path: path, hunk: h }); });
    else out.push({ path: path, hunk: -1 });
  });
  return out;
}
// Which file the review is actually showing. `current` is a hunk index, so it is stale while a file with
// no hunks is open — and starting the walk from a stale index is how the first attempt at this skipped a
// file forwards and never reached the last one.
function activeDiffPath() {
  const active = links.find(function (link) { return link.classList.contains('active'); });
  if (active && active.dataset.file) return active.dataset.file;
  return diffCursor ? diffCursor.path : '';
}
// A changed file with no change blocks of its own — an empty file added, a pure rename, a mode change.
// There is no "last change in this file" to announce when leaving one, because it never had one.
function diffFileHasNoHunks(path) {
  if (!path) return false;
  const mine = diffNavTargets().filter(function (x) { return x.path === path; });
  return mine.length > 0 && mine.every(function (x) { return x.hunk < 0; });
}
// The next unviewed target after where the review is now, in document order.
function nextUnviewedTarget(fromHunk, fromPath, delta) {
  const targets = diffNavTargets();
  if (!targets.length) return null;
  // The FILE on screen decides where the walk starts; the caret's hunk only refines the position inside
  // it. The caret does not follow when a file with no hunks is opened — there is no row to put it on — so
  // trusting the hunk first meant the walk resumed from the file the reviewer had already left.
  let at = -1;
  const mine = [];
  if (fromPath) targets.forEach(function (x, i) { if (x.path === fromPath) mine.push(i); });
  if (mine.length) {
    const viaHunk = fromHunk >= 0
      ? targets.findIndex(function (x) { return x.hunk === fromHunk && x.path === fromPath; })
      : -1;
    at = viaHunk >= 0 ? viaHunk : (delta > 0 ? mine[mine.length - 1] : mine[0]);
  } else if (fromHunk >= 0) {
    at = targets.findIndex(function (x) { return x.hunk === fromHunk; });
  }
  if (at < 0) at = delta > 0 ? -1 : targets.length;
  // Count the FILES stepped over, not the targets: a reviewer ticking files off as they read is the normal
  // way to use this app, so the walk routinely passes several, and it passed them in silence. From the
  // outside that is F7 jumping from README.md to src/analysis.ts with three files between them still listed
  // in the sidebar — the key looks like it skipped, and there was nothing on screen to say otherwise.
  // A viewed file's diff body is display:none, so stopping in one would show an empty pane; the walk is
  // right to cross it. What was missing is saying so.
  // diffNavTargets() is one entry per FILE (the stepping between change blocks inside a file happens
  // above, in next()), so counting entries counts files — which is what the sentence is about, since a
  // file is one row in the sidebar however many blocks it holds.
  let steppedOver = 0;
  for (let i = at + delta; i >= 0 && i < targets.length; i += delta) {
    if (!isFileViewed(targets[i].path)) return { hunk: targets[i].hunk, path: targets[i].path, skipped: steppedOver };
    steppedOver += 1;
  }
  return null;
}
function nextUnviewedHunk(base, delta) {
  var total = hunkTotal();
  for (var idx = base < 0 ? initialHunkForNavigation(delta) : base + delta; idx >= 0 && idx < total; idx += delta) {
    if (!isFileViewed(hunkPathAt(idx) || '')) return idx;
  }
  return -1;
}

function initialHunkForNavigation(delta) {
  const openPath = sourceOpenPath();
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

// ---- The diff as a stack of files ---------------------------------------------------------------------
// IntelliJ's combined diff view is one scroll holding every changed file, which is what this app has always
// shown — so the actions worth porting from it are the ones that treat that scroll as a STACK: collapse the
// file you have finished with, collapse them all, and step to the next one.
//
// No new chords. ⌘. already folds "the thing the caret is in" and ⌘⇧-/⌘⌥= already collapse and expand
// "everything", and in the diff the thing the caret is in is a FILE. The keys mean the same sentence on
// both surfaces, which is why they are one row in the table and not four.
//
// Display only, and deliberately separate from Viewed. Viewed is review state — it says a human has read
// this file — and it happens to hide the body as well; a reader who collapses three files to get them out
// of the way has not reviewed them, and conflating the two would quietly tick them off.
var diffCollapsedFiles = null;
function diffCollapsedFileSet() {
  if (!diffCollapsedFiles) diffCollapsedFiles = Object.create(null);
  return diffCollapsedFiles;
}
// Put a whole folded set back at once. restoreUiState needs it: the caret restore it runs parks the caret in
// another file first, and stepping into a folded file opens it, so the reader's folds have to be re-applied
// once the caret is where it belongs rather than left as the restore happened to leave them.
function setDiffCollapsedFileSet(paths) {
  diffCollapsedFiles = Object.create(null);
  (paths || []).forEach(function (p) { if (p) diffCollapsedFiles[p] = true; });
  paintDiffFileCollapse();
}
function paintDiffFileCollapse() {
  var wrappers = document.querySelectorAll('#diff2html-container .d2h-file-wrapper');
  Array.prototype.forEach.call(wrappers, function (wrapper) {
    var key = diffWrapperPathKey(wrapper);
    var collapsed = !!(key && diffCollapsedFileSet()[key]);
    wrapper.classList.toggle('file-collapsed', collapsed);
    // Something has to be left on screen. diff2html's own file header is `display: none` here — the diff
    // shows ONE file at a time and the toolbar's breadcrumb names it — so hiding the body left the pane
    // wholly blank: no header, no disclosure control anywhere in the chrome, and nothing saying which key
    // brings it back. A collapsed file in a list is a row you can click; a collapsed file here was a
    // blank screen you had to guess your way out of.
    var note = wrapper.querySelector(':scope > .mc-file-collapsed');
    if (!collapsed) { if (note) note.remove(); return; }
    if (!note) {
      note = document.createElement('button');
      note.type = 'button';
      note.className = 'mc-file-collapsed';
      note.addEventListener('click', function () {
        delete diffCollapsedFileSet()[key];
        paintDiffFileCollapse();
      });
      wrapper.appendChild(note);
    }
    note.textContent = t('diff.fileCollapsed').replace('{file}', key).replace('{key}', shortcutLabel('toggleFold'));
  });
}
/** ⌘. in the diff: fold away the file the caret is in, or open it again. */
function toggleDiffFileCollapse() {
  if (!isDiffViewVisible()) return false;
  var wrapper = diffActiveWrapper();
  var key = wrapper ? diffWrapperPathKey(wrapper) : '';
  if (!key) return false;
  var set = diffCollapsedFileSet();
  if (set[key]) delete set[key];
  else set[key] = true;
  paintDiffFileCollapse();
  return true;
}
/** ⌘⇧- / ⌘⌥= in the diff: every file at once. */
function setAllDiffFilesCollapsed(collapsed) {
  if (!isDiffViewVisible()) return false;
  var wrappers = document.querySelectorAll('#diff2html-container .d2h-file-wrapper');
  if (!wrappers.length) return false;
  var set = diffCollapsedFileSet();
  Array.prototype.forEach.call(wrappers, function (wrapper) {
    var key = diffWrapperPathKey(wrapper);
    if (!key) return;
    if (collapsed) set[key] = true;
    else delete set[key];
  });
  paintDiffFileCollapse();
  return true;
}
/**
 * ⌘⇧→ / ⌘⇧← : the next or previous file in the stack — IntelliJ's Compare Next/Previous File, on the
 * chords `$default.xml` gives them (⌃⇧→ / ⌃⇧←).
 *
 * The caret lands on the file's first code row, not on its header: a header is not a position a reader can
 * read from, and every other jump in this app leaves the caret somewhere it can press an arrow next.
 */
function goToDiffFile(delta) {
  if (!isDiffViewVisible()) return false;
  var wrappers = Array.prototype.slice.call(document.querySelectorAll('#diff2html-container .d2h-file-wrapper'));
  if (wrappers.length < 2) return false;
  var current = diffActiveWrapper();
  var at = wrappers.indexOf(current);
  var next = wrappers[(at < 0 ? 0 : at + (delta > 0 ? 1 : -1) + wrappers.length) % wrappers.length];
  var key = next ? diffWrapperPathKey(next) : '';
  if (!key) return false;
  // Stepping INTO a collapsed file opens it: the alternative is a jump that appears to do nothing, which
  // is the same reason navigating into a folded region opens it in the source view.
  if (diffCollapsedFileSet()[key]) { delete diffCollapsedFileSet()[key]; paintDiffFileCollapse(); }
  // Materialize FIRST. A lazy review keeps every file it has not shown as an empty shell, so reading rows
  // off `next` answered zero for all but the two or three files already visited — and the key then
  // declined and fell through to ⌘⇧Arrow's line-edge selection, which silently selected text instead of
  // moving. Measured on a 30-file review: 28 of them unreachable with this chord.
  revealDiffFile(key);
  whenFileReady(next, function () {
    // Re-resolve by PATH rather than trusting the element captured above: a cold lazy body is fetched over
    // IPC, and a watch rebuild landing in that window replaces every wrapper — leaving this reading rows
    // off a detached table and handing a row index from it to setDiffCursor, which would clamp that index
    // against a different file's row count.
    var live = diffWrapperByPath(key);
    if (!live) return;
    var side = diffCursor && diffCursor.side === 'old' ? 'old' : 'new';
    var rows = diffRowsOf(diffSideTable(live, side));
    var rowIndex = rows.findIndex(function (row) { return isDiffCodeRow(row); });
    if (rowIndex < 0) {
      side = side === 'new' ? 'old' : 'new';
      rows = diffRowsOf(diffSideTable(live, side));
      rowIndex = rows.findIndex(function (row) { return isDiffCodeRow(row); });
    }
    // A file with no code row at all — a pure rename, a binary. Revealing it IS the answer to "go to the
    // next file"; there is simply nowhere inside it to put a caret.
    if (rowIndex >= 0) setDiffCursor(key, side, rowIndex, 0, true);
  });
  return true;
}
