import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "viewer");
const TOP_LEVEL_DECL = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

test("no viewer slice redeclares a top-level name from another slice", () => {
  const owners = new Map();
  const collisions = [];
  for (const file of readdirSync(VIEWER_DIR).filter((f) => f.endsWith(".js")).sort()) {
    const seenHere = new Set();
    for (const line of readFileSync(join(VIEWER_DIR, file), "utf8").split(/\r?\n/)) {
      const m = TOP_LEVEL_DECL.exec(line);
      if (!m) continue;
      const name = m[1];
      if (seenHere.has(name)) continue;
      seenHere.add(name);
      const prior = owners.get(name);
      if (prior && prior !== file) collisions.push(`${name}: ${prior} + ${file}`);
      else owners.set(name, file);
    }
  }
  assert.deepEqual(collisions, [], `top-level name collision across concatenated viewer slices:\n  ${collisions.join("\n  ")}`);
});
