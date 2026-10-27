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
   *
   * "find" is a searching surface that owns the keyboard while it is up: the ⌘F bar, and the Find in
   * Files dialog, whose three modifier toggles below take letters that mean something else in the window
   * behind it. That is sound rather than lucky — the dialog consumes every key while it is open
   * (KEY_OWNERS in 05-keymap.js), so the window-level chord cannot fire underneath it.
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
  { id: "revealInTree", keys: ["⌥F1", "⌘↑"], where: "any", i18n: "kbd.revealInTree" },
  { id: "rowActions", keys: ["⌥Enter"], where: "tree", i18n: "kbd.rowActions", fixed: "structural" },
  { id: "closeDialog", keys: ["Esc"], where: "any", i18n: "kbd.closeDialog", fixed: "structural" },

  // ---- Navigation ---------------------------------------------------------------------------------
  { id: "nextChange", keys: ["F7"], where: "any", i18n: "kbd.nextChange" },
  { id: "prevChange", keys: ["⇧F7"], where: "any", i18n: "kbd.prevChange" },
  { id: "nextComment", keys: ["F8", "⇧F8"], where: "any", i18n: "kbd.nextComment" },
  { id: "gotoDiagnostic", keys: ["F2", "⇧F2"], where: "code", i18n: "kbd.gotoDiagnostic" },
  // IntelliJ's Show Error Description (⌃F1): the message of the problem the caret is on, in full and from
  // the keyboard. The gutter already carries it in a dwell tooltip, which is a mouse affordance.
  { id: "errorDescription", keys: ["⌘F1"], where: "code", i18n: "kbd.errorDescription" },
  // IntelliJ's Problems tool window, on its own chord. The diagnostics were always here; what was missing
  // was asking about more than the one file on screen.
  { id: "problemsView", keys: ["⌘6"], where: "any", i18n: "kbd.problemsView" },
  // Quick Documentation (F1 on IntelliJ's own Mac keymap) and Expression Type (⌃⇧P). One `textDocument/
  // hover` answers both — this app asked the server eight questions and none of them was "what IS this".
  { id: "quickDoc", keys: ["F1"], where: "code", i18n: "kbd.quickDoc" },
  { id: "expressionType", keys: ["⌘⇧P"], where: "code", i18n: "kbd.expressionType" },
  { id: "filesChangesTab", keys: ["⌘1", "⌘0"], where: "any", i18n: "kbd.filesChangesTab" },
  { id: "sidebarNavigate", keys: ["↑↓", "Enter"], where: "tree", i18n: "kbd.sidebarNavigate", fixed: "structural" },
  { id: "sidebarContent", keys: ["Tab", "⇧Tab"], where: "any", i18n: "kbd.sidebarContent", fixed: "structural" },
  { id: "findInFile", keys: ["⌘F"], where: "any", i18n: "kbd.findInFile" },
  { id: "findNextPrev", keys: ["⌘G", "⌘⇧G"], where: "find", i18n: "kbd.findNextPrev" },
  // The same step, from inside the find box, where Enter is what a search field answers to. It had no row
  // at all: the two buttons beside the box spelled "↵" and "⇧↵" themselves, which is the one thing this
  // table exists to stop. Structural — a search field's Enter is a convention of the surface, not a
  // preference, and the find box reads it directly rather than through a rebind.
  { id: "findEnter", keys: ["↵", "⇧↵"], where: "find", i18n: "kbd.findEnter", fixed: "structural" },
  { id: "findInFiles", keys: ["⌘⇧F"], where: "any", i18n: "kbd.findInFiles" },
  { id: "recentFiles", keys: ["⌘E"], where: "any", i18n: "kbd.recentFiles" },
  { id: "searchExtensions", keys: ["⌥E"], where: "any", i18n: "kbd.searchExtensions" },
  { id: "excludeSearchNoise", keys: ["⌥P"], where: "any", i18n: "kbd.excludeSearchNoise" },
  // IntelliJ's three Find in Files modifiers — `Cc`, `W`, `.*`. One ripgrep flag each (src/search.ts),
  // and without them a reviewer hunting a pattern across a repository had to leave kakapo to do it.
  // Match case is ⌥M rather than IntelliJ's mnemonic C: ⌥C is Compare against a ref, and a window-level
  // chord owns every surface in this table — the dialog would shadow it rather than share it.
  { id: "searchMatchCase", keys: ["⌥M"], where: "find", i18n: "kbd.searchMatchCase" },
  { id: "searchWholeWords", keys: ["⌥W"], where: "find", i18n: "kbd.searchWholeWords" },
  { id: "searchRegex", keys: ["⌥X"], where: "find", i18n: "kbd.searchRegex" },
  // IntelliJ's Find in Files scope selector: In Project / Project Production Files / Project Test Files /
  // Module. It has no chord there (it is a dropdown), and a dropdown inside a dialog that owns the
  // keyboard needs one here, so ⌥S cycles it — beside ⌥M/⌥W/⌥X, which are the toggles next to it.
  { id: "searchScope", keys: ["⌥S"], where: "find", i18n: "kbd.searchScope" },
  // IntelliJ's Search In Selection (ToggleFindInSelection, ⌃⌥E in both the default and the Mac keymap),
  // which narrows the in-file find to the block the reviewer had selected when they pressed ⌘F. ⌃ folds
  // into ⌘ in this table, so it lands on ⌘⌥E — free, and beside the three toggles it sits next to.
  { id: "findInSelection", keys: ["⌘⌥E"], where: "find", i18n: "kbd.findInSelection" },
  // IntelliJ's Search History, which its find toolbar opens as a dropdown from the field (⌥↓). A bar one
  // line wide has nowhere to put a dropdown, so the same keys step through it in place. The chord is shared
  // with the code surface's next/previous symbol and only answers here while the find FIELD has the
  // keyboard — which is the same thing that stops IntelliJ's editor from seeing it.
  { id: "findHistory", keys: ["⌥↓", "⌥↑"], where: "find", i18n: "kbd.findHistory" },
  // IntelliJ's Show Usages is ⌃⌥F7 and its Declaration or Usages is ⌘B; this popup is the answer to both,
  // so it answers to both chords rather than being reached by only one of them.
  { id: "defUsages", keys: ["⌘B", "⌘⌥F7"], where: "code", i18n: "kbd.defUsages" },
  // IntelliJ's Find Usages: the same answer grouped by what each usage IS, which is the question ⌘B's flat
  // popup cannot take. Its own chord, ⌥F7.
  { id: "findUsages", keys: ["⌥F7"], where: "code", i18n: "kbd.findUsages" },
  // IntelliJ's Find Usages in File (⌃F7) and Highlight Usages in File (⌃⇧F7), which are one action here:
  // paint this file's occurrences, writes apart from reads. The chords used to be a second spelling of
  // F8/⇧F8's comment stepping — a duplicate that cost IntelliJ's two in-file usage keys to keep.
  { id: "highlightUsages", keys: ["⌘F7", "⌘⇧F7"], where: "code", i18n: "kbd.highlightUsages" },
  // IntelliJ's next/previous occurrence of the element under the caret (⌃⌥↓/⌃⌥↑), which works whether or
  // not the highlight is up.
  { id: "nextPrevOccurrence", keys: ["⌘⌥↓", "⌘⌥↑"], where: "code", i18n: "kbd.nextPrevOccurrence" },
  // ---- The usage view's two toolbars ---------------------------------------------------------------
  // IntelliJ's usage view is not a list, it is a tree divided by what the files ARE, and the division is
  // a stack of grouping rules with ranks (UsageGroupingRulesDefaultRanks): non-code(0), scope(100),
  // usage type(200), module(300), directory(400), file(500). Each rank is a toggle in its Group By
  // toolbar, and beside it a filtering toolbar hides read accesses, write accesses or imports.
  //
  // The chords are IntelliJ's own, from `$default.xml` rather than the Mac keymap: that file spells the
  // groupings ⌃⌥-something, which arrives here as ⌘⌥-something and lands on nothing already taken. The
  // Mac keymap's plain ⌃M/⌃P/⌃T would have become ⌘M/⌘P/⌘T, and ⌘P is already the patch-set selector.
  //
  // One of those chords has to be read carefully: `$default.xml` gives UsageGrouping.Module TWO
  // keystrokes, ⌃⌥M and ⌃⌥P, and names the directory rule ⌃⌥D (UsageGrouping.DirectoryStructure). ⌃⌥P
  // is therefore the module's second spelling, not the directory's — this table used to have the
  // directory on ⌘⌥P, which is the module chord said twice.
  //
  // Two deviations, both forced: Flatten Modules is ⌃⌥O there and ⌘⌥O is Go to Symbol here, so it sits on
  // the module chord plus ⇧ (the ⌘F7/⌘⇧F7 pairing this app already uses, spelled in the order
  // shortcutModifiers builds: ⌘⇧⌥); and Production/Test has no
  // chord in IntelliJ at all — it is toolbar-only — so ⌘⌥S is this app's choice.
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
  // IntelliJ's Go to Class. Not on its ⌘O — that opens a folder here, and a desktop app's ⌘O is not a
  // chord to take — so it sits one modifier away from Go to Symbol, which is what it is a filter of.
  { id: "goToClass", keys: ["⌥O"], where: "any", i18n: "kbd.goToClass" },
  // IntelliJ's Go to Related Symbol. Its ⌃⌘↑ folds onto ⌘↑, which reveals the file in the sidebar here.
  { id: "relatedSymbol", keys: ["⌥G"], where: "any", i18n: "kbd.relatedSymbol" },
  // IntelliJ's Go to Custom Region, on its own chord.
  { id: "customRegion", keys: ["⌘⌥."], where: "code", i18n: "kbd.customRegion" },
  // IntelliJ's Jump to Last Change, on its own chord. F7 steps the review; this stays in the file.
  { id: "lastChange", keys: ["⌘⇧Backspace"], where: "code", i18n: "kbd.lastChange" },
  // The third hierarchy. IntelliJ puts the method hierarchy on ⌃⇧H, which folds onto ⌘⇧H — already the
  // type hierarchy here, because IntelliJ's ⌃H folds onto ⌘H and macOS owns that one (Hide). The whole
  // family is therefore shifted by one, and this is the chord left over.
  { id: "methodHierarchy", keys: ["⌘⇧M"], where: "code", i18n: "kbd.methodHierarchy" },
  { id: "goToDef", keys: ["⌘↓"], where: "code", i18n: "kbd.goToDef" },
  // IntelliJ's Quick Definition, on both of the chords it answers to there: the definition's own code
  // without going to it, which is the difference from ⌘↓.
  { id: "quickDefinition", keys: ["⌥Space", "⌘Y"], where: "code", i18n: "kbd.quickDefinition" },
  // IntelliJ's Go to Type Declaration, its structure popup and its Recent Locations, on IntelliJ's own
  // chords. Next/previous symbol is the one that could not keep its chord: this table folds Ctrl into ⌘
  // (one spelling for both platforms), so ⌃↓ and ⌘↓ are the same row — and ⌘↓ is Go to Definition.
  { id: "typeDeclaration", keys: ["⌘⇧B"], where: "code", i18n: "kbd.typeDeclaration" },
  { id: "fileStructure", keys: ["⌘F12"], where: "code", i18n: "kbd.fileStructure" },
  { id: "nextPrevSymbol", keys: ["⌥↓", "⌥↑"], where: "code", i18n: "kbd.nextPrevSymbol" },
  { id: "recentLocations", keys: ["⌘⇧E"], where: "any", i18n: "kbd.recentLocations" },
  // ⇧⌘O (IntelliJ's Go to File) is Open in New Window here, which is a desktop-app convention worth
  // keeping; ⌘P is the other chord every editor uses for "go to a file by name".
  { id: "searchFiles", keys: ["⌘P"], where: "any", i18n: "kbd.searchFiles" },
  // IntelliJ's Search Everywhere, on its own chord. A double tap is spelled as a chord here and
  // recognised by the one matcher (00-shortcuts.js) — not by a second handler with its own timing.
  { id: "searchEverywhere", keys: ["⇧⇧"], where: "any", i18n: "kbd.searchEverywhere" },
  // IntelliJ's Find Action (⌃⇧A). Cheap here because the commands are already this table: the list is a
  // search over it and running one is the call the keypress makes.
  { id: "findAction", keys: ["⌘⇧A"], where: "any", i18n: "kbd.findAction" },
  // The file's counterpart: its test, or the source the test is for. Convention-based, as IntelliJ's is.
  { id: "goToTest", keys: ["⌘⇧T"], where: "any", i18n: "kbd.goToTest" },
  // The two hierarchies. IntelliJ puts them on ⌃H and ⌃⌥H; this table spells Control and Command the
  // same way, so they take the ⌘ forms — and pressing the same chord again flips the direction, which is
  // what IntelliJ's two tabs do. ⌘H went to macOS (Hide), which is why the type hierarchy is on ⌘⇧H.
  //
  // The call hierarchy could not keep ⌘⌥H either, for the same kind of reason one step further out:
  // `role: "appMenu"` (app-main.ts) expands to Hide / **Hide Others (⌘⌥H)** / Show All, and a menu
  // accelerator is consumed before any renderer keydown runs — so that chord hid every other application
  // and the hierarchy never opened. IntelliJ's own macOS keymap moves Call Hierarchy to ⌘⇧H, which is the
  // type hierarchy here, so this takes IntelliJ's other name for it: the mnemonic in "Call Hierarch_y".
  { id: "typeHierarchy", keys: ["⌘⇧H"], where: "code", i18n: "kbd.typeHierarchy" },
  { id: "callHierarchy", keys: ["⌘⇧Y"], where: "code", i18n: "kbd.callHierarchy" },
  { id: "goToSuper", keys: ["⌘U"], where: "code", i18n: "kbd.goToSuper" },
  // A place to come back to, with nothing to say about it — IntelliJ's F3. A comment is the right thing
  // when there IS something to say, and kakapo already keeps those beside the code.
  { id: "toggleBookmark", keys: ["F3"], where: "code", i18n: "kbd.toggleBookmark" },
  { id: "showBookmarks", keys: ["⌘F3"], where: "any", i18n: "kbd.showBookmarks" },
  // IntelliJ's mnemonic bookmarks: a digit per line. On ⌥ rather than ⌃ for the same reason as above —
  // ⌘1/⌘0/⌘9 are already the Files panel, the Changes panel and history.
  { id: "assignBookmark", keys: ["⇧⌥1", "⇧⌥2", "⇧⌥3", "⇧⌥4", "⇧⌥5", "⇧⌥6", "⇧⌥7", "⇧⌥8", "⇧⌥9"], where: "code", i18n: "kbd.assignBookmark" },
  { id: "jumpBookmark", keys: ["⌥1", "⌥2", "⌥3", "⌥4", "⌥5", "⌥6", "⌥7", "⌥8", "⌥9"], where: "any", i18n: "kbd.jumpBookmark" },
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
  // The two other things a reviewer does with a .http file: run the whole file as the sequence it is
  // written as, and take one request out of kakapo as a cURL command.
  { id: "runHttpAll", keys: ["⌘⇧Enter"], where: "code", i18n: "kbd.runHttpAll" },
  { id: "copyHttpCurl", keys: ["⌘⇧C"], where: "code", i18n: "kbd.copyHttpCurl" },
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
  // Copying out of this panel IS the hand-off, so it files what it copied — one card, or the whole panel
  // after ⌘A. It used to copy and leave everything in the review, which meant the next hand-off carried
  // the same comments again. "menu", not "structural": ⌘C is the Edit menu's accelerator (app-main.ts
  // keeps the standard role so real text fields still work), so the page cannot rebind it.
  { id: "mergedCopy", keys: ["⌘C"], where: "merged", i18n: "kbd.mergedCopy", fixed: "menu" },
  { id: "maximizePanel", keys: ["⌘⇧'"], where: "merged", i18n: "kbd.maximizePanel" },

  // ---- History ------------------------------------------------------------------------------------
  { id: "copyRevision", keys: ["⌘C"], where: "history", i18n: "kbd.copyRevision" },
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
    "nextChange", "prevChange", "nextComment", "gotoDiagnostic", "errorDescription", "problemsView",
    "quickDoc", "expressionType", "filesChangesTab",
    "sidebarNavigate", "sidebarContent", "findInFile", "findNextPrev", "findEnter", "findInFiles", "recentFiles",
    "searchExtensions", "excludeSearchNoise", "searchMatchCase", "searchWholeWords", "searchRegex", "searchScope",
    "findInSelection", "findHistory",
    "searchFiles", "searchEverywhere", "findAction", "goToTest",
    "defUsages", "findUsages", "highlightUsages", "nextPrevOccurrence", "goToImplementation",
    "workspaceSymbol", "goToClass", "relatedSymbol", "customRegion", "lastChange", "goToDef", "quickDefinition", "typeDeclaration", "fileStructure", "nextPrevSymbol", "recentLocations", "typeHierarchy", "callHierarchy", "methodHierarchy", "goToSuper",
    "toggleBookmark", "showBookmarks", "assignBookmark", "jumpBookmark",
    "toggleFold", "prevNextTab", "cursorBackForward",
  ] },
  // IntelliJ's own two groups: "Usage View Grouping" and "Usage View Filtering" (UsageViewBundle). They
  // are one category here because they are one panel — nine toggles over the same list.
  { i18n: "settings.kbd.cat.usages", ids: [
    "findUsages", "usageGroupScope", "usageGroupType", "usageGroupModule", "usageFlattenModules",
    "usageGroupDirectory", "usageGroupFile", "usageFilterRead", "usageFilterWrite", "usageFilterImports",
    "excludeSearchNoise",
  ] },
  { i18n: "settings.kbd.cat.editor", ids: [
    "moveCaret", "wordJump", "lineStartEnd", "extendSelection", "selectEditor", "copyLocation",
    "pageUpDown", "expandDiffFold", "runHttp", "runHttpAll", "copyHttpCurl", "toggleRendered",
    "toggleLineWrap", "closeTab",
  ] },
  { i18n: "settings.kbd.cat.review", ids: [
    "toggleViewed", "addComment", "allComments", "undoCommentRemoval", "ignoreWhitespace", "saveComment",
    "reviewStops", "editComment", "deleteComment", "stepComments", "mergedCopy", "mergedSend", "maximizePanel",
  ] },
  { i18n: "settings.kbd.cat.history", ids: [
    "openHistory", "historyNavigate", "copyRevision", "pageUpDown",
  ] },
];

export function shortcutById(id: string): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}
