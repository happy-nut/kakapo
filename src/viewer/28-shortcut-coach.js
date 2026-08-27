// ===== Shortcut coach ==============================================================================
// 시안 D: watch what the mouse keeps doing, and point at the key that does it. Every control that has a
// real application shortcut already carries it in data-keyhint (the hover-hint system in 05-keymap.js
// reads the same attribute), so detection is one delegated click listener — not per-action code. The
// keyboard side is one capture-phase keydown listener that normalizes the event into the same "⌘⇧N"
// string the attributes use; that shared spelling IS the join key between "clicked the button" and
// "pressed the chord".
//
// The ledger persists like every other cross-reopen preference (persistSave — Electron bridge first,
// localStorage as the browser/serve fallback) and is app-global, not per-review: knowing ⌘E is not a
// property of one worktree.
//
// Rules (the ones agreed on, not aspirations):
//   - a nudge fires after COACH_CLICK_THRESHOLD mouse uses of a control whose chord was never pressed
//   - a shortcut that WAS used but slept ≥ COACH_RUSTY_DAYS gets re-introduced, at most 3 times ever,
//     and using it again resets that budget
//   - one behavior nudge and one rusty nudge per session, ≥ 3 days between nudges of the same chord,
//     "don't show again" is forever, and pressing the chord while its nudge is up ends it with a ✓.

var COACH_KEY = 'kakapo-shortcut-coach';
var COACH_CLICK_THRESHOLD = 3;
var COACH_RUSTY_DAYS = 21;
var COACH_MAX_NUDGES = 3;
var COACH_RENUDGE_MS = 3 * 24 * 60 * 60 * 1000;
var COACH_RUSTY_SCAN_DELAY_MS = 45000; // let the person settle into the review before coaching
var COACH_AUTO_HIDE_MS = 12000;

var coachLedger = (function () {
  var v = persistRead(COACH_KEY);
  if (!v) { try { v = JSON.parse(localStorage.getItem(COACH_KEY) || 'null'); } catch (e) { v = null; } }
  return v && typeof v === 'object' ? v : {};
})();
// entry: { uses, last, clicks, nudges, nt (last nudge time), muted, label }
function coachEntry(hint) {
  return coachLedger[hint] || (coachLedger[hint] = { uses: 0, last: 0, clicks: 0, nudges: 0, nt: 0, muted: false, label: '' });
}
function coachSave() { persistSave(COACH_KEY, coachLedger); }

// Only chords worth teaching: ⌘/⌥ combinations and the bare F-keys. Single contextual keys (Esc, ↵,
// Del on a focused composer) explain themselves where they appear — nudging those is noise.
function coachEligible(hint) { return /[⌘⌥]/.test(hint) || /^⇧?F\d{1,2}$/.test(hint); }

// data-keyhint spelling varies slightly (⏎ vs ↵); fold it into the keydown normalization's space.
function coachCanonical(hint) { return (hint || '').replace(/⏎/g, '↵').replace(/\s+/g, ''); }

var COACH_CODE_KEYS = {
  Enter: '↵', Escape: 'Esc', Backspace: 'Del', Delete: 'Del',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Slash: '/', Period: '.', Comma: ',', Quote: "'", Semicolon: ';',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=',
};
function coachHintFromEvent(event) {
  var code = event.code || '';
  var key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (COACH_CODE_KEYS[code]) key = COACH_CODE_KEYS[code];
  else if (COACH_CODE_KEYS[event.key]) key = COACH_CODE_KEYS[event.key];
  else return '';
  return ((event.metaKey || event.ctrlKey) ? '⌘' : '') + (event.altKey ? '⌥' : '') + (event.shiftKey ? '⇧' : '') + key;
}

// Same fallback chain as the hover hint's buttonLabel — the hint system may already have moved `title`
// into data-hint-title, so both are consulted.
function coachLabelFor(el) {
  return el.getAttribute('data-tooltip') || el.getAttribute('aria-label')
    || el.getAttribute('data-hint-title') || el.getAttribute('title')
    || (el.textContent || '').trim();
}
// A rusty chord may have been used only from the keyboard, so its label was never captured on a click.
// The controls carrying that chord are (mostly) in the DOM — recover the label from them, else skip the
// nudge: keys with no findable name would render as a bare chord with no story. This also keeps junk
// ledger entries (⌘C, ⌘V — recorded because recording is unconditional) permanently un-nudgeable.
function coachResolveLabel(hint) {
  var entry = coachLedger[hint];
  if (entry && entry.label) return entry.label;
  var all = document.querySelectorAll('[data-keyhint]');
  for (var i = 0; i < all.length; i += 1) {
    if (coachCanonical(all[i].getAttribute('data-keyhint')) === hint) {
      var label = coachLabelFor(all[i]);
      if (label) return label;
    }
  }
  return '';
}

