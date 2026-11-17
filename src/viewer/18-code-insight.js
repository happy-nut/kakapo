

var quickDocSeq = 0;

function quickDocPanel() {
  return document.getElementById('quick-doc');
}

function closeQuickDoc() {
  var panel = quickDocPanel();
  if (!panel || panel.classList.contains('hidden')) return false;
  var hadFocus = panel.contains(document.activeElement);
  panel.classList.add('hidden');
  panel.style.left = panel.style.top = panel.style.bottom = panel.style.width = panel.style.maxHeight = '';
  if (!hadFocus) return true;
  focusReadingSurface();
  return true;
}

function codeInsightTarget() {
  var symbol = symbolUnderCursor();
  if (!symbol || !symbol.name) return null;
  return symbol;
}

async function openQuickDocumentation() {
  var panel = quickDocPanel();
  var symbol = codeInsightTarget();
  if (!panel || !symbol) { if (!symbol) showSemanticNavigationFailure('symbol'); return false; }
  if (!panel.classList.contains('hidden') && panel.dataset.symbol === symbol.name) return closeQuickDoc();
  var seq = ++quickDocSeq;
  panel.dataset.symbol = symbol.name;
  var title = document.getElementById('quick-doc-title');
  var meta = document.getElementById('quick-doc-meta');
  var body = document.getElementById('quick-doc-body');
  if (title) title.textContent = symbol.name;
  if (meta) meta.textContent = '';
  if (body) body.innerHTML = loadingStateHtml(t('quickopen.searching'), 'quick-doc-empty');
  panel.classList.remove('hidden');
  positionPanelAtCaret(panel);
  var response = await queryProjectAnalysis('hover', symbol.name, symbol);
  if (seq !== quickDocSeq) return true;
  var markdown = response && typeof response.hover === 'string' ? response.hover : '';
  if (meta) {
    var bits = [];
    if (response && response.engine) bits.push(response.engine === 'lsp' ? (response.server || 'LSP') : t('quickdoc.fromIndex'));
    if (response && response.revision) bits.push(response.revision);
    meta.textContent = bits.join(' · ');
    meta.title = response && response.fallbackReason ? String(response.fallbackReason) : '';
  }
  if (body) {
    body.innerHTML = markdown
      ? renderMarkdownHtml(markdown)
      : '<div class="quick-doc-empty">' + escapeHtml(t('quickdoc.none').replace('{symbol}', symbol.name))
        + (response && response.fallbackReason ? '<span class="quick-open-why">' + escapeHtml(String(response.fallbackReason)) + '</span>' : '')
        + '</div>';
    if (typeof body.focus === 'function') body.focus({ preventScroll: true });
  }
  positionPanelAtCaret(panel);
  return true;
}

function hoverSignatureLine(markdown) {
  var text = String(markdown || '');
  var fenced = text.match(/```[^\n]*\n([\s\S]*?)```/);
  var body = fenced ? fenced[1] : text;
  var lines = body.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  if (!lines.length) return '';
  return lines.slice(0, 3).join(' ').slice(0, 300);
}

async function showExpressionType() {
  var symbol = codeInsightTarget();
  if (!symbol) { showSemanticNavigationFailure('symbol'); return false; }
  var pending = setTimeout(function () { showCaretHint(t('monaco.searching').replace('{symbol}', symbol.name), null, true); }, 250);
  var response = await queryProjectAnalysis('hover', symbol.name, symbol);
  clearTimeout(pending);
  var line = hoverSignatureLine(response && response.hover);
  if (!line) {
    showCaretHint(t('quickdoc.noType').replace('{symbol}', symbol.name));
    return true;
  }
  showCaretHint(line);
  return true;
}

function showErrorDescriptionAtCaret() {
  var items = diagnosticsAtCaret();
  if (!items || !items.length) {
    showCaretHint(t('problems.noneHere'));
    return true;
  }
  var seen = [];
  items.forEach(function (item) {
    var source = item.source ? item.source + ': ' : '';
    var line = source + String(item.message || '').replace(/\s+/g, ' ');
    if (seen.indexOf(line) < 0) seen.push(line);
  });
  showCaretHint(seen.join(' — '));
  return true;
}

