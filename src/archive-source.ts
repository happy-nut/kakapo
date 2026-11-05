import { readFileSync, statSync } from "node:fs";
import { inflateRawSync, inflateSync } from "node:zlib";

/**
 * An entry read out of an archive a language server pointed a definition at.
 *
 * Only the Phar format is read, because it is the only archive a server here has named something inside.
 * A `.phar` is not a zip: it is a PHP stub ending in `__HALT_COMPILER();`, then a manifest of fixed-order
 * little-endian records, then every entry's bytes back to back in manifest order, then a signature.
 * Phpactor ships PhpStorm's stubs inside its own phar, so `textDocument/definition` on `date()` in any PHP
 * project answers `…/phpactor.phar/vendor/jetbrains/phpstorm-stubs/date/date_c.php` — a path to real source
 * that `existsSync` is right to say nothing about, and that used to end the navigation.
 *
 * The other two shapes a server has handed us stay unreadable, and deliberately:
 *   - `…/jbr/Contents/Home!/java.base/java/time/Instant.class` (Kotlin) is an entry in a JDK jimage.
 *     Reading it needs a jimage parser AND a bytecode decompiler; the vendored JBR ships neither — no
 *     `src.zip`, no `jimage`/`javap` in its `bin`, no FernFlower in any bundled jar. Java only works
 *     because jdtls answers `java/classFileContents` with decompiled text of its own.
 *   - `https://github.com/sorbet/…/json.rbi#L194` (Sorbet) is not a path at all. The viewer hands that one
 *     to the browser instead.
 *
 * ponytail: phar only. A `guava.jar!/com/…/Joiner.class` is a zip and would be ~30 lines more here, but no
 * server in this app has yet produced one — add that branch when one does.
 */
export type ArchiveEntry = {
  /** The archive as it exists on disk. */
  archive: string;
  /** The entry's name inside it. */
  entry: string;
  bytes: Buffer;
  /** The ARCHIVE's mtime — an entry carries its own timestamp, but the file that can change is the archive. */
  mtimeMs: number;
};

const HALT = "__HALT_COMPILER();";
/** The archive is read whole, so the bound belongs here. phpactor.phar is 4 MB; nothing legitimate is near this. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const ENTRY_DEFLATED = 0x1000;
const ENTRY_BZIP2 = 0x2000;
/** filename length, size, timestamp, compressed size, crc32, flags, metadata length. */
const ENTRY_FIXED_BYTES = 24;

/** `…/x.phar/a/b.php` -> the archive and the entry inside it; null when the path names no archive. */
export function splitArchivePath(path: string): { archive: string; entry: string } | null {
  const slashed = String(path || "").replace(/\\/g, "/");
  const at = slashed.toLowerCase().lastIndexOf(".phar/");
  if (at < 0) return null;
  const entry = slashed.slice(at + ".phar/".length);
  return entry ? { archive: slashed.slice(0, at + ".phar".length), entry } : null;
}

/** The bytes of one entry, or null for anything this cannot read. Never throws. */
export function readArchiveEntry(path: string, maxEntryBytes: number): ArchiveEntry | null {
  const split = splitArchivePath(path);
  if (!split) return null;
  let stats: ReturnType<typeof statSync>;
  try { stats = statSync(split.archive); } catch { return null; }
  if (!stats.isFile() || stats.size > MAX_ARCHIVE_BYTES) return null;
  try {
    const bytes = pharEntry(readFileSync(split.archive), split.entry, maxEntryBytes);
    return bytes ? { ...split, bytes, mtimeMs: stats.mtimeMs } : null;
  } catch {
    // A truncated, hand-edited or simply not-a-phar file reads past its own end. The walk below bounds
    // every read against the manifest it declared, so what lands here is a file whose shape we misread —
    // and a misread archive must come back as "no" rather than as convincing garbage in the source view.
    return null;
  }
}

function pharEntry(buf: Buffer, want: string, maxEntryBytes: number): Buffer | null {
  const halt = buf.indexOf(HALT);
  if (halt < 0) return null;
  let p = halt + HALT.length;
  // PHP accepts ` ?>` and either newline after the halt, or nothing at all, so skip whatever is there.
  while (p < buf.length && (buf[p] === 0x20 || buf[p] === 0x3f || buf[p] === 0x3e || buf[p] === 0x0d || buf[p] === 0x0a)) p++;
  const u32 = () => { const v = buf.readUInt32LE(p); p += 4; return v; };
  // `p += u32()` would be wrong and silently so: `+=` reads p BEFORE evaluating the right side, so the four
  // bytes u32() just consumed get overwritten by the old p plus the length. Two statements, on purpose.
  const skipBlob = () => { const length = u32(); p += length; };
  const manifestLength = u32();
  const manifestEnd = p + manifestLength;
  if (manifestLength <= 0 || manifestEnd > buf.length) return null;
  const count = u32();
  p += 2;      // api version
  p += 4;      // global flags
  skipBlob();  // alias
  skipBlob();  // metadata
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
    p += 4;                 // timestamp
    const compressedSize = u32();
    p += 4;                 // crc32
    const flags = u32();
    skipBlob();             // per-entry metadata
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
  if (flags & ENTRY_BZIP2) return null; // no bzip2 in Node's stdlib, and one stub is not worth a dependency
  if (flags & ENTRY_DEFLATED) {
    // PHP writes raw deflate here. The zlib-wrapped fallback is for archives written by something else.
    try { out = inflateRawSync(raw); } catch { out = inflateSync(raw); }
  } else {
    out = Buffer.from(raw);
  }
  // The manifest states the uncompressed length, so a mismatch means the walk landed somewhere else than
  // it thinks. Refuse rather than paint it.
  return out.length === size ? out : null;
}
