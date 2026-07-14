// Monaco is a lazy, Electron-only enhancement. Review mode keeps monacori's line-comment DOM; Code mode
// virtualizes large source files, and multi-result semantic navigation opens the Peek inspector below.
var monacoLoadPromise = null;
var monacoSourceMode = false;
var monacoSourceEditor = null;
var monacoSourceDecorations = null;
var monacoSourceSyncing = false;
var monacoSourcePath = '';
var monacoPeekEditor = null;
var monacoPeekDecorations = null;
var monacoModels = new Map();
var monacoProvidersRegistered = false;
var semanticPeekItems = [];
var semanticPeekActive = 0;
var semanticPeekRequestSeq = 0;

function monacoAvailable() {
  return Boolean(window.monacoriAnalysis && document.getElementById('editor-mode-toggle'));
}

function monacoEligibleSource(path, file) {
  return Boolean(monacoAvailable() && file && file.embedded && !file.image
    && !isMarkdownPath(path) && !isCsvPath(path) && !isHttpFile(path));
}

function shouldRenderMonacoSource(path, file) {
  return Boolean(monacoSourceMode && monacoEligibleSource(path, file));
}

function isMonacoSourceActive(path) {
  if (!monacoSourceEditor || !monacoSourcePath) return false;
  return !path || path === monacoSourcePath;
}

function syncMonacoModeToggle(path, file) {
  var button = document.getElementById('editor-mode-toggle');
  if (!button) return;
  var eligible = monacoEligibleSource(path, file);
  button.classList.toggle('hidden', !eligible);
  if (!eligible) return;
  var key = monacoSourceMode ? 'monaco.reviewMode' : 'monaco.codeMode';
  var titleKey = monacoSourceMode ? 'monaco.reviewMode.title' : 'monaco.codeMode.title';
  button.setAttribute('data-i18n', key);
  button.setAttribute('data-i18n-title', titleKey);
  button.setAttribute('aria-pressed', monacoSourceMode ? 'true' : 'false');
  button.textContent = t(key);
  button.title = t(titleKey);
}

function toggleMonacoSourceMode() {
  var viewer = document.getElementById('source-viewer');
  var path = viewer && viewer.dataset.openPath;
  var file = path && sourceByPath.get(path);
  if (!path || !monacoEligibleSource(path, file)) return;
  monacoSourceMode = !monacoSourceMode;
  if (!monacoSourceMode) disposeMonacoSourceEditor();
  openSourceFile(path, false);
  syncMonacoModeToggle(path, file);
}

function loadMonacoRuntime() {
  if (window.monaco && window.monaco.editor) {
    // Tests and future embedders may preload Monaco. Treat that exactly like the lazy-loader path so
    // semantic providers and theme synchronization are never skipped just because the runtime arrived first.
    registerMonacoAnalysisProviders(window.monaco);
    applyMonacoTheme(window.monaco);
    return Promise.resolve(window.monaco);
  }
  if (monacoLoadPromise) return monacoLoadPromise;
  var started = performance.now();
  try { window.monacoriPerf?.mark('monaco-load-start'); } catch (e) {}
  monacoLoadPromise = new Promise(function (resolveRuntime, rejectRuntime) {
    function loadEditor() {
      try {
        window.MonacoEnvironment = Object.assign({}, window.MonacoEnvironment || {}, { globalAPI: true });
        window.require.config({ paths: { vs: 'monacori-asset://app/vs' } });
        window.require(['vs/editor/editor.main'], function (runtime) {
          var monaco = window.monaco || runtime;
          if (!monaco || !monaco.editor) { rejectRuntime(new Error('Monaco runtime did not expose its editor API')); return; }
          registerMonacoAnalysisProviders(monaco);
          applyMonacoTheme(monaco);
          try { window.monacoriPerf?.mark('monaco-ready', { durationMs: Math.round((performance.now() - started) * 10) / 10 }); } catch (e) {}
          resolveRuntime(monaco);
        }, rejectRuntime);
      } catch (error) { rejectRuntime(error); }
    }
    if (window.require && typeof window.require.config === 'function') { loadEditor(); return; }
    var script = document.createElement('script');
    script.src = 'monacori-asset://app/vs/loader.js';
    script.async = true;
    script.onload = loadEditor;
    script.onerror = function () { rejectRuntime(new Error('Could not load Monaco runtime')); };
    document.head.appendChild(script);
  }).catch(function (error) {
    monacoLoadPromise = null;
    try { window.monacoriPerf?.mark('monaco-load-failed', { error: String(error && error.message || error).slice(0, 160) }); } catch (e) {}
    throw error;
  });
  return monacoLoadPromise;
}

