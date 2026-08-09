// CORE USER FLOW: choosing a light or dark theme.
//
// The whole UI (chrome, diff2html, syntax tokens) reads :root CSS variables, and the light theme just
// overrides them under html[data-theme="light"]. The toggle lives in Settings → General, mirrors the
// language toggle (live switch, persisted), and the choice must survive a reopen.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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
  // One grid, not two dropdowns: every family × appearance combination is a visible, pickable card.
  assert.equal(v.$all("#settings-theme-grid .theme-card").length, 6, "both families offer system/light/dark");
  assert.equal(v.$("#settings-theme-grid .theme-card.is-active").dataset.family, "default");
  assert.equal(v.$("#settings-theme-grid .theme-card.is-active").dataset.mode, "dark");
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
function pickTheme(v, family, mode) {
  const card = v.$(`#settings-theme-grid .theme-card[data-family="${family}"][data-mode="${mode}"]`);
  assert.ok(card, `the grid offers ${family}/${mode}`);
  card.click();
}
// Whatever family is selected right now, with a different appearance — the axis this helper is changing.
function pickAppearance(v, mode) {
  pickTheme(v, v.$("#settings-theme-grid .theme-card.is-active").dataset.family, mode);
}

test("switching to light flips data-theme on <html> and persists", async () => {
  const v = await loadViewer(html);
  pickAppearance(v, "light");
  await v.settle(20);

  assert.equal(v.document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(v.window.localStorage.getItem("kakapo-theme"), "light");
  v.close();
});

test("the light theme is restored on reopen", async () => {
  const v1 = await loadViewer(html);
  pickAppearance(v1, "light");
  await v1.settle(20);
  const snapshot = v1.exportStorage();
  v1.close();

  const v2 = await loadViewer(html, { seedStorage: snapshot });
  assert.equal(
    v2.document.documentElement.getAttribute("data-theme"),
    "light",
    "data-theme is light on first paint after reopen",
  );
  assert.equal(v2.$("#settings-theme-grid .theme-card.is-active").dataset.mode, "light", "the grid reflects the restored theme");
  v2.close();
});

test("the Darcula family follows interface appearance across chrome and Review tokens", async () => {
  const v = await loadViewer(html);
  pickTheme(v, "darcula", "dark");
  await v.settle(20);

  assert.equal(v.document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(v.document.documentElement.getAttribute("data-syntax-theme"), "darcula");
  assert.equal(v.window.localStorage.getItem("kakapo-syntax-theme"), "darcula");
  assert.equal(
    v.window.getComputedStyle(v.document.documentElement).getPropertyValue("--token-keyword").trim().toLowerCase(),
    "#cc7832",
    "raw source and diff token classes receive the Darcula keyword color",
  );

  pickAppearance(v, "light");
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
  assert.equal(reopened.$("#settings-theme-grid .theme-card.is-active").dataset.family, "darcula");
  reopened.close();
});
