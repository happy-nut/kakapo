// Every workspace is a view inside ONE window, and main hands the keyboard back to the active one with
// webContents.focus() (rail collapse, dialog close, workspace switch, app re-activation). The page regains
// focus, the focused ELEMENT never changes — and macOS' input method, which let go of the field when the view
// lost focus, never picks it up again: 한글 comes out as separated jamo until you click another pane and back.
// That manual round trip is what this pins, minus the clicking.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";
import { readFileSync } from "node:fs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

// The refocus is deliberately a frame later than the blur — in one frame the renderer's input state ends
// where it started and nothing is published, which is the entire point of the round trip.
const nextFrame = (window) => new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)));

test("the page regaining focus blurs the focused field and focuses it again a frame later", async () => {
  const v = await loadViewer(html);
  const { window } = v;
  const box = window.document.createElement("textarea");
  window.document.body.appendChild(box);
  box.focus();
  let blurs = 0;
  box.addEventListener("blur", () => { blurs += 1; });

  window.dispatchEvent(new window.Event("focus"));
  assert.equal(blurs, 1, "the field is let go of");
  assert.notEqual(window.document.activeElement, box, "so the element focus genuinely changes");

  await nextFrame(window);
  assert.equal(window.document.activeElement, box, "and it has the keyboard back one frame later");
  v.close();
});

test("it never steals focus from whatever the user clicked on the way back in", async () => {
  const v = await loadViewer(html);
  const { window } = v;
  const first = window.document.createElement("textarea");
  const second = window.document.createElement("textarea");
  window.document.body.append(first, second);
  first.focus();

  window.dispatchEvent(new window.Event("focus"));
  second.focus(); // the click that brought the view back landed in another field
  await nextFrame(window);
  assert.equal(window.document.activeElement, second, "the field the user chose keeps the keyboard");
  v.close();
});

test("a contenteditable is left alone — the terminal's rename label commits on blur", async () => {
  const v = await loadViewer(html);
  const { window } = v;
  const label = window.document.createElement("div");
  label.contentEditable = "true";
  window.document.body.appendChild(label);
  label.focus();
  let blurs = 0;
  label.addEventListener("blur", () => { blurs += 1; });

  window.dispatchEvent(new window.Event("focus"));
  await nextFrame(window);
  assert.equal(blurs, 0, "re-activating the app must not commit a rename behind the user's back");
  v.close();
});

// A composition-aware HOLD on the agent's output shipped in 0.4.18 and was pulled straight back out: a macOS
// Hangul composition runs to the end of the WORD, not the end of a syllable, so holding output "until
// compositionend" swallowed the echo of everything typed until the space bar. This pins the retraction — the
// route from pty to terminal must stay unconditional — so the next attempt at the jamo bug cannot reach for
// the same lever again.
test("pty output reaches the terminal unconditionally, never gated on a composition", () => {
  const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");
  const onData = client.match(/window\.kakapoPty\.onData\(function \(msg\)[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(onData, "the pty output route exists");
  assert.match(onData, /panes\[k\]\.term\.write\(msg\.data\)/, "output is written as it arrives");
  assert.doesNotMatch(onData, /composingPanes|held|holdTimer/,
    "output must not be queued behind an IME composition — that is a whole word of typing, not a syllable");
});
