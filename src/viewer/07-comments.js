function showToast(message) {
  var stack = document.getElementById('mc-toasts');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'mc-toasts';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  var el = document.createElement('div');
  el.className = 'mc-toast';
  el.textContent = message;
  stack.appendChild(el);
  while (stack.children.length > 3 && stack.firstChild) stack.removeChild(stack.firstChild);
  requestAnimationFrame(function () { el.classList.add('show'); });
  setTimeout(function () {
    el.classList.add('hide');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
  }, 4500);
}
var caretHintEl = null, caretHintTimer = 0;
function caretAnchorElement() {
  var sourceRow = function () {
    var loc = caretSourceLoc();
    return loc ? document.querySelector('#source-body .source-row[data-line-index="' + loc.lineIndex + '"]') : null;
  };
  var candidates = isSourceViewerVisible()
    ? [document.querySelector('#source-body .code-cursor'), sourceRow()]
    : isDiffViewVisible()
      ? [document.querySelector('#diff2html-container .code-cursor'), activeDiffRow, document.querySelector('#diff2html-container .diff-active-row')]
      : [document.querySelector('#source-body .code-cursor'), sourceRow(), document.querySelector('#diff2html-container .code-cursor'), activeDiffRow, document.querySelector('#diff2html-container .diff-active-row')];
  for (var i = 0; i < candidates.length; i++) { if (candidates[i]) return candidates[i]; }
  return null;
}
var caretHintSeq = 0;
function showCaretHint(message, anchor, sticky) {
  caretHintSeq += 1;
  var row = anchor || caretAnchorElement();
  if (!row || (!row.getBoundingClientRect && !Number.isFinite(Number(row.bottom)))) { showToast(message); return; }
  if (!caretHintEl) {
    caretHintEl = document.createElement('div');
    caretHintEl.className = 'mc-caret-hint';
    caretHintEl.setAttribute('role', 'status');
    caretHintEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(caretHintEl);
  }
  caretHintEl.textContent = message;
  var r = row.getBoundingClientRect ? row.getBoundingClientRect() : row;
  caretHintEl.style.left = Math.round(Math.max(8, r.left)) + 'px';
  caretHintEl.style.top = Math.round(r.bottom + 4) + 'px';
  caretHintEl.classList.remove('show');
  void caretHintEl.offsetWidth;
  caretHintEl.classList.add('show');
  if (caretHintTimer) clearTimeout(caretHintTimer);
  if (!sticky) caretHintTimer = setTimeout(hideCaretHint, caretHintLifetime(message));
}
function caretHintLifetime(message) {
  return Math.min(8000, Math.max(2000, 1200 + String(message || '').length * 65));
}
function repositionCaretHint() {
  if (!caretHintEl || !caretHintEl.classList.contains('show')) return;
  var row = caretAnchorElement();
  if (!row || !row.getBoundingClientRect) return;
  var r = row.getBoundingClientRect();
  caretHintEl.style.left = Math.round(Math.max(8, r.left)) + 'px';
  caretHintEl.style.top = Math.round(r.bottom + 4) + 'px';
}
function hideCaretHint() {
  if (caretHintTimer) { clearTimeout(caretHintTimer); caretHintTimer = 0; }
  if (caretHintEl) caretHintEl.classList.remove('show');
}
function currentFileText(path, side) {
  var base = side === 'old';
  var file = base ? null : sourceByPath.get(path);
  if (file && file.embedded && typeof file.content === 'string' && file.content) {
    var lines = file.content.split(/\r?\n/);
    return {
      complete: true,
      at: function (line) { return lines[line - 1]; },
      has: function (code) { return lines.indexOf(code) >= 0; },
      find: function (code, near) {
        var best = 0, bestDist = Infinity;
        for (var i = 0; i < lines.length; i++) {
          if (lines[i] !== code) continue;
          var d = Math.abs(i - (near - 1));
          if (d < bestDist) { bestDist = d; best = i + 1; }
        }
        return best;
      },
    };
  }
  var wrapper = diffWrapperByPath(path);
  var rows = wrapper ? diffRowsOf(diffSideTable(wrapper, base ? 'old' : 'new')) : [];
  if (!rows.length) return null;
  var byLine = new Map();
  for (var r = 0; r < rows.length; r++) {
    var ln = diffLineNumber(rows[r]);
    if (ln != null && !byLine.has(ln)) byLine.set(ln, diffLineText(rows[r]));
  }
  if (!byLine.size) return null;
  return {
    complete: false,
    at: function (line) { return byLine.get(line); },
    has: function (code) {
      var found = false;
      byLine.forEach(function (text) { if (text === code) found = true; });
      return found;
    },
    find: function (code, near) {
      var best = 0, bestDist = Infinity;
      byLine.forEach(function (text, ln) {
        if (text !== code) return;
        var d = Math.abs(ln - near);
        if (d < bestDist) { bestDist = d; best = ln; }
      });
      if (!best) return 0;
      for (var ln = Math.min(near, best); ln <= Math.max(near, best); ln += 1) {
        if (!byLine.has(ln)) return 0;
      }
      return best;
    },
  };
}
function anchorLinePresent(path, anchorCode, code, side) {
  var ac = String(anchorCode == null ? (code == null ? '' : code) : anchorCode);
  if (!ac.trim() || ac.indexOf('\n') >= 0) return false;
  var text = currentFileText(path, side);
  return !!text && text.has(ac);
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
// A file whose body has not loaded is read out of the rendered diff instead (currentFileText), and is
// reconciled again — against the whole file, so job 2 can run — once loadSourceFile resolves.
// The commented line has left the working tree, so its line number on the right now points at whatever code
// took its place — the card would sit beside a stranger. The base pane is where a line that is gone still
// exists, so look the anchor up there and move the card across, keeping the reviewer's words next to the code
// they were about.
// ponytail: reads the base out of the rendered diff, so a file whose body has not materialized yet (lazy
// review) simply doesn't move — same as before. Give the renderer the base text if that ever matters.
function moveCommentToBaseSide(c) {
  if (commentSide(c) === 'old') return false;
  var code = String(c.anchorCode == null ? '' : c.anchorCode);
  if (!code.trim()) return false;
  var wrapper = diffWrapperByPath(c.path);
  var rows = wrapper ? diffRowsOf(diffSideTable(wrapper, 'old')) : [];
  for (var i = 0; i < rows.length; i++) {
    if (diffLineText(rows[i]) !== code) continue;
    var line = diffLineNumber(rows[i]);
    if (line == null) continue;
    var delta = line - c.line;
    c.side = 'old';
    c.line = line;
    if (Number.isFinite(Number(c.from))) c.from = Number(c.from) + delta;
    if (Number.isFinite(Number(c.to))) c.to = Number(c.to) + delta;
    return true;
  }
  return false;
}
function reanchorReplies() {
  var changed = 0;
  reviewComments.slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); }).forEach(function (c) {
    if (c.replyTo == null) return;
    var parent = reviewComments.find(function (x) { return x.seq === c.replyTo; });
    if (!parent) return;
    if (c.path === parent.path && c.line === parent.line && c.side === parent.side) return;
    c.path = parent.path;
    c.line = parent.line;
    c.side = parent.side;
    c.from = parent.from;
    c.to = parent.to;
    changed += 1;
  });
  return changed;
}
function remapComments() {
  if (!reviewComments.length) return;
  var changed = 0;
  reviewComments.forEach(function (c) {
    var text = currentFileText(c.path, commentSide(c));
    if (!text) return;
    var code = c.anchorCode != null ? String(c.anchorCode) : (c.code == null ? '' : String(c.code));
    if (code.indexOf('\n') >= 0) return;
    if (!code.trim()) return;
    var present;
    if (text.at(c.line) === code) {
      present = true;
    } else {
      var found = text.find(code, c.line);
      present = found > 0;
      if (present && c.line !== found) {
        var delta = found - c.line;
        c.line = found;
        if (Number.isFinite(Number(c.from))) c.from = Number(c.from) + delta;
        if (Number.isFinite(Number(c.to))) c.to = Number(c.to) + delta;
        changed++;
      }
    }
    if (present) {
      if (!c.anchorPresent) { c.anchorPresent = true; changed++; }
    } else if (text.complete && c.anchorPresent && !c.addressed) {
      c.addressed = true;
      moveCommentToBaseSide(c);
      changed++;
    }
  });
  changed += reanchorReplies();
  if (!changed) return;
  saveComments();
  refreshComments();
}
function saveComments() {
  persistSave(COMMENTS_KEY, reviewComments);
  saveThread();
}

