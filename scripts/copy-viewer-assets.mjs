// Builds the client viewer assets into dist/ after tsc (tsc only emits .ts output). The browser viewer is
// authored as ordered slices in src/viewer/*.js (numbered to preserve order) and CONCATENATED here into the
// single inlined script the renderer ships — concatenation only, so it stays one global scope, byte-for-byte
// the same as the former single-file viewer bundle. cli.ts reads these at runtime via readViewerAsset().
import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });

// Concatenate the numbered slices in order (01-, 02-, …). join("") — each slice already ends with its
// trailing newline, so the result is identical to the original single file (no extra separators added).
const viewerDir = join(root, "src", "viewer");
// Explicit load order (was readdirSync().sort()). Order matters for the slices with top-level executable
// statements (e.g. 05-keymap's init block runs on load); making it explicit removes the same-numeric-prefix
// lexicographic-tie fragility and lets a new slice be placed precisely. The check below fails the build
// loudly if a slice is added/removed without updating this list — instead of silently mis-ordering.
const VIEWER_SLICES = [
  "00-util.js", "00-diff-layers.js", "01-core.js", "01-diff-alignment.js", "01-diff-model.js", "02-diff-nav.js",
  "03-quick-open.js", "04-source-tree.js", "05-keymap.js", "06-diff-caret.js", "07-comments.js",
  "08-dock.js", "09-views-update.js", "10-source-view.js", "11-render-http.js", "12-history.js",
  "13-goto.js", "14-impact.js", "15-analysis-status.js", "15-semantic-navigation.js", "16-semantic-peek.js",
  "17-file-find.js", "18-diagnostics.js", "19-terminal.js", "20-mermaid.js",
  "22-patchset.js", "23-annotations.js", "24-prompt-palette.js",
];
const onDisk = readdirSync(viewerDir).filter((f) => f.endsWith(".js")).sort();
const listed = [...VIEWER_SLICES].sort();
if (onDisk.length !== listed.length || onDisk.some((f, i) => f !== listed[i])) {
  throw new Error(`VIEWER_SLICES is out of sync with src/viewer/*.js — update scripts/copy-viewer-assets.mjs.\n  on disk: ${onDisk.join(", ")}\n  listed:  ${listed.join(", ")}`);
}
const parts = VIEWER_SLICES;
// One audited read-only Markdown stack is embedded ahead of the app slices, so source previews and merged
// prompts execute the exact same parser + sanitizer in Electron and static/browser reviews.
const markdownVendors = [
  join(root, "node_modules", "markdown-it", "dist", "markdown-it.min.js"),
  join(root, "node_modules", "dompurify", "dist", "purify.min.js"),
];
// Tiptap provides the Notion-style, single-surface Markdown editor used by the worktree memo. Bundle its
// ESM graph into the same browser script; dependencies remain development-only and are pruned from the app.
const editorBuild = await build({
  entryPoints: [join(root, "scripts", "markdown-editor-entry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: true,
  legalComments: "inline",
});
const editorBundle = editorBuild.outputFiles[0]?.text;
if (!editorBundle) throw new Error("Failed to bundle the inline Markdown editor");
const vendorBundle = markdownVendors.map((file) => readFileSync(file, "utf8") + "\n").join("");
const bundle = vendorBundle + parts.map((f) => readFileSync(join(viewerDir, f), "utf8")).join("");
writeFileSync(join(distDir, "viewer.client.js"), bundle); // readable concat — tests + debugging read this

// Runtime ships a MINIFIED bundle (smaller inlined <script> -> faster parse). mangle.toplevel:false keeps
// top-level/global names — the page + tests reference them via window.*, and the inline functions call each
// other by name in one shared scope. Best-effort: without terser the build still succeeds and diffScript()
// falls back to the readable concat.
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

// The rich Markdown editor is loaded lazily through Electron's narrow kakapo-asset:// scheme. The
// directory keeps its historical name for protocol compatibility, but no code-editor runtime is shipped.
rmSync(join(distDir, "monaco"), { recursive: true, force: true });
mkdirSync(join(distDir, "monaco"), { recursive: true });
// The rich editor is needed only when the memo opens. Keep it out of the startup script and serve it from
// the narrow asset scheme so ordinary diff review pays no parse/evaluation cost.
writeFileSync(join(distDir, "monaco", "markdown-editor.js"), editorBundle);
// Mermaid renders the Explain view's context/swimlane/flowchart diagrams (proper graph layout instead of a
// hand-rolled one — see 20-explain.js's loadMermaid). It's several MB even minified, so it rides the same
// lazy kakapo-asset:// path as the Markdown editor: fetched only the first time an Explain doc actually
// contains one of those diagram kinds, never part of the eagerly-parsed startup script.
copyFileSync(join(root, "node_modules", "mermaid", "dist", "mermaid.min.js"), join(distDir, "monaco", "mermaid.js"));
// The Electron review references the client as an external kakapo-asset:// script (render.ts diffClientAsset)
// instead of inlining ~514KB into every window; the handler serves this dir, so mirror the client here too.
for (const client of ["viewer.client.min.js", "viewer.client.js"]) {
  const from = join(distDir, client);
  if (existsSync(from)) copyFileSync(from, join(distDir, "monaco", client));
}
console.log(`bundled ${parts.length} viewer slices -> dist/viewer.client.js (${bundle.length} bytes); copied viewer.css + lazy Markdown editor + lazy Mermaid`);
