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
// The sections that live INSIDE this dialog. The rail's other two entries (review comments, memo) are docks
// with their own panels — the user asked for them to be reachable here, not embedded — so they just open and
// dismiss the launcher.
var QUICK_LAUNCHER_MODES = ['recent', 'prompts'];
var quickSideKeepsFocus = false;

function openQuickOpen(mode) {
  if (!quickOpen || !quickInput || !quickModeLabel) return;
  setQuickOpenOwnsEditKeys(true);
  quickMode = mode;
  quickModeLabel.textContent = mode === 'recent'
    ? t('quickopen.recent')
    : mode === 'prompts'
      ? t('promptPalette.title')
      : mode === 'content'
        ? t('quickopen.findInFiles')
        : mode === 'symbol'
          ? t('quickopen.workspaceSymbols')
          : t('quickopen.searchFiles');
  quickInput.setAttribute('placeholder', mode === 'symbol' ? t('quickopen.workspaceSymbols') : mode === 'content' ? t('quickopen.findInFiles') : t('quickopen.searchFiles'));
  quickOpen.classList.remove('hidden');
  // Recent files needs no search box — it's just the latest files. Hide the input and let typed letters
  // narrow the list (IntelliJ-style speed search); the global keydown routes keys to handleQuickOpenKey.
  // Prompts has no search box either, so it borrows quick-recent's "input hidden, letters filter" chrome.
  quickOpen.classList.toggle('quick-recent', mode === 'recent' || mode === 'prompts');
  quickOpen.classList.toggle('quick-content', mode === 'content');
  quickOpen.classList.toggle('quick-launcher', QUICK_LAUNCHER_MODES.indexOf(mode) >= 0);
  syncQuickLauncherRail();
  syncContentSearchControls();
  recentFilter = '';
  quickInput.value = '';
  updateRecentFilterDisplay();
  renderQuickOpenResults();
  // File search intentionally stays empty until the user types. Loading the whole project index on open
  // made an untouched dialog look like an arbitrary file browser and spent work before there was a query.
  // The first real file-name query requests the deferred index in renderQuickOpenResults().
  // Switching from the rail must not throw the keyboard back to the list, or one ArrowDown after picking a
  // section would land somewhere else entirely.
  if (quickSideKeepsFocus) { quickSideKeepsFocus = false; focusQuickSide(); }
  else if (mode === 'recent' || mode === 'prompts') { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
  else setTimeout(() => quickInput.focus(), 0);
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
    quickSideKeepsFocus = !!focusedQuickSideItem(); // arrived by keyboard -> stay on the rail
    openQuickOpen(section);
    return;
  }
  closeQuickOpen();
  if (section === 'merged' && typeof openMergedView === 'function') openMergedView();
  else if (section === 'memo' && typeof openMemoView === 'function') openMemoView();
  // Everything else is a view with a rail button behind it: click that, so the launcher opens it by exactly
  // the path the shortcut and the title bar already use rather than by a second copy of the same logic.
  else document.querySelector('.rail-btn[data-view="' + section + '"]')?.click();
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

function handleQuickOpenKey(event) {
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

function renderQuickOpenResults() {
  if (!quickResults) return;
  // Recent mode filters its own list by the typed speed-search string; other modes use the search box.
  const isRecent = quickMode === 'recent';
  const rawQuery = (isRecent ? recentFilter : (quickInput?.value || '')).trim();
  if (quickMode === 'prompts') { renderPromptSection(); return; }
  if (quickMode === 'content') { renderContentSearchResults(rawQuery); return; }
  if (quickMode === 'symbol') { renderWorkspaceSymbolResults(rawQuery); return; }
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
  const query = rawQuery.toLowerCase();
  const candidates = isRecent ? recentItems() : allQuickItems();
  quickItems = candidates
    .filter((item) => {
      if (query.length === 0) return true;
      if (quickMode === 'content') {
        const file = sourceByPath.get(item.path);
        return Boolean(file && file.embedded && file.content.toLowerCase().includes(query));
      }
      return (item.path + '\n' + item.name + '\n' + item.detail).toLowerCase().includes(query);
    })
    .sort((a, b) => scoreQuickItem(a, query) - scoreQuickItem(b, query) || a.path.localeCompare(b.path))
    .slice(0, 80);
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
    '</span>',
    '<span class="quick-open-badge">' + escapeHtml(item.detail) + '</span>',
    '</button>',
  ].join('')).join('');
  renderQuickPreview(quickItems[quickActive]);
}

