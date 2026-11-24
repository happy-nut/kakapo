var quickPreviewSeq = 0;
var quickPreviewState = null;
var quickPreviewScrollFrame = 0;
var QUICK_PREVIEW_RADIUS = 60;
var QUICK_PREVIEW_CHUNK = 120;

claimsMenuChords('quick-open', function () {
  return !!quickOpen && !quickOpen.classList.contains('hidden');
});
function syncQuickOpenEditKeys() { syncMenuChords(); }
var QUICK_LAUNCHER_MODES = ['everywhere', 'recent', 'all', 'content', 'symbol', 'actions'];
function paintQuickOpenMode() {
  if (!quickInput || !quickModeLabel) return;
  quickModeLabel.textContent = quickMode === 'everywhere'
    ? t('quickopen.everywhere')
    : quickMode === 'recent'
    ? t('quickopen.recent')
    : quickMode === 'content'
      ? t('quickopen.findInFiles')
      : quickMode === 'symbol'
        ? t(workspaceSymbolTypesOnly ? 'quickopen.goToClass' : 'quickopen.workspaceSymbols')
        : quickMode === 'structure'
          ? t('structure.title')
          : quickMode === 'locations'
            ? t('locations.title')
            : quickMode === 'hierarchy'
              ? t('hierarchy.title')
              : quickMode === 'bookmarks'
                ? t('bookmark.title')
                : quickMode === 'usages'
                  ? t('findusages.title').replace('{name}', usageViewName)
                  : quickMode === 'problems'
                    ? t('problems.title')
                    : quickMode === 'endpoints'
                      ? t('endpoints.title')
                      : quickMode === 'actions'
                        ? t('actions.title')
                        : t('quickopen.searchFiles');
  var quickPlaceholder = quickMode === 'everywhere'
    ? t('quickopen.everywherePlaceholder')
    : quickMode === 'symbol'
    ? t(workspaceSymbolTypesOnly ? 'quickopen.goToClass' : 'quickopen.workspaceSymbols')
    : quickMode === 'content'
      ? t('quickopen.findInFiles')
      : quickMode === 'structure'
        ? t('structure.placeholder')
        : quickMode === 'locations'
          ? t('locations.placeholder')
          : quickMode === 'hierarchy'
            ? t('hierarchy.placeholder')
            : quickMode === 'bookmarks'
              ? t('bookmark.placeholder')
              : quickMode === 'usages'
                ? t('findusages.placeholder')
                : quickMode === 'problems'
                  ? t('problems.placeholder')
                  : quickMode === 'endpoints'
                    ? t('endpoints.placeholder')
                    : quickMode === 'actions'
                      ? t('actions.placeholder')
                      : t('quickopen.searchFiles');
  quickInput.setAttribute('placeholder', quickPlaceholder === quickModeLabel.textContent ? '' : quickPlaceholder);
}

function openQuickOpen(mode, hideRail) {
  if (!quickOpen || !quickInput || !quickModeLabel) return;
  closeCompareMenu();
  closeSemanticPeek();
  closeQuickDoc();
  rememberOverlayFocus(quickOpen);
  quickMode = mode;
  paintQuickOpenMode();
  quickOpen.classList.remove('hidden');
  quickOpen.classList.toggle('quick-recent', mode === 'recent');
  quickOpen.classList.toggle('quick-content', mode === 'content');
  quickOpen.classList.toggle('quick-usages', mode === 'usages');
  quickOpen.classList.toggle('quick-launcher', !hideRail && QUICK_LAUNCHER_MODES.indexOf(mode) >= 0);
  syncQuickLauncherRail();
  syncContentSearchControls();
  recentFilter = '';
  quickInput.value = '';
  updateRecentFilterDisplay();
  renderQuickOpenResults();
  if (mode === 'recent') { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); syncQuickOpenEditKeys(); }
  else setTimeout(() => { quickInput.focus(); syncQuickOpenEditKeys(); }, 0);
}

function syncQuickLauncherRail() {
  document.querySelectorAll('#quick-open-side .quick-open-side-item').forEach(function (item) {
    item.classList.toggle('active', quickLauncherSectionActive(item.dataset.section));
  });
}

