function openQuickOpen(mode) {
  if (!quickOpen || !quickInput || !quickModeLabel) return;
  quickMode = mode;
  quickModeLabel.textContent = mode === 'recent' ? t('quickopen.recent') : mode === 'content' ? t('quickopen.findInFiles') : t('quickopen.searchFiles');
  quickOpen.classList.remove('hidden');
  // Recent files needs no search box — it's just the latest files. Hide the input and let typed letters
  // narrow the list (IntelliJ-style speed search); the global keydown routes keys to handleQuickOpenKey.
  quickOpen.classList.toggle('quick-recent', mode === 'recent');
  recentFilter = '';
  quickInput.value = '';
  updateRecentFilterDisplay();
  renderQuickOpenResults();
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
  const query = (isRecent ? recentFilter : (quickInput?.value || '')).trim().toLowerCase();
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
  if (!item) { preview.innerHTML = ''; return; }
  const file = sourceByPath.get(item.path);
  if (!file || !file.embedded) {
    preview.innerHTML = '<div class="qp-empty">' + escapeHtml(item.path) + '</div>';
    return;
  }
  const query = ((quickInput && quickInput.value) || '').trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  let firstHit = -1;
  const rows = lines.map((line, i) => {
    const hit = query.length > 0 && line.toLowerCase().includes(query);
    if (hit && firstHit < 0) firstHit = i;
    return '<div class="qp-line' + (hit ? ' qp-hit' : '') + '"><span class="qp-num">' + (i + 1) + '</span><span class="qp-code">' + highlightLine(line, file.language || 'text') + '</span></div>';
  }).join('');
  preview.innerHTML = '<div class="qp-head">' + escapeHtml(item.path) + '</div><div class="qp-body">' + rows + '</div>';
  if (firstHit >= 0) {
    const target = preview.querySelectorAll('.qp-line')[firstHit];
    if (target) target.scrollIntoView({ block: 'center' });
  }
}

function openQuickItem(item) {
  if (!item) return;
  closeQuickOpen();
  rememberRecent(item.path, item.kind);
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
  return loadRecent()
    .map((item) => byPath.get(item.path) || {
      path: item.path,
      name: baseName(item.path),
      detail: item.kind === 'change' ? 'diff' : 'file',
      kind: item.kind,
      recent: true,
      recentRank: 0,
    })
    .map((item, index) => ({ ...item, recent: true, recentRank: index }));
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
