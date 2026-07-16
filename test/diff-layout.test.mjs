import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

test("real Chromium keeps every full-viewport title surface clear of macOS traffic lights", {
  skip: process.platform !== "darwin" ? "macOS native-title layout regression" : false,
  timeout: 30_000,
}, async () => {
  const electron = require("electron");
  const fixture = fileURLToPath(new URL("./fixtures/electron-native-title-layout.cjs", import.meta.url));
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
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("KAKAPO_NATIVE_TITLE_LAYOUT="));
  assert.ok(marker, `native title layout result missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const layout = JSON.parse(marker.slice("KAKAPO_NATIVE_TITLE_LAYOUT=".length));
  assert.equal(layout.safeWidth, 76, "the measured native control reservation matches BrowserWindow traffic lights");
  assert.equal(layout.titlebarHeight, 40, "all custom title rows share the native titlebar height");
  assert.ok(layout.railActionTop >= layout.titlebarHeight, "activity buttons begin below the traffic-light row");
  assert.ok(layout.sidebarBrandTop >= layout.titlebarHeight, "the expanded project header begins below the traffic-light row");
  assert.equal(layout.sidebarFocusTop, layout.titlebarHeight, "the sidebar keyboard cue begins below the traffic-light row");
  assert.equal(layout.sidebarFocusOutline, "none", "the sidebar does not draw a full-box outline through native controls");
  assert.equal(layout.railFocusOutline, "none", "the activity rail does not outline the traffic-light corner");
  assert.ok(layout.reviewTitleLeft >= layout.safeWidth + 8, `collapsed review title starts at ${layout.reviewTitleLeft}px`);
  assert.ok(layout.historyTitleLeft >= layout.safeWidth + 8, `History title starts at ${layout.historyTitleLeft}px`);
  assert.ok(layout.historyBarHeight >= layout.titlebarHeight - 0.5, "History preserves the shared titlebar height within Chromium subpixel rounding");
  assert.ok(layout.dockTitleLeft >= layout.safeWidth + 8, `maximized writing-panel title starts at ${layout.dockTitleLeft}px`);
  assert.ok(layout.dockBarHeight >= layout.titlebarHeight - 0.5, "maximized writing panels preserve the shared titlebar height within Chromium subpixel rounding");
  assert.equal(layout.dockButtonRegion, "no-drag", "maximized writing-panel actions remain clickable");
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
