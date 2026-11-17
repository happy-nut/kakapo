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

function isChangeCodeRow(row) {
  return !!(row && isDiffCodeRow(row) && row.querySelector('.d2h-ins, .d2h-del, ins, del'));
}
function firstChangeRowForCaret(hunkRow) {
  const wrapper = hunkRow.closest('.d2h-file-wrapper');
  const sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  const hunkSideEl = hunkRow.closest('.d2h-file-side-diff');
  if (sides.length >= 2 && hunkSideEl) {
    const hunkRows = Array.from(hunkSideEl.querySelectorAll('tr'));
    const otherEl = hunkSideEl === sides[0] ? sides[1] : sides[0];
    const otherRows = Array.from(otherEl.querySelectorAll('tr'));
    for (let i = hunkRows.indexOf(hunkRow) + 1; i < hunkRows.length; i++) {
      const hr = hunkRows[i];
      if (hr.classList.contains('hunk') || hr.classList.contains('hunk-peer')) break;
      if (isChangeCodeRow(otherRows[i])) return otherRows[i];
      if (isChangeCodeRow(hr)) {
        for (let f = i; f < otherRows.length; f++) if (isDiffCodeRow(otherRows[f])) return otherRows[f];
        for (let b = i - 1; b >= 0; b--) if (isDiffCodeRow(otherRows[b])) return otherRows[b];
        return hr;
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
  const navInfo = diffRowInfoFromNode(row);
  if (navInfo && navInfo.path) {
    let navSide = navInfo.side;
    if (navSide === 'old') {
      const navWrap = diffWrapperByPath(navInfo.path);
      if (isDiffCodeRow(navWrap ? diffRowAt(navWrap, 'new', navInfo.rowIndex) : null)) navSide = 'new';
    }
    setDiffCursor(navInfo.path, navSide, navInfo.rowIndex, 0, false);
  }
}

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
    subject.title = lead.subject;
    container.appendChild(subject);
  }
  if (lead.others > 0) {
    const more = document.createElement('span');
    more.className = 'crumb-count';
    more.textContent = t('compare.andMore', { n: lead.others });
    container.appendChild(more);
  }
}
function renderBreadcrumb(container, path) {
  if (!container) return;
  container.textContent = '';
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

function appendBreadcrumbStat(container, path) {
  if (!path) return;
  var row = Array.prototype.find.call(document.querySelectorAll('.change-row'), function (el) {
    return el.dataset.file === path;
  });
  var added = Number(row && row.dataset.added) || 0;
  var deleted = Number(row && row.dataset.deleted) || 0;
  if (!added && !deleted) return;
  var stat = document.createElement('span');
  stat.className = 'crumb-stat';
  var plus = document.createElement('span');
  plus.className = 'crumb-stat-add';
  plus.textContent = '+' + added;
  var minus = document.createElement('span');
  minus.className = 'crumb-stat-del';
  minus.textContent = '\u2212' + deleted;
  stat.appendChild(plus);
  stat.appendChild(minus);
  container.appendChild(stat);
}

function diffBaseSidePath(path) {
  if (!path) return path;
  var row = Array.prototype.find.call(document.querySelectorAll('.change-row'), function (el) {
    return el.dataset.file === path;
  });
  return (row && row.dataset.oldPath) || path;
}

var diffChromePath = null;
var diffChromeLead = null;
function syncDiffReviewChrome(path) {
  var empty = !document.querySelector('#diff2html-container .d2h-file-wrapper');
  var activePath = empty ? '' : (path || (diffCursor && diffCursor.path) || hunkPathAt(current) || '');
  var beforePath = document.getElementById('diff-before-path');
  var afterPath = document.getElementById('diff-after-path');
  var afterKind = document.getElementById('diff-after-kind');
  if (afterKind) {
    var target = patchSetData && patchSetData.activeTarget;
    if (target && target !== 'worktree') {
      afterKind.setAttribute('data-i18n', 'diff.target');
      afterKind.textContent = t('diff.target');
    } else if (afterKind.getAttribute('data-i18n') !== 'diff.workingTree') {
      afterKind.setAttribute('data-i18n', 'diff.workingTree');
      afterKind.textContent = t('diff.workingTree');
    }
  }
  var basePath = diffBaseSidePath(activePath);
  if (beforePath) { beforePath.textContent = basePath; beforePath.title = basePath; }
  if (afterPath) { afterPath.textContent = activePath; afterPath.title = activePath; }
  var lead = compareCommitLead();
  var leadKey = lead
    ? String(lead.sha || '') + '\u0000' + String(lead.subject || '') + '\u0000' + String(lead.others || 0)
    : '';
  if (activePath !== diffChromePath || leadKey !== diffChromeLead || !path) {
    diffChromePath = activePath;
    diffChromeLead = leadKey;
    renderCommitContext(document.getElementById('diff-commit-context'));
    renderBreadcrumb(document.getElementById('diff-breadcrumb'), activePath);
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

var pendingScrollEl = null, pendingScrollContainer = null, pendingScrollMargin = 0, scrollElRaf = 0;
function scrolloffReveal(el, scroller, marginFrac) {
  if (!el || !scroller || !scroller.clientHeight) return;
  var top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  var rowH = el.offsetHeight || 18;
  var ch = scroller.clientHeight;
  var margin = Math.round(ch * marginFrac);
  if (top < margin) scroller.scrollTop += top - margin;
  else if (top + rowH > ch - margin) scroller.scrollTop += (top + rowH) - (ch - margin);
}
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
  var margin = Math.min(80, Math.round(width / 3));
  var origin = scroller.getBoundingClientRect().left;
  var rect = caret.getBoundingClientRect();
  var left = rect.left - origin;
  var right = rect.right - origin;
  var delta = 0;
  if (left < margin) delta = left - margin;
  else if (right > width - margin) delta = right - (width - margin);
  if (!delta) return;
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
  current = allowViewed ? requested : preferredReviewHunk(requested);
  setActiveScrollPending = shouldScroll;
  setActiveEnterAtPending = enterAt;
  if (setActiveRaf) return;
  setActiveRaf = requestAnimationFrame(function () {
    setActiveRaf = 0;
    applySetActive(current, setActiveScrollPending, setActiveEnterAtPending);
  });
}
function diffHunkForLink(link) {
  if (!link) return -1;
  const index = Number(link.dataset.hunk);
  if (!Number.isFinite(index) || index < 0 || index >= hunkTotal()) return -1;
  return hunkPathAt(index) === link.dataset.file ? index : -1;
}
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
  whenFileReady(diffWrapperByPath(file), function () {
    showOnlyFile(file, true);
    const active = document.getElementById('hunk-' + idx);
    if (!active) return;
    if (REVIEW_LAZY) {
      document.querySelectorAll('#diff2html-container .hunk.active, #diff2html-container .hunk-peer.active').forEach((h) => h.classList.remove('active'));
      document.querySelectorAll('#diff2html-container [data-hunk-index="' + idx + '"]').forEach((h) => h.classList.add('active'));
    } else {
      hunks.forEach((hunk, i) => hunk.classList.toggle('active', i === idx));
      hunkPeers.forEach((hunk) => hunk.classList.toggle('active', Number(hunk.dataset.hunkIndex) === idx));
    }
    const wrap = diffWrapperByPath(file);
    const blocks = enterAt === 'last' ? changeBlockAnchors(wrap) : [];
    const lastRow = blocks.length ? changeBlockRow(wrap, blocks[blocks.length - 1]) : null;
    const targetRow = lastRow || firstChangeRowForCaret(active);
    navSuppress = true;
    try { focusDiffRow(targetRow); } finally { navSuppress = false; }
    if (shouldScroll && targetRow && targetRow.scrollIntoView) targetRow.scrollIntoView({ block: 'center' });
    refreshFileFindForActiveView();
  });
}

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
    wrapper.classList.toggle('mc-active-diff', active);
    if (active) activeWrapper = wrapper;
  });
  syncDiffSideScroll(activeWrapper);
  if (activeWrapper) scheduleLayeredDiffGutters(activeWrapper);
  scheduleAsymmetricDiffScroll();
  scheduleDiffStripe();
  if (!skipCursor) ensureDiffCursor();
}

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
  sideEl.querySelectorAll('[data-hunk-index]').forEach((marker) => {
    if (marker === caretRow || (caretRow.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_PRECEDING)) {
      found = Number(marker.dataset.hunkIndex);
    }
  });
  return found;
}

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

