if (!REVIEW_LAZY) prepareDiff2HtmlHunks();
const hunks = REVIEW_LAZY ? [] : Array.from(document.querySelectorAll('.hunk'));
const hunkPeers = REVIEW_LAZY ? [] : Array.from(document.querySelectorAll('.hunk-peer'));
var activeReviewHunkIndex = -1;
const hunkMeta = [];
if (REVIEW_LAZY) {
  Array.prototype.forEach.call(document.querySelectorAll('#diff2html-container .d2h-file-wrapper'), function (w) {
    var base = parseInt(w.dataset.firstHunk || '0', 10) || 0;
    var cnt = parseInt(w.dataset.hunkCount || '0', 10) || 0;
    var p = diffWrapperPathKey(w);
    for (var k = 0; k < cnt; k++) hunkMeta[base + k] = { path: p };
  });
}
var diffBootDone = false;
function refreshHunkIndex() {
  activeReviewHunkIndex = -1;
  if (REVIEW_LAZY) {
    hunkMeta.length = 0;
    Array.prototype.forEach.call(document.querySelectorAll('#diff2html-container .d2h-file-wrapper'), function (w) {
      var base = parseInt(w.dataset.firstHunk || '0', 10) || 0;
      var cnt = parseInt(w.dataset.hunkCount || '0', 10) || 0;
      var p = diffWrapperPathKey(w);
      for (var k = 0; k < cnt; k++) hunkMeta[base + k] = { path: p };
    });
  } else {
    prepareDiff2HtmlHunks();
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
function diffSideRowPairs(wrapper) {
  var sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  if (sides.length < 2) return null;
  var cleanRows = function (side) {
    return Array.prototype.slice.call(side.querySelectorAll('tr')).filter(function (row) {
      return !row.classList.contains('mc-comment-row') && !row.classList.contains('mc-spacer-row');
    });
  };
  return { sides: sides, oldRows: cleanRows(sides[0]), newRows: cleanRows(sides[sides.length - 1]) };
}
function annotateDiffHunkRows(wrapper) {
  resetDiffImportFolds(wrapper);
  var pairs = diffSideRowPairs(wrapper);
  if (!pairs) return;
  var sides = pairs.sides;
  var oldRows = pairs.oldRows;
  var newRows = pairs.newRows;
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
  installLayeredDiffGutters(wrapper, true);
  var oldContent = sides[0].querySelector('.mc-diff-layer-stack') || sides[0].querySelector('.d2h-code-wrapper') || sides[0].querySelector('.d2h-diff-table');
  var newContent = sides[sides.length - 1].querySelector('.mc-diff-layer-stack') || sides[sides.length - 1].querySelector('.d2h-code-wrapper') || sides[sides.length - 1].querySelector('.d2h-diff-table');
  [oldContent, newContent].forEach(function (content) {
    if (!content) return;
    content.classList.toggle('mc-asymmetric-scroll-content', insertionGaps.length > 0 || deletionGaps.length > 0);
    content.style.transform = '';
  });
  var alignmentAnchors = [];
  for (var anchorIndex = 0; anchorIndex < Math.min(oldRows.length, newRows.length); anchorIndex++) {
    var anchorOld = oldRows[anchorIndex], anchorNew = newRows[anchorIndex];
    if (!anchorOld || !anchorNew || anchorOld.classList.contains('mc-diff-change') || anchorNew.classList.contains('mc-diff-change')) continue;
    var oldNumber = anchorOld.querySelector('.d2h-code-side-linenumber');
    var newNumber = anchorNew.querySelector('.d2h-code-side-linenumber');
    if (!oldNumber || !newNumber || !String(oldNumber.textContent || '').trim() || !String(newNumber.textContent || '').trim()) continue;
    alignmentAnchors.push({ oldRow: anchorOld, newRow: anchorNew, kind: 'shared-row' });
  }
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
  paintDiffSemanticTokens(wrapper, oldRows, newRows);
  decorateDiffContextFolds(wrapper, oldRows, newRows);
  decorateDiffImportFold(wrapper, oldRows, newRows);
  decorateDiffHttpRuns(wrapper);
  refreshLayeredDiffGutters(wrapper);
  scheduleAsymmetricDiffScroll();
}
