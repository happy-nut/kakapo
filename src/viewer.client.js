
const REVIEW_LAZY = document.getElementById('review-meta')?.dataset.lazy === 'true';
// lazy-LOAD (Phase 2): file bodies are NOT embedded; they are fetched on demand (serve: GET /file,
// Electron: window.monacoriFile.get) so the initial HTML stays small. Implies REVIEW_LAZY (shells).
const REVIEW_LAZY_LOAD = document.getElementById('review-meta')?.dataset.lazyLoad === 'true';
if (!REVIEW_LAZY) prepareDiff2HtmlHunks();
const hunks = REVIEW_LAZY ? [] : Array.from(document.querySelectorAll('.hunk'));
const hunkPeers = REVIEW_LAZY ? [] : Array.from(document.querySelectorAll('.hunk-peer'));
// Lazy mode: each file body lives in an inert <script type="text/html"> island (see splitDiffForLazy).
// Build a hunk index from the lightweight shells (data-first-hunk/data-hunk-count/data-path) so F7 and
// change-nav work without materializing everything. hunkRowAt() materializes the target file on demand.
const hunkMeta = [];
if (REVIEW_LAZY) {
  Array.prototype.forEach.call(document.querySelectorAll('#diff2html-container .d2h-file-wrapper'), function (w) {
    var base = parseInt(w.dataset.firstHunk || '0', 10) || 0;
    var cnt = parseInt(w.dataset.hunkCount || '0', 10) || 0;
    var p = w.dataset.path || ((w.querySelector('.d2h-file-name') || {}).textContent || '').trim();
    for (var k = 0; k < cnt; k++) hunkMeta[base + k] = { path: p };
  });
}
var diffBootDone = false;
function hunkTotal() { return REVIEW_LAZY ? hunkMeta.length : hunks.length; }
function hunkPathAt(i) { return REVIEW_LAZY ? (hunkMeta[i] ? hunkMeta[i].path : '') : (hunks[i] ? hunks[i].dataset.file : ''); }
function hunkRowAt(i) {
  if (!REVIEW_LAZY) return hunks[i] || null;
  var meta = hunkMeta[i];
  if (!meta) return null;
  ensureFileReady(diffWrapperByPath(meta.path));
  return document.getElementById('hunk-' + i);
}
// Assign global hunk ids/classes to a freshly materialized file body, keyed off its shell's
// data-first-hunk so indices stay globally consistent with the eager numbering.
function markWrapperHunks(wrapper) {
  var base = parseInt(wrapper.dataset.firstHunk || '0', 10) || 0;
  var fileName = ((wrapper.querySelector('.d2h-file-name') || {}).textContent || '').trim();
  var headerToIndex = new Map();
  var local = 0;
  Array.prototype.forEach.call(wrapper.querySelectorAll('tr'), function (row) {
    var header = (row.textContent || '').trim();
    if (header.indexOf('@@') !== 0) return;
    var index = headerToIndex.get(header);
    if (index === undefined) { index = base + local; headerToIndex.set(header, index); row.classList.add('hunk'); row.id = 'hunk-' + index; local += 1; }
    else { row.classList.add('hunk-peer'); }
    row.dataset.hunkIndex = String(index);
    row.dataset.file = fileName;
  });
}
var bodyCache = {};   // file index -> diff body html (lazy-LOAD cache)
var bodyPromise = {}; // file index -> Promise that resolves once the body is materialized
function loadBodyHtml(index) {
  if (bodyCache[index] != null) return Promise.resolve(bodyCache[index]);
  var p;
  if (typeof window !== 'undefined' && window.monacoriFile && typeof window.monacoriFile.get === 'function') {
    p = Promise.resolve().then(function () { return window.monacoriFile.get(Number(index), 'diff'); });
  } else if (typeof fetch !== 'undefined') {
    p = fetch('file?index=' + index).then(function (r) { return r.ok ? r.text() : ''; });
  } else {
    p = Promise.resolve('');
  }
  return p.then(function (html) { bodyCache[index] = html || ''; return bodyCache[index]; }, function () { bodyCache[index] = ''; return ''; });
}
function materializeBody(wrapper, html) {
  var body = wrapper.querySelector('.d2h-files-diff[data-lazy]');
  if (!body) return;
  body.innerHTML = html || '';
  body.removeAttribute('data-lazy');
  body.removeAttribute('data-loading');
  markWrapperHunks(wrapper);
  if (diffBootDone && typeof reviewComments !== 'undefined' && reviewComments.length) { try { refreshComments(); } catch (e) {} }
}
// Materialize a lazily-emitted file body. Phase 1 reads it from an inert embedded island (sync);
// Phase 2 lazy-LOAD fetches it on demand (async) — callers that then need rows must use whenFileReady().
function ensureFileReady(wrapper) {
  if (!wrapper) return null;
  var body = wrapper.querySelector('.d2h-files-diff[data-lazy]');
  if (!body) return wrapper; // already materialized (or eager mode)
  var idx = (wrapper.id || '').replace('file-', '');
  if (REVIEW_LAZY_LOAD) {
    if (!bodyPromise[idx]) {
      body.setAttribute('data-loading', '1');
      bodyPromise[idx] = loadBodyHtml(idx).then(function (html) { materializeBody(wrapper, html); return wrapper; });
    }
    return wrapper;
  }
  var island = document.getElementById('diff-body-' + idx);
  if (island) materializeBody(wrapper, island.textContent || '');
  return wrapper;
}
// Run cb once the wrapper's body is materialized — synchronously when it already is (eager / Phase 1
// island / cached), or after the fetch resolves (cold lazy-LOAD). Lets navigation stay correct without
// turning every caller async.
function whenFileReady(wrapper, cb) {
  if (!wrapper) { cb(); return; }
  ensureFileReady(wrapper);
  var body = wrapper.querySelector('.d2h-files-diff');
  if (!body || !body.hasAttribute('data-lazy')) { cb(); return; }
  var idx = (wrapper.id || '').replace('file-', '');
  if (bodyPromise[idx]) { bodyPromise[idx].then(function () { cb(); }); return; }
  cb();
}
function setupLazyDiff() {
  var container = document.getElementById('diff2html-container');
  if (!container) return;
  var wrappers = Array.prototype.slice.call(container.querySelectorAll('.d2h-file-wrapper'));
  if (typeof IntersectionObserver !== 'undefined') {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { ensureFileReady(e.target); io.unobserve(e.target); } });
    }, { root: null, rootMargin: '600px 0px' });
    wrappers.forEach(function (w) { io.observe(w); });
  } else {
    wrappers.forEach(function (w) { ensureFileReady(w); }); // no IntersectionObserver -> materialize all
  }
  if (wrappers[0]) ensureFileReady(wrappers[0]); // first file ready so the initial caret has a row to land on
}
if (REVIEW_LAZY) { setupLazyDiff(); setTimeout(function () { diffBootDone = true; }, 0); }
const links = Array.from(document.querySelectorAll('#changes-panel .file-link'));
let sourceLinks = Array.from(document.querySelectorAll('.source-link')); // re-captured when a deferred tree materializes
const sourceFiles = JSON.parse(document.getElementById('source-files-data')?.textContent || '[]');
// i18n: the message catalog (en + ko) is emitted server-side; the locale lives in localStorage and the
// whole UI switches live (no reload). t() feeds dynamically-built text; applyI18n() rewrites the static
// chrome (data-i18n / -ph / -title / -aria). English is the first-paint default.
var I18N = JSON.parse(document.getElementById('i18n-data')?.textContent || '{}');
// Cross-reopen persistence. Electron persists via the main process (window.monacoriSettings — survives
// app restart; file:// localStorage doesn't); browser/serve falls back to localStorage. persistRead
// returns the bridge value (native) if present, else undefined so callers parse localStorage themselves.
function persistRead(key) {
  try { if (window.monacoriSettings && window.monacoriSettings.all && key in window.monacoriSettings.all) return window.monacoriSettings.all[key]; } catch (e) {}
  return undefined;
}
function persistSave(key, value) {
  try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) {}
  try { if (window.monacoriSettings) window.monacoriSettings.set(key, value); } catch (e2) {}
}
var LOCALE_KEY = 'monacori-locale';
var locale = (function () {
  var v = persistRead(LOCALE_KEY);
  if (v !== 'ko' && v !== 'en') { try { v = localStorage.getItem(LOCALE_KEY); } catch (e) {} }
  return (v === 'ko' || v === 'en') ? v : 'en';
})();
function t(key) { var m = (I18N[locale] || I18N.en || {}); return (m && key in m) ? m[key] : ((I18N.en && I18N.en[key]) || key); }
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  document.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  document.documentElement.lang = locale;
  var sel = document.getElementById('settings-language');
  if (sel) sel.value = locale;
}
const fileStates = JSON.parse(document.getElementById('file-state-data')?.textContent || '[]');
const httpEnvironments = JSON.parse(document.getElementById('http-env-data')?.textContent || '{}');
const httpEnvNames = Object.keys(httpEnvironments);
const httpEnvKey = 'monacori-http-env:' + location.pathname;
const httpRequestsByPath = new Map();
const httpVarsByPath = new Map();
const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
// Phase 2b lazy-LOAD: source content is fetched once after first paint (serve /source-data or the
// Electron bridge) and merged into the metadata-only source records; until then sourceLoaded is false
// and the source view shows a brief loading state. Non-lazy-load modes embed source -> already loaded.
var sourceLoaded = !REVIEW_LAZY_LOAD;
var pendingSourceOpen = null;
var sourceLoading = false;
var pendingSymbol = null;
var sourceTabs = []; // Files-mode tab paths (session-only); see addSourceTab / renderSourceTabs.
// The source blob (content + image base64) is large on big repos, so lazy-LOAD fetches it lazily — on
// the first source-view open or go-to-definition — not eagerly at startup. Idempotent.
function loadSourceData() {
  if (sourceLoaded || sourceLoading) return;
  sourceLoading = true;
  var p;
  if (typeof window !== 'undefined' && window.monacoriFile && typeof window.monacoriFile.getSourceData === 'function') {
    p = Promise.resolve().then(function () { return window.monacoriFile.getSourceData(); });
  } else if (typeof fetch !== 'undefined') {
    p = fetch('source-data').then(function (r) { return r.ok ? r.text() : '[]'; });
  } else {
    p = Promise.resolve('[]');
  }
  p.then(function (text) {
    var data = [];
    try { data = JSON.parse(text || '[]'); } catch (e) { data = []; }
    for (var i = 0; i < data.length; i++) {
      var existing = sourceByPath.get(data[i].path);
      if (existing) { existing.content = data[i].content; if (data[i].image) existing.image = data[i].image; }
    }
    sourceLoaded = true;
    sourceLoading = false;
    try { startSymbolIndex(); } catch (e) {}
    if (pendingSourceOpen) { var po = pendingSourceOpen; pendingSourceOpen = null; openSourceFile(po.path, po.shouldSwitch); }
    else if (isSourceViewerVisible() && document.getElementById('source-viewer').dataset.openPath) { openSourceFile(document.getElementById('source-viewer').dataset.openPath, false); }
    if (pendingSymbol) { var s = pendingSymbol; pendingSymbol = null; goToDefOrUsages(s); }
  }, function () { sourceLoaded = true; sourceLoading = false; });
}
const fileSignatureByPath = new Map(fileStates.map((file) => [file.path, file.signature]));
const reviewMeta = document.getElementById('review-meta');
const watchEnabled = reviewMeta?.dataset.watch === 'true';
const currentSignature = reviewMeta?.dataset.signature || '';
const uiStateKey = 'monacori-diff-ui:' + location.pathname;
const recentKey = 'monacori-diff-recent:' + location.pathname;
const viewedKey = 'monacori-diff-viewed:' + location.pathname;
const quickOpen = document.getElementById('quick-open');
const quickInput = document.getElementById('quick-open-input');
const quickResults = document.getElementById('quick-open-results');
const quickModeLabel = document.getElementById('quick-open-mode');
let current = -1;
let checkingForUpdates = false;
let lastShiftAt = 0;
let lastShiftSide = 0;
let quickMode = 'all';
let quickItems = [];
let quickActive = 0;
let usageItems = []; // find-usages results for the Cmd+B-on-declaration popup
let usageActive = 0;
let viewerCursor = null;
let selectedCommentRow = null; // a comment box "selected" while navigating with arrows (caret hidden); Backspace deletes it
let currentHttpEnvName = (function () {
  let saved = '';
  try { saved = localStorage.getItem(httpEnvKey) || ''; } catch (error) { saved = ''; }
  if (saved && httpEnvNames.indexOf(saved) >= 0) return saved;
  return httpEnvNames.length ? httpEnvNames[0] : '';
})();
let treeFocusIndex = -1;
let selectionAnchor = null;
let diffCursor = null; // { path, side: 'old'|'new', rowIndex, column } — keyboard caret in the side-by-side diff
// Cursor-position history for Cmd/Ctrl+[ (back) and Cmd/Ctrl+] (forward), IDE-style.
let navList = [];
let navPos = -1;
let navSuppress = false;
var NAV_JUMP_LINES = 8;
var NAV_MAX = 60;
let diffSelectionAnchor = null; // { side, rowIndex, column } — Shift+Arrow drag-select origin in the diff
let measuredCharWidth = 0;

// Review-comment state — initialized here (early) so saved comments are loaded before
// restoreUiState()/openDefaultSourceFile() run on startup and try to render them.
var COMMENTS_KEY = 'monacori-comments:' + location.pathname;
var reviewComments = [];
reviewComments = (function () { var b = persistRead(COMMENTS_KEY); if (Array.isArray(b)) return b; try { return JSON.parse(localStorage.getItem(COMMENTS_KEY) || '[]'); } catch (commentsErr) { return []; } })();
if (!Array.isArray(reviewComments)) reviewComments = [];
var commentSeq = reviewComments.reduce(function (max, c) { return Math.max(max, c.seq || 0); }, 0);
var composerState = null;

function prepareDiff2HtmlHunks() {
  const wrappers = Array.from(document.querySelectorAll('.d2h-file-wrapper'));
  let globalHunkIndex = 0;
  wrappers.forEach((wrapper, fileIndex) => {
    wrapper.id = 'file-' + fileIndex;
    const fileName = wrapper.querySelector('.d2h-file-name')?.textContent?.trim() || '';
    const headerToIndex = new Map();
    const rows = Array.from(wrapper.querySelectorAll('tr'));
    rows.forEach((row) => {
      const header = row.textContent.trim();
      if (!header.startsWith('@@')) return;
      let index = headerToIndex.get(header);
      if (index === undefined) {
        index = globalHunkIndex;
        headerToIndex.set(header, index);
        row.classList.add('hunk');
        row.id = 'hunk-' + index;
        globalHunkIndex += 1;
      } else {
        row.classList.add('hunk-peer');
      }
      row.dataset.hunkIndex = String(index);
      row.dataset.file = fileName;
    });
  });
}

prepareViewedControls();

function prepareViewedControls() {
  pruneViewedState();
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    const fileName = wrapper.querySelector('.d2h-file-name')?.textContent?.trim() || '';
    const toggle = wrapper.querySelector('.d2h-file-collapse');
    const input = toggle?.querySelector('input');
    if (!fileName || !toggle || !input) return;
    toggle.title = t('btn.viewed.title');
    input.tabIndex = -1;
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      setFileViewed(fileName, !isFileViewed(fileName));
    });
  });
  applyViewedState();
}

function loadViewedState() {
  try {
    const value = JSON.parse(localStorage.getItem(viewedKey) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveViewedState(value) {
  try {
    localStorage.setItem(viewedKey, JSON.stringify(value));
  } catch {}
}

function currentFileSignature(path) {
  return fileSignatureByPath.get(path) || '';
}

function isFileViewed(path) {
  const viewed = loadViewedState();
  const signature = currentFileSignature(path);
  return Boolean(signature && viewed[path] === signature);
}

function setFileViewed(path, viewed) {
  const state = loadViewedState();
  if (viewed) {
    const signature = currentFileSignature(path);
    if (signature) state[path] = signature;
  } else {
    delete state[path];
  }
  saveViewedState(state);
  applyViewedState();
}

function pruneViewedState() {
  const state = loadViewedState();
  let changed = false;
  Object.keys(state).forEach((path) => {
    if (state[path] !== currentFileSignature(path)) {
      delete state[path];
      changed = true;
    }
  });
  if (changed) saveViewedState(state);
}

function applyViewedState() {
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    const fileName = wrapper.querySelector('.d2h-file-name')?.textContent?.trim() || '';
    const viewed = isFileViewed(fileName);
    wrapper.classList.toggle('file-viewed', viewed);
    const checkbox = wrapper.querySelector('.d2h-file-collapse-input');
    if (checkbox) checkbox.checked = viewed;
  });
  // Viewed is a diff-review concept: only the Changes list shows it, not the Files/source tree.
  links.forEach((link) => {
    link.classList.toggle('viewed', isFileViewed(link.dataset.file || ''));
  });
  updateDiffViewedToggle();
}

// The diff file header is merged into the toolbar; this reflects the active file's viewed state there.
function updateDiffViewedToggle() {
  var btn = document.getElementById('diff-viewed-toggle');
  if (!btn) return;
  var path = btn.dataset.file || '';
  var known = Boolean(path && currentFileSignature(path));
  btn.hidden = !known;
  if (!known) return;
  var viewed = isFileViewed(path);
  btn.classList.toggle('is-viewed', viewed);
  btn.setAttribute('aria-pressed', viewed ? 'true' : 'false');
}

let activeDiffRow = null;
function firstCodeRowOfHunk(hunkRow) {
  let row = hunkRow.nextElementSibling;
  let firstRow = null;
  while (row && !row.classList.contains('hunk') && !row.classList.contains('hunk-peer')) {
    if (row.querySelector && row.querySelector('.d2h-code-side-line')) {
      if (!firstRow) firstRow = row;
      if (row.querySelector('.d2h-ins, .d2h-del, ins, del')) return row;
    }
    row = row.nextElementSibling;
  }
  return firstRow || hunkRow;
}

// First row in a hunk to land the caret on. F7 should track the NEW (right) file, so prefer the
// first change on the new side anywhere in the hunk (additions / modifications) and only fall back
// to the old side for a pure-deletion hunk that has nothing on the new side. The .hunk marker sits
// on the OLD side and the two side tables are positionally aligned row-for-row, so the new-side row
// at the same index is the counterpart. Without this, a hunk that begins with deletions lands the
// caret on the old-side deletion instead of the added lines below it.
function isChangeCodeRow(row) {
  return !!(row && isDiffCodeRow(row) && row.querySelector('.d2h-ins, .d2h-del, ins, del'));
}
function firstChangeRowForCaret(hunkRow) {
  const wrapper = hunkRow.closest('.d2h-file-wrapper');
  const sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  const hunkSideEl = hunkRow.closest('.d2h-file-side-diff');
  if (sides.length >= 2 && hunkSideEl) {
    const hunkRows = Array.from(hunkSideEl.querySelectorAll('tr')); // old side (carries the .hunk marker)
    const otherEl = hunkSideEl === sides[0] ? sides[1] : sides[0];   // new side
    const otherRows = Array.from(otherEl.querySelectorAll('tr'));
    let fallbackOld = null;
    for (let i = hunkRows.indexOf(hunkRow) + 1; i < hunkRows.length; i++) {
      const hr = hunkRows[i];
      if (hr.classList.contains('hunk') || hr.classList.contains('hunk-peer')) break;
      if (isChangeCodeRow(otherRows[i])) return otherRows[i]; // first new-side change wins (track the new file)
      if (fallbackOld === null && isChangeCodeRow(hr)) fallbackOld = hr; // remember the first old-side change
    }
    if (fallbackOld) return fallbackOld; // pure-deletion hunk: nothing added, so land on the deletion
  }
  return firstCodeRowOfHunk(hunkRow);
}
function focusDiffRow(row) {
  if (activeDiffRow) activeDiffRow.classList.remove('diff-active-row');
  activeDiffRow = row || null;
  if (!row) return;
  row.classList.add('diff-active-row');
  // move the diff caret to follow hunk navigation (F7 / Shift+F7 / [ / ])
  const navInfo = diffRowInfoFromNode(row);
  if (navInfo && navInfo.path) {
    let navSide = navInfo.side;
    if (navSide === 'old') { // prefer the new (modified) side when it has a real line at this row
      const navWrap = diffWrapperByPath(navInfo.path);
      if (isDiffCodeRow(navWrap ? diffRowAt(navWrap, 'new', navInfo.rowIndex) : null)) navSide = 'new';
    }
    setDiffCursor(navInfo.path, navSide, navInfo.rowIndex, 0, false);
  }
}

function renderBreadcrumb(container, path) {
  if (!container) return;
  container.textContent = '';
  const parts = (path || '').split('/').filter(Boolean);
  parts.forEach((seg, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      container.appendChild(sep);
    }
    const span = document.createElement('span');
    span.className = i === parts.length - 1 ? 'crumb crumb-leaf' : 'crumb';
    span.textContent = seg;
    container.appendChild(span);
  });
}

