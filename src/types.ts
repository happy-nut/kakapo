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
  // `old mode`/`new mode` in the header with no content change: the file is in the diff and has no hunks.
  modeChanged?: boolean;
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
  // Desktop lazy reviews can keep only metadata after the project-wide source cache budget is reached.
  // The main process materializes this record from disk when the reviewer explicitly opens the file.
  deferred?: boolean;
  changedLines: number[];
  signature: string;
  skippedReason?: string;
  // Rendered preview for raster image files: a data: URI embedded by collectSourceFiles
  // (gated by IMAGE_MAX_BYTES). Present only for images; absent for text/binary files.
  image?: string;
  // Working-tree git status for sidebar coloring: untracked(new)=red, modified=blue, staged(git add)=green.
  vcs?: "new" | "edited" | "staged";
  // Read on demand for library navigation (a dependency, a stdlib module, a bundled type stub) rather than
  // taken from the project index. Opens read-only and carries no comments; see library-source.ts.
  library?: true;
};

/**
 * One `multipart/form-data` part. A part whose content is a file is named rather than inlined, because the
 * renderer would have to turn its bytes into a string to pass them here — and a PNG does not survive that.
 * Main reads the file (repo-confined) and writes the bytes into the body it assembles.
 */
/** How much whitespace difference counts as a difference. See readUnifiedDiff. */
export type WhitespaceMode = "none" | "trim" | "all";

/**
 * How a changed line is marked: `word` highlights the characters that actually differ inside it (what
 * diff2html emits and IntelliJ defaults to), `line` tints the whole line only, `none` tints nothing and
 * leaves the +/- gutter as the signal. Renderer-side: it is CSS over markup that is always emitted, so
 * changing it needs no rebuild.
 */
export type DiffHighlightMode = "word" | "line" | "none";

export type HttpBodyPart = {
  headers: Record<string, string>;
  text?: string;
  file?: string;
};

export type HttpSendRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** `< ./body.json`: main reads it, so a binary body stays bytes instead of going through a JS string. */
  bodyFile?: string;
  /** `multipart/form-data` parts, assembled by main against `boundary`. */
  bodyParts?: HttpBodyPart[];
  boundary?: string;
  /** `# @timeout 600` / `# @connection-timeout 2 m`, already in milliseconds. */
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** `# @no-redirect`: hand the 3xx back instead of following it. */
  noRedirect?: boolean;
  /** `# @no-cookie-jar`: keep this response's cookies out of the jar. */
  noCookieJar?: boolean;
  /**
   * `Authorization: Basic user pass` / `Digest user pass` — IntelliJ's space-separated form, which is NOT a
   * valid header value. The parser splits it out so main can encode Basic, or run Digest's 401 challenge.
   */
  auth?: { type: "basic" | "digest"; user: string; password: string };
  /**
   * The selected environment's `SSLConfiguration`, as written in http-client.private.env.json. Paths
   * only: main reads the certificate and key itself, from inside the review, at send time.
   */
  ssl?: {
    clientCertificate?: string;
    clientCertificateKey?: string;
    hasCertificatePassphrase?: boolean;
    verifyHostCertificate?: boolean;
  };
};

export type HttpSendResult = {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Set instead of `body` when the response is not text — the renderer shows a byte count, not mojibake. */
  bodyBase64?: string;
  /** Byte length on the wire; `body.length` counts UTF-16 units, which is not the same number. */
  bytes?: number;
  /** URLs actually followed, so a reviewer can see where a request ended up. */
  redirects?: string[];
  /** Cookies this response set (and, unless `noCookieJar`, that were saved to the jar). */
  cookies?: string[];
  error?: string;
  durationMs: number;
};

/** One line of a WebSocket exchange, as the response panel reads it back. */
export type WebSocketTranscriptEntry = {
  direction: "open" | "out" | "in" | "close";
  text: string;
  /** Milliseconds since the request started — the order and the pace are both part of the answer. */
  at: number;
};

export type WebSocketSendRequest = {
  url: string;
  /** `Sec-WebSocket-Protocol`, the one header a browser-shaped WebSocket client can carry. */
  protocols?: string[];
  /** The messages the file lists, in order. `waitForServer` is `=== wait-for-server`. */
  messages: { text?: string; waitForServer?: boolean }[];
  /** `# @timeout`, as the whole exchange's deadline. */
  timeoutMs?: number;
  /** How long a silent socket is given before the exchange is called finished. */
  idleMs?: number;
};

export type WebSocketSendResult = {
  ok: boolean;
  transcript: WebSocketTranscriptEntry[];
  durationMs: number;
  error?: string;
};

/** A file the .http runner asks main to read: an external body, a handler script, or a multipart part. */
export type HttpAttachment = {
  ok: boolean;
  text?: string;
  bytes?: number;
  error?: string;
};

