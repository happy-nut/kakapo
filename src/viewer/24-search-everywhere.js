// ⇧⇧: IntelliJ's Search Everywhere — the All tab, and the tab strip the other searches hang off.
//
// Ported from the shipped IDE rather than from memory. The classes live in
// `IntelliJ IDEA CE.app/Contents/lib/app-client.jar` (the frontend half of the 2025 split, NOT app.jar),
// and the four that decide what this file does are:
//
//   SearchEverywhereBaseAction  — the chord again on the tab already up widens the scope; another tab's
//                                 chord switches to it instead of reopening.
//   SearchEverywhereTabsShortcutsUtils — the tab strip: All (double shift), Classes (GotoClass),
//                                 Files (GotoFile), Symbols (GotoSymbol), Actions (GotoAction),
//                                 Text (TextSearchAction).
//   MixedListFactory            — the All tab is ONE FLAT LIST with no group headings, sorted by the
//                                 element's own match weight and only tie-broken by which contributor
//                                 produced it, with a single trailing "more" row.
//   SearchEverywhereUI          — SINGLE_CONTRIBUTOR_ELEMENTS_LIMIT 30 / MULTIPLE_CONTRIBUTORS 15, and
//                                 the +15 a "more" row fetches.
//
// The flatness is the thing worth saying out loud, because the obvious design is the opposite: a column
// of labelled sections. IntelliJ dropped that (the grouped list model is gone — MixedListFactory is the
// only factory left), and a merged list that re-sorts on every keystroke reads better for it: the best
// answer is always row 0, whichever kind of thing it is.

/**
 * IntelliJ's contributor sort weights, verbatim from the contributors' own getSortWeight().
 *
 * They are a TIE-BREAK, not the sort: SearchEverywhereFoundElementInfo.COMPARATOR compares the elements'
 * match weights first and only reaches for these when two rows answer the query equally well. Lower wins.
 * (TopHitSEContributor 50 and ClassSearchEverywhere 100 are the two this app has no producer for — it has
 * no top-hit provider, and a class is a symbol from the same query, which IntelliJ's own equality
 * providers merge back into one row anyway.)
 */
var SE_WEIGHT = { recent: 70, file: 200, symbol: 300, action: 400 };
/** MULTIPLE_CONTRIBUTORS_ELEMENTS_LIMIT, and what a "more" row adds. */
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
var everywhereScope = null; // lazily read from storage; null means "not asked yet"
// IntelliJ's isScopeDefaultAndAutoSet, inverted: true once the person has said what scope they want for
// the query on screen, which is what stops the automatic widening below from overruling them. Cleared
// when the query changes, exactly as IntelliJ clears myNotFoundString when the pattern moves away.
var everywhereScopeManual = false;

/**
 * Is the scope widened past the change?
 *
 * IntelliJ's "Include non-project items" has no literal counterpart here — nothing in a review is a
 * non-project file — so the toggle takes the one scope line this app really has: the review IS a change,
 * so the narrow scope is the files that moved and the wide one is the whole project index. That is the
 * same shape as IntelliJ's (what you are working on / everything) and it is the distinction the Find in
 * Files scope selector already offers under the name "Changed files".
 *
 * Saved, like the compare mode is, because it cannot be inferred from anything on screen.
 */
function seScopeEverywhere() {
  if (everywhereScope === null) everywhereScope = persistRead(SE_EVERYWHERE_KEY) === true;
  return everywhereScope;
}
function setSeScopeEverywhere(value) {
  everywhereScope = !!value;
  persistSave(SE_EVERYWHERE_KEY, everywhereScope);
}
/** ⇧⇧ with the All tab already up. Returns false when the tab has no scope to widen, as IntelliJ's does. */
function toggleSeEverywhere() {
  if (quickMode !== 'everywhere') return false;
  setSeScopeEverywhere(!seScopeEverywhere());
  everywhereScopeManual = true;
  // Re-rendered, NOT re-queried: the scope decides which files are offered and the file group is rebuilt
  // from the index on every render anyway. Only the symbol search is cached, and widening the file scope
  // does not change its answer — resetting the query threw that answer away and put the list back into
  // "Searching…" for a toggle that had nothing to ask anyone.
  renderQuickOpenResults();
  return true;
}

