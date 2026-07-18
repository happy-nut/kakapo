// Asymmetric side-by-side alignment engine. The pane under the pointer or caret owns the
// scroll timeline; the opposite pane catches up through stable semantic anchors. Keeping
// geometry, connector rendering, and scroll ownership together prevents ordinary UI state
// in 01-core.js from accidentally forcing layout during a scroll frame.
var asymmetricDiffScrollRaf = 0;
function asymmetricGapProgress(y, start, end) {
  return Math.max(0, Math.min(y - start, Math.max(0, end - start)));
}
function diffAlignmentLineText(row) {
  var content = row && row.querySelector('.d2h-code-line-ctn');
  return content ? String(content.textContent || '').trim().replace(/\s+/g, ' ') : '';
}
function semanticDiffAlignmentAnchors(oldRows, newRows) {
  var collect = function (rows) {
    var values = new Map();
    rows.forEach(function (row, index) {
      var number = row && row.querySelector('.d2h-code-side-linenumber');
      var text = diffAlignmentLineText(row);
      if (!number || !String(number.textContent || '').trim() || text.length < 12 || !/[A-Za-z0-9_$]/.test(text)) return;
      var entry = values.get(text);
      if (entry) entry.count += 1;
      else values.set(text, { row: row, index: index, count: 1 });
    });
    return values;
  };
  var oldByText = collect(oldRows || []);
  var newByText = collect(newRows || []);
  var candidates = [];
  newByText.forEach(function (newEntry, text) {
    var oldEntry = oldByText.get(text);
    if (!oldEntry || oldEntry.count !== 1 || newEntry.count !== 1) return;
    candidates.push({
      oldRow: oldEntry.row,
      newRow: newEntry.row,
      oldIndex: oldEntry.index,
      newIndex: newEntry.index,
      kind: 'semantic-line',
    });
  });
  candidates.sort(function (a, b) { return a.newIndex - b.newIndex || a.oldIndex - b.oldIndex; });
  // Keep the longest monotonic sequence. A moved block must not pull the base pane backwards or make the
  // correction jump between two contradictory anchors while the reviewer scrolls.
  var previous = [], tailIndices = [];
  for (var i = 0; i < candidates.length; i++) {
    var low = 0, high = tailIndices.length;
    while (low < high) {
      var middle = (low + high) >> 1;
      if (candidates[tailIndices[middle]].oldIndex < candidates[i].oldIndex) low = middle + 1;
      else high = middle;
    }
    previous[i] = low > 0 ? tailIndices[low - 1] : -1;
    tailIndices[low] = i;
  }
  var anchors = [];
  var best = tailIndices.length ? tailIndices[tailIndices.length - 1] : -1;
  while (best >= 0) {
    anchors.push(candidates[best]);
    best = previous[best];
  }
  return anchors.reverse();
}
function diffRectHeight(rect) {
  return rect ? Math.max(0, Number(rect.height) || (Number(rect.bottom) - Number(rect.top)) || 0) : 0;
}
function invalidateAsymmetricDiffGeometry(wrapper) {
  var state = wrapper && wrapper.__asymmetricDiffState;
  if (!state) return;
  state.anchorGeometry = null;
  state.gapGeometry = null;
  state.connectorGeometry = null;
  state.connectorPathNodes = null;
  state.connectorRenderKey = '';
  state.connectorLastOffset = null;
}
function diffRowBounds(rows, fallbackRows, run, side, surfaceRect) {
  var realRows = side === 'old' ? run.oldRealRows : run.newRealRows;
  if (realRows && realRows.length) {
    var firstRect = realRows[0].getBoundingClientRect();
    var lastRect = realRows[realRows.length - 1].getBoundingClientRect();
    if (diffRectHeight(firstRect) || diffRectHeight(lastRect)) {
      return { top: firstRect.top - surfaceRect.top, bottom: lastRect.bottom - surfaceRect.top };
    }
  }
  // A pure insertion/deletion has no source extent on one side. Collapse that end of the connector to
  // the boundary between the surrounding real rows, producing IntelliJ's tapered hunk shape.
  for (var next = run.endIndex + 1; next < fallbackRows.length; next++) {
    var nextRect = fallbackRows[next].getBoundingClientRect();
    if (diffRectHeight(nextRect)) {
      var nextY = nextRect.top - surfaceRect.top;
      // A mathematically zero-height SVG edge can lose its final pixel to antialiasing where it meets the
      // 1px base-side insertion marker. Give the collapsed end one physical CSS pixel centred on the same
      // boundary so the horizontal marker and curved fill overlap without a hairline seam.
      return { top: nextY - 0.5, bottom: nextY + 0.5 };
    }
  }
  for (var previous = run.startIndex - 1; previous >= 0; previous--) {
    var previousRect = fallbackRows[previous].getBoundingClientRect();
    if (diffRectHeight(previousRect)) {
      var previousY = previousRect.bottom - surfaceRect.top;
      return { top: previousY - 0.5, bottom: previousY + 0.5 };
    }
  }
  return null;
}
function diffConnectorGeometry(state, surfaceRect) {
  if (state.connectorGeometry) return state.connectorGeometry;
  var oldOffset = Number(state.offset) || 0;
  var newOffset = Number(state.newOffset) || 0;
  state.connectorGeometry = (state.connectorRuns || []).map(function (run) {
    var oldBounds = diffRowBounds(run.oldRealRows, state.oldRows || [], run, 'old', surfaceRect);
    var newBounds = diffRowBounds(run.newRealRows, state.newRows || [], run, 'new', surfaceRect);
    if (!oldBounds || !newBounds) return null;
    // Old rows live inside the translated base stack. Store their untransformed document coordinates once;
    // subsequent scroll frames only add the new offset and never re-read row layout.
    return {
      kind: run.kind,
      oldTop: oldBounds.top - oldOffset,
      oldBottom: oldBounds.bottom - oldOffset,
      newTop: newBounds.top - newOffset,
      newBottom: newBounds.bottom - newOffset,
    };
  }).filter(Boolean);
  return state.connectorGeometry;
}
function renderDiffConnectors(wrapper, state) {
  var surface = wrapper && wrapper.querySelector('.d2h-files-diff');
  if (!surface || !state) return;
  var svg = surface.querySelector(':scope > .mc-diff-connectors');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'mc-diff-connectors');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('preserveAspectRatio', 'none');
    surface.appendChild(svg);
  }
  var oldOffset = Number(state.offset) || 0;
  var newOffset = Number(state.newOffset) || 0;
  var currentOffset = oldOffset + ':' + newOffset;
  // Outside an asymmetric insertion the offset does not change. The SVG is already part of the scrolled
  // document, so there is nothing to repaint and—critically—no layout to measure on ordinary scroll frames.
  if (state.connectorLastOffset === currentOffset && state.connectorRenderKey && state.connectorGeometry) return;
  var surfaceRect = surface.getBoundingClientRect();
  var height = Math.max(Number(surface.scrollHeight) || 0, diffRectHeight(surfaceRect));
  if (!height) { svg.replaceChildren(); return; }
  var surfaceWidth = Number(surfaceRect.width) || (Number(surfaceRect.right) - Number(surfaceRect.left)) || 0;
  var connectorWidth = Math.min(104, surfaceWidth || 104);
  // The surface is an exact two-column grid. Keep the overlay attached to that live CSS midpoint instead
  // of baking the current midpoint into pixels. The review sidebar animates the content track width; a
  // pixel left value stayed behind for the duration of that transition and visibly tore (or covered) the
  // two code canvases. Percentage positioning follows every compositor frame without rerunning row layout.
  svg.style.left = '50%';
  svg.style.width = connectorWidth + 'px';
  svg.style.transform = 'translateX(-50%)';
  svg.setAttribute('viewBox', '0 0 ' + connectorWidth + ' ' + height);
  var geometry = diffConnectorGeometry(state, surfaceRect);
  if (!state.connectorPathNodes || state.connectorPathNodes.length !== geometry.length) {
    var fragment = document.createDocumentFragment();
    state.connectorPathNodes = geometry.map(function (entry) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'mc-diff-connector mc-diff-connector-' + entry.kind);
      fragment.appendChild(path);
      return path;
    });
    svg.replaceChildren(fragment);
  }
  var edgeBleed = 1;
  geometry.forEach(function (entry, index) {
    var oldTop = Math.max(0, Math.min(height, entry.oldTop + oldOffset));
    var oldBottom = Math.max(0, Math.min(height, entry.oldBottom + oldOffset));
    var newTop = Math.max(0, Math.min(height, entry.newTop + newOffset));
    var newBottom = Math.max(0, Math.min(height, entry.newBottom + newOffset));
    var firstControl = Math.round(connectorWidth * 0.29 * 10) / 10;
    var secondControl = Math.round(connectorWidth * 0.71 * 10) / 10;
    // Bleed one physical pixel into both code canvases. This removes the antialiasing seam at the gutter
    // boundary without adding an outline around the line-number area.
    var d = 'M ' + (-edgeBleed) + ' ' + oldTop + ' C ' + firstControl + ' ' + oldTop + ', ' + secondControl + ' ' + newTop + ', ' + (connectorWidth + edgeBleed) + ' ' + newTop
      + ' L ' + (connectorWidth + edgeBleed) + ' ' + newBottom + ' C ' + secondControl + ' ' + newBottom + ', ' + firstControl + ' ' + oldBottom + ', ' + (-edgeBleed) + ' ' + oldBottom + ' Z';
    state.connectorPathNodes[index].setAttribute('d', d);
  });
  state.connectorLastOffset = currentOffset;
  state.connectorRenderKey = [surfaceWidth, height, connectorWidth, geometry.length].join(':');
}
function diffGapGeometry(state, containerRect, scrollTop) {
  if (state.gapGeometry) return state.gapGeometry;
  state.gapGeometry = (state.gaps || []).map(function (gap) {
    if (!gap.firstNewRow || !gap.lastNewRow || !gap.firstNewRow.isConnected || !gap.lastNewRow.isConnected) return null;
    var firstRect = gap.firstNewRow.getBoundingClientRect();
    var lastRect = gap.lastNewRow.getBoundingClientRect();
    var newOffset = Number(state.newOffset) || 0;
    return {
      start: firstRect.top - containerRect.top + scrollTop - newOffset,
      end: lastRect.bottom - containerRect.top + scrollTop - newOffset,
    };
  }).filter(Boolean);
  return state.gapGeometry;
}
function diffAlignmentGeometry(state, containerRect, scrollTop) {
  if (state.anchorGeometry) return state.anchorGeometry;
  var oldOffset = Number(state.offset) || 0;
  var newOffset = Number(state.newOffset) || 0;
  state.anchorGeometry = (state.anchors || []).map(function (pair) {
    if (!pair.oldRow || !pair.newRow || !pair.oldRow.isConnected || !pair.newRow.isConnected) return null;
    var oldRect = pair.oldRow.getBoundingClientRect();
    var newRect = pair.newRow.getBoundingClientRect();
    if (!diffRectHeight(oldRect) || !diffRectHeight(newRect)) return null;
    return {
      oldY: oldRect.top - containerRect.top + scrollTop - oldOffset,
      newY: newRect.top - containerRect.top + scrollTop - newOffset,
      oldCenter: oldRect.top - containerRect.top + scrollTop - oldOffset + diffRectHeight(oldRect) / 2,
      newCenter: newRect.top - containerRect.top + scrollTop - newOffset + diffRectHeight(newRect) / 2,
    };
  }).filter(Boolean).sort(function (a, b) { return a.newCenter - b.newCenter; });
  return state.anchorGeometry;
}
function interpolatedDiffAlignmentOffset(geometry, y, referenceSide) {
  if (!geometry || !geometry.length) return null;
  var centerKey = referenceSide === 'old' ? 'oldCenter' : 'newCenter';
  var low = 0, high = geometry.length;
  while (low < high) {
    var middle = (low + high) >> 1;
    if (geometry[middle][centerKey] < y) low = middle + 1;
    else high = middle;
  }
  var after = geometry[Math.min(low, geometry.length - 1)];
  var before = geometry[Math.max(0, low - 1)];
  var beforeOffset = before.newY - before.oldY;
  var afterOffset = after.newY - after.oldY;
  if (before === after || after[centerKey] <= before[centerKey]) return beforeOffset;
  var progress = Math.max(0, Math.min(1, (y - before[centerKey]) / (after[centerKey] - before[centerKey])));
  return beforeOffset + (afterOffset - beforeOffset) * progress;
}
function diffReferenceSide(wrapper, state, cursor) {
  if (state && (state.wheelSide === 'old' || state.wheelSide === 'new')) return state.wheelSide;
  if (state && (state.pointerSide === 'old' || state.pointerSide === 'new')) return state.pointerSide;
  var activeCursor = arguments.length >= 3
    ? cursor
    : (typeof diffCursor !== 'undefined' ? diffCursor : null);
  if (activeCursor && wrapper && activeCursor.path === wrapper.dataset.path) {
    return activeCursor.side === 'old' ? 'old' : 'new';
  }
  return state && state.referenceSide === 'old' ? 'old' : 'new';
}
function diffTargetAlignmentOffset(state, containerRect, scrollTop, canonicalY, referenceSide) {
  var offset = 0;
  var insideGap = false;
  // Insertions have a real extent only on the working-tree timeline. Preserve the exact IntelliJ-style
  // pause when that pane is the reference; the anchor interpolation below provides the inverse mapping
  // when the base pane owns the gesture.
  if (referenceSide !== 'old') {
    diffGapGeometry(state, containerRect, scrollTop).forEach(function (gap) {
      if (canonicalY >= gap.start && canonicalY <= gap.end) insideGap = true;
      offset += asymmetricGapProgress(canonicalY, gap.start, gap.end);
    });
  }
  if ((!insideGap || referenceSide === 'old') && state.anchors && state.anchors.length) {
    var exactOffset = interpolatedDiffAlignmentOffset(
      diffAlignmentGeometry(state, containerRect, scrollTop), canonicalY, referenceSide
    );
    if (Number.isFinite(exactOffset)) offset = exactOffset;
  }
  return Math.round(offset * 100) / 100;
}
function moveDiffOffsetToward(current, target, budget) {
  if (!Number.isFinite(target)) return current;
  if (!Number.isFinite(budget) || budget < 0 || Math.abs(target - current) <= budget) return target;
  return current + Math.sign(target - current) * budget;
}
function applyAsymmetricDiffOffsets(state, oldOffset, newOffset) {
  oldOffset = Math.round((Number(oldOffset) || 0) * 100) / 100;
  newOffset = Math.round((Number(newOffset) || 0) * 100) / 100;
  state.offset = oldOffset;
  state.newOffset = newOffset;
  var oldTransform = oldOffset ? 'translate3d(0, ' + oldOffset + 'px, 0)' : '';
  var newTransform = newOffset ? 'translate3d(0, ' + newOffset + 'px, 0)' : '';
  if (state.oldContent.style.transform !== oldTransform) state.oldContent.style.transform = oldTransform;
  if (state.newContent.style.transform !== newTransform) state.newContent.style.transform = newTransform;
}
function rebaseAsymmetricDiffReference(container, state, referenceSide, scrollTop) {
  var referenceOffset = referenceSide === 'old' ? (Number(state.offset) || 0) : (Number(state.newOffset) || 0);
  if (!referenceOffset) return scrollTop;
  // Transforms are relative; remove their shared component when ownership changes and compensate through
  // scrollTop in the same task. The selected pane therefore becomes the zero-offset timeline without a
  // visible jump or an ever-growing blank margin after alternating between the two panes.
  var requestedScrollTop = scrollTop - referenceOffset;
  container.scrollTop = requestedScrollTop;
  var appliedShift = scrollTop - (Number(container.scrollTop) || 0);
  if (!appliedShift) return scrollTop;
  applyAsymmetricDiffOffsets(
    state,
    (Number(state.offset) || 0) - appliedShift,
    (Number(state.newOffset) || 0) - appliedShift
  );
  return Number(container.scrollTop) || 0;
}
// The pane under the pointer (or owning the keyboard caret) is the canonical timeline. The reference pane
// always keeps its current transform, so changing sides never snaps code under the reviewer. If a distant
// semantic anchor asks for a large correction, only the opposite pane catches up, capped by the distance
// of the user's own scroll gesture; once it reaches the target the two panes resume moving together.
function scrollAsymmetricDiffSurface(container, wrapper, cursor) {
  var state = wrapper && wrapper.__asymmetricDiffState;
  if (!container || !state || !state.oldContent || !state.newContent || !container.clientHeight) {
    if (state && state.oldContent) state.oldContent.style.transform = '';
    if (state && state.newContent) state.newContent.style.transform = '';
    return;
  }
  var scrollTop = container.scrollTop || 0;
  var originalScrollTop = scrollTop;
  var anchor = Math.round(container.clientHeight * 0.15);
  var referenceSide = diffReferenceSide(wrapper, state, cursor);
  var referenceChanged = state.initialized && state.referenceSide !== referenceSide;
  var scrollDistance = Math.abs(originalScrollTop - (Number.isFinite(state.lastScrollTop) ? state.lastScrollTop : originalScrollTop));
  if (referenceChanged) scrollTop = rebaseAsymmetricDiffReference(container, state, referenceSide, scrollTop);
  var containerRect = container.getBoundingClientRect();
  var referenceOffset = referenceSide === 'old' ? (Number(state.offset) || 0) : (Number(state.newOffset) || 0);
  var canonicalY = scrollTop + anchor - referenceOffset;
  var targetDelta = diffTargetAlignmentOffset(state, containerRect, scrollTop, canonicalY, referenceSide);
  var oldOffset = Number(state.offset) || 0;
  var newOffset = Number(state.newOffset) || 0;
  var budget = Math.max(scrollDistance, Number(state.pendingScrollBudget) || 0);
  var scrollDriven = !!state.scrollDriven;
  state.lastScrollTop = scrollTop;
  state.pendingScrollBudget = 0;
  state.scrollDriven = false;
  state.wheelSide = '';
  if (!state.initialized) {
    if (referenceSide === 'old') newOffset = oldOffset - targetDelta;
    else oldOffset = newOffset + targetDelta;
    state.initialized = true;
  } else if (referenceSide === 'old') {
    var targetNewOffset = oldOffset - targetDelta;
    newOffset = scrollDriven ? moveDiffOffsetToward(newOffset, targetNewOffset, budget) : targetNewOffset;
  } else {
    var targetOldOffset = newOffset + targetDelta;
    oldOffset = scrollDriven ? moveDiffOffsetToward(oldOffset, targetOldOffset, budget) : targetOldOffset;
  }
  state.referenceSide = referenceSide;
  state.catchingUp = referenceSide === 'old'
    ? Math.abs(newOffset - (oldOffset - targetDelta)) > 0.5
    : Math.abs(oldOffset - (newOffset + targetDelta)) > 0.5;
  // `referenceChanged` is intentionally only documentary state: keeping the newly selected reference's
  // existing offset is what prevents the side switch itself from moving either editor.
  state.referenceChanged = referenceChanged;
  applyAsymmetricDiffOffsets(state, oldOffset, newOffset);
  renderDiffConnectors(wrapper, state);
}
function scrollAsymmetricDiff() {
  var container = document.getElementById('diff2html-container');
  var wrapper = typeof diffActiveWrapper === 'function' ? diffActiveWrapper() : null;
  var cursor = typeof diffCursor !== 'undefined' ? diffCursor : null;
  scrollAsymmetricDiffSurface(container, wrapper, cursor);
}
function scheduleAsymmetricDiffScroll() {
  if (asymmetricDiffScrollRaf) return;
  asymmetricDiffScrollRaf = requestAnimationFrame(function () {
    asymmetricDiffScrollRaf = 0;
    scrollAsymmetricDiff();
  });
}
var asymmetricDiffContainer = document.getElementById('diff2html-container');
function noteAsymmetricDiffScroll() {
  var wrapper = typeof diffActiveWrapper === 'function' ? diffActiveWrapper() : null;
  var state = wrapper && wrapper.__asymmetricDiffState;
  if (state) state.scrollDriven = true;
  scheduleAsymmetricDiffScroll();
}
function asymmetricDiffSideFromTarget(target) {
  var side = target && target.closest ? target.closest('.d2h-file-side-diff') : null;
  if (!side) return '';
  var wrapper = side.closest('.d2h-file-wrapper');
  var sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  return side === sides[0] ? 'old' : 'new';
}
function prepareAsymmetricDiffWheel(event) {
  var wrapper = typeof diffActiveWrapper === 'function' ? diffActiveWrapper() : null;
  var state = wrapper && wrapper.__asymmetricDiffState;
  if (!state) return;
  var side = asymmetricDiffSideFromTarget(event && event.target);
  if (side) state.wheelSide = side;
  state.pendingScrollBudget = (Number(state.pendingScrollBudget) || 0) + Math.abs(Number(event && event.deltaY) || 0);
  state.scrollDriven = true;
}
if (asymmetricDiffContainer) {
  asymmetricDiffContainer.addEventListener('scroll', noteAsymmetricDiffScroll, { passive: true });
  asymmetricDiffContainer.addEventListener('pointermove', function (event) {
    var wrapper = typeof diffActiveWrapper === 'function' ? diffActiveWrapper() : null;
    var state = wrapper && wrapper.__asymmetricDiffState;
    if (state) state.pointerSide = asymmetricDiffSideFromTarget(event.target);
  }, { passive: true });
  asymmetricDiffContainer.addEventListener('pointerleave', function () {
    var wrapper = typeof diffActiveWrapper === 'function' ? diffActiveWrapper() : null;
    var state = wrapper && wrapper.__asymmetricDiffState;
    if (state) state.pointerSide = '';
  }, { passive: true });
}
window.addEventListener('resize', function () {
  Array.prototype.forEach.call(document.querySelectorAll('.d2h-file-wrapper:not(.df-inactive)'), function (wrapper) {
    invalidateAsymmetricDiffGeometry(wrapper);
  });
  // 00-diff-layers owns viewport settling. Running alignment immediately here forces connector/anchor
  // layout on every intermediate native resize frame and can leave the expanded window showing its old
  // compositor surface. The settling callback schedules one alignment pass at the final width.
  if (typeof diffViewportResizing === 'undefined' || !diffViewportResizing) scheduleAsymmetricDiffScroll();
});
