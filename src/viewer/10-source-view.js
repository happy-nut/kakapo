function openDefaultSourceFile() {
  const isReadme = (candidate) => /^readme(\.|$)/i.test(candidate.name || '');
  const depthOf = (candidate) => (candidate.path || '').split('/').length;
  const rootReadme = sourceFiles
    .filter((candidate) => candidate.embedded && isReadme(candidate))
    .sort((a, b) => depthOf(a) - depthOf(b))[0];
  const file = sourceFiles.find((candidate) => candidate.changed && candidate.embedded)
    || rootReadme
    || sourceFiles.find((candidate) => candidate.embedded)
    || sourceFiles.find((candidate) => candidate.changed)
    || sourceFiles[0];
  if (file) {
    openSourceFile(file.path);
    return;
  }
  if (hunkTotal() > 0) setActive(0, false);
}

function sourceSelectionCitation() {
  const selection = window.getSelection();
  const sourceBody = document.getElementById('source-body');
  if (!selection || selection.isCollapsed || !sourceBody || !isSourceViewerVisible()) return null;
  if (!selection.anchorNode || !selection.focusNode) return null;
  if (!sourceBody.contains(selection.anchorNode) || !sourceBody.contains(selection.focusNode)) return null;

  const path = sourceOpenPath();
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return null;
  const rows = selectedSourceRows(selection);
  if (rows.length === 0) return null;

  const lineNumbers = rows
    .map((row) => Number(row.dataset.lineIndex || 0) + 1)
    .filter((line) => Number.isFinite(line))
    .sort((a, b) => a - b);
  const startLine = lineNumbers[0];
  const endLine = lineNumbers[lineNumbers.length - 1];
  if (!startLine || !endLine) return null;

  const selectedText = cleanSelectedSourceText(selection.toString(), rows);
  const code = selectedText || sourceLinesForRows(file, rows);
  if (!code.trim()) return null;

  const reference = path + ':' + (startLine === endLine ? String(startLine) : startLine + '-' + endLine);
  const language = file.language && file.language !== 'text' ? file.language : '';
  const fence = String.fromCharCode(96).repeat(3);
  return { reference, payload: reference + '\n\n' + fence + language + '\n' + code.replace(/\s+$/g, '') + '\n' + fence };
}

// ---- dragging past the end of the file --------------------------------------------------------------
// Drag-select downwards past the last line of a short file and the selection used to flip: instead of
// reaching the end it covered line 1 down to wherever the drag STARTED.
//
// The source view is a real <table>, and Chromium maps a point below a table to `(container, 0)` — the
// START of the scroll container, not the end of its last row. That position sorts before the anchor, so
// the browser's own selection reverses. (The diff view does not do this: diff2html is divs, and a point
// below a block maps to the end of it, which is what one expects.)
//
// Corrected AFTER the fact, on `selectionchange`, not on mousemove: the browser updates a drag selection
// in the default action of the move, which runs after listeners, so anything set during the move is
// immediately overwritten. The symptom is precise enough to key on — while a button is down, with the
// anchor inside the body, the focus has left the rows entirely — so this never touches a drag that is
// behaving.

function deepestTextNode(el, last) {
  if (!el) return null;
  var nodes = el.childNodes;
  for (var i = 0; i < nodes.length; i += 1) {
    var node = nodes[last ? nodes.length - 1 - i : i];
    if (node.nodeType === 3) return node;
    var inner = deepestTextNode(node, last);
    if (inner) return inner;
  }
  return null;
}

var sourceDragY = null;
var clampingSourceSelection = false;

function sourceRowOf(node) {
  var el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  return el && el.closest ? el.closest('.source-row') : null;
}

function clampSourceDragSelection() {
  if (clampingSourceSelection || sourceDragY === null) return;
  var body = document.getElementById('source-body');
  if (!body || body.classList.contains('empty')) return;
  var selection = window.getSelection && window.getSelection();
  if (!selection || !selection.rangeCount || !selection.anchorNode || !selection.focusNode) return;
  if (!body.contains(selection.anchorNode) || !sourceRowOf(selection.anchorNode)) return;
  if (sourceRowOf(selection.focusNode)) return;
  var rows = body.querySelectorAll('.source-row');
  if (!rows.length) return;
  var last = rows[rows.length - 1];
  var below = sourceDragY > last.getBoundingClientRect().bottom;
  var row = below ? last : rows[0];
  var cell = row.querySelector('.source-code') || row;
  var node = deepestTextNode(cell, below);
  clampingSourceSelection = true;
  try {
    if (node) selection.extend(node, below ? node.length : 0);
    else selection.extend(cell, below ? cell.childNodes.length : 0);
  } catch (e) {
    // extend() throws when there is no range to extend; there is nothing to correct in that case.
  }
  clampingSourceSelection = false;
}

document.addEventListener('mousemove', function (event) {
  sourceDragY = (event.buttons & 1) ? event.clientY : null;
}, true);
document.addEventListener('mouseup', function () { sourceDragY = null; }, true);
document.addEventListener('selectionchange', clampSourceDragSelection);

function selectedSourceRows(selection) {
  if (!selection.rangeCount) return [];
  flushSourceRows();
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  return Array.from(document.querySelectorAll('#source-body .source-row'))
    .filter((row) => ranges.some((range) => {
      try {
        return range.intersectsNode(row);
      } catch {
        return false;
      }
    }))
    .sort((a, b) => Number(a.dataset.lineIndex || 0) - Number(b.dataset.lineIndex || 0));
}

function stripLineNumberGutter(line, row) {
  if (!row) return line;
  const cell = row.querySelector('.source-code');
  const code = sourceCellText(cell).replace(/\u200b/g, '');
  if (code && code.includes(line.trim())) return line;
  if (code && line.endsWith(code)) return code;
  const lineNumber = Number(row.dataset.lineIndex || 0) + 1;
  return line.replace(new RegExp('^\\s*' + lineNumber + '\\s+'), '');
}

function cleanSelectedSourceText(text, rows) {
  const value = String(text || '').replace(/\r/g, '').replace(/\u200b/g, '');
  if (!value.trim()) return '';
  const lines = value.split('\n');
  if (lines.length < rows.length) return value.trimEnd();
  return lines.map((line, index) => stripLineNumberGutter(line, rows[index])).join('\n').trimEnd();
}

function sourceLinesForRows(file, rows) {
  const lines = sourceLinesOf(file);
  return rows
    .map((row) => lines[Number(row.dataset.lineIndex || 0)] || '')
    .join('\n')
    .trimEnd();
}

