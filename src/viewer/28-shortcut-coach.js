
var COACH_KEY = 'kakapo-shortcut-coach';
var COACH_CLICK_THRESHOLD = 3;
var COACH_RUSTY_DAYS = 21;
var COACH_MAX_NUDGES = 3;
var COACH_RENUDGE_MS = 3 * 24 * 60 * 60 * 1000;
var COACH_RUSTY_SCAN_DELAY_MS = 45000;
var COACH_AUTO_HIDE_MS = 12000;

var COACH_KEY_ALIASES = { '⏎': 'Enter', '↵': 'Enter', '⌫': 'Backspace', 'Del': 'Backspace', 'Delete': 'Backspace', '⎋': 'Esc', 'Escape': 'Esc' };
var COACH_MOD_ORDER = '⌘⇧⌥⌃';
function coachCanonical(hint) {
  var text = String(hint || '').replace(/\s+/g, '');
  var mods = '';
  while (text && COACH_MOD_ORDER.indexOf(text[0]) >= 0) { mods += text[0]; text = text.slice(1); }
  if (!text) return String(hint || '').replace(/\s+/g, '');
  var ordered = COACH_MOD_ORDER.split('').filter(function (m) { return mods.indexOf(m) >= 0; }).join('');
  return ordered + (COACH_KEY_ALIASES[text] || text);
}

var coachLedger = (function () {
  var v = persistRead(COACH_KEY);
  if (!v) { try { v = JSON.parse(localStorage.getItem(COACH_KEY) || 'null'); } catch (e) { v = null; } }
  if (!v || typeof v !== 'object') return {};
  var migrated = {};
  Object.keys(v).forEach(function (key) {
    var canonical = coachCanonical(key);
    var held = migrated[canonical];
    var entry = v[key];
    if (!entry || typeof entry !== 'object') return;
    if (!held) { migrated[canonical] = entry; return; }
    held.uses = (held.uses || 0) + (entry.uses || 0);
    held.clicks = (held.clicks || 0) + (entry.clicks || 0);
    held.last = Math.max(held.last || 0, entry.last || 0);
    held.nt = Math.max(held.nt || 0, entry.nt || 0);
    held.nudges = Math.max(held.nudges || 0, entry.nudges || 0);
    held.muted = Boolean(held.muted || entry.muted);
    held.label = held.label || entry.label || '';
  });
  return migrated;
})();
function coachEntry(hint) {
  return coachLedger[hint] || (coachLedger[hint] = { uses: 0, last: 0, clicks: 0, nudges: 0, nt: 0, muted: false, label: '' });
}
function coachSave() { persistSave(COACH_KEY, coachLedger); }

function coachEligible(hint) { return /[⌘⌥]/.test(hint) || /^⇧?F\d{1,2}$/.test(hint); }

var COACH_CODE_KEYS = {
  Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Backspace', Space: 'Space', Tab: 'Tab',
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
  return coachCanonical(((event.metaKey || event.ctrlKey) ? '⌘' : '')
    + (event.shiftKey ? '⇧' : '') + (event.altKey ? '⌥' : '') + key);
}

function coachLabelFor(el) {
  return el.getAttribute('data-tooltip') || el.getAttribute('aria-label')
    || el.getAttribute('data-hint-title') || el.getAttribute('title')
    || (el.textContent || '').trim();
}
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
  var caps = hint.match(/F\d{1,2}|Backspace|Enter|Esc|Tab|Space|[⌘⌥⇧⌃↵↑↓←→]|[A-Z0-9/.,;'[\]=-]/g) || [hint];
  return caps.map(function (c) { return '<kbd>' + escapeHtml(c) + '</kbd>'; }).join('');
}
function coachShow(hint, kind) {
  var entry = coachEntry(hint);
  var label = coachResolveLabel(hint);
  if (!label) return false;
  var obs = kind === 'rusty'
    ? (function () { var w = Math.max(1, Math.round((Date.now() - entry.last) / (7 * 24 * 60 * 60 * 1000)));
        return t('coach.rusty', { w: w }); })()
      + ' · ' + t('coach.nudgeCount', { n: entry.nudges + 1 })
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

document.addEventListener('keydown', function (event) {
  var hint = coachHintFromEvent(event);
  if (!hint || !coachEligible(hint)) return;
  var entry = coachEntry(hint);
  entry.uses += 1;
  entry.last = Date.now();
  entry.clicks = 0;
  entry.nudges = 0;
  coachSave();
  if (coachVisibleHint === hint) {
    coachBox.querySelector('.coach-obs').textContent = t('coach.known');
    coachVisibleHint = '';
    if (coachHideTimer) clearTimeout(coachHideTimer);
    coachHideTimer = setTimeout(coachHide, 1500);
  }
}, true);

document.addEventListener('click', function (event) {
  var el = event.target && event.target.closest ? event.target.closest('[data-keyhint]') : null;
  if (!el) return;
  var hint = coachCanonical(el.getAttribute('data-keyhint'));
  if (!hint || !coachEligible(hint)) return;
  var entry = coachEntry(hint);
  if (coachLabelFor(el)) entry.label = coachLabelFor(el);
  if (entry.uses > 0 || entry.muted) { coachSave(); return; }
  entry.clicks += 1;
  if (entry.clicks >= COACH_CLICK_THRESHOLD && !coachSession.clicks && !coachVisibleHint && coachMayNudge(entry)) {
    entry.clicks = 0;
    if (coachShow(hint, 'clicks')) coachSession.clicks = true;
  }
  coachSave();
}, true);

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
window.__kakapoCoach = { scan: coachRustyScan, ledger: coachLedger, canonical: coachCanonical };
