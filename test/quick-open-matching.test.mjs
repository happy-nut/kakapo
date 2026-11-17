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
  await openFiles(v, "qop");
  assert.ok(names(v).includes("quick-open.js"), `camel/separator humps across a path: ${JSON.stringify(names(v))}`);
  v.close();
});

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
