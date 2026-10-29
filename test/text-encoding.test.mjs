// A text file kakapo cannot decode is a file the reviewer cannot read, and the symptom is the same whatever
// the extension: "Source preview unavailable: binary file".
//
// The binary test is a NUL byte in the first 8KB — git's own heuristic, and right for a .png or a .class.
// But every other byte of UTF-16 text IS a NUL, so a UTF-16 MANIFEST.MF, .properties or .csv (PowerShell's
// `>` and a good deal of Windows tooling still write them) was refused as binary, and reading one as UTF-8
// would have shown mojibake anyway. A byte-order mark says what the file is; honour it in both places.
//
// UTF-32 stays binary on purpose: its NULs are not something swap16 can undo, so refusing it is better than
// showing four bytes per character.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLikelyBinary, readTextFile, decodeTextBuffer } from "../dist/util.js";
import { materializeDeferredSourceFile } from "../dist/diff.js";

const dirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-encoding-"));
  dirs.push(dir);
  return dir;
}
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const MANIFEST = "Manifest-Version: 1.0\r\nMain-Class: com.example.Main\r\n\r\n";
const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
const utf16be = (text) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
const utf8bom = (text) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);

function write(name, bytes) {
  const dir = scratch();
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

test("a UTF-16 text file is not binary, whichever byte order it is in", () => {
  assert.equal(isLikelyBinary(write("MANIFEST.MF", utf16le(MANIFEST))), false, "UTF-16LE");
  assert.equal(isLikelyBinary(write("MANIFEST.MF", utf16be(MANIFEST))), false, "UTF-16BE");
  assert.equal(isLikelyBinary(write("MANIFEST.MF", utf8bom(MANIFEST))), false, "UTF-8 with a BOM");
});

test("a file with a NUL and no BOM is still binary", () => {
  const bytes = Buffer.concat([Buffer.from("\xca\xfe\xba\xbe", "latin1"), Buffer.alloc(8), Buffer.from("payload")]);
  assert.equal(isLikelyBinary(write("Mod.class", bytes)), true);
  // UTF-32LE starts FF FE 00 00 — the UTF-16LE BOM followed by NULs. Reading it as text would show four
  // bytes per character, so the sniff must not be fooled by the prefix.
  assert.equal(isLikelyBinary(write("u32.txt", Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), Buffer.from("A\0\0\0B\0\0\0", "latin1")]))), true);
});

test("reading decodes by BOM and drops the mark", () => {
  for (const [label, bytes] of [["UTF-16LE", utf16le(MANIFEST)], ["UTF-16BE", utf16be(MANIFEST)], ["UTF-8 BOM", utf8bom(MANIFEST)]]) {
    const text = readTextFile(write("MANIFEST.MF", bytes));
    assert.equal(text, MANIFEST, label);
    // The mark left in the string is an invisible first character: a phantom column in the gutter, in find,
    // and in every offset handed to a language server.
    assert.equal(text.charCodeAt(0), "M".charCodeAt(0), label + ": no leading U+FEFF");
  }
  assert.equal(decodeTextBuffer(Buffer.from(MANIFEST, "utf8")), MANIFEST, "plain UTF-8 is unchanged");
  assert.equal(decodeTextBuffer(Buffer.alloc(0)), "", "an empty file decodes to an empty string");
  // An odd trailing byte would make swap16 throw; a truncated file should still open.
  assert.equal(
    decodeTextBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("A", "utf16le").swap16(), Buffer.from([0x00])])),
    "A",
    "a truncated UTF-16BE file loses the stray byte, not the file",
  );
});

test("opening a UTF-16 file in the app gives its text, not 'binary file'", () => {
  const dir = scratch();
  writeFileSync(join(dir, "MANIFEST.MF"), utf16le(MANIFEST));
  const record = materializeDeferredSourceFile(dir, {
    path: "MANIFEST.MF",
    name: "MANIFEST.MF",
    language: "text",
    content: "",
    size: 0,
    changed: false,
    embedded: false,
    deferred: true,
    signature: "x",
  });
  assert.equal(record.skippedReason, undefined, "no refusal reason");
  assert.equal(record.embedded, true, "the viewer is told the content is there");
  assert.equal(record.content, MANIFEST, "and it is the decoded text");
});
