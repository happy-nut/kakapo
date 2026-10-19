// Syntax colours against their own theme's code background, at the WCAG AA floor for body text.
//
// Code IS the body text here — this app's whole job is reading it — and comments are most of it: measured on
// a real diff, 76% of the rendered characters were comment glyphs. Darcula dark shipped with comments at
// 3.21:1, strings at 3.15:1 and every other token under the bar too, so on that theme nearly everything on
// screen was below the floor. Nothing failed, because nothing was checking.
//
// Hue and saturation are the theme's business; this only asks that the result be legible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const AA_NORMAL_TEXT = 4.5;
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

test("every syntax token clears WCAG AA against its own theme's code background", () => {
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
    const background = resolve(vars, "--panel");
    assert.ok(background, `${theme.selector} resolves a code background`);
    for (const name of Object.keys(vars)) {
      if (!name.startsWith("--token-")) continue;
      const colour = resolve(vars, name);
      if (!colour) continue;
      checked += 1;
      const ratio = contrast(colour, background);
      if (ratio < AA_NORMAL_TEXT) failures.push(`${theme.selector} ${name} = ${ratio}:1`);
    }
  }

  assert.ok(checked >= 100, `the sweep actually covered the palette (checked ${checked})`);
  assert.deepEqual(failures, [], `tokens below ${AA_NORMAL_TEXT}:1`);
});
