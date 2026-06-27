function setTab(name) {
  if (name === 'files') ensureTreeRendered();
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  document.getElementById('changes-panel')?.classList.toggle('hidden', name !== 'changes');
  document.getElementById('files-panel')?.classList.toggle('hidden', name !== 'files');
  syncRail();
}
// Reflect the current view/dock state on the activity rail icons (active highlight). Terminal active is
// kept in sync separately by the dock-terminal setOpen (it toggles is-active on #terminal-toggle).
function syncRail() {
  var rail = document.querySelector('.activity-rail');
  if (!rail) return;
  var setOn = function (view, on) {
    var btn = rail.querySelector('[data-view="' + view + '"]');
    if (btn) btn.classList.toggle('is-active', !!on);
  };
  setOn('changes', !document.getElementById('changes-panel')?.classList.contains('hidden'));
  setOn('files', !document.getElementById('files-panel')?.classList.contains('hidden'));
  var merged = document.getElementById('mc-merged-panel');
  setOn('q', !!(merged && merged.dataset.kind === 'q'));
  setOn('c', !!(merged && merged.dataset.kind === 'c'));
  setOn('memo', !!document.getElementById('mc-memo-panel'));
  var hv = document.getElementById('history-view');
  setOn('history', !!(hv && !hv.classList.contains('hidden')));
}
// Rail click for the merged views toggles: a 2nd click on the open kind closes it (memo already toggles).
function toggleMergedRail(kind) {
  var m = document.getElementById('mc-merged-panel');
  if (m && m.dataset.kind === kind) { closeMergedMemoDocks(); return; }
  openMergedView(kind);
}
// Big repos ship the source tree as an inert island (see render.ts); build it the first time the Files
// tab is opened so the (potentially huge) tree never blocks startup. No-op for inline (small) trees.
function ensureTreeRendered() {
  var panel = document.getElementById('files-panel');
  var island = document.getElementById('files-tree-html');
  if (!panel || !island) return;
  var html = island.textContent || '';
  island.parentNode && island.parentNode.removeChild(island);
  panel.innerHTML = '<div class="empty-nav">' + escapeHtml(t('source.buildingTree')) + '</div>';
  setTimeout(function () { // let "Building…" paint before the heavy innerHTML
    panel.innerHTML = html;
    sourceLinks = Array.from(document.querySelectorAll('.source-link'));
    if (typeof refreshComments === 'function') { try { refreshComments(); } catch (e) {} } // re-render per-file badges
  }, 0);
}

function showDiffView(shouldScroll) {
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  setTab('changes');
  if (current < 0 && hunkTotal()) {
    setActive(0, shouldScroll);
    return;
  }
  if (current >= 0) {
    const cidx = current;
    whenFileReady(diffWrapperByPath(hunkPathAt(cidx)), function () {
      const curRow = document.getElementById('hunk-' + cidx);
      if (curRow) {
        showOnlyFile(hunkPathAt(cidx));
        if (shouldScroll) curRow.scrollIntoView({ block: 'start' });
      }
    });
  }
}

function showSourceView() {
  document.getElementById('diff-view')?.classList.add('hidden');
  document.getElementById('source-viewer')?.classList.remove('hidden');
  setTab('files');
}

function saveUiState() {
  const activeTab = document.querySelector('.tab.active')?.dataset.tab || 'changes';
  const sourcePath = document.getElementById('source-viewer')?.dataset.openPath || '';
  sessionStorage.setItem(uiStateKey, JSON.stringify({
    tab: activeTab,
    view: document.getElementById('source-viewer')?.classList.contains('hidden') ? 'diff' : 'source',
    sourcePath,
    hash: location.hash,
    // Preserve open tabs + the exact caret across watch reloads (otherwise the caret resets to the
    // hunk's first change / file top every time the working tree changes).
    tabs: sourceTabs,
    diffCursor: diffCursor,
    viewerCursor: viewerCursor,
  }));
}

