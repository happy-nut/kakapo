#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("Kakapo's .icns generator currently requires macOS sips and iconutil.");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");
const source = join(assets, "icon-source.png");
const png = join(assets, "icon.png");
const icns = join(assets, "icon.icns");
const work = mkdtempSync(join(tmpdir(), "kakapo-icon-"));
const iconset = join(work, "Kakapo.iconset");

const variants = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

try {
  mkdirSync(iconset, { recursive: true });
  execFileSync("sips", ["-z", "1024", "1024", source, "--out", png], { stdio: "ignore" });
  for (const [name, size] of variants) {
    execFileSync("sips", ["-z", String(size), String(size), png, "--out", join(iconset, name)], { stdio: "ignore" });
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
  console.log("wrote assets/icon.png and assets/icon.icns from assets/icon-source.png");
} finally {
  rmSync(work, { recursive: true, force: true });
}
