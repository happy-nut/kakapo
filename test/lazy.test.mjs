// CORE USER FLOW: lazy-LOAD source view (big repos / serve / Electron).
//
// In lazy-LOAD the standalone HTML ships source metadata only (no content); the body is fetched on demand
// via window.monacoriFile.getSourceData(). This guards the critical regression where one file's content
// rendered under another file's path because the caret fast-path trusted metadata over the painted body —
// fixed by tracking sourceBodyPath (the path actually painted) and re-rendering on mismatch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html, lazySourceData;
before(async () => {
  const r = await makeReviewHtml(
    [
      { path: "src/one.ts", before: "export const one = 1;\n", after: "export const one = 11;\n" },
      { path: "src/two.ts", before: "export const two = 2;\n", after: "export const two = 22;\n" },
    ],
    { lazyLoad: true },
  );
  html = r.html;
  lazySourceData = r.build.lazySourceData;
});
after(cleanupFixtures);

test("lazy-LOAD: source view renders each file's OWN content after async fetch", async () => {
  const v = await loadViewer(html, { lazySourceData });
  await v.openSourceFile("src/two.ts");
  await v.settle(150); // loadSourceData resolves async, then re-opens the file with content
  assert.match(v.$("#source-title").textContent, /two\.ts/, "breadcrumb is src/two.ts");
  assert.match(v.$("#source-body").textContent, /export const two = 22/, "body shows src/two.ts content");
  assert.doesNotMatch(v.$("#source-body").textContent, /one = 11/, "body does NOT show another file's content");
  v.close();
});

test("lazy-LOAD: switching files shows the new file's content, never a stale body (path↔content fix)", async () => {
  const v = await loadViewer(html, { lazySourceData });
  await v.openSourceFile("src/one.ts");
  await v.settle(150);
  assert.match(v.$("#source-body").textContent, /one = 11/, "src/one.ts content shown");
  await v.openSourceFile("src/two.ts");
  await v.settle(150);
  const body = v.$("#source-body").textContent;
  assert.match(body, /two = 22/, "switched to src/two.ts content");
  assert.doesNotMatch(body, /one = 11/, "stale src/one.ts body is gone (sourceBodyPath guard)");
  v.close();
});

// REGRESSION: a watch refresh (in-place diff update) cleared bodyPromise but NOT bodyCache, which is keyed
// by file INDEX. loadBodyHtml then returned the cached OLD body for the same index, so a working-tree change
// never appeared in the diff until a full reload. applyDiffUpdate must drop bodyCache too.
test("lazy-LOAD: a watch refresh shows the rebuilt diff body, not the cached old one", async () => {
  const b1 = await makeReviewHtml(
    [{ path: "src/live.ts", before: "export const x = 1;\n", after: "export const x = 111;\n" }],
    { lazyLoad: true },
  );
  let bodies = b1.build.lazyBodies || [];
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    lazySourceData: b1.build.lazySourceData,
    getDiffBody: (idx) => bodies[idx] || "",
  });
  await v.openDiffFor("src/live.ts");
  await v.settle(120);
  assert.match(v.$("#diff2html-container").textContent, /111/, "initial diff body shown");

  // A watch rebuild changes the SAME file again -> a new body for the same index.
  const b2 = await makeReviewHtml(
    [{ path: "src/live.ts", before: "export const x = 1;\n", after: "export const x = 222;\n" }],
    { lazyLoad: true },
  );
  bodies = b2.build.lazyBodies || []; // the bridge now serves the rebuilt body for that index
  await v.pushDiffUpdate(b2.build.update);
  await v.settle(120);

  const text = v.$("#diff2html-container").textContent;
  assert.match(text, /222/, "rebuilt body shown after the watch refresh");
  assert.doesNotMatch(text, /111/, "stale cached body is gone");
  v.close();
});

// A watch refresh that lands WHILE a comment composer is open must be HELD, not applied — applyDiffUpdate
// rebuilds the diff DOM, which would destroy the composer textarea mid-type (input stalls / batched chars).
// It's flushed the moment the composer closes (save/cancel).
test("lazy-LOAD: a watch refresh is deferred while composing, then applied on close", async () => {
  const b1 = await makeReviewHtml(
    [{ path: "src/live.ts", before: "export const x = 1;\n", after: "export const x = 111;\n" }],
    { lazyLoad: true },
  );
  let bodies = b1.build.lazyBodies || [];
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    lazySourceData: b1.build.lazySourceData,
    getDiffBody: (idx) => bodies[idx] || "",
  });
  await v.openDiffFor("src/live.ts");
  await v.settle(120);
  await v.clickFirstDiffLine(); // place the diff caret so the composer has a target line
  await v.openComposer("q");
  assert.ok(v.visibleComposerInput(), "composer is open");

  const b2 = await makeReviewHtml(
    [{ path: "src/live.ts", before: "export const x = 1;\n", after: "export const x = 222;\n" }],
    { lazyLoad: true },
  );
  bodies = b2.build.lazyBodies || [];
  await v.pushDiffUpdate(b2.build.update);
  await v.settle(120);
  assert.ok(v.visibleComposerInput(), "composer survives the watch refresh (update held)");
  assert.doesNotMatch(v.$("#diff2html-container").textContent, /222/, "diff is NOT rebuilt while composing");

  await v.writeAndSave("note"); // saving closes the composer, which flushes the held refresh
  await v.settle(120);
  assert.ok(!v.visibleComposerInput(), "composer closed after save");
  assert.match(v.$("#diff2html-container").textContent, /222/, "the held watch refresh is applied once composing ends");
  v.close();
});