function applyMonacoTheme(monaco) {
  if (!monaco || !monaco.editor) return;
  monaco.editor.setTheme(theme === 'light' ? 'vs' : 'vs-dark');
}

function monacoLanguage(file) {
  var language = String(file && file.language || 'text').toLowerCase();
  var aliases = { text: 'plaintext', markup: 'html', shell: 'shell', csharp: 'csharp', cpp: 'cpp' };
  return aliases[language] || language;
}

function monacoUri(monaco, path) {
  var encoded = String(path || '').split('/').map(encodeURIComponent).join('/');
  return monaco.Uri.parse('monacori-source://workspace/' + encoded);
}

function pathFromMonacoUri(uri) {
  if (!uri || uri.scheme !== 'monacori-source') return '';
  try { return decodeURIComponent(String(uri.path || '').replace(/^\/+/, '')); } catch (e) { return ''; }
}

function monacoModelFor(monaco, path, file) {
  var existing = monacoModels.get(path);
  if (existing && !existing.isDisposed()) {
    if (existing.getValue() !== String(file.content || '')) existing.setValue(String(file.content || ''));
    return existing;
  }
  var model = monaco.editor.createModel(String(file.content || ''), monacoLanguage(file), monacoUri(monaco, path));
  monacoModels.set(path, model);
  model.onWillDispose(function () { if (monacoModels.get(path) === model) monacoModels.delete(path); });
  return model;
}

function monacoEditorOptions(extra) {
  return Object.assign({
    readOnly: true,
    domReadOnly: false,
    automaticLayout: true,
    minimap: { enabled: true, autohide: true },
    fontFamily: 'Monaco, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 20,
    lineNumbersMinChars: 4,
    glyphMargin: true,
    folding: true,
    stickyScroll: { enabled: true },
    renderWhitespace: 'selection',
    scrollBeyondLastLine: false,
    smoothScrolling: false,
    wordWrap: 'off',
    padding: { top: 6, bottom: 12 },
  }, extra || {});
}

function renderMonacoSource(file) {
  var requestedPath = file.path;
  loadMonacoRuntime().then(function (monaco) {
    var viewer = document.getElementById('source-viewer');
    var body = document.getElementById('source-body');
    if (!monacoSourceMode || !viewer || viewer.dataset.openPath !== requestedPath || !body) return;
    disposeMonacoSourceEditor();
    body.className = 'source-body monaco-source-body';
    body.innerHTML = '<div id="monaco-source-host" class="monaco-source-host"></div>';
    var host = document.getElementById('monaco-source-host');
    if (!host) return;
    var model = monacoModelFor(monaco, requestedPath, file);
    monacoSourceEditor = monaco.editor.create(host, monacoEditorOptions({ model: model }));
    monacoSourcePath = requestedPath;
    monacoSourceEditor.onDidChangeCursorPosition(function (event) {
      if (monacoSourceSyncing || monacoSourcePath !== requestedPath) return;
      var lineIndex = Math.max(0, event.position.lineNumber - 1);
      var column = Math.max(0, event.position.column - 1);
      viewerCursor = { path: requestedPath, lineIndex: lineIndex, column: column, targetLine: -1 };
      selectedCommentRow = null;
    });
    monacoSourceEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, function () { goToSymbolUnderCursor(); });
    monacoSourceEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB, function () { goToImplementation(); });
    monacoSourceEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit8, function () { toggleImpact(); });
    monacoSourceEditor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Slash, function () { openComposer('q'); });
    monacoSourceEditor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Period, function () { openComposer('c'); });
    refreshMonacoSourceDecorations(monaco, file);
    var cursor = viewerCursor && viewerCursor.path === requestedPath ? viewerCursor : { lineIndex: 0, column: 0, targetLine: -1 };
    updateMonacoSourcePosition(cursor.lineIndex, cursor.column, true, cursor.targetLine);
    monacoSourceEditor.focus();
  }).catch(function () {
    // A failed optional editor load returns to the proven Review renderer at the same caret.
    monacoSourceMode = false;
    if (document.getElementById('source-viewer')?.dataset.openPath === requestedPath) openSourceFile(requestedPath, false);
  });
}

