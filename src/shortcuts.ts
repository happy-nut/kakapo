
export interface ShortcutDef {
  id: string;
  keys: string[];
  i18n: string;
  where: "any" | "code" | "tree" | "merged" | "history" | "find" | "launcher";
  fixed?: "structural" | "menu";
}

export const MODAL_SURFACES: string[] = ["launcher"];

export const SHORTCUTS: ShortcutDef[] = [
  { id: "openFolder", keys: ["⌘O"], where: "any", i18n: "kbd.openFolder", fixed: "menu" },
  { id: "openNewWindow", keys: ["⌘⇧O"], where: "any", i18n: "kbd.openNewWindow", fixed: "menu" },
  { id: "openSettings", keys: ["⌘,"], where: "any", i18n: "kbd.openSettings", fixed: "structural" },
  { id: "zoomIn", keys: ["⌘+", "⌘="], where: "any", i18n: "kbd.zoomIn", fixed: "menu" },
  { id: "zoomOut", keys: ["⌘-"], where: "any", i18n: "kbd.zoomOut", fixed: "menu" },
  { id: "zoomReset", keys: ["⌘0"], where: "any", i18n: "kbd.zoomReset", fixed: "menu" },
  { id: "openHistory", keys: ["⌘9"], where: "any", i18n: "kbd.openHistory" },
  { id: "compareMode", keys: ["⌥A", "⌥U", "⌥T", "⌥N"], where: "any", i18n: "kbd.compareMode" },
  { id: "compareRef", keys: ["⌥C"], where: "any", i18n: "kbd.compareRef" },
  { id: "openPullRequest", keys: ["⌥L"], where: "any", i18n: "kbd.openPullRequest" },
  { id: "patchSetStep", keys: ["⌥]", "⌥["], where: "any", i18n: "kbd.patchSetStep" },
  { id: "gotoLine", keys: ["⌘L"], where: "code", i18n: "kbd.gotoLine" },
  { id: "revealInTree", keys: ["⌥F1", "⌘↑"], where: "any", i18n: "kbd.revealInTree" },
  { id: "editSource", keys: ["⌘↓", "F4"], where: "any", i18n: "kbd.editSource" },
  { id: "rowActions", keys: ["⌥Enter"], where: "tree", i18n: "kbd.rowActions", fixed: "structural" },
  { id: "closeDialog", keys: ["Esc"], where: "any", i18n: "kbd.closeDialog", fixed: "structural" },

  { id: "nextChange", keys: ["F7"], where: "any", i18n: "kbd.nextChange" },
  { id: "prevChange", keys: ["⇧F7"], where: "any", i18n: "kbd.prevChange" },
  { id: "nextComment", keys: ["F8", "⇧F8"], where: "any", i18n: "kbd.nextComment" },
  { id: "gotoDiagnostic", keys: ["F2", "⇧F2"], where: "code", i18n: "kbd.gotoDiagnostic" },
  { id: "errorDescription", keys: ["⌘F1"], where: "code", i18n: "kbd.errorDescription" },
  { id: "problemsView", keys: ["⌘6"], where: "any", i18n: "kbd.problemsView" },
  { id: "endpointsView", keys: ["⌘7"], where: "any", i18n: "kbd.endpointsView" },
  { id: "quickDoc", keys: ["F1"], where: "code", i18n: "kbd.quickDoc" },
  { id: "expressionType", keys: ["⌘⇧P"], where: "code", i18n: "kbd.expressionType" },
  { id: "filesChangesTab", keys: ["⌘1", "⌘2"], where: "any", i18n: "kbd.filesChangesTab" },
  { id: "sidebarNavigate", keys: ["↑↓", "Enter"], where: "tree", i18n: "kbd.sidebarNavigate", fixed: "structural" },
  { id: "sidebarContent", keys: ["Tab", "⇧Tab"], where: "any", i18n: "kbd.sidebarContent", fixed: "structural" },
  { id: "findInFile", keys: ["⌘F"], where: "any", i18n: "kbd.findInFile" },
  { id: "findNextPrev", keys: ["⌘G", "⌘⇧G"], where: "find", i18n: "kbd.findNextPrev" },
  { id: "findEnter", keys: ["↵", "⇧↵"], where: "find", i18n: "kbd.findEnter", fixed: "structural" },
  { id: "findInFiles", keys: ["⌘⇧F"], where: "any", i18n: "kbd.findInFiles" },
  { id: "recentFiles", keys: ["⌘E"], where: "any", i18n: "kbd.recentFiles" },
  { id: "searchExtensions", keys: ["⌥E"], where: "any", i18n: "kbd.searchExtensions" },
  { id: "excludeSearchNoise", keys: ["⌥P"], where: "any", i18n: "kbd.excludeSearchNoise" },
  { id: "searchMatchCase", keys: ["⌥M"], where: "find", i18n: "kbd.searchMatchCase" },
  { id: "searchWholeWords", keys: ["⌥W"], where: "find", i18n: "kbd.searchWholeWords" },
  { id: "searchRegex", keys: ["⌥X"], where: "find", i18n: "kbd.searchRegex" },
  { id: "searchScope", keys: ["⌥S"], where: "find", i18n: "kbd.searchScope" },
  { id: "findInSelection", keys: ["⌘⌥E"], where: "find", i18n: "kbd.findInSelection" },
  { id: "searchChangesOnly", keys: ["⌥D"], where: "find", i18n: "kbd.searchChangesOnly" },
  { id: "findHistory", keys: ["⌥↓", "⌥↑"], where: "find", i18n: "kbd.findHistory" },
  { id: "defUsages", keys: ["⌘⌥F7"], where: "code", i18n: "kbd.defUsages" },
  { id: "findUsages", keys: ["⌥F7"], where: "code", i18n: "kbd.findUsages" },
  { id: "highlightUsages", keys: ["⌘F7", "⌘⇧F7"], where: "code", i18n: "kbd.highlightUsages" },
  { id: "nextPrevOccurrence", keys: ["⌘⌥↓", "⌘⌥↑"], where: "code", i18n: "kbd.nextPrevOccurrence" },
  { id: "usageGroupScope", keys: ["⌘⌥S"], where: "find", i18n: "kbd.usageGroupScope" },
  { id: "usageGroupType", keys: ["⌘⌥T"], where: "find", i18n: "kbd.usageGroupType" },
  { id: "usageGroupModule", keys: ["⌘⌥M"], where: "find", i18n: "kbd.usageGroupModule" },
  { id: "usageFlattenModules", keys: ["⌘⇧⌥M"], where: "find", i18n: "kbd.usageFlattenModules" },
  { id: "usageGroupDirectory", keys: ["⌘⌥D"], where: "find", i18n: "kbd.usageGroupDirectory" },
  { id: "usageGroupFile", keys: ["⌘⌥F"], where: "find", i18n: "kbd.usageGroupFile" },
  { id: "usageFilterRead", keys: ["⌘⌥R"], where: "find", i18n: "kbd.usageFilterRead" },
  { id: "usageFilterWrite", keys: ["⌘⌥W"], where: "find", i18n: "kbd.usageFilterWrite" },
  { id: "usageFilterImports", keys: ["⌘⌥I"], where: "find", i18n: "kbd.usageFilterImports" },

  { id: "goToImplementation", keys: ["⌘⌥B"], where: "code", i18n: "kbd.goToImplementation" },
  { id: "workspaceSymbol", keys: ["⌘⌥O"], where: "any", i18n: "kbd.workspaceSymbol" },
  { id: "goToClass", keys: ["⌥O"], where: "any", i18n: "kbd.goToClass" },
  { id: "relatedSymbol", keys: ["⌥G"], where: "any", i18n: "kbd.relatedSymbol" },
  { id: "customRegion", keys: ["⌘⌥."], where: "code", i18n: "kbd.customRegion" },
  { id: "lastChange", keys: ["⌘⇧Backspace"], where: "code", i18n: "kbd.lastChange" },
  { id: "methodHierarchy", keys: ["⌘⇧M"], where: "code", i18n: "kbd.methodHierarchy" },
  { id: "goToDef", keys: ["⌘B"], where: "code", i18n: "kbd.goToDef" },
  { id: "quickDefinition", keys: ["⌥Space", "⌘Y"], where: "code", i18n: "kbd.quickDefinition" },
  { id: "typeDeclaration", keys: ["⌘⇧B"], where: "code", i18n: "kbd.typeDeclaration" },
  { id: "fileStructure", keys: ["⌘F12"], where: "code", i18n: "kbd.fileStructure" },
  { id: "nextPrevSymbol", keys: ["⌘⌥]", "⌘⌥["], where: "code", i18n: "kbd.nextPrevSymbol" },
  { id: "extendShrinkSelection", keys: ["⌥↑", "⌥↓"], where: "code", i18n: "kbd.extendShrinkSelection" },
  { id: "recentLocations", keys: ["⌘⇧E"], where: "any", i18n: "kbd.recentLocations" },
  { id: "searchFiles", keys: ["⌘P"], where: "any", i18n: "kbd.searchFiles" },
  { id: "searchEverywhere", keys: ["⇧⇧"], where: "any", i18n: "kbd.searchEverywhere" },
  { id: "seNextTab", keys: ["Tab"], where: "launcher", i18n: "kbd.seNextTab", fixed: "structural" },
  { id: "sePrevTab", keys: ["⇧Tab"], where: "launcher", i18n: "kbd.sePrevTab", fixed: "structural" },
  { id: "findAction", keys: ["⌘⇧A"], where: "any", i18n: "kbd.findAction" },
  { id: "goToTest", keys: ["⌘⇧T"], where: "any", i18n: "kbd.goToTest" },
  { id: "typeHierarchy", keys: ["⌘⇧H"], where: "code", i18n: "kbd.typeHierarchy" },
  { id: "callHierarchy", keys: ["⌘⇧Y"], where: "code", i18n: "kbd.callHierarchy" },
  { id: "goToSuper", keys: ["⌘U"], where: "code", i18n: "kbd.goToSuper" },
  { id: "toggleBookmark", keys: ["F3"], where: "code", i18n: "kbd.toggleBookmark" },
  { id: "showBookmarks", keys: ["⌘F3"], where: "any", i18n: "kbd.showBookmarks" },
  { id: "assignBookmark", keys: ["⇧⌥1", "⇧⌥2", "⇧⌥3", "⇧⌥4", "⇧⌥5", "⇧⌥6", "⇧⌥7", "⇧⌥8", "⇧⌥9"], where: "code", i18n: "kbd.assignBookmark" },
  { id: "jumpBookmark", keys: ["⌥1", "⌥2", "⌥3", "⌥4", "⌥5", "⌥6", "⌥7", "⌥8", "⌥9"], where: "any", i18n: "kbd.jumpBookmark" },
  { id: "toggleFold", keys: ["⌘."], where: "code", i18n: "kbd.toggleFold" },
  { id: "collapseAll", keys: ["⌘⇧-"], where: "code", i18n: "kbd.collapseAll" },
  { id: "expandAll", keys: ["⌘⌥="], where: "code", i18n: "kbd.expandAll" },
  { id: "collapseRecursively", keys: ["⌘⌥-"], where: "code", i18n: "kbd.collapseRecursively" },
  { id: "diffFileStep", keys: ["⌘⌥→", "⌘⌥←"], where: "code", i18n: "kbd.diffFileStep" },
  { id: "prevNextTab", keys: ["⌘⇧[", "⌘⇧]"], where: "code", i18n: "kbd.prevNextTab" },
  { id: "cursorBackForward", keys: ["⌘[", "⌘]"], where: "code", i18n: "kbd.cursorBackForward" },

  { id: "moveCaret", keys: ["←↑↓→"], where: "code", i18n: "kbd.moveCaret", fixed: "structural" },
  { id: "wordJump", keys: ["⌥←", "⌥→"], where: "code", i18n: "kbd.wordJump", fixed: "structural" },
  { id: "lineStartEnd", keys: ["⌘←", "⌘→"], where: "code", i18n: "kbd.lineStartEnd", fixed: "structural" },
  { id: "extendSelection", keys: ["⇧←↑↓→"], where: "code", i18n: "kbd.extendSelection", fixed: "structural" },
  { id: "selectByWord", keys: ["⇧⌥←", "⇧⌥→"], where: "code", i18n: "kbd.selectByWord", fixed: "structural" },
  { id: "selectToLineEdge", keys: ["⌘⇧←", "⌘⇧→"], where: "code", i18n: "kbd.selectToLineEdge", fixed: "structural" },
  { id: "selectEditor", keys: ["⌘A"], where: "code", i18n: "kbd.selectEditor" },
  { id: "copyLocation", keys: ["⌘K"], where: "code", i18n: "kbd.copyLocation" },
  { id: "copyAsPatch", keys: ["⇧⌥P"], where: "any", i18n: "kbd.copyAsPatch" },
  { id: "compareClipboard", keys: ["⇧⌥C"], where: "any", i18n: "kbd.compareClipboard" },
  { id: "pageUpDown", keys: ["PageUp", "PageDown"], where: "code", i18n: "kbd.pageUpDown", fixed: "structural" },
  { id: "expandDiffFold", keys: ["Space"], where: "code", i18n: "kbd.expandDiffFold", fixed: "structural" },
  { id: "runHttp", keys: ["⌘Enter", "⌥Enter"], where: "code", i18n: "kbd.runHttp" },
  { id: "runHttpAll", keys: ["⌘⇧Enter"], where: "code", i18n: "kbd.runHttpAll" },
  { id: "copyHttpCurl", keys: ["⌘⇧C"], where: "code", i18n: "kbd.copyHttpCurl" },
  { id: "toggleRendered", keys: ["⌥R"], where: "code", i18n: "kbd.toggleRendered" },

  { id: "showWhitespace", keys: ["⇧⌥W"], where: "code", i18n: "kbd.showWhitespace" },
  { id: "indentGuides", keys: ["⇧⌥I"], where: "code", i18n: "kbd.indentGuides" },
  { id: "stickyLines", keys: ["⇧⌥S"], where: "code", i18n: "kbd.stickyLines" },
  { id: "focusMode", keys: ["⇧⌥F"], where: "code", i18n: "kbd.focusMode" },
  { id: "essentialHighlighting", keys: ["⇧⌥E"], where: "any", i18n: "kbd.essentialHighlighting" },
  { id: "alignChanges", keys: ["⇧⌥A"], where: "any", i18n: "kbd.alignChanges" },
  { id: "codeVision", keys: ["⇧⌥V"], where: "code", i18n: "kbd.codeVision" },
  { id: "inlayHints", keys: ["⇧⌥H"], where: "code", i18n: "kbd.inlayHints" },
  { id: "toggleLineWrap", keys: ["⌥W"], where: "code", i18n: "kbd.toggleLineWrap" },
  { id: "closeTab", keys: ["⌘W"], where: "code", i18n: "kbd.closeTab", fixed: "menu" },

  { id: "toggleViewed", keys: ["Space"], where: "tree", i18n: "kbd.toggleViewed", fixed: "structural" },
  { id: "addComment", keys: ["?"], where: "code", i18n: "kbd.addComment" },
  { id: "allComments", keys: ["⌘⇧/"], where: "any", i18n: "kbd.allComments" },
  { id: "undoCommentRemoval", keys: ["⌘Z"], where: "any", i18n: "kbd.undoCommentRemoval" },
  { id: "ignoreWhitespace", keys: ["⌘⇧W"], where: "any", i18n: "kbd.ignoreWhitespace", fixed: "menu" },
  { id: "saveComment", keys: ["⌘Enter"], where: "merged", i18n: "kbd.saveComment", fixed: "structural" },
  { id: "reviewStops", keys: ["↑", "↓"], where: "code", i18n: "kbd.reviewStops", fixed: "structural" },
  { id: "editComment", keys: ["e"], where: "code", i18n: "kbd.editComment", fixed: "structural" },
  { id: "deleteComment", keys: ["Backspace", "Delete"], where: "merged", i18n: "kbd.deleteComment", fixed: "structural" },
  { id: "stepComments", keys: ["↑", "↓"], where: "merged", i18n: "kbd.stepComments", fixed: "structural" },
  { id: "openComment", keys: ["Enter"], where: "merged", i18n: "kbd.openComment", fixed: "structural" },
  { id: "mergedSend", keys: ["⌥Enter"], where: "merged", i18n: "kbd.mergedSend", fixed: "structural" },
  { id: "mergedCopy", keys: ["⌘C"], where: "merged", i18n: "kbd.mergedCopy", fixed: "menu" },
  { id: "maximizePanel", keys: ["⌘⇧'"], where: "merged", i18n: "kbd.maximizePanel" },

  { id: "copyRevision", keys: ["⌘C"], where: "history", i18n: "kbd.copyRevision" },
  { id: "historyNavigate", keys: ["↑↓", "Enter"], where: "history", i18n: "kbd.historyNavigate", fixed: "structural" },
  { id: "historyRange", keys: ["⇧↑", "⇧↓"], where: "history", i18n: "kbd.historyRange", fixed: "structural" },
];

