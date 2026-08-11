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
function showCaretHint(message, anchor) {
  // Anchor to the caret in the VISIBLE view. Both the source and diff carets persist in the DOM, so the
  // hidden view's .code-cursor is still queryable — and while it is display:none its rect is all-zero, which
  // would pin the hint at the window's top-left, over the macOS traffic lights. Gate candidates by which view
  // is actually showing (the .hidden class), not by geometry, so this is right even without layout.
  var candidates;
  if (anchor) {
    candidates = [anchor];
  } else {
    var srcOnly = typeof isSourceViewerVisible === 'function' && isSourceViewerVisible();
    var diffShown = typeof isDiffViewVisible !== 'function' || isDiffViewVisible();
    candidates = srcOnly
      ? [document.querySelector('#source-body .code-cursor')]
      : diffShown
        ? [document.querySelector('#diff2html-container .code-cursor'), activeDiffRow, document.querySelector('#diff2html-container .diff-active-row')]
        : [document.querySelector('#source-body .code-cursor'), document.querySelector('#diff2html-container .code-cursor'), activeDiffRow, document.querySelector('#diff2html-container .diff-active-row')];
  }
  var row = null;
  for (var i = 0; i < candidates.length; i++) { if (candidates[i]) { row = candidates[i]; break; } }
  if (!row || (!row.getBoundingClientRect && !Number.isFinite(Number(row.bottom)))) { showToast(message); return; }
  if (!caretHintEl) { caretHintEl = document.createElement('div'); caretHintEl.className = 'mc-caret-hint'; document.body.appendChild(caretHintEl); }
  caretHintEl.textContent = message;
  var r = row.getBoundingClientRect ? row.getBoundingClientRect() : row;
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
// Is a comment's anchor line (its snapshot of the commented text) present in the file's current content?
// Used both when a comment is created (to record that the line was real then) and on every rebuild. A blank
// or multi-line snapshot has no stable single-line anchor and reports false.
function anchorLinePresent(path, anchorCode, code) {
  var file = sourceByPath.get(path);
  if (!file || !file.embedded || typeof file.content !== 'string' || !file.content) return false;
  var ac = String(anchorCode == null ? (code == null ? '' : code) : anchorCode);
  if (!ac.trim() || ac.indexOf('\n') >= 0) return false;
  return file.content.split(/\r?\n/).indexOf(ac) >= 0;
}
// Reconcile comments against the current content after a rebuild (the AI's next round) or a source load.
// Two jobs:
//  1. Follow each comment to its anchor line: same line if unchanged, else the nearest exact match. A comment
//     is NEVER auto-deleted. If its line can't be found we leave it — this happens routinely WITHOUT a change:
//     a comment on a deleted/old-side diff line never matches the new content and would otherwise vanish.
//  2. Track resolution across rounds: a comment whose anchor line WAS present but has now disappeared was very
//     likely acted on by the agent, so mark it addressed (a candidate, not a deletion — the reviewer reopens
//     if the heuristic was wrong). anchorPresent is set at creation so the first round is not missed; an
//     old-side anchor is never present, so it never flips to addressed.
// Files whose content isn't loaded yet (lazy) are skipped here and reconciled after loadSourceFile resolves.
function remapComments() {
  if (!reviewComments.length) return;
  var changed = 0;
  reviewComments.forEach(function (c) {
    var file = sourceByPath.get(c.path);
    if (!file || !file.embedded || typeof file.content !== 'string' || !file.content) return;
    var code = c.anchorCode != null ? String(c.anchorCode) : (c.code == null ? '' : String(c.code));
    if (code.indexOf('\n') >= 0) return; // legacy multi-line snapshots had no stable anchor line
    if (!code.trim()) return;
    var lines = file.content.split(/\r?\n/);
    var present;
    if (lines[c.line - 1] === code) {
      present = true; // unchanged at its current line
    } else {
      var best = -1, bestDist = Infinity;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i] === code) { var d = Math.abs(i - (c.line - 1)); if (d < bestDist) { bestDist = d; best = i; } }
      }
      present = best >= 0;
      if (present && c.line !== best + 1) {
        var delta = (best + 1) - c.line;
        c.line = best + 1;
        if (Number.isFinite(Number(c.from))) c.from = Number(c.from) + delta;
        if (Number.isFinite(Number(c.to))) c.to = Number(c.to) + delta;
        changed++;
      }
    }
    if (present) {
      if (!c.anchorPresent) { c.anchorPresent = true; changed++; } // confirm the anchor is real in this content
    } else if (c.anchorPresent && !c.addressed) {
      c.addressed = true; // the commented line is gone in the new content — the agent likely addressed it
      changed++;
    }
  });
  if (!changed) return; // nothing moved or re-flagged — skip the save/re-render
  saveComments();
  refreshComments();
}
function saveComments() {
  persistSave(COMMENTS_KEY, reviewComments);
}
function hasProjectExistenceBridge() {
  return !!(window.kakapoFile && typeof window.kakapoFile.existingPaths === 'function');
}
function commentFileIsKnownMissing(path) {
  var file = sourceByPath.get(path);
  if (file) {
    return file.vcs === 'deleted' || /not present in the working tree/i.test(String(file.skippedReason || ''));
  }
  // The desktop project index intentionally excludes some existing tool/config paths. Only browser/static
  // reviews can treat absence from an authoritative full index as deletion; Electron asks main directly.
  return !hasProjectExistenceBridge() && !!projectIndexLoaded;
}
function removeCommentsForPaths(paths) {
  var missing = new Set(Array.isArray(paths) ? paths : []);
  if (!missing.size) return 0;
  var removed = reviewComments.filter(function (comment) { return missing.has(comment.path); });
  if (!removed.length) return 0;
  reviewComments = reviewComments.filter(function (comment) { return !missing.has(comment.path); });
  saveComments();
  try {
    document.dispatchEvent(new CustomEvent('kakapo:comments-pruned', { detail: { comments: removed } }));
  } catch (e) {}
  return removed.length;
}
function pruneCommentsForMissingFiles() {
  var missing = [];
  reviewComments.forEach(function (comment) {
    if (commentFileIsKnownMissing(comment.path) && missing.indexOf(comment.path) < 0) missing.push(comment.path);
  });
  return removeCommentsForPaths(missing);
}
function verifyCommentFilesExist() {
  var paths = [];
  reviewComments.forEach(function (comment) { if (paths.indexOf(comment.path) < 0) paths.push(comment.path); });
  if (!paths.length) return Promise.resolve(0);
  if (hasProjectExistenceBridge()) {
    return Promise.resolve(window.kakapoFile.existingPaths(paths)).then(function (result) {
      if (!result || typeof result !== 'object') return 0;
      return removeCommentsForPaths(paths.filter(function (path) { return result[path] === false; }));
    }, function () { return 0; });
  }
  return ensureProjectIndex().then(function () { return pruneCommentsForMissingFiles(); }, function () { return 0; });
}
function commentsAt(path, line) {
  return reviewComments.filter(function (c) { return c.path === path && c.line === line; });
}
function commentKindLabel(kind) {
  return kind === 'q' ? t('comment.kind.q') : t('comment.kind.c');
}
// Monochrome inline icons for the two comment kinds: a help-circle for questions, a pencil for change
// requests. No emoji, no color — stroke=currentColor so the kind pill stays monotone (.mc-kind in
// viewer.css); the icon, not the color, distinguishes q vs c.
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
  annotationLines(path, set); // agent-written notes share the same thread rows (23-annotations.js)
  return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
}
function addComment(kind, path, line, code, text, from, to, side, anchorCode, replyTo) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return;
  commentSeq += 1;
  var hasFrom = from != null && from !== '' && Number.isFinite(Number(from));
  var hasTo = to != null && to !== '' && Number.isFinite(Number(to));
  var start = hasFrom ? Number(from) : Number(line);
  var end = hasTo ? Number(to) : Number(line);
  if (start > end) { var swap = start; start = end; end = swap; }
  reviewComments.push({
    seq: commentSeq, kind: kind, path: path, line: line, code: String(code || ''), text: trimmed,
    from: start, to: end, side: side || null, anchorCode: String(anchorCode == null ? code || '' : anchorCode),
    // Record whether the anchor line exists now so a later rebuild can tell "the line I commented on changed"
    // from "this old-side anchor was never in the working tree". addressed starts false.
    anchorPresent: anchorLinePresent(path, anchorCode, code), addressed: false,
    // Filled in by applyAnswersUpdate() once an agent writes into answers.json (see 08-dock.js/answers-ipc.ts).
    answer: null, answeredAt: null,
    // Set when this comment continues an existing exchange (the Reply button on an answered card). The
    // follow-up is a full comment of its own — own seq, own answer — that carries its ancestors' Q&A to the
    // agent as context, so "why did you do it that way?" isn't handed over with the question stripped off.
    replyTo: replyTo == null ? null : Number(replyTo),
  });
  saveComments();
}
// The whole exchange a comment continues, oldest turn first: any agent note on its line, then each ancestor
// comment with the answer it got. Both ends of the hand-off use it (the quoted lines in mergedItemLines and
// the `thread` field of the answers checklist in 08-dock.js), so the agent writes the next reply knowing
// every earlier turn. A note has no question of its own, so its turn carries a null prompt — without it a
// reply opened from an explain card reached the agent as a bare "why that way?" with no "that way".
function commentThreadContext(comment) {
  var turns = [];
  if (typeof annotationsAt === 'function') {
    annotationsAt(comment.path, comment.line).forEach(function (note) { turns.push({ prompt: null, answer: note.text }); });
  }
  commentAncestry(comment).forEach(function (parent) { turns.push({ prompt: parent.text, answer: parent.answer || null }); });
  return turns;
}
// Walk a comment's reply chain back to its root, oldest exchange first. Used to give an agent the
// conversation a follow-up belongs to (see the answers payload in 08-dock.js) and to indent the thread.
function commentAncestry(comment) {
  var chain = [], guard = 0, node = comment;
  while (node && node.replyTo != null && ++guard < 50) {
    var parent = reviewComments.find(function (x) { return x.seq === node.replyTo; });
    if (!parent) break;
    chain.unshift(parent);
    node = parent;
  }
  return chain;
}
// The reviewer disagrees with the "possibly addressed" heuristic: reopen the comment. Clear anchorPresent too
// so it only becomes addressed again if its anchor first reappears and then disappears in a future round.
function reopenComment(seq) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c || !c.addressed) return;
  c.addressed = false;
  c.anchorPresent = false;
  saveComments();
  refreshComments();
}
// Edit an existing comment in place (e on a selected box -> composer prefilled -> save). Empty text deletes it.
function updateComment(seq, text) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  var trimmed = String(text || '').trim();
  if (trimmed) { c.text = trimmed; saveComments(); }
  else { deleteComment(seq); }
}
// Session-only undo stack for comment removal (Cmd/Ctrl+Z, see 05-keymap.js). Deletion became one keystroke
// away from the merged panel's Enter->navigate+edit flow, so an accidental Backspace at the destination
// needs a safety net. Each entry is the full batch removed together (deleteCommentsInRow removes every
// comment on a row in one Backspace), so one undo restores exactly what one deletion removed.
var commentUndoStack = [];
function removeComments(seqs) {
  var removed = reviewComments.filter(function (c) { return seqs.indexOf(c.seq) !== -1; });
  if (!removed.length) return;
  commentUndoStack.push(removed);
  if (commentUndoStack.length > 20) commentUndoStack.shift();
  reviewComments = reviewComments.filter(function (c) { return seqs.indexOf(c.seq) === -1; });
  saveComments();
}
function deleteComment(seq) {
  removeComments([seq]);
  refreshComments();
}
// Cmd/Ctrl+Z outside any native text-editing surface: restore the last removed comment(s). Returns false
// (a no-op) when the stack is empty, so the caller can decide not to swallow the key in that case.
function undoLastCommentRemoval() {
  var batch = commentUndoStack.pop();
  if (!batch || !batch.length) return false;
  reviewComments = reviewComments.concat(batch);
  saveComments();
  refreshComments();
  showToast(t(batch.length > 1 ? 'comment.restoredMany' : 'comment.restored'));
  return true;
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
      var rangeFile = sourceByPath.get(viewerCursor.path);
      var rangeLines = rangeFile && typeof rangeFile.content === 'string' ? rangeFile.content.split(/\r?\n/) : [];
      return { path: viewerCursor.path, line: t + 1, code: selText, anchorCode: rangeLines[t] || '', from: f + 1, to: t + 1, side: null };
    }
    var scaretFile = sourceByPath.get(viewerCursor.path);
    var scaretCode = (scaretFile && typeof scaretFile.content === 'string') ? (scaretFile.content.split(/\r?\n/)[viewerCursor.lineIndex] || '') : '';
    return { path: viewerCursor.path, line: viewerCursor.lineIndex + 1, code: scaretCode, anchorCode: scaretCode, from: null, to: null, side: null };
  }
  // Diff view: prefer the explicit diff caret when there is no text selection.
  if (!hasSel && diffCursor && isDiffViewVisible()) {
    var dwrap = diffWrapperByPath(diffCursor.path);
    var drow = dwrap ? diffRowAt(dwrap, diffCursor.side, diffCursor.rowIndex) : null;
    var dline = drow ? diffLineNumber(drow) : null;
    if (dline != null) return { path: diffCursor.path, line: dline, code: diffLineText(drow) || '', anchorCode: diffLineText(drow) || '', from: null, to: null, side: null };
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
  return { path: path, line: toLine, code: hasSel ? selText : '', anchorCode: diffLineText(toRow) || '', from: hasSel ? Math.min(fromLine, toLine) : null, to: hasSel ? Math.max(fromLine, toLine) : null, side: side };
}

