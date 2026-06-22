import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { DiffReviewBuild } from "./types.js";
import { isGitRepository } from "./git.js";
import { collectHttpEnvironments, collectReviewFileStates, collectSourceFiles, parseUnifiedDiff, readUnifiedDiff } from "./diff.js";
import { renderDiff2Html } from "./highlight.js";
import { diffSubtitle, renderDiffHtml, renderNotGitRepoHtml, shouldLazyRender, splitDiffForLazy } from "./render.js";

export function buildDiffReview(input: {
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  title: string;
  watch?: boolean;
  ignoreWhitespace?: boolean;
  lazy?: boolean; // force lazy materialize (shells + on-demand bodies); auto for big repos
  lazyLoad?: boolean; // serve/Electron set this — bodies + source fetched on demand, not embedded
  app?: boolean; // Electron app — inlines the integrated terminal (xterm); off for serve/standalone/tests
}): DiffReviewBuild {
  if (!isGitRepository(process.cwd())) {
    return {
      html: renderNotGitRepoHtml(process.cwd()),
      files: 0,
      hunks: 0,
      signature: "not-a-git-repo",
      generatedAt: new Date().toISOString(),
    };
  }
  const diffText = readUnifiedDiff({
    base: input.base,
    staged: input.staged,
    context: input.context,
    includeUntracked: input.includeUntracked,
    ignoreWhitespace: input.ignoreWhitespace,
  });
  const files = parseUnifiedDiff(diffText);
  const sourceFiles = collectSourceFiles(files);
  const fileStates = collectReviewFileStates(files, sourceFiles);
  const httpEnvironments = collectHttpEnvironments(process.cwd());
  const hunks = files.reduce((sum, file) => sum + file.hunks.length, 0);
  const generatedAt = new Date().toISOString();
  const diffHtml = renderDiff2Html(diffText);
  const totalLines = files.reduce((sum, file) => sum + file.hunks.reduce((t, h) => t + h.lines.length, 0), 0);
  // lazy-LOAD (Phase 2) serves each file body + source on demand instead of embedding them; it implies
  // lazy (shells). The transport opts in (serve/Electron pass lazyLoad:true) and we honor it regardless
  // of size: it used to be gated by `&& big`, but a mid-size repo (dozens of files, just under the
  // threshold) then embedded a 600KB+ source blob + every diff body inline, forcing the renderer to
  // parse + lay out a huge document before the first click — the startup "freeze". Standalone (no
  // transport) has no server, so it auto-decides by size and lazy-materializes from embedded islands.
  const big = shouldLazyRender(files.length, totalLines);
  const lazyLoad = input.lazyLoad ?? false;
  const lazy = lazyLoad || (input.lazy ?? big);
  const diffSplit = lazy ? splitDiffForLazy(diffHtml, files) : { container: diffHtml, islands: "", bodies: [] as string[] };
  const signature = createHash("sha1")
    .update(diffText)
    .update("\n")
    .update(sourceFiles.map((file) => `${file.path}\0${file.size}\0${file.embedded ? file.content : file.skippedReason ?? ""}`).join("\n"))
    .update("\n")
    .update(JSON.stringify(httpEnvironments))
    .digest("hex");
  const html = renderDiffHtml({
    files,
    diffHtml: diffSplit.container,
    diffIslands: lazyLoad ? "" : diffSplit.islands,
    lazy,
    lazyLoad,
    sourceFiles,
    fileStates,
    httpEnvironments,
    title: input.title,
    subtitle: diffSubtitle(input),
    projectName: basename(process.cwd()),
    projectPath: process.cwd(),
    watch: Boolean(input.watch),
    ignoreWhitespace: Boolean(input.ignoreWhitespace),
    app: Boolean(input.app),
    signature,
    generatedAt,
  });

  return {
    html,
    files: files.length,
    hunks,
    signature,
    generatedAt,
    lazyBodies: diffSplit.bodies,
    lazySourceData: lazyLoad ? JSON.stringify(sourceFiles) : undefined,
  };
}
