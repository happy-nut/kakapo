var quickPreviewSeq = 0;
var quickPreviewState = null;
var quickPreviewScrollFrame = 0;
var QUICK_PREVIEW_RADIUS = 60;
var QUICK_PREVIEW_CHUNK = 120;

// Cmd/Ctrl+A is the app menu's `selectAll` role, and that acts on the whole webContents — so inside this
// dialog it highlighted the entire review page behind it instead of the text in the search box. Claim the
// accelerator for as long as the dialog is up (same mechanism the merged dock uses, see 08-dock.js); the
// focused <input> then handles Cmd+A itself, natively, and selects only its own text.
function setQuickOpenOwnsEditKeys(owns) {
  if (window.kakapoApp && typeof window.kakapoApp.setIgnoreMenuShortcuts === 'function') {
    window.kakapoApp.setIgnoreMenuShortcuts(!!owns);
  }
}
// Claim the app menu's edit accelerators only while nothing in this dialog is being typed into. Claiming
// them for as long as the dialog was open took Cmd+V and Cmd+C away from the search box along with Cmd+A —
// in an Electron window those keys ARE the menu's roles, so pasting a query stopped working entirely. The
// case the claim exists for is Recent files, which has no input and leaves nothing focused: there the
// menu's selectAll would run against the whole review page behind the dialog.
function syncQuickOpenEditKeys() {
  var focused = document.activeElement;
  var typing = !!focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.isContentEditable);
  setQuickOpenOwnsEditKeys(!typing);
}
// The sections that live INSIDE this dialog. The other entries (review comments, history) are panels of
// their own — reachable here, not embedded — so they just open and dismiss the launcher.
var QUICK_LAUNCHER_MODES = ['recent', 'all', 'content'];
// hideRail: open this section on its own, with no rail beside it. ⌘E asks for that — it names the section
// it wants, so a column of the other sections beside a short list of recent files is all frame and no list.
function openQuickOpen(mode, hideRail) {
  if (!quickOpen || !quickInput || !quickModeLabel) return;
  quickMode = mode;
  quickModeLabel.textContent = mode === 'recent'
    ? t('quickopen.recent')
    : mode === 'content'
      ? t('quickopen.findInFiles')
      : mode === 'symbol'
        ? t(workspaceSymbolTypesOnly ? 'quickopen.goToClass' : 'quickopen.workspaceSymbols')
        : mode === 'structure'
          ? t('structure.title')
          : mode === 'locations'
            ? t('locations.title')
            : mode === 'hierarchy'
              ? t('hierarchy.title')
              : mode === 'bookmarks'
                ? t('bookmark.title')
                : mode === 'usages'
                  ? t('findusages.title').replace('{name}', usageViewName)
                  : mode === 'problems'
                    ? t('problems.title')
                    : mode === 'actions'
                      ? t('actions.title')
                      : t('quickopen.searchFiles');
  quickInput.setAttribute('placeholder', mode === 'symbol'
    ? t('quickopen.workspaceSymbols')
    : mode === 'content'
      ? t('quickopen.findInFiles')
      : mode === 'structure'
        ? t('structure.placeholder')
        : mode === 'locations'
          ? t('locations.placeholder')
          : mode === 'hierarchy'
            ? t('hierarchy.placeholder')
            : mode === 'bookmarks'
              ? t('bookmark.placeholder')
              : mode === 'usages'
                ? t('findusages.placeholder')
                : mode === 'problems'
                  ? t('problems.placeholder')
                  : mode === 'actions'
                    ? t('actions.placeholder')
                    : t('quickopen.searchFiles'));
  quickOpen.classList.remove('hidden');
  // Recent files needs no search box — it's just the latest files. Hide the input and let typed letters
  // narrow the list (IntelliJ-style speed search); the global keydown routes keys to handleQuickOpenKey.
  quickOpen.classList.toggle('quick-recent', mode === 'recent');
  quickOpen.classList.toggle('quick-content', mode === 'content');
  // The usage view shares this strip: Find-in-Files' "comments & tests are noise" toggle (⌥P) keeps its
  // meaning there, and beside it the Group By and Show chips of IntelliJ's two usage-view toolbars appear
  // — #quick-open-usage-options, driven by 17-find-usages.js.
  quickOpen.classList.toggle('quick-usages', mode === 'usages');
  quickOpen.classList.toggle('quick-launcher', !hideRail && QUICK_LAUNCHER_MODES.indexOf(mode) >= 0);
  syncQuickLauncherRail();
  syncContentSearchControls();
  recentFilter = '';
  quickInput.value = '';
  updateRecentFilterDisplay();
  // The selection goes back to the top with it: the list is re-sorted by commit date on every read, so a
  // carried-over index does not point at the row it pointed at last time — it points at whichever checkout
  // has since moved into that slot. Row 0 is always the checkout you are in.
  renderQuickOpenResults();
  // File search intentionally stays empty until the user types. Loading the whole project index on open
  // made an untouched dialog look like an arbitrary file browser and spent work before there was a query.
  // The first real file-name query requests the deferred index in renderQuickOpenResults().
  // Picking a section is done with the rail: focus goes to the section's own panel, whether the pick came from
  // a click or from Enter on the rail. Arrows then move in the list, ArrowLeft steps back to the rail.
  if (mode === 'recent') { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); syncQuickOpenEditKeys(); }
  else setTimeout(() => { quickInput.focus(); syncQuickOpenEditKeys(); }, 0);
}

// Mark the rail entry for the section on screen. The dock entries never mark: they close this dialog.
function syncQuickLauncherRail() {
  document.querySelectorAll('#quick-open-side .quick-open-side-item').forEach(function (item) {
    item.classList.toggle('active', item.dataset.section === quickMode);
  });
}

// The rail: switch to a section that lives here, or hand off to the dock that owns the rest and get out of
// the way. Wired once — the markup is static.
document.getElementById('quick-open-side')?.addEventListener('click', function (event) {
  var button = event.target.closest && event.target.closest('.quick-open-side-item');
  if (!button) return;
  var section = button.dataset.section;
  if (QUICK_LAUNCHER_MODES.indexOf(section) >= 0) {
    openQuickOpen(section);
    return;
  }
  closeQuickOpen();
  // Every other row owns a panel of its own. These used to be dispatched by clicking the matching activity-rail
  // button; the rail is gone, so the row calls the panel directly — a row that quietly opened nothing is worse
  // than no row at all. Blur first: the launcher is closing, and its own row must not keep the keyboard.
  if (button.blur) button.blur();
  if (section === 'history') openHistory();
});
// Title-row indicator for the Recent speed-search: the typed letters, or a muted "type to filter" hint.
function updateRecentFilterDisplay() {
  if (!quickFilterEl) return;
  if (quickMode !== 'recent') { quickFilterEl.textContent = ''; quickFilterEl.className = 'quick-open-filter'; return; }
  if (recentFilter) { quickFilterEl.textContent = recentFilter; quickFilterEl.className = 'quick-open-filter has-filter'; }
  else { quickFilterEl.textContent = t('quickopen.typeToFilter'); quickFilterEl.className = 'quick-open-filter is-hint'; }
}

