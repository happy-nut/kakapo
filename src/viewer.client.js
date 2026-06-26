
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
var lazyIO = null; // remembered so each setupLazyDiff (re-run on every watch refresh) disconnects the prior
                   // observer instead of leaving a new one bound to detached wrappers — otherwise observers
                   // (and the old DOM they retain) pile up over a long-running session and slowly choke it.
function setupLazyDiff() {
  var container = document.getElementById('diff2html-container');
  if (!container) return;
  if (lazyIO) { try { lazyIO.disconnect(); } catch (e) {} lazyIO = null; }
  var wrappers = Array.prototype.slice.call(container.querySelectorAll('.d2h-file-wrapper'));
  if (typeof IntersectionObserver !== 'undefined') {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { ensureFileReady(e.target); io.unobserve(e.target); } });
    }, { root: null, rootMargin: '600px 0px' });
    lazyIO = io; // track this observer so the NEXT setupLazyDiff can disconnect it (callback keeps using local io)
    wrappers.forEach(function (w) { io.observe(w); });
  } else {
    wrappers.forEach(function (w) { ensureFileReady(w); }); // no IntersectionObserver -> materialize all
  }
  if (wrappers[0]) ensureFileReady(wrappers[0]); // first file ready so the initial caret has a row to land on
}
if (REVIEW_LAZY) { setupLazyDiff(); setTimeout(function () { diffBootDone = true; }, 0); }
let links = Array.from(document.querySelectorAll('#changes-panel .file-link')); // re-captured on in-place diff update
let sourceLinks = Array.from(document.querySelectorAll('.source-link')); // re-captured when a deferred tree materializes
let sourceFiles = JSON.parse(document.getElementById('source-files-data')?.textContent || '[]');
// i18n: the message catalog (en + ko) is emitted server-side; the locale lives in localStorage and the
// whole UI switches live (no reload). t() feeds dynamically-built text; applyI18n() rewrites the static
// chrome (data-i18n / -ph / -title / -aria). English is the first-paint default.
var I18N = JSON.parse(document.getElementById('i18n-data')?.textContent || '{}');
// Cross-reopen persistence. Electron persists via the main process (window.monacoriSettings — survives
// app restart; file:// localStorage doesn't); browser/serve falls back to localStorage. persistRead
// returns the bridge value (native) if present, else undefined so callers parse localStorage themselves.
function persistRead(key) {
  // window.monacoriSettings.all crosses Electron's contextBridge, which DEEP-FREEZES every value it
  // exposes. Returning that frozen object/array directly breaks callers that mutate the result —
  // reviewComments.push(...) and mergePrompts[kind]=... both throw "object is not extensible". Hand
  // back a mutable deep copy so the persisted snapshot is a starting point, not a locked one.
  try {
    if (window.monacoriSettings && window.monacoriSettings.all && key in window.monacoriSettings.all) {
      var v = window.monacoriSettings.all[key];
      return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    }
  } catch (e) {}
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
var langSelectRef = null, themeSelectRef = null;
// Replace a native <select> with a button that opens our custom dropdown (consistent with the comment
// dropdown + themable; native <select> popups ignore the app theme). getOptions() -> [{value,label}];
// returns { render } so localized labels can be refreshed on a language switch.
function setupCustomSelect(id, getOptions, getCurrent, onPick) {
  var el = document.getElementById(id);
  if (!el) return null;
  function render() {
    var cur = getCurrent();
    var match = getOptions().filter(function (o) { return o.value === cur; })[0];
    el.textContent = match ? match.label : cur;
  }
  el.addEventListener('click', function (e) {
    e.preventDefault();
    var r = el.getBoundingClientRect(), cur = getCurrent();
    showCustomDropdown(r.left, r.bottom + 4, getOptions().map(function (o) {
      return { label: (o.value === cur ? '✓  ' : '  ') + o.label, onSelect: function () { onPick(o.value); render(); } };
    }), r.top - 4);
  });
  render();
  return { render: render };
}
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
  document.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
  document.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
  document.documentElement.lang = locale;
  if (langSelectRef) langSelectRef.render();
  if (themeSelectRef) themeSelectRef.render(); // theme labels are localized — refresh on a language switch too
}
// Theme mirrors the locale pattern: persisted choice, applied by toggling data-theme on <html> so the
// :root[data-theme="light"] palette takes over. Dark is the default (matches the inline :root). Applied
// immediately at script start to minimize a first-paint flash from the dark default to light.
var THEME_KEY = 'monacori-theme';
var theme = (function () {
  var v = persistRead(THEME_KEY);
  if (v !== 'light' && v !== 'dark') { try { v = localStorage.getItem(THEME_KEY); } catch (e) {} }
  return (v === 'light' || v === 'dark') ? v : 'dark';
})();
function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme);
  if (themeSelectRef) themeSelectRef.render();
}
applyTheme();
let fileStates = JSON.parse(document.getElementById('file-state-data')?.textContent || '[]');
let httpEnvironments = JSON.parse(document.getElementById('http-env-data')?.textContent || '{}');
let httpEnvNames = Object.keys(httpEnvironments);
const httpEnvKey = 'monacori-http-env:' + location.pathname;
const httpRequestsByPath = new Map();
const httpVarsByPath = new Map();
let sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
// Phase 2b lazy-LOAD: source content is fetched once after first paint (serve /source-data or the
// Electron bridge) and merged into the metadata-only source records; until then sourceLoaded is false
// and the source view shows a brief loading state. Non-lazy-load modes embed source -> already loaded.
var sourceLoaded = !REVIEW_LAZY_LOAD;
var pendingSourceOpen = null;
// The path whose content is ACTUALLY painted in #source-body right now. dataset.openPath is the INTENDED
// path and gets set BEFORE the body paints in the lazy-LOAD branch, so the caret fast-path must check this
// instead — else it patches the caret onto a stale body, leaving one file's content under another's path.
var sourceBodyPath = null;
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
    scheduleSymbolIndex();
    remapComments(); // content just arrived — reconcile comment anchors against it
    if (pendingSourceOpen) { var po = pendingSourceOpen; pendingSourceOpen = null; openSourceFile(po.path, po.shouldSwitch); }
    else if (isSourceViewerVisible() && document.getElementById('source-viewer').dataset.openPath) { openSourceFile(document.getElementById('source-viewer').dataset.openPath, false); }
    if (pendingSymbol) { var s = pendingSymbol; pendingSymbol = null; goToDefOrUsages(s); }
  }, function () { sourceLoaded = true; sourceLoading = false; });
}
let fileSignatureByPath = new Map(fileStates.map((file) => [file.path, file.signature]));
const reviewMeta = document.getElementById('review-meta');
const watchEnabled = reviewMeta?.dataset.watch === 'true';
let currentSignature = reviewMeta?.dataset.signature || '';
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
  return Boolean(viewed[path]); // boolean now; legacy signature strings are also truthy, so old marks still read as viewed
}

function setFileViewed(path, viewed) {
  const state = loadViewedState();
  // Persist a plain boolean (not the file signature) so a viewed mark survives a restart/refresh the way
  // comments do. Tying it to the signature meant any re-generation that changed the signature silently
  // cleared every viewed mark — exactly the "viewed didn't persist" the user hit.
  if (viewed) state[path] = true;
  else delete state[path];
  saveViewedState(state);
  applyViewedState();
}

// Viewed marks persist by path (a plain boolean), like comments — we deliberately DON'T prune on signature
// change or restart. Tying persistence to the file signature is what made viewed marks vanish on every
// re-generation; the user wants them to survive restarts the way comments do.
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

