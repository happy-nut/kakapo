// ===== Who owns the keyboard right now =============================================================
// One decision, asked by every shortcut below, instead of each branch re-deriving "is a modal up / is a
// panel focused / am I in a text field". Ordered most-capturing first:
//
//   modal    a surface that owns the keyboard outright — settings, go-to-line. Nothing else fires.
//   history  the History overlay: its own keys, and the window-level ones (it is a view, not a text box).
//   panel    a focused dock or terminal pane. Every key is going INTO it; only window-level ones survive.
//   field    a focused input/textarea/contenteditable anywhere else. Same rule as `panel`.
//   content  the diff/source review itself. Everything is available.
//
// A shortcut is then described by the scopes it may fire in, not by where it happens to sit in this file —
// "did I put this above or below the focus guard?" is what kept going wrong.
function isTextEntry(el) {
  return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}
function inTextField() { return isTextEntry(document.activeElement); }
function keyboardScope() {
  var settings = document.getElementById('settings-modal');
  if (settings && !settings.classList.contains('hidden')) return 'modal';
  if (document.getElementById('goto-line')) return 'modal'; // owns the keys until Enter/Esc
  var history = document.getElementById('history-view');
  if (history && !history.classList.contains('hidden')) return 'history';
  if (isDockFocused()) return 'panel'; // merged/memo dock, or a terminal pane (see 08-dock.js)
  if (inTextField()) return 'field';
  return 'content';
}
// Kept as the name the content-level handlers (here and in 11-render-http.js) already ask by: everything
// below the stand-down point is review navigation, which belongs to the review only.
function isFloatingModalOpen() { return keyboardScope() !== 'content'; }

// Cmd+0/Cmd+1 mean "take me to the tree", and the floating terminal sits on top of exactly what they reveal.
// Leaving it parked there made the shortcut look like it had done nothing, so opening either view puts the
// terminal away. Only when it is actually open — this must never toggle it back on.
function closeTerminalForViewSwitch() {
  var api = window.__kakapoTerminal;
  if (!api || typeof api.isOpen !== 'function' || typeof api.close !== 'function') return;
  if (api.isOpen()) api.close();
}

// Cmd+0/1 and their rail icons are focus-aware. From content they reveal/focus the matching tree; only a
// repeated activation while that tree owns the logical focus collapses it. A collapsed tree expands first.
function activateChangesView(navigateToDiff) {
  closeTerminalForViewSwitch();
  if (isDiffViewVisible()) {
    if (reviewSidebarCollapsed) { setReviewSidebarCollapsed(false, { focusSidebar: true }); return; }
    if (treeFocusIndex >= 0) { toggleReviewSidebar(); return; }
    setTab('changes');
    focusOpenFileInTree();
    return;
  }
  // Outside the diff, keep the current content visible and move navigation to Changes. Enter on a row
  // performs the actual diff transition, matching the existing Cmd+0 -> arrows -> Enter workflow.
  setSourceSidebarCollapsed(false);
  setReviewSidebarCollapsed(false);
  if (navigateToDiff) showDiffView(false);
  setTab('changes');
  focusOpenFileInTree();
}

function activateFilesView() {
  closeTerminalForViewSwitch();
  if (isSourceViewerVisible()) {
    if (sourceSidebarCollapsed) { setSourceSidebarCollapsed(false, { focusSidebar: true }); return; }
    if (treeFocusIndex >= 0) { toggleSourceSidebar(); return; }
    setTab('files');
    focusOpenFileInTree();
    return;
  }
  setSourceSidebarCollapsed(false);
  if (isDiffViewVisible()) {
    var wrapper = diffActiveWrapper();
    var name = wrapper && wrapper.querySelector('.d2h-file-name');
    var path = (diffCursor && diffCursor.path) || (name ? (name.textContent || '').trim() : '');
    if (path && sourceByPath.has(path)) {
      openSourceFile(path);
    } else {
      // Never leave the UI in the invalid hybrid state "Files sidebar + Diff content". A deferred project
      // index can still discover the path after the view opens; until then show the source placeholder.
      showSourceView();
      if (path && REVIEW_LAZY_LOAD && !projectIndexLoaded) {
        ensureProjectIndex().then(function () {
          if (sourceByPath.has(path)) openSourceFile(path);
          focusOpenFileInTree();
        });
      }
    }
  }
  if (!isSourceViewerVisible()) showSourceView();
  setTab('files');
  focusOpenFileInTree();
}
// ===== Who gets the key FIRST ======================================================================
// The surfaces that own the keyboard outright while they are up, most-capturing first. A row's handle()
// returns true when it consumed the key and dispatch stops there.
//
// This order used to live in two invisible places at once: which slice registered its listener first (the
// build script's VIEWER_SLICES order) and whether that listener passed `true` for capture. "Capture so
// closing settings wins over other Escape handlers (lightbox / composer)" was a comment in 08-dock.js
// asserting a precedence no reader of 11-render-http.js could see, and the only way to change it was to
// move a file in a build script. It is a row order now — the same treatment WINDOW_SHORTCUTS gave the
// chords, for the same reason: adding a surface should be a row, not a fourth thing to get right.
//
// Owners are looked up through `typeof` because every slice that owns one loads after this file.
// NOT here, and correctly so: the go-to-line prompt (13-goto.js) and the comment composer (08-dock.js)
// both scope their listener to their own lifetime or target, so they never race anything.
var KEY_OWNERS = [
  // Settings is the top-most overlay: its Esc beats the lightbox and the composer, and its Cmd+, toggle
  // has to work while it is itself up (keyboardScope reports 'modal' then, standing down everything below).
  { name: 'settings', handle: function (event) { return typeof handleSettingsKey === 'function' && handleSettingsKey(event); } },
  // While a terminal send-mode pick is on screen every key belongs to it, handled or not.
  { name: 'terminal-send-mode', handle: function (event) { return typeof handleTerminalSendModeKey === 'function' && handleTerminalSendModeKey(event); } },
  // A playing note walkthrough (23-annotations.js) owns the arrows — they are how you step it, and the caret
  // they would otherwise move is being driven by the tour anyway. It claims nothing else, so every other key
  // reaches the surfaces below exactly as before.
  { name: 'note-tour', handle: function (event) { return typeof handleTourKey === 'function' && handleTourKey(event); } },
  // Semantic navigation is a caret-local dropdown. It must own arrows/Enter before the persistent sidebar's
  // logical tree focus gets a chance to consume them; otherwise Enter opens the tree row instead of the
  // selected definition when Cmd+B was invoked after Cmd+0/Cmd+1.
  { name: 'semantic-peek', handle: function (event) { return typeof handleSemanticPeekKey === 'function' && handleSemanticPeekKey(event); } },
  // Quick Open / Find in Files is a true modal keyboard scope. Its own handler consumes navigation and
  // dismissal keys, then every other key is stopped from reaching the shortcut router (or later document
  // listeners). Do NOT prevent an unhandled key's default: native input editing such as Cmd/Ctrl+Left/Right,
  // Cmd/Ctrl+A, clipboard shortcuts, and text composition must keep working inside the focused search field
  // without moving the dimmed source/diff caret behind the dialog.
  { name: 'quick-open', handle: function (event) {
    if (quickOpen?.classList.contains('hidden')) return false;
    handleQuickOpenKey(event);
    event.stopImmediatePropagation();
    return true;
  } },
  { name: 'usages', handle: function (event) {
    var box = document.getElementById('usages');
    if (!box || box.classList.contains('hidden')) return false;
    return handleUsagesKey(event);
  } },
  // Cmd/Ctrl+F belongs to the active file surface, not the project-wide quick-open search. It sits above the
  // general focus guard so Enter/Shift+Enter/Esc keep working while its input owns focus.
  { name: 'file-find', handle: function (event) { return typeof handleFileFindKey === 'function' && handleFileFindKey(event); } },
  { name: 'lightbox', handle: function (event) {
    if (event.key !== 'Escape' || !lightboxOpen()) return false;
    event.preventDefault();
    event.stopPropagation();
    closeLightbox();
    return true;
  } },
  { name: 'workspace-hub', handle: function (event) { return typeof handleWorkspaceHubKey === 'function' && handleWorkspaceHubKey(event); } },
];