function closeQuickOpen() {
  setQuickOpenOwnsEditKeys(false);
  // Hand the keyboard back explicitly. Chromium drops focus from an element that becomes display:none, so
  // in the app the focus would move on its own — but relying on that leaves the keyboard scope reading
  // "a text field is focused" in any environment that does not (jsdom), and every code-level shortcut
  // stands down while that is true. Saying it is cheaper than depending on it.
  var focused = document.activeElement;
  if (focused && quickOpen && quickOpen.contains(focused) && focused.blur) focused.blur();
  quickOpen?.classList.add('hidden');
  quickPreviewState = null;
  if (quickPreviewScrollFrame) cancelAnimationFrame(quickPreviewScrollFrame);
  quickPreviewScrollFrame = 0;
}

// The section rail is keyboard-reachable, not mouse-only: ArrowLeft steps into it from the list, arrows move
// within it, Enter picks, and ArrowRight steps back to the results. Rail focus is real DOM focus (they are
// buttons), so the browser draws it and Enter can simply click.
function quickSideItems() {
  return Array.prototype.slice.call(document.querySelectorAll('#quick-open-side .quick-open-side-item'));
}
function focusQuickSide() {
  var items = quickSideItems();
  var target = items.filter(function (item) { return item.classList.contains('active'); })[0] || items[0];
  if (target) target.focus();
}
function focusedQuickSideItem() {
  var el = document.activeElement;
  return el && el.closest ? el.closest('#quick-open-side .quick-open-side-item') : null;
}

// This dialog is a modal keyboard scope — while it is up, every key goes to it and menu accelerators are
// suspended (setQuickOpenOwnsEditKeys). So it must never outlive being looked at: it had no outside-click
// dismissal, and the terminal panel renders above it, so opening a terminal over an open launcher left an
// INVISIBLE dialog eating every keystroke (spaces included) and killing Cmd+Shift+E along with every other
// accelerator. A click anywhere outside its panel closes it.
document.addEventListener('mousedown', function (event) {
  if (!quickOpen || quickOpen.classList.contains('hidden')) return;
  if (event.target && event.target.closest && event.target.closest('.quick-open-panel')) return;
  closeQuickOpen();
}, true);

// Focus moves between the search box, the extension filter and the rail while the dialog is up, and each
// move changes whether the menu's edit keys belong to the page or to the field (see syncQuickOpenEditKeys).
document.addEventListener('focusin', function () { if (quickOpen && !quickOpen.classList.contains('hidden')) syncQuickOpenEditKeys(); });
document.addEventListener('focusout', function () {
  if (!quickOpen || quickOpen.classList.contains('hidden')) return;
  setTimeout(syncQuickOpenEditKeys, 0); // after the browser has settled on the next focus target
});

function handleQuickOpenKey(event) {
  // The hierarchy is a tree: ⇢ expands a row, ⇠ collapses it. Asked first, because ArrowLeft otherwise
  // steps out to the section rail.
  if (handleHierarchyKey(event)) return true;
  if (handleUsageViewKey(event)) return true;
  if (handleProblemsKey(event)) return true;
  if (quickMode === 'actions' && isShortcut(event, 'findAction')) { event.preventDefault(); closeQuickOpen(); return true; }
  var sideItem = focusedQuickSideItem();
  if (sideItem) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      var items = quickSideItems();
      var index = items.indexOf(sideItem);
      var step = event.key === 'ArrowDown' ? 1 : items.length - 1;
      var next = items[(index + step) % items.length];
      if (next) next.focus();
      return true;
    }
    if (event.key === 'Enter') { event.preventDefault(); sideItem.click(); return true; }
    if (event.key === 'ArrowRight' || event.key === 'Tab') { event.preventDefault(); sideItem.blur(); return true; }
    if (event.key === 'Escape') { event.preventDefault(); closeQuickOpen(); return true; }
  } else if (event.key === 'ArrowLeft' && QUICK_LAUNCHER_MODES.indexOf(quickMode) >= 0 && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    focusQuickSide();
    return true;
  }
  // Cmd/Ctrl+E toggles the Recent panel: it opened this dialog, so a second press closes it (parity with how
  // Esc dismisses it). Only for 'recent' — the same key means "focus extensions" inside Find-in-Files.
  if (quickMode === 'recent' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
    && (event.code === 'KeyE' || event.key.toLowerCase() === 'e')) {
    event.preventDefault();
    closeQuickOpen();
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    // Recent speed-search: first Esc clears the typed filter, a second Esc closes (IntelliJ behavior).
    if (quickMode === 'recent' && recentFilter) { recentFilter = ''; updateRecentFilterDisplay(); renderQuickOpenResults(); return true; }
    closeQuickOpen();
    return true;
  }
  if (quickMode === 'content' && isShortcut(event, 'searchScope')) {
    event.preventDefault();
    return cycleContentSearchScope();
  }
  if (quickMode === 'content' && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
    && (event.code === 'KeyE' || event.key.toLowerCase() === 'e')) {
    event.preventDefault();
    focusContentSearchExtensions();
    return true;
  }
  if (quickMode === 'content' && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
    && (event.code === 'KeyP' || event.key.toLowerCase() === 'p')) {
    event.preventDefault();
    toggleContentSearchNoise();
    return true;
  }
  // IntelliJ's Cc / W / .*, on the three letters the dialog can spare. Asked through the shortcut table
  // rather than spelled here, so the Settings sheet and these branches cannot drift apart.
  if (quickMode === 'content') {
    var modifiers = [['searchMatchCase', 'matchCase'], ['searchWholeWords', 'wholeWords'], ['searchRegex', 'regex']];
    for (var mi = 0; mi < modifiers.length; mi += 1) {
      if (!isShortcut(event, modifiers[mi][0])) continue;
      event.preventDefault();
      return toggleContentSearchModifier(modifiers[mi][1]);
    }
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    quickActive = Math.min(quickActive + 1, Math.max(quickItems.length - 1, 0));
    updateQuickActive();
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    quickActive = Math.max(quickActive - 1, 0);
    updateQuickActive();
    return true;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (document.activeElement === quickExtensionInput) {
      quickInput.focus();
      return true;
    }
    openQuickItem(quickItems[quickActive]);
    return true;
  }
  // Recent files has no input box: type letters to filter the list, Backspace to delete (speed search).
  if (quickMode === 'recent') {
    if (event.key === 'Backspace') {
      event.preventDefault();
      if (recentFilter) { recentFilter = recentFilter.slice(0, -1); updateRecentFilterDisplay(); renderQuickOpenResults(); }
      return true;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      recentFilter += event.key;
      updateRecentFilterDisplay();
      renderQuickOpenResults();
      return true;
    }
  }
  return false;
}

