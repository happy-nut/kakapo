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

// The other half of the same failure, from the opposite direction: the field keeps focus, but the agent
// PRINTS while a syllable is half built. xterm pins the composition overlay and the IME rect to the buffer
// cursor, so that output drags the box you are typing in down to the agent's new last line (measured: the
// overlay jumps from the prompt to 0,30 mid-composition), and macOS answers a moved rect by committing 가 as
// ㄱ ㅏ. xterm doesn't boot under jsdom, so this pins the routing in the client instead.
test("pty output is held while a pane is mid-syllable, and released after the typing gap", () => {
  const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");
  const onData = client.match(/window\.kakapoPty\.onData\(function \(msg\)[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(onData, "the pty output route exists");
  assert.match(onData, /composingPanes\.has\(p\)[\s\S]{0,60}held[\s\S]{0,40}push\(msg\.data\)/,
    "output for a composing pane is queued, not written into the terminal under the IME");
  assert.match(onData, /p\.term\.write\(msg\.data\)/, "every other pane still writes straight through");

  const flush = client.match(/function flushPaneOutput\(p\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(flush, "a flush exists");
  assert.match(flush, /composingPanes\.has\(p\)/,
    "the flush stands down again if another syllable started — output is never written mid-composition");
  assert.match(flush, /held\.join\(''\)/, "held chunks go out in arrival order, as one write");

  // Flushing the instant a syllable commits lands the burst inside the NEXT one, which is the reported
  // "출력이 나면 그 다음 타이핑이 깨진다": xterm writes asynchronously, so the repaint outlives compositionend.
  assert.match(client, /compositionend'[\s\S]{0,120}scheduleFlushPaneOutput\(pane\)/,
    "compositionend defers the flush by a typing gap rather than releasing it immediately");
  assert.match(client, /'blur'[\s\S]{0,120}flushPaneOutput\(pane\)/,
    "leaving the pane releases the output at once — nobody is composing any more");
  assert.match(client, /removePaneRef[\s\S]{0,400}clearTimeout\(p\.holdTimer\)/,
    "a closed pane takes its pending flush with it");
});
