// The 26 viewer slices are concatenated into ONE global script scope (copy-viewer-assets.mjs), so two
// slices declaring the same top-level name is a real hazard: a duplicate `let`/`const`/`class` is a
// SyntaxError that kills the entire bundle, and a duplicate `function`/`var` silently shadows (last wins).
// The repo has no ESLint; this is the in-idiom source-lint guarding that collision, with a clear message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "viewer");
// Top-level declarations sit at column 0 in these unwrapped slices; anything indented is inside a function/
// block/IIFE and is correctly out of scope. Multi-declarator/destructuring forms aren't matched — this is a
// conservative guard for the common (and dangerous) `function foo` / `const foo =` collision.
const TOP_LEVEL_DECL = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

test("no viewer slice redeclares a top-level name from another slice", () => {
  const owners = new Map(); // name -> declaring file
  const collisions = [];
  for (const file of readdirSync(VIEWER_DIR).filter((f) => f.endsWith(".js")).sort()) {
    const seenHere = new Set();
    for (const line of readFileSync(join(VIEWER_DIR, file), "utf8").split(/\r?\n/)) {
      const m = TOP_LEVEL_DECL.exec(line);
      if (!m) continue;
      const name = m[1];
      if (seenHere.has(name)) continue; // a name repeated within one file is that file's own re-decl, not cross-slice
      seenHere.add(name);
      const prior = owners.get(name);
      if (prior && prior !== file) collisions.push(`${name}: ${prior} + ${file}`);
      else owners.set(name, file);
    }
  }
  assert.deepEqual(collisions, [], `top-level name collision across concatenated viewer slices:\n  ${collisions.join("\n  ")}`);
});