// The window-level shortcut table (see the dispatch loop inside the keydown listener). A handler returning
// false means "not applicable right now" — the key falls through to the rest of the chain untouched.
var WINDOW_SHORTCUTS = [
  { code: 'Quote', shift: true, run: function () { toggleDockMaximized(); } },
  { code: 'Slash', shift: true, key: '?', run: function () { openMergedView(); } },
  // ⌘⇧P has no dialog of its own: it opens the ⌘E launcher on its Prompts section, so every
  // "pick something and go" surface is one window. A second press closes it.
  { code: 'KeyP', shift: true, key: 'p', run: function () {
    if (quickMode === 'prompts' && quickOpen && !quickOpen.classList.contains('hidden')) closeQuickOpen();
    else openQuickOpen('prompts');
  } },
  { code: 'KeyN', shift: true, key: 'n', run: function () { openMemoView(); } },
  { code: 'Digit9', key: '9', run: function () { if (typeof toggleHistory !== 'function') return false; toggleHistory(); } },
  { code: 'Digit8', key: '8', run: function () { if (typeof toggleImpact !== 'function') return false; toggleImpact(); } },
  // Explain opens no view of its own: it stages the "annotate this diff" prompt in the terminal composer,
  // and the agent's notes land on the diff lines they explain (23-annotations.js).
  { code: 'Digit7', key: '7', run: function () { if (typeof runAnnotatePrompt !== 'function') return false; runAnnotatePrompt(); } },
  // Cmd+0/Cmd+1 mean "take me to the tree", so they close the History overlay first — otherwise the view
  // they activate would be switched invisibly underneath it.
  { code: 'Digit0', key: '0', run: function () { closeHistoryIfOpen(); activateChangesView(false); } },
  { code: 'Digit1', key: '1', run: function () { closeHistoryIfOpen(); activateFilesView(); } },
  // Undo the last comment removal — a Backspace on a selected card in the merged dock deletes one, so the
  // safety net has to reach into that dock. Text surfaces keep their own native undo, and the key is only
  // swallowed when there was actually something to restore.
  { code: 'KeyZ', key: 'z', run: function () {
    if (inTextField() || typeof undoLastCommentRemoval !== 'function') return false;
    return undoLastCommentRemoval() ? undefined : false; // nothing to restore -> let the key through
  } },
];
function closeHistoryIfOpen() {
  if (typeof isHistoryOpen === 'function' && isHistoryOpen() && typeof closeHistory === 'function') closeHistory();
}
// Cmd/Ctrl + the given code (or key, for layouts that report no code), with the modifiers spelled out: a
// shortcut fires only on the exact combination it declares, so Cmd+Shift+P can never answer a plain Cmd+P.
function matchesChord(event, sc) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  if (event.code === sc.code) return !!sc.shift === event.shiftKey;
  if (sc.key === undefined || typeof event.key !== 'string') return false;
  if (event.key.toLowerCase() !== sc.key) return false;
  // A letter/digit `key` still needs the Shift check (Cmd+P must not answer for Cmd+Shift+P). A punctuation
  // one already IS the shifted character — "?" is Shift+/ — so demanding Shift on top of it would be asking
  // for the same modifier twice.
  return !/^[a-z0-9]$/.test(sc.key) || !!sc.shift === event.shiftKey;
}
document.addEventListener('keydown', (event) => {
  for (var oi = 0; oi < KEY_OWNERS.length; oi += 1) {
    // Each owner does its own preventDefault/stopPropagation — Quick Open in particular must NOT prevent an
    // unhandled key's default, so the loop cannot do it on their behalf.
    if (KEY_OWNERS[oi].handle(event)) return;
  }

  // ---- window-level shortcuts -------------------------------------------------------------------
  // These belong to the window, not to whatever has focus, so they fire from a focused dock, a terminal
  // pane or the History overlay too. A true modal (settings, go-to-line) is the one thing that stands them
  // down — it owns the keyboard while it is up. Adding one is a row in this table, not another branch with
  // its own hand-written guard; the eight `!settingsUp &&` conditions this replaces were where the "above
  // or below the focus guard?" mistakes kept happening.
  // `code` is matched first so a non-US layout or an IME can never swallow the combo; `key` is the fallback.
  var scope = keyboardScope();
  if (scope !== 'modal') {
    for (var wi = 0; wi < WINDOW_SHORTCUTS.length; wi += 1) {
      var sc = WINDOW_SHORTCUTS[wi];
      if (!matchesChord(event, sc)) continue;
      if (sc.run(event) !== false) { event.preventDefault(); return; }
    }
  }

  // The bare navigation F-keys sit just above the content stand-down: they move a cursor and never insert
  // text, so a focused text field — a comment composer, which is exactly where you are when the note you
  // want to step to is the reason you are typing — must not swallow them. A focused PANEL still does: the
  // dock and the terminal own their keys outright, and F7 inside the merged dock has always meant nothing.
  if (scope === 'content' || scope === 'field') {
  if (event.key === 'F7' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    // Navigating changes moves the CODE caret, so arrows have to follow it. The sidebar owns arrows while
    // treeFocusIndex >= 0, and nothing here focuses a DOM node inside the diff, so that index survived: after
    // clicking a file in the tree and then pressing F7, the caret moved but arrows still drove the tree.
    // (Not in setDiffCursor — a sidebar CLICK legitimately keeps its row focused while opening the diff.)
    clearTreeFocus();
    const delta = event.shiftKey ? -1 : 1;
    const sourceViewer = document.getElementById('source-viewer');
    // Forward F7 from the source view enters the diff at the open file's own hunk, so the reviewer lands
    // where they were reading. Shift+F7 — and any file with no hunk of its own — falls through to plain
    // prev/next-change navigation across the whole diff.
    if (delta > 0 && sourceViewer && !sourceViewer.classList.contains('hidden')) {
      const sp = sourceViewer.dataset.openPath || '';
      const sourceHunk = firstHunkForPath(sp);
      // Enter the diff at the open file's own hunk — UNLESS it's already viewed. A viewed file's diff body
      // is hidden (display:none), so landing on it blanks the content and F7 appears stuck; fall through to
      // next() instead so we skip to an unviewed change.
      if (sourceHunk >= 0 && !isFileViewed(sp)) {
        setActive(sourceHunk);
        return;
      }
    }
    next(delta);
  }

  // F8 / Shift+F8: step between everything written on the diff — the reviewer's comments AND the agent's
  // notes, one list (see sortedNavThread). The bare-key counterpart of F7/Shift+F7 for hunks: changes on one
  // key, the conversation about them on the next one over. Cmd+F7 below does the same and stays for muscle
  // memory. There used to be a third key, F9, for the agent's notes alone; the two are one timeline now, and
  // a second key for half of it only meant F8 silently skipped the other half.
  if (event.key === 'F8' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    clearTreeFocus(); // stepping to a comment moves the caret, so arrows follow it (see F7 above)
    if (typeof gotoComment === 'function') gotoComment(event.shiftKey ? -1 : 1);
    return;
  }

  }

  // ⌥F1 reveals the open file in the tree from ANY view — it runs BEFORE the isFloatingModalOpen stand-down
  // below so History (and merged/memo docks), which otherwise own the keys, don't swallow it. Only a
  // genuine text-input modal (settings, go-to-line) still keeps it; there the "main panel" isn't focused.
  if (event.key === 'F1' && event.altKey && !event.metaKey && !event.ctrlKey) {
    // "Anything but a true modal" is `scope !== 'modal'` — which is already in hand. This used to re-read the
    // settings overlay and the go-to-line prompt itself, the one branch left doing by hand what keyboardScope
    // exists to answer, and so the one branch that would have gone on disagreeing with it as surfaces changed.
    if (scope !== 'modal' && typeof revealOpenFileInTree === 'function') { event.preventDefault(); revealOpenFileInTree(); return; }
  }

  // Settings overlay (or a focused merged/memo dock) captures keys: stand down the rest of the global
  // shortcuts (F7, Cmd+[/], Cmd+B, …). Each has its own Esc + editing handlers.
  if (isFloatingModalOpen()) return;

  // Cmd/Ctrl+. mirrors an IDE's "toggle fold" at the source caret. The Review renderer folds the
  // innermost multiline brace range. Shift+. remains the distinct merged change-request shortcut above.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.code === 'Period' || event.key === '.')) {
    var foldAe = document.activeElement;
    if (!(foldAe && (foldAe.tagName === 'INPUT' || foldAe.tagName === 'TEXTAREA' || foldAe.tagName === 'SELECT'))
      && typeof toggleCurrentSourceFold === 'function' && toggleCurrentSourceFold()) {
      event.preventDefault();
      return;
    }
  }

  // Cmd/Ctrl+A in the diff/source view selects ONLY that view's content (the browser default reached into
  // the sidebar). In an editable field, let the default select-within-field stand.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.code === 'KeyA' || event.key === 'a' || event.key === 'A')) {
    var aae = document.activeElement;
    if (!(aae && (aae.tagName === 'INPUT' || aae.tagName === 'TEXTAREA' || aae.tagName === 'SELECT')) && selectAllInView()) {
      event.preventDefault();
      return;
    }
  }

  // Cmd/Ctrl+L = go to line (numeric prompt); Cmd/Ctrl+K = copy the caret's file:line. Skip when an
  // editable field owns focus (a comment composer textarea) so we don't hijack the user's typing.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.code === 'KeyL' || event.key === 'l' || event.key === 'L')) {
    var lkae = document.activeElement;
    if (!(lkae && (lkae.tagName === 'INPUT' || lkae.tagName === 'TEXTAREA' || lkae.tagName === 'SELECT'))) {
      event.preventDefault();
      openGotoLine();
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.code === 'KeyK' || event.key === 'k' || event.key === 'K')) {
    var kkae = document.activeElement;
    if (!(kkae && (kkae.tagName === 'INPUT' || kkae.tagName === 'TEXTAREA' || kkae.tagName === 'SELECT'))) {
      event.preventDefault();
      copyCaretLocation();
      return;
    }
  }

  // Tab / Shift+Tab move the "cursor" horizontally between the left sidebar and the right content pane.
  if (event.key === 'Tab') {
    const activeEl = document.activeElement;
    const inField = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
    if (!inField) {
      event.preventDefault();
      if (event.shiftKey) {
        // In the diff view, Shift+Tab toggles the caret between the old/new panes (this change owns
        // Shift+Tab L/R; plain arrows stay in-pane and Cmd/Ctrl+Arrows also cross — see diff nav).
        if (isDiffViewVisible() && diffCursor) {
          const tabSide = diffCursor.side === 'new' ? 'old' : 'new';
          const tabWrap = diffWrapperByPath(diffCursor.path);
          const tabRow = tabWrap ? diffRowAt(tabWrap, tabSide, diffCursor.rowIndex) : null;
          if (isDiffCodeRow(tabRow)) setDiffCursor(diffCursor.path, tabSide, diffCursor.rowIndex, 0, true);
          return;
        }
        focusTree(treeFocusIndex >= 0 ? treeFocusIndex : 0); // ← left: focus sidebar tree
      } else {
        clearTreeFocus(); // → right: hand focus back to the content pane (source caret / diff nav)
        const openPath = document.getElementById('source-viewer')?.dataset.openPath || '';
        if (isSourceViewerVisible() && openPath && (!viewerCursor || viewerCursor.path !== openPath)) {
          setSourceCursor(openPath, viewerCursor ? viewerCursor.lineIndex : 0, 0, false, -1);
        }
      }
      return;
    }
  }

  // (Merged views Cmd/Ctrl+Shift+/ +. and the memo Cmd/Ctrl+Shift+N are handled above the focus guard so
  // they work from inside a dock too.)
  // "?" = question, ">" = change-request composer on the current line/selection (no modifier).
  if (!event.altKey && !event.metaKey && !event.ctrlKey && (event.key === '?' || event.key === '>')) {
    const ce = document.activeElement;
    const inEditable = ce && (ce.tagName === 'INPUT' || ce.tagName === 'TEXTAREA' || ce.tagName === 'SELECT');
    if (!inEditable) {
      event.preventDefault();
      openComposer(event.key === '?' ? 'q' : 'c');
      return;
    }
  }

  // Opt/Alt + Left/Right: word-wise caret jump (source or diff view).
  if (event.altKey && !event.metaKey && !event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    var wae = document.activeElement;
    var wInField = wae && (wae.tagName === 'INPUT' || wae.tagName === 'TEXTAREA' || wae.tagName === 'SELECT');
    if (!wInField && treeFocusIndex < 0) {
      var wdir = event.key === 'ArrowRight' ? 1 : -1;
      if (isSourceViewerVisible() && viewerCursor) { event.preventDefault(); moveSourceWord(wdir, event.shiftKey); return; }
      if (isDiffViewVisible() && diffCursor) { event.preventDefault(); moveDiffWord(wdir, event.shiftKey); return; }
    }
  }

  // PageUp/Down scroll the diff/source view. There's no focusable scroller (the diff caret is a JS cursor),
  // and d2h-file-side-diff's horizontal scrollport even swallows vertical wheel, so handle paging explicitly.
  // Only when the tree isn't focused — the tree pages itself in handleTreeKey below.
  if (treeFocusIndex < 0 && (event.key === 'PageDown' || event.key === 'PageUp') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    var psc = isDiffViewVisible() ? document.getElementById('diff2html-container') : (isSourceViewerVisible() ? document.getElementById('source-body') : null);
    if (psc) { event.preventDefault(); psc.scrollTop += (event.key === 'PageDown' ? 0.9 : -0.9) * psc.clientHeight; return; }
  }
  // A non-Shift keystroke between the two Shifts cancels the pending double-Shift quick-open. Without this,
  // "Shift → type something → Shift" within 300ms still popped the search, so it fired on nearly every other
  // keystroke. Reset BEFORE the caret handlers below (they swallow arrows) so arrow keys break it too.
  if (event.key !== 'Shift') { lastShiftAt = 0; lastShiftSide = 0; }
  if (treeFocusIndex >= 0 && handleTreeKey(event)) return;
  if (treeFocusIndex < 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isSourceViewerVisible() && handleSourceCaretKey(event)) return;
  if (treeFocusIndex < 0 && !event.metaKey && !event.ctrlKey && !event.altKey && isDiffViewVisible() && handleDiffCaretKey(event)) return;

  if (event.key === 'Shift' && !event.repeat) {
    const now = performance.now();
    // event.location: 1 = left Shift, 2 = right Shift, 0 = unspecified.
    // Require the SAME physical side twice (left+right never counts) within a
    // tight 300ms window so quick-open doesn't fire on accidental or mixed
    // Shift presses. The side !== 0 guard keeps an unknown location from ever
    // matching itself and triggering.
    const side = event.location;
    if (side !== 0 && side === lastShiftSide && now - lastShiftAt < 300) {
      event.preventDefault();
      lastShiftAt = 0;
      lastShiftSide = 0;
      openQuickOpen('all');
      return;
    }
    lastShiftAt = now;
    lastShiftSide = side;
  }

  if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && (event.code === 'KeyF' || event.key.toLowerCase() === 'f')) {
    event.preventDefault();
    openQuickOpen('content');
    return;
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.code === 'KeyE' || event.key.toLowerCase() === 'e')) {
    event.preventDefault();
    openQuickOpen('content');
    setTimeout(focusContentSearchExtensions, 0);
    return;
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.code === 'KeyP' || event.key.toLowerCase() === 'p')) {
    event.preventDefault();
    openQuickOpen('content');
    toggleContentSearchNoise();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.code === 'KeyE' || event.key.toLowerCase() === 'e')) {
    event.preventDefault();
    openQuickOpen('recent');
    return;
  }

  if ((event.metaKey || event.altKey) && event.key === 'Enter' && isSourceViewerVisible()) {
    const enterPath = document.getElementById('source-viewer')?.dataset.openPath || '';
    if (isHttpFile(enterPath)) {
      event.preventDefault();
      runHttpAtCaret();
      return;
    }
    // Option+Enter on a diagnostic line drafts a "fix this" change-request comment for the agent.
    if (event.altKey && typeof createFixCommentAtCaret === 'function' && createFixCommentAtCaret()) {
      event.preventDefault();
      return;
    }
  }

  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    if (isSourceViewerVisible()) goToSymbolUnderCursor();
    else openDiffFileAtCaret();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && (event.code === 'KeyO' || event.key.toLowerCase() === 'o')) {
    event.preventDefault();
    openWorkspaceSymbols();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && (event.code === 'KeyB' || event.key.toLowerCase() === 'b')) {
    var aeImpl = document.activeElement;
    if (aeImpl && (aeImpl.tagName === 'INPUT' || aeImpl.tagName === 'TEXTAREA' || aeImpl.tagName === 'SELECT')) return;
    event.preventDefault();
    goToImplementation();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && (event.code === 'KeyB' || event.key === 'b' || event.key === 'B')) {
    var aeB = document.activeElement;
    if (aeB && (aeB.tagName === 'INPUT' || aeB.tagName === 'TEXTAREA' || aeB.tagName === 'SELECT')) return;
    event.preventDefault();
    if (isSourceViewerVisible()) goToSymbolUnderCursor();
    else if (isDiffViewVisible()) goToSymbolFromDiff();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isSourceViewerVisible() && viewerCursor) {
    event.preventDefault();
    const lineEdgeFile = sourceByPath.get(viewerCursor.path);
    if (lineEdgeFile && lineEdgeFile.embedded) {
      const lineEdgeLines = lineEdgeFile.content.split(/\r?\n/);
      const lineEdgeCol = event.key === 'ArrowLeft' ? 0 : (lineEdgeLines[viewerCursor.lineIndex] || '').length;
      if (event.shiftKey) { if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column }; }
      else selectionAnchor = null;
      setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, lineEdgeCol, true, -1);
      applySourceSelection();
    }
    return;
  }

  // Diff view: Cmd/Ctrl + Left/Right goes to the line start / end; pressing it again AT the
  // edge crosses to the adjacent pane (Left -> old, Right -> new). Plain arrows never cross.
  //
  // With Shift it SELECTS to that edge instead, the same as Cmd+Shift+Left/Right in any editor. setDiffCursor
  // drops diffSelectionAnchor on every caret placement (it cannot tell a jump from an extend), so the anchor
  // is captured before the move and put back after — exactly what moveDiffCursor already does for plain
  // Shift+Arrow (06-diff-caret.js). Without it this branch moved the caret to the line edge and cleared the
  // selection on the way, so Cmd+Shift+Arrow was the one selection gesture that could not be made here.
  // Shift also suppresses the pane crossing: a selection that spans the old and new panes is not a thing
  // (applyDiffSelection drops any anchor from the other side anyway), so at the edge it simply stops.
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isDiffViewVisible() && diffCursor) {
    event.preventDefault();
    const edgeWrap = diffWrapperByPath(diffCursor.path);
    const edgeRow = edgeWrap ? diffRowAt(edgeWrap, diffCursor.side, diffCursor.rowIndex) : null;
    const edgeLen = edgeRow ? diffLineText(edgeRow).length : 0;
    const edgeExtend = event.shiftKey;
    const edgeAnchor = edgeExtend
      ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column })
      : null;
    if (event.key === 'ArrowLeft') {
      if (diffCursor.column > 0) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, 0, true); // -> line start
      } else if (!edgeExtend && diffCursor.side === 'new') { // already at start -> cross to old (left)
        const oldRow = edgeWrap ? diffRowAt(edgeWrap, 'old', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(oldRow)) setDiffCursor(diffCursor.path, 'old', diffCursor.rowIndex, diffLineText(oldRow).length, true);
      }
    } else { // ArrowRight
      if (diffCursor.column < edgeLen) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, edgeLen, true); // -> line end
      } else if (!edgeExtend && diffCursor.side === 'old') { // already at end -> cross to new (right)
        const newRow = edgeWrap ? diffRowAt(edgeWrap, 'new', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(newRow)) setDiffCursor(diffCursor.path, 'new', diffCursor.rowIndex, 0, true);
      }
    }
    if (edgeAnchor) { diffSelectionAnchor = edgeAnchor; applyDiffSelection(); }
    return;
  }

  // Cmd/Ctrl+[ / ] walk the cursor-position history (back / forward), like an editor's Go Back/Forward.
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && (event.key === '[' || event.key === ']' || event.key === '{' || event.key === '}')) {
    if (isSourceViewerVisible() && sourceTabs.length > 1) { event.preventDefault(); cycleSourceTab((event.key === '[' || event.key === '{') ? -1 : 1); return; }
  }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === '[' || event.key === ']')) {
    var navEl = document.activeElement;
    var navInField = navEl && (navEl.tagName === 'INPUT' || navEl.tagName === 'TEXTAREA' || navEl.tagName === 'SELECT');
    if (!navInField) {
      event.preventDefault();
      clearTreeFocus(); // jumping the cursor history moves the caret, so arrows follow it (see F7 below)
      if (event.key === '[') navBack(); else navForward();
      return;
    }
  }

  if (event.key === 'F2' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    // F2 / Shift+F2 steps between language-server problems inside the open source file. It only consumes the
    // key when the source view owns it (a code file is on screen); otherwise the event falls through.
    if (typeof gotoDiagnostic === 'function' && gotoDiagnostic(event.shiftKey ? -1 : 1)) event.preventDefault();
    return;
  }

  // Cmd+F7 / Shift+Cmd+F7: the same comment stepping as F8, kept for muscle memory. A modifier combo — unlike
  // bare F7/F8 it can land in a text field (e.g. an open comment composer, which isn't inside .dock-panel so
  // isFloatingModalOpen() above wouldn't catch it) — guard that explicitly, same idiom as the other
  // modifier-combo shortcuts in this handler.
  if (event.key === 'F7' && (event.metaKey || event.ctrlKey) && !event.altKey) {
    var cfAe = document.activeElement;
    if (cfAe && (cfAe.tagName === 'INPUT' || cfAe.tagName === 'TEXTAREA' || cfAe.tagName === 'SELECT' || cfAe.isContentEditable)) return;
    event.preventDefault();
    clearTreeFocus(); // same as F7: stepping between comments moves the caret, so arrows follow it
    if (typeof gotoComment === 'function') gotoComment(event.shiftKey ? -1 : 1);
  }
});

