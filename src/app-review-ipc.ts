import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { performHttpRequest, renderLazyDiffBody, type HttpSendRequest } from "./cli.js";
import { readGitLog, readGitLineLog, readGitBlame, readCommitDiff, readRangeDiff } from "./git-log.js";
import { readPatchSets } from "./patch-sets.js";
import { materializeDeferredSourceFile } from "./diff.js";
import { searchProject } from "./search.js";
import type { AnalysisRequest, ProjectAnalysis } from "./analysis.js";
import type { ReviewPerformanceTrace } from "./perf.js";
import { readReviewDiffContext, type DiffContextRequest } from "./diff-context.js";
import type { ProjectIndexPayload, SourceFile } from "./types.js";

export type ReviewIpcState = {
  options: { root: string; base?: string; target?: string; staged: boolean };
  signature: string;
  bodyDiffs: string[];
  bodyCache: Map<number, string>;
  sourceFiles: Map<string, SourceFile>;
  analysis: ProjectAnalysis;
  perf: ReviewPerformanceTrace;
  reviewBase?: string;
  reviewTarget?: string;
  compareScope?: { sha: string; shortSha: string; subject: string; date: string }[];
};

type ReviewIpcEvent = IpcMainEvent | IpcMainInvokeEvent;
type ReviewStateResolver = (event: ReviewIpcEvent) => ReviewIpcState | undefined;

/** Registers read-only review, analysis, search, and history adapters. */
export function registerReviewIpc(ipc: IpcMain, stateFromEvent: ReviewStateResolver): void {
  ipc.handle("kakapo:http-send", (_event, request: HttpSendRequest) => performHttpRequest(request));

  ipc.handle("kakapo:get-file", (event, request: { index?: number }) => {
    const state = stateFromEvent(event);
    if (!state) return "";
    const index = Number(request?.index);
    if (!Number.isInteger(index) || index < 0 || index >= state.bodyDiffs.length) return "";
    const cached = state.bodyCache.get(index);
    if (cached !== undefined) return cached;
    const body = renderLazyDiffBody(state.bodyDiffs[index]);
    state.bodyCache.set(index, body);
    return body;
  });

  ipc.handle("kakapo:get-source", (event, request: { path?: string }) => {
    const state = stateFromEvent(event);
    const path = String(request?.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!state || !path || path.startsWith("../")) return null;
    const record = state.sourceFiles.get(path);
    if (!record) return null;
    if (!record.deferred) return record;
    const materialized = materializeDeferredSourceFile(state.options.root, record, state.reviewTarget ?? state.options.target);
    state.sourceFiles.set(path, materialized);
    return materialized;
  });

  ipc.handle("kakapo:get-project-index", (event): ProjectIndexPayload | null => {
    const state = stateFromEvent(event);
    if (!state) return null;
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
      bodyDiffs: state.bodyDiffs,
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

  ipc.handle("kakapo:search", (event, request: { query?: string; limit?: number; extensions?: string[]; excludeCommentsAndTests?: boolean }) => {
    const state = stateFromEvent(event);
    if (!state) return { available: false, engine: "fallback", matches: [], truncated: false };
    return searchProject(state.options.root, String(request?.query ?? ""), request?.limit, {
      extensions: request?.extensions,
      excludeCommentsAndTests: request?.excludeCommentsAndTests === true,
    });
  });

  ipc.handle("kakapo:git-log", (event, request: { limit?: number; skip?: number }) => {
    const state = stateFromEvent(event);
    if (!state) return [];
    try { return readGitLog(state.options.root, { limit: request?.limit, skip: request?.skip }); } catch { return []; }
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
      : (state.reviewTarget ?? state.options.target); // A→B: new-side blame is commit B, else working tree
    try { return readGitBlame(state.options.root, path, revision); } catch { return []; }
  });

  ipc.handle("kakapo:git-commit-diff", (event, request: { sha?: string }) => {
    const state = stateFromEvent(event);
    if (!state || !request?.sha) return null;
    try { return readCommitDiff(state.options.root, request.sha); } catch { return null; }
  });

  // Combined diff between two commits shift-selected in the history view (readRangeDiff validates the SHAs).
  ipc.handle("kakapo:git-range-diff", (event, request: { oldSha?: string; newSha?: string }) => {
    const state = stateFromEvent(event);
    if (!state || !request?.oldSha || !request?.newSha) return null;
    try { return readRangeDiff(state.options.root, request.oldSha, request.newSha); } catch { return null; }
  });

  // Patch sets available as diff bases for the compare bar. activeBase reflects the live review options
  // ("auto" when no explicit base), so the renderer can highlight the current selection. Read-only; the
  // mutating counterpart (kakapo:set-review-base) lives in app-main because it triggers a rebuild.
  ipc.handle("kakapo:git-patch-sets", (event) => {
    const state = stateFromEvent(event);
    if (!state) return null;
    try {
      // While a range opened from Cmd+9 is active, the dropdowns pick base/target from THAT range's commits
      // (so B..D within an opened A..F is selectable), not the local commits-ahead-of-branch-point.
      if (state.compareScope && state.compareScope.length) {
        return {
          activeBase: state.reviewBase ?? state.options.base ?? "auto",
          activeTarget: state.reviewTarget ?? state.options.target ?? "worktree",
          head: state.compareScope[state.compareScope.length - 1].sha,
          commits: state.compareScope,
          scoped: true,
        };
      }
      const list = readPatchSets(state.options.root);
      // Highlight against the base the build actually resolved (a SHA), not the raw option. When no
      // explicit base was set, reviewBase is the automatic merge-base, or undefined → the diff used HEAD.
      list.activeBase = state.reviewBase || list.head;
      // Right side: a chosen patch set (commit) or the working tree ("worktree" sentinel).
      list.activeTarget = state.reviewTarget ?? state.options.target ?? "worktree";
      return list;
    } catch { return null; }
  });
}
