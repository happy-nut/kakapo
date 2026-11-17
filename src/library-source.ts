import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { SOURCE_MAX_LAZY_FILE_BYTES } from "./constants.js";
import type { SourceFile } from "./types.js";
import { decodeTextBuffer, formatBytes, hashText, isLikelyBinary, isLikelyBinaryHead, languageForPath, readTextFile } from "./util.js";
import { externalLocationLabel } from "./lsp.js";
import { readArchiveEntry } from "./archive-source.js";

function libraryBase(displayPath: string, size: number): SourceFile {
  return {
    path: displayPath,
    name: basename(displayPath),
    language: languageForPath(displayPath),
    content: "",
    size,
    changed: false,
    embedded: false,
    changedLines: [],
    signature: "",
    library: true,
  };
}

export function readLibrarySourceFile(absolutePath: string, displayPath = absolutePath): SourceFile | null {
  if (!existsSync(absolutePath)) {
    const archived = readArchiveEntry(absolutePath, SOURCE_MAX_LAZY_FILE_BYTES);
    if (!archived || isLikelyBinaryHead(archived.bytes)) return null;
    return {
      ...libraryBase(displayPath, archived.bytes.length),
      content: decodeTextBuffer(archived.bytes),
      embedded: true,
      signature: hashText(`${displayPath}\0${archived.bytes.length}\0${archived.mtimeMs}`),
    };
  }
  let stats: ReturnType<typeof statSync>;
  try { stats = statSync(absolutePath); } catch { return null; }
  if (!stats.isFile()) return null;
  const base = libraryBase(displayPath, stats.size);
  const unreadable = (skippedReason: string, kind: SourceFile["skippedKind"], tag: string): SourceFile =>
    ({ ...base, skippedReason, skippedKind: kind, signature: hashText(`${displayPath}\0${tag}\0${stats.size}`) });
  if (stats.size > SOURCE_MAX_LAZY_FILE_BYTES) {
    return unreadable(`larger than ${formatBytes(SOURCE_MAX_LAZY_FILE_BYTES)}`, "large", "library-large");
  }
  if (isLikelyBinary(absolutePath)) return unreadable("binary file", "binary", "library-binary");
  let content: string;
  try { content = readTextFile(absolutePath); } catch { return unreadable("unreadable file", "unreadable", "library-unreadable"); }
  return {
    ...base,
    content,
    embedded: true,
    signature: hashText(`${displayPath}\0${stats.size}\0${stats.mtimeMs}`),
  };
}

export function externalSourceFile(uri: string, content: string, language = "java"): SourceFile {
  const label = externalLocationLabel(uri.split("?")[0] ?? uri);
  return {
    path: uri,
    name: label.split("/").filter(Boolean).pop() || label || uri,
    language,
    content,
    size: Buffer.byteLength(content, "utf8"),
    changed: false,
    embedded: true,
    changedLines: [],
    signature: hashText(`${uri}\0${content.length}`),
    library: true,
  };
}
