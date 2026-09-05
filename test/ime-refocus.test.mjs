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

// The round trip can be defeated from inside the house. The terminal panel re-takes the keyboard on the
// same window `focus` event (its refocusTerminal path), and doing that SYNCHRONOUSLY landed the blur and
// the re-focus in one frame — the renderer published no input-state change, the round trip's own frame
// callback found focus already claimed and stood down, and 한글 stayed broken exactly where people type
// the most: an open terminal pane. The panel's re-grab must wait a frame; 01-core registers first, so its
// callback runs first and the panel's lands as a no-op when the round trip already put focus back.
test("the terminal panel's own window-focus re-grab waits a frame, so the round trip survives it", () => {
  const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");
  const handler = client.match(/var refocusTerminal[\s\S]*?window\.addEventListener\('focus'[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(handler, "the panel still re-takes the keyboard on window focus");
  assert.match(handler, /requestAnimationFrame\(function \(\) \{ focusPane\(/,
    "…but a frame later — synchronous focusPane() here is how the IME round trip was being cancelled");
  assert.doesNotMatch(handler, /\n\s*if \(refocusTerminal && isOpen\(\) && active\) focusPane\(active\);/,
    "the same-frame re-grab must not come back");
});

// The round trip runs on window focus alone — so an input context that broke MID-typing stayed broken until
// the user happened to leave the window. The incident trace shows the shape: one composition split under
// output pressure, then every following one died ~100-200ms in, a bare jamo per keystroke, with the terminal
// near-idle — the stuck state. Two split commits in a row are that signature, and the cure is the same round
// trip, self-administered: blur between compositions, focus back a frame later, never mid-syllable, on a
// cooldown.
test("two split commits in a row trigger the round trip without waiting for a window switch", () => {
  const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");
  const rebind = client.match(/function scheduleImeRebind\(pane, term\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(rebind, "the self-administered round trip exists");
  assert.match(rebind, /helper\._isComposing\)/, "it never cuts a syllable in flight to fix the next one");
  assert.match(rebind, /document\.activeElement !== ta/, "and only acts while the keyboard is actually the pane's");
  assert.match(rebind, /ta\.blur\(\)[\s\S]*?requestAnimationFrame/, "blur now, focus a frame later — the same two-frame shape 01-core uses");
  assert.match(rebind, /landed !== document\.body\) return/, "focus claimed by something else meanwhile is left alone");
  assert.match(client, /pane\.__jamoRun = broken \? \(pane\.__jamoRun \|\| 0\) \+ 1 : 0/,
    "the run of split commits is counted where commits land");
  assert.match(client, />= 2\) scheduleImeRebind/,
    "…and two in a row is what fires it — a lone split is output pressure and heals by itself");
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

// WHY a syllable was breaking, and what the fix may not be.
//
// While a composition is live, xterm re-points its helper textarea at the buffer cursor on a 0ms loop
// (CompositionHelper.updateCompositionElements writes textarea.style.left/top from buffer.x/y and reschedules
// itself). That textarea is what the macOS input context is attached to, so an agent pouring output — every
// line moving the cursor — drags the anchor out from under a half-built 가 many times a second and macOS
// commits it as ㄱ ㅏ. Switching workspace does the same once, through changed cell dimensions.
//
// The fix pins the anchor. It must NOT hold output: that was tried, and a Hangul composition runs to the end
// of the word, so holding until compositionend hid the reviewer's own echo until they pressed space.
test("the IME anchor is pinned for the life of a composition, and holds nothing back", () => {
  const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");
  const pin = client.match(/function pinCompositionAnchor\(term\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(pin, "the anchor pin exists");
  assert.match(pin, /updateCompositionElements/, "it wraps xterm's own repositioning rather than forking it");
  assert.match(pin, /helper\._isComposing/, "and only acts while a composition is actually live");
  assert.match(pin, /textarea\.style\.left = helper\.__kakapoPinned\.left/, "putting the anchor back where the composition started");
  assert.doesNotMatch(pin, /term\.write|msg\.data/, "it touches no output — pinning is not queueing");
  assert.match(client, /compositionstart'[\s\S]{0,600}pinCompositionAnchor\(term\)/, "armed as the composition starts");
  // A shape change in a future xterm must degrade to the old behaviour, never throw into node-pty's callback.
  assert.match(pin, /typeof helper\.updateCompositionElements !== 'function'\) return/, "absent internals are a no-op");
});

// The failure is a race: by the time ㄱ ㅏ is on screen, whatever moved the terminal has already finished. So
// each composition carries a tally, and the commit itself is checked — a committed run containing Hangul jamo
// is a syllable that was cut in half, and nothing else produces one.
test("a split syllable names itself, with what the terminal was doing while it split", () => {
  const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");
  const note = client.match(/function noteCompositionEnd\(event\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(note, "each composition is closed out somewhere");
  assert.match(client, /\\u1100-\\u11FF/, "the Hangul jamo block is what marks a broken commit");
  assert.match(note, /JAMO_CODEPOINTS\.test/, "and the committed text is what gets checked");
  assert.match(note, /console\.warn/, "a split says so at the moment it happens, not silently");
  assert.match(note, /imeLog\.push\(entry\)/, "…and is kept, so the next report has the context with it");
  assert.match(note, /writes|anchorPins|fitsHeld/, "the tally names what was happening to the terminal");
  assert.match(client, /imeLog: function/, "readable afterwards from __kakapoTerminal");
});