function refreshMonacoSourceDecorations(monaco, file) {
  if (!monacoSourceEditor) return;
  if (monacoSourceDecorations) monacoSourceDecorations.clear();
  var decorations = [];
  (file.changedLines || []).forEach(function (line) {
    decorations.push({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: 'monacori-changed-line', linesDecorationsClassName: 'monacori-changed-glyph' },
    });
  });
  reviewComments.filter(function (comment) { return comment.path === file.path; }).forEach(function (comment) {
    decorations.push({
      range: new monaco.Range(comment.line, 1, comment.line, 1),
      options: { glyphMarginClassName: 'monacori-comment-glyph', glyphMarginHoverMessage: { value: comment.text || t('comment.kind.' + comment.kind) } },
    });
  });
  monacoSourceDecorations = monacoSourceEditor.createDecorationsCollection(decorations);
}

function updateMonacoSourcePosition(lineIndex, column, shouldReveal, targetLine) {
  if (!monacoSourceEditor) return;
  monacoSourceSyncing = true;
  var position = { lineNumber: Math.max(1, Number(lineIndex) + 1), column: Math.max(1, Number(column) + 1) };
  monacoSourceEditor.setPosition(position);
  if (shouldReveal) monacoSourceEditor.revealPositionInCenterIfOutsideViewport(position);
  if (monacoSourceDecorations && targetLine >= 0) {
    // The caret itself is the precise semantic target in Code mode; reveal it without duplicating the
    // transient Review-mode DOM highlight.
    monacoSourceEditor.revealLineInCenterIfOutsideViewport(targetLine + 1);
  }
  monacoSourceSyncing = false;
}

function selectAllMonacoSource() {
  if (!monacoSourceEditor) return;
  monacoSourceEditor.trigger('monacori', 'editor.action.selectAll', null);
  monacoSourceEditor.focus();
}

function disposeMonacoSourceEditor() {
  if (monacoSourceDecorations) { monacoSourceDecorations.clear(); monacoSourceDecorations = null; }
  if (monacoSourceEditor) { monacoSourceEditor.dispose(); monacoSourceEditor = null; }
  monacoSourcePath = '';
}

function switchMonacoToReviewAtCursor() {
  if (!isMonacoSourceActive()) return;
  var cursor = viewerCursor ? { ...viewerCursor } : null;
  var path = monacoSourcePath;
  monacoSourceMode = false;
  disposeMonacoSourceEditor();
  openSourceFile(path, false);
  if (cursor) setSourceCursor(path, cursor.lineIndex, cursor.column, true, cursor.targetLine);
}

function analysisGenerationIsCurrent(response) {
  if (!response || !Number.isFinite(Number(response.generation))) return true;
  var status = document.getElementById('analysis-status');
  var currentGeneration = status ? Number(status.dataset.generation) : 0;
  return !currentGeneration || Number(response.generation) === currentGeneration;
}

