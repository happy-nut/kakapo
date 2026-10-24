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

// Every fill that is painted behind a line of code — including the word-level fills, which are grounds
// again now that the word mark is a fill again. They are the ones that bottomed out at 2.07:1, so leaving
// them out of this sweep is how that went unnoticed in the first place.
const CODE_GROUNDS = [
  "--panel",
  "--add", "--del", "--diff-modified", "--diff-added", "--diff-deleted",
  "--add-strong", "--del-strong", "--diff-modified-strong", "--diff-added-strong", "--diff-deleted-strong",
];

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

  assert.ok(checked >= 1100, `the sweep actually covered the palette on every ground (checked ${checked})`);
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
  assert.ok(rules.length >= 4, `every declaration of the magnitude's colour is checked (found ${rules.length})`);
  for (const rule of rules) {
    assert.doesNotMatch(rule[1], /var\(--(add|del)(-strong)?\)/,
      `the magnitude is painted with a diff FILL token again; those are backgrounds, not text: ${rule[0].trim()}`);
    assert.match(rule[1], /var\(--chrome-stat-(add|del)\)/,
      `the magnitude is painted with the solved chrome pair: ${rule[0].trim()}`);
  }
  // The figure was high-contrast and still unreadable once, because it was 10px at 0.75 alpha: the alpha
  // composited the colour back toward the ground, undoing exactly what the pair above is solved for.
  const stat = /\.change-row \.change-stat \{([^}]*)\}/.exec(css);
  assert.ok(stat, "the sidebar magnitude still has one rule for its box");
  assert.doesNotMatch(stat[1], /opacity:/, "the magnitude is solid; alpha here silently undoes its contrast");

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
    // A sidebar row has two grounds — resting and selected — and the figure has to be readable on both.
    // Measuring only --chrome-bg is how the SELECTED row went unchecked while it was the worse of the two.
    for (const groundName of ["--chrome-bg", "--chrome-selected"]) {
      const ground = resolve(vars, groundName);
      if (!ground) continue;
      // The pair the magnitude is actually painted with, plus the quiet labels sitting beside it.
      for (const name of ["--chrome-stat-add", "--chrome-stat-del", "--chrome-text"]) {
        const colour = resolve(vars, name);
        if (!colour) continue;
        checked += 1;
        const ratio = contrast(colour, ground);
        if (ratio < AA_NORMAL_TEXT) failures.push(`${theme.selector} ${name} on ${groundName} = ${ratio}:1`);
      }
    }
  }
  assert.ok(checked >= 60, `the sweep covered the shipped themes on both grounds (checked ${checked})`);
  assert.deepEqual(failures, [], `chrome text below ${AA_NORMAL_TEXT}:1 on its own ground`);
});

// The word fill and the line fill are one colour at two strengths, the way GitHub's are — not two
// colours. An earlier attempt gave the step to SATURATION alone, at a near-identical lightness, and that
// reads as a different colour rather than as more of the same one.
//
// Stated as a ramp, because that is the claim: from the panel, to the line's tint, to the word's. Each
// step moves further from the panel in the same direction, so the page reads as one background getting
// stronger rather than as unrelated patches.
test("a changed word is the row's own colour, one step stronger", () => {
  const blocks = customPropertyBlocks();
  const base = blocks.find((b) => b.selector === ":root");
  const light = blocks.find((b) => b.selector === ':root[data-theme="light"]') ?? { vars: {} };
  const themes = blocks.filter((b) =>
    b.selector === ":root" || b.selector === ':root[data-theme="light"]' || b.selector.includes("data-syntax-theme"));
  const PAIRS = [
    ["--add", "--add-strong"], ["--del", "--del-strong"],
    ["--diff-modified", "--diff-modified-strong"],
    ["--diff-added", "--diff-added-strong"],
    ["--diff-deleted", "--diff-deleted-strong"],
  ];
  const hueOf = ({ r, g, b }) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), span = max - min;
    if (!span) return null; // grey has no hue to compare — Darcula's deletion tint is deliberately one
    const h = max === r ? ((g - b) / span + (g < b ? 6 : 0)) : max === g ? ((b - r) / span + 2) : ((r - g) / span + 4);
    return (h * 60 + 360) % 360;
  };
  const saturation = ({ r, g, b }) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  };

  let checked = 0;
  const failures = [];
  for (const theme of themes) {
    const isLight = theme.selector.includes('data-theme="light"');
    const vars = { ...base.vars, ...(isLight ? light.vars : {}), ...theme.vars };
    const panel = resolve(vars, "--panel");
    if (!panel) continue;
    for (const [lineName, wordName] of PAIRS) {
      const line = resolve(vars, lineName);
      const word = resolve(vars, wordName);
      if (!line || !word) continue;
      checked += 1;
      const where = `${theme.selector} ${lineName}/${wordName}`;

      // One colour, two strengths: the hues agree wherever there is a hue to compare.
      const lineHue = hueOf(line), wordHue = hueOf(word);
      if (lineHue !== null && wordHue !== null && saturation(line) > 0.08 && saturation(word) > 0.08) {
        const apart = Math.min(Math.abs(lineHue - wordHue), 360 - Math.abs(lineHue - wordHue));
        if (apart > 14) failures.push(`${where}: hues ${apart.toFixed(0)}° apart — that is two colours, not two strengths`);
      }

      // And a real step, in the same direction as the one the row already took from the panel.
      const away = (a, b) => relativeLuminance(a) - relativeLuminance(b);
      const rowStep = away(line, panel);
      const wordStep = away(word, line);
      if (Math.sign(wordStep) !== Math.sign(rowStep)) {
        failures.push(`${where}: the word fill turns back toward the panel instead of going further from it`);
      }
      if (Math.abs(wordStep) < Math.abs(rowStep) * 0.25) {
        failures.push(`${where}: the word fill is only ${(Math.abs(wordStep) / Math.abs(rowStep) * 100).toFixed(0)}% of the row's own step — no visible second level`);
      }
    }
  }
  assert.ok(checked >= 50, `every change kind in every theme was checked (checked ${checked})`);
  assert.deepEqual(failures, [], "word fills that are not the row's colour one step stronger");
});

