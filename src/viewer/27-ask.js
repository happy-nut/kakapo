// ===== What the hidden session is doing, said out loud.
//
// kakapo's own agent (ask-session.ts) has no pane, no terminal and no output anyone can watch. That is the
// point of it — and it is also the one thing that could make it feel broken: a reviewer clicks Ask, nothing
// visibly happens, and forty seconds later an answer appears from a process they never saw start.
//
// So two marks, and they say different things. The card that asked carries a "waiting" state, because that
// is where the answer is going to land. The status pill in the header says what the session is working on
// right now — including the work that belongs to no card at all (an Explain run over the whole diff), which
// otherwise has nowhere on screen to be. Clicking the pill goes to the card it names.

var askPending = {};   // comment seq -> true, while its answer is being written
var askActive = [];    // [{ label, seq }] — everything the hidden session has in flight, oldest first
// The Settings row's choices. `auto` is two answers, not one — see askModel (app-main.ts), which is the only
// place that decides; this list just has to name the same values.
var ASK_MODEL_KEY = 'kakapo-ask-model';
var ASK_MODELS = ['auto', 'sonnet', 'opus', 'fable', 'inherit'];

// Read through a function, never the variable. The bundle is one script, so `function` declarations hoist
// and this is callable from anywhere — but `var askPending` above is only ASSIGNED when this slice runs, and
// 08-dock.js draws every card at load, before that. Reading the variable directly there is `undefined[seq]`,
// which throws inside the card renderer and takes the whole comment list down with it.
function askIsPending(seq) {
  return !!(askPending && askPending[seq]);
}

function askBridge() {
  return window.kakapoAsk && typeof window.kakapoAsk.ask === 'function' ? window.kakapoAsk : null;
}
// Outside Electron (the CLI's browser viewer) there is no main process to run an agent, so every entry point
// checks this and falls back to the terminal hand-off that has always been there.
function askAvailable() {
  return !!askBridge();
}
function hasTerminal() {
  return !!(window.__kakapoTerminal && typeof window.__kakapoTerminal.handOff === 'function');
}

// The hidden session answered "this needs a code change" rather than answering (ask.prompt.handoff). It
// cannot make the change — nothing invisible is allowed to — so the instruction it wrote travels to the agent
// the reviewer already has open, and kakapo presses Enter only when that pane is plainly idle. Any doubt and
// it stages instead, which is the hand-off every other prompt has always used: the reviewer presses the key.
function deliverHandoff(payload) {
  var text = String((payload && payload.text) || '').trim();
  if (!text || !hasTerminal()) return;
  Promise.resolve(window.__kakapoTerminal.handOff(text)).catch(function () { return false; })
    .then(function (sent) {
      if (sent) { showToast(t('ask.handoff.sent')); return; }
      window.__kakapoTerminal.enterSendMode(text);
      showToast(t('ask.handoff.staged'));
    });
}

// The card in the answer's own slot, holding it open while the answer is being written (threadHtml,
// 07-comments.js). Built as the agent card it is about to become — same tint, same "answer" pill — so what
// arrives replaces it rather than appearing somewhere else on the thread.
function askThinkingHtml() {
  return '<div class="mc-card mc-ai mc-reply-card mc-thinking" aria-live="polite">'
    + '<div class="mc-card-head"><span class="mc-kind mc-kind-ai">' + annotationKindIcon()
    + '<span class="mc-kind-text">' + escapeHtml(t('comment.answer')) + '</span></span></div>'
    + '<div class="mc-card-body mc-thinking-body">'
    + '<span class="mc-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
    + '<span class="mc-thinking-text">' + escapeHtml(t('ask.answering')) + '</span>'
    + '</div></div>';
}

// The pill carries only the work that has nowhere else to show itself — an Explain run over the whole diff,
// which belongs to no card. Anything anchored to a comment is announced ON that comment now, and the same
// thing said twice in two places reads as two things happening.
function renderAskStatus() {
  var el = document.getElementById('ask-status');
  if (!el) return;
  var first = askActive.filter(function (a) { return a.seq == null; })[0];
  el.classList.toggle('hidden', !first);
  if (!first) return;
  var label = el.querySelector('.ask-status-label');
  var more = askActive.length > 1 ? ' +' + (askActive.length - 1) : '';
  if (label) label.textContent = (first.label || t('ask.working')) + more;
  el.title = askActive.map(function (a) { return a.label || t('ask.working'); }).join('\n');
  el.classList.toggle('is-anchored', first.seq != null);
}

