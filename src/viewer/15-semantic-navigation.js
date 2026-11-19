function wordAtCursor() {
  if (!viewerCursor) return null;
  const file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return null;
  const line = file.content.split(/\r?\n/)[viewerCursor.lineIndex] || '';
  const column = Math.max(0, Math.min(viewerCursor.column, line.length));
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match = null;
  while ((match = identifier.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (column >= start && column <= end) {
      return { name: match[0], path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: start };
    }
  }
  return null;
}

function symbolUnderCursor() {
  return isSourceViewerVisible() ? wordAtCursor() : symbolAtDiffCaret();
}
function goToDefinitionUnderCursor() {
  const symbol = symbolUnderCursor();
  if (symbol) goToDefOrUsages(symbol.name, symbol);
  else showSemanticNavigationFailure('symbol');
}
function findUsagesUnderCursor() {
  const symbol = symbolUnderCursor();
  if (symbol) findUsagesOf(symbol.name, symbol);
  else showSemanticNavigationFailure('symbol');
}
async function findUsagesOf(name, explicitLoc) {
  if (!name) { showSemanticNavigationFailure('symbol'); return; }
  var loc = explicitLoc || caretSourceLoc();
  var pending = setTimeout(function () { showCaretHint(t('monaco.searching').replace('{symbol}', name), null, true); }, 250);
  var response = await queryProjectAnalysis('references', name, loc);
  clearTimeout(pending);
  hideCaretHint();
  if (declinedForRevision(response, name)) return;
  // The declaration the caret is sitting on is not one of its usages. Some servers report it, and a lone
  // self-hit then "navigated" to the line the caret was already on, which looks exactly like nothing.
  var items = ((response && response.locations) || []).filter(function (item) {
    return !(loc && item && item.path === loc.path && Number(item.lineIndex) === Number(loc.lineIndex));
  });
  if (items.length) { openAnalysisUsages(name, items, response, 'references'); return; }
  var def = findSymbolDefinition(name) || { path: (loc && loc.path) || '', lineIndex: -1 };
  openUsages(name, def, response);
}
function isPartialAnalysisAnswer(response) {
  if (!response || response.engine === 'lsp') return false;
  if (response.revision) return false;
  var phase = (document.getElementById('analysis-status') || { dataset: {} }).dataset.phase;
  return phase === 'indexing' || phase === 'starting' || Boolean(response.fallbackReason);
}
var ANALYSIS_PARTIAL_NOTICE_MS = 4000;
var analysisPartialNoticeAt = 0;

function showPartialAnalysisHint(name) {
  analysisPartialNoticeAt = Date.now();
  showCaretHint(t('monaco.analysisPartial').replace('{symbol}', String(name || '')));
}

var BACKGROUND_ANALYSIS_KINDS = {
  documentSymbol: true,
  foldingRange: true,
  documentHighlight: true,
  codeLens: true,
  inlayHint: true,
  semanticTokens: true,
};
function noteProvisionalAnalysis(response, symbol) {
  if (!isPartialAnalysisAnswer(response)) return;
  if (!analysisStillArriving()) return;
  if (Date.now() - analysisPartialNoticeAt < ANALYSIS_PARTIAL_NOTICE_MS) return;
  var seq = caretHintSeq;
  setTimeout(function () {
    if (caretHintSeq !== seq) return;
    showPartialAnalysisHint(symbol);
  }, 0);
}
function analysisStillArriving() {
  var phase = (document.getElementById('analysis-status') || { dataset: {} }).dataset.phase;
  return phase === 'starting' || phase === 'indexing';
}
function revisionDecline(response) {
  return response && response.declined === 'revision' ? String(response.revision || '') : null;
}
function revisionAnswer(response) {
  return response && !response.declined && response.revision ? String(response.revision) : null;
}
function showRevisionAnswerHint(name, revision) {
  showCaretHint(t('monaco.analysisRevisionMatched')
    .replace('{symbol}', String(name || ''))
    .replace('{revision}', revision));
}
function showRevisionDecline(revision, name) {
  closeSemanticPeek();
  showCaretHint(t('monaco.analysisRevision')
    .replace('{revision}', revision || '—')
    .replace('{symbol}', String(name || '')));
}
function declinedForRevision(response, name) {
  var revision = revisionDecline(response);
  if (revision === null) return false;
  showRevisionDecline(revision, name);
  return true;
}
function showSemanticNavigationFailure(kind, name, response) {
  var revision = revisionDecline(response);
  if (revision !== null) { showRevisionDecline(revision, name); return; }
  if (response && response.unsupported) {
    closeSemanticPeek();
    showCaretHint(t('monaco.notOffered').replace('{symbol}', String(name || '')));
    return;
  }
  if (response && response.noServer) {
    closeSemanticPeek();
    showCaretHint(t('monaco.noServer'));
    return;
  }
  if (response && response.baseSide) {
    closeSemanticPeek();
    showCaretHint(t('monaco.baseSide').replace('{symbol}', String(name || '')));
    return;
  }
  var couldNotAsk = Boolean(response && response.engine !== 'lsp' && response.fallbackReason
    && response.serverAnswered !== true);
  var pending = analysisStillArriving() || couldNotAsk;
  var key = pending ? 'monaco.analysisPending'
    : kind === 'references' ? 'monaco.referencesNotFound'
      : kind === 'implementation' ? 'monaco.implementationNotFound'
        : kind === 'typeDefinition' ? 'monaco.typeNotFound'
          : kind === 'supertypes' ? 'monaco.superNotFound'
            : kind === 'symbol' ? 'monaco.noSymbol' : 'monaco.definitionNotFound';
  var message = t(key).replace('{symbol}', String(name || ''));
  closeSemanticPeek();
  showCaretHint(message);
}
async function goToDefOrUsages(name, explicitLoc) {
  if (!name) { showSemanticNavigationFailure('symbol'); return; }
  var loc = explicitLoc || caretSourceLoc();
  var pending = setTimeout(function () { showCaretHint(t('monaco.searching').replace('{symbol}', name), null, true); }, 250);
  var response = await queryProjectAnalysis('definition', name, loc);
  clearTimeout(pending);
  hideCaretHint();
  if (declinedForRevision(response, name)) return;
  if (response && response.ok) {
    var defs = response.locations || [];
    var answeredFor = revisionAnswer(response);
    if (defs.length && answeredFor) showRevisionAnswerHint(name, answeredFor);
    var guessing = response.engine !== 'lsp' && analysisStillArriving();
    if (defs.length > 1 || (defs.length === 1 && guessing)) {
      openSemanticPeek(name, defs, response, 'definition');
      return;
    }
    var def = defs[0];
    if (def && def.external) {
      var external = await loadLibrarySourceFile(def.path);
      if (!external || !String(external.content || '')) {
        if (openLibraryOnWeb(def.path)) return;
        showCaretHint(t('monaco.definitionExternal')
          .replace('{symbol}', String(name || ''))
          .replace('{where}', externalLocationLabel(def.path)));
        return;
      }
      openSourceAt(def.path, def.lineIndex, def.column);
      return;
    }
    if (def && alreadyAtLocation(loc, def)) {
      var refs = await queryProjectAnalysis('references', name, loc);
      openAnalysisUsages(name, refs && refs.locations || [], refs, 'references');
      return;
    }
    if (def) { openSourceAt(def.path, def.lineIndex, def.column); return; }
  }
  var def = findSymbolDefinition(name);
  if (def && alreadyAtLocation(loc, def)) {
    openUsages(name, def);
    return;
  }
  if (def) { openSourceAt(def.path, def.lineIndex, def.column); return; }
  showSemanticNavigationFailure('definition', name, response);
}
async function goToImplementation() {
  var symbol = isSourceViewerVisible() ? wordAtCursor() : null;
  var name = symbol ? symbol.name : wordAtDiffCaret();
  var loc = symbol || caretSourceLoc();
  if (!name || !loc) { showSemanticNavigationFailure('symbol'); return; }
  var response = await queryProjectAnalysis('implementation', name, loc);
  if (declinedForRevision(response, name)) return;
  var items = response && response.locations || [];
  if (items.length === 1) {
    if (alreadyAtLocation(loc, items[0])) { showCaretHint(t('monaco.alreadyThere').replace('{symbol}', name)); return; }
    openSourceAt(items[0].path, items[0].lineIndex, items[0].column);
    return;
  }
  openAnalysisUsages(name, items, response, 'implementation');
}
function alreadyAtLocation(loc, item) {
  if (!loc || !item) return false;
  if (loc.side === 'old') return false;
  if (String(item.path || '') !== String(loc.path || '')) return false;
  if (Number(item.lineIndex) !== Number(loc.lineIndex)) return false;
  var token = symbolUnderCursor();
  if (!token || Number(token.lineIndex) !== Number(loc.lineIndex)) return true;
  var column = Number(item.column);
  if (!isFinite(column)) return true;
  var start = Number(token.column);
  return column >= start && column <= start + String(token.name || '').length;
}

var guessedAnalysisQuestionLast = null;
function guessedAnalysisQuestionFor(response) {
  var question = guessedAnalysisQuestionLast;
  return question && question.response === response ? question : null;
}
function queryProjectAnalysis(kind, symbol, loc, extra) {
  if (!window.kakapoAnalysis || typeof window.kakapoAnalysis.query !== 'function') return Promise.resolve(null);
  var request = Object.assign({
    kind: kind,
    symbol: symbol || undefined,
    path: loc && loc.path,
    line: loc && loc.lineIndex,
    column: loc && loc.column,
    side: loc && loc.side,
  }, extra || {});
  return Promise.resolve(window.kakapoAnalysis.query(request)).then(function (response) {
    if (!analysisGenerationIsCurrent(response)) return null;
    if (!BACKGROUND_ANALYSIS_KINDS[kind]) {
      noteProvisionalAnalysis(response, symbol);
      guessedAnalysisQuestionLast = response && response.engine !== 'lsp' && analysisStillArriving()
        ? { kind: kind, symbol: symbol, loc: loc, extra: extra, response: response }
        : null;
    }
    return response;
  }).catch(function () { return null; });
}
function diffCaretOnWorkingTree(wrapper, row, line) {
  if (!diffCursor || diffCursor.side !== 'old') return { lineIndex: line - 1, side: diffCursor ? diffCursor.side : 'new' };
  var mate = wrapper ? diffRowAt(wrapper, 'new', diffCursor.rowIndex) : null;
  var mateLine = mate ? diffLineNumber(mate) : null;
  if (mateLine != null && diffLineText(mate) === diffLineText(row)) return { lineIndex: mateLine - 1, side: 'new' };
  return { lineIndex: line - 1, side: 'old' };
}
function caretSourceLoc() {
  if (isSourceViewerVisible() && viewerCursor) return { path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  if (isDiffViewVisible() && diffCursor) {
    var wrap = diffWrapperByPath(diffCursor.path);
    var row = wrap ? diffRowAt(wrap, diffCursor.side, diffCursor.rowIndex) : null;
    var ln = row ? diffLineNumber(row) : null;
    if (ln == null) return null;
    var at = diffCaretOnWorkingTree(wrap, row, ln);
    return { path: diffCursor.path, lineIndex: at.lineIndex, column: diffCursor.column, side: at.side };
  }
  return null;
}
function findUsages(name, defPath, defLine) {
  var re;
  try { re = new RegExp('(^|[^A-Za-z0-9_$])' + escapeRegExp(name) + '(?![A-Za-z0-9_$])'); } catch (e) { return []; }
  var out = [];
  for (var fi = 0; fi < sourceFiles.length; fi++) {
    var f = sourceFiles[fi];
    if (!f.embedded || semanticDocumentPath(f.path)) continue;
    var lines = String(f.content).split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      if (f.path === defPath && li === defLine) continue;
      if (semanticCommentOnlyLine(lines[li])) continue;
      var m = re.exec(lines[li]);
      if (m) {
        out.push({ path: f.path, lineIndex: li, column: m.index + (m[1] ? m[1].length : 0), text: lines[li] });
        if (out.length >= 500) return out;
      }
    }
  }
  return out;
}
function openUsages(name, def, response) {
  var items = findUsages(name, def.path, def.lineIndex);
  if (items.length === 1) { openSourceAt(items[0].path, items[0].lineIndex, items[0].column); return; }
  if (!items.length) { showSemanticNavigationFailure('references', name, response); return; }
  usageItems = items;
  usageActive = 0;
  showUsages(name, items.length);
}
function openAnalysisUsages(name, locations, response, kind) {
  locations = semanticNavigationLocations(locations, kind);
  if (!(locations || []).length) { showSemanticNavigationFailure(kind || 'references', name, response); return; }
  if (locations.length > 1) {
    openSemanticPeek(name, locations, response, kind || 'references');
    return;
  }
  openAnalysisUsagesFallback(name, locations, kind || 'references');
}
var usageName = '';
function showUsages(name, count) {
  var box = document.getElementById('usages');
  var title = document.getElementById('usages-title');
  if (!box) return;
  if (box.classList.contains('hidden')) rememberOverlayFocus(box);
  usageName = String(name || '');
  if (title) title.textContent = t('peek.usages', { n: count }) + ' · ' + usageName;
  renderUsages();
  box.classList.remove('hidden');
  positionUsagesAtCaret();
}
function positionUsagesAtCaret() {
  var box = document.getElementById('usages');
  if (!box) return;
  var panel = box.querySelector('.quick-open-panel');
  if (!panel) return;
  resetUsagesAnchor(box, panel);
  var caret = document.querySelector('#source-body .code-cursor') || document.querySelector('#diff2html-container .code-cursor');
  if (!caret) return;
  var rect = caret.getBoundingClientRect();
  if (!rect.height && !rect.width && !rect.top) return;
  var vw = window.innerWidth, vh = window.innerHeight, gap = 6, margin = 8;
  var pw = Math.min(560, vw - margin * 2);
  var left = Math.min(Math.max(margin, rect.left), vw - pw - margin);
  box.classList.add('anchored');
  panel.style.width = pw + 'px';
  panel.style.left = left + 'px';
  var spaceBelow = vh - rect.bottom - gap - margin;
  var spaceAbove = rect.top - gap - margin;
  if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
    panel.style.top = (rect.bottom + gap) + 'px';
    panel.style.maxHeight = Math.max(120, spaceBelow) + 'px';
  } else {
    panel.style.bottom = (vh - rect.top + gap) + 'px';
    panel.style.maxHeight = Math.max(120, spaceAbove) + 'px';
  }
}
function resetUsagesAnchor(box, panel) {
  box.classList.remove('anchored');
  panel.style.left = panel.style.top = panel.style.bottom = panel.style.width = panel.style.maxHeight = '';
}
function renderUsages() {
  var results = document.getElementById('usages-results');
  if (!results) return;
  if (!usageItems.length) {
    var empty = analysisStillArriving()
      ? t('monaco.analysisPending').replace('{symbol}', usageName || '')
      : t('monaco.referencesNotFound').replace('{symbol}', usageName || '');
    results.innerHTML = '<div class="quick-open-empty">' + escapeHtml(empty) + '</div>';
    return;
  }
  results.innerHTML = usageItems.map(function (item, index) {
    var fname = item.path.split('/').pop();
    var isTest = item.isTest || semanticTestPath(item.path);
    return '<button type="button" class="quick-open-item usage-item' + (isTest ? ' is-test' : '') + (index === usageActive ? ' active' : '') + '" data-index="' + index + '" title="' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '">'
      + '<span class="usage-loc">' + escapeHtml(fname) + ':' + (item.lineIndex + 1) + '</span>'
      + '<span class="usage-code">' + semanticCodeHtml(item.path, item.text.replace(/^\s+/, '').slice(0, 160)) + '</span>'
      + projectRowTagsHtml(item.path, 'module')
      + '</button>';
  }).join('');
  updateUsageActive();
}
function updateUsageActive() {
  var results = document.getElementById('usages-results');
  if (!results) return;
  var items = results.querySelectorAll('.usage-item');
  for (var i = 0; i < items.length; i++) {
    var on = i === usageActive;
    items[i].classList.toggle('active', on);
    if (on && items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
  }
}
function handleUsagesKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); closeUsages(); return true; }
  if (event.key === 'ArrowDown') { event.preventDefault(); usageActive = Math.min(usageActive + 1, usageItems.length - 1); updateUsageActive(); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); usageActive = Math.max(usageActive - 1, 0); updateUsageActive(); return true; }
  if (event.key === 'Enter') { event.preventDefault(); openUsageItem(usageItems[usageActive]); return true; }
  return false;
}
function openUsageItem(item) {
  if (!item) return;
  closeUsages(true);
  openSourceAt(item.path, item.lineIndex, item.column);
}
function closeUsages(navigating) {
  var box = document.getElementById('usages');
  if (!box) return;
  var held = !navigating && !box.classList.contains('hidden');
  box.classList.add('hidden');
  var panel = box.querySelector('.quick-open-panel');
  if (panel) resetUsagesAnchor(box, panel);
  restoreOverlayFocus(box, held);
}

