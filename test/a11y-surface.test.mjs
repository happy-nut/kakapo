// Three things a reader who is not watching the window, or not using a mouse, needs from this page.
//
// All three were live at once, and all three are the same kind of defect: a thing that is *there* but not
// *reachable*. The page had a <main> and two <section>s and offered a screen reader exactly one region to
// jump to, because an unnamed <section> is not a landmark. The glyph buttons were painted at 18-22px and
// answer to a 24px floor. The one element that reports what a navigation key did gave every message the
// same two seconds, so the longest ones were gone before they could be read.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
// Comments first. A scan that does not strip them reports the prose ABOUT a 20px button as a 20px button,
// which is three of the six hits the first version of this produced.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

let html;
before(async () => {
  // { app: true } so the desktop chrome renders — the compare pill, the patch-set bar, the source tabs.
  // Without it this page simply has no patch-set bar, so the sweep below could not have seen that its
  // four buttons were 22px: the coverage of a DOM-driven sweep is whatever the fixture draws.
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

test("the thing being reviewed is a region a screen reader can jump to", async () => {
  const v = await loadViewer(html);
  try {
    const { document } = v.window;
    // A <section> becomes a `region` landmark only once it has an accessible name. Both of these are a
    // whole reading surface; without the name the only landmark on the page was the sidebar, so the
    // keyboard shortcut for "next region" skipped the diff entirely.
    for (const id of ["diff-view", "source-viewer"]) {
      const el = document.getElementById(id);
      assert.ok(el, `${id} is still here`);
      assert.equal(el.tagName, "SECTION", `${id} is a section, which is what needs the name`);
      assert.ok((el.getAttribute("aria-label") || "").trim(), `${id} has an accessible name`);
      assert.ok(el.getAttribute("data-i18n-aria"), `${id}'s name is translated, not hardcoded English`);
    }
    assert.ok(document.querySelector("main"), "the reading surfaces are still inside a main landmark");
    assert.ok(document.querySelector("aside[aria-label]"), "the sidebar is still a named landmark");

    // role="group", deliberately, and not role="toolbar": a toolbar advertises arrow-key movement between
    // its controls, and these are reached with Tab. Promising one and giving the other is worse than
    // promising nothing, so this asserts the honest role rather than the impressive one.
    for (const cls of ["diff-toolbar", "source-toolbar"]) {
      const el = document.querySelector(`.${cls}`);
      assert.ok(el, `.${cls} is still here`);
      assert.equal(el.getAttribute("role"), "group", `.${cls} claims only what it implements`);
      assert.ok((el.getAttribute("aria-label") || "").trim(), `.${cls} is named`);
    }
  } finally {
    v.close();
  }
});

test("a punctuation mark between breadcrumbs is not read out as content", async () => {
  const v = await loadViewer(html);
  try {
    // "src › viewer › 02-diff-nav.js" announced as "src, single right-pointing angle quotation mark,
    // viewer, …". The path is one string to a reader; the chevrons are how it is drawn.
    const seps = v.window.document.querySelectorAll(".crumb-sep");
    assert.ok(seps.length > 0, "the breadcrumb is drawn with separators — otherwise this guard is furniture");
    for (const sep of seps) {
      assert.equal(sep.getAttribute("aria-hidden"), "true", "the chevron is drawing, not content");
    }
  } finally {
    v.close();
  }
});

test("a hint stays up for as long as it takes to read", async () => {
  const v = await loadViewer(html);
  try {
    const life = v.window.caretHintLifetime;
    assert.equal(typeof life, "function", "the lifetime is computed, not a constant at the call site");
    // The floor is the old flat value, so every short hint behaves exactly as it did.
    assert.equal(life("gone"), 2000, "a short hint is unchanged");
    assert.equal(life(""), 2000, "and so is an empty one");
    const long = "E0308: mismatched types: expected `&str`, found `String` — consider borrowing here";
    assert.ok(life(long) > life("definition not found"),
      "a longer message gets longer, which is the whole point");
    assert.ok(life(long) >= 4000, `a message that long needs more than a glance (got ${life(long)})`);
    // Capped: the hint is positioned against a line, and scrolling moves the line out from under it.
    assert.equal(life("x".repeat(4000)), 8000, "a hint cannot outlive the row it points at");
  } finally {
    v.close();
  }
});

// A control may keep a small painted box and buy its 24px with an absolutely positioned pseudo-element
// inset outwards — it adds nothing to the layout, so it is the only way to grow a target that sits inside
// a row designed around the smaller mark. Returns how much that adds to each axis, so a sweep reading the
// declarations does not report a fixed control as still broken (which is what it did here first).
function hitAreaBonus(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pseudo = new RegExp(`${escaped}::(?:before|after)\\s*\\{([^}]*)\\}`).exec(rules);
  if (!pseudo || !/position\s*:\s*absolute/.test(pseudo[1])) return 0;
  const inset = /inset\s*:\s*-([\d.]+)px/.exec(pseudo[1]);
  return inset ? Number(inset[1]) * 2 : 0;
}

test("nothing you have to click is smaller than 24 CSS pixels", async () => {
  // WCAG 2.5.8. The spacing exception — a 24px circle on the target that intersects no other target's —
  // rescues none of these: every one sits directly beside another control, so the circles intersect
  // whatever the painted box is.
  //
  // Which selectors are targets is the whole difficulty, and a regex over class names gets it wrong. The
  // first version of this matched anything containing "-icon" and reported five glyphs — .href-icon,
  // .rail-btn > svg, the file-type marks — as undersized buttons. They are 14-16px on purpose, inside a
  // control that is not. Meanwhile .quick-open-usage-icon, which genuinely IS a button, has the same
  // suffix, so dropping the pattern would have lost the one real hit.
  //
  // So the page is asked instead. Every class on a real interactive element becomes the set of things
  // that answer to the floor, and a sized rule counts only if the element it ends in is in that set.
  // Decoration inside a control is excluded because the DOM says it is decoration, not because a list
  // here says so.
  const v = await loadViewer(html);
  let controlClasses;
  try {
    const interactive = v.window.document.querySelectorAll(
      'button, a[href], input, select, textarea, summary, [role="button"], [role="option"], ' +
      '[role="menuitem"], [role="menuitemradio"], [role="tab"], [role="checkbox"], ' +
      '[tabindex]:not([tabindex="-1"])');
    assert.ok(interactive.length > 10, `the page renders its controls (found ${interactive.length})`);
    controlClasses = new Set();
    for (const el of interactive) for (const c of el.classList) controlClasses.add(c);
  } finally {
    v.close();
  }
  assert.ok(controlClasses.size > 15, `the controls carry classes to match on (${controlClasses.size})`);

  // The honest limit of asking the page: a DOM-driven sweep measures what the fixture DRAWS, and some
  // controls are drawn from data the fixture has none of. The patch-set bar renders its reset button
  // from markup — which is why that one is caught above — but its numbered buttons come from
  // 22-patchset.js once there are patch sets to number, so a review of two files never shows them.
  // They were 22px for exactly that reason: the sweep's coverage was its fixture's coverage.
  //
  // Named, not inferred. Every entry here is a control this file could not see, and the list is short
  // on purpose: the moment a fixture CAN draw one of these, it belongs above instead.
  for (const cls of ["patchset-num", "patchset-gap"]) controlClasses.add(cls);

  const small = [];
  let measured = 0;
  for (const [, selector, body] of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const box = (prop) => {
      const m = new RegExp(`(?:^|[;\\s])(?:min-)?${prop}\\s*:\\s*([\\d.]+)px`).exec(body);
      return m ? Number(m[1]) : null;
    };
    const w = box("width");
    const h = box("height");
    if (w === null && h === null) continue;
    // A rule may list several selectors; each is judged on its own.
    for (const one of selector.split(",")) {
      const sel = one.trim().replace(/\s+/g, " ");
      if (!sel || sel.startsWith(":root") || sel.startsWith("@")) continue;
      if (/::|:hover|:focus|:active|:disabled/.test(sel)) continue;
      // The element the rule actually sizes is the LAST compound in the selector. ".rail-btn > svg"
      // sizes the svg, not the button, which is exactly the distinction the regex version missed.
      const last = sel.split(/[\s>+~]+/).filter(Boolean).pop() || "";
      const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
      // `summary` as well as `button`: the folder row is styled by `.tree-dir summary`, so its last
      // compound carries no class at all and class matching alone cannot reach it.
      const isControl = /^(?:button|summary)\b/.test(last) || classes.some((c) => controlClasses.has(c));
      if (!isControl) continue;
      measured += 1;
      // The declared size IS the target: `* { box-sizing: border-box }` is set globally, so padding and
      // border are inside it and there is no arithmetic to do. Worth stating, because the first fix here
      // added 2px to a tree row on the assumption that the padding counted on top — it does not, and the
      // row was still 2px short while the comment claimed otherwise.
      const grown = hitAreaBonus(sel);
      const W = w === null ? null : w + grown;
      const H = h === null ? null : h + grown;
      // A box of 0 is a hidden or collapsed state, not a target.
      if ((W !== null && W > 0 && W < 24) || (H !== null && H > 0 && H < 24)) {
        small.push(`${sel} — ${W ?? "auto"}x${H ?? "auto"}`);
      }
    }
  }
  assert.ok(measured >= 8, `the scan reached the sized controls (measured ${measured})`);
  assert.deepEqual(small, [], "an interactive target under the 24px floor");
});

// Every popup this app opens instead of a native <select> or context menu is the one factory in
// 07-comments.js — the language, theme, scale and highlight pickers in Settings, the source-tab overflow
// list, and three context menus. It was an anonymous <div> of <button>s: arrow keys and Enter worked, so
// SC 2.1.1 passed, and nothing on the page said a menu had opened, so SC 4.1.2 did not. Measured on the
// Settings language control: trigger aria-expanded null and no aria-haspopup, #mc-dropdown role none, its
// items role none. A reader was told a button was pressed and nothing about the choices under it.
//
// Driven through the real control rather than asserted against the factory's source, because the half that
// kept breaking is the state coming back DOWN — there are four ways out of this popup.
test("a custom dropdown says it is open, and stops saying so", async () => {
  const v = await loadViewer(html);
  try {
    const { document, window } = v.window;
    const trigger = document.getElementById("settings-language");
    assert.ok(trigger, "the language picker is still a custom select");
    assert.equal(trigger.getAttribute("aria-expanded"), null, "it does not claim to be open before it is");

    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const dd = document.getElementById("mc-dropdown");
    assert.ok(dd, "the popup opened");
    assert.equal(trigger.getAttribute("aria-haspopup"), "true", "the trigger says it opens something");
    assert.equal(trigger.getAttribute("aria-expanded"), "true", "and that it is open now");
    assert.equal(dd.getAttribute("role"), "menu", "the popup is a menu, not an unnamed div");
    const items = [...dd.children];
    assert.ok(items.length >= 2, `the locales are listed (got ${items.length})`);
    for (const item of items) {
      assert.equal(item.getAttribute("role"), "menuitem", "each choice announces itself as one");
      assert.equal(item.tagName, "BUTTON", "and is still a real button, so Tab and Enter keep working");
    }

    // Escape is one of four exits — a pick, Escape, a click outside, and the next dropdown replacing this
    // one. All four run close(), which is why the state lives in the factory and not at the call site.
    document.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    assert.equal(document.getElementById("mc-dropdown"), null, "the popup is gone");
    assert.equal(trigger.getAttribute("aria-expanded"), "false", "and the trigger no longer claims otherwise");
  } finally {
    v.close();
  }
});