quickInput?.addEventListener('input', () => renderQuickOpenResults());
quickExtensionInput?.addEventListener('input', restartContentSearch);
quickExcludeNoiseButton?.addEventListener('click', toggleContentSearchNoise);
quickResults?.addEventListener('mousemove', (event) => {
  const item = event.target.closest?.('.quick-open-item');
  if (!item) return;
  const next = Number(item.dataset.index || 0);
  if (next === quickActive) return;
  quickActive = next;
  updateQuickActive();
});
quickResults?.addEventListener('click', (event) => {
  const item = event.target.closest?.('.quick-open-item');
  if (!item) return;
  const index = Number(item.dataset.index || 0);
  openQuickItem(quickItems[index]);
});
quickOpen?.addEventListener('click', (event) => {
  if (event.target === quickOpen) closeQuickOpen();
});
document.getElementById('usages-results')?.addEventListener('mousemove', function (event) {
  var it = event.target.closest && event.target.closest('.usage-item');
  if (!it) return;
  usageActive = Number(it.dataset.index || 0);
  updateUsageActive();
});
document.getElementById('usages-results')?.addEventListener('click', function (event) {
  var it = event.target.closest && event.target.closest('.usage-item');
  if (!it) return;
  openUsageItem(usageItems[Number(it.dataset.index || 0)]);
});
document.getElementById('usages')?.addEventListener('click', function (event) {
  if (event.target && event.target.id === 'usages') closeUsages();
});

