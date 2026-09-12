// Standalone reviews embed source in the initial HTML, so keep their per-file DOM preview conservative.
export const SOURCE_MAX_FILE_BYTES = 220_000;
// Electron fetches one source file at a time. Keep a finite ceiling so accidentally opening generated or
// minified artifacts cannot exhaust the single Review renderer.
export const SOURCE_MAX_LAZY_FILE_BYTES = 10_000_000;
export const SOURCE_MAX_TOTAL_BYTES = 50_000_000;
export const SOURCE_MAX_FILES = 20000;
// Raster images up to this size are embedded as base64 data URIs for inline preview. Kept in step with
// SOURCE_MAX_LAZY_FILE_BYTES so opening a normal screenshot/diagram in the tree previews instead of showing
// "Source preview unavailable".
export const IMAGE_MAX_BYTES = 10_000_000;

export const TITLEBAR_H = 38;

// Every UI scale the app offers, smallest first. One list: the Settings dropdown renders it (01-core.js keeps
// its own copy, pinned to this one by a test) and ⌘+ / ⌘− step through it, so a keystroke can never land on a
// size the dropdown cannot show as selected.
export const UI_SCALES = [0.9, 1, 1.1, 1.25, 1.5];