// Coalesce diff-nav scrolls: hammering F7 / [ / ] schedules at most one
// scrollIntoView per frame (to the latest target) instead of forcing a
// synchronous reflow on every keystroke.
var pendingDiffScrollRow = null;
var diffScrollRaf = 0;
function scheduleDiffScroll(row) {
  pendingDiffScrollRow = row || null;
  if (diffScrollRaf) return;
  diffScrollRaf = requestAnimationFrame(function () {
    diffScrollRaf = 0;
    var r = pendingDiffScrollRow;
    pendingDiffScrollRow = null;
    if (r && r.scrollIntoView) r.scrollIntoView({ block: 'center' });
  });
}

function setActive(index, shouldScroll = true) {
  if (hunkTotal() === 0) return;
  current = ((index % hunkTotal()) + hunkTotal()) % hunkTotal();
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  setTab('changes');
  const file = hunkPathAt(current);
  const idx = current;
  links.forEach((link) => link.classList.toggle('active', link.dataset.file === file));
  renderBreadcrumb(document.getElementById('diff-breadcrumb'), file);
  var dvt = document.getElementById('diff-viewed-toggle');
  if (dvt) dvt.dataset.file = file || '';
  updateDiffViewedToggle();
  if (file) rememberRecent(file, 'change');
  history.replaceState(null, '', '#hunk-' + idx);
  // Row-dependent work waits for the file body (sync for eager/Phase 1, async for cold lazy-LOAD).
  whenFileReady(diffWrapperByPath(file), function () {
    showOnlyFile(file);
    const active = document.getElementById('hunk-' + idx);
    if (!active) return;
    if (REVIEW_LAZY) {
      document.querySelectorAll('#diff2html-container .hunk.active, #diff2html-container .hunk-peer.active').forEach((h) => h.classList.remove('active'));
      document.querySelectorAll('#diff2html-container [data-hunk-index="' + idx + '"]').forEach((h) => h.classList.add('active'));
    } else {
      hunks.forEach((hunk, i) => hunk.classList.toggle('active', i === idx));
      hunkPeers.forEach((hunk) => hunk.classList.toggle('active', Number(hunk.dataset.hunkIndex) === idx));
    }
    const targetRow = firstChangeRowForCaret(active);
    // F7/change navigation moves the caret but must NOT pollute the Cmd+[/] cursor history.
    navSuppress = true;
    try { focusDiffRow(targetRow); } finally { navSuppress = false; }
    if (shouldScroll && targetRow) scheduleDiffScroll(targetRow);
  });
}

function showOnlyFile(fileName) {
  if (REVIEW_LAZY) ensureFileReady(diffWrapperByPath(fileName));
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    wrapper.classList.toggle('df-inactive', diffWrapperPathKey(wrapper) !== fileName);
  });
  ensureDiffCursor();
}

// The hunk the diff caret currently sits in. Arrow keys move the caret without touching the active
// index (the F7 anchor), so navigation must read the caret's real position -- otherwise pressing F7
// after arrowing to the bottom of a file re-treads hunks already passed instead of going to the next file.
function hunkIndexAtCaret() {
  if (!diffCursor) return -1;
  const wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return -1;
  const caretRow = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  const sideEl = caretRow ? caretRow.closest('.d2h-file-side-diff') : null;
  if (!sideEl) return -1;
  let found = -1;
  // @@ markers on the caret's side carry data-hunk-index; the nearest one at or above the caret wins.
  sideEl.querySelectorAll('[data-hunk-index]').forEach((marker) => {
    if (marker === caretRow || (caretRow.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_PRECEDING)) {
      found = Number(marker.dataset.hunkIndex);
    }
  });
  return found;
}

// New-side row indices, one per change block — a run of change rows (ins/del) separated by context.
// A wide context window merges several edits into one @@ hunk; stepping by these stops at each edit.
function changeBlockAnchors(wrapper) {
  if (!wrapper) return [];
  if (wrapper.__anchors) return wrapper.__anchors;
  var right = diffSideTables(wrapper).right;
  if (!right) return []; // body not materialized yet — don't cache an empty result
  var rows = diffRowsOf(right);
  var anchors = [];
  var prev = false;
  for (var i = 0; i < rows.length; i++) {
    var chg = isChangeCodeRow(rows[i]);
    if (chg && !prev) anchors.push(i);
    prev = chg;
  }
  wrapper.__anchors = anchors; // change-block layout is static once materialized
  return anchors;
}

function next(delta) {
  if (hunkTotal() === 0) return;
  // Within the caret's (unviewed) file, step change-block by change-block so a context-merged hunk
  // (several separate edits under one @@) stops at every edit instead of skipping to the next file.
  if (diffCursor && isDiffViewVisible()) {
    const w = diffWrapperByPath(diffCursor.path);
    if (w && !isFileViewed(diffCursor.path)) {
      const anchors = changeBlockAnchors(w);
      const cur = diffCursor.rowIndex;
      let target = null;
      if (delta > 0) { for (let a = 0; a < anchors.length; a++) { if (anchors[a] > cur) { target = anchors[a]; break; } } }
      else { for (let b = anchors.length - 1; b >= 0; b--) { if (anchors[b] < cur) { target = anchors[b]; break; } } }
      if (target != null) {
        const row = diffRowAt(w, 'new', target);
        if (row) { navSuppress = true; try { focusDiffRow(row); } finally { navSuppress = false; } scheduleDiffScroll(row); return; }
      }
    }
  }
  // File boundary (no more change blocks this file) → hunk-level nav to the next/prev unviewed file.
  const caretHunk = hunkIndexAtCaret();
  const base = caretHunk >= 0 ? caretHunk : current;
  let idx = base < 0 ? initialHunkForNavigation(delta) : base + delta;
  for (let step = 0; step < hunkTotal(); step++) {
    const norm = ((idx % hunkTotal()) + hunkTotal()) % hunkTotal();
    if (!isFileViewed(hunkPathAt(norm) || '')) { setActive(norm); return; }
    idx += delta;
  }
  // Every changed file is marked viewed — nothing left to review, so F7/[/] stay put.
}

function initialHunkForNavigation(delta) {
  const openPath = document.getElementById('source-viewer')?.dataset.openPath || '';
  const sourceHunk = firstHunkForPath(openPath);
  if (sourceHunk >= 0) return sourceHunk;
  return delta < 0 ? hunkTotal() - 1 : 0;
}

function firstHunkForPath(path) {
  if (!path) return -1;
  const link = links.find((candidate) => candidate.dataset.file === path);
  if (!link) return -1;
  const index = Number(link.dataset.hunk);
  return Number.isNaN(index) ? -1 : index;
}

function openQuickOpen(mode) {
  if (!quickOpen || !quickInput || !quickModeLabel) return;
  quickMode = mode;
  quickModeLabel.textContent = mode === 'recent' ? t('quickopen.recent') : mode === 'content' ? t('quickopen.findInFiles') : t('quickopen.searchFiles');
  quickOpen.classList.remove('hidden');
  quickInput.value = '';
  renderQuickOpenResults();
  setTimeout(() => quickInput.focus(), 0);
}

function closeQuickOpen() {
  quickOpen?.classList.add('hidden');
}

function handleQuickOpenKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeQuickOpen();
    return true;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    quickActive = Math.min(quickActive + 1, Math.max(quickItems.length - 1, 0));
    updateQuickActive();
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    quickActive = Math.max(quickActive - 1, 0);
    updateQuickActive();
    return true;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    openQuickItem(quickItems[quickActive]);
    return true;
  }
  return false;
}

function renderQuickOpenResults() {
  if (!quickResults) return;
  const query = quickInput?.value.trim().toLowerCase() || '';
  const candidates = quickMode === 'recent' && query.length === 0 ? recentItems() : allQuickItems();
  quickItems = candidates
    .filter((item) => quickMode !== 'recent' || query.length > 0 || item.recent)
    .filter((item) => {
      if (query.length === 0) return true;
      if (quickMode === 'content') {
        const file = sourceByPath.get(item.path);
        return Boolean(file && file.embedded && file.content.toLowerCase().includes(query));
      }
      return (item.path + '\n' + item.name + '\n' + item.detail).toLowerCase().includes(query);
    })
    .sort((a, b) => scoreQuickItem(a, query) - scoreQuickItem(b, query) || a.path.localeCompare(b.path))
    .slice(0, 80);
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
  if (quickItems.length === 0) {
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.noFiles')) + '</div>';
    return;
  }
  quickResults.innerHTML = quickItems.map((item, index) => [
    '<button type="button" class="quick-open-item' + (index === quickActive ? ' active' : '') + '" data-index="' + index + '">',
    '<span class="quick-open-main">',
    '<span class="quick-open-name">' + escapeHtml(item.name) + '</span>',
    '<span class="quick-open-path">' + escapeHtml(item.path) + '</span>',
    '</span>',
    '<span class="quick-open-badge">' + escapeHtml(item.detail) + '</span>',
    '</button>',
  ].join('')).join('');
  renderQuickPreview(quickItems[quickActive]);
}

function updateQuickActive() {
  quickResults?.querySelectorAll('.quick-open-item').forEach((element, index) => {
    const active = index === quickActive;
    element.classList.toggle('active', active);
    if (active) element.scrollIntoView({ block: 'nearest' });
  });
  renderQuickPreview(quickItems[quickActive]);
}

function renderQuickPreview(item) {
  const preview = document.getElementById('quick-open-preview');
  if (!preview) return;
  if (!item) { preview.innerHTML = ''; return; }
  const file = sourceByPath.get(item.path);
  if (!file || !file.embedded) {
    preview.innerHTML = '<div class="qp-empty">' + escapeHtml(item.path) + '</div>';
    return;
  }
  const query = ((quickInput && quickInput.value) || '').trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  let firstHit = -1;
  const rows = lines.map((line, i) => {
    const hit = query.length > 0 && line.toLowerCase().includes(query);
    if (hit && firstHit < 0) firstHit = i;
    return '<div class="qp-line' + (hit ? ' qp-hit' : '') + '"><span class="qp-num">' + (i + 1) + '</span><span class="qp-code">' + highlightLine(line, file.language || 'text') + '</span></div>';
  }).join('');
  preview.innerHTML = '<div class="qp-head">' + escapeHtml(item.path) + '</div><div class="qp-body">' + rows + '</div>';
  if (firstHit >= 0) {
    const target = preview.querySelectorAll('.qp-line')[firstHit];
    if (target) target.scrollIntoView({ block: 'center' });
  }
}

function openQuickItem(item) {
  if (!item) return;
  closeQuickOpen();
  rememberRecent(item.path, item.kind);
  if (sourceByPath.has(item.path)) {
    openSourceFile(item.path);
    return;
  }
  const link = links.find((candidate) => candidate.dataset.file === item.path);
  if (!link) return;
  const target = Number(link.dataset.hunk);
  if (!Number.isNaN(target) && target >= 0 && target < hunkTotal()) {
    setActive(target);
  } else {
    showDiffView(false);
    const targetId = link.getAttribute('href')?.slice(1);
    if (targetId) document.getElementById(targetId)?.scrollIntoView({ block: 'center' });
  }
}

function allQuickItems() {
  const items = sourceFiles.map((file) => ({
    path: file.path,
    name: baseName(file.path),
    detail: [file.changed ? 'changed' : 'file', file.language || 'text'].join(' - '),
    kind: 'source',
    recent: false,
  }));
  links.forEach((link) => {
    const path = link.dataset.file || '';
    if (!path || sourceByPath.has(path)) return;
    items.push({ path, name: baseName(path), detail: 'diff', kind: 'change', recent: false });
  });
  const recent = loadRecent();
  const recentRank = new Map(recent.map((item, index) => [item.path, index]));
  return items.map((item) => ({
    ...item,
    recent: recentRank.has(item.path),
    recentRank: recentRank.get(item.path) ?? 9999,
  }));
}

function recentItems() {
  const all = allQuickItems();
  const byPath = new Map(all.map((item) => [item.path, item]));
  return loadRecent()
    .map((item) => byPath.get(item.path) || {
      path: item.path,
      name: baseName(item.path),
      detail: item.kind === 'change' ? 'diff' : 'file',
      kind: item.kind,
      recent: true,
      recentRank: 0,
    })
    .map((item, index) => ({ ...item, recent: true, recentRank: index }));
}

function scoreQuickItem(item, query) {
  let score = item.recentRank ?? 9999;
  if (!query) return score;
  const path = item.path.toLowerCase();
  const name = item.name.toLowerCase();
  if (name === query) score -= 3000;
  else if (name.startsWith(query)) score -= 2000;
  else if (path.includes('/' + query)) score -= 1000;
  else if (path.includes(query)) score -= 500;
  if (item.recent) score -= 100;
  return score;
}

function loadRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(recentKey) || '[]');
    return Array.isArray(value) ? value.filter((item) => item && typeof item.path === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecent(path, kind) {
  if (!path) return;
  const next = [{ path, kind }, ...loadRecent().filter((item) => item.path !== path)].slice(0, 30);
  try {
    localStorage.setItem(recentKey, JSON.stringify(next));
  } catch {}
}

function baseName(path) {
  return String(path).split('/').filter(Boolean).pop() || String(path);
}

// A tree row is navigable only when it is actually visible — i.e. not tucked inside a collapsed
// <details> folder. getClientRects alone is unreliable here: Chromium keeps collapsed <details>
// content laid out (content-visibility), so its descendants still report rects. Walk the ancestor
// <details> and treat anything inside a closed one (other than its own summary) as hidden.
function isTreeRowVisible(el) {
  var node = el;
  while (node) {
    var parent = node.parentElement;
    if (!parent || parent.classList.contains('tab-panel')) return true;
    if (parent.tagName === 'DETAILS' && !parent.open && node.tagName !== 'SUMMARY') return false;
    node = parent;
  }
  return true;
}
function treeRows() {
  const panel = document.querySelector('.tab-panel:not(.hidden)');
  if (!panel) return [];
  return Array.from(panel.querySelectorAll('summary, .file-link')).filter((el) => el.getClientRects().length > 0 && isTreeRowVisible(el));
}

function focusTree(index) {
  const rows = treeRows();
  if (rows.length === 0) return;
  treeFocusIndex = Math.max(0, Math.min(rows.length - 1, index));
  rows.forEach((row, i) => row.classList.toggle('tree-focus', i === treeFocusIndex));
  const el = rows[treeFocusIndex];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function clearTreeFocus() {
  treeFocusIndex = -1;
  document.querySelectorAll('.tree-focus').forEach((el) => el.classList.remove('tree-focus'));
}

// Focus the tree row for the currently open file (source openPath, else the active diff file);
// falls back to the first row when nothing is open or no matching row exists.
function focusOpenFileInTree() {
  const rows = treeRows();
  if (rows.length === 0) return;
  let openPath = document.getElementById('source-viewer')?.dataset.openPath || '';
  if (!openPath && typeof diffActiveWrapper === 'function') {
    const w = diffActiveWrapper();
    const n = w && w.querySelector('.d2h-file-name');
    if (n && n.textContent) openPath = n.textContent.trim();
  }
  let idx = 0;
  if (openPath) {
    for (let i = 0; i < rows.length; i++) {
      const ds = rows[i].dataset || {};
      if (ds.sourceFile === openPath || ds.file === openPath) { idx = i; break; }
    }
  }
  focusTree(idx);
}

function treePageSize() {
  var scroller = document.querySelector('.sidebar-scroll');
  var h = scroller ? scroller.clientHeight : 320;
  return Math.max(1, Math.floor(h / 20) - 1); // ~20px per tree row, minus one for overlap
}
function treeOpenKey() { return 'monacori-tree-open:' + location.pathname; }
function loadTreeOpen() { try { return new Set(JSON.parse(sessionStorage.getItem(treeOpenKey()) || '[]')); } catch (e) { return new Set(); } }
function saveTreeOpen(set) { try { sessionStorage.setItem(treeOpenKey(), JSON.stringify(Array.from(set))); } catch (e) {} }
// Folders start collapsed. Restore the folders the user manually opened, plus reveal the open file's
// path. Toggle listeners attach AFTER the initial state so the auto-revealed path is not mistaken for
// a user-opened folder (keeping "collapsed by default" intact on the next load).
var treeRevealing = false; // true while opening folders programmatically, so those opens are not persisted
function persistTreeToggle(d) {
  var set = loadTreeOpen();
  var dir = d.dataset.dir || '';
  if (d.open) set.add(dir); else set.delete(dir);
  saveTreeOpen(set);
}
function initSourceTreeFolds() {
  var dirs = Array.prototype.slice.call(document.querySelectorAll('.source-dir'));
  if (!dirs.length) return;
  var saved = loadTreeOpen();
  var openPath = (document.getElementById('source-viewer') && document.getElementById('source-viewer').dataset.openPath) || '';
  // Only USER toggles persist; the initial state below is applied under treeRevealing so the open
  // file's revealed path stays transient (folders stay "collapsed by default" on the next load).
  dirs.forEach(function (d) {
    d.addEventListener('toggle', function () { if (!treeRevealing) persistTreeToggle(d); });
  });
  treeRevealing = true;
  dirs.forEach(function (d) {
    var dir = d.dataset.dir || '';
    var reveal = openPath && (openPath === dir || openPath.indexOf(dir + '/') === 0);
    d.open = saved.has(dir) || !!reveal;
  });
  setTimeout(function () { treeRevealing = false; }, 0);
}
// Expand a file's ancestor folders so it is visible in the tree (transient — not persisted), then
// scroll its row into view. Called whenever a source file opens (tree click, go-to-definition, etc.).
function revealTreeFor(path) {
  if (!path) return;
  treeRevealing = true;
  document.querySelectorAll('.source-dir').forEach(function (d) {
    var dir = d.dataset.dir || '';
    if (dir && (path === dir || path.indexOf(dir + '/') === 0) && !d.open) d.open = true;
  });
  setTimeout(function () { treeRevealing = false; }, 0);
  var active = document.querySelector('.source-link.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}
function handleTreeKey(event) {
  const rows = treeRows();
  if (rows.length === 0) return false;
  if (treeFocusIndex >= rows.length) treeFocusIndex = rows.length - 1;
  const row = rows[treeFocusIndex];
  const isFolder = row && row.tagName === 'SUMMARY';
  if (event.key === 'ArrowDown') { event.preventDefault(); focusTree(treeFocusIndex + 1); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); focusTree(treeFocusIndex - 1); return true; }
  if (event.key === 'PageDown') { event.preventDefault(); focusTree(treeFocusIndex + treePageSize()); return true; }
  if (event.key === 'PageUp') { event.preventDefault(); focusTree(treeFocusIndex - treePageSize()); return true; }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (row && row.classList.contains('file-link')) { row.click(); clearTreeFocus(); }
    else if (isFolder && row.parentElement) row.parentElement.open = !row.parentElement.open;
    return true;
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (isFolder && row.parentElement && !row.parentElement.open) row.parentElement.open = true;
    else focusTree(treeFocusIndex + 1);
    return true;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (isFolder && row.parentElement && row.parentElement.open) row.parentElement.open = false;
    else focusTree(treeFocusIndex - 1);
    return true;
  }
  if (event.key === 'Escape') { event.preventDefault(); clearTreeFocus(); return true; }
  return false;
}

document.addEventListener('keydown', (event) => {
  if (!quickOpen?.classList.contains('hidden')) {
    if (handleQuickOpenKey(event)) return;
  }
  var usagesBox = document.getElementById('usages');
  if (usagesBox && !usagesBox.classList.contains('hidden')) {
    if (handleUsagesKey(event)) return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key === '1') {
    event.preventDefault();
    setTab('files');
    focusOpenFileInTree();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === '0') {
    event.preventDefault();
    setTab('changes');
    focusOpenFileInTree();
    return;
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

  // Merged comment views — see every saved comment of one kind at once + copy-all to paste into a prompt:
  //   Cmd/Ctrl+Shift+/ ("?") = all questions, Cmd/Ctrl+Shift+. (">") = all change-requests.
  // Match the PHYSICAL key (event.code) so macOS/IME/layout never swallows the combo; fires in any focus.
  if ((event.metaKey || event.ctrlKey) && (event.code === 'Slash' || event.code === 'Period' || event.key === '?' || event.key === '>')) {
    event.preventDefault();
    openMergedView((event.code === 'Slash' || event.key === '?') ? 'q' : 'c');
    return;
  }
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

  // "<" (Shift+,) toggles "viewed" for the current file (source openPath, else active diff file).
  if (!event.altKey && !event.metaKey && !event.ctrlKey && event.key === '<') {
    const ce2 = document.activeElement;
    const inEditable2 = ce2 && (ce2.tagName === 'INPUT' || ce2.tagName === 'TEXTAREA' || ce2.tagName === 'SELECT');
    if (!inEditable2) {
      let vp = isSourceViewerVisible() ? (document.getElementById('source-viewer')?.dataset.openPath || '') : '';
      if (!vp && typeof diffActiveWrapper === 'function') {
        const vw = diffActiveWrapper();
        const vn = vw && vw.querySelector('.d2h-file-name');
        if (vn && vn.textContent) vp = vn.textContent.trim();
      }
      if (vp && currentFileSignature(vp)) {
        event.preventDefault();
        setFileViewed(vp, !isFileViewed(vp));
        return;
      }
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

  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openQuickOpen('content');
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
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
  }

  if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowDown') {
    event.preventDefault();
    if (isSourceViewerVisible()) goToSymbolUnderCursor();
    else openDiffFileAtCaret();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && (event.key === 'b' || event.key === 'B')) {
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
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && isDiffViewVisible() && diffCursor) {
    event.preventDefault();
    const edgeWrap = diffWrapperByPath(diffCursor.path);
    const edgeRow = edgeWrap ? diffRowAt(edgeWrap, diffCursor.side, diffCursor.rowIndex) : null;
    const edgeLen = edgeRow ? diffLineText(edgeRow).length : 0;
    if (event.key === 'ArrowLeft') {
      if (diffCursor.column > 0) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, 0, true); // -> line start
      } else if (diffCursor.side === 'new') { // already at start -> cross to old (left)
        const oldRow = edgeWrap ? diffRowAt(edgeWrap, 'old', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(oldRow)) setDiffCursor(diffCursor.path, 'old', diffCursor.rowIndex, diffLineText(oldRow).length, true);
      }
    } else { // ArrowRight
      if (diffCursor.column < edgeLen) {
        setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, edgeLen, true); // -> line end
      } else if (diffCursor.side === 'old') { // already at end -> cross to new (right)
        const newRow = edgeWrap ? diffRowAt(edgeWrap, 'new', diffCursor.rowIndex) : null;
        if (isDiffCodeRow(newRow)) setDiffCursor(diffCursor.path, 'new', diffCursor.rowIndex, 0, true);
      }
    }
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
      if (event.key === '[') navBack(); else navForward();
      return;
    }
  }

  if (event.key === 'F7') {
    event.preventDefault();
    if (!document.getElementById('source-viewer')?.classList.contains('hidden')) {
      const sourceHunk = firstHunkForPath(document.getElementById('source-viewer')?.dataset.openPath || '');
      if (sourceHunk >= 0) {
        setActive(sourceHunk);
        return;
      }
    }
    next(event.shiftKey ? -1 : 1);
  }
});