// Typing a file name with the keyboard still in Korean produces the Hangul those keys compose, not the
// letters — "Transfer" comes out "ㅆ뭬ㄴ랙". The keystrokes are recoverable: every syllable decomposes into
// the jamo that made it, and each jamo has one dubeolsik key. So a Hangul query also searches as what it
// would have typed in English, and a query that IS Korean (this project has 과제 안내.md) still matches
// itself — both variants are tried.
var DUBEOLSIK_CHO = ['r','R','s','e','E','f','a','q','Q','t','T','d','w','W','c','z','x','v','g'];
var DUBEOLSIK_JUNG = ['k','o','i','O','j','p','u','P','h','hk','ho','hl','y','n','nj','np','nl','b','m','ml','l'];
var DUBEOLSIK_JONG = ['','r','R','rt','s','sw','sg','e','f','fr','fa','fq','ft','fx','fv','fg','a','q','qt','t','T','d','w','c','z','x','v','g'];
// U+3131..U+3163: the jamo on their own, which is what a half-typed syllable leaves behind.
var DUBEOLSIK_JAMO = ['r','R','rt','s','sw','sg','e','E','f','fr','fa','fq','ft','fx','fv','fg','a','q','Q','qt','t','T','d','w','W','c','z','x','v','g',
  'k','o','i','O','j','p','u','P','h','hk','ho','hl','y','n','nj','np','nl','b','m','ml','l'];
function qwertyFromHangul(text) {
  var out = '';
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i);
    if (code >= 0xac00 && code <= 0xd7a3) {
      var n = code - 0xac00;
      out += DUBEOLSIK_CHO[Math.floor(n / 588)] + DUBEOLSIK_JUNG[Math.floor((n % 588) / 28)] + DUBEOLSIK_JONG[n % 28];
    } else if (code >= 0x3131 && code <= 0x3163) {
      out += DUBEOLSIK_JAMO[code - 0x3131];
    } else {
      out += text[i];
    }
  }
  return out.toLowerCase();
}
// The strings a query should be tried as: what was typed, and — when it holds Hangul — the keys that typed it.
function queryVariants(query) {
  if (!/[\uac00-\ud7a3\u3131-\u3163]/.test(query)) return [query];
  var latin = qwertyFromHangul(query);
  return latin === query ? [query] : [query, latin];
}
function quickItemHaystack(item) {
  return (item.path + '\n' + item.name + '\n' + item.detail).toLowerCase();
}
// Rank on the variant that actually matched, so a Korean-typed query is scored like the English one it means.
function matchedQuery(item, queries) {
  var hay = quickItemHaystack(item);
  for (var i = 0; i < queries.length; i += 1) if (hay.indexOf(queries[i]) >= 0) return queries[i];
  return queries[0];
}

function renderQuickOpenResults() {
  if (!quickResults) return;
  // Recent mode filters its own list by the typed speed-search string; other modes use the search box.
  const isRecent = quickMode === 'recent';
  const rawQuery = (isRecent ? recentFilter : (quickInput?.value || '')).trim();
  if (quickMode === 'content') { renderContentSearchResults(rawQuery); return; }
  if (quickMode === 'symbol') { renderWorkspaceSymbolResults(rawQuery); return; }
  if (quickMode === 'structure') { renderFileStructureResults(rawQuery); return; }
  if (quickMode === 'locations') { renderRecentLocationResults(rawQuery); return; }
  if (quickMode === 'hierarchy') { renderHierarchyResults(rawQuery); return; }
  if (quickMode === 'bookmarks') { renderBookmarkResults(rawQuery); return; }
  if (quickMode === 'usages') { renderFindUsagesResults(rawQuery); return; }
  if (quickMode === 'problems') { renderProblemsResults(rawQuery); return; }
  if (quickMode === 'actions') { renderFindActionResults(rawQuery); return; }
  if (!isRecent && !rawQuery) {
    quickItems = [];
    quickActive = 0;
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.typeFileName')) + '</div>';
    renderQuickPreview(null);
    return;
  }
  if (!isRecent && REVIEW_LAZY_LOAD && !projectIndexLoaded) {
    ensureProjectIndex().then(function () {
      if (quickOpen && !quickOpen.classList.contains('hidden') && quickMode === 'all'
        && String(quickInput && quickInput.value || '').trim()) renderQuickOpenResults();
    });
  }
  // `app.ts:42` — the line to land on, written after the file name, as IntelliJ's Go to File accepts it.
  // Stripped before matching (nothing is named "app.ts:42") and carried on a COPY of the item, so the
  // shared index entry does not keep a line number from an earlier search.
  const lineSuffix = /^(.*\S)\s*:(\d+)(?::\d+)?$/.exec(rawQuery);
  const gotoLine = lineSuffix ? Math.max(1, Number(lineSuffix[2])) : 0;
  const query = (lineSuffix ? lineSuffix[1] : rawQuery).toLowerCase();
  const queries = queryVariants(query);
  const candidates = isRecent ? recentItems() : allQuickItems();
  quickItems = candidates
    .filter((item) => {
      if (query.length === 0) return true;
      if (quickMode === 'content') {
        const file = sourceByPath.get(item.path);
        return Boolean(file && file.embedded && file.content.toLowerCase().includes(query));
      }
      const hay = quickItemHaystack(item);
      return queries.some((variant) => hay.includes(variant));
    })
    .sort((a, b) => scoreQuickItem(a, matchedQuery(a, queries)) - scoreQuickItem(b, matchedQuery(b, queries)) || a.path.localeCompare(b.path))
    .slice(0, 80)
    .map((item) => (gotoLine ? Object.assign({}, item, { kind: 'symbol', lineIndex: gotoLine - 1, column: 0 }) : item));
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
  if (quickItems.length === 0) {
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.noFiles')) + '</div>';
    renderQuickPreview(null);
    return;
  }
  quickResults.innerHTML = quickItems.map((item, index) => [
    '<button type="button" class="quick-open-item' + (index === quickActive ? ' active' : '') + '" data-index="' + index + '">',
    '<span class="quick-open-main">',
    '<span class="quick-open-name">' + escapeHtml(item.name) + '</span>',
    '<span class="quick-open-path">' + escapeHtml(item.path) + '</span>',
    // Which module, and whether it is test code — the two things IntelliJ's own Go to File row says
    // besides the name (14-project-layout.js). Inside the main column, where the path it qualifies is.
    projectRowTagsHtml(item.path),
    '</span>',
    // The type as its icon, not as the words "file - kotlin": the row is scanned, not read, and the icon is
    // the same glyph the file tree uses for that type. The words stay as the tooltip.
    '<span class="quick-open-badge' + (item.kind === 'change' ? ' is-changed' : '') + '" title="' + escapeHtml(item.detail) + '">'
      + virtualTypeIcon(item.path) + '</span>',
    '</button>',
  ].join('')).join('');
  renderQuickPreview(quickItems[quickActive]);
}

