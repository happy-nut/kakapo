// Syntax colours against every background the diff puts them on, at the WCAG AA floor for body text.
//
// Code IS the body text here — this app's whole job is reading it — and comments are most of it: measured on
// a real diff, 76% of the rendered characters were comment glyphs. Darcula dark shipped with comments at
// 3.21:1, strings at 3.15:1 and every other token under the bar too, so on that theme nearly everything on
// screen was below the floor. Nothing failed, because nothing was checking.
//
// This swept --panel alone for a while, and --panel is the one ground a CHANGED line never has. Every
// changed line is painted with a fill, and a fill moves the ground away from the colour the palette was
// tuned against: swept across the fills, 31 of 120 token values fell under the floor on --add and 46 on
// --diff-modified. Mixing the fills back toward --panel cannot fix it — several themes would need the fill
// at 7-13% strength, which measures 1.01:1 against --panel, i.e. no visible fill at all. So the headroom
// has to live in the tokens, and the sweep has to ask about the grounds that exist.
//
// Hue and saturation are the theme's business; this only asks that the result be legible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const AA_NORMAL_TEXT = 4.5;
const AA_NON_TEXT = 3; // WCAG 1.4.11: an indicator that is not text answers to a lower floor
const css = readFileSync(new URL("../src/viewer.css", import.meta.url), "utf8");

function customPropertyBlocks() {
  const out = [];
  const re = /^(:root(?:\[[^\]]+\])*)\s*\{([\s\S]*?)^\}/gm;
  let match;
  while ((match = re.exec(css))) {
    const vars = {};
    for (const line of match[2].split("\n")) {
      const declaration = /^\s*(--[\w-]+)\s*:\s*([^;]+);/.exec(line);
      if (declaration) vars[declaration[1]] = declaration[2].trim();
    }
    if (Object.keys(vars).length) out.push({ selector: match[1], vars });
  }
  return out;
}

const hex = (value) => {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};
const relativeLuminance = ({ r, g, b }) => {
  const channel = [r, g, b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};
// One level of `var(--x)` indirection is enough for how these themes are written; more would be a smell.
const resolve = (vars, name, depth = 0) => {
  const value = vars[name];
  if (!value || depth > 4) return null;
  const reference = /^var\((--[\w-]+)\)$/.exec(value.trim());
  return reference ? resolve(vars, reference[1], depth + 1) : hex(value);
};

// Every fill that is painted behind a line of code. The `-strong` fills are deliberately absent: they are
// not grounds any more, because the word-level mark stopped being a fill (see the box-shadow guard below).
const CODE_GROUNDS = ["--panel", "--add", "--del", "--diff-modified", "--diff-added", "--diff-deleted"];

test("every syntax token clears WCAG AA against every background the diff puts it on", () => {
  const blocks = customPropertyBlocks();
  const base = blocks.find((b) => b.selector === ":root");
  assert.ok(base, "the default theme is the one every other theme is layered on");
  const light = blocks.find((b) => b.selector === ':root[data-theme="light"]') ?? { vars: {} };

  const themes = blocks.filter((b) =>
    b.selector === ":root" || b.selector === ':root[data-theme="light"]' || b.selector.includes("data-syntax-theme"));
  assert.ok(themes.length >= 6, `every shipped theme is checked (found ${themes.length})`);

  const failures = [];
  let checked = 0;
  for (const theme of themes) {
    const isLight = theme.selector.includes('data-theme="light"');
    const vars = { ...base.vars, ...(isLight ? light.vars : {}), ...theme.vars };
    const grounds = CODE_GROUNDS.map((name) => ({ name, colour: resolve(vars, name) }));
    for (const ground of grounds) {
      assert.ok(ground.colour, `${theme.selector} resolves ${ground.name}`);
    }
    for (const name of Object.keys(vars)) {
      if (!name.startsWith("--token-")) continue;
      const colour = resolve(vars, name);
      if (!colour) continue;
      for (const ground of grounds) {
        checked += 1;
        const ratio = contrast(colour, ground.colour);
        if (ratio < AA_NORMAL_TEXT) failures.push(`${theme.selector} ${name} on ${ground.name} = ${ratio}:1`);
      }
    }
  }

  assert.ok(checked >= 600, `the sweep actually covered the palette on every ground (checked ${checked})`);
  assert.deepEqual(failures, [], `tokens below ${AA_NORMAL_TEXT}:1`);
});

// The sidebar's +/− magnitude is TEXT on the chrome ground, and it used to be painted with --add-strong
// and --del-strong — the fills the diff puts BEHIND a changed line. A fill read as text is dark-on-dark or
// pale-on-pale by construction: measured in the running app it came out at 2.09:1 on a resting dark row,
// 1.08:1 on the active one and 1.02:1 in light. It now inherits the chrome text colour, so this guards the
// two halves of that: the rule may not reach for a fill again, and the colour it inherits has to be legible
// on the ground it sits on, in every theme.
test("the change magnitude is readable in every theme, wherever it is shown", () => {
  // BOTH places this figure appears. The first version of this guard matched only the tree row, and the
  // breadcrumb's copy — same figure, same bug, thirteen lines up — went on failing while the test passed.
  // A guard that covers half of a fix certifies the half that was done.
  const rules = [...css.matchAll(/^[^{}\n]*\.(?:change-stat|crumb-stat)-(?:add|del)\b[^{}]*\{([^}]*)\}/gm)];
  assert.ok(rules.length >= 2, `every declaration of the magnitude's colour is checked (found ${rules.length})`);
  for (const rule of rules) {
    assert.doesNotMatch(rule[1], /--(add|del)(-strong)?\b/,
      `the magnitude is painted with a diff FILL token again; those are backgrounds, not text: ${rule[0].trim()}`);
  }

  const blocks = customPropertyBlocks();
  const base = blocks.find((b) => b.selector === ":root");
  const light = blocks.find((b) => b.selector === ':root[data-theme="light"]') ?? { vars: {} };
  const themes = blocks.filter((b) =>
    b.selector === ":root" || b.selector === ':root[data-theme="light"]' || b.selector.includes("data-syntax-theme"));

  const failures = [];
  let checked = 0;
  for (const theme of themes) {
    const isLight = theme.selector.includes('data-theme="light"');
    const vars = { ...base.vars, ...(isLight ? light.vars : {}), ...theme.vars };
    const ground = resolve(vars, "--chrome-bg");
    if (!ground) continue;
    // --chrome-text is what the magnitude inherits; --chrome-muted is every other quiet label beside it.
    for (const name of ["--chrome-text", "--chrome-muted"]) {
      const colour = resolve(vars, name);
      if (!colour) continue;
      checked += 1;
      const ratio = contrast(colour, ground);
      if (ratio < AA_NORMAL_TEXT) failures.push(`${theme.selector} ${name} = ${ratio}:1`);
    }
  }
  assert.ok(checked >= 20, `the sweep covered the shipped themes (checked ${checked})`);
  assert.deepEqual(failures, [], `chrome text below ${AA_NORMAL_TEXT}:1 on its own ground`);
});

