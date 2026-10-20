// ===== The shortcut table =========================================================================
// Every keyboard shortcut the app has, spelled once. Before this file a shortcut was written down in four
// places that nothing kept in agreement: the chord inside an `if` in some viewer slice, the row in the
// Settings sheet, the `data-keyhint` on whatever button does the same thing, and the README. Renaming a key
// meant finding all four, and the sheet had already drifted — ⌘K, ⌥F1, ⌘Z, F2 and ⌘F7 all worked and none
// of them were documented.
//
// The table is data, not behaviour: the viewer bundle gets it verbatim (scripts/copy-viewer-assets.mjs
// emits it as a slice) and attaches the handlers by id, the Settings sheet renders from it, and
// `data-keyhint` is filled from it. A rebind is then one string in one place.
//
// `keys` is a list because one action can answer to more than one combination — F8/⇧F8 are the two
// directions of comment stepping, ⌥A/⌥U name the two compare modes outright. The handler is told which
// one fired.

export interface ShortcutDef {
  id: string;
  /** Combinations that invoke it, in the display spelling. Index is passed to the handler. */
  keys: string[];
  /** Translation key for the row's label. The English text lives in i18n.ts with every other string. */
  i18n: string;
  /**
   * The surface it acts on. Two actions may share a combination when they act on different surfaces —
   * Space ticks a sidebar row and expands diff context, and neither has ever been ambiguous — so this is
   * what makes a conflict check mean something. "any" is the whole window.
   */
  where: "any" | "code" | "tree" | "merged" | "history" | "find";
  /**
   * Why this one cannot be rebound. Absent means it can be.
   *   "structural" — Esc, Tab, the arrows: conventions of the surface they act on, not preferences.
   *   "menu"       — an Electron menu accelerator; the OS menu owns it, not the page.
   */
  fixed?: "structural" | "menu";
}