/**
 * The line (and column) written after a name, exactly as IntelliJ reads it.
 *
 * `ourPatternToDetectLinesAndColumns` from AbstractGotoSEContributor, verbatim — which is far wider than
 * the `name:42` this app accepted: `App.tsx:42:7`, `App.tsx 42`, `App.tsx@42`, `App.tsx#L42`,
 * `App.tsx?l=42`, `App.tsx on line 42`, `App.tsx(42,7)` and `App.tsx[42]` all name line 42. Guarded by
 * the same cheap character test IntelliJ guards it with (filterControlSymbols), so an ordinary query
 * never touches the regular expression, and applied with the same rule: the WHOLE string must match or
 * the query is left alone — which is why `foo bar` stays `foo bar` and only `foo 42` becomes `foo`.
 */
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

/**
 * How well a row answers the query — one scale for every group in the merged list.
 *
 * It has to be one function. The merged order is match weight first and contributor weight only as a
 * tie-break, so if each group scored on its own scale the comparison across groups would be noise: the
 * file list's own `scoreQuickItem` runs to -3000 and a symbol would never be seen next to it. Higher wins
 * here (IntelliJ's priorities are "bigger is better" and the comparator is reversed).
 */
function sePriority(name, path, query) {
  if (!query) return 0;
  var n = String(name || '').toLowerCase();
  var p = String(path || '').toLowerCase();
  if (n === query) return 1000;
  if (n.indexOf(query) === 0) return 800;
  if (n.indexOf(query) >= 0) return 600;
  if (p.indexOf('/' + query) >= 0) return 400;
  if (p.indexOf(query) >= 0) return 200;
  return 0;
}

/**
 * Did this row move in the review? The narrow scope is exactly the rows for which this is true.
 *
 * A 'change' row is a file the diff has and the source index does not (a binary, a deletion), so it is
 * changed by construction; everything else asks pathIsChanged, which is where that question lives.
 */
function seItemIsChanged(item) {
  if (!item) return false;
  return item.kind === 'change' || pathIsChanged(item.path);
}

// ---- The groups ----------------------------------------------------------------------------------
// Each one answers with items already carrying `seGroup` (which weight applies) and `sePriority`. They
// are capped and merged below; none of them sorts, because sorting is the merged list's job.

/**
 * Recent files, newest first.
 *
 * The recency has to ride INSIDE the priority or the merged sort throws it away: with an empty box every
 * row scores 0, so the list fell back to the name tie-break and "recent files" came out alphabetical. A
 * bonus of at most 30 is also small enough never to outrank a better match — the match-quality steps in
 * sePriority are 200 apart — which is the other half of what RecentFilesSEContributor's element priority
 * does there.
 */
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
  if (!query) return []; // an unprompted list of every command is not an answer to an empty box
  return findActionItems().filter(function (item) {
    return matchesQueryVariants((item.name + ' ' + item.actionId + ' ' + item.chords.join(' ')).toLowerCase(), queries);
  }).map(function (item) {
    return {
      path: '', name: item.name, detail: item.chords.join(' / '), kind: 'action', recent: false,
      lineIndex: 0, column: 0, text: '', actionId: item.actionId, chords: item.chords,
      seGroup: 'action', sePriority: sePriority(item.name, '', query),
    };
  });
}

/**
 * Symbols, scoped like the files are.
 *
 * Scoped HERE rather than in the request, because the server has no idea what a review is — and left
 * unscoped the tab contradicted itself: a narrow scope offered symbols from the whole project while
 * hiding the very files they live in. IntelliJ applies its scope to every contributor that supports one
 * (ScopeSupporting), and this is that.
 */
