import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { findRipgrepBinary, normalizeProjectSearchMasks, parseRipgrepJsonLine, projectSearchMaskAllows, searchProject } from "../dist/search.js";

test("project search resolves the bundled ripgrep without relying on PATH", async () => {
  assert.equal(findRipgrepBinary({ PATH: "" }), rgPath);
  await access(rgPath);
});

test("ripgrep JSON parser expands submatches and converts UTF-8 byte offsets to source columns", () => {
  const text = "한글 needle needle\n";
  const firstStart = Buffer.byteLength("한글 ", "utf8");
  const secondStart = Buffer.byteLength("한글 needle ", "utf8");
  const line = JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/unicode.ts" },
      lines: { text },
      line_number: 7,
      submatches: [
        { match: { text: "needle" }, start: firstStart, end: firstStart + 6 },
        { match: { text: "needle" }, start: secondStart, end: secondStart + 6 },
      ],
    },
  });

  assert.deepEqual(parseRipgrepJsonLine(line), [
    { path: "src/unicode.ts", line: 7, column: 4, endColumn: 10, text: "한글 needle needle", matchText: "needle" },
    { path: "src/unicode.ts", line: 7, column: 11, endColumn: 17, text: "한글 needle needle", matchText: "needle" },
  ]);
});

test("ripgrep JSON parser ignores summary and malformed stream messages", () => {
  assert.deepEqual(parseRipgrepJsonLine('{"type":"summary","data":{}}'), []);
  assert.deepEqual(parseRipgrepJsonLine('not json'), []);
});

test("project search normalizes extension filters and excludes comments and test files", async () => {
  // IntelliJ's mask, not a bare extension: a plain `ts` still means `*.ts` (that is what the field always
  // took), a glob passes through, `!` excludes, and a path is still not a mask — that is what the scope is.
  assert.deepEqual(normalizeProjectSearchMasks([".TS", "*.py", "ts", "bad/path"]), ["*.ts", "*.py"]);
  assert.deepEqual(normalizeProjectSearchMasks(["*Service*.java", "!*.min.js"]), ["*service*.java", "!*.min.js"]);
  assert.ok(projectSearchMaskAllows("src/api/UserService.java", ["*service*.java"]));
  assert.ok(!projectSearchMaskAllows("src/api/User.java", ["*service*.java"]));
  assert.ok(projectSearchMaskAllows("src/app.ts", ["*.ts", "!*.d.ts"]));
  assert.ok(!projectSearchMaskAllows("src/app.d.ts", ["*.ts", "!*.d.ts"]), "an exclusion beats an inclusion");
  assert.ok(projectSearchMaskAllows("src/anything.rb", []), "no mask filters nothing");
  const root = await mkdtemp(join(tmpdir(), "kakapo-search-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "src", "main.ts"), "const needle = 1;\n// needle in a comment\n");
    await writeFile(join(root, "src", "main.py"), "needle = 2\n");
    await writeFile(join(root, "tests", "main.test.ts"), "const needle = 3;\n");

    const result = await searchProject(root, "needle", 50, {
      extensions: [".ts"],
      excludeCommentsAndTests: true,
    });
    assert.equal(result.available, true);
    assert.deepEqual(result.matches.map((match) => [match.path, match.line]), [["src/main.ts", 1]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// IntelliJ's three Find in Files modifiers. One ripgrep flag each, so what is worth testing is that each
// flag reaches ripgrep and changes the answer — and that a pattern ripgrep rejects comes back as an error
// rather than as "nothing matched", which is the one way this could be wrong and look right.
test("match case, whole words and regex each change what project search finds", async () => {
  const root = await mkdtemp(join(tmpdir(), "kakapo-search-mods-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), [
      "const Needle = 1;",      // 1  capital
      "const needles = 2;",     // 2  lower, longer word
      "const needle = 3;",      // 3  lower, exact word
    ].join("\n") + "\n");
    const lines = async (options) =>
      (await searchProject(root, options.query ?? "needle", 50, options)).matches.map((m) => m.line);

    // Off: smart-case, literal, anywhere in the line — a lower-case query finds the capital too.
    assert.deepEqual(await lines({}), [1, 2, 3]);
    assert.deepEqual(await lines({ matchCase: true }), [2, 3], "`Cc` stops it matching Needle");
    assert.deepEqual(await lines({ wholeWords: true }), [1, 3], "`W` stops it matching needles");
    assert.deepEqual(await lines({ matchCase: true, wholeWords: true }), [3], "and both together");
    assert.deepEqual(await lines({ query: "needle[s]", regex: true }), [2], "`.*` reads the query as a pattern");
    assert.deepEqual(await lines({ query: "needle[s]" }), [], "and without it, as the literal it is");

    const broken = await searchProject(root, "needle(", 50, { regex: true });
    assert.equal(broken.available, false, "an unparseable pattern failed — it did not find nothing");
    assert.match(String(broken.error), /regex|parse|unclosed/i, broken.error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
