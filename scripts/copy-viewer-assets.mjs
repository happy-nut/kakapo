// Builds the client viewer assets into dist/ after tsc (tsc only emits .ts output). The browser viewer is
// authored as ordered slices in src/viewer/*.js (numbered to preserve order) and CONCATENATED here into the
// single inlined script the renderer ships — concatenation only, so it stays one global scope, byte-for-byte
// the same as the old monolithic src/viewer.client.js. cli.ts reads these at runtime via readViewerAsset().
import { readdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
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

// Monaco loads lazily from Electron's privileged monacori-asset:// scheme. Copy only the production `min`
// runtime into dist: monaco-editor stays a development dependency, so installed users receive the 15MB
// runtime assets without also installing the 73MB source package.
const monacoSource = join(root, "node_modules", "monaco-editor", "min", "vs");
const monacoTarget = join(distDir, "monaco", "vs");
rmSync(join(distDir, "monaco"), { recursive: true, force: true });
cpSync(monacoSource, monacoTarget, { recursive: true });

// Monaco 0.55.1 vendors a vulnerable DOMPurify release directly inside its prebuilt editor.api bundle. Updating the
// package dependency alone does not update those inlined bytes, so an apparently clean `npm audit` would
// still ship the vulnerable sanitizer. Replace that one self-contained module with the audited DOMPurify
// source installed at the root. This is deliberately fail-closed: a changed Monaco bundle layout must stop
// the build instead of silently restoring the vulnerable runtime.
async function patchMonacoSanitizer() {
  const purifySource = readFileSync(join(root, "node_modules", "dompurify", "dist", "purify.es.mjs"), "utf8");
  const exportMatch = purifySource.match(/\nexport\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\};?/);
  if (!exportMatch || exportMatch.index === undefined) {
    throw new Error("Unable to locate DOMPurify's default export");
  }
  const purifyBody = purifySource.slice(0, exportMatch.index);
  const purifyVersion = JSON.parse(readFileSync(join(root, "node_modules", "dompurify", "package.json"), "utf8")).version;
  const { minify } = await import("terser");
  let patched = 0;

  for (const entry of readdirSync(monacoTarget, { withFileTypes: true })) {
    if (!entry.isFile() || !/^editor\.api.*\.js$/.test(entry.name)) continue;
    const targetPath = join(monacoTarget, entry.name);
    const runtime = readFileSync(targetPath, "utf8");
    const start = runtime.indexOf("/*! @license DOMPurify");
    if (start < 0) continue;

    const vulnerableChunk = runtime.slice(start);
    const factoryMatch = vulnerableChunk.match(/function\s+([A-Za-z_$][\w$]*)\(\)\{let\s+[A-Za-z_$][\w$]*=arguments\.length>0/);
    if (!factoryMatch) throw new Error(`Unable to locate Monaco's DOMPurify factory in ${entry.name}`);
    const escapedFactory = factoryMatch[1].replace(/[$]/g, "\\$&");
    const assignmentPattern = new RegExp(`(?:var|const|let)\\s+([A-Za-z_$][\\w$]*)=${escapedFactory}\\(\\);`);
    const assignmentMatch = vulnerableChunk.match(assignmentPattern);
    if (!assignmentMatch || assignmentMatch.index === undefined) {
      throw new Error(`Unable to locate Monaco's DOMPurify assignment in ${entry.name}`);
    }

    const replacementSource = `var ${assignmentMatch[1]}=(function(){${purifyBody}\nreturn ${exportMatch[1]};})();`;
    const replacement = await minify(replacementSource, {
      compress: true,
      mangle: { toplevel: false },
      format: { comments: /@license/ },
    });
    if (!replacement.code || !replacement.code.includes(`DOMPurify ${purifyVersion}`)) {
      throw new Error(`Failed to build audited DOMPurify ${purifyVersion} for ${entry.name}`);
    }

    const end = start + assignmentMatch.index + assignmentMatch[0].length;
    const securedRuntime = runtime.slice(0, start) + replacement.code + runtime.slice(end);
    const embeddedVersions = Array.from(securedRuntime.matchAll(/DOMPurify ([0-9.]+)/g), (match) => match[1]);
    if (embeddedVersions.length === 0 || embeddedVersions.some((version) => version !== purifyVersion)) {
      throw new Error(`Monaco runtime still contains an unexpected DOMPurify version: ${embeddedVersions.join(", ")}`);
    }
    writeFileSync(targetPath, securedRuntime);
    patched += 1;
  }

  if (patched === 0) throw new Error("No Monaco DOMPurify runtime was patched");
  return { patched, purifyVersion };
}

const securedMonaco = await patchMonacoSanitizer();
console.log(`bundled ${parts.length} viewer slices -> dist/viewer.client.js (${bundle.length} bytes); copied viewer.css + Monaco runtime; secured ${securedMonaco.patched} Monaco bundle with DOMPurify ${securedMonaco.purifyVersion}`);
