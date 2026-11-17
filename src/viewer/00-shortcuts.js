
var SHORTCUT_CODE_NAMES = {
  Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Esc', Space: 'Space', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Comma: ',', Period: '.', Slash: '/', Quote: "'", Semicolon: ';', Backquote: '`',
  BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backslash: '\\',
};
var SHORTCUT_KEY_NAMES = {
  Enter: 'Enter', Escape: 'Esc', ' ': 'Space', Spacebar: 'Space', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

function shortcutNameFromCode(code) {
  if (!code) return '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return SHORTCUT_CODE_NAMES[code] || '';
}
function shortcutNameFromKey(key) {
  if (typeof key !== 'string' || !key) return '';
  if (SHORTCUT_KEY_NAMES[key]) return SHORTCUT_KEY_NAMES[key];
  if (/^F\d{1,2}$/.test(key)) return key;
  if (key.length === 1) return key.toUpperCase();
  return '';
}
function shortcutModifiers(event, withShift) {
  return ((event.metaKey || event.ctrlKey) ? '⌘' : '') + (withShift && event.shiftKey ? '⇧' : '') + (event.altKey ? '⌥' : '');
}
var SHORTCUT_DOUBLE_TAP_MS = 300;
var lastShiftTapAt = 0;
var tapEvent = null;
var tapChord = '';
function shortcutDoubleTapChord(event) {
  if (event === tapEvent) return tapChord;
  tapEvent = event;
  tapChord = shortcutComputeDoubleTap(event);
  return tapChord;
}
function shortcutComputeDoubleTap(event) {
  if (event.key !== 'Shift') { lastShiftTapAt = 0; return ''; }
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) { lastShiftTapAt = 0; return ''; }
  var now = Date.now();
  var isDouble = now - lastShiftTapAt <= SHORTCUT_DOUBLE_TAP_MS;
  lastShiftTapAt = isDouble ? 0 : now;
  return isDouble ? '⇧⇧' : '';
}

function shortcutChords(event) {
  var out = [];
  var tap = shortcutDoubleTapChord(event);
  if (tap) out.push(tap);
  var byCode = shortcutNameFromCode(event.code);
  if (byCode) out.push(shortcutModifiers(event, true) + byCode);
  var byKey = shortcutNameFromKey(event.key);
  if (byKey) {
    var shiftIsInTheKey = byKey !== byCode && byKey.length === 1 && !/^[A-Z0-9]$/.test(byKey);
    var folded = shortcutModifiers(event, !shiftIsInTheKey) + byKey;
    if (out.indexOf(folded) < 0) out.push(folded);
  }
  return out;
}

var SHORTCUT_OVERRIDES_KEY = 'kakapo-shortcut-overrides';
var shortcutOverrides = null;
var shortcutLookup = null;

function shortcutOverridesAll() {
  if (shortcutOverrides) return shortcutOverrides;
  var v = persistRead(SHORTCUT_OVERRIDES_KEY);
  if (!v) { try { v = JSON.parse(localStorage.getItem(SHORTCUT_OVERRIDES_KEY) || 'null'); } catch (e) { v = null; } }
  shortcutOverrides = (v && typeof v === 'object') ? v : {};
  return shortcutOverrides;
}
function shortcutDef(id) {
  for (var i = 0; i < SHORTCUT_DEFS.length; i += 1) if (SHORTCUT_DEFS[i].id === id) return SHORTCUT_DEFS[i];
  return null;
}
function shortcutKeys(id) {
  var over = shortcutOverridesAll()[id];
  if (Array.isArray(over) && over.length) return over;
  var def = shortcutDef(id);
  return def ? def.keys : [];
}
function shortcutLabel(id, index) {
  var keys = shortcutKeys(id);
  return keys[index || 0] || '';
}
function shortcutCanonical(chord) {
  return String(chord || '').replace(/[^⌘⇧⌥]+$/, function (tail) { return tail.length === 1 ? tail.toUpperCase() : tail; });
}
var SHORTCUT_SHIFTED_PAIRS = '1!2@3#4$5%6^7&8*9(0)-_=+[{]}\\|;:\'",<.>/?`~';
function shortcutShiftPartner(ch, wantShifted) {
  var at = SHORTCUT_SHIFTED_PAIRS.indexOf(ch);
  if (at < 0 || at % 2 !== (wantShifted ? 0 : 1)) return '';
  return SHORTCUT_SHIFTED_PAIRS.charAt(wantShifted ? at + 1 : at - 1);
}
function shortcutAliases(chord) {
  var out = [chord];
  var mods = chord.slice(0, chord.length - 1);
  var last = chord.charAt(chord.length - 1);
  if (!/^[⌘⇧⌥]*$/.test(mods) || last.length !== 1) return out;
  if (mods.indexOf('⇧') >= 0) {
    var shifted = shortcutShiftPartner(last, true);
    if (shifted) out.push(mods.replace('⇧', '') + shifted);
  } else {
    var plain = shortcutShiftPartner(last, false);
    if (plain) out.push(mods + '⇧' + plain);
  }
  return out;
}
function shortcutLookupMap() {
  if (shortcutLookup) return shortcutLookup;
  shortcutLookup = new Map();
  for (var i = 0; i < SHORTCUT_DEFS.length; i += 1) {
    var id = SHORTCUT_DEFS[i].id;
    var keys = shortcutKeys(id);
    for (var k = 0; k < keys.length; k += 1) {
      var aliases = shortcutAliases(shortcutCanonical(keys[k]));
      for (var a = 0; a < aliases.length; a += 1) {
        if (!shortcutLookup.has(aliases[a])) shortcutLookup.set(aliases[a], []);
        shortcutLookup.get(aliases[a]).push({ id: id, index: k });
      }
    }
  }
  return shortcutLookup;
}
function shortcutsChanged() {
  shortcutLookup = null;
  forgetFindActionItems();
}

function shortcutHits(event) {
  var map = shortcutLookupMap();
  var chords = shortcutChords(event);
  var out = [];
  for (var i = 0; i < chords.length; i += 1) {
    var hits = map.get(shortcutCanonical(chords[i]));
    if (!hits) continue;
    for (var h = 0; h < hits.length; h += 1) if (out.indexOf(hits[h]) < 0) out.push(hits[h]);
  }
  return out;
}
function shortcutHit(event) {
  var hits = shortcutHits(event);
  return hits.length ? hits[0] : null;
}
var shortcutMatchIndex = -1;
function isShortcut(event, id) {
  var hits = shortcutHits(event);
  shortcutMatchIndex = -1;
  for (var i = 0; i < hits.length; i += 1) if (hits[i].id === id) { shortcutMatchIndex = hits[i].index; return true; }
  return false;
}
function shortcutSurfacesOverlap(a, b) {
  if (a === b) return true;
  if (a !== 'any' && b !== 'any') return false;
  var surface = a === 'any' ? b : a;
  return MODAL_SURFACES.indexOf(surface) < 0;
}
function shortcutConflict(id, chord) {
  var def = shortcutDef(id);
  if (!def) return '';
  var want = shortcutCanonical(chord);
  for (var i = 0; i < SHORTCUT_DEFS.length; i += 1) {
    var other = SHORTCUT_DEFS[i];
    if (other.id === id) continue;
    if (!shortcutSurfacesOverlap(other.where, def.where)) continue;
    var keys = shortcutKeys(other.id);
    for (var k = 0; k < keys.length; k += 1) if (shortcutCanonical(keys[k]) === want) return other.id;
  }
  return '';
}