// Coalesced scrollIntoView for caret/focus moves. Holding an arrow key fires key-repeat faster than a
// reflow-forcing scrollIntoView can run, so collapse them to one (latest element) per animation frame and
// use block:nearest (no per-row center-jump). Shared by the tree, source caret, and diff caret.
var pendingScrollEl = null, scrollElRaf = 0;
// Reveal `el` by keeping it ~fraction of the way down its scroller, scrolling minimally on EVERY move so the
// view follows the caret CONTINUOUSLY. scrollIntoView('nearest') instead leaves the view still until the
// caret reaches the edge and then jumps — stuttering ~every viewport while an arrow key is held.
function revealAt(el, scroller, fraction) {
  if (!el) return;
  if (!scroller || !scroller.clientHeight) { try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (x) {} return; }
  var off = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop += off - scroller.clientHeight * fraction;
}
// Scrolloff variant: scroll ONLY when `el` would otherwise leave the viewport, keeping it within `marginFrac`
// of the top/bottom edge. While the row moves comfortably inside that band the view stays put — continuous
// centering scrolled the file even when everything was visible (dizzying). Used by the diff caret and the sidebar tree.
function scrolloffReveal(el, scroller, marginFrac) {
  if (!el || !scroller || !scroller.clientHeight) return;
  var top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  var rowH = el.offsetHeight || 18;
  var ch = scroller.clientHeight;
  var margin = Math.round(ch * marginFrac);
  if (top < margin) scroller.scrollTop += top - margin;
  else if (top + rowH > ch - margin) scroller.scrollTop += (top + rowH) - (ch - margin);
}
function scheduleScrollIntoView(el) {
  pendingScrollEl = el || null;
  if (scrollElRaf) return;
  scrollElRaf = requestAnimationFrame(function () {
    scrollElRaf = 0;
    var e = pendingScrollEl; pendingScrollEl = null;
    if (e && e.scrollIntoView) { try { e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (x) {} }
  });
}

var setActiveRaf = 0, setActiveScrollPending = true;
function setActive(index, shouldScroll = true) {
  if (hunkTotal() === 0) return;
  current = ((index % hunkTotal()) + hunkTotal()) % hunkTotal();
  // Coalesce rapid presses (holding/spamming F7 or Shift+F7) into one DOM apply per animation frame. The
  // key handler returns immediately and `current` updates synchronously (so next()/nav math stays correct),
  // while the heavy DOM work (full link/wrapper sweeps, body materialize) runs at most once per frame
  // instead of once per keystroke — the input queue never blocks and can't pile up on big repos.
  setActiveScrollPending = shouldScroll;
  if (setActiveRaf) return;
  setActiveRaf = requestAnimationFrame(function () {
    setActiveRaf = 0;
    applySetActive(current, setActiveScrollPending);
  });
}
function applySetActive(idx, shouldScroll) {
  document.getElementById('source-viewer')?.classList.add('hidden');
  document.getElementById('diff-view')?.classList.remove('hidden');
  setTab('changes');
  const file = hunkPathAt(idx);
  links.forEach((link) => link.classList.toggle('active', link.dataset.file === file));
  renderBreadcrumb(document.getElementById('diff-breadcrumb'), file);
  var dvt = document.getElementById('diff-viewed-toggle');
  if (dvt) dvt.dataset.file = file || '';
  updateDiffViewedToggle();
  if (file) rememberRecent(file, 'change');
  history.replaceState(null, '', '#hunk-' + idx);
  // Row-dependent work waits for the file body (sync for eager/Phase 1, async for cold lazy-LOAD).
  whenFileReady(diffWrapperByPath(file), function () {
    showOnlyFile(file, true); // materialize + isolate the file, but leave the caret to focusDiffRow (skip ensureDiffCursor)
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
    // Scroll inline in THIS frame, NOT via scheduleDiffScroll's extra rAF. showOnlyFile just display:none'd
    // the previous file, but the scroll container keeps its old (larger) scrollTop — so for one frame the new
    // file renders at that stale offset (≈ line 146) before a deferred scroll snaps to the change (≈ line 21):
    // the visible 146→21 double jump on F7 across a file boundary. Scrolling synchronously here lands the
    // view on the change before this frame paints, so the new file appears already at its first change.
    if (shouldScroll && targetRow && targetRow.scrollIntoView) targetRow.scrollIntoView({ block: 'center' });
  });
}

function showOnlyFile(fileName, skipCursor) {
  if (REVIEW_LAZY) ensureFileReady(diffWrapperByPath(fileName));
  document.querySelectorAll('.d2h-file-wrapper').forEach((wrapper) => {
    wrapper.classList.toggle('df-inactive', diffWrapperPathKey(wrapper) !== fileName);
  });
  // applySetActive passes skipCursor: it sets the caret itself via focusDiffRow(targetRow). Letting
  // ensureDiffCursor run here would first place the caret on the file's FIRST code row, then focusDiffRow
  // overrides it to the change — a visible double jump (the F7 "first line → change" flash).
  if (!skipCursor) ensureDiffCursor();
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

// Forward F7 at a file's last change announces "last change — press F7 again" once before crossing to the
// next file, giving a beat to mark-viewed. Holds the path we've already announced; any caret move clears it
// (see setDiffCursor), so leaving and returning to the last change re-arms the announcement.
var pendingFileBoundary = null;
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
  // File boundary: no more change blocks in this file. Forward F7 announces "last change — press F7 again
  // to go to the next file" on the FIRST press (a beat to mark-viewed) and only crosses on the SECOND
  // consecutive press. Already-viewed files (and backward nav) cross immediately — no announcement.
  if (delta > 0 && diffCursor && isDiffViewVisible() && !isFileViewed(diffCursor.path)) {
    if (pendingFileBoundary !== diffCursor.path) {
      pendingFileBoundary = diffCursor.path;
      showToast(t('diff.lastHunk'));
      return;
    }
    pendingFileBoundary = null; // second consecutive press on the same file → fall through and cross
  }
  // hunk-level nav to the next/prev unviewed file.
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

// Jump to the first change of the next unviewed file after `path` (wrapping). Used right after marking a
// file viewed: its diff body is now hidden, so staying would blank the content — we advance to the next
// change instead. Returns false when every changed file is viewed (nothing to advance to).
function gotoNextUnviewedFile(path) {
  const total = hunkTotal();
  if (total === 0) return false;
  const start = firstHunkForPath(path);
  let idx = (start >= 0 ? start : (current >= 0 ? current : 0)) + 1;
  for (let step = 0; step < total; step++) {
    const norm = ((idx % total) + total) % total;
    if (!isFileViewed(hunkPathAt(norm) || '')) { setActive(norm); return true; }
    idx += 1;
  }
  return false;
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
  // isTreeRowVisible walks ancestor <details> (cheap, layout-free) and already excludes rows inside
  // collapsed folders. The previous extra `getClientRects().length > 0` check forced a SYNCHRONOUS
  // reflow per node — 6k forced layouts on every arrow key in a large source tree, which froze input.
  // The details walk makes the rects check redundant, so drop it.
  return Array.from(panel.querySelectorAll('summary, .file-link')).filter(isTreeRowVisible);
}

function focusTree(index) {
  const rows = treeRows();
  if (rows.length === 0) return;
  treeFocusIndex = Math.max(0, Math.min(rows.length - 1, index));
  // Render the focus class AND scroll in the SAME frame. A fast key-repeat queues many ArrowDowns before a
  // frame; moving the focus class instantly while the coalesced scroll lags makes the panel jump. Coalescing
  // both keeps focus + scroll in lockstep, and scrolloffReveal scrolls ONLY when the focused row nears the
  // top/bottom edge — a row moving inside the visible band must never drag the whole panel (revealAt did,
  // re-centering on every move so even a mid-list row scrolled the sidebar).
  scheduleTreeFocus();
}
var treeFocusRaf = 0;
function scheduleTreeFocus() {
  if (treeFocusRaf) return;
  treeFocusRaf = requestAnimationFrame(function () {
    treeFocusRaf = 0;
    const rows = treeRows();
    if (treeFocusIndex < 0 || treeFocusIndex >= rows.length) return;
    const el = rows[treeFocusIndex];
    document.querySelectorAll('.tree-focus').forEach((e) => { if (e !== el) e.classList.remove('tree-focus'); });
    if (el) { el.classList.add('tree-focus'); scrolloffReveal(el, document.querySelector('.sidebar-scroll'), 0.15); }
  });
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

// d2h-file-side-diff is a HORIZONTAL scrollport (overflow-x:auto), so the browser swallows VERTICAL wheel
// there instead of bubbling it to #diff2html-container — the diff wouldn't scroll by mouse wheel at all.
// Redirect vertical wheel to the container; leave horizontal wheel (deltaX) for the side's own h-scroll.
(function () {
  var dsc = document.getElementById('diff2html-container');
  if (dsc) dsc.addEventListener('wheel', function (e) {
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX) && e.deltaY !== 0) { dsc.scrollTop += e.deltaY; e.preventDefault(); }
  }, { passive: false });
})();
// A floating, focus-grabbing overlay (merged-comments, prompt memo, settings) is open. While one is up it
// owns focus AND the only caret, so global shortcuts stand down until Esc/close — we must not navigate a
// panel the user can't even see behind the overlay (nor leave a second blinking caret in it).
function isFloatingModalOpen() {
  var sm = document.getElementById('settings-modal');
  if (sm && !sm.classList.contains('hidden')) return true;
  // The merged/memo panels are now docked (inline), not overlays — but while one OWNS focus we still stand
  // down the global nav shortcuts so typing / ▲▼ inside it isn't hijacked. Focus elsewhere -> shortcuts run.
  return isDockFocused();
}
document.addEventListener('keydown', (event) => {
  if (!quickOpen?.classList.contains('hidden')) {
    if (handleQuickOpenKey(event)) return;
  }
  var usagesBox = document.getElementById('usages');
  if (usagesBox && !usagesBox.classList.contains('hidden')) {
    if (handleUsagesKey(event)) return;
  }

  // Dock controls fire regardless of focus (terminal / merged / memo) — they sit ABOVE the focus guard so
  // they still work from inside a dock panel. Cmd/Ctrl+Shift+' maximizes the active dock; Cmd/Ctrl+Shift+/
  // and +. open the merged views; Cmd/Ctrl+Shift+N toggles the memo. (Match event.code so IME/layout never
  // swallows the combo.) Settings is a true overlay, so these stand down while it is up.
  var settingsUp = (function () { var s = document.getElementById('settings-modal'); return !!(s && !s.classList.contains('hidden')); })();
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'Quote') {
    event.preventDefault();
    toggleDockMaximized();
    return;
  }
  if (!settingsUp && (event.metaKey || event.ctrlKey) && (event.code === 'Slash' || event.code === 'Period' || event.key === '?' || event.key === '>')) {
    event.preventDefault();
    openMergedView((event.code === 'Slash' || event.key === '?') ? 'q' : 'c');
    return;
  }
  if (!settingsUp && (event.metaKey || event.ctrlKey) && event.shiftKey && (event.code === 'KeyN' || event.key === 'n' || event.key === 'N')) {
    event.preventDefault();
    openMemoView();
    return;
  }

  // Settings overlay (or a focused merged/memo dock) captures keys: stand down the rest of the global
  // shortcuts (Cmd+1, F7, Cmd+[/], Cmd+B, …). Each has its own Esc + editing handlers.
  if (isFloatingModalOpen()) return;

  if ((event.metaKey || event.ctrlKey) && event.key === '1') {
    event.preventDefault();
    // Coming from the diff: open the file you were viewing as source so Cmd+1 lands ON it (not a stale/blank
    // source pane), and the tree below points at the same file. Capture the path BEFORE openSourceFile flips
    // the view (isDiffViewVisible would then be false).
    if (isDiffViewVisible()) {
      var dw1 = diffActiveWrapper();
      var dn1 = dw1 && dw1.querySelector('.d2h-file-name');
      var dpath1 = (diffCursor && diffCursor.path) || (dn1 ? (dn1.textContent || '').trim() : '');
      if (dpath1 && sourceByPath.has(dpath1)) openSourceFile(dpath1);
    }
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
        const willView = !isFileViewed(vp);
        setFileViewed(vp, willView);
        // Marking viewed hides this file's diff body — don't strand the caret on the now-blank file.
        // Auto-advance to the next unviewed change (the user's flow: mark viewed -> jump to next).
        // Unmarking stays put. If every file is viewed, gotoNextUnviewedFile is a no-op.
        if (willView) gotoNextUnviewedFile(vp);
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

  // PageUp/Down scroll the diff/source view. There's no focusable scroller (the diff caret is a JS cursor),
  // and d2h-file-side-diff's horizontal scrollport even swallows vertical wheel, so handle paging explicitly.
  // Only when the tree isn't focused — the tree pages itself in handleTreeKey below.
  if (treeFocusIndex < 0 && (event.key === 'PageDown' || event.key === 'PageUp') && !event.metaKey && !event.ctrlKey && !event.altKey) {
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

// Delegated (like #files-panel below) so it survives the in-place diff update that re-captures `links`
// on every watch tick — per-element listeners would be lost on the new nodes, and then Cmd+0 → arrow →
// Enter (which calls row.click()) would silently do nothing.
document.getElementById('changes-panel')?.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('.file-link') : null;
  if (!link) return;
  showDiffView(false);
  const target = Number(link.dataset.hunk);
  if (!Number.isNaN(target) && target >= 0 && target < hunkTotal()) {
    event.preventDefault();
    setActive(target);
  }
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
if (!REVIEW_LAZY_LOAD) scheduleSymbolIndex(); // non-lazy indexes when idle; lazy-LOAD defers the (large) source blob + index to the first source-view open / go-to-def
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
// Electron receives live updates over IPC (monacoriMenu.onDiffUpdate); only serve/browser needs the HTTP
// poller. Under file:// its fetch just fails every 1.5s for the app's whole life, so skip it in Electron.
if (watchEnabled && !(window.monacoriMenu && typeof window.monacoriMenu.onDiffUpdate === 'function')) {
  setInterval(checkForLiveUpdate, 1500);
}
window.addEventListener('beforeunload', saveUiState);

// First render has painted — drop the boot overlay (it bridged the blank gap right after loadFile). Two
// rAFs so the spinner stays until the diff/tree are actually on screen, then a short fade-out.
(function () {
  var ov = document.getElementById('boot-overlay');
  if (!ov) return;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      ov.classList.add('hide');
      setTimeout(function () { ov.remove(); }, 240);
    });
  });
})();

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
  // Empty line (ctn is just a <br>): an inline caret span would wrap onto a 2nd visual line and break the
  // row height, so position the caret absolutely — it shows without affecting the layout.
  if ((ctn.textContent || '').length === 0) {
    var espan = document.createElement('span');
    espan.className = 'code-cursor';
    espan.setAttribute('aria-hidden', 'true');
    espan.style.position = 'absolute';
    ctn.appendChild(espan);
    diffCaretSpan = espan;
    return;
  }
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
  pendingFileBoundary = null; // any caret move re-arms the last-change announcement for the next F7 (see next)
  diffSelectionAnchor = null; // any direct caret placement (click/F7/Cmd-arrow) drops the selection; Shift+Arrow re-sets it
  if (reveal) {
    // Render the caret AND scroll in the SAME animation frame. A fast key-repeat queues several ArrowDowns
    // before one frame; rendering the caret immediately (while the coalesced scroll lags) would push it many
    // rows past the viewport, then the view would snap ~one viewport at a time. Coalescing both keeps the
    // caret and scroll in lockstep, so holding ArrowDown scrolls smoothly instead of jumping every ~15 lines.
    scheduleDiffReveal(wrapper, side, ri);
  } else {
    renderDiffCaret();
    applyDiffSelection();
  }
  recordNav(navEntryOf('diff'));
}
var diffRevealRaf = 0, diffRevealTarget = null;
function scheduleDiffReveal(wrapper, side, ri) {
  diffRevealTarget = { wrapper: wrapper, side: side, ri: ri };
  if (diffRevealRaf) return;
  diffRevealRaf = requestAnimationFrame(function () {
    diffRevealRaf = 0;
    var t = diffRevealTarget; diffRevealTarget = null;
    renderDiffCaret();
    applyDiffSelection();
    if (!t) return;
    var row = diffRowAt(t.wrapper, t.side, t.ri);
    scrolloffReveal(row, document.getElementById('diff2html-container'), 0.15);
  });
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
// Comment boxes are injected on the right(new) side, right after the line's row (see injectThreadRow /
// renderDiffComments). Split-view rows align 1:1 by index, so the caret's row index on the new side finds
// the adjacent box regardless of which side the caret sits on. Mirrors commentRowSiblingOf for the source view.
function diffCommentBoxSiblingOf(dir) {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return null;
  var rows = diffRowsOf(diffSideTable(wrapper, 'new'));
  var row = rows[diffCursor.rowIndex];
  if (!row) return null;
  var sib = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
  return (sib && sib.classList && sib.classList.contains('mc-comment-row')) ? sib : null;
}
function handleDiffCaretKey(event) {
  if (!isDiffViewVisible() || !diffCursor) return false;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return false;
  var extend = event.shiftKey;
  // A comment box is selected: Backspace/Delete removes it, `e` edits it, an arrow/Escape steps off it.
  // Same contract as the source view (handleSourceCaretKey), but caret moves go through setDiffCursor.
  if (selectedCommentRow) {
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); deleteCommentsInRow(selectedCommentRow); return true; }
    if (event.key === 'e' || event.key === 'E') { event.preventDefault(); editCommentInRow(selectedCommentRow); return true; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Escape') {
      var dir = event.key === 'ArrowUp' ? -1 : (event.key === 'ArrowDown' ? 1 : 0);
      var sib = dir < 0 ? selectedCommentRow.previousElementSibling : (dir > 0 ? selectedCommentRow.nextElementSibling : null);
      selectedCommentRow.classList.remove('mc-row-selected');
      selectedCommentRow = null;
      event.preventDefault();
      var wrapper = diffWrapperByPath(diffCursor.path);
      if (sib && wrapper && isDiffCodeRow(sib)) {
        var rows = diffRowsOf(diffSideTable(wrapper, 'new'));
        var idx = rows.indexOf(sib);
        if (idx >= 0) { setDiffCursor(diffCursor.path, 'new', idx, 0, true); return true; }
      }
      setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, diffCursor.column, false); // restore caret where it was
      return true;
    }
    return false;
  }
  // Plain Up/Down: a comment box attached to the caret line is a selectable stop (caret stays visible).
  if (!extend && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    var box = diffCommentBoxSiblingOf(event.key === 'ArrowUp' ? -1 : 1);
    if (box) { event.preventDefault(); selectCommentRow(box); return true; }
  }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveDiffCursor(1, 0, extend); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveDiffCursor(-1, 0, extend); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveDiffCursor(0, -1, extend); return true; }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveDiffCursor(0, 1, extend); return true; }
  return false;
}