function commentToRecord(c) {
  var record = { id: c.seq };
  if (c.replyTo != null) record.re = c.replyTo;
  if (c.by === 'agent') record.by = 'agent';
  if (c.kind === 'note') record.kind = 'note';
  var parent = c.replyTo != null ? reviewComments.find(function (x) { return x.seq === c.replyTo; }) : null;
  if (!parent || parent.path !== c.path) record.path = c.path;
  if (!parent || parent.line !== c.line) record.line = c.line;
  if (Number(c.from) && Number(c.from) !== c.line) record.from = Number(c.from);
  if (Number(c.to) && Number(c.to) !== c.line) record.to = Number(c.to);
  if (c.side) record.side = c.side;
  if (c.role) record.role = c.role;
  if (c.group) record.group = c.group;
  if (c.anchorCode) record.anchor = c.anchorCode;
  if (c.title) record.title = c.title;
  if (c.addressed) record.addressed = true;
  if (c.archivedAt) record.archivedAt = c.archivedAt;
  if (c.view) record.view = c.view;
  record.text = c.text;
  return record;
}
function recordToComment(record, byId) {
  var parent = record.re != null ? byId[record.re] : null;
  var path = record.path != null ? String(record.path) : (parent ? parent.path : '');
  var line = Math.max(1, Number(record.line) || (parent ? parent.line : 1));
  var anchor = record.anchor != null ? String(record.anchor) : '';
  return {
    seq: Number(record.id), kind: (record.kind === 'note' || (record.kind == null && !parent && record.by === 'agent')) ? 'note' : 'c',
    by: record.by === 'agent' ? 'agent' : 'me', replyTo: record.re == null ? null : Number(record.re),
    path: path, line: line, code: anchor, anchorCode: anchor,
    from: Number(record.from) || line, to: Number(record.to) || line, side: record.side || null,
    title: record.title ? String(record.title) : '',
    role: NOTE_ROLES[record.role] ? record.role : null,
    group: Number(record.group) > 0 ? Number(record.group) : 0,
    addressed: !!record.addressed, anchorPresent: anchorLinePresent(path, anchor, anchor, record.side),
    archivedAt: typeof record.archivedAt === 'string' ? record.archivedAt : null,
    view: record.view === 'diff' || record.view === 'source' ? record.view : null,
    text: String(record.text == null ? '' : record.text),
  };
}
function threadFromRecords(records) {
  var list = (Array.isArray(records) ? records : []).filter(function (r) {
    return r && Number.isFinite(Number(r.id));
  });
  var raw = {};
  list.forEach(function (r) { var id = Number(r.id); if (!(id in raw)) raw[id] = r; });
  var byId = {}, visiting = {};
  var convert = function (record) {
    var id = Number(record.id);
    if (byId[id]) return byId[id];
    if (visiting[id]) return null;
    visiting[id] = true;
    var parentId = record.re == null ? null : Number(record.re);
    if (parentId != null && parentId !== id && raw[parentId]) convert(raw[parentId]);
    byId[id] = recordToComment(record, byId);
    visiting[id] = false;
    return byId[id];
  };
  list.forEach(convert);
  var out = [];
  list.forEach(function (record) {
    var comment = byId[Number(record.id)];
    if (comment && out.indexOf(comment) < 0) out.push(comment);
  });
  return out;
}
var reviewThreadPath = '';
var threadSaveTimer = 0;
var threadSavePending = false;
function saveThread() {
  if (!(window.kakapoComments && typeof window.kakapoComments.write === 'function')) return;
  if (threadSaveTimer) clearTimeout(threadSaveTimer);
  threadSavePending = true;
  threadSaveTimer = setTimeout(function () {
    threadSaveTimer = 0;
    var settle = function (result) {
      threadSavePending = false;
      if (result && result.arrived && result.arrived.length) applyThreadRecords(null, result.arrived);
    };
    try {
      window.kakapoComments.write({ records: reviewComments.concat(archivedComments).map(commentToRecord) })
        .then(settle, function () { threadSavePending = false; });
    } catch (e) { threadSavePending = false; }
  }, 250);
}
function applyThreadRecords(records, extra, silent) {
  var next = records ? threadFromRecords(records) : reviewComments.slice();
  if (extra && extra.length) {
    var byId = {};
    next.forEach(function (c) { byId[c.seq] = c; });
    threadFromRecords(extra).forEach(function (c) { if (!byId[c.seq]) next.push(c); });
  }
  archivedComments = next.filter(function (c) { return !!c.archivedAt; });
  reviewComments = next.filter(function (c) { return !c.archivedAt; });
  reanchorReplies();
  commentSeq = next.reduce(function (max, c) { return Math.max(max, c.seq || 0); }, 0);
  persistSave(COMMENTS_KEY, reviewComments);
  if (silent) seenAgentSeq = maxAgentSeq(); else notifyAgentTurns();
  refreshCommentsWhenNotTyping();
}
var seenAgentSeq = maxAgentSeq();
function maxAgentSeq() {
  return reviewComments.reduce(function (max, c) { return c.by === 'agent' ? Math.max(max, c.seq || 0) : max; }, 0);
}
function notifyAgentTurns() {
  var high = maxAgentSeq();
  if (high <= seenAgentSeq) { seenAgentSeq = high; return; }
  var fresh = reviewComments.filter(function (c) { return c.by === 'agent' && c.seq > seenAgentSeq; });
  seenAgentSeq = high;
  if (!fresh.length || persistRead('kakapo-answer-notify') === false) return;
  if (typeof Notification !== 'function' || document.hasFocus()) return;
  var first = String(fresh[0].text || '').split('\n').filter(function (line) { return line.trim(); })[0] || '';
  var body = t(fresh.length > 1 ? 'notify.agentReplies' : 'notify.agentReplied');
  try {
    var seq = fresh[0].seq;
    var note = new Notification('kakapo', { body: first ? body + ' \u2014 ' + first.slice(0, 140) : body });
    note.onclick = function () { try { window.focus(); revealComment(seq); } catch (e) {} };
  } catch (e) {}
}
function loadThread() {
  if (!(window.kakapoComments && typeof window.kakapoComments.read === 'function')) return;
  window.kakapoComments.read().then(function (result) {
    if (!result) return;
    reviewThreadPath = result.path || '';
    if (result.records && result.records.length) applyThreadRecords(result.records, null, true);
    if (result.conversationExists ?? result.exists) return;
    var migrated = reviewComments.slice();
    var nextSeq = migrated.reduce(function (max, c) { return Math.max(max, c.seq || 0); }, 0);
    migrated.slice().forEach(function (c) {
      if (!c.answer) return;
      migrated.push({ seq: ++nextSeq, kind: c.kind, by: 'agent', replyTo: c.seq, path: c.path, line: c.line,
        code: '', anchorCode: '', from: c.line, to: c.line, side: null, title: '', addressed: false,
        anchorPresent: false, text: String(c.answer) });
      delete c.answer; delete c.answeredAt;
    });
    (result.legacyNotes || []).forEach(function (note) {
      if (!note || !note.path || !note.text) return;
      migrated.push({ seq: ++nextSeq, kind: 'note', by: 'agent', replyTo: null, path: String(note.path),
        line: Math.max(1, Number(note.line) || 1), code: '', anchorCode: '', from: Number(note.line) || 1,
        to: Number(note.line) || 1, side: null, title: note.title ? String(note.title) : '', addressed: false,
        anchorPresent: false, text: String(note.text) });
    });
    reviewComments = migrated;
    commentSeq = nextSeq;
    saveThread();
    refreshComments();
  }, function () {});
}
function onThreadFilePush(payload) {
  if (threadSavePending) return;
  try { applyThreadRecords(payload && payload.records); } catch (e) {}
}
if (window.kakapoComments && typeof window.kakapoComments.onUpdate === 'function') {
  window.kakapoComments.onUpdate(onThreadFilePush);
}
if (window.kakapoComments && typeof window.kakapoComments.onReveal === 'function') {
  window.kakapoComments.onReveal(function (payload) {
    var seq = payload && Number(payload.seq), tries = 0;
    if (!seq) return;
    var attempt = function () {
      try { if (revealComment(seq) || ++tries > 10) return; } catch (e) { return; }
      setTimeout(attempt, 150);
    };
    attempt();
  });
}
loadThread();
function hasProjectExistenceBridge() {
  return !!(window.kakapoFile && typeof window.kakapoFile.existingPaths === 'function');
}
function commentFileIsKnownMissing(path) {
  var file = sourceByPath.get(path);
  if (file) {
    return file.vcs === 'deleted' || /not present in the working tree/i.test(String(file.skippedReason || ''));
  }
  return !hasProjectExistenceBridge() && !!projectIndexLoaded;
}
function removeCommentsForPaths(paths) {
  var missing = new Set(Array.isArray(paths) ? paths : []);
  if (!missing.size) return 0;
  var orphaned = function (comment) { return missing.has(comment.path) && commentSide(comment) !== 'old'; };
  var removed = reviewComments.filter(orphaned);
  if (!removed.length) return 0;
  reviewComments = reviewComments.filter(function (comment) { return !orphaned(comment); });
  saveComments();
  try {
    document.dispatchEvent(new CustomEvent('kakapo:comments-pruned', { detail: { comments: removed } }));
  } catch (e) {}
  return removed.length;
}
function pruneCommentsForMissingFiles() {
  var missing = [];
  reviewComments.forEach(function (comment) {
    if (comment.path && commentFileIsKnownMissing(comment.path) && missing.indexOf(comment.path) < 0) missing.push(comment.path);
  });
  return removeCommentsForPaths(missing);
}
function verifyCommentFilesExist() {
  var paths = [];
  reviewComments.forEach(function (comment) {
    if (comment.path && paths.indexOf(comment.path) < 0) paths.push(comment.path);
  });
  if (!paths.length) return Promise.resolve(0);
  if (hasProjectExistenceBridge()) {
    return Promise.resolve(window.kakapoFile.existingPaths(paths)).then(function (result) {
      if (!result || typeof result !== 'object') return 0;
      return removeCommentsForPaths(paths.filter(function (path) { return result[path] === false; }));
    }, function () { return 0; });
  }
  return ensureProjectIndex().then(function () { return pruneCommentsForMissingFiles(); }, function () { return 0; });
}
function commentSide(c) {
  return c && c.side === 'old' ? 'old' : 'new';
}
function commentsAt(path, line, side) {
  return reviewComments.filter(function (c) {
    return c.path === path && c.line === line && (!side || commentSide(c) === side);
  }).sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
}
function commentKindIcon() {
  return '<svg class="mc-kind-ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M5.5 5.5h13c.8 0 1.5.7 1.5 1.5v6.4c0 .8-.7 1.5-1.5 1.5H12l-4.5 3.6V16.4H5.5c-.8 0-1.5-.7-1.5-1.5V7c0-.8.7-1.5 1.5-1.5z"/></svg>';
}
function commentKindHtml() {
  return commentKindIcon() + '<span class="mc-kind-text">' + escapeHtml(t('comment.kind')) + '</span>';
}
function relevantLines(path, side) {
  var set = {};
  reviewComments.forEach(function (c) {
    if (c.path === path && (!side || commentSide(c) === side)) set[c.line] = true;
  });
  if (composerState && composerState.path === path && (!side || commentSide(composerState) === side)) set[composerState.line] = true;
  return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
}
function commentBodyText(anchorSource, text) {
  var label = commentTargetLabel(anchorSource);
  var body = String(text || '');
  return (body.slice(0, label.length) === label ? body.slice(label.length) : body).trim();
}
function addComment(kind, path, line, code, text, from, to, side, anchorCode, replyTo) {
  var trimmed = String(text || '').trim();
  var written = commentBodyText({ path: path, line: line, from: from, to: to }, trimmed);
  if (!written) { if (trimmed) showCaretHint(t('comment.empty')); return; }
  commentSeq += 1;
  var hasFrom = from != null && from !== '' && Number.isFinite(Number(from));
  var hasTo = to != null && to !== '' && Number.isFinite(Number(to));
  var start = hasFrom ? Number(from) : Number(line);
  var end = hasTo ? Number(to) : Number(line);
  if (start > end) { var swap = start; start = end; end = swap; }
  reviewComments.push({
    seq: commentSeq, kind: kind, by: 'me', path: path, line: line, code: String(code || ''), text: trimmed,
    from: start, to: end, side: side || null, anchorCode: String(anchorCode == null ? code || '' : anchorCode),
    title: '',
    anchorPresent: anchorLinePresent(path, anchorCode, code, side), addressed: false,
    view: isDiffViewVisible() ? 'diff' : 'source',
    replyTo: replyTo == null ? null : Number(replyTo),
  });
  saveComments();
}
function reopenComment(seq) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c || !c.addressed) return;
  c.addressed = false;
  c.anchorPresent = false;
  saveComments();
  refreshComments();
}
function updateComment(seq, text) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  var trimmed = String(text || '').trim();
  if (commentBodyText(c, trimmed)) { c.text = trimmed; saveComments(); }
  else { deleteComment(seq); }
}
var commentUndoStack = [];
function archiveComments(seqs) {
  var moving = reviewComments.filter(function (c) { return seqs.indexOf(c.seq) !== -1; });
  if (!moving.length) return 0;
  var at = new Date().toISOString();
  commentUndoStack.push(moving.map(function (c) { return Object.assign({}, c); }));
  if (commentUndoStack.length > 20) commentUndoStack.shift();
  moving.forEach(function (c) { c.archivedAt = at; });
  reviewComments = reviewComments.filter(function (c) { return seqs.indexOf(c.seq) === -1; });
  archivedComments = archivedComments.concat(moving);
  saveComments();
  return moving.length;
}
function restoreArchivedThread(seq) {
  var back = archivedComments.filter(function (c) { return c.seq === seq || c.replyTo === seq; });
  if (!back.length) return 0;
  back.forEach(function (c) { c.archivedAt = null; });
  archivedComments = archivedComments.filter(function (c) { return back.indexOf(c) < 0; });
  reviewComments = reviewComments.concat(back);
  saveComments();
  refreshComments();
  return back.length;
}
function removeComments(seqs) {
  var removed = reviewComments.filter(function (c) { return seqs.indexOf(c.seq) !== -1; });
  if (!removed.length) return;
  commentUndoStack.push(removed);
  if (commentUndoStack.length > 20) commentUndoStack.shift();
  reviewComments = reviewComments.filter(function (c) { return seqs.indexOf(c.seq) === -1; });
  saveComments();
}
function commentSubtreeSeqs(seq) {
  var out = [seq], queue = [seq], guard = 0;
  while (queue.length && ++guard < 500) {
    var parent = queue.shift();
    reviewComments.forEach(function (c) {
      if (c.replyTo === parent && out.indexOf(c.seq) < 0) { out.push(c.seq); queue.push(c.seq); }
    });
  }
  return out;
}
function deleteComment(seq) {
  removeComments(commentSubtreeSeqs(seq));
  refreshComments();
}
function commentSeqsForPath(path) {
  return reviewComments.filter(function (c) { return c.path === path; }).map(function (c) { return c.seq; });
}
function commentRemovalPending() {
  var top = commentUndoStack[commentUndoStack.length - 1];
  return !!(top && top.length);
}
function undoLastCommentRemoval() {
  var batch = commentUndoStack.pop();
  if (!batch || !batch.length) return false;
  var seqs = batch.map(function (c) { return c.seq; });
  archivedComments = archivedComments.filter(function (c) { return seqs.indexOf(c.seq) === -1; });
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
  if (!hasSel && diffCursor && isDiffViewVisible()) {
    var dwrap = diffWrapperByPath(diffCursor.path);
    var drow = dwrap ? diffRowAt(dwrap, diffCursor.side, diffCursor.rowIndex) : null;
    var dline = drow ? diffLineNumber(drow) : null;
    if (dline != null) return { path: diffCursor.path, line: dline, code: diffLineText(drow) || '', anchorCode: diffLineText(drow) || '', from: null, to: null, side: diffCursor.side === 'old' ? 'old' : 'new' };
  }
  var rng = (sel && sel.rangeCount) ? sel.getRangeAt(0) : null;
  var fromNode = rng ? rng.startContainer : (sel ? sel.anchorNode : null);
  var toNode = rng ? rng.endContainer : (sel ? sel.anchorNode : null);
  var fromEl = fromNode ? (fromNode.nodeType === 1 ? fromNode : fromNode.parentElement) : null;
  var toEl = toNode ? (toNode.nodeType === 1 ? toNode : toNode.parentElement) : null;
  var wrapper = (toEl && toEl.closest && toEl.closest('.d2h-file-wrapper')) || document.querySelector('#diff2html-container .d2h-file-wrapper:not(.df-inactive)');
  if (!wrapper) return null;
  var path = diffWrapperPathKey(wrapper);
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

function inlineCommentTargetLabel(s) {
  var line = Math.max(1, Number(s && s.line) || 1);
  var from = Math.max(1, Number(s && s.from) || line);
  var to = Math.max(1, Number(s && s.to) || line);
  return from === to ? '' : commentTargetLabel(s);
}
function commentTargetHeadHtml(s) {
  var label = inlineCommentTargetLabel(s);
  return label ? '<span class="mc-target" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>' : '';
}
function commentTargetLabel(s) {
  var line = Math.max(1, Number(s && s.line) || 1);
  var from = Math.max(1, Number(s && s.from) || line);
  var to = Math.max(1, Number(s && s.to) || line);
  if (from > to) { var swap = from; from = to; to = swap; }
  return '@' + String(s && s.path || '') + '#L' + from + (to !== from ? '-' + to : '');
}
function reviewerCardHtml(c) {
  var addressed = !!c.addressed;
  return '<div class="mc-card mc-' + c.kind + (addressed ? ' mc-addressed' : '') + (c.replyTo != null ? ' mc-reply-card' : '') + '">'
    + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml() + '</span>'
    + commentTargetHeadHtml(c)
    + (addressed ? '<span class="mc-addressed-tag" title="' + escapeHtml(t('comment.addressed.hint')) + '">' + escapeHtml(t('comment.addressed')) + '</span>' : '')
    + (addressed ? '<button type="button" class="mc-reopen" data-seq="' + c.seq + '" aria-label="' + escapeHtml(t('comment.reopen')) + '" title="' + escapeHtml(t('comment.reopen')) + '">↺</button>' : '')
    + '<button type="button" class="mc-del" data-keyhint-id="deleteComment:1" data-seq="' + c.seq + '" aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">×</button></div>'
    + '<div class="mc-card-body">' + escapeHtml(commentBodyWithoutAnchor(c)) + '</div></div>';
}
function composerAt(path, line, side) {
  return !!(composerState && composerState.path === path && composerState.line === line
    && (!side || commentSide(composerState) === side));
}
function threadHtml(path, line, side) {
  var html = '';
  commentsAt(path, line, side).forEach(function (c) {
    if (composerState && composerState.editSeq === c.seq) return;
    html += c.by === 'agent' ? agentCardHtml(c) : reviewerCardHtml(c);
  });
  if (composerAt(path, line, side)) {
    var ph = t('composer.comment');
    html += '<div class="mc-card mc-' + composerState.kind + ' mc-composer' + (composerState.replyTo != null ? ' mc-reply-card' : '') + '">'
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml() + '</span></div>'
      + '<textarea class="mc-input" rows="3" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="' + escapeHtml(ph) + '">' + escapeHtml(composerState.editText || '') + '</textarea>'
      + '<div class="mc-actions"><button type="button" class="mc-btn mc-save" data-keyhint-id="saveComment">' + escapeHtml(t('composer.save')) + '</button>'
      + '<button type="button" class="mc-btn mc-ghost mc-cancel" data-keyhint-id="closeDialog">' + escapeHtml(t('composer.cancel')) + '</button>'
      + '<span class="mc-hint">' + escapeHtml(t('composer.hint')) + '</span></div></div>';
  }
  return html;
}

function injectThreadRow(anchorRow, path, line, side) {
  if (!anchorRow || !anchorRow.parentNode) return null;
  var tr = document.createElement('tr');
  tr.className = 'mc-comment-row';
  var td = document.createElement('td');
  td.colSpan = (anchorRow.classList && anchorRow.classList.contains('source-row')) ? (anchorRow.children.length || 2) : 2;
  td.className = 'mc-thread-cell';
  td.innerHTML = threadHtml(path, line, side);
  tr.appendChild(td);
  anchorRow.parentNode.insertBefore(tr, anchorRow.nextSibling);
  return tr;
}

function injectDiffCommentSpacer(anchorRow, slot) {
  if (!anchorRow || !anchorRow.parentNode) return null;
  var tr = document.createElement('tr');
  tr.className = 'mc-spacer-row mc-comment-spacer-row';
  tr.dataset.commentSlot = String(slot);
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
  var bySlot = {};
  wrapper.querySelectorAll('.mc-comment-spacer-row').forEach(function (row) {
    bySlot[row.dataset.commentSlot || ''] = row;
  });
  var changed = false;
  wrapper.querySelectorAll('.mc-comment-row[data-comment-slot]').forEach(function (row) {
    var peer = bySlot[row.dataset.commentSlot || ''];
    var spacer = peer && peer.querySelector('.mc-comment-spacer');
    if (!spacer) return;
    var rect = row.getBoundingClientRect();
    var height = Math.max(Number(rect.height) || 0, Number(row.offsetHeight) || 0);
    if (!height) return;
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
    try { renderDiffCommentsForFile(w, commentsByPath, remember); }
    catch (e) { try { console.error('kakapo: comments render failed for one file', e); } catch (e2) {} }
  });
  return affected;
}
function renderDiffCommentsForFile(w, commentsByPath, remember) {
  var path = diffWrapperPathKey(w);
  if (!path) return;
  var pathComments = commentsByPath[path] || [];
  var activeComposer = composerState && composerState.path === path ? composerState : null;
  var renderKey = JSON.stringify({
    comments: pathComments.map(function (comment) {
      return [comment.seq, comment.kind, comment.by, comment.replyTo, comment.line, comment.from, comment.to, commentSide(comment), comment.text];
    }),
    composer: activeComposer
      ? [activeComposer.kind, activeComposer.line, activeComposer.from, activeComposer.to, commentSide(activeComposer), activeComposer.editSeq, activeComposer.editText || '']
      : null,
  });
  var slotCount = relevantLines(path, 'new').length + relevantLines(path, 'old').length;
  var existingRows = w.querySelectorAll('.mc-comment-row');
  var existingSpacers = w.querySelectorAll('.mc-comment-spacer-row');
  if (w.__mcDiffCommentRenderKey === renderKey && existingRows.length === slotCount && existingSpacers.length === slotCount) return;
  if (!slotCount && !existingRows.length && !existingSpacers.length) { w.__mcDiffCommentRenderKey = renderKey; return; }
  w.querySelectorAll('.mc-comment-row, .mc-comment-spacer-row').forEach(function (row) { row.remove(); });
  remember(w);
  if (!slotCount) { w.__mcDiffCommentRenderKey = renderKey; return; }
  var sides = w.querySelectorAll('.d2h-file-side-diff');
  var right = sides[sides.length - 1];
  var left = sides[0];
  if (!right || !left || right === left) return;
  var codeRows = function (side) {
    return Array.prototype.slice.call(side.querySelectorAll('tr')).filter(function (row) {
      return !row.classList.contains('mc-comment-row') && !row.classList.contains('mc-spacer-row');
    });
  };
  var rowsBySide = { new: codeRows(right), old: codeRows(left) };
  ['new', 'old'].forEach(function (side) {
    var rows = rowsBySide[side];
    var peers = rowsBySide[side === 'new' ? 'old' : 'new'];
    relevantLines(path, side).forEach(function (line) {
      for (var i = 0; i < rows.length; i++) {
        var num = rows[i].querySelector('.d2h-code-side-linenumber');
        if (num && (num.textContent || '').trim() === String(line)) {
          var slot = side + ':' + line;
          var commentRow = injectThreadRow(rows[i], path, line, side);
          if (commentRow) commentRow.dataset.commentSlot = slot;
          if (peers[i]) injectDiffCommentSpacer(peers[i], slot);
          break;
        }
      }
    });
  });
  syncDiffCommentSpacerHeights(w);
  w.__mcDiffCommentRenderKey = renderKey;
}

function renderSourceComments() {
  var body = document.getElementById('source-body');
  if (!body) return;
  body.querySelectorAll('.mc-comment-row').forEach(function (r) { r.remove(); });
  var path = sourceOpenPath();
  if (!path) return;
  relevantLines(path).forEach(function (line) {
    var anchor = body.querySelector('.source-row[data-line-index="' + (line - 1) + '"]');
    if (anchor) injectThreadRow(anchor, path, line);
  });
  try { renderMermaidDiagrams(body); } catch (e) {}
}

function renderCommentBadges() {
  document.querySelectorAll('.mc-file-badge').forEach(function (b) { b.remove(); });
  var counts = {};
  reviewComments.forEach(function (x) { counts[x.path] = (counts[x.path] || 0) + 1; });
  function makeBadge(n) {
    var badge = document.createElement('span');
    badge.className = 'mc-file-badge';
    var badgeTitle = t('badge.comments', { n: n });
    badge.innerHTML = '<span class="mc-fb" title="' + escapeHtml(badgeTitle) + '">' + n + '</span>';
    return badge;
  }
  function inject(selector, keyAttr, refSelector) {
    document.querySelectorAll(selector).forEach(function (row) {
      var n = counts[row.dataset[keyAttr] || ''];
      if (!n) return;
      var ref = refSelector ? row.querySelector(refSelector) : null;
      if (ref) row.insertBefore(makeBadge(n), ref); else row.appendChild(makeBadge(n));
    });
  }
  inject('.change-row', 'file', '');
  inject('.source-link', 'sourceFile', '.count');
}

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
function renderArchivePanel() {
  var panel = document.getElementById('archive-panel');
  if (!panel) return;
  var roots = archivedComments.filter(function (c) { return c.replyTo == null; });
  panel.classList.toggle('hidden', roots.length === 0);
  if (!roots.length) { panel.innerHTML = ''; return; }
  roots.sort(function (a, b) { return String(b.archivedAt || '').localeCompare(String(a.archivedAt || '')); });
  panel.innerHTML = '<div class="archive-head">' + escapeHtml(t('archive.title'))
    + '<span class="archive-count">' + roots.length + '</span></div>'
    + roots.map(function (c) {
      var where = c.path ? sourceTabLabel(c.path) + ':' + c.line : '';
      var when = c.archivedAt ? patchSetShortDate(c.archivedAt) : '';
      if (when) where = where ? where + ' · ' + when : when;
      var full = commentBodyWithoutAnchor(c);
      return '<button type="button" class="archive-row" data-seq="' + c.seq + '" title="'
        + escapeHtml(full ? full + '\n\n' + t('archive.restore') : t('archive.restore')) + '">'
        + '<span class="archive-where">' + escapeHtml(where) + '</span>'
        + '<span class="archive-text">' + escapeHtml(full.replace(/\s+/g, ' ').slice(0, 90)) + '</span>'
        + '</button>';
    }).join('');
}
document.addEventListener('click', function (event) {
  var row = event.target && event.target.closest ? event.target.closest('#archive-panel .archive-row') : null;
  if (!row) return;
  var seq = Number(row.dataset.seq);
  if (!restoreArchivedThread(seq)) return;
  revealComment(seq);
});

function refreshComments() {
  renderArchivePanel();
  var changedDiffWrappers = renderDiffComments();
  scheduleDiffStripe();
  changedDiffWrappers.forEach(function (wrapper) {
    if (!wrapper.querySelector('.mc-layered-diff-side')) return;
    syncDiffCommentSpacerHeights(wrapper);
    invalidateAsymmetricDiffGeometry(wrapper);
    if (wrapper === diffActiveWrapper()) {
      refreshLayeredDiffGutters(wrapper);
    } else {
      scheduleLayeredDiffGutters(wrapper);
    }
  });
  if (changedDiffWrappers.length) scrollAsymmetricDiff();
  if (isSourceViewerVisible()) renderSourceComments();
  document.querySelectorAll('.mc-composer, .mc-card').forEach(function (el) { try { applyKeyHints(el); } catch (e) {} });
  renderCommentBadges();
  try { refreshMergedDock(); } catch (e) {}
  applyCommentSelectionHighlight();
  try { renderMermaidDiagrams(document); } catch (e) {}
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
      if (!ta) return true;
      if (document.activeElement === ta) return true;
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
  if (!target) { showCaretHint(t('comment.noTarget')); return true; }
  if (isLibrarySourcePath(target.path)) { showCaretHint(t('source.libraryReadOnly')); return true; }
  var existing = commentsAt(target.path, target.line, target.side)
    .filter(function (c) { return c.by !== 'agent'; });
  if (existing.length) {
    var mine = existing[0];
    composerState = {
      kind: mine.kind, path: mine.path, line: mine.line, code: mine.code, anchorCode: mine.anchorCode,
      from: mine.from, to: mine.to, side: mine.side, editSeq: mine.seq, editText: mine.text,
    };
    refreshComments();
    return;
  }
  composerState = { kind: kind, path: target.path, line: target.line, code: target.code, anchorCode: target.anchorCode, from: target.from, to: target.to, side: target.side };
  composerState.editText = commentTargetLabel(composerState) + ' ';
  try { var psel = window.getSelection(); if (psel) psel.removeAllRanges(); } catch (e) {}
  refreshComments();
}
function closeComposer() {
  if (!composerState) return;
  composerState = null;
  refreshComments();
  flushPendingDiffUpdate();
}
function returnCaretAfterComposer() {
  clearTreeFocus();
  if (isDiffViewVisible() && typeof diffCursor !== 'undefined' && diffCursor) {
    setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, diffCursor.column, false);
  } else if (isSourceViewerVisible() && typeof viewerCursor !== 'undefined' && viewerCursor) {
    setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, viewerCursor.column, false);
  }
}
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
  if (composerState.editSeq == null && String(box.value || '').trim() && !commentBodyText(composerState, box.value)) {
    showCaretHint(t('comment.empty'));
    return;
  }
  if (composerState.editSeq != null) updateComment(composerState.editSeq, box.value);
  else addComment(composerState.kind, composerState.path, composerState.line, composerState.code, box.value, composerState.from, composerState.to, composerState.side, composerState.anchorCode, composerState.replyTo);
  composerState = null;
  refreshComments();
  flushPendingDiffUpdate();
}

