
var actionItems = [];

var FIND_ACTION_EXTRAS = {
  findInFile: function () { return !fileFindBlockedByOverlay() && openFileFind(); },
};

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

function forgetFindActionItems() {
  actionItems = [];
}

function openFindAction() {
  findActionItems();
  openQuickOpen('actions');
  return true;
}

function renderFindActionResults(query) {
  if (!quickResults) return;
  var needle = String(query || '').trim().toLowerCase();
  var queries = queryVariants(String(query || '').trim());
  let rows = findActionItems().filter(function (item) {
    if (!needle) return true;
    var hay = [item.name, item.actionId, item.chords.join(' ')];
    return matchesQueryVariants(hay, queries);
  });
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
  renderQuickPreview(null);
}

function runFindActionItem(item) {
  if (!item || item.kind !== 'action') return false;
  var action = SHORTCUT_ACTIONS[item.actionId] || FIND_ACTION_EXTRAS[item.actionId];
  if (!action) return false;
  closeQuickOpen();
  setTimeout(function () {
    if (action(null, 0) === false) showCaretHint(t('findaction.declined').replace('{action}', item.name));
  }, 0);
  return true;
}