// Delegated (like #files-panel below) so it survives the in-place diff update that re-captures `links`
// on every watch tick — per-element listeners would be lost on the new nodes, and then Cmd+0 → arrow →
// Enter (which calls row.click()) would silently do nothing.
document.getElementById('changes-panel')?.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('.file-link') : null;
  if (!link) return;
  // Shift+Click extends a multi-file selection (for batch "mark as viewed" with Space) instead of opening.
  if (event.shiftKey && typeof extendTreeSelectionToRow === 'function' && extendTreeSelectionToRow(link)) {
    event.preventDefault();
    return;
  }
  const pointerSelection = reviewFocusInputModality === 'pointer';
  showDiffView(false);
  const target = Number(link.dataset.hunk);
  if (!Number.isNaN(target) && target >= 0 && target < hunkTotal()) {
    event.preventDefault();
    setActive(target, true, true); // explicit selection always opens this file, even when it is already viewed
  }
  if (pointerSelection) focusTreeRowFromPointer(link);
});

// Delegated so it works whether the tree is inline (small repos) or materialized later (big repos).
document.getElementById('files-panel')?.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('.source-link') : null;
  if (!link || !link.dataset.sourceFile) return;
  const pointerSelection = reviewFocusInputModality === 'pointer';
  openSourceFile(link.dataset.sourceFile, true, { scrollTree: !pointerSelection });
  if (pointerSelection) focusTreeRowFromPointer(link);
});

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => setTab(button.dataset.tab || 'changes'));
});

