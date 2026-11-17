import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures, renderLazyBodies } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

after(cleanupFixtures);

async function openedReview() {
  const built = await makeReviewHtml(
    [
      { path: "src/one.ts", before: "export const one = 1;\n", after: "export const one = 11;\n" },
      { path: "src/two.ts", before: "export const two = 2;\n", after: "export const two = 22;\n" },
    ],
    { lazyLoad: true },
  );
  const bodies = await renderLazyBodies(built.build);
  const fetched = [];
  const viewer = await loadViewer(built.html, {
    menuBridge: true,
    lazySourceData: built.build.lazySourceData,
    getDiffBody: (index) => { fetched.push(index); return bodies[index] || ""; },
  });
  return { built, viewer, fetched };
}

test("a materialized diff body is not kept a second time as a string", async () => {
  const { viewer, fetched } = await openedReview();
  await viewer.openDiffFor("src/one.ts");
  await viewer.settle(120);

  assert.match(viewer.$("#diff2html-container").textContent, /11/, "the body is painted");
  assert.ok(fetched.length > 0, "the body came over the bridge");
  assert.deepEqual(Object.keys(viewer.window.bodyCache), [], "no body HTML is retained alongside the DOM");
  viewer.close();
});

test("a released review repaints from the next rebuild, and reads its bodies again", async () => {
  const { built, viewer, fetched } = await openedReview();
  await viewer.openDiffFor("src/one.ts");
  await viewer.settle(120);
  const before = fetched.length;

  await viewer.releaseView();
  assert.equal(viewer.$("#diff2html-container").querySelectorAll(".d2h-file-wrapper").length, 0, "the diff DOM is gone");

  await viewer.pushDiffUpdate(built.build.update);
  await viewer.openDiffFor("src/one.ts");
  await viewer.settle(120);

  assert.equal(
    viewer.$("#diff2html-container").querySelectorAll(".d2h-file-wrapper").length,
    2,
    "every file wrapper is back after the rebuild",
  );
  assert.match(viewer.$("#diff2html-container").textContent, /11/, "the body is painted again");
  assert.ok(fetched.length > before, "the released body was fetched again rather than served from a stale cache");
  viewer.close();
});

test("releasing a review that was never painted is a no-op", async () => {
  const { viewer } = await openedReview();
  await viewer.releaseView();
  await viewer.releaseView();
  assert.ok(viewer.$("#diff2html-container"), "the container survives");
  viewer.close();
});
