// src/viewer/*.js is 28 slices concatenated into ONE script (scripts/copy-viewer-assets.mjs), so there are no
// module boundaries: every cross-file call is an implicit global. The code defended itself with
// `if (typeof refreshComments === 'function') refreshComments();` — 189 of those — and that defence is a lie.
// The bundle is one script, so every top-level `function` declaration in it is hoisted before the first
// statement runs: the guard is ALWAYS true. What it actually did was swallow renames — delete or rename a
// function and its callers stop calling it, silently, with no error and no log (issue #29).
//
// So the ordering rules are checked here instead, where a violation is a failed test rather than a feature
// that quietly stops happening:
//   - a guarded name must EXIST (a rename that misses a call site fails here)
//   - a slice function is never guarded (hoisting makes the guard dead, and dead guards hide renames)
//   - nothing reads a `let`/`const` from a later slice (those are NOT hoisted; a load-time read throws a
//     ReferenceError that `typeof` cannot even catch, so file order is load-bearing for them)
//
// `var` bindings are deliberately not covered: 05-keymap.js's KEY_OWNERS names handlers four later slices
// assign (handleSettingsKey, handleTourKey …), reading them long after load, and `var` makes that undefined
// rather than a throw. Those guards are the real ones and they stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const viewerDir = fileURLToPath(new URL("../src/viewer/", import.meta.url));
const buildScript = readFileSync(new URL("../scripts/copy-viewer-assets.mjs", import.meta.url), "utf8");

// The load order is the build's list, not readdir() — that is the order the one script is assembled in.
const order = buildScript.match(/const VIEWER_SLICES = \[([\s\S]*?)\];/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
assert.equal(order.length, readdirSync(viewerDir).filter((f) => f.endsWith(".js")).length, "every slice is listed");

const sources = new Map(order.map((f) => [f, readFileSync(join(viewerDir, f), "utf8")]));

// Top-level declarations only (column 0) — those are the shared names. Anything indented is inside a scope.
const declarations = new Map();
order.forEach((file, index) => {
  sources.get(file).split("\n").forEach((line) => {
    const m = line.match(/^(function|var|let|const)\s+([A-Za-z_$][\w$]*)/);
    if (m && !declarations.has(m[2])) declarations.set(m[2], { file, index, kind: m[1] });
  });
});

// Provided by the browser/host, not by a slice: a `typeof` on these is a genuine capability check.
const HOST_GLOBALS = new Set(["window", "document", "fetch", "ResizeObserver", "IntersectionObserver"]);

// The one slice that is also executed OUTSIDE the bundle: the real-Chromium layout fixtures
// (test/fixtures/electron-{diff-layout,window-resize,comment-layout}.cjs) load it alone against a bare
// page to measure gutter geometry, so there its calls into other slices genuinely are absent. Its guards
// are load-bearing and stay.
const STANDALONE = new Set(["00-diff-layers.js"]);

function guards() {
  const found = [];
  for (const file of order) {
    sources.get(file).split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*[=!]==?\s*['"](function|undefined)['"]/g)) {
        found.push({ at: `${file}:${i + 1}`, name: m[1], expects: m[2] });
      }
    });
  }
  return found;
}

test("every name a viewer slice guards with typeof actually exists", () => {
  for (const guard of guards()) {
    assert.ok(
      declarations.has(guard.name) || HOST_GLOBALS.has(guard.name),
      `${guard.at}: nothing declares ${guard.name} — the guard is silently skipping this call`,
    );
  }
});

test("a function the bundle declares is never guarded — it is always there", () => {
  const dead = guards().filter((g) =>
    g.expects === "function" && declarations.get(g.name)?.kind === "function" && !STANDALONE.has(g.at.split(":")[0]));
  assert.deepEqual(
    dead.map((g) => `${g.at} ${g.name}`),
    [],
    "the slices are one script: function declarations hoist, so these guards can only ever hide a rename",
  );
});

test("no slice reads a let/const declared by a later slice", () => {
  const late = [];
  order.forEach((file, index) => {
    const text = sources.get(file);
    for (const [name, declaration] of declarations) {
      if (declaration.index <= index || declaration.kind === "function" || declaration.kind === "var") continue;
      if (new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(text)) {
        late.push(`${file} reads ${name} (${declaration.kind}, declared in ${declaration.file})`);
      }
    }
  });
  assert.deepEqual(late, [], "a let/const read before its slice loads throws — reorder the slice or make it a var");
});
