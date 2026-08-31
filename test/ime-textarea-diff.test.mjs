// The whole prompt, sent again. xterm's helper textarea is cleared on only three events (blur, Enter,
// Ctrl+C), so a Korean prompt typed into a TUI composer accumulates in it in full. The path a keyCode-229
// keydown takes when nothing is composing worked out what to send with `newValue.replace(oldValue, '')` — a
// SUBSTRING replace. Hangul rewrites the last syllable in place rather than appending, so oldValue is not
// found at all and the "difference" comes back as the ENTIRE accumulated value: "추가 확인해보자" arriving
// three times over. And because onData flushes a half-repaired syllable before writing, one of those
// re-sends landing mid-word cuts the syllable it interrupts — the same bug as the jamo splits.
//
// xterm does not boot under jsdom, so the rule is extracted from the slice source and run directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");

const fnSource = client.match(/var TEXTAREA_DEL = [\s\S]*?function textareaAppend\(oldValue, newValue\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(fnSource, "textareaAppend exists in the slice");
const textareaAppend = new Function(`${fnSource}; return textareaAppend;`)();
const DEL = "\x7f";

test("only an append is sent from the textarea", () => {
  // The reported failure, with the real strings. The IME rewrites the trailing syllable, so the previous
  // value is nowhere inside the new one — and the old rule handed back the whole buffer.
  assert.equal(textareaAppend("추가 확인해보ㅈ", "추가 확인해보자"), null,
    "a syllable rewritten in place is the composition path's input, never a textarea diff");
  assert.notEqual(textareaAppend("추가 확인해보ㅈ", "추가 확인해보자"), "추가 확인해보자",
    "…and above all it is not the entire accumulated prompt");

  // What the path is actually FOR: a digit or a punctuation mark typed while the Korean IME is active
  // appends to whatever is already in the textarea, and nothing else delivers it.
  assert.equal(textareaAppend("추가 확인해보자", "추가 확인해보자2"), "2");
  assert.equal(textareaAppend("", "."), ".", "an empty textarea appends the whole value");

  // Unchanged, and shortened.
  assert.equal(textareaAppend("추가", "추가"), null, "no change is nothing to send");
  assert.equal(textareaAppend("추가", "추"), DEL, "a shortened textarea is a delete, as before");

  // Same length, different content — the branch that used to send the whole value verbatim.
  assert.equal(textareaAppend("확인해보자", "확인해보아"), null);
});

test("the guard is installed on every pane and stands down for an unknown xterm", () => {
  assert.match(client, /guardTextareaDiff\(term\);/, "every pane installs it right after term.open()");
  const guard = client.match(/function guardTextareaDiff\(term\) \{[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(guard, "guardTextareaDiff exists in the slice");
  assert.match(guard, /typeof helper\._handleAnyTextareaChanges !== 'function'/,
    "an xterm without the private method is left with its own behaviour");
  assert.match(guard, /__kakapoDiffGuarded/, "and it is wrapped once per terminal, not once per call");
  assert.match(guard, /if \(helper\._isComposing\) return;/,
    "a composition that started meanwhile owns the input");
});

// `end "ㅇ"` → `data ""` → the bare jamo emitted at +0ms, in all three splits traced from the 0.5.20 build.
// A zero-length data event carries no intent and must not cut a syllable that is waiting for its next jamo.
test("an empty data event is not a keystroke and cannot flush a held syllable", () => {
  const onData = client.match(/term\.onData\(function \(d\) \{[\s\S]*?\n    \}\);/)?.[0];
  assert.ok(onData, "the pty input handler is still where writes leave the pane");
  assert.match(onData, /if \(!d\) return;/, "an empty run returns before anything else runs");
  // Order matters: the guard has to sit ABOVE the flush, or the syllable is already cut by the time it runs.
  assert.ok(onData.indexOf("if (!d) return;") < onData.indexOf("flushHangulRepair"),
    "…and above the flush, not below it");
});

// The control run. Everything kakapo does to xterm's composition machinery is a reach into an input path no
// other terminal touches, and 32% of the jamo splits on record happened with the terminal completely idle —
// which the documented cause (output dragging the anchor) does not explain. More log cannot separate "macOS
// does this" from "we do this". KAKAPO_IME_RAW=1 stands every reach down and leaves plain xterm.js behind.
test("KAKAPO_IME_RAW stands down every kakapo reach into the composition path", () => {
  const preload = readFileSync(new URL("../src/preload.cts", import.meta.url), "utf8");
  assert.match(preload, /imeRaw: process\.env\.KAKAPO_IME_RAW === "1"/, "the flag reaches the renderer");
  assert.match(client, /var IME_RAW = !!\(window\.kakapoPty && window\.kakapoPty\.imeRaw\)/);

  // The switch sits at the BOUNDARY, not inside each helper: the helpers are pure functions other tests
  // extract and run in a sandbox that has no IME_RAW, and a run-mode flag smeared through seven of them is
  // the kind of thing that gets half-removed later. One gate per event, and every reach is below it.
  const start = client.match(/addEventListener\('compositionstart', function \(\) \{[\s\S]*?\n      \}\);/)?.[0];
  assert.ok(start, "the compositionstart listener is where the arming happens");
  assert.match(start, /if \(IME_RAW\) return;/, "the control run stops before every reach");
  for (const reach of ["pinCompositionAnchor", "setCursorHiddenForComposition",
                       "matchCompositionDim", "alignCompositionOverlay"]) {
    assert.ok(start.indexOf("if (IME_RAW) return;") < start.indexOf(reach), `${reach} sits below the gate`);
  }
  // The measurement itself must run in BOTH modes, or the two runs cannot be compared at all.
  assert.ok(start.indexOf("imeNow = {") < start.indexOf("if (IME_RAW) return;"),
    "the composition tally is armed above the gate");
  assert.match(client, /if \(!IME_RAW\) \{ setCursorHiddenForComposition\(term, false\); takeCompositionCommit\(term, event\); \}/,
    "compositionend hands the commit back to xterm on the control run");
  assert.match(client, /noteCompositionEnd\(event\); \/\/ the measurement runs in BOTH modes/);
  assert.match(client, /if \(!IME_RAW\) guardTextareaDiff\(term\);/);
  // The keydown swallow is a line, not a function.
  assert.match(client, /if \(!IME_RAW && e\.type === 'keydown' && e\.keyCode !== 229 && paneIsComposing\(term\)\)/,
    "composition keydowns reach xterm untouched on the control run");
  // And every split says which run produced it, or the comparison cannot be made.
  assert.match(client, /entry\.raw = IME_RAW;/);
});

// The clear that measurement retired. Emptying the helper textarea at compositionstart was tried, shipped and
// withdrawn: over 2116 compositions it took the abort rate from 4.7% to 6.4% and introduced 9 compositions
// that died in under 60ms — a composition cancelled, not ended — which never happened before it. Writing
// .value on the element the macOS input context is attached to is what cancels it. The accumulation it was
// aimed at is handled where it does harm instead, by textareaAppend above.
test("the helper textarea is left alone", () => {
  assert.doesNotMatch(client, /textarea\.value = ''/, "nothing writes the composition textarea's value");
  assert.doesNotMatch(client, /clearComposedTextarea/, "and the function that did is gone, not merely unused");
  assert.match(client, /Leave it alone\./, "with the measurement kept beside the empty space it left");
});

// A DEL from the textarea diff and a DEL from the user's backspace are the same byte at the same place, which
// is how a whole round went into the wrong suspect. Only one of them is ours; say which.
test("a DEL the diff emits is distinguishable from the one the keyboard sends", () => {
  const guard = client.match(/function guardTextareaDiff\(term\) \{[\s\S]*?\n  \}\n/)?.[0];
  assert.match(guard, /if \(send === TEXTAREA_DEL\) imeTrace\('guardDel'/,
    "the diff's own DEL is tagged where it leaves");
});
