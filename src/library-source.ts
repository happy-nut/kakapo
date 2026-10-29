import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { SOURCE_MAX_LAZY_FILE_BYTES } from "./constants.js";
import type { SourceFile } from "./types.js";
import { formatBytes, hashText, isLikelyBinary, languageForPath, readTextFile } from "./util.js";

/**
 * A file read for library navigation — a dependency, a stdlib module, a bundled type stub — after a
 * language server pointed a definition at it. It is deliberately not part of the project index: there is no
 * diff for it, no git status, and no comments, so it arrives as its own record, keyed by the path the
 * renderer asked for, and the viewer opens it read-only.
 *
 * `displayPath` is what the record is keyed by (repo-relative for a file under the root, absolute for one
 * outside it); `absolutePath` is what is actually read.
 */
export function readLibrarySourceFile(absolutePath: string, displayPath = absolutePath): SourceFile | null {
  if (!existsSync(absolutePath)) return null;
  let stats: ReturnType<typeof statSync>;
  try { stats = statSync(absolutePath); } catch { return null; }
  if (!stats.isFile()) return null;
  const base: SourceFile = {
    path: displayPath,
    name: basename(displayPath),
    language: languageForPath(displayPath),
    content: "",
    size: stats.size,
    changed: false,
    embedded: false,
    changedLines: [],
    signature: "",
    library: true,
  };
  const unreadable = (skippedReason: string, tag: string): SourceFile =>
    ({ ...base, skippedReason, signature: hashText(`${displayPath}\0${tag}\0${stats.size}`) });
  if (stats.size > SOURCE_MAX_LAZY_FILE_BYTES) {
    return unreadable(`larger than ${formatBytes(SOURCE_MAX_LAZY_FILE_BYTES)}`, "library-large");
  }
  if (isLikelyBinary(absolutePath)) return unreadable("binary file", "library-binary");
  let content: string;
  try { content = readTextFile(absolutePath); } catch { return unreadable("unreadable file", "library-unreadable"); }
  return {
    ...base,
    content,
    embedded: true,
    signature: hashText(`${displayPath}\0${stats.size}\0${stats.mtimeMs}`),
  };
}