// Activity rail (IntelliJ-style): click an icon to navigate/toggle its view. The settings button carries
// no data-view and keeps its own id-based handler.
document.querySelector('.activity-rail')?.addEventListener('click', (event) => {
  const btn = event.target.closest && event.target.closest('.rail-btn[data-view]');
  if (!btn) return;
  const view = btn.dataset.view;
  if (view === 'changes') { activateChangesView(true); }
  else if (view === 'files') { activateFilesView(); }
  else if (view === 'merged') { toggleMergedRail(); }
  else if (view === 'memo') { openMemoView(); } // openMemoView already toggles
  else if (view === 'impact') { toggleImpact(); }
  else if (view === 'explain') { runAnnotatePrompt(); }
  else if (view === 'history') { toggleHistory(); }
  document.getElementById('workspace-more-menu')?.classList.add('hidden');
  document.getElementById('workspace-more-toggle')?.setAttribute('aria-expanded', 'false');
  syncRail();
});

// Force-open (never toggle) a review view. Used when a review shortcut (⌘0/⌘1/⌘9/Ctrl+`) is pressed while the
// workspace rail is expanded: the shell forwards e.g. 'files:open'. Unlike a toolbar click (which toggles), this
// always ends with the view shown and its sidebar expanded, so the shortcut can only open — never close — it.
function openRailView(view) {
  if (view === 'files') {
    if (!isSourceViewerVisible()) showSourceView();
    setSourceSidebarCollapsed(false);
    setTab('files');
    focusOpenFileInTree();
  } else if (view === 'changes') {
    setSourceSidebarCollapsed(false);
    setReviewSidebarCollapsed(false);
    if (!isDiffViewVisible()) showDiffView(false);
    setTab('changes');
    focusOpenFileInTree();
  } else if (view === 'history') {
    if (typeof openHistory === 'function' && (typeof isHistoryOpen !== 'function' || !isHistoryOpen())) openHistory();
  } else if (view === 'terminal') {
    var tp = document.getElementById('terminal-panel');
    if (tp && tp.classList.contains('hidden')) document.getElementById('terminal-toggle')?.click();
  } else {
    document.querySelector('.rail-btn[data-view="' + view + '"]')?.click();
  }
  if (typeof syncRail === 'function') syncRail();
}
// The shell title-bar mirrors these tools (single-instance app). A title-bar click is relayed here as a rail
// action; replay it by clicking the matching (possibly CSS-hidden) rail control so every existing handler and
// syncRail run unchanged. An ':open' suffix (from a shortcut fired while the rail is expanded) force-opens
// instead of toggling. Terminal and More carry id-based handlers, not data-view.
if (window.kakapoMenu && window.kakapoMenu.onRailAction) {
  window.kakapoMenu.onRailAction((action) => {
    if (typeof action === 'string' && action.slice(-5) === ':open') { openRailView(action.slice(0, -5)); return; }
    // F7 forwarded from the expanded rail. Replay the key rather than re-implement the handler: F7 is not a
    // rail button, and its logic (enter the diff at the open file's own hunk, skip viewed files, announce the
    // last change) lives in the keydown branch above and must not be duplicated here.
    if (action === 'nextChange' || action === 'prevChange') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', shiftKey: action === 'prevChange', bubbles: true }));
      return;
    }
    if (action === 'terminal') { document.getElementById('terminal-toggle')?.click(); return; }
    document.querySelector('.rail-btn[data-view="' + action + '"]')?.click();
  });
}