document.getElementById('quick-open-side')?.addEventListener('click', function (event) {
  var button = event.target.closest && event.target.closest('.quick-open-side-item');
  if (!button) return;
  var section = button.dataset.section;
  if (switchQuickLauncherSection(section)) return;
  closeQuickOpen(true);
  if (button.blur) button.blur();
  if (section === 'history') openHistory();
});
function updateRecentFilterDisplay() {
  if (!quickFilterEl) return;
  if (quickMode !== 'recent') { quickFilterEl.textContent = ''; quickFilterEl.className = 'quick-open-filter'; return; }
  if (recentFilter) { quickFilterEl.textContent = recentFilter; quickFilterEl.className = 'quick-open-filter has-filter'; }
  else { quickFilterEl.textContent = t('quickopen.typeToFilter'); quickFilterEl.className = 'quick-open-filter is-hint'; }
}

function closeQuickOpen(navigating) {
  syncMenuChords();
  var wasOpen = !!(quickOpen && !quickOpen.classList.contains('hidden'));
  var focused = document.activeElement;
  if (focused && quickOpen && quickOpen.contains(focused) && focused.blur) focused.blur();
  quickOpen?.classList.add('hidden');
  restoreOverlayFocus(quickOpen, wasOpen && !navigating);
  quickPreviewState = null;
  if (quickPreviewScrollFrame) cancelAnimationFrame(quickPreviewScrollFrame);
  quickPreviewScrollFrame = 0;
}

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

document.addEventListener('mousedown', function (event) {
  if (!quickOpen || quickOpen.classList.contains('hidden')) return;
  if (event.target && event.target.closest && event.target.closest('.quick-open-panel')) return;
  closeQuickOpen();
}, true);

quickOpen?.addEventListener('keydown', function (event) {
  if (quickOpen.classList.contains('hidden')) return;
  if (handleQuickLauncherTabKey(event)) return;
  trapTabWithin(quickOpen, event);
});

document.addEventListener('focusin', function () { if (quickOpen && !quickOpen.classList.contains('hidden')) syncQuickOpenEditKeys(); });
document.addEventListener('focusout', function () {
  if (!quickOpen || quickOpen.classList.contains('hidden')) return;
  setTimeout(syncQuickOpenEditKeys, 0); // after the browser has settled on the next focus target
});