function restoreUiState() {
  const raw = sessionStorage.getItem(uiStateKey);
  if (!raw) return false;
  try {
    const state = JSON.parse(raw);
    // Restore Files-mode tabs first so a watch reload doesn't drop the open tabs.
    if (Array.isArray(state.tabs)) sourceTabs = state.tabs.filter(function (p) { return sourceByPath.has(p); });
    if (state.view === 'diff') {
      const match = String(state.hash || location.hash || '').match(/^#hunk-(\d+)$/);
      setActive(match ? Number(match[1]) : current >= 0 ? current : 0, false);
      // Restore the exact diff caret (setActive only lands on the hunk's first change).
      if (state.diffCursor && state.diffCursor.path) {
        var dc = state.diffCursor;
        setTimeout(function () { try { setDiffCursor(dc.path, dc.side, dc.rowIndex, dc.column, true); } catch (e) {} }, 60);
      }
      return true;
    }
    // Source view. Open the saved file — or fall back to the first restored tab when that file is gone
    // (filtered out above) or wasn't recorded. Otherwise we'd render the tab bar but leave the body on its
    // "select a file" placeholder, which looks broken (a tab is clearly open). No openable tab → drop the
    // stale tabs and let the init fallback pick a sensible default.
    var openPath = (state.sourcePath && sourceByPath.has(state.sourcePath)) ? state.sourcePath : (sourceTabs[0] || '');
    if (openPath) {
      openSourceFile(openPath);
      // Restore the exact source caret/scroll (openSourceFile alone resets it to the top).
      if (state.viewerCursor && state.viewerCursor.path === openPath) {
        var vc = state.viewerCursor;
        setTimeout(function () { try { setSourceCursor(openPath, vc.lineIndex, vc.column, true, -1); } catch (e) {} }, 60);
      }
      return true;
    }
    sourceTabs = [];
  } catch {
    sessionStorage.removeItem(uiStateKey);
  }
  return false;
}

// In-place diff refresh (instead of a full window reload): apply a compact payload of just the changed
// regions (diff container, sidebar trees, status, data) and re-run the bootstrap steps. The window never
// reloads, so the integrated terminal's pty sessions (claude/codex) survive a watch refresh. Electron's
// main pushes the payload over IPC (monacori:diff-update); serve mode's poller fetches /__ai_flow_update.
// Live watch refreshes are HELD while a comment composer is open. applyDiffUpdate rebuilds the diff DOM, so
// applying it mid-compose would destroy the composer textarea every watch tick — input stalls and characters
// arrive in bursts — and flicker the page. Keep only the latest pending payload; flush it on close/save.
var pendingDiffUpdate = null;
function flushPendingDiffUpdate() {
  if (!pendingDiffUpdate) return;
  var u = pendingDiffUpdate;
  pendingDiffUpdate = null;
  try { applyDiffUpdate(u); } catch (e) {}
}
// Flicker-saver for the live-watch refresh. The default path replaces the WHOLE diff DOM
// (container.innerHTML = …), which re-renders the file you're looking at even when only an OFF-SCREEN file
// changed. When the file set AND order are identical, reconcile per-file instead: keep every unchanged
// wrapper's DOM node untouched (no flicker — including the visible one) and swap only the changed wrappers,
// which are off-screen so the swap is invisible. Returns false (caller does the full innerHTML swap) for the
// risky cases — files added/removed/reordered — so that proven path still handles index-shift correctly.
function reconcileDiffWrappers(container, newDiffHtml, oldSigByPath, newSigByPath) {
  var oldW = Array.prototype.slice.call(container.querySelectorAll('.d2h-file-wrapper'));
  if (!oldW.length) return false;
  var tmp = document.createElement('div');
  tmp.innerHTML = newDiffHtml;
  var newW = Array.prototype.slice.call(tmp.querySelectorAll('.d2h-file-wrapper'));
  if (newW.length !== oldW.length) return false; // add/remove → full swap (global hunk indices shift)
  for (var i = 0; i < oldW.length; i++) {
    if (diffWrapperPathKey(oldW[i]) !== diffWrapperPathKey(newW[i])) return false; // reordered → full swap
  }
  for (var j = 0; j < oldW.length; j++) {
    var ow = oldW[j], nw = newW[j], p = diffWrapperPathKey(ow);
    if ((oldSigByPath.get(p) || '') !== (newSigByPath.get(p) || '')) {
      // Changed file (off-screen): drop in the fresh shell and clear its cached body so it refetches the
      // new content when it next scrolls into view. Replacing an off-screen node is invisible.
      var nidx = (nw.id || '').replace('file-', '');
      delete bodyCache[nidx];
      delete bodyPromise[nidx];
      ow.parentNode.replaceChild(nw, ow);
    } else {
      // Unchanged file: keep its DOM node (no flicker). An earlier file's changed hunk count can shift the
      // global numbering, so sync the index attrs and renumber a materialized body's hunk ids (id/class
      // changes only — invisible, no flicker).
      var baseChanged = ow.getAttribute('data-first-hunk') !== nw.getAttribute('data-first-hunk');
      ow.id = nw.id;
      if (nw.hasAttribute('data-first-hunk')) ow.setAttribute('data-first-hunk', nw.getAttribute('data-first-hunk'));
      if (nw.hasAttribute('data-hunk-count')) ow.setAttribute('data-hunk-count', nw.getAttribute('data-hunk-count'));
      var body = ow.querySelector('.d2h-files-diff');
      if (baseChanged && body && !body.hasAttribute('data-lazy')) markWrapperHunks(ow);
    }
  }
  return true;
}
function applyDiffUpdate(u) {
  if (!u || !u.signature || u.signature === currentSignature) return false; // unchanged — nothing to do
  if (composerState) { pendingDiffUpdate = u; return false; } // composing a comment — hold the refresh until close/save

  // Remember what to restore after the swap (comments/viewed persist on their own; these don't).
  var sv = document.getElementById('source-viewer');
  var openPath = (sv && sv.dataset.openPath) || '';
  var wasSource = isSourceViewerVisible();
  var container = document.getElementById('diff2html-container');
  var diffScrollTop = container ? container.scrollTop : 0;
  // The active hunk's file path BEFORE the swap (hunkMeta/hunks still hold the old build here). After a commit
  // the old active file can vanish from the new diff, so we re-anchor `current` to it below — otherwise it
  // dangles at a stale index and showDiffView renders blank with a stale breadcrumb.
  var prevActivePath = current >= 0 ? hunkPathAt(current) : '';
  // Did the file the user is CURRENTLY viewing actually change in this build? If not, we must not re-render
  // the source view — an unrelated file's edit would otherwise flicker the pane they're reading. Capture the
  // open file's signature BEFORE fileSignatureByPath is rebuilt below.
  var prevOpenSig = openPath ? (fileSignatureByPath.get(openPath) || '') : '';

  // Fast-path: when the file set + order are unchanged, reconcile per-file so an off-screen change never
  // flickers the file you're viewing. Falls back to the full swap (below) for add/remove/reorder or eager.
  var newSigByPath = new Map((u.fileStates || []).map(function (f) { return [f.path, f.signature]; }));
  var fastPath = false;
  if (REVIEW_LAZY && container && u.diffContainer) {
    fastPath = reconcileDiffWrappers(container, u.diffContainer, fileSignatureByPath, newSigByPath);
  }

  // Full-swap path only: snapshot already-materialized bodies (keyed by path + signature) BEFORE the swap so
  // UNCHANGED files re-fill synchronously afterwards — otherwise the swap blanks every wrapper into an empty
  // lazy shell until its body reloads over IPC (the "flicker"). The fast-path keeps those nodes, so skip it.
  var prevBodies = {};
  if (!fastPath && REVIEW_LAZY && container) {
    container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
      var b = w.querySelector('.d2h-files-diff');
      if (!b || b.hasAttribute('data-lazy')) return; // only bodies that are actually materialized
      var p = diffWrapperPathKey(w);
      if (p) prevBodies[p] = { sig: fileSignatureByPath.get(p) || '', html: b.innerHTML };
    });
  }

  // 1) Replace the visible regions straight from the payload (no full-HTML parse) — unless the fast-path
  // already reconciled the diff DOM in place.
  if (container && !fastPath) container.innerHTML = u.diffContainer || '';
  var changesPanel = document.getElementById('changes-panel');
  if (changesPanel) changesPanel.innerHTML = u.changesPanel || '';
  // Files tree: keep the inert island (lazy, not yet opened) in sync, and refresh the live panel when it's
  // already materialized — or always, in eager mode where the panel holds the tree directly.
  var filesIsland = document.getElementById('files-tree-html');
  if (filesIsland) filesIsland.textContent = u.filesTree || '';
  var filesPanel = document.getElementById('files-panel');
  if (filesPanel && (!REVIEW_LAZY || filesPanel.innerHTML.trim())) filesPanel.innerHTML = u.filesTree || '';
  var statusEl = document.querySelector('.review-status');
  if (statusEl) statusEl.innerHTML = u.reviewStatus || '';
  // Branch can change between watch ticks (checkout/commit) — keep the sidebar chip current.
  var branchName = document.getElementById('brand-branch-name');
  if (branchName) {
    branchName.textContent = u.branch || '';
    var branchChip = branchName.closest && branchName.closest('.brand-branch');
    if (branchChip) branchChip.classList.toggle('hidden', !u.branch);
  }
  if (reviewMeta) { reviewMeta.setAttribute('data-signature', u.signature); if (u.generatedAt) reviewMeta.setAttribute('data-generated-at', u.generatedAt); }

  // 2) Re-derive module-level state directly from the payload objects.
  fileStates = u.fileStates || [];
  fileSignatureByPath = new Map(fileStates.map(function (f) { return [f.path, f.signature]; }));
  // The open file changed iff its signature moved (or it vanished from the new build). Drives whether we
  // re-render the source view below.
  var openFileChanged = !openPath || prevOpenSig !== (fileSignatureByPath.get(openPath) || '');
  sourceFiles = u.sourceFilesMeta || [];
  sourceByPath = new Map(sourceFiles.map(function (f) { return [f.path, f]; }));
  httpEnvironments = u.httpEnvironments || {};
  httpEnvNames = Object.keys(httpEnvironments);
  currentSignature = u.signature;
  links = Array.from(document.querySelectorAll('#changes-panel .file-link'));
  sourceLinks = Array.from(document.querySelectorAll('.source-link'));

  // Reconcile the active hunk against the new build (uses the just-rebuilt `links`). A committed/removed file
  // reshuffles or shrinks the diff: re-anchor `current` to the same file's new hunk when it survives, else
  // drop to -1 so the diff lands on the first change rather than a dangling index that paints nothing.
  var activeFilePreserved = false;
  if (prevActivePath) {
    var reHunk = firstHunkForPath(prevActivePath);
    if (reHunk >= 0) { current = reHunk; activeFilePreserved = true; }
    else current = -1;
  }

  // 3) Reset lazy-materialize + index state so the new diff bodies / source / symbols rebuild on demand.
  // bodyCache is keyed by file INDEX, not content — after a watch rebuild the same index maps to the new
  // body, so it MUST be dropped too. Clearing only bodyPromise left loadBodyHtml() returning the cached
  // OLD body, so a watch change never showed up in the diff until a full reload.
  bodyCache = {};
  bodyPromise = {};
  diffBootDone = false;
  sourceLoaded = !REVIEW_LAZY_LOAD; // lazyLoad: re-fetch source content on next use
  sourceLoading = false;
  // Force a source body re-render on next open ONLY if the open file actually changed; otherwise keep
  // sourceBodyPath so the already-painted (unchanged) source view is left exactly as-is — no flicker.
  if (openFileChanged) sourceBodyPath = null;
  symbolIndex = null;

  // 3b) Re-fill UNCHANGED files' bodies synchronously from the snapshot so they don't blank-then-reload (the
  // flicker). Runs BEFORE setupLazyDiff so the IntersectionObserver sees them already materialized and never
  // re-fetches them. The fresh wrapper carries the correct data-first-hunk + file index, so materializeBody
  // numbers hunks exactly as a normal lazy load would. Changed/new files stay shells and lazy-load as usual.
  if (!fastPath && REVIEW_LAZY && container) {
    container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
      var p = diffWrapperPathKey(w);
      var prev = p ? prevBodies[p] : null;
      if (!prev || !prev.sig || prev.sig !== (fileSignatureByPath.get(p) || '')) return; // changed/new -> lazy-load
      var shell = w.querySelector('.d2h-files-diff[data-lazy]');
      if (!shell) return;
      var idx = (w.id || '').replace('file-', '');
      materializeBody(w, prev.html);           // fills the body + markWrapperHunks (uses the new data-first-hunk)
      bodyCache[idx] = prev.html;              // keep the index cache consistent so it never refetches
      bodyPromise[idx] = Promise.resolve(w);
    });
  }
  refreshHunkIndex(); // rebuild hunks/hunkMeta from the swapped-in DOM so hunkTotal()/hunkPathAt() aren't stale
  if (REVIEW_LAZY) { setupLazyDiff(); setTimeout(function () { diffBootDone = true; }, 0); }
  else { diffBootDone = true; }
  if (!REVIEW_LAZY_LOAD) setTimeout(startSymbolIndex, 0);

  // 4) Re-run the DOM-dependent bootstrap steps.
  applyI18n();
  populateHttpEnvSelect();
  initSourceTreeFolds();
  remapComments(); // follow/drop comments whose anchor line moved or vanished in the new build
  refreshComments();

  // 5) Best-effort restore of what the user was looking at. Re-render the source view only when the open file
  // actually changed; an unchanged file stays painted as-is, so an unrelated edit doesn't flicker the pane.
  if (wasSource && openPath && sourceByPath.has(openPath)) {
    if (openFileChanged) openSourceFile(openPath, false);
  } else if (container) {
    showDiffView(false);
    // Same active file survived → keep the user's exact scroll. If it was committed away (current reset to
    // -1, showDiffView landed on the first change), restoring the old, now-out-of-range scrollTop would push
    // the shorter new diff off-screen and look blank — so reset to the top instead.
    container.scrollTop = activeFilePreserved ? diffScrollTop : 0;
  }
  return true;
}

async function checkForLiveUpdate() {
  if (checkingForUpdates) return;
  checkingForUpdates = true;
  const liveStatus = document.getElementById('live-status');
  try {
    const response = await fetch('/__ai_flow_state', { cache: 'no-store' });
    if (!response.ok) return;
    const state = await response.json();
    if (liveStatus && state.generatedAt) {
      liveStatus.textContent = t('status.live.updated') + ' ' + new Date(state.generatedAt).toLocaleTimeString();
    }
    if (state.signature && state.signature !== currentSignature) {
      // serve mode: fetch just the compact update payload and refresh in place (same path Electron uses
      // over IPC) rather than reloading — so an open integrated terminal keeps its sessions.
      try {
        var fresh = await fetch('__ai_flow_update', { cache: 'no-store' });
        if (fresh.ok) applyDiffUpdate(await fresh.json());
      } catch (e) {}
    }
  } catch {
    if (liveStatus) liveStatus.textContent = t('status.live.waiting');
  } finally {
    checkingForUpdates = false;
  }
}

