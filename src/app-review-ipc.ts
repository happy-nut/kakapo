import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import type {
  HttpAttachment, HttpSaveRequest, HttpSaveResult, HttpSendRequest, WebSocketSendRequest,
} from "./types.js";
import { performWebSocketRequest } from "./http-socket.js";
import { readHttpAttachment, saveHttpResponse } from "./http-files.js";

const buildTools = (): Promise<typeof import("./cli.js")> => import("./cli.js");
import {
  readGitLog, readGitLineLog, readGitBlame,
  readGitReflog, readGitStashes, resolveGitRevision, type GitLogFilter,
} from "./git-log.js";
import { canonicalWorkspaceRoot, defaultBaseRef, git, listBranches, listRemotes, workspaceGitPrefix, RAW_PATHS } from "./git.js";
import { previewMediaForPath } from "./preview-media.js";
import { readUnifiedDiff } from "./diff.js";
import { readPatchSets, readPatchSetStats, resolveReadMark } from "./patch-sets.js";
import { AppPreferences } from "./app-preferences.js";
import { materializeDeferredSourceFile } from "./diff.js";
import { containedRealPath, languageForPath } from "./util.js";
import { isKnownExternalUri, isKnownLibraryPath } from "./lsp.js";
import { externalSourceFile, readLibrarySourceFile } from "./library-source.js";
import { allReviewBodies, readReviewBody, reviewBodyCount } from "./review-bodies.js";
import { searchProject } from "./search.js";
import type { AnalysisRequest, ProjectAnalysis } from "./analysis.js";
import type { ReviewPerformanceTrace } from "./perf.js";
import { readReviewDiffContext, type DiffContextRequest } from "./diff-context.js";
import type { ProjectIndexPayload, SourceFile } from "./types.js";

export type ReviewIpcState = {
  options: { root: string; base?: string; baseLabel?: string; target?: string; staged: boolean };
  signature: string;
  bodies: { file: string; offsets: number[] };
  bodyCache: { get(key: string): string | undefined; set(key: string, value: string): void };
  sourceFiles: Map<string, SourceFile>;
  analysis: ProjectAnalysis;
  perf: ReviewPerformanceTrace;
  reviewBase?: string;
  reviewTarget?: string;
  compareScope?: { sha: string; shortSha: string; subject: string; date: string }[];
  compareRef?: string;
  compareTip?: boolean;
  ensureFullIndex?: () => void | Promise<void>;
};

type ReviewIpcEvent = IpcMainEvent | IpcMainInvokeEvent;
type ReviewStateResolver = (event: ReviewIpcEvent) => ReviewIpcState | undefined;

function reviewAssetMime(rel: string): string | null {
  const media = previewMediaForPath(rel);
  if (media) return media.mime;
  return extname(rel).toLowerCase() === ".svg" ? "image/svg+xml" : null;
}
const MAX_REVIEW_ASSET_BYTES = 64 * 1024 * 1024;

function readRevisionBlob(root: string, rel: string, revision: string): Buffer | null {
  const workspace = canonicalWorkspaceRoot(root);
  const prefix = workspaceGitPrefix(workspace);
  const out = spawnSync("git", [...RAW_PATHS, "show", "--no-textconv", `${revision}:${prefix ? prefix + "/" : ""}${rel}`],
    { cwd: workspace, encoding: "buffer", maxBuffer: MAX_REVIEW_ASSET_BYTES + 1024 });
  if (out.status !== 0) return null;
  const data = out.stdout as Buffer | undefined;
  return data && data.length <= MAX_REVIEW_ASSET_BYTES ? data : null;
}

function librarySource(root: string, requested: string): SourceFile | null {
  if (isAbsolute(requested)) {
    return isKnownLibraryPath(requested) ? readLibrarySourceFile(requested) : null;
  }
  const target = containedRealPath(root, requested);
  return target ? readLibrarySourceFile(target, requested) : null;
}