quickInput?.addEventListener('input', () => renderQuickOpenResults());
quickResults?.addEventListener('mousemove', (event) => {
  const item = event.target.closest?.('.quick-open-item');
  if (!item) return;
  quickActive = Number(item.dataset.index || 0);
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

links.forEach((link) => {
  link.addEventListener('click', (event) => {
    showDiffView(false);
    const target = Number(link.dataset.hunk);
    if (!Number.isNaN(target) && target >= 0 && target < hunkTotal()) {
      event.preventDefault();
      setActive(target);
    }
  });
});

// Delegated so it works whether the tree is inline (small repos) or materialized later (big repos).
document.getElementById('files-panel')?.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('.source-link') : null;
  if (link && link.dataset.sourceFile) openSourceFile(link.dataset.sourceFile);
});

document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => setTab(button.dataset.tab || 'changes'));
});

document.getElementById('back-to-diff')?.addEventListener('click', () => showDiffView(true));
document.getElementById('source-tabs')?.addEventListener('click', function (event) {
  var closeBtn = event.target && event.target.closest && event.target.closest('.source-tab-close');
  if (closeBtn) { event.stopPropagation(); event.preventDefault(); closeSourceTab(closeBtn.getAttribute('data-close-path')); return; }
  var tab = event.target && event.target.closest && event.target.closest('.source-tab');
  if (tab) openSourceFile(tab.getAttribute('data-tab-path'));
});
document.getElementById('diff-viewed-toggle')?.addEventListener('click', function () {
  var btn = document.getElementById('diff-viewed-toggle');
  var path = btn ? (btn.dataset.file || '') : '';
  if (path) setFileViewed(path, !isFileViewed(path));
});
document.getElementById('source-body')?.addEventListener('click', handleSourceClick);
document.getElementById('source-body')?.addEventListener('click', function (event) {
  var img = event.target && event.target.closest && event.target.closest('.image-preview');
  if (img) openLightbox(img.getAttribute('src'), img.getAttribute('alt'));
});
document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && lightboxOpen()) { event.preventDefault(); event.stopPropagation(); closeLightbox(); }
}, true);
document.addEventListener('copy', handleSourceCopy);

applyI18n(); // first paint already shows English (inline); this swaps to the saved locale before the rest of init renders dynamic text
populateHttpEnvSelect();
if (!REVIEW_LAZY_LOAD) setTimeout(startSymbolIndex, 0); // non-lazy indexes now; lazy-LOAD defers the (large) source blob + index to the first source-view open / go-to-def
const restored = restoreUiState();
if (!restored) {
  const initial = location.hash.match(/^#hunk-(\d+)$/);
  if (initial) setActive(Number(initial[1]), false);
  else if (REVIEW_LAZY_LOAD) showDiffView(false); // big repos: open to the diff (Changes); the source tree stays deferred until the Files tab is opened
  else openDefaultSourceFile();
}
initSourceTreeFolds();
if (watchEnabled) setInterval(checkForLiveUpdate, 1500);
window.addEventListener('beforeunload', saveUiState);

(function setupSidebarResize() {
  const resizer = document.querySelector('.sidebar-resizer');
  if (!resizer) return;
  const sidebarKey = 'monacori-sidebar-width:' + location.pathname;
  const saved = localStorage.getItem(sidebarKey);
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
    const width = Math.min(640, Math.max(180, event.clientX));
    document.documentElement.style.setProperty('--sidebar-width', width + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    resizer.classList.remove('resizing');
    document.body.style.userSelect = '';
    try { localStorage.setItem(sidebarKey, getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width').trim()); } catch (e) {}
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
    const info = diffRowInfoFromNode(event.target);
    if (info && info.path) setDiffCursor(info.path, info.side, info.rowIndex, 0, false);
  });
  ensureDiffCursor();
})();

// ===== Side-by-side diff caret (keyboard navigation across the old/new panes) =====
function isDiffViewVisible() {
  var d = document.getElementById('diff-view');
  return Boolean(d && !d.classList.contains('hidden'));
}
function diffActiveWrapper() {
  return document.querySelector('#diff2html-container .d2h-file-wrapper:not(.df-inactive)')
    || document.querySelector('#diff2html-container .d2h-file-wrapper');
}
// path -> wrapper, O(1) after the first build. Rebuilt only on a miss/disconnect
// (the wrapper set is stable; only bodies materialize). This is called several times
// per F7 press, so the old O(files) querySelector scan made each keystroke cost scale
// with the file count — the main source of cross-file nav stutter on big diffs.
var wrapperPathMap = null;
function diffWrapperPathKey(w) {
  return (w.dataset && w.dataset.path) || ((w.querySelector('.d2h-file-name') || {}).textContent || '').trim();
}
function diffWrapperByPath(path) {
  if (wrapperPathMap) {
    var hit = wrapperPathMap.get(path);
    if (hit && hit.isConnected) return hit;
  }
  wrapperPathMap = new Map();
  var ws = document.querySelectorAll('#diff2html-container .d2h-file-wrapper');
  for (var i = 0; i < ws.length; i++) {
    var key = diffWrapperPathKey(ws[i]);
    if (key) wrapperPathMap.set(key, ws[i]);
  }
  return wrapperPathMap.get(path) || null;
}
function diffSideTables(wrapper) {
  var sides = wrapper ? wrapper.querySelectorAll('.d2h-file-side-diff') : [];
  return { left: sides[0] || null, right: sides[sides.length - 1] || null };
}
function diffSideTable(wrapper, side) {
  var t = diffSideTables(wrapper);
  return side === 'old' ? t.left : t.right;
}
function diffRowsOf(sideTable) {
  if (!sideTable) return [];
  return Array.prototype.slice.call(sideTable.querySelectorAll('tr')).filter(function (r) {
    return !r.classList.contains('mc-comment-row') && !r.classList.contains('mc-spacer-row');
  });
}
function diffRowAt(wrapper, side, rowIndex) {
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  return rows[rowIndex] || null;
}
function diffCellCtn(row) {
  return row ? row.querySelector('.d2h-code-line-ctn') : null;
}
function diffLineText(row) {
  var ctn = diffCellCtn(row);
  return ctn ? (ctn.textContent || '') : '';
}
function diffLineNumber(row) {
  var n = row ? row.querySelector('.d2h-code-side-linenumber') : null;
  var v = n ? parseInt((n.textContent || '').trim(), 10) : NaN;
  return isFinite(v) ? v : null;
}
function diffRowInfoFromNode(node) {
  var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  if (!el || !el.closest) return null;
  var wrapper = el.closest('.d2h-file-wrapper');
  var sideEl = el.closest('.d2h-file-side-diff');
  var row = el.closest('tr');
  if (!wrapper || !sideEl || !row) return null;
  var nameEl = wrapper.querySelector('.d2h-file-name');
  var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
  var t = diffSideTables(wrapper);
  var side = sideEl === t.left ? 'old' : 'new';
  if (!isDiffCodeRow(row)) return null;
  var rowIndex = diffRowsOf(sideEl).indexOf(row);
  if (!path || rowIndex < 0) return null;
  return { path: path, side: side, rowIndex: rowIndex };
}
function diffCaretDomPosition(ctn, column) {
  if (!ctn) return null;
  var remaining = column;
  var walker = document.createTreeWalker(ctn, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode())) {
    var len = node.textContent.length;
    if (remaining <= len) return { node: node, offset: remaining };
    remaining -= len;
  }
  return { node: ctn, offset: ctn.childNodes.length };
}
var diffCaretSpan = null;
function clearDiffCaret() {
  var container = document.getElementById('diff2html-container');
  if (container) {
    container.querySelectorAll('.mc-diff-cursor-row').forEach(function (r) { r.classList.remove('mc-diff-cursor-row'); });
    // remove ALL caret spans (not just the tracked one) so a stray indicator never lingers
    container.querySelectorAll('.code-cursor').forEach(function (s) { var p = s.parentNode; if (p) { p.removeChild(s); if (p.normalize) p.normalize(); } });
  }
  diffCaretSpan = null;
}
function renderDiffCaret() {
  clearDiffCaret();
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  if (!row) return;
  row.classList.add('mc-diff-cursor-row');
  var ctn = diffCellCtn(row);
  if (!ctn) return;
  // Empty line (ctn is just a <br>): the row highlight marks the caret. Inserting a caret span
  // next to the <br> would push it onto a second visual line and break the row's height.
  if ((ctn.textContent || '').length === 0) return;
  var pos = diffCaretDomPosition(ctn, diffCursor.column);
  if (!pos) return;
  var span = document.createElement('span');
  span.className = 'code-cursor';
  span.setAttribute('aria-hidden', 'true');
  try {
    var off = pos.node.nodeType === 3 ? Math.min(pos.offset, (pos.node.textContent || '').length) : pos.offset;
    var range = document.createRange();
    range.setStart(pos.node, off);
    range.collapse(true);
    range.insertNode(span);
    diffCaretSpan = span;
  } catch (e) { diffCaretSpan = null; }
}
function setDiffCursor(path, side, rowIndex, column, reveal) {
  markCaretBusy();
  var wrapper = diffWrapperByPath(path);
  if (!wrapper) return;
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  if (!rows.length) return;
  var ri = Math.max(0, Math.min(rowIndex, rows.length - 1));
  var col = Math.max(0, Math.min(column, diffLineText(rows[ri]).length));
  diffCursor = { path: path, side: side, rowIndex: ri, column: col };
  diffSelectionAnchor = null; // any direct caret placement (click/F7/Cmd-arrow) drops the selection; Shift+Arrow re-sets it
  renderDiffCaret();
  applyDiffSelection();
  if (reveal) {
    var r = diffRowAt(wrapper, side, ri);
    if (r && r.scrollIntoView) requestAnimationFrame(function () { try { r.scrollIntoView({ block: 'nearest' }); } catch (e) {} });
  }
  recordNav(navEntryOf('diff'));
}
function navEntryOf(kind) {
  if (kind === 'diff') {
    if (!diffCursor) return null;
    return { kind: 'diff', path: diffCursor.path, side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column, line: diffCursor.rowIndex };
  }
  if (!viewerCursor) return null;
  return { kind: 'source', path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: viewerCursor.column, line: viewerCursor.lineIndex };
}
function navSamePos(a, b) {
  return !!(a && b && a.kind === b.kind && a.path === b.path && a.line === b.line && (a.kind !== 'diff' || a.side === b.side));
}
// Record a caret placement into the back/forward history. Contiguous small moves refresh the
// current entry (so arrowing around does not flood it); a jump (different file or a far line)
// pushes a new entry and drops any forward history.
function recordNav(entry) {
  if (navSuppress || !entry) return;
  var cur = navPos >= 0 ? navList[navPos] : null;
  if (navSamePos(cur, entry)) { navList[navPos] = entry; return; }
  var small = cur && cur.kind === entry.kind && cur.path === entry.path && Math.abs(cur.line - entry.line) < NAV_JUMP_LINES;
  if (small) { navList[navPos] = entry; return; }
  navList = navList.slice(0, navPos + 1);
  navList.push(entry);
  navPos = navList.length - 1;
  if (navList.length > NAV_MAX) { navList.shift(); navPos -= 1; }
}
function revealDiffFile(path) {
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  setTab('changes');
  showOnlyFile(path);
  links.forEach(function (link) { link.classList.toggle('active', link.dataset.file === path); });
  renderBreadcrumb(document.getElementById('diff-breadcrumb'), path);
}
function restoreNav(entry) {
  if (!entry) return;
  navSuppress = true;
  try {
    if (entry.kind === 'diff') {
      revealDiffFile(entry.path);
      setDiffCursor(entry.path, entry.side, entry.rowIndex, entry.column, true);
    } else {
      setSourceCursor(entry.path, entry.lineIndex, entry.column, true, -1);
    }
  } finally {
    navSuppress = false;
  }
}
function navBack() {
  if (navPos < 0) return;
  // Change-nav (F7) does not record positions. If the caret has drifted past the last recorded
  // spot, the first Cmd+[ returns to it; the next steps further back through the cursor history.
  var live = navEntryOf(isSourceViewerVisible() ? 'source' : 'diff');
  if (live && !navSamePos(live, navList[navPos])) { restoreNav(navList[navPos]); return; }
  if (navPos > 0) { navPos -= 1; restoreNav(navList[navPos]); }
}
function navForward() {
  if (navPos < navList.length - 1) { navPos += 1; restoreNav(navList[navPos]); }
}
function applyDiffSelection() {
  var sel = window.getSelection();
  if (!sel) return;
  // Selection only makes sense within one pane and one file; otherwise clear it.
  if (!diffSelectionAnchor || !diffCursor || diffSelectionAnchor.side !== diffCursor.side) { try { sel.removeAllRanges(); } catch (e) {} return; }
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) { try { sel.removeAllRanges(); } catch (e) {} return; }
  var aCtn = diffCellCtn(diffRowAt(wrapper, diffSelectionAnchor.side, diffSelectionAnchor.rowIndex));
  var cCtn = diffCellCtn(diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex));
  var a = aCtn ? diffCaretDomPosition(aCtn, diffSelectionAnchor.column) : null;
  var c = cCtn ? diffCaretDomPosition(cCtn, diffCursor.column) : null;
  if (a && c) { try { sel.setBaseAndExtent(a.node, a.offset, c.node, c.offset); } catch (e) {} }
}
function isDiffCodeRow(row) {
  if (!row) return false;
  if (row.querySelector('.d2h-emptyplaceholder, .d2h-code-side-emptyplaceholder')) return false; // added/removed counterpart — no real line
  if (!row.querySelector('.d2h-code-line-ctn')) return false;
  var num = row.querySelector('.d2h-code-side-linenumber');
  return !!num && (num.textContent || '').trim().length > 0; // real code line has a line number (excludes hunk-info rows)
}
function firstDiffCodeRow(wrapper, side) {
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  for (var i = 0; i < rows.length; i++) { if (isDiffCodeRow(rows[i])) return i; }
  return -1;
}
function ensureDiffCursor() {
  if (!isDiffViewVisible()) return;
  var wrapper = diffActiveWrapper();
  if (!wrapper) return;
  whenFileReady(wrapper, function () {
    var nameEl = wrapper.querySelector('.d2h-file-name');
    var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
    if (!path) return;
    if (diffCursor && diffCursor.path === path) { renderDiffCaret(); return; }
    var ri = firstDiffCodeRow(wrapper, 'new');
    if (ri < 0) return;
    setDiffCursor(path, 'new', ri, 0, false);
  });
}
function moveDiffCursor(dLine, dColumn, extend) {
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var side = diffCursor.side;
  var rows = diffRowsOf(diffSideTable(wrapper, side));
  var ri = diffCursor.rowIndex;
  var col = diffCursor.column;
  var text = diffLineText(rows[ri]);
  // Shift extends a text selection from where the caret sat before the first shifted move.
  var anchor = extend ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column }) : null;
  // Plain arrows stay within the current pane (no auto pane-crossing — that is Cmd+Left/Right).
  if (dColumn < 0) {
    if (col > 0) { col -= 1; }
    else { // at line start: end of previous code line in the SAME pane
      var p = ri - 1; while (p >= 0 && !isDiffCodeRow(rows[p])) p -= 1;
      if (p >= 0) { ri = p; col = diffLineText(rows[p]).length; }
    }
  } else if (dColumn > 0) {
    if (col < text.length) { col += 1; }
    else { // at line end: start of next code line in the SAME pane
      var nx = ri + 1; while (nx < rows.length && !isDiffCodeRow(rows[nx])) nx += 1;
      if (nx < rows.length) { ri = nx; col = 0; }
    }
  }
  if (dLine !== 0) {
    var rows2 = diffRowsOf(diffSideTable(wrapper, side));
    var step = dLine > 0 ? 1 : -1;
    var cand = ri + step;
    while (cand >= 0 && cand < rows2.length && !isDiffCodeRow(rows2[cand])) cand += step;
    if (cand >= 0 && cand < rows2.length) { ri = cand; col = Math.min(col, diffLineText(rows2[ri]).length); }
  }
  setDiffCursor(diffCursor.path, side, ri, col, true); // clears diffSelectionAnchor + native selection
  if (anchor) { diffSelectionAnchor = anchor; applyDiffSelection(); } // re-establish the Shift selection
}
function moveDiffWord(dir, extend) {
  if (!diffCursor) return;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  var text = diffLineText(row);
  var ncol = nextWordBoundary(text, diffCursor.column, dir);
  if (ncol === diffCursor.column) return; // already at the line edge — plain arrows change lines
  var anchor = extend ? (diffSelectionAnchor || { side: diffCursor.side, rowIndex: diffCursor.rowIndex, column: diffCursor.column }) : null;
  setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, ncol, true);
  if (anchor) { diffSelectionAnchor = anchor; applyDiffSelection(); }
}
function handleDiffCaretKey(event) {
  if (!isDiffViewVisible() || !diffCursor) return false;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return false;
  var extend = event.shiftKey;
  if (event.key === 'ArrowDown') { event.preventDefault(); moveDiffCursor(1, 0, extend); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveDiffCursor(-1, 0, extend); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveDiffCursor(0, -1, extend); return true; }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveDiffCursor(0, 1, extend); return true; }
  return false;
}

