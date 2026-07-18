// ===== Go-to-line (Cmd/Ctrl+L), copy caret location (Cmd/Ctrl+K), and the sidebar row action menu. =====

// Programmatic clipboard write. Electron's bridge is reliable on file://; navigator.clipboard is the fallback.
function copyTextToClipboard(text) {
  try { if (window.kakapoClipboard && typeof window.kakapoClipboard.write === 'function') { window.kakapoClipboard.write(text); return true; } } catch (e) {}
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; } } catch (e) {}
  return false;
}

// "path:line" for the current caret — source view (the painted file) or the diff caret. '' if neither.
function caretLocation() {
  if (typeof isSourceViewerVisible === 'function' && isSourceViewerVisible()) {
    var sv = document.getElementById('source-viewer');
    var p = (sv && sv.dataset.openPath) || '';
    if (p && typeof viewerCursor !== 'undefined' && viewerCursor && viewerCursor.path === p) return p + ':' + (viewerCursor.lineIndex + 1);
    if (p) return p;
  }
  if (typeof isDiffViewVisible === 'function' && isDiffViewVisible() && typeof diffCursor !== 'undefined' && diffCursor) {
    var wrap = diffWrapperByPath(diffCursor.path);
    var row = wrap ? diffRowAt(wrap, diffCursor.side, diffCursor.rowIndex) : null;
    var ln = row ? diffLineNumber(row) : null;
    return diffCursor.path + (ln ? ':' + ln : '');
  }
  return '';
}

// Cmd/Ctrl+K — copy the caret's file:line to the clipboard.
function copyCaretLocation() {
  var loc = caretLocation();
  if (!loc) return;
  if (copyTextToClipboard(loc) && typeof showToast === 'function') showToast(t('goto.copied') + ' ' + loc);
}

// Diff view: place the caret on the row whose (new, then old) line number matches n, in the active file.
function gotoDiffLine(n) {
  var path = (typeof diffCursor !== 'undefined' && diffCursor && diffCursor.path) || '';
  if (!path && typeof diffActiveWrapper === 'function') {
    var w = diffActiveWrapper();
    var nm = w && w.querySelector('.d2h-file-name');
    if (nm && nm.textContent) path = nm.textContent.trim();
  }
  var wrap = path && diffWrapperByPath(path);
  if (!wrap) return;
  var sides = [(diffCursor && diffCursor.side) || 'new', 'new', 'old'];
  for (var s = 0; s < sides.length; s++) {
    var rows = diffRowsOf(diffSideTable(wrap, sides[s]));
    for (var i = 0; i < rows.length; i++) {
      if (diffLineNumber(rows[i]) === n) { setDiffCursor(path, sides[s], i, 0, true); return; }
    }
  }
}

function gotoLineJump(n) {
  if (!(n >= 1)) return;
  if (typeof isSourceViewerVisible === 'function' && isSourceViewerVisible()) {
    var sv = document.getElementById('source-viewer');
    var p = (sv && sv.dataset.openPath) || '';
    var f = p && sourceByPath.get(p);
    if (f && f.embedded && typeof f.content === 'string') {
      var max = f.content.split(/\r?\n/).length;
      setSourceCursor(p, Math.max(0, Math.min(max - 1, n - 1)), 0, true, -1);
      return;
    }
  }
  if (typeof isDiffViewVisible === 'function' && isDiffViewVisible()) gotoDiffLine(n);
}

// Cmd/Ctrl+L — a small numeric prompt; Enter jumps, Esc closes.
function openGotoLine() {
  if (!((typeof isSourceViewerVisible === 'function' && isSourceViewerVisible()) || (typeof isDiffViewVisible === 'function' && isDiffViewVisible()))) return;
  var prior = document.getElementById('goto-line');
  if (prior) prior.remove();
  var box = document.createElement('div');
  box.id = 'goto-line';
  box.className = 'goto-line';
  var input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.className = 'goto-line-input';
  input.placeholder = t('goto.placeholder');
  box.appendChild(input);
  document.body.appendChild(box);
  function close() { box.remove(); document.removeEventListener('keydown', onKey, true); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); var n = parseInt(input.value, 10); close(); if (n >= 1) gotoLineJump(n); }
  }
  // Capture phase so Enter/Esc are handled here before the global keymap (which is on bubble).
  document.addEventListener('keydown', onKey, true);
  setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
}