// One location syntax everywhere: @project/relative/path#L53 or @project/relative/path#L50-60.
// Older persisted comments have only `line`; treating it as both ends keeps them display-compatible.
function commentTargetLabel(s) {
  var line = Math.max(1, Number(s && s.line) || 1);
  var from = Math.max(1, Number(s && s.from) || line);
  var to = Math.max(1, Number(s && s.to) || line);
  if (from > to) { var swap = from; from = to; to = swap; }
  return '@' + String(s && s.path || '') + '#L' + from + (to !== from ? '-' + to : '');
}
// An agent writes markdown — bold, lists, fenced code, mermaid — so render it, the same way agent
// annotations already do. Escaping it left "**워밍스타트 씨앗**" and "1." literally on screen. Falls back to
// escaped text if the markdown runtime is unavailable (browser/static builds without it).
function agentBodyHtml(text) {
  if (typeof annotationBodyHtml === 'function') {
    try { return annotationBodyHtml(text); } catch (e) { /* fall through to plain text */ }
  }
  return '<div class="mc-answer-plain">' + escapeHtml(text) + '</div>';
}
// Rendered inside a comment's .mc-card, right after .mc-card-body, once an agent has written an answer
// into answers.json (see applyAnswersUpdate below). Empty string — nothing rendered — until then.
function commentAnswerHtml(c) {
  if (!c || !c.answer) return '';
  // The answer is where the exchange usually continues — "so why not X?", "then do Y instead". Put Reply on
  // the answer itself so the follow-up is one click from what it answers, rather than making the reviewer
  // scroll back up to the question's own header to find the same button.
  return '<div class="mc-card-answer"><span class="mc-answer-label">' + escapeHtml(t('comment.answer')) + '</span>'
    + '<button type="button" class="mc-reply mc-answer-reply" data-seq="' + c.seq + '"'
    + ' aria-label="' + escapeHtml(t('comment.reply')) + '" title="' + escapeHtml(t('comment.reply')) + '">↩</button>'
    + '<div class="mc-answer-body markdown-body mc-ai-body">' + agentBodyHtml(c.answer) + '</div></div>';
}
function threadHtml(path, line) {
  // Agent notes first: they explain the code the reviewer is about to comment on.
  var html = annotationsThreadHtml(path, line);
  commentsAt(path, line).forEach(function (c) {
    if (composerState && composerState.editSeq === c.seq) return; // being edited -> rendered as the composer below
    var target = commentTargetLabel(c);
    var addressed = !!c.addressed;
    html += '<div class="mc-card mc-' + c.kind + (addressed ? ' mc-addressed' : '') + (c.replyTo != null ? ' mc-reply-card' : '') + '">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml(c.kind) + '</span>'
      + '<span class="mc-target" title="' + escapeHtml(target) + '">' + escapeHtml(target) + '</span>'
      + (addressed ? '<span class="mc-addressed-tag" title="' + escapeHtml(t('comment.addressed.hint')) + '">' + escapeHtml(t('comment.addressed')) + '</span>' : '')
      + (addressed ? '<button type="button" class="mc-reopen" data-seq="' + c.seq + '" aria-label="' + escapeHtml(t('comment.reopen')) + '" title="' + escapeHtml(t('comment.reopen')) + '">↺</button>' : '')
      + '<button type="button" class="mc-reply" data-seq="' + c.seq + '" aria-label="' + escapeHtml(t('comment.reply')) + '" title="' + escapeHtml(t('comment.reply')) + '">↩</button>'
      + '<button type="button" class="mc-del" data-keyhint="Del" data-seq="' + c.seq + '" aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">×</button></div>'
      + '<div class="mc-card-body">' + escapeHtml(c.text) + '</div>' + commentAnswerHtml(c) + '</div>';
  });
  if (composerState && composerState.path === path && composerState.line === line) {
    var ph = composerState.replyTo != null ? t('composer.reply')
      : composerState.kind === 'q' ? t('composer.question') : t('composer.changeRequest');
    html += '<div class="mc-card mc-' + composerState.kind + ' mc-composer' + (composerState.replyTo != null ? ' mc-reply-card' : '') + '">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml(composerState.kind) + '</span><span class="mc-target" title="' + escapeHtml(commentTargetLabel(composerState)) + '">' + escapeHtml(commentTargetLabel(composerState)) + '</span></div>'
      // spellcheck/autocorrect/autocapitalize off: a code-review comment carries identifiers and symbols that
      // macOS/Chromium text substitution mangles (foo_bar -> foo bar, capitalizing names) — and that OS-level
      // autocorrect is the leading suspect for a space being swallowed right after punctuation like "?".
      + '<textarea class="mc-input" rows="3" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="' + escapeHtml(ph) + '">' + escapeHtml(composerState.editText || '') + '</textarea>'
      + '<div class="mc-actions"><button type="button" class="mc-btn mc-save" data-keyhint="⌘↵">' + escapeHtml(t('composer.save')) + '</button>'
      + '<button type="button" class="mc-btn mc-ghost mc-cancel" data-keyhint="Esc">' + escapeHtml(t('composer.cancel')) + '</button>'
      + '<span class="mc-hint">' + escapeHtml(t('composer.hint')) + '</span></div></div>';
  }
  return html;
}

