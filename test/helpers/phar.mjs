import { deflateRawSync } from "node:zlib";

export const PHAR_STUB = "#!/usr/bin/env php\n<?php /* a box stub */ __HALT_COMPILER(); ?>\r\n";

export function buildPhar(entries, { manifestLength, signature = Buffer.alloc(0) } = {}) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const bodies = [];
  const records = [];
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const stored = e.bzip2 ? data : e.deflate ? deflateRawSync(data) : data;
    bodies.push(stored);
    const name = Buffer.from(e.name, "utf8");
    records.push(Buffer.concat([
      u32(name.length), name,
      u32(e.declaredSize ?? data.length),
      u32(0),
      u32(stored.length),
      u32(0),
      u32(e.bzip2 ? 0x2000 : e.deflate ? 0x1000 : 0),
      u32(0),
    ]));
  }
  const manifest = Buffer.concat([u32(entries.length), u16(0x1100), u32(0), u32(0), u32(0), ...records]);
  return Buffer.concat([
    Buffer.from(PHAR_STUB, "utf8"),
    u32(manifestLength ?? manifest.length),
    manifest,
    ...bodies,
    signature,
  ]);
}