// Sidebar Opt+Enter: project-grounded file actions for the focused row. Absolute paths are resolved by
// Electron's main process so the renderer never needs the project root or direct filesystem access.
function openTreeRowMenu(row) {
  if (!row) return;
  var path = row.dataset.sourceFile || row.dataset.file || '';
  if (!path) return;
  var r = row.getBoundingClientRect();
  var items = [
    { label: t('menu.copyRelativePath'), onSelect: function () { if (copyTextToClipboard(path) && typeof showToast === 'function') showToast(t('goto.copied') + ' ' + path); } },
  ];
  if (window.kakapoApp && typeof window.kakapoApp.absolutePath === 'function') {
    items.push({ label: t('menu.copyAbsolutePath'), onSelect: function () {
      try {
        Promise.resolve(window.kakapoApp.absolutePath(path)).then(function (result) {
          var absolute = result && result.ok && typeof result.path === 'string' ? result.path : '';
          if (absolute && copyTextToClipboard(absolute) && typeof showToast === 'function') showToast(t('goto.copied') + ' ' + absolute);
        });
      } catch (e) {}
    } });
  }
  if (window.kakapoApp && typeof window.kakapoApp.revealInFinder === 'function') {
    items.push({ label: t('menu.revealFinder'), onSelect: function () { try { window.kakapoApp.revealInFinder(path); } catch (e) {} } });
  }
  if (window.kakapoApp && typeof window.kakapoApp.openTerminal === 'function') {
    items.push({ label: t('menu.openTerminal'), onSelect: function () { try { window.kakapoApp.openTerminal(path); } catch (e) {} } });
  }
  showCustomDropdown(Math.round(r.left + 14), Math.round(r.bottom + 2), items, Math.round(r.top));
}

// IntelliJ-style file blame: the line-number gutter expands in place to show date + author. Attribution
// remains attached to its source tab across folding/raw repaints, and clicking an attribution reuses the
// existing read-only commit-diff workspace instead of opening a second line-history list.
function buildBlameAgeBuckets(records) {
  var rows = Array.isArray(records) ? records : [];
  var dated = rows.map(function (record) {
    var time = Date.parse(String(record && record.date || '') + 'T00:00:00Z');
    return { hash: String(record && record.hash || ''), time: time };
  }).filter(function (entry) { return entry.hash && Number.isFinite(entry.time); });
  if (!dated.length) return new Map();
  var newest = Math.max.apply(Math, dated.map(function (entry) { return entry.time; }));
  var oldest = Math.min.apply(Math, dated.map(function (entry) { return entry.time; }));
  var span = Math.max(1, newest - oldest);
  var result = new Map();
  dated.forEach(function (entry) {
    result.set(entry.hash, Math.max(0, Math.min(4, Math.round(((newest - entry.time) / span) * 4))));
  });
  return result;
}

var sourceBlamePath = '';
var sourceBlameLines = null;
var sourceBlameAges = new Map();
var sourceBlameLoadSeq = 0;

function sourceBlameEnabled(path) { return !!path && sourceBlamePath === path; }

function clearSourceBlamePaint() {
  var body = document.getElementById('source-body');
  if (!body) return;
  body.classList.remove('source-blame-visible', 'source-blame-loading');
}

function hideSourceBlame(path) {
  if (path && sourceBlamePath !== path) return;
  sourceBlameLoadSeq += 1;
  sourceBlamePath = '';
  sourceBlameLines = null;
  sourceBlameAges = new Map();
  clearSourceBlamePaint();
  var viewer = document.getElementById('source-viewer');
  var openPath = viewer && viewer.dataset.openPath || '';
  if (openPath && typeof openSourceFile === 'function') openSourceFile(openPath, false, { scrollTree: false });
}

