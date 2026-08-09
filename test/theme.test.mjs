// CORE USER FLOW: choosing a light or dark theme.
//
// The whole UI (chrome, diff2html, syntax tokens) reads :root CSS variables, and the light theme just
// overrides them under html[data-theme="light"]. The toggle lives in Settings → General, mirrors the
// language toggle (live switch, persisted), and the choice must survive a reopen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: "a.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" },
  ]));
});
after(cleanupFixtures);

test("defaults to dark, with a theme selector in settings", async () => {
  const v = await loadViewer(html);
  assert.equal(v.document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(v.document.documentElement.getAttribute("data-syntax-theme"), "default");
  // One flat grid, not two dropdowns: each card is a whole named theme that is already light or dark,
  // plus System — the only entry that has an appearance to resolve at all.
  const names = v.$all("#settings-theme-grid .theme-card-name").map((n) => n.textContent);
  assert.deepEqual(names, ["System", "Kakapo Dark", "Kakapo Light", "Darcula", "IntelliJ Light", "GitHub Dark", "GitHub Light"]);
  assert.equal(v.$("#settings-theme-grid .theme-card.is-active").dataset.themeId, "default-dark");
  assert.ok(
    v.$all("#settings-theme-grid .theme-swatch").every((s) => s.dataset.swatch),
    "each card previews its own theme with a swatch",
  );
  v.$("#settings-language").dispatchEvent(new v.window.MouseEvent("mouseover", { bubbles: true }));
  await v.settle(20);
  assert.ok(v.$("#mc-button-hint").classList.contains("hidden"), "custom dropdowns do not advertise a non-focused Enter action on hover");
  v.close();
});

test("application chrome uses a neutral high-contrast palette without replacing the code palette", async () => {
  const v = await loadViewer(html);
  const root = v.window.getComputedStyle(v.document.documentElement);
  assert.equal(root.getPropertyValue("--chrome-text").trim().toLowerCase(), "#f1f1f2");
  assert.equal(root.getPropertyValue("--chrome-border").trim().toLowerCase(), "#34363a", "the panel border sits close to --chrome-bg rather than a full mid-gray line");
  assert.equal(root.getPropertyValue("--chrome-selected").trim().toLowerCase(), "#3a3c40", "menu selection is neutral gray");
  assert.equal(root.getPropertyValue("--text").trim().toLowerCase(), "#d8e0eb", "code text keeps its quieter palette");
  assert.equal(root.getPropertyValue("--panel").trim().toLowerCase(), "#171b21", "code surfaces keep their original canvas");
  v.close();
});

// Theme is one grid of cards keyed by (family, appearance); language is still a custom dropdown (a button
// that opens .mc-dropdown), so a language pick is: click the trigger, then click the matching item.
function pickTheme(v, id) {
  const card = v.$(`#settings-theme-grid .theme-card[data-theme-id="${id}"]`);
  assert.ok(card, `the grid offers ${id}`);
  card.click();
}

test("switching to light flips data-theme on <html> and persists", async () => {
  const v = await loadViewer(html);
  pickTheme(v, "default-light");
  await v.settle(20);

  assert.equal(v.document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(v.window.localStorage.getItem("kakapo-theme"), "light");
  v.close();
});

test("the light theme is restored on reopen", async () => {
  const v1 = await loadViewer(html);
  pickTheme(v1, "default-light");
  await v1.settle(20);
  const snapshot = v1.exportStorage();
  v1.close();

  const v2 = await loadViewer(html, { seedStorage: snapshot });
  assert.equal(
    v2.document.documentElement.getAttribute("data-theme"),
    "light",
    "data-theme is light on first paint after reopen",
  );
  assert.equal(v2.$("#settings-theme-grid .theme-card.is-active").dataset.themeId, "default-light", "the grid reflects the restored theme");
  v2.close();
});

test("the Darcula family follows interface appearance across chrome and Review tokens", async () => {
  const v = await loadViewer(html);
  pickTheme(v, "darcula-dark");
  await v.settle(20);

  assert.equal(v.document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(v.document.documentElement.getAttribute("data-syntax-theme"), "darcula");
  assert.equal(v.window.localStorage.getItem("kakapo-syntax-theme"), "darcula");
  assert.equal(
    v.window.getComputedStyle(v.document.documentElement).getPropertyValue("--token-keyword").trim().toLowerCase(),
    "#cc7832",
    "raw source and diff token classes receive the Darcula keyword color",
  );

  pickTheme(v, "darcula-light");
  await v.settle(20);
  assert.equal(
    v.window.getComputedStyle(v.document.documentElement).getPropertyValue("--token-keyword").trim().toLowerCase(),
    "#0033b3",
    "the light appearance selects the IntelliJ Light token member",
  );
  assert.equal(
    v.window.getComputedStyle(v.document.documentElement).getPropertyValue("--sidebar").trim().toLowerCase(),
    "#f2f3f5",
    "the theme family also colors interface chrome",
  );

  const snapshot = v.exportStorage();
  v.close();
  const reopened = await loadViewer(html, { seedStorage: snapshot });
  assert.equal(reopened.document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(reopened.document.documentElement.getAttribute("data-syntax-theme"), "darcula");
  assert.equal(reopened.$("#settings-theme-grid .theme-card.is-active").dataset.themeId, "darcula-light");
  reopened.close();
});

// Everything styled by CSS follows html[data-theme] on its own. The terminal does not: each xterm pane is
// constructed with a colour OBJECT read from the variables at that moment, so switching to a light family
// repainted the whole app around panes still wearing the dark palette. And a light background needs its own
// ANSI palette — xterm's default white/bright-white is what a TUI prints in, and it is invisible on white.
test("switching theme repaints the live terminal panes, and light gets a readable ANSI palette", () => {
  const core = readFileSync(new URL("../src/viewer/01-core.js", import.meta.url), "utf8");
  const term = readFileSync(new URL("../src/viewer/19-terminal.js", import.meta.url), "utf8");

  assert.match(core, /function applyTheme\(\)[\s\S]{0,320}retheme\(\);/, "a theme change pushes into the panes");
  assert.match(core, /function applySyntaxTheme\(\)[\s\S]{0,260}retheme\(\)/,
    "so does a syntax family — it carries its own --panel/--text");
  assert.match(core, /function retheme\(\)[\s\S]{0,220}__kakapoTerminal[\s\S]{0,80}\.retheme\(\)/,
    "through the terminal's own entry point");
  assert.match(term, /retheme: applyTerminalTheme/, "which the terminal exposes");
  assert.match(term, /function applyTerminalTheme\(\)[\s\S]{0,200}p\.term\.options\.theme = colors/,
    "and which re-themes every live pane, not just the next one created");

  const colors = term.match(/function themeColors\(\)[\s\S]*?\n  \}/)?.[0];
  assert.ok(colors, "themeColors exists");
  assert.match(colors, /data-theme'\) === 'light'/, "it reads the resolved theme");
  assert.match(colors, /if \(light\) for \(var name in LIGHT_ANSI\)/, "and only a light theme overrides ANSI");
  for (const slot of ["white", "brightWhite", "yellow"]) {
    assert.ok(new RegExp(`\\b${slot}: '#`).test(term), `the light palette defines ${slot}`);
  }
});

// The GitHub family is a real Primer palette, not the default family's GitHub-flavoured accents: the point
// of choosing it is that a diff here reads like the same diff on github.com, which is the syntax tokens
// (red keywords, blue strings, purple functions) and the canvas under the code.
test("the GitHub family carries Primer's own palette on both sides", async () => {
  const v = await loadViewer(html);
  const css = Array.from(v.document.querySelectorAll("style"), (s) => s.textContent || "").join("\n");
  for (const mode of ["dark", "light"]) {
    const head = `:root[data-theme="${mode}"][data-syntax-theme="github"] {`;
    const at = css.indexOf(head);
    assert.ok(at >= 0, `the ${mode} member exists`);
    const block = css.slice(at, css.indexOf("}", at));
    for (const token of ["--token-keyword", "--token-string", "--token-function", "--chrome-bg", "--diff-added"]) {
      assert.ok(block.includes(token + ":"), `${mode} defines ${token}`);
    }
  }
  assert.ok(css.includes('data-syntax-theme="github"] #diff2html-container'), "and its own code canvas");
  assert.ok(css.includes('.theme-swatch[data-swatch="github-dark"]'), "with swatches for the picker");

  // Selecting it must survive: the picker only accepts families it knows, so a new one has to be listed.
  const dock = readFileSync(new URL("../src/viewer/08-dock.js", import.meta.url), "utf8");
  assert.match(dock, /SYNTAX_FAMILIES = \['default', 'darcula', 'github'\]/, "the family is selectable");
  v.close();
});