function sourceLinesOf(file) {
  if (!file) return [];
  if (file.__linesOf !== file.content || !Array.isArray(file.__lines)) {
    file.__lines = String(file.content || '').split(/\r?\n/);
    file.__linesOf = file.content;
  }
  return file.__lines;
}
function sourceBraceRanges(file) {
  if (!file || !file.embedded) return [];
  if (file.__foldBraceContent === file.content && Array.isArray(file.__foldBraceRanges)) return file.__foldBraceRanges;
  var lines = sourceLinesOf(file), stack = [], ranges = [];
  var inBlockComment = false, quote = '', escaped = false;
  for (var li = 0; li < lines.length; li++) {
    var text = lines[li];
    for (var ci = 0; ci < text.length; ci++) {
      var ch = text.charAt(ci), next = text.charAt(ci + 1);
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; ci += 1; }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '/' && next === '*') { inBlockComment = true; ci += 1; continue; }
      if (ch === '/' && next === '/') break;
      if (ch === '#' && !text.slice(0, ci).trim()) break;
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') stack.push({ line: li, column: ci });
      else if (ch === '}' && stack.length) {
        var open = stack.pop();
        if (li > open.line) ranges.push({ start: open.line, end: li, column: open.column, kind: 'block' });
      }
    }
    if (quote && quote !== '`') { quote = ''; escaped = false; }
  }
  ranges.sort(function (a, b) {
    var span = (a.end - a.start) - (b.end - b.start);
    return span || b.start - a.start;
  });
  file.__foldBraceContent = file.content;
  file.__foldBraceRanges = ranges;
  return ranges;
}
function sourceFoldHasComment(file, range) {
  if (!range || typeof reviewComments === 'undefined') return false;
  return reviewComments.some(function (comment) {
    var line = Number(comment.line) - 1;
    return comment.path === file.path && line >= range.start && line <= range.end;
  });
}
var sourceFoldServerCache;
function sourceFoldServerCacheMap() {
  if (!sourceFoldServerCache) sourceFoldServerCache = new Map();
  return sourceFoldServerCache;
}
function sourceServerFoldRanges(path) {
  if (!path) return null;
  var cached = sourceFoldServerCacheMap().get(path);
  if (cached && cached.generation === analysisGeneration()) return cached.ranges;
  if (cached && cached.pending) return null;
  sourceFoldServerCacheMap().set(path, { generation: analysisGeneration(), ranges: null, pending: true });
  Promise.resolve(queryProjectAnalysis('foldingRange', null, { path: path, lineIndex: 0, column: 0 }))
    .then(function (response) {
      if (!pageAlive()) return;
      var ranges = response && Array.isArray(response.folds) ? response.folds : null;
      if (!ranges) sourceFoldServerCacheMap().delete(path);
      else sourceFoldServerCacheMap().set(path, { generation: analysisGeneration(), ranges: ranges, pending: false });
      if (ranges && ranges.length && sourceOpenPath() === path) openSourceFile(path, false);
    }, function () {
      if (!pageAlive()) return;
      sourceFoldServerCacheMap().delete(path);
    });
  return null;
}

var semanticTokenCache;
function semanticTokenCacheMap() {
  if (!semanticTokenCache) semanticTokenCache = new Map();
  return semanticTokenCache;
}
var semanticTokenClassTable;
function semanticTokenClasses() {
  if (semanticTokenClassTable) return semanticTokenClassTable;
  semanticTokenClassTable = {
    comment: 'tok-comment',
    string: 'tok-string', character: 'tok-string',
    escapeSequence: 'tok-escape', regexp: 'tok-regexp',
    invalidEscapeSequence: 'tok-error', unresolvedReference: 'tok-error', unknown: 'tok-error',
    number: 'tok-number', formatSpecifier: 'tok-format', boolean: 'tok-literal',
    keyword: 'tok-keyword', modifier: 'tok-keyword',
    builtinType: 'tok-builtin-type', selfKeyword: 'tok-self', selfTypeKeyword: 'tok-self',
    class: 'tok-type', struct: 'tok-type', union: 'tok-type', concept: 'tok-type',
    type: 'tok-type-alias', typeAlias: 'tok-type-alias', generic: 'tok-type-alias',
    interface: 'tok-interface', enum: 'tok-enum',
    typeParameter: 'tok-typeparam', constParameter: 'tok-typeparam',
    namespace: 'tok-namespace', toolModule: 'tok-namespace',
    function: 'tok-function', method: 'tok-method', member: 'tok-method',
    macro: 'tok-macro', procMacro: 'tok-macro', macroBang: 'tok-macro',
    derive: 'tok-macro', deriveHelper: 'tok-macro',
    decorator: 'tok-decorator', attribute: 'tok-decorator', builtinAttribute: 'tok-decorator',
    property: 'tok-property', event: 'tok-property',
    variable: 'tok-variable', parameter: 'tok-parameter',
    enumMember: 'tok-constant', const: 'tok-constant', static: 'tok-global',
    lifetime: 'tok-lifetime', label: 'tok-label',
    angle: '', attributeBracket: '', brace: '', bracket: '', colon: '', comma: '', dot: '',
    parenthesis: '', punctuation: '', semicolon: '',
    operator: '', arithmetic: '', bitwise: '', comparison: '', logical: '', negation: '',
  };
  return semanticTokenClassTable;
}
var semanticModifierClassTable;
function semanticModifierClasses() {
  if (semanticModifierClassTable) return semanticModifierClassTable;
  semanticModifierClassTable = {
    static: 'tokmod-static', deprecated: 'tokmod-deprecated', mutable: 'tokmod-mutable',
    documentation: 'tokmod-documentation',
  };
  return semanticModifierClassTable;
}
function semanticTokenSpanClass(token) {
  var base = semanticTokenClasses()[token.type];
  if (!base) return base === '' ? '' : null;
  var modifiers = token.modifiers;
  if (!modifiers || !modifiers.length) return base;
  var extras = semanticModifierClasses();
  for (var i = 0; i < modifiers.length; i += 1) {
    var extra = extras[modifiers[i]];
    if (extra && base.indexOf(extra) < 0) base += ' ' + extra;
  }
  return base;
}
function semanticTokensFor(path) {
  if (!path) return null;
  var cached = semanticTokenCacheMap().get(path);
  if (cached && cached.generation === analysisGeneration()) return cached.pending ? null : cached.byLine;
  semanticTokenCacheMap().set(path, { generation: analysisGeneration(), byLine: null, pending: true });
  Promise.resolve(queryProjectAnalysis('semanticTokens', null, { path: path, lineIndex: 0, column: 0 }))
    .then(function (response) {
      if (!pageAlive()) return;
      var tokens = response && Array.isArray(response.tokens) ? response.tokens : null;
      if (!tokens || !tokens.length) { semanticTokenCacheMap().delete(path); return; }
      var byLine = new Map();
      tokens.forEach(function (token) {
        if (!semanticTokenSpanClass(token)) return;
        var row = byLine.get(token.lineIndex);
        if (!row) { row = []; byLine.set(token.lineIndex, row); }
        row.push(token);
      });
      byLine.forEach(function (row) { row.sort(function (a, b) { return a.startColumn - b.startColumn; }); });
      semanticTokenCacheMap().set(path, { generation: analysisGeneration(), byLine: byLine, pending: false });
      if (sourceOpenPath() === path) openSourceFile(path, false);
      repaintDiffSemanticTokens(path);
    }, function () {
      if (pageAlive()) semanticTokenCacheMap().delete(path);
    });
  return null;
}
function semanticTokensForFile(file) {
  if (!file || !file.path) return null;
  if ((file.language || 'text') === 'text') return null;
  if (file.size > codeInsightMaxBytes()) return null;
  return semanticTokensFor(file.path);
}

function semanticLineHtml(text, tokens, language) {
  var out = '';
  var at = 0;
  var between = function (from, to) {
    if (to <= from) return '';
    var slice = text.slice(from, to);
    if (!language || !/[\w$]/.test(slice)) return escapeHtml(slice);
    return highlightLine(slice, language);
  };
  for (var i = 0; i < tokens.length; i += 1) {
    var token = tokens[i];
    var start = token.startColumn;
    var end = start + token.length;
    if (start < at || start >= text.length) continue;
    if (end > text.length) end = text.length;
    if (end <= start) continue;
    var className = semanticTokenSpanClass(token);
    if (!className) continue;
    out += between(at, start);
    out += '<span class="' + className + '">' + escapeHtml(text.slice(start, end)) + '</span>';
    at = end;
  }
  return out + between(at, text.length);
}

