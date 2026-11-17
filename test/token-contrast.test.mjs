import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const AA_NORMAL_TEXT = 4.5;
const AA_NON_TEXT = 3;
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
const resolve = (vars, name, depth = 0) => {
  const value = vars[name];
  if (!value || depth > 4) return null;
  const trimmed = value.trim();
  const reference = /^var\((--[\w-]+)\)$/.exec(trimmed);
  if (reference) return resolve(vars, reference[1], depth + 1);
  return hex(trimmed) ?? mixed(vars, trimmed, depth);
};

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

test("the change magnitude is readable in every theme, wherever it is shown", () => {
  const rules = [...css.matchAll(/^[^{}\n]*\.(?:change-stat|crumb-stat)-(?:add|del)\b[^{}]*\{([^}]*)\}/gm)];
  assert.ok(rules.length >= 4, `every declaration of the magnitude's colour is checked (found ${rules.length})`);
  for (const rule of rules) {
    assert.doesNotMatch(rule[1], /var\(--(add|del)(-strong)?\)/,
      `the magnitude is painted with a diff FILL token again; those are backgrounds, not text: ${rule[0].trim()}`);
    assert.match(rule[1], /var\(--chrome-stat-(add|del)\)/,
      `the magnitude is painted with the solved chrome pair: ${rule[0].trim()}`);
  }
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
    for (const groundName of ["--chrome-bg", "--chrome-selected"]) {
      const ground = resolve(vars, groundName);
      if (!ground) continue;
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
    if (!span) return null;
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

      const lineHue = hueOf(line), wordHue = hueOf(word);
      if (lineHue !== null && wordHue !== null && saturation(line) > 0.08 && saturation(word) > 0.08) {
        const apart = Math.min(Math.abs(lineHue - wordHue), 360 - Math.abs(lineHue - wordHue));
        if (apart > 14) failures.push(`${where}: hues ${apart.toFixed(0)}° apart — that is two colours, not two strengths`);
      }

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

test("the sidebar's qualifying pills are ink on the row, never ink on a tint of itself", () => {
  const PILLS = [".change-trivial", ".change-collision.cl-conflict", ".change-collision.cl-diverged"];
  for (const selector of PILLS) {
    const at = css.indexOf(selector + " {");
    assert.ok(at >= 0, `${selector} has a rule of its own`);
    const body = css.slice(at, css.indexOf("}", at));
    assert.doesNotMatch(body, /background/,
      `${selector} paints a fill again; a pill's own tint is the ground its ink has to clear: ${body.trim()}`);
  }
  const shape = /\.change-trivial,\n\.change-collision \{([^}]*)\}/.exec(css);
  assert.ok(shape, "the two pills still share one shape block");
  assert.doesNotMatch(shape[1], /background/, "the shared pill shape stays unfilled");
});

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

  for (const theme of themes) {
    const declared = theme.vars["--chrome-status-bad"];
    if (!declared) continue;
    assert.doesNotMatch(declared, /var\(/,
      `${theme.selector}: --chrome-status-bad is an alias; a state that tracks a count is a state painted by a count`);
  }

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

test("text painted a literal colour is still readable on the light themes", () => {
  const light = customPropertyBlocks().find((block) => block.selector === ':root[data-theme="light"]');
  assert.ok(light, "the light palette is declared in one :root block");
  const grounds = ["--bg", "--panel"].map((name) => {
    const value = resolve(light.vars, name);
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

const CHROME_GROUNDS = ["--chrome-bg", "--chrome-selected", "--chrome-panel", "--chrome-elevated",
  "--file-color-test", "--file-color-generated",
  "--file-color-test-tab", "--file-color-generated-tab"];
const CANVAS_GROUNDS = ["--panel", "--bg", "--elevated", "--line",
  "--add", "--del", "--diff-modified", "--diff-added", "--diff-deleted"];
const VCS_GROUNDS = ["--chrome-bg", "--chrome-panel", "--chrome-elevated",
  "--file-color-test", "--file-color-generated", "--file-color-test-tab", "--file-color-generated-tab"];
const INK = [
  { name: "--text", floor: AA_NORMAL_TEXT, grounds: CANVAS_GROUNDS },
  { name: "--muted", floor: AA_NORMAL_TEXT, grounds: CANVAS_GROUNDS },
  { name: "--chrome-text", floor: AA_NORMAL_TEXT, grounds: CHROME_GROUNDS },
  { name: "--chrome-muted", floor: AA_NORMAL_TEXT, grounds: CHROME_GROUNDS },
  { name: "--chrome-selected-text", floor: AA_NORMAL_TEXT, grounds: ["--chrome-selected"] },
  { name: "--chrome-vcs-new", floor: AA_NORMAL_TEXT, grounds: VCS_GROUNDS },
  { name: "--chrome-vcs-edited", floor: AA_NORMAL_TEXT, grounds: VCS_GROUNDS },
  { name: "--chrome-vcs-staged", floor: AA_NORMAL_TEXT, grounds: VCS_GROUNDS },
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
  assert.ok(checked >= 400, `the sweep covered every ink on every ground (checked ${checked})`);
  assert.deepEqual(failures, [], "ink below its floor on a surface it is painted on");
});

test("no secondary ink is thinned with alpha, and none is laid on a tint of itself", () => {
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
    const alpha = /(?:^|[;\s])opacity\s*:\s*(0?\.\d+|0)\s*(?:;|$)/.exec(body);
    if (alpha) offenders.push(`${sel} thins ${ink} with opacity: ${alpha[1]}`);
    const fill = new RegExp(`background(?:-color)?\\s*:[^;]*color-mix\\([^)]*var\\(${ink}\\)`).exec(body);
    if (fill) offenders.push(`${sel} lays ${ink} on a tint of ${ink}`);
    const thinned = new RegExp(`color\\s*:\\s*color-mix\\([^;]*var\\(${ink}\\)\\s*\\d+%\\s*,\\s*transparent`).exec(body);
    if (thinned) offenders.push(`${sel} thins ${ink} with a transparent mix`);
  }
  assert.ok(scanned >= 20, `the secondary inks are actually used in rules this scan reaches (scanned ${scanned})`);
  assert.deepEqual(offenders, [], "secondary ink spending the contrast the palette was tuned for");
});

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