function seSymbolGroup(query) {
  var everywhere = seScopeEverywhere();
  return everywhereSymbolItems.filter(function (item) {
    return everywhere || seItemIsChanged(item);
  }).map(function (item) {
    return Object.assign({}, item, { seGroup: 'symbol', sePriority: sePriority(item.name, item.path, query) });
  });
}

/**
 * The symbol group, which is the one that cannot answer at once.
 *
 * Streamed in, the way IntelliJ's contributors are: the synchronous groups paint immediately and this one
 * merges itself into the list when the server answers. The alternative — holding the whole list back until
 * the slowest contributor is done — is what WaitForContributorsListenerWrapper does there, and it is off
 * by default for exactly this reason.
 */
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
    // Re-rendered through the dispatcher, which reads the box — NOT with `query`, which is the stripped
    // and lowercased name. Handing that back as the raw query made it differ from the one on screen, so
    // the render below read it as a NEW query: `App.tsx` searched twice, and `app.ts:42` dropped its line
    // number and then flip-flopped with the box on every answer.
    renderQuickOpenResults();
  });
}

/** Enter on the trailing "more" row: +15 per group, as IntelliJ's more element fetches. */
function expandEverywhereMore(item) {
  if (!item || item.kind !== 'more') return false;
  everywhereLimit += SE_GROUP_LIMIT;
  renderQuickOpenResults();
  return true;
}

