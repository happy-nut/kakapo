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

/**
 * Rows whose KEY never reaches the dispatcher, but which are real commands all the same.
 *
 * A surface owner (KEY_OWNERS, 05-keymap.js) runs before `runShortcut` and consumes its own chord, so
 * those rows carry no `SHORTCUT_ACTIONS` entry — and this list, which shows "the rows the page can
 * invoke", therefore left out ⌘F. Typing "find" into the command palette did not offer "Find in the
 * current file", which is the app's most-used search.
 *
 * Only commands that work from a COLD start belong here. The find bar's own toggles (⌥M, ⌥W, ⌥X, ⌥S,
 * ⌥D) and the usage view's grouping chips are the other rows with no dispatcher, and they are left out
 * on purpose: each acts on a surface that has to be open already, so a palette row for one would be the
 * entry that does nothing when you press Enter — the thing the note below says is worse than absence.
 *
 * Kept honest by test/find-action.test.mjs: every id here must be a table row that has no dispatcher.
 */
var FIND_ACTION_EXTRAS = {
  findInFile: function () { return !fileFindBlockedByOverlay() && openFileFind(); },
};

/** Every row of the shortcut table this page can actually invoke, as list items. */
function findActionItems() {
  if (actionItems.length) return actionItems;
  actionItems = SHORTCUT_DEFS.filter(function (def) {
    return def && def.id
      && (typeof SHORTCUT_ACTIONS[def.id] === 'function' || typeof FIND_ACTION_EXTRAS[def.id] === 'function');
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
  // With the rail, not on its own: Actions is one of IntelliJ's Search Everywhere tabs
  // (SearchEverywhereTabsShortcutsUtils maps ActionSearchEverywhereContributor to GotoAction), so the
  // strip has to be there to switch away from it — Tab out of the command list and you are in Files.
  openQuickOpen('actions');
  return true;
}

function renderFindActionResults(query) {
  if (!quickResults) return;
  var needle = String(query || '').trim().toLowerCase();
  // The matcher gets the query AS TYPED — `needle` stays lower-cased for this list's own
  // substring work, because camel humps are case and a lower-cased pattern has none.
  var queries = queryVariants(String(query || '').trim());
  let rows = findActionItems().filter(function (item) {
    if (!needle) return true;
    // The chord is part of the haystack on purpose: "what was ⌘⇧E again" is the other half of why this
    // list is opened, and typing the chord finds the action it belongs to.
    var hay = [item.name, item.actionId, item.chords.join(' ')];
    return matchesQueryVariants(hay, queries);
  });
  // Ranked by how well each answers, which this list did not do at all — it kept the alphabetical order
  // the commands are declared in. It mattered little while the rule was `includes` and every row matched
  // the same way; it matters now, because a hump match and an accident score an order of magnitude
  // apart: `SE` is "Search Everywhere" at 1091 and "Collapse all" — the `se` inside "Collapse" — at 1.
  // IntelliJ's Find Action ranks the same way. The ties keep their declared order, which is what a
  // stable sort on an equal key gives.
  if (needle) {
    rows = rows
      .map(function (item) {
        return { item: item, rank: minusculeQueryScore([item.name, item.actionId, item.chords.join(' ')], queries) };
      })
      .sort(function (a, b) { return b.rank - a.rank; })
      .map(function (scored) { return scored.item; });
  }
  quickItems = rows.map(function (item) {
    return { path: '', name: item.name, detail: item.chords.join(' / '), kind: 'action', recent: false, lineIndex: 0, column: 0, text: '', actionId: item.actionId };
  });
  clampQuickActive();
  setQuickFilterChip(false, resultsLabel(rows.length));
  if (!rows.length) {
    showQuickEmpty(t('quickopen.noMatches'));
    return;
  }
  quickResults.innerHTML = rows.map(function (item, index) {
    return '<button type="button" class="quick-open-item action-result' + (index === quickActive ? ' active' : '')
      + '" data-index="' + index + '" data-action="' + escapeHtml(item.actionId) + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(item.name) + '</span></span>'
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
  var action = SHORTCUT_ACTIONS[item.actionId] || FIND_ACTION_EXTRAS[item.actionId];
  if (!action) return false;
  closeQuickOpen();
  // `index` 0: the action is told which of its combinations fired, and a list row is the first one. The
  // event is null — every handler that reads it reads modifier state, which a click does not have.
  //
  // The handler's own answer used to be discarded, and that is where the note at the top of this slice
  // leaked: "Collapse recursively", "Prev / next tab" and "Rendered / raw Markdown" are all listed, all
  // belong to an open file, and all did nothing at all when run from the diff — the dead row the doctrine
  // says is worse than an absent one, reached the long way round. Hiding them would also hide the fact
  // that the command EXISTS, which is half of what a palette is for, so the decline is spoken instead.
  // `=== false` and not falsiness: declining is a deliberate answer (AGENTS.md), and a handler that
  // simply returns nothing has done its work. The row's label names its surface where there is one.
  setTimeout(function () {
    if (action(null, 0) === false) showCaretHint(t('findaction.declined').replace('{action}', item.name));
  }, 0);
  return true;
}