// A watch refresh must not blank-then-reload files that DIDN'T change: their already-materialized body is
// snapshotted before the swap and re-filled synchronously, so it never flickers and isn't re-fetched.
test("lazy-LOAD: a watch refresh keeps an UNCHANGED file's body (no blank, no re-fetch)", async () => {
  const b1 = await makeReviewHtml(
    [
      { path: "src/a.ts", before: "const a = 1;\n", after: "const a = 1; // AAA\n" },
      { path: "src/b.ts", before: "const b = 2;\n", after: "const b = 2; // BBB1\n" },
    ],
    { lazyLoad: true },
  );
  let bodies = b1.build.lazyBodies || [];
  const fetched = [];
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    lazySourceData: b1.build.lazySourceData,
    getDiffBody: (idx) => { fetched.push(idx); return bodies[idx] || ""; },
  });
  await v.openDiffFor("src/a.ts");
  await v.settle(120);
  assert.match(v.$("#diff2html-container").textContent, /AAA/, "a.ts body materialized");
  const aIdx = Number((v.$("#diff2html-container .d2h-file-wrapper").id || "file-0").replace("file-", ""));
  fetched.length = 0; // ignore the initial-load fetches

  // Watch rebuild changes ONLY b.ts; a.ts is byte-identical.
  const b2 = await makeReviewHtml(
    [
      { path: "src/a.ts", before: "const a = 1;\n", after: "const a = 1; // AAA\n" },   // unchanged
      { path: "src/b.ts", before: "const b = 2;\n", after: "const b = 2; // BBB2\n" },   // changed
    ],
    { lazyLoad: true },
  );
  bodies = b2.build.lazyBodies || [];
  await v.pushDiffUpdate(b2.build.update);
  await v.settle(120);

  assert.match(v.$("#diff2html-container").textContent, /AAA/, "unchanged a.ts body stays painted (no blank flash)");
  assert.ok(!fetched.includes(aIdx), "unchanged a.ts body served from the snapshot, NOT re-fetched over IPC");
  v.close();
});

// FLICKER-SAVER: when an OFF-SCREEN file changes but the file you're viewing doesn't (same file set+order),
// applyDiffUpdate must reconcile per-file — keeping the viewed file's exact DOM node (no re-render/flicker)
// and swapping only the changed off-screen wrapper.
test("lazy: off-screen change preserves the viewed file's wrapper node, swaps only the changed one", async () => {
  const b1 = await makeReviewHtml(
    [
      { path: "src/a.ts", before: "const a = 1;\n", after: "const a = 1; // AAA\n" },
      { path: "src/b.ts", before: "const b = 2;\n", after: "const b = 2; // BBB\n" },
    ],
    { lazyLoad: true },
  );
  let bodies = b1.build.lazyBodies || [];
  const v = await loadViewer(b1.html, {
    menuBridge: true,
    lazySourceData: b1.build.lazySourceData,
    getDiffBody: (idx) => bodies[idx] || "",
  });
  await v.openDiffFor("src/a.ts");
  await v.settle(120);
  const aBefore = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/a.ts"]');
  const bBefore = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/b.ts"]');
  assert.ok(aBefore && bBefore, "both wrappers exist");

  // Watch: a.ts byte-identical, only b.ts changes.
  const b2 = await makeReviewHtml(
    [
      { path: "src/a.ts", before: "const a = 1;\n", after: "const a = 1; // AAA\n" },     // unchanged
      { path: "src/b.ts", before: "const b = 2;\n", after: "const b = 2; // BBB-CHANGED\n" }, // changed
    ],
    { lazyLoad: true },
  );
  bodies = b2.build.lazyBodies || [];
  await v.pushDiffUpdate(b2.build.update);
  await v.settle(120);

  const aAfter = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/a.ts"]');
  const bAfter = v.$('#diff2html-container .d2h-file-wrapper[data-path="src/b.ts"]');
  assert.equal(aAfter, aBefore, "viewed file's wrapper is the SAME DOM node — no flicker");
  assert.notEqual(bAfter, bBefore, "changed off-screen file's wrapper was swapped");
  v.close();
});