function handleQuickOpenKey(event) {
  if (handleHierarchyKey(event)) return true;
  if (handleUsageViewKey(event)) return true;
  if (handleProblemsKey(event)) return true;
  if (handleEndpointsKey(event)) return true;
  if (handleQuickLauncherTabKey(event)) return true;
  var railItems = quickSideItems();
  for (var ri = 0; ri < railItems.length; ri += 1) {
    var railId = (railItems[ri].getAttribute('data-keyhint-id') || '').split(':')[0];
    if (!railId || !isShortcut(event, railId)) continue;
    event.preventDefault();
    if (!quickLauncherSectionActive(railItems[ri].dataset.section)) railItems[ri].click();
    else if (!toggleSeEverywhere()) closeQuickOpen();
    return true;
  }
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
  if (event.key === 'Escape') {
    event.preventDefault();
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
function queryVariants(query) {
  if (!/[\uac00-\ud7a3\u3131-\u3163]/.test(query)) return [query];
  var latin = qwertyFromHangul(query);
  return latin === query ? [query] : [query, latin];
}
function quickItemHaystack(item) {
  return [item.name, item.path, item.detail];
}
function matchesQueryVariants(hay, queries) {
  return minusculeMatchesQuery(hay, queries);
}

function quickTypedQuery() {
  var raw = quickMode === 'recent' ? recentFilter : ((quickInput && quickInput.value) || '');
  return String(raw || '').trim();
}

function quickNameHtml(name) {
  var text = String(name == null ? '' : name);
  var query = quickTypedQuery();
  if (!text || !query) return escapeHtml(text);
  var ranges = minusculeQueryRanges(text, queryVariants(quickLineAndColumn(query).name));
  if (!ranges.length) return escapeHtml(text);
  var out = '';
  var at = 0;
  for (var i = 0; i < ranges.length; i += 1) {
    var range = ranges[i];
    if (range.start < at) continue;
    out += escapeHtml(text.slice(at, range.start));
    out += '<b class="usage-hit">' + escapeHtml(text.slice(range.start, range.end)) + '</b>';
    at = range.end;
  }
  return out + escapeHtml(text.slice(at));
}

function renderQuickOpenResults() {
  if (!quickResults) return;
  const isRecent = quickMode === 'recent';
  const rawQuery = (isRecent ? recentFilter : (quickInput?.value || '')).trim();
  if (quickMode === 'everywhere') { renderEverywhereResults(rawQuery); return; }
  if (quickMode === 'content') { renderContentSearchResults(rawQuery); return; }
  if (quickMode === 'symbol') { renderWorkspaceSymbolResults(rawQuery); return; }
  if (quickMode === 'structure') { renderFileStructureResults(rawQuery); return; }
  if (quickMode === 'locations') { renderRecentLocationResults(rawQuery); return; }
  if (quickMode === 'hierarchy') { renderHierarchyResults(rawQuery); return; }
  if (quickMode === 'bookmarks') { renderBookmarkResults(rawQuery); return; }
  if (quickMode === 'usages') { renderFindUsagesResults(rawQuery); return; }
  if (quickMode === 'problems') { renderProblemsResults(rawQuery); return; }
  if (quickMode === 'endpoints') { renderEndpointResults(rawQuery); return; }
  if (quickMode === 'actions') { renderFindActionResults(rawQuery); return; }
  if (!isRecent && !rawQuery) {
    quickItems = [];
    quickActive = 0;
    showQuickEmpty(t('quickopen.typeFileName'));
    return;
  }
  if (!isRecent && REVIEW_LAZY_LOAD && !projectIndexLoaded) {
    ensureProjectIndex().then(function () {
      if (quickOpen && !quickOpen.classList.contains('hidden') && quickMode === 'all'
        && String(quickInput && quickInput.value || '').trim()) renderQuickOpenResults();
    });
  }
  const parsedQuery = quickLineAndColumn(rawQuery);
  const gotoLine = parsedQuery.lineIndex >= 0 ? parsedQuery.lineIndex + 1 : 0;
  const query = gotoLine ? parsedQuery.name : rawQuery;
  const lowerQuery = query.toLowerCase();
  const queries = queryVariants(query);
  const candidates = isRecent ? recentItems() : allQuickItems();
  quickItems = candidates
    .filter((item) => {
      if (query.length === 0) return true;
      if (quickMode === 'content') {
        const file = sourceByPath.get(item.path);
        return Boolean(file && file.embedded && file.content.toLowerCase().includes(lowerQuery));
      }
      const hay = quickItemHaystack(item);
      return matchesQueryVariants(hay, queries);
    })
    .map((item) => ({ item, rank: scoreQuickItem(item, queries) }))
    .sort((a, b) => a.rank - b.rank || a.item.path.localeCompare(b.item.path))
    .map((scored) => scored.item)
    .slice(0, 80)
    .map((item) => (gotoLine
      ? Object.assign({}, item, { kind: 'symbol', lineIndex: gotoLine - 1, column: Math.max(0, parsedQuery.column) })
      : item));
  clampQuickActive();
  if (quickItems.length === 0) {
    showQuickEmpty(t('quickopen.noFiles'));
    return;
  }
  quickResults.innerHTML = quickItems.map((item, index) => [
    '<button type="button" class="quick-open-item' + (index === quickActive ? ' active' : '') + '" data-index="' + index + '">',
    '<span class="quick-open-main">',
    '<span class="quick-open-name">' + quickNameHtml(item.name) + '</span>',
    '<span class="quick-open-path">' + escapeHtml(item.path) + '</span>',
    projectRowTagsHtml(item.path),
    '</span>',
    '<span class="quick-open-badge' + (item.kind === 'change' ? ' is-changed' : '') + '" title="' + escapeHtml(item.detail) + '">'
      + virtualTypeIcon(item.path) + '</span>',
    '</button>',
  ].join('')).join('');
  renderQuickPreview(quickItems[quickActive]);
}

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
  clampQuickActive();
  setQuickFilterChip(workspaceSymbolBusy, resultsLabel(quickItems.length) + ' · ' + workspaceSymbolEngine);
  if (workspaceSymbolBusy) {
    showQuickLoading();
    return;
  }
  if (!quickItems.length) {
    showQuickEmpty(t('quickopen.noMatches'));
    return;
  }
  quickResults.innerHTML = quickItems.map(function (item, index) {
    return '<button type="button" class="quick-open-item symbol-result' + (index === quickActive ? ' active' : '') + '" data-index="' + index + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(item.name) + '</span>'
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
  workspaceSymbolEngine = revisionDecline(response) !== null
    ? t('quickopen.revisionOff')
    : response && response.engine === 'lsp' ? (response.server || 'LSP') : 'index';
  workspaceSymbolBusy = false;
  quickActive = 0;
  renderWorkspaceSymbolResults(query);
}

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

function contentSearchMaskMatches(mask, name) {
  var text = String(mask);
  var m = 0;
  var n = 0;
  var star = -1;
  var afterStar = 0;
  while (n < name.length) {
    var ch = m < text.length ? text.charAt(m) : '';
    if (ch === '*') { m += 1; star = m; afterStar = n; }
    else if (ch && (ch === '?' || ch === name.charAt(n))) { m += 1; n += 1; }
    else if (star >= 0) { m = star; afterStar += 1; n = afterStar; }
    else return false;
  }
  while (text.charAt(m) === '*') m += 1;
  return m === text.length;
}

function contentSearchMaskAllows(path, masks) {
  if (!masks.length) return true;
  var segments = String(path || '').replace(/\\/g, '/').toLowerCase().split('/');
  var name = segments[segments.length - 1] || '';
  var excluded = masks.some(function (mask) {
    return mask.charAt(0) === '!' && contentSearchMaskMatches(mask.slice(1), name);
  });
  if (excluded) return false;
  var include = masks.filter(function (mask) { return mask.charAt(0) !== '!'; });
  return !include.length || include.some(function (mask) { return contentSearchMaskMatches(mask, name); });
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
var CONTENT_SEARCH_SCOPES = ['all', 'production', 'tests', 'module', 'changed'];

function contentSearchScopeAllows(path, scope) {
  if (!scope || scope === 'all') return true;
  if (scope === 'production') return projectScopeOf(path) === 'production';
  if (scope === 'tests') return projectScopeOf(path) === 'test';
  if (scope === 'module') {
    var module = projectCurrentModule();
    return !module || projectModuleName(path) === module;
  }
  if (scope === 'changed') return pathIsChanged(path);
  return true;
}

function pathIsChanged(path) {
  var file = sourceByPath.get(path);
  return Boolean(file && file.changed);
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
function syncContentSearchScope() {
  if (!quickScopeSelect) return;
  var module = projectCurrentModule();
  var offered = CONTENT_SEARCH_SCOPES.filter(function (scope) {
    return scope !== 'module' || (module && projectHasModules());
  });
  if (offered.indexOf(contentSearchScope) < 0) contentSearchScope = 'all';
  quickScopeSelect.innerHTML = offered.map(function (scope) {
    var label = scope === 'module' ? t('scope.module').replace('{name}', module) : t('scope.' + scope);
    return '<option value="' + escapeHtml(scope) + '">' + escapeHtml(label) + '</option>';
  }).join('');
  quickScopeSelect.value = contentSearchScope;
}

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

function toggleContentSearchModifier(which) {
  if (which === 'matchCase') contentSearchMatchCase = !contentSearchMatchCase;
  else if (which === 'wholeWords') contentSearchWholeWords = !contentSearchWholeWords;
  else if (which === 'regex') contentSearchRegex = !contentSearchRegex;
  else return false;
  syncContentSearchControls();
  restartContentSearch();
  return true;
}
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
    contentSearchSeq += 1;
    if (contentSearchTimer) clearTimeout(contentSearchTimer);
    contentSearchBusy = false;
    contentSearchItems = [];
    quickItems = [];
    updateContentSearchStatus(query);
    showQuickEmpty(t('quickopen.badPattern'), patternError);
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
  clampQuickActive();
  updateContentSearchStatus(query);
  if (!query) {
    showQuickEmpty(t('quickopen.typeToSearch'));
    return;
  }
  if (contentSearchBusy) {
    showQuickLoading();
    return;
  }
  if (!quickItems.length) {
    showQuickEmpty(t('quickopen.noMatches'));
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
  if (!query) { setQuickFilterChip(false, ''); return; }
  if (contentSearchBusy) { setQuickFilterChip(true, ''); return; }
  setQuickFilterChip(false, resultsLabel(String(contentSearchItems.length) + (contentSearchTruncated ? '+' : ''))
    + ' · ' + contentSearchEngine);
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
  if (!item || !item.path) { preview.innerHTML = ''; return; }
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
  if (runFindActionItem(item)) return;
  if (expandEverywhereMore(item)) return;
  if (openRecentLocationItem(item)) return;
  closeQuickOpen(true);
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

function scoreQuickItem(item, queries) {
  let score = item.recentRank ?? 9999;
  if (!queries.length || !queries.some(Boolean)) return score;
  const degree = minusculeQueryScore(quickItemHaystack(item), queries);
  if (degree > -Infinity) score -= degree;
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