// ---- the bubble -----------------------------------------------------------------------------------
var coachVisibleHint = '';
var coachHideTimer = 0;
var coachSession = { clicks: false, rusty: false };
var coachBox = (function () {
  var box = document.createElement('div');
  box.id = 'coach-nudge';
  box.className = 'coach-nudge hidden';
  box.setAttribute('role', 'status');
  box.innerHTML = '<div class="coach-obs"></div>'
    + '<div class="coach-act"><span class="coach-keys"></span><span class="coach-label"></span></div>'
    + '<div class="coach-foot"><button type="button" class="coach-ok"></button><button type="button" class="coach-mute-btn"></button></div>';
  document.body.appendChild(box);
  box.querySelector('.coach-ok').addEventListener('click', function () { coachHide(); });
  box.querySelector('.coach-mute-btn').addEventListener('click', function () {
    if (coachVisibleHint) { coachEntry(coachVisibleHint).muted = true; coachSave(); }
    coachHide();
  });
  return box;
})();
function coachHide() {
  coachVisibleHint = '';
  if (coachHideTimer) { clearTimeout(coachHideTimer); coachHideTimer = 0; }
  coachBox.classList.add('hidden');
}
function coachKeysHtml(hint) {
  var caps = hint.match(/F\d{1,2}|Esc|Del|[⌘⌥⇧↵↑↓←→]|[A-Z0-9/.,;'[\]=-]/g) || [hint];
  return caps.map(function (c) { return '<kbd>' + escapeHtml(c) + '</kbd>'; }).join('');
}
function coachShow(hint, kind) {
  var entry = coachEntry(hint);
  var label = coachResolveLabel(hint);
  if (!label) return false;
  var obs = kind === 'rusty'
    ? t('coach.rusty').replace('{w}', String(Math.max(1, Math.round((Date.now() - entry.last) / (7 * 24 * 60 * 60 * 1000)))))
      + ' · ' + t('coach.nudgeCount').replace('{n}', String(entry.nudges + 1))
    : t('coach.observed');
  coachBox.querySelector('.coach-obs').textContent = obs;
  coachBox.querySelector('.coach-keys').innerHTML = coachKeysHtml(hint);
  coachBox.querySelector('.coach-label').textContent = label;
  coachBox.querySelector('.coach-ok').textContent = t('coach.gotIt');
  coachBox.querySelector('.coach-mute-btn').textContent = t('coach.mute');
  coachBox.classList.toggle('coach-rusty', kind === 'rusty');
  coachBox.classList.remove('hidden');
  coachVisibleHint = hint;
  entry.nudges += 1;
  entry.nt = Date.now();
  coachSave();
  if (coachHideTimer) clearTimeout(coachHideTimer);
  coachHideTimer = setTimeout(coachHide, COACH_AUTO_HIDE_MS);
  return true;
}
function coachMayNudge(entry) {
  return !entry.muted && entry.nudges < COACH_MAX_NUDGES && (Date.now() - entry.nt) >= COACH_RENUDGE_MS;
}

// ---- keyboard side: pressing an eligible chord marks it known (and wakes it if it was rusty) -------
// Capture phase: owners like Quick Open stopImmediatePropagation on the bubble path, and a chord the
// user pressed counts as known whether or not anything consumed it.
document.addEventListener('keydown', function (event) {
  var hint = coachHintFromEvent(event);
  if (!hint || !coachEligible(hint)) return;
  var entry = coachEntry(hint);
  entry.uses += 1;
  entry.last = Date.now();
  entry.clicks = 0;
  entry.nudges = 0; // using it again refills the reminder budget
  coachSave();
  if (coachVisibleHint === hint) {
    coachBox.querySelector('.coach-obs').textContent = t('coach.known');
    coachVisibleHint = '';
    if (coachHideTimer) clearTimeout(coachHideTimer);
    coachHideTimer = setTimeout(coachHide, 1500);
  }
}, true);

// ---- mouse side: the same control, clicked over and over, while its chord goes unpressed -----------
document.addEventListener('click', function (event) {
  var el = event.target && event.target.closest ? event.target.closest('[data-keyhint]') : null;
  if (!el) return;
  var hint = coachCanonical(el.getAttribute('data-keyhint'));
  if (!hint || !coachEligible(hint)) return;
  var entry = coachEntry(hint);
  if (coachLabelFor(el)) entry.label = coachLabelFor(el);
  if (entry.uses > 0 || entry.muted) { coachSave(); return; } // they know the key; nothing to teach
  entry.clicks += 1;
  if (entry.clicks >= COACH_CLICK_THRESHOLD && !coachSession.clicks && !coachVisibleHint && coachMayNudge(entry)) {
    entry.clicks = 0;
    if (coachShow(hint, 'clicks')) coachSession.clicks = true;
  }
  coachSave();
}, true);

// ---- rusty pass: once per session, well after load, surface the longest-asleep known shortcut ------
function coachRustyScan() {
  if (coachSession.rusty || coachVisibleHint) return;
  var now = Date.now();
  var pick = '';
  var pickLast = Infinity;
  Object.keys(coachLedger).forEach(function (hint) {
    var entry = coachLedger[hint];
    if (!entry || !entry.uses || !coachEligible(hint) || !coachMayNudge(entry)) return;
    if (now - entry.last < COACH_RUSTY_DAYS * 24 * 60 * 60 * 1000) return;
    if (entry.last < pickLast) { pick = hint; pickLast = entry.last; }
  });
  if (pick && coachShow(pick, 'rusty')) coachSession.rusty = true;
}
setTimeout(coachRustyScan, COACH_RUSTY_SCAN_DELAY_MS);
// Deliberate debug/test seam, same pattern as window.__kakapoTerminal.
window.__kakapoCoach = { scan: coachRustyScan, ledger: coachLedger };
