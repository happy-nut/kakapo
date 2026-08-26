#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("Kakapo's .icns generator currently requires macOS sips and iconutil.");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");
const source = join(assets, "icon-source.png");
const uiSource = join(assets, "icon-ui-source.png");
const png = join(assets, "icon.png");
const uiPng = join(assets, "icon-ui.png");
const icns = join(assets, "icon.icns");
const ico = join(assets, "icon.ico");
const work = mkdtempSync(join(tmpdir(), "kakapo-icon-"));
const iconset = join(work, "Kakapo.iconset");
const roundedSource = join(work, "icon-source-rounded.png");

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
  // Give the tile a little more macOS-style breathing room and corner softness without making the
  // Kakapo artwork feel undersized. The scale affects the whole tile; the glyph-to-tile ratio stays intact.
  execFileSync("swift", [join(root, "scripts", "round-icon.swift"), source, roundedSource, "0.15", "0.98"], { stdio: "ignore" });
  execFileSync("sips", ["-z", "1024", "1024", roundedSource, "--out", png], { stdio: "ignore" });
  // The full macOS icon keeps its charcoal squircle, while in-app branding uses the isolated Kakapo
  // glyph. Keeping separate sources prevents a future app-icon regeneration from restoring the tiny
  // dark tile inside footers, settings, and loading indicators.
  execFileSync("sips", ["-z", "96", "96", uiSource, "--out", uiPng], { stdio: "ignore" });
  for (const [name, size] of variants) {
    execFileSync("sips", ["-z", String(size), String(size), png, "--out", join(iconset, name)], { stdio: "ignore" });
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icns]);
  writeFileSync(ico, buildIco([16, 24, 32, 48, 64, 128, 256].map((size) => {
    const out = join(work, `ico-${size}.png`);
    execFileSync("sips", ["-z", String(size), String(size), png, "--out", out], { stdio: "ignore" });
    return { size, data: readFileSync(out) };
  })));
  console.log("wrote assets/icon.png, assets/icon-ui.png, assets/icon.icns, and assets/icon.ico from assets/icon-source.png");
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Windows .ico container with PNG-compressed entries (supported since Vista, accepted by rcedit).
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // 0 means 256
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map(({ data }) => data)]);
}
