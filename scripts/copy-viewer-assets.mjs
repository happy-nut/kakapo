import { readdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });

const viewerDir = join(root, "src", "viewer");
const VIEWER_SLICES = [
  "00-util.js", "00-minuscule.js", "00-diff-layers.js", "00-shortcuts.js", "01-core.js", "01-diff-alignment.js", "01-diff-model.js", "02-diff-nav.js",
  "03-quick-open.js", "04-source-tree.js", "05-keymap.js", "06-diff-caret.js", "07-comments.js",
  "08-dock.js", "09-views-update.js", "10-source-view.js", "11-http-parse.js", "11-http-script.js",
  "11-http-run.js", "11-render-http.js", "12-history.js",
  "13-goto.js", "14-project-layout.js", "15-analysis-status.js", "15-semantic-navigation.js", "16-semantic-peek.js",
  "16-structure.js", "16-reading-modes.js", "17-file-find.js", "17-find-usages.js", "18-diagnostics.js", "18-code-insight.js", "19-find-action.js", "19-diff-stripe.js", "20-mermaid.js", "21-compare-menu.js",
  "22-patchset.js", "23-agent-cards.js", "24-search-everywhere.js", "26-endpoints.js", "28-shortcut-coach.js", "29-shortcut-rebind.js",
];
const onDisk = readdirSync(viewerDir).filter((f) => f.endsWith(".js")).sort();
const listed = [...VIEWER_SLICES].sort();
if (onDisk.length !== listed.length || onDisk.some((f, i) => f !== listed[i])) {
  throw new Error(`VIEWER_SLICES is out of sync with src/viewer/*.js — update scripts/copy-viewer-assets.mjs.\n  on disk: ${onDisk.join(", ")}\n  listed:  ${listed.join(", ")}`);
}
const parts = VIEWER_SLICES;
const markdownVendors = [
  join(root, "node_modules", "markdown-it", "dist", "markdown-it.min.js"),
  join(root, "node_modules", "dompurify", "dist", "purify.min.js"),
];
const vendorBundle = markdownVendors.map((file) => readFileSync(file, "utf8") + "\n").join("");
const { SHORTCUTS: shortcutDefs, MENU_OWNED_CHORDS: menuOwnedChords, MENU_OWNED_CHORDS_MAC: menuOwnedMac,
  MODAL_SURFACES: modalSurfaces } =
  createRequire(import.meta.url)(join(distDir, "shortcuts.js"));
if (!Array.isArray(modalSurfaces) || !modalSurfaces.length) throw new Error("dist/shortcuts.js exported no MODAL_SURFACES — did tsc run?");
if (!Array.isArray(shortcutDefs) || !shortcutDefs.length) throw new Error("dist/shortcuts.js exported no SHORTCUTS — did tsc run?");
if (!Array.isArray(menuOwnedChords) || !menuOwnedChords.length) throw new Error("dist/shortcuts.js exported no MENU_OWNED_CHORDS — did tsc run?");
const shortcutPrelude = `var SHORTCUT_DEFS = ${JSON.stringify(shortcutDefs)};\n`
  + `var MODAL_SURFACES = ${JSON.stringify(modalSurfaces)};\n`
  + `var MENU_OWNED_CHORDS = ${JSON.stringify(menuOwnedChords)}`
  + `.concat(/Electron/.test(navigator.userAgent) && /Mac|iPhone|iPad/.test(navigator.userAgent)`
  + ` ? ${JSON.stringify(menuOwnedMac)} : []);\n`;
const { markWhitespaceRuns, moduleEntryFor } = createRequire(import.meta.url)(join(distDir, "util.js"));
if (typeof markWhitespaceRuns !== "function") throw new Error("dist/util.js exported no markWhitespaceRuns — did tsc run?");
if (typeof moduleEntryFor !== "function") throw new Error("dist/util.js exported no moduleEntryFor — did tsc run?");
const whitespacePrelude = `var markWhitespaceRuns = ${markWhitespaceRuns.toString()};\n`
  + `var moduleEntryFor = ${moduleEntryFor.toString()};\n`;
const bundle = vendorBundle + shortcutPrelude + whitespacePrelude + parts.map((f) => readFileSync(join(viewerDir, f), "utf8")).join("");
writeFileSync(join(distDir, "viewer.client.js"), bundle);

try {
  const { minify } = await import("terser");
  const out = await minify(bundle, { compress: true, mangle: { toplevel: false }, format: { comments: /@license|^!/ } });
  if (out.code) {
    writeFileSync(join(distDir, "viewer.client.min.js"), out.code);
    console.log(`minified viewer.client.js: ${bundle.length} -> ${out.code.length} chars`);
  }
} catch (e) {
  console.warn("terser minify skipped (runtime falls back to readable concat):", e.message);
}

copyFileSync(join(root, "src", "viewer.css"), join(distDir, "viewer.css"));

rmSync(join(distDir, "monaco"), { recursive: true, force: true });
mkdirSync(join(distDir, "monaco"), { recursive: true });
copyFileSync(join(root, "node_modules", "mermaid", "dist", "mermaid.min.js"), join(distDir, "monaco", "mermaid.js"));
for (const client of ["viewer.client.min.js", "viewer.client.js"]) {
  const from = join(distDir, client);
  if (existsSync(from)) copyFileSync(from, join(distDir, "monaco", client));
}
console.log(`bundled ${parts.length} viewer slices -> dist/viewer.client.js (${bundle.length} bytes); copied viewer.css + lazy Mermaid`);
