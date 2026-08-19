import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const layers = readFileSync(new URL("../src/viewer/00-diff-layers.js", import.meta.url), "utf8");
const alignment = readFileSync(new URL("../src/viewer/01-diff-alignment.js", import.meta.url), "utf8");

test("layered diff gutter batches every row measurement before mutating live gutter DOM", () => {
  const match = layers.match(/function refreshLayeredDiffSide\b[\s\S]*?(?=\nfunction refreshLayeredDiffGutters\b)/);
  assert.ok(match, "gutter refresh implementation exists");
  const source = match[0];
  const measurementStart = source.indexOf("var measurements = model.map");
  const liveGutterRead = source.indexOf("layer.gutter.querySelectorAll");
  assert.ok(measurementStart >= 0, "row geometry is collected into a dedicated measurement phase");
  assert.ok(liveGutterRead > measurementStart, "live gutter nodes are not touched until all row geometry is measured");
  const mutationPhase = source.slice(liveGutterRead);
  assert.doesNotMatch(
    mutationPhase,
    /getBoundingClientRect\s*\(/,
    "the DOM mutation phase never forces another row layout read",
  );
});

test("inactive diff files defer gutter work until navigation makes them visible", () => {
  assert.match(
    layers,
    /ResizeObserver\(function \(\) \{[\s\S]*?classList\.contains\('df-inactive'\)[\s\S]*?__mcDiffLayersDirty = true;[\s\S]*?return;/,
    "hidden file resize delivery is reduced to a dirty bit",
  );
  assert.match(
    layers,
    /function scheduleLayeredDiffGutters\b[\s\S]*?classList\.contains\('df-inactive'\)[\s\S]*?return;/,
    "scheduled projection also ignores hidden files",
  );
});

test("native window resizing defers row projection and connector geometry until the viewport settles", () => {
  assert.match(
    layers,
    /function beginDiffViewportChurn\(\) \{[\s\S]*?diffViewportResizing = true;[\s\S]*?setTimeout\(settleDiffViewportResize, 140\)/,
    "viewport churn enters one debounced settling phase",
  );
  assert.match(
    layers,
    /window\.addEventListener\('resize', beginDiffViewportChurn/,
    "a native resize is one of the things that starts it",
  );
  assert.match(
    layers,
    /ResizeObserver\(function \(\) \{[\s\S]*?if \(diffViewportResizing\) \{[\s\S]*?__mcDiffLayersDirty = true;[\s\S]*?return;/,
    "row measurement is skipped while native bounds are still changing",
  );
  assert.match(
    layers,
    /function settleDiffViewportResize\b[\s\S]*?visibleDiffWrappersAfterResize\(\)\.forEach[\s\S]*?scheduleLayeredDiffGutters\(wrapper\)/,
    "only visible diff layers are refreshed once at the final viewport width",
  );
  assert.match(
    alignment,
    /if \(typeof diffViewportResizing === 'undefined' \|\| !diffViewportResizing\) scheduleAsymmetricDiffScroll\(\)/,
    "connector alignment does not force layout during intermediate resize frames",
  );
});

// A resize is not the only thing that dirties every row at once. Swapping the theme or the syntax family
// rewrites the custom properties the whole document is painted from, and a zoom step changes every row's
// height — after either, the table's ResizeObserver fires with the entire style tree invalidated, and what it
// triggers reads a computed style and a rect per row while writing spacer heights that resize the table and
// fire it again. Reported twice as the window simply stopping. They take the resize's exit now.
test("a theme swap or a zoom step settles like a resize instead of re-projecting per row", () => {
  const core = readFileSync(new URL("../src/viewer/01-core.js", import.meta.url), "utf8");
  const arms = (fn) => new RegExp("function " + fn + "\\([^)]*\\) \\{[\\s\\S]{0,400}?beginDiffViewportChurn\\(\\)").test(core);
  assert.ok(arms("applyTheme"), "the app palette arms the settle before it repaints");
  assert.ok(arms("applySyntaxTheme"), "the syntax family does too");
  assert.ok(arms("paintUiScale"), "and the page's own zoom");
  // ⌘+/⌘− are menu accelerators: main zooms the view and only tells the renderer afterwards, so that path has
  // to arm the settle itself or the keyboard stays exactly as slow as it was.
  assert.match(
    core,
    /onUiScale\(function \(next\) \{[\s\S]{0,200}?beginDiffViewportChurn\(\)/,
    "the ⌘+/⌘− notification from main arms it too",
  );
});