function openWorkspaceSymbols() {
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
      + '<span class="quick-open-path">' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '</span></span>'
      + '<span class="quick-open-badge">' + escapeHtml(item.detail) + '</span></button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

async function runWorkspaceSymbolSearch(query, seq) {
  var loc = caretSourceLoc() || { path: sourceFiles[0] && sourceFiles[0].path, lineIndex: 0, column: 0 };
  var response = await queryProjectAnalysis('workspaceSymbol', null, loc, { query: query, limit: 200 });
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
  workspaceSymbolEngine = response && response.engine === 'lsp' ? (response.server || 'LSP') : 'index';
  workspaceSymbolBusy = false;
  quickActive = 0;
  renderWorkspaceSymbolResults(query);
}

function contentSearchExtensions() {
  var seen = new Set();
  return String(quickExtensionInput && quickExtensionInput.value || '')
    .split(/[\s,;]+/)
    .map(function (value) { return value.trim().toLowerCase().replace(/^\*?\./, ''); })
    .filter(function (value) {
      if (!value || !/^[a-z0-9][a-z0-9._+-]{0,31}$/.test(value) || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}
function contentSearchPathAllowed(path, extensions, excludeNoise) {
  var normalized = String(path || '').replace(/\\/g, '/').toLowerCase();
  if (extensions && extensions.length && !extensions.some(function (extension) { return normalized.endsWith('.' + extension); })) return false;
  if (!excludeNoise) return true;
  var segments = normalized.split('/');
  var name = segments[segments.length - 1] || '';
  return !segments.some(function (segment) { return segment === 'test' || segment === 'tests' || segment === '__tests__'; })
    && !/(^test_.*|_test\.[^.]+$|\.(test|spec)\.[^.]+$)/.test(name);
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
  return contentSearchPathAllowed(item && item.path, filters.extensions, filters.excludeNoise)
    && (!filters.excludeNoise || !contentSearchLineIsComment(item));
}
function currentContentSearchFilters() {
  return { extensions: contentSearchExtensions(), excludeNoise: contentSearchExcludeNoise };
}
function contentSearchRequestKey(query, filters) {
  return JSON.stringify([query, filters.extensions, filters.excludeNoise]);
}
function syncContentSearchControls() {
  if (quickExcludeNoiseButton) {
    quickExcludeNoiseButton.setAttribute('aria-pressed', contentSearchExcludeNoise ? 'true' : 'false');
    quickExcludeNoiseButton.classList.toggle('active', contentSearchExcludeNoise);
  }
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
      if (filters.extensions.length) request.extensions = filters.extensions;
      if (filters.excludeNoise) request.excludeCommentsAndTests = true;
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

function localContentSearch(query, limit, filters) {
  filters = filters || { extensions: [], excludeNoise: false };
  var smartCase = /[A-Z]/.test(query);
  var needle = smartCase ? query : query.toLowerCase();
  var out = [];
  for (var fi = 0; fi < sourceFiles.length && out.length < limit; fi++) {
    var file = sourceFiles[fi];
    if (!file.embedded || !contentSearchPathAllowed(file.path, filters.extensions, filters.excludeNoise)) continue;
    var lines = String(file.content || '').split(/\r?\n/);
    for (var li = 0; li < lines.length && out.length < limit; li++) {
      var line = lines[li];
      var haystack = smartCase ? line : line.toLowerCase();
      var from = 0;
      while (from <= haystack.length && out.length < limit) {
        var at = haystack.indexOf(needle, from);
        if (at < 0) break;
        var item = { path: file.path, name: file.name, detail: (li + 1) + ':' + (at + 1), kind: 'search', recent: false, lineIndex: li, column: at, endColumn: at + query.length, text: line, matchText: line.slice(at, at + query.length) };
        if (contentSearchItemAllowed(item, filters)) out.push(item);
        from = at + Math.max(query.length, 1);
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
  // A prompt is not a file: it has no path to preview, and the pane was rendering its id ("codebase") as
  // though it were one. The card already says everything there is to say about a prompt.
  if (!item || item.kind === 'prompt') { preview.innerHTML = ''; return; }
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

// Prompts section: the saved agent prompts, sent to the terminal composer on Enter. The list itself comes
// from promptPaletteEntries() (24-prompt-palette.js), which stays the one definition of what a prompt is.
function renderPromptSection() {
  // The card says WHEN to reach for a prompt, not what it says. You are picking between two or three of
  // them; the first line of the prompt text is the least useful thing to compare — they all open the same
  // way. The text itself is editable in Settings, which is where reading it belongs.
  quickItems = (typeof promptPaletteEntries === 'function' ? promptPaletteEntries() : []).map(function (entry) {
    return { kind: 'prompt', path: entry.id, name: entry.title, detail: entry.when || '', prompt: entry };
  });
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
  if (!quickItems.length) {
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('promptPalette.title')) + '</div>';
    renderQuickPreview(null);
    return;
  }
  quickResults.innerHTML = quickItems.map(function (item, index) {
    return '<button type="button" class="quick-open-item quick-open-prompt' + (index === quickActive ? ' active' : '') + '" data-index="' + index + '">'
      + '<span class="quick-open-prompt-name">' + escapeHtml(item.name) + '</span>'
      + '<span class="quick-open-prompt-when">' + escapeHtml(item.detail) + '</span>'
      + '<span class="quick-open-prompt-go">' + escapeHtml(t('promptPalette.hint')) + '</span></button>';
  }).join('');
  renderQuickPreview(null);
}

function openQuickItem(item) {
  if (!item) return;
  // A prompt is not a file: hand it to the terminal's send mode (staged in the composer, never executed
  // behind the user's back) exactly as the standalone ⌘⇧P palette used to.
  if (item.kind === 'prompt') {
    closeQuickOpen();
    var text = item.prompt && typeof item.prompt.text === 'function' ? item.prompt.text() : (item.prompt && item.prompt.text);
    if (text && typeof sendPromptToTerminal === 'function') sendPromptToTerminal(text);
    return;
  }
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
  const target = Number(link.dataset.hunk);
  if (!Number.isNaN(target) && target >= 0 && target < hunkTotal()) {
    setActive(target);
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
  const items = loadRecent()
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