// ===== Review comments: questions ("?") and change-requests (">") =====
// (COMMENTS_KEY / reviewComments / commentSeq / composerState are declared near the top of the script)
function saveComments() {
  persistSave(COMMENTS_KEY, reviewComments);
}
function commentsAt(path, line) {
  return reviewComments.filter(function (c) { return c.path === path && c.line === line; });
}
function commentKindLabel(kind) {
  return kind === 'q' ? t('comment.kind.q') : t('comment.kind.c');
}
function relevantLines(path) {
  var set = {};
  reviewComments.forEach(function (c) { if (c.path === path) set[c.line] = true; });
  if (composerState && composerState.path === path) set[composerState.line] = true;
  return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
}
function addComment(kind, path, line, code, text) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return;
  commentSeq += 1;
  reviewComments.push({ seq: commentSeq, kind: kind, path: path, line: line, code: String(code || ''), text: trimmed });
  saveComments();
}
function deleteComment(seq) {
  reviewComments = reviewComments.filter(function (c) { return c.seq !== seq; });
  saveComments();
  refreshComments();
}

function sourceRowLineOf(node) {
  var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  var row = el && el.closest ? el.closest('.source-row') : null;
  if (!row) return null;
  var v = parseInt(row.dataset.lineIndex, 10);
  return isFinite(v) ? v : null;
}
function currentCommentTarget() {
  var sel = window.getSelection();
  var selText = (sel && sel.toString) ? sel.toString() : '';
  var hasSel = !!sel && !sel.isCollapsed && selText.trim().length > 0;
  // Source view: anchor BELOW the selection (its last line) so the box sits under the drag.
  // Derive the span from the actual DOM range so MOUSE drags work (they don't move the JS caret).
  if (isSourceViewerVisible() && viewerCursor) {
    if (hasSel) {
      var srng = sel.rangeCount ? sel.getRangeAt(0) : null;
      var sa = srng ? sourceRowLineOf(srng.startContainer) : null;
      var sb = srng ? sourceRowLineOf(srng.endContainer) : null;
      if (sa == null || sb == null) { sa = selectionAnchor ? selectionAnchor.lineIndex : viewerCursor.lineIndex; sb = viewerCursor.lineIndex; }
      var f = Math.min(sa, sb), t = Math.max(sa, sb);
      return { path: viewerCursor.path, line: t + 1, code: selText, from: f + 1, to: t + 1, side: null };
    }
    return { path: viewerCursor.path, line: viewerCursor.lineIndex + 1, code: '', from: null, to: null, side: null };
  }
  // Diff view: prefer the explicit diff caret when there is no text selection.
  if (!hasSel && diffCursor && isDiffViewVisible()) {
    var dwrap = diffWrapperByPath(diffCursor.path);
    var drow = dwrap ? diffRowAt(dwrap, diffCursor.side, diffCursor.rowIndex) : null;
    var dline = drow ? diffLineNumber(drow) : null;
    if (dline != null) return { path: diffCursor.path, line: dline, code: '', from: null, to: null, side: null };
  }
  // Diff view with a selection (or click): anchor at the LAST line so the composer drops BELOW the
  // drag; capture the selected code + line span (used to keep the drag highlighted via .mc-sel-line).
  var rng = (sel && sel.rangeCount) ? sel.getRangeAt(0) : null;
  var fromNode = rng ? rng.startContainer : (sel ? sel.anchorNode : null);
  var toNode = rng ? rng.endContainer : (sel ? sel.anchorNode : null);
  var fromEl = fromNode ? (fromNode.nodeType === 1 ? fromNode : fromNode.parentElement) : null;
  var toEl = toNode ? (toNode.nodeType === 1 ? toNode : toNode.parentElement) : null;
  var wrapper = (toEl && toEl.closest && toEl.closest('.d2h-file-wrapper')) || document.querySelector('#diff2html-container .d2h-file-wrapper:not(.df-inactive)');
  if (!wrapper) return null;
  var nameEl = wrapper.querySelector('.d2h-file-name');
  var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
  if (!path) return null;
  var toRow = toEl && toEl.closest ? toEl.closest('tr') : null;
  if (!toRow || !toRow.querySelector('.d2h-code-side-linenumber')) {
    var sides0 = wrapper.querySelectorAll('.d2h-file-side-diff');
    var right0 = sides0[sides0.length - 1];
    var firstNum = right0 ? right0.querySelector('.d2h-code-side-linenumber') : null;
    toRow = firstNum ? firstNum.closest('tr') : null;
  }
  if (!toRow) return null;
  var toLine = diffLineNumber(toRow);
  if (toLine == null) return null;
  var fromRow = (hasSel && fromEl && fromEl.closest) ? fromEl.closest('tr') : null;
  var fromLine = fromRow ? diffLineNumber(fromRow) : null;
  if (fromLine == null) fromLine = toLine;
  var sideEl = toEl && toEl.closest ? toEl.closest('.d2h-file-side-diff') : null;
  var st = diffSideTables(wrapper);
  var side = (sideEl && sideEl === st.left) ? 'old' : 'new';
  return { path: path, line: toLine, code: hasSel ? selText : '', from: hasSel ? Math.min(fromLine, toLine) : null, to: hasSel ? Math.max(fromLine, toLine) : null, side: side };
}

function threadHtml(path, line) {
  var html = '';
  commentsAt(path, line).forEach(function (c) {
    html += '<div class="mc-card mc-' + c.kind + '">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindLabel(c.kind) + '</span>'
      + '<button type="button" class="mc-del" data-seq="' + c.seq + '" title="' + escapeHtml(t('composer.delete')) + '">×</button></div>'
      + '<div class="mc-card-body">' + escapeHtml(c.text) + '</div></div>';
  });
  if (composerState && composerState.path === path && composerState.line === line) {
    var ph = composerState.kind === 'q' ? t('composer.question') : t('composer.changeRequest');
    html += '<div class="mc-card mc-' + composerState.kind + ' mc-composer">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindLabel(composerState.kind) + '</span></div>'
      + '<textarea class="mc-input" rows="3" placeholder="' + escapeHtml(ph) + '"></textarea>'
      + '<div class="mc-actions"><button type="button" class="mc-btn mc-save">' + escapeHtml(t('composer.save')) + '</button>'
      + '<button type="button" class="mc-btn mc-ghost mc-cancel">' + escapeHtml(t('composer.cancel')) + '</button>'
      + '<span class="mc-hint">' + escapeHtml(t('composer.hint')) + '</span></div></div>';
  }
  return html;
}

function injectThreadRow(anchorRow, path, line) {
  if (!anchorRow || !anchorRow.parentNode) return;
  var tr = document.createElement('tr');
  tr.className = 'mc-comment-row';
  var td = document.createElement('td');
  // source/markdown/csv rows can have >2 cells (csv); span them all. diff (d2h) rows stay 2.
  td.colSpan = (anchorRow.classList && anchorRow.classList.contains('source-row')) ? (anchorRow.children.length || 2) : 2;
  td.className = 'mc-thread-cell';
  td.innerHTML = threadHtml(path, line);
  tr.appendChild(td);
  anchorRow.parentNode.insertBefore(tr, anchorRow.nextSibling);
}

function renderDiffComments() {
  var container = document.getElementById('diff2html-container');
  if (!container) return;
  container.querySelectorAll('.mc-comment-row').forEach(function (r) { r.remove(); });
  container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
    var nameEl = w.querySelector('.d2h-file-name');
    var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
    if (!path) return;
    var lines = relevantLines(path);
    if (!lines.length) return;
    var sides = w.querySelectorAll('.d2h-file-side-diff');
    var right = sides[sides.length - 1];
    if (!right) return;
    var rows = right.querySelectorAll('tr');
    lines.forEach(function (line) {
      for (var i = 0; i < rows.length; i++) {
        var num = rows[i].querySelector('.d2h-code-side-linenumber');
        if (num && (num.textContent || '').trim() === String(line)) { injectThreadRow(rows[i], path, line); break; }
      }
    });
  });
}

function renderSourceComments() {
  var body = document.getElementById('source-body');
  if (!body) return;
  body.querySelectorAll('.mc-comment-row').forEach(function (r) { r.remove(); });
  var viewer = document.getElementById('source-viewer');
  var path = viewer ? (viewer.dataset.openPath || '') : '';
  if (!path) return;
  relevantLines(path).forEach(function (line) {
    var anchor = body.querySelector('.source-row[data-line-index="' + (line - 1) + '"]');
    if (anchor) injectThreadRow(anchor, path, line);
  });
}

// Per-file comment counts as small (no-emoji) badges in BOTH sidebars — the Changes list
// (.change-row, before the diffstat) and the Files tree (.source-link, after the file name).
function renderCommentBadges() {
  document.querySelectorAll('.mc-file-badge').forEach(function (b) { b.remove(); });
  var counts = {};
  reviewComments.forEach(function (x) {
    var k = counts[x.path] || (counts[x.path] = { q: 0, c: 0 });
    if (x.kind === 'q') k.q += 1; else k.c += 1;
  });
  function makeBadge(k) {
    var badge = document.createElement('span');
    badge.className = 'mc-file-badge';
    var html = '';
    if (k.q) html += '<span class="mc-fb mc-fb-q" title="' + k.q + ' ' + escapeHtml(t('badge.questions')) + '">' + k.q + '</span>';
    if (k.c) html += '<span class="mc-fb mc-fb-c" title="' + k.c + ' ' + escapeHtml(t('badge.changeRequests')) + '">' + k.c + '</span>';
    badge.innerHTML = html;
    return badge;
  }
  function inject(selector, keyAttr, refSelector) {
    document.querySelectorAll(selector).forEach(function (row) {
      var k = counts[row.dataset[keyAttr] || ''];
      if (!k) return;
      var ref = row.querySelector(refSelector);
      if (ref) row.insertBefore(makeBadge(k), ref); else row.appendChild(makeBadge(k));
    });
  }
  inject('.change-row', 'file', '.diffstat');
  inject('.source-link', 'sourceFile', '.count');
}

// While composing on a drag selection, keep those lines highlighted (.mc-sel-line) so the user
// sees what they are commenting on even though the native selection was cleared.
function applyCommentSelectionHighlight() {
  document.querySelectorAll('.mc-sel-line').forEach(function (r) { r.classList.remove('mc-sel-line'); });
  if (!composerState || composerState.from == null || composerState.to == null) return;
  var from = composerState.from, to = composerState.to;
  if (isDiffViewVisible()) {
    var wrap = diffWrapperByPath(composerState.path);
    if (!wrap) return;
    diffRowsOf(diffSideTable(wrap, composerState.side || 'new')).forEach(function (row) {
      var ln = diffLineNumber(row);
      if (ln != null && ln >= from && ln <= to) row.classList.add('mc-sel-line');
    });
  } else if (isSourceViewerVisible()) {
    for (var ln = from; ln <= to; ln++) {
      var sr = document.querySelector('.source-row[data-line-index="' + (ln - 1) + '"]');
      if (sr) sr.classList.add('mc-sel-line');
    }
  }
}
function refreshComments() {
  renderDiffComments();
  if (isSourceViewerVisible()) renderSourceComments();
  renderCommentBadges();
  applyCommentSelectionHighlight();
  if (composerState) {
    var composerFocusTries = 0;
    var tryFocusComposer = function () {
      var ta = document.querySelector('.mc-composer .mc-input');
      if (!ta) return true;                            // composer gone — stop retrying
      if (document.activeElement === ta) return true;  // already focused — done
      try { ta.focus({ preventScroll: true }); } catch (e) { try { ta.focus(); } catch (e2) {} }
      try { ta.selectionStart = ta.selectionEnd = ta.value.length; } catch (e3) {}
      return document.activeElement === ta;
    };
    // A one-shot focus works in a plain browser, but Electron asynchronously restores focus to <body>
    // after the keydown, so the textarea loses that race. Retry on a short interval until it wins (or the
    // composer closes), capped at ~300ms so it never fights real user focus once they start typing.
    if (!tryFocusComposer()) {
      var composerFocusIv = setInterval(function () {
        if (tryFocusComposer() || ++composerFocusTries > 12) clearInterval(composerFocusIv);
      }, 25);
    }
  }
}

function openComposer(kind) {
  var target = currentCommentTarget();
  if (!target) return;
  composerState = { kind: kind, path: target.path, line: target.line, code: target.code, from: target.from, to: target.to, side: target.side };
  // Keep the dragged code visibly highlighted via the .mc-sel-line class (applyCommentSelectionHighlight),
  // and clear the native selection so its highlight doesn't bleed into the composer/cards below it.
  try { var psel = window.getSelection(); if (psel) psel.removeAllRanges(); } catch (e) {}
  refreshComments();
}
function closeComposer() {
  if (!composerState) return;
  composerState = null;
  refreshComments();
}
function saveComposer(ta) {
  if (!composerState) return;
  var box = ta || document.querySelector('.mc-composer .mc-input');
  if (!box) return;
  addComment(composerState.kind, composerState.path, composerState.line, composerState.code, box.value);
  composerState = null;
  refreshComments();
}

// Default merge-prompt headings, localized: a Korean user gets Korean defaults. Editable in
// Settings → Merge prompts (stored per browser in localStorage); buildMergedText + the textarea
// placeholders fall back to these when the stored value is empty.
function defaultMergePrompt(kind) {
  return t(kind === 'q' ? 'mergePrompt.default.q' : 'mergePrompt.default.c');
}
var mergePromptsKey = 'monacori-merge-prompts';
function loadMergePrompts() {
  var b = persistRead(mergePromptsKey); if (b && typeof b === 'object') return b; try { var v = JSON.parse(localStorage.getItem(mergePromptsKey) || '{}'); return (v && typeof v === 'object') ? v : {}; } catch (e) { return {}; }
}
function mergePromptFor(kind) {
  var v = loadMergePrompts()[kind];
  return (typeof v === 'string' && v.trim()) ? v : defaultMergePrompt(kind);
}
function saveMergePrompt(kind, text) {
  var saved = loadMergePrompts();
  if (text && text.trim()) saved[kind] = text; else delete saved[kind];
  persistSave(mergePromptsKey, saved);
}

function buildMergedText(kind) {
  var items = reviewComments.filter(function (c) { return c.kind === kind; });
  var nl = String.fromCharCode(10);
  var lines = [];
  // Per-kind agent contract heading (editable in Settings → Merge prompts; default otherwise).
  lines.push(mergePromptFor(kind));
  lines.push('');
  lines.push((kind === 'q' ? t('merged.qHeading') : t('merged.cHeading')) + ' (' + items.length + ')');
  lines.push('');
  items.forEach(function (c) {
    lines.push('### ' + c.path + ':' + c.line);
    if (c.code && c.code.trim()) lines.push('> ' + c.code.trim());
    lines.push(c.text);
    lines.push('');
  });
  return lines.join(nl);
}

function openMergedView(kind) {
  var existing = document.getElementById('mc-modal');
  if (existing) existing.remove();
  var modal = document.createElement('div');
  modal.id = 'mc-modal';
  modal.className = 'mc-modal';
  modal.dataset.kind = kind; // remembered so a live locale switch can re-render this same view
  var panel = document.createElement('div');
  panel.className = 'mc-modal-panel';
  var head = document.createElement('div');
  head.className = 'mc-modal-head';
  var title = document.createElement('span');
  title.textContent = kind === 'q' ? t('merged.qTitle') : t('merged.cTitle');
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'mc-btn mc-ghost';
  closeBtn.textContent = t('merged.close');
  var area = document.createElement('textarea');
  area.className = 'mc-modal-text';
  area.readOnly = true;
  area.value = buildMergedText(kind);
  closeBtn.addEventListener('click', function () { modal.remove(); });
  // Terminal send (Electron, terminal open): close the modal and hand off to pane-pick mode ON the
  // terminal — the chosen pane is highlighted, the rest dimmed, arrows change the choice, Enter sends.
  // One button here; the actual pick happens visually over the live claude/codex sessions.
  var sendBtn = null;
  if (window.__monacoriTerminal && typeof window.__monacoriTerminal.isOpen === 'function' && window.__monacoriTerminal.isOpen()) {
    sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'mc-btn mc-send-term';
    sendBtn.textContent = t('merged.sendToTerminal');
    sendBtn.addEventListener('click', function () {
      var text = buildMergedText(kind);
      modal.remove();
      window.__monacoriTerminal.enterSendMode(text);
    });
  }
  head.appendChild(title);
  if (sendBtn) head.appendChild(sendBtn);
  head.appendChild(closeBtn);
  panel.appendChild(head);
  panel.appendChild(area);
  modal.appendChild(panel);
  modal.addEventListener('mousedown', function (e) { if (e.target === modal) modal.remove(); });
  modal.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); modal.remove(); } });
  document.body.appendChild(modal);
  // Focus the send button (Enter starts pane-pick) when present, else the read-only text. Electron
  // async-restores focus to <body>, so retry briefly (same as the composer).
  var modalFocusTarget = sendBtn || area;
  var modalFocusTries = 0;
  var tryFocusModal = function () {
    if (!document.getElementById('mc-modal')) return true;
    if (document.activeElement === modalFocusTarget) return true;
    try { modalFocusTarget.focus(); if (modalFocusTarget === area) modalFocusTarget.select(); } catch (e) {}
    return document.activeElement === modalFocusTarget;
  };
  if (!tryFocusModal()) {
    var modalFocusIv = setInterval(function () { if (tryFocusModal() || ++modalFocusTries > 12) clearInterval(modalFocusIv); }, 25);
  }
}

document.addEventListener('click', function (event) {
  var t = event.target;
  if (!t || !t.closest) return;
  var del = t.closest('.mc-del');
  if (del) { event.preventDefault(); deleteComment(parseInt(del.dataset.seq, 10)); return; }
  if (t.closest('.mc-save')) { event.preventDefault(); saveComposer(); return; }
  if (t.closest('.mc-cancel')) { event.preventDefault(); closeComposer(); return; }
});
document.addEventListener('keydown', function (event) {
  var t = event.target;
  if (!t || !t.classList || !t.classList.contains('mc-input')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeComposer(); return; }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveComposer(t); return; }
}, true);

refreshComments();


