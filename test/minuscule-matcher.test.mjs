// IntelliJ's name matcher (src/viewer/00-minuscule.js), checked against the behaviour of the real one.
//
// Every expectation in the first test was produced by RUNNING the shipped matcher, not by reading it:
// a small Java program built `NameUtil.buildMatcher(pattern).build()` off
// `IntelliJ IDEA CE.app/Contents/lib/*.jar` on its own bundled JRE and printed
// `matchingFragments` + `matchingDegree` for each pair. The port was wrong three times and each time
// only the run said so:
//
//   * `Strings.trimEnd(pattern, "* ")` trims the literal two-character suffix `"* "`, not the SET
//     {'*',' '} — so a pattern may end in a bare space, and that space is a feature (see below).
//   * `matchingDegree(name)` passes `valueStartCaseMatch = FALSE`. Guessing true adds +149 to most
//     rows (the 150-for-a-first-character branch instead of the 1-for-a-hump one).
//   * `Strings.indexOf(pattern, c, from, end, false)`'s last argument is `caseSensitive`, so the scan
//     for the corresponding pattern character IGNORES case. Reading it as `ignoreCase` costs more than
//     one term: it returns -1 for every hump typed in lower case, which breaks out of the fragment
//     early and leaves the skipped-hump penalty wrong for every fragment after it.
//   * `MinusculeMatcherImpl` has its OWN `nextWord` — a digit advances by one instead of swallowing the
//     digit run, so each digit is a hump of its own. Worth 1 point on `x1` against `x21`, and nothing
//     but a run would ever have found it.
//
// To re-measure after changing the matcher, see the note at the bottom of this file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/viewer/00-minuscule.js", import.meta.url), "utf8");
const box = {};
new Function(`${source}
;this.minusculeMatcher = minusculeMatcher;
 this.minusculeQueryScore = minusculeQueryScore;
 this.minusculeMatchesQuery = minusculeMatchesQuery;
 this.minusculeQueryRanges = minusculeQueryRanges;
 this.nameUtilIsWordStart = nameUtilIsWordStart;
 this.nameUtilNextWord = nameUtilNextWord;`).call(box);

const shape = (pattern, name) => {
  const m = box.minusculeMatcher(pattern);
  const fragments = m.fragments(name);
  return [
    fragments === null ? "null" : fragments.map((r) => `${r.start}-${r.end}`).join(",") + (fragments.length ? "," : ""),
    fragments === null ? -2147483648 : m.degree(name, fragments),
  ];
};

// pattern, name, fragments, degree — all four columns printed by the real IntelliJ matcher.
const MEASURED = [
  // Camel humps: the gesture the old `haystack.includes(query)` could not answer at all.
  ["SEC", "SearchEverywhereContributor", "0-1,6-7,16-17,", 1150],
  ["sec", "SearchEverywhereContributor", "0-2,16-17,", 980],
  ["qop", "quick-open.js", "0-1,6-8,", 982],
  // An all-caps run is ONE hump up to the capital that starts the next word, so `URL` matches
  // `URLLoader` and `RLL` — three letters that are really the end of one hump and the start of the
  // next — does not.
  ["URL", "URLLoader", "0-3,", 1152],
  ["RLL", "URLLoader", "null", -2147483648],
  // A bare pattern is anchored at the START. This is the fact that decides how the app has to call the
  // matcher: every list here searches paths, so queryMatcher() prefixes '*'.
  ["quick", "quickOpen", "0-5,", 1003],
  ["quick", "aQuickOpenThing", "null", -2147483648],
  ["foo", "foobar", "0-3,", 1003],
  ["foo", "barfoo", "null", -2147483648],
  ["*foo", "barfoo", "3-6,", 2],
  // A space is a wildcard, which is how `se cont` means "then, later, another word".
  ["se cont", "SearchEverywhereContributor", "0-2,16-20,", 980],
  // ...and a TRAILING space asks for a literal space in the name, not for the word to end. `get `
  // therefore matches neither `getName` nor `getter` — both lack a space.
  ["get ", "getName", "null", -2147483648],
  ["get ", "getter", "null", -2147483648],
  // A '.' in the pattern lets the match cross a '.' in the name; without one it may not.
  ["a.b", "a.b.c", "0-3,", 1005],
  ["ab", "a.b", "0-1,2-3,", 983],
  // Two pattern digits running together may not skip a name digit.
  ["x1", "x21", "0-1,2-3,", 994],
  ["x1", "x1y", "0-2,", 1004],
  ["renderQ", "renderQuickOpenResults", "0-7,", 1053],
  ["rqor", "renderQuickOpenResults", "0-1,6-7,11-12,15-16,", 970],
];

test("the matcher answers exactly as the shipped IntelliJ matcher does", () => {
  for (const [pattern, name, fragments, degree] of MEASURED) {
    assert.deepEqual(shape(pattern, name), [fragments, degree],
      `${JSON.stringify(pattern)} against ${JSON.stringify(name)}`);
  }
});