// The word-level mark used to be the loudest fill in the app, painted straight under the characters it was
// pointing at: a syntax token on --diff-modified-strong measured 2.07:1, so the changed word was the least
// readable text on the screen. It is an underline now, and the two halves of that need holding separately —
// the rule may not reach for a fill again, and the edge it draws instead has to clear the 3:1 floor for a
// non-text indicator against the fill it sits on.
test("the word-level change mark is an edge, not a ground", () => {
  const rule = /\.d2h-code-line-ctn ins, \.d2h-code-line-ctn del \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the single rule that styles every word-level change mark is still the single rule");
  assert.match(rule[1], /box-shadow:\s*inset 0 -2px/, "the mark is drawn as an underline, not a box");
  assert.match(rule[1], /background:\s*none/, "the mark explicitly clears diff2html's own fill");
  // Anywhere, not just in that rule: a later, more specific selector is exactly how the fills got back in.
  const fills = [...css.matchAll(/^[^{}\n]*d2h-code-line-ctn (?:ins|del)[^{}]*\{([^}]*)\}/gm)];
  assert.ok(fills.length >= 1, "the mark's rules are found by this sweep");
  for (const found of fills) {
    assert.doesNotMatch(found[1], /background(-color)?:\s*(var\(--|color-mix|#|rgb)/,
      `a word-level mark paints a background again, which makes it the ground under the code: ${found[0].trim()}`);
  }

  const blocks = customPropertyBlocks();
  const base = blocks.find((b) => b.selector === ":root");
  const light = blocks.find((b) => b.selector === ':root[data-theme="light"]') ?? { vars: {} };
  const themes = blocks.filter((b) =>
    b.selector === ":root" || b.selector === ':root[data-theme="light"]' || b.selector.includes("data-syntax-theme"));
  // Each change kind sets --word-mark to its own strong colour; the mark is that mixed with --text.
  const KINDS = [
    ["--add-strong", "--add"], ["--del-strong", "--del"],
    ["--diff-modified-strong", "--diff-modified"],
    ["--diff-added-strong", "--diff-added"],
    ["--diff-deleted-strong", "--diff-deleted"],
  ];
  const share = /color-mix\(in srgb, var\(--text\) (\d+)%/.exec(rule[1]);
  assert.ok(share, "the mark's colour is a measurable mix of --text and the change hue");
  const textShare = Number(share[1]) / 100;
  const mix = (a, b, p) => ({ r: a.r * p + b.r * (1 - p), g: a.g * p + b.g * (1 - p), b: a.b * p + b.b * (1 - p) });

  const failures = [];
  let checked = 0;
  for (const theme of themes) {
    const isLight = theme.selector.includes('data-theme="light"');
    const vars = { ...base.vars, ...(isLight ? light.vars : {}), ...theme.vars };
    const text = resolve(vars, "--text");
    assert.ok(text, `${theme.selector} resolves --text`);
    for (const [strong, fill] of KINDS) {
      const hue = resolve(vars, strong);
      const ground = resolve(vars, fill);
      if (!hue || !ground) continue;
      checked += 1;
      const ratio = contrast(mix(text, hue, textShare), ground);
      if (ratio < AA_NON_TEXT) failures.push(`${theme.selector} ${strong} mark on ${fill} = ${ratio}:1`);
    }
  }
  assert.ok(checked >= 50, `every change kind was checked in every theme (checked ${checked})`);
  assert.deepEqual(failures, [], `word marks below the ${AA_NON_TEXT}:1 floor for a non-text indicator`);
});
