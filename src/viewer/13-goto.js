
function copyTextToClipboard(text) {
  try { if (window.kakapoClipboard && typeof window.kakapoClipboard.write === 'function') { window.kakapoClipboard.write(text); return true; } } catch (e) {}
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; } } catch (e) {}
  return false;
}

function copyFileAsPatch(path) {
  if (!path) return false;
  if (!window.kakapoGit || typeof window.kakapoGit.filePatch !== 'function') return false;
  Promise.resolve(window.kakapoGit.filePatch(path)).then(function (patch) {
    if (!pageAlive()) return;
    var text = typeof patch === 'string' ? patch : '';
    if (!text.trim()) { showToast(t('patch.none').replace('{path}', path)); return; }
    copyTextToClipboard(text);
    showToast(t('patch.copied').replace('{path}', path));
  }, function () {
    if (pageAlive()) showToast(t('patch.none').replace('{path}', path));
  });
  return true;
}

function compareClipboardWith(path) {
  if (!path) return false;
  if (!window.kakapoClipboard || typeof window.kakapoClipboard.read !== 'function') return false;
  if (!window.kakapoGit || typeof window.kakapoGit.compareClipboard !== 'function') return false;
  var text = '';
  try { text = String(window.kakapoClipboard.read() || ''); } catch (e) { text = ''; }
  if (!text) { showToast(t('clipdiff.empty')); return true; }
  Promise.resolve(window.kakapoGit.compareClipboard(path, text)).then(function (patch) {
    if (!pageAlive()) return;
    var body = typeof patch === 'string' ? patch : '';
    if (!body.trim()) { showToast(t('clipdiff.same').replace('{path}', path)); return; }
    var synthetic = path + ' ↔ clipboard.diff';
    sourceByPath.set(synthetic, {
      path: synthetic,
      name: synthetic,
      language: 'diff',
      content: body,
      size: body.length,
      changed: false,
      embedded: true,
      changedLines: [],
      signature: '',
      library: true,
      __loaded: true,
    });
    openSourceFile(synthetic, true);
  }, function () {
    if (pageAlive()) showToast(t('clipdiff.same').replace('{path}', path));
  });
  return true;
}

function activeReadingPath() {
  if (isSourceViewerVisible()) {
    return sourceOpenPath();
  }
  if (diffCursor && diffCursor.path) return diffCursor.path;
  var wrapper = diffActiveWrapper();
  return wrapper ? (diffWrapperPathKey(wrapper) || '') : '';
}
function copyActiveFileAsPatch() { return copyFileAsPatch(activeReadingPath()); }
function compareClipboardWithFile() { return compareClipboardWith(activeReadingPath()); }

function caretLocation() {
  if (isSourceViewerVisible()) {
    var p = sourceOpenPath();
    if (p && typeof viewerCursor !== 'undefined' && viewerCursor && viewerCursor.path === p) return p + ':' + (viewerCursor.lineIndex + 1);
    if (p) return p;
  }
  if (isDiffViewVisible() && typeof diffCursor !== 'undefined' && diffCursor) {
    var wrap = diffWrapperByPath(diffCursor.path);
    var row = wrap ? diffRowAt(wrap, diffCursor.side, diffCursor.rowIndex) : null;
    var ln = row ? diffLineNumber(row) : null;
    return diffCursor.path + (ln ? ':' + ln : '');
  }
  return '';
}

function copyCaretLocation() {
  var cite = sourceSelectionCitation();
  if (cite) { if (copyTextToClipboard(cite.payload)) showToast(t('goto.copied') + ' ' + cite.reference); return true; }
  var loc = caretLocation();
  if (!loc) return false;
  if (copyTextToClipboard(loc)) showToast(t('goto.copied') + ' ' + loc);
  return true;
}