function injectThreadRow(anchorRow, path, line) {
  if (!anchorRow || !anchorRow.parentNode) return null;
  var tr = document.createElement('tr');
  tr.className = 'mc-comment-row';
  var td = document.createElement('td');
  // source/markdown/csv rows can have >2 cells (csv); span them all. diff (d2h) rows stay 2.
  td.colSpan = (anchorRow.classList && anchorRow.classList.contains('source-row')) ? (anchorRow.children.length || 2) : 2;
  td.className = 'mc-thread-cell';
  td.innerHTML = threadHtml(path, line);
  tr.appendChild(td);
  anchorRow.parentNode.insertBefore(tr, anchorRow.nextSibling);
  return tr;
}

// A diff comment is visible only in the working-tree pane, but its vertical space belongs to the shared
// review timeline. Reserve the exact same height in the base pane so semantic anchors, connector curves,
// and the one line-number layer never learn a false offset from opening/closing a comment.
function injectDiffCommentSpacer(anchorRow, line) {
  if (!anchorRow || !anchorRow.parentNode) return null;
  var tr = document.createElement('tr');
  tr.className = 'mc-spacer-row mc-comment-spacer-row';
  tr.dataset.commentSlot = String(line);
  tr.setAttribute('aria-hidden', 'true');
  var td = document.createElement('td');
  td.colSpan = 2;
  var spacer = document.createElement('div');
  spacer.className = 'mc-comment-spacer';
  td.appendChild(spacer);
  tr.appendChild(td);
  anchorRow.parentNode.insertBefore(tr, anchorRow.nextSibling);
  return tr;
}

