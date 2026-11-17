import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html, lazySourceData;
before(async () => {
  const r = await makeReviewHtml([
    { path: "chain/only/deeper/a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
    { path: "chain/only/deeper/b.ts", before: "export const b = 1;\n", after: "export const b = 2;\n" },
    { path: "fan/alpha/one.ts", before: "export const one = 1;\n", after: "export const one = 2;\n" },
    { path: "fan/beta/two.ts", before: "export const two = 1;\n", after: "export const two = 2;\n" },
    { path: "fan/gamma/three.ts", before: "export const three = 1;\n", after: "export const three = 2;\n" },
  ], { lazyLoad: true });
  html = r.html;
  lazySourceData = r.build.lazySourceData;
});
after(cleanupFixtures);

function openUnder(v, root) {
  return v
    .$all("#files-panel .tree-dir[open]")
    .map((d) => d.dataset.dir)
    .filter((p) => p && (p === root || p.startsWith(root + "/")))
    .sort();
}

async function open(v, dir) {
  v.window.setTab("files");
  await v.settle(80);
  const details = v.$(`#files-panel .tree-dir[data-dir="${dir}"]`);
  assert.ok(details, `the tree has a row for ${dir}`);
  details.open = true;
  await v.settle(120);
}

test("a folder with one way down keeps descending until a level has files", async () => {
  const v = await loadViewer(html, { lazySourceData });
  await open(v, "chain");
  assert.deepEqual(openUnder(v, "chain"), ["chain", "chain/only", "chain/only/deeper"],
    "there is nothing to read in chain/ or chain/only, so neither is a stop");
  assert.ok(v.$('[data-source-file="chain/only/deeper/a.ts"]'), "one click reached the files");
  v.close();
});

test("a folder that branches stops there — the next level is the reader's choice", async () => {
  const v = await loadViewer(html, { lazySourceData });
  await open(v, "fan");
  assert.deepEqual(openUnder(v, "fan"), ["fan"],
    "alpha, beta and gamma stay shut: three subtrees nobody asked for is not a saved click");
  v.close();
});

test("a folder that holds files opens exactly itself", async () => {
  const v = await loadViewer(html, { lazySourceData });
  await open(v, "chain");
  const before = openUnder(v, "chain");
  await open(v, "chain/only/deeper");
  assert.deepEqual(openUnder(v, "chain"), before, "the level with the files is where the walk already stopped");
  v.close();
});