document.getElementById('back-to-diff')?.addEventListener('click', () => showDiffView(true));
document.getElementById('source-tabs')?.addEventListener('click', function (event) {
  var closeBtn = event.target && event.target.closest && event.target.closest('.source-tab-close');
  if (closeBtn) { event.stopPropagation(); event.preventDefault(); closeSourceTab(closeBtn.getAttribute('data-close-path')); return; }
  var overflow = event.target && event.target.closest && event.target.closest('.source-tab-overflow');
  if (overflow) { event.stopPropagation(); event.preventDefault(); showSourceTabOverflowMenu(overflow); return; }
  var tab = event.target && event.target.closest && event.target.closest('.source-tab');
  if (tab) openSourceFile(tab.getAttribute('data-tab-path'));
});
document.getElementById('diff-prev-change')?.addEventListener('click', function () { next(-1); });
document.getElementById('diff-next-change')?.addEventListener('click', function () { next(1); });
document.getElementById('diff-open-source')?.addEventListener('click', function () { openDiffFileAtCaret(); });
document.getElementById('diff-sidebar-toggle')?.addEventListener('click', function () { toggleReviewSidebar(); });
document.getElementById('source-body')?.addEventListener('click', handleSourceClick);
document.getElementById('source-body')?.addEventListener('dblclick', handleSourceDoubleClick);
document.getElementById('source-body')?.addEventListener('click', function (event) {
  var img = event.target && event.target.closest && event.target.closest('.image-preview');
  if (img) openLightbox(img.getAttribute('src'), img.getAttribute('alt'));
});
document.addEventListener('copy', handleSourceCopy);

