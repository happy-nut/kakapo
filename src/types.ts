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

export type DiffReviewBuild = {
  html: string;
  files: number;
  hunks: number;
  signature: string;
  generatedAt: string;
  // Phase 2 lazy-LOAD: per-file diff body HTML, served on demand (IPC / HTTP) instead of embedded,
  // so the initial HTML stays small. Indexed by file order. Empty unless lazyLoad was requested.
  lazyBodies?: string[];
  // Phase 2b lazy-LOAD: full source files JSON (with content), served on demand so the HTML embeds
  // only metadata. undefined unless lazyLoad.
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