export const MENU_OWNED_CHORDS: string[] = [
  "⌘+", "⌘-", "⌘0", "⌘=", "⌘O", "⌘W", "⌘⇧=", "⌘⇧O", "⌘⇧W",
];

export const MENU_OWNED_CHORDS_MAC: string[] = ["⌘H", "⌘M", "⌘Q", "⌘⌥H"];

export const SHORTCUT_GROUPS: { i18n: string; ids: string[] }[] = [
  { i18n: "settings.kbd.cat.app", ids: [
    "openFolder", "openNewWindow", "openSettings", "openHistory", "compareMode", "compareRef",
    "zoomIn", "zoomOut", "zoomReset",
    "openPullRequest", "patchSetStep",
    "gotoLine", "revealInTree", "rowActions", "closeDialog",
  ] },
  { i18n: "settings.kbd.cat.nav", ids: [
    "nextChange", "prevChange", "nextComment", "gotoDiagnostic", "errorDescription", "problemsView",
    "quickDoc", "expressionType", "endpointsView", "filesChangesTab",
    "sidebarNavigate", "sidebarContent", "findInFile", "findNextPrev", "findEnter", "findInFiles", "recentFiles",
    "searchExtensions", "excludeSearchNoise", "searchMatchCase", "searchWholeWords", "searchRegex", "searchScope",
    "findInSelection", "searchChangesOnly", "findHistory",
    "searchFiles", "searchEverywhere", "seNextTab", "sePrevTab", "findAction", "goToTest",
    "defUsages", "findUsages", "highlightUsages", "nextPrevOccurrence", "goToImplementation",
    "workspaceSymbol", "goToClass", "relatedSymbol", "customRegion", "lastChange", "goToDef", "editSource", "quickDefinition", "typeDeclaration", "fileStructure", "nextPrevSymbol", "extendShrinkSelection", "recentLocations", "typeHierarchy", "callHierarchy", "methodHierarchy", "goToSuper",
    "toggleBookmark", "showBookmarks", "assignBookmark", "jumpBookmark",
    "toggleFold", "collapseAll", "expandAll", "collapseRecursively", "diffFileStep", "prevNextTab", "cursorBackForward",
  ] },
  { i18n: "settings.kbd.cat.usages", ids: [
    "findUsages", "usageGroupScope", "usageGroupType", "usageGroupModule", "usageFlattenModules",
    "usageGroupDirectory", "usageGroupFile", "usageFilterRead", "usageFilterWrite", "usageFilterImports",
    "excludeSearchNoise",
  ] },
  { i18n: "settings.kbd.cat.editor", ids: [
    "moveCaret", "wordJump", "lineStartEnd", "extendSelection", "selectByWord", "selectToLineEdge", "selectEditor", "copyLocation",
    "pageUpDown", "expandDiffFold", "copyAsPatch", "compareClipboard", "runHttp", "runHttpAll", "copyHttpCurl", "toggleRendered",
    "toggleLineWrap", "showWhitespace", "indentGuides", "stickyLines", "focusMode",
    "essentialHighlighting", "alignChanges", "codeVision", "inlayHints", "closeTab",
  ] },
  { i18n: "settings.kbd.cat.review", ids: [
    "toggleViewed", "addComment", "allComments", "undoCommentRemoval", "ignoreWhitespace", "saveComment",
    "reviewStops", "editComment", "deleteComment", "stepComments", "openComment", "mergedCopy", "mergedSend", "maximizePanel",
  ] },
  { i18n: "settings.kbd.cat.history", ids: [
    "openHistory", "historyNavigate", "historyRange", "copyRevision", "pageUpDown",
  ] },
];