// One consistent tooltip for controls that have an explicit application shortcut, including controls
// created after startup. Do not synthesize an Enter tooltip for ordinary buttons: list rows, tabs and menu
// items already state their action on screen, so repeating that label in a large bubble only obscures content.
// Custom select triggers are excluded, and activity-rail buttons keep their own tooltip.
(function installButtonShortcutHints() {
  var hint = document.createElement('div');
  hint.id = 'mc-button-hint';
  hint.className = 'mc-button-hint hidden';
  hint.setAttribute('role', 'tooltip');
  hint.innerHTML = '<span class="mc-button-hint-label"></span><kbd></kbd>';
  document.body.appendChild(hint);
  var owner = null;
  function buttonFor(target) {
    var button = target && target.closest ? target.closest('button') : null;
    // The launcher's rail rows print their own shortcut on the row, so a bubble repeating it under the
    // cursor says nothing and covers the row below — same reason .rail-btn is excluded.
    return button && button.hasAttribute('data-keyhint')
      && !button.classList.contains('rail-btn') && !button.classList.contains('mc-select')
      && !button.classList.contains('quick-open-side-item')
      && !button.classList.contains('file-link') ? button : null;
  }
  function buttonLabel(button) {
    return button.getAttribute('data-tooltip') || button.getAttribute('aria-label')
      || button.getAttribute('data-hint-title') || button.getAttribute('title')
      || (button.textContent || '').trim() || 'Action';
  }
  function place(button) {
    if (!button || !button.isConnected) return;
    owner = button;
    hint.querySelector('.mc-button-hint-label').textContent = buttonLabel(button);
    // The custom bubble replaces the browser's delayed native `title` bubble. Keeping both produced two
    // overlapping shortcut guides over Viewed and other toolbar controls.
    if (button.hasAttribute('title')) {
      button.setAttribute('data-hint-title', button.getAttribute('title') || '');
      button.removeAttribute('title');
    }
    hint.querySelector('kbd').textContent = button.getAttribute('data-keyhint');
    hint.classList.remove('hidden');
    var rect = button.getBoundingClientRect();
    var box = hint.getBoundingClientRect();
    var left = Math.max(8, Math.min(window.innerWidth - box.width - 8, rect.left + rect.width / 2 - box.width / 2));
    var top = rect.bottom + 8;
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 8);
    hint.style.left = left + 'px'; hint.style.top = top + 'px';
  }
  function hide(button) {
    if (button && owner && button !== owner) return;
    owner = null; hint.classList.add('hidden');
  }
  document.addEventListener('mouseover', function (event) { var button = buttonFor(event.target); if (button) place(button); });
  document.addEventListener('mouseout', function (event) {
    var button = buttonFor(event.target);
    if (button && (!event.relatedTarget || !button.contains(event.relatedTarget))) hide(button);
  });
  document.addEventListener('focusin', function (event) { var button = buttonFor(event.target); if (button) place(button); });
  document.addEventListener('focusout', function (event) { var button = buttonFor(event.target); if (button) hide(button); });
  document.addEventListener('click', function () { hide(); }, true);
  window.addEventListener('scroll', function () { hide(); }, true);
  window.addEventListener('resize', function () { if (owner) place(owner); });
  // Composer and other dynamic controls are replaced by innerHTML. Removing a hovered/focused button does
  // not reliably emit mouseout/focusout in Chromium, so its shortcut bubble could remain orphaned after the
  // comment box closed. A single batched observer is cheaper and more robust than teaching every renderer
  // to know about this global tooltip.
  if (window.MutationObserver) {
    new window.MutationObserver(function () {
      if (owner && !owner.isConnected) hide();
    }).observe(document.body, { childList: true, subtree: true });
  }
})();