function renderEverywhereResults(rawQuery) {
  if (!quickResults) return;
  var parsed = quickLineAndColumn(rawQuery);
  var query = String(parsed.name || '').trim().toLowerCase();
  var queries = queryVariants(query);
  if (rawQuery !== everywhereQuery) {
    everywhereQuery = rawQuery;
    everywhereLimit = SE_GROUP_LIMIT;
    everywhereScopeManual = false;
    everywhereSymbolSeq += 1;
    everywhereSymbolItems = [];
    everywhereSymbolEngine = ''; // the chip must not name the server that answered the PREVIOUS query
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

  // Empty box: recent files and nothing else. RecentFilesSEContributor is the one contributor whose
  // isEmptyPatternSupported() is true, which is why IntelliJ's All tab opens on the recent list.
  var groups = query
    ? [seRecentGroup(query, queries), seFileGroup(query, queries), seSymbolGroup(query), seActionGroup(query, queries)]
    : [seRecentGroup('', queries)];
  var truncated = false;
  var seen = new Set();
  var merged = [];
  groups.forEach(function (group) {
    if (group.length > everywhereLimit) truncated = true;
    group.slice(0, everywhereLimit).forEach(function (item) {
      // IntelliJ's SEResultsEqualityProvider: the same element found by two contributors is ONE row.
      // Here that is a recent file which is also a file of the project — the recent group wins because
      // it is merged first and carries the lighter weight.
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

  // Nothing in the change, so widen — IntelliJ's autoSetEverywhere, which it runs for the same reason
  // (a query that found nothing in the project scope is retried everywhere rather than answered "no").
  if (!merged.length && query && !seScopeEverywhere() && !everywhereScopeManual && !everywhereSymbolBusy) {
    everywhereScopeManual = true; // once per query, and never over a scope the person chose by hand
    setSeScopeEverywhere(true);
    renderEverywhereResults(rawQuery);
    return;
  }

  // A line written after the name opens the row AT that line, on a copy, so the shared index entry does
  // not keep a line number from an earlier search (the same care the file list takes).
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
    // "No matches" while a contributor is still working is the reassuring lie this app's empty states are
    // written against: nothing has answered yet, which is not the same as nothing being there.
    if (everywhereSymbolBusy) showQuickLoading();
    else showQuickEmpty(query ? t('quickopen.noMatches') : t('quickopen.typeToSearch'));
    return;
  }
  quickResults.innerHTML = merged.map(function (item, index) { return seRowHtml(item, index); }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

/**
 * One row of the merged list.
 *
 * One function for all four kinds rather than borrowing each group's own renderer: the rows sit next to
 * each other in one list, so what varies between them — the second line and the badge — has to be
 * decided in one place or the list stops looking like one list.
 */
function seRowHtml(item, index) {
  var active = index === quickActive ? ' active' : '';
  if (item.kind === 'more') {
    return '<button type="button" class="quick-open-item se-more' + active + '" data-index="' + index + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + escapeHtml(item.name) + '</span></span></button>';
  }
  if (item.kind === 'action') {
    return '<button type="button" class="quick-open-item action-result' + active + '" data-index="' + index + '"'
      + ' data-action="' + escapeHtml(item.actionId) + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + escapeHtml(item.name) + '</span></span>'
      + ((item.chords || []).length
        ? '<span class="action-chords">' + item.chords.map(function (chord) {
          return '<kbd class="action-chord">' + escapeHtml(chord) + '</kbd>';
        }).join('') + '</span>'
        : '')
      + '</button>';
  }
  if (item.seGroup === 'symbol') {
    return '<button type="button" class="quick-open-item symbol-result' + active + '" data-index="' + index + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + escapeHtml(item.name) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '</span>'
      + projectRowTagsHtml(item.path) + '</span>'
      + '<span class="quick-open-badge">' + escapeHtml(item.detail) + '</span></button>';
  }
  return '<button type="button" class="quick-open-item' + active + '" data-index="' + index + '">'
    + '<span class="quick-open-main"><span class="quick-open-name">' + escapeHtml(item.name) + '</span>'
    + '<span class="quick-open-path">' + escapeHtml(item.path) + '</span>'
    + projectRowTagsHtml(item.path) + '</span>'
    + '<span class="quick-open-badge' + (item.kind === 'change' ? ' is-changed' : '')
    + '" title="' + escapeHtml(item.detail) + '">' + virtualTypeIcon(item.path) + '</span></button>';
}

// ---- The tab strip -------------------------------------------------------------------------------

/**
 * The tabs, and what each one is.
 *
 * `active` rather than comparing `quickMode` to the section name, because two of these tabs ARE the same
 * mode: Classes and Symbols are one search with a flag (openWorkspaceSymbols), so a mode comparison lit
 * both rows at once.
 */
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

/** Is this rail row the section on screen? The one reader of that question. */
function quickLauncherSectionActive(section) {
  var entry = QUICK_LAUNCHER_SECTIONS[section];
  return !!entry && entry.active();
}

/**
 * Switch tabs, keeping what has been typed.
 *
 * IntelliJ's switchToTab leaves the search field alone and re-runs the query against the new tab's
 * contributors — typing a name on All and pressing Tab is how you narrow it to files. Every opener here
 * clears the box (they are all entry points in their own right), so the text is carried across by hand.
 */
function switchQuickLauncherSection(section) {
  var entry = QUICK_LAUNCHER_SECTIONS[section];
  if (!entry) return false;
  // Only what is on screen NOW is carried. quickMode and recentFilter outlive a close, so reading them
  // on a cold open would have pasted the last session's speed-search into the new tab.
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

/**
 * Tab / ⇧Tab inside the dialog: step the tab strip.
 *
 * Answered here and not in the global dispatcher because the dialog's own focus trap listens on the
 * panel and runs FIRST (it bubbles to #quick-open before it reaches document), so Tab would have been
 * swallowed as "keep the focus inside" before any tab switch could see it. Both callers ask this, and
 * `defaultPrevented` is how the second one knows the first already answered.
 */
function handleQuickLauncherTabKey(event) {
  if (!quickOpen || quickOpen.classList.contains('hidden')) return false;
  var next = isShortcut(event, 'seNextTab');
  var prev = isShortcut(event, 'sePrevTab');
  if (!next && !prev) return false;
  if (event.defaultPrevented) return true;
  // While the rail itself has the keyboard, Tab steps back out to the results — this dialog's own
  // convention, and older than the strip. handleQuickOpenKey owns that branch.
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