function syncDiffCommentSpacerHeights(wrapper) {
  if (!wrapper) return false;
  var sides = wrapper.querySelectorAll('.d2h-file-side-diff');
  if (sides.length < 2) return false;
  var oldSpacers = {};
  sides[0].querySelectorAll('.mc-comment-spacer-row').forEach(function (row) {
    oldSpacers[row.dataset.commentSlot || ''] = row;
  });
  var changed = false;
  sides[sides.length - 1].querySelectorAll('.mc-comment-row[data-comment-slot]').forEach(function (row) {
    var peer = oldSpacers[row.dataset.commentSlot || ''];
    var spacer = peer && peer.querySelector('.mc-comment-spacer');
    if (!spacer) return;
    var rect = row.getBoundingClientRect();
    var height = Math.max(Number(rect.height) || 0, Number(row.offsetHeight) || 0);
    if (!height) return; // jsdom/hidden wrapper: the next visible layout pass will provide a real height.
    var next = Math.ceil(height * 100) / 100;
    if (Math.abs((parseFloat(spacer.style.height) || 0) - next) <= 0.25) return;
    spacer.style.height = next + 'px';
    changed = true;
  });
  return changed;
}

function renderDiffComments() {
  var container = document.getElementById('diff2html-container');
  if (!container) return [];
  var affected = [];
  var remember = function (wrapper) {
    if (wrapper && affected.indexOf(wrapper) < 0) affected.push(wrapper);
  };
  var commentsByPath = {};
  reviewComments.forEach(function (comment) {
    (commentsByPath[comment.path] || (commentsByPath[comment.path] = [])).push(comment);
  });
  container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
    var nameEl = w.querySelector('.d2h-file-name');
    var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
    if (!path) return;
    var pathComments = commentsByPath[path] || [];
    var activeComposer = composerState && composerState.path === path ? composerState : null;
    var renderKey = JSON.stringify({
      comments: pathComments.map(function (comment) {
        return [comment.seq, comment.kind, comment.line, comment.from, comment.to, comment.text, comment.answer, comment.answeredAt];
      }),
      composer: activeComposer
        ? [activeComposer.kind, activeComposer.line, activeComposer.from, activeComposer.to, activeComposer.editSeq, activeComposer.editText || '']
        : null,
      annotations: annotationRenderKey(path),
    });
    var lines = relevantLines(path);
    var existingRows = w.querySelectorAll('.mc-comment-row');
    var existingSpacers = w.querySelectorAll('.mc-comment-spacer-row');
    // A watch/lazy body swap can remove rows without changing comment data. Count expected timeline slots as
    // part of the cache validity check so that a newly materialized table still receives its comments.
    if (w.__mcDiffCommentRenderKey === renderKey && existingRows.length === lines.length && existingSpacers.length === lines.length) return;
    w.__mcDiffCommentRenderKey = renderKey;
    if (!lines.length && !existingRows.length && !existingSpacers.length) return;
    w.querySelectorAll('.mc-comment-row, .mc-comment-spacer-row').forEach(function (row) { row.remove(); });
    remember(w);
    if (!lines.length) return;
    var sides = w.querySelectorAll('.d2h-file-side-diff');
    var right = sides[sides.length - 1];
    var left = sides[0];
    if (!right || !left || right === left) return;
    var rows = Array.prototype.slice.call(right.querySelectorAll('tr')).filter(function (row) {
      return !row.classList.contains('mc-comment-row') && !row.classList.contains('mc-spacer-row');
    });
    var leftRows = Array.prototype.slice.call(left.querySelectorAll('tr')).filter(function (row) {
      return !row.classList.contains('mc-comment-row') && !row.classList.contains('mc-spacer-row');
    });
    lines.forEach(function (line) {
      for (var i = 0; i < rows.length; i++) {
        var num = rows[i].querySelector('.d2h-code-side-linenumber');
        if (num && (num.textContent || '').trim() === String(line)) {
          var commentRow = injectThreadRow(rows[i], path, line);
          if (commentRow) commentRow.dataset.commentSlot = String(line);
          if (leftRows[i]) injectDiffCommentSpacer(leftRows[i], line);
          break;
        }
      }
    });
    syncDiffCommentSpacerHeights(w);
  });
  return affected;
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
  var changedDiffWrappers = renderDiffComments();
  // Reproject ONLY wrappers whose comment rows changed. The previous all-files loop measured every row in
  // every materialized diff on each keystroke/save/cancel, which became severe UI jank in large reviews.
  changedDiffWrappers.forEach(function (wrapper) {
    if (!wrapper.querySelector('.mc-layered-diff-side')) return;
    syncDiffCommentSpacerHeights(wrapper);
    invalidateAsymmetricDiffGeometry(wrapper);
    if (wrapper === (typeof diffActiveWrapper === 'function' ? diffActiveWrapper() : null)) {
      refreshLayeredDiffGutters(wrapper);
    } else {
      scheduleLayeredDiffGutters(wrapper);
    }
  });
  // A removed comment must not leave the previous base transform or connector geometry on screen until the
  // next user scroll. Recompute the active timeline in this same update, after both pane heights match.
  if (changedDiffWrappers.length && typeof scrollAsymmetricDiff === 'function') scrollAsymmetricDiff();
  if (isSourceViewerVisible()) renderSourceComments();
  renderCommentBadges();
  applyCommentSelectionHighlight();
  // Every agent-written body can carry Mermaid diagrams — a note AND an answer (commentAnswerHtml renders the
  // same markdown). Gating this on a note existing left a diagram inside an answer stuck on "loading…" forever
  // in any review the agent had not also annotated. Already-rendered placeholders are skipped inside, so this
  // stays a no-op scan on an ordinary refresh (see renderMermaidDiagrams in 20-mermaid.js).
  try { renderMermaidDiagrams(document); } catch (e) {}
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
  composerState = { kind: kind, path: target.path, line: target.line, code: target.code, anchorCode: target.anchorCode, from: target.from, to: target.to, side: target.side };
  // Keep the dragged code visibly highlighted via the .mc-sel-line class (applyCommentSelectionHighlight),
  // and clear the native selection so its highlight doesn't bleed into the composer/cards below it.
  try { var psel = window.getSelection(); if (psel) psel.removeAllRanges(); } catch (e) {}
  refreshComments(); // refreshComments syncs body.mc-composing from the on-screen composer

}
// Continue an exchange from the card itself (the Reply button), instead of hunting the code line down again
// and writing what reads as an unrelated new comment. The reply inherits the parent's anchor, so it lives in
// the same thread and travels with it; kind is inherited too (a follow-up to a question is still a question).
function openReplyComposer(seq) {
  var parent = reviewComments.find(function (x) { return x.seq === seq; });
  if (!parent) return;
  composerState = {
    kind: parent.kind, path: parent.path, line: parent.line, code: parent.code, anchorCode: parent.anchorCode,
    from: parent.from, to: parent.to, side: parent.side, replyTo: parent.seq,
  };
  try { var rsel = window.getSelection(); if (rsel) rsel.removeAllRanges(); } catch (e) {}
  refreshComments();
}
// Replying to an agent note. There is no parent comment to inherit an anchor from — the note is not a
// comment — so the composer anchors to the note's own line, which is what puts the reply directly under it
// in the same thread (threadHtml renders notes first, then the comments for that line). A question is the
// register a follow-up to an explanation is almost always in.
function openAnnotationReplyComposer(path, line) {
  if (!path || !(line > 0)) return;
  composerState = { kind: 'q', path: path, line: line };
  try { var asel = window.getSelection(); if (asel) asel.removeAllRanges(); } catch (e) {}
  refreshComments();
}
function closeComposer() {
  if (!composerState) return;
  composerState = null;
  refreshComments();
  flushPendingDiffUpdate(); // apply any live watch refresh that was held while composing
}
// After Esc-closing the composer, return keyboard focus to the code caret (diff or source) so arrows keep
// moving it. Without this the textarea is removed, focus falls away, and the side tree (which owns arrows
// while treeFocusIndex >= 0) captures navigation — the "focus jumped to the side panel" surprise.
function returnCaretAfterComposer() {
  if (typeof clearTreeFocus === 'function') clearTreeFocus();
  if (typeof isDiffViewVisible === 'function' && isDiffViewVisible() && typeof diffCursor !== 'undefined' && diffCursor && typeof setDiffCursor === 'function') {
    setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, diffCursor.column, false);
  } else if (typeof isSourceViewerVisible === 'function' && isSourceViewerVisible() && typeof viewerCursor !== 'undefined' && viewerCursor && typeof setSourceCursor === 'function') {
    setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, viewerCursor.column, false);
  }
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
  else addComment(composerState.kind, composerState.path, composerState.line, composerState.code, box.value, composerState.from, composerState.to, composerState.side, composerState.anchorCode, composerState.replyTo);
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
var mergePromptsKey = 'kakapo-merge-prompts';
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
function showCustomDropdown(x, y, options, flipTop, className) {
  var existing = document.getElementById('mc-dropdown');
  if (existing) existing.remove();
  var dd = document.createElement('div');
  dd.id = 'mc-dropdown';
  dd.className = 'mc-dropdown' + (className ? ' ' + className : '');
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
// Open `path` in the source view and land the caret on `line` (1-based). The shared tail of every
// "jump to an anchor" path — review comments below, agent notes in 23-annotations.js.
function navigateToLine(path, line) {
  openSourceFile(path);
  requestAnimationFrame(function () { setSourceCursor(path, Math.max(0, (Number(line) || 1) - 1), 0, true, -1); });
}
function navigateToComment(seq) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  if (commentFileIsKnownMissing(c.path)) {
    removeCommentsForPaths([c.path]);
    refreshComments();
    return;
  }
  navigateToLine(c.path, Number(c.from) || c.line || 1);
}
// Merged-panel Enter on a selected comment card: navigate to the comment's source location AND land
// straight in its edit composer, combining what "Navigate" + a manual "E" press would do separately.
// Reuses navigateToComment's exact timing (one requestAnimationFrame after openSourceFile) and
// editCommentInRow's composerState shape (10-source-view.js) — refreshComments() already retry-focuses
// the composer textarea itself, so no extra focus plumbing is needed here.
function navigateToCommentAndEdit(seq) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  if (commentFileIsKnownMissing(c.path)) {
    removeCommentsForPaths([c.path]);
    refreshComments();
    return;
  }
  openSourceFile(c.path);
  requestAnimationFrame(function () {
    setSourceCursor(c.path, Math.max(0, (Number(c.from) || c.line || 1) - 1), 0, true, -1);
    composerState = {
      kind: c.kind, path: c.path, line: c.line, code: c.code, anchorCode: c.anchorCode,
      from: c.from, to: c.to, side: c.side, editSeq: seq, editText: c.text,
    };
    refreshComments();
  });
}

