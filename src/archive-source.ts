import { readFileSync, statSync } from "node:fs";
import { inflateRawSync, inflateSync } from "node:zlib";

export type ArchiveEntry = {
  archive: string;
  entry: string;
  bytes: Buffer;
  mtimeMs: number;
};

const HALT = "__HALT_COMPILER();";
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const ENTRY_DEFLATED = 0x1000;
const ENTRY_BZIP2 = 0x2000;
/** filename length, size, timestamp, compressed size, crc32, flags, metadata length. */
const ENTRY_FIXED_BYTES = 24;

export function splitArchivePath(path: string): { archive: string; entry: string } | null {
  const slashed = String(path || "").replace(/\\/g, "/");
  const phar = slashed.toLowerCase().lastIndexOf(".phar/");
  if (phar >= 0) {
    const entry = slashed.slice(phar + ".phar/".length);
    return entry ? { archive: slashed.slice(0, phar + ".phar".length), entry } : null;
  }
  // The Kotlin server answers a library definition with `jar:///…/spring-batch-core-5.1.2.jar!/org/…/
  // RunIdIncrementer.class`, so the separator is the jar URI's `!/` rather than a directory boundary.
  const bang = slashed.indexOf("!/");
  if (bang < 0) return null;
  const archive = slashed.slice(0, bang);
  const entry = slashed.slice(bang + 2);
  return entry && /\.(jar|zip)$/i.test(archive) ? { archive, entry } : null;
}

export function readArchiveEntry(path: string, maxEntryBytes: number): ArchiveEntry | null {
  const split = splitArchivePath(path);
  if (!split) return null;
  let stats: ReturnType<typeof statSync>;
  try { stats = statSync(split.archive); } catch { return null; }
  if (!stats.isFile() || stats.size > MAX_ARCHIVE_BYTES) return null;
  try {
    const buf = readFileSync(split.archive);
    const bytes = /\.phar$/i.test(split.archive)
      ? pharEntry(buf, split.entry, maxEntryBytes)
      : zipEntry(buf, split.entry, maxEntryBytes);
    return bytes ? { ...split, bytes, mtimeMs: stats.mtimeMs } : null;
  } catch {
    return null;
  }
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_DEFLATED = 8;

function zipEntry(buf: Buffer, want: string, maxEntryBytes: number): Buffer | null {
  const floor = Math.max(0, buf.length - 66_000);
  let end = -1;
  for (let at = buf.length - 22; at >= floor; at -= 1) {
    if (buf.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) { end = at; break; }
  }
  if (end < 0) return null;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_FILE_HEADER) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    if (name === want) {
      if (size > maxEntryBytes || localOffset + 30 > buf.length) return null;
      // The local header repeats the name and carries its own extra field, whose length is the only thing
      // that says where the bytes start — the central directory's extra length is a different number.
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      if (start + compressedSize > buf.length) return null;
      const raw = buf.subarray(start, start + compressedSize);
      if (method === 0) return raw.length === size ? Buffer.from(raw) : null;
      if (method !== ZIP_DEFLATED) return null;
      try {
        const out = inflateRawSync(raw);
        return out.length === size ? out : null;
      } catch {
        return null;
      }
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function pharEntry(buf: Buffer, want: string, maxEntryBytes: number): Buffer | null {
  const halt = buf.indexOf(HALT);
  if (halt < 0) return null;
  let p = halt + HALT.length;
  while (p < buf.length && (buf[p] === 0x20 || buf[p] === 0x3f || buf[p] === 0x3e || buf[p] === 0x0d || buf[p] === 0x0a)) p++;
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  const skipBlob = () => { const length = u32(); p += length; };
  const manifestLength = u32();
  const manifestEnd = p + manifestLength;
  if (manifestLength <= 0 || manifestEnd > buf.length) return null;
  const count = u32();
  p += 2;
  p += 4;
  skipBlob();
  skipBlob();
  // Entry bytes follow the manifest in manifest order, so an entry's offset is the sum of every COMPRESSED
  // size declared before it. That is why the walk runs from the start rather than seeking: the manifest is
  // the only index there is.
  let offset = manifestEnd;
  for (let i = 0; i < count; i++) {
    if (p + 4 > manifestEnd) return null;
    const nameLength = u32();
    if (nameLength > manifestEnd - p) return null;
    const name = buf.subarray(p, p + nameLength).toString("utf8");
    p += nameLength;
    if (p + ENTRY_FIXED_BYTES > manifestEnd) return null;
    const size = u32();
    p += 4;
    const compressedSize = u32();
    p += 4;
    const flags = u32();
    skipBlob();
    if (p > manifestEnd) return null;
    if (offset + compressedSize > buf.length) return null;
    if (name === want) {
      if (size > maxEntryBytes) return null;
      return inflateEntry(buf.subarray(offset, offset + compressedSize), flags, size);
    }
    offset += compressedSize;
  }
  return null;
}

function inflateEntry(raw: Buffer, flags: number, size: number): Buffer | null {
  let out: Buffer;
  if (flags & ENTRY_BZIP2) return null;
  if (flags & ENTRY_DEFLATED) {
    try { out = inflateRawSync(raw); } catch { out = inflateSync(raw); }
  } else {
    out = Buffer.from(raw);
  }
  return out.length === size ? out : null;
}
