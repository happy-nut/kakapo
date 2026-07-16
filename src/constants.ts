// Legacy project-local artifacts stay excluded from source indexing, but monacori no longer creates or
// writes this directory. Runtime state lives below the application's per-workspace userData mirror.
export const FLOW_DIR = ".monacori";
// Standalone reviews embed source in the initial HTML, so keep their per-file DOM preview conservative.
export const SOURCE_MAX_FILE_BYTES = 220_000;
// Electron fetches one source file at a time. Keep a finite ceiling so accidentally opening generated or
// minified artifacts cannot exhaust the single Review renderer.
export const SOURCE_MAX_LAZY_FILE_BYTES = 10_000_000;
export const SOURCE_MAX_TOTAL_BYTES = 50_000_000;
export const SOURCE_MAX_FILES = 20000;
// Raster images up to this size are embedded as base64 data URIs for inline preview.
export const IMAGE_MAX_BYTES = 2_000_000;
