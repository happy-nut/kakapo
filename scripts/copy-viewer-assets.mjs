// Builds the client viewer assets into dist/ after tsc (tsc only emits .ts output). The browser viewer is
// authored as ordered slices in src/viewer/*.js (numbered to preserve order) and CONCATENATED here into the
// single inlined script the renderer ships — concatenation only, so it stays one global scope, byte-for-byte
// the same as the old monolithic src/viewer.client.js. cli.ts reads these at runtime via readViewerAsset().
import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });

// Concatenate the numbered slices in order (01-, 02-, …). join("") — each slice already ends with its
// trailing newline, so the result is identical to the original single file (no extra separators added).
const viewerDir = join(root, "src", "viewer");
const parts = readdirSync(viewerDir).filter((f) => f.endsWith(".js")).sort();
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

// The rich Markdown editor is loaded lazily through Electron's narrow monacori-asset:// scheme. The
// directory keeps its historical name for protocol compatibility, but no code-editor runtime is shipped.
rmSync(join(distDir, "monaco"), { recursive: true, force: true });
mkdirSync(join(distDir, "monaco"), { recursive: true });
// The rich editor is needed only when the memo opens. Keep it out of the startup script and serve it from
// the narrow asset scheme so ordinary diff review pays no parse/evaluation cost.
writeFileSync(join(distDir, "monaco", "markdown-editor.js"), editorBundle);
console.log(`bundled ${parts.length} viewer slices -> dist/viewer.client.js (${bundle.length} bytes); copied viewer.css + lazy Markdown editor`);
