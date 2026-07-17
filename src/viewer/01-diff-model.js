// Builds the semantic row/hunk model consumed by navigation, layered gutters, and the
// asymmetric alignment engine. This is the only slice that classifies diff2html rows.
if (!REVIEW_LAZY) prepareDiff2HtmlHunks();
const hunks = REVIEW_LAZY ? [] : Array.from(document.querySelectorAll('.hunk'));
const hunkPeers = REVIEW_LAZY ? [] : Array.from(document.querySelectorAll('.hunk-peer'));
var activeReviewHunkIndex = -1;
// Lazy mode: each file body lives in an inert <script type="text/html"> island (see splitDiffForLazy).
// Build a hunk index from the lightweight shells (data-first-hunk/data-hunk-count/data-path) so F7 and
// change-nav work without materializing everything. hunkRowAt() materializes the target file on demand.
const hunkMeta = [];
if (REVIEW_LAZY) {
  Array.prototype.forEach.call(document.querySelectorAll('#diff2html-container .d2h-file-wrapper'), function (w) {
    var base = parseInt(w.dataset.firstHunk || '0', 10) || 0;
    var cnt = parseInt(w.dataset.hunkCount || '0', 10) || 0;
    var p = w.dataset.path || ((w.querySelector('.d2h-file-name') || {}).textContent || '').trim();
    for (var k = 0; k < cnt; k++) hunkMeta[base + k] = { path: p };
  });
}
var diffBootDone = false;
// Rebuild the hunk index from the CURRENT diff DOM. `hunks`/`hunkPeers`/`hunkMeta` are captured once at
// init; after an in-place watch swap (applyDiffUpdate) the DOM holds new wrappers/rows, so without this
// hunkTotal()/hunkPathAt() keep reporting the OLD build — F7 and showDiffView then target vanished indices
// and the diff pane goes blank. Mutates the const arrays in place so existing references stay valid.
function refreshHunkIndex() {
  activeReviewHunkIndex = -1;
  if (REVIEW_LAZY) {
    hunkMeta.length = 0;
    Array.prototype.forEach.call(document.querySelectorAll('#diff2html-container .d2h-file-wrapper'), function (w) {
      var base = parseInt(w.dataset.firstHunk || '0', 10) || 0;
      var cnt = parseInt(w.dataset.hunkCount || '0', 10) || 0;
      var p = w.dataset.path || ((w.querySelector('.d2h-file-name') || {}).textContent || '').trim();
      for (var k = 0; k < cnt; k++) hunkMeta[base + k] = { path: p };
    });
  } else {
    prepareDiff2HtmlHunks(); // (re)tag .hunk/.hunk-peer rows + file ids on the new DOM
    hunks.length = 0;
    Array.prototype.push.apply(hunks, document.querySelectorAll('.hunk'));
    hunkPeers.length = 0;
    Array.prototype.push.apply(hunkPeers, document.querySelectorAll('.hunk-peer'));
  }
}
function hunkTotal() { return REVIEW_LAZY ? hunkMeta.length : hunks.length; }
function hunkPathAt(i) { return REVIEW_LAZY ? (hunkMeta[i] ? hunkMeta[i].path : '') : (hunks[i] ? hunks[i].dataset.file : ''); }
function hunkRowAt(i) {
  if (!REVIEW_LAZY) return hunks[i] || null;
  var meta = hunkMeta[i];
  if (!meta) return null;
  ensureFileReady(diffWrapperByPath(meta.path));
  return document.getElementById('hunk-' + i);
}
// diff2html aligns the old/new tables row-for-row. Carry each @@ hunk id through those paired rows and
// classify every changed pair once so CSS can paint semantic code bands while the curved overlay owns the
// neutral centre line-number gutters. Replacements stay blue on both sides, deletions are neutral gray,
// and insertions keep their empty old-side peer neutral while the actual new-side source is green.
function annotateDiffHunkRows(wrapper) {
  resetDiffImportFolds(wrapper);
  var sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  if (sides.length < 2) return;
  var cleanRows = function (side) {
    return Array.prototype.slice.call(side.querySelectorAll('tr')).filter(function (row) {
      return !row.classList.contains('mc-comment-row') && !row.classList.contains('mc-spacer-row');
    });
  };
  var oldRows = cleanRows(sides[0]);
  var newRows = cleanRows(sides[sides.length - 1]);
  // diff2html emits the number cell first on both sides. IntelliJ places old numbers at the RIGHT edge
  // of the left editor and new numbers at the LEFT edge of the right editor, so make that order explicit
  // in the table DOM instead of relying on absolute-positioned table cells (Chromium keeps their static
  // table position even when `right: 0` is computed).
  oldRows.forEach(function (row) {
    var number = row.querySelector('.d2h-code-side-linenumber');
    if (number && number !== row.lastElementChild) row.appendChild(number);
  });
  newRows.forEach(function (row) {
    var number = row.querySelector('.d2h-code-side-linenumber');
    if (number && number !== row.firstElementChild) row.insertBefore(number, row.firstElementChild);
  });
  var semanticClasses = ['mc-diff-change', 'mc-diff-modified', 'mc-diff-deleted', 'mc-diff-added', 'mc-change-start', 'mc-change-end', 'mc-diff-hunk-row', 'mc-active-hunk', 'mc-asymmetric-insert-gap', 'mc-asymmetric-delete-gap', 'mc-asymmetric-insert-resume', 'mc-asymmetric-insert-tail'];
  oldRows.concat(newRows).forEach(function (row) {
    semanticClasses.forEach(function (name) { row.classList.remove(name); });
    row.removeAttribute('data-review-hunk-index');
  });

  // The working tree is the canonical vertical timeline. Pure insertions therefore do not need a tall
  // stack of empty rows in the base editor: collapse those positional peers, retain their DOM indices for
  // caret/comment mapping, and record the right-side run so scrollAsymmetricDiff() can hold the base editor
  // still while the working tree advances through it (the same visual model as IntelliJ's side-by-side diff).
  var insertionGaps = [];
  var deletionGaps = [];
  var openInsertionGap = null;
  var closeInsertionGap = function () {
    if (openInsertionGap) insertionGaps.push(openInsertionGap);
    openInsertionGap = null;
  };
  var connectorRuns = [];
  var openConnectorRun = null;
  var closeConnectorRun = function () {
    if (!openConnectorRun) return;
    openConnectorRun.kind = openConnectorRun.hasOld && openConnectorRun.hasNew
      ? 'modified'
      : (openConnectorRun.hasNew ? 'added' : 'deleted');
    connectorRuns.push(openConnectorRun);
    openConnectorRun = null;
  };

  var currentHunk = '';
  var previousType = '';
  var previousPair = [];
  var addPairClass = function (pair, name) {
    pair.forEach(function (row) { if (row) row.classList.add(name); });
  };
  var count = Math.max(oldRows.length, newRows.length);
  for (var i = 0; i < count; i++) {
    var oldRow = oldRows[i] || null;
    var newRow = newRows[i] || null;
    var marker = (oldRow && oldRow.hasAttribute('data-hunk-index') && oldRow)
      || (newRow && newRow.hasAttribute('data-hunk-index') && newRow);
    if (marker) currentHunk = marker.getAttribute('data-hunk-index') || '';
    var pair = [oldRow, newRow];
    if (currentHunk !== '') {
      pair.forEach(function (row) {
        if (!row) return;
        row.classList.add('mc-diff-hunk-row');
        row.setAttribute('data-review-hunk-index', currentHunk);
      });
    }

    var hasOld = !!(oldRow && oldRow.querySelector('td.d2h-del:not(.d2h-emptyplaceholder)'));
    var hasNew = !!(newRow && newRow.querySelector('td.d2h-ins:not(.d2h-emptyplaceholder)'));
    var type = hasOld && hasNew ? 'modified' : (hasOld ? 'deleted' : (hasNew ? 'added' : ''));
    if (type) {
      if (!openConnectorRun) {
        openConnectorRun = {
          startIndex: i,
          endIndex: i,
          oldRealRows: [],
          newRealRows: [],
          hasOld: false,
          hasNew: false,
        };
      }
      openConnectorRun.endIndex = i;
      if (hasOld && oldRow) { openConnectorRun.oldRealRows.push(oldRow); openConnectorRun.hasOld = true; }
      if (hasNew && newRow) { openConnectorRun.newRealRows.push(newRow); openConnectorRun.hasNew = true; }
    } else {
      closeConnectorRun();
    }
    var isPureInsertion = type === 'added' && !!(oldRow && oldRow.querySelector('.d2h-emptyplaceholder, .d2h-code-side-emptyplaceholder'));
    var isPureDeletion = type === 'deleted' && !!(newRow && newRow.querySelector('.d2h-emptyplaceholder, .d2h-code-side-emptyplaceholder'));
    if (isPureInsertion) {
      oldRow.classList.add('mc-asymmetric-insert-gap');
      if (!openInsertionGap) openInsertionGap = { startIndex: i, endIndex: i, firstNewRow: newRow, lastNewRow: newRow };
      else { openInsertionGap.endIndex = i; openInsertionGap.lastNewRow = newRow; }
    } else {
      closeInsertionGap();
    }
    // Removed base-only lines belong in the old editor and connector, not as gray blank rows between two
    // consecutive working-tree lines. Keep the positional peer for caret/comment mapping, but remove it
    // from layout just like an insertion's empty base peer. Shared-row anchors below compensate the base
    // layer with a signed transform after this compact deletion.
    if (isPureDeletion) {
      newRow.classList.add('mc-asymmetric-delete-gap');
      deletionGaps.push({ index: i, oldRow: oldRow, newRow: newRow });
    }
    if (!type) {
      if (previousType) addPairClass(previousPair, 'mc-change-end');
      previousType = '';
      previousPair = [];
      continue;
    }
    addPairClass(pair, 'mc-diff-change');
    addPairClass(pair, 'mc-diff-' + type);
    if (type !== previousType) {
      if (previousType) addPairClass(previousPair, 'mc-change-end');
      addPairClass(pair, 'mc-change-start');
    }
    previousType = type;
    previousPair = pair;
  }
  closeInsertionGap();
  closeConnectorRun();
  if (previousType) addPairClass(previousPair, 'mc-change-end');
  insertionGaps.forEach(function (gap) {
    var resume = oldRows[gap.endIndex + 1] || null;
    if (resume) resume.classList.add('mc-asymmetric-insert-resume');
    else {
      var tail = oldRows[gap.startIndex - 1] || null;
      if (tail) tail.classList.add('mc-asymmetric-insert-tail');
    }
  });
  // Replace diff2html's visible per-row number cells with one gutter layer per pane before the alignment
  // state captures its transform target. The stack contains BOTH code and gutter, so vertical correction
  // can never make the line numbers trail the source by a frame.
  // Only create the shared stack here. Import/context decoration below can still hide rows, so measuring
  // now would build the gutter twice. The single refresh at the end sees the final row layout.
  installLayeredDiffGutters(wrapper, true);
  var oldContent = sides[0].querySelector('.mc-diff-layer-stack') || sides[0].querySelector('.d2h-code-wrapper') || sides[0].querySelector('.d2h-diff-table');
  var newContent = sides[sides.length - 1].querySelector('.mc-diff-layer-stack') || sides[sides.length - 1].querySelector('.d2h-code-wrapper') || sides[sides.length - 1].querySelector('.d2h-diff-table');
  [oldContent, newContent].forEach(function (content) {
    if (!content) return;
    content.classList.toggle('mc-asymmetric-scroll-content', insertionGaps.length > 0 || deletionGaps.length > 0);
    content.style.transform = '';
  });
  // Real shared rows are stronger alignment evidence than an accumulated line-height estimate. Keeping
  // these anchors lets scrollAsymmetricDiff correct sub-pixel/border drift at the reader's current position.
  var alignmentAnchors = [];
  for (var anchorIndex = 0; anchorIndex < Math.min(oldRows.length, newRows.length); anchorIndex++) {
    var anchorOld = oldRows[anchorIndex], anchorNew = newRows[anchorIndex];
    if (!anchorOld || !anchorNew || anchorOld.classList.contains('mc-diff-change') || anchorNew.classList.contains('mc-diff-change')) continue;
    var oldNumber = anchorOld.querySelector('.d2h-code-side-linenumber');
    var newNumber = anchorNew.querySelector('.d2h-code-side-linenumber');
    if (!oldNumber || !newNumber || !String(oldNumber.textContent || '').trim() || !String(newNumber.textContent || '').trim()) continue;
    alignmentAnchors.push({ oldRow: anchorOld, newRow: anchorNew, kind: 'shared-row' });
  }
  // A large replacement can contain a stable symbol boundary that diff2html still marks as changed (for
  // example the unchanged `def _exit_intents(` below a rewritten method). Pair unique, substantial source
  // lines across the two compact editors so that boundary becomes an exact scroll anchor as well. This is
  // intentionally conservative: duplicate/short lines and reordered crossings are discarded.
  semanticDiffAlignmentAnchors(oldRows, newRows).forEach(function (anchor) {
    var duplicate = alignmentAnchors.some(function (existing) {
      return existing.oldRow === anchor.oldRow && existing.newRow === anchor.newRow;
    });
    if (!duplicate) alignmentAnchors.push(anchor);
  });
  wrapper.__asymmetricDiffState = oldContent && newContent ? {
    gaps: insertionGaps,
    deletionGaps: deletionGaps,
    content: oldContent,
    oldContent: oldContent,
    newContent: newContent,
    anchors: alignmentAnchors,
    connectorRuns: connectorRuns,
    oldRows: oldRows,
    newRows: newRows,
    offset: 0,
    newOffset: 0,
    referenceSide: 'new',
    initialized: false,
  } : null;
  decorateDiffContextFolds(wrapper, oldRows, newRows);
  decorateDiffImportFold(wrapper, oldRows, newRows);
  refreshLayeredDiffGutters(wrapper);
  scheduleAsymmetricDiffScroll();
}
