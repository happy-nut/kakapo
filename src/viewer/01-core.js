
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
// Rebuild the hunk index from the CURRENT diff DOM. `hunks`/`hunkPeers`/`hunkMeta` are captured once at
// init; after an in-place watch swap (applyDiffUpdate) the DOM holds new wrappers/rows, so without this
// hunkTotal()/hunkPathAt() keep reporting the OLD build — F7 and showDiffView then target vanished indices
// and the diff pane goes blank. Mutates the const arrays in place so existing references stay valid.
function refreshHunkIndex() {
  if (REVIEW_LAZY) {
    hunkMeta.length = 0;
    Array.prototype.forEach.call(document.querySelectorAll('#diff2html-container .d2h-file-wrapper'), function (w) {
      var base = parseInt(w.dataset.firstHunk || '0', 10) || 0;
      var cnt = parseInt(w.dataset.hunkCount || '0', 10) || 0;
      var p = w.dataset.path || ((w.querySelector('.d2h-file-name') || {}).textContent || '').trim();
      for (var k = 0; k < cnt; k++) hunkMeta[base + k] = { path: p };
    });
  } else {
    prepareDiff2HtmlHunks(); // (re)tag .hunk/.hunk-peer rows + file ids on the new DOM
    hunks.length = 0;
    Array.prototype.push.apply(hunks, document.querySelectorAll('.hunk'));
    hunkPeers.length = 0;
    Array.prototype.push.apply(hunkPeers, document.querySelectorAll('.hunk-peer'));
  }
}
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
// Electron starts with metadata only. Source bodies are fetched one file at a time so opening a large
// project never clones every source file into the renderer. The browser server retains its bulk endpoint
// as a compatibility fallback, but the desktop app always uses monacoriFile.getSource(path).
sourceFiles.forEach(function (file) { file.__loaded = !REVIEW_LAZY_LOAD || !file.embedded; });
var sourceLoadPromises = Object.create(null);
var bulkSourcePromise = null;
var sourceGeneration = 0; // increments on watch refresh so an older IPC response cannot overwrite new source
// The path whose content is ACTUALLY painted in #source-body right now. dataset.openPath is the INTENDED
// path and gets set BEFORE the body paints in the lazy-LOAD branch, so the caret fast-path must check this
// instead — else it patches the caret onto a stale body, leaving one file's content under another's path.
var sourceBodyPath = null;
var sourceTabs = []; // Files-mode tab paths (session-only); see addSourceTab / renderSourceTabs.
function sourceContentLoaded(file) {
  return Boolean(file && (!REVIEW_LAZY_LOAD || !file.embedded || file.__loaded));
}
function mergeSourceRecord(record) {
  if (!record || !record.path) return null;
  var file = sourceByPath.get(record.path);
  if (!file) return null;
  file.content = String(record.content || '');
  if (record.image) file.image = record.image;
  file.__loaded = true;
  return file;
}
function loadSourceFile(path) {
  var file = sourceByPath.get(path);
  if (!file || sourceContentLoaded(file)) return Promise.resolve(file || null);
  if (sourceLoadPromises[path]) return sourceLoadPromises[path];
  var generation = sourceGeneration;
  var promise;
  if (typeof window !== 'undefined' && window.monacoriFile && typeof window.monacoriFile.getSource === 'function') {
    promise = Promise.resolve().then(function () { return window.monacoriFile.getSource(path); }).then(function (record) {
      if (generation !== sourceGeneration) return sourceByPath.get(path) || null;
      return mergeSourceRecord(record) || file;
    });
  } else {
    // The standalone browser viewer has a single source-data endpoint. Fetch it at most once and mark
    // each returned record loaded; Electron never enters this branch.
    if (!bulkSourcePromise) {
      bulkSourcePromise = (typeof fetch !== 'undefined'
        ? fetch('source-data').then(function (r) { return r.ok ? r.text() : '[]'; })
        : Promise.resolve('[]')).then(function (text) {
          var data = [];
          try { data = JSON.parse(text || '[]'); } catch (e) { data = []; }
          if (generation === sourceGeneration) {
            for (var i = 0; i < data.length; i++) mergeSourceRecord(data[i]);
          }
          return data;
        });
    }
    promise = bulkSourcePromise.then(function () { return sourceByPath.get(path) || file; });
  }
  var tracked = promise.then(function (loaded) {
    if (sourceLoadPromises[path] === tracked) delete sourceLoadPromises[path];
    remapComments();
    return loaded;
  }, function () {
    if (sourceLoadPromises[path] === tracked) delete sourceLoadPromises[path];
    if (generation === sourceGeneration) file.__loaded = true;
    return file;
  });
  sourceLoadPromises[path] = tracked;
  return tracked;
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
const quickFilterEl = document.getElementById('quick-open-filter');
let current = -1;
let checkingForUpdates = false;
let lastShiftAt = 0;
let lastShiftSide = 0;
let quickMode = 'all';
let quickItems = [];
let quickActive = 0;
let recentFilter = ''; // IntelliJ-style speed-search: typed letters narrow the Recent list (no search box)
let contentSearchItems = [];
let contentSearchQuery = '';
let contentSearchSeq = 0;
let contentSearchTimer = null;
let contentSearchBusy = false;
let contentSearchTruncated = false;
let contentSearchEngine = 'local';
let workspaceSymbolItems = [];
let workspaceSymbolQuery = '';
let workspaceSymbolSeq = 0;
let workspaceSymbolTimer = null;
let workspaceSymbolBusy = false;
let workspaceSymbolEngine = 'index';
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