function applySourceBlameIfActive(path) {
  var body = document.getElementById('source-body');
  if (!body || !sourceBlameEnabled(path) || !sourceBlameLines) return;
  body.classList.remove('source-blame-loading');
  body.classList.add('source-blame-visible');
  body.querySelectorAll('.source-row[data-line-index] > .num').forEach(function (cell) {
    var row = cell.closest('.source-row[data-line-index]');
    var lineIndex = Number(row && row.dataset.lineIndex);
    var record = sourceBlameLines.get(lineIndex + 1);
    var label = cell.textContent || String(lineIndex + 1);
    var numberHtml = '<span class="source-line-number">' + escapeHtml(label) + '</span>';
    if (!record) {
      cell.innerHTML = '<span class="source-blame-entry source-blame-empty"></span>' + numberHtml;
      return;
    }
    var zeroHash = /^0+$/.test(record.hash || '');
    var ageClass = ' mc-blame-age-' + (sourceBlameAges.get(record.hash) || 0);
    var title = [record.summary, record.hash && record.hash.slice(0, 10)].filter(Boolean).join(' · ');
    var content = '<span class="source-blame-date">' + escapeHtml(record.date || '—') + '</span>'
      + '<span class="source-blame-author">' + escapeHtml(record.author || '—') + '</span>';
    cell.innerHTML = (zeroHash
      ? '<span class="source-blame-entry source-blame-uncommitted' + ageClass + '" title="' + escapeHtml(title) + '">' + content + '</span>'
      : '<button type="button" class="source-blame-entry' + ageClass + '" data-blame-sha="' + escapeHtml(record.hash) + '" data-blame-path="' + escapeHtml(path) + '" title="' + escapeHtml(title) + '">' + content + '</button>') + numberHtml;
  });
}

function showSourceBlame(path) {
  if (!path || !window.kakapoGit || typeof window.kakapoGit.blame !== 'function') return;
  sourceBlamePath = path;
  sourceBlameLines = null;
  var body = document.getElementById('source-body');
  if (body) body.classList.add('source-blame-loading');
  var seq = ++sourceBlameLoadSeq;
  Promise.resolve(window.kakapoGit.blame({ path: path })).then(function (records) {
    if (seq !== sourceBlameLoadSeq || sourceBlamePath !== path) return;
    var rows = Array.isArray(records) ? records : [];
    sourceBlameLines = new Map(rows.map(function (record) { return [Number(record.line), record]; }));
    sourceBlameAges = buildBlameAgeBuckets(rows);
    applySourceBlameIfActive(path);
  }, function () {
    if (seq === sourceBlameLoadSeq) hideSourceBlame(path);
  });
}

// Called after source-table repaints (folding, Markdown/raw switching, and watch updates).
function refreshSourceBlamePaint(path) {
  clearSourceBlamePaint();
  applySourceBlameIfActive(path);
}

// Files mode (Cmd+1): right-clicking any line number toggles the inline blame columns.
(function wireSourceLineHistoryMenu() {
  var body = document.getElementById('source-body');
  if (!body) return;
  body.addEventListener('contextmenu', function (event) {
    var number = event.target && event.target.closest ? event.target.closest('.source-row .num') : null;
    var row = number && number.closest ? number.closest('.source-row[data-line-index]') : null;
    var viewer = document.getElementById('source-viewer');
    var path = viewer && viewer.dataset.openPath || '';
    if (!row || !path || !window.kakapoGit || typeof window.kakapoGit.blame !== 'function') return;
    event.preventDefault();
    event.stopPropagation();
    showCustomDropdown(event.clientX, event.clientY, [{
      label: t(sourceBlameEnabled(path) ? 'menu.hideLineHistory' : 'menu.showLineHistory'),
      onSelect: function () {
        if (sourceBlameEnabled(path)) hideSourceBlame(path);
        else showSourceBlame(path);
      },
    }], event.clientY);
  });
})();

// Diff blame uses the same read-only commit workspace, but keeps each logical line number attached to its
// code edge. The base pane is code | line | date | author; the working pane is date | author | line | code.
// Loading both revisions avoids attributing base-only lines to the current working tree.
var diffBlamePath = '';
var diffBlameLines = { old: null, new: null };
var diffBlameAges = new Map();
var diffBlameLoading = false;
var diffBlameLoadSeq = 0;