// Integrated terminal (Electron only): xterm panes wired to node-pty sessions in the main process.
// Toggle with Ctrl+` / Opt+F12 / the footer ⌗ button; Cmd/Ctrl+D splits the active pane (side by side,
// no tabs); drag the top edge to resize. window.__monacoriTerminal pipes the merged prompt into the
// active pane. Cmd combos are released back to the app so shortcuts like Cmd+1 don't get stuck typing.
(function setupTerminal() {
  if (!window.monacoriPty) return; // xterm (window.Terminal) is loaded lazily on first open
  var panel = document.getElementById('terminal-panel');
  var host = document.getElementById('terminal-host');
  var toggleBtn = document.getElementById('terminal-toggle');
  var closeBtn = document.getElementById('terminal-close');
  var resizer = panel ? panel.querySelector('.terminal-resizer') : null;
  if (!panel || !host) return;
  if (toggleBtn) toggleBtn.classList.remove('hidden'); // reveal the footer toggle in Electron

  // xterm ships as an inert island (id=xterm-code) so ~490KB isn't parsed at startup. Inject it on the
  // first open; returns false if unavailable (e.g. the island is absent), so callers can bail gracefully.
  function ensureXterm() {
    if (typeof window.Terminal === 'function') return true;
    var code = document.getElementById('xterm-code');
    if (!code) return false;
    try {
      var s = document.createElement('script');
      s.textContent = code.textContent;
      document.head.appendChild(s);
      code.remove(); // free the inert text once compiled
    } catch (e) { return false; }
    return typeof window.Terminal === 'function';
  }

  var panes = [];   // { id, term, fit, el }
  var active = null;
  var MAX_PANES = 4;
  var heightKey = 'monacori-terminal-height';
  var openKey = 'monacori-terminal-open:' + location.pathname;

  function applyHeight(px) {
    var h = Math.max(120, Math.min(px, window.innerHeight - 120));
    document.documentElement.style.setProperty('--terminal-height', h + 'px');
  }
  var savedH = parseInt(localStorage.getItem(heightKey) || '', 10);
  if (savedH) applyHeight(savedH);

  function fitPane(p) {
    if (!p) return;
    try { p.fit.fit(); if (p.id != null) window.monacoriPty.resize({ id: p.id, cols: p.term.cols, rows: p.term.rows }); } catch (e) {}
  }
  function fitAll() { panes.forEach(fitPane); }

  function setActive(p) {
    active = p;
    panes.forEach(function (q) { q.el.classList.toggle('is-active', q === p); });
    if (p) requestAnimationFrame(function () { try { p.term.focus(); } catch (e) {} });
  }

  function makePane() {
    if (!ensureXterm()) return null; // xterm unavailable — leave the panel empty rather than throw
    var el = document.createElement('div');
    el.className = 'terminal-pane';
    var labelEl = document.createElement('div');
    labelEl.className = 'terminal-pane-label';
    var paneHost = document.createElement('div');
    paneHost.className = 'terminal-pane-host';
    el.appendChild(labelEl);
    el.appendChild(paneHost);
    host.appendChild(el);
    var term = new window.Terminal({
      fontSize: 12,
      fontFamily: 'Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#161616', foreground: '#a9b7c6', cursor: '#a9b7c6', selectionBackground: '#214283' },
      cursorBlink: true,
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(paneHost);
    var pane = { id: null, term: term, fit: fit, el: el, labelEl: labelEl, name: 'Terminal ' + (panes.length + 1) };
    labelEl.textContent = pane.name;
    // Cmd combos are app shortcuts (Cmd+1/0 tab switch, Cmd+B go-to-def, …). Release the terminal and let
    // them bubble to the document handler instead of typing into the shell (fixes "Cmd+1 stuck in term").
    term.attachCustomKeyEventHandler(function (e) {
      if (e.type === 'keydown' && e.metaKey) { try { term.blur(); } catch (x) {} return false; }
      return true;
    });
    term.onData(function (d) { if (pane.id != null) window.monacoriPty.write({ id: pane.id, data: d }); });
    el.addEventListener('mousedown', function (e) { if (e.target !== labelEl) setActive(pane); });
    labelEl.addEventListener('dblclick', function () { renamePane(pane); });
    panes.push(pane);
    try { fit.fit(); } catch (e) {}
    window.monacoriPty.spawn({ cols: term.cols || 80, rows: term.rows || 24 }).then(function (r) { pane.id = r && r.id; });
    setActive(pane);
    return pane;
  }
  // Rename a pane inline: the label becomes editable, Enter commits, Esc/blur reverts to the last name.
  function renamePane(pane) {
    if (!pane) { pane = active; }
    if (!pane) return;
    var el = pane.labelEl;
    if (el.getAttribute('contenteditable') === 'true') return;
    setActive(pane);
    el.contentEditable = 'true';
    el.focus();
    try { var range = document.createRange(); range.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); } catch (e) {}
    function finish(commit) {
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('blur', onBlur);
      el.contentEditable = 'false';
      if (commit) pane.name = (el.textContent || '').trim() || pane.name;
      el.textContent = pane.name;
      try { if (pane.term) pane.term.focus(); } catch (e) {}
    }
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    }
    function onBlur() { finish(true); }
    el.addEventListener('keydown', onKey);
    el.addEventListener('blur', onBlur);
  }

  function removePane(id) {
    var i = -1;
    for (var k = 0; k < panes.length; k++) { if (panes[k].id === id) { i = k; break; } }
    if (i < 0) return;
    var p = panes[i];
    try { p.term.dispose(); } catch (e) {}
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    panes.splice(i, 1);
    if (active === p) setActive(panes[panes.length - 1] || null);
    if (panes.length === 0) setOpen(false);
    else fitAll();
  }

  function split() {
    if (panes.length >= MAX_PANES) return;
    makePane();
    fitAll();
  }
  // Move active focus between split panes (menu accelerators Cmd/Ctrl+Alt+[ and ]).
  function focusPaneByDelta(delta) {
    if (panes.length < 2) return;
    var i = panes.indexOf(active);
    if (i < 0) i = 0;
    setActive(panes[(i + delta + panes.length) % panes.length]);
  }

  // Route per-pane pty output / exit by id (registered once for the window).
  window.monacoriPty.onData(function (msg) {
    for (var k = 0; k < panes.length; k++) { if (panes[k].id === msg.id) { panes[k].term.write(msg.data); return; } }
  });
  window.monacoriPty.onExit(function (msg) { removePane(msg.id); });

  function isOpen() { return !panel.classList.contains('hidden'); }
  function setOpen(open) {
    panel.classList.toggle('hidden', !open);
    document.body.classList.toggle('terminal-open', open);
    if (toggleBtn) toggleBtn.classList.toggle('is-active', open);
    try { sessionStorage.setItem(openKey, open ? '1' : '0'); } catch (e) {}
    if (open) {
      if (panes.length === 0) makePane();
      requestAnimationFrame(function () { fitAll(); if (active) try { active.term.focus(); } catch (e) {} });
    }
  }
  function toggle() { setOpen(!isOpen()); }

  if (toggleBtn) toggleBtn.addEventListener('click', toggle);
  if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
  // Toggle (Ctrl+`/Alt+F12) and split (Cmd+D) arrive from the Terminal menu accelerators (app-main),
  // because Chromium swallows Cmd+D before a renderer keydown would ever see it.
  if (window.monacoriMenu && typeof window.monacoriMenu.onTerminalToggle === 'function') window.monacoriMenu.onTerminalToggle(toggle);
  if (window.monacoriMenu && typeof window.monacoriMenu.onTerminalSplit === 'function') window.monacoriMenu.onTerminalSplit(split);
  if (window.monacoriMenu && typeof window.monacoriMenu.onTerminalPaneFocus === 'function') window.monacoriMenu.onTerminalPaneFocus(focusPaneByDelta);
  if (window.monacoriMenu && typeof window.monacoriMenu.onTerminalPaneRename === 'function') window.monacoriMenu.onTerminalPaneRename(function () { renamePane(active); });

  var ro = (typeof ResizeObserver === 'function') ? new ResizeObserver(function () { if (isOpen()) fitAll(); }) : null;
  if (ro) ro.observe(host);
  window.addEventListener('resize', function () { if (isOpen()) fitAll(); });

  if (resizer) {
    resizer.addEventListener('mousedown', function (e) {
      e.preventDefault();
      resizer.classList.add('resizing');
      function move(ev) { applyHeight(window.innerHeight - ev.clientY); }
      function up() {
        resizer.classList.remove('resizing');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        var cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--terminal-height'), 10);
        if (cur) { try { localStorage.setItem(heightKey, String(cur)); } catch (e) {} }
        fitAll();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // Kill this window's ptys on unload so a reload/close doesn't leak them in the main process.
  window.addEventListener('beforeunload', function () {
    panes.forEach(function (p) { if (p.id != null) { try { window.monacoriPty.kill({ id: p.id }); } catch (e) {} } });
  });

  // Hook for the merged-prompt modal: pipe the combined text into a chosen pane (no trailing Enter —
  // the user reviews in the live session, then presses Enter, so multiline prompts stay intact).
  function writeToPane(p, text) {
    if (!p) return;
    setOpen(true);
    if (p.id != null) window.monacoriPty.write({ id: p.id, data: text });
    setActive(p);
    requestAnimationFrame(function () { try { p.term.focus(); } catch (e) {} });
  }
  // Pane-pick mode: triggered from the merged modal's "Send to terminal". The chosen pane is highlighted,
  // the rest are dimmed; arrows change the pick, Enter sends, Esc cancels. Single pane → send at once.
  var sendModeText = null, sendModeIdx = 0;
  function paintSendMode() {
    panes.forEach(function (p, i) {
      p.el.classList.toggle('is-send-target', i === sendModeIdx);
      p.el.classList.toggle('is-dimmed', i !== sendModeIdx);
    });
  }
  function exitSendMode() {
    if (sendModeText == null) return;
    sendModeText = null;
    panel.classList.remove('send-mode');
    document.body.classList.remove('terminal-send-mode'); // un-dim the rest of the app
    panes.forEach(function (p) { p.el.classList.remove('is-send-target', 'is-dimmed'); });
  }
  function enterSendMode(text) {
    if (panes.length === 0) return;
    setOpen(true);
    sendModeText = text;
    sendModeIdx = Math.max(0, panes.indexOf(active));
    panel.classList.add('send-mode');
    document.body.classList.add('terminal-send-mode'); // dim sidebar + file/diff view; only the terminal pops
    paintSendMode();
  }
  // Capture phase so the pick keys win over the focused xterm; while picking, every key is swallowed.
  document.addEventListener('keydown', function (e) {
    if (sendModeText == null) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
      sendModeIdx = (sendModeIdx + d + panes.length) % panes.length;
      paintSendMode();
    } else if (e.key === 'Enter') {
      var p = panes[sendModeIdx], text = sendModeText;
      exitSendMode();
      writeToPane(p, text);
    } else if (e.key === 'Escape') {
      exitSendMode();
    }
  }, true);
  window.__monacoriTerminal = {
    isOpen: isOpen,
    open: function () { setOpen(true); },
    paneCount: function () { return panes.length; },
    enterSendMode: enterSendMode,
    send: function (text) { writeToPane(active || panes[0], text); },
    sendToPane: function (i, text) { writeToPane(panes[i] || active || panes[0], text); },
  };

  // Restore the open state across reloads.
  try { if (sessionStorage.getItem(openKey) === '1') setOpen(true); } catch (e) {}
})();

// In Electron, the Review menu's Cmd/Ctrl+Shift+/ and +. accelerators arrive here via IPC
// (macOS reserves Cmd+? for its Help search, so the menu claims it and routes to these views).
if (window.monacoriMenu && typeof window.monacoriMenu.onMergedView === 'function') {
  // Always open the merged-view modal; sending to a terminal pane is a button inside it (per-pane when
  // split), so the user can pick which claude/codex session receives the prompt.
  window.monacoriMenu.onMergedView(function (kind) { openMergedView(kind); });
}
if (window.monacoriMenu && typeof window.monacoriMenu.onCloseTab === 'function') {
  // Cmd/Ctrl+W: close the active Files-mode tab (no-op outside the source viewer).
  window.monacoriMenu.onCloseTab(function () { if (isSourceViewerVisible()) closeActiveSourceTab(); });
}

(function checkForUpdate() {
  var current = window.__MONACORI_VERSION__ || '';
  if (!current) return;
  var isNewer = function (a, b) {
    var pa = String(a).split('.'), pb = String(b).split('.');
    for (var i = 0; i < 3; i++) {
      var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  };
  var apply = function (latest) {
    if (!latest) return;
    var status = document.getElementById('app-info-status');
    if (isNewer(latest, current)) {
      var flag = document.getElementById('app-update-flag');
      if (flag) flag.classList.remove('hidden');
      // One-click auto-update needs the Electron main process (it spawns npm). When available, reveal the
      // button so a click installs + restarts; otherwise (browser/static export) name the command instead.
      var ub = document.getElementById('app-info-update');
      if (ub && window.monacoriUpdate && typeof window.monacoriUpdate.run === 'function') {
        ub.textContent = t('settings.updateRestart') + ' (v' + latest + ')';
        ub.classList.remove('hidden');
        if (status) { status.textContent = t('settings.updateAvailable') + ': v' + latest; status.classList.add('has-update'); }
      } else if (status) {
        status.textContent = t('settings.updateAvailable') + ': v' + latest + ' — npm i -g @happy-nut/monacori';
        status.classList.add('has-update');
      }
    } else if (status) {
      status.textContent = t('settings.upToDate') + ' (v' + current + ')';
    }
  };
  // Cache the npm result for the session so watch-mode reloads reuse it instead of refetching.
  var cached = '';
  try { cached = sessionStorage.getItem('monacori-update-latest') || ''; } catch (e) {}
  if (cached) { apply(cached); return; }
  if (typeof fetch !== 'function') return;
  fetch('https://registry.npmjs.org/@happy-nut/monacori/latest', { cache: 'no-store' })
    .then(function (res) { return res && res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.version) return;
      try { sessionStorage.setItem('monacori-update-latest', data.version); } catch (e) {}
      apply(data.version);
    })
    .catch(function () {});
})();

// Unified settings modal: the sidebar-footer gear opens it (General category by default), with
// About/update/shortcuts under General and the merge-prompt editor under Merge prompts.
(function setupSettings() {
  var modal = document.getElementById('settings-modal');
  if (!modal) return;
  var gearBtn = document.getElementById('app-info-btn');
  var flag = document.getElementById('app-update-flag');
  var updateBtn = document.getElementById('app-info-update');
  var qta = document.getElementById('settings-prompt-q');
  var cta = document.getElementById('settings-prompt-c');
  var resetBtn = document.getElementById('settings-reset');
  var savedMsg = document.getElementById('settings-saved');
  var cats = Array.prototype.slice.call(modal.querySelectorAll('.settings-cat'));
  var secs = Array.prototype.slice.call(modal.querySelectorAll('.settings-section'));
  function showCat(cat) {
    cats.forEach(function (c) { c.classList.toggle('active', c.dataset.cat === cat); });
    secs.forEach(function (s) { s.classList.toggle('hidden', s.dataset.cat !== cat); });
  }
  function fill() {
    var s = loadMergePrompts();
    if (qta) { qta.value = typeof s.q === 'string' ? s.q : ''; qta.placeholder = defaultMergePrompt('q'); }
    if (cta) { cta.value = typeof s.c === 'string' ? s.c : ''; cta.placeholder = defaultMergePrompt('c'); }
  }
  function open(cat) { fill(); if (cat) showCat(cat); modal.classList.remove('hidden'); }
  function close() { modal.classList.add('hidden'); }
  var flashTimer = null;
  function flash() { if (!savedMsg) return; savedMsg.textContent = 'Saved'; if (flashTimer) clearTimeout(flashTimer); flashTimer = setTimeout(function () { savedMsg.textContent = ''; }, 1200); }
  if (gearBtn) gearBtn.addEventListener('click', function (e) { e.stopPropagation(); if (modal.classList.contains('hidden')) open('general'); else close(); });
  if (flag) flag.addEventListener('click', function (e) { e.stopPropagation(); open('general'); });
  cats.forEach(function (c) { c.addEventListener('click', function () { showCat(c.dataset.cat); }); });
  modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
  // Capture so closing settings wins over other Escape handlers (lightbox / composer).
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) { e.stopPropagation(); e.preventDefault(); close(); return; }
    // Cmd/Ctrl+, (the standard "Preferences" accelerator) toggles the settings panel from anywhere.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === ',' || e.code === 'Comma')) {
      e.preventDefault(); e.stopPropagation();
      if (modal.classList.contains('hidden')) open('general'); else close();
    }
  }, true);
  // One-click self-update (Electron only): install latest globally via the main process, then relaunch.
  if (updateBtn && window.monacoriUpdate && typeof window.monacoriUpdate.run === 'function') {
    updateBtn.addEventListener('click', function () {
      if (updateBtn.disabled) return;
      updateBtn.disabled = true;
      var status = document.getElementById('app-info-status');
      if (status) { status.textContent = t('settings.updating'); status.classList.add('has-update'); }
      window.monacoriUpdate.run().then(function (r) {
        if (r && r.ok) { if (status) status.textContent = t('settings.updated'); }
        else { updateBtn.disabled = false; if (status) status.textContent = t('settings.updateFailed'); }
      }).catch(function () { updateBtn.disabled = false; if (status) status.textContent = t('settings.updateFailed'); });
    });
  }
  if (qta) qta.addEventListener('input', function () { saveMergePrompt('q', qta.value); flash(); });
  if (cta) cta.addEventListener('input', function () { saveMergePrompt('c', cta.value); flash(); });
  if (resetBtn) resetBtn.addEventListener('click', function () { saveMergePrompt('q', ''); saveMergePrompt('c', ''); fill(); flash(); });
  // Language: live-switch the whole UI (no reload). Persist, re-apply the static chrome, then re-render
  // any currently-shown dynamic text (open composer / merged modal / index status) so it follows too.
  var langSel = document.getElementById('settings-language');
  if (langSel) {
    langSel.value = locale;
    langSel.addEventListener('change', function () {
      var next = langSel.value === 'ko' ? 'ko' : 'en';
      if (next === locale) return;
      locale = next;
      persistSave(LOCALE_KEY, locale);
      applyI18n();
      // Merge-prompt placeholders are locale-dependent defaults; refresh them while the panel is open.
      fill();
      // Re-render dynamic, currently-visible text in the new locale.
      try { if (typeof refreshComments === 'function') refreshComments(); } catch (e) {}
      var mergedModal = document.getElementById('mc-modal');
      if (mergedModal) { var mk = mergedModal.dataset.kind || 'q'; mergedModal.remove(); openMergedView(mk); }
    });
  }
})();

function setTab(name) {
  if (name === 'files') ensureTreeRendered();
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  document.getElementById('changes-panel')?.classList.toggle('hidden', name !== 'changes');
  document.getElementById('files-panel')?.classList.toggle('hidden', name !== 'files');
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
    if (state.sourcePath && sourceByPath.has(state.sourcePath)) {
      openSourceFile(state.sourcePath);
      // Restore the exact source caret/scroll (openSourceFile alone resets it to the top).
      if (state.viewerCursor && state.viewerCursor.path === state.sourcePath) {
        var vc = state.viewerCursor;
        setTimeout(function () { try { setSourceCursor(state.sourcePath, vc.lineIndex, vc.column, true, -1); } catch (e) {} }, 60);
      }
      return true;
    }
  } catch {
    sessionStorage.removeItem(uiStateKey);
  }
  return false;
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
      saveUiState();
      location.reload();
    }
  } catch {
    if (liveStatus) liveStatus.textContent = t('status.live.waiting');
  } finally {
    checkingForUpdates = false;
  }
}

function filterNavigation(rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  links.forEach((link) => {
    const path = link.dataset.file || '';
    const source = sourceByPath.get(path);
    const haystack = (path + '\n' + (source?.content || '')).toLowerCase();
    link.hidden = query.length > 0 && !haystack.includes(query);
  });
  sourceLinks.forEach((link) => {
    const path = link.dataset.sourceFile || '';
    const source = sourceByPath.get(path);
    const haystack = (path + '\n' + (source?.content || '')).toLowerCase();
    link.hidden = query.length > 0 && !haystack.includes(query);
  });
  updateTreeVisibility(document.getElementById('changes-panel'), query);
  updateTreeVisibility(document.getElementById('files-panel'), query);
}

