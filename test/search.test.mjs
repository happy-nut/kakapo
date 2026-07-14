import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { rgPath } from "@vscode/ripgrep";
import { findRipgrepBinary, parseRipgrepJsonLine } from "../dist/search.js";

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
