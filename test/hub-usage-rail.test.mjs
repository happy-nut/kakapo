// Regression for the collapsed rail's usage battery: when a provider has no percentage window (Claude's
// token-count fallback), uGroup() emits the icon with no ring SVG around it. jsdom has no layout engine, so
// it can't reproduce the visual collapse directly (getBoundingClientRect is always zero there) — instead this
// asserts the CSS rule that gives .usage-ring-wrap its own footprint, which is what keeps the icon from
// collapsing onto the .usage-cell-num text below it regardless of whether a ring is present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hubHtml } from "../dist/shell-pages.js";

const t = (key) => key;

test(".usage-ring-wrap has a fixed footprint so a ring-less cell (token-count fallback) can't collapse", () => {
  const html = hubHtml(false, "1.0.0", t);
  const rule = html.match(/\.usage-ring-wrap\{[^}]*\}/)?.[0];
  assert.ok(rule, ".usage-ring-wrap rule should exist in the hub stylesheet");
  assert.match(rule, /width:26px/, "wrap must reserve the ring's own width even without a ring child");
  assert.match(rule, /height:26px/, "wrap must reserve the ring's own height even without a ring child");
});
