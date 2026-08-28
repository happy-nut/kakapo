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
import { createRequire } from "node:module";

const preload = readFileSync(new URL("../src/preload.cts", import.meta.url), "utf8");
const ESC = String.fromCharCode(27);

// ---- the way back: pty output → xterm (issue #34) ---------------------------------------------------------
//
// xterm joins a conjoining jamo (U+1160–U+11FF, zero width) into the cell before it only while the parser's
// precedingJoinState is intact, and any escape sequence resets it — tmux and ink-style TUIs put an SGR
// between styled spans as a matter of course. composeTerminalOutput (preload) pulls the jamo back over the
// SGR run and composes to NFC before the bytes reach xterm. Extracted here the same way the write-side test
// reads the bridge, and proven against the real xterm build: the full DOM renderer never boots under node,
// but the parser and buffer do, which is exactly the layer this bug lives in.
const helper = preload.match(/const CONJOINING_JAMO[\s\S]*?\nfunction composeTerminalOutput[\s\S]*?\n\}/)?.[0];
assert.ok(helper, "composeTerminalOutput exists in the bridge");
const composeTerminalOutput = new Function(
  `${helper.replace("(data: string): string", "(data)")}; return composeTerminalOutput;`
)();

function makeHeadlessTerminal() {
  globalThis.self = globalThis;
  globalThis.window = globalThis;
  globalThis.document = globalThis.document || {
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }),
  };
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/xterm");
  return new Terminal({ cols: 40, rows: 5 });
}
const write = (term, data) => new Promise((res) => term.write(data, res));
function row0Cells(term) {
  const line = term.buffer.active.getLine(0);
  const cells = [];
  for (let x = 0; x < term.cols; x++) {
    const cell = line.getCell(x);
    if (cell && cell.getChars()) cells.push({ x, width: cell.getWidth(), chars: cell.getChars() });
  }
  return cells;
}

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

test("an SGR between jamo splits the syllable in xterm's own buffer — the bug, reproduced", async () => {
  const term = makeHeadlessTerminal();
  const [L, V] = "조".normalize("NFD"); // ᄌ + ᅩ
  await write(term, `${L}${ESC}[m${V}`);
  const cells = row0Cells(term);
  assert.equal(cells.length, 2, "the vowel took a cell of its own instead of joining the lead");
  assert.equal(cells[0].chars, L, "lead jamo alone in a wide cell");
  assert.equal(cells[1].chars, V, "vowel stranded in the next cell");
});

test("the same bytes through the bridge land as one composed cell", async () => {
  const term = makeHeadlessTerminal();
  const [L, V] = "조".normalize("NFD");
  await write(term, composeTerminalOutput(`${L}${ESC}[m${V}`));
  const cells = row0Cells(term);
  assert.equal(cells.length, 1, "one syllable, one cell");
  assert.equal(cells[0].chars, "조", "composed to NFC");
  assert.equal(cells[0].width, 2, "wide, as a syllable is");
});

test("two SGR gaps in one syllable both close (L·SGR·V·SGR·T)", () => {
  const [L, V, T] = "좁".normalize("NFD");
  const out = composeTerminalOutput(`${L}${ESC}[1m${V}${ESC}[m${T}after`);
  assert.ok(out.startsWith("좁"), `syllable leads: ${JSON.stringify(out)}`);
  assert.equal(out, `좁${ESC}[1m${ESC}[m` + "after", "both SGRs kept, in order, after the syllable");
});

test("what must pass through untouched does", () => {
  // ASCII, bare escapes, NFC Hangul: the probe skips them all — same string out, no normalise cost.
  for (const raw of ["ls -la", `${ESC}[31mred${ESC}[m`, "조합 완료", `${ESC}[1;2H`, ""]) {
    assert.equal(composeTerminalOutput(raw), raw, JSON.stringify(raw));
  }
  // A cursor move between jamo is a real relocation — text must not travel across it. The jamo still
  // composes with what sits beside it, but nothing crosses the escape.
  const [L, V] = "조".normalize("NFD");
  const moved = composeTerminalOutput(`${L}${ESC}[2;1H${V}`);
  assert.ok(moved.includes(`${ESC}[2;1H`), "the move survives");
  assert.ok(moved.indexOf(L) < moved.indexOf(`${ESC}[2;1H`), "and the lead stays before it");
});

test("NFD split across two writes still composes without help — the bridge only guards the escape case", async () => {
  // xterm's precedingJoinState survives a chunk boundary, so per-chunk transformation can stay per-chunk:
  // a syllable whose jamo straddle two writes joins on its own, and the bridge must not make it worse.
  const term = makeHeadlessTerminal();
  const NFD = "조".normalize("NFD");
  await write(term, composeTerminalOutput(NFD.slice(0, 1)));
  await write(term, composeTerminalOutput(NFD.slice(1)));
  const cells = row0Cells(term);
  assert.equal(cells.length, 1, "joined across the chunk boundary");
  assert.equal(cells[0].chars.normalize("NFC"), "조");
});

test("the bridge applies it on the way in: onData routes through composeTerminalOutput", () => {
  const onData = preload.match(/onData: \(cb[\s\S]*?\n  \},/)?.[0];
  assert.ok(onData, "the pty output crosses here");
  assert.match(onData, /composeTerminalOutput/, "and is composed on the way");
  assert.match(onData, /typeof msg\?\.data === "string"/, "guarding a payload that is not text");
});