// Cmd+F7 / Shift+Cmd+F7 (05-keymap.js): step between comments the same way F7/Shift+F7 steps between diff
// hunks. path -> first-seen hunk index, walking hunkPathAt in the exact order F7 already traverses (NOT
// sourceFiles' plain alphabetical order, and NOT the sidebar tree's directory-grouped order) so "next
// comment" moves top-to-bottom the way the reviewer sees the diff. Cheap enough (a handful of array reads,
// same as one F7 press) to recompute on every call rather than cache/invalidate.
function commentNavOrder() {
  var order = {};
  if (typeof hunkTotal !== 'function' || typeof hunkPathAt !== 'function') return order;
  var next = 0;
  for (var i = 0; i < hunkTotal(); i++) {
    var p = hunkPathAt(i);
    if (p && !(p in order)) order[p] = next++;
  }
  return order;
}
// commentNavOrder ranks only files the DIFF contains, which is all F8 needed while every comment was
// anchored to a change. An agent's codebase map is not: its notes sit in files that are not part of this
// diff at all, and those all collapsed to rank Infinity — so the walk had no order among them, and
// stepAnchor, finding the current file unranked, answered every press with the first item. Extend the order
// with the files the list itself names, in path order, so every anchor has a place.
function navOrderFor(list) {
  var order = commentNavOrder();
  var next = 0;
  for (var key in order) if (order[key] >= next) next = order[key] + 1;
  var extra = [];
  for (var i = 0; i < list.length; i++) {
    var path = list[i] && list[i].path;
    if (path && !(path in order) && extra.indexOf(path) < 0) extra.push(path);
  }
  extra.sort().forEach(function (path) { order[path] = next++; });
  return order;
}
function sortedNavComments() {
  var order = commentNavOrder();
  return reviewComments.slice().sort(function (a, b) {
    var oa = a.path in order ? order[a.path] : Infinity;
    var ob = b.path in order ? order[b.path] : Infinity;
    if (oa !== ob) return oa - ob;
    var la = Number(a.from) || a.line || 0, lb = Number(b.from) || b.line || 0;
    if (la !== lb) return la - lb;
    return a.seq - b.seq;
  });
}
// Land the DIFF caret on a comment's row (kept the diff view active, matching how F7 never leaves it).
// Most comments carry side: null (made from the keyboard caret, not a mouse drag — see
// currentCommentTarget), so try the NEW side first, same "track the new file" convention hunk-nav uses
// (02-diff-nav.js), then fall back to the other side. Returns false when there's no matching row (e.g. the
// file's diff body isn't materialized yet) so the caller can fall back to the source-view jump.
function navigateToLineInDiff(path, line, side) {
  var wrapper = typeof diffWrapperByPath === 'function' ? diffWrapperByPath(path) : null;
  if (!wrapper) return false;
  var sides = side === 'old' ? ['old', 'new'] : ['new', 'old'];
  for (var i = 0; i < sides.length; i++) {
    var rowIndex = diffRowIndexForLine(wrapper, sides[i], line);
    if (rowIndex >= 0) { setDiffCursor(path, sides[i], rowIndex, 0, true); return true; }
  }
  return false;
}
function navigateToCommentInDiff(seq) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return false;
  return navigateToLineInDiff(c.path, Number(c.from) || c.line, c.side);
}
// The Cmd+F7 entry point (05-keymap.js). delta: +1 next, -1 previous, wrapping at both ends — a short
// browsing aid, not F7's "press again to cross a file" boundary gate (that exists to protect against
// skipping an unviewed file, which doesn't apply to a deliberately-browsed comment list).
// Pick the next (delta > 0) or previous anchor relative to wherever the caret currently is, wrapping at
// both ends. `list` is already in diff order (sortedNavComments / sortedAnnotations); each item needs a
// .path and a line (.from or .line). Used by F8, which walks review comments and agent notes as one list.
// so the two step through the review identically. Assumes a non-empty list — callers hint and bail first.
function stepAnchor(delta, list) {
  var order = navOrderFor(list);
  var curPath = null, curLine = -1;
  if (isDiffViewVisible() && diffCursor) {
    var curWrapper = diffWrapperByPath(diffCursor.path);
    var curRow = curWrapper ? diffRowAt(curWrapper, diffCursor.side, diffCursor.rowIndex) : null;
    curPath = diffCursor.path; curLine = curRow ? diffLineNumber(curRow) : -1;
  } else if (isSourceViewerVisible() && viewerCursor) {
    curPath = viewerCursor.path; curLine = viewerCursor.lineIndex + 1;
  }
  var curOrder = curPath != null && curPath in order ? order[curPath] : null;
  function rank(c) { return c.path in order ? order[c.path] : Infinity; }
  function lineOf(c) { return Number(c.from) || c.line || 0; }
  if (delta > 0) {
    return list.find(function (c) {
      if (curOrder == null) return true;
      return rank(c) > curOrder || (rank(c) === curOrder && lineOf(c) > curLine);
    }) || list[0];
  }
  for (var i = list.length - 1; i >= 0; i--) {
    var c = list[i];
    if (curOrder == null || rank(c) < curOrder || (rank(c) === curOrder && lineOf(c) < curLine)) return c;
  }
  return list[list.length - 1];
}
// F8 steps every note on the diff, whoever wrote it: an agent's explanation and a reviewer's question are
// the same object to a reader walking the file, and having them on two different keys meant stepping through
// one while silently skipping the other. Sorted together by anchor, so the walk follows the file.
function sortedNavThread() {
  var notes = typeof sortedAnnotations === 'function' ? sortedAnnotations() : [];
  var all = sortedNavComments().concat(notes);
  var order = navOrderFor(all);
  return all.sort(function (a, b) {
    var oa = a.path in order ? order[a.path] : Infinity;
    var ob = b.path in order ? order[b.path] : Infinity;
    if (oa !== ob) return oa - ob;
    var la = Number(a.from) || a.line || 0, lb = Number(b.from) || b.line || 0;
    if (la !== lb) return la - lb;
    // A note explains the code the comment is about, so it comes first on a shared line — the same order
    // threadHtml renders them in.
    var sa = a.seq == null ? -1 : a.seq, sb = b.seq == null ? -1 : b.seq;
    return sa - sb;
  });
}
function gotoComment(delta) {
  var list = sortedNavThread();
  if (!list.length) { showCaretHint(t('comment.nav.none')); return true; }
  var target = stepAnchor(delta, list);
  // A comment knows its own seq and can be navigated to precisely; a note is anchored by line.
  if (target.seq != null) {
    if (!isDiffViewVisible() || !navigateToCommentInDiff(target.seq)) navigateToComment(target.seq);
  } else if (!isDiffViewVisible() || !navigateToLineInDiff(target.path, target.line, 'new')) {
    navigateToLine(target.path, target.line);
  }
  return true;
}