export const SHORTCUTS: ShortcutDef[] = [
  // ---- App ----------------------------------------------------------------------------------------
  { id: "openFolder", keys: ["⌘O"], where: "any", i18n: "kbd.openFolder", fixed: "menu" },
  { id: "openNewWindow", keys: ["⌘⇧O"], where: "any", i18n: "kbd.openNewWindow", fixed: "menu" },
  { id: "openSettings", keys: ["⌘,"], where: "any", i18n: "kbd.openSettings", fixed: "structural" },
  { id: "openHistory", keys: ["⌘9"], where: "any", i18n: "kbd.openHistory" },
  { id: "compareMode", keys: ["⌥A", "⌥U"], where: "any", i18n: "kbd.compareMode" },
  { id: "compareRef", keys: ["⌥C"], where: "any", i18n: "kbd.compareRef" },
  { id: "gotoLine", keys: ["⌘L"], where: "code", i18n: "kbd.gotoLine" },
  { id: "revealInTree", keys: ["⌥F1"], where: "any", i18n: "kbd.revealInTree" },
  { id: "rowActions", keys: ["⌥Enter"], where: "tree", i18n: "kbd.rowActions", fixed: "structural" },
  { id: "closeDialog", keys: ["Esc"], where: "any", i18n: "kbd.closeDialog", fixed: "structural" },

  // ---- Navigation ---------------------------------------------------------------------------------
  { id: "nextChange", keys: ["F7"], where: "any", i18n: "kbd.nextChange" },
  { id: "prevChange", keys: ["⇧F7"], where: "any", i18n: "kbd.prevChange" },
  { id: "nextComment", keys: ["F8", "⇧F8"], where: "any", i18n: "kbd.nextComment" },
  { id: "commentStepAlt", keys: ["⌘F7", "⌘⇧F7"], where: "any", i18n: "kbd.commentStepAlt" },
  { id: "gotoDiagnostic", keys: ["F2", "⇧F2"], where: "code", i18n: "kbd.gotoDiagnostic" },
  { id: "filesChangesTab", keys: ["⌘1", "⌘0"], where: "any", i18n: "kbd.filesChangesTab" },
  { id: "sidebarNavigate", keys: ["↑↓", "Enter"], where: "tree", i18n: "kbd.sidebarNavigate", fixed: "structural" },
  { id: "sidebarContent", keys: ["Tab", "⇧Tab"], where: "any", i18n: "kbd.sidebarContent", fixed: "structural" },
  { id: "findInFile", keys: ["⌘F"], where: "any", i18n: "kbd.findInFile" },
  { id: "findNextPrev", keys: ["⌘G", "⌘⇧G"], where: "find", i18n: "kbd.findNextPrev" },
  { id: "findInFiles", keys: ["⌘⇧F"], where: "any", i18n: "kbd.findInFiles" },
  { id: "recentFiles", keys: ["⌘E"], where: "any", i18n: "kbd.recentFiles" },
  { id: "searchExtensions", keys: ["⌥E"], where: "any", i18n: "kbd.searchExtensions" },
  { id: "excludeSearchNoise", keys: ["⌥P"], where: "any", i18n: "kbd.excludeSearchNoise" },
  { id: "defUsages", keys: ["⌘B"], where: "code", i18n: "kbd.defUsages" },
  { id: "goToImplementation", keys: ["⌘⌥B"], where: "code", i18n: "kbd.goToImplementation" },
  { id: "workspaceSymbol", keys: ["⌘⌥O"], where: "any", i18n: "kbd.workspaceSymbol" },
  { id: "goToDef", keys: ["⌘↓"], where: "code", i18n: "kbd.goToDef" },
  { id: "toggleFold", keys: ["⌘."], where: "code", i18n: "kbd.toggleFold" },
  { id: "prevNextTab", keys: ["⌘⇧[", "⌘⇧]"], where: "code", i18n: "kbd.prevNextTab" },
  { id: "cursorBackForward", keys: ["⌘[", "⌘]"], where: "code", i18n: "kbd.cursorBackForward" },

  // ---- Editor -------------------------------------------------------------------------------------
  { id: "moveCaret", keys: ["←↑↓→"], where: "code", i18n: "kbd.moveCaret", fixed: "structural" },
  { id: "wordJump", keys: ["⌥←", "⌥→"], where: "code", i18n: "kbd.wordJump", fixed: "structural" },
  { id: "lineStartEnd", keys: ["⌘←", "⌘→"], where: "code", i18n: "kbd.lineStartEnd", fixed: "structural" },
  { id: "extendSelection", keys: ["⇧←↑↓→"], where: "code", i18n: "kbd.extendSelection", fixed: "structural" },
  { id: "selectEditor", keys: ["⌘A"], where: "code", i18n: "kbd.selectEditor" },
  { id: "copyLocation", keys: ["⌘K"], where: "code", i18n: "kbd.copyLocation" },
  { id: "pageUpDown", keys: ["PageUp", "PageDown"], where: "code", i18n: "kbd.pageUpDown", fixed: "structural" },
  { id: "expandDiffFold", keys: ["Space"], where: "code", i18n: "kbd.expandDiffFold", fixed: "structural" },
  // One key, two contexts — like compareMode's ⌥A/⌥U, this is one row because it is one chord: in a .http
  // file ⌥Enter runs the request, and on a line a language server flagged it drafts the change request that
  // asks an agent to fix it (05-keymap.js). The second was reachable, documented nowhere, and named by a
  // label that said only "Run HTTP request" — so the sheet and both READMEs described half of the key.
  { id: "runHttp", keys: ["⌘Enter", "⌥Enter"], where: "code", i18n: "kbd.runHttp" },
  { id: "toggleRendered", keys: ["⌥R"], where: "code", i18n: "kbd.toggleRendered" },
  { id: "toggleLineWrap", keys: ["⌥W"], where: "code", i18n: "kbd.toggleLineWrap" },
  { id: "closeTab", keys: ["⌘W"], where: "code", i18n: "kbd.closeTab", fixed: "menu" },

  // ---- Review -------------------------------------------------------------------------------------
  { id: "toggleViewed", keys: ["Space"], where: "tree", i18n: "kbd.toggleViewed", fixed: "structural" },
  { id: "addComment", keys: ["?"], where: "code", i18n: "kbd.addComment" },
  { id: "allComments", keys: ["⌘⇧/"], where: "any", i18n: "kbd.allComments" },
  { id: "undoCommentRemoval", keys: ["⌘Z"], where: "any", i18n: "kbd.undoCommentRemoval" },
  { id: "ignoreWhitespace", keys: ["⌘⇧W"], where: "any", i18n: "kbd.ignoreWhitespace", fixed: "menu" },
  { id: "saveComment", keys: ["⌘Enter"], where: "merged", i18n: "kbd.saveComment", fixed: "structural" },
  { id: "reviewStops", keys: ["↑", "↓"], where: "code", i18n: "kbd.reviewStops", fixed: "structural" },
  { id: "editComment", keys: ["e"], where: "merged", i18n: "kbd.editComment", fixed: "structural" },
  { id: "deleteComment", keys: ["Backspace", "Delete"], where: "merged", i18n: "kbd.deleteComment", fixed: "structural" },
  { id: "stepComments", keys: ["⌥↑", "⌥↓"], where: "merged", i18n: "kbd.stepComments", fixed: "structural" },
  // Was "send to pane" back when the app embedded a terminal. The terminal was removed; the row survived
  // with nothing answering it, so the sheet advertised a chord that did nothing. Its surviving descendant
  // is the hand-off — copying the review out and filing it away is how a review leaves kakapo now — so the
  // chord goes there rather than being deleted. Structural like its merged siblings: the dock's own
  // keydown owns these, and none of them read a rebind.
  { id: "mergedSend", keys: ["⌥Enter"], where: "merged", i18n: "kbd.mergedSend", fixed: "structural" },
  { id: "maximizePanel", keys: ["⌘⇧'"], where: "merged", i18n: "kbd.maximizePanel" },

  // ---- History ------------------------------------------------------------------------------------
  { id: "historyNavigate", keys: ["↑↓", "Enter"], where: "history", i18n: "kbd.historyNavigate", fixed: "structural" },
];