function wordAtDiffCaret() {
  var symbol = symbolAtDiffCaret();
  return symbol ? symbol.name : null;
}
function symbolAtDiffCaret() {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return null;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  var line = diffLineNumber(row);
  if (line == null) return null;
  var text = diffLineText(row);
  var column = Math.max(0, Math.min(diffCursor.column, text.length));
  var at = diffCaretOnWorkingTree(wrapper, row, line);
  var identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  var match = null;
  while ((match = identifier.exec(text))) {
    if (column >= match.index && column <= match.index + match[0].length) {
      return {
        name: match[0],
        path: diffCursor.path,
        lineIndex: at.lineIndex,
        column: match.index,
        side: at.side,
      };
    }
  }
  return null;
}

var NOT_A_DECLARED_NAME = /^(?:if|for|while|switch|catch|with|function|return|new|typeof|void|delete|throw|await|yield)$/;

function findSymbolDefinition(name) {
  if (NOT_A_DECLARED_NAME.test(String(name || ''))) return null;
  const matchers = definitionMatchers(name);
  const currentPath = viewerCursor?.path || '';
  const orderedFiles = [
    ...sourceFiles.filter((file) => file.path === currentPath),
    ...sourceFiles.filter((file) => file.path !== currentPath),
  ].filter((file) => file.embedded && !semanticDocumentPath(file.path));

  for (const file of orderedFiles) {
    const lines = file.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (semanticCommentOnlyLine(line)) continue;
      if (matchers.some((matcher) => declarationMatch(matcher, line))) {
        return { path: file.path, lineIndex, column: Math.max(0, line.indexOf(name)) };
      }
    }
  }
  return null;
}

