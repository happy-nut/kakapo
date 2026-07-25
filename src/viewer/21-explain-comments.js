// ===== Explain view comments: a parallel comment store anchored by {sectionId, blockId} instead of the
// diff/source store's {path, line, side} (see 07-comments.js). Kept as a small, separate implementation
// rather than generalizing the existing store — reviewComments/addComment/etc. are used by ~10 call sites
// tied to diff/source DOM shapes (table rows, line-drift re-anchoring) that don't apply to prose blocks.
//
// Deliberately uses its OWN class names for the composer/delete controls (.explain-mc-input/-del/-save/
// -cancel, not .mc-input/-del/-save/-cancel) — those exact names are matched by document-level delegated
// listeners wired to the diff/source store (08-dock.js); reusing them would route these comments into the
// wrong array. .mc-card/.mc-card-head/.mc-target/.mc-card-body/.mc-btn/.mc-ghost/.mc-hint/.mc-actions carry
// no such delegation and are reused as-is for visual consistency.
//
// v1 scope: one comment "kind" (no question/change-request split), whole-block anchoring only (diagram
// nodes and table rows are not individually addressable — comment on the block, reference specifics in the
// text), and no edit-in-place (delete + re-add covers it). A comment whose blockId no longer exists after a
// spec regeneration simply has nothing to anchor to until a matching blockId reappears — still persisted,
// never lost.

