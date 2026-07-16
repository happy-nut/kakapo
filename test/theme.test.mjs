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
  assert.ok(v.$("#settings-theme"), "a theme selector is rendered in settings");
  assert.ok(v.$("#settings-syntax-theme"), "syntax highlighting has its own selector");
  v.$("#settings-syntax-theme").dispatchEvent(new v.window.MouseEvent("mouseover", { bubbles: true }));
  await v.settle(20);
  assert.ok(v.$("#mc-button-hint").classList.contains("hidden"), "custom dropdowns do not advertise a non-focused Enter action on hover");
  v.close();
});

test("application chrome uses a neutral high-contrast palette without replacing the code palette", async () => {
  const v = await loadViewer(html);
  const root = v.window.getComputedStyle(v.document.documentElement);
  assert.equal(root.getPropertyValue("--chrome-text").trim().toLowerCase(), "#f1f1f2");
  assert.equal(root.getPropertyValue("--chrome-border").trim().toLowerCase(), "#494b50");
  assert.equal(root.getPropertyValue("--chrome-selected").trim().toLowerCase(), "#3a3c40", "menu selection is neutral gray");
  assert.equal(root.getPropertyValue("--text").trim().toLowerCase(), "#d8e0eb", "code text keeps its quieter palette");
  assert.equal(root.getPropertyValue("--panel").trim().toLowerCase(), "#171b21", "code surfaces keep their original canvas");
  v.close();
});

// The theme/language pickers are now custom dropdowns (a button that opens .mc-dropdown), not native
// <select>s, so a pick is: click the trigger, then click the matching .mc-dropdown-item.
function pickOption(v, triggerId, match) {
  v.$(triggerId).click();
  const item = [...v.document.querySelectorAll(".mc-dropdown-item")].find((b) => match.test(b.textContent));
  assert.ok(item, `dropdown offers an option matching ${match}`);
  item.click();
}

test("switching to light flips data-theme on <html> and persists", async () => {
  const v = await loadViewer(html);
  pickOption(v, "#settings-theme", /light/i);
  await v.settle(20);

  assert.equal(v.document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(v.window.localStorage.getItem("monacori-theme"), "light");
  v.close();
});

test("the light theme is restored on reopen", async () => {
  const v1 = await loadViewer(html);
  pickOption(v1, "#settings-theme", /light/i);
  await v1.settle(20);
  const snapshot = v1.exportStorage();
  v1.close();

  const v2 = await loadViewer(html, { seedStorage: snapshot });
  assert.equal(
    v2.document.documentElement.getAttribute("data-theme"),
    "light",
    "data-theme is light on first paint after reopen",
  );
  assert.match(v2.$("#settings-theme").textContent, /light/i, "the trigger reflects the restored theme");
  v2.close();
});

test("the Darcula family follows interface appearance across chrome, tokens, and Monaco", async () => {
  const v = await loadViewer(html, { monacoBridge: true });
  pickOption(v, "#settings-syntax-theme", /darcula/i);
  await v.settle(20);

  assert.equal(v.document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(v.document.documentElement.getAttribute("data-syntax-theme"), "darcula");
  assert.equal(v.window.localStorage.getItem("monacori-syntax-theme"), "darcula");
  assert.equal(v.window.__monacoMock.theme, "monacori-darcula");
  assert.equal(v.window.__monacoMock.themes["monacori-darcula"].colors["editor.background"], "#2B2B2B");
  assert.equal(
    v.window.getComputedStyle(v.document.documentElement).getPropertyValue("--token-keyword").trim().toLowerCase(),
    "#cc7832",
    "raw source and diff token classes receive the Darcula keyword color",
  );

  pickOption(v, "#settings-theme", /light/i);
  await v.settle(20);
  assert.equal(v.window.__monacoMock.theme, "monacori-intellij-light");
  assert.equal(v.window.__monacoMock.themes["monacori-intellij-light"].colors["editor.background"], "#FFFFFF");
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
  assert.match(reopened.$("#settings-syntax-theme").textContent, /darcula/i);
  reopened.close();
});
