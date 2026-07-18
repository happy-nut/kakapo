import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
const paths = [
  "src/one.ts",
  "src/two.ts",
  "src/three.ts",
  "src/four.ts",
  "src/five.ts",
  "src/six.ts",
  "src/seven.ts",
];

before(async () => {
  ({ html } = await makeReviewHtml(paths.map((path, index) => ({
    path,
    before: `export const value = ${index};\n`,
    after: `export const value = ${index + 1};\n`,
  }))));
});

after(cleanupFixtures);

test("source tabs collapse beyond the available width into an active-file-safe N+ menu", async () => {
  const v = await loadViewer(html);
  paths.forEach((path) => v.window.openSourceFile(path));
  const bar = v.$("#source-tabs");
  Object.defineProperty(bar, "clientWidth", { configurable: true, value: 600 });
  const tabs = [...bar.querySelectorAll(".source-tab")];
  tabs.forEach((tab) => {
    tab.getBoundingClientRect = () => ({ left: 0, right: 160, top: 0, bottom: 30, width: 160, height: 30 });
  });
  const overflow = bar.querySelector(".source-tab-overflow");
  overflow.getBoundingClientRect = () => ({ left: 550, right: 594, top: 0, bottom: 30, width: 44, height: 30 });

  v.window.syncSourceTabOverflow(paths.at(-1));
  const hidden = tabs.filter((tab) => tab.classList.contains("source-tab-overflowed"));
  assert.equal(hidden.length, 4, "four tabs are collected instead of creating a horizontal tab scroller");
  assert.equal(overflow.textContent, "4+", "the overflow group reports the hidden file count");
  assert.equal(overflow.classList.contains("hidden"), false, "the overflow group is visible");
  assert.equal(
    bar.querySelector(`.source-tab[data-tab-path="${paths.at(-1)}"]`).classList.contains("source-tab-overflowed"),
    false,
    "the active file remains directly selectable even when it is the newest/right-most tab",
  );

  overflow.click();
  assert.equal(v.$("#mc-dropdown").classList.contains("source-tab-overflow-menu"), true, "large hidden-tab sets use a bounded scrollable menu");
  const items = [...v.document.querySelectorAll("#mc-dropdown .mc-dropdown-item")];
  assert.equal(items.length, 4, "the dropdown contains exactly the collected files");
  const selectedPath = hidden[0].getAttribute("data-tab-path");
  assert.match(items[0].textContent, new RegExp(selectedPath.split("/").at(-1).replace(".", "\\.")), "dropdown labels identify the hidden file");
  items[0].click();
  assert.equal(v.$("#source-viewer").dataset.openPath, selectedPath, "choosing a dropdown file reuses normal tab navigation");

  v.close();
});

test("source tab overflow disappears again when a resize provides enough width", async () => {
  const v = await loadViewer(html);
  paths.forEach((path) => v.window.openSourceFile(path));
  const bar = v.$("#source-tabs");
  Object.defineProperty(bar, "clientWidth", { configurable: true, value: 1500 });
  [...bar.querySelectorAll(".source-tab")].forEach((tab) => {
    tab.getBoundingClientRect = () => ({ left: 0, right: 160, top: 0, bottom: 30, width: 160, height: 30 });
  });
  const overflow = bar.querySelector(".source-tab-overflow");
  overflow.getBoundingClientRect = () => ({ left: 0, right: 44, top: 0, bottom: 30, width: 44, height: 30 });

  v.window.syncSourceTabOverflow(paths.at(-1));
  assert.equal(bar.querySelectorAll(".source-tab-overflowed").length, 0, "all tabs return after the bar grows");
  assert.equal(overflow.classList.contains("hidden"), true, "the N+ group does not occupy width unnecessarily");

  v.close();
});