function semanticSpan(className, text) {
  var span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function overlaySemanticTokens(root, tokens) {
  var entries = [];
  var at = 0;
  var walk = function (node) {
    for (var child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        var value = child.nodeValue || '';
        entries.push({ node: child, value: value, start: at });
        at += value.length;
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(root);
  for (var n = 0; n < entries.length; n += 1) {
    var entry = entries[n];
    var stop = entry.start + entry.value.length;
    var cut = entry.start;
    var fragment = null;
    for (var t = 0; t < tokens.length; t += 1) {
      var token = tokens[t];
      var from = Math.max(token.startColumn, entry.start);
      var to = Math.min(token.startColumn + token.length, stop);
      if (to <= from || from < cut) continue;
      var className = semanticTokenSpanClass(token);
      if (!className) continue;
      if (!fragment) fragment = document.createDocumentFragment();
      if (from > cut) fragment.appendChild(document.createTextNode(entry.value.slice(cut - entry.start, from - entry.start)));
      fragment.appendChild(semanticSpan(className, entry.value.slice(from - entry.start, to - entry.start)));
      cut = to;
    }
    if (!fragment) continue;
    if (cut < stop) fragment.appendChild(document.createTextNode(entry.value.slice(cut - entry.start)));
    if (entry.node.parentNode) entry.node.parentNode.replaceChild(fragment, entry.node);
  }
}

function paintDiffSemanticTokens(wrapper, oldRows, newRows) {
  var path = wrapper ? diffWrapperPathKey(wrapper) : '';
  var byLine = path ? semanticTokensForFile(sourceByPath.get(path)) : null;
  if (!byLine) return;
  for (var i = 0; i < newRows.length; i += 1) {
    var ctn = diffCellCtn(newRows[i]);
    if (!ctn || ctn.dataset.semanticPainted === '1') continue;
    var number = diffLineNumber(newRows[i]);
    if (number === null) continue;
    var tokens = byLine.get(number - 1);
    if (!tokens || !tokens.length) continue;
    var text = ctn.textContent || '';
    ctn.dataset.semanticPainted = '1';
    overlaySemanticTokens(ctn, tokens);
    var mirror = diffCellCtn(oldRows[i]);
    if (!mirror || mirror.dataset.semanticPainted === '1') continue;
    if ((mirror.textContent || '') !== text) continue;
    mirror.dataset.semanticPainted = '1';
    overlaySemanticTokens(mirror, tokens);
  }
}

function repaintDiffSemanticTokens(path) {
  var wrapper = diffWrapperByPath(path);
  var pairs = wrapper ? diffSideRowPairs(wrapper) : null;
  if (pairs) paintDiffSemanticTokens(wrapper, pairs.oldRows, pairs.newRows);
}

function sourceFoldCandidates(file) {
  if (!file || !file.embedded) return [];
  var server = sourceServerFoldRanges(file.path);
  if (!server || !server.length) return sourceBraceRanges(file);
  var lineCount = sourceLinesOf(file).length;
  return server
    .filter(function (r) { return r.endLine > r.startLine && r.startLine >= 0 && r.endLine < lineCount; })
    .map(function (r) { return { start: r.startLine, end: r.endLine, column: 0, kind: 'block' }; })
    .sort(function (a, b) { return a.start - b.start || b.end - a.end; });
}

function sourceFoldRanges(file) {
  if (!file || !file.embedded) return [];
  var folds = [];
  var importRange = findImportRange(sourceLinesOf(file));
  if (importRange && !sourceImportOpenPaths[file.path] && !sourceFoldHasComment(file, importRange)) {
    folds.push({ start: importRange.start, end: importRange.end, column: 0, kind: 'imports' });
  }
  var stored = sourceManualFoldKeys[file.path] || Object.create(null);
  var pairs = sourceFoldCandidates(file), valid = Object.create(null);
  pairs.forEach(function (pair) { valid[pair.start + ':' + pair.end] = pair; });
  Object.keys(stored).forEach(function (key) {
    var pair = valid[key];
    if (!pair || sourceFoldHasComment(file, pair)) { delete stored[key]; return; }
    folds.push(pair);
  });
  sourceManualFoldKeys[file.path] = stored;
  folds.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
  return folds.filter(function (fold, index) {
    for (var i = 0; i < index; i++) {
      if (folds[i].start <= fold.start && folds[i].end >= fold.end) return false;
    }
    return true;
  });
}
function expandSourceFoldsAt(path, lineIndex) {
  var file = sourceByPath.get(path);
  if (!file || !file.embedded) return false;
  var changed = false;
  sourceFoldRanges(file).forEach(function (fold) {
    if (lineIndex <= fold.start || lineIndex > fold.end) return;
    if (fold.kind === 'imports') sourceImportOpenPaths[path] = true;
    else {
      var stored = sourceManualFoldKeys[path] || Object.create(null);
      delete stored[fold.start + ':' + fold.end];
      sourceManualFoldKeys[path] = stored;
    }
    changed = true;
  });
  return changed;
}
function sourceFoldButtonHtml(kind, count, start, end) {
  var label = codeFoldMessage(kind, count);
  var title = codeFoldExpandTitle() + (kind === 'block' ? ' (⌘.)' : '');
  return '<button type="button" class="mc-code-fold-button source-fold-toggle" data-source-fold="1"'
    + ' data-fold-kind="' + kind + '" data-fold-count="' + count + '" data-fold-start="' + start + '" data-fold-end="' + end + '"'
    + ' data-keyhint-id="toggleFold" title="' + escapeHtml(title) + '"><span class="mc-code-fold-icon">›</span>'
    + '<span class="mc-code-fold-label">' + escapeHtml(label) + '</span></button>';
}
function repaintSourceFold(path, lineIndex, column) {
  if (!path) return;
  viewerCursor = { path: path, lineIndex: Math.max(0, Number(lineIndex) || 0), column: Math.max(0, Number(column) || 0), targetLine: -1 };
  openSourceFile(path, false);
  requestAnimationFrame(function () { revealSourceCursorWithMargin(); });
}
function openSourceFoldButton(button) {
  var path = sourceOpenPath();
  if (!path || !button) return false;
  var start = Number(button.dataset.foldStart) || 0;
  var end = Number(button.dataset.foldEnd) || start;
  if (button.dataset.foldKind === 'imports') sourceImportOpenPaths[path] = true;
  else {
    var stored = sourceManualFoldKeys[path] || Object.create(null);
    delete stored[start + ':' + end];
    sourceManualFoldKeys[path] = stored;
  }
  repaintSourceFold(path, start, 0);
  return true;
}
function toggleCurrentSourceFold() {
  if (!isSourceViewerVisible() || !viewerCursor) return false;
  var body = document.getElementById('source-body');
  if (!body || body.classList.contains('rendered-body') || isHttpFile(viewerCursor.path)) return false;
  var row = body.querySelector('.source-row[data-line-index="' + viewerCursor.lineIndex + '"]');
  var existingButton = row && row.querySelector('[data-source-fold]');
  if (existingButton) return openSourceFoldButton(existingButton);
  var file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return false;
  var pair = sourceFoldCandidates(file).filter(function (range) {
    return range.start <= viewerCursor.lineIndex && range.end >= viewerCursor.lineIndex;
  }).sort(function (a, b) { return (a.end - a.start) - (b.end - b.start); })[0];
  if (!pair) return false;
  if (sourceFoldHasComment(file, pair)) { showCaretHint(t('fold.hasComment')); return true; }
  var stored = sourceManualFoldKeys[file.path] || Object.create(null);
  stored[pair.start + ':' + pair.end] = true;
  sourceManualFoldKeys[file.path] = stored;
  repaintSourceFold(file.path, pair.start, pair.column + 1);
  return true;
}
function sourceFoldActionTarget() {
  var path = sourceOpenPath();
  if (!path || !isSourceViewerVisible()) return null;
  var file = sourceByPath.get(path);
  if (!file || !file.embedded) return null;
  return { path: path, file: file };
}
function collapseAllSourceFolds() {
  var target = sourceFoldActionTarget();
  if (!target) return false;
  var candidates = sourceFoldCandidates(target.file).filter(function (pair) {
    return !sourceFoldHasComment(target.file, pair);
  });
  if (!candidates.length) return false;
  var stored = sourceManualFoldKeys[target.path] || Object.create(null);
  candidates.forEach(function (pair) { stored[pair.start + ':' + pair.end] = true; });
  sourceManualFoldKeys[target.path] = stored;
  openSourceFile(target.path, false);
  return true;
}
function expandAllSourceFolds() {
  var target = sourceFoldActionTarget();
  if (!target) return false;
  var had = Object.keys(sourceManualFoldKeys[target.path] || {}).length > 0
    || !sourceImportOpenPaths[target.path];
  sourceManualFoldKeys[target.path] = Object.create(null);
  sourceImportOpenPaths[target.path] = true;
  if (!had) return false;
  openSourceFile(target.path, false);
  return true;
}
function collapseSourceFoldRecursively() {
  var target = sourceFoldActionTarget();
  if (!target || !viewerCursor || viewerCursor.path !== target.path) return false;
  var candidates = sourceFoldCandidates(target.file);
  var enclosing = candidates.filter(function (pair) {
    return pair.start <= viewerCursor.lineIndex && pair.end >= viewerCursor.lineIndex;
  }).sort(function (a, b) { return (a.end - a.start) - (b.end - b.start); })[0];
  if (!enclosing) return false;
  var stored = sourceManualFoldKeys[target.path] || Object.create(null);
  candidates.forEach(function (pair) {
    if (pair.start < enclosing.start || pair.end > enclosing.end) return;
    if (sourceFoldHasComment(target.file, pair)) return;
    stored[pair.start + ':' + pair.end] = true;
  });
  sourceManualFoldKeys[target.path] = stored;
  openSourceFile(target.path, false);
  return true;
}

function sourceVisibleLineIndex(lineIndex, direction) {
  var body = document.getElementById('source-body');
  if (!body) return lineIndex;
  var model = typeof sourceRowModel !== 'undefined' && sourceRowModel && sourceRowModel.path === sourceOpenPath()
    ? sourceRowModel.rowStarts
    : (typeof sourceFill !== 'undefined' && sourceFill ? sourceFill.rowStarts : null);
  var indices = model || Array.prototype.map.call(body.querySelectorAll('.source-row[data-line-index]'), function (row) {
    return Number(row.dataset.lineIndex);
  }).filter(function (line) { return Number.isFinite(line); });
  if (!indices.length) return lineIndex;
  var at = indices.indexOf(lineIndex), step = direction < 0 ? -1 : 1;
  if (at < 0) {
    for (var i = 0; i < indices.length; i++) {
      if (indices[i] > lineIndex) return direction < 0 ? (indices[i - 1] == null ? indices[0] : indices[i - 1]) : indices[i];
    }
    return indices[indices.length - 1];
  }
  return indices[Math.max(0, Math.min(indices.length - 1, at + step))];
}

function handleSourceClick(event) {
  const target = event.target;
  const blameEntry = target?.closest?.('[data-blame-sha]');
  if (blameEntry) {
    event.preventDefault();
    event.stopPropagation();
    if (window.__kakapoHistory && typeof window.__kakapoHistory.openCommit === 'function') {
      window.__kakapoHistory.openCommit(blameEntry.dataset.blameSha, blameEntry.dataset.blamePath || '');
    }
    return;
  }
  const foldButton = target?.closest?.('[data-source-fold]');
  if (foldButton) {
    event.preventDefault();
    openSourceFoldButton(foldButton);
    return;
  }
  const runBtn = target?.closest?.('.http-run');
  if (runBtn) {
    event.preventDefault();
    runHttpRequest(Number(runBtn.dataset.req));
    return;
  }
  const respToggle = target?.closest?.('.http-resp-toggle');
  if (respToggle) {
    event.preventDefault();
    const panel = respToggle.closest('.http-response')?.querySelector('.http-resp-headers');
    if (panel) panel.classList.toggle('hidden');
    return;
  }
  if (Number(event.detail) > 1) return;
  if (selectedText()) return;
  const row = target?.closest?.('.source-row');
  if (!row) return;
  clearTreeFocus();
  const path = sourceOpenPath();
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const lineIndex = Number(row.dataset.lineIndex || 0);
  const lines = sourceLinesOf(file);
  const line = lines[lineIndex] || '';
  const codeCell = row.querySelector('.source-code');
  const column = estimateColumnFromClick(codeCell, event, line);
  setSourceCursor(path, lineIndex, column, false, -1);
  if (event.metaKey || event.ctrlKey) { event.preventDefault(); goToDefinitionUnderCursor(); }
}

var cmdLinkEl = null;
var cmdLinkKey = '';
function hideCmdLink() {
  cmdLinkKey = '';
  if (cmdLinkEl) cmdLinkEl.classList.remove('show');
  document.body.classList.remove('cmd-link-active');
}
function wordRangeFromPoint(x, y) {
  var caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  var node = caret && caret.startContainer;
  if (!node || node.nodeType !== 3) return null;
  var text = node.data || '';
  var isWord = function (ch) { return /[A-Za-z0-9_$]/.test(ch); };
  var start = Math.min(caret.startOffset, text.length);
  var end = start;
  while (start > 0 && isWord(text.charAt(start - 1))) start -= 1;
  while (end < text.length && isWord(text.charAt(end))) end += 1;
  if (end <= start) return null;
  var range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}
function updateCmdLink(event) {
  if (!(event.metaKey || event.ctrlKey) || !isSourceViewerVisible()) { hideCmdLink(); return; }
  var cell = event.target && event.target.closest ? event.target.closest('.source-code') : null;
  if (!cell) { hideCmdLink(); return; }
  var range = wordRangeFromPoint(event.clientX, event.clientY);
  if (!range) { hideCmdLink(); return; }
  var rect = range.getBoundingClientRect();
  if (!rect.width) { hideCmdLink(); return; }
  var key = Math.round(rect.left) + ':' + Math.round(rect.top) + ':' + Math.round(rect.width);
  document.body.classList.add('cmd-link-active');
  if (key === cmdLinkKey) return;
  cmdLinkKey = key;
  if (!cmdLinkEl) {
    cmdLinkEl = document.createElement('div');
    cmdLinkEl.className = 'mc-cmd-link';
    document.body.appendChild(cmdLinkEl);
  }
  cmdLinkEl.style.left = Math.round(rect.left) + 'px';
  cmdLinkEl.style.top = Math.round(rect.bottom) + 'px';
  cmdLinkEl.style.width = Math.round(rect.width) + 'px';
  cmdLinkEl.classList.add('show');
}

function handleSourceDoubleClick(event) {
  const target = event.target;
  const codeCell = target?.closest?.('.source-code');
  const row = codeCell?.closest?.('.source-row');
  if (!codeCell || !row) return;
  const path = sourceOpenPath();
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  const lineIndex = Number(row.dataset.lineIndex || 0);
  const line = sourceLinesOf(file)[lineIndex] || '';
  const column = estimateColumnFromClick(codeCell, event, line);
  if (selectCodeWord(codeCell, line, column)) event.preventDefault();
}

function estimateColumnFromClick(codeCell, event, line) {
  if (!codeCell) return 0;
  if (codeCell.closest('.source-body.line-wrap')) {
    var point = null;
    if (document.caretPositionFromPoint) point = document.caretPositionFromPoint(event.clientX, event.clientY);
    else if (document.caretRangeFromPoint) {
      var pointRange = document.caretRangeFromPoint(event.clientX, event.clientY);
      if (pointRange) point = { offsetNode: pointRange.startContainer, offset: pointRange.startOffset };
    }
    if (point && codeCell.contains(point.offsetNode)) {
      try {
        return Math.max(0, Math.min(line.length,
          sourceTextLengthBefore(codeCell, point.offsetNode, point.offset)));
      } catch (e) {}
    }
  }
  const rect = codeCell.getBoundingClientRect();
  const style = getComputedStyle(codeCell);
  const paddingLeft = Number.parseFloat(style.paddingLeft || '0') || 0;
  const x = event.clientX - rect.left - paddingLeft;
  const width = measuredCharWidth || measureCharWidth(codeCell);
  const column = Math.round(x / Math.max(width, 1));
  return Math.max(0, Math.min(line.length, column));
}

function measureCharWidth(element) {
  const probe = document.createElement('span');
  probe.textContent = 'mmmmmmmmmm';
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'pre';
  probe.style.font = getComputedStyle(element).font;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  measuredCharWidth = width || 7;
  return measuredCharWidth;
}

var caretBusyTimer = null;
function markCaretBusy() {
  document.body.classList.add('caret-busy');
  if (caretBusyTimer) clearTimeout(caretBusyTimer);
  caretBusyTimer = setTimeout(function () { document.body.classList.remove('caret-busy'); }, 650);
}

function setSourceCursor(path, lineIndex, column, shouldReveal = false, targetLine = -1) {
  markCaretBusy();
  clearSelectedDiffFold();
  selectedCommentRow = null;
  const file = sourceByPath.get(path);
  if (!file || !file.embedded) return;
  flashReviewPanelFocus(document.getElementById('source-body'));
  const lines = sourceLinesOf(file);
  const boundedLine = Math.max(0, Math.min(lineIndex, Math.max(lines.length - 1, 0)));
  const boundedColumn = Math.max(0, Math.min(column, (lines[boundedLine] || '').length));
  const unfolded = expandSourceFoldsAt(path, boundedLine);

  const prev = viewerCursor;
  const sameFileOpen = !unfolded && Boolean(sourceOpenPath() === path && isSourceViewerVisible()
    && prev && prev.path === path && !isHttpFile(path) && sourceBodyPath === path);

  viewerCursor = { path, lineIndex: boundedLine, column: boundedColumn, targetLine };

  if (sameFileOpen) {
    if (shouldReveal) scheduleSourceReveal(prev);
    else updateSourceCaret(prev, lines, file.language || 'text');
  } else {
    const shouldSwitch = sourceOpenPath() !== path || !isSourceViewerVisible();
    openSourceFile(path, shouldSwitch);
    if (shouldReveal) scheduleScrollIntoView(document.querySelector('.source-row.cursor-line'), document.getElementById('source-body'), 0.15);
  }
  recordNav(navEntryOf('source'));
  refreshFocusMode();
  scheduleStickyLines();
}
var sourceRevealRaf = 0, sourceRevealPrev = null;
var _srcRowH = 0;
function sourceRowHeight() {
  if (_srcRowH > 0) return _srcRowH;
  var r = document.querySelector('#source-body .source-row');
  if (r) { var h = r.offsetHeight; if (h > 0) _srcRowH = h; }
  return _srcRowH;
}
if (typeof window !== 'undefined') window.addEventListener('resize', function () { _srcRowH = 0; });
function scheduleSourceReveal(prev) {
  if (!sourceRevealRaf) sourceRevealPrev = prev;
  if (sourceRevealRaf) return;
  sourceRevealRaf = requestAnimationFrame(function () {
    sourceRevealRaf = 0;
    var p = sourceRevealPrev; sourceRevealPrev = null;
    var f = sourceByPath.get(viewerCursor.path);
    if (!f || !f.embedded) return;
    var lines = f.content.split(/\r?\n/);
    updateSourceCaret(p, lines, f.language || 'text');
    var sb = document.getElementById('source-body');
    var rowH = sourceRowHeight();
    if (rowH > 0 && sb && !sb.classList.contains('rendered-body') && !sb.classList.contains('line-wrap')) {
      if (sb.querySelector('.mc-comment-row, .http-response, .source-fold-row, .source-block-folded')) revealSourceCursorWithMargin();
      else {
        var caretTop = viewerCursor.lineIndex * rowH;
        var ch = sb.clientHeight;
        var margin = Math.round(ch * 0.15);
        var vTop = sb.scrollTop;
        if (caretTop < vTop + margin) sb.scrollTop = Math.max(0, caretTop - margin);
        else if (caretTop + rowH > vTop + ch - margin) sb.scrollTop = caretTop + rowH - ch + margin;
        revealCaretColumn(sb.querySelector('.code-cursor'));
      }
    } else {
      revealSourceCursorWithMargin();
    }
  });
}

function revealSourceCursorWithMargin() {
  var body = document.getElementById('source-body');
  if (!body || !viewerCursor) return;
  var row = body.querySelector('.source-row[data-line-index="' + viewerCursor.lineIndex + '"]')
    || body.querySelector('.source-row.cursor-line');
  scrolloffReveal(row, body, 0.15);
  revealCaretColumn(body.querySelector('.code-cursor'));
}

function updateSourceCaret(prev, lines, language) {
  const body = document.getElementById('source-body');
  if (!body) return;
  const rendered = body.classList.contains('rendered-body');
  const rowFor = (idx) => body.querySelector('.source-row[data-line-index="' + idx + '"]');
  if (prev && prev.lineIndex !== viewerCursor.lineIndex) {
    const prevRow = rowFor(prev.lineIndex);
    if (prevRow) prevRow.classList.remove('cursor-line');
  }
  if (!rendered) body.querySelectorAll('.code-cursor').forEach((s) => { const p = s.parentNode; if (p) { p.removeChild(s); if (p.normalize) p.normalize(); } });
  body.querySelectorAll('.source-row.symbol-target').forEach((r) => r.classList.remove('symbol-target'));
  if (viewerCursor.targetLine >= 0) rowFor(viewerCursor.targetLine)?.classList.add('symbol-target');
  const row = rowFor(viewerCursor.lineIndex);
  if (!row) { if (!rendered) openSourceFile(viewerCursor.path, false); return; }
  row.classList.add('cursor-line');
  if (!rendered) insertSourceCaret(row, viewerCursor.column);
}
function insertSourceCaret(row, column) {
  var cell = row.querySelector('.source-code');
  if (!cell) return;
  var pos = row.classList.contains('source-fold-row')
    ? { node: cell, offset: 0 }
    : diffCaretDomPosition(cell, column);
  if (!pos) return;
  var span = document.createElement('span');
  span.className = 'code-cursor';
  span.setAttribute('aria-hidden', 'true');
  if ((cell.textContent || '').length === 0) {
    span.classList.add('code-cursor-empty');
    cell.appendChild(span);
    return;
  }
  try {
    var off = pos.node.nodeType === 3 ? Math.min(pos.offset, (pos.node.textContent || '').length) : pos.offset;
    var range = document.createRange();
    range.setStart(pos.node, off); range.collapse(true);
    range.insertNode(span);
  } catch (e) {}
}

function openSourceAt(path, lineIndex, column) {
  var file = sourceByPath.get(path);
  if (!file) {
    loadLibrarySourceFile(path).then(function (record) {
      if (!record) { reportLibraryMiss(path); return; }
      openSourceFile(path);
      loadSourceFile(path).then(function () { setSourceCursor(path, lineIndex, column, true, lineIndex); });
    });
    return;
  }
  if (!sourceContentLoaded(file)) {
    openSourceFile(path);
    loadSourceFile(path).then(function () { setSourceCursor(path, lineIndex, column, true, lineIndex); });
    return;
  }
  setSourceCursor(path, lineIndex, column, true, lineIndex);
}

function isSourceViewerVisible() {
  const viewer = document.getElementById('source-viewer');
  return Boolean(viewer && !viewer.classList.contains('hidden'));
}

function selectAllInView() {
  var target = null;
  if (isSourceViewerVisible()) {
    flushSourceRows();
    target = document.getElementById('source-body');
  } else if (isDiffViewVisible()) {
    target = document.querySelector('#diff2html-container .d2h-file-wrapper:not(.df-inactive)') || document.getElementById('diff2html-container');
  }
  if (!target) return false;
  try {
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) { return false; }
  return true;
}

function openDiffFileAtCaret() {
  if (diffCursor && isDiffViewVisible()) {
    const dwrap = diffWrapperByPath(diffCursor.path);
    const drow = dwrap ? diffRowAt(dwrap, diffCursor.side, diffCursor.rowIndex) : null;
    const dline = drow ? diffLineNumber(drow) : null;
    if (sourceByPath.has(diffCursor.path)) { setSourceCursor(diffCursor.path, dline != null ? dline - 1 : 0, 0, true, -1); return; }
    openSourceFile(diffCursor.path); return;
  }
  const sel = window.getSelection();
  const node = sel && sel.anchorNode;
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  const wrapper = (el && el.closest && el.closest('.d2h-file-wrapper')) || document.querySelector('.d2h-file-wrapper:not(.df-inactive)');
  if (!wrapper) return;
  const fileName = diffWrapperPathKey(wrapper);
  if (!fileName) return;
  if (!sourceByPath.has(fileName)) { openSourceFile(fileName); return; }
  let lineIndex = 0;
  const lineEl = el && el.closest && el.closest('.d2h-code-side-line');
  if (lineEl) {
    const row = lineEl.closest('tr');
    const numEl = row && row.querySelector('.d2h-code-side-linenumber');
    const num = numEl ? parseInt((numEl.textContent || '').trim(), 10) : NaN;
    if (Number.isFinite(num)) lineIndex = Math.max(0, num - 1);
  }
  setSourceCursor(fileName, lineIndex, 0, true, -1);
}

function commentRowSiblingOf(lineIndex, dir) {
  var cur = document.querySelector('#source-body .source-row[data-line-index="' + lineIndex + '"]');
  if (!cur) return null;
  var sib = dir < 0 ? cur.previousElementSibling : cur.nextElementSibling;
  return (sib && sib.classList && sib.classList.contains('mc-comment-row')) ? sib : null;
}
function commentCardsIn(row) {
  if (!row) return [];
  return Array.prototype.slice.call(row.querySelectorAll('.mc-card')).filter(function (card) {
    return !card.classList.contains('mc-composer');
  });
}
function enterSelectedCommentCard() {
  return false;
}
function markSelectedCard(card) {
  document.querySelectorAll('.mc-card-selected').forEach(function (el) { el.classList.remove('mc-card-selected'); });
  if (card) card.classList.add('mc-card-selected');
}
function selectedCommentCard() {
  return selectedCommentRow ? selectedCommentRow.querySelector('.mc-card-selected') : null;
}
function stepSelectedCommentCard(dir) {
  var cards = commentCardsIn(selectedCommentRow);
  if (cards.length < 2) return false;
  var at = cards.indexOf(selectedCommentCard());
  var next = at + (dir < 0 ? -1 : 1);
  if (at < 0 || next < 0 || next >= cards.length) return false;
  markSelectedCard(cards[next]);
  if (cards[next].scrollIntoView) { try { cards[next].scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  return true;
}
function selectCommentRow(row, fromBelow) {
  clearSelectedDiffFold();
  if (selectedCommentRow && selectedCommentRow !== row) selectedCommentRow.classList.remove('mc-row-selected');
  selectedCommentRow = row || null;
  if (!selectedCommentRow) { markSelectedCard(null); return; }
  selectedCommentRow.classList.add('mc-row-selected');
  var cards = commentCardsIn(selectedCommentRow);
  markSelectedCard(fromBelow ? cards[cards.length - 1] : cards[0]);
}
function handleSelectedCommentRowKey(event, stepOntoRow, restoreCaret) {
  if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); deleteCommentsInRow(selectedCommentRow); return true; }
  if (event.code === 'KeyE' || event.key === 'e' || event.key === 'E') { event.preventDefault(); editCommentInRow(selectedCommentRow); return true; }
  if (event.key === 'Enter' && enterSelectedCommentCard()) { event.preventDefault(); return true; }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Escape') {
    var dir = event.key === 'ArrowUp' ? -1 : (event.key === 'ArrowDown' ? 1 : 0);
    if (dir && stepSelectedCommentCard(dir)) { event.preventDefault(); return true; }
    var sib = dir < 0 ? selectedCommentRow.previousElementSibling : (dir > 0 ? selectedCommentRow.nextElementSibling : null);
    clearCommentRowSelection();
    event.preventDefault();
    var landed = false;
    while (sib && !landed) {
      landed = stepOntoRow(sib);
      if (!landed) sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
    }
    if (!landed) restoreCaret();
    return true;
  }
  return false;
}
function clearCommentRowSelection() {
  if (selectedCommentRow) selectedCommentRow.classList.remove('mc-row-selected');
  selectedCommentRow = null;
  markSelectedCard(null);
}
function deleteCommentsInRow(row) {
  if (!row) return;
  var card = selectedCommentCard() || commentCardsIn(row)[0];
  var del = card ? card.querySelector('.mc-del') : null;
  if (!del) return;
  clearCommentRowSelection();
  var seq = parseInt(del.dataset.seq, 10);
  if (isFinite(seq)) deleteComment(seq);
}
function editCommentInRow(row) {
  if (!row) return;
  var card = selectedCommentCard() || commentCardsIn(row)[0];
  if (card && card.classList.contains('mc-ai')) return;
  var del = card ? card.querySelector('.mc-del') : null;
  if (!del) return;
  var seq = parseInt(del.dataset.seq, 10);
  var c = reviewComments.find(function (x) { return x.seq === seq; });
  if (!c) return;
  clearCommentRowSelection();
  composerState = {
    kind: c.kind, path: c.path, line: c.line, code: c.code, anchorCode: c.anchorCode,
    from: c.from, to: c.to, side: c.side, replyTo: c.replyTo == null ? null : c.replyTo,
    editSeq: seq, editText: c.text,
  };
  refreshComments();
}
function handleSourceCaretKey(event) {
  if (!viewerCursor) return false;
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return false;
  const extend = event.shiftKey;
  if (selectedCommentRow) {
    return handleSelectedCommentRowKey(event, function (sib) {
      if (!sib.classList || !sib.classList.contains('source-row')) return false;
      var li = parseInt(sib.dataset.lineIndex, 10);
      if (!isFinite(li)) return false;
      setSourceCursor(viewerCursor.path, li, 0, true, -1);
      return true;
    }, function () {
      setSourceCursor(viewerCursor.path, viewerCursor.lineIndex, viewerCursor.column, false, -1);
    });
  }
  if (!extend && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    var box = commentRowSiblingOf(viewerCursor.lineIndex, event.key === 'ArrowUp' ? -1 : 1);
    if (box) { event.preventDefault(); selectCommentRow(box, event.key === 'ArrowUp'); return true; }
  }
  if (event.key === 'ArrowDown') { event.preventDefault(); moveSourceCursor(1, 0, extend); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); moveSourceCursor(-1, 0, extend); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); moveSourceCursor(0, -1, extend); return true; }
  if (event.key === 'ArrowRight') { event.preventDefault(); moveSourceCursor(0, 1, extend); return true; }
  return false;
}

