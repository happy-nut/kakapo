// Semantic navigation controller. Source rendering owns caret state; this slice translates that state into
// project-analysis requests and hands multiple results to the semantic presenter in 16-semantic-peek.js.
// Standalone reviews retain a bounded in-memory fallback without coupling it back into source rendering.
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

function goToSymbolUnderCursor() {
  const symbol = wordAtCursor();
  if (symbol) goToDefOrUsages(symbol.name, symbol);
  else showSemanticNavigationFailure('symbol');
}
function showSemanticNavigationFailure(kind, name) {
  var key = kind === 'references' ? 'monaco.referencesNotFound'
    : kind === 'implementation' ? 'monaco.implementationNotFound'
      : kind === 'symbol' ? 'monaco.noSymbol' : 'monaco.definitionNotFound';
  var message = t(key).replace('{symbol}', String(name || ''));
  if (typeof closeSemanticPeek === 'function') closeSemanticPeek();
  showCaretHint(message);
}
// Cmd+B: on a declaration, show its usages (navigate if there's only one); elsewhere, go to the definition.
async function goToDefOrUsages(name, explicitLoc) {
  if (!name) { showSemanticNavigationFailure('symbol'); return; }
  var loc = explicitLoc || caretSourceLoc();
  var response = await queryProjectAnalysis('definition', name, loc);
  if (response && response.ok) {
    var defs = response.locations || [];
    if (defs.length > 1 && typeof openSemanticPeek === 'function') {
      openSemanticPeek(name, defs, response, 'definition');
      return;
    }
    var def = defs[0];
    if (def && loc && def.path === loc.path && def.lineIndex === loc.lineIndex) {
      var refs = await queryProjectAnalysis('references', name, loc);
      openAnalysisUsages(name, refs && refs.locations || [], refs, 'references');
      return;
    }
    if (def) { openSourceAt(def.path, def.lineIndex, def.column); return; }
  }
  // Standalone HTML has no main-process analyzer. Keep a small in-memory scan for that mode only.
  var def = findSymbolDefinition(name);
  if (def && loc && def.path === loc.path && def.lineIndex === loc.lineIndex) {
    openUsages(name, def);
    return;
  }
  if (def) { openSourceAt(def.path, def.lineIndex, def.column); return; }
  showSemanticNavigationFailure('definition', name);
}
async function goToImplementation() {
  var symbol = isSourceViewerVisible() ? wordAtCursor() : null;
  var name = symbol ? symbol.name : wordAtDiffCaret();
  var loc = symbol || caretSourceLoc();
  if (!name || !loc) { showSemanticNavigationFailure('symbol'); return; }
  var response = await queryProjectAnalysis('implementation', name, loc);
  var items = response && response.locations || [];
  if (items.length === 1) { openSourceAt(items[0].path, items[0].lineIndex, items[0].column); return; }
  openAnalysisUsages(name, items, response, 'implementation');
}
function queryProjectAnalysis(kind, symbol, loc, extra) {
  if (!window.kakapoAnalysis || typeof window.kakapoAnalysis.query !== 'function') return Promise.resolve(null);
  var request = Object.assign({
    kind: kind,
    symbol: symbol || undefined,
    path: loc && loc.path,
    line: loc && loc.lineIndex,
    column: loc && loc.column,
  }, extra || {});
  return Promise.resolve(window.kakapoAnalysis.query(request)).then(function (response) {
    if (typeof analysisGenerationIsCurrent === 'function' && !analysisGenerationIsCurrent(response)) return null;
    return response;
  }).catch(function () { return null; });
}
// Where the caret sits, mapped to a source (path, lineIndex). Both diff panes carry their own real line
// number; callers that need the token itself use symbolAtDiffCaret so the old side can query by name too.
function caretSourceLoc() {
  if (isSourceViewerVisible() && viewerCursor) return { path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  if (isDiffViewVisible() && diffCursor) {
    var wrap = diffWrapperByPath(diffCursor.path);
    var row = wrap ? diffRowAt(wrap, diffCursor.side, diffCursor.rowIndex) : null;
    var ln = row ? diffLineNumber(row) : null;
    if (ln != null) return { path: diffCursor.path, lineIndex: ln - 1, column: diffCursor.column, side: diffCursor.side };
  }
  return null;
}
// All word-boundary occurrences of name across embedded files, excluding the declaration line itself.
function findUsages(name, defPath, defLine) {
  var re;
  try { re = new RegExp('(^|[^A-Za-z0-9_$])' + escapeRegExp(name) + '(?![A-Za-z0-9_$])'); } catch (e) { return []; }
  var out = [];
  for (var fi = 0; fi < sourceFiles.length; fi++) {
    var f = sourceFiles[fi];
    if (!f.embedded || (typeof semanticDocumentPath === 'function' && semanticDocumentPath(f.path))) continue;
    var lines = String(f.content).split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      if (f.path === defPath && li === defLine) continue;
      if (typeof semanticCommentOnlyLine === 'function' && semanticCommentOnlyLine(lines[li])) continue;
      var m = re.exec(lines[li]);
      if (m) {
        out.push({ path: f.path, lineIndex: li, column: m.index + (m[1] ? m[1].length : 0), text: lines[li] });
        if (out.length >= 500) return out;
      }
    }
  }
  return out;
}
function openUsages(name, def) {
  var items = findUsages(name, def.path, def.lineIndex);
  if (items.length === 1) { openSourceAt(items[0].path, items[0].lineIndex, items[0].column); return; }
  if (!items.length) { showSemanticNavigationFailure('references', name); return; }
  usageItems = items;
  usageActive = 0;
  showUsages(name, items.length);
}
function openAnalysisUsages(name, locations, response, kind) {
  if (typeof semanticNavigationLocations === 'function') locations = semanticNavigationLocations(locations);
  if (!(locations || []).length) { showSemanticNavigationFailure(kind || 'references', name); return; }
  if (locations.length > 1 && typeof openSemanticPeek === 'function') {
    openSemanticPeek(name, locations, response, kind || 'references');
    return;
  }
  openAnalysisUsagesFallback(name, locations, kind || 'references');
}
function showUsages(name, count) {
  var box = document.getElementById('usages');
  var title = document.getElementById('usages-title');
  if (!box) return;
  if (title) title.textContent = count + ' usage' + (count === 1 ? '' : 's') + ' of ' + name;
  renderUsages();
  box.classList.remove('hidden');
  positionUsagesAtCaret();
}
// Anchor the usages popup just below (or above, if cramped) the live caret — source OR diff both render a
// `.code-cursor` span. No caret on screen → leave the centered overlay fallback in place.
function positionUsagesAtCaret() {
  var box = document.getElementById('usages');
  if (!box) return;
  var panel = box.querySelector('.quick-open-panel');
  if (!panel) return;
  resetUsagesAnchor(box, panel); // measure from a clean slate
  var caret = document.querySelector('#source-body .code-cursor') || document.querySelector('#diff2html-container .code-cursor');
  if (!caret) return;
  var rect = caret.getBoundingClientRect();
  if (!rect.height && !rect.width && !rect.top) return; // detached / off-layout
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
  if (!usageItems.length) { results.innerHTML = '<div class="quick-open-empty">No usages found.</div>'; return; }
  results.innerHTML = usageItems.map(function (item, index) {
    var fname = item.path.split('/').pop();
    var isTest = item.isTest || (typeof semanticTestPath === 'function' && semanticTestPath(item.path));
    return '<button type="button" class="quick-open-item usage-item' + (isTest ? ' is-test' : '') + (index === usageActive ? ' active' : '') + '" data-index="' + index + '" title="' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '">'
      + '<span class="usage-loc">' + escapeHtml(fname) + ':' + (item.lineIndex + 1) + '</span>'
      + '<span class="usage-code">' + escapeHtml(item.text.replace(/^\s+/, '').slice(0, 160)) + '</span>'
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
  closeUsages();
  openSourceAt(item.path, item.lineIndex, item.column);
}
function closeUsages() {
  var box = document.getElementById('usages');
  if (!box) return;
  box.classList.add('hidden');
  var panel = box.querySelector('.quick-open-panel');
  if (panel) resetUsagesAnchor(box, panel); // clear inline anchoring so the next open re-measures cleanly
}

function wordAtDiffCaret() {
  var symbol = symbolAtDiffCaret();
  return symbol ? symbol.name : null;
}
// Resolve the token and its real source coordinates from whichever diff pane owns the caret. The old/base
// side is intentionally supported too: the analyzer receives the explicit token, so its index fallback can
// still resolve a definition when that exact baseline line no longer exists in the working tree.
function symbolAtDiffCaret() {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return null;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  var line = diffLineNumber(row);
  if (line == null) return null;
  var text = diffLineText(row);
  var column = Math.max(0, Math.min(diffCursor.column, text.length));
  var identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  var match = null;
  while ((match = identifier.exec(text))) {
    if (column >= match.index && column <= match.index + match[0].length) {
      return {
        name: match[0],
        path: diffCursor.path,
        lineIndex: line - 1,
        column: match.index,
        side: diffCursor.side,
      };
    }
  }
  return null;
}
function goToSymbolFromDiff() {
  var symbol = symbolAtDiffCaret();
  if (!symbol) { showSemanticNavigationFailure('symbol'); return; }
  goToDefOrUsages(symbol.name, symbol);
}
function findSymbolDefinition(name) {
  const matchers = definitionMatchers(name);
  const currentPath = viewerCursor?.path || '';
  const orderedFiles = [
    ...sourceFiles.filter((file) => file.path === currentPath),
    ...sourceFiles.filter((file) => file.path !== currentPath),
  ].filter((file) => file.embedded && !(typeof semanticDocumentPath === 'function' && semanticDocumentPath(file.path)));

  for (const file of orderedFiles) {
    const lines = file.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (typeof semanticCommentOnlyLine === 'function' && semanticCommentOnlyLine(line)) continue;
      if (matchers.some((matcher) => matcher.test(line))) {
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
  return [
    new RegExp('^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + mod + '(?:class|interface|object|enum|trait|struct)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|val)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + '(?:fun|def|fn|func)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + escaped + '\\s*\\([^)]*\\)\\s*(?::\\s*[^=]+)?\\s*(?:\\{|=>)'),
    new RegExp('^\\s*' + escaped + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)'),
  ];
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
