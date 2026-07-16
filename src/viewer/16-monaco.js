// Monaco is a lazy, Electron-only enhancement. Review mode keeps monacori's line-comment DOM; Code mode
// virtualizes large source files, and multi-result semantic navigation opens the Peek inspector below.
var monacoLoadPromise = null;
var monacoSourceMode = false;
// A large source opens virtualized by default. The override lets the user temporarily switch that one
// file to Review mode for comments without changing the preferred mode of every ordinary source file.
var monacoReviewOverrides = Object.create(null);
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
  // The standalone bootstrap can open its default file before this late viewer slice has run its
  // top-level initializer. `var` is hoisted as undefined, so treat that brief state as no override.
  if (!monacoEligibleSource(path, file) || (monacoReviewOverrides && monacoReviewOverrides[path])) return false;
  return Boolean(monacoSourceMode || file.virtualized);
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
  var codeMode = shouldRenderMonacoSource(path, file);
  var key = codeMode ? 'monaco.reviewMode' : 'monaco.codeMode';
  var titleKey = codeMode ? 'monaco.reviewMode.title' : 'monaco.codeMode.title';
  button.setAttribute('data-i18n', key);
  button.setAttribute('data-i18n-title', titleKey);
  button.setAttribute('aria-pressed', codeMode ? 'true' : 'false');
  button.textContent = t(key);
  button.title = t(titleKey);
}

function toggleMonacoSourceMode() {
  var viewer = document.getElementById('source-viewer');
  var path = viewer && viewer.dataset.openPath;
  var file = path && sourceByPath.get(path);
  if (!path || !monacoEligibleSource(path, file)) return;
  var codeMode = shouldRenderMonacoSource(path, file);
  if (file.virtualized) {
    if (codeMode) monacoReviewOverrides[path] = true;
    else delete monacoReviewOverrides[path];
  } else {
    monacoSourceMode = !monacoSourceMode;
  }
  if (codeMode) disposeMonacoSourceEditor();
  openSourceFile(path, false);
  syncMonacoModeToggle(path, file);
}

function toggleMonacoSourceFold() {
  if (!monacoSourceEditor) return false;
  var action = typeof monacoSourceEditor.getAction === 'function' && monacoSourceEditor.getAction('editor.toggleFold');
  if (action && typeof action.run === 'function') { action.run(); return true; }
  if (typeof monacoSourceEditor.trigger === 'function') {
    monacoSourceEditor.trigger('monacori', 'editor.toggleFold', null);
    return true;
  }
  return false;
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
  if (syntaxTheme === 'darcula') {
    if (typeof monaco.editor.defineTheme === 'function') {
      monaco.editor.defineTheme('monacori-darcula', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '808080', fontStyle: 'italic' },
          { token: 'keyword', foreground: 'CC7832' },
          { token: 'string', foreground: '6A8759' },
          { token: 'number', foreground: '6897BB' },
          { token: 'type.identifier', foreground: 'A9B7C6' },
          { token: 'identifier.function', foreground: 'FFC66D' },
          { token: 'annotation', foreground: 'BBB529', fontStyle: 'italic' },
          { token: 'tag', foreground: 'E8BF6A' },
        ],
        colors: {
          'editor.background': '#2B2B2B',
          'editor.foreground': '#A9B7C6',
          'editorCursor.foreground': '#A9B7C6',
          'editor.lineHighlightBackground': '#323232',
          'editor.selectionBackground': '#214283',
          'editor.inactiveSelectionBackground': '#3A455A',
          'editorLineNumber.foreground': '#808080',
          'editorLineNumber.activeForeground': '#A4A3A3',
        },
      });
      monaco.editor.defineTheme('monacori-intellij-light', {
        base: 'vs',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '8C8C8C', fontStyle: 'italic' },
          { token: 'keyword', foreground: '0033B3' },
          { token: 'string', foreground: '067D17' },
          { token: 'number', foreground: '1750EB' },
          { token: 'type.identifier', foreground: '000000' },
          { token: 'identifier.function', foreground: '00627A' },
          { token: 'annotation', foreground: '9E880D', fontStyle: 'italic' },
          { token: 'tag', foreground: '0033B3' },
        ],
        colors: {
          'editor.background': '#FFFFFF',
          'editor.foreground': '#000000',
          'editorCursor.foreground': '#000000',
          'editor.lineHighlightBackground': '#F3F4F5',
          'editor.selectionBackground': '#A6D2FF',
          'editor.inactiveSelectionBackground': '#D7E8F8',
          'editorLineNumber.foreground': '#999999',
          'editorLineNumber.activeForeground': '#555555',
        },
      });
    }
    monaco.editor.setTheme(theme === 'light' ? 'monacori-intellij-light' : 'monacori-darcula');
    return;
  }
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
    foldingImportsByDefault: true,
    showFoldingControls: 'mouseover',
    stickyScroll: { enabled: true },
    renderWhitespace: 'selection',
    scrollBeyondLastLine: false,
    smoothScrolling: false,
    wordWrap: 'off',
    // Keep roughly 15% of a normal editor viewport above/below the caret. syncMonacoScrolloff recalculates
    // this from the actual layout after mount/resize; six lines is the safe first-paint fallback.
    cursorSurroundingLines: 6,
    cursorSurroundingLinesStyle: 'all',
    padding: { top: 6, bottom: 12 },
  }, extra || {});
}

