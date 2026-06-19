// Generates assets/icon.png (1024x1024) for the monacori desktop app.
// No external image tooling required — encodes the PNG directly with zlib.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = 1024;
const H = 1024;
const buf = Buffer.alloc(W * H * 4);

function blend(x, y, r, g, b, a) {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  const i = (y * W + x) * 4;
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

// Rounded-rect background with a vertical blue gradient (Darcula-friendly accent).
const MARGIN = 48;
const RADIUS = 210;
for (let y = MARGIN; y < H - MARGIN; y++) {
  for (let x = MARGIN; x < W - MARGIN; x++) {
    let dx = 0;
    let dy = 0;
    if (x < MARGIN + RADIUS && y < MARGIN + RADIUS) { dx = MARGIN + RADIUS - x; dy = MARGIN + RADIUS - y; }
    else if (x >= W - MARGIN - RADIUS && y < MARGIN + RADIUS) { dx = x - (W - MARGIN - RADIUS - 1); dy = MARGIN + RADIUS - y; }
    else if (x < MARGIN + RADIUS && y >= H - MARGIN - RADIUS) { dx = MARGIN + RADIUS - x; dy = y - (H - MARGIN - RADIUS - 1); }
    else if (x >= W - MARGIN - RADIUS && y >= H - MARGIN - RADIUS) { dx = x - (W - MARGIN - RADIUS - 1); dy = y - (H - MARGIN - RADIUS - 1); }
    let aa = 1;
    if (dx > 0 && dy > 0) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > RADIUS) continue;
      aa = Math.max(0, Math.min(1, RADIUS - d + 0.5));
    }
    const t = (y - MARGIN) / (H - 2 * MARGIN);
    const r = Math.round(0x53 + (0x2c - 0x53) * t);
    const g = Math.round(0x96 + (0x5a - 0x96) * t);
    const b = Math.round(0xd8 + (0x8a - 0xd8) * t);
    blend(x, y, r, g, b, Math.round(255 * aa));
  }
}

// White "M" monogram built from four thick strokes.
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
const THICK = 78;
const segs = [
  [352, 690, 352, 360],
  [352, 360, 512, 566],
  [512, 566, 672, 360],
  [672, 360, 672, 690],
];
for (let y = 320; y <= 730; y++) {
  for (let x = 312; x <= 712; x++) {
    let dmin = 1e9;
    for (const s of segs) {
      const d = distSeg(x, y, s[0], s[1], s[2], s[3]);
      if (d < dmin) dmin = d;
    }
    const aa = Math.max(0, Math.min(1, THICK / 2 - dmin + 0.5));
    if (aa > 0) blend(x, y, 255, 255, 255, Math.round(255 * aa));
  }
}

// Minimal PNG encoder (truecolor + alpha, single IDAT).
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter: none
  buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "icon.png"), png);
console.log("wrote assets/icon.png:", png.length, "bytes");