async function openQuickDefinition() {
  var panel = quickDocPanel();
  var symbol = codeInsightTarget();
  if (!panel || !symbol) { if (!symbol) showSemanticNavigationFailure('symbol'); return false; }
  if (!panel.classList.contains('hidden') && panel.dataset.symbol === 'def:' + symbol.name) return closeQuickDoc();
  var seq = ++quickDocSeq;
  panel.dataset.symbol = 'def:' + symbol.name;
  var title = document.getElementById('quick-doc-title');
  var meta = document.getElementById('quick-doc-meta');
  var body = document.getElementById('quick-doc-body');
  if (title) title.textContent = symbol.name;
  if (meta) meta.textContent = '';
  if (body) body.innerHTML = loadingStateHtml(t('quickopen.searching'), 'quick-doc-empty');
  panel.classList.remove('hidden');
  positionPanelAtCaret(panel);
  var response = await queryProjectAnalysis('definition', symbol.name, symbol);
  if (seq !== quickDocSeq) return true;
  if (revisionDecline(response) !== null) { closeQuickDoc(); declinedForRevision(response, symbol.name); return true; }
  var target = ((response && response.locations) || [])[0];
  if (!target) {
    if (body) body.innerHTML = '<div class="quick-doc-empty">' + escapeHtml(t('quickdef.none').replace('{symbol}', symbol.name)) + '</div>';
    return true;
  }
  if (!sourceByPath.has(target.path)) {
    await loadLibrarySourceFile(target.path);
    if (seq !== quickDocSeq) return true;
  }
  if (!sourceByPath.has(target.path)) {
    if (meta) meta.textContent = semanticFileLabel(target.path, target.lineIndex);
    if (body) body.innerHTML = '<div class="quick-doc-empty">' + escapeHtml(t('quickdef.outside').replace('{key}', shortcutLabel('goToDef'))) + '</div>';
    return true;
  }
  var file = sourceByPath.get(target.path);
  if (!sourceContentLoaded(file)) await loadSourceFile(target.path);
  if (seq !== quickDocSeq) return true;
  if (meta) meta.textContent = semanticFileLabel(target.path, target.lineIndex);
  if (body) body.innerHTML = quickDefinitionHtml(target);
  positionPanelAtCaret(panel);
  return true;
}

var QUICK_DEFINITION_LINES = 14;

function quickDefinitionHtml(target) {
  var file = sourceByPath.get(target.path);
  var lines = String((file && file.content) || '').split(/\r?\n/);
  var start = Math.max(0, Number(target.lineIndex) || 0);
  var declared = Number(target.endLineIndex);
  var end = Math.min(lines.length - 1, Number.isFinite(declared) && declared > start
    ? Math.min(declared, start + QUICK_DEFINITION_LINES * 3)
    : start + QUICK_DEFINITION_LINES - 1);
  var language = (file && file.language) || 'text';
  var out = '';
  for (var i = start; i <= end; i += 1) {
    out += '<div class="quick-def-line"><span class="quick-def-num">' + String(i + 1) + '</span>'
      + '<span class="quick-def-code">' + highlightLine(lines[i] || '', language) + '</span></div>';
  }
  return '<div class="quick-def">' + out + '</div>';
}

var problemRows = [];
var problemsBusy = false;
var problemsScanned = 0;
var problemsTotal = 0;
var problemsSeq = 0;
var problemsGeneration = -1;
var problemsErrorsOnly = false;
var problemsUnavailable = 0;
var PROBLEMS_CONCURRENCY = 4;

function openProblemsView() {
  var fresh = problemsGeneration !== analysisGeneration();
  if (fresh) {
    problemRows = [];
    problemsScanned = 0;
    problemsUnavailable = 0;
    problemsGeneration = analysisGeneration();
  }
  problemsBusy = fresh;
  openQuickOpen('problems', true);
  if (fresh) scanProblems();
  return true;
}

function reviewedPaths() {
  var own = new Set();
  links.forEach(function (link) {
    var path = link && link.dataset && link.dataset.file;
    if (path) own.add(path);
  });
  return own;
}

function problemFilePaths() {
  var own = reviewedPaths();
  var mine = [], rest = [];
  sourceFiles.forEach(function (file) {
    if (!file || !file.path || !diagnosticsEligible(file.path)) return;
    (own.has(file.path) ? mine : rest).push(file.path);
  });
  return mine.concat(rest);
}

