import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProjectSearchMasks, projectSearchMaskAllows } from "../dist/search.js";

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
  const mask = "*a".repeat(24);
  assert.deepEqual(normalizeProjectSearchMasks([mask]), [mask], "the field really does accept this");
  const name = `${"a".repeat(250)}b`;
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