var EXPLAIN_COMMENTS_KEY = 'kakapo-explain-comments:' + location.pathname;
var explainComments = (function () {
  var b = persistRead(EXPLAIN_COMMENTS_KEY);
  if (Array.isArray(b)) return b;
  try { var v = JSON.parse(localStorage.getItem(EXPLAIN_COMMENTS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
})();
if (!Array.isArray(explainComments)) explainComments = [];
var explainComposerState = null; // { sectionId, blockId } while composing a new comment on that block
var explainCommentUndoStack = [];

function saveExplainComments() { persistSave(EXPLAIN_COMMENTS_KEY, explainComments); }

function explainCommentsAt(blockId) {
  return explainComments.filter(function (c) { return c.blockId === blockId; });
}

function addExplainComment(sectionId, blockId, text) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return;
  commentSeq += 1; // shared counter with the diff/source store (01-core.js) — seq stays globally unique
  // answer/answeredAt: filled in by applyExplainAnswersUpdate() once an agent writes into answers.json
  // (same file/format as the diff/source store — see answers-ipc.ts and sendExplainCommentsToTerminal below).
  explainComments.push({ seq: commentSeq, sectionId: sectionId, blockId: blockId, text: trimmed, answer: null, answeredAt: null });
  saveExplainComments();
}
function removeExplainComments(seqs) {
  var removed = explainComments.filter(function (c) { return seqs.indexOf(c.seq) !== -1; });
  if (!removed.length) return;
  explainCommentUndoStack.push(removed);
  if (explainCommentUndoStack.length > 20) explainCommentUndoStack.shift();
  explainComments = explainComments.filter(function (c) { return seqs.indexOf(c.seq) === -1; });
  saveExplainComments();
}
function deleteExplainComment(seq) {
  removeExplainComments([seq]);
  refreshExplainComments();
}
function undoLastExplainCommentRemoval() {
  var batch = explainCommentUndoStack.pop();
  if (!batch || !batch.length) return false;
  explainComments = explainComments.concat(batch);
  saveExplainComments();
  refreshExplainComments();
  showToast(t(batch.length > 1 ? 'comment.restoredMany' : 'comment.restored'));
  return true;
}

function explainCommentTargetLabel(sectionId, blockId) { return '@' + sectionId + '#' + blockId; }

function explainBlockElementById(blockId) {
  var doc = document.getElementById('explain-doc');
  if (!doc) return null;
  var blocks = doc.querySelectorAll('.explain-block');
  for (var i = 0; i < blocks.length; i++) { if (blocks[i].dataset.blockId === blockId) return blocks[i]; }
  return null;
}

// Rendered inside a comment's .mc-card, right after .mc-card-body, once an agent has written an answer
// into answers.json (see applyExplainAnswersUpdate below). Reuses the diff/source store's .mc-card-answer/
// .mc-answer-label/.mc-answer-body CSS as-is — purely presentational, no delegated behavior tied to it.
function explainCommentAnswerHtml(c) {
  if (!c || !c.answer) return '';
  return '<div class="mc-card-answer"><span class="mc-answer-label">' + escapeHtml(t('comment.answer')) + '</span>'
    + '<div class="mc-answer-body">' + escapeHtml(c.answer) + '</div></div>';
}
function explainThreadHtml(sectionId, blockId) {
  var html = '';
  explainCommentsAt(blockId).forEach(function (c) {
    var target = explainCommentTargetLabel(c.sectionId, c.blockId);
    html += '<div class="mc-card">'
      + '<div class="mc-card-head"><span class="mc-target" title="' + escapeHtml(target) + '">' + escapeHtml(target) + '</span>'
      + '<button type="button" class="explain-mc-del" data-keyhint="Del" data-seq="' + c.seq + '" aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">&times;</button></div>'
      + '<div class="mc-card-body">' + escapeHtml(c.text) + '</div>' + explainCommentAnswerHtml(c) + '</div>';
  });
  if (explainComposerState && explainComposerState.blockId === blockId) {
    html += '<div class="mc-card">'
      + '<div class="mc-card-head"><span class="mc-target">' + escapeHtml(explainCommentTargetLabel(sectionId, blockId)) + '</span></div>'
      + '<textarea class="explain-mc-input" rows="3" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="' + escapeHtml(t('explain.addComment')) + '"></textarea>'
      + '<div class="mc-actions"><button type="button" class="mc-btn explain-mc-save" data-keyhint="⌘&#8629;">' + escapeHtml(t('composer.save')) + '</button>'
      + '<button type="button" class="mc-btn mc-ghost explain-mc-cancel" data-keyhint="Esc">' + escapeHtml(t('composer.cancel')) + '</button>'
      + '<span class="mc-hint">' + escapeHtml(t('composer.hint')) + '</span></div></div>';
  }
  return html;
}

function explainRelevantBlockIds() {
  var set = {};
  explainComments.forEach(function (c) { set[c.blockId] = true; });
  if (explainComposerState) set[explainComposerState.blockId] = true;
  return Object.keys(set);
}

function updateExplainCommentBadges() {
  var doc = document.getElementById('explain-doc');
  if (!doc) return;
  doc.querySelectorAll('.explain-comment-badge').forEach(function (b) { b.remove(); });
  var counts = {};
  explainComments.forEach(function (c) { counts[c.blockId] = (counts[c.blockId] || 0) + 1; });
  Object.keys(counts).forEach(function (blockId) {
    var el = explainBlockElementById(blockId);
    if (!el) return;
    var badge = document.createElement('span');
    badge.className = 'explain-comment-badge';
    badge.textContent = String(counts[blockId]);
    el.appendChild(badge);
  });
}

function updateExplainSendCommentsButton() {
  var btn = document.getElementById('explain-send-comments');
  if (btn) btn.classList.toggle('hidden', explainComments.length === 0);
}

// Called after every spec render (renderExplainSpec in 20-explain.js) and after any comment mutation.
function refreshExplainComments() {
  var doc = document.getElementById('explain-doc');
  if (!doc) return;
  doc.querySelectorAll('.explain-thread').forEach(function (node) { node.remove(); });
  explainRelevantBlockIds().forEach(function (blockId) {
    var blockEl = explainBlockElementById(blockId);
    if (!blockEl) return; // orphaned after a regeneration — still persisted, just nothing to anchor to right now
    var thread = document.createElement('div');
    thread.className = 'explain-thread';
    thread.innerHTML = explainThreadHtml(blockEl.dataset.sectionId || '', blockId);
    blockEl.parentNode.insertBefore(thread, blockEl.nextSibling);
  });
  updateExplainCommentBadges();
  updateExplainSendCommentsButton();
  explainApplySelectionClass();
}

// ----- keyboard block selection: Up/Down (05-keymap.js, guarded by isExplainViewVisible) move a
// "selected" block; "?" opens a comment composer on it — the keyboard-driven equivalent of clicking a
// block's + affordance, mirroring the diff/source "?"/">" -> currentCommentTarget() flow. -----
var explainSelectedBlockId = null;

function explainAllBlockIds() {
  var doc = document.getElementById('explain-doc');
  if (!doc) return [];
  return Array.prototype.map.call(doc.querySelectorAll('.explain-block'), function (el) { return el.dataset.blockId; });
}
// Re-applies the .is-selected class after any doc.innerHTML rebuild (refreshExplainComments runs this on
// every call) — DOM nodes are recreated wholesale on each render, so a plain CSS class does not survive on
// its own. Clears the selection if its block no longer exists (spec regenerated without it).
function explainApplySelectionClass() {
  var doc = document.getElementById('explain-doc');
  if (!doc) return;
  doc.querySelectorAll('.explain-block.is-selected').forEach(function (el) { el.classList.remove('is-selected'); });
  if (!explainSelectedBlockId) return;
  var el = explainBlockElementById(explainSelectedBlockId);
  if (el) el.classList.add('is-selected');
  else explainSelectedBlockId = null;
}
function explainSelectBlock(blockId, scroll) {
  explainSelectedBlockId = blockId || null;
  explainApplySelectionClass();
  if (scroll !== false && explainSelectedBlockId) {
    var el = explainBlockElementById(explainSelectedBlockId);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
}
function explainClearSelection() {
  if (!explainSelectedBlockId) return false;
  explainSelectBlock(null);
  return true;
}
function explainMoveSelection(delta) {
  var ids = explainAllBlockIds();
  if (!ids.length) return false;
  var idx = explainSelectedBlockId ? ids.indexOf(explainSelectedBlockId) : -1;
  var next = idx < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, idx + delta));
  explainSelectBlock(ids[next]);
  return true;
}
// "?" with nothing selected yet selects the first block instead of no-op'ing, so it works without a
// mandatory Up/Down press first.
function explainOpenComposerForSelection() {
  if (!explainSelectedBlockId && !explainMoveSelection(1)) return false;
  var el = explainBlockElementById(explainSelectedBlockId);
  if (!el) return false;
  openExplainComposer(el.dataset.sectionId || '', explainSelectedBlockId);
  return true;
}

function openExplainComposer(sectionId, blockId) {
  explainComposerState = { sectionId: sectionId, blockId: blockId };
  refreshExplainComments();
  var doc = document.getElementById('explain-doc');
  var ta = doc && doc.querySelector('.explain-mc-input');
  if (ta) { try { ta.focus(); } catch (e) {} }
}
function closeExplainComposer() {
  if (!explainComposerState) return;
  explainComposerState = null;
  refreshExplainComments();
}
function saveExplainComposer(ta) {
  if (!explainComposerState) return;
  var doc = document.getElementById('explain-doc');
  var box = ta || (doc && doc.querySelector('.explain-mc-input'));
  if (!box) return;
  addExplainComment(explainComposerState.sectionId, explainComposerState.blockId, box.value);
  explainComposerState = null;
  refreshExplainComments();
}

// Hand accumulated feedback back to the agent for a revision pass — same gesture as the diff/source
// merged-comments "send to terminal" flow, just built from this store instead of reviewComments.
function buildExplainMergedText() {
  var nl = String.fromCharCode(10);
  var lines = [];
  explainComments.forEach(function (c) {
    lines.push(explainCommentTargetLabel(c.sectionId, c.blockId));
    lines.push(c.text);
    lines.push('');
  });
  return lines.join(nl).replace(/\n+$/, '');
}
// Issue #10, extended to Explain comments: before sending, write an answers.json checklist (same file/
// format the diff/source merged panel uses — see answers-ipc.ts) so the agent can write structured answers
// back instead of only replying in the terminal, then prepend the instruction + path, mirroring
// sendWholeDocToTerminal's exact pattern (08-dock.js). "note" is a fixed kind — Explain comments don't
// split into question/change-request kinds (see the file header).
function sendExplainCommentsToTerminal() {
  if (!explainComments.length) return;
  if (!window.__kakapoTerminal || typeof window.__kakapoTerminal.enterSendMode !== 'function') return;
  var text = buildExplainMergedText();
  var items = explainComments.map(function (c) {
    return { seq: c.seq, kind: 'note', target: explainCommentTargetLabel(c.sectionId, c.blockId), prompt: c.text, answer: null, answeredAt: null };
  });
  function deliver(finalText) {
    window.__kakapoTerminal.enterSendMode(finalText);
  }
  if (window.kakapoAnswers && typeof window.kakapoAnswers.write === 'function') {
    window.kakapoAnswers.write(items).then(function (result) {
      deliver(result && result.ok && result.path ? t('mergePrompt.answersFile') + '\n' + result.path + '\n\n' + text : text);
    }, function () { deliver(text); });
  } else {
    deliver(text);
  }
}
// Pushed from main (kakapo:answers-update) whenever the agent writes new answers into answers.json —
// registered as a SECOND listener alongside 08-dock.js's applyAnswersUpdate (ipcRenderer.on supports
// multiple listeners per channel), so items are just tried against both stores; each matches by seq and
// silently ignores items it doesn't own.
function applyExplainAnswersUpdate(items) {
  if (!Array.isArray(items) || !items.length) return;
  var changed = false;
  items.forEach(function (item) {
    var c = explainComments.find(function (x) { return x.seq === item.seq; });
    if (!c) return;
    c.answer = item.answer;
    c.answeredAt = item.answeredAt;
    changed = true;
  });
  if (changed) { saveExplainComments(); refreshExplainComments(); }
}
if (window.kakapoAnswers && typeof window.kakapoAnswers.onUpdate === 'function') {
  window.kakapoAnswers.onUpdate(function (items) { try { applyExplainAnswersUpdate(items); } catch (e) {} });
}

(function wireExplainComments() {
  var sendBtn = document.getElementById('explain-send-comments');
  if (sendBtn) sendBtn.addEventListener('click', sendExplainCommentsToTerminal);

  document.addEventListener('click', function (event) {
    var t = event.target;
    if (!t || !t.closest) return;
    var add = t.closest('.explain-comment-affordance');
    if (add) { event.preventDefault(); explainSelectBlock(add.dataset.blockId, false); openExplainComposer(add.dataset.sectionId, add.dataset.blockId); return; }
    var del = t.closest('.explain-mc-del');
    if (del) { event.preventDefault(); deleteExplainComment(parseInt(del.dataset.seq, 10)); return; }
    if (t.closest('.explain-mc-save')) { event.preventDefault(); saveExplainComposer(); return; }
    if (t.closest('.explain-mc-cancel')) { event.preventDefault(); closeExplainComposer(); return; }
    // Click anywhere else in a block selects it (keyboard-visible focus, and "?" then targets it).
    var block = t.closest('.explain-block');
    if (block) { explainSelectBlock(block.dataset.blockId, false); return; }
  });
  document.addEventListener('keydown', function (event) {
    var t = event.target;
    if (!t || !t.classList || !t.classList.contains('explain-mc-input')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeExplainComposer(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveExplainComposer(t); return; }
  }, true);
})();