// One place decides what is pending: the status the main process pushes. The renderer does not track its own
// requests in parallel — two sources of truth for "is this still running" is how a spinner outlives its work.
function applyAskStatus(payload) {
  askActive = (payload && Array.isArray(payload.asks) ? payload.asks : []).map(function (a) {
    return { label: String((a && a.label) || ''), seq: a && a.seq != null ? Number(a.seq) : null };
  });
  var next = {};
  askActive.forEach(function (a) { if (a.seq != null) next[a.seq] = true; });
  var changed = Object.keys(next).join(',') !== Object.keys(askPending).join(',');
  askPending = next;
  renderAskStatus();
  if (changed) refreshComments(); // the cards' waiting marks come and go with it
}

// The prompt a question becomes. The agent is reading this repository and nothing else, so the comment needs
// its place in the code attached to it — and the thread file named, so a follow-up can be read in context
// rather than arriving as a sentence with no history.
function askPromptForComment(c) {
  // The place is told only while the comment still CLAIMS it. The composer prefills `@path#Lnn` into the text
  // (openComposer, 07-comments.js) precisely so it can be deleted when the question is about something else,
  // and a location attached here regardless would put it straight back and make the deletion mean nothing.
  var claimed = c.path && String(c.text || '').indexOf('@' + c.path) >= 0;
  var where = claimed ? c.path + (c.line ? ':' + c.line : '') : '';
  var thread = reviewThreadPath || '';
  return [
    t('ask.prompt.intro'),
    where ? t('ask.prompt.where') + ' ' + where : '',
    claimed && c.code ? '\n```\n' + String(c.code) + '\n```\n' : '', // the line goes with its address
    t('ask.prompt.question') + '\n' + String(c.text || ''),
    thread ? '\n' + t('ask.prompt.thread') + ' ' + thread + ' (id ' + c.seq + ')' : '',
    '\n' + t('ask.prompt.style'),
    // Only offer the hand-off where there is a terminal to hand off TO. In the CLI's browser viewer there is
    // none, and an agent told to produce a hand-off nobody can deliver would answer nothing at all.
    hasTerminal() ? '\n' + t('ask.prompt.handoff') : '',
  ].filter(Boolean).join('\n');
}

function askComment(seq) {
  var c = reviewComments.find(function (x) { return x.seq === Number(seq); });
  if (!c || askPending[c.seq]) return;
  if (!askAvailable()) { showToast(t('ask.unavailable')); return; }
  // Optimistic, and immediately: the round trip to main is short but not instant, and a button that does
  // nothing for 200ms is a button people press twice.
  askPending[c.seq] = true;
  refreshComments();
  Promise.resolve(askBridge().ask({
    prompt: askPromptForComment(c),
    label: t('ask.answering') + ' ' + (c.path ? c.path.split('/').pop() : ''),
    seq: c.seq,
  })).catch(function () { return null; }).then(function (result) {
    if (result && result.ok) return; // the answer arrives through the thread file, like every other answer
    delete askPending[c.seq];
    refreshComments();
    showToast(t(result && result.reason === 'no-agent' ? 'ask.noAgent' : 'ask.failed'));
  });
}

// A whole prompt (Explain, the codebase map) run in the hidden session instead of the reviewer's terminal.
// There is no comment to hang it on, so it exists on screen only as the pill.
// `notes: true` — these prompts end by telling the agent to append JSONL records to the notes file, and the
// hidden session has no write access at all. Main overrides that one instruction and takes the lines off
// stdout instead (collectPrintedRecords, app-main.ts).
function askWholePrompt(text, label) {
  if (!askAvailable()) return false;
  Promise.resolve(askBridge().ask({ prompt: text, label: label, notes: true })).catch(function () { return null; })
    .then(function (result) {
      if (!result || result.ok) return;
      showToast(t(result.reason === 'no-agent' ? 'ask.noAgent' : 'ask.failed'));
    });
  return true;
}

// The model row in Settings. Registered here and not beside the other selects in 08-dock.js for the reason
// written next to the vocabulary's row (26-terms.js): setupCustomSelect renders on the spot, and ASK_MODELS
// is a `var` in this slice — read from an earlier one it is undefined, which throws and takes the rest of
// that boot block down with it.
setupCustomSelect('settings-ask-model',
  function () {
    return ASK_MODELS.map(function (id) { return { value: id, label: t('settings.askModel.' + id) }; });
  },
  function () {
    var stored = persistRead(ASK_MODEL_KEY);
    return ASK_MODELS.indexOf(stored) >= 0 ? stored : 'auto';
  },
  function (next) { persistSave(ASK_MODEL_KEY, next); });

(function setupAskStatus() {
  var bridge = askBridge();
  if (bridge && typeof bridge.onStatus === 'function') bridge.onStatus(applyAskStatus);
  if (bridge && typeof bridge.onHandoff === 'function') bridge.onHandoff(deliverHandoff);
  var pill = document.getElementById('ask-status');
  if (pill) {
    pill.addEventListener('click', function () {
      var first = askActive[0];
      if (first && first.seq != null) revealComment(first.seq);
    });
  }
})();