function showCustomDropdown(x, y, options, flipTop, className, trigger) {
  var existing = document.getElementById('mc-dropdown');
  if (existing) existing.remove();
  var dd = document.createElement('div');
  dd.id = 'mc-dropdown';
  dd.className = 'mc-dropdown' + (className ? ' ' + className : '');
  dd.setAttribute('role', 'menu');
  if (trigger) {
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'true');
  }
  var active = 0;
  function setActive(i) { active = i; for (var j = 0; j < dd.children.length; j++) dd.children[j].classList.toggle('active', j === i); }
  function close() {
    dd.remove();
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onOutside, true);
  }
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
    item.setAttribute('role', 'menuitem');
    item.className = 'mc-dropdown-item' + (i === 0 ? ' active' : '');
    item.textContent = opt.label;
    item.addEventListener('click', function () { close(); opt.onSelect(); });
    item.addEventListener('mousemove', function () { setActive(i); });
    dd.appendChild(item);
  });
  document.body.appendChild(dd);
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
function navigateToLine(path, line) {
  openSourceFile(path);
  var place = function () {
    requestAnimationFrame(function () { setSourceCursor(path, Math.max(0, (Number(line) || 1) - 1), 0, true, -1); });
  };
  loadSourceFile(path).then(place, place);
}
function openPathReference(ref) {
  var text = String(ref || '').trim();
  if (!text) return;
  var line = 1;
  var at = text.match(/^(.+?):(\d+)$/);
  if (at) { text = at[1]; line = Number(at[2]) || 1; }
  var resolve = function () {
    if (sourceByPath.has(text)) return text;
    var suffix = '/' + text, best = null;
    sourceByPath.forEach(function (_file, path) {
      if (path.length > suffix.length && path.slice(-suffix.length) === suffix && (!best || path.length < best.length)) best = path;
    });
    return best;
  };
  var hit = resolve();
  if (hit) { navigateToLine(hit, line); return; }
  ensureProjectIndex().then(function () {
    var late = resolve();
    if (late) { navigateToLine(late, line); return; }
    showCaretHint(t('comment.pathMissing'));
  }, function () {});
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
function navigateToCommentAndEdit(seq) {
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  if (commentFileIsKnownMissing(c.path)) {
    removeCommentsForPaths([c.path]);
    refreshComments();
    return;
  }
  revealComment(seq);
  requestAnimationFrame(function () {
    composerState = {
      kind: c.kind, path: c.path, line: c.line, code: c.code, anchorCode: c.anchorCode,
      from: c.from, to: c.to, side: c.side, editSeq: seq, editText: c.text,
    };
    refreshComments();
  });
}

function commentNavOrder() {
  var order = {};
  var next = 0;
  for (var i = 0; i < hunkTotal(); i++) {
    var p = hunkPathAt(i);
    if (p && !(p in order)) order[p] = next++;
  }
  return order;
}
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
    var ga = Number(a.group) > 0 ? Number(a.group) : Infinity;
    var gb = Number(b.group) > 0 ? Number(b.group) : Infinity;
    if (ga !== gb) return ga - gb;
    if (ga !== Infinity) return a.seq - b.seq;
    var oa = a.path in order ? order[a.path] : Infinity;
    var ob = b.path in order ? order[b.path] : Infinity;
    if (oa !== ob) return oa - ob;
    var la = Number(a.from) || a.line || 0, lb = Number(b.from) || b.line || 0;
    if (la !== lb) return la - lb;
    return a.seq - b.seq;
  });
}
function navigateToLineInDiff(path, line, side) {
  var wrapper = diffWrapperByPath(path);
  if (!wrapper) return false;
  if (wrapper.classList.contains('df-inactive')) revealDiffFile(path);
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
  function standingOn(c) {
    if (c.path !== curPath) return false;
    var ends = [lineOf(c), Number(c.line) || 0, Number(c.to) || 0].filter(Boolean);
    return curLine >= Math.min.apply(null, ends) && curLine <= Math.max.apply(null, ends);
  }
  var byId = {};
  list.forEach(function (c) { byId[c.seq] = c; });
  var at = -1;
  for (var k = 0; k < list.length; k++) {
    if (!standingOn(list[k])) continue;
    if (at < 0) at = k;
    if (list[k].seq === lastRevealedSeq) { at = k; break; }
  }
  if (at >= 0) {
    var here = commentThreadRoot(list[at], byId);
    var dir = delta > 0 ? 1 : -1;
    for (var n = 1; n <= list.length; n++) {
      var candidate = list[((at + dir * n) % list.length + list.length) % list.length];
      if (!standingOn(candidate) || commentThreadRoot(candidate, byId) !== here) return candidate;
    }
    return list[at];
  }
  var best = null, bestGap = Infinity;
  for (var j = 0; j < list.length; j++) {
    var item = list[j];
    var sameFile = curOrder != null && rank(item) === curOrder;
    var gap = sameFile ? (delta > 0 ? lineOf(item) - curLine : curLine - lineOf(item)) : Infinity;
    if (sameFile && gap > 0 && gap < bestGap) { best = item; bestGap = gap; }
  }
  if (best) return best;
  var byFile = list.slice().sort(function (a, b) {
    return rank(a) !== rank(b) ? rank(a) - rank(b) : lineOf(a) - lineOf(b);
  });
  if (curOrder == null) return delta > 0 ? byFile[0] : byFile[byFile.length - 1];
  if (delta > 0) return byFile.find(function (c) { return rank(c) > curOrder; }) || byFile[0];
  for (var m = byFile.length - 1; m >= 0; m--) if (rank(byFile[m]) < curOrder) return byFile[m];
  return byFile[byFile.length - 1];
}
function sortedNavThread() {
  return sortedNavComments();
}
var centerThreadTarget = 0;
function centerThreadRow(path, line, side, tries, token) {
  var mine = token === undefined ? ++centerThreadTarget : token;
  flushSourceRows();
  requestAnimationFrame(function () {
    if (mine !== centerThreadTarget) return;
    var row = null;
    if (isSourceViewerVisible()) {
      var anchor = document.querySelector('#source-body .source-row[data-line-index="' + (line - 1) + '"]');
      var next = anchor ? anchor.nextElementSibling : null;
      row = next && next.classList.contains('mc-comment-row') ? next : anchor;
    } else {
      var wrapper = diffWrapperByPath(path);
      row = wrapper ? wrapper.querySelector('.mc-comment-row[data-comment-slot="' + (side || 'new') + ':' + line + '"]') : null;
    }
    if (row && row.scrollIntoView) { try { row.scrollIntoView({ block: 'center' }); } catch (e) {} return; }
    if ((tries || 0) < 3) centerThreadRow(path, line, side, (tries || 0) + 1, mine);
  });
}
function diffCanShowComment(c) {
  var wrapper = c && diffWrapperByPath(c.path);
  if (!wrapper) return false;
  if (wrapper.classList.contains('df-inactive')) revealDiffFile(c.path);
  var line = Number(c.from) || c.line;
  var sides = commentSide(c) === 'old' ? ['old', 'new'] : ['new', 'old'];
  for (var i = 0; i < sides.length; i++) if (diffRowIndexForLine(wrapper, sides[i], line) >= 0) return true;
  return false;
}
var lastRevealedSeq = 0;
function commentIsReachable(c) {
  var path = String((c && c.path) || '');
  if (!path) return false;
  return sourceByPath.has(path) || !!diffWrapperByPath(path);
}
function revealComment(seq) {
  var target = reviewComments.find(function (c) { return c.seq === seq; });
  if (!target) return false;
  lastRevealedSeq = seq;
  var center = function () { centerThreadRow(target.path, Number(target.line) || 1, commentSide(target), 0); };
  var land = function () {
    if (!navigateToCommentInDiff(target.seq)) navigateToComment(target.seq);
    center();
  };
  if (target.view === 'source' || !diffCanShowComment(target)) {
    navigateToComment(target.seq);
    loadSourceFile(target.path).then(center, center);
    return true;
  }
  if (isDiffViewVisible()) land();
  else { showDiffView(false); requestAnimationFrame(land); }
  return true;
}
var commentNavAwaitingIndex = false;
var commentNavPendingDelta = 0;
function gotoComment(delta) {
  var list = sortedNavThread();
  if (!list.length) { showCaretHint(t('comment.nav.none')); return true; }
  var step = function (candidates, direction) {
    if (!candidates.length) { showCaretHint(t('comment.nav.unreachable')); return; }
    revealComment(stepAnchor(direction, candidates).seq);
  };
  var reachable = list.filter(commentIsReachable);
  var settled = projectIndexLoaded || reachable.length === list.length;
  if (reachable.length) { step(reachable, delta); return true; }
  if (settled) { showCaretHint(t('comment.nav.unreachable')); return true; }
  showCaretHint(t('comment.nav.looking'));
  commentNavPendingDelta = delta;
  if (commentNavAwaitingIndex) return true;
  commentNavAwaitingIndex = true;
  var release = function (landed) {
    commentNavAwaitingIndex = false;
    var direction = commentNavPendingDelta || delta;
    commentNavPendingDelta = 0;
    if (landed) step(sortedNavThread().filter(commentIsReachable), direction);
    else showCaretHint(t('comment.nav.unreachable'));
  };
  ensureProjectIndex().then(function () { release(true); }, function () { release(false); });
  return true;
}

