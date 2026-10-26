// ⌘⇧A: every command this app has, by name — IntelliJ's Find Action.
//
// The thing that makes this cheap here is that the commands are already DATA. src/shortcuts.ts is one
// table that the Settings sheet renders, that `data-keyhint` is filled from, and that the dispatcher
// attaches handlers to by id (SHORTCUT_ACTIONS in 05-keymap.js). So "search the actions" is a search over
// that table, and running one is the same call the keypress makes — there is no second registry to keep in
// agreement, which is the whole reason the table exists.
//
// Only the rows the page can actually invoke are listed. A menu accelerator (⌘O opens a folder, ⌘W closes
// a tab) belongs to the OS menu and cannot be fired from here, and a row that did nothing when you pressed
// Enter on it would be worse than one that is absent — Settings ▸ Shortcuts still shows all of them.

var actionItems = [];

/** Every dispatchable row of the shortcut table, as list items. */
function findActionItems() {
  if (actionItems.length) return actionItems;
  actionItems = SHORTCUT_DEFS.filter(function (def) {
    return def && def.id && typeof SHORTCUT_ACTIONS[def.id] === 'function';
  }).map(function (def) {
    return {
      actionId: def.id,
      name: t(def.i18n),
      chords: shortcutKeys(def.id),
      where: def.where || 'any',
    };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  return actionItems;
}

// The labels are translated, so a locale switch has to drop the cache or the list stays in the old
// language. Called from the same place the rest of the page re-reads its strings.
function forgetFindActionItems() {
  actionItems = [];
}

/** ⌘⇧A. */
function openFindAction() {
  findActionItems();
  openQuickOpen('actions', true);
  return true;
}

function renderFindActionResults(query) {
  if (!quickResults) return;
  var needle = String(query || '').trim().toLowerCase();
  var queries = queryVariants(needle);
  var rows = findActionItems().filter(function (item) {
    if (!needle) return true;
    // The chord is part of the haystack on purpose: "what was ⌘⇧E again" is the other half of why this
    // list is opened, and typing the chord finds the action it belongs to.
    var hay = (item.name + ' ' + item.actionId + ' ' + item.chords.join(' ')).toLowerCase();
    return queries.some(function (variant) { return hay.includes(variant); });
  });
  quickItems = rows.map(function (item) {
    return { path: '', name: item.name, detail: item.chords.join(' / '), kind: 'action', recent: false, lineIndex: 0, column: 0, text: '', actionId: item.actionId };
  });
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
  if (quickFilterEl) {
    quickFilterEl.className = 'quick-open-filter';
    quickFilterEl.textContent = String(rows.length) + ' ' + t('quickopen.results');
  }
  if (!rows.length) {
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.noMatches')) + '</div>';
    renderQuickPreview(null);
    return;
  }
  quickResults.innerHTML = rows.map(function (item, index) {
    return '<button type="button" class="quick-open-item action-result' + (index === quickActive ? ' active' : '')
      + '" data-index="' + index + '" data-action="' + escapeHtml(item.actionId) + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + escapeHtml(item.name) + '</span></span>'
      + (item.chords.length
        ? '<span class="action-chords">' + item.chords.map(function (chord) {
          return '<kbd class="action-chord">' + escapeHtml(chord) + '</kbd>';
        }).join('') + '</span>'
        : '')
      + '</button>';
  }).join('');
  // An action has no file behind it, so the preview pane has nothing to show. Saying that is better than
  // leaving whatever the previous mode left there.
  renderQuickPreview(null);
}

/**
 * Enter on an action: close the list first, then run it.
 *
 * In that order because the launcher is a modal keyboard scope — it consumes every key while it is up
 * (KEY_OWNERS in 05-keymap.js) — and several of these actions open a panel of their own. Running one
 * underneath this dialog would put a panel behind it, or hand the keyboard to two surfaces at once.
 */
function runFindActionItem(item) {
  if (!item || item.kind !== 'action') return false;
  // Truthiness, not a typeof: the list was built from the rows that HAVE a handler, so this only guards
  // against a stale item — and a `typeof … === 'function'` on a local reads to test/viewer-slices.test.mjs
  // as a guard on a cross-slice name, which is a check worth not confusing.
  var action = SHORTCUT_ACTIONS[item.actionId];
  if (!action) return false;
  closeQuickOpen();
  // `index` 0: the action is told which of its combinations fired, and a list row is the first one. The
  // event is null — every handler that reads it reads modifier state, which a click does not have.
  setTimeout(function () { action(null, 0); }, 0);
  return true;
}
