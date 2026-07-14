// ===== Go-to-line (Cmd/Ctrl+L), copy caret location (Cmd/Ctrl+K), and the sidebar row action menu. =====

// Programmatic clipboard write. Electron's bridge is reliable on file://; navigator.clipboard is the fallback.
function copyTextToClipboard(text) {
  try { if (window.monacoriClipboard && typeof window.monacoriClipboard.write === 'function') { window.monacoriClipboard.write(text); return true; } } catch (e) {}
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

// Sidebar Opt+Enter: actions for a focused file row (copy path / reveal in Finder).
function openTreeRowMenu(row) {
  if (!row) return;
  var path = row.dataset.sourceFile || row.dataset.file || '';
  if (!path) return;
  var r = row.getBoundingClientRect();
  var items = [
    { label: t('menu.copyPath'), onSelect: function () { if (copyTextToClipboard(path) && typeof showToast === 'function') showToast(t('goto.copied') + ' ' + path); } },
  ];
  if (window.monacoriApp && typeof window.monacoriApp.revealInFinder === 'function') {
    items.push({ label: t('menu.revealFinder'), onSelect: function () { try { window.monacoriApp.revealInFinder(path); } catch (e) {} } });
  }
  showCustomDropdown(Math.round(r.left + 14), Math.round(r.bottom + 2), items, Math.round(r.top));
}
