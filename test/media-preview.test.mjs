import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

function plantBinaryWrapper(v, path) {
  const container = v.$("#diff2html-container");
  const wrapper = v.window.document.createElement("div");
  wrapper.className = "d2h-file-wrapper";
  wrapper.id = "file-media";
  wrapper.dataset.path = path;
  wrapper.innerHTML = '<div class="d2h-file-header"><span class="d2h-file-name">' + path + "</span></div>"
    + '<div class="d2h-files-diff"></div>';
  container.appendChild(wrapper);
  return wrapper;
}

// jsdom has no URL.createObjectURL, and the viewer hands a blob to every <img>/<video> it mounts; without
// this the mount falls to its own failure path and every assertion below would be measuring that instead.
function blobUrls(v) {
  let n = 0;
  v.window.URL.createObjectURL = () => "blob:kakapo-test/" + (++n);
  v.window.URL.revokeObjectURL = () => {};
}

function assetBridge(v, answer) {
  const asked = [];
  v.window.kakapoFile = Object.assign({}, v.window.kakapoFile, {
    getAsset: (path, side) => {
      asked.push({ path, side: side || "" });
      return Promise.resolve(answer(path, side || ""));
    },
  });
  return asked;
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a picture in the diff is two pictures, because a diff of one is not a diff", async () => {
  const v = await loadViewer(html, { eagerIntersections: true });
  const wrapper = plantBinaryWrapper(v, "assets/logo.png");
  blobUrls(v);
  const asked = assetBridge(v, () => ({ dataUrl: PNG }));

  v.window.refreshDiffMediaPreviews();
  await v.settle(10);

  const sides = wrapper.querySelectorAll(".media-diff-side");
  assert.equal(sides.length, 2, "the base revision and the working tree, side by side");
  assert.deepEqual(asked, [{ path: "assets/logo.png", side: "base" }, { path: "assets/logo.png", side: "" }],
    "each side is asked for its own bytes; the base is a blob the working tree no longer has");
  const images = wrapper.querySelectorAll(".media-diff-side img.image-preview");
  assert.equal(images.length, 2, "a png is drawn, not described");
  assert.ok(Array.from(images).every((img) => /^blob:/.test(img.src)),
    "the bytes are handed over as a blob, so a 10 MB picture is not a 13 MB attribute");
  v.close();
});

test("a side the file is not on says so instead of leaving a hole", async () => {
  const v = await loadViewer(html, { eagerIntersections: true });
  const wrapper = plantBinaryWrapper(v, "assets/added.png");
  blobUrls(v);
  assetBridge(v, (_path, side) => (side === "base" ? null : { dataUrl: PNG }));

  v.window.refreshDiffMediaPreviews();
  await v.settle(10);

  const sides = wrapper.querySelectorAll(".media-diff-side");
  assert.ok(sides[0].querySelector(".media-diff-absent"), "nothing stood here before this change, and the pane says that");
  assert.equal(sides[0].querySelector("img"), null, "and the broken-image icon is gone with it");
  assert.ok(sides[1].querySelector("img.image-preview"), "the working tree's picture is still shown");
  v.close();
});

test("an mp4 is a player, not a picture element that will never load", async () => {
  const v = await loadViewer(html, { eagerIntersections: true });
  const wrapper = plantBinaryWrapper(v, "docs/demo.mp4");
  blobUrls(v);
  assetBridge(v, () => ({ dataUrl: "data:video/mp4;base64,AAAA" }));

  v.window.refreshDiffMediaPreviews();
  await v.settle(10);

  const players = wrapper.querySelectorAll("video.media-preview");
  assert.equal(players.length, 2, "both sides of a video change are playable");
  assert.ok(Array.from(players).every((el) => el.hasAttribute("controls")),
    "with the controls, or it is a still frame with extra steps");
  v.close();
});

test("the table the viewer reads is the one the main process reads", async () => {
  const v = await loadViewer(html, { eagerIntersections: true });
  const kind = (path) => (v.window.previewMediaFor(path) || {}).kind;
  assert.equal(kind("a/b.PNG"), "image", "the extension is matched without regard to case");
  assert.equal(kind("a/b.mov"), "video");
  assert.equal(kind("a/b.m4a"), "audio");
  assert.equal(kind("a/b.pdf"), "pdf");
  assert.equal(kind("a/b.ts"), undefined, "source is read, not played");
  assert.equal(kind("a/b.svg"), undefined,
    "an svg is text with a diff worth reading; it is previewed by the markdown path, not by this one");
  v.close();
});

test("a file whose diff has rows is left alone", async () => {
  const v = await loadViewer(html, { eagerIntersections: true });
  const wrapper = plantBinaryWrapper(v, "assets/icon.png");
  wrapper.querySelector(".d2h-files-diff").innerHTML = "<table><tbody><tr><td>+1</td></tr></tbody></table>";
  assetBridge(v, () => ({ dataUrl: PNG }));

  v.window.refreshDiffMediaPreviews();
  await v.settle(10);
  assert.equal(wrapper.querySelector(".media-diff"), null,
    "git found a text diff for it, and a text diff is the better answer");
  v.close();
});
