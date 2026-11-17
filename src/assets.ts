import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const nodeRequire = createRequire(import.meta.url);
const viewerAssetCache = new Map<string, string>();

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
  try {
    return readViewerAsset("viewer.client.min.js");
  } catch {
    return readViewerAsset("viewer.client.js");
  }
}

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