// ===== Review comments: questions ("?") and change-requests (">") =====
// (COMMENTS_KEY / reviewComments / commentSeq / composerState are declared near the top of the script)
// Bottom-left, non-blocking toast stack; each toast auto-dismisses. Used to tell the user when a file
// change made some comments untrackable (they were removed).
function showToast(message) {
  var stack = document.getElementById('mc-toasts');
  if (!stack) { stack = document.createElement('div'); stack.id = 'mc-toasts'; document.body.appendChild(stack); }
  var el = document.createElement('div');
  el.className = 'mc-toast';
  el.textContent = message;
  stack.appendChild(el);
  requestAnimationFrame(function () { el.classList.add('show'); });
  setTimeout(function () {
    el.classList.add('hide');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }, 4500);
}
// Follow each comment to its snapshot line (c.code) in the current content: same line if unchanged, else the
// nearest exact match of that line. A comment is NEVER auto-deleted. If its line can't be found we leave it
// where it is — this happens routinely WITHOUT the file changing: a comment anchored to a deleted/old-side
// diff line (comments carry no side, so old-side text never matches the new content) would otherwise vanish.
// Silently dropping user-authored comments loses data; the reviewer can remove a stale one with the × button.
// Files whose content isn't loaded yet (lazy) are skipped here and reconciled once loadSourceData arrives.
function remapComments() {
  if (!reviewComments.length) return;
  var moved = 0;
  reviewComments.forEach(function (c) {
    var file = sourceByPath.get(c.path);
    if (!file || !file.embedded || typeof file.content !== 'string' || !file.content) return;
    var code = c.code == null ? '' : String(c.code);
    if (!code.trim()) return;
    var lines = file.content.split(/\r?\n/);
    if (lines[c.line - 1] === code) return;
    var best = -1, bestDist = Infinity;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] === code) { var d = Math.abs(i - (c.line - 1)); if (d < bestDist) { bestDist = d; best = i; } }
    }
    if (best >= 0 && c.line !== best + 1) { c.line = best + 1; moved++; } // moved to follow the line; not found -> keep as-is
  });
  if (!moved) return; // nothing moved — skip the save/re-render
  saveComments();
  refreshComments();
}
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
// Edit an existing comment in place (e on a selected box -> composer prefilled -> save). Empty text deletes it.
function updateComment(seq, text) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  var trimmed = String(text || '').trim();
  if (trimmed) { c.text = trimmed; saveComments(); }
  else { deleteComment(seq); }
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
    var scaretFile = sourceByPath.get(viewerCursor.path);
    var scaretCode = (scaretFile && typeof scaretFile.content === 'string') ? (scaretFile.content.split(/\r?\n/)[viewerCursor.lineIndex] || '') : '';
    return { path: viewerCursor.path, line: viewerCursor.lineIndex + 1, code: scaretCode, from: null, to: null, side: null };
  }
  // Diff view: prefer the explicit diff caret when there is no text selection.
  if (!hasSel && diffCursor && isDiffViewVisible()) {
    var dwrap = diffWrapperByPath(diffCursor.path);
    var drow = dwrap ? diffRowAt(dwrap, diffCursor.side, diffCursor.rowIndex) : null;
    var dline = drow ? diffLineNumber(drow) : null;
    if (dline != null) return { path: diffCursor.path, line: dline, code: diffLineText(drow) || '', from: null, to: null, side: null };
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

// "live_trading_engine.py:424" (or ":420–424" for a multi-line drag) — shown in the composer head so the
// reviewer always sees WHICH file + line(s) a comment targets instead of a bare, context-free box.
function composerTargetLabel(s) {
  var base = (s.path || '').split('/').pop() || s.path || '';
  var loc = (s.from != null && s.to != null && s.from !== s.to) ? (s.from + '–' + s.to) : String(s.line);
  return base + ':' + loc;
}
function threadHtml(path, line) {
  var html = '';
  commentsAt(path, line).forEach(function (c) {
    if (composerState && composerState.editSeq === c.seq) return; // being edited -> rendered as the composer below
    html += '<div class="mc-card mc-' + c.kind + '">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindLabel(c.kind) + '</span>'
      + '<button type="button" class="mc-del" data-seq="' + c.seq + '" title="' + escapeHtml(t('composer.delete')) + '">×</button></div>'
      + '<div class="mc-card-body">' + escapeHtml(c.text) + '</div></div>';
  });
  if (composerState && composerState.path === path && composerState.line === line) {
    var ph = composerState.kind === 'q' ? t('composer.question') : t('composer.changeRequest');
    html += '<div class="mc-card mc-' + composerState.kind + ' mc-composer">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindLabel(composerState.kind) + '</span><span class="mc-target" title="' + escapeHtml(composerState.path || '') + '">' + escapeHtml(composerTargetLabel(composerState)) + '</span></div>'
      + '<textarea class="mc-input" rows="3" placeholder="' + escapeHtml(ph) + '">' + escapeHtml(composerState.editText || '') + '</textarea>'
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
  // Keep body.mc-composing (which hides the file caret) tied to the ACTUAL on-screen composer, not just
  // composerState. Leaving the composer by any path other than save/cancel (opening another file, switching
  // views) would otherwise leave the class stuck and hide EVERY caret — making arrow navigation and
  // comment-box selection look dead. This single sync point covers all refreshComments callers.
  var visibleComposer = false;
  var composerInputs = document.querySelectorAll('.mc-composer .mc-input');
  for (var ci = 0; ci < composerInputs.length; ci++) {
    if (composerInputs[ci].closest('#diff-view') && !isDiffViewVisible()) continue;
    if (composerInputs[ci].closest('#source-viewer') && !isSourceViewerVisible()) continue;
    visibleComposer = true; break;
  }
  document.body.classList.toggle('mc-composing', visibleComposer);
  if (composerState) {
    var composerFocusTries = 0;
    var tryFocusComposer = function () {
      var ta = activeComposerInput();
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
  refreshComments(); // refreshComments syncs body.mc-composing from the on-screen composer

}
function closeComposer() {
  if (!composerState) return;
  composerState = null;
  refreshComments();
  flushPendingDiffUpdate(); // apply any live watch refresh that was held while composing
}
// The composer is injected into BOTH the diff and source views (refreshComments renders comments in
// each), but only one view is on screen at a time — the other lives inside a `.hidden` container with
// its own, empty textarea. Pick the textarea in the *visible* view so save/auto-focus never grab the
// off-screen duplicate. This was the "Comment doesn't save" bug: clicking Save ran
// document.querySelector('.mc-composer .mc-input'), which returns the hidden diff-view textarea first
// (it precedes #source-viewer in the DOM), so addComment got its empty value and bailed.
function activeComposerInput() {
  var inputs = document.querySelectorAll('.mc-composer .mc-input');
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].closest('#diff-view') && !isDiffViewVisible()) continue;
    if (inputs[i].closest('#source-viewer') && !isSourceViewerVisible()) continue;
    return inputs[i];
  }
  return inputs[0] || null;
}
function saveComposer(ta) {
  if (!composerState) return;
  var box = ta || activeComposerInput();
  if (!box) return;
  if (composerState.editSeq != null) updateComment(composerState.editSeq, box.value);
  else addComment(composerState.kind, composerState.path, composerState.line, composerState.code, box.value);
  composerState = null;
  refreshComments();
  flushPendingDiffUpdate(); // apply any live watch refresh that was held while composing
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

// Reusable custom dropdown (keyboard + mouse). options: [{ label, onSelect }]. First item is pre-selected;
// Arrow keys move, Enter chooses, Esc / click-outside dismiss. Replaces native <select>/menus everywhere.
// Approximate the caret's pixel position in the (monospace) merged textarea so the dropdown can open right
// under it — and flip above when there isn't room below. Returns { x, top (caret line top), below }.
function mergedCaretXY(area) {
  var pos = area.selectionStart || 0;
  var nl = area.value.slice(0, pos).split('\n');
  var lineNum = nl.length - 1;
  var col = nl[lineNum].length;
  var cs = getComputedStyle(area);
  var lineH = parseFloat(cs.lineHeight) || 18;
  var rect = area.getBoundingClientRect();
  var span = document.createElement('span');
  span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  span.style.font = cs.font;
  span.textContent = 'MMMMMMMMMMMMMMMMMMMM';
  document.body.appendChild(span);
  var charW = span.getBoundingClientRect().width / 20;
  span.remove();
  var caretTop = rect.top + (parseFloat(cs.paddingTop) || 0) + lineNum * lineH - area.scrollTop;
  var x = Math.min(rect.left + (parseFloat(cs.paddingLeft) || 0) + col * charW, rect.right - 24);
  return { x: x, top: caretTop, below: caretTop + lineH + 2 };
}
function showCustomDropdown(x, y, options, flipTop) {
  var existing = document.getElementById('mc-dropdown');
  if (existing) existing.remove();
  var dd = document.createElement('div');
  dd.id = 'mc-dropdown';
  dd.className = 'mc-dropdown';
  var active = 0;
  function setActive(i) { active = i; for (var j = 0; j < dd.children.length; j++) dd.children[j].classList.toggle('active', j === i); }
  function close() { dd.remove(); document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onOutside, true); }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive(Math.min(active + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive(Math.max(active - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); var o = options[active]; close(); if (o) o.onSelect(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  function onOutside(e) { if (!dd.contains(e.target)) close(); }
  options.forEach(function (opt, i) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'mc-dropdown-item' + (i === 0 ? ' active' : '');
    item.textContent = opt.label;
    item.addEventListener('click', function () { close(); opt.onSelect(); });
    item.addEventListener('mousemove', function () { setActive(i); });
    dd.appendChild(item);
  });
  document.body.appendChild(dd);
  // Position after measuring: open at (x, y); flip above (flipTop) when it would overflow the bottom,
  // and nudge in from the right/bottom edges so it never clips offscreen.
  var ddr = dd.getBoundingClientRect();
  var top = y, left = x;
  if (typeof flipTop === 'number' && top + ddr.height > window.innerHeight - 8) top = Math.max(8, flipTop - ddr.height);
  else if (top + ddr.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ddr.height - 8);
  if (left + ddr.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - ddr.width - 8);
  dd.style.left = Math.round(left) + 'px';
  dd.style.top = Math.round(top) + 'px';
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onOutside, true);
}
// Map a char range in the merged textarea back to the comment seq(s) it covers. Each comment is a
// "### path:line" block; the caret's block (or every block a selection spans) identifies the comment(s).
function mergedCommentSeqs(kind, start, end) {
  var items = reviewComments.filter(function (c) { return c.kind === kind; });
  var text = buildMergedText(kind);
  var lines = text.split(String.fromCharCode(10));
  var seqs = [], pos = 0, idx = -1;
  for (var i = 0; i < lines.length; i++) {
    var lineStart = pos, lineEnd = pos + lines[i].length;
    if (lines[i].indexOf('### ') === 0) idx++;
    if (idx >= 0 && idx < items.length && lineEnd >= start && lineStart <= end) {
      var s = items[idx].seq;
      if (seqs.indexOf(s) < 0) seqs.push(s);
    }
    pos = lineEnd + 1;
  }
  return seqs;
}
function navigateToComment(seq) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  openSourceFile(c.path);
  requestAnimationFrame(function () { setSourceCursor(c.path, Math.max(0, (c.line || 1) - 1), 0, true, -1); });
}
// Move the merged-view caret to the next (dir=1) / previous (dir=-1) "### path:line" header and center it,
// so Opt+Arrow steps comment-by-comment in the merged view.
function jumpMergedComment(area, dir) {
  var text = area.value;
  var headers = [], pos = 0;
  text.split('\n').forEach(function (ln) { if (ln.indexOf('### ') === 0) headers.push(pos); pos += ln.length + 1; });
  if (!headers.length) return;
  var cur = area.selectionStart;
  var target;
  if (dir > 0) { target = headers.find(function (h) { return h > cur; }); if (target == null) target = headers[headers.length - 1]; }
  else { var before = headers.filter(function (h) { return h < cur; }); target = before.length ? before[before.length - 1] : headers[0]; }
  area.selectionStart = area.selectionEnd = target;
  var lineNum = text.slice(0, target).split('\n').length - 1;
  var lineH = parseFloat(getComputedStyle(area).lineHeight) || 18;
  area.scrollTop = Math.max(0, lineNum * lineH - area.clientHeight / 2);
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

// ===== Bottom dock: merged-prompt / memo / terminal share ONE docked slot below the editor =====
// Only one is visible at a time — opening one closes the others (the terminal included). Cmd/Ctrl+Shift+'
// maximizes the active dock over the editor area (the sidebar stays). A top resizer drags the height.
var dockHeightKey = 'monacori-dock-height';
var dockMaximized = false;
function applyDockHeight(px) {
  var h = Math.max(140, Math.min(px, window.innerHeight - 120));
  document.documentElement.style.setProperty('--dock-height', h + 'px');
}
(function () { var s = parseInt(localStorage.getItem(dockHeightKey) || '', 10); if (s) applyDockHeight(s); })();
// The dock panel currently filling the slot: a merged/memo panel, else the terminal when it's open.
function activeDockPanel() {
  var mm = document.getElementById('mc-merged-panel') || document.getElementById('mc-memo-panel');
  if (mm) return mm;
  var term = document.getElementById('terminal-panel');
  return (term && !term.classList.contains('hidden')) ? term : null;
}
function applyDockMaximized() {
  if (!activeDockPanel()) dockMaximized = false; // nothing docked -> can't stay maximized
  document.body.classList.toggle('dock-maximized', dockMaximized);
}
function toggleDockMaximized() {
  if (!activeDockPanel()) return; // nothing docked -> nothing to maximize
  dockMaximized = !dockMaximized;
  applyDockMaximized();
}
function isDockFocused() {
  var ae = document.activeElement;
  return !!(ae && ae.closest && ae.closest('.dock-panel'));
}
// Close the merged/memo docks (the terminal's setOpen also calls this so the slot stays exclusive).
function closeMergedMemoDocks() {
  var m = document.getElementById('mc-merged-panel'); if (m) m.remove();
  var n = document.getElementById('mc-memo-panel'); if (n) n.remove();
  document.querySelectorAll('.dock-backdrop').forEach(function (b) { b.remove(); });
  document.body.classList.toggle('dock-open', !!activeDockPanel());
  // floating-dock tracks merged/memo only (NOT the terminal) so the maximize CSS hides content for a
  // terminal dock but never for these floating panels.
  document.body.classList.toggle('floating-dock', !!(document.getElementById('mc-merged-panel') || document.getElementById('mc-memo-panel')));
  applyDockMaximized();
}
window.__monacoriCloseDocks = closeMergedMemoDocks;
// Retry-focus a docked field (Electron async-restores focus to <body>, so a one-shot focus can lose the race).
function focusDockField(field, panelSel) {
  var tries = 0;
  var tryF = function () {
    if (!document.querySelector(panelSel)) return true;
    if (document.activeElement === field) return true;
    try { field.focus(); } catch (e) {}
    return document.activeElement === field;
  };
  if (!tryF()) { var iv = setInterval(function () { if (tryF() || ++tries > 12) clearInterval(iv); }, 25); }
}
// Build a docked panel shell (resizer + bar with Maximize/Close + body) and mount it below the editor.
// Opening it closes the terminal and any other merged/memo dock (the slot is exclusive). Returns
// { panel, body, bar, close }.
function mountDock(id, titleText) {
  if (window.__monacoriTerminal && typeof window.__monacoriTerminal.close === 'function') {
    try { window.__monacoriTerminal.close(); } catch (e) {}
  }
  var prior = document.getElementById(id);
  if (prior) prior.remove();
  closeMergedMemoDocks();
  var panel = document.createElement('div');
  panel.id = id;
  panel.className = 'dock-panel';
  panel.tabIndex = -1;
  // The panel floats over the editor; a dim backdrop sits behind it (click to dismiss).
  var backdrop = document.createElement('div');
  backdrop.className = 'dock-backdrop';
  var resizer = document.createElement('div');
  resizer.className = 'dock-resizer';
  resizer.setAttribute('aria-hidden', 'true');
  var bar = document.createElement('div');
  bar.className = 'dock-bar';
  var title = document.createElement('span');
  title.className = 'dock-title';
  title.textContent = titleText;
  var maxBtn = document.createElement('button');
  maxBtn.type = 'button';
  maxBtn.className = 'dock-btn dock-max';
  maxBtn.setAttribute('data-i18n-title', 'dock.maximize');
  maxBtn.title = t('dock.maximize');
  maxBtn.textContent = '⤢'; // ⤢ maximize glyph
  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dock-btn dock-close';
  closeBtn.setAttribute('data-i18n', 'merged.close');
  closeBtn.textContent = t('merged.close');
  var body = document.createElement('div');
  body.className = 'dock-body';
  bar.appendChild(title);
  bar.appendChild(maxBtn);
  bar.appendChild(closeBtn);
  panel.appendChild(resizer);
  panel.appendChild(bar);
  panel.appendChild(body);
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  function close() { panel.remove(); backdrop.remove(); closeMergedMemoDocks(); }
  maxBtn.addEventListener('click', function () { toggleDockMaximized(); });
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close); // click the dim behind the panel to dismiss
  // Esc closes the dock when focus is inside it; the editor keeps its own handlers otherwise.
  panel.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  resizer.addEventListener('mousedown', function (e) {
    e.preventDefault();
    resizer.classList.add('resizing');
    function move(ev) { applyDockHeight(window.innerHeight - ev.clientY); }
    function up() {
      resizer.classList.remove('resizing');
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      var cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-height'), 10);
      if (cur) { try { localStorage.setItem(dockHeightKey, String(cur)); } catch (x) {} }
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  document.body.classList.add('dock-open');
  document.body.classList.add('floating-dock'); // scopes the maximize CSS so it doesn't hide the diff
  applyDockMaximized();
  return { panel: panel, body: body, bar: bar, close: close };
}

function openMergedView(kind) {
  var dock = mountDock('mc-merged-panel', kind === 'q' ? t('merged.qTitle') : t('merged.cTitle'));
  dock.panel.dataset.kind = kind; // remembered so a live locale switch can re-render this same view
  var area = document.createElement('textarea');
  area.className = 'mc-modal-text';
  // NOT readOnly: a readOnly textarea hides the caret in Chromium, yet we need it VISIBLE so the user sees
  // which comment Opt+Enter / Opt+Arrow will target. Block every edit via beforeinput instead.
  area.value = buildMergedText(kind);
  area.addEventListener('beforeinput', function (e) { e.preventDefault(); });
  // Opt/Alt+Enter on the merged text: a custom dropdown for the comment under the caret. Opt/Alt+Arrow steps
  // the caret comment-to-comment so each can be acted on without hand-scrolling.
  area.addEventListener('keydown', function (e) {
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      e.stopPropagation();
      jumpMergedComment(area, e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (!e.altKey || (e.key !== 'Enter' && e.code !== 'Enter')) return;
    e.preventDefault();
    e.stopPropagation();
    var seqs = mergedCommentSeqs(kind, area.selectionStart, area.selectionEnd);
    if (!seqs.length) return;
    var cxy = mergedCaretXY(area);
    var x = cxy.x, y = cxy.below, flipTop = cxy.top;
    var rerender = function () {
      if (!reviewComments.filter(function (c) { return c.kind === kind; }).length) { dock.close(); return; }
      area.value = buildMergedText(kind);
    };
    if (area.selectionStart !== area.selectionEnd || seqs.length > 1) {
      // Select-all / multi-comment: offer send-to-terminal (the whole merged text) FIRST, then remove-all.
      var multi = [];
      if (window.__monacoriTerminal && typeof window.__monacoriTerminal.paneCount === 'function' && window.__monacoriTerminal.paneCount() > 0) {
        multi.push({ label: t('merged.sendToTerminal'), onSelect: function () { var text = buildMergedText(kind); dock.close(); window.__monacoriTerminal.enterSendMode(text); } });
      }
      multi.push({ label: t('dropdown.remove'), onSelect: function () { seqs.forEach(deleteComment); rerender(); } });
      showCustomDropdown(x, y, multi, flipTop);
    } else {
      var seq = seqs[0];
      showCustomDropdown(x, y, [
        { label: t('dropdown.navigate'), onSelect: function () { dock.close(); navigateToComment(seq); } },
        { label: t('dropdown.remove'), onSelect: function () { deleteComment(seq); rerender(); } },
      ], flipTop);
    }
  });
  dock.body.appendChild(area);
  // Focus the read-only text so the caret is visible and Opt+Arrow / Opt+Enter work; retry (Electron focus race).
  focusDockField(area, '#mc-merged-panel');
}

// Prompt memo (Cmd/Ctrl+Shift+N): one freeform Markdown scratchpad with a live split preview, persisted
// across reopens via the same store as comments/locale. "Send to terminal" hands the current draft to the
// same pane-pick mode the merged views use, so a half-formed prompt can target any live claude/codex session.
var memoKey = 'monacori-memo';
function loadMemo() {
  var v = persistRead(memoKey);
  if (typeof v === 'string') return v;
  try { var s = localStorage.getItem(memoKey); return typeof s === 'string' ? s : ''; } catch (e) { return ''; }
}
function saveMemo(text) { persistSave(memoKey, text || ''); }
function renderMemoMd(text) {
  if (!text || !text.trim()) return '<div class="mc-memo-empty" data-i18n="memo.previewEmpty">' + escapeHtml(t('memo.previewEmpty')) + '</div>';
  return renderMarkdownBlocks(text).map(function (b) { return b.html; }).join('');
}
function openMemoView() {
  if (document.getElementById('mc-memo-panel')) { closeMergedMemoDocks(); return; } // the shortcut toggles: 2nd press closes
  var dock = mountDock('mc-memo-panel', t('memo.title'));
  var memoBody = document.createElement('div');
  memoBody.className = 'mc-memo-body';
  var area = document.createElement('textarea');
  area.className = 'mc-modal-text mc-memo-edit';
  area.spellcheck = false;
  area.setAttribute('data-i18n-ph', 'memo.placeholder');
  area.placeholder = t('memo.placeholder');
  area.value = loadMemo();
  var preview = document.createElement('div');
  preview.className = 'md-cell mc-memo-preview';
  preview.innerHTML = renderMemoMd(area.value);
  area.addEventListener('input', function () {
    saveMemo(area.value);
    preview.innerHTML = renderMemoMd(area.value);
  });
  // Terminal send: hand the current draft to pane-pick mode. Shown only once a terminal pane exists;
  // enterSendMode reopens the terminal (which closes this memo dock — the slot is exclusive).
  if (window.__monacoriTerminal && typeof window.__monacoriTerminal.paneCount === 'function' && window.__monacoriTerminal.paneCount() > 0) {
    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'dock-btn mc-send-term';
    sendBtn.setAttribute('data-i18n', 'merged.sendToTerminal');
    sendBtn.textContent = t('merged.sendToTerminal');
    sendBtn.addEventListener('click', function () {
      var text = area.value;
      dock.close();
      window.__monacoriTerminal.enterSendMode(text);
    });
    dock.bar.insertBefore(sendBtn, dock.bar.querySelector('.dock-max'));
  }
  memoBody.appendChild(area);
  memoBody.appendChild(preview);
  dock.body.appendChild(memoBody);
  focusDockField(area, '#mc-memo-panel');
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
    panes.forEach(function (q) {
      q.el.classList.toggle('is-active', q === p);
      // 2+ panes: dim every pane but the active one (no border, just a clean focus cue). A lone pane stays full.
      q.el.classList.toggle('is-inactive', panes.length > 1 && q !== p);
    });
    if (p) requestAnimationFrame(function () {
      try {
        if (p.labelEl && p.labelEl.getAttribute('contenteditable') === 'true') return;
        p.term.focus();
      } catch (e) {}
    });
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
    // Exception: keep focus for clipboard/selection combos (Cmd+C/V/X/A) so the terminal's own copy &
    // paste keep working — blurring on Cmd+V drops the textarea focus the paste event needs.
    term.attachCustomKeyEventHandler(function (e) {
      if (e.type === 'keydown' && e.metaKey) {
        var k = (e.key || '').toLowerCase();
        // The bare modifier press (Cmd goes down BEFORE the letter on macOS) must not blur — blurring
        // here drops the textarea focus the upcoming Cmd+V paste / Cmd+C copy needs, which broke them.
        if (k === 'meta' || k === 'control' || k === 'alt' || k === 'shift') return true;
        // Match the PHYSICAL key (e.code), not e.key: under a non-Latin layout/IME (e.g. Korean 한글)
        // Cmd+V reports e.key as 'ㅍ', so a key-based check misses it — blurring the terminal and
        // breaking paste/copy/cut/select-all whenever the Korean input source is active.
        if (e.code === 'KeyC' || e.code === 'KeyV' || e.code === 'KeyX' || e.code === 'KeyA') return true;
        try { term.blur(); } catch (x) {}
        return false;
      }
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
    // Electron asynchronously restores focus to <body> after the keydown, so a one-shot focus loses the
    // race and the label turns editable but never gets the caret — retry until it sticks, then select all
    // (same pattern as the composer/memo). This is why rename "did nothing" before.
    var renameTries = 0;
    var focusLabel = function () {
      if (el.getAttribute('contenteditable') !== 'true') return true; // finished/cancelled meanwhile
      try { el.focus(); } catch (e) {}
      if (document.activeElement !== el) return false;
      try { var range = document.createRange(); range.selectNodeContents(el); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); } catch (e) {}
      return true;
    };
    if (!focusLabel()) { var renameIv = setInterval(function () { if (focusLabel() || ++renameTries > 12) clearInterval(renameIv); }, 25); }
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
    // The terminal shares the bottom dock slot with merged/memo — opening it closes those (exclusive slot).
    if (open && typeof window.__monacoriCloseDocks === 'function') { try { window.__monacoriCloseDocks(); } catch (e) {} }
    panel.classList.toggle('hidden', !open);
    document.body.classList.toggle('terminal-open', open);
    if (toggleBtn) toggleBtn.classList.toggle('is-active', open);
    try { sessionStorage.setItem(openKey, open ? '1' : '0'); } catch (e) {}
    if (typeof applyDockMaximized === 'function') applyDockMaximized(); // keep Cmd+Shift+' maximize in sync
    if (open) {
      if (panes.length === 0) makePane();
      requestAnimationFrame(function () { fitAll(); if (active) try { active.term.focus(); } catch (e) {} });
    }
  }
  function toggle() { setOpen(!isOpen()); }
  // The keyboard shortcut is "focus-first": when the terminal is visible but focus is elsewhere, the first
  // press just moves focus INTO the terminal; only when it already owns focus does another press toggle it
  // closed. (The footer button stays a plain toggle — a mouse click should open/close in one step.)
  function toggleOrFocus() {
    if (!isOpen()) { setOpen(true); return; } // setOpen(true) also focuses the active pane
    var ae = document.activeElement;
    if (ae && panel.contains(ae)) { setOpen(false); return; } // focus already in the terminal → close
    if (active) { try { active.term.focus(); } catch (e) {} } // visible but unfocused → just grab focus
  }

  if (toggleBtn) toggleBtn.addEventListener('click', toggle);
  if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
  // Toggle (Ctrl+`/Alt+F12) and split (Cmd+D) arrive from the Terminal menu accelerators (app-main),
  // because Chromium swallows Cmd+D before a renderer keydown would ever see it.
  if (window.monacoriMenu && typeof window.monacoriMenu.onTerminalToggle === 'function') window.monacoriMenu.onTerminalToggle(toggleOrFocus);
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
    close: function () { setOpen(false); },
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
if (window.monacoriMenu && typeof window.monacoriMenu.onOpenMemo === 'function') {
  // Cmd/Ctrl+Shift+N from the Review menu -> open/close the prompt memo.
  window.monacoriMenu.onOpenMemo(function () { openMemoView(); });
}
if (window.monacoriMenu && typeof window.monacoriMenu.onDiffUpdate === 'function') {
  // Electron watch: main rebuilds on working-tree changes and pushes the new HTML so we refresh the diff
  // in place — NO window reload — keeping the integrated terminal's pty sessions (claude/codex) alive.
  window.monacoriMenu.onDiffUpdate(function (html) { try { applyDiffUpdate(html); } catch (e) {} });
}
if (window.monacoriMenu && typeof window.monacoriMenu.onCloseTab === 'function') {
  // Cmd/Ctrl+W: close the active Files-mode tab (no-op outside the source viewer).
  window.monacoriMenu.onCloseTab(function () {
    // Cmd/Ctrl+W closes the terminal panel first when it's open, otherwise the active Files-mode tab.
    if (window.__monacoriTerminal && window.__monacoriTerminal.isOpen()) { window.__monacoriTerminal.close(); return; }
    if (isSourceViewerVisible()) closeActiveSourceTab();
  });
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
    // Cmd/Ctrl+, (the standard "Preferences" accelerator) toggles the settings panel from anywhere — but not
    // while another floating overlay (merged / memo) owns focus; that one must be Esc'd first.
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === ',' || e.code === 'Comma')) {
      if (modal.classList.contains('hidden') && (document.getElementById('mc-modal') || document.getElementById('mc-memo'))) return;
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
  langSelectRef = setupCustomSelect('settings-language',
    function () { return [{ value: 'en', label: 'English' }, { value: 'ko', label: '한국어' }]; },
    function () { return locale; },
    function (next) {
      if (next === locale) return;
      locale = next;
      persistSave(LOCALE_KEY, locale);
      applyI18n();
      fill(); // merge-prompt placeholders are locale-dependent defaults
      try { if (typeof refreshComments === 'function') refreshComments(); } catch (e) {}
      var mergedModal = document.getElementById('mc-modal');
      if (mergedModal) { var mk = mergedModal.dataset.kind || 'q'; mergedModal.remove(); openMergedView(mk); }
    });
  themeSelectRef = setupCustomSelect('settings-theme',
    function () { return [{ value: 'dark', label: t('theme.dark') }, { value: 'light', label: t('theme.light') }]; },
    function () { return theme; },
    function (next) {
      if (next === theme) return;
      theme = next;
      persistSave(THEME_KEY, theme);
      applyTheme();
    });
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
function applyDiffUpdate(u) {
  if (!u || !u.signature || u.signature === currentSignature) return false; // unchanged — nothing to do
  if (composerState) { pendingDiffUpdate = u; return false; } // composing a comment — hold the refresh until close/save

  // Remember what to restore after the swap (comments/viewed persist on their own; these don't).
  var sv = document.getElementById('source-viewer');
  var openPath = (sv && sv.dataset.openPath) || '';
  var wasSource = isSourceViewerVisible();
  var container = document.getElementById('diff2html-container');
  var diffScrollTop = container ? container.scrollTop : 0;
  // Did the file the user is CURRENTLY viewing actually change in this build? If not, we must not re-render
  // the source view — an unrelated file's edit would otherwise flicker the pane they're reading. Capture the
  // open file's signature BEFORE fileSignatureByPath is rebuilt below.
  var prevOpenSig = openPath ? (fileSignatureByPath.get(openPath) || '') : '';

  // Snapshot already-materialized file bodies (keyed by path + current signature) BEFORE the swap, so an
  // UNCHANGED file can be re-filled synchronously afterwards. Without this, the swap turns every wrapper into
  // an empty lazy shell that blanks until its body re-loads over IPC — the visible "flicker" on a watch tick.
  var prevBodies = {};
  if (REVIEW_LAZY && container) {
    container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
      var b = w.querySelector('.d2h-files-diff');
      if (!b || b.hasAttribute('data-lazy')) return; // only bodies that are actually materialized
      var p = diffWrapperPathKey(w);
      if (p) prevBodies[p] = { sig: fileSignatureByPath.get(p) || '', html: b.innerHTML };
    });
  }

  // 1) Replace the visible regions straight from the payload (no full-HTML parse).
  if (container) container.innerHTML = u.diffContainer || '';
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
  if (REVIEW_LAZY) { setupLazyDiff(); setTimeout(function () { diffBootDone = true; }, 0); }
  else { prepareDiff2HtmlHunks(); diffBootDone = true; }
  if (!REVIEW_LAZY_LOAD) setTimeout(startSymbolIndex, 0);

  // 3b) Re-fill UNCHANGED files' bodies synchronously from the snapshot so they don't blank-then-reload (the
  // flicker). The fresh wrapper carries the correct data-first-hunk + file index, so materializeBody numbers
  // hunks exactly as a normal lazy load would — this only skips the IPC round-trip for files whose content is
  // identical. Changed/new files stay shells and lazy-load as usual, so a real edit still refreshes the diff.
  if (REVIEW_LAZY && container) {
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
    container.scrollTop = diffScrollTop;
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
  const isReadme = (candidate) => /^readme(\.|$)/i.test(candidate.name || '');
  const depthOf = (candidate) => (candidate.path || '').split('/').length;
  // Prefer the TOP-MOST README (root before any nested one), not just the first match in tree order.
  const rootReadme = sourceFiles
    .filter((candidate) => candidate.embedded && isReadme(candidate))
    .sort((a, b) => depthOf(a) - depthOf(b))[0];
  const file = sourceFiles.find((candidate) => candidate.changed && candidate.embedded)
    || rootReadme // top-most README when nothing changed
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
  // sourceBodyPath (the file actually painted in the body) must match too — dataset.openPath/viewerCursor
  // are metadata that can be set before the body repaints (lazy fetch in flight, fast file switch, watch
  // refresh), so without this the caret patches a STALE body and one file's content shows under another's
  // breadcrumb. On mismatch we fall through to openSourceFile, which re-renders the body for `path`.
  const sameFileOpen = Boolean(viewer && viewer.dataset.openPath === path && !viewer.classList.contains('hidden')
    && prev && prev.path === path && !isHttpFile(path) && sourceBodyPath === path);

  viewerCursor = { path, lineIndex: boundedLine, column: boundedColumn, targetLine };

  if (sameFileOpen) {
    // Coalesce caret render + scroll into ONE frame on reveal (ArrowDown) so a fast key-repeat doesn't run
    // the caret several rows ahead of the lagging (rAF) scroll and snap ~one viewport at a time ("stutter
    // every ~26 lines"). Click (no reveal) stays instant.
    if (shouldReveal) scheduleSourceReveal(prev);
    else updateSourceCaret(prev, lines, file.language || 'text');
  } else {
    const shouldSwitch = !viewer || viewer.dataset.openPath !== path || viewer.classList.contains('hidden');
    openSourceFile(path, shouldSwitch);
    if (shouldReveal) scheduleScrollIntoView(document.querySelector('.source-row.cursor-line'));
  }
  recordNav(navEntryOf('source'));
}
var sourceRevealRaf = 0, sourceRevealPrev = null;
// Source rows are a fixed monospace height, so the caret-follow scroll can be computed from
// lineIndex*rowHeight instead of reading the caret's getBoundingClientRect — which forces a full reflow on
// every move (~15ms on a 400-line file; the main caret-follow stutter). Cached; invalidated on resize.
var _srcRowH = 0;
function sourceRowHeight() {
  if (_srcRowH > 0) return _srcRowH;
  var r = document.querySelector('#source-body .source-row');
  if (r) { var h = r.offsetHeight; if (h > 0) _srcRowH = h; }
  return _srcRowH;
}
if (typeof window !== 'undefined') window.addEventListener('resize', function () { _srcRowH = 0; });
function scheduleSourceReveal(prev) {
  // First prev of a coalesced burst wins: a fast ArrowDown updates viewerCursor many times before the frame
  // fires; render the caret once (first prev -> final viewerCursor) and scroll in the SAME frame so caret and
  // scroll stay locked together instead of the scroll snapping a viewport behind.
  if (!sourceRevealRaf) sourceRevealPrev = prev;
  if (sourceRevealRaf) return;
  sourceRevealRaf = requestAnimationFrame(function () {
    sourceRevealRaf = 0;
    var p = sourceRevealPrev; sourceRevealPrev = null;
    var f = sourceByPath.get(viewerCursor.path);
    if (!f || !f.embedded) return;
    var lines = f.content.split(/\r?\n/);
    updateSourceCaret(p, lines, f.language || 'text');
    var sb = document.getElementById('source-body');
    var rowH = sourceRowHeight();
    if (rowH > 0 && sb && !sb.classList.contains('rendered-body')) {
      // Scrolloff, not follow: scroll ONLY when the caret would otherwise leave the viewport, keeping it
      // within a 15% margin of the top/bottom edge. While the caret moves comfortably inside that band the
      // view stays put — continuous follow was dizzying (the file slid even when everything was visible) and
      // it forced a scroll/reflow on every move. lineIndex*rowH avoids getBoundingClientRect entirely, and
      // skipping the scroll when it's unnecessary removes the reflow on most moves too.
      var caretTop = viewerCursor.lineIndex * rowH;
      var ch = sb.clientHeight;
      var margin = Math.round(ch * 0.15);
      var vTop = sb.scrollTop;
      if (caretTop < vTop + margin) sb.scrollTop = Math.max(0, caretTop - margin);
      else if (caretTop + rowH > vTop + ch - margin) sb.scrollTop = caretTop + rowH - ch + margin;
    } else {
      revealAt(document.querySelector('.source-row.cursor-line'), sb, 0.85);
    }
  });
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
    if (prevRow) prevRow.classList.remove('cursor-line');
  }
  // Drop the old caret span WITHOUT re-highlighting the line — re-tokenizing a line on every caret move is
  // what made holding an arrow key stutter. (The diff caret already works this way: insert/remove a span.)
  if (!rendered) body.querySelectorAll('.code-cursor').forEach((s) => { const p = s.parentNode; if (p) { p.removeChild(s); if (p.normalize) p.normalize(); } });
  // Reconcile the go-to-definition highlight (set only on symbol jumps, cleared on plain moves).
  body.querySelectorAll('.source-row.symbol-target').forEach((r) => r.classList.remove('symbol-target'));
  if (viewerCursor.targetLine >= 0) rowFor(viewerCursor.targetLine)?.classList.add('symbol-target');
  const row = rowFor(viewerCursor.lineIndex);
  if (!row) { if (!rendered) openSourceFile(viewerCursor.path, false); return; } // line not in the DOM — full re-render (eager source only)
  row.classList.add('cursor-line');
  if (!rendered) insertSourceCaret(row, viewerCursor.column);
}
// Insert the caret span at `column` of `row` via a real DOM range into the already-highlighted line — the
// same cheap technique the diff caret uses, so holding an arrow key never re-tokenizes a line.
function insertSourceCaret(row, column) {
  var cell = row.querySelector('.source-code');
  if (!cell) return;
  var pos = diffCaretDomPosition(cell, column); // empty line: returns {node: cell, offset: 0} so the caret still shows
  if (!pos) return;
  var span = document.createElement('span');
  span.className = 'code-cursor';
  span.setAttribute('aria-hidden', 'true');
  try {
    var off = pos.node.nodeType === 3 ? Math.min(pos.offset, (pos.node.textContent || '').length) : pos.offset;
    var range = document.createRange();
    range.setStart(pos.node, off); range.collapse(true);
    range.insertNode(span);
  } catch (e) {}
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
  // Keep the caret visible: the box's active outline (.mc-row-selected) already shows the selection, and the
  // caret must never be hidden ("어떤 경우에도 커서는 가려지면 안 됨"). Previously this removed cursor-line +
  // code-cursor, so Go-to-comment → ArrowDown (which selects the comment box on that line) made the caret vanish.
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
// Open the composer in EDIT mode for the first comment in `row`, pre-filled with its text. threadHtml renders
// the composer in place of that card (via composerState.editSeq), and saveComposer routes editSeq through
// updateComment instead of addComment. Triggered by `e` while a comment box is selected.
function editCommentInRow(row) {
  if (!row) return;
  var del = row.querySelector('.mc-del');
  if (!del) return;
  var seq = parseInt(del.dataset.seq, 10);
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  row.classList.remove('mc-row-selected');
  selectedCommentRow = null;
  composerState = { kind: c.kind, path: c.path, line: c.line, code: c.code, editSeq: seq, editText: c.text };
  refreshComments();
}
function handleSourceCaretKey(event) {
  if (!viewerCursor) return false;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return false;
  const extend = event.shiftKey;
  // A comment box is selected (caret hidden): Backspace/Delete removes it; an arrow steps off it.
  if (selectedCommentRow) {
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); deleteCommentsInRow(selectedCommentRow); return true; }
    if (event.key === 'e' || event.key === 'E') { event.preventDefault(); editCommentInRow(selectedCommentRow); return true; }
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
// Run symbol indexing off the critical path: requestIdleCallback so the heavy postMessage of the whole
// source blob to the worker (structured-clone serialization is synchronous on the main thread) never
// competes with key handling — especially on big repos right after the diff/tree first paints.
function scheduleSymbolIndex() {
  var run = function () { try { startSymbolIndex(); } catch (e) {} };
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 0);
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
  var foot = document.getElementById('footer-progress');
  var running = Boolean(total) && done < total;
  var pct = running ? Math.round(done / total * 100) + '%' : '0%';
  if (el) {
    el.textContent = running ? (t('status.indexing') + ' ' + done + '/' + total + '…') : ((total || 0) + ' ' + t('status.indexed'));
  }
  if (bar) {
    bar.classList.toggle('hidden', !running);
    if (running && bar.firstElementChild) bar.firstElementChild.style.width = pct;
  }
  // The same signal, mirrored as a thin bar pinned under the version block at the bottom of the
  // sidebar — so background work (indexing) is visible even when the toolbar status is out of view.
  if (foot) {
    foot.classList.toggle('hidden', !running);
    if (foot.firstElementChild) foot.firstElementChild.style.width = pct;
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
  // Switching to another file abandons any in-progress comment elsewhere; closeComposer() clears
  // composerState and (via refreshComments) drops body.mc-composing so no caret stays hidden.
  if (composerState && composerState.path !== path) closeComposer();
  addSourceTab(path);
  renderSourceTabs(path);
  // lazy-LOAD: source content not fetched yet -> show a loading state; loadSourceData re-opens it.
  if (REVIEW_LAZY_LOAD && !sourceLoaded && file.embedded) {
    pendingSourceOpen = { path: path, shouldSwitch: shouldSwitch };
    loadSourceData();
    sourceBodyPath = null; // body shows a loading placeholder, not this path's content yet
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
  sourceBodyPath = path; // past the lazy guard — every branch below paints THIS path's body (text/image/not-embedded)
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
    if (viewerCursor && viewerCursor.path === path) { var ccr = body.querySelector('.source-row.cursor-line'); if (ccr) insertSourceCaret(ccr, viewerCursor.column); }
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
    if (isFloatingModalOpen()) return; // a floating overlay owns focus -> no render-toggle shortcut beneath it
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

// Render HTML embedded in Markdown (GitHub-style) safely. Parse in an INERT <template> — scripts don't
// run and resources don't load there — then strip dangerous tags + on*/javascript: attributes before
// returning the HTML. The result is injected via innerHTML, so only the sanitized subset survives.
function sanitizeHtml(html) {
  var tpl = document.createElement('template');
  tpl.innerHTML = String(html);
  var BAD = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1, BASE: 1, FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1, NOSCRIPT: 1 };
  var walk = function (node) {
    var kids = Array.prototype.slice.call(node.children || []);
    for (var k = 0; k < kids.length; k++) {
      var el = kids[k];
      if (BAD[el.tagName]) { el.parentNode.removeChild(el); continue; }
      var attrs = Array.prototype.slice.call(el.attributes);
      for (var a = 0; a < attrs.length; a++) {
        var nm = attrs[a].name.toLowerCase();
        if (nm.indexOf('on') === 0) { el.removeAttribute(attrs[a].name); continue; }
        if ((nm === 'href' || nm === 'src' || nm === 'xlink:href' || nm === 'srcset')
          && /^\s*(javascript|vbscript|data:text\/html):/i.test(attrs[a].value || '')) {
          el.removeAttribute(attrs[a].name);
        }
      }
      walk(el);
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
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
    // Raw HTML block (GitHub-flavored Markdown): a line beginning with a tag. Accumulate to the next
    // blank line and render it as sanitized HTML, so README markup (<div>, <img>, <table>, …) shows
    // rendered instead of as escaped text.
    if (/^\s*<(\/?[a-zA-Z][\w-]*|!--)/.test(line)) {
      var hbuf = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i])) { hbuf.push(lines[i]); i++; }
      blocks.push({ line: start, html: '<div class="md-html">' + sanitizeHtml(hbuf.join('\n')) + '</div>' });
      continue;
    }
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
  // The <select> lives in the toolbar (not swapped on in-place diff updates), so wire the change handler
  // exactly once — populateHttpEnvSelect is re-called by applyDiffUpdate to refresh the options.
  if (!select.dataset.wired) {
    select.dataset.wired = '1';
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
      '<td class="source-code">' + highlightLine(line, file.language || 'text') + '</td>',
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
    if (char === '@') {
      const decorator = rest.match(/^@[A-Za-z_$][\w$.]*/);
      if (decorator) {
        output += '<span class="tok-decorator">' + escapeHtml(decorator[0]) + '</span>';
        index += decorator[0].length;
        continue;
      }
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
      const trailing = text.slice(index + value.length);
      if (keywords.has(value)) output += '<span class="tok-keyword">' + escapeHtml(value) + '</span>';
      else if (literals.has(value)) output += '<span class="tok-literal">' + escapeHtml(value) + '</span>';
      else if (/^\s*\(/.test(trailing)) output += '<span class="tok-function">' + escapeHtml(value) + '</span>';
      else if (/^[A-Z]/.test(value) && /[a-z]/.test(value)) output += '<span class="tok-type">' + escapeHtml(value) + '</span>';
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
