// The typed contract for the build -> viewer boundary: the `<script type="application/json">` "islands" the
// review HTML embeds (render.ts) and the plain-JS viewer parses back by element id (viewer/01-core.js). The
// viewer is untyped JS and can't import this, so render.ts emits ids from REVIEW_ISLAND and
// test/viewer-contract.test.mjs asserts the viewer's literal ids still match — keeping producer and consumer
// honest against one source of truth. Any perf work that reshapes these payloads changes them HERE first.
import type { ReviewFileState, SourceFile } from "./types.js";

/** Element ids of the JSON islands embedded in the review document. */
export const REVIEW_ISLAND = {
  meta: "review-meta",
  i18n: "i18n-data",
  sourceFiles: "source-files-data",
  fileStates: "file-state-data",
  httpEnv: "http-env-data",
  xterm: "xterm-code",
} as const;

export type ReviewIslandId = (typeof REVIEW_ISLAND)[keyof typeof REVIEW_ISLAND];

/** #review-meta carries flags on its dataset (its body is an empty `{}`); the viewer reads them as strings. */
export type ReviewMetaDataset = {
  watch: "true" | "false";
  signature: string;
  generatedAt: string;
  lazy: "true" | "false";
  lazyLoad: "true" | "false";
};

/** #source-files-data: the file index. In lazyLoad mode content/image are stripped (see sourceFileMetadata). */
export type SourceFilesIsland = SourceFile[];
/** #file-state-data: per-file review state (viewed flags, comment counts, ...). */
export type FileStatesIsland = ReviewFileState[];
/** #http-env-data: HTTP-client environments — environment name -> (variable -> value). */
export type HttpEnvIsland = Record<string, Record<string, string>>;