export function registerReviewIpc(ipc: IpcMain, stateFromEvent: ReviewStateResolver, userData = ""): void {
  const preferences = new AppPreferences(userData);
  ipc.handle("kakapo:http-send", async (event, request: HttpSendRequest) => {
    const state = stateFromEvent(event);
    return (await buildTools()).performHttpRequest(request, { root: state?.options.root, userData });
  });

  ipc.handle("kakapo:ws-send", (_event, request: WebSocketSendRequest) => performWebSocketRequest(request));

  ipc.handle("kakapo:http-attachment", (event, request: { path?: string }): HttpAttachment => {
    const state = stateFromEvent(event);
    if (!state) return { ok: false, error: "Review window is unavailable" };
    return readHttpAttachment(state.options.root, String(request?.path ?? ""));
  });

  ipc.handle("kakapo:http-save-response", (event, request: HttpSaveRequest): HttpSaveResult => {
    const state = stateFromEvent(event);
    if (!state) return { ok: false, error: "Review window is unavailable" };
    return saveHttpResponse(state.options.root, userData, request);
  });

  ipc.handle("kakapo:get-file", async (event, request: { index?: number }) => {
    const state = stateFromEvent(event);
    if (!state) return "";
    const index = Number(request?.index);
    if (!Number.isInteger(index) || index < 0 || index >= reviewBodyCount(state.bodies)) return "";
    const cached = state.bodyCache.get(String(index));
    if (cached !== undefined) return cached;
    const body = (await buildTools()).renderLazyDiffBody(
      readReviewBody(state.bodies, index),
      (path) => sourceTextForHighlight(state, path),
    );
    state.bodyCache.set(String(index), body);
    return body;
  });

  ipc.handle("kakapo:get-source", async (event, request: { path?: string }) => {
    const state = stateFromEvent(event);
    const asked = String(request?.path ?? "");
    const path = asked.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!state || !path || path.startsWith("../")) return null;
    let record = state.sourceFiles.get(path);
    if (!record) {
      await state.ensureFullIndex?.();
      record = state.sourceFiles.get(path);
    }
    if (!record) {
      // A definition target that is not a path — a class in a dependency jar, a class in the JDK image.
      // Its text exists only inside the language server that named it, so it is fetched rather than read.
      // Matched against what the renderer ASKED for, not the normalised path: the normaliser turns every
      // backslash into a slash, which is right for a file path and wrong for a URI whose query can contain
      // one — a rewritten URI matches nothing in the registry and is not the string the server would
      // recognise either. Both forms are tried so a path that normalising did not touch still works.
      const external = isKnownExternalUri(asked) ? asked : isKnownExternalUri(path) ? path : "";
      if (external) {
        const text = await state.analysis.externalSourceText(external);
        return text ? externalSourceFile(external, text) : null;
      }
      return librarySource(state.options.root, path);
    }
    if (!record.deferred) return record;
    const materialized = materializeDeferredSourceFile(state.options.root, record, state.reviewTarget ?? state.options.target);
    state.sourceFiles.set(path, materialized);
    return materialized;
  });

  ipc.handle("kakapo:get-asset", (event, request: { path?: string; side?: string }) => {
    const state = stateFromEvent(event);
    const rel = String(request?.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!state || !rel || rel.startsWith("../")) return null;
    const mime = reviewAssetMime(rel);
    if (!mime) return null;
    if (String(request?.side ?? "") === "base") {
      const revision = state.reviewBase ?? state.options.base ?? defaultBaseRef(state.options.root);
      if (!revision) return null;
      const data = readRevisionBlob(state.options.root, rel, revision);
      return data ? { dataUrl: `data:${mime};base64,${data.toString("base64")}` } : null;
    }
    const target = containedRealPath(state.options.root, rel);
    if (!target) return null;
    try {
      const stats = statSync(target);
      if (!stats.isFile() || stats.size > MAX_REVIEW_ASSET_BYTES) return null;
      return { dataUrl: `data:${mime};base64,${readFileSync(target).toString("base64")}` };
    } catch { return null; }
  });

  ipc.handle("kakapo:get-project-index", async (event): Promise<ProjectIndexPayload | null> => {
    const state = stateFromEvent(event);
    if (!state) return null;
    await state.ensureFullIndex?.();
    return {
      signature: state.signature,
      filesTree: "",
      sourceFilesMeta: Array.from(state.sourceFiles.values(), (file) => {
        const { content: _content, image: _image, ...metadata } = file;
        return metadata as SourceFile;
      }),
    };
  });

  ipc.handle("kakapo:get-diff-context", (event, request: DiffContextRequest) => {
    const state = stateFromEvent(event);
    if (!state) return { ok: false, oldStart: 0, newStart: 0, oldLines: [], newLines: [], error: "Review window is unavailable" };
    return readReviewDiffContext({
      root: state.options.root,
      base: state.reviewBase ?? state.options.base,
      target: state.reviewTarget ?? state.options.target,
      staged: state.options.staged,
      bodyDiffs: allReviewBodies(state.bodies),
      request,
    });
  });

  ipc.handle("kakapo:analysis", async (event, request: AnalysisRequest) => {
    const state = stateFromEvent(event);
    if (!state) return { ok: false, generation: 0, durationMs: 0, engine: "index", confidence: "heuristic", locations: [], error: "Review window is unavailable" };
    const response = await state.analysis.query(request);
    state.perf.mark("analysis-query", {
      kind: request?.kind ?? "unknown",
      generation: response.generation,
      durationMs: response.durationMs,
      engine: response.engine,
      ok: response.ok,
    });
    return response;
  });

  ipc.handle("kakapo:analysis-status", (event) => stateFromEvent(event)?.analysis.getStatus() ?? {
    generation: 0,
    phase: "failed",
    error: "Review window is unavailable",
    updatedAt: new Date().toISOString(),
  });

  ipc.handle("kakapo:diagnostics", async (event, request: { path?: string }) => {
    const state = stateFromEvent(event);
    if (!state) return { ok: false, generation: 0, available: false, engine: "index", diagnostics: [], error: "Review window is unavailable" };
    const response = await state.analysis.diagnostics(typeof request?.path === "string" ? request.path : "");
    state.perf.mark("diagnostics-query", {
      generation: response.generation,
      available: response.available,
      count: response.diagnostics.length,
      ok: response.ok,
    });
    return response;
  });

  ipc.on("kakapo:perf-mark", (event, payload: { name?: unknown; details?: unknown }) => {
    const state = stateFromEvent(event);
    const name = typeof payload?.name === "string" ? payload.name : "";
    if (!state || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) return;
    const raw = payload?.details && typeof payload.details === "object" ? payload.details as Record<string, unknown> : {};
    const details: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(raw).slice(0, 20)) {
      if (/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/.test(key) && (value === null || ["string", "number", "boolean"].includes(typeof value))) {
        details[key] = value as string | number | boolean | null;
      }
    }
    state.perf.mark(name, details);
  });

  ipc.handle("kakapo:search", (event, request: {
    query?: string; limit?: number; masks?: string[]; extensions?: string[]; excludeCommentsAndTests?: boolean;
    matchCase?: boolean; wholeWords?: boolean; regex?: boolean;
    includePaths?: string[]; excludePaths?: string[];
  }) => {
    const state = stateFromEvent(event);
    if (!state) return { available: false, engine: "fallback", matches: [], truncated: false };
    return searchProject(state.options.root, String(request?.query ?? ""), request?.limit, {
      masks: request?.masks ?? request?.extensions,
      excludeCommentsAndTests: request?.excludeCommentsAndTests === true,
      matchCase: request?.matchCase === true,
      wholeWords: request?.wholeWords === true,
      includePaths: request?.includePaths,
      excludePaths: request?.excludePaths,
      regex: request?.regex === true,
    });
  });

  ipc.handle("kakapo:git-log", (event, request: GitLogFilter) => {
    const state = stateFromEvent(event);
    if (!state) return [];
    try { return readGitLog(state.options.root, request ?? {}); } catch { return []; }
  });

  ipc.handle("kakapo:git-reflog", (event, request: { limit?: number }) => {
    const state = stateFromEvent(event);
    if (!state) return [];
    try { return readGitReflog(state.options.root, { limit: request?.limit }); } catch { return []; }
  });

  ipc.handle("kakapo:git-stashes", (event) => {
    const state = stateFromEvent(event);
    if (!state) return [];
    try { return readGitStashes(state.options.root); } catch { return []; }
  });

  ipc.handle("kakapo:git-resolve-rev", (event, request: { query?: string }) => {
    const state = stateFromEvent(event);
    if (!state || !request?.query) return null;
    try { return resolveGitRevision(state.options.root, request.query); } catch { return null; }
  });

  ipc.handle("kakapo:git-line-log", (event, request: { path?: string; line?: number; limit?: number }) => {
    const state = stateFromEvent(event);
    const path = typeof request?.path === "string" ? request.path : "";
    if (!state || !path || !state.sourceFiles.has(path)) return [];
    try { return readGitLineLog(state.options.root, { path, line: Number(request?.line), limit: request?.limit }); } catch { return []; }
  });

  ipc.handle("kakapo:git-blame", (event, request: { path?: string; side?: "old" | "new" }) => {
    const state = stateFromEvent(event);
    const path = typeof request?.path === "string" ? request.path : "";
    if (!state || !path || !state.sourceFiles.has(path)) return [];
    const revision = request?.side === "old"
      ? (state.reviewBase ?? state.options.base ?? "HEAD")
      : (state.reviewTarget ?? state.options.target);
    try { return readGitBlame(state.options.root, path, revision); } catch { return []; }
  });

  ipc.handle("kakapo:file-patch", (event, request: { path?: string }) => {
    const state = stateFromEvent(event);
    const path = typeof request?.path === "string" ? request.path : "";
    if (!state || !path || !state.sourceFiles.has(path)) return "";
    try {
      return readUnifiedDiff({
        base: state.reviewBase ?? state.options.base,
        target: state.reviewTarget ?? state.options.target,
        staged: state.options.staged === true,
        // Three lines of context and NO whitespace flags, whatever the window is currently showing. The
        // review's own view may be ignoring whitespace to read better; a patch generated that way does not
        // apply, and a patch that does not apply is worse than none. This is the form `git apply` expects.
        context: 3,
        includeUntracked: false,
        whitespace: "none",
        root: state.options.root,
        paths: [path],
      });
    } catch {
      return "";
    }
  });

  ipc.handle("kakapo:compare-clipboard", (event, request: { path?: string; text?: string }) => {
    const state = stateFromEvent(event);
    const path = typeof request?.path === "string" ? request.path : "";
    const text = typeof request?.text === "string" ? request.text : "";
    if (!state || !path || !state.sourceFiles.has(path)) return "";
    const file = state.sourceFiles.get(path);
    const current = typeof file?.content === "string" ? file.content : "";
    let dir = "";
    try {
      dir = mkdtempSync(join(tmpdir(), "kakapo-clip-"));
      const mine = join(dir, "clipboard");
      const theirs = join(dir, basename(path) || "file");
      writeFileSync(mine, text, "utf8");
      writeFileSync(theirs, current, "utf8");
      // --no-index makes git compare two paths outside any repository, so this says nothing about, and
      // reads nothing from, the review's own history. status 1 just means "they differ".
      const result = spawnSync("git", ["--no-pager", "diff", "--no-index", "--unified=3", "--", mine, theirs], {
        encoding: "utf8", maxBuffer: 1024 * 1024 * 50,
      });
      if (result.status !== 0 && result.status !== 1) return "";
      return result.stdout ?? "";
    } catch {
      return "";
    } finally {
      if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { } }
    }
  });

  ipc.handle("kakapo:compare-menu", (event) => {
    const state = stateFromEvent(event);
    if (!state) return null;
    try {
      const root = state.options.root;
      const defaultRef = compareDefaultRef(root);
      const ref = state.compareRef || state.options.baseLabel || defaultRef;
      const explicitBase = Boolean(state.options.base) && !state.options.baseLabel && state.options.base !== "HEAD";
      const readMark = resolveReadMark(root, preferences.readReadMark(root));
      const sinceReadMark = Boolean(
        readMark
        && !state.compareScope?.length
        && !state.options.target
        && !state.options.baseLabel
        && state.options.base === readMark.sha,
      );
      const mode = sinceReadMark
        ? "since"
        : state.compareScope?.length || state.options.target || explicitBase
        ? "other"
        : state.options.staged || state.options.base === "HEAD" || (!state.options.base && !state.reviewBase)
          ? "uncommitted"
          : state.compareTip
            ? "tip"
            : "all";
      return { mode, ref, defaultRef, readMark, pinned: Boolean(state.compareRef), branches: listBranches(root), remotes: listRemotes(root) };
    } catch { return null; }
  });

  ipc.handle("kakapo:git-patch-sets", (event) => {
    const state = stateFromEvent(event);
    if (!state) return null;
    try {
      if (state.compareScope && state.compareScope.length) {
        return {
          activeBase: state.reviewBase ?? state.options.base ?? "auto",
          activeTarget: state.reviewTarget ?? state.options.target ?? "worktree",
          head: state.compareScope[state.compareScope.length - 1].sha,
          commits: state.compareScope,
          scoped: true,
        };
      }
      const list = readPatchSets(state.options.root, state.compareRef);
      list.activeBase = state.reviewBase || list.head;
      list.activeTarget = state.reviewTarget ?? state.options.target ?? "worktree";
      return list;
    } catch { return null; }
  });

  ipc.handle("kakapo:patch-set-ledger", async (event) => {
    const state = stateFromEvent(event);
    if (!state) return null;
    try {
      const root = state.options.root;
      const scoped = Boolean(state.compareScope && state.compareScope.length);
      const list = scoped
        ? {
          activeBase: state.reviewBase ?? state.options.base ?? "auto",
          activeTarget: state.reviewTarget ?? state.options.target ?? "worktree",
          head: state.compareScope![state.compareScope!.length - 1].sha,
          commits: state.compareScope!,
          scoped: true,
          branchPoint: undefined,
        }
        : (() => {
          const read = readPatchSets(root, state.compareRef);
          read.activeBase = state.reviewBase || read.head;
          read.activeTarget = state.reviewTarget ?? state.options.target ?? "worktree";
          return read;
        })();
      const first = list.commits[0];
      const last = list.commits[list.commits.length - 1];
      const from = scoped
        ? (first ? `${first.sha}^` : "")
        : (list.branchPoint ? list.branchPoint.sha : "");
      const stats = first && last ? await readPatchSetStats(root, from, last.sha) : {};
      return { ...list, stats, readMark: resolveReadMark(root, preferences.readReadMark(root)) };
    } catch { return null; }
  });
}

export function compareDefaultRef(root: string): string {
  return git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) || defaultBaseRef(root);
}

function sourceTextForHighlight(state: ReviewIpcState, path: string): string | undefined {
  if (languageForPath(path) !== "markup") return undefined;
  const record = state.sourceFiles.get(path);
  if (!record) return undefined;
  if (typeof record.content === "string" && record.content) return record.content;
  if (!record.deferred) return undefined;
  try {
    const filled = materializeDeferredSourceFile(state.options.root, record, state.reviewTarget ?? state.options.target);
    return typeof filled?.content === "string" && filled.content ? filled.content : undefined;
  } catch { return undefined; }
}
