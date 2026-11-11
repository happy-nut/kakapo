// The matcher reaching the actual lists. test/minuscule-matcher.test.mjs proves the algorithm against the
// shipped IntelliJ one; this proves it is what the dialog asks, which is a different thing and the half
// that can rot on its own — the haystacks had to stop being lower-cased for any of it to work, and a
// stray `.toLowerCase()` put back anywhere would leave the matcher correct and the feature dead.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { loadViewer } from "./helpers/dom.mjs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";

after(cleanupFixtures);

const names = (v) => v.$all("#quick-open-results .quick-open-item")
  .map((r) => r.querySelector(".quick-open-name")?.textContent || "");
const marks = (v) => v.$all("#quick-open-results .quick-open-item .quick-open-name .usage-hit")
  .map((b) => b.textContent);

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    // A decoy to absorb the recent slot, which the review gives to its alphabetically FIRST path (not,
    // as it looks, to the first entry here — measured). It matters because `recentRank` is the BASE of a
    // row's rank and the match degree only adjusts it, so the recent file leads the list whatever is
    // typed. That is true before this port too — the old ladder's best was 3000 against a 9999 recency
    // spread — so it is left alone here rather than quietly changed along with the matcher.
    { path: "src/aaa-opened-first.ts", before: "export const z = 1;\n", after: "export const z = 2;\n" },
    { path: "src/viewer/quick-open.js", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "src/SearchEverywhereContributor.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
    { path: "src/bQuickOpenThing.ts", before: "export const c = 1;\n", after: "export const c = 2;\n" },
    { path: "src/render.ts", before: "export const d = 1;\n", after: "export const d = 2;\n" },
  ]));
});

const openFiles = async (v, typed) => {
  v.key("p", { metaKey: true });
  await v.settle(20);
  assert.ok(v.quickOpenVisible(), "⌘P opens the file list");
  v.typeInto(v.$("#quick-open-input"), typed);
  await v.settle(200);
};

test("camel humps reach a name the old substring rule could not", async () => {
  const v = await loadViewer(html);
  await openFiles(v, "SEC");
  assert.deepEqual(names(v), ["SearchEverywhereContributor.ts"],
    "three humps, typed as three capitals, find the one name that has them");
  v.close();
});

test("a query reaches a name in the middle of a path", async () => {
  const v = await loadViewer(html);
  // `open` is nowhere near the start of `src/viewer/quick-open.js`, which is why queryMatcher() asks the
  // '*' form — a bare MinusculeMatcher pattern is anchored at the start and would match nothing here.
  await openFiles(v, "qop");
  assert.ok(names(v).includes("quick-open.js"), `camel/separator humps across a path: ${JSON.stringify(names(v))}`);
  v.close();
});

// The ranking the two hand-made ladders could not do: both of these contain `quick`, so `includes` called
// them equal and the tie fell to the path's alphabetical order.
//
// `bQuickOpenThing.ts` is named to make that tie-break point the WRONG way: `src/bQuickOpenThing.ts`
// sorts before `src/viewer/quick-open.js`, so if the degrees ever came out equal this test fails instead
// of passing for the reason it is not testing.
test("a word-start match outranks the middle of a word", async () => {
  const v = await loadViewer(html);
  await openFiles(v, "quick");
  const listed = names(v);
  const atStart = listed.indexOf("quick-open.js");
  const midWord = listed.indexOf("bQuickOpenThing.ts");
  assert.ok(atStart >= 0 && midWord >= 0, `both listed: ${JSON.stringify(listed)}`);
  assert.ok(atStart < midWord, `quick-open.js (${atStart}) must come before bQuickOpenThing.ts (${midWord})`);
  v.close();
});

test("the characters that answered are marked in the row", async () => {
  const v = await loadViewer(html);
  await openFiles(v, "SEC");
  assert.deepEqual(marks(v), ["S", "E", "C"], "one mark per hump, so the reader can see why it answered");

  v.typeInto(v.$("#quick-open-input"), "open");
  await v.settle(200);
  assert.ok(marks(v).includes("open"), `a plain run is marked whole: ${JSON.stringify(marks(v))}`);
  v.close();
});

test("an unmatched name is listed by nobody", async () => {
  const v = await loadViewer(html);
  await openFiles(v, "zzqq");
  assert.deepEqual(names(v), [], "and the matcher does not invent a match to fill the list");
  v.close();
});
