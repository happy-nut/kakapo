// macOS sometimes aborts a Hangul composition against a busy renderer and commits bare jamo — 저 arrives
// as "ㅈ" then "ㅓ", one commit each (the ime-splits.jsonl signature). The abort is the OS's; what the
// terminal can do is refuse to pass a broken syllable to the pty: feed the pieces through a 두벌식
// automaton and hand over the syllables they were meant to be. The automaton is pure, so it is extracted
// from the slice and exercised directly (the terms-harvest pattern); the wiring is pinned by source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");

function extract(re) {
  const m = client.match(re)?.[0];
  assert.ok(m, `${re} found in 19-terminal.js`);
  return m;
}
const source = [
  extract(/var HANGUL_CHO = [\s\S]*?;/),
  extract(/var HANGUL_JUNG = [\s\S]*?;/),
  extract(/var HANGUL_JONG = [\s\S]*?;/),
  extract(/var HANGUL_JUNG_PAIRS = [\s\S]*?;/),
  extract(/var HANGUL_JONG_PAIRS = [\s\S]*?;/),
  extract(/var HANGUL_JONG_SPLIT = [\s\S]*?;/),
  extract(/var HANGUL_BARE_JAMO = [^;]*;/),
  extract(/function hangulSyllableParts\([\s\S]*?\n\}/),
  extract(/function hangulJoin\([\s\S]*?\n\}/),
  extract(/function hangulFeed\([\s\S]*?\n\}/),
].join("\n");
const feed = new Function(`${source}; return function (text) {
  var state = { out: '', cur: { cho: '', jung: '', jong: '' } };
  for (var i = 0; i < text.length; i++) hangulFeed(state, text[i]);
  return { closed: state.out, open: hangulJoin(state.cur) };
};`)();

const whole = (text) => { const r = feed(text); return r.closed + r.open; };

test("the split commits from the field logs reassemble into the syllables they were meant to be", () => {
  assert.equal(whole("ㅈㅓ"), "저");
  assert.equal(whole("ㅁㅏㄱㅗ"), "마고");
  assert.equal(whole("ㅇㅏㄴㄴㅕㅇ"), "안녕");
});

test("받침 rides the next commit — 했다 assembled across the burst", () => {
  assert.equal(whole("해ㅆㄷㅏ"), "했다");
  assert.equal(whole("ㅎㅐㅆㄷㅏ"), "했다");
});

test("도깨비불: a trailing consonant leaves its 받침 to open the next syllable", () => {
  assert.equal(whole("ㄱㅏㅂㅅㅏ"), "갑사"); // 값 then ㅏ steals the ㅅ
  assert.equal(whole("ㄱㅏㄴㅏ"), "가나");
});

test("겹모음 and 겹받침 combine; what cannot combine flushes cleanly", () => {
  assert.equal(whole("ㄱㅗㅏ"), "과");
  assert.equal(whole("ㅇㅜㅣ"), "위");
  assert.equal(whole("ㄱㅏㅂㅅ"), "값");
  assert.equal(whole("ㅋㅋㅋ"), "ㅋㅋㅋ"); // lone consonants never join each other
  assert.equal(whole("ㅏㅏ"), "ㅏㅏ"); // lone vowels that cannot pair stay themselves
});

test("syllables and other characters flow through, and an open syllable still grows", () => {
  assert.equal(whole("가ㄱ"), "각"); // a following consonant becomes the 받침 of the committed syllable
  assert.equal(whole("안녕 ㅎㅏ"), "안녕 하");
  assert.equal(whole("ab가"), "ab가");
});

test("the commit path routes bare-jamo commits through the automaton and holds the open syllable", () => {
  const take = extract(/function takeCompositionCommit\([\s\S]*?\n  \}/);
  assert.match(take, /var broken = HANGUL_BARE_JAMO\.test\(event\.data\)/,
    "a commit carrying bare jamo is what a broken composition looks like");
  assert.match(take, /pane\.__hangul \|\| broken \|\|/,
    "repair engages on bare jamo, or while a burst already holds state");
  // A third route was added after the traces showed the 받침 arriving as its own commit AFTER its syllable
  // had already been sent (겨 then ㅇ, which can never become 경). A healthy commit is held only when the
  // pane has JUST had a composition aborted and a 받침 could still attach — see ime-conditional-hold.
  assert.match(take, /paneImeIsBroken\(pane\) && endsOpenSyllable\(event\.data\)/,
    "…and, on a pane whose IME is currently coming apart, on a syllable still open to a 받침");
  assert.match(take, /service\.triggerDataEvent\(event\.data, true\)/,
    "…and the healthy path is still the old one, untouched and undelayed");
  assert.match(take, /HANGUL_REPAIR_FLUSH_MS/, "the open syllable is held only briefly");
  const flush = extract(/function flushHangulRepair\([\s\S]*?\n  \}/);
  assert.match(flush, /state\.out \+ hangulJoin\(state\.cur\)/, "a flush emits everything still held");
  // TYPED input still flushes first, so the pty sees the order the user typed. What changed: most of what
  // reaches onData was never typed — a TUI asks the terminal for its colours and identity, xterm answers, the
  // mouse reports every wheel notch — and those were cutting a syllable that was waiting for its vowel. An
  // answer always begins with ESC; nothing typed at a prompt does. See ime-abort-redelivery.
  assert.match(client, /if \(pane\.__hangul && d\.charCodeAt\(0\) !== 0x1b\) flushHangulRepair\(pane\);\s*\n\s*if \(pane\.id != null\) window\.kakapoPty\.write/,
    "ordinary input (Enter, Latin) flushes the hold first, so the pty sees the typed order");
});

// A desynced IME can re-offer a commit it believes was lost; xterm's other input paths (the insertText
// handler, the keydown-229 textarea diff) forward it to onData, and the word lands twice — the
// "전략에서도 전략에서도" regression. The commit was already written by takeCompositionCommit, so onData
// drops an identical arrival straight after it.
test("a commit re-delivered through xterm's other input paths is dropped, not written twice", () => {
  const take = extract(/function takeCompositionCommit\([\s\S]*?\n  \}/);
  assert.match(take, /service\.triggerDataEvent\(event\.data, true\);\s*\n\s*if \(pane\) pane\.__lastCommit/,
    "the commit is remembered AFTER the healthy hand-over — recording first would eat the write itself");
  assert.match(take, /pane\.__lastCommit = \{ data: event\.data, at: Date\.now\(\) \}/,
    "the raw commit is what echoes back, so the raw commit is what is remembered — not the repaired form");
  assert.match(client, /pane\.__lastCommit && d === pane\.__lastCommit\.data && Date\.now\(\) - pane\.__lastCommit\.at < 300/,
    "onData drops input identical to the just-written commit, once, inside a human-impossible window");
});
