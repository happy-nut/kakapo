import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import type { AutomaticReviewBase } from "./git.js";
import type { CompareState, DiffReviewBuild, WhitespaceMode } from "./types.js";
import { isGitRepository, git, resolveAutomaticReviewBase } from "./git.js";
import { collectHttpEnvironments, collectReviewFileStates, collectSourceFiles, parseUnifiedDiff, readUnifiedDiff } from "./diff.js";
import { reviewDiffSignature } from "./review-bodies.js";
import { readProjectLayout } from "./project-layout.js";
import { detectBaseDivergence } from "./git-conflicts.js";
import { renderDiff2Html, type SourceTextLookup } from "./highlight.js";
import {
  diffSubtitle,
  extractLazyDiffBody,
  renderCompareBanner,
  renderDiffHtml,
  renderDiffTree,
  renderLazyDiffShells,
  renderReviewStatus,
  renderSourceTree,
  shouldLazyRender,
  splitDiffForLazy,
  annotateDiffWrappers,
} from "./render.js";

function resolveCompareState(input: {
  base?: string;
  baseLabel?: string;
  target?: string;
  staged: boolean;
}, automaticBase: AutomaticReviewBase | undefined): CompareState {
  if (input.staged) return { mode: "staged", left: input.baseLabel ?? input.base ?? "HEAD", right: "" };
  if (input.base === "HEAD" && !input.target) return { mode: "local", left: "HEAD", right: "" };
  if (input.base || input.target) {
    return { mode: "manual", left: input.baseLabel ?? input.base ?? "HEAD", right: input.target ?? "" };
  }
  if (automaticBase?.target) {
    return { mode: "incoming", left: "HEAD", right: automaticBase.target, count: automaticBase.behind };
  }
  if (automaticBase) return { mode: "ahead", left: automaticBase.upstream, right: "HEAD", count: automaticBase.ahead };
  return { mode: "local", left: "HEAD", right: "" };
}

export function renderLazyDiffBody(diffText: string, sourceText?: SourceTextLookup): string {
  return extractLazyDiffBody(renderDiff2Html(diffText, sourceText));
}

export function buildDiffReview(input: {
  base?: string;
  baseLabel?: string;
  openPath?: string;
  target?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  title: string;
  watch?: boolean;
  ignoreWhitespace?: boolean;
  whitespace?: WhitespaceMode;
  lazy?: boolean;
  lazyLoad?: boolean;
  app?: boolean;
  root?: string;
  deferFullIndex?: boolean;
}): DiffReviewBuild {
  const root = input.root ?? process.cwd();
  const automaticBase = !input.base && !input.staged && !input.target
    ? resolveAutomaticReviewBase(root, input.includeUntracked)
    : undefined;
  const reviewBase = input.base ?? automaticBase?.revision;
  const reviewTarget = input.target ?? automaticBase?.target;
  const watchSignature = reviewDiffSignature({ ...input, root, ignoreWhitespace: Boolean(input.ignoreWhitespace) }, reviewBase, automaticBase?.upstream);
  const compare = resolveCompareState(input, automaticBase);
  const diffText = readUnifiedDiff({
    base: reviewBase,
    target: reviewTarget,
    staged: input.staged,
    context: input.context,
    includeUntracked: input.includeUntracked,
    ignoreWhitespace: input.ignoreWhitespace,
    whitespace: input.whitespace,
    root,
  });
  const files = parseUnifiedDiff(diffText);
  const appLazySource = Boolean(input.app && input.lazyLoad);
  const deferFullIndex = Boolean(input.deferFullIndex && appLazySource && files.length > 0);
  const sourceFiles = collectSourceFiles(files, root, {
    previewLargeText: appLazySource,
    deferSourceContent: appLazySource,
    target: reviewTarget,
    changedPathsOnly: deferFullIndex,
  });
  const fileStates = collectReviewFileStates(files, sourceFiles);
  const projectLayout = readProjectLayout(root);
  const divergence = reviewBase
    ? detectBaseDivergence(root, reviewBase, files.map((file) => file.displayPath))
    : undefined;
  const collisions = new Map((divergence?.collisions ?? []).map((item) => [item.path, item.kind] as const));
  const httpEnvironments = collectHttpEnvironments(root,
    sourceFiles.filter((file) => /\.(http|rest)$/i.test(file.path)).map((file) => file.path));
  const hunks = files.reduce((sum, file) => sum + file.hunks.length, 0);
  const generatedAt = new Date().toISOString();
  const branch = git(root, ["branch", "--show-current"]);
  const toplevel = git(root, ["rev-parse", "--show-toplevel"]);
  const gitCommonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const sharedRepoDir = gitCommonDir ? dirname(gitCommonDir) : "";
  const projectName = (sharedRepoDir && toplevel && resolve(toplevel) !== resolve(sharedRepoDir))
    ? basename(sharedRepoDir)
    : basename(root);
  const totalLines = files.reduce((sum, file) => sum + file.hunks.reduce((t, h) => t + h.lines.length, 0), 0);
  const big = shouldLazyRender(files.length, totalLines);
  const lazyLoad = input.lazyLoad ?? false;
  const lazy = lazyLoad || (input.lazy ?? big);
  const lazyBodyDiffs = lazyLoad ? splitUnifiedDiffForLazyBodies(diffText) : undefined;
  const diffSplit = lazyLoad
    ? { container: renderLazyDiffShells(files), islands: "", bodies: [] as string[] }
    : (() => {
        const byPath = new Map(sourceFiles.map((file) => [file.path, file.content]));
        const diffHtml = renderDiff2Html(diffText, (path) => byPath.get(path) || undefined);
        return lazy
          ? splitDiffForLazy(diffHtml, files)
          : { container: annotateDiffWrappers(diffHtml, files), islands: "", bodies: [] as string[] };
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
    collisions,
    diffHtml: diffSplit.container,
    diffIslands: lazyLoad ? "" : diffSplit.islands,
    lazy,
    lazyLoad,
    sourceFiles,
    fileStates,
    httpEnvironments,
    projectLayout,
    title: input.title,
    subtitle: diffSubtitle({ ...input, base: reviewBase, baseLabel: automaticBase?.label }),
    projectName,
    projectPath: root,
    branch,
    watch: Boolean(input.watch),
    ignoreWhitespace: Boolean(input.ignoreWhitespace),
    app: Boolean(input.app),
    compare,
    openPath: input.openPath,
    signature,
    generatedAt,
  });

  const update = {
    signature,
    generatedAt,
    branch,
    diffContainer: diffSplit.container || '<div class="empty"><p class="empty-title" data-i18n="diff.noDiff">No diff to review.</p><p class="empty-hint" data-i18n="diff.noDiff.hint">If this is not what you meant to review, change it with the compare control in the toolbar.</p></div>',
    changesPanel: renderDiffTree(files, collisions, projectLayout.modules),
    filesTree: lazyLoad ? "" : renderSourceTree(sourceFiles, projectLayout.modules),
    reviewStatus: renderReviewStatus({ compare, app: Boolean(input.app) }),
    compareBanner: renderCompareBanner(compare),
    fileStates,
    sourceFilesMeta: lazyLoad ? sourceFiles.map((file) => ({ ...file, content: "", image: "" })) : sourceFiles,
    httpEnvironments,
    projectLayout,
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
    watchSignature,
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
