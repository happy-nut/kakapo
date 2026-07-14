import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const viewerAssetCache = new Map<string, string>();

// Client viewer script/stylesheet live in sibling files (copied to dist/ at build) so this
// module stays small and the client code can use template literals freely (no String.raw).
export function readViewerAsset(name: string): string {
  let cached = viewerAssetCache.get(name);
  if (cached === undefined) {
    cached = readFileSync(join(dirname(fileURLToPath(import.meta.url)), name), "utf8");
    viewerAssetCache.set(name, cached);
  }
  return cached;
}

export function diff2HtmlCss(): string {
  try {
    return readFileSync(nodeRequire.resolve("diff2html/bundles/css/diff2html.min.css"), "utf8");
  } catch {
    return "";
  }
}

export function diffCss(): string {
  return readViewerAsset("viewer.css");
}

export function diffScript(): string {
  // Prefer the minified bundle the build emits (smaller inlined <script>); fall back to the readable concat
  // when minify was skipped (e.g. terser unavailable).
  try {
    return readViewerAsset("viewer.client.min.js");
  } catch {
    return readViewerAsset("viewer.client.js");
  }
}