function diffBlameEnabled(path) { return !!path && diffBlamePath === path; }

function diffBlameWrapperPath(wrapper) {
  if (!wrapper) return '';
  if (typeof diffWrapperPathKey === 'function') return diffWrapperPathKey(wrapper);
  return (wrapper.dataset && wrapper.dataset.path) || '';
}

function syncDiffBlameWrapper(wrapper) {
  if (!wrapper || !wrapper.classList) return;
  // Blame belongs to the live Review workspace only. Commit diffs reuse the same layered diff renderer,
  // but must open clean instead of inheriting the annotation state of the file that launched them.
  var reviewWrapper = !!(wrapper.closest && wrapper.closest('#diff2html-container'));
  var active = reviewWrapper && diffBlameEnabled(diffBlameWrapperPath(wrapper));
  wrapper.classList.toggle('mc-diff-blame-loading', active && diffBlameLoading);
  wrapper.classList.toggle('mc-diff-blame-visible', active && !diffBlameLoading && !!diffBlameLines.old && !!diffBlameLines.new);
  wrapper.querySelectorAll('.mc-diff-gutter-layer').forEach(function (layer) {
    layer.setAttribute('aria-hidden', active ? 'false' : 'true');
  });
}

function diffBlameSideName(side, wrapper) {
  var tables = typeof diffSideTables === 'function' ? diffSideTables(wrapper) : { left: null, right: null };
  return side === tables.left ? 'old' : 'new';
}

function diffBlameEntryHtml(record, path) {
  if (!record) return '<span class="mc-diff-blame-entry mc-diff-blame-empty"></span>';
  var zeroHash = /^0+$/.test(record.hash || '');
  var ageClass = ' mc-blame-age-' + (diffBlameAges.get(record.hash) || 0);
  var title = [record.summary, record.hash && record.hash.slice(0, 10)].filter(Boolean).join(' · ');
  var content = '<span class="mc-diff-blame-date">' + escapeHtml(record.date || '—') + '</span>'
    + '<span class="mc-diff-blame-author">' + escapeHtml(record.author || '—') + '</span>';
  return zeroHash
    ? '<span class="mc-diff-blame-entry mc-diff-blame-uncommitted' + ageClass + '" title="' + escapeHtml(title) + '">' + content + '</span>'
    : '<button type="button" class="mc-diff-blame-entry' + ageClass + '" data-blame-sha="' + escapeHtml(record.hash) + '" data-blame-path="' + escapeHtml(path) + '" title="' + escapeHtml(title) + '">' + content + '</button>';
}

function decorateDiffBlameGutterItem(item, entry, side) {
  var wrapper = side && side.closest ? side.closest('.d2h-file-wrapper') : null;
  var path = diffBlameWrapperPath(wrapper);
  var reviewWrapper = !!(wrapper && wrapper.closest && wrapper.closest('#diff2html-container'));
  var active = reviewWrapper && diffBlameEnabled(path) && !diffBlameLoading && diffBlameLines.old && diffBlameLines.new;
  var lineHtml = '<span class="mc-diff-line-number">' + escapeHtml(entry.lineNumber) + '</span>';
  if (!active) {
    if (item.dataset.blamePaint !== 'number:' + entry.lineNumber) item.innerHTML = lineHtml;
    item.dataset.blamePaint = 'number:' + entry.lineNumber;
    return;
  }
  var sideName = diffBlameSideName(side, wrapper);
  var record = diffBlameLines[sideName].get(Number(entry.lineNumber));
  var recordKey = record ? [record.hash, record.date, record.author].join(':') : 'empty';
  var paintKey = sideName + ':' + entry.lineNumber + ':' + recordKey;
  if (item.dataset.blamePaint === paintKey) return;
  var blameHtml = diffBlameEntryHtml(record, path);
  item.innerHTML = sideName === 'old' ? lineHtml + blameHtml : blameHtml + lineHtml;
  item.dataset.blamePaint = paintKey;
}