/**
 * ⌘⌥O every symbol, ⌥O types only — IntelliJ's Go to Symbol and its Go to Class.
 *
 * One mode with a flag rather than two: the list, the debounce and the engine label are identical and the
 * only difference is a word in the title and a filter main applies. (The filter is main's because the two
 * engines spell a kind differently — see isTypeLocation in analysis.ts.)
 */
function openWorkspaceSymbols(typesOnly) {
  workspaceSymbolTypesOnly = typesOnly === true;
  workspaceSymbolQuery = '\0';
  openQuickOpen('symbol');
}

function renderWorkspaceSymbolResults(query) {
  if (query !== workspaceSymbolQuery) {
    workspaceSymbolQuery = query;
    workspaceSymbolSeq += 1;
    if (workspaceSymbolTimer) clearTimeout(workspaceSymbolTimer);
    workspaceSymbolItems = [];
    workspaceSymbolBusy = true;
    var seq = workspaceSymbolSeq;
    workspaceSymbolTimer = setTimeout(function () { runWorkspaceSymbolSearch(query, seq); }, 80);
  }
  quickItems = workspaceSymbolItems;
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
  if (quickFilterEl) {
    quickFilterEl.className = 'quick-open-filter' + (workspaceSymbolBusy ? ' is-loading' : '');
    quickFilterEl.innerHTML = workspaceSymbolBusy
      ? kakapoLoaderHtml('kakapo-loader-micro') + '<span>' + escapeHtml(t('quickopen.searching')) + '</span>'
      : escapeHtml(String(quickItems.length) + ' ' + t('quickopen.results') + ' · ' + workspaceSymbolEngine);
  }
  if (workspaceSymbolBusy) {
    quickResults.innerHTML = loadingStateHtml(t('quickopen.searching'), 'quick-open-empty');
    renderQuickPreview(null);
    return;
  }
  if (!quickItems.length) {
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.noMatches')) + '</div>';
    renderQuickPreview(null);
    return;
  }
  quickResults.innerHTML = quickItems.map(function (item, index) {
    return '<button type="button" class="quick-open-item symbol-result' + (index === quickActive ? ' active' : '') + '" data-index="' + index + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + escapeHtml(item.name) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '</span>'
      + projectRowTagsHtml(item.path) + '</span>'
      + '<span class="quick-open-badge">' + escapeHtml(item.detail) + '</span></button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

async function runWorkspaceSymbolSearch(query, seq) {
  var loc = caretSourceLoc() || { path: sourceFiles[0] && sourceFiles[0].path, lineIndex: 0, column: 0 };
  var response = await queryProjectAnalysis('workspaceSymbol', null, loc, { query: query, limit: 200, types: workspaceSymbolTypesOnly });
  if (seq !== workspaceSymbolSeq || quickMode !== 'symbol' || query !== String(quickInput && quickInput.value || '').trim()) return;
  workspaceSymbolItems = response && Array.isArray(response.locations) ? response.locations.map(function (item) {
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
  // A declined search is not an empty project. Said in the label beside the count, because "0 results"
  // with no reason is how a reviewer concludes the symbol does not exist.
  workspaceSymbolEngine = revisionDecline(response) !== null
    ? t('quickopen.revisionOff')
    : response && response.engine === 'lsp' ? (response.server || 'LSP') : 'index';
  workspaceSymbolBusy = false;
  quickActive = 0;
  renderWorkspaceSymbolResults(query);
}

/**
 * IntelliJ's file mask, as typed: a comma-separated list of globs over the file name, `!` to exclude.
 *
 * The field used to reduce every entry to an extension, so `*Service*.java` matched nothing and `!*.min.js`
 * was dropped silently. The entries pass through now and src/search.ts hands them to ripgrep's own
 * `--glob`, which reads the same spelling including the `!`. A bare `ts` or `.ts` still means `*.ts` —
 * that is what a reviewer typing in this field means, and it is what the field used to accept.
 */
function contentSearchMasks() {
  var seen = new Set();
  return String(quickExtensionInput && quickExtensionInput.value || '')
    .split(/[\s,;]+/)
    .map(function (value) {
      var text = value.trim().toLowerCase();
      var negated = text.charAt(0) === '!';
      var body = negated ? text.slice(1) : text;
      if (body && !body.includes('*') && /^\.?[a-z0-9][a-z0-9._+-]*$/.test(body)) body = '*.' + body.replace(/^\./, '');
      return (negated ? '!' : '') + body;
    })
    .filter(function (value) {
      var body = value.charAt(0) === '!' ? value.slice(1) : value;
      if (!body || body.length > 48 || body.indexOf('/') >= 0 || body.indexOf('..') >= 0 || seen.has(value)) return false;
      if (!/^[a-z0-9*?._+\-\[\]{},]+$/.test(body)) return false;
      seen.add(value);
      return true;
    });
}

/** One mask over a file NAME. `*` and `?` only; ripgrep does the real matching when there is a ripgrep. */
function contentSearchMaskRegExp(mask) {
  var pattern = String(mask)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp('^' + pattern + '$');
}

function contentSearchMaskAllows(path, masks) {
  if (!masks.length) return true;
  var segments = String(path || '').replace(/\\/g, '/').toLowerCase().split('/');
  var name = segments[segments.length - 1] || '';
  var excluded = masks.some(function (mask) {
    return mask.charAt(0) === '!' && contentSearchMaskRegExp(mask.slice(1)).test(name);
  });
  if (excluded) return false;
  var include = masks.filter(function (mask) { return mask.charAt(0) !== '!'; });
  return !include.length || include.some(function (mask) { return contentSearchMaskRegExp(mask).test(name); });
}
function contentSearchPathAllowed(path, masks, excludeNoise) {
  var normalized = String(path || '').replace(/\\/g, '/').toLowerCase();
  if (!contentSearchMaskAllows(normalized, masks || [])) return false;
  if (!excludeNoise) return true;
  var segments = normalized.split('/');
  var name = segments[segments.length - 1] || '';
  return !segments.some(function (segment) { return segment === 'test' || segment === 'tests' || segment === '__tests__'; })
    && !/(^test_.*|_test\.[^.]+$|\.(test|spec)\.[^.]+$)/.test(name);
}
// IntelliJ's Find in Files scope dropdown, minus the scopes this app has no answer for: it indexes no
// library sources, and every file in a review is a project file, so "All Places" and "Project Files" are
// the same list. "Changed files" is this app's own — the review IS a change, and "only where something
// moved" is the scope a reviewer asks for that IntelliJ has no name for.
var CONTENT_SEARCH_SCOPES = ['all', 'production', 'tests', 'module', 'changed'];

/** Whether `path` is in the chosen scope. The exact rule — the globs sent with the query only narrow. */
function contentSearchScopeAllows(path, scope) {
  if (!scope || scope === 'all') return true;
  if (scope === 'production') return projectScopeOf(path) === 'production';
  if (scope === 'tests') return projectScopeOf(path) === 'test';
  if (scope === 'module') {
    var module = projectCurrentModule();
    return !module || projectModuleName(path) === module;
  }
  if (scope === 'changed') {
    var file = sourceByPath.get(path);
    return Boolean(file && file.changed);
  }
  return true;
}

function contentSearchLineIsComment(item) {
  var text = String(item && item.text || '');
  var path = String(item && item.path || '').toLowerCase();
  var column = Math.max(0, Number(item && item.column) || 0);
  var trimmed = text.trimStart();
  if (/^(\/\/|\/\*|\*|#|--|;|<!--)/.test(trimmed)) return true;
  var markers = /\.(py|pyi|rb|sh|bash|zsh|fish|ya?ml|toml|ini|conf)$/i.test(path)
    ? ['#']
    : /\.(sql|lua)$/i.test(path) ? ['--'] : ['//', '/*'];
  return markers.some(function (marker) {
    var at = text.indexOf(marker);
    return at >= 0 && at < column;
  });
}
function contentSearchItemAllowed(item, filters) {
  return contentSearchPathAllowed(item && item.path, filters.masks, filters.excludeNoise)
    && contentSearchScopeAllows(item && item.path, filters.scope)
    && (!filters.excludeNoise || !contentSearchLineIsComment(item));
}
function currentContentSearchFilters() {
  return {
    masks: contentSearchMasks(),
    excludeNoise: contentSearchExcludeNoise,
    matchCase: contentSearchMatchCase,
    wholeWords: contentSearchWholeWords,
    regex: contentSearchRegex,
    scope: contentSearchScope,
  };
}
function contentSearchRequestKey(query, filters) {
  return JSON.stringify([query, filters.masks, filters.excludeNoise,
    filters.matchCase, filters.wholeWords, filters.regex, filters.scope, projectCurrentModule()]);
}
function syncContentSearchControls() {
  syncContentSearchScope();
  if (quickExcludeNoiseButton) {
    var excluding = quickMode === 'usages' ? usageViewHideNoise : contentSearchExcludeNoise;
    quickExcludeNoiseButton.setAttribute('aria-pressed', excluding ? 'true' : 'false');
    quickExcludeNoiseButton.classList.toggle('active', excluding);
  }
  [[quickMatchCaseButton, contentSearchMatchCase], [quickWholeWordsButton, contentSearchWholeWords],
    [quickRegexButton, contentSearchRegex]].forEach(function (pair) {
    if (!pair[0]) return;
    pair[0].setAttribute('aria-pressed', pair[1] ? 'true' : 'false');
    pair[0].classList.toggle('active', pair[1]);
  });
}
/** The scope select's options and selection. Rebuilt rather than patched: one of them carries a name. */
function syncContentSearchScope() {
  if (!quickScopeSelect) return;
  var module = projectCurrentModule();
  var offered = CONTENT_SEARCH_SCOPES.filter(function (scope) {
    // A module scope with no module to name is not a scope. Neither is one in a single-module repo,
    // where it would be the whole project under another name.
    return scope !== 'module' || (module && projectHasModules());
  });
  if (offered.indexOf(contentSearchScope) < 0) contentSearchScope = 'all';
  quickScopeSelect.innerHTML = offered.map(function (scope) {
    var label = scope === 'module' ? t('scope.module').replace('{name}', module) : t('scope.' + scope);
    return '<option value="' + escapeHtml(scope) + '">' + escapeHtml(label) + '</option>';
  }).join('');
  quickScopeSelect.value = contentSearchScope;
}

/** ⌥S, and the select itself: the next scope round. Restarts the search — the answer changes with it. */
function setContentSearchScope(scope) {
  if (CONTENT_SEARCH_SCOPES.indexOf(scope) < 0) return false;
  contentSearchScope = scope;
  syncContentSearchScope();
  restartContentSearch();
  return true;
}

document.getElementById('quick-open-scope')?.addEventListener('change', function (event) {
  setContentSearchScope(String(event.target && event.target.value || 'all'));
  if (quickInput) quickInput.focus();
});

function cycleContentSearchScope() {
  if (!quickScopeSelect) return false;
  var offered = Array.prototype.map.call(quickScopeSelect.options, function (option) { return option.value; });
  if (!offered.length) return false;
  var at = offered.indexOf(contentSearchScope);
  return setContentSearchScope(offered[(at + 1) % offered.length]);
}

/** One of the three modifiers, by the flag's name. Restarts the search: the answer changes with it. */
function toggleContentSearchModifier(which) {
  if (which === 'matchCase') contentSearchMatchCase = !contentSearchMatchCase;
  else if (which === 'wholeWords') contentSearchWholeWords = !contentSearchWholeWords;
  else if (which === 'regex') contentSearchRegex = !contentSearchRegex;
  else return false;
  syncContentSearchControls();
  restartContentSearch();
  return true;
}
/**
 * The message for a pattern that cannot be compiled, or '' when it can.
 *
 * Checked in the page, before anything is asked, because both searchers would otherwise answer "nothing
 * matched" — ripgrep by exiting 2, and the in-page fallback by having nothing to run. "No results" for a
 * typo in a pattern is the wrong answer, and it is the one a reviewer would believe.
 */
function contentSearchPatternError(query) {
  if (!contentSearchRegex || !query) return '';
  try { new RegExp(query); return ''; } catch (error) { return String(error && error.message || error); }
}
function restartContentSearch() {
  contentSearchQuery = '\0';
  if (quickMode === 'content') renderQuickOpenResults();
}
function focusContentSearchExtensions() {
  if (!quickExtensionInput) return;
  quickExtensionInput.focus();
  quickExtensionInput.select();
}
function toggleContentSearchNoise() {
  contentSearchExcludeNoise = !contentSearchExcludeNoise;
  syncContentSearchControls();
  restartContentSearch();
}

function renderContentSearchResults(query) {
  var filters = currentContentSearchFilters();
  var patternError = contentSearchPatternError(query);
  if (patternError) {
    contentSearchQuery = '';
    contentSearchSeq += 1; // an answer already in flight is for a query that is no longer being asked
    if (contentSearchTimer) clearTimeout(contentSearchTimer);
    contentSearchBusy = false;
    contentSearchItems = [];
    quickItems = [];
    updateContentSearchStatus(query);
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.badPattern'))
      + '<span class="quick-open-why">' + escapeHtml(patternError) + '</span></div>';
    renderQuickPreview(null);
    return;
  }
  var requestKey = contentSearchRequestKey(query, filters);
  if (requestKey !== contentSearchQuery) {
    contentSearchQuery = requestKey;
    contentSearchSeq += 1;
    if (contentSearchTimer) clearTimeout(contentSearchTimer);
    contentSearchItems = [];
    contentSearchTruncated = false;
    contentSearchBusy = Boolean(query);
    if (query) {
      const seq = contentSearchSeq;
      contentSearchTimer = setTimeout(function () { runContentSearch(query, seq, filters, requestKey); }, 120);
    }
  }

  quickItems = contentSearchItems;
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
  updateContentSearchStatus(query);
  if (!query) {
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.typeToSearch')) + '</div>';
    renderQuickPreview(null);
    return;
  }
  if (contentSearchBusy) {
    quickResults.innerHTML = loadingStateHtml(t('quickopen.searching'), 'quick-open-empty');
    renderQuickPreview(null);
    return;
  }
  if (!quickItems.length) {
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.noMatches')) + '</div>';
    renderQuickPreview(null);
    return;
  }
  quickResults.innerHTML = quickItems.map(function (item, index) {
    return '<button type="button" class="quick-open-item search-result' + (index === quickActive ? ' active' : '') + '" data-index="' + index + '">'
      + '<span class="quick-open-main">'
      + '<span class="quick-open-name">' + escapeHtml(baseName(item.path) + ':' + (item.lineIndex + 1) + ':' + (item.column + 1)) + '</span>'
      + '<span class="quick-open-path search-snippet">' + searchSnippetHtml(item) + '</span>'
      + projectRowTagsHtml(item.path)
      + '</span>'
      + '<span class="quick-open-badge">' + escapeHtml(item.path) + '</span>'
      + '</button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

function updateContentSearchStatus(query) {
  if (!quickFilterEl) return;
  quickFilterEl.className = 'quick-open-filter';
  if (!query) { quickFilterEl.textContent = ''; quickFilterEl.classList.remove('is-loading'); return; }
  if (contentSearchBusy) {
    quickFilterEl.classList.add('is-loading');
    quickFilterEl.innerHTML = kakapoLoaderHtml('kakapo-loader-micro') + '<span>' + escapeHtml(t('quickopen.searching')) + '</span>';
    return;
  }
  quickFilterEl.classList.remove('is-loading');
  quickFilterEl.textContent = String(contentSearchItems.length) + (contentSearchTruncated ? '+' : '') + ' ' + t('quickopen.results') + ' · ' + contentSearchEngine;
}

async function runContentSearch(query, seq, filters, requestKey) {
  var response = null;
  try {
    if (window.kakapoSearch && typeof window.kakapoSearch.query === 'function') {
      var request = { query: query, limit: 500 };
      if (filters.masks.length) request.masks = filters.masks;
      if (filters.excludeNoise) request.excludeCommentsAndTests = true;
      if (filters.matchCase) request.matchCase = true;
      if (filters.wholeWords) request.wholeWords = true;
      if (filters.regex) request.regex = true;
      var prefixes = projectScopePrefixes(filters.scope);
      if (prefixes.include.length) request.includePaths = prefixes.include;
      if (prefixes.exclude.length) request.excludePaths = prefixes.exclude;
      response = await window.kakapoSearch.query(request);
    }
  } catch (e) { response = null; }
  if (seq !== contentSearchSeq || quickMode !== 'content'
    || requestKey !== contentSearchRequestKey(String(quickInput && quickInput.value || '').trim(), currentContentSearchFilters())) return;

  if (response && response.available && Array.isArray(response.matches)) {
    contentSearchItems = response.matches.map(searchItemFromMatch).filter(Boolean).filter(function (item) {
      return contentSearchItemAllowed(item, filters);
    });
    contentSearchTruncated = Boolean(response.truncated);
    contentSearchEngine = response.engine === 'ripgrep' ? 'rg' : 'local';
  } else {
    var localItems = localContentSearch(query, 501, filters);
    contentSearchTruncated = localItems.length > 500;
    contentSearchItems = localItems.slice(0, 500);
    contentSearchEngine = 'local';
  }
  contentSearchBusy = false;
  quickActive = 0;
  renderContentSearchResults(query);
}

function searchItemFromMatch(match) {
  var path = String(match && match.path || '');
  var line = Number(match && match.line);
  var column = Number(match && match.column);
  var endColumn = Number(match && match.endColumn);
  if (!path || !Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) return null;
  return {
    path: path,
    name: baseName(path),
    detail: line + ':' + column,
    kind: 'search',
    recent: false,
    lineIndex: line - 1,
    column: column - 1,
    endColumn: Math.max(column, endColumn || column) - 1,
    text: String(match.text || ''),
    matchText: String(match.matchText || ''),
  };
}

/**
 * One compiled matcher for the in-page searcher, honouring the same three modifiers ripgrep is given.
 *
 * Case: `Cc` off keeps this app's long-standing smart-case behaviour (a lower-case query ignores case, a
 * query with a capital in it does not), which is what `--smart-case` means on the other side.
 * Returns null when the pattern cannot be compiled — the caller has already said so by then.
 */
function localContentSearchMatcher(query, filters) {
  var source = filters.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (filters.wholeWords) source = '\\b(?:' + source + ')\\b';
  var insensitive = filters.matchCase ? false : !/[A-Z]/.test(query);
  try { return new RegExp(source, insensitive ? 'gi' : 'g'); } catch (e) { return null; }
}

function localContentSearch(query, limit, filters) {
  filters = filters || { masks: [], excludeNoise: false };
  var pattern = localContentSearchMatcher(query, filters);
  if (!pattern) return [];
  var out = [];
  for (var fi = 0; fi < sourceFiles.length && out.length < limit; fi++) {
    var file = sourceFiles[fi];
    if (!file.embedded || !contentSearchPathAllowed(file.path, filters.masks, filters.excludeNoise)) continue;
    if (!contentSearchScopeAllows(file.path, filters.scope)) continue;
    var lines = String(file.content || '').split(/\r?\n/);
    for (var li = 0; li < lines.length && out.length < limit; li++) {
      var line = lines[li];
      pattern.lastIndex = 0;
      var match = null;
      while (out.length < limit && (match = pattern.exec(line))) {
        var at = match.index;
        var hit = match[0];
        // A pattern that can match nothing (`a*`) would otherwise never advance.
        pattern.lastIndex = at + Math.max(hit.length, 1);
        if (!hit.length) continue;
        var item = { path: file.path, name: file.name, detail: (li + 1) + ':' + (at + 1), kind: 'search', recent: false, lineIndex: li, column: at, endColumn: at + hit.length, text: line, matchText: hit };
        if (contentSearchItemAllowed(item, filters)) out.push(item);
      }
    }
  }
  return out;
}

function searchSnippetHtml(item) {
  var text = String(item.text || '');
  var start = Math.max(0, Math.min(Number(item.column) || 0, text.length));
  var end = Math.max(start, Math.min(Number(item.endColumn) || start + String(item.matchText || '').length, text.length));
  var cropStart = Math.max(0, start - 80);
  var cropEnd = Math.min(text.length, Math.max(end + 100, cropStart + 220));
  if (cropEnd - cropStart > 240) cropEnd = cropStart + 240;
  var prefix = cropStart > 0 ? '…' : '';
  var suffix = cropEnd < text.length ? '…' : '';
  return escapeHtml(prefix + text.slice(cropStart, start))
    + '<mark class="search-hit">' + escapeHtml(text.slice(start, end) || String(item.matchText || '')) + '</mark>'
    + escapeHtml(text.slice(end, cropEnd) + suffix);
}

function updateQuickActive() {
  quickResults?.querySelectorAll('.quick-open-item').forEach((element, index) => {
    const active = index === quickActive;
    element.classList.toggle('active', active);
    if (active) element.scrollIntoView({ block: 'nearest' });
  });
  renderQuickPreview(quickItems[quickActive]);
}

function renderQuickPreview(item) {
  const preview = document.getElementById('quick-open-preview');
  if (!preview) return;
  const previewSeq = ++quickPreviewSeq;
  quickPreviewState = null;
  if (!item) { preview.innerHTML = ''; return; }
  const file = sourceByPath.get(item.path);
  if (!file || !file.embedded) {
    preview.innerHTML = item.kind === 'search'
      ? '<div class="qp-head">' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '</div><div class="qp-empty">' + searchSnippetHtml(item) + '</div>'
      : '<div class="qp-empty">' + escapeHtml(item.path) + '</div>';
    return;
  }
  if (!sourceContentLoaded(file)) {
    preview.innerHTML = '<div class="qp-head">' + escapeHtml(item.path) + '</div>'
      + loadingStateHtml(t('source.loading'), 'qp-empty');
    loadSourceFile(item.path).then(function (loaded) {
      if (previewSeq !== quickPreviewSeq || !quickOpen || quickOpen.classList.contains('hidden')) return;
      var activeItem = quickItems[quickActive];
      if (!activeItem || activeItem.path !== item.path) return;
      if (!loaded || !sourceContentLoaded(loaded)) {
        preview.innerHTML = '<div class="qp-head">' + escapeHtml(item.path) + '</div>'
          + '<div class="qp-empty">' + escapeHtml(t('source.previewUnavailable')) + '</div>';
        return;
      }
      renderQuickPreview(item);
    });
    return;
  }
  const query = ((quickInput && quickInput.value) || '').trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  const focusLine = item.kind === 'search' || item.kind === 'symbol' ? item.lineIndex : -1;
  const firstLine = focusLine >= 0 ? Math.max(0, focusLine - QUICK_PREVIEW_RADIUS) : 0;
  const lastLine = focusLine >= 0
    ? Math.min(lines.length, focusLine + QUICK_PREVIEW_RADIUS + 1)
    : Math.min(lines.length, QUICK_PREVIEW_CHUNK);
  quickPreviewState = {
    seq: previewSeq,
    path: item.path,
    language: file.language || 'text',
    lines: lines,
    query: query,
    focusLine: focusLine,
    focusColumn: item.kind === 'search' ? Math.max(0, Number(item.column) || 0) : -1,
    focusEndColumn: item.kind === 'search' ? Math.max(0, Number(item.endColumn) || 0) : -1,
    matchText: item.kind === 'search' ? String(item.matchText || '') : '',
    start: firstLine,
    end: lastLine,
  };
  paintQuickPreviewWindow(preview, quickPreviewState, 'focus');
}

function quickPreviewCodeHtml(line, state, lineIndex) {
  if (lineIndex !== state.focusLine || state.focusColumn < 0) return highlightLine(line, state.language);
  var start = Math.min(line.length, state.focusColumn);
  var end = Math.min(line.length, Math.max(start, state.focusEndColumn));
  if (end <= start) {
    var fallback = state.matchText || state.query;
    var at = fallback ? line.toLowerCase().indexOf(fallback.toLowerCase()) : -1;
    if (at >= 0) { start = at; end = at + fallback.length; }
  }
  if (end <= start) return highlightLine(line, state.language);
  return highlightLine(line.slice(0, start), state.language)
    + '<mark class="search-hit qp-search-hit">' + highlightLine(line.slice(start, end), state.language) + '</mark>'
    + highlightLine(line.slice(end), state.language);
}

function paintQuickPreviewWindow(preview, state, scrollMode) {
  if (!preview || !state || state !== quickPreviewState) return;
  const oldTop = preview.scrollTop;
  const oldHeight = preview.scrollHeight;
  let firstHit = -1;
  const rows = state.lines.slice(state.start, state.end).map((line, offset) => {
    const i = state.start + offset;
    const hit = state.focusLine >= 0 ? i === state.focusLine : state.query.length > 0 && line.toLowerCase().includes(state.query);
    if (hit && firstHit < 0) firstHit = i;
    return '<div class="qp-line' + (hit ? ' qp-hit' : '') + '" data-line-index="' + i + '"><span class="qp-num">' + (i + 1) + '</span><span class="qp-code">' + quickPreviewCodeHtml(line, state, i) + '</span></div>';
  }).join('');
  preview.innerHTML = '<div class="qp-head">' + escapeHtml(state.path) + '</div><div class="qp-body">' + rows + '</div>';
  if (scrollMode === 'prepend') {
    preview.scrollTop = oldTop + Math.max(0, preview.scrollHeight - oldHeight);
  } else if (scrollMode === 'preserve') {
    preview.scrollTop = oldTop;
  } else if (scrollMode === 'focus' && firstHit >= 0) {
    requestAnimationFrame(function () {
      if (state !== quickPreviewState || !preview.isConnected) return;
      const target = preview.querySelector('.qp-line[data-line-index="' + firstHit + '"]');
      if (!target || !preview.clientHeight) return;
      const head = preview.querySelector('.qp-head');
      const headHeight = head ? head.offsetHeight : 0;
      const available = Math.max(0, preview.clientHeight - headHeight - target.offsetHeight);
      const previewRect = preview.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      if (targetRect.height || targetRect.top !== previewRect.top) {
        preview.scrollTop = Math.max(0, preview.scrollTop + targetRect.top - previewRect.top - headHeight - available / 2);
      } else {
        preview.scrollTop = Math.max(0, target.offsetTop - headHeight - available / 2);
      }
    });
  }
}

function handleQuickPreviewScroll(event) {
  const preview = event.currentTarget;
  if (!quickPreviewState || !preview || quickPreviewScrollFrame) return;
  quickPreviewScrollFrame = requestAnimationFrame(function () {
    quickPreviewScrollFrame = 0;
    const state = quickPreviewState;
    if (!state || !preview.isConnected || preview.scrollHeight <= preview.clientHeight) return;
    const nearTop = preview.scrollTop <= 56 && state.start > 0;
    const nearBottom = preview.scrollTop + preview.clientHeight >= preview.scrollHeight - 72
      && state.end < state.lines.length;
    if (!nearTop && !nearBottom) return;
    if (nearTop) state.start = Math.max(0, state.start - QUICK_PREVIEW_CHUNK);
    if (nearBottom) state.end = Math.min(state.lines.length, state.end + QUICK_PREVIEW_CHUNK);
    paintQuickPreviewWindow(preview, state, nearTop ? 'prepend' : 'preserve');
  });
}

document.getElementById('quick-open-preview')?.addEventListener('scroll', handleQuickPreviewScroll, { passive: true });

function openQuickItem(item) {
  if (!item) return;
  // An action is not a place: running it is the whole point, and it has no path to open.
  if (runFindActionItem(item)) return;
  // A recent location is a position (which pane, which side, which line), not a file — restoring it is a
  // different act from opening its path.
  if (openRecentLocationItem(item)) return;
  closeQuickOpen();
  rememberRecent(item.path, item.kind);
  if ((item.kind === 'search' || item.kind === 'symbol') && sourceByPath.has(item.path)) {
    var searchFile = sourceByPath.get(item.path);
    if (searchFile && searchFile.embedded) openSourceAt(item.path, item.lineIndex, item.column);
    else openSourceFile(item.path);
    return;
  }
  if (sourceByPath.has(item.path)) {
    openSourceFile(item.path);
    return;
  }
  const link = links.find((candidate) => candidate.dataset.file === item.path);
  if (!link) return;
  const target = diffHunkForLink(link);
  if (target >= 0) {
    setActive(target);
  } else if (activateDiffFile(item.path, true)) {
    // Was a scroll to the file's anchor, which left the sidebar and breadcrumb pointing elsewhere.
  } else {
    showDiffView(false);
    const targetId = link.getAttribute('href')?.slice(1);
    if (targetId) document.getElementById(targetId)?.scrollIntoView({ block: 'center' });
  }
}

function allQuickItems() {
  const items = sourceFiles.map((file) => ({
    path: file.path,
    name: baseName(file.path),
    detail: [file.changed ? 'changed' : 'file', file.language || 'text'].join(' - '),
    kind: 'source',
    recent: false,
  }));
  links.forEach((link) => {
    const path = link.dataset.file || '';
    if (!path || sourceByPath.has(path)) return;
    items.push({ path, name: baseName(path), detail: 'diff', kind: 'change', recent: false });
  });
  const recent = loadRecent();
  const recentRank = new Map(recent.map((item, index) => [item.path, index]));
  return items.map((item) => ({
    ...item,
    recent: recentRank.has(item.path),
    recentRank: recentRank.get(item.path) ?? 9999,
  }));
}

function recentItems() {
  const all = allQuickItems();
  const byPath = new Map(all.map((item) => [item.path, item]));
  // A stored path the project does not have cannot be opened — a file since deleted or renamed, or (before
  // core.quotePath was turned off) a git-escaped name that never existed on disk. Those rows do nothing when
  // picked, so drop them. Only once the index is complete: until then `all` is partial and every row would go.
  const indexReady = !REVIEW_LAZY_LOAD || projectIndexLoaded;
  const items = loadRecent()
    .filter((item) => !indexReady || byPath.has(item.path))
    .map((item) => byPath.get(item.path) || {
      path: item.path,
      name: baseName(item.path),
      detail: item.kind === 'change' ? 'diff' : 'file',
      kind: item.kind,
      recent: true,
      recentRank: 0,
    })
    .map((item, index) => ({ ...item, recent: true, recentRank: index }));
  return items;
}

function scoreQuickItem(item, query) {
  let score = item.recentRank ?? 9999;
  if (!query) return score;
  const path = item.path.toLowerCase();
  const name = item.name.toLowerCase();
  if (name === query) score -= 3000;
  else if (name.startsWith(query)) score -= 2000;
  else if (path.includes('/' + query)) score -= 1000;
  else if (path.includes(query)) score -= 500;
  if (item.recent) score -= 100;
  return score;
}

function loadRecent() {
  try {
    var stored = persistRead(recentKey);
    const value = Array.isArray(stored) ? stored : JSON.parse(localStorage.getItem(recentKey) || '[]');
    return Array.isArray(value) ? value.filter((item) => item && typeof item.path === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecent(path, kind) {
  if (!path) return;
  const next = [{ path, kind }, ...loadRecent().filter((item) => item.path !== path)].slice(0, 30);
  persistSave(recentKey, next);
}

function baseName(path) {
  return String(path).split('/').filter(Boolean).pop() || String(path);
}

// A tree row is navigable only when it is actually visible — i.e. not tucked inside a collapsed
// <details> folder. getClientRects alone is unreliable here: Chromium keeps collapsed <details>
// content laid out (content-visibility), so its descendants still report rects. Walk the ancestor
// <details> and treat anything inside a closed one (other than its own summary) as hidden.
