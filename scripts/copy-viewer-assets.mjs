// Builds the client viewer assets into dist/ after tsc (tsc only emits .ts output). The browser viewer is
// authored as ordered slices in src/viewer/*.js (numbered to preserve order) and CONCATENATED here into the
// single inlined script the renderer ships — concatenation only, so it stays one global scope, byte-for-byte
// the same as the old monolithic src/viewer.client.js. cli.ts reads these at runtime via readViewerAsset().
import { readdirSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });

// Concatenate the numbered slices in order (01-, 02-, …). join("") — each slice already ends with its
// trailing newline, so the result is identical to the original single file (no extra separators added).
const viewerDir = join(root, "src", "viewer");
const parts = readdirSync(viewerDir).filter((f) => f.endsWith(".js")).sort();
const bundle = parts.map((f) => readFileSync(join(viewerDir, f), "utf8")).join("");
writeFileSync(join(distDir, "viewer.client.js"), bundle); // readable concat — tests + debugging read this

// Runtime ships a MINIFIED bundle (smaller inlined <script> -> faster parse). mangle.toplevel:false keeps
// top-level/global names — the page + tests reference them via window.*, and the inline functions call each
// other by name in one shared scope. Best-effort: without terser the build still succeeds and diffScript()
// falls back to the readable concat.
try {
  const { minify } = await import("terser");
  const out = await minify(bundle, { compress: true, mangle: { toplevel: false }, format: { comments: false } });
  if (out.code) {
    writeFileSync(join(distDir, "viewer.client.min.js"), out.code);
    console.log(`minified viewer.client.js: ${bundle.length} -> ${out.code.length} chars`);
  }
} catch (e) {
  console.warn("terser minify skipped (runtime falls back to readable concat):", e.message);
}

copyFileSync(join(root, "src", "viewer.css"), join(distDir, "viewer.css"));
console.log(`bundled ${parts.length} viewer slices -> dist/viewer.client.js (${bundle.length} bytes); copied viewer.css`);