function commentThreadRoot(c, byId) {
  var node = c, guard = 0;
  while (node && node.replyTo != null && ++guard < 50) {
    var parent = byId[node.replyTo];
    if (!parent) break;
    node = parent;
  }
  return node ? node.seq : c.seq;
}
function mergedBlocks() {
  var byId = {};
  reviewComments.forEach(function (c) { byId[c.seq] = c; });
  var lastAgentTurn = {};
  reviewComments.forEach(function (c) {
    if (c.by !== 'agent') return;
    var root = commentThreadRoot(c, byId);
    if (!(root in lastAgentTurn) || c.seq > lastAgentTurn[root]) lastAgentTurn[root] = c.seq;
  });
  var open = reviewComments.filter(function (c) {
    if (c.by === 'agent' || c.addressed) return false;
    return !(lastAgentTurn[commentThreadRoot(c, byId)] > c.seq);
  });
  return [{ items: open }];
}

function mergedItemLines(c) {
  return [commentTargetLabel(c), commentBodyWithoutAnchor(c), ''];
}

function commentBodyWithoutAnchor(c) {
  var anchor = commentTargetLabel(c);
  var text = String(c.text || '');
  if (text.slice(0, anchor.length) !== anchor) return text;
  return text.slice(anchor.length).replace(/^[ \t]+/, '');
}
function buildMergedText() {
  var nl = String.fromCharCode(10);
  var lines = [];
  mergedBlocks().forEach(function (block) {
    block.items.forEach(function (c) { lines.push.apply(lines, mergedItemLines(c)); });
  });
  return lines.join(nl);
}

function mergedCardHtml(comment) {
  return '<div class="mc-card mc-merged-card mc-' + comment.kind + '" data-comment-seq="' + comment.seq + '" tabindex="-1" role="option" aria-selected="false">'
    + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml() + '</span>'
    + '<span class="mc-target">' + escapeHtml(commentTargetLabel(comment)) + '</span>'
    + '</div>'
    + '<div class="mc-card-body">' + escapeHtml(commentBodyWithoutAnchor(comment)) + '</div></div>';
}