function updateTreeVisibility(root, query) {
  if (!root) return;
  Array.from(root.querySelectorAll('details')).reverse().forEach((details) => {
    const hasVisibleLeaf = Array.from(details.children).some((child) => {
      if (child.tagName === 'SUMMARY') return false;
      return !child.hidden;
    });
    details.hidden = query.length > 0 && !hasVisibleLeaf;
    if (query.length > 0 && hasVisibleLeaf) details.open = true;
  });
}

function openDefaultSourceFile() {
  const file = sourceFiles.find((candidate) => candidate.changed && candidate.embedded)
    || sourceFiles.find((candidate) => candidate.embedded)
    || sourceFiles.find((candidate) => candidate.changed)
    || sourceFiles[0];
  if (file) {
    openSourceFile(file.path);
    return;
  }
  if (hunkTotal() > 0) setActive(0, false);
}

function handleSourceCopy(event) {
  const selection = window.getSelection();
  const sourceBody = document.getElementById('source-body');
  const viewer = document.getElementById('source-viewer');
  if (!selection || selection.isCollapsed || !sourceBody || !viewer || viewer.classList.contains('hidden')) return;
  if (!selection.anchorNode || !selection.focusNode) return;
  if (!sourceBody.contains(selection.anchorNode) || !sourceBody.contains(selection.focusNode)) return;

  const path = viewer.dataset.openPath || '';
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const rows = selectedSourceRows(selection);
  if (rows.length === 0) return;

  const lineNumbers = rows
    .map((row) => Number(row.dataset.lineIndex || 0) + 1)
    .filter((line) => Number.isFinite(line))
    .sort((a, b) => a - b);
  const startLine = lineNumbers[0];
  const endLine = lineNumbers[lineNumbers.length - 1];
  if (!startLine || !endLine) return;

  const selectedText = cleanSelectedSourceText(selection.toString(), rows);
  const code = selectedText || sourceLinesForRows(file, rows);
  if (!code.trim()) return;

  const reference = path + ':' + (startLine === endLine ? String(startLine) : startLine + '-' + endLine);
  const language = file.language && file.language !== 'text' ? file.language : '';
  const fence = String.fromCharCode(96).repeat(3);
  const payload = reference + '\n\n' + fence + language + '\n' + code.replace(/\s+$/g, '') + '\n' + fence;
  event.clipboardData?.setData('text/plain', payload);
  event.preventDefault();
}

function selectedSourceRows(selection) {
  if (!selection.rangeCount) return [];
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  return Array.from(document.querySelectorAll('#source-body .source-row'))
    .filter((row) => ranges.some((range) => {
      try {
        return range.intersectsNode(row);
      } catch {
        return false;
      }
    }))
    .sort((a, b) => Number(a.dataset.lineIndex || 0) - Number(b.dataset.lineIndex || 0));
}

function cleanSelectedSourceText(text, rows) {
  const value = String(text || '').replace(/\r/g, '').replace(/\u200b/g, '');
  if (!value.trim()) return '';
  const lineNumbers = rows.map((row) => Number(row.dataset.lineIndex || 0) + 1);
  const lines = value.split('\n');
  if (lines.length >= lineNumbers.length) {
    return lines
      .map((line, index) => {
        const lineNumber = lineNumbers[index];
        return lineNumber ? line.replace(new RegExp('^\\s*' + lineNumber + '\\s+'), '') : line;
      })
      .join('\n')
      .trimEnd();
  }
  return value.trimEnd();
}

function sourceLinesForRows(file, rows) {
  const lines = file.content.split(/\r?\n/);
  return rows
    .map((row) => lines[Number(row.dataset.lineIndex || 0)] || '')
    .join('\n')
    .trimEnd();
}

function handleSourceClick(event) {
  const target = event.target;
  const runBtn = target?.closest?.('.http-run');
  if (runBtn) {
    event.preventDefault();
    runHttpRequest(Number(runBtn.dataset.req));
    return;
  }
  const respToggle = target?.closest?.('.http-resp-toggle');
  if (respToggle) {
    event.preventDefault();
    const panel = respToggle.closest('.http-response')?.querySelector('.http-resp-headers');
    if (panel) panel.classList.toggle('hidden');
    return;
  }
  const row = target?.closest?.('.source-row');
  if (!row) return;
  clearTreeFocus();
  const viewer = document.getElementById('source-viewer');
  const path = viewer?.dataset.openPath || '';
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const lineIndex = Number(row.dataset.lineIndex || 0);
  const lines = file.content.split(/\r?\n/);
  const line = lines[lineIndex] || '';
  const codeCell = row.querySelector('.source-code');
  const column = estimateColumnFromClick(codeCell, event, line);
  setSourceCursor(path, lineIndex, column, false, -1);
}

function estimateColumnFromClick(codeCell, event, line) {
  if (!codeCell) return 0;
  const rect = codeCell.getBoundingClientRect();
  const style = getComputedStyle(codeCell);
  const paddingLeft = Number.parseFloat(style.paddingLeft || '0') || 0;
  const x = event.clientX - rect.left - paddingLeft;
  const width = measuredCharWidth || measureCharWidth(codeCell);
  const column = Math.round(x / Math.max(width, 1));
  return Math.max(0, Math.min(line.length, column));
}

function measureCharWidth(element) {
  const probe = document.createElement('span');
  probe.textContent = 'mmmmmmmmmm';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.font = getComputedStyle(element).font;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  measuredCharWidth = width || 7;
  return measuredCharWidth;
}

var caretBusyTimer = null;
// While the caret is actively moving (held arrow key, typing), keep it solid and only resume the
// blink animation after a short idle. Otherwise key-repeat exposes the blink's "off" frames between
// moves and the caret appears to vanish intermittently.
function markCaretBusy() {
  document.body.classList.add('caret-busy');
  if (caretBusyTimer) clearTimeout(caretBusyTimer);
  caretBusyTimer = setTimeout(function () { document.body.classList.remove('caret-busy'); }, 650);
}

function setSourceCursor(path, lineIndex, column, shouldReveal = false, targetLine = -1) {
  markCaretBusy();
  selectedCommentRow = null; // any explicit caret placement (click/move) ends a comment-box selection
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const lines = file.content.split(/\r?\n/);
  const boundedLine = Math.max(0, Math.min(lineIndex, Math.max(lines.length - 1, 0)));
  const boundedColumn = Math.max(0, Math.min(column, (lines[boundedLine] || '').length));

  const prev = viewerCursor;
  const viewer = document.getElementById('source-viewer');
  // Fast path: the file is already on screen and only the caret moved. Re-rendering the whole
  // file on every keystroke blocks the main thread on large files, so patch just the previous
  // and new caret lines in place instead.
  const sameFileOpen = Boolean(viewer && viewer.dataset.openPath === path && !viewer.classList.contains('hidden')
    && prev && prev.path === path && !isHttpFile(path));

  viewerCursor = { path, lineIndex: boundedLine, column: boundedColumn, targetLine };

  if (sameFileOpen) {
    updateSourceCaret(prev, lines, file.language || 'text');
  } else {
    const shouldSwitch = !viewer || viewer.dataset.openPath !== path || viewer.classList.contains('hidden');
    openSourceFile(path, shouldSwitch);
  }
  if (shouldReveal) {
    requestAnimationFrame(() => {
      document.querySelector('.source-row.cursor-line')?.scrollIntoView({ block: 'center' });
    });
  }
  recordNav(navEntryOf('source'));
}

// Move the caret by patching only the affected line cells, never the whole <table>. This keeps
// large files responsive (no full re-highlight per keystroke) and, because the new caret line is
// rebuilt with a fresh .code-cursor span, restarts the blink animation so the caret is solid the
// instant it moves and only resumes blinking when idle.
function updateSourceCaret(prev, lines, language) {
  const body = document.getElementById('source-body');
  if (!body) return;
  // Markdown/CSV render to HTML cells (.rendered-body): the caret is a whole-row highlight there,
  // so never rewrite a cell's innerHTML (that would replace the rendered block with raw text).
  const rendered = body.classList.contains('rendered-body');
  const rowFor = (idx) => body.querySelector('.source-row[data-line-index="' + idx + '"]');
  // Restore the line the caret left: drop the caret span, re-highlight the full line.
  if (prev && prev.lineIndex !== viewerCursor.lineIndex) {
    const prevRow = rowFor(prev.lineIndex);
    if (prevRow) {
      prevRow.classList.remove('cursor-line');
      if (!rendered) {
        const prevCell = prevRow.querySelector('.source-code');
        if (prevCell) prevCell.innerHTML = highlightLine(lines[prev.lineIndex] || '', language);
      }
    }
  }
  // Reconcile the go-to-definition highlight (set only on symbol jumps, cleared on plain moves).
  body.querySelectorAll('.source-row.symbol-target').forEach((r) => r.classList.remove('symbol-target'));
  if (viewerCursor.targetLine >= 0) rowFor(viewerCursor.targetLine)?.classList.add('symbol-target');
  // Rebuild the new caret line with the caret span.
  const row = rowFor(viewerCursor.lineIndex);
  if (!row) { if (!rendered) openSourceFile(viewerCursor.path, false); return; } // line not in the DOM — full re-render (eager source only)
  row.classList.add('cursor-line');
  if (!rendered) {
    const cell = row.querySelector('.source-code');
    if (cell) cell.innerHTML = renderLineWithCursor(lines[viewerCursor.lineIndex] || '', language, viewerCursor.column);
  }
}

function openSourceAt(path, lineIndex, column) {
  setSourceCursor(path, lineIndex, column, true, lineIndex);
}

function isSourceViewerVisible() {
  const viewer = document.getElementById('source-viewer');
  return Boolean(viewer && !viewer.classList.contains('hidden'));
}

function openDiffFileAtCaret() {
  if (diffCursor && isDiffViewVisible()) {
    const dwrap = diffWrapperByPath(diffCursor.path);
    const drow = dwrap ? diffRowAt(dwrap, diffCursor.side, diffCursor.rowIndex) : null;
    const dline = drow ? diffLineNumber(drow) : null;
    if (sourceByPath.has(diffCursor.path)) { setSourceCursor(diffCursor.path, dline != null ? dline - 1 : 0, 0, true, -1); return; }
    openSourceFile(diffCursor.path); return;
  }
  const sel = window.getSelection();
  const node = sel && sel.anchorNode;
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  const wrapper = (el && el.closest && el.closest('.d2h-file-wrapper')) || document.querySelector('.d2h-file-wrapper:not(.df-inactive)');
  if (!wrapper) return;
  const fileName = (wrapper.querySelector('.d2h-file-name')?.textContent || '').trim();
  if (!fileName) return;
  if (!sourceByPath.has(fileName)) { openSourceFile(fileName); return; }
  let lineIndex = 0;
  const lineEl = el && el.closest && el.closest('.d2h-code-side-line');
  if (lineEl) {
    const row = lineEl.closest('tr');
    const numEl = row && row.querySelector('.d2h-code-side-linenumber');
    const num = numEl ? parseInt((numEl.textContent || '').trim(), 10) : NaN;
    if (Number.isFinite(num)) lineIndex = Math.max(0, num - 1);
  }
  setSourceCursor(fileName, lineIndex, 0, true, -1);
}

// ----- Comment-box navigation: a box attached to a line is a selectable stop while moving the caret -----
function commentRowSiblingOf(lineIndex, dir) {
  var cur = document.querySelector('#source-body .source-row[data-line-index="' + lineIndex + '"]');
  if (!cur) return null;
  var sib = dir < 0 ? cur.previousElementSibling : cur.nextElementSibling;
  return (sib && sib.classList && sib.classList.contains('mc-comment-row')) ? sib : null;
}
function selectCommentRow(row) {
  if (selectedCommentRow && selectedCommentRow !== row) selectedCommentRow.classList.remove('mc-row-selected');
  selectedCommentRow = row || null;
  if (!selectedCommentRow) return;
  selectedCommentRow.classList.add('mc-row-selected');
  // hide the text caret while the box is "selected" (no re-render happens during plain selection)
  document.querySelectorAll('#source-body .source-row.cursor-line').forEach(function (r) { r.classList.remove('cursor-line'); });
  document.querySelectorAll('#source-body .code-cursor').forEach(function (s) { var p = s.parentNode; if (p) { p.removeChild(s); if (p.normalize) p.normalize(); } });
}
function deleteCommentsInRow(row) {
  if (!row) return;
  var seqs = Array.prototype.slice.call(row.querySelectorAll('.mc-del')).map(function (b) { return parseInt(b.dataset.seq, 10); });
  selectedCommentRow = null;
  if (seqs.length) {
    reviewComments = reviewComments.filter(function (c) { return seqs.indexOf(c.seq) < 0; });
    saveComments();
  }
  refreshComments(); // remaining comment rows re-injected; the caret stays hidden until the next arrow press
}
function handleSourceCaretKey(event) {
  if (!viewerCursor) return false;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return false;
  const extend = event.shiftKey;
  // A comment box is selected (caret hidden): Backspace/Delete removes it; an arrow steps off it.
  if (selectedCommentRow) {
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); deleteCommentsInRow(selectedCommentRow); return true; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Escape') {
      var dir = event.key === 'ArrowUp' ? -1 : (event.key === 'ArrowDown' ? 1 : 0);
      var sib = dir < 0 ? selectedCommentRow.previousElementSibling : (dir > 0 ? selectedCommentRow.nextElementSibling : null);
      selectedCommentRow.classList.remove('mc-row-selected');
      selectedCommentRow = null;
      event.preventDefault();
      if (sib && sib.classList && sib.classList.contains('source-row')) {
        var li = parseInt(sib.dataset.lineIndex, 10);
        if (isFinite(li)) { setSourceCursor(viewerCursor.path, li, 0, true, -1); return true; }
      }
      setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, viewerCursor.column, false, -1); // restore caret where it was
      return true;
    }
    return false;
  }
  // Plain Up/Down: a comment box between the caret line and the next line becomes a selectable stop.
  if (!extend && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    var box = commentRowSiblingOf(viewerCursor.lineIndex, event.key === 'ArrowUp' ? -1 : 1);
    if (box) { event.preventDefault(); selectCommentRow(box); return true; }
  }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveSourceCursor(1, 0, extend); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveSourceCursor(-1, 0, extend); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveSourceCursor(0, -1, extend); return true; }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveSourceCursor(0, 1, extend); return true; }
  return false;
}

function moveSourceCursor(dLine, dColumn, extend) {
  if (!viewerCursor) return;
  const file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return;
  // Markdown/CSV rendered view: rows are blocks (sparse data-line-index), so any arrow steps to the
  // adjacent block row rather than into a (non-existent) raw line. No text column / selection there.
  const renderedBody = document.getElementById('source-body');
  if (renderedBody && renderedBody.classList.contains('rendered-body')) {
    const rows = Array.from(renderedBody.querySelectorAll('.source-row'));
    if (!rows.length) return;
    let ci = rows.indexOf(renderedBody.querySelector('.source-row[data-line-index="' + viewerCursor.lineIndex + '"]'));
    if (ci < 0) ci = 0;
    const step = (dLine || 0) + (dColumn > 0 ? 1 : dColumn < 0 ? -1 : 0);
    const ni = Math.max(0, Math.min(rows.length - 1, ci + (step || 0)));
    selectionAnchor = null;
    setSourceCursor(viewerCursor.path, Number(rows[ni].dataset.lineIndex) || 0, 0, true, -1);
    return;
  }
  const lines = file.content.split(/\r?\n/);
  let line = viewerCursor.lineIndex;
  let col = viewerCursor.column;
  if (dColumn < 0) {
    if (col > 0) col -= 1;
    else if (line > 0) { line -= 1; col = (lines[line] || '').length; }
  } else if (dColumn > 0) {
    if (col < (lines[line] || '').length) col += 1;
    else if (line < lines.length - 1) { line += 1; col = 0; }
  }
  if (dLine !== 0) {
    line = Math.max(0, Math.min(lines.length - 1, line + dLine));
    col = Math.min(col, (lines[line] || '').length);
  }
  if (extend) {
    if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  } else {
    selectionAnchor = null;
  }
  setSourceCursor(viewerCursor.path, line, col, true, -1);
  applySourceSelection();
}
// Word boundary in text from col in direction dir (+1 next, -1 prev): skip non-word, then word.
function nextWordBoundary(text, col, dir) {
  // Classify like vim's word motions: 0 = whitespace, 1 = word char, 2 = punctuation.
  // A run of word chars and a run of punctuation are each their own "word", so the
  // caret lands on the START of the next word/punctuation run (vim 'w'), or the start
  // of the previous one (vim 'b') -- never stranded in the middle of whitespace.
  var classOf = function (ch) {
    if (ch === '' || /\s/.test(ch)) return 0;
    if (/[A-Za-z0-9_$]/.test(ch)) return 1;
    return 2;
  };
  var i = col;
  if (dir > 0) {
    var cf = classOf(text.charAt(i));
    if (cf !== 0) { while (i < text.length && classOf(text.charAt(i)) === cf) i++; }
    while (i < text.length && classOf(text.charAt(i)) === 0) i++;
  } else {
    i--;
    while (i > 0 && classOf(text.charAt(i)) === 0) i--;
    var cb = classOf(text.charAt(i));
    while (i > 0 && classOf(text.charAt(i - 1)) === cb) i--;
    if (i < 0) i = 0;
  }
  return i;
}
function moveSourceWord(dir, extend) {
  if (!viewerCursor) return;
  var file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return;
  var lines = file.content.split(/\r?\n/);
  var line = viewerCursor.lineIndex, col = viewerCursor.column;
  var text = lines[line] || '';
  if (dir > 0) {
    var fwd = nextWordBoundary(text, col, 1);
    if (fwd < text.length || line >= lines.length - 1) { col = fwd; }
    else { line += 1; var nt = lines[line] || ''; var m = nt.search(/\S/); col = m < 0 ? 0 : m; }
  } else {
    var back = nextWordBoundary(text, col, -1);
    if (back < col && /\S/.test(text.charAt(back))) { col = back; }
    else if (line > 0) { line -= 1; var pt = lines[line] || ''; col = pt.length > 0 ? nextWordBoundary(pt, pt.length, -1) : 0; }
    else { col = back; }
  }
  if (extend) { if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column }; }
  else selectionAnchor = null;
  setSourceCursor(viewerCursor.path, line, col, true, -1);
  applySourceSelection();
}

function applySourceSelection() {
  const sel = window.getSelection();
  if (!sel) return;
  if (!selectionAnchor || !viewerCursor) { sel.removeAllRanges(); return; }
  const a = caretDomPosition(selectionAnchor.lineIndex, selectionAnchor.column);
  const c = caretDomPosition(viewerCursor.lineIndex, viewerCursor.column);
  if (a && c) {
    try { sel.setBaseAndExtent(a.node, a.offset, c.node, c.offset); } catch (e) {}
  }
}

function caretDomPosition(lineIndex, column) {
  const cell = document.querySelector('.source-row[data-line-index="' + lineIndex + '"] .source-code');
  if (!cell) return null;
  let remaining = column;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
  }
  return { node: cell, offset: cell.childNodes.length };
}