function gotoDiffLine(n) {
  var path = (typeof diffCursor !== 'undefined' && diffCursor && diffCursor.path) || '';
  if (!path) {
    var w = diffActiveWrapper();
    if (w) path = diffWrapperPathKey(w);
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
  if (isSourceViewerVisible()) {
    var p = sourceOpenPath();
    var f = p && sourceByPath.get(p);
    if (f && f.embedded && typeof f.content === 'string') {
      var max = f.content.split(/\r?\n/).length;
      setSourceCursor(p, Math.max(0, Math.min(max - 1, n - 1)), 0, true, -1);
      return;
    }
  }
  if (isDiffViewVisible()) gotoDiffLine(n);
}

var closeGotoLine = null;
function openGotoLine() {
  if (!isSourceViewerVisible() && !isDiffViewVisible()) return false;
  if (closeGotoLine) closeGotoLine();
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
  function close() {
    box.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    if (closeGotoLine === close) closeGotoLine = null;
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); var n = parseInt(input.value, 10); close(); if (n >= 1) gotoLineJump(n); }
  }
  function onPointerDown(e) {
    if (e.target && box.contains(e.target)) return;
    close();
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  closeGotoLine = close;
  setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
  return true;
}

var closePullRequestPrompt = null;
function openPullRequestPrompt() {
  if (!window.kakapoGit || typeof window.kakapoGit.openPullRequest !== 'function') return false;
  if (closePullRequestPrompt) closePullRequestPrompt();
  var prior = document.getElementById('pr-prompt');
  if (prior) prior.remove();
  var box = document.createElement('div');
  box.id = 'pr-prompt';
  box.className = 'goto-line pr-prompt';
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'goto-line-input pr-prompt-input';
  input.placeholder = t('pr.placeholder');
  var note = document.createElement('div');
  note.className = 'pr-prompt-note';
  box.appendChild(input);
  box.appendChild(note);
  document.body.appendChild(box);

  function close() {
    box.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    if (closePullRequestPrompt === close) closePullRequestPrompt = null;
  }
  function say(message, bad) {
    note.textContent = message;
    note.classList.toggle('pr-prompt-bad', !!bad);
  }
  function submit() {
    var text = (input.value || '').trim();
    if (!text) return;
    say(t('pr.working'), false);
    input.disabled = true;
    Promise.resolve(window.kakapoGit.openPullRequest(text)).then(function (res) {
      if (res && res.ok) {
        close();
        showToast(t('pr.opened', { number: res.number, base: res.base, head: res.head })
          + (res.title ? ' · ' + res.title : ''));
        return;
      }
      input.disabled = false;
      input.focus();
      input.select();
      var error = (res && res.error) || '';
      if (error === 'pr-unreadable') say(t('pr.unreadable'), true);
      else if (error === 'gh-missing') say(t('pr.ghMissing'), true);
      else if (error === 'gh-failed') say(t('pr.ghFailed', { detail: (res && res.detail) || '' }), true);
      else if (error === 'pr-head-missing') say(t('pr.headMissing', { ref: (res && res.ref) || '' }), true);
      else if (error === 'pr-base-missing') say(t('pr.baseMissing', { ref: (res && res.ref) || '' }), true);
      else say(String(error || ''), true);
    }, function () { input.disabled = false; say(t('pr.unreadable'), true); });
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); }
  }
  function onOutside(e) {
    if (e.target && box.contains(e.target)) return;
    close();
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);
  closePullRequestPrompt = close;
  setTimeout(function () { try { input.focus(); } catch (e) {} }, 0);
  return true;
}