function moveSourceCursor(dLine, dColumn, extend) {
  if (!viewerCursor) return;
  const file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return;
  const renderedBody = document.getElementById('source-body');
  if (renderedBody && renderedBody.classList.contains('rendered-body')) {
    const rows = Array.from(renderedBody.querySelectorAll('.source-row'));
    if (!rows.length) return;
    let ci = rows.indexOf(renderedBody.querySelector('.source-row[data-line-index="' + viewerCursor.lineIndex + '"]'));
    if (ci < 0) ci = 0;
    const step = (dLine || 0) + (dColumn > 0 ? 1 : dColumn < 0 ? -1 : 0);
    const ni = Math.max(0, Math.min(rows.length - 1, ci + (step || 0)));
    selectionAnchor = null;
    setSourceCursor(viewerCursor.path, Number(rows[ni].dataset.lineIndex) || 0, 0, true, -1);
    return;
  }
  const lines = sourceLinesOf(file);
  let line = viewerCursor.lineIndex;
  let col = viewerCursor.column;
  if (dColumn < 0) {
    if (col > 0) col -= 1;
    else if (line > 0) { line = sourceVisibleLineIndex(line, -1); col = (lines[line] || '').length; }
  } else if (dColumn > 0) {
    if (col < (lines[line] || '').length) col += 1;
    else if (line < lines.length - 1) { line = sourceVisibleLineIndex(line, 1); col = 0; }
  }
  if (dLine !== 0) {
    line = sourceVisibleLineIndex(line, dLine);
    col = Math.min(col, (lines[line] || '').length);
  }
  if (extend) {
    if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  } else {
    selectionAnchor = null;
  }
  setSourceCursor(viewerCursor.path, line, col, true, -1);
  applySourceSelection();
}
function nextWordBoundary(text, col, dir) {
  var classOf = function (ch) {
    if (ch === '' || /\s/.test(ch)) return 0;
    if (/[A-Za-z0-9_$]/.test(ch)) return 1;
    return 2;
  };
  var i = col;
  if (dir > 0) {
    while (i < text.length && classOf(text.charAt(i)) === 0) i++;
    var cf = classOf(text.charAt(i));
    if (cf !== 0) { while (i < text.length && classOf(text.charAt(i)) === cf) i++; }
  } else {
    i--;
    while (i > 0 && classOf(text.charAt(i)) === 0) i--;
    var cb = classOf(text.charAt(i));
    while (i > 0 && classOf(text.charAt(i - 1)) === cb) i--;
    if (i < 0) i = 0;
  }
  return i;
}
function moveSourceWord(dir, extend) {
  if (!viewerCursor) return;
  var file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return;
  var lines = sourceLinesOf(file);
  var line = viewerCursor.lineIndex, col = viewerCursor.column;
  var text = lines[line] || '';
  if (dir > 0) {
    var fwd = nextWordBoundary(text, col, 1);
    if (fwd > col) { col = fwd; }
    else if (line < lines.length - 1) { line += 1; var nt = lines[line] || ''; col = nextWordBoundary(nt, 0, 1); }
    else { col = text.length; }
  } else {
    var back = nextWordBoundary(text, col, -1);
    if (back < col && /\S/.test(text.charAt(back))) { col = back; }
    else if (line > 0) { line -= 1; var pt = lines[line] || ''; col = pt.length > 0 ? nextWordBoundary(pt, pt.length, -1) : 0; }
    else { col = back; }
  }
  if (extend) { if (!selectionAnchor) selectionAnchor = { lineIndex: viewerCursor.lineIndex, column: viewerCursor.column }; }
  else selectionAnchor = null;
  setSourceCursor(viewerCursor.path, line, col, true, -1);
  applySourceSelection();
}