function wordAtCursor() {
  if (!viewerCursor) return null;
  const file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return null;
  const line = file.content.split(/\r?\n/)[viewerCursor.lineIndex] || '';
  const column = Math.max(0, Math.min(viewerCursor.column, line.length));
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match = null;
  while ((match = identifier.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (column >= start && column <= end) {
      return { name: match[0], path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: start };
    }
  }
  return null;
}

function goToSymbolUnderCursor() {
  const symbol = wordAtCursor();
  if (symbol) goToDefOrUsages(symbol.name);
}
// Cmd+B: on a declaration, show its usages (navigate if there's only one); elsewhere, go to the definition.
function goToDefOrUsages(name) {
  if (!name) return;
  if (REVIEW_LAZY_LOAD && !sourceLoaded) { pendingSymbol = name; loadSourceData(); return; } // load source+index on first use
  var def = findSymbolDefinition(name);
  var loc = caretSourceLoc();
  if (def && loc && def.path === loc.path && def.lineIndex === loc.lineIndex) {
    openUsages(name, def);
    return;
  }
  if (def) openSourceAt(def.path, def.lineIndex, def.column);
}
// Where the caret sits, mapped to a source (path, lineIndex). In the diff, only the new side maps cleanly.
function caretSourceLoc() {
  if (isSourceViewerVisible() && viewerCursor) return { path: viewerCursor.path, lineIndex: viewerCursor.lineIndex };
  if (isDiffViewVisible() && diffCursor && diffCursor.side === 'new') {
    var wrap = diffWrapperByPath(diffCursor.path);
    var row = wrap ? diffRowAt(wrap, diffCursor.side, diffCursor.rowIndex) : null;
    var ln = row ? diffLineNumber(row) : null;
    if (ln != null) return { path: diffCursor.path, lineIndex: ln - 1 };
  }
  return null;
}
// All word-boundary occurrences of name across embedded files, excluding the declaration line itself.
function findUsages(name, defPath, defLine) {
  var re;
  try { re = new RegExp('(^|[^A-Za-z0-9_$])' + escapeRegExp(name) + '(?![A-Za-z0-9_$])'); } catch (e) { return []; }
  var out = [];
  for (var fi = 0; fi < sourceFiles.length; fi++) {
    var f = sourceFiles[fi];
    if (!f.embedded) continue;
    var lines = String(f.content).split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      if (f.path === defPath && li === defLine) continue;
      var m = re.exec(lines[li]);
      if (m) {
        out.push({ path: f.path, lineIndex: li, column: m.index + (m[1] ? m[1].length : 0), text: lines[li] });
        if (out.length >= 500) return out;
      }
    }
  }
  return out;
}
function openUsages(name, def) {
  var items = findUsages(name, def.path, def.lineIndex);
  if (items.length === 1) { openSourceAt(items[0].path, items[0].lineIndex, items[0].column); return; }
  usageItems = items;
  usageActive = 0;
  showUsages(name, items.length);
}
function showUsages(name, count) {
  var box = document.getElementById('usages');
  var title = document.getElementById('usages-title');
  if (!box) return;
  if (title) title.textContent = count + ' usage' + (count === 1 ? '' : 's') + ' of ' + name;
  renderUsages();
  box.classList.remove('hidden');
}
function renderUsages() {
  var results = document.getElementById('usages-results');
  if (!results) return;
  if (!usageItems.length) { results.innerHTML = '<div class="quick-open-empty">No usages found.</div>'; return; }
  results.innerHTML = usageItems.map(function (item, index) {
    var fname = item.path.split('/').pop();
    return '<button type="button" class="quick-open-item usage-item' + (index === usageActive ? ' active' : '') + '" data-index="' + index + '">'
      + '<span class="usage-loc">' + escapeHtml(fname) + ':' + (item.lineIndex + 1) + '</span>'
      + '<span class="usage-code">' + escapeHtml(item.text.replace(/^\s+/, '').slice(0, 160)) + '</span>'
      + '</button>';
  }).join('');
  updateUsageActive();
}
function updateUsageActive() {
  var results = document.getElementById('usages-results');
  if (!results) return;
  var items = results.querySelectorAll('.usage-item');
  for (var i = 0; i < items.length; i++) {
    var on = i === usageActive;
    items[i].classList.toggle('active', on);
    if (on && items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
  }
}
function handleUsagesKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); closeUsages(); return true; }
  if (event.key === 'ArrowDown') { event.preventDefault(); usageActive = Math.min(usageActive + 1, usageItems.length - 1); updateUsageActive(); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); usageActive = Math.max(usageActive - 1, 0); updateUsageActive(); return true; }
  if (event.key === 'Enter') { event.preventDefault(); openUsageItem(usageItems[usageActive]); return true; }
  return false;
}
function openUsageItem(item) {
  if (!item) return;
  closeUsages();
  openSourceAt(item.path, item.lineIndex, item.column);
}
function closeUsages() {
  document.getElementById('usages')?.classList.add('hidden');
}

var symbolIndex = null; // Map<name, [{path,lineIndex,column}]>; built off-thread by a Web Worker, null until ready
function symbolIndexWorker() {
  self.onmessage = function (e) {
    var files = e.data || [];
    var patterns = [
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      /^\s*(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|annotation|static|export|default|expect|actual|value)\s+)*(?:class|interface|object|enum|trait|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      /^\s*(?:export\s+)?(?:const|let|var|val)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
      /^\s*(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\s+)*(?:fun|def|fn|func)\s+([A-Za-z_$][A-Za-z0-9_$]*)/
    ];
    var index = new Map();
    var total = files.length;
    var step = Math.max(1, Math.floor(total / 20)); // ~20 progress ticks regardless of repo size
    for (var fi = 0; fi < total; fi++) {
      var p = files[fi].path;
      var lines = String(files[fi].content || '').split(/\r?\n/);
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        for (var pi = 0; pi < patterns.length; pi++) {
          var m = patterns[pi].exec(line);
          if (m && m[1]) {
            var arr = index.get(m[1]);
            if (!arr) { arr = []; index.set(m[1], arr); }
            arr.push({ path: p, lineIndex: li, column: Math.max(0, line.indexOf(m[1])) });
            break;
          }
        }
      }
      if ((fi + 1) % step === 0 && fi + 1 < total) self.postMessage({ done: fi + 1, total: total });
    }
    self.postMessage({ index: index, total: total });
  };
}
function startSymbolIndex() {
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return;
    var src = '(' + symbolIndexWorker.toString() + ')()';
    var url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    var worker = new Worker(url);
    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg && msg.index) { // final index
        symbolIndex = msg.index;
        setIndexProgress(msg.total, msg.total);
        try { worker.terminate(); } catch (x) {}
        try { URL.revokeObjectURL(url); } catch (x) {}
      } else if (msg && typeof msg.done === 'number') { // progress tick
        setIndexProgress(msg.done, msg.total);
      }
    };
    worker.onerror = function () { setIndexProgress(1, 1); try { worker.terminate(); } catch (x) {} };
    var payload = [];
    for (var i = 0; i < sourceFiles.length; i++) {
      if (sourceFiles[i].embedded) payload.push({ path: sourceFiles[i].path, content: sourceFiles[i].content });
    }
    setIndexProgress(0, payload.length);
    worker.postMessage(payload);
  } catch (err) { /* Worker unavailable -> scan fallback remains in effect */ }
}
// Drive the go-to-definition indexing progress bar in the toolbar status. Hidden when done / not running.
function setIndexProgress(done, total) {
  var el = document.getElementById('index-status');
  var bar = document.getElementById('index-progress');
  if (!el) return;
  if (!total || done >= total) {
    el.textContent = (total || 0) + ' ' + t('status.indexed');
    if (bar) bar.classList.add('hidden');
    return;
  }
  el.textContent = t('status.indexing') + ' ' + done + '/' + total + '…';
  if (bar) {
    bar.classList.remove('hidden');
    var fill = bar.firstElementChild;
    if (fill) fill.style.width = Math.round(done / total * 100) + '%';
  }
}
function wordAtDiffCaret() {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return null;
  var text = diffLineText(diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex));
  var column = Math.max(0, Math.min(diffCursor.column, text.length));
  var identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  var match = null;
  while ((match = identifier.exec(text))) {
    if (column >= match.index && column <= match.index + match[0].length) return match[0];
  }
  return null;
}
function goToSymbolFromDiff() {
  goToDefOrUsages(wordAtDiffCaret());
}
function findSymbolDefinition(name) {
  if (symbolIndex) {
    var hits = symbolIndex.get(name);
    if (hits && hits.length) {
      var cur = (viewerCursor && viewerCursor.path) || (diffCursor && diffCursor.path) || '';
      for (var i = 0; i < hits.length; i++) { if (hits[i].path === cur) return hits[i]; }
      return hits[0];
    }
  }
  const matchers = definitionMatchers(name);
  const currentPath = viewerCursor?.path || '';
  const orderedFiles = [
    ...sourceFiles.filter((file) => file.path === currentPath),
    ...sourceFiles.filter((file) => file.path !== currentPath),
  ].filter((file) => file.embedded);

  for (const file of orderedFiles) {
    const lines = file.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (matchers.some((matcher) => matcher.test(line))) {
        return { path: file.path, lineIndex, column: Math.max(0, line.indexOf(name)) };
      }
    }
  }
  return null;
}

function definitionMatchers(name) {
  const escaped = escapeRegExp(name);
  const mod = '(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|enum|annotation|static|export|default|expect|actual|value)\\s+)*';
  const funMod = '(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\\s+)*';
  return [
    new RegExp('^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + mod + '(?:class|interface|object|enum|trait|struct)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|val)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + '(?:fun|def|fn|func)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + escaped + '\\s*\\([^)]*\\)\\s*(?::\\s*[^=]+)?\\s*(?:\\{|=>)'),
    new RegExp('^\\s*' + escaped + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)'),
  ];
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

function setSourceTypeIcon(path) {
  var holder = document.getElementById('source-type-icon');
  if (!holder) return;
  var link = sourceLinks.find(function (l) { return l.dataset.sourceFile === path; });
  var icon = link ? link.querySelector('.ftype') : null;
  holder.innerHTML = icon ? icon.outerHTML : '';
}
// Files-mode tabs: each distinct file opened in the source viewer becomes a tab (session-only).
// Cmd/Ctrl+W closes the active tab; Cmd/Ctrl+Shift+[ / ] cycle tabs; the × button closes one.
// (sourceTabs is declared near the other source state up top so early restore-state openSourceFile
// calls run before this block don't see an undefined array.)
function addSourceTab(path) { if (path && sourceTabs.indexOf(path) < 0) sourceTabs.push(path); }
function sourceTabLabel(path) { var p = String(path || ''); var s = p.lastIndexOf('/'); return s >= 0 ? p.slice(s + 1) : p; }
function currentSourceTabPath() { var v = document.getElementById('source-viewer'); return (v && v.dataset.openPath) || ''; }
function renderSourceTabs(activePath) {
  var bar = document.getElementById('source-tabs');
  if (!bar) return;
  if (!sourceTabs.length) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = sourceTabs.map(function (p) {
    var active = p === activePath;
    return '<div class="source-tab' + (active ? ' active' : '') + '" data-tab-path="' + escapeHtml(p) + '" title="' + escapeHtml(p) + '">'
      + '<span class="source-tab-name">' + escapeHtml(sourceTabLabel(p)) + '</span>'
      + '<button type="button" class="source-tab-close" data-close-path="' + escapeHtml(p) + '" aria-label="Close tab" title="Close (Cmd/Ctrl+W)">×</button>'
      + '</div>';
  }).join('');
  var act = bar.querySelector('.source-tab.active');
  if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function closeSourceTab(path) {
  var idx = sourceTabs.indexOf(path);
  if (idx < 0) return;
  var wasActive = path === currentSourceTabPath();
  sourceTabs.splice(idx, 1);
  if (!wasActive) { renderSourceTabs(currentSourceTabPath()); return; }
  var nextPath = sourceTabs[idx] || sourceTabs[idx - 1] || '';
  if (nextPath) { openSourceFile(nextPath); return; }
  // No tabs left: reset the source view to its empty state.
  var v = document.getElementById('source-viewer'); if (v) v.dataset.openPath = '';
  var body = document.getElementById('source-body');
  if (body) { body.className = 'source-body empty'; body.textContent = t('source.selectFile'); }
  sourceLinks.forEach(function (l) { l.classList.remove('active'); });
  renderSourceTabs('');
}
function closeActiveSourceTab() { var p = currentSourceTabPath(); if (p) { closeSourceTab(p); return true; } return false; }
function cycleSourceTab(dir) {
  if (sourceTabs.length < 2) return;
  var cur = sourceTabs.indexOf(currentSourceTabPath());
  if (cur < 0) cur = 0;
  openSourceFile(sourceTabs[(cur + dir + sourceTabs.length) % sourceTabs.length]);
}

function openSourceFile(path, shouldSwitch = true) {
  const file = sourceByPath.get(path);
  if (!file) return;
  addSourceTab(path);
  renderSourceTabs(path);
  // lazy-LOAD: source content not fetched yet -> show a loading state; loadSourceData re-opens it.
  if (REVIEW_LAZY_LOAD && !sourceLoaded && file.embedded) {
    pendingSourceOpen = { path: path, shouldSwitch: shouldSwitch };
    loadSourceData();
    document.getElementById('source-viewer').dataset.openPath = path;
    sourceLinks.forEach((link) => link.classList.toggle('active', link.dataset.sourceFile === path));
    renderBreadcrumb(document.getElementById('source-title'), path);
    setSourceTypeIcon(path);
    revealTreeFor(path);
    var lb = document.getElementById('source-body');
    lb.className = 'source-body empty';
    lb.textContent = t('source.loading');
    if (shouldSwitch) showSourceView();
    return;
  }
  rememberRecent(path, 'source');
  document.getElementById('source-viewer').dataset.openPath = path;
  sourceLinks.forEach((link) => link.classList.toggle('active', link.dataset.sourceFile === path));
  renderBreadcrumb(document.getElementById('source-title'), path);
  setSourceTypeIcon(path);
  revealTreeFor(path);
  const meta = file.embedded
    ? formatBytes(file.size || 0)
    : formatBytes(file.size || 0) + ' · ' + (file.skippedReason || 'not embedded');
  document.getElementById('source-meta').textContent = meta;
  const body = document.getElementById('source-body');
  // Image files carry a data: URI preview instead of text — render inline (click to zoom).
  if (file.image) {
    body.className = 'source-body image-body';
    body.innerHTML = renderImageView(file);
    document.getElementById('http-env-select')?.classList.add('hidden');
    updateRenderToggle(path);
    if (shouldSwitch) showSourceView();
    return;
  }
  if (!file.embedded) {
    body.className = 'source-body empty';
    body.textContent = file.skippedReason ? t('source.previewUnavailable').replace(/\.$/, '') + ': ' + file.skippedReason + '.' : t('source.previewUnavailable');
    document.getElementById('http-env-select')?.classList.add('hidden');
    updateRenderToggle(path);
    if (shouldSwitch) showSourceView();
    return;
  }
  if (!viewerCursor || viewerCursor.path !== path) {
    viewerCursor = { path, lineIndex: 0, column: 0, targetLine: -1 };
  }
  body.className = 'source-body';
  const httpEnvSelect = document.getElementById('http-env-select');
  // Markdown/CSV render to HTML but stay a line-numbered .source-table: each block (md) or record (csv)
  // is a .source-row keyed by its start line, so the gutter shows line numbers and line/block comments
  // work exactly as in the plain source view (renderSourceComments anchors on .source-row[data-line-index]).
  if (isMarkdownPath(path)) {
    if (renderRawMode) {
      body.innerHTML = renderSourceTable(file, '');
    } else {
      body.classList.add('rendered-body');
      body.innerHTML = renderMarkdownRows(file.content);
    }
    if (httpEnvSelect) httpEnvSelect.classList.add('hidden');
    updateRenderToggle(path);
    renderSourceComments();
    if (shouldSwitch) showSourceView();
    return;
  }
  if (isCsvPath(path)) {
    if (renderRawMode) {
      body.innerHTML = renderSourceTable(file, '');
    } else {
      body.classList.add('rendered-body');
      body.innerHTML = renderCsvRows(file.content, path);
    }
    if (httpEnvSelect) httpEnvSelect.classList.add('hidden');
    updateRenderToggle(path);
    renderSourceComments();
    if (shouldSwitch) showSourceView();
    return;
  }
  if (isHttpFile(path)) {
    body.innerHTML = renderHttpTable(file);
    if (httpEnvSelect) httpEnvSelect.classList.toggle('hidden', httpEnvNames.length === 0);
  } else {
    body.innerHTML = renderSourceTable(file, '');
    if (httpEnvSelect) httpEnvSelect.classList.add('hidden');
  }
  updateRenderToggle(path);
  renderSourceComments();
  if (shouldSwitch) showSourceView();
}

function isMarkdownPath(p) { return /\.(md|mdx|markdown)$/i.test(p || ''); }
function isCsvPath(p) { return /\.(csv|tsv)$/i.test(p || ''); }
function isRenderToggleable(p) { return isMarkdownPath(p) || isCsvPath(p); }

// Markdown/CSV open rendered by default; this flips the open file to raw line-numbered text and back.
// Session-global so the choice carries across files. The toolbar button + Cmd/Ctrl+Shift+M both call it.
var renderRawMode = false;
function updateRenderToggle(path) {
  var btn = document.getElementById('render-toggle');
  if (!btn) return;
  var on = isRenderToggleable(path);
  btn.classList.toggle('hidden', !on);
  if (!on) return;
  btn.textContent = renderRawMode ? t('source.viewRendered') : t('source.viewRaw'); // label = the mode you switch TO
  btn.setAttribute('aria-pressed', renderRawMode ? 'true' : 'false');
}
function toggleRenderMode() {
  var sv = document.getElementById('source-viewer');
  var open = sv && sv.dataset.openPath;
  if (!open || !isRenderToggleable(open)) return;
  renderRawMode = !renderRawMode;
  openSourceFile(open, false); // re-render the current file in the new mode
}
(function wireRenderToggle() {
  var btn = document.getElementById('render-toggle');
  if (btn) btn.addEventListener('click', function () { toggleRenderMode(); });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && (e.key === 'M' || e.key === 'm' || e.code === 'KeyM')) {
      var sv = document.getElementById('source-viewer');
      var open = sv && sv.dataset.openPath;
      if (open && isRenderToggleable(open) && isSourceViewerVisible()) { e.preventDefault(); toggleRenderMode(); }
    }
  });
})();

function renderImageView(file) {
  return '<div class="image-view">'
    + '<img class="image-preview" src="' + file.image + '" alt="' + escapeHtml(file.name) + '" data-zoomable="1">'
    + '<div class="image-cap">' + escapeHtml(file.name) + ' &middot; ' + formatBytes(file.size || 0) + ' &middot; click to zoom</div>'
    + '</div>';
}

function openLightbox(src, alt) {
  if (!src) return;
  var lb = document.getElementById('mc-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'mc-lightbox';
    lb.className = 'mc-lightbox hidden';
    lb.innerHTML = '<img class="mc-lightbox-img" alt="">';
    document.body.appendChild(lb);
    lb.addEventListener('click', closeLightbox);
  }
  var img = lb.querySelector('img');
  img.src = src;
  img.alt = alt || '';
  lb.classList.remove('hidden');
}
function closeLightbox() {
  var lb = document.getElementById('mc-lightbox');
  if (lb) lb.classList.add('hidden');
}
function lightboxOpen() {
  var lb = document.getElementById('mc-lightbox');
  return !!(lb && !lb.classList.contains('hidden'));
}