// A pill never lays its ink on a tint of itself.
//
// The sidebar's qualifying pills (trivial, 충돌, 갈라짐) were built as `color: <ink>` over
// `background: color-mix(<same ink> N%, transparent)`. That fill is not free: it moves the ground toward
// the ink by exactly as much as it makes the pill visible, so the shape is bought with the contrast. And
// there is nothing to buy it with here — `--chrome-stat-del` is solved to 4.58-4.63:1 in all twelve themes,
// i.e. to the floor, and `--muted` (what two of the three pills used, though it is a code-canvas token on a
// chrome ground) measures 2.33:1 before any fill at all.
//
// So the rule is structural, not a number: these rules declare no background. Stated that way because a
// threshold would have to model the composite, and the composite is the bug — the way to not have it is to
// not paint it.
test("the sidebar's qualifying pills are ink on the row, never ink on a tint of itself", () => {
  const PILLS = [".change-trivial", ".change-collision.cl-conflict", ".change-collision.cl-diverged"];
  for (const selector of PILLS) {
    // The shape block is shared (`.change-trivial,\n.change-collision`), so anchor on the whole declaration
    // list that this exact selector introduces rather than on a rule that starts at a newline.
    const at = css.indexOf(selector + " {");
    assert.ok(at >= 0, `${selector} has a rule of its own`);
    const body = css.slice(at, css.indexOf("}", at));
    assert.doesNotMatch(body, /background/,
      `${selector} paints a fill again; a pill's own tint is the ground its ink has to clear: ${body.trim()}`);
  }
  // The shared shape block may not reintroduce one for all of them either.
  const shape = /\.change-trivial,\n\.change-collision \{([^}]*)\}/.exec(css);
  assert.ok(shape, "the two pills still share one shape block");
  assert.doesNotMatch(shape[1], /background/, "the shared pill shape stays unfilled");
});

// --chrome-status-bad is a STATE on a chrome row, and it is new, so its contract is asserted rather than
// assumed: 4.5:1 on both grounds a sidebar row has, in every theme that ships.
//
// It exists because the conflict pill used --chrome-stat-del, which answers a different question ("how many
// lines went away") and is tuned to the floor for it. The two are not interchangeable even where they share
// a value: darcula paints its deletion figure GREY on purpose, so inheriting it would have rendered a
// conflict warning as a grey pill next to the quiet grey pill it has to be told apart from.
//
// --chrome-muted, which the quiet pills use, is deliberately NOT swept here: it is under the floor on
// solarized and dracula today, and solarized's own token comment records that choice (base01 is Solarized's
// secondary text, and the lighter candidate measured worse). That is a palette question with its own
// argument, not something this test should settle by failing.
test("a chrome state ink is readable on both sidebar grounds, in every theme", () => {
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
    const ink = resolve(vars, "--chrome-status-bad");
    assert.ok(ink, `${theme.selector} declares --chrome-status-bad (every theme states its own chrome inks)`);
    for (const groundName of ["--chrome-bg", "--chrome-selected"]) {
      const ground = resolve(vars, groundName);
      if (!ground) continue;
      checked += 1;
      const ratio = contrast(ink, ground);
      if (ratio < AA_NORMAL_TEXT) failures.push(`${theme.selector} --chrome-status-bad on ${groundName} = ${ratio}:1`);
    }
  }
  assert.ok(checked >= 24, `both grounds in all twelve themes were checked (checked ${checked})`);
  assert.deepEqual(failures, [], `a conflict warning below ${AA_NORMAL_TEXT}:1 on a row it appears on`);

  // The split may not be collapsed back into an alias. Nine themes share their count's VALUE — swept at
  // each count ink's own lightness, every theme is already at the maximum chroma its grounds allow, so
  // there is no stronger step to give the state — but sharing a value is not the same as being the same
  // token, and `var(--chrome-stat-del)` is how the distinction would quietly die. Shape carries it: a pill
  // with a word in it at 600, against a bare figure.
  for (const theme of themes) {
    const declared = theme.vars["--chrome-status-bad"];
    if (!declared) continue;
    assert.doesNotMatch(declared, /var\(/,
      `${theme.selector}: --chrome-status-bad is an alias; a state that tracks a count is a state painted by a count`);
  }

  // And it is a WARNING, so it may not collapse into the quiet ink beside it on any theme — the failure
  // darcula would have had by inheriting the deletion figure.
  for (const theme of themes) {
    const isLight = theme.selector.includes('data-theme="light"');
    const vars = { ...base.vars, ...(isLight ? light.vars : {}), ...theme.vars };
    const bad = resolve(vars, "--chrome-status-bad");
    const quiet = resolve(vars, "--chrome-muted");
    if (!bad || !quiet) continue;
    assert.ok(contrast(bad, quiet) >= 1.3 || Math.abs(saturationOf(bad) - saturationOf(quiet)) >= 0.15,
      `${theme.selector}: 충돌 and 갈라짐 are the same ink — the warning has nothing to tell it apart`);
  }
});

const saturationOf = ({ r, g, b }) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};