// Chromium's custom scrollbar styling disables macOS' native overlay fade. Restore that behavior for
// every current and future scroll surface without changing its reserved gutter (which would shift code).
(function installAutoHidingScrollbars() {
  var idleTimers = new WeakMap();
  var idleMs = 900;
  document.addEventListener('scroll', function (event) {
    var target = event.target === document ? document.documentElement : event.target;
    if (!target || !target.classList) return;
    target.classList.add('mc-scroll-active');
    var previous = idleTimers.get(target);
    if (previous) clearTimeout(previous);
    idleTimers.set(target, setTimeout(function () {
      target.classList.remove('mc-scroll-active');
      idleTimers.delete(target);
    }, idleMs));
  }, { capture: true, passive: true });
})();

applyI18n(); // first paint already shows English (inline); this swaps to the saved locale before the rest of init renders dynamic text
populateHttpEnvSelect();
const restored = restoreUiState();
if (!restored) {
  const initial = location.hash.match(/^#hunk-(\d+)$/);
  const hasDiff = Boolean(document.querySelector('#diff2html-container .d2h-file-wrapper'));
  if (initial) setActive(Number(initial[1]), false);
  // Clean tree (nothing to review): open a file (README first) instead of staring at an empty diff.
  else if (!hasDiff) openDefaultSourceFile();
  else if (REVIEW_LAZY_LOAD) showDiffView(false); // big repos with changes: open to the diff (Changes); the source tree stays deferred until the Files tab is opened
  else openDefaultSourceFile();
}
initSourceTreeFolds();
initChangesTreeFolds();
syncRail(); // reflect the initial view on the activity rail
// Electron receives live updates over IPC (kakapoMenu.onDiffUpdate); only serve/browser needs the HTTP
// poller. Under file:// its fetch just fails every 1.5s for the app's whole life, so skip it in Electron.
if (watchEnabled && !(window.kakapoMenu && typeof window.kakapoMenu.onDiffUpdate === 'function')) {
  setInterval(checkForLiveUpdate, 1500);
}
window.addEventListener('beforeunload', saveUiState);

// First render has painted — drop the boot overlay (it bridged the blank gap right after loadFile). Two
// rAFs so the Kakapo loading mark stays until the diff/tree are actually on screen, then a short fade-out.
(function () {
  var ov = document.getElementById('boot-overlay');
  if (!ov) return;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      try {
        if (window.kakapoPerf && typeof window.kakapoPerf.mark === 'function') {
          window.kakapoPerf.mark('first-review-paint', {
            lazy: Boolean(REVIEW_LAZY),
            lazyLoad: Boolean(REVIEW_LAZY_LOAD),
          });
        }
      } catch (e) {}
      ov.classList.add('hide');
      setTimeout(function () { ov.remove(); }, 240);
    });
  });
})();

(function setupSidebarResize() {
  const resizer = document.querySelector('.sidebar-resizer');
  if (!resizer) return;
  const sidebarKey = 'kakapo-sidebar-width:' + location.pathname;
  const saved = persistRead(sidebarKey) || localStorage.getItem(sidebarKey);
  if (saved) document.documentElement.style.setProperty('--sidebar-width', saved);
  let resizing = false;
  resizer.addEventListener('mousedown', (event) => {
    resizing = true;
    resizer.classList.add('resizing');
    document.body.style.userSelect = 'none';
    event.preventDefault();
  });
  document.addEventListener('mousemove', (event) => {
    if (!resizing) return;
    // Subtract the activity rail's width: the sidebar starts to its right, so its width is the cursor X
    // minus the rail offset (not clientX itself, which would over-size it by the rail width).
    const railW = parseFloat(getComputedStyle(document.body).getPropertyValue('--rail-width')) || 0;
    const width = Math.min(640, Math.max(180, event.clientX - railW));
    document.documentElement.style.setProperty('--sidebar-width', width + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    resizer.classList.remove('resizing');
    document.body.style.userSelect = '';
    persistSave(sidebarKey, getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim());
  });
})();

(function setupDiffCaret() {
  const container = document.getElementById('diff2html-container');
  if (!container) return;
  // No contenteditable: the diff caret is the JS diffCursor. A native contenteditable caret
  // would render a second blinking cursor alongside it. Text selection (for comment capture)
  // still works on non-editable content.
  container.setAttribute('aria-readonly', 'true');
  container.querySelectorAll('.d2h-code-side-linenumber, .d2h-code-linenumber, .d2h-code-line-prefix').forEach((el) => el.setAttribute('contenteditable', 'false'));
  const inComment = (event) => Boolean(event.target && event.target.closest && event.target.closest('.mc-comment-row'));
  const block = (event) => { if (inComment(event)) return; event.preventDefault(); };
  container.addEventListener('focusin', (event) => { if (!inComment(event)) clearTreeFocus(); });
  container.addEventListener('mousedown', (event) => { if (!inComment(event)) clearTreeFocus(); });
  container.addEventListener('beforeinput', block);
  container.addEventListener('paste', block);
  container.addEventListener('drop', block);
  container.addEventListener('dragstart', block);
  container.addEventListener('keydown', (event) => {
    if (inComment(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Tab') {
      event.preventDefault();
    }
  });
  container.addEventListener('click', (event) => {
    if (inComment(event)) return;
    // The second click is completed by the dblclick handler below. Re-inserting the fake caret here would
    // split the target text a second time and erase Chromium's pending word selection.
    if (Number(event.detail) > 1) return;
    const info = diffRowInfoFromNode(event.target);
    if (info && info.path) setDiffCursor(info.path, info.side, info.rowIndex, 0, false);
  });
  container.addEventListener('dblclick', (event) => {
    if (inComment(event)) return;
    const code = event.target?.closest?.('.d2h-code-line-ctn');
    const row = code?.closest?.('tr');
    if (!code || !row || !isDiffCodeRow(row)) return;
    const text = diffLineText(row);
    const column = estimateColumnFromClick(code, event, text);
    diffSelectionAnchor = null;
    if (selectCodeWord(code, text, column)) event.preventDefault();
  });
  ensureDiffCursor();
})();
