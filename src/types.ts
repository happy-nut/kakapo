export type FlowConfig = {
  version: 1;
  projectName: string;
  verification: {
    commands: string[];
  };
  diff: {
    context: number;
    includeUntracked: boolean;
  };
};

export type GitSnapshot = {
  branch: string;
  status: string;
  diffStat: string;
  recentCommits: string;
};

export type DiffLine = {
  kind: "context" | "add" | "delete";
  oldLine?: number;
  newLine?: number;
  text: string;
};

export type DiffHunk = {
  header: string;
  title: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type DiffFile = {
  oldPath: string;
  newPath: string;
  displayPath: string;
  status: string;
  binary: boolean;
  hunks: DiffHunk[];
  vcs?: "new" | "edited" | "staged";
};

export type SourceFile = {
  path: string;
  name: string;
  language: string;
  content: string;
  size: number;
  changed: boolean;
  embedded: boolean;
  changedLines: number[];
  signature: string;
  skippedReason?: string;
  // Rendered preview for raster image files: a data: URI embedded by collectSourceFiles
  // (gated by IMAGE_MAX_BYTES). Present only for images; absent for text/binary files.
  image?: string;
  // Working-tree git status for sidebar coloring: untracked(new)=red, modified=blue, staged(git add)=green.
  vcs?: "new" | "edited" | "staged";
};

export type HttpSendRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

export type HttpSendResult = {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  durationMs: number;
};

export type SourceTreeNode = {
  name: string;
  path: string;
  children: Map<string, SourceTreeNode>;
  file?: SourceFile;
};

export type DiffReviewResult = {
  path: string;
  url: string;
  files: number;
  hunks: number;
};

// In-place diff refresh payload (Electron IPC / serve /__ai_flow_update): only the regions the renderer
// transplants on a watch change — far smaller than re-sending the whole HTML.
export type DiffReviewUpdate = {
  signature: string;
  generatedAt: string;
  diffContainer: string; // #diff2html-container innerHTML (lazy shells; bodies still fetched on demand)
  changesPanel: string; // #changes-panel innerHTML
  filesTree: string; // files tree HTML (#files-panel / #files-tree-html island)
  reviewStatus: string; // .review-status innerHTML
  fileStates: ReviewFileState[];
  sourceFilesMeta: SourceFile[]; // metadata only when lazyLoad (content fetched separately)
  httpEnvironments: Record<string, Record<string, string>>;
};

export type DiffReviewBuild = {
  html: string;
  files: number;
  hunks: number;
  signature: string;
  generatedAt: string;
  // Compact payload for in-place refresh (Electron watch / serve poll); see DiffReviewUpdate.
  update?: DiffReviewUpdate;
  // Phase 2 lazy-LOAD: per-file diff body HTML, served on demand (IPC / HTTP) instead of embedded,
  // so the initial HTML stays small. Indexed by file order. Empty unless lazyLoad was requested.
  lazyBodies?: string[];
  // Phase 2c lazy-LOAD: raw per-file unified diff chunks. The app/server render a single body only when
  // the renderer asks for that file, avoiding a full diff2html render before first paint.
  lazyBodyDiffs?: string[];
  // Full source-file records retained by the host when lazyLoad is enabled. Electron parses this once
  // into a main-process map and serves one file per request; the browser server keeps a bulk fallback.
  lazySourceData?: string;
};

export type VerificationRun = {
  commands: string[];
  failed: boolean;
  skipped: boolean;
  logPath?: string;
};

export type ReviewFileState = {
  path: string;
  signature: string;
};
