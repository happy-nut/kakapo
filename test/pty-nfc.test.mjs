// Everything the app types into a shell leaves the bridge as NFC.
//
// macOS hands Hangul to the web layer DECOMPOSED. "지금 캠페인" arrives as fourteen code points instead of six,
// and a terminal draws code points — so the agent's composer showed the reader's own sentence spelled out one
// jamo per cell. That is the "자모 분리" reported through this session, and it was blamed in turn on the IME,
// on the caret drawn under the composition, and on xterm's composition handling. None of them were it: the
// string was already decomposed before any of that ran, which is why a broken syllable could be logged with no
// output, no re-flow and no anchor movement anywhere near it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const preload = readFileSync(new URL("../src/preload.cts", import.meta.url), "utf8");
const ESC = String.fromCharCode(27);

test("the observed decomposition is exactly what the screenshot showed", () => {
  const typed = "지금 캠페인";
  const decomposed = typed.normalize("NFD");
  assert.equal([...decomposed].length, 14, "macOS's form is one code point per jamo");
  assert.equal([...typed.normalize("NFC")].length, 6, "…against six composed syllables");
  assert.notEqual(decomposed, typed, "so a terminal draws a different string than the reader typed");
  assert.equal(decomposed.normalize("NFC"), typed, "and composing it back is lossless");
});

test("NFC cannot disturb anything else that goes down the same pipe", () => {
  // The bracketed-paste markers, control bytes and ordinary ASCII all share this call.
  const samples = [`${ESC}[200~text${ESC}[201~`, "\r", "", "ls -la | grep x", "", "café"];
  for (const raw of samples) {
    assert.equal(raw.normalize("NFC").normalize("NFC"), raw.normalize("NFC"), "idempotent");
  }
  for (const raw of samples.slice(0, 5)) {
    assert.equal(raw.normalize("NFC"), raw, `${JSON.stringify(raw)} is untouched`);
  }
  // The one that is not: a combining accent composes, which is the point of doing this at all.
  assert.equal("café".normalize("NFC"), "café");
});

test("the bridge is the one place it happens, so no call site can forget", () => {
  const write = preload.match(/write: \(msg: \{ id: number; data: string \}\)[\s\S]*?\n.*\n/)?.[0];
  assert.ok(write, "the pty write crosses here");
  assert.match(write, /normalize\("NFC"\)/, "and normalises on the way");
  assert.match(write, /typeof msg\?\.data === "string"/, "guarding a caller that sends something else");

  // Several call sites reach a pty; none of them may normalise on their own, or the choke point stops being one.
  const term = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");
  const writes = (term.match(/kakapoPty\.write\(/g) ?? []).length;
  assert.ok(writes >= 4, `expected several pty write sites, found ${writes}`);
  assert.ok(!/normalize\((["'])NF/.test(term), "the terminal slice leaves it to the bridge");
});