function applySourceSelection() {
  const sel = window.getSelection();
  if (!sel) return;
  if (!selectionAnchor || !viewerCursor) { sel.removeAllRanges(); return; }
  const a = caretDomPosition(selectionAnchor.lineIndex, selectionAnchor.column);
  const c = caretDomPosition(viewerCursor.lineIndex, viewerCursor.column);
  if (a && c) {
    try { sel.setBaseAndExtent(a.node, a.offset, c.node, c.offset); } catch (e) {}
  }
}

function sourceTextWalker(cell) {
  return document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      var parent = node.parentNode;
      return parent && parent.closest && parent.closest('.inlay-hint, .mc-code-fold-button')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
}

function sourceCellText(cell) {
  if (!cell) return '';
  const walker = sourceTextWalker(cell);
  let out = '';
  let node;
  while ((node = walker.nextNode())) out += node.textContent;
  return out;
}

function sourceTextLengthBefore(cell, node, offset) {
  const walker = sourceTextWalker(cell);
  let seen = 0;
  let current;
  while ((current = walker.nextNode())) {
    if (current === node) return seen + offset;
    seen += current.textContent.length;
  }
  return seen;
}

function caretDomPosition(lineIndex, column) {
  const cell = document.querySelector('.source-row[data-line-index="' + lineIndex + '"] .source-code');
  if (!cell) return null;
  let remaining = column;
  const walker = sourceTextWalker(cell);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
  }
  return { node: cell, offset: cell.childNodes.length };
}