// NameUtilCore.isWordStart / nextWord are where every hump in the file comes from, so they are checked
// on their own: a fault here reads as a scoring fault several layers up.
test("where a word starts", () => {
  const starts = (name) => Array.from(name).map((_, i) => i).filter((i) => box.nameUtilIsWordStart(name, i));
  assert.deepEqual(starts("renderQuickOpen"), [0, 6, 11], "a capital after a lower-case letter");
  assert.deepEqual(starts("URLLoader"), [0, 3], "an all-caps run is one word up to the next word's capital");
  assert.deepEqual(starts("quick-open"), [0, 6], "a letter after a separator");
  // Every digit starts a word — but the letter AFTER a digit does not, because its previous character
  // is still a letter-or-digit. Measured, not reasoned: `[0, 1, 2, 3]` was the obvious guess and the
  // shipped NameUtilCore says `[0, 1, 2]`.
  assert.deepEqual(starts("x21y"), [0, 1, 2], "every digit — but not the letter after them");

  // nextWord walks those humps. Two measured surprises here too: a separator is a step of its own (so
  // `quick-open` walks 0, 5, 6 and not 0, 6), and a run of digits is ONE word — which is exactly where
  // the matcher's own nextWord differs, stepping one digit at a time for scoring.
  const walk = (name) => { const out = []; for (let i = 0; i < name.length; i = box.nameUtilNextWord(name, i)) out.push(i); return out; };
  assert.deepEqual(walk("renderQuickOpen"), [0, 6, 11]);
  assert.deepEqual(walk("URLLoader"), [0, 3]);
  assert.deepEqual(walk("quick-open"), [0, 5, 6], "the '-' is a word of its own");
  assert.deepEqual(walk("x21y"), [0, 1, 3], "the digit run is one word here");
});

// How the app asks: a '*'-prefixed matcher over a path-shaped haystack.
test("a query matches inside a path, and a word start outranks the middle of a word", () => {
  const queries = ["open"];
  assert.equal(box.minusculeMatchesQuery("src/viewer/03-quick-open.js", queries), true,
    "'open' reaches a name in the middle of a path");
  assert.equal(box.minusculeMatchesQuery("src/viewer/03-quick-open.js", ["qop"]), true,
    "...and so does the camel/separator hump form");
  assert.equal(box.minusculeMatchesQuery("src/render.ts", queries), false, "and does not match what it is not in");

  // The ranking the two hand-made ladders could not do: both of these CONTAIN 'open', so `includes`
  // called them equal.
  const atWordStart = box.minusculeQueryScore(["quick-open.js", "src/viewer/quick-open.js"], queries);
  const midWord = box.minusculeQueryScore(["reopener.js", "src/viewer/reopener.js"], queries);
  assert.ok(atWordStart > midWord, `word start ${atWordStart} must beat mid-word ${midWord}`);

  // A name hit beats a path hit, which is what MINUSCULE_PATH_PENALTY is for: typing `render` should
  // reach `render.ts` before a file that merely lives in a folder called `render`.
  const inName = box.minusculeQueryScore(["render.ts", "src/render.ts"], ["render"]);
  const inPath = box.minusculeQueryScore(["index.ts", "src/render/index.ts"], ["render"]);
  assert.ok(inName > inPath, `name ${inName} must beat path ${inPath}`);

  assert.equal(box.minusculeQueryScore(["nothing.ts", "src/nothing.ts"], queries), -Infinity, "no match is no score");
});

// The visible half: a row has to be able to show WHICH characters answered, or a hump match reads as a
// list that guessed.
test("the matched characters come back for drawing", () => {
  assert.deepEqual(box.minusculeQueryRanges("SearchEverywhereContributor", ["SEC"]),
    [{ start: 0, end: 1 }, { start: 6, end: 7 }, { start: 16, end: 17 }], "one range per hump");
  assert.deepEqual(box.minusculeQueryRanges("quick-open.js", ["open"]), [{ start: 6, end: 10 }]);
  assert.deepEqual(box.minusculeQueryRanges("quick-open.js", ["zzz"]), [], "nothing to draw when nothing matched");
  assert.deepEqual(box.minusculeQueryRanges("", ["open"]), [], "and nothing to draw on an empty string");
});

// An empty query matches everything and ranks nothing — the state the box is in when a list first opens.
test("an empty query matches everything at degree zero", () => {
  assert.equal(box.minusculeMatchesQuery("anything at all", [""]), true);
  assert.equal(box.minusculeQueryScore(["anything", "src/anything"], [""]), 0);
});

// A pasted blob must not send the backtracker exponential. Over 100 characters IntelliJ drops to a
// plain substring test, and this asserts the cheap path answers rather than that it is fast — a timing
// assertion would be a bet on the clock.
test("an over-long pattern falls back to a substring test", () => {
  const long = "a".repeat(120);
  assert.equal(box.minusculeMatcher(long).fragments(`${long}b`) !== null, true, "the prefix form still matches");
  assert.equal(box.minusculeMatcher(long).fragments("short") === null, true);
  assert.equal(box.minusculeMatcher(`*${long}`).fragments(`xx${long}`) !== null, true, "and so does the infix form");
});

// ---- Re-measuring ------------------------------------------------------------------------------
// MEASURED above is a recording of another program's output, so it can only be refreshed by running
// that program again — do not "fix" a row by reasoning about what the matcher ought to say.
//
//   IDEA="/Applications/IntelliJ IDEA CE.app"
//   CP=$(ls "$IDEA/Contents/lib/"*.jar | tr '\n' ':')
//   # A main() that, for each pair: NameUtil.buildMatcher(pattern).build(),
//   # then matchingFragments(name) and matchingDegree(name).
//   "$IDEA/Contents/jbr/Contents/Home/bin/javac" -cp "$CP" -d out Probe.java
//   "$IDEA/Contents/jbr/Contents/Home/bin/java"  -cp "$CP:out" Probe
//
// buildMatcher().build() returns a FixingLayoutMatcher, which for an ASCII pattern delegates every one
// of these calls straight to MinusculeMatcherImpl — so it is the same answer, and the keyboard-layout
// fallback it adds is the job queryVariants() already does here for Hangul.
