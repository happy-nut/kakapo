// Find in Files' three modifiers, from the page's side: that each one reaches the searcher, that the
// in-page fallback honours them itself, and that a pattern which cannot be compiled says so instead of
// coming back as "no matches".
//
// The flags' effect on ripgrep is in test/search.test.mjs; this is about the strip of toggles and what
// the page asks for. The fallback matters on its own because a standalone HTML review has no main
// process to ask: it used to be a literal smart-case indexOf, which would have gone on answering the
// unmodified question while the toggles claimed otherwise.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const SOURCE = [
  "const Needle = 1;",   // 0  capital
  "const needles = 2;",  // 1  lower, longer word
  "const needle = 3;",   // 2  lower, exact word
].join("\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/a.ts", before: "const needle = 0;\n", after: SOURCE + "\n" },
  ]));
});
after(cleanupFixtures);

const press = (v, init) => {
  v.document.dispatchEvent(new v.window.KeyboardEvent("keydown", { bubbles: true, ...init }));
  return v.settle(40);
};
const MATCH_CASE = { code: "KeyM", key: "m", altKey: true };
const WHOLE_WORDS = { code: "KeyW", key: "w", altKey: true };
const REGEX = { code: "KeyX", key: "x", altKey: true };

/** Find in Files, open, with `query` typed into it. */
async function openFindInFiles(v, query) {
  v.window.openQuickOpen("content");
  await v.settle(20);
  v.typeInto(v.$("#quick-open-input"), query);
  await v.settle(260); // the search is debounced
}

const pressed = (v, id) => v.$(id).getAttribute("aria-pressed");
const hitLines = (v) => v.$all("#quick-open-results .search-result")
  .map((row) => Number(row.querySelector(".quick-open-name").textContent.split(":")[1]));

test("each toggle travels to the searcher, and the strip says which are on", async () => {
  const asked = [];
  const v = await loadViewer(html, {
    searchBridge: (request) => {
      asked.push(request);
      return { available: true, engine: "ripgrep", matches: [], truncated: false };
    },
  });
  await openFindInFiles(v, "needle");
  assert.equal(asked.length, 1, "one search for the typed query");
  assert.ok(!("regex" in asked[0]) && !("matchCase" in asked[0]) && !("wholeWords" in asked[0]),
    "with nothing switched on, nothing is asked for");

  await press(v, MATCH_CASE);
  await press(v, WHOLE_WORDS);
  await press(v, REGEX);
  await v.settle(260);
  const last = asked[asked.length - 1];
  assert.equal(last.matchCase, true);
  assert.equal(last.wholeWords, true);
  assert.equal(last.regex, true);
  assert.deepEqual(
    ["#quick-open-match-case", "#quick-open-whole-words", "#quick-open-regex"].map((id) => pressed(v, id)),
    ["true", "true", "true"],
  );

  await press(v, REGEX);
  await v.settle(260);
  assert.equal(pressed(v, "#quick-open-regex"), "false", "pressed again, off again");
  assert.ok(!("regex" in asked[asked.length - 1]));
  v.close();
});

test("the toggles are clickable, not only chords", async () => {
  const asked = [];
  const v = await loadViewer(html, {
    searchBridge: (request) => { asked.push(request); return { available: true, engine: "ripgrep", matches: [], truncated: false }; },
  });
  await openFindInFiles(v, "needle");
  v.click(v.$("#quick-open-whole-words"));
  await v.settle(260);
  assert.equal(pressed(v, "#quick-open-whole-words"), "true");
  assert.equal(asked[asked.length - 1].wholeWords, true);
  v.close();
});

test("a pattern that cannot be compiled is named, and never asked", async () => {
  const asked = [];
  const v = await loadViewer(html, {
    searchBridge: (request) => { asked.push(request); return { available: true, engine: "ripgrep", matches: [], truncated: false }; },
  });
  await openFindInFiles(v, "needle");
  const before = asked.length;
  await press(v, REGEX);
  v.typeInto(v.$("#quick-open-input"), "needle(");
  await v.settle(300);
  assert.match(v.$("#quick-open-results").textContent, /not a pattern/,
    "'no matches' would be a wrong answer a reviewer would believe");
  assert.equal(asked.length, before, "and the searcher was never asked");

  v.typeInto(v.$("#quick-open-input"), "needle(s)?");
  await v.settle(300);
  assert.ok(asked.length > before, "a pattern that does compile is searched for");
  v.close();
});

// ---- the in-page fallback, which is the whole searcher in a standalone review --------------------

test("without a main process, the page's own search honours the three modifiers", async () => {
  const v = await loadViewer(html); // no searchBridge: localContentSearch answers
  await openFindInFiles(v, "needle");
  assert.deepEqual(hitLines(v), [1, 2, 3], "smart-case and literal: the capital matches too");

  await press(v, MATCH_CASE);
  await v.settle(260);
  assert.deepEqual(hitLines(v), [2, 3], "`Cc` stops it matching Needle");

  await press(v, WHOLE_WORDS);
  await v.settle(260);
  assert.deepEqual(hitLines(v), [3], "`W` stops it matching needles");

  await press(v, MATCH_CASE);
  await press(v, WHOLE_WORDS);
  await press(v, REGEX);
  v.typeInto(v.$("#quick-open-input"), "needle[s]");
  await v.settle(300);
  assert.deepEqual(hitLines(v), [2], "`.*` reads the query as a pattern");
  v.close();
});

test("the page's own search highlights what actually matched, not the query", async () => {
  const v = await loadViewer(html);
  await openFindInFiles(v, "needle");
  await press(v, REGEX);
  v.typeInto(v.$("#quick-open-input"), "needle(s)?");
  await v.settle(300);
  assert.deepEqual(v.$all("#quick-open-results .search-hit").map((hit) => hit.textContent),
    ["Needle", "needles", "needle"],
    "each hit is marked at the text that matched — the capital one because `Cc` is off, and `needles` "
    + "because the group did match, which a highlight keyed off the query's length would have cut short");
  v.close();
});

test("a pattern that can match nothing does not spin", async () => {
  const v = await loadViewer(html);
  await openFindInFiles(v, "needle");
  await press(v, REGEX);
  v.typeInto(v.$("#quick-open-input"), "e*");
  await v.settle(400);
  // The guard being checked is the lastIndex advance: a zero-length match at every position would never
  // terminate. Reaching an assertion at all is the result; the hits are the non-empty ones.
  assert.ok(hitLines(v).length > 0, "it finished, with the non-empty matches");
  v.close();
});