// The merged prompt's data shape: one block per kind that has open comments (its agent-contract prose,
// then its items), in order — questions first, so the agent answers those (no edits) before touching code
// for the change requests. A kind with no open comments is omitted entirely (heading, contract, and all).
// When NEITHER kind has anything open, one empty block is still returned so the panel isn't a dead surface
// (matching its long-standing behavior of a blank scratch document you can still type into and copy).
// Comment bodies are never edited by typing into this document (see mergedCardHtml/the merged dock) — they
// render `comment.text` verbatim and read/write straight through `reviewComments`, so there is no markdown
// round-trip of comment text to get wrong, and no reconcile step needed at all.
function mergedBlocks() {
  var qItems = reviewComments.filter(function (c) { return c.kind === 'q' && !c.addressed; });
  var cItems = reviewComments.filter(function (c) { return c.kind === 'c' && !c.addressed; });
  var blocks = [];
  if (qItems.length) blocks.push({ prose: mergePromptFor('q'), items: qItems });
  if (cItems.length) {
    // Change requests are task instructions, so they lead with the plan contract: plan first and decompose
    // into verifiable steps without asking the agent to add an application-state file to the repository.
    blocks.push({ prose: mergePromptFor('plan') + '\n\n' + mergePromptFor('c'), items: cItems });
  }
  if (!blocks.length) blocks.push({ prose: '', items: [] });
  return blocks;
}

