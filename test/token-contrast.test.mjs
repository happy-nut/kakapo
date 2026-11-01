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
// A ground may be written as a step from another ground rather than as a literal — the File Colors are,
// because one flat tint cannot sit behind twelve themes' ink. Evaluating the mix is not a nicety: a
// resolver that returns null for it drops that ground from every sweep SILENTLY, which looks exactly like
// a ground that passes.
const mixed = (vars, value, depth) => {
  const m = /^color-mix\(\s*in\s+srgb\s*,\s*(#[0-9a-f]{6}|var\(--[\w-]+\))\s+(\d+)%\s*,\s*(#[0-9a-f]{6}|var\(--[\w-]+\))\s*\)$/i
    .exec(value);
  if (!m) return null;
  const side = (token) => {
    const ref = /^var\((--[\w-]+)\)$/.exec(token);
    return ref ? resolve(vars, ref[1], depth + 1) : hex(token);
  };
  const a = side(m[1]);
  const b = side(m[3]);
  if (!a || !b) return null;
  const w = Number(m[2]) / 100;
  return { r: a.r * w + b.r * (1 - w), g: a.g * w + b.g * (1 - w), b: a.b * w + b.b * (1 - w) };
};
// One level of `var(--x)` indirection is enough for how these themes are written; more would be a smell.
const resolve = (vars, name, depth = 0) => {
  const value = vars[name];
  if (!value || depth > 4) return null;
  const trimmed = value.trim();
  const reference = /^var\((--[\w-]+)\)$/.exec(trimmed);
  if (reference) return resolve(vars, reference[1], depth + 1);
  return hex(trimmed) ?? mixed(vars, trimmed, depth);
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

// A colour written as a literal hex in a rule, rather than taken from the palette, answers to no theme.
//
// The ref badges in the history list were four such literals — `.href-head #56c8ff` and its siblings,
// picked against a dark panel and left there. On every light theme they measured 1.39–1.80:1: the label
// naming the branch a commit sits on, unreadable, forty-eight rows at a time. Nothing caught it because
// every sweep above reads the palette, and a literal is exactly the thing that is not in it.
//
// Measured, not demanded: plenty of literals are fine on both grounds (a mid green reads on either), and a
// guard that fails those is one somebody turns off. This asks the real question — what does this colour
// measure against the LIGHT theme's surfaces — and a literal answered by its own `[data-theme="light"]`
// rule has been dealt with and is skipped.
test("text painted a literal colour is still readable on the light themes", () => {
  const light = customPropertyBlocks().find((block) => block.selector === ':root[data-theme="light"]');
  assert.ok(light, "the light palette is declared in one :root block");
  const grounds = ["--bg", "--panel"].map((name) => {
    const value = resolve(light.vars, name); // already {r,g,b}
    assert.ok(value, `${name} resolves to a colour on the light theme`);
    return { name, value };
  });

  const answered = (selector) => {
    const classes = selector.match(/\.[\w-]+/g) || [];
    return classes.some((cls) => {
      const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\[data-theme="light"\\][^{]*${escaped}[^{]*\\{[^}]*color\\s*:`).test(css);
    });
  };

  const failures = [];
  const re = /^([^@{}\n][^{}\n]*)\{([^}]*)\}/gm;
  let match;
  while ((match = re.exec(css))) {
    const selector = match[1].trim();
    if (selector.startsWith(":root") || /\[data-theme="light"\]/.test(selector)) continue;
    // A diff cell never sits on --bg or --panel: every one of them is painted with a change fill, and
    // those grounds have their own sweep at the top of this file (CODE_GROUNDS). Measured here it would
    // report 1.25:1 for a colour that is correct, which is the kind of false alarm that gets a guard
    // switched off.
    if (/\bd2h-/.test(selector)) continue;
    const ink = /(?:^|;)\s*color\s*:\s*(#[0-9a-fA-F]{6})\s*(?:;|$)/.exec(match[2]);
    if (!ink || answered(selector)) continue;
    const value = hex(ink[1]);
    if (!value) continue;
    for (const ground of grounds) {
      const ratio = contrast(value, ground.value);
      if (ratio < AA_NORMAL_TEXT) {
        failures.push(`${selector} → ${ink[1]} is ${ratio.toFixed(2)}:1 on ${ground.name}`);
      }
    }
  }
  assert.deepEqual(failures, [],
    "a fixed colour has to hold on the light grounds too, or carry a [data-theme=\"light\"] rule that does");
});

// ===========================================================================================================
// The grounds, not the colours.
//
// Thirteen rounds of review never measured these, and the reason is instructive: every one of them was
// introduced as "the quiet one", and quiet is not a property anything was checking. Swept across the twelve
// themes against the surfaces they are actually painted on, the gutter's line numbers measured 3.11:1, a
// Code Vision row 3.11:1, an inlay hint 2.93:1, Quick Open's path 2.27:1 — and darcula's own modal surface
// put PRIMARY text at 4.46:1, which is the finding that argues for this shape: a sweep aimed at secondary
// ink caught the primary, because it asked about a GROUND rather than about a list of colours.
//
// So this names surfaces and asks every ink that lands on one to clear its floor there. A new theme answers
// the same questions without anyone remembering to add it, and a new surface is one line.
// A tinted row is a ground: IntelliJ's File Colors paint the ROW and leave the name alone, so the status
// colour that name carries has to survive the tint. These were missing, and seventeen ink/ground pairs
// were under AA behind them — the one axis of this round that a first pass walked straight past.
const CHROME_GROUNDS = ["--chrome-bg", "--chrome-selected", "--chrome-panel", "--chrome-elevated",
  "--file-color-test", "--file-color-generated"];
// --muted is the code canvas's secondary ink. The canvas is the diff and the source, plus the sheets and
// empty states that share its palette — NOT the sidebar: a chrome row uses --chrome-muted, which is the
// rule the qualifier pills were moved onto and the rule a deleted filename was still breaking.
const CANVAS_GROUNDS = ["--panel", "--bg", "--elevated", "--line",
  "--add", "--del", "--diff-modified", "--diff-added", "--diff-deleted"];
const VCS_GROUNDS = ["--chrome-bg", "--chrome-panel", "--chrome-elevated",
  "--file-color-test", "--file-color-generated"];
const INK = [
  { name: "--text", floor: AA_NORMAL_TEXT, grounds: CANVAS_GROUNDS },
  { name: "--muted", floor: AA_NORMAL_TEXT, grounds: CANVAS_GROUNDS },
  { name: "--chrome-text", floor: AA_NORMAL_TEXT, grounds: CHROME_GROUNDS },
  { name: "--chrome-muted", floor: AA_NORMAL_TEXT, grounds: CHROME_GROUNDS },
  { name: "--chrome-selected-text", floor: AA_NORMAL_TEXT, grounds: ["--chrome-selected"] },
  // The sidebar's git status IS the information — IntelliJ's alphabet, with no badge to fall back on. Its
  // grounds are the three RESTING chrome surfaces and not --chrome-selected, because a selected row hands
  // its filename to --chrome-selected-text instead. That is not an omission, and the test below holds it:
  // --chrome-selected sits between the two lightness poles, so no status ink can be tuned against both it
  // and the resting row — --chrome-vcs-edited measured 2.86:1 there on Solarized dark.
  { name: "--chrome-vcs-new", floor: AA_NORMAL_TEXT, grounds: VCS_GROUNDS },
  { name: "--chrome-vcs-edited", floor: AA_NORMAL_TEXT, grounds: VCS_GROUNDS },
  { name: "--chrome-vcs-staged", floor: AA_NORMAL_TEXT, grounds: VCS_GROUNDS },
  // Focus rings and the selection accent: indicators, not text, so 1.4.11's floor.
  { name: "--active", floor: AA_NON_TEXT, grounds: [...CANVAS_GROUNDS, ...CHROME_GROUNDS] },
];

test("every ink clears its floor on every surface it is painted on", () => {
  const blocks = customPropertyBlocks();
  const base = blocks.find((b) => b.selector === ":root");
  const light = blocks.find((b) => b.selector === ':root[data-theme="light"]') ?? { vars: {} };
  const themes = blocks.filter((b) =>
    b.selector === ":root" || b.selector === ':root[data-theme="light"]' || b.selector.includes("data-syntax-theme"));
  assert.ok(themes.length >= 6, `every shipped theme is checked (found ${themes.length})`);

  const failures = [];
  let checked = 0;
  for (const theme of themes) {
    const isLight = theme.selector.includes('data-theme="light"');
    const vars = { ...base.vars, ...(isLight ? light.vars : {}), ...theme.vars };
    for (const ink of INK) {
      const colour = resolve(vars, ink.name);
      assert.ok(colour, `${theme.selector} resolves ${ink.name}`);
      for (const groundName of ink.grounds) {
        const ground = resolve(vars, groundName);
        assert.ok(ground, `${theme.selector} resolves ${groundName}`);
        checked += 1;
        const ratio = contrast(colour, ground);
        if (ratio < ink.floor) {
          failures.push(`${theme.selector} ${ink.name} on ${groundName} = ${ratio}:1 (floor ${ink.floor})`);
        }
      }
    }
  }
  // 13 theme/mode pairs x 9 inks; a drop here means an ink or a ground quietly left the sweep.
  assert.ok(checked >= 400, `the sweep covered every ink on every ground (checked ${checked})`);
  assert.deepEqual(failures, [], "ink below its floor on a surface it is painted on");
});

// The two ways a colour that measures fine on paper arrives on screen below the floor. Both were live in
// six places at once, which is what a shape rule is for: the measuring test above only sees the tokens, and
// these defects live in the rules that USE them.
//
//   1. Alpha. `opacity: 0.8` composites the ink back toward the ground by 20% — it undoes exactly the
//      headroom the palette was tuned for, and it is invisible in any sweep of the palette itself. Nine of
//      the thirteen theme/mode pairs were under AA on the inlay hint for this reason alone.
//   2. Ink on a tint of itself. A `color-mix(<ink> N%, transparent)` fill moves the ground toward the ink
//      by as much as it makes the chip visible, so it spends the ink's contrast to buy the chip's shape.
//      This was already written down for the sidebar pills; it was still live for the kind chip and the
//      inlay hint, which is how a rule stated in one comment fails to bind the next author.
//
// Secondary text does not need either one. Size, weight, face, italic and position separate it for free.
test("no secondary ink is thinned with alpha, and none is laid on a tint of itself", () => {
  // Every rule whose colour is one of the secondary inks — the ones with the least headroom to spend.
  const SECONDARY = ["--muted", "--chrome-muted"];
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.ok(rules.length > 500, `the whole stylesheet is scanned (found ${rules.length} rules)`);

  const offenders = [];
  let scanned = 0;
  for (const [, selector, body] of rules) {
    if (selector.trimStart().startsWith(":root") || selector.includes("@")) continue;
    const colour = /(?:^|[;\s])color\s*:\s*([^;]+)/.exec(body);
    if (!colour) continue;
    const ink = SECONDARY.find((name) => colour[1].includes(`var(${name})`));
    if (!ink) continue;
    scanned += 1;
    const sel = selector.trim().replace(/\s+/g, " ");
    // 1. Alpha anywhere in the rule that paints it.
    const alpha = /(?:^|[;\s])opacity\s*:\s*(0?\.\d+|0)\s*(?:;|$)/.exec(body);
    if (alpha) offenders.push(`${sel} thins ${ink} with opacity: ${alpha[1]}`);
    // 2. A fill made out of the very ink being painted on it.
    const fill = new RegExp(`background(?:-color)?\\s*:[^;]*color-mix\\([^)]*var\\(${ink}\\)`).exec(body);
    if (fill) offenders.push(`${sel} lays ${ink} on a tint of ${ink}`);
    // 3. The same spend wearing the mix's clothes: the ink itself mixed toward its own ground.
    const thinned = new RegExp(`color\\s*:\\s*color-mix\\([^;]*var\\(${ink}\\)\\s*\\d+%\\s*,\\s*transparent`).exec(body);
    if (thinned) offenders.push(`${sel} thins ${ink} with a transparent mix`);
  }
  assert.ok(scanned >= 20, `the secondary inks are actually used in rules this scan reaches (scanned ${scanned})`);
  assert.deepEqual(offenders, [], "secondary ink spending the contrast the palette was tuned for");
});

// The canvas and the chrome are two palettes, and the comments in viewer.css say so in three places —
// "--muted — a code-canvas token, on chrome grounds here" is how the qualifier pills were diagnosed. Prose
// does not bind the next author: a deleted filename was still painted with --muted on a sidebar row, the
// Settings close button hovered in --text on --chrome-selected (3.88:1 on darcula), and three patch-set
// controls wore --chrome-muted on --panel. Each one measured somewhere between fine and broken depending on
// the theme, which is exactly the kind of defect that survives review.
//
// Stating it as a rule also licenses the narrower ground lists above: --text is swept against the canvas
// ONLY because nothing paints it on the chrome, and this is what keeps that true.
//
// Honest limit: ink inherits its ground from an ancestor, so a stylesheet scan can only judge the rules that
// declare both halves themselves. It catches the crossing where it is written down, not the one assembled
// across two selectors — the measuring sweep above is what covers the rest.
test("the canvas palette and the chrome palette do not borrow each other's ink", () => {
  const CANVAS_INK = ["--text", "--muted"];
  const CHROME_INK = ["--chrome-text", "--chrome-muted", "--chrome-selected-text"];
  const CHROME_GROUND = ["--chrome-bg", "--chrome-selected", "--chrome-panel", "--chrome-elevated", "--chrome-line"];
  const CANVAS_GROUND = ["--panel", "--bg", "--elevated", "--line"];

  const crossings = [];
  let paired = 0;
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector.trimStart().startsWith(":root") || selector.includes("@")) continue;
    const colour = /(?:^|[;\s])color\s*:\s*([^;]+)/.exec(body);
    const fill = /(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/.exec(body);
    if (!colour || !fill) continue;
    paired += 1;
    const sel = selector.trim().replace(/\s+/g, " ");
    const pairs = [
      ["canvas ink on a chrome ground", CANVAS_INK, CHROME_GROUND],
      ["chrome ink on a canvas ground", CHROME_INK, CANVAS_GROUND],
    ];
    for (const [what, inks, grounds] of pairs) {
      for (const ink of inks) {
        if (!colour[1].includes(`var(${ink})`)) continue;
        for (const ground of grounds) {
          if (fill[1].includes(`var(${ground})`)) crossings.push(`${sel}: ${what} — ${ink} on ${ground}`);
        }
      }
    }
  }
  assert.ok(paired >= 60, `the scan reached the rules that paint both halves (found ${paired})`);
  assert.deepEqual(crossings, [], "a rule borrowing the other palette's ink");
});

// The claim VCS_GROUNDS leans on. A selected sidebar row must hand its filename to --chrome-selected-text,
// because that is the ONLY ink measured against --chrome-selected: delete this rule and every status colour
// is back on a ground none of them clears, with the sweep above no longer asking. The rule has to outrank
// the status rules it overrides, so it also has to come after them — equal specificity, source order wins.
test("a selected row paints its filename in the selection's own ink", () => {
  const override = /\.change-row\.active \.change-name[^{}]*\{([^}]*)\}/.exec(css);
  assert.ok(override, "the selected row still overrides the status ink on the filename");
  assert.match(override[1], /var\(--chrome-selected-text\)/,
    "the one ink this test's --chrome-selected measurement covers");

  const status = css.lastIndexOf(".change-row.ch-deleted .change-name");
  assert.ok(status > 0, "the status rules are still here to be overridden");
  assert.ok(css.indexOf(override[0]) > status,
    "the override comes after the status rules, or equal specificity hands them the cascade");
});
