import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  const beforeLines = Array.from({ length: 32 }, (_, index) => `const line${index + 1} = ${index + 1};`);
  const afterLines = beforeLines.slice();
  afterLines[2] = "const line3 = 300;";
  afterLines[27] = "const line28 = 2800;";
  const colorBefore = Array.from({ length: 36 }, (_, index) => `const colorLine${index + 1} = ${index + 1};`);
  const colorAfter = colorBefore.slice();
  colorAfter[2] = "const colorLine3 = 300;";
  colorAfter.splice(10, 1);
  colorAfter.splice(25, 0, "const inserted = true;");
  ({ html } = await makeReviewHtml([
    { path: "src/review.ts", before: beforeLines.join("\n") + "\n", after: afterLines.join("\n") + "\n" },
    { path: "src/colors.ts", before: colorBefore.join("\n") + "\n", after: colorAfter.join("\n") + "\n" },
  ], { app: true, context: 2 }));
});
after(cleanupFixtures);

test("IntelliJ-style diff chrome tracks review stops and opens the current source", async () => {
  const v = await loadViewer(html, {
    analysisBridge: () => null,
    analysisStatus: { generation: 1, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openDiffFor("src/review.ts");
  await v.settle(80);

  assert.equal(v.$("#diff-before-path").textContent, "src/review.ts");
  assert.equal(v.$("#diff-after-path").textContent, "src/review.ts");
  assert.match(v.$("#diff-change-counter").textContent, /1 of 2/);
  assert.equal(v.window.getComputedStyle(v.$(".d2h-code-line-prefix")).display, "none", "patch +/- prefixes are hidden");

  v.click(v.$("#diff-next-change"));
  await v.settle(80);
  assert.match(v.$("#diff-change-counter").textContent, /2 of 2/, "the toolbar follows the same next-change stop as F7");

  v.click(v.$("#diff-open-source"));
  await v.settle(80);
  assert.equal(v.visibleView(), "source");
  assert.equal(v.$("#source-viewer").dataset.openPath, "src/review.ts");
  v.close();
});

test("paired hunk rows use center gutters and IntelliJ semantic colors", async () => {
  const v = await loadViewer(html, {
    analysisBridge: () => null,
    analysisStatus: { generation: 1, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openDiffFor("src/colors.ts");
  await v.settle(80);

  const wrapper = v.$("#diff2html-container .d2h-file-wrapper:not(.df-inactive)");
  const sides = wrapper.querySelectorAll(".d2h-file-side-diff");
  const oldRows = Array.from(sides[0].querySelectorAll("tr"));
  const newRows = Array.from(sides[1].querySelectorAll("tr"));
  const oldModified = oldRows.find((row) => row.textContent.includes("colorLine3 = 3"));
  const oldDeleted = oldRows.find((row) => row.textContent.includes("colorLine11 = 11"));
  const newAdded = newRows.find((row) => row.textContent.includes("inserted = true"));

  assert.ok(oldModified?.classList.contains("mc-diff-modified"), "a replacement is blue on the old side");
  assert.ok(newRows[oldRows.indexOf(oldModified)]?.classList.contains("mc-diff-modified"), "the replacement band crosses both panes");
  assert.ok(oldDeleted?.classList.contains("mc-diff-deleted"), "a pure deletion is neutral gray");
  assert.ok(newRows[oldRows.indexOf(oldDeleted)]?.classList.contains("mc-diff-deleted"), "the gray deletion band crosses the empty placeholder");
  assert.ok(newAdded?.classList.contains("mc-diff-added"), "a pure insertion is green");
  const oldAddedPeer = oldRows[newRows.indexOf(newAdded)];
  assert.ok(oldAddedPeer?.classList.contains("mc-diff-added"), "the old placeholder keeps the insertion's semantic pairing");
  assert.ok(oldAddedPeer.classList.contains("mc-asymmetric-insert-gap"), "the empty old peer is tagged as an asymmetric insertion gap");
  assert.equal(v.window.getComputedStyle(oldAddedPeer).display, "none", "the base pane does not reserve a tall blank row for an insertion");
  const resumeRow = oldRows[oldRows.indexOf(oldAddedPeer) + 1];
  assert.ok(resumeRow?.classList.contains("mc-asymmetric-insert-resume"), "a thin marker separates the consecutive base lines");

  const visibleOldNumbers = oldRows
    .filter((row) => v.window.getComputedStyle(row).display !== "none")
    .map((row) => Number(row.querySelector(".d2h-code-side-linenumber")?.textContent.trim()))
    .filter(Number.isFinite);
  const resumeNumber = Number(resumeRow.querySelector(".d2h-code-side-linenumber")?.textContent.trim());
  const resumeAt = visibleOldNumbers.indexOf(resumeNumber);
  assert.equal(visibleOldNumbers[resumeAt - 1], resumeNumber - 1, "base line numbers remain consecutive across the collapsed insertion");

  const semanticRow = (number, text) => {
    const row = v.window.document.createElement("tr");
    row.innerHTML = `<td class="d2h-code-side-linenumber">${number}</td><td><span class="d2h-code-line-ctn"></span></td>`;
    row.querySelector(".d2h-code-line-ctn").textContent = text;
    return row;
  };
  const oldSemanticRows = [semanticRow(1, "old implementation detail"), semanticRow(2, "def stable_review_anchor(")];
  const newSemanticRows = [
    semanticRow(1, "new implementation detail one"),
    semanticRow(2, "new implementation detail two"),
    semanticRow(3, "def stable_review_anchor("),
  ];
  const semanticAnchors = v.window.semanticDiffAlignmentAnchors(oldSemanticRows, newSemanticRows);
  const semanticAnchor = semanticAnchors.find((anchor) => anchor.oldRow === oldSemanticRows[1] && anchor.newRow === newSemanticRows[2]);
  assert.ok(semanticAnchor, "a unique stable source line anchors two differently positioned changed rows");
  assert.notEqual(semanticAnchor.oldIndex, semanticAnchor.newIndex, "semantic anchors are not limited to diff2html's positional row pairs");

  assert.equal(
    v.window.interpolatedDiffAlignmentOffset([
      { newCenter: 100, oldY: 0, newY: 20 },
      { newCenter: 200, oldY: 200, newY: 260 },
    ], 150),
    40,
    "alignment correction changes smoothly between exact semantic anchors",
  );

  const container = v.$("#diff2html-container");
  const oldContent = sides[0].querySelector(".mc-diff-layer-stack");
  const diffSurface = wrapper.querySelector(".d2h-files-diff");
  Object.defineProperty(container, "clientHeight", { configurable: true, value: 1000 });
  container.getBoundingClientRect = () => ({ top: 0, bottom: 1000 });
  Object.defineProperty(diffSurface, "scrollHeight", { configurable: true, value: 1000 });
  diffSurface.getBoundingClientRect = () => ({ top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000 });
  sides[0].getBoundingClientRect = () => ({ left: 0, right: 500, width: 500 });
  sides[1].getBoundingClientRect = () => ({ left: 500, right: 1000, width: 500 });
  const firstGapRow = newAdded;
  firstGapRow.getBoundingClientRect = () => ({ top: 300 - container.scrollTop, bottom: 400 - container.scrollTop });
  container.scrollTop = 0;
  firstGapRow.getBoundingClientRect = () => ({ top: 40 - container.scrollTop, bottom: 100 - container.scrollTop });
  v.window.scrollAsymmetricDiff();
  assert.equal(
    oldContent.style.transform,
    "translate3d(0, 60px, 0)",
    "an insertion already inside the initial reading band is fully absorbed so the next shared symbol aligns",
  );

  firstGapRow.getBoundingClientRect = () => ({ top: 300 - container.scrollTop, bottom: 400 - container.scrollTop });
  let gapLayoutReads = 0;
  firstGapRow.getBoundingClientRect = () => {
    gapLayoutReads += 1;
    return { top: 300 - container.scrollTop, bottom: 400 - container.scrollTop };
  };
  v.window.invalidateAsymmetricDiffGeometry(wrapper);
  container.scrollTop = 200;
  v.window.scrollAsymmetricDiff();
  assert.equal(oldContent.style.transform, "translate3d(0, 50px, 0)", "right-side scrolling is cancelled on the base pane while the insertion crosses the reading band");
  const readsAfterFirstScroll = gapLayoutReads;
  container.scrollTop = 250;
  v.window.scrollAsymmetricDiff();
  assert.equal(oldContent.style.transform, "translate3d(0, 100px, 0)", "the base pane stays pinned until the last inserted line passes");
  assert.equal(gapLayoutReads, readsAfterFirstScroll, "ordinary scroll frames reuse gap geometry instead of forcing row layout");

  const alignment = wrapper.__asymmetricDiffState;
  const anchorPair = alignment.anchors[0];
  assert.ok(anchorPair, "shared rendered rows are retained as exact alignment anchors");
  anchorPair.oldRow.getBoundingClientRect = () => ({ top: 100, bottom: 120, height: 20 });
  anchorPair.newRow.getBoundingClientRect = () => ({ top: 106, bottom: 126, height: 20 });
  alignment.offset = 100;
  v.window.invalidateAsymmetricDiffGeometry(wrapper);
  container.scrollTop = 500;
  v.window.scrollAsymmetricDiff();
  assert.equal(
    oldContent.style.transform,
    "translate3d(0, 106px, 0)",
    "outside an insertion, an exact shared row corrects accumulated table-height drift",
  );

  const connectorRun = alignment.connectorRuns.find((run) => run.oldRealRows.length && run.newRealRows.length);
  assert.ok(connectorRun, "changed source extents are grouped into connector runs");
  connectorRun.oldRealRows[0].getBoundingClientRect = () => ({ top: 160, bottom: 184, height: 24 });
  connectorRun.oldRealRows.at(-1).getBoundingClientRect = () => ({ top: 160, bottom: 184, height: 24 });
  connectorRun.newRealRows[0].getBoundingClientRect = () => ({ top: 152, bottom: 176, height: 24 });
  connectorRun.newRealRows.at(-1).getBoundingClientRect = () => ({ top: 152, bottom: 176, height: 24 });
  v.window.invalidateAsymmetricDiffGeometry(wrapper);
  v.window.renderDiffConnectors(wrapper, alignment);
  const connector = diffSurface.querySelector(".mc-diff-connector");
  assert.ok(connector, "the center line-number gutters receive a hunk connector");
  assert.match(connector.getAttribute("d"), / C /, "the connector uses a smooth cubic boundary rather than a hard box");
  assert.match(connector.getAttribute("d"), /^M -1 /, "the connector bleeds into the code canvas so no antialiasing seam remains");
  assert.equal(diffSurface.querySelector(".mc-diff-connectors").style.left, "448px", "the connector stays centered on the pane divider");
  assert.equal(diffSurface.querySelector(".mc-diff-connectors").style.width, "104px", "horizontal table movement cannot stretch the connector");

  const collapsedAfter = v.window.document.createElement("tr");
  collapsedAfter.getBoundingClientRect = () => ({ top: 240, bottom: 260, height: 20 });
  const collapsedBounds = v.window.diffRowBounds([], [v.window.document.createElement("tr"), collapsedAfter], {
    startIndex: 0,
    endIndex: 0,
    oldRealRows: [],
    newRealRows: [],
  }, "old", { top: 0 });
  assert.equal(collapsedBounds.bottom - collapsedBounds.top, 1, "a collapsed addition endpoint overlaps its 1px horizontal marker instead of leaving an antialiased seam");

  v.click(newAdded.querySelector(".d2h-code-side-line"));
  const cursorCell = wrapper.querySelector(".mc-diff-cursor-row .d2h-code-side-line");
  assert.equal(v.window.getComputedStyle(cursorCell).boxShadow, "none", "the diff caret has no duplicate blue rail to its left");
  const activeCells = wrapper.querySelectorAll("tr.diff-active-row td");
  assert.ok(activeCells.length > 0, "the current navigation row remains tracked without relying on an outline");
  activeCells.forEach((cell) => {
    assert.equal(v.window.getComputedStyle(cell).boxShadow, "none", "the active diff row has no blue border or gutter rail");
  });
  assert.ok(wrapper.querySelectorAll("tr.mc-active-hunk").length > 2, "the current hunk is tracked across both panes");
  wrapper.querySelectorAll("tr.mc-diff-change").forEach((row) => {
    assert.notEqual(row.dataset.reviewHunkIndex, undefined, "every semantic change row carries its hunk id");
  });

  const oldNumber = sides[0].querySelector(".d2h-code-side-linenumber:not(.d2h-info)");
  const newNumber = sides[1].querySelector(".d2h-code-side-linenumber:not(.d2h-info)");
  const oldNumberStyle = v.window.getComputedStyle(oldNumber);
  const newNumberStyle = v.window.getComputedStyle(newNumber);
  const oldGutter = sides[0].querySelector(".mc-diff-gutter-layer");
  const newGutter = sides[1].querySelector(".mc-diff-gutter-layer");
  assert.equal(oldNumber.parentElement.lastElementChild, oldNumber, "old line numbers are the last center-facing table cell");
  assert.equal(newNumber.parentElement.firstElementChild, newNumber, "new line numbers are the first center-facing table cell");
  assert.equal(oldNumberStyle.position, "relative", "old diff2html number cell is only a hidden model anchor");
  assert.equal(newNumberStyle.position, "relative", "new diff2html number cell is only a hidden model anchor");
  assert.equal(oldNumberStyle.visibility, "hidden", "the base table cell is not painted as a second gutter");
  assert.equal(newNumberStyle.visibility, "hidden", "the working-tree table cell is not painted as a second gutter");
  assert.equal(v.window.getComputedStyle(oldGutter).position, "sticky", "one base gutter layer is fixed by native layout");
  assert.equal(v.window.getComputedStyle(newGutter).position, "sticky", "one working-tree gutter layer is fixed by native layout");
  assert.ok(oldGutter.querySelector(".mc-diff-gutter-number"), "the base gutter projects numbers from the row model");
  assert.ok(newGutter.querySelector(".mc-diff-gutter-number"), "the working-tree gutter projects numbers from the row model");
  assert.equal(sides[0].querySelectorAll(".mc-diff-gutter-layer").length, 1, "the base pane owns exactly one visible gutter");
  assert.equal(sides[1].querySelectorAll(".mc-diff-gutter-layer").length, 1, "the working-tree pane owns exactly one visible gutter");
  assert.equal(oldNumberStyle.borderRightWidth, "0px", "the active hunk does not draw a blue center rail");
  assert.equal(newNumberStyle.borderLeftWidth, "0px", "the active hunk does not draw a blue center rail");

  const changeRow = v.$('.change-row[data-file="src/colors.ts"]');
  assert.equal(changeRow.querySelector(".diffstat"), null, "Changes rows omit added/deleted line totals");
  assert.equal(changeRow.querySelector(".status").textContent.trim(), "", "status uses no wide text label");
  assert.ok(changeRow.querySelector(".status-modified svg"), "modified state is a compact icon badge");
  v.close();
});

test("omitted context expands in both diff panes without losing hunk navigation", async () => {
  const v = await loadViewer(html, {
    analysisBridge: () => null,
    analysisStatus: { generation: 1, phase: "ready", updatedAt: new Date(0).toISOString() },
  });
  await v.openDiffFor("src/review.ts");
  await v.settle(80);

  const wrapper = v.$("#diff2html-container .d2h-file-wrapper:not(.df-inactive)");
  const folds = wrapper.querySelectorAll(".mc-context-fold");
  assert.equal(folds.length, 2, "one paired fold control is shown for the omitted range");
  assert.match(folds[0].textContent, /20 unchanged lines/, "the control explains how much context is hidden");
  assert.equal(folds[0].tagName, "BUTTON", "the fold is keyboard accessible");
  const hunkCountBefore = wrapper.querySelectorAll("tr.hunk").length;

  const rightSide = wrapper.querySelectorAll(".d2h-file-side-diff")[1];
  const rows = v.window.diffRowsOf(rightSide);
  const foldRow = folds[1].closest("tr");
  const foldIndex = rows.indexOf(foldRow);
  let previousCode = foldIndex - 1;
  while (previousCode >= 0 && !v.window.isDiffCodeRow(rows[previousCode])) previousCode -= 1;
  v.window.setDiffCursor("src/review.ts", "new", previousCode, 0, false);
  v.key("ArrowDown");
  assert.ok(foldRow.classList.contains("mc-row-selected"), "ArrowDown selects the folded context as a review stop");
  assert.ok(v.diffCaretRow(), "selecting the fold keeps the adjacent code caret visible");

  v.key(" ", { code: "Space" });
  await v.settle(80);

  const sides = wrapper.querySelectorAll(".d2h-file-side-diff");
  for (const side of sides) {
    const expanded = Array.from(side.querySelectorAll("tr.mc-expanded-context-row"));
    assert.equal(expanded.length, 20, "the complete omitted range is inserted into each pane");
    const line10 = expanded.find((row) => row.querySelector(".d2h-code-side-linenumber")?.textContent.trim() === "10");
    assert.match(line10?.textContent || "", /line10 = 10/, "expanded rows contain the actual source text and line numbers");
  }
  assert.equal(wrapper.querySelector(".mc-context-fold"), null, "the fold control disappears after the range is exhausted");
  const exhaustedMarkers = Array.from(wrapper.querySelectorAll("tr.mc-context-expanded-marker"));
  assert.ok(exhaustedMarkers.length >= 2, "paired hunk anchors remain available to navigation");
  exhaustedMarkers.forEach((marker) => {
    assert.equal(marker.getAttribute("aria-hidden"), "true", "the exhausted control is not exposed as UI");
    assert.equal(v.window.getComputedStyle(marker).display, "none", "expansion leaves no empty marker bar in either pane");
  });
  assert.equal(wrapper.querySelectorAll("tr.hunk").length, hunkCountBefore, "expansion preserves hunk navigation anchors");
  v.close();
});