function syncMonacoScrolloff(editor) {
  if (!editor || typeof editor.updateOptions !== 'function') return;
  var layout = typeof editor.getLayoutInfo === 'function' ? editor.getLayoutInfo() : null;
  var lineHeight = 20;
  try {
    if (window.monaco && window.monaco.editor && window.monaco.editor.EditorOption
        && typeof editor.getOption === 'function') {
      lineHeight = Number(editor.getOption(window.monaco.editor.EditorOption.lineHeight)) || lineHeight;
    }
  } catch (e) {}
  var height = layout && Number(layout.height) > 0 ? Number(layout.height) : lineHeight * 40;
  var surrounding = Math.max(2, Math.ceil((height / lineHeight) * 0.15));
  editor.updateOptions({ cursorSurroundingLines: surrounding, cursorSurroundingLinesStyle: 'all' });
}

function renderMonacoSource(file) {
  var requestedPath = file.path;
  loadMonacoRuntime().then(function (monaco) {
    var viewer = document.getElementById('source-viewer');
    var body = document.getElementById('source-body');
    var currentFile = sourceByPath.get(requestedPath) || file;
    if (!shouldRenderMonacoSource(requestedPath, currentFile)
        || !viewer || viewer.dataset.openPath !== requestedPath || !body) return;
    disposeMonacoSourceEditor();
    body.className = 'source-body monaco-source-body';
    body.innerHTML = '<div id="monaco-source-host" class="monaco-source-host"></div>';
    var host = document.getElementById('monaco-source-host');
    if (!host) return;
    var model = monacoModelFor(monaco, requestedPath, file);
    monacoSourceEditor = monaco.editor.create(host, monacoEditorOptions({ model: model }));
    monacoSourcePath = requestedPath;
    syncMonacoScrolloff(monacoSourceEditor);
    if (typeof monacoSourceEditor.onDidLayoutChange === 'function') {
      monacoSourceEditor.onDidLayoutChange(function () { syncMonacoScrolloff(monacoSourceEditor); });
    }
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
    if (file.virtualized) monacoReviewOverrides[requestedPath] = true;
    else monacoSourceMode = false;
    if (document.getElementById('source-viewer')?.dataset.openPath === requestedPath) openSourceFile(requestedPath, false);
  });
}