// One unified hand-off document as a single string (Copy all's default, "Send to terminal", and tests).
// The live merged dock instead renders each block as its own small editable surface plus one non-editable
// card per comment (see openMergedView/currentMergedText in 08-dock.js) — this stays the static/default view.
// One comment's lines in the hand-off document — shared with the live panel's currentMergedText (08-dock.js)
// so the two can't drift. A follow-up leads with the exchange it continues, quoted, because the checklist is
// rewritten every round: without it the agent reads "why did you do it that way?" and has no "that way".
function mergedItemLines(c) {
  var lines = ['### ' + commentTargetLabel(c)];
  commentThreadContext(c).forEach(function (turn) {
    if (turn.prompt) lines.push('> ' + turn.prompt.split('\n').join('\n> '));
    if (turn.answer) {
      if (turn.prompt) lines.push('>', '> ' + t('comment.answer') + ': ' + turn.answer.split('\n').join('\n> '));
      else lines.push('> ' + turn.answer.split('\n').join('\n> ')); // an agent note: its own statement, no question above it
    }
    lines.push('');
  });
  lines.push(c.text);
  lines.push('');
  return lines;
}
function buildMergedText() {
  var nl = String.fromCharCode(10);
  var lines = [];
  mergedBlocks().forEach(function (block) {
    if (!block.prose && !block.items.length) return; // the empty scratch-pad block prints nothing
    if (block.prose) { lines.push(block.prose); lines.push(''); }
    block.items.forEach(function (c) { lines.push.apply(lines, mergedItemLines(c)); });
  });
  return lines.join(nl);
}

