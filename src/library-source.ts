import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { SOURCE_MAX_LAZY_FILE_BYTES } from "./constants.js";
import type { SourceFile } from "./types.js";
import { formatBytes, hashText, isLikelyBinary, languageForPath, readTextFile } from "./util.js";
import { externalLocationLabel } from "./lsp.js";

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
  // The kind travels beside the reason, because the reason is an English sentence written for a log while
  // the page puts it on screen in the reader's own language — see SourceFile.skippedKind.
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

/**
 * A definition target that is not a file at all — `jdt://contents/…`, `jrt:/…/Instant.class` — rendered as
 * a read-only source record from text the language server produced for it.
 *
 * IntelliJ's two answers for the same question are one answer here: the string is the library's own source
 * when the server found a sources jar and a decompilation when it did not, and in both cases what reaches
 * the reader is Java to read rather than the "it is somewhere in rt.jar" line this used to end at. The
 * record is keyed by the URI, because that is what the renderer asked for and what the location it came
 * from names; the NAME is the archive-and-entry label the page already uses for these targets, so the tab
 * says `rt.jar / java/time/Instant.class` rather than a 200-character URI.
 */
export function externalSourceFile(uri: string, content: string, language = "java"): SourceFile {
  // The entry, without the query. A jdt URI is `jdt://contents/<jar>/<package>/<Class>.class?=<project>…`
  // and that query holds its own slash-separated path, so the last segment of the WHOLE uri is the jar
  // named at the end of the query — the tab came out called `rt.jar`. Cut at the `?` first.
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
