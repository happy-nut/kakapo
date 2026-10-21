import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

// The sidebar's project header and the content pane's first toolbar are the same band, and they meet at
// one seam across the sidebar/content divider — the CSS says so in a comment and nothing checked it. It
// cannot be checked without a browser: jsdom reports every one of these heights as 0, so the band could
// drift to three different values and the rest of the suite would stay green.
//
// What stood here instead was a test of the `native-app` layout, which reserved room for an integrated
// title bar. The app stopped emitting that class, so the test only passed because its own fixture added
// it by hand: with the class gone, the traffic-light reservation it asserted computes to 0 and every
// "title starts past the controls" bound collapses to "past 8px". It was defending deleted CSS.
test("real Chromium lands the sidebar header and the content toolbar on one seam", {
  skip: process.platform !== "darwin" ? "macOS header-band layout regression" : false,
  timeout: 30_000,
}, async () => {
  const electron = require("electron");
  const fixture = fileURLToPath(new URL("./fixtures/electron-header-band.cjs", import.meta.url));
  const css = fileURLToPath(new URL("../dist/viewer.css", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fixture, css], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("KAKAPO_HEADER_BAND="));
  assert.ok(marker, `header band result missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const layout = JSON.parse(marker.slice("KAKAPO_HEADER_BAND=".length));

  assert.ok(layout.band > 0, `the band is a real measured height (--header-band resolved to ${layout.band})`);
  // Both panes are measured, because the diff view and the source view reach the band by different rules.
  for (const [name, surface] of Object.entries({ brand: layout.brand, diff: layout.diff, source: layout.source })) {
    assert.ok(surface.height > 0, `${name} has a measurable height`);
    assert.equal(surface.top, 0, `${name} sits flush at the top of the window`);
    assert.ok(Math.abs(surface.height - layout.band) <= 0.5,
      `${name} is ${surface.height}px tall, not the ${layout.band}px band`);
  }
  // The seam itself: the sidebar header and whichever toolbar is showing end on the same pixel row.
  assert.ok(Math.abs(layout.brand.bottom - layout.diff.bottom) <= 0.5,
    `the sidebar header ends at ${layout.brand.bottom} and the diff toolbar at ${layout.diff.bottom}`);
  assert.ok(Math.abs(layout.brand.bottom - layout.source.bottom) <= 0.5,
    `the sidebar header ends at ${layout.brand.bottom} and the source toolbar at ${layout.source.bottom}`);
});

test("real Chromium fills the enlarged native window and settles one visible diff projection", {
  skip: process.platform !== "darwin" ? "macOS native resize regression" : false,
  timeout: 30_000,
}, async () => {
  const electron = require("electron");
  const fixture = fileURLToPath(new URL("./fixtures/electron-window-resize.cjs", import.meta.url));
  const css = fileURLToPath(new URL("../dist/viewer.css", import.meta.url));
  const layers = fileURLToPath(new URL("../src/viewer/00-diff-layers.js", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fixture, css, layers], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("KAKAPO_WINDOW_RESIZE="));
  assert.ok(marker, `window resize result missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const layout = JSON.parse(marker.slice("KAKAPO_WINDOW_RESIZE=".length));
  for (const [phase, measurement] of Object.entries(layout)) {
    assert.ok(Math.abs(measurement.bodyWidth - measurement.innerWidth) <= 1, `${phase}: body left a native background strip`);
    assert.ok(Math.abs(measurement.contentRight - measurement.innerWidth) <= 1, `${phase}: content did not reach the window edge`);
    assert.ok(Math.abs(measurement.toolbarRight - measurement.innerWidth) <= 1, `${phase}: review toolbar retained its previous width`);
    assert.equal(measurement.gutterLayerCount, 2, `${phase}: resize duplicated a diff gutter layer`);
    assert.equal(measurement.resizeSettled, true, `${phase}: viewport projection never settled`);
  }
  assert.ok(layout.after.innerWidth > layout.before.innerWidth, "the test actually enlarges the BrowserWindow");
});

test("real Chromium keeps both diff gutters at the divider after maximum horizontal scroll", {
  skip: process.platform !== "darwin" ? "macOS packaged layout regression" : false,
  timeout: 30_000,
}, async () => {
  const electron = require("electron");
  const fixture = fileURLToPath(new URL("./fixtures/electron-diff-layout.cjs", import.meta.url));
  const css = fileURLToPath(new URL("../dist/viewer.css", import.meta.url));
  const layers = fileURLToPath(new URL("../src/viewer/00-diff-layers.js", import.meta.url));
  const viewer = readFileSync(new URL("../dist/viewer.client.js", import.meta.url), "utf8");
  assert.match(viewer, /function installLayeredDiffGutters/, "the viewer ships the panel-level gutter renderer");
  assert.doesNotMatch(viewer, /installDiffHorizontalGutterPinning|--mc-diff-gutter-offset/, "the viewer no longer ships scroll-following gutter JavaScript");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fixture, css, layers], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("KAKAPO_DIFF_LAYOUT="));
  assert.ok(marker, `layout result missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const layout = JSON.parse(marker.slice("KAKAPO_DIFF_LAYOUT=".length));
  assert.ok(layout.oldScrollLeft > 500, "the base pane reached a destructive horizontal-scroll distance");
  assert.ok(layout.newScrollLeft > 500, "the working-tree pane reached a destructive horizontal-scroll distance");
  assert.equal(layout.gutterLayerCount, 2, "each pane owns exactly one visible gutter layer");
  assert.equal(layout.visibleOriginalNumberCount, 0, "diff2html number cells remain model anchors, not visible gutters");
  assert.equal(layout.oldAppliedOffset, 0, "base gutter must not chase scrollLeft through a transform variable");
  assert.equal(layout.newAppliedOffset, 0, "working-tree gutter must not chase scrollLeft through a transform variable");
  assert.ok(layout.immediateOldDividerGap <= 1.5, `base gutter lagged its scroll event by ${layout.immediateOldDividerGap}px`);
  assert.ok(layout.immediateNewDividerGap <= 1, `working-tree gutter lagged its scroll event by ${layout.immediateNewDividerGap}px`);
  assert.ok(layout.immediateOldBandGap <= 1, `base change background lagged its gutter by ${layout.immediateOldBandGap}px`);
  assert.ok(layout.immediateNewBandGap <= 1, `working-tree change background lagged its gutter by ${layout.immediateNewBandGap}px`);
  assert.ok(layout.immediateOldFoldCenterGap <= 1, `base folded-context label missed the visible pane centre by ${layout.immediateOldFoldCenterGap}px`);
  assert.ok(layout.immediateNewFoldCenterGap <= 1, `working folded-context label missed the visible pane centre by ${layout.immediateNewFoldCenterGap}px`);
  assert.ok(layout.immediateOldFoldOverflow <= 1, `base folded-context control escaped its pane by ${layout.immediateOldFoldOverflow}px`);
  assert.ok(layout.immediateNewFoldOverflow <= 1, `working folded-context control escaped its pane by ${layout.immediateNewFoldOverflow}px`);
  assert.ok(layout.oldDividerGap <= 1.5, `base gutter escaped the divider by ${layout.oldDividerGap}px`);
  assert.ok(layout.newDividerGap <= 1, `working-tree gutter escaped the divider by ${layout.newDividerGap}px`);
  assert.ok(Math.abs(layout.oldNumberWidth - 52) <= 1, `base gutter width changed to ${layout.oldNumberWidth}px`);
  assert.ok(Math.abs(layout.newNumberWidth - 52) <= 1, `working-tree gutter width changed to ${layout.newNumberWidth}px`);
  assert.ok(layout.oldBandGap <= 1, `base change background broke ${layout.oldBandGap}px before its gutter`);
  assert.ok(layout.newBandGap <= 1, `working-tree change background broke ${layout.newBandGap}px after its gutter`);
  assert.ok(layout.oldTextTravel < -500, "base text still moves horizontally inside its pinned change background");
  assert.ok(layout.newTextTravel < -500, "working-tree text still moves horizontally inside its pinned change background");
  assert.ok(layout.oldAnchorTravel < -500, "the hidden base number anchor scrolls with the table instead of acting as a sticky layer");
  assert.ok(layout.newAnchorTravel < -500, "the hidden working-tree number anchor scrolls with the table instead of acting as a sticky layer");
  assert.ok(layout.immediateCommentCardGap >= 8, `comment card started only ${layout.immediateCommentCardGap}px after the working-tree gutter in the scroll task`);
  assert.equal(layout.immediateCommentRightOverflow, 0, "comment card overflowed the working-tree viewport in the scroll task");
  assert.equal(layout.immediateCommentButtonClip, 0, "the primary comment button was clipped behind the gutter in the scroll task");
  assert.ok(layout.commentCardGap >= 8, `comment card started only ${layout.commentCardGap}px after the working-tree gutter`);
  assert.equal(layout.commentRightOverflow, 0, "comment card overflowed the working-tree viewport");
  assert.equal(layout.commentInputRightOverflow, 0, "comment input overflowed the working-tree viewport");
  assert.equal(layout.commentButtonClip, 0, "the primary comment button was clipped behind the gutter");
  assert.ok(Math.abs(layout.commentCardTravel) <= 1, `comment card moved ${layout.commentCardTravel}px with source text`);
  assert.ok(Math.abs(layout.oldVerticalLock) <= 0.5, "base code and its one gutter layer share the same vertical transform");
  assert.ok(Math.abs(layout.newVerticalLock) <= 0.5, "working-tree code and its one gutter layer share the same vertical transform");
  assert.ok(layout.wrappedOldTextHeight > 30, `base long line did not wrap (${layout.wrappedOldTextHeight}px)`);
  assert.ok(layout.wrappedNewTextHeight > 30, `working-tree long line did not wrap (${layout.wrappedNewTextHeight}px)`);
  assert.ok(layout.wrappedOldTableOverflow <= 1, `wrapped base table overflowed its pane by ${layout.wrappedOldTableOverflow}px`);
  assert.ok(layout.wrappedNewTableOverflow <= 1, `wrapped working table overflowed its pane by ${layout.wrappedNewTableOverflow}px`);
  assert.ok(layout.wrappedOldNumberTopGap <= 1, `base wrapped line number started ${layout.wrappedOldNumberTopGap}px below its row`);
  assert.ok(layout.wrappedNewNumberTopGap <= 1, `working wrapped line number started ${layout.wrappedNewNumberTopGap}px below its row`);
  assert.ok(layout.wrappedOldNumberLineHeight < layout.wrappedOldTextHeight, "base line number stays on the first visual line");
  assert.ok(layout.wrappedNewNumberLineHeight < layout.wrappedNewTextHeight, "working line number stays on the first visual line");
  assert.ok(Math.abs(layout.wrappedOldAnchorWidth - 52) <= 1, `base wrap anchor grew to ${layout.wrappedOldAnchorWidth}px`);
  assert.ok(Math.abs(layout.wrappedNewAnchorWidth - 52) <= 1, `working wrap anchor grew to ${layout.wrappedNewAnchorWidth}px`);
  assert.ok(
    Math.abs(layout.wrappedOldCodeWidth - (layout.wrappedOldPaneWidth - 52)) <= 1,
    `base code used ${layout.wrappedOldCodeWidth}px of its ${layout.wrappedOldPaneWidth}px pane`,
  );
  assert.ok(
    Math.abs(layout.wrappedNewCodeWidth - (layout.wrappedNewPaneWidth - 52)) <= 1,
    `working code used ${layout.wrappedNewCodeWidth}px of its ${layout.wrappedNewPaneWidth}px pane`,
  );
});

test("real Chromium keeps both panes aligned while a comment opens and closes", {
  skip: process.platform !== "darwin" ? "macOS packaged layout regression" : false,
  timeout: 30_000,
}, async () => {
  const electron = require("electron");
  const fixture = fileURLToPath(new URL("./fixtures/electron-comment-layout.cjs", import.meta.url));
  const css = fileURLToPath(new URL("../dist/viewer.css", import.meta.url));
  const layers = fileURLToPath(new URL("../src/viewer/00-diff-layers.js", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fixture, css, layers], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("KAKAPO_COMMENT_LAYOUT="));
  assert.ok(marker, `comment layout result missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const layout = JSON.parse(marker.slice("KAKAPO_COMMENT_LAYOUT=".length));
  assert.ok(layout.pairedHeightGap <= 1, `paired comment heights differed by ${layout.pairedHeightGap}px`);
  assert.ok(layout.openFollowTopGap <= 1, `rows below the open comment diverged by ${layout.openFollowTopGap}px`);
  assert.ok(layout.removedFollowTopGap <= 1, `rows stayed split by ${layout.removedFollowTopGap}px after close`);
  assert.equal(layout.backgroundMatches, true, "the paired slot uses the same canvas background");
});