// A comment's read-only card in the merged dock: same .mc-card/.mc-card-head/.mc-kind/.mc-target/.mc-card-body
// classes threadHtml() already renders in the diff/source view, so it looks and feels like the same "comment
// box" — just without the reopen/delete buttons (deletion happens by navigating to the source and using the
// existing select-row-then-Backspace flow there, not from this panel). `.mc-merged-card` carries the
// selection/keyboard behavior; `tabindex="-1"` makes it programmatically focusable without joining Tab order.
// An answered comment shows only a tag here, never the answer body: this panel is the hand-off document you
// scan and send, and a multi-paragraph agent answer inlined into it buries the requests you're actually
// reviewing. The full answer stays one click away, in the thread at the comment's own line.
function mergedCardHtml(comment) {
  return '<div class="mc-card mc-merged-card mc-' + comment.kind + '" data-comment-seq="' + comment.seq + '" tabindex="-1" role="button">'
    + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml(comment.kind) + '</span>'
    + '<span class="mc-target">' + escapeHtml(commentTargetLabel(comment)) + '</span>'
    + (comment.answer ? '<span class="mc-answered-tag" title="' + escapeHtml(t('comment.answered.hint')) + '">' + escapeHtml(t('comment.answered')) + '</span>' : '')
    + '</div>'
    + '<div class="mc-card-body">' + escapeHtml(comment.text) + '</div></div>';
}

// Pushed from main (kakapo:answers-update, see answers-ipc.ts's syncAnswersFile) whenever the agent writes
// new answers into answers.json. Matches each item back to reviewComments by seq — the only id stable
// across a comment's text being edited later; an item whose seq no longer exists (comment deleted in the
// meantime) is dropped silently rather than resurrecting it.
function applyAnswersUpdate(items) {
  if (!Array.isArray(items) || !items.length) return;
  var changed = false;
  items.forEach(function (item) {
    var c = reviewComments.find(function (x) { return x.seq === item.seq; });
    if (!c) return;
    c.answer = item.answer;
    c.answeredAt = item.answeredAt;
    changed = true;
  });
  // Agent-driven, so the re-render yields to a terminal being typed into (see refreshCommentsWhenNotTyping).
  if (changed) { saveComments(); refreshCommentsWhenNotTyping(); }
}