function openTreeRowMenu(row) {
  if (!row) return;
  var path = row.dataset.sourceFile || row.dataset.file || '';
  if (!path) return;
  var r = row.getBoundingClientRect();
  var items = [
    { label: t('menu.copyRelativePath'), onSelect: function () { if (copyTextToClipboard(path)) showToast(t('goto.copied') + ' ' + path); } },
  ];
  if (window.kakapoApp && typeof window.kakapoApp.absolutePath === 'function') {
    items.push({ label: t('menu.copyAbsolutePath'), onSelect: function () {
      try {
        Promise.resolve(window.kakapoApp.absolutePath(path)).then(function (result) {
          var absolute = result && result.ok && typeof result.path === 'string' ? result.path : '';
          if (absolute && copyTextToClipboard(absolute)) showToast(t('goto.copied') + ' ' + absolute);
        });
      } catch (e) {}
    } });
  }
  if (window.kakapoGit) {
    items.push({ label: t('menu.fileHistory'), onSelect: function () { openFileHistory(path); } });
  }
  if (window.kakapoApp && typeof window.kakapoApp.revealInFinder === 'function') {
    items.push({ label: t('menu.revealFinder'), onSelect: function () { try { window.kakapoApp.revealInFinder(path); } catch (e) {} } });
  }
  if (window.kakapoApp && typeof window.kakapoApp.openTerminal === 'function') {
    items.push({ label: t('menu.openTerminal'), onSelect: function () { try { window.kakapoApp.openTerminal(path); } catch (e) {} } });
  }
  if (window.kakapoGit && typeof window.kakapoGit.filePatch === 'function') {
    items.push({ label: t('kbd.copyAsPatch'), onSelect: function () { copyFileAsPatch(path); } });
  }
  if (window.kakapoClipboard && typeof window.kakapoClipboard.read === 'function'
    && window.kakapoGit && typeof window.kakapoGit.compareClipboard === 'function') {
    items.push({ label: t('kbd.compareClipboard'), onSelect: function () { compareClipboardWith(path); } });
  }
  var owned = commentSeqsForPath(path);
  if (owned.length) {
    items.push({ label: t('menu.clearComments', { n: owned.length }), onSelect: function () {
      removeComments(owned);
      refreshComments();
      showToast(t('comment.clearedMany', { n: owned.length }));
    } });
  }
  showCustomDropdown(Math.round(r.left + 14), Math.round(r.bottom + 2), items, Math.round(r.top));
}

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
  var openPath = sourceOpenPath();
  if (openPath) openSourceFile(openPath, false, { scrollTree: false });
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
    var painted = cell.querySelector('.source-line-number');
    var label = painted ? painted.textContent : (cell.textContent || String(lineIndex + 1));
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
    if (!rows.length) {
      sourceBlamePath = '';
      sourceBlameAges = new Map();
      clearSourceBlamePaint();
      showCaretHint(t('blame.noHistory'));
      return;
    }
    sourceBlameLines = new Map(rows.map(function (record) { return [Number(record.line), record]; }));
    sourceBlameAges = buildBlameAgeBuckets(rows);
    applySourceBlameIfActive(path);
  }, function () {
    if (seq === sourceBlameLoadSeq) hideSourceBlame(path);
  });
}

function refreshSourceBlamePaint(path) {
  clearSourceBlamePaint();
  applySourceBlameIfActive(path);
}

(function wireSourceLineHistoryMenu() {
  var body = document.getElementById('source-body');
  if (!body) return;
  body.addEventListener('contextmenu', function (event) {
    var number = event.target && event.target.closest ? event.target.closest('.source-row .num') : null;
    var row = number && number.closest ? number.closest('.source-row[data-line-index]') : null;
    var path = sourceOpenPath();
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

var diffBlamePath = '';
var diffBlameLines = { old: null, new: null };
var diffBlameAges = new Map();
var diffBlameLoading = false;
var diffBlameLoadSeq = 0;

function diffBlameEnabled(path) { return !!path && diffBlamePath === path; }

function diffBlameWrapperPath(wrapper) {
  if (!wrapper) return '';
  return diffWrapperPathKey(wrapper);
}

function syncDiffBlameWrapper(wrapper) {
  if (!wrapper || !wrapper.classList) return;
  var reviewWrapper = !!(wrapper.closest && wrapper.closest('#diff2html-container'));
  var active = reviewWrapper && diffBlameEnabled(diffBlameWrapperPath(wrapper));
  wrapper.classList.toggle('mc-diff-blame-loading', active && diffBlameLoading);
  wrapper.classList.toggle('mc-diff-blame-visible', active && !diffBlameLoading && !!diffBlameLines.old && !!diffBlameLines.new);
  wrapper.querySelectorAll('.mc-diff-gutter-layer').forEach(function (layer) {
    layer.setAttribute('aria-hidden', active ? 'false' : 'true');
  });
}

function diffBlameSideName(side, wrapper) {
  var tables = diffSideTables(wrapper);
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
  var wrapper = diffWrapperByPath(path);
  if (!wrapper) return;
  syncDiffBlameWrapper(wrapper);
  refreshLayeredDiffGutters(wrapper);
  invalidateAsymmetricDiffGeometry(wrapper);
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
