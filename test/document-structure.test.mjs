import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { after } from "node:test";

after(cleanupFixtures);

const review = async () => {
  const { html } = await makeReviewHtml([
    { path: "src/a.ts", before: "const a = 1;\n", after: "const a = 2;\n" },
  ]);
  return html;
};

test("the document's top-level surfaces are siblings, not swallowed by each other", async () => {
  const dom = new JSDOM(await review());
  const { document } = dom.window;
  for (const sel of ["#settings-modal", "#history-view", "#diff2html-container", "#source-viewer", ".sidebar"]) {
    const el = document.querySelector(sel);
    assert.ok(el, `${sel} is in the review document`);
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      assert.ok(!p.matches("#settings-modal, #history-view, .settings-panel, .settings-body"),
        `${sel} ended up inside ${p.id ? "#" + p.id : "." + [...p.classList].join(".")} — a wrapper above it never closed`);
    }
  }
  dom.window.close();
});

test("no full-screen surface is nested inside another one", async () => {
  const dom = new JSDOM(await review());
  const { document } = dom.window;
  const surfaces = ["#history-view", "#settings-modal"];
  const present = surfaces.map((sel) => [sel, document.querySelector(sel)]);
  for (const [sel, el] of present) assert.ok(el, `${sel} is in the review document`);

  for (const [sel, el] of present) {
    for (const [otherSel, other] of present) {
      if (sel === otherSel) continue;
      assert.ok(!other.contains(el), `${sel} is nested inside ${otherSel}, so it can never outlive its display`);
    }
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      assert.ok(!p.classList.contains("hidden"),
        `${sel} sits inside .${[...p.classList].join(".")}, which ships hidden`);
    }
  }
  dom.window.close();
});
