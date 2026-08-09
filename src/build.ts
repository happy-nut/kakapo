import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import type { DiffReviewBuild } from "./types.js";
import { isGitRepository, git, resolveAutomaticReviewBase } from "./git.js";
import { collectHttpEnvironments, collectReviewFileStates, collectSourceFiles, parseUnifiedDiff, readUnifiedDiff } from "./diff.js";
import { renderDiff2Html } from "./highlight.js";
import {
  diffSubtitle,
  extractLazyDiffBody,
  renderDiffHtml,
  renderDiffTree,
  renderLazyDiffShells,
  renderNotGitRepoHtml,
  renderReviewStatus,
  renderSourceTree,
  shouldLazyRender,
  splitDiffForLazy,
} from "./render.js";

export function renderLazyDiffBody(diffText: string): string {
  return extractLazyDiffBody(renderDiff2Html(diffText));
}

export function buildDiffReview(input: {
  base?: string;
  // Right/new side revision (A→B compare). undefined → compare against the working tree (default).
  target?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  title: string;
  watch?: boolean;
  ignoreWhitespace?: boolean;
  lazy?: boolean; // force lazy materialize (shells + on-demand bodies); auto for big repos
  lazyLoad?: boolean; // serve/Electron set this — bodies + source fetched on demand, not embedded
  app?: boolean; // Electron app — enables app-only review features such as Git history
  root?: string; // repo to review; defaults to process.cwd() (serve/CLI). Electron passes it per-window.
  // Diff-first startup: when there's a diff to show, index ONLY the changed files so the first paint isn't
  // blocked on enumerating a large tree; the full project index is materialized on demand (app-main's
  // ensureFullProjectIndex, pulled via kakapo:get-project-index). Honored only on the app's lazy path.
  deferFullIndex?: boolean;
}): DiffReviewBuild {
  const root = input.root ?? process.cwd();
  if (!isGitRepository(root)) {
    return {
      html: renderNotGitRepoHtml(root),
      files: 0,
      hunks: 0,
      signature: "not-a-git-repo",
      generatedAt: new Date().toISOString(),
    };
  }
  // A→B compare pins both sides to revisions, so the automatic (clean-branch merge-base) resolution and the
  // working-tree/index sides don't apply.
  const automaticBase = !input.base && !input.staged && !input.target
    ? resolveAutomaticReviewBase(root, input.includeUntracked)
    : undefined;
  const reviewBase = input.base ?? automaticBase?.revision;
  const reviewTarget = input.target ?? automaticBase?.target;
  const diffText = readUnifiedDiff({
    base: reviewBase,
    target: reviewTarget,
    staged: input.staged,
    context: input.context,
    includeUntracked: input.includeUntracked,
    ignoreWhitespace: input.ignoreWhitespace,
    root,
  });
  const files = parseUnifiedDiff(diffText);
  // The Electron app keeps source content behind per-file IPC. Standalone HTML retains the smaller limit
  // because every embedded source contributes to its initial payload.
  const appLazySource = Boolean(input.app && input.lazyLoad);
  // Diff-first only makes sense when there's a diff to show first AND the renderer can pull the full index
  // later (the app's lazy path). A clean tree's index IS the content, so build it fully.
  const deferFullIndex = Boolean(input.deferFullIndex && appLazySource && files.length > 0);
  const sourceFiles = collectSourceFiles(files, root, {
    previewLargeText: appLazySource,
    deferSourceContent: appLazySource,
    target: reviewTarget,
    changedPathsOnly: deferFullIndex,
  });
  const fileStates = collectReviewFileStates(files, sourceFiles);
  const httpEnvironments = collectHttpEnvironments(root);
  const hunks = files.reduce((sum, file) => sum + file.hunks.length, 0);
  const generatedAt = new Date().toISOString();
  // Current branch for the sidebar chip (empty on a detached HEAD); refreshed in the watch payload too.
  const branch = git(root, ["branch", "--show-current"]);
  // A linked worktree's own directory is often named after its branch (git worktree add ../branch branch,
  // or Orca-managed worktrees) — basename(root) would then just repeat the branch chip next to it in the
  // sidebar. Name it after the shared repository instead, found via --git-common-dir's parent — but ONLY
  // when root really is a separate worktree (its own --show-toplevel differs from that shared repo dir).
  // A monorepo review scoped to a subdirectory of the SAME working tree (toplevel === shared repo dir)
  // must keep showing the opened folder's own name: that's the intentionally isolated workspace identity.
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]);
  const gitCommonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const sharedRepoDir = gitCommonDir ? dirname(gitCommonDir) : "";
  const projectName = (sharedRepoDir && toplevel && resolve(toplevel) !== resolve(sharedRepoDir))
    ? basename(sharedRepoDir)
    : basename(root);
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
  const lazyBodyDiffs = lazyLoad ? splitUnifiedDiffForLazyBodies(diffText) : undefined;
  const diffSplit = lazyLoad
    ? { container: renderLazyDiffShells(files), islands: "", bodies: [] as string[] }
    : (() => {
        const diffHtml = renderDiff2Html(diffText);
        return lazy ? splitDiffForLazy(diffHtml, files) : { container: diffHtml, islands: "", bodies: [] as string[] };
      })();
  const signature = createHash("sha1")
    .update(reviewBase ?? "HEAD")
    .update("\n")
    .update(reviewTarget ?? "")
    .update("\n")
    .update(diffText)
    .update("\n")
    .update(sourceFiles.map((file) => `${file.path}\0${file.size}\0${file.signature}`).join("\n"))
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
    subtitle: diffSubtitle({ ...input, base: reviewBase, baseLabel: automaticBase?.label }),
    projectName,
    projectPath: root,
    branch,
    watch: Boolean(input.watch),
    ignoreWhitespace: Boolean(input.ignoreWhitespace),
    app: Boolean(input.app),
    signature,
    generatedAt,
  });

  // Compact payload for in-place refresh: just the regions the renderer swaps on a watch change. Reuses
  // the same fragment renderers as the full page, minus heavyweight embedded source content.
  const update = {
    signature,
    generatedAt,
    branch,
    diffContainer: diffSplit.container || '<div class="empty" data-i18n="diff.noDiff">No diff to review.</div>',
    changesPanel: renderDiffTree(files),
    // Transport-backed reviews build folder children incrementally from sourceFilesMeta in the renderer;
    // avoid generating/transferring a multi-megabyte all-files HTML tree on every build/update.
    filesTree: lazyLoad ? "" : renderSourceTree(sourceFiles),
    reviewStatus: renderReviewStatus({
      files: files.length,
      hunks,
      embeddedFiles: sourceFiles.filter((file) => file.embedded).length,
      sourceFileCount: sourceFiles.length,
      ignoreWhitespace: input.ignoreWhitespace,
      watch: input.watch,
      generatedAt,
    }),
    fileStates,
    sourceFilesMeta: lazyLoad ? sourceFiles.map((file) => ({ ...file, content: "", image: "" })) : sourceFiles,
    httpEnvironments,
  };

  return {
    html,
    files: files.length,
    hunks,
    signature,
    generatedAt,
    reviewBase,
    reviewTarget,
    reviewUpstream: automaticBase?.upstream,
    lazyBodies: lazyLoad ? [] : diffSplit.bodies,
    lazyBodyDiffs,
    lazySourceData: lazyLoad && !input.app ? JSON.stringify(sourceFiles) : undefined,
    lazySourceFiles: lazyLoad ? sourceFiles : undefined,
    fullIndexDeferred: deferFullIndex,
    update,
  };
}

function splitUnifiedDiffForLazyBodies(diffText: string): string[] {
  if (diffText.trim().length === 0) return [];
  return diffText
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.replace(/^\n+/, "").trimEnd())
    .filter((chunk) => chunk.startsWith("diff --git ") && parseUnifiedDiff(chunk).length > 0);
}
