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
// Inline hint anchored just under the diff caret — used for the F7 "last change" boundary announcement so the
// message appears where the user is looking and fades on its own (unlike the corner toast). Falls back to the
// corner toast when there's no on-screen caret (e.g. source view).
var caretHintEl = null, caretHintTimer = 0;
function showCaretHint(message) {
  var row = activeDiffRow || document.querySelector('#diff2html-container .diff-active-row');
  if (!row || !row.getBoundingClientRect) { showToast(message); return; }
  if (!caretHintEl) { caretHintEl = document.createElement('div'); caretHintEl.className = 'mc-caret-hint'; document.body.appendChild(caretHintEl); }
  caretHintEl.textContent = message;
  var r = row.getBoundingClientRect();
  caretHintEl.style.left = Math.round(Math.max(8, r.left)) + 'px';
  caretHintEl.style.top = Math.round(r.bottom + 4) + 'px';
  caretHintEl.classList.remove('show');
  void caretHintEl.offsetWidth; // reflow so the fade-in re-triggers on rapid repeat presses
  caretHintEl.classList.add('show');
  if (caretHintTimer) clearTimeout(caretHintTimer);
  caretHintTimer = setTimeout(function () { if (caretHintEl) caretHintEl.classList.remove('show'); }, 2000);
}
function hideCaretHint() {
  if (caretHintTimer) { clearTimeout(caretHintTimer); caretHintTimer = 0; }
  if (caretHintEl) caretHintEl.classList.remove('show');
}
// Follow each comment to its snapshot line (c.code) in the current content: same line if unchanged, else the
// nearest exact match of that line. A comment is NEVER auto-deleted. If its line can't be found we leave it
// where it is — this happens routinely WITHOUT the file changing: a comment anchored to a deleted/old-side
// diff line (comments carry no side, so old-side text never matches the new content) would otherwise vanish.
// Silently dropping user-authored comments loses data; the reviewer can remove a stale one with the × button.
// Files whose content isn't loaded yet (lazy) are skipped here and reconciled after loadSourceFile resolves.
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
// Monochrome inline icons for the two comment kinds: a help-circle for questions, a pencil for change
// requests (the pencil path matches the activity-rail "c" button). No emoji, no color — stroke=currentColor
// so the kind pill stays monotone (.mc-kind in viewer.css); the icon, not the color, distinguishes q vs c.
function commentKindIcon(kind) {
  var path = kind === 'q'
    ? '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 0 1 5.2 1c0 1.8-2.6 2.4-2.6 2.4"/><line x1="12" y1="16.7" x2="12.01" y2="16.7"/>'
    : '<path d="M14.5 5.5l4 4"/><path d="M4.5 19.5l1-4 10-10 3 3-10 10z"/>';
  return '<svg class="mc-kind-ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
}
// Full inner HTML for a .mc-kind pill: monochrome icon + the (localized) label.
function commentKindHtml(kind) {
  return commentKindIcon(kind) + '<span class="mc-kind-text">' + escapeHtml(commentKindLabel(kind)) + '</span>';
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
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml(c.kind) + '</span>'
      + '<button type="button" class="mc-del" data-seq="' + c.seq + '" title="' + escapeHtml(t('composer.delete')) + '">×</button></div>'
      + '<div class="mc-card-body">' + escapeHtml(c.text) + '</div></div>';
  });
  if (composerState && composerState.path === path && composerState.line === line) {
    var ph = composerState.kind === 'q' ? t('composer.question') : t('composer.changeRequest');
    html += '<div class="mc-card mc-' + composerState.kind + ' mc-composer">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml(composerState.kind) + '</span><span class="mc-target" title="' + escapeHtml(composerState.path || '') + '">' + escapeHtml(composerTargetLabel(composerState)) + '</span></div>'
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

// Per-file comment counts as small (no-emoji) badges in BOTH sidebars — appended after the compact
// Changes row and after the file name in the Files tree.
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
      var ref = refSelector ? row.querySelector(refSelector) : null;
      if (ref) row.insertBefore(makeBadge(k), ref); else row.appendChild(makeBadge(k));
    });
  }
  inject('.change-row', 'file', '');
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
  if (typeof isMonacoSourceActive === 'function' && isMonacoSourceActive() && window.monaco) {
    var monacoCommentFile = sourceByPath.get(monacoSourcePath);
    if (monacoCommentFile) refreshMonacoSourceDecorations(window.monaco, monacoCommentFile);
  }
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
  // Monaco's Code mode is optimized for navigation and virtualized reading; line-comment cards live in
  // Review mode. Preserve the Monaco caret, switch the same file back, then open the normal composer.
  if (typeof isMonacoSourceActive === 'function' && isMonacoSourceActive()) switchMonacoToReviewAtCursor();
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
  return t(kind === 'q' ? 'mergePrompt.default.q' : kind === 'plan' ? 'plan.contract' : 'mergePrompt.default.c');
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
  // Change requests are task instructions, so they lead with the plan contract: plan first, decompose into
  // verifiable steps, write the plan to .monacori/plan.md (editable in Settings → Merge prompts). Questions
  // are read-only clarifications, so they skip it.
  if (kind === 'c') { lines.push(mergePromptFor('plan')); lines.push(''); }
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