// Minimal, dependency-free Markdown -> HTML for the preview pane. Input is escaped before any
// markup is applied; links/images are restricted to http(s)/data/mailto/anchor targets.
function renderInlineMd(text) {
  var s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, function (m, code) { return '<code>' + code + '</code>'; });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (m, alt, url) {
    return /^(https?:|data:)/i.test(url) ? '<img class="md-img" src="' + url + '" alt="' + alt + '">' : m;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, function (m, label, url) {
    return /^(https?:|mailto:|#)/i.test(url) ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

function mdFenceLang(lang) {
  var l = (lang || '').toLowerCase();
  if (l === 'js' || l === 'jsx' || l === 'ts' || l === 'tsx') return 'typescript';
  if (l === 'sh' || l === 'bash' || l === 'zsh') return 'shell';
  if (l === 'yml') return 'yaml';
  return l || 'text';
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
}

// Parse markdown into block objects { line, html } where line is the 0-based start line in the source.
// Each block becomes one .source-row so the rendered view keeps a real line gutter + line comments.
function renderMarkdownBlocks(content) {
  var lines = String(content).split(/\r?\n/);
  var blocks = [];
  var i = 0;
  var m;
  while (i < lines.length) {
    var start = i;
    var line = lines[i];
    var fence = line.match(/^(\s*)(```+|~~~+)\s*([\w+#-]*)\s*$/);
    if (fence) {
      var marker = fence[2].charAt(0);
      var closeRe = new RegExp('^\\s*' + (marker === '`' ? '`' : '~') + '{3,}\\s*$');
      var lang = mdFenceLang(fence[3]);
      var buf = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      blocks.push({ line: start, html: '<pre class="md-code"><code>' + buf.map(function (l) { return highlightLine(l, lang); }).join('\n') + '</code></pre>' });
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    var h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) { var lv = h[1].length; blocks.push({ line: start, html: '<h' + lv + ' class="md-h md-h' + lv + '">' + renderInlineMd(h[2].replace(/\s+#+\s*$/, '')) + '</h' + lv + '>' }); i++; continue; }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { blocks.push({ line: start, html: '<hr class="md-hr">' }); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      var qbuf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { qbuf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      blocks.push({ line: start, html: '<blockquote class="md-quote">' + qbuf.map(function (l) { return l.trim() ? '<p>' + renderInlineMd(l) + '</p>' : ''; }).join('') + '</blockquote>' });
      continue;
    }
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      var header = splitTableRow(line);
      i += 2;
      var rowsHtml = '';
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
        var cells = splitTableRow(lines[i]);
        rowsHtml += '<tr>' + header.map(function (_h, ci) { return '<td>' + renderInlineMd(cells[ci] || '') + '</td>'; }).join('') + '</tr>';
        i++;
      }
      blocks.push({ line: start, html: '<table class="md-table"><thead><tr>' + header.map(function (c) { return '<th>' + renderInlineMd(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>' });
      continue;
    }
    if ((m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      var type = /\d/.test(m[2]) ? 'ol' : 'ul';
      var items = '';
      while (i < lines.length && (m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) { items += '<li>' + renderInlineMd(m[3]) + '</li>'; i++; }
      blocks.push({ line: start, html: '<' + type + ' class="md-list">' + items + '</' + type + '>' });
      continue;
    }
    var pbuf = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(\s{0,3}#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s|\s*(```|~~~))/.test(lines[i])) { pbuf.push(lines[i]); i++; }
    blocks.push({ line: start, html: '<p class="md-p">' + renderInlineMd(pbuf.join('\n')).replace(/\n/g, '<br>') + '</p>' });
  }
  return blocks;
}

function renderMarkdownRows(content) {
  var blocks = renderMarkdownBlocks(content);
  if (!blocks.length) return '<table class="source-table md-doc"><tbody></tbody></table>';
  var rows = blocks.map(function (b) {
    return '<tr class="source-row md-row" data-line-index="' + b.line + '"><td class="num">' + (b.line + 1) + '</td><td class="source-code md-cell">' + b.html + '</td></tr>';
  }).join('');
  return '<table class="source-table md-doc"><tbody>' + rows + '</tbody></table>';
}

// RFC-4180-ish delimited parser: handles quoted fields with embedded delimiters, newlines, and "" escapes.
function parseDelimited(content, delim) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var s = String(content);
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// CSV/TSV renders to an aligned table that is still a .source-table: each record is a .source-row keyed
// by its record index (data-line-index) so line numbers show in the gutter and comments anchor per row.
function renderCsvRows(content, path) {
  var delim = /\.tsv$/i.test(path || '') ? '\t' : ',';
  var records = parseDelimited(content, delim).filter(function (r) { return !(r.length === 1 && r[0] === ''); });
  if (!records.length) return '<table class="source-table csv-doc"><tbody></tbody></table>';
  var cols = records.reduce(function (max, r) { return Math.max(max, r.length); }, 0);
  var rows = records.map(function (rec, idx) {
    var head = idx === 0;
    var cells = '';
    for (var c = 0; c < cols; c++) {
      var v = escapeHtml(rec[c] == null ? '' : rec[c]);
      cells += head ? '<th class="csv-cell">' + v + '</th>' : '<td class="csv-cell">' + v + '</td>';
    }
    return '<tr class="source-row csv-row' + (head ? ' csv-head' : '') + '" data-line-index="' + idx + '"><td class="num">' + (idx + 1) + '</td>' + cells + '</tr>';
  }).join('');
  return '<table class="source-table csv-doc"><tbody>' + rows + '</tbody></table>';
}

function isHttpFile(path) {
  return /\.(http|rest)$/i.test(path || '');
}

function currentHttpEnv() {
  return httpEnvironments[currentHttpEnvName] || {};
}

function applyHttpVars(text, env) {
  return String(text == null ? '' : text).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, function (whole, name) {
    if (env && Object.prototype.hasOwnProperty.call(env, name)) return env[name];
    return whole;
  });
}

// Parses an IntelliJ-style .http file into a list of requests. Each request
// tracks the line of its request line (for the gutter Run button) and the line
// span it covers (for placing the inline response and for Cmd/Alt+Enter).
function parseHttpRequests(content) {
  const methods = { GET: 1, POST: 1, PUT: 1, PATCH: 1, DELETE: 1, HEAD: 1, OPTIONS: 1, TRACE: 1, CONNECT: 1 };
  const lines = String(content).split(/\r?\n/);
  const requests = [];
  const vars = {};
  let curr = null;
  let phase = 'pre';
  function flush() {
    if (curr && curr.url) {
      curr.body = curr.bodyLines.join('\n').replace(/\s+$/, '');
      requests.push(curr);
    }
  }
  function start(boundaryLine, name, index) {
    return { name: name, method: '', url: '', headers: [], bodyLines: [], startLine: -1, endLine: index, boundaryLine: boundaryLine };
  }
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (trimmed.indexOf('###') === 0) {
      flush();
      curr = start(i, trimmed.replace(/^#+/, '').trim(), i);
      phase = 'pre';
      continue;
    }
    if (!curr) {
      curr = start(-1, '', i);
      phase = 'pre';
    }
    curr.endLine = i;
    if (phase === 'pre') {
      if (trimmed === '') continue;
      if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) continue;
      const varMatch = /^@([\w.$-]+)\s*=\s*(.*)$/.exec(trimmed);
      if (varMatch) { vars[varMatch[1]] = varMatch[2].trim(); continue; }
      const sp = trimmed.indexOf(' ');
      const firstToken = sp >= 0 ? trimmed.slice(0, sp) : trimmed;
      if (sp >= 0 && methods[firstToken.toUpperCase()]) {
        curr.method = firstToken.toUpperCase();
        curr.url = trimmed.slice(sp + 1).replace(/\s+HTTP\/[\d.]+\s*$/i, '').trim();
      } else {
        curr.method = 'GET';
        curr.url = trimmed.replace(/\s+HTTP\/[\d.]+\s*$/i, '').trim();
      }
      curr.startLine = i;
      phase = 'headers';
      continue;
    }
    if (phase === 'headers') {
      if (trimmed === '') { phase = 'body'; continue; }
      if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) continue;
      const colon = rawLine.indexOf(':');
      if (colon > 0) curr.headers.push({ name: rawLine.slice(0, colon).trim(), value: rawLine.slice(colon + 1).trim() });
      continue;
    }
    curr.bodyLines.push(rawLine);
  }
  flush();
  return { requests: requests, vars: vars };
}

function renderHttpTable(file) {
  const parsed = parseHttpRequests(file.content);
  const requests = parsed.requests;
  httpRequestsByPath.set(file.path, requests);
  httpVarsByPath.set(file.path, parsed.vars);
  const env = Object.assign({}, parsed.vars, currentHttpEnv());
  const lines = String(file.content).split(/\r?\n/);
  const cursor = viewerCursor && viewerCursor.path === file.path ? viewerCursor : null;
  const runAtLine = {};
  const respAfterLine = {};
  requests.forEach(function (req, idx) {
    if (req.startLine >= 0) runAtLine[req.startLine] = idx;
    respAfterLine[req.endLine] = idx;
  });
  let rows = '';
  lines.forEach(function (line, index) {
    const hasRun = Object.prototype.hasOwnProperty.call(runAtLine, index);
    const reqIdx = hasRun ? runAtLine[index] : -1;
    const isCursorLine = Boolean(cursor && cursor.lineIndex === index);
    const gutter = hasRun
      ? '<button type="button" class="http-run" data-req="' + reqIdx + '" title="Run request (Cmd/Alt+Enter)" aria-label="Run request">&#9654;</button>'
      : '';
    rows += '<tr class="source-row http-row' + (hasRun ? ' http-request-line' : '') + (isCursorLine ? ' cursor-line' : '') + '" data-line-index="' + index + '">'
      + '<td class="num http-gutter">' + gutter + '<span class="num-text">' + (index + 1) + '</span></td>'
      + '<td class="source-code">' + (isCursorLine ? renderHttpLineWithCursor(line, env, cursor.column) : highlightHttpLine(line, env)) + '</td>'
      + '</tr>';
    if (Object.prototype.hasOwnProperty.call(respAfterLine, index)) {
      const rIdx = respAfterLine[index];
      rows += '<tr class="http-response-row"><td class="num"></td><td class="source-code"><div class="http-response hidden" id="http-resp-' + rIdx + '"></div></td></tr>';
    }
  });
  return '<table class="source-table http-table"><tbody>' + rows + '</tbody></table>';
}
function renderHttpLineWithCursor(text, env, column) {
  var col = Math.max(0, Math.min(column, text.length));
  return highlightHttpLine(text.slice(0, col), env) + '<span class="code-cursor" aria-hidden="true"></span>' + highlightHttpLine(text.slice(col), env);
}

function highlightHttpLine(line, env) {
  const trimmed = line.trim();
  if (trimmed.indexOf('###') === 0) return '<span class="http-sep">' + escapeHtml(line) + '</span>';
  if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) return '<span class="tok-comment">' + escapeHtml(line) + '</span>';
  let html = escapeHtml(line);
  html = html.replace(/^(\s*)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(\s)/, function (whole, pre, method, post) {
    return pre + '<span class="http-method">' + method + '</span>' + post;
  });
  html = html.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, function (whole, name) {
    const known = env && Object.prototype.hasOwnProperty.call(env, name);
    const title = known ? String(env[name]) : 'Undefined variable';
    return '<span class="http-var ' + (known ? 'known' : 'unknown') + '" title="' + escapeHtml(title) + '">' + escapeHtml(whole) + '</span>';
  });
  return html;
}

function sendHttp(request) {
  if (window.monacoriHttp && typeof window.monacoriHttp.send === 'function') {
    return Promise.resolve(window.monacoriHttp.send(request));
  }
  return fetch('/__http_send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }).then(function (response) { return response.json(); });
}

function runHttpRequest(reqIndex) {
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  const requests = httpRequestsByPath.get(path);
  if (!requests || !requests[reqIndex]) return;
  const req = requests[reqIndex];
  const env = Object.assign({}, httpVarsByPath.get(path) || {}, currentHttpEnv());
  const headers = {};
  req.headers.forEach(function (header) {
    const key = applyHttpVars(header.name, env);
    if (key) headers[key] = applyHttpVars(header.value, env);
  });
  const resolved = {
    method: req.method || 'GET',
    url: applyHttpVars(req.url, env),
    headers: headers,
    body: req.body ? applyHttpVars(req.body, env) : undefined,
  };
  const target = document.getElementById('http-resp-' + reqIndex);
  if (target) {
    target.className = 'http-response loading';
    target.textContent = resolved.method + ' ' + resolved.url;
  }
  sendHttp(resolved).then(function (result) {
    if (target) renderHttpResponse(target, result);
  }).catch(function (error) {
    if (target) {
      target.className = 'http-response error';
      target.innerHTML = '<div class="http-resp-head"><span class="http-status bad">Failed</span></div><pre class="http-resp-body">' + escapeHtml(String(error && error.message ? error.message : error)) + '</pre>';
    }
  });
}

function runHttpAtCaret() {
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  const requests = httpRequestsByPath.get(path);
  if (!requests || !requests.length) return;
  const caretLine = viewerCursor && viewerCursor.path === path ? viewerCursor.lineIndex : 0;
  let chosen = -1;
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const from = req.boundaryLine >= 0 ? req.boundaryLine : req.startLine;
    if (from <= caretLine && caretLine <= req.endLine) { chosen = i; break; }
    if (from <= caretLine) chosen = i;
  }
  if (chosen < 0) chosen = 0;
  runHttpRequest(chosen);
}

function renderHttpResponse(target, result) {
  if (!result || !result.ok) {
    target.className = 'http-response error';
    const message = result && result.error ? result.error : 'Request failed';
    target.innerHTML = '<div class="http-resp-head"><span class="http-status bad">Failed</span></div><pre class="http-resp-body">' + escapeHtml(message) + '</pre>';
    return;
  }
  target.className = 'http-response';
  const status = Number(result.status) || 0;
  const statusClass = status >= 200 && status < 300 ? 'ok' : (status >= 400 ? 'bad' : 'warn');
  const headers = result.headers || {};
  const headerKeys = Object.keys(headers).sort();
  const headerHtml = headerKeys.map(function (key) {
    return '<div class="http-h"><span class="http-h-k">' + escapeHtml(key) + '</span><span class="http-h-v">' + escapeHtml(String(headers[key])) + '</span></div>';
  }).join('');
  let contentType = '';
  for (let i = 0; i < headerKeys.length; i++) {
    if (headerKeys[i].toLowerCase() === 'content-type') { contentType = String(headers[headerKeys[i]]); break; }
  }
  const bodyText = result.body == null ? '' : String(result.body);
  const bodyHtml = formatHttpBody(bodyText, contentType);
  target.innerHTML =
    '<div class="http-resp-head">'
    + '<span class="http-status ' + statusClass + '">' + status + (result.statusText ? ' ' + escapeHtml(result.statusText) : '') + '</span>'
    + '<span class="http-resp-meta">' + (Number(result.durationMs) || 0) + ' ms</span>'
    + '<span class="http-resp-meta">' + formatBytes(bodyText.length) + '</span>'
    + (headerKeys.length ? '<button type="button" class="http-resp-toggle">Headers (' + headerKeys.length + ')</button>' : '')
    + '</div>'
    + '<div class="http-resp-headers hidden">' + headerHtml + '</div>'
    + '<pre class="http-resp-body">' + bodyHtml + '</pre>';
}

function formatHttpBody(text, contentType) {
  if (!text) return '<span class="http-resp-empty">(empty body)</span>';
  const looksJson = /json/i.test(contentType) || /^[\[{]/.test(text.trim());
  if (looksJson) {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      return pretty.split(/\r?\n/).map(function (line) { return highlightLine(line, 'json'); }).join('\n');
    } catch (error) {}
  }
  return escapeHtml(text);
}

function populateHttpEnvSelect() {
  const select = document.getElementById('http-env-select');
  if (!select) return;
  let opts = '<option value="">No environment</option>';
  httpEnvNames.forEach(function (name) {
    opts += '<option value="' + escapeHtml(name) + '"' + (name === currentHttpEnvName ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
  });
  select.innerHTML = opts;
  select.addEventListener('change', function () {
    currentHttpEnvName = select.value;
    try { localStorage.setItem(httpEnvKey, currentHttpEnvName); } catch (error) {}
    const path = document.getElementById('source-viewer')?.dataset.openPath || '';
    if (path && isHttpFile(path)) {
      const file = sourceByPath.get(path);
      const body = document.getElementById('source-body');
      if (file && body) body.innerHTML = renderHttpTable(file);
    }
  });
}

function renderSourceTable(file, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  const cursor = viewerCursor && viewerCursor.path === file.path ? viewerCursor : null;
  const changedSet = new Set(file.changedLines || []);
  const rows = lines.map((line, index) => {
    const hit = normalizedQuery.length > 0 && line.toLowerCase().includes(normalizedQuery);
    const isCursorLine = Boolean(cursor && cursor.lineIndex === index);
    const isSymbolTarget = Boolean(cursor && cursor.targetLine === index);
    const isChanged = changedSet.has(index + 1);
    const classes = [
      'source-row',
      hit ? 'search-hit' : '',
      isChanged ? 'changed-line' : '',
      isCursorLine ? 'cursor-line' : '',
      isSymbolTarget ? 'symbol-target' : '',
    ].filter(Boolean).join(' ');
    return [
      '<tr class="' + classes + '" data-line-index="' + index + '">',
      '<td class="num">' + String(index + 1) + '</td>',
      '<td class="source-code">' + (isCursorLine ? renderLineWithCursor(line, file.language || 'text', cursor.column) : highlightLine(line, file.language || 'text')) + '</td>',
      '</tr>',
    ].join('');
  }).join('');
  return '<table class="source-table"><tbody>' + rows + '</tbody></table>';
}

function renderLineWithCursor(text, language, column) {
  const boundedColumn = Math.max(0, Math.min(column, text.length));
  const before = text.slice(0, boundedColumn);
  const after = text.slice(boundedColumn);
  return highlightLine(before, language) + '<span class="code-cursor" aria-hidden="true"></span>' + highlightLine(after, language);
}

function highlightLine(text, language) {
  if (language === 'text') return escapeHtml(text);
  if (language === 'markup') {
    return escapeHtml(text).replace(/(&lt;\/?)([\w:-]+)([^&]*?)(\/?&gt;)/g, '$1<span class="tok-tag">$2</span>$3$4');
  }
  if (language === 'markdown') {
    const escaped = escapeHtml(text);
    if (/^\s{0,3}#{1,6}\s/.test(text)) return '<span class="tok-keyword">' + escaped + '</span>';
    return escaped.replace(new RegExp(String.fromCharCode(96) + '[^' + String.fromCharCode(96) + ']+' + String.fromCharCode(96), 'g'), '<span class="tok-string">$&</span>');
  }
  const keywords = new Set(['as','async','await','break','case','catch','class','const','continue','def','default','defer','do','else','enum','export','extends','final','finally','fn','for','from','func','function','go','if','impl','import','in','interface','let','match','module','new','package','private','protected','public','return','select','static','struct','switch','throw','try','type','val','var','while','yield']);
  const literals = new Set(['False','None','True','false','nil','null','self','this','true','undefined']);
  const commentPrefixes = ['python','ruby','shell','yaml','toml'].includes(language) ? ['#'] : ['//'];
  let output = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const commentPrefix = commentPrefixes.find((prefix) => rest.startsWith(prefix));
    if (commentPrefix) {
      output += '<span class="tok-comment">' + escapeHtml(rest) + '</span>';
      break;
    }
    const char = text[index];
    if (char === '"' || char === "'" || char === String.fromCharCode(96)) {
      const quote = char;
      let end = index + 1;
      let escaped = false;
      while (end < text.length) {
        const currentChar = text[end];
        if (currentChar === quote && !escaped) {
          end += 1;
          break;
        }
        escaped = currentChar === '\\' && !escaped;
        if (currentChar !== '\\') escaped = false;
        end += 1;
      }
      output += '<span class="tok-string">' + escapeHtml(text.slice(index, end)) + '</span>';
      index = end;
      continue;
    }
    const number = rest.match(/^\b\d+(?:\.\d+)?\b/);
    if (number) {
      output += '<span class="tok-number">' + escapeHtml(number[0]) + '</span>';
      index += number[0].length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_$][\w$-]*/);
    if (identifier) {
      const value = identifier[0];
      if (keywords.has(value)) output += '<span class="tok-keyword">' + escapeHtml(value) + '</span>';
      else if (literals.has(value)) output += '<span class="tok-literal">' + escapeHtml(value) + '</span>';
      else output += escapeHtml(value);
      index += value.length;
      continue;
    }
    output += escapeHtml(char);
    index += 1;
  }
  return output;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const kib = bytes / 1024;
  if (kib < 1024) return kib.toFixed(1) + ' KiB';
  return (kib / 1024).toFixed(1) + ' MiB';
}
