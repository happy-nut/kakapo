import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const x = 1;\n", after: "export const x = 2;\n" },
  ], { app: true }));
});
after(cleanupFixtures);

test("the thing being reviewed is a region a screen reader can jump to", async () => {
  const v = await loadViewer(html);
  try {
    const { document } = v.window;
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
    assert.equal(life("gone"), 2000, "a short hint is unchanged");
    assert.equal(life(""), 2000, "and so is an empty one");
    const long = "E0308: mismatched types: expected `&str`, found `String` — consider borrowing here";
    assert.ok(life(long) > life("definition not found"),
      "a longer message gets longer, which is the whole point");
    assert.ok(life(long) >= 4000, `a message that long needs more than a glance (got ${life(long)})`);
    assert.equal(life("x".repeat(4000)), 8000, "a hint cannot outlive the row it points at");
  } finally {
    v.close();
  }
});

function hitAreaBonus(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pseudo = new RegExp(`${escaped}::(?:before|after)\\s*\\{([^}]*)\\}`).exec(rules);
  if (!pseudo || !/position\s*:\s*absolute/.test(pseudo[1])) return 0;
  const inset = /inset\s*:\s*-([\d.]+)px/.exec(pseudo[1]);
  return inset ? Number(inset[1]) * 2 : 0;
}

test("nothing you have to click is smaller than 24 CSS pixels", async () => {
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
    for (const one of selector.split(",")) {
      const sel = one.trim().replace(/\s+/g, " ");
      if (!sel || sel.startsWith(":root") || sel.startsWith("@")) continue;
      if (/::|:hover|:focus|:active|:disabled/.test(sel)) continue;
      const last = sel.split(/[\s>+~]+/).filter(Boolean).pop() || "";
      const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
      const isControl = /^(?:button|summary)\b/.test(last) || classes.some((c) => controlClasses.has(c));
      if (!isControl) continue;
      measured += 1;
      const grown = hitAreaBonus(sel);
      const W = w === null ? null : w + grown;
      const H = h === null ? null : h + grown;
      if ((W !== null && W > 0 && W < 24) || (H !== null && H > 0 && H < 24)) {
        small.push(`${sel} — ${W ?? "auto"}x${H ?? "auto"}`);
      }
    }
  }
  assert.ok(measured >= 8, `the scan reached the sized controls (measured ${measured})`);
  assert.deepEqual(small, [], "an interactive target under the 24px floor");
});

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

    document.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    assert.equal(document.getElementById("mc-dropdown"), null, "the popup is gone");
    assert.equal(trigger.getAttribute("aria-expanded"), "false", "and the trigger no longer claims otherwise");
  } finally {
    v.close();
  }
});
