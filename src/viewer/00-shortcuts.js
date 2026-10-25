// ===== Reading a keypress against the shortcut table ===============================================
// SHORTCUT_DEFS is injected ahead of every slice by scripts/copy-viewer-assets.mjs, straight from
// src/shortcuts.ts — the same array the Settings sheet renders. Everything here turns a KeyboardEvent into
// the spelling that table uses, so a chord is compared as a string in one place instead of being rebuilt
// as a hand-written `if` wherever it is needed.
//
// Two spellings come out of one event, and both are tried, which is what the hand-written branches already
// did ("matched on `code` first — ⌥U is a dead key on macOS, so event.key is 'Dead'"):
//   from `code`  the physical key. Survives a non-US layout, an IME, and the dead keys ⌥ composes.
//   from `key`   what the layout actually produced. Catches the layouts where the US `code` is elsewhere.
// Shift is spelled out in the first and folded into the second: `?` IS Shift+/, and asking for Shift on
// top of it would be asking for the same modifier twice.

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

// The table's spelling of one key, from event.code. '' when the physical key has no name we use.
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
// ⌘ stands for Command OR Control throughout, the same equivalence every handler in the app already used.
function shortcutModifiers(event, withShift) {
  return ((event.metaKey || event.ctrlKey) ? '⌘' : '') + (withShift && event.shiftKey ? '⇧' : '') + (event.altKey ? '⌥' : '');
}
// A DOUBLE TAP, spelled as a chord so the one table can hold it.
//
// IntelliJ's Search Everywhere is ⇧⇧, and a bare Shift press produces no chord at all above (its `code`
// and `key` both resolve to ''). The alternative was a second key handler somewhere else with the timing
// written into it — which is exactly the drift the single chord table exists to prevent. So the tap is
// recognised HERE and handed to the same matcher as every other chord.
var SHORTCUT_DOUBLE_TAP_MS = 400;
var lastShiftTapAt = 0;
// The detector has to be idempotent per event, because shortcutChords() is called more than once for the
// same keypress (the dispatcher asks which shortcuts an event could be, and several callers ask again).
// Without this, ONE Shift press was counted as two and opened the launcher on every single tap.
var tapEvent = null;
var tapChord = '';
function shortcutDoubleTapChord(event) {
  if (event === tapEvent) return tapChord;
  tapEvent = event;
  tapChord = shortcutComputeDoubleTap(event);
  return tapChord;
}
function shortcutComputeDoubleTap(event) {
  if (event.key !== 'Shift') { lastShiftTapAt = 0; return ''; } // any other key ends a pending tap
  // Holding Shift repeats the keydown; a held key is not two presses. Shift with another modifier down is
  // part of some other chord, not a tap of its own.
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) { lastShiftTapAt = 0; return ''; }
  var now = Date.now();
  var isDouble = now - lastShiftTapAt <= SHORTCUT_DOUBLE_TAP_MS;
  // Reset on a match so a third tap starts a new pair instead of firing again.
  lastShiftTapAt = isDouble ? 0 : now;
  return isDouble ? '⇧⇧' : '';
}

/** The one or two chord spellings this event could be, most reliable first. */
function shortcutChords(event) {
  var out = [];
  var tap = shortcutDoubleTapChord(event);
  if (tap) out.push(tap);
  var byCode = shortcutNameFromCode(event.code);
  if (byCode) out.push(shortcutModifiers(event, true) + byCode);
  var byKey = shortcutNameFromKey(event.key);
  // A one-character key that is not alphanumeric already carries Shift inside it ("?" is Shift+/).
  if (byKey) {
    var folded = shortcutModifiers(event, /^[A-Z0-9]$/.test(byKey) || byKey.length > 1) + byKey;
    if (out.indexOf(folded) < 0) out.push(folded);
  }
  return out;
}