function refreshDiffBlamePath(path) {
  var wrapper = typeof diffWrapperByPath === 'function' ? diffWrapperByPath(path) : null;
  if (!wrapper) return;
  syncDiffBlameWrapper(wrapper);
  if (typeof refreshLayeredDiffGutters === 'function') refreshLayeredDiffGutters(wrapper);
  if (typeof invalidateAsymmetricDiffGeometry === 'function') invalidateAsymmetricDiffGeometry(wrapper);
}

function hideDiffBlame(path) {
  if (path && !diffBlameEnabled(path)) return;
  var previous = diffBlamePath;
  diffBlameLoadSeq += 1;
  diffBlamePath = '';
  diffBlameLines = { old: null, new: null };
  diffBlameAges = new Map();
  diffBlameLoading = false;
  if (previous) refreshDiffBlamePath(previous);
}

function showDiffBlame(path) {
  if (!path || !window.kakapoGit || typeof window.kakapoGit.blame !== 'function') return;
  var previous = diffBlamePath;
  diffBlamePath = path;
  diffBlameLines = { old: null, new: null };
  diffBlameAges = new Map();
  diffBlameLoading = true;
  if (previous && previous !== path) refreshDiffBlamePath(previous);
  refreshDiffBlamePath(path);
  var seq = ++diffBlameLoadSeq;
  Promise.all([
    Promise.resolve(window.kakapoGit.blame({ path: path, side: 'old' })),
    Promise.resolve(window.kakapoGit.blame({ path: path, side: 'new' })),
  ]).then(function (records) {
    if (seq !== diffBlameLoadSeq || !diffBlameEnabled(path)) return;
    var oldRows = Array.isArray(records[0]) ? records[0] : [];
    var newRows = Array.isArray(records[1]) ? records[1] : [];
    diffBlameLines = {
      old: new Map(oldRows.map(function (record) { return [Number(record.line), record]; })),
      new: new Map(newRows.map(function (record) { return [Number(record.line), record]; })),
    };
    diffBlameAges = buildBlameAgeBuckets(oldRows.concat(newRows));
    diffBlameLoading = false;
    refreshDiffBlamePath(path);
  }, function () {
    if (seq === diffBlameLoadSeq) hideDiffBlame(path);
  });
}

function diffGutterHitAt(side, clientX, clientY) {
  var gutter = side && side.querySelector ? side.querySelector('.mc-diff-gutter-layer') : null;
  if (!gutter) return false;
  var rect = gutter.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
  return Array.prototype.some.call(gutter.querySelectorAll('.mc-diff-gutter-number'), function (row) {
    var rowRect = row.getBoundingClientRect();
    return clientY >= rowRect.top && clientY <= rowRect.bottom;
  });
}

(function wireDiffLineHistoryMenu() {
  var container = document.getElementById('diff2html-container');
  if (!container) return;
  container.addEventListener('contextmenu', function (event) {
    var side = event.target && event.target.closest ? event.target.closest('.d2h-file-side-diff') : null;
    var wrapper = side && side.closest ? side.closest('.d2h-file-wrapper') : null;
    var path = diffBlameWrapperPath(wrapper);
    if (!side || !path || !diffGutterHitAt(side, event.clientX, event.clientY)
      || !window.kakapoGit || typeof window.kakapoGit.blame !== 'function') return;
    event.preventDefault();
    event.stopPropagation();
    showCustomDropdown(event.clientX, event.clientY, [{
      label: t(diffBlameEnabled(path) ? 'menu.hideLineHistory' : 'menu.showLineHistory'),
      onSelect: function () {
        if (diffBlameEnabled(path)) hideDiffBlame(path);
        else showDiffBlame(path);
      },
    }], event.clientY);
  });
  container.addEventListener('click', function (event) {
    var blameEntry = event.target && event.target.closest ? event.target.closest('[data-blame-sha]') : null;
    if (!blameEntry) return;
    event.preventDefault();
    event.stopPropagation();
    if (window.__kakapoHistory && typeof window.__kakapoHistory.openCommit === 'function') {
      window.__kakapoHistory.openCommit(blameEntry.dataset.blameSha, blameEntry.dataset.blamePath || '');
    }
  });
})();
