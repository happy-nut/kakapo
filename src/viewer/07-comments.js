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
    var srcOnly = isSourceViewerVisible();
    var diffShown = isDiffViewVisible();
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
// A reply has no anchor of its own: it lives wherever the comment it continues lives, which is why
// openReplyComposer copies the parent's and commentToRecord omits path/line whenever they still match.
// Nothing kept that true once the parent MOVED. remapComments follows a root to its new line after the agent
// edits the file, but a reply carries no anchor text to follow with — so it stayed on the line the question
// used to be on, and the answer showed up as a card of its own, in a thread of its own, somewhere else in the
// file. Re-seat every reply on its parent, parents first so a chain propagates in one pass.
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
      moveCommentToBaseSide(c); // and its card belongs beside the base copy, not next to whatever took its place
      changed++;
    }
  });
  changed += reanchorReplies(); // a root that moved drags its answers along
  if (!changed) return; // nothing moved or re-flagged — skip the save/re-render
  saveComments();
  refreshComments();
}
function saveComments() {
  persistSave(COMMENTS_KEY, reviewComments); // browser/static builds, and a non-git folder, have only this
  saveThread();
}

// ===== The thread file: comments, agent answers and agent notes as one list (comments-file.ts) =====
// One record per comment. Everything at its default is omitted, and a reply inherits its parent's anchor, so
// the line an agent appends to answer a question is just {"id","re","by","text"} — both cheap to read into an
// agent's context and hard to get wrong when writing.
function commentToRecord(c) {
  var record = { id: c.seq };
  if (c.replyTo != null) record.re = c.replyTo;
  if (c.by === 'agent') record.by = 'agent';
  // The only kind left that isn't the default review comment is the agent's own Explain note.
  if (c.kind === 'note') record.kind = 'note';
  var parent = c.replyTo != null ? reviewComments.find(function (x) { return x.seq === c.replyTo; }) : null;
  if (!parent || parent.path !== c.path) record.path = c.path;
  if (!parent || parent.line !== c.line) record.line = c.line;
  if (Number(c.from) && Number(c.from) !== c.line) record.from = Number(c.from);
  if (Number(c.to) && Number(c.to) !== c.line) record.to = Number(c.to);
  if (c.side) record.side = c.side;
  if (c.role) record.role = c.role; // written back, or the agent's key marks vanish on the next save
  if (c.group) record.group = c.group; // likewise: losing the group would collapse the walk back to file order
  if (c.anchorCode) record.anchor = c.anchorCode;
  if (c.title) record.title = c.title;
  if (c.addressed) record.addressed = true;
  if (c.view) record.view = c.view; // same trap as role/group: a field not written back is a field the next save deletes
  // Written by the agent, never by this app — but it has to be carried back out. The renderer sends the WHOLE
  // list on every save (saveThread), so a field it forgets here is a field the next unrelated comment deletes
  // from the agent's note.
  record.text = c.text;
  return record;
}
function recordToComment(record, byId) {
  var parent = record.re != null ? byId[record.re] : null;
  var path = record.path != null ? String(record.path) : (parent ? parent.path : '');
  var line = Math.max(1, Number(record.line) || (parent ? parent.line : 1));
  var anchor = record.anchor != null ? String(record.anchor) : '';
  return {
    // A file written before questions and change requests were unified says kind:"q" or kind:"c"; both are
    // just a review comment now, so only "note" survives the trip.
    seq: Number(record.id), kind: (record.kind === 'note' || (record.kind == null && !parent && record.by === 'agent')) ? 'note' : 'c',
    by: record.by === 'agent' ? 'agent' : 'me', replyTo: record.re == null ? null : Number(record.re),
    path: path, line: line, code: anchor, anchorCode: anchor,
    from: Number(record.from) || line, to: Number(record.to) || line, side: record.side || null,
    title: record.title ? String(record.title) : '',
    // Only a role the card knows how to draw survives the trip: anything else an agent invents would otherwise
    // reach agentCardHtml as a class name and a missing translation. "key" is the one written now; the older
    // "problem"/"fix" still read back as the same single mark (NOTE_ROLES, 23-annotations.js).
    role: NOTE_ROLES[record.role] ? record.role : null,
    group: Number(record.group) > 0 ? Number(record.group) : 0,
    addressed: !!record.addressed, anchorPresent: anchorLinePresent(path, anchor, anchor),
    view: record.view === 'diff' || record.view === 'source' ? record.view : null,
    text: String(record.text == null ? '' : record.text),
  };
}
// Index every record BEFORE converting any of them, and convert a parent before whatever continues it.
// byId used to be filled as the list was walked, so a record could only inherit from a parent that happened
// to appear earlier — and this list is two files concatenated: the conversation first, then the shared notes.
// A reply written in the conversation to a NOTE therefore never found its parent. Inheriting nothing, it came
// out with no path at all, which matches no file: the answer was in the file and nowhere on screen.
function threadFromRecords(records) {
  var list = (Array.isArray(records) ? records : []).filter(function (r) {
    return r && Number.isFinite(Number(r.id));
  });
  var raw = {};
  // First wins, so the conversation owns an id the shared notes happen to reuse — the two files number
  // themselves independently and an agent can only ever see the one it was pointed at.
  list.forEach(function (r) { var id = Number(r.id); if (!(id in raw)) raw[id] = r; });
  var byId = {}, visiting = {};
  var convert = function (record) {
    var id = Number(record.id);
    if (byId[id]) return byId[id];
    if (visiting[id]) return null; // a record that answers itself, or a cycle: treat it as having no parent
    visiting[id] = true;
    var parentId = record.re == null ? null : Number(record.re);
    if (parentId != null && parentId !== id && raw[parentId]) convert(raw[parentId]);
    byId[id] = recordToComment(record, byId);
    visiting[id] = false;
    return byId[id];
  };
  list.forEach(convert);
  // Back into the file's own order, not the order resolution happened to need.
  var out = [];
  list.forEach(function (record) {
    var comment = byId[Number(record.id)];
    if (comment && out.indexOf(comment) < 0) out.push(comment);
  });
  return out;
}
// Debounced because one rebuild can remap many comments at once. Main keeps anything an agent appended since
// this renderer last read the file (knownMaxId), so saving a comment never swallows an answer that landed a
// moment earlier.
var reviewThreadPath = ''; // comments.jsonl — the file an agent appends its ANSWERS to (see loadThread)
var threadSaveTimer = 0;
// Set from the moment a local change is made until its write has landed. Main polls the thread file on its
// own timer (syncCommentsFile), and a poll that fell inside this window read the file we had not written
// yet — then handed it back as "the file is the source of truth", which put the comment just deleted right
// back on screen. The reviewer saw the first Backspace do nothing and the second one work, because the
// second one no longer overlapped a poll. Anything an agent appended meanwhile still arrives: the write's
// own answer carries it (`arrived`).
var threadSavePending = false;
var heldThreadUpdate = null; // a file poll that arrived mid-write, replayed once the write lands
function saveThread() {
  if (!(window.kakapoComments && typeof window.kakapoComments.write === 'function')) return;
  if (threadSaveTimer) clearTimeout(threadSaveTimer);
  threadSavePending = true;
  threadSaveTimer = setTimeout(function () {
    threadSaveTimer = 0;
    var settle = function (result) {
      threadSavePending = false;
      if (result && result.arrived && result.arrived.length) applyThreadRecords(null, result.arrived);
      // Our write is the newer truth for what WE changed, and main re-reads the file after it — but a poll we
      // held is still the only copy of anything that landed in the file meanwhile, so replay it rather than
      // waiting for a tick that only fires when the signature moves again.
      if (heldThreadUpdate) {
        var held = heldThreadUpdate;
        heldThreadUpdate = null;
        try { applyThreadRecords(held && held.records, null, true); } catch (e) {}
      }
    };
    try {
      window.kakapoComments.write({ records: reviewComments.map(commentToRecord), knownMaxId: commentSeq })
        .then(settle, function () { threadSavePending = false; heldThreadUpdate = null; });
    } catch (e) { threadSavePending = false; heldThreadUpdate = null; }
  }, 250);
}
// The file is the source of truth: whatever it says replaces what is in memory (a full swap cannot drift the
// way a delta can). `extra` appends records main kept from a concurrent agent write.
function applyThreadRecords(records, extra, silent) {
  var next = records ? threadFromRecords(records) : reviewComments.slice();
  if (extra && extra.length) {
    var byId = {};
    next.forEach(function (c) { byId[c.seq] = c; });
    threadFromRecords(extra).forEach(function (c) { if (!byId[c.seq]) next.push(c); });
  }
  reviewComments = next;
  reanchorReplies(); // an answer that named its own line lands in its question's thread, not beside it
  commentSeq = reviewComments.reduce(function (max, c) { return Math.max(max, c.seq || 0); }, 0);
  // A fresh explanation retires the one it replaces (23-annotations.js). Here, because this is where the
  // agent's first new note actually lands — and its own write-back merges anything the agent appended in the
  // meantime, so pruning cannot race the run that triggered it.
  pruneSupersededNotes();
  persistSave(COMMENTS_KEY, reviewComments);
  if (silent) seenAgentSeq = maxAgentSeq(); else notifyAgentTurns();
  // Agent-driven, so the re-render yields to a terminal being typed into (see refreshCommentsWhenNotTyping).
  refreshCommentsWhenNotTyping();
  try { syncRail(); } catch (e) {} // the Explain rail lights up on notes
}
// An agent finishing its work is worth knowing about when you are not watching, and answering a review
// comment is the most precise form of that signal kakapo has — far better than guessing from terminal output.
// It rides the same path the terminal bell already uses (kakapo:bell in app-terminal-ipc.ts): the tile's
// attention dot always, a native notification only while the window is unfocused, and one shared setting.
// `seenAgentSeq` is the high-water mark of turns already accounted for, so a reload or a workspace switch
// re-reads the whole file without announcing answers you have long since read.
var seenAgentSeq = maxAgentSeq();
function maxAgentSeq() {
  return reviewComments.reduce(function (max, c) { return c.by === 'agent' ? Math.max(max, c.seq || 0) : max; }, 0);
}
function notifyAgentTurns() {
  var high = maxAgentSeq();
  if (high <= seenAgentSeq) { seenAgentSeq = high; return; } // nothing new (a deletion can lower the mark)
  var fresh = reviewComments.filter(function (c) { return c.by === 'agent' && c.seq > seenAgentSeq; });
  seenAgentSeq = high;
  if (!fresh.length || persistRead('kakapo-terminal-bell-notify') === false) return;
  if (!(window.kakapoPty && typeof window.kakapoPty.bell === 'function')) return;
  var first = String(fresh[0].text || '').split('\n').filter(function (line) { return line.trim(); })[0] || '';
  var body = t(fresh.length > 1 ? 'notify.agentReplies' : 'notify.agentReplied');
  // The seq rides along so clicking the notification lands on this exchange rather than merely raising the
  // window — in a review with fifty comments, "an answer arrived" is not much use without "here".
  try { window.kakapoPty.bell({ title: 'kakapo', body: first ? body + ' — ' + first.slice(0, 140) : body, seq: fresh[0].seq }); } catch (e) {}
}
// Startup. The file wins when it exists; when it does not, this workspace's existing comments (app settings)
// and Explain notes (annotations.json) are folded into it once, so unifying the stores loses nothing.
function loadThread() {
  if (!(window.kakapoComments && typeof window.kakapoComments.read === 'function')) return;
  window.kakapoComments.read().then(function (result) {
    if (!result) return;
    // The Explain prompts write NOTES, which belong to the repository rather than to this worktree — main
    // hands back both paths and this is the one {{NOTES_PATH}} means.
    annotationsPath = result.notesPath || result.path || '';
    // …and the CONVERSATION file, which is a different file. Answers to review comments belong here, beside
    // the comments they answer; knowledge.jsonl is where what-was-learned-about-the-codebase outlives the
    // worktree. The hand-off used to name the notes file for both, so an agent answering #19 appended to a
    // store that has never heard of #19 — the answer landed nowhere the review could show it.
    reviewThreadPath = result.path || '';
    if (result.exists) { applyThreadRecords(result.records, null, true); return; } // a load is not news
    var migrated = reviewComments.slice();
    var nextSeq = migrated.reduce(function (max, c) { return Math.max(max, c.seq || 0); }, 0);
    // A pre-unification answer was a field ON the question; it becomes what it always was — a reply.
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
if (window.kakapoComments && typeof window.kakapoComments.onUpdate === 'function') {
  window.kakapoComments.onUpdate(function (payload) {
    // A poll of the file we are still writing (see saveThread) — held, never dropped: whatever an agent put
    // in it is real, and the only thing wrong with it is the timing.
    if (threadSavePending) { heldThreadUpdate = payload; return; }
    try { applyThreadRecords(payload && payload.records); } catch (e) {}
  });
}
if (window.kakapoComments && typeof window.kakapoComments.onReveal === 'function') {
  // The notification about an answer was clicked. The record may not have arrived in this renderer yet (the
  // click can beat the poll tick), so retry briefly rather than dropping the jump on the floor.
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
  // The desktop project index intentionally excludes some existing tool/config paths. Only browser/static
  // reviews can treat absence from an authoritative full index as deletion; Electron asks main directly.
  return !hasProjectExistenceBridge() && !!projectIndexLoaded;
}
// "The file this comment points at is gone, so the comment is orphaned" holds for a working-tree comment
// only. A base-pane comment is anchored on the OLD side, and the base is precisely where a file the change
// DELETED still exists — commentFileIsKnownMissing reports vcs === 'deleted' as missing, which is the one
// file whose entire diff lives in that pane. So "why did you remove this?" — the most natural thing to write
// there — was silently deleted from disk the next time the merged panel opened. Same carve-out the addressed
// heuristic already makes for an old-side anchor (see remapComments). Filtering per comment, not per path,
// because one file can hold comments on both sides and only the working-tree ones lost their anchor.
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
  // Never ask about an empty path. It means "we do not know where this belongs" — a reply whose parent did
  // not resolve used to come out that way — and the question below is "has this file been deleted?", to which
  // the answer for "" is no, it is a directory. That answer removed the comment AND saved, so a card that was
  // merely unplaceable was deleted from disk the next time this panel opened. Not knowing where something
  // goes is not grounds for throwing it away.
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
// Which diff pane a comment belongs to. Everything written before sides existed (and everything written in
// the source view, which has no panes) is a working-tree comment, so null reads as 'new'.
function commentSide(c) {
  return c && c.side === 'old' ? 'old' : 'new';
}
// `side` is optional: omitting it means "either pane", which is what the source view wants — it shows one
// file, not two, so a card anchored to the base still belongs at its line there.
// A thread reads top to bottom in the order it was written, so it is sorted by id rather than left in the
// order `reviewComments` happens to hold. That order is two files concatenated — this workspace's
// conversation, then the repository's shared notes (comments-file.ts) — so an agent's note always sank below
// every question and answer at the same line, however long before them it was written. A reader saw their own
// question at the top of a thread that had started with the note it was asked about.
//
// `seq` is safe to sort on across both files because they are ONE id space, which is the whole reason the
// prompt is handed a NEXT FREE ID rather than "highest in this file + 1".
function commentsAt(path, line, side) {
  return reviewComments.filter(function (c) {
    if (isBriefingCard(c)) return false; // it is the panel, not a card
    return c.path === path && c.line === line && (!side || commentSide(c) === side);
  }).sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
}
// Questions and change requests used to be two kinds with two shortcuts. They were the same conversation:
// any thread that runs long enough reaches "…so change it", and the kind you picked first decided whether
// that was allowed. One kind now, one shortcut ("?"), one icon — a speech bubble, matching the rail.
function commentKindIcon() {
  return '<svg class="mc-kind-ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M5.5 5.5h13c.8 0 1.5.7 1.5 1.5v6.4c0 .8-.7 1.5-1.5 1.5H12l-4.5 3.6V16.4H5.5c-.8 0-1.5-.7-1.5-1.5V7c0-.8.7-1.5 1.5-1.5z"/></svg>';
}
// Full inner HTML for a .mc-kind pill: monochrome icon + the (localized) label.
function commentKindHtml() {
  return commentKindIcon() + '<span class="mc-kind-text">' + escapeHtml(t('comment.kind')) + '</span>';
}
function relevantLines(path, side) {
  var set = {};
  reviewComments.forEach(function (c) {
    if (isBriefingCard(c)) return; // no card, so no slot to hold one
    if (c.path === path && (!side || commentSide(c) === side)) set[c.line] = true;
  });
  if (composerState && composerState.path === path && (!side || commentSide(composerState) === side)) set[composerState.line] = true;
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
    seq: commentSeq, kind: kind, by: 'me', path: path, line: line, code: String(code || ''), text: trimmed,
    from: start, to: end, side: side || null, anchorCode: String(anchorCode == null ? code || '' : anchorCode),
    title: '',
    // Record whether the anchor line exists now so a later rebuild can tell "the line I commented on changed"
    // from "this old-side anchor was never in the working tree". addressed starts false.
    anchorPresent: anchorLinePresent(path, anchorCode, code), addressed: false,
    // WHICH VIEW this was written in. Going back to a comment used to prefer the diff whenever the diff could
    // show the line at all — but a comment written while reading the whole file was about the whole file, and
    // answering it with two narrow hunk panes drops the context it was made in. The view is part of where the
    // comment is, so it is recorded with the line. An agent's note has none (it never sat in a view) and keeps
    // the diff-first rule.
    view: isDiffViewVisible() ? 'diff' : 'source',
    // Set when this comment continues an existing exchange (a Reply on any card in it). The follow-up is a
    // full comment of its own — own seq, own replies — anchored where its parent is, so it renders and
    // travels as part of the same thread.
    replyTo: replyTo == null ? null : Number(replyTo),
  });
  saveComments();
  // …and ask, now, without being told to. The whole point of kakapo keeping its own agent is that leaving a
  // comment IS the question — walking to the terminal to send it was the step that made a reviewer save the
  // question up instead of asking it. A follow-up counts too: a reply is the second half of a question.
  // Quietly skipped where there is no agent to ask (the CLI's browser viewer), rather than toasting about it
  // on every comment somebody writes.
  if (askAvailable()) askComment(commentSeq);
}
// Every earlier turn of the exchange a comment continues, oldest first — whoever wrote each one. Used to
// indent a thread on screen. The hand-off document no longer inlines these: it names their ids and lets the
// agent read them out of the thread file (mergedItemLines).
function commentThreadContext(comment) {
  return commentAncestry(comment).map(function (parent) {
    return { by: parent.by === 'agent' ? 'agent' : 'me', kind: parent.kind, text: parent.text };
  });
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
  // Everything the reader worked out in that conversation is going with it, so this is where the vocabulary
  // asks to keep the concepts (26-terms.js). After the delete, never in front of it: the delete already has
  // an undo, and nothing should have to wait on a dialog. A batch with nothing to learn puts up no dialog.
  offerTermHarvest(removed);
}
// This card and every card that continues from it. A thread hangs off its first comment — a reply carries no
// anchor of its own, only its parent's — so removing that comment without its replies leaves them pointing at
// a parent that is not there: cards that answer a question nobody can read, in a thread with no beginning.
// Deleting the root therefore deletes the thread, which is also the only reading of "delete this" that a
// reviewer looking at the top card has. One batch, so one Cmd+Z brings the whole conversation back.
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
// Every comment anchored in one file, whichever line and whoever wrote it — the file tree's "clear comments"
// row (13-goto.js) both counts and removes by this, so the number it offers is the number it takes.
function commentSeqsForPath(path) {
  return reviewComments.filter(function (c) { return c.path === path; }).map(function (c) { return c.seq; });
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
    // The caret's own pane decides where the card lands: commenting on a line the change deleted is a normal
    // thing to want to do, and it only makes sense beside the base copy of that line.
    if (dline != null) return { path: diffCursor.path, line: dline, code: diffLineText(drow) || '', anchorCode: diffLineText(drow) || '', from: null, to: null, side: diffCursor.side === 'old' ? 'old' : 'new' };
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
// A card rendered INLINE is already sitting on the line it is about, in the file it is about, so repeating
// "@src/foo.ts#L42" in its header restates the only two things the reader can see for certain — and takes up
// to 62% of the head doing it, pushing the title out. A RANGE is the exception worth keeping: a card anchored
// at one line cannot show you that it covers ten. The composer still labels itself unconditionally (you are
// deciding where this attaches, before you write it), and the merged dock still labels everything, because
// there the cards have been lifted away from the code they belong to.
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
// Every thread ends in the box for its next turn, attached under the last card — GitHub's "Write a reply".
// It used to appear only once a thread was already an exchange (the agent answered, or someone followed up),
// so a comment you had just written offered no way onward except finding the ↩ button in its header. Clicking
// it opens the real composer (one shared composerState), on the last card in the thread so the conversation
// keeps going in a line rather than branching.
function replyStubHtml(path, line, side) {
  if (composerAt(path, line, side)) return ''; // already open here
  var cards = commentsAt(path, line, side);
  if (!cards.length) return '';
  var last = cards[cards.length - 1];
  return '<button type="button" class="mc-card mc-reply-stub" data-path="' + escapeHtml(path) + '" data-line="' + line + '"'
    + ' data-seq="' + last.seq + '">' + escapeHtml(t('composer.reply')) + '</button>';
}
// One card per turn, in the order they were written — the reviewer's own (below) and the agent's
// (agentCardHtml, 23-annotations.js), which is the only difference between them now.
function reviewerCardHtml(c) {
  var addressed = !!c.addressed;
  // Ask: hand THIS comment to the hidden session and let the answer come back under it (27-ask.js). Only on
  // a root comment — a follow-up already sits in a thread the session is reading — and only where there is a
  // main process to run an agent, so the CLI's browser viewer never offers a button that cannot work.
  var asking = askIsPending(c.seq);
  var canAsk = c.replyTo == null && askAvailable();
  return '<div class="mc-card mc-' + c.kind + (addressed ? ' mc-addressed' : '') + (asking ? ' mc-asking' : '') + (c.replyTo != null ? ' mc-reply-card' : '') + '">'
    + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml() + '</span>'
    + commentTargetHeadHtml(c)
    + (addressed ? '<span class="mc-addressed-tag" title="' + escapeHtml(t('comment.addressed.hint')) + '">' + escapeHtml(t('comment.addressed')) + '</span>' : '')
    + (addressed ? '<button type="button" class="mc-reopen" data-seq="' + c.seq + '" aria-label="' + escapeHtml(t('comment.reopen')) + '" title="' + escapeHtml(t('comment.reopen')) + '">↺</button>' : '')
    // No button while one is out: the waiting card below the comment says so, and two marks for one state on
    // one card is how the header dot came to be the only thing announcing it.
    + (canAsk && !asking ? '<button type="button" class="mc-ask" data-ask="' + c.seq + '"'
      + ' aria-label="' + escapeHtml(t('ask.button')) + '" title="' + escapeHtml(t('ask.button')) + '">?</button>' : '')
    + '<button type="button" class="mc-del" data-keyhint="Del" data-seq="' + c.seq + '" aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">×</button></div>'
    + '<div class="mc-card-body">' + escapeHtml(c.text) + '</div></div>';
}
// Is the open composer the one that belongs in this (path, line, pane) slot?
function composerAt(path, line, side) {
  return !!(composerState && composerState.path === path && composerState.line === line
    && (!side || commentSide(composerState) === side));
}
function threadHtml(path, line, side) {
  var html = '';
  var waiting = false;
  commentsAt(path, line, side).forEach(function (c) {
    if (composerState && composerState.editSeq === c.seq) return; // being edited -> rendered as the composer below
    html += c.by === 'agent' ? agentCardHtml(c) : reviewerCardHtml(c);
    if (askIsPending(c.seq)) waiting = true;
  });
  // The waiting mark stands where the ANSWER will stand (27-ask.js) — below the question, in the slot the
  // reply is about to take. It began as a dot in the card's header, which is both the smallest thing on the
  // card and nowhere near where anything was going to happen.
  if (waiting) html += askThinkingHtml();
  html += replyStubHtml(path, line, side);
  if (composerAt(path, line, side)) {
    var ph = composerState.replyTo != null ? t('composer.reply') : t('composer.comment');
    html += '<div class="mc-card mc-' + composerState.kind + ' mc-composer' + (composerState.replyTo != null ? ' mc-reply-card' : '') + '">'
      // No target label in the head: it is in the textarea now, where it can be edited or deleted.
      + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml() + '</span></div>'
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

function injectThreadRow(anchorRow, path, line, side) {
  if (!anchorRow || !anchorRow.parentNode) return null;
  var tr = document.createElement('tr');
  tr.className = 'mc-comment-row';
  var td = document.createElement('td');
  // source/markdown/csv rows can have >2 cells (csv); span them all. diff (d2h) rows stay 2.
  td.colSpan = (anchorRow.classList && anchorRow.classList.contains('source-row')) ? (anchorRow.children.length || 2) : 2;
  td.className = 'mc-thread-cell';
  td.innerHTML = threadHtml(path, line, side);
  tr.appendChild(td);
  anchorRow.parentNode.insertBefore(tr, anchorRow.nextSibling);
  return tr;
}

// A diff comment is visible in one pane, but its vertical space belongs to the shared review timeline.
// Reserve the exact same height in the opposite pane so semantic anchors, connector curves, and the one
// line-number layer never learn a false offset from opening/closing a comment.
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
  // Comment rows and their spacers now live on both sides (a card anchored to a deleted line sits in the base
  // pane), so pair them by slot across the whole wrapper rather than assuming which pane each is in.
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
  // One file's render is its own business. This loop used to let a throw anywhere inside it escape — and the
  // only caller that can throw is the one that matters: the agent-update handler wraps applyThreadRecords in
  // a bare try/catch, so a single bad wrapper aborted the whole pass, left EVERY file after it painting its
  // last render, and said nothing. The reviewer's comments were all still on screen, correct and stale, with
  // the agent's answers sitting in memory behind them. Isolate per file, and stamp the render key only when
  // that file actually finished, so the next pass retries it rather than trusting a render that never ran.
  container.querySelectorAll('.d2h-file-wrapper').forEach(function (w) {
    // No need to clear the render key here: it is only stamped once a file has actually painted, so a file
    // that threw is already un-stamped and the next pass retries it.
    try { renderDiffCommentsForFile(w, commentsByPath, remember); }
    catch (e) { try { console.error('kakapo: comments render failed for one file', e); } catch (e2) {} }
  });
  return affected;
}
function renderDiffCommentsForFile(w, commentsByPath, remember) {
  var nameEl = w.querySelector('.d2h-file-name');
  var path = (nameEl && nameEl.textContent ? nameEl.textContent : '').trim();
  if (!path) return;
  var pathComments = commentsByPath[path] || [];
  var activeComposer = composerState && composerState.path === path ? composerState : null;
  var renderKey = JSON.stringify({
    // `askIsPending` is part of the key because it is part of what the card DRAWS (the waiting card in
    // threadHtml). Without it the cache answered "nothing changed" for the two moments that matter most: the
    // question going out, and the answer coming back. The waiting mark never appeared in the diff pane, and
    // where it did appear it stayed after the answer had already landed under it.
    comments: pathComments.map(function (comment) {
      return [comment.seq, comment.kind, comment.by, comment.replyTo, comment.line, comment.from, comment.to, commentSide(comment), comment.text, askIsPending(comment.seq)];
    }),
    composer: activeComposer
      ? [activeComposer.kind, activeComposer.line, activeComposer.from, activeComposer.to, commentSide(activeComposer), activeComposer.editSeq, activeComposer.editText || '']
      : null,
  });
  var slotCount = relevantLines(path, 'new').length + relevantLines(path, 'old').length;
  var existingRows = w.querySelectorAll('.mc-comment-row');
  var existingSpacers = w.querySelectorAll('.mc-comment-spacer-row');
  // A watch/lazy body swap can remove rows without changing comment data. Count expected timeline slots as
  // part of the cache validity check so that a newly materialized table still receives its comments.
  if (w.__mcDiffCommentRenderKey === renderKey && existingRows.length === slotCount && existingSpacers.length === slotCount) return;
  // Stamped at the END, once the rows are actually in. It used to be stamped here, before any of the bail-outs
  // below — so a file whose body had not materialized recorded a render it never performed.
  if (!slotCount && !existingRows.length && !existingSpacers.length) { w.__mcDiffCommentRenderKey = renderKey; return; }
  w.querySelectorAll('.mc-comment-row, .mc-comment-spacer-row').forEach(function (row) { row.remove(); });
  remember(w);
  if (!slotCount) { w.__mcDiffCommentRenderKey = renderKey; return; }
  var sides = w.querySelectorAll('.d2h-file-side-diff');
  var right = sides[sides.length - 1];
  var left = sides[0];
  if (!right || !left || right === left) return; // body not materialized yet — retry on the next pass
  var codeRows = function (side) {
    return Array.prototype.slice.call(side.querySelectorAll('tr')).filter(function (row) {
      return !row.classList.contains('mc-comment-row') && !row.classList.contains('mc-spacer-row');
    });
  };
  // Split rows align 1:1 by index, so a card in one pane reserves its height at the same index in the other.
  var rowsBySide = { new: codeRows(right), old: codeRows(left) };
  ['new', 'old'].forEach(function (side) {
    var rows = rowsBySide[side];
    var peers = rowsBySide[side === 'new' ? 'old' : 'new'];
    relevantLines(path, side).forEach(function (line) {
      for (var i = 0; i < rows.length; i++) {
        var num = rows[i].querySelector('.d2h-code-side-linenumber');
        if (num && (num.textContent || '').trim() === String(line)) {
          // The pane is part of the slot key: old line 12 and new line 12 are two different anchors.
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
  var viewer = document.getElementById('source-viewer');
  var path = viewer ? (viewer.dataset.openPath || '') : '';
  if (!path) return;
  relevantLines(path).forEach(function (line) {
    var anchor = body.querySelector('.source-row[data-line-index="' + (line - 1) + '"]');
    if (anchor) injectThreadRow(anchor, path, line);
  });
  // Every card this just injected can carry a Mermaid fence, and the placeholders it renders are inert until
  // something asks for them. refreshComments() does that at its own end — but openSourceFile (11-render-http.js)
  // calls THIS function directly, on three paths, and following a note's path link is exactly that: the cards
  // reappeared in the source view and their diagrams sat on "loading…" until some later refresh happened to
  // run. Rendering here instead of at each caller means a new caller cannot forget. Already-rendered nodes are
  // skipped inside, so the extra scan on the refreshComments path costs nothing.
  try { renderMermaidDiagrams(body); } catch (e) {}
}

// Per-file comment counts as small (no-emoji) badges in BOTH sidebars — appended after the compact
// Changes row and after the file name in the Files tree.
function renderCommentBadges() {
  document.querySelectorAll('.mc-file-badge').forEach(function (b) { b.remove(); });
  var counts = {};
  reviewComments.forEach(function (x) { counts[x.path] = (counts[x.path] || 0) + 1; });
  function makeBadge(n) {
    var badge = document.createElement('span');
    badge.className = 'mc-file-badge';
    badge.innerHTML = '<span class="mc-fb" title="' + n + ' ' + escapeHtml(t('badge.comments')) + '">' + n + '</span>';
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
    if (wrapper === diffActiveWrapper()) {
      refreshLayeredDiffGutters(wrapper);
    } else {
      scheduleLayeredDiffGutters(wrapper);
    }
  });
  // A removed comment must not leave the previous base transform or connector geometry on screen until the
  // next user scroll. Recompute the active timeline in this same update, after both pane heights match.
  if (changedDiffWrappers.length) scrollAsymmetricDiff();
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
  // The place, IN the text rather than printed above it. As a label in the header it was a fact about the
  // comment that the writer could not touch — and the thing they most often want to say is that the question
  // is not about this line at all ("while I'm here — why does the wiki come into this?"). Prefilled it is
  // still there by default and a Backspace away when it is wrong, and what the agent is told follows what
  // the comment actually says (askPromptForComment, 27-ask.js).
  composerState.editText = commentTargetLabel(composerState) + ' ';
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
    // Inheriting `note` would make the reviewer's own words read as the agent's and keep them out of the
    // hand-off entirely, so a follow-up to an explanation is a plain review comment like any other.
    kind: 'c',
    path: parent.path, line: parent.line, code: parent.code, anchorCode: parent.anchorCode,
    from: parent.from, to: parent.to, side: parent.side, replyTo: parent.seq,
  };
  try { var rsel = window.getSelection(); if (rsel) rsel.removeAllRanges(); } catch (e) {}
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
  clearTreeFocus();
  if (isDiffViewVisible() && typeof diffCursor !== 'undefined' && diffCursor) {
    setDiffCursor(diffCursor.path, diffCursor.side, diffCursor.rowIndex, diffCursor.column, false);
  } else if (isSourceViewerVisible() && typeof viewerCursor !== 'undefined' && viewerCursor) {
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
  return t(kind === 'plan' ? 'plan.contract' : 'mergePrompt.default.c');
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
// The file is often not here yet. On a lazy review openSourceFile paints a loading placeholder and fetches
// the content, so a caret placed one frame later found `file.embedded` false and setSourceCursor returned
// having done nothing at all — silently. On screen that is "the file changed but the comment is nowhere":
// the body finishes painting at the top of the file while the card sits four hundred lines down, and nothing
// ever comes back to place the caret. Wait for the content instead of guessing a frame; loadSourceFile
// dedupes with the fetch openSourceFile already started, and resolves immediately when there is nothing to
// fetch, so the eager path costs one microtask.
function navigateToLine(path, line) {
  openSourceFile(path);
  var place = function () {
    requestAnimationFrame(function () { setSourceCursor(path, Math.max(0, (Number(line) || 1) - 1), 0, true, -1); });
  };
  loadSourceFile(path).then(place, place);
}
// A path an agent names in prose is a place to go: `campaign_control.py`, `tests/foo/test_bar.py:42`. The
// agent writes it relative to wherever it works, so an exact hit is tried first, then the SHORTEST project
// path ending in it — the least surprising of several matches. The index is fetched lazily, so a path in no
// open file is retried once it arrives instead of silently doing nothing.
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
  // Nothing matched, and the project index may simply not be loaded yet — fetch it and try once more. If it
  // still misses, SAY so: a link that swallows the click looks like a broken app rather than what it is, a
  // file the agent named that this workspace does not have.
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
// The agent's notes walk in the order the EXPLANATION was built — group by group, and inside a group in the
// order they were appended — because that order is the argument being made. File position is where the code
// happens to live, which is a different thing and was the only order this used to offer. Everything ungrouped
// (the reviewer's own comments, and any note written before groups existed) keeps that file order, after them.
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
// Land the DIFF caret on a comment's row (kept the diff view active, matching how F7 never leaves it).
// Most comments carry side: null (made from the keyboard caret, not a mouse drag — see
// currentCommentTarget), so try the NEW side first, same "track the new file" convention hunk-nav uses
// (02-diff-nav.js), then fall back to the other side. Returns false when there's no matching row (e.g. the
// file's diff body isn't materialized yet) so the caller can fall back to the source-view jump.
function navigateToLineInDiff(path, line, side) {
  var wrapper = diffWrapperByPath(path);
  if (!wrapper) return false;
  // A hidden file's body may not be materialized yet (REVIEW_LAZY), and its rows are unfindable until it is —
  // so reveal it before looking for the line, not after. setDiffCursor reveals too, but by then this lookup
  // would already have failed and sent the jump to the source view instead.
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
// The Cmd+F7 entry point (05-keymap.js). delta: +1 next, -1 previous, wrapping at both ends — a short
// browsing aid, not F7's "press again to cross a file" boundary gate (that exists to protect against
// skipping an unviewed file, which doesn't apply to a deliberately-browsed comment list).
// Pick the next (delta > 0) or previous anchor relative to wherever the caret currently is, wrapping at
// both ends. `list` is already in diff order (sortedNavComments); each item needs a
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
  // Is the caret standing on this card? Its anchor is a RANGE — from..to for a drag selection — and
  // revealComment puts the caret on `line`, which for such a card is not `from`. Comparing against one end
  // only meant that after stepping onto a range the walk no longer recognised where it was, fell through to
  // the positional search below, and jumped to whatever happened to come first in GROUP order — usually a
  // note near the end of the file. "The first F8 works and then it goes to the end" was exactly that.
  function standingOn(c) {
    if (c.path !== curPath) return false;
    var ends = [lineOf(c), Number(c.line) || 0, Number(c.to) || 0].filter(Boolean);
    return curLine >= Math.min.apply(null, ends) && curLine <= Math.max.apply(null, ends);
  }
  // On a card: walk by INDEX from it. The walk is ordered by the agent's groups, so the next note in the
  // story is often further UP the file and the previous one further DOWN — a positional search cannot
  // express that order at all.
  //
  // WHICH card, though. The caret is a line, and a line does not identify a card: notes accumulate in the
  // repository's shared knowledge file, so two explanations of the same code put two separate notes on the
  // same line, and "the first card standing here" was always the same one of them. Stepping off the second
  // note computed its way back to the first and returned the second again — F8 pressed forever without
  // moving, and the note behind it could not be reached at all. So the walk remembers the card it last put
  // the caret on and starts from that one while the caret is still standing there.
  var byId = {};
  list.forEach(function (c) { byId[c.seq] = c; });
  var at = -1;
  for (var k = 0; k < list.length; k++) {
    if (!standingOn(list[k])) continue;
    if (at < 0) at = k;
    if (list[k].seq === lastRevealedSeq) { at = k; break; }
  }
  if (at >= 0) {
    // A THREAD is one stop — skip the card we are leaving and its replies, or stepping would land on an
    // answer to the question we just read and look like the key did nothing. Sharing an anchor is not the
    // same as being one conversation, which is what this used to test.
    var here = commentThreadRoot(list[at], byId);
    var dir = delta > 0 ? 1 : -1;
    for (var n = 1; n <= list.length; n++) {
      var candidate = list[((at + dir * n) % list.length + list.length) % list.length];
      if (!standingOn(candidate) || commentThreadRoot(candidate, byId) !== here) return candidate;
    }
    return list[at]; // the whole review is one thread anchored here; there is nowhere else to go
  }
  // Not on a card — the reader scrolled or clicked somewhere of their own. Enter the walk at the NEAREST card
  // in the file rather than at the first one in group order, which is an order about the explanation and says
  // nothing about where the caret happens to be. From the next press on, the story's order takes over.
  var best = null, bestGap = Infinity;
  for (var j = 0; j < list.length; j++) {
    var item = list[j];
    var sameFile = curOrder != null && rank(item) === curOrder;
    var gap = sameFile ? (delta > 0 ? lineOf(item) - curLine : curLine - lineOf(item)) : Infinity;
    if (sameFile && gap > 0 && gap < bestGap) { best = item; bestGap = gap; }
  }
  if (best) return best;
  // Nothing left in this file that way: fall out to the file order, which is where the reader would look next.
  var byFile = list.slice().sort(function (a, b) {
    return rank(a) !== rank(b) ? rank(a) - rank(b) : lineOf(a) - lineOf(b);
  });
  if (curOrder == null) return delta > 0 ? byFile[0] : byFile[byFile.length - 1];
  if (delta > 0) return byFile.find(function (c) { return rank(c) > curOrder; }) || byFile[0];
  for (var m = byFile.length - 1; m >= 0; m--) if (rank(byFile[m]) < curOrder) return byFile[m];
  return byFile[byFile.length - 1];
}
// F8 steps every card on the diff, whoever wrote it — an agent's explanation and a reviewer's question are
// the same object to a reader walking the file. They are one list now, so this is just that list in file
// order; the name stays because the whole viewer calls it.
function sortedNavThread() {
  return sortedNavComments();
}
// The card hangs BELOW the line it is anchored to, so revealing only the anchor row leaves the card — the
// thing the reader is actually going to — hanging off the bottom edge, clipped. Center the whole thread row
// instead. Scheduled after the caret's own reveal (registered first, so this frame's later scroll wins), and
// retried a few frames because a freshly opened source file renders its rows asynchronously.
// Every reveal claims the scroll. A retry belongs to the target that started it, and gives up the moment a
// newer one is chosen — without that, a row that renders late (a long file, lazily built rows) would find
// itself two presses after it was asked for and drag the view BACK to where you no longer are. That is the
// "F8 goes and then returns" this counter removes; it costs one comparison per frame.
var centerThreadTarget = 0;
function centerThreadRow(path, line, side, tries, token) {
  var mine = token === undefined ? ++centerThreadTarget : token;
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
// Can the diff put the caret on this comment's line? A diff is hunks, not files: a comment on a line no hunk
// covers — which is where the Explain prompt deliberately puts its briefing note — has no row to land on, and
// neither does one on a file this review does not change at all. Asked before anything moves, so the answer
// can decide WHICH view to show rather than being discovered after switching to the wrong one.
function diffCanShowComment(c) {
  var wrapper = c && diffWrapperByPath(c.path);
  if (!wrapper) return false;
  // A lazily-built file has no rows until it is revealed, and "no rows" is not "no line" — reveal first, or
  // every comment in a collapsed file would be answered with a wrong no.
  if (wrapper.classList.contains('df-inactive')) revealDiffFile(c.path);
  var line = Number(c.from) || c.line;
  var sides = commentSide(c) === 'old' ? ['old', 'new'] : ['new', 'old'];
  for (var i = 0; i < sides.length; i++) if (diffRowIndexForLine(wrapper, sides[i], line) >= 0) return true;
  return false;
}
// Land on one specific card: the tail every "go to a comment" path shares — F8's step, and the click on a
// notification about an answer (kakapo:comments-reveal, below).
//
// Go back to the view the comment was WRITTEN in (`view`, set in addComment). It used to hinge on which view
// happened to be open, which stranded a walk in Files; that was replaced by "the diff wins whenever it can
// show the line", and that overshot the other way — a comment written while reading the whole file was about
// the whole file, and answering it with two narrow hunk panes takes away the context it was made in. Where
// you were IS part of where the comment is, so it travels with the line rather than being re-decided later.
//
// Two things still override it. A line no hunk covers cannot be shown in the diff at all (the briefing note is
// deliberately one of those), and an agent's note has no `view` because it never sat in a view — those keep
// the diff-first rule, which is right for them: the change beside a note is half of what the note means.
//
// lastRevealedSeq is the card the walk last landed on. A line cannot say which of the cards anchored to it you
// are reading, and stepAnchor needs to know — see the walk-by-index branch there.
var lastRevealedSeq = 0;
function revealComment(seq) {
  var target = reviewComments.find(function (c) { return c.seq === seq; });
  if (!target) return false;
  lastRevealedSeq = seq;
  var center = function () { centerThreadRow(target.path, Number(target.line) || 1, commentSide(target), 0); };
  var land = function () {
    if (!navigateToCommentInDiff(target.seq)) navigateToComment(target.seq);
    center();
  };
  // Short-circuited on purpose: a comment that belongs in the source view must not make diffCanShowComment
  // materialize a diff file (revealDiffFile) that nothing is going to show.
  if (target.view === 'source' || !diffCanShowComment(target)) {
    navigateToComment(target.seq);
    // Same race as navigateToLine: on a lazy review the row this wants to centre does not exist for as long
    // as the fetch takes, and its own retry budget is four frames — nowhere near a round trip.
    loadSourceFile(target.path).then(center, center);
    return true;
  }
  // showDiffView, not activateChangesView: this is "show the diff", not "go work in the tree" — the latter
  // focuses the sidebar row, which takes the caret off the code we are about to put it on. Opening the diff
  // for the first time also selects hunk 0, and that lands a frame later: placing the caret in the same tick
  // put it on the right line and then watched the view drag it back to the top of the file.
  if (isDiffViewVisible()) land();
  else { showDiffView(false); requestAnimationFrame(land); }
  return true;
}
function gotoComment(delta) {
  // NOT filtered by the source index. Scoping a shared note to the workspace that has its file is main's job
  // (notesForWorkspace, comments-file.ts) and it is done before the renderer ever sees the record. Filtering
  // again here read `sourceByPath`, which on a diff-first launch holds only the CHANGED files — so notes on
  // untouched files vanished from the walk while the card badge, counting the unfiltered list, went on
  // numbering them. F8 then bounced between whichever two survived, calling them 8/9 and 9/9.
  // The briefing has no card to land on (isBriefingCard), so the walk steps past it — otherwise F8 stopped at
  // a line with nothing on it. Its own note is still reachable: ⌘⇧B.
  var list = sortedNavThread().filter(function (c) { return !isBriefingCard(c); });
  if (!list.length) { showCaretHint(t('comment.nav.none')); return true; }
  revealComment(stepAnchor(delta, list).seq);
  return true;
}

// The merged prompt's data shape: the agent-contract prose, then every open comment. It used to be two
// blocks — questions first (answer, don't edit), change requests second — which forced the reviewer to
// decide which one a comment was before writing it. It is one conversation, so it is one block, and the
// contract tells the agent to answer what is asked and change what is requested.
// With nothing open, an empty block is still returned so the panel isn't a dead surface (matching its
// long-standing behavior of a blank scratch document you can still type into and copy).
// Comment bodies are never edited by typing into this document (see mergedCardHtml/the merged dock) — they
// render `comment.text` verbatim and read/write straight through `reviewComments`, so there is no markdown
// round-trip of comment text to get wrong, and no reconcile step needed at all.
// The seq of the comment a thread hangs off, following replyTo up. Used to ask "has the agent spoken in this
// conversation since?" — a question about the whole thread, not about one card's direct children.
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
  // An agent's own cards (its answers and its notes) are not requests going back to it, so they are never
  // items here — they reach it as the quoted context of the follow-up that continues them.
  //
  // And a request the agent has ALREADY answered is not a request either. The hand-off used to carry every
  // unaddressed comment, so a question answered in round one went back in round two, and round three, wearing
  // an "answered" tag — the agent was handed its own finished work as if it were new, and the reviewer had to
  // read past it to find what they had actually just written. The turn is what decides: a comment goes over
  // only while the agent has not spoken in its thread since. Reply to an answer and the reply goes over (with
  // `continues #N` naming the history); say nothing and the thread is done.
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
  // The plan contract leads: a comment can ask for work, so plan first and decompose into verifiable steps
  // without asking the agent to add an application-state file to the repository.
  return [{ prose: open.length ? mergePromptFor('plan') + '\n\n' + mergePromptFor('c') : '', items: open }];
}

// One unified hand-off document as a single string (Copy all's default, "Send to terminal", and tests).
// The live merged dock instead renders each block as its own small editable surface plus one non-editable
// card per comment (see openMergedView/currentMergedText in 08-dock.js) — this stays the static/default view.
// One comment's lines in the hand-off document — shared with the live panel's currentMergedText (08-dock.js)
// so the two can't drift. The id leads the heading because that is what an agent replies to: it appends a
// line with `"re": <id>` to the thread file.
//
// A follow-up names the ids it continues instead of quoting them. Quoting made the document grow with the
// conversation — a third round re-sent the question AND the agent's own multi-paragraph answer, every time,
// for every comment in the review — and all of it was already in the thread file this document points at,
// under exactly these ids. So the reviewer's own words (the request) stay inline, and the history is a
// lookup. `id` here is the record's `id` in the file: commentToRecord writes `seq` as `id`.
function mergedItemLines(c) {
  var lines = ['### #' + c.seq + ' ' + commentTargetLabel(c)];
  var ancestry = commentAncestry(c);
  if (ancestry.length) {
    lines.push(t('mergePrompt.continues') + ' ' + ancestry.map(function (p) { return '#' + p.seq; }).join(', '));
    lines.push('');
  }
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
// No "answered" tag any more: an answered comment is not in this document at all (mergedBlocks). The tag
// existed to explain why a finished exchange was still sitting in the hand-off, and the answer to that turned
// out to be "it should not be". The answer itself stays one click away, in the thread at the comment's line.
function mergedCardHtml(comment) {
  return '<div class="mc-card mc-merged-card mc-' + comment.kind + '" data-comment-seq="' + comment.seq + '" tabindex="-1" role="button">'
    + '<div class="mc-card-head"><span class="mc-kind">' + commentKindHtml() + '</span>'
    + '<span class="mc-target">' + escapeHtml(commentTargetLabel(comment)) + '</span>'
    + '</div>'
    + '<div class="mc-card-body">' + escapeHtml(comment.text) + '</div></div>';
}