function changeBlockAnchors(wrapper) {
  if (!wrapper) return [];
  if (wrapper.__anchors) return wrapper.__anchors;
  var sides = diffSideTables(wrapper);
  if (!sides.right) return [];
  var right = diffRowsOf(sides.right);
  var left = sides.left && sides.left !== sides.right ? diffRowsOf(sides.left) : [];
  var anchors = [];
  var prev = false;
  for (var i = 0; i < right.length; i++) {
    var chg = isChangeCodeRow(right[i]) || isChangeCodeRow(left[i]);
    if (chg && !prev) anchors.push(i);
    prev = chg;
  }
  wrapper.__anchors = anchors;
  return anchors;
}

function changeRowIndexOnSide(wrapper, index, side) {
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  if (isChangeCodeRow(rows[index])) return index;
  for (var i = index; i < rows.length; i += 1) if (isDiffCodeRow(rows[i])) return i;
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
  var other = changeRowOnSide(wrapper, index, side === 'new' ? 'old' : 'new');
  return other || diffRowAt(wrapper, side, index);
}

var pendingFileBoundary = null;
function next(delta) {
  if (hunkTotal() === 0) return;
  if (diffCursor && isDiffViewVisible()) {
    const w = diffWrapperByPath(diffCursor.path);
    if (w && !isFileViewed(diffCursor.path)) {
      const anchors = changeBlockAnchors(w);
      const cur = diffCursor.rowIndex;
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
  const caretHunk = hunkIndexAtCaret();
  const base = caretHunk >= 0 ? caretHunk : current;
  const next = nextUnviewedTarget(base, activeDiffPath(), delta);
  const target = next && next.hunk >= 0 ? next.hunk : -1;
  if (target >= 0 && diffCursor && isDiffViewVisible() && !isFileViewed(diffCursor.path)
    && hunkPathAt(current) === diffCursor.path && !diffFileHasNoHunks(activeDiffPath())) {
    const arm = diffCursor.path + (delta > 0 ? '\u0000next' : '\u0000prev');
    if (pendingFileBoundary !== arm) {
      pendingFileBoundary = arm;
      showCaretHint(t(delta > 0 ? 'diff.lastHunk' : 'diff.firstHunk')
        .replace('{key}', shortcutLabel(delta > 0 ? 'nextChange' : 'prevChange')));
      return;
    }
    pendingFileBoundary = null;
  }
  hideCaretHint();
  if (target >= 0) {
    const crossed = next && next.skipped ? next.skipped : 0;
    setActive(target, true, false, delta < 0 ? 'last' : 'first');
    if (crossed > 0) {
      showCaretHint(t(crossed === 1 ? 'diff.skippedViewedOne' : 'diff.skippedViewed', { n: crossed }));
    }
    return;
  }
  if (next && next.hunk < 0 && activateDiffFile(next.path, true)) return;
  if (isDiffViewVisible()) { showCaretHint(t('diff.navEnd')); return; }
  {
    var sourcePath = sourceOpenPath();
    var sourceHunk = sourcePath ? firstHunkForPath(sourcePath) : -1;
    var fallbackHunk = sourceHunk >= 0 ? sourceHunk : (base >= 0 ? base : (current >= 0 ? current : 0));
    setActive(fallbackHunk);
  }
}

function diffNavTargets() {
  const out = [];
  document.querySelectorAll('#diff2html-container .d2h-file-wrapper').forEach(function (w) {
    const path = diffWrapperPathKey(w);
    const own = [];
    if (REVIEW_LAZY) {
      const base = parseInt(w.dataset.firstHunk || '0', 10) || 0;
      const count = parseInt(w.dataset.hunkCount || '0', 10) || 0;
      for (let k = 0; k < count; k += 1) own.push(base + k);
    } else {
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
function activeDiffPath() {
  const active = links.find(function (link) { return link.classList.contains('active'); });
  if (active && active.dataset.file) return active.dataset.file;
  return diffCursor ? diffCursor.path : '';
}
function diffFileHasNoHunks(path) {
  if (!path) return false;
  const mine = diffNavTargets().filter(function (x) { return x.path === path; });
  return mine.length > 0 && mine.every(function (x) { return x.hunk < 0; });
}
function nextUnviewedTarget(fromHunk, fromPath, delta) {
  const targets = diffNavTargets();
  if (!targets.length) return null;
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

var diffCollapsedFiles = null;
function diffCollapsedFileSet() {
  if (!diffCollapsedFiles) diffCollapsedFiles = Object.create(null);
  return diffCollapsedFiles;
}
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
function goToDiffFile(delta) {
  if (!isDiffViewVisible()) return false;
  var wrappers = Array.prototype.slice.call(document.querySelectorAll('#diff2html-container .d2h-file-wrapper'));
  if (wrappers.length < 2) return false;
  var current = diffActiveWrapper();
  var at = wrappers.indexOf(current);
  var next = wrappers[(at < 0 ? 0 : at + (delta > 0 ? 1 : -1) + wrappers.length) % wrappers.length];
  var key = next ? diffWrapperPathKey(next) : '';
  if (!key) return false;
  if (diffCollapsedFileSet()[key]) { delete diffCollapsedFileSet()[key]; paintDiffFileCollapse(); }
  revealDiffFile(key);
  whenFileReady(next, function () {
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
    if (rowIndex >= 0) setDiffCursor(key, side, rowIndex, 0, true);
  });
  return true;
}