// ---- The table, and what the person has rebound ---------------------------------------------------
// Overrides are a plain {id: ["⌘⇧K"]} map saved like every other cross-reopen preference. The lookup is
// rebuilt whenever they change rather than consulted per keystroke; a keypress stays one map read.
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
/** The combinations that currently invoke `id` — the person's, or the table's. */
function shortcutKeys(id) {
  var over = shortcutOverridesAll()[id];
  if (Array.isArray(over) && over.length) return over;
  var def = shortcutDef(id);
  return def ? def.keys : [];
}
// Letters are spelled uppercase in a chord; the sheet may show a bare key lowercase ("e" to edit a
// comment), so both sides of a comparison go through this.
function shortcutCanonical(chord) {
  return String(chord || '').replace(/[^⌘⇧⌥]+$/, function (tail) { return tail.length === 1 ? tail.toUpperCase() : tail; });
}
// A punctuation key has two names and an event hands over whichever one it happens to know: `code` gives
// the physical key (Shift plus "/"), `key` gives what it produced ("?"). The same chord therefore arrives
// spelled "⇧/" or "?" depending on the event, so each table entry is registered under both — the layout
// assumption only ever decides which of two spellings of the SAME key is used, never which key it is.
var SHORTCUT_SHIFTED_PAIRS = '1!2@3#4$5%6^7&8*9(0)-_=+[{]}\\|;:\'",<.>/?`~';
function shortcutShiftPartner(ch, wantShifted) {
  var at = SHORTCUT_SHIFTED_PAIRS.indexOf(ch);
  if (at < 0 || at % 2 !== (wantShifted ? 0 : 1)) return '';
  return SHORTCUT_SHIFTED_PAIRS.charAt(wantShifted ? at + 1 : at - 1);
}
/** The one or two spellings a table entry should answer to. */
function shortcutAliases(chord) {
  var out = [chord];
  var mods = chord.slice(0, chord.length - 1);
  var last = chord.charAt(chord.length - 1);
  if (!/^[⌘⇧⌥]*$/.test(mods) || last.length !== 1) return out;
  if (mods.indexOf('⇧') >= 0) {
    // "⌘⇧/" also arrives as "⌘?" — an event that only knows `key` has the shift inside the character.
    var shifted = shortcutShiftPartner(last, true);
    if (shifted) out.push(mods.replace('⇧', '') + shifted);
  } else {
    // "?" also arrives as "⇧/" — an event that only knows `code` reports the physical key.
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
        // A chord can legitimately belong to more than one action when they live on different surfaces —
        // ⌥Enter is row actions in the tree, "run this request" in a .http file, and the comment menu in
        // the merged dock. So the map holds every candidate and the caller tries them in turn; the one
        // that applies takes it, the others decline. Keeping only the first silently killed two of the three.
        if (!shortcutLookup.has(aliases[a])) shortcutLookup.set(aliases[a], []);
        shortcutLookup.get(aliases[a]).push({ id: id, index: k });
      }
    }
  }
  return shortcutLookup;
}
function shortcutsChanged() { shortcutLookup = null; }

/** Every shortcut this event could be, as [{id, index}]. `index` is which of that action's keys fired. */
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
/** The first shortcut this event is, or null. */
function shortcutHit(event) {
  var hits = shortcutHits(event);
  return hits.length ? hits[0] : null;
}
/** True when this event is that shortcut. Returns the matched index via shortcutMatchIndex. */
var shortcutMatchIndex = -1;
function isShortcut(event, id) {
  var hits = shortcutHits(event);
  shortcutMatchIndex = -1;
  for (var i = 0; i < hits.length; i += 1) if (hits[i].id === id) { shortcutMatchIndex = hits[i].index; return true; }
  return false;
}
/** The action already bound to `chord` on a surface `id` would collide with, or '' if it is free. */
function shortcutConflict(id, chord) {
  var def = shortcutDef(id);
  if (!def) return '';
  var want = shortcutCanonical(chord);
  for (var i = 0; i < SHORTCUT_DEFS.length; i += 1) {
    var other = SHORTCUT_DEFS[i];
    if (other.id === id) continue;
    if (other.where !== 'any' && def.where !== 'any' && other.where !== def.where) continue;
    var keys = shortcutKeys(other.id);
    for (var k = 0; k < keys.length; k += 1) if (shortcutCanonical(keys[k]) === want) return other.id;
  }
  return '';
}
