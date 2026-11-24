
var shortcutCapture = null;

function shortcutSaveOverrides() {
  persistSave(SHORTCUT_OVERRIDES_KEY, shortcutOverridesAll());
  shortcutsChanged();
  applyI18n();
  renderShortcutRow(null);
}

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
// Recording a chord needs the keys while a field has the caret too: the row being typed into is the
// recorder, and a ⌘V that pasted instead of being recorded would be the bug.
claimsMenuChords('shortcut-capture', function () { return !!shortcutCapture; }, { whileTyping: true });
function endShortcutCapture() {
  if (!shortcutCapture) return;
  syncMenuChords();
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
  syncMenuChords();
  row.classList.add('keys-row-capturing');
  var holder = row.querySelector('.keys-keys');
  holder.innerHTML = '<span class="keys-combo keys-combo-listening"><kbd>' + escapeHtml(t('settings.kbd.capture')) + '</kbd></span>';
  shortcutCaptureMessage(row, t('settings.kbd.captureHint'), false);
}

function shortcutBindable(chord) {
  return /[⌘⇧⌥⌃]/.test(chord) || /^F\d{1,2}$/.test(chord);
}

document.addEventListener('keydown', function (event) {
  if (!shortcutCapture) return;
  var sheet = document.getElementById('settings-modal');
  if (!sheet || sheet.classList.contains('hidden')) { endShortcutCapture(); return; }
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === 'Escape') { endShortcutCapture(); return; }
  var chord = shortcutChords(event)[0];
  if (!chord) return;
  if (!shortcutBindable(chord)) { shortcutCaptureMessage(shortcutCapture.row, t('settings.kbd.needModifier'), true); return; }
  // The application menu takes its chords before any renderer keydown runs, so binding one here saves a
  // key that can never fire — and the sheet used to accept ⌘M, ⌘0 and ⌘⇧Z in silence and do exactly that.
  if (MENU_OWNED_CHORDS.indexOf(shortcutCanonical(chord)) >= 0) {
    shortcutCaptureMessage(shortcutCapture.row, t('settings.kbd.menuOwned').replace('{key}', chord), true);
    return;
  }
  var own = shortcutKeys(shortcutCapture.id);
  for (var o = 0; o < own.length; o += 1) {
    if (o !== shortcutCapture.index && shortcutCanonical(own[o]) === shortcutCanonical(chord)) {
      shortcutCaptureMessage(shortcutCapture.row, t('settings.kbd.sameRow').replace('{key}', chord), true);
      return;
    }
  }
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
  syncMenuChords();
  shortcutCapture = null;
  row.classList.remove('keys-row-capturing');
  var note = row.querySelector('.keys-note');
  if (note) note.remove();
  shortcutSaveOverrides();
}, true);

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
