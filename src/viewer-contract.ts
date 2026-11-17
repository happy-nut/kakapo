import type { ProjectLayout } from "./project-layout.js";
import type { ReviewFileState, SourceFile } from "./types.js";

/** Element ids of the JSON islands embedded in the review document. */
export const REVIEW_ISLAND = {
  meta: "review-meta",
  i18n: "i18n-data",
  sourceFiles: "source-files-data",
  fileStates: "file-state-data",
  httpEnv: "http-env-data",
  projectLayout: "project-layout-data",
} as const;

export type ReviewIslandId = (typeof REVIEW_ISLAND)[keyof typeof REVIEW_ISLAND];

export type ReviewMetaDataset = {
  watch: "true" | "false";
  signature: string;
  generatedAt: string;
  lazy: "true" | "false";
  lazyLoad: "true" | "false";
};

export type SourceFilesIsland = SourceFile[];
export type FileStatesIsland = ReviewFileState[];
export type HttpEnvIsland = Record<string, Record<string, string>>;
export type ProjectLayoutIsland = ProjectLayout;