function definitionMatchers(name) {
  const escaped = escapeRegExp(name);
  const mod = '(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|enum|annotation|static|export|default|expect|actual|value)\\s+)*';
  const funMod = '(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\\s+)*';
  const enumEntry = /^[A-Z][A-Z0-9_$]*$/.test(name)
    ? [new RegExp('^\\s*' + escaped + '\\s*(?:[,;(]|\\{|$)')]
    : [];
  return enumEntry.concat([
    new RegExp('^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + mod + '(?:class|interface|object|enum|trait|struct)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|val)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + '(?:fun|def|fn|func)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + escaped + '\\s*\\((?<parameters>[^)]*)\\)\\s*(?::\\s*[^=]+)?\\s*(?:\\{|=>)'),
    new RegExp('^\\s*' + escaped + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)'),
  ]);
}

function isParameterListText(text) {
  for (var at = text.indexOf('('); at >= 0; at = text.indexOf('(', at + 1)) {
    if (!text.slice(0, at).replace(/\s+$/, '').endsWith(':')) return false;
  }
  return true;
}

function declarationMatch(matcher, line) {
  var match = matcher.exec(line);
  if (!match) return false;
  var parameters = match.groups && match.groups.parameters;
  return parameters === undefined || isParameterListText(parameters);
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

var selectionChain = null;

function selectionChainIsLive() {
  return Boolean(selectionChain && viewerCursor
    && selectionChain.path === viewerCursor.path
    && selectionChain.applied
    && selectionChain.applied.lineIndex === viewerCursor.lineIndex
    && selectionChain.applied.column === viewerCursor.column);
}

function applySelectionChainStep(index) {
  var range = selectionChain.ranges[index];
  selectionChain.index = index;
  selectionAnchor = { lineIndex: range.startLine, column: range.startCharacter };
  navSuppress = true;
  try { setSourceCursor(selectionChain.path, range.endLine, range.endCharacter, false); }
  finally { navSuppress = false; }
  selectionChain.applied = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  applySourceSelection();
  if (!sourceSelectionIsWhole(range)) {
    flushSourceRows();
    applySourceSelection();
  }
  scheduleScrollIntoView(document.querySelector('.source-row.cursor-line'), document.getElementById('source-body'), 0.15);
}

function sourceSelectionIsWhole(range) {
  return Boolean(caretDomPosition(range.startLine, range.startCharacter)
    && caretDomPosition(range.endLine, range.endCharacter));
}

function clearSelectionChain() {
  selectionChain = null;
}

function extendShrinkSelection(outward) {
  if (!isSourceViewerVisible() || !viewerCursor) return false;
  if (selectionChainIsLive()) {
    var next = selectionChain.index + (outward ? 1 : -1);
    if (next >= selectionChain.ranges.length) return true;
    if (next < 0) {
      selectionAnchor = null;
      applySourceSelection();
      clearSelectionChain();
      return true;
    }
    applySelectionChainStep(next);
    return true;
  }
  if (!outward) return false;
  var loc = caretSourceLoc();
  if (!loc || !loc.path) return false;
  var origin = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  queryProjectAnalysis('selectionRange', wordAtCursor(), loc).then(function (response) {
    var ranges = response && Array.isArray(response.selection) ? response.selection : [];
    if (!viewerCursor || viewerCursor.path !== loc.path
      || viewerCursor.lineIndex !== origin.lineIndex || viewerCursor.column !== origin.column) return;
    if (!ranges.length) { showSemanticNavigationFailure('selectionRange', wordAtCursor(), response); return; }
    selectionChain = { path: loc.path, ranges: ranges, index: -1, applied: null };
    applySelectionChainStep(0);
  });
  return true;
}
