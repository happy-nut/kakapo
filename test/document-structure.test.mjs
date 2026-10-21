// The review document's SHAPE, which nothing else in this suite looks at.
//
// Every other test here asks whether a view carries the right `.hidden` class, because that is what the
// viewer toggles and what jsdom can see without a layout engine. That is also the blind spot: for several
// releases the settings dialog's three wrappers (settings-modal / settings-panel / settings-body) were
// never closed, so the parser made #history-view a DESCENDANT of a dialog that is display:none whenever
// Settings is shut. Cmd+9 dutifully removed .hidden, git handed back three hundred commits, the view
// rendered 0x0, and the whole feature was unreachable. Every assertion in the suite passed, because every
// class was correct — the dead ancestor is a layout fact and jsdom has no layout.
//
// What jsdom CAN decide is structure. An unbalanced document and a dialog nested inside another dialog are
// both visible to the parser, so they are what these guard.
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

// The three wrappers that went unclosed were invisible in the source because the markup is emitted as an
// array of string fragments — no editor or type checker pairs a '<div>' in one entry with a '</div>' forty
// entries later. Counting tags in the text cannot decide it either: the document embeds the reviewed
// project's own source in JSON islands, and that source contains the characters `<div`. The parser is the
// only thing that knows which angle brackets are markup, so the question is put to the parser, as a
// question about where things ENDED UP: an unclosed wrapper does not announce itself, it swallows whatever
// came after it. These five are emitted as siblings at the top of the document and must stay that way.
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

// A full-screen dialog inside another full-screen dialog inherits the outer one's display, so it can only
// ever be as visible as its host. These are siblings by design; this is what says so.
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
    // Not merely un-nested: nothing between it and <body> may be a hidden-by-default container either.
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      assert.ok(!p.classList.contains("hidden"),
        `${sel} sits inside .${[...p.classList].join(".")}, which ships hidden`);
    }
  }
  dom.window.close();
});