/** `>> out.json` / `>>! out.json`. `$historyFolder`-prefixed paths land in kakapo's own user-data mirror. */
export type HttpSaveRequest = {
  path: string;
  force?: boolean;
  body: string;
};

export type HttpSaveResult = {
  ok: boolean;
  path?: string;
  error?: string;
};

export type SourceTreeNode = {
  name: string;
  path: string;
  children: Map<string, SourceTreeNode>;
  file?: SourceFile;
  // Set on the node that IS a module: its name is the module's, not the folder's, and it sorts to the top.
  module?: string;
};

// Folder-hierarchy node for the Changes navigation. Leaves carry the diff file plus the flat index/hunk
// offsets the diff caret navigation keys rows by; interior folders leave those undefined.
export type DiffTreeNode = {
  name: string;
  path: string;
  children: Map<string, DiffTreeNode>;
  file?: DiffFile;
  fileIndex?: number;
  firstHunk?: number;
  // Set on the node that IS a module: its name is the module's, not the folder's, and it sorts to the top.
  module?: string;
};

// What the diff on screen is actually comparing. A clean worktree silently moves the review to the branch
// point — or, with nothing of your own left to read, to the tracking branch — and until now the screen looked
// identical either way: "am I looking at my changes, or at the remote's?" had no answer on it. Derived in
// buildDiffReview from what it has already resolved, so it costs no extra git call.
//
//   local     dirty worktree — HEAD vs the files as they are now
//   staged    --staged — HEAD vs the index
//   ahead     clean, unpushed commits — branch point vs HEAD
//   incoming  clean and nothing unpushed — HEAD vs the tracking branch (what the remote has and you don't)
//   manual    an explicit --base/--target, or a patch-set pick in the compare bar
//
// `right` is empty for local/staged: the right-hand side is the live working tree / index rather than a ref,
// and naming it is the renderer's job (it is the one word here that gets translated).
export type CompareState = {
  mode: "local" | "staged" | "ahead" | "incoming" | "manual";
  left: string;
  right: string;
  count?: number; // commits ahead / behind — the number the mode's name is counting
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
  reviewStatus: string; // .review-status innerHTML — the compare pill
  compareBanner: string; // #compare-why innerHTML; empty in every mode but `incoming`
  fileStates: ReviewFileState[];
  sourceFilesMeta: SourceFile[]; // metadata only when lazyLoad (content fetched separately)
  httpEnvironments: Record<string, Record<string, string>>;
};

// Heavy project-wide navigation data is deliberately kept out of the initial review HTML. Electron and
// the watch server return this payload only when the renderer first opens Files / Quick Open (or restores
// a source tab), so repositories with thousands of files do not pay the transfer + parse cost at startup.
export type ProjectIndexPayload = {
  signature: string;
  filesTree: string;
  sourceFilesMeta: SourceFile[];
};

export type DiffReviewBuild = {
  html: string;
  files: number;
  hunks: number;
  signature: string;
  generatedAt: string;
  // Actual base revision used for this build. When a clean branch is ahead of its upstream this is the
  // merge-base, allowing context expansion to read the same revision as the rendered diff.
  reviewBase?: string;
  // Right/new side revision for an A→B compare (undefined = compared against the working tree).
  reviewTarget?: string;
  // Tracking ref that selected reviewBase automatically. Electron watches it so a later push clears the
  // already-reviewed commit range without requiring an app restart.
  reviewUpstream?: string;
  // Compact payload for in-place refresh (Electron watch / serve poll); see DiffReviewUpdate.
  update?: DiffReviewUpdate;
  // Phase 2 lazy-LOAD: per-file diff body HTML, served on demand (IPC / HTTP) instead of embedded,
  // so the initial HTML stays small. Indexed by file order. Empty unless lazyLoad was requested.
  lazyBodies?: string[];
  // Phase 2c lazy-LOAD: raw per-file unified diff chunks. The app/server render a single body only when
  // the renderer asks for that file, avoiding a full diff2html render before first paint.
  lazyBodyDiffs?: string[];
  // Serialized full source records retained for the browser server's bulk compatibility endpoint.
  lazySourceData?: string;
  // Native in-process form for Electron/benchmarks. Avoids stringify + parse of the entire source index;
  // lazySourceData remains the transport form used by the browser watch server.
  lazySourceFiles?: SourceFile[];
  // Diff-first startup: true when this build indexed ONLY the changed files (deferFullIndex was honored),
  // so the caller knows a second full-index pass is still owed to the renderer. False for a full build.
  fullIndexDeferred?: boolean;
};

export type ReviewFileState = {
  path: string;
  signature: string;
};
