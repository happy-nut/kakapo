// Reading a whole tree at a revision, for the symbol index.
//
// kakapo already reads single files at a revision (diff.ts: readTargetBlobSource) with one `git show` per
// file, and at diff scale — a handful of changed files — that is the right primitive. At tree scale it is
// not: measured on a 3,058-file repository, `git show` per file costs 14.7 ms each, which is 44.9 SECONDS
// for the tree, while one `git cat-file --batch` answers all 3,058 in 548 ms. The 82× is not git being
// slow; it is fork/exec and repository setup paid 3,058 times instead of once.
//
// So this module owns exactly two operations — enumerate, and read in bulk — and nothing else.
import { spawn } from "node:child_process";
import { git, workspaceGitPrefix, RAW_PATHS } from "./git.js";

/**
 * Every file the revision holds under this workspace, as paths relative to `root`.
 *
 * `-r` recurses, `--name-only` drops the mode/type/oid columns, and `-z` is what makes the output
 * parseable: a path with a newline or a quote in it is legal in git, and without `-z` git escapes and
 * quotes such names, which a line split silently mangles into a path that exists nowhere.
 */
export function listRevisionFiles(root: string, revision: string): string[] {
  const prefix = workspaceGitPrefix(root);
  // `--full-tree` is load-bearing when there is a prefix. Without it, ls-tree limits itself to the current
  // working directory AND reads the pathspec relative to it, so running in `<repo>/src` with `-- src`
  // asks for `src/src` and returns nothing — which is indistinguishable from an empty revision. With it,
  // ls-tree behaves as if run from the repository root: the pathspec and the output are both
  // repository-relative, which is what the stripping below assumes.
  const args = ["ls-tree", "-r", "-z", "--full-tree", "--name-only", revision];
  if (prefix) args.push("--", prefix);
  const out = git(root, args);
  if (!out) return [];
  const names = out.split("\0").filter(Boolean);
  if (!prefix) return names;
  const strip = prefix + "/";
  return names.filter((name) => name.startsWith(strip)).map((name) => name.slice(strip.length));
}

export type RevisionBlob = { path: string; content: string };

/**
 * Read many blobs from one revision through a single `git cat-file --batch` process.
 *
 * The protocol per request line is `<oid> <type> <size>\n`, then exactly `size` bytes, then one `\n`; a
 * spec git cannot resolve answers `<spec> missing\n` instead. Parsed from a byte buffer rather than a
 * string because the size is in BYTES — decoding first would make the offset arithmetic wrong for any file
 * with a multi-byte character in it, which is most of them.
 *
 * `maxBytes` is checked against the header, so an oversized file is skipped without being decoded at all.
 * The working-tree path cannot do that: it reads the file, then measures what it read.
 */
export function readRevisionBlobs(
  root: string,
  revision: string,
  paths: string[],
  options: { maxBytes?: number; onFile?: (file: RevisionBlob) => void } = {},
): Promise<RevisionBlob[]> {
  const maxBytes = options.maxBytes ?? Infinity;
  const prefix = workspaceGitPrefix(root);
  const out: RevisionBlob[] = [];
  if (!paths.length) return Promise.resolve(out);

  return new Promise((resolve) => {
    const child = spawn("git", [...RAW_PATHS, "cat-file", "--batch"], {
      cwd: root,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    // Requests go out in order and answers come back in the same order, so the path for each record is
    // positional. git echoes the spec only on a miss, and a spec can contain spaces, so it is not a
    // reliable key to parse back out.
    let next = 0;
    // Annotated: Buffer.alloc narrows to Buffer<ArrayBuffer>, Buffer.concat widens to ArrayBufferLike, and
    // the two do not assign to each other.
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let at = 0;

    const take = (file: RevisionBlob) => { out.push(file); options.onFile?.(file); };

    const drain = () => {
      for (;;) {
        const newline = buf.indexOf(0x0a, at);
        if (newline < 0) break;
        const header = buf.toString("utf8", at, newline);
        const space = header.lastIndexOf(" ");
        const size = space >= 0 ? Number(header.slice(space + 1)) : NaN;
        if (!Number.isFinite(size)) {
          // "<spec> missing" (or "ambiguous"): no body follows, so only the header is consumed. A path
          // absent from this revision is an ordinary outcome, not an error — it is what a file added after
          // this commit looks like.
          at = newline + 1;
          next += 1;
          continue;
        }
        const bodyEnd = newline + 1 + size;
        if (buf.length < bodyEnd + 1) break; // +1 for the record's trailing newline
        const path = paths[next];
        next += 1;
        if (path !== undefined && size <= maxBytes) {
          const content = buf.toString("utf8", newline + 1, bodyEnd);
          // A NUL means binary, and the index has nothing to say about it. Checked here rather than left to
          // indexableContent so the string is dropped at once instead of travelling further.
          if (!content.includes("\0")) take({ path, content });
        }
        at = bodyEnd + 1;
      }
    };

    // Carry only the unconsumed tail into the next chunk. Keeping one growing buffer instead would hold the
    // whole tree — 27 MB on the repository this was measured against — alive until the process closed.
    child.stdout.on("data", (chunk: Buffer) => {
      buf = at === buf.length ? chunk : Buffer.concat([buf.subarray(at), chunk]);
      at = 0;
      drain();
    });
    child.once("error", () => resolve(out));
    child.once("close", () => { drain(); resolve(out); });
    child.stdin.on("error", () => { /* a closed pipe ends the read; whatever arrived is still usable */ });
    child.stdin.end(paths.map((path) => `${revision}:${prefix ? prefix + "/" : ""}${path}`).join("\n") + "\n");
  });
}
