// The 받침 that arrives after its syllable has already left.
//
// Traced three times from the 0.5.20 build: `end "겨"` — a healthy syllable, sent at once — then `end "ㅇ"`,
// the trailing consonant as a commit of its own. By then 겨 is down the pty, 경 can never be assembled, and
// the automaton is left holding a lone ㅇ with nothing to attach to.
//
// Holding every healthy syllable would fix it and cost every Hangul keystroke a 500ms maybe, which the design
// refused for good reason. So the hold is conditional: only a pane that has JUST had a composition aborted
// into bare jamo, and only when a 받침 could still attach. A pane whose IME behaves never waits at all.
//
// A measured control run (KAKAPO_IME_RAW=1) settled the premise this rests on: with every kakapo reach into
// xterm's composition path stood down, macOS aborted 8.5% of compositions (10/117) against 3.6% (12/331)
// with them on. The aborting is not kakapo's doing and cannot be prevented here — only repaired after.
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
  extract(/var HANGUL_BROKEN_WINDOW_MS = [^;]*;/),
  extract(/  function paneImeIsBroken\(pane\) \{[\s\S]*?\n  \}/),
  extract(/  function endsOpenSyllable\(text\) \{[\s\S]*?\n  \}/),
].join("\n");
const api = new Function(`${source}; return { endsOpenSyllable: endsOpenSyllable, paneImeIsBroken: paneImeIsBroken,
  HANGUL_BROKEN_WINDOW_MS: HANGUL_BROKEN_WINDOW_MS,
  // The automaton as takeCompositionCommit drives it: feed a commit, emit what closed, hold what is still open.
  run: function (commits) {
    var state = null, out = '';
    commits.forEach(function (c) {
      state = state || { out: '', cur: { cho: '', jung: '', jong: '' } };
      for (var i = 0; i < c.length; i++) hangulFeed(state, c[i]);
      out += state.out; state.out = '';
    });
    if (state) out += hangulJoin(state.cur); // the flush (timer, blur, or real input)
    return out;
  } };`)();

test("only a syllable that could still take a 받침 is worth holding", () => {
  assert.equal(api.endsOpenSyllable("겨"), true, "겨 has no 종성 — ㅇ can still land on it");
  assert.equal(api.endsOpenSyllable("다"), true);
  assert.equal(api.endsOpenSyllable("것"), false, "것 already has one; nothing more attaches");
  assert.equal(api.endsOpenSyllable("안"), false);
  assert.equal(api.endsOpenSyllable("지 "), false, "a commit that ended on a space is finished");
  assert.equal(api.endsOpenSyllable("?"), false);
  assert.equal(api.endsOpenSyllable("ㅇ"), false, "a bare jamo is not a syllable");
  assert.equal(api.endsOpenSyllable(""), false);
});

test("the hold is armed only while the pane's IME is actually coming apart", () => {
  assert.equal(api.paneImeIsBroken(null), false);
  assert.equal(api.paneImeIsBroken({}), false, "a pane that never saw a broken commit never waits");
  assert.equal(api.paneImeIsBroken({ __jamoAt: Date.now() }), true);
  assert.equal(api.paneImeIsBroken({ __jamoAt: Date.now() - (api.HANGUL_BROKEN_WINDOW_MS + 1000) }), false,
    "…and stops waiting once the IME has behaved for a while");
});

test("the traced failure now assembles instead of splitting", () => {
  // The exact sequence from the log: a healthy syllable, then its 받침 as a commit of its own.
  assert.equal(api.run(["겨", "ㅇ"]), "경", "겨 + ㅇ is 경, not 겨ㅇ");
  assert.equal(api.run(["브", "랜", "ㅊ", "ㅣ"]), "브랜치");
  // A 받침 that turns out to belong to the NEXT syllable (도깨비불) still moves across.
  assert.equal(api.run(["가", "ㅁ", "ㅏ"]), "가마");
  // And an already-closed syllable is untouched by what follows.
  assert.equal(api.run(["것 ", "다"]), "것 다");
});

test("the branch that routes a healthy commit into the hold is wired to both conditions", () => {
  const branch = client.match(/var broken = HANGUL_BARE_JAMO[\s\S]{0,600}?endsOpenSyllable\(event\.data\)[\s\S]{0,20}?\{/)?.[0];
  assert.ok(branch, "the commit branch is still where the routing happens");
  assert.match(branch, /pane\.__jamoAt = Date\.now\(\)/, "a bare-jamo commit arms the window");
  assert.match(branch, /paneImeIsBroken\(pane\) && endsOpenSyllable\(event\.data\)/,
    "a healthy commit is held only when BOTH hold — recently broken, and still open to a 받침");
  assert.match(branch, /pane\.__hangul \|\| broken \|\|/, "the existing two routes are unchanged");
});