// The Settings sheet, in order. Grouping lives here rather than on each row because History is a summary
// of one surface and so repeats two rows that already appear above it — a `group` field on the row could
// not have said that.
export const SHORTCUT_GROUPS: { i18n: string; ids: string[] }[] = [
  { i18n: "settings.kbd.cat.app", ids: [
    "openFolder", "openNewWindow", "openSettings", "openHistory", "compareMode", "compareRef",
    "gotoLine", "revealInTree", "rowActions", "closeDialog",
  ] },
  { i18n: "settings.kbd.cat.nav", ids: [
    "nextChange", "prevChange", "nextComment", "commentStepAlt", "gotoDiagnostic", "filesChangesTab",
    "sidebarNavigate", "sidebarContent", "findInFile", "findNextPrev", "findInFiles", "recentFiles",
    "searchExtensions", "excludeSearchNoise", "defUsages", "goToImplementation", "workspaceSymbol",
    "goToDef", "toggleFold", "prevNextTab", "cursorBackForward",
  ] },
  { i18n: "settings.kbd.cat.editor", ids: [
    "moveCaret", "wordJump", "lineStartEnd", "extendSelection", "selectEditor", "copyLocation",
    "pageUpDown", "expandDiffFold", "runHttp", "toggleRendered", "toggleLineWrap", "closeTab",
  ] },
  { i18n: "settings.kbd.cat.review", ids: [
    "toggleViewed", "addComment", "allComments", "undoCommentRemoval", "ignoreWhitespace", "saveComment",
    "reviewStops", "editComment", "deleteComment", "stepComments", "mergedSend", "maximizePanel",
  ] },
  { i18n: "settings.kbd.cat.history", ids: [
    "openHistory", "historyNavigate", "pageUpDown",
  ] },
];

export function shortcutById(id: string): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}