function registerMonacoAnalysisProviders(monaco) {
  if (monacoProvidersRegistered) return;
  monacoProvidersRegistered = true;
  async function locations(kind, model, position, token) {
    var path = pathFromMonacoUri(model.uri);
    var word = model.getWordAtPosition(position);
    if (!path || !word) return [];
    var response = await queryProjectAnalysis(kind, word.word, {
      path: path,
      lineIndex: position.lineNumber - 1,
      column: position.column - 1,
    });
    if (token.isCancellationRequested || !response || !response.ok || !analysisGenerationIsCurrent(response)) return [];
    return (response.locations || []).map(function (item) {
      var line = Math.max(1, Number(item.lineIndex) + 1);
      var start = Math.max(1, Number(item.column) + 1);
      var end = Math.max(start + 1, Number(item.endColumn) + 1 || start + String(item.name || word.word).length);
      return { uri: monacoUri(monaco, item.path), range: new monaco.Range(line, start, line, end) };
    });
  }
  monaco.languages.registerDefinitionProvider('*', { provideDefinition: function (model, position, token) { return locations('definition', model, position, token); } });
  monaco.languages.registerReferenceProvider('*', { provideReferences: function (model, position, _context, token) { return locations('references', model, position, token); } });
  monaco.languages.registerImplementationProvider('*', { provideImplementation: function (model, position, token) { return locations('implementation', model, position, token); } });
  monaco.editor.registerEditorOpener({
    openCodeEditor: function (_source, resource, selection) {
      var path = pathFromMonacoUri(resource);
      if (!path) return false;
      var line = Math.max(0, Number(selection && selection.startLineNumber || 1) - 1);
      var column = Math.max(0, Number(selection && selection.startColumn || 1) - 1);
      closeSemanticPeek();
      openSourceAt(path, line, column);
      return true;
    },
  });
}

function openSemanticPeek(name, locations, response, kind) {
  var panel = document.getElementById('semantic-peek');
  if (!panel || !monacoAvailable()) { openAnalysisUsagesFallback(name, locations); return; }
  semanticPeekItems = (locations || []).map(function (item) {
    return { path: item.path, lineIndex: Number(item.lineIndex) || 0, column: Number(item.column) || 0, text: String(item.text || '') };
  });
  semanticPeekActive = 0;
  var title = document.getElementById('semantic-peek-title');
  var meta = document.getElementById('semantic-peek-meta');
  var label = kind === 'definition' ? 'definitions' : kind === 'implementation' ? 'implementations' : 'usages';
  if (title) title.textContent = semanticPeekItems.length + ' ' + label + ' · ' + name;
  if (meta) {
    var bits = [response && response.confidence || response && response.engine || 'semantic'];
    if (response && response.server) bits.push(response.server + (response.serverSource ? ' (' + response.serverSource + ')' : ''));
    if (response && Number.isFinite(Number(response.generation))) bits.push('g' + Number(response.generation));
    if (response && Number.isFinite(Number(response.durationMs))) bits.push(Number(response.durationMs).toFixed(1) + 'ms');
    meta.textContent = bits.join(' · ');
    meta.title = response && response.fallbackReason ? String(response.fallbackReason) : '';
  }
  renderSemanticPeekResults();
  panel.classList.remove('hidden');
  var seq = ++semanticPeekRequestSeq;
  loadMonacoRuntime().then(function (monaco) {
    if (seq !== semanticPeekRequestSeq || panel.classList.contains('hidden')) return;
    if (!monacoPeekEditor) {
      var host = document.getElementById('semantic-peek-editor');
      if (!host) return;
      monacoPeekEditor = monaco.editor.create(host, monacoEditorOptions({ minimap: { enabled: false }, stickyScroll: { enabled: false } }));
    }
    showSemanticPeekItem(semanticPeekActive, true);
  }).catch(function () {
    var host = document.getElementById('semantic-peek-editor');
    if (host) host.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('source.previewUnavailable')) + '</div>';
  });
}

function openAnalysisUsagesFallback(name, locations) {
  usageItems = (locations || []).map(function (item) {
    return { path: item.path, lineIndex: Number(item.lineIndex) || 0, column: Number(item.column) || 0, text: String(item.text || '') };
  });
  if (usageItems.length === 1) { openUsageItem(usageItems[0]); return; }
  usageActive = 0;
  showUsages(name, usageItems.length);
}

function renderSemanticPeekResults() {
  var results = document.getElementById('semantic-peek-results');
  if (!results) return;
  if (!semanticPeekItems.length) { results.innerHTML = '<div class="quick-open-empty">' + escapeHtml(t('monaco.noResults')) + '</div>'; return; }
  results.innerHTML = semanticPeekItems.map(function (item, index) {
    return '<button type="button" class="semantic-peek-item' + (index === semanticPeekActive ? ' active' : '') + '" data-index="' + index + '">'
      + '<span class="semantic-peek-item-path">' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '</span>'
      + '<span class="semantic-peek-item-code">' + escapeHtml(item.text.trim().slice(0, 180)) + '</span></button>';
  }).join('');
}

