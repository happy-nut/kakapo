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
  deferred?: boolean;
  changedLines: number[];
  signature: string;
  symlink?: true;
  skippedReason?: string;
  skippedKind?: "missing" | "missingRevision" | "missingTarget" | "imageLarge" | "binary" | "large" | "budget" | "notFile" | "unreadable";
  skippedDetail?: string;
  image?: string;
  media?: { mime: string; kind: "image" | "video" | "audio" | "pdf" };
  vcs?: "new" | "edited" | "staged";
  library?: true;
};

export type WhitespaceMode = "none" | "trim" | "all";

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
  bodyFile?: string;
  bodyParts?: HttpBodyPart[];
  boundary?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  noRedirect?: boolean;
  noCookieJar?: boolean;
  auth?: { type: "basic" | "digest"; user: string; password: string };
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
  bodyBase64?: string;
  bytes?: number;
  redirects?: string[];
  cookies?: string[];
  error?: string;
  durationMs: number;
};

export type WebSocketTranscriptEntry = {
  direction: "open" | "out" | "in" | "close";
  text: string;
  at: number;
};

export type WebSocketSendRequest = {
  url: string;
  protocols?: string[];
  messages: { text?: string; waitForServer?: boolean }[];
  timeoutMs?: number;
  idleMs?: number;
};

export type WebSocketSendResult = {
  ok: boolean;
  transcript: WebSocketTranscriptEntry[];
  durationMs: number;
  error?: string;
};

export type HttpAttachment = {
  ok: boolean;
  text?: string;
  bytes?: number;
  error?: string;
};

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
  module?: string;
};

export type DiffTreeNode = {
  name: string;
  path: string;
  children: Map<string, DiffTreeNode>;
  file?: DiffFile;
  fileIndex?: number;
  firstHunk?: number;
  module?: string;
};

export type CompareState = {
  mode: "local" | "staged" | "ahead" | "incoming" | "manual";
  left: string;
  right: string;
  count?: number;
};

export type DiffReviewResult = {
  path: string;
  url: string;
  files: number;
  hunks: number;
};

export type DiffReviewUpdate = {
  signature: string;
  generatedAt: string;
  diffContainer: string;
  changesPanel: string;
  filesTree: string;
  reviewStatus: string;
  compareBanner: string;
  fileStates: ReviewFileState[];
  sourceFilesMeta: SourceFile[];
  httpEnvironments: Record<string, Record<string, string>>;
};

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
  reviewBase?: string;
  reviewTarget?: string;
  reviewUpstream?: string;
  watchSignature: string;
  update?: DiffReviewUpdate;
  lazyBodies?: string[];
  lazyBodyDiffs?: string[];
  lazySourceData?: string;
  lazySourceFiles?: SourceFile[];
  fullIndexDeferred?: boolean;
};

export type ReviewFileState = {
  path: string;
  signature: string;
};
