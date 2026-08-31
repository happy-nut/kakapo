// One abort, two complaints.
//
// When macOS gives up on a composition it does not simply lose the syllable: it commits the fragment it had,
// then re-composes the SAME keystrokes and delivers the finished syllable a moment later. Both reached the
// pty. That is why "자모 분리" and "중복 출력" were always reported together — 아 landing on a held ㅇ was
// written out as "ㅇ아": the jamo shows, and the syllable appears twice. onData's exact-match echo guard
// cannot see it, because "ㅇ" and "아" are not the same string.
//
// The automaton is pure, so the rule is extracted from the slice and exercised directly.
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
  extract(/var HANGUL_CHO = [\s\S]*?;/), extract(/var HANGUL_JUNG = [\s\S]*?;/), extract(/var HANGUL_JONG = [\s\S]*?;/),
  extract(/var HANGUL_JUNG_PAIRS = [\s\S]*?;/), extract(/var HANGUL_JONG_PAIRS = [\s\S]*?;/),
  extract(/var HANGUL_JONG_SPLIT = [\s\S]*?;/), extract(/var HANGUL_BARE_JAMO = [^;]*;/),
  extract(/function hangulSyllableParts\([\s\S]*?\n\}/), extract(/function hangulJoin\([\s\S]*?\n\}/),
  extract(/function hangulSupersedes\([\s\S]*?\n\}/), extract(/function hangulFeed\([\s\S]*?\n\}/),
].join("\n");
// takeCompositionCommit's loop, in miniature: feed each commit, emit what closed, hold what is still open.
const drive = new Function(`${source}; return function (commits, fromAbort) {
  var state = { out: '', cur: { cho: '', jung: '', jong: '' }, fromAbort: !!fromAbort };
  var out = '';
  commits.forEach(function (c) {
    for (var i = 0; i < c.length; i++) hangulFeed(state, c[i]);
    out += state.out; state.out = '';
  });
  return out + hangulJoin(state.cur);
};`)();

test("a re-delivered syllable replaces the fragment the abort left behind", () => {
  assert.equal(drive(["ㅇ", "아"], true), "아", "ㅇ then 아 is one 아, not ㅇ아");
  assert.equal(drive(["ㅊ", "치"], true), "치");
  assert.equal(drive(["고", "곤"], true), "곤", "a syllable that has just gained its 받침 supersedes too");
  assert.equal(drive(["겨", "경"], true), "경");
});

test("two real syllables are still two", () => {
  assert.equal(drive(["고", "고"], true), "고고", "the same syllable typed twice is not a re-delivery");
  assert.equal(drive(["ㅇ", "가"], true), "ㅇ가", "a different 초성 was never what the fragment was becoming");
  // The cost, stated plainly: a lone held consonant cannot say WHICH syllable it was on its way to, so any
  // syllable with the same 초성 supersedes it. Typing a bare ㅋ immediately followed by 카 — with no space
  // between, and only inside the 5s window after a real abort — loses the ㅋ. A space, punctuation or any
  // other keystroke flushes the hold first, so it takes a deliberately adjacent pair to hit.
  assert.equal(drive(["ㅋ", "카"], true), "카", "the known cost of not being able to tell the two apart");
  assert.equal(drive(["안", "아"], true), "안아", "a fragment that already closed is not still becoming anything");
  assert.equal(drive(["가", "나"], true), "가나");
});

test("a syllable held for any other reason is never second-guessed", () => {
  // (C) holds healthy syllables too while a pane's IME is misbehaving. Those were not aborted, so a following
  // syllable is a following syllable — superseding there would silently eat the user's text.
  assert.equal(drive(["ㅇ", "아"], false), "ㅇ아");
  assert.equal(drive(["겨", "경"], false), "겨경");
  assert.match(client, /if \(broken\) state\.fromAbort = true;/, "only an aborted commit arms it");
});

test("the assembly the abort was supposed to get still works", () => {
  assert.equal(drive(["ㄱ", "ㅗ"], true), "고", "jamo that arrive separately still join");
  assert.equal(drive(["겨", "ㅇ"], true), "경", "a 받침 arriving alone still lands");
  assert.equal(drive(["가", "ㅁ", "ㅏ"], true), "가마", "도깨비불 still moves the 받침 across");
});

test("a terminal's own reply cannot cut a syllable that is waiting", () => {
  const onData = client.match(/term\.onData\(function \(d\) \{[\s\S]*?\n    \}\);/)?.[0];
  assert.ok(onData, "the pty input handler is still where writes leave the pane");
  assert.match(onData, /if \(pane\.__hangul && d\.charCodeAt\(0\) !== 0x1b\) flushHangulRepair\(pane\);/,
    "an ESC-prefixed answer (colour query, device attributes, a mouse report) flushes nothing");
});
