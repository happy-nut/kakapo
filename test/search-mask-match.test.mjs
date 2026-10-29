import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProjectSearchMasks, projectSearchMaskAllows } from "../dist/search.js";

/**
 * The matcher replaced a compiled regular expression, so prove it agrees with the one it replaced on
 * every mask the field accepts, and that no accepted mask can stall the search any more.
 */

// Exactly the compiler that shipped before, as the oracle.
function legacyMaskToRegExp(mask) {
  const pattern = mask
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${pattern}$`);
}

test("the mask matcher agrees with the regular expression it replaced", () => {
  const masks = [
    "*.ts", "*.d.ts", "*service*.java", "ts", ".ts", "*", "**", "*.*", "?.ts", "a?c.txt",
    "*a*b*", "a*", "*a", "readme.md", "*.{ts,js}", "[abc].ts", "x+y.ts", "a..b",
  ].flatMap((mask) => normalizeProjectSearchMasks([mask]));
  const names = [
    "app.ts", "app.d.ts", "userservice.java", "user.java", "a.ts", "abc.ts", "a", "", "aab",
    "readme.md", "*.{ts,js}", "x+y.ts", "[abc].ts", "ab", "aXbYc", "a.b.c.ts", "service.java",
  ];
  let compared = 0;
  for (const mask of masks) {
    const oracle = legacyMaskToRegExp(mask);
    for (const name of names) {
      assert.equal(
        projectSearchMaskAllows(name, [mask]),
        oracle.test(name),
        `mask ${JSON.stringify(mask)} vs name ${JSON.stringify(name)}`,
      );
      compared += 1;
    }
  }
  assert.ok(compared > 200, `only compared ${compared} pairs`);
});

test("a mask the field accepts cannot stall the search", () => {
  // 48 characters, the field's whole budget, and 24 wildcards: the regular expression needed 1.07s for a
  // 33-character name and ten times that for every two characters more.
  const mask = "*a".repeat(24);
  assert.deepEqual(normalizeProjectSearchMasks([mask]), [mask], "the field really does accept this");
  const name = `${"a".repeat(250)}b`; // fails only at the last character: the worst case
  const started = process.hrtime.bigint();
  assert.equal(projectSearchMaskAllows(name, [mask]), false);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, `one file took ${ms.toFixed(1)}ms, and this runs once per file of the index`);
});

test("the matcher still answers the masks a reviewer types", () => {
  assert.ok(projectSearchMaskAllows("src/api/UserService.java", ["*service*.java"]));
  assert.ok(!projectSearchMaskAllows("src/api/User.java", ["*service*.java"]));
  assert.ok(projectSearchMaskAllows("src/app.ts", ["*.ts", "!*.d.ts"]));
  assert.ok(!projectSearchMaskAllows("src/app.d.ts", ["*.ts", "!*.d.ts"]));
  assert.ok(projectSearchMaskAllows("deep/nested/dir/name.ts", ["*.ts"]), "the mask names the file, not the path");
});