function setSourceTypeIcon(path) {
  var holder = document.getElementById('source-type-icon');
  if (!holder) return;
  var link = sourceLinks.find(function (l) { return l.dataset.sourceFile === path; });
  var icon = link ? link.querySelector('.ftype') : null;
  holder.innerHTML = icon ? icon.outerHTML : '';
}
function addSourceTab(path) { if (path && sourceTabs.indexOf(path) < 0) sourceTabs.push(path); }
function sourceTabLabel(path) { var p = String(path || ''); var s = p.lastIndexOf('/'); return s >= 0 ? p.slice(s + 1) : p; }

function openLibraryOnWeb(path) {
  var p = String(path || '');
  if (!/^https?:\/\//i.test(p)) return false;
  try { window.open(p, '_blank', 'noopener'); } catch (e) {}
  showCaretHint(t('source.libraryOnWeb').replace('{file}', function () { return sourceTabLabel(p); }));
  return true;
}

function reportLibraryMiss(path) {
  var p = String(path || '');
  if (openLibraryOnWeb(p)) return;
  var put = function (key) { showCaretHint(t(key).replace('{file}', function () { return sourceTabLabel(p); })); };
  if (p.indexOf('!/') >= 0 || /\.(phar|jar|zip|apk|aar)\//i.test(p)) { put('source.libraryInArchive'); return; }
  put('source.libraryUnavailable');
}
function sourceTabMenuLabel(path) {
  var p = String(path || ''), name = sourceTabLabel(p), slash = p.lastIndexOf('/');
  return slash > 0 ? name + '  —  ' + p.slice(0, slash) : name;
}
var sourceTabOverflowPaths = [];
var sourceTabOverflowRaf = 0;
var sourceTabResizeObserver = null;

function sourceTabElementWidth(element, fallback) {
  if (!element) return fallback || 0;
  var rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
  return Math.ceil((rect && rect.width) || element.offsetWidth || fallback || 0);
}

function syncSourceTabOverflow(activePath) {
  sourceTabOverflowRaf = 0;
  var bar = document.getElementById('source-tabs');
  if (!bar || bar.classList.contains('hidden')) return;
  var tabs = Array.prototype.slice.call(bar.querySelectorAll('.source-tab'));
  var overflow = bar.querySelector('.source-tab-overflow');
  if (!overflow) return;
  tabs.forEach(function (tab) { tab.classList.remove('source-tab-overflowed'); });
  overflow.classList.add('hidden');
  bar.classList.remove('tabs-overflowing');
  sourceTabOverflowPaths = [];
  if (tabs.length < 2 || !bar.clientWidth) return;

  var style = window.getComputedStyle ? window.getComputedStyle(bar) : null;
  var padding = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 0;
  var gap = style ? (parseFloat(style.columnGap || style.gap) || 0) : 1;
  var available = Math.max(0, bar.clientWidth - padding);
  var widths = tabs.map(function (tab) { return sourceTabElementWidth(tab, 120); });
  var total = widths.reduce(function (sum, width) { return sum + width; }, 0) + gap * Math.max(0, tabs.length - 1);
  if (total <= available) return;

  var overflowWidth = sourceTabElementWidth(overflow, 44);
  var tabBudget = Math.max(0, available - overflowWidth - gap);
  var visible = new Set();
  var activeIndex = tabs.findIndex(function (tab) { return tab.getAttribute('data-tab-path') === activePath; });
  var used = 0;
  if (activeIndex >= 0) {
    visible.add(activeIndex);
    used = widths[activeIndex];
  }
  tabs.forEach(function (_tab, index) {
    if (visible.has(index)) return;
    var next = widths[index] + (visible.size ? gap : 0);
    if (used + next <= tabBudget) {
      visible.add(index);
      used += next;
    }
  });
  if (!visible.size && tabs.length) visible.add(activeIndex >= 0 ? activeIndex : 0);

  tabs.forEach(function (tab, index) {
    var hidden = !visible.has(index);
    tab.classList.toggle('source-tab-overflowed', hidden);
    if (hidden) sourceTabOverflowPaths.push(tab.getAttribute('data-tab-path') || '');
  });
  sourceTabOverflowPaths = sourceTabOverflowPaths.filter(Boolean);
  if (!sourceTabOverflowPaths.length) return;
  overflow.textContent = sourceTabOverflowPaths.length + '+';
  var hiddenTabs = t('source.hiddenTabs', { count: sourceTabOverflowPaths.length });
  overflow.setAttribute('aria-label', hiddenTabs);
  overflow.setAttribute('title', hiddenTabs);
  overflow.classList.remove('hidden');
  bar.classList.add('tabs-overflowing');
}

function scheduleSourceTabOverflow(activePath) {
  if (sourceTabOverflowRaf) cancelAnimationFrame(sourceTabOverflowRaf);
  sourceTabOverflowRaf = requestAnimationFrame(function () {
    syncSourceTabOverflow(activePath || sourceOpenPath());
  });
}

function observeSourceTabWidth(bar) {
  if (!bar || sourceTabResizeObserver || typeof ResizeObserver !== 'function') return;
  sourceTabResizeObserver = new ResizeObserver(function () { scheduleSourceTabOverflow(sourceOpenPath()); });
  sourceTabResizeObserver.observe(bar);
}

function showSourceTabOverflowMenu(button) {
  if (!button || !sourceTabOverflowPaths.length) return;
  var rect = button.getBoundingClientRect();
  showCustomDropdown(Math.max(8, rect.right - 280), rect.bottom + 4, sourceTabOverflowPaths.map(function (path) {
    return { label: sourceTabMenuLabel(path), onSelect: function () { openSourceFile(path); } };
  }), rect.top - 4, 'source-tab-overflow-menu', button);
}

function syncSourceTreeActive() {
  var openPath = sourceOpenPath();
  document.querySelectorAll('.source-link').forEach(function (link) {
    link.classList.toggle('active', !!openPath && link.dataset.sourceFile === openPath);
  });
}
function renderSourceTabs(activePath) {
  syncSourceTreeActive();
  var bar = document.getElementById('source-tabs');
  if (!bar) return;
  if (sourceTabs.length < 2) {
    bar.classList.add('hidden'); bar.innerHTML = ''; sourceTabOverflowPaths = [];
    return;
  }
  bar.classList.remove('hidden');
  bar.innerHTML = sourceTabs.map(function (p) {
    var active = p === activePath;
    var scope = projectScopeOf(p);
    return '<div class="source-tab' + (active ? ' active' : '')
      + (scope === 'test' ? ' is-test-file' : scope === 'generated' ? ' is-generated-file' : '')
      + '" data-tab-path="' + escapeHtml(p) + '" title="' + escapeHtml(p) + '">'
      + '<span class="source-tab-name">' + escapeHtml(sourceTabLabel(p)) + '</span>'
      + '<button type="button" class="source-tab-close" data-keyhint-id="closeTab" data-close-path="' + escapeHtml(p) + '" aria-label="Close tab" data-i18n-title="tab.close" title="Close">×</button>'
      + '</div>';
  }).join('')
    + '<button type="button" class="source-tab-overflow hidden" aria-haspopup="menu"></button>';
  try { applyKeyHints(bar); } catch (e) {}
  observeSourceTabWidth(bar);
  scheduleSourceTabOverflow(activePath);
}
function closeSourceTab(path) {
  var idx = sourceTabs.indexOf(path);
  if (idx < 0) return;
  var wasActive = path === sourceOpenPath();
  sourceTabs.splice(idx, 1);
  if (!wasActive) { renderSourceTabs(sourceOpenPath()); return; }
  var nextPath = sourceTabs[idx] || sourceTabs[idx - 1] || '';
  if (nextPath) { openSourceFile(nextPath); return; }
  var v = document.getElementById('source-viewer'); if (v) v.dataset.openPath = '';
  var body = document.getElementById('source-body');
  var title = document.getElementById('source-title');
  var meta = document.getElementById('source-meta');
  if (title) { title.setAttribute('data-i18n', 'source.title'); title.textContent = t('source.title'); }
  if (meta) { meta.setAttribute('data-i18n', 'source.selectFile'); meta.textContent = t('source.selectFile'); }
  if (body) { body.setAttribute('data-i18n', 'source.selectFile'); setPanelClassNamePreservingFocus(body, 'source-body empty'); body.textContent = t('source.selectFile'); }
  sourceLinks.forEach(function (l) { l.classList.remove('active'); });
  renderSourceTabs('');
}
function closeActiveSourceTab() { var p = sourceOpenPath(); if (p) { closeSourceTab(p); return true; } return false; }
function cycleSourceTab(dir) {
  if (sourceTabs.length < 2) return;
  var cur = sourceTabs.indexOf(sourceOpenPath());
  if (cur < 0) cur = 0;
  openSourceFile(sourceTabs[(cur + dir + sourceTabs.length) % sourceTabs.length]);
}
window.addEventListener('resize', function () { scheduleSourceTabOverflow(sourceOpenPath()); }, { passive: true });
