import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join } from "node:path";
import { cleanupFixtures, makeReviewHtml } from "./helpers/fixture.mjs";

const root = new URL("..", import.meta.url).pathname;
after(cleanupFixtures);

test("package, launcher, documentation, and source use the Kakapo identity exclusively", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "@happy-nut/kakapo");
  assert.deepEqual(pkg.bin, { kakapo: "bin/kakapo.js" });
  assert.equal(existsSync(join(root, "bin", "kakapo.js")), true);
  assert.equal(existsSync(join(root, "assets", "kakapo-core-flow.gif")), true);
  assert.equal(existsSync(join(root, "assets", "icon-ui-source.png")), true, "the isolated Kakapo glyph source is shipped");
  assert.equal(existsSync(join(root, "assets", "icon-ui.png")), true, "the UI derivative of the app icon is shipped");

  const legacyBrand = ["mona", "cori"].join("");
  const textExtensions = new Set(["", ".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ts", ".yml", ".yaml"]);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
  const offenders = [];
  for (const relative of tracked) {
    const file = join(root, relative);
    if (!existsSync(file) || !textExtensions.has(extname(relative))) continue;
    if (readFileSync(file, "utf8").toLowerCase().includes(legacyBrand)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], `legacy product identity remains in: ${offenders.join(", ")}`);
});

test("macOS app icon keeps a restrained inset and softened system-style corners", () => {
  const generator = readFileSync(join(root, "scripts", "gen-icon.mjs"), "utf8");
  const rounder = readFileSync(join(root, "scripts", "round-icon.swift"), "utf8");

  assert.match(generator, /roundedSource, "0\.15", "0\.98"/, "the tile is only slightly smaller and rounder");
  assert.match(rounder, /let scaledTile = NSRect/, "the mask follows the scaled tile instead of clipping the old bounds");
  assert.match(rounder, /sourceImage\.draw\(\s*in: drawRect/, "the whole icon scales together without changing the Kakapo glyph ratio");
});

test("visible product labels and wait states reuse the real Kakapo icon", async () => {
  const { renderNotGitRepoHtml, renderWelcomeHtml } = await import("../dist/render.js");
  for (const html of [renderNotGitRepoHtml("/tmp/project"), renderWelcomeHtml(false)]) {
    assert.match(html, /class="brand-mark"[^>]*role="img"[^>]*aria-label="Kakapo"/, "standalone screens show the icon as the accessible brand");
    assert.doesNotMatch(html, /class="badge">kakapo</i, "the old visible wordmark is gone");
  }

  const { html } = await makeReviewHtml([
    { path: "src/app.ts", before: "export const value = 1;\n", after: "export const value = 2;\n" },
  ], { app: true });
  assert.match(html, /id="boot-overlay"[^>]*>.*kakapo-loader-boot.*kakapo-mark/s, "review boot uses the animated parrot");
  assert.match(html, /class="app-version"[^>]*aria-label="Kakapo v[^\"]+"[^>]*>.*kakapo-mark/s, "footer wordmark is an icon plus version");
  assert.match(html, /class="settings-h settings-brand"[^>]*>.*kakapo-mark/s, "settings header reuses the same icon");
  assert.doesNotMatch(html, /class="app-version"[^>]*>\s*kakapo/i, "footer no longer paints the product name as text");
  assert.doesNotMatch(html, /class="settings-h">\s*kakapo/i, "settings no longer paints the product name as text");

  const css = readFileSync(join(root, "dist", "viewer.css"), "utf8");
  const viewer = readFileSync(join(root, "dist", "viewer.client.js"), "utf8");
  const main = readFileSync(join(root, "dist", "app-main.js"), "utf8");
  assert.match(css, /@keyframes kakapo-peck/, "the parrot has one shared activity animation");
  assert.match(css, /\.app-version \.kakapo-mark\s*\{\s*width:\s*28px;\s*height:\s*28px;/, "the compact footer still shows a legible parrot");
  assert.match(css, /\.settings-brand \.kakapo-mark\s*\{\s*width:\s*40px;\s*height:\s*40px;/, "panel branding does not collapse to an indistinct glyph");
  assert.match(css, /\.kakapo-loader-boot \.kakapo-mark\s*\{\s*width:\s*68px;\s*height:\s*68px;/, "the primary loading indicator remains visually prominent");
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*kakapo-breathe/, "loading remains accessible with reduced motion");
  assert.doesNotMatch(css, /\.boot-spinner|\.mc-spinner|@keyframes boot-spin/, "generic ring spinners are fully retired");
  assert.match(viewer, /function loadingStateHtml[\s\S]*kakapoLoaderHtml/, "dynamic loading surfaces share the parrot helper");
  assert.match(css, /data-context-loading="1"[\s\S]{0,300}var\(--kakapo-ui-icon\)/, "diff context hydration uses the same loading vocabulary");
  assert.match(main, /Kakapo is loading/, "the native first-paint screen exposes an accessible loading label");
});
