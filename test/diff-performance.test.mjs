import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const layers = readFileSync(new URL("../src/viewer/00-diff-layers.js", import.meta.url), "utf8");

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