function showSemanticPeekItem(index, focusEditor) {
  if (!semanticPeekItems.length) return;
  semanticPeekActive = Math.max(0, Math.min(index, semanticPeekItems.length - 1));
  renderSemanticPeekResults();
  var active = document.querySelector('#semantic-peek-results .semantic-peek-item.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  var item = semanticPeekItems[semanticPeekActive];
  var seq = ++semanticPeekRequestSeq;
  loadSourceFile(item.path).then(function (file) {
    if (seq !== semanticPeekRequestSeq || !file || !file.embedded || !monacoPeekEditor || !window.monaco) return;
    var model = monacoModelFor(window.monaco, item.path, file);
    monacoPeekEditor.setModel(model);
    var position = { lineNumber: item.lineIndex + 1, column: item.column + 1 };
    monacoPeekEditor.setPosition(position);
    monacoPeekEditor.revealPositionInCenter(position);
    if (monacoPeekDecorations) monacoPeekDecorations.clear();
    monacoPeekDecorations = monacoPeekEditor.createDecorationsCollection([{
      range: new window.monaco.Range(position.lineNumber, 1, position.lineNumber, 1),
      options: { isWholeLine: true, className: 'monacori-changed-line', linesDecorationsClassName: 'monacori-changed-glyph' },
    }]);
    if (focusEditor) monacoPeekEditor.focus();
  });
}

function closeSemanticPeek() {
  semanticPeekRequestSeq += 1;
  document.getElementById('semantic-peek')?.classList.add('hidden');
}

function openActiveSemanticPeekSource() {
  var item = semanticPeekItems[semanticPeekActive];
  if (!item) return;
  closeSemanticPeek();
  openSourceAt(item.path, item.lineIndex, item.column);
}

document.getElementById('editor-mode-toggle')?.addEventListener('click', toggleMonacoSourceMode);
document.getElementById('semantic-peek-close')?.addEventListener('click', closeSemanticPeek);
document.getElementById('semantic-peek-open')?.addEventListener('click', openActiveSemanticPeekSource);
document.getElementById('semantic-peek-results')?.addEventListener('click', function (event) {
  var item = event.target && event.target.closest && event.target.closest('.semantic-peek-item');
  if (item) showSemanticPeekItem(Number(item.dataset.index) || 0, false);
});
document.getElementById('semantic-peek-results')?.addEventListener('mousemove', function (event) {
  var item = event.target && event.target.closest && event.target.closest('.semantic-peek-item');
  if (!item) return;
  var index = Number(item.dataset.index) || 0;
  if (index !== semanticPeekActive) { semanticPeekActive = index; renderSemanticPeekResults(); }
});
document.addEventListener('keydown', function (event) {
  var panel = document.getElementById('semantic-peek');
  if (!panel || panel.classList.contains('hidden')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSemanticPeek(); return; }
  var inResults = event.target && event.target.closest && event.target.closest('#semantic-peek-results');
  if (!inResults) return;
  if (event.key === 'ArrowDown') { event.preventDefault(); showSemanticPeekItem(semanticPeekActive + 1, false); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); showSemanticPeekItem(semanticPeekActive - 1, false); }
  else if (event.key === 'Enter') { event.preventDefault(); openActiveSemanticPeekSource(); }
}, true);

// applyTheme is defined earlier; keep already-created Monaco editors in lockstep with the app setting.
var applyThemeWithoutMonaco = applyTheme;
applyTheme = function () {
  applyThemeWithoutMonaco();
  if (window.monaco) applyMonacoTheme(window.monaco);
};

if (typeof window !== 'undefined') window.__monacoriMonaco = {
  load: loadMonacoRuntime,
  openPeek: openSemanticPeek,
  closePeek: closeSemanticPeek,
  toggleSourceMode: toggleMonacoSourceMode,
};
