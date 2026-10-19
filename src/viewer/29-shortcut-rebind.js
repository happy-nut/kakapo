// ===== Rebinding a shortcut from the Settings sheet ================================================
// The sheet already shows one chip per key, read off the shared table (src/shortcuts.ts). Clicking a
// combination captures the next keypress and writes it back as an override — which is only possible
// because the chord is a value in one table now, rather than a literal inside an `if` in some slice, a
// second literal in the sheet's markup and a third in the button's tooltip.
//
// What a click CANNOT do is rebind a key the page does not own: a menu accelerator belongs to the OS
// menu, and Esc/Tab/the arrows are the conventions of the surface they act on. Those rows say so instead
// of silently ignoring the click (`data-fixed` carries the reason).

var shortcutCapture = null; // { id, index, combo, row } while a row is listening for its new key

function shortcutSaveOverrides() {
  persistSave(SHORTCUT_OVERRIDES_KEY, shortcutOverridesAll());
  shortcutsChanged();      // the lookup is rebuilt from the new bindings
  applyI18n();             // every data-keyhint / tooltip re-reads the table
  renderShortcutRow(null); // and so does every row of the sheet
}

/** Redraw one row's chips from the table — or every row when `id` is null. */
function renderShortcutRow(id) {
  var rows = document.querySelectorAll('#settings-modal .keys-row' + (id ? '[data-shortcut="' + id + '"]' : ''));
  rows.forEach(function (row) {
    var def = shortcutDef(row.dataset.shortcut);
    if (!def) return;
    var keys = shortcutKeys(def.id);
    var overridden = !!shortcutOverridesAll()[def.id];
    row.classList.toggle('keys-row-custom', overridden);
    var holder = row.querySelector('.keys-keys');
    if (!holder) return;
    holder.innerHTML = keys.map(function (chord, i) {
      return '<button type="button" class="keys-combo" data-combo-index="' + i + '">'
        + shortcutChipsHtml(chord) + '</button>';
    }).join('<span class="keys-or">/</span>')
      + (overridden ? '<button type="button" class="keys-reset" data-i18n-title="settings.kbd.reset"'
        + ' title="' + escapeHtml(t('settings.kbd.reset')) + '" aria-label="' + escapeHtml(t('settings.kbd.reset')) + '">↺</button>' : '');
  });
}

// Same split the server-rendered sheet uses (keyChips in render.ts): modifiers one chip each, then the
// key itself, and an arrow cluster one chip per arrow.
function shortcutChipsHtml(chord) {
  var chips = [];
  var rest = String(chord);
  while (rest.length && '⌘⇧⌥⌃'.indexOf(rest[0]) >= 0) { chips.push(rest[0]); rest = rest.slice(1); }
  if (/^[←↑↓→]+$/.test(rest)) chips = chips.concat(rest.split(''));
  else if (rest.length) chips.push(rest);
  return chips.map(function (c) { return '<kbd>' + escapeHtml(c) + '</kbd>'; }).join('');
}

function shortcutCaptureMessage(row, message, bad) {
  var note = row.querySelector('.keys-note');
  if (!note) {
    note = document.createElement('span');
    note.className = 'keys-note';
    row.appendChild(note);
  }
  note.textContent = message;
  note.classList.toggle('keys-note-bad', !!bad);
}
function endShortcutCapture() {
  if (!shortcutCapture) return;
  var row = shortcutCapture.row;
  shortcutCapture = null;
  row.classList.remove('keys-row-capturing');
  var note = row.querySelector('.keys-note');
  if (note) note.remove();
  renderShortcutRow(row.dataset.shortcut);
}
function beginShortcutCapture(row, index) {
  endShortcutCapture();
  var def = shortcutDef(row.dataset.shortcut);
  if (!def) return;
  shortcutCapture = { id: def.id, index: index, row: row };
  row.classList.add('keys-row-capturing');
  var holder = row.querySelector('.keys-keys');
  holder.innerHTML = '<span class="keys-combo keys-combo-listening"><kbd>' + escapeHtml(t('settings.kbd.capture')) + '</kbd></span>';
  shortcutCaptureMessage(row, t('settings.kbd.captureHint'), false);
}

// A new binding needs a modifier (or to be a function key). A bare letter would be taken by the caret and
// the tree's own keys the moment the sheet closes, and the person would have no way to tell why — the
// table's own bare keys are the ones the surfaces were designed around, not ones to hand out by click.
function shortcutBindable(chord) {
  return /[⌘⇧⌥⌃]/.test(chord) || /^F\d{1,2}$/.test(chord);
}

document.addEventListener('keydown', function (event) {
  if (!shortcutCapture) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === 'Escape') { endShortcutCapture(); return; }
  var chord = shortcutChords(event)[0];
  if (!chord) return; // a modifier on its own — keep listening for the key it is held for
  if (!shortcutBindable(chord)) { shortcutCaptureMessage(shortcutCapture.row, t('settings.kbd.needModifier'), true); return; }
  var clash = shortcutConflict(shortcutCapture.id, chord);
  if (clash) {
    var other = shortcutDef(clash);
    shortcutCaptureMessage(shortcutCapture.row, t('settings.kbd.conflict').replace('{action}', t(other.i18n)).replace('{key}', chord), true);
    return;
  }
  var keys = shortcutKeys(shortcutCapture.id).slice();
  keys[shortcutCapture.index] = chord;
  shortcutOverridesAll()[shortcutCapture.id] = keys;
  var row = shortcutCapture.row;
  shortcutCapture = null;
  row.classList.remove('keys-row-capturing');
  var note = row.querySelector('.keys-note');
  if (note) note.remove();
  shortcutSaveOverrides();
}, true); // capture phase: while a row is listening, no shortcut may fire the key being typed at it

document.addEventListener('click', function (event) {
  var target = event.target;
  if (!target || !target.closest) return;
  var row = target.closest('#settings-modal .keys-row');
  if (!row) { endShortcutCapture(); return; }

  if (target.closest('.keys-reset')) {
    delete shortcutOverridesAll()[row.dataset.shortcut];
    shortcutSaveOverrides();
    return;
  }
  var combo = target.closest('.keys-combo');
  if (!combo) return;
  if (row.dataset.fixed) {
    shortcutCaptureMessage(row, t('settings.kbd.fixed.' + row.dataset.fixed), true);
    setTimeout(function () { var n = row.querySelector('.keys-note'); if (n && !shortcutCapture) n.remove(); }, 2600);
    return;
  }
  beginShortcutCapture(row, Number(combo.dataset.comboIndex || 0));
});

// The sheet is server-rendered as plain chips; turning them into buttons once the page is up keeps the
// pre-script markup readable and means a review opened without the bundle still shows its shortcuts.
(function wireShortcutSheet() {
  var keys = document.querySelector('#settings-modal .app-info-keys');
  if (!keys) return;
  renderShortcutRow(null);
  var reset = document.createElement('button');
  reset.type = 'button';
  reset.id = 'settings-kbd-reset-all';
  reset.className = 'plain-button';
  reset.setAttribute('data-i18n', 'settings.kbd.resetAll');
  reset.textContent = t('settings.kbd.resetAll');
  reset.addEventListener('click', function () {
    shortcutOverrides = {};
    shortcutSaveOverrides();
  });
  keys.appendChild(reset);
})();
