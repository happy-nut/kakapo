var quickPreviewSeq = 0;

function openQuickOpen(mode) {
  if (!quickOpen || !quickInput || !quickModeLabel) return;
  quickMode = mode;
  quickModeLabel.textContent = mode === 'recent'
    ? t('quickopen.recent')
    : mode === 'content'
      ? t('quickopen.findInFiles')
      : mode === 'symbol'
        ? t('quickopen.workspaceSymbols')
        : t('quickopen.searchFiles');
  quickInput.setAttribute('placeholder', mode === 'symbol' ? t('quickopen.workspaceSymbols') : mode === 'content' ? t('quickopen.findInFiles') : t('quickopen.searchFiles'));
  quickOpen.classList.remove('hidden');
  // Recent files needs no search box — it's just the latest files. Hide the input and let typed letters
  // narrow the list (IntelliJ-style speed search); the global keydown routes keys to handleQuickOpenKey.
  quickOpen.classList.toggle('quick-recent', mode === 'recent');
  recentFilter = '';
  quickInput.value = '';
  updateRecentFilterDisplay();
  renderQuickOpenResults();
  // File search intentionally stays empty until the user types. Loading the whole project index on open
  // made an untouched dialog look like an arbitrary file browser and spent work before there was a query.
  // The first real file-name query requests the deferred index in renderQuickOpenResults().
  if (mode === 'recent') { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
  else setTimeout(() => quickInput.focus(), 0);
}
// Title-row indicator for the Recent speed-search: the typed letters, or a muted "type to filter" hint.
function updateRecentFilterDisplay() {
  if (!quickFilterEl) return;
  if (quickMode !== 'recent') { quickFilterEl.textContent = ''; quickFilterEl.className = 'quick-open-filter'; return; }
  if (recentFilter) { quickFilterEl.textContent = recentFilter; quickFilterEl.className = 'quick-open-filter has-filter'; }
  else { quickFilterEl.textContent = t('quickopen.typeToFilter'); quickFilterEl.className = 'quick-open-filter is-hint'; }
}

function closeQuickOpen() {
  quickOpen?.classList.add('hidden');
}

function handleQuickOpenKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    // Recent speed-search: first Esc clears the typed filter, a second Esc closes (IntelliJ behavior).
    if (quickMode === 'recent' && recentFilter) { recentFilter = ''; updateRecentFilterDisplay(); renderQuickOpenResults(); return true; }
    closeQuickOpen();
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
    quickFilterEl.className = 'quick-open-filter';
    quickFilterEl.textContent = workspaceSymbolBusy
      ? t('quickopen.searching')
      : String(quickItems.length) + ' ' + t('quickopen.results') + ' · ' + workspaceSymbolEngine;
  }
  if (workspaceSymbolBusy) {
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.searching')) + '</div>';
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

function renderContentSearchResults(query) {
  if (query !== contentSearchQuery) {
    contentSearchQuery = query;
    contentSearchSeq += 1;
    if (contentSearchTimer) clearTimeout(contentSearchTimer);
    contentSearchItems = [];
    contentSearchTruncated = false;
    contentSearchBusy = Boolean(query);
    if (query) {
      const seq = contentSearchSeq;
      contentSearchTimer = setTimeout(function () { runContentSearch(query, seq); }, 120);
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
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('quickopen.searching')) + '</div>';
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
  if (!query) { quickFilterEl.textContent = ''; return; }
  if (contentSearchBusy) { quickFilterEl.textContent = t('quickopen.searching'); return; }
  quickFilterEl.textContent = String(contentSearchItems.length) + (contentSearchTruncated ? '+' : '') + ' ' + t('quickopen.results') + ' · ' + contentSearchEngine;
}

async function runContentSearch(query, seq) {
  var response = null;
  try {
    if (window.monacoriSearch && typeof window.monacoriSearch.query === 'function') {
      response = await window.monacoriSearch.query({ query: query, limit: 500 });
    }
  } catch (e) { response = null; }
  if (seq !== contentSearchSeq || quickMode !== 'content' || query !== String(quickInput && quickInput.value || '').trim()) return;

  if (response && response.available && Array.isArray(response.matches)) {
    contentSearchItems = response.matches.map(searchItemFromMatch).filter(Boolean);
    contentSearchTruncated = Boolean(response.truncated);
    contentSearchEngine = response.engine === 'ripgrep' ? 'rg' : 'local';
  } else {
    var localItems = localContentSearch(query, 501);
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

function localContentSearch(query, limit) {
  var smartCase = /[A-Z]/.test(query);
  var needle = smartCase ? query : query.toLowerCase();
  var out = [];
  for (var fi = 0; fi < sourceFiles.length && out.length < limit; fi++) {
    var file = sourceFiles[fi];
    if (!file.embedded) continue;
    var lines = String(file.content || '').split(/\r?\n/);
    for (var li = 0; li < lines.length && out.length < limit; li++) {
      var line = lines[li];
      var haystack = smartCase ? line : line.toLowerCase();
      var from = 0;
      while (from <= haystack.length && out.length < limit) {
        var at = haystack.indexOf(needle, from);
        if (at < 0) break;
        out.push({ path: file.path, name: file.name, detail: (li + 1) + ':' + (at + 1), kind: 'search', recent: false, lineIndex: li, column: at, endColumn: at + query.length, text: line, matchText: line.slice(at, at + query.length) });
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
      + '<div class="qp-empty">' + escapeHtml(t('source.loading')) + '</div>';
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
  const firstLine = focusLine >= 0 ? Math.max(0, focusLine - 7) : 0;
  const lastLine = focusLine >= 0 ? Math.min(lines.length, focusLine + 8) : lines.length;
  let firstHit = -1;
  const rows = lines.slice(firstLine, lastLine).map((line, offset) => {
    const i = firstLine + offset;
    const hit = focusLine >= 0 ? i === focusLine : query.length > 0 && line.toLowerCase().includes(query);
    if (hit && firstHit < 0) firstHit = i;
    return '<div class="qp-line' + (hit ? ' qp-hit' : '') + '"><span class="qp-num">' + (i + 1) + '</span><span class="qp-code">' + highlightLine(line, file.language || 'text') + '</span></div>';
  }).join('');
  preview.innerHTML = '<div class="qp-head">' + escapeHtml(item.path) + '</div><div class="qp-body">' + rows + '</div>';
  if (firstHit >= 0) {
    const target = preview.querySelectorAll('.qp-line')[Math.max(0, firstHit - firstLine)];
    if (target) target.scrollIntoView({ block: 'center' });
  }
}

function openQuickItem(item) {
  if (!item) return;
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

// The agent's plan file, pinned to the top of Recent so a freshly-written plan is one ⌘E away — loadRecent
// only tracks files you've opened, so a brand-new plan would otherwise be absent until first opened.
var PLAN_PATH = '.monacori/plan.md';
function planQuickItem() {
  var f = sourceByPath.get(PLAN_PATH);
  if (!f) return null;
  return { path: f.path, name: baseName(f.path), detail: 'plan', kind: 'source', recent: true, recentRank: -1 };
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
  const plan = planQuickItem();
  if (plan) return [plan].concat(items.filter((it) => it.path !== plan.path));
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
    const value = JSON.parse(localStorage.getItem(recentKey) || '[]');
    return Array.isArray(value) ? value.filter((item) => item && typeof item.path === 'string') : [];
  } catch {
    return [];
  }
}

function rememberRecent(path, kind) {
  if (!path) return;
  const next = [{ path, kind }, ...loadRecent().filter((item) => item.path !== path)].slice(0, 30);
  try {
    localStorage.setItem(recentKey, JSON.stringify(next));
  } catch {}
}

function baseName(path) {
  return String(path).split('/').filter(Boolean).pop() || String(path);
}

// A tree row is navigable only when it is actually visible — i.e. not tucked inside a collapsed
// <details> folder. getClientRects alone is unreliable here: Chromium keeps collapsed <details>
// content laid out (content-visibility), so its descendants still report rects. Walk the ancestor
// <details> and treat anything inside a closed one (other than its own summary) as hidden.