// Live-watch refresh for the file already open in Code mode. Updating the existing model preserves the
// editor DOM, view state, focus, and caret; disposing/recreating Monaco here caused the same large flash and
// top-of-file jump as the Review renderer's former Loading placeholder path.
function refreshMonacoSourceInPlace(file, cursorSnapshot) {
  if (!file || !isMonacoSourceActive(file.path) || !monacoSourceEditor || !window.monaco) return false;
  var editor = monacoSourceEditor;
  var model = editor.getModel && editor.getModel();
  if (!model) return false;
  var viewState = typeof editor.saveViewState === 'function' ? editor.saveViewState() : null;
  var cursor = cursorSnapshot || (viewerCursor && viewerCursor.path === file.path ? viewerCursor : null);
  var lineIndex = cursor ? remapSourceRefreshLine(file, cursor) : 0;
  var column = cursor ? cursor.column : 0;
  monacoSourceSyncing = true;
  try {
    if (model.getValue() !== String(file.content || '')) model.setValue(String(file.content || ''));
    if (viewState && typeof editor.restoreViewState === 'function') editor.restoreViewState(viewState);
  } finally {
    monacoSourceSyncing = false;
  }
  viewerCursor = { path: file.path, lineIndex: lineIndex, column: column, targetLine: cursor ? cursor.targetLine : -1 };
  updateMonacoSourcePosition(lineIndex, column, false, viewerCursor.targetLine);
  refreshMonacoSourceDecorations(window.monaco, file);
  syncMonacoScrolloff(editor);
  return true;
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
  var file = sourceByPath.get(path);
  if (file && file.virtualized) monacoReviewOverrides[path] = true;
  else monacoSourceMode = false;
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
  var results = document.getElementById('semantic-peek-results');
  if (results && typeof results.focus === 'function') results.focus({ preventScroll: true });
  var seq = ++semanticPeekRequestSeq;
  loadMonacoRuntime().then(function (monaco) {
    if (seq !== semanticPeekRequestSeq || panel.classList.contains('hidden')) return;
    if (!monacoPeekEditor) {
      var host = document.getElementById('semantic-peek-editor');
      if (!host) return;
      monacoPeekEditor = monaco.editor.create(host, monacoEditorOptions({
        domReadOnly: true,
        minimap: { enabled: false },
        stickyScroll: { enabled: false },
        glyphMargin: false,
        folding: false,
        renderLineHighlight: 'none',
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
      }));
    }
    showSemanticPeekItem(semanticPeekActive);
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
    return '<button type="button" role="option" aria-selected="' + (index === semanticPeekActive ? 'true' : 'false')
      + '" class="semantic-peek-item' + (index === semanticPeekActive ? ' active' : '') + '" data-index="' + index + '" title="' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '">'
      + '<span class="semantic-peek-item-path">' + escapeHtml(item.path) + '</span>'
      + '<span class="semantic-peek-item-line">' + (item.lineIndex + 1) + '</span>'
      + '<span class="semantic-peek-item-code">' + escapeHtml(item.text.trim().slice(0, 180)) + '</span></button>';
  }).join('') + '<div class="semantic-peek-list-hint">' + escapeHtml(t('monaco.peekHint')) + '</div>';
}

function showSemanticPeekItem(index) {
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
    // Peek is a passive preview: reveal and decorate the target without placing a second editor caret.
    monacoPeekEditor.revealPositionInCenter(position);
    if (monacoPeekDecorations) monacoPeekDecorations.clear();
    monacoPeekDecorations = monacoPeekEditor.createDecorationsCollection([{
      range: new window.monaco.Range(position.lineNumber, 1, position.lineNumber, 1),
      options: { isWholeLine: true, className: 'semantic-peek-target-line' },
    }]);
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
  if (item) {
    showSemanticPeekItem(Number(item.dataset.index) || 0);
    event.currentTarget.focus({ preventScroll: true });
  }
});
document.getElementById('semantic-peek-results')?.addEventListener('dblclick', function (event) {
  var item = event.target && event.target.closest && event.target.closest('.semantic-peek-item');
  if (!item) return;
  semanticPeekActive = Number(item.dataset.index) || 0;
  openActiveSemanticPeekSource();
});
document.getElementById('semantic-peek-results')?.addEventListener('mousemove', function (event) {
  var item = event.target && event.target.closest && event.target.closest('.semantic-peek-item');
  if (!item) return;
  var index = Number(item.dataset.index) || 0;
  if (index !== semanticPeekActive) showSemanticPeekItem(index);
});
document.addEventListener('keydown', function (event) {
  var panel = document.getElementById('semantic-peek');
  if (!panel || panel.classList.contains('hidden')) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSemanticPeek(); return; }
  // Keep result navigation authoritative even if the user clicked the passive Monaco preview. This makes
  // the floating list behave like IntelliJ's usages popup: arrows preview, Enter enters the source.
  if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); showSemanticPeekItem(semanticPeekActive + 1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); showSemanticPeekItem(semanticPeekActive - 1); }
  else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); openActiveSemanticPeekSource(); }
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
