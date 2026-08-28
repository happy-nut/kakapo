// The composition overlay used to float one retina pixel above the line: webgl places committed ink from
// a canvas 'ideographic' baseline, the DOM overlay from the primary font's strut. alignCompositionOverlay
// measures both models and cancels the difference with a transform. xterm doesn't boot under jsdom, so the
// function is extracted from the slice source and run against stubbed metrics — the same numbers measured
// off the running app — plus the wiring and safety pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");

const fnSource = client.match(/function alignCompositionOverlay\(term\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(fnSource, "alignCompositionOverlay exists in the slice");

// Build the function in a sandbox where document/window are controllable.
function makeAligner({ ctx, probeBaseline }) {
  const probe = {
    style: {},
    offsetTop: probeBaseline,
    set cssText(v) {},
  };
  const doc = {
    createElement(tag) {
      if (tag === "canvas") return { getContext: () => ctx };
      return probe;
    },
  };
  const win = { devicePixelRatio: 2 };
  const factory = new Function("document", "window", `${fnSource}; return alignCompositionOverlay;`);
  return { align: factory(doc, win), probe };
}

// Metrics measured off the running app (13px / 1.45, dpr 2): char.top 7 device (3.5 css), char.height 30
// device (15 css), Hangul run A_ideo 13.45, A_alpha 10.45, overlay strut baseline at 15 css px.
function appTerm(view) {
  return {
    element: { querySelector: () => view },
    __kakapoWebgl: {},
    _core: { _renderService: { dimensions: { device: { char: { top: 7, height: 30 } } } } },
    options: { fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace" },
  };
}
function makeView(text) {
  return {
    textContent: text,
    style: { transform: "", paddingTop: "" },
    children: [],
    appendChild() {},
    removeChild() {},
  };
}

test("the measured app metrics produce the measured nudge: overlay pushed DOWN by 0.5 css px", () => {
  const ctx = {
    textBaseline: "alphabetic",
    set font(v) {},
    measureText() {
      return { actualBoundingBoxAscent: this.textBaseline === "ideographic" ? 13.45 : 10.45 };
    },
  };
  const { align } = makeAligner({ ctx, probeBaseline: 15 });
  const view = makeView("갓");
  align(appTerm(view));
  // committed ink top = (7+30)/2 - 13.45 = 5.05 ; overlay ink top = 15 - 10.45 = 4.55 ; dy = +0.50
  // Down goes in as PADDING, not a transform: translateY moved the whole box and opened a sliver of the
  // cell above the overlay, through which the composer's own full-cell block showed as a caret floating on
  // top of the glyph. Padding moves the ink while the box (and its opaque background) stays on the cell.
  assert.equal(view.style.paddingTop, "0.50px");
  assert.equal(view.style.transform, "", "no transform in the downward direction");
});

test("ink that must move UP keeps the transform — padding cannot be negative", () => {
  const ctx = {
    textBaseline: "alphabetic",
    set font(v) {},
    measureText() {
      // overlay ink top = 15 - 9.45 = 5.55 ; committed = 5.05 ; dy = -0.50
      return { actualBoundingBoxAscent: this.textBaseline === "ideographic" ? 13.45 : 9.45 };
    },
  };
  const { align } = makeAligner({ ctx, probeBaseline: 15 });
  const view = makeView("갓");
  align(appTerm(view));
  assert.equal(view.style.transform, "translateY(-0.50px)");
  assert.equal(view.style.paddingTop, "", "no padding in the upward direction");
});

test("an already-aligned overlay gets no transform, and the DOM renderer clears any leftover nudge", () => {
  const ctx = {
    textBaseline: "alphabetic",
    set font(v) {},
    measureText() {
      // ideographic exactly (charTop+charH)-strut deeper than alphabetic: models agree
      return { actualBoundingBoxAscent: this.textBaseline === "ideographic" ? 13.95 : 10.45 };
    },
  };
  const { align } = makeAligner({ ctx, probeBaseline: 15 });
  const view = makeView("갓");
  align(appTerm(view));
  assert.equal(view.style.transform, "", "sub-0.05px disagreement leaves the overlay alone");
  assert.equal(view.style.paddingTop, "", "and no padding either");

  const domView = makeView("갓");
  domView.style.transform = "translateY(0.50px)";
  domView.style.paddingTop = "0.50px";
  const term = appTerm(domView);
  term.__kakapoWebgl = null; // context lost -> DOM renderer
  align(term);
  assert.equal(domView.style.transform, "", "DOM renderer shares the overlay's model — nudge removed");
  assert.equal(domView.style.paddingTop, "", "padding removed with it");
});

test("engines without ink metrics (jsdom-class) leave the overlay untouched instead of guessing", () => {
  const ctx = { set font(v) {}, textBaseline: "", measureText: () => ({}) };
  const { align } = makeAligner({ ctx, probeBaseline: 15 });
  const view = makeView("갓");
  align(appTerm(view));
  assert.equal(view.style.transform, "");
  const noCtx = makeAligner({ ctx: null, probeBaseline: 15 });
  const view2 = makeView("갓");
  noCtx.align(appTerm(view2)); // must not throw
  assert.equal(view2.style.transform, "");
});

test("the overlay is aligned at composition start and on every update", () => {
  assert.match(client, /matchCompositionDim\(term\);\n\s*alignCompositionOverlay\(term\);\n\s*imeNow =/,
    "compositionstart aligns after the dim match");
  assert.match(client, /compositionupdate.*matchCompositionDim\(term\); alignCompositionOverlay\(term\);/,
    "compositionupdate re-aligns (the composed script can change what font run is measured)");
});

test("a new composition never inherits the previous composition's pinned anchor", () => {
  const pin = client.match(/function pinCompositionAnchor\(term\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(pin, "pinCompositionAnchor exists");
  assert.match(pin, /helper\.__kakapoPinned = null;[\s\S]*if \(helper\.__kakapoAnchorPinned\) return;/,
    "the pin is cleared on every compositionstart, before the install guard — not only by an idle tick");
});
