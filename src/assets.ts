import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

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

// xterm.js (terminal renderer) for the integrated terminal panel. UMD bundles that expose
// window.Terminal + window.FitAddon + window.WebLinksAddon when inlined. Resolved from node_modules like
// diff2HtmlCss(); pure JS, no native binding — the pty itself lives in the main process via node-pty.
export function xtermCss(): string {
  try {
    return readFileSync(nodeRequire.resolve("@xterm/xterm/css/xterm.css"), "utf8");
  } catch {
    return "";
  }
}

export function xtermScript(): string {
  try {
    const core = readFileSync(nodeRequire.resolve("@xterm/xterm/lib/xterm.js"), "utf8");
    const fit = readFileSync(nodeRequire.resolve("@xterm/addon-fit/lib/addon-fit.js"), "utf8");
    // Link detection is the addon's job, not a regex of ours: it has to survive xterm's wrapped lines and
    // reflow, which is exactly where a hand-rolled scan gets a URL wrong. Read separately: without a shell
    // there is no terminal at all, but without clickable links there is still a terminal — and the renderer
    // already skips the addon when the global is missing (loadWebLinks), so match that here.
    let webLinks = "";
    try {
      webLinks = readFileSync(nodeRequire.resolve("@xterm/addon-web-links/lib/addon-web-links.js"), "utf8");
    } catch { /* links are a nicety; the terminal is not */ }
    return core + "\n" + fit + (webLinks ? "\n" + webLinks : "");
  } catch {
    return "";
  }
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

// The Electron app references the client as an EXTERNAL kakapo-asset:// script instead of inlining ~514KB
// into every review window's HTML (render.ts) — the doc gets ~40% smaller and Chromium parses/caches the
// client once across windows. The kakapo-asset handler serves immutable-cached assets, so the URL carries a
// content hash to bust the cache when the client changes. Computed once (the client is fixed per process).
let clientAssetCache: { file: string; version: string } | undefined;
export function diffClientAsset(): { file: string; version: string } {
  if (!clientAssetCache) {
    const dir = dirname(fileURLToPath(import.meta.url));
    const file = existsSync(join(dir, "viewer.client.min.js")) ? "viewer.client.min.js" : "viewer.client.js";
    const version = createHash("sha1").update(readFileSync(join(dir, file))).digest("hex").slice(0, 12);
    clientAssetCache = { file, version };
  }
  return clientAssetCache;
}
