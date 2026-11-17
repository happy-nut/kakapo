
var SE_WEIGHT = { recent: 70, file: 200, symbol: 300, action: 400 };
var SE_GROUP_LIMIT = 15;
var SE_SYMBOL_DEBOUNCE_MS = 80;
var SE_EVERYWHERE_KEY = 'kakapo-se-everywhere';

var everywhereQuery = '\0';
var everywhereLimit = SE_GROUP_LIMIT;
var everywhereSymbolItems = [];
var everywhereSymbolBusy = false;
var everywhereSymbolSeq = 0;
var everywhereSymbolTimer = null;
var everywhereSymbolEngine = '';
var everywhereScope = null;
var everywhereScopeManual = false;

function seScopeEverywhere() {
  if (everywhereScope === null) everywhereScope = persistRead(SE_EVERYWHERE_KEY) === true;
  return everywhereScope;
}
function setSeScopeEverywhere(value) {
  everywhereScope = !!value;
  persistSave(SE_EVERYWHERE_KEY, everywhereScope);
}
function toggleSeEverywhere() {
  if (quickMode !== 'everywhere') return false;
  setSeScopeEverywhere(!seScopeEverywhere());
  everywhereScopeManual = true;
  renderQuickOpenResults();
  return true;
}

function quickLineAndColumn(raw) {
  var text = String(raw || '');
  if (!/[:,;@[( #]/.test(text) && text.indexOf(' line ') < 0 && text.indexOf('?l=') < 0) {
    return { name: text, lineIndex: -1, column: -1 };
  }
  var m = /^(.+?)(?::|@|,| |#|#L|\?l=| on line | at line |:line |:?\(|:?\[)(\d+)?(?:\W(\d+)?)?[)\]]?$/.exec(text);
  if (!m) return { name: text, lineIndex: -1, column: -1 };
  return {
    name: m[1],
    lineIndex: m[2] ? Math.max(0, Number(m[2]) - 1) : -1,
    column: m[3] ? Math.max(0, Number(m[3]) - 1) : -1,
  };
}

function sePriority(name, path, query) {
  if (!query) return 0;
  var degree = minusculeQueryScore([name, path], [query]);
  return degree > -Infinity ? degree : 0;
}

function seItemIsChanged(item) {
  if (!item) return false;
  return item.kind === 'change' || pathIsChanged(item.path);
}

function seRecentGroup(query, queries) {
  return recentItems().filter(function (item) {
    return !query || matchesQueryVariants(quickItemHaystack(item), queries);
  }).map(function (item, index) {
    return Object.assign({}, item, {
      seGroup: 'recent',
      sePriority: sePriority(item.name, item.path, query) + Math.max(0, 30 - index),
    });
  });
}

function seFileGroup(query, queries) {
  var everywhere = seScopeEverywhere();
  return allQuickItems().filter(function (item) {
    if (!everywhere && !seItemIsChanged(item)) return false;
    return !query || matchesQueryVariants(quickItemHaystack(item), queries);
  }).map(function (item) {
    return Object.assign({}, item, { seGroup: 'file', sePriority: sePriority(item.name, item.path, query) });
  });
}

function seActionGroup(query, queries) {
  if (!query) return [];
  return findActionItems().filter(function (item) {
    return matchesQueryVariants([item.name, item.actionId, item.chords.join(' ')], queries);
  }).map(function (item) {
    return {
      path: '', name: item.name, detail: item.chords.join(' / '), kind: 'action', recent: false,
      lineIndex: 0, column: 0, text: '', actionId: item.actionId, chords: item.chords,
      seGroup: 'action', sePriority: sePriority(item.name, '', query),
    };
  });
}

function seSymbolGroup(query) {
  var everywhere = seScopeEverywhere();
  return everywhereSymbolItems.filter(function (item) {
    return everywhere || seItemIsChanged(item);
  }).map(function (item) {
    return Object.assign({}, item, { seGroup: 'symbol', sePriority: sePriority(item.name, item.path, query) });
  });
}

function runSeSymbolSearch(query, seq) {
  var loc = caretSourceLoc() || { path: sourceFiles[0] && sourceFiles[0].path, lineIndex: 0, column: 0 };
  queryProjectAnalysis('workspaceSymbol', null, loc, { query: query, limit: 200, types: false }).then(function (response) {
    if (seq !== everywhereSymbolSeq || quickMode !== 'everywhere') return;
    everywhereSymbolItems = response && Array.isArray(response.locations) ? response.locations.map(function (item) {
      return {
        path: item.path,
        name: String(item.name || baseName(item.path)),
        detail: item.kind != null ? 'symbol ' + item.kind : 'symbol',
        kind: 'symbol',
        recent: false,
        lineIndex: Number(item.lineIndex) || 0,
        column: Number(item.column) || 0,
        text: String(item.text || ''),
      };
    }) : [];
    everywhereSymbolEngine = revisionDecline(response) !== null
      ? t('quickopen.revisionOff')
      : response && response.engine === 'lsp' ? (response.server || 'LSP') : 'index';
    everywhereSymbolBusy = false;
    renderQuickOpenResults();
  });
}

function expandEverywhereMore(item) {
  if (!item || item.kind !== 'more') return false;
  everywhereLimit += SE_GROUP_LIMIT;
  renderQuickOpenResults();
  return true;
}

function renderEverywhereResults(rawQuery) {
  if (!quickResults) return;
  var parsed = quickLineAndColumn(rawQuery);
  var query = String(parsed.name || '').trim();
  var queries = queryVariants(query);
  if (rawQuery !== everywhereQuery) {
    everywhereQuery = rawQuery;
    everywhereLimit = SE_GROUP_LIMIT;
    everywhereScopeManual = false;
    everywhereSymbolSeq += 1;
    everywhereSymbolItems = [];
    everywhereSymbolEngine = '';
    if (everywhereSymbolTimer) clearTimeout(everywhereSymbolTimer);
    if (query) {
      everywhereSymbolBusy = true;
      var seq = everywhereSymbolSeq;
      everywhereSymbolTimer = setTimeout(function () { runSeSymbolSearch(query, seq); }, SE_SYMBOL_DEBOUNCE_MS);
    } else {
      everywhereSymbolBusy = false;
    }
    if (REVIEW_LAZY_LOAD && !projectIndexLoaded && query) {
      ensureProjectIndex().then(function () {
        if (quickOpen && !quickOpen.classList.contains('hidden') && quickMode === 'everywhere') renderQuickOpenResults();
      });
    }
  }

  var groups = query
    ? [seRecentGroup(query, queries), seFileGroup(query, queries), seSymbolGroup(query), seActionGroup(query, queries)]
    : [seRecentGroup('', queries)];
  var truncated = false;
  var seen = new Set();
  var merged = [];
  groups.forEach(function (group) {
    if (group.length > everywhereLimit) truncated = true;
    group.slice(0, everywhereLimit).forEach(function (item) {
      var id = item.kind === 'action' ? 'action:' + item.actionId
        : item.kind === 'symbol' ? 'symbol:' + item.path + ':' + item.lineIndex + ':' + item.name
          : 'path:' + item.path;
      if (seen.has(id)) return;
      seen.add(id);
      merged.push(item);
    });
  });
  merged.sort(function (a, b) {
    return (b.sePriority - a.sePriority)
      || (SE_WEIGHT[a.seGroup] - SE_WEIGHT[b.seGroup])
      || String(a.name).localeCompare(String(b.name));
  });

  if (!merged.length && query && !seScopeEverywhere() && !everywhereScopeManual && !everywhereSymbolBusy) {
    everywhereScopeManual = true;
    setSeScopeEverywhere(true);
    renderEverywhereResults(rawQuery);
    return;
  }

  if (parsed.lineIndex >= 0) {
    merged = merged.map(function (item) {
      return item.kind === 'action' ? item
        : Object.assign({}, item, { kind: 'symbol', lineIndex: parsed.lineIndex, column: Math.max(0, parsed.column) });
    });
  }
  if (truncated) merged.push({ path: '', name: t('quickopen.more'), detail: '', kind: 'more', recent: false });

  quickItems = merged;
  clampQuickActive();
  var scopeLabel = seScopeEverywhere() ? t('quickopen.scopeEverywhere') : t('quickopen.scopeChanged');
  var countLabel = resultsLabel(truncated ? merged.length - 1 : merged.length);
  setQuickFilterChip(everywhereSymbolBusy, countLabel + ' · ' + scopeLabel
    + (everywhereSymbolEngine ? ' · ' + everywhereSymbolEngine : ''));
  if (!merged.length) {
    if (everywhereSymbolBusy) showQuickLoading();
    else showQuickEmpty(query ? t('quickopen.noMatches') : t('quickopen.typeToSearch'));
    return;
  }
  quickResults.innerHTML = merged.map(function (item, index) { return seRowHtml(item, index); }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

function seRowHtml(item, index) {
  var active = index === quickActive ? ' active' : '';
  if (item.kind === 'more') {
    return '<button type="button" class="quick-open-item se-more' + active + '" data-index="' + index + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(item.name) + '</span></span></button>';
  }
  if (item.kind === 'action') {
    return '<button type="button" class="quick-open-item action-result' + active + '" data-index="' + index + '"'
      + ' data-action="' + escapeHtml(item.actionId) + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(item.name) + '</span></span>'
      + ((item.chords || []).length
        ? '<span class="action-chords">' + item.chords.map(function (chord) {
          return '<kbd class="action-chord">' + escapeHtml(chord) + '</kbd>';
        }).join('') + '</span>'
        : '')
      + '</button>';
  }
  if (item.seGroup === 'symbol') {
    return '<button type="button" class="quick-open-item symbol-result' + active + '" data-index="' + index + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(item.name) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '</span>'
      + projectRowTagsHtml(item.path) + '</span>'
      + '<span class="quick-open-badge">' + escapeHtml(item.detail) + '</span></button>';
  }
  return '<button type="button" class="quick-open-item' + active + '" data-index="' + index + '">'
    + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(item.name) + '</span>'
    + '<span class="quick-open-path">' + escapeHtml(item.path) + '</span>'
    + projectRowTagsHtml(item.path) + '</span>'
    + '<span class="quick-open-badge' + (item.kind === 'change' ? ' is-changed' : '')
    + '" title="' + escapeHtml(item.detail) + '">' + virtualTypeIcon(item.path) + '</span></button>';
}

var QUICK_LAUNCHER_SECTIONS = {
  everywhere: {
    open: function () { everywhereQuery = '\0'; everywhereScopeManual = false; openQuickOpen('everywhere'); },
    active: function () { return quickMode === 'everywhere'; },
  },
  classes: {
    open: function () { openWorkspaceSymbols(true); },
    active: function () { return quickMode === 'symbol' && workspaceSymbolTypesOnly; },
  },
  all: { open: function () { openQuickOpen('all'); }, active: function () { return quickMode === 'all'; } },
  symbol: {
    open: function () { openWorkspaceSymbols(false); },
    active: function () { return quickMode === 'symbol' && !workspaceSymbolTypesOnly; },
  },
  actions: { open: function () { openFindAction(); }, active: function () { return quickMode === 'actions'; } },
  content: { open: function () { openQuickOpen('content'); }, active: function () { return quickMode === 'content'; } },
  recent: { open: function () { openQuickOpen('recent'); }, active: function () { return quickMode === 'recent'; } },
};

function quickLauncherSectionActive(section) {
  var entry = QUICK_LAUNCHER_SECTIONS[section];
  return !!entry && entry.active();
}

function switchQuickLauncherSection(section) {
  var entry = QUICK_LAUNCHER_SECTIONS[section];
  if (!entry) return false;
  var open = !!(quickOpen && !quickOpen.classList.contains('hidden'));
  var carried = !open ? '' : quickMode === 'recent' ? recentFilter : String(quickInput && quickInput.value || '');
  entry.open();
  if (!carried) return true;
  if (quickMode === 'recent') { recentFilter = carried; updateRecentFilterDisplay(); }
  else if (quickInput) quickInput.value = carried;
  renderQuickOpenResults();
  return true;
}

function quickLauncherTabRows() {
  return Array.prototype.slice.call(document.querySelectorAll('#quick-open-side .quick-open-side-item[data-se-tab]'));
}

function handleQuickLauncherTabKey(event) {
  if (!quickOpen || quickOpen.classList.contains('hidden')) return false;
  var next = isShortcut(event, 'seNextTab');
  var prev = isShortcut(event, 'sePrevTab');
  if (!next && !prev) return false;
  if (event.defaultPrevented) return true;
  if (focusedQuickSideItem()) return false;
  var rows = quickLauncherTabRows();
  if (rows.length < 2) return false;
  var at = -1;
  for (var i = 0; i < rows.length; i += 1) if (rows[i].classList.contains('active')) at = i;
  event.preventDefault();
  var step = next ? 1 : rows.length - 1;
  var target = rows[((at < 0 ? 0 : at) + step) % rows.length];
  if (target) switchQuickLauncherSection(target.dataset.section);
  return true;
}