let shortcutOverrides: Record<string, string[]> = {};
export function setShortcutOverrides(next: unknown): void {
  shortcutOverrides = {};
  if (!next || typeof next !== "object") return;
  for (const [id, keys] of Object.entries(next as Record<string, unknown>)) {
    if (!Array.isArray(keys)) continue;
    const clean = keys.map((key) => (typeof key === "string" && key.trim() ? key : ""));
    if (clean.some(Boolean)) shortcutOverrides[id] = clean;
  }
}

export function electronAcceleratorFor(id: string, index = 0): string | undefined {
  const override = shortcutOverrides[id];
  const chord = (Array.isArray(override) ? override[index] : undefined) || shortcutById(id)?.keys[index];
  if (!chord || typeof chord !== "string") return undefined;
  let rest = chord;
  const parts: string[] = [];
  if (rest.startsWith("⌘")) { parts.push("CommandOrControl"); rest = rest.slice(1); }
  if (rest.startsWith("⇧")) { parts.push("Shift"); rest = rest.slice(1); }
  if (rest.startsWith("⌥")) { parts.push("Alt"); rest = rest.slice(1); }
  const NAMED: Record<string, string> = {
    "↑": "Up", "↓": "Down", "←": "Left", "→": "Right", "Enter": "Return", "Esc": "Escape",
    Backspace: "Backspace", Delete: "Delete", Tab: "Tab", Space: "Space", "+": "Plus",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  };
  if (NAMED[rest]) return [...parts, NAMED[rest]].join("+");
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(rest)) return [...parts, rest].join("+");
  if (!/^[\x20-\x7e]$/.test(rest)) return undefined;
  return [...parts, rest.toUpperCase()].join("+");
}

export function shortcutById(id: string): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}