async function scanProblems() {
  var seq = ++problemsSeq;
  var paths = problemFilePaths();
  problemsTotal = paths.length;
  problemsScanned = 0;
  problemsUnavailable = 0;
  problemRows = [];
  renderProblemsResults(String(quickInput && quickInput.value || ''));
  var next = 0;
  async function worker() {
    while (next < paths.length) {
      var path = paths[next++];
      var response = null;
      try { response = await queryProjectDiagnostics(path); } catch (e) { response = null; }
      if (seq !== problemsSeq) return;
      problemsScanned += 1;
      if (!response || response.ok === false || response.available === false) {
        problemsUnavailable += 1;
      }
      var items = surfacedDiagnostics(response && response.diagnostics);
      items.forEach(function (item) {
        problemRows.push({
          path: path,
          lineIndex: Number(item.lineIndex) || 0,
          column: Number(item.column) || 0,
          severity: String(item.severity || 'warning'),
          message: String(item.message || '').replace(/\s+/g, ' ').trim(),
          source: String(item.source || ''),
        });
      });
      if (quickMode === 'problems') renderProblemsResults(String(quickInput && quickInput.value || ''));
    }
  }
  var workers = [];
  for (var i = 0; i < Math.min(PROBLEMS_CONCURRENCY, paths.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  if (seq !== problemsSeq) return;
  problemsBusy = false;
  if (quickMode === 'problems') renderProblemsResults(String(quickInput && quickInput.value || ''));
}

function queryProjectDiagnostics(path) {
  if (!window.kakapoAnalysis || typeof window.kakapoAnalysis.diagnostics !== 'function') return Promise.resolve(null);
  return Promise.resolve(window.kakapoAnalysis.diagnostics(path));
}

var PROBLEM_ORDER = { error: 0, warning: 1, weak: 2 };

function visibleProblemRows(query) {
  var needle = String(query || '').trim().toLowerCase();
  var queries = queryVariants(String(query || '').trim());
  var own = reviewedPaths();
  return problemRows.filter(function (row) {
    if (problemsErrorsOnly && row.severity !== 'error') return false;
    if (!needle) return true;
    var hay = [row.message, row.path];
    return matchesQueryVariants(hay, queries);
  }).sort(function (a, b) {
    return (PROBLEM_ORDER[a.severity] - PROBLEM_ORDER[b.severity])
      || ((own.has(b.path) ? 1 : 0) - (own.has(a.path) ? 1 : 0))
      || a.path.localeCompare(b.path)
      || a.lineIndex - b.lineIndex;
  });
}

function renderProblemsResults(query) {
  if (!quickResults) return;
  var rows = visibleProblemRows(query);
  quickItems = rows.map(function (row) {
    return {
      path: row.path,
      name: sourceTabLabel(row.path),
      detail: row.severity,
      kind: 'symbol',
      recent: false,
      lineIndex: row.lineIndex,
      column: row.column,
      text: row.message,
    };
  });
  clampQuickActive();
  var errors = problemRows.filter(function (row) { return row.severity === 'error'; }).length;
  var summary = t('problems.summary', { n: problemRows.length, errors: errors, files: problemsTotal });
  if (problemsUnavailable) {
    summary += ' · ' + t('problems.unavailable', { n: problemsUnavailable });
  }
  setQuickFilterChip(problemsBusy, summary, t('problems.scanning', { done: problemsScanned, total: problemsTotal }));
  if (quickFilterEl) {
    quickFilterEl.removeAttribute('title');
    if (!problemsBusy && problemsUnavailable) {
      quickFilterEl.setAttribute('title', t('problems.unavailableWhy', { n: problemsUnavailable }));
    }
  }
  if (!rows.length) {
    var empty = problemsBusy ? t('quickopen.searching')
      : problemsErrorsOnly && problemRows.length ? t('problems.noErrors')
        : t('problems.none');
    showQuickEmpty(empty, !problemsBusy && problemsUnavailable
      ? t('problems.unavailableWhy', { n: problemsUnavailable })
      : '');
    return;
  }
  quickResults.innerHTML = rows.map(function (row, index) {
    return '<button type="button" class="quick-open-item problem-result' + (index === quickActive ? ' active' : '')
      + '" data-index="' + index + '" data-severity="' + escapeHtml(row.severity) + '"'
      + ' title="' + escapeHtml(row.path + ':' + (row.lineIndex + 1)) + '">'
      + '<span class="problem-mark" aria-hidden="true"></span>'
      + '<span class="quick-open-main"><span class="problem-message">' + escapeHtml(row.message) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(semanticFileLabel(row.path, row.lineIndex))
      + (row.source ? ' · ' + escapeHtml(row.source) : '') + '</span>'
      + projectRowTagsHtml(row.path) + '</span>'
      + '<span class="quick-open-badge">' + escapeHtml(t('problems.severity.' + row.severity)) + '</span></button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

function toggleProblemsErrorsOnly() {
  problemsErrorsOnly = !problemsErrorsOnly;
  quickActive = 0;
  renderProblemsResults(String(quickInput && quickInput.value || ''));
  return true;
}

function handleProblemsKey(event) {
  if (quickMode !== 'problems') return false;
  if (isShortcut(event, 'problemsView')) { event.preventDefault(); closeQuickOpen(); return true; }
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
    && (event.code === 'KeyE' || String(event.key).toLowerCase() === 'e')) {
    event.preventDefault();
    return toggleProblemsErrorsOnly();
  }
  return false;
}
