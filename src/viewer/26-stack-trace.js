var STACK_TRACE_DEBOUNCE_MS = 120;

function stackIsDigitChar(ch) {
  return ch >= '0' && ch <= '9';
}
function stackIsSpaceChar(ch) {
  return ch !== '' && /\p{Zs}/u.test(ch);
}
function stackHandleSpaces(line, pos, delta) {
  for (var len = line.length; pos >= 0 && pos < len; pos += delta) {
    if (!stackIsSpaceChar(line.charAt(pos))) break;
  }
  return pos;
}
function stackTrimmedRange(line, start, end) {
  return { start: stackHandleSpaces(line, start, 1), end: stackHandleSpaces(line, end, -1) };
}
function stackLineNumberOf(text) {
  if (!text || text.length > 9 || !stackIsDigitChar(text.charAt(0))) return -1;
  if (!/^[0-9]+$/.test(text)) return -1;
  return parseInt(text, 10);
}
function stackRangeText(line, range) {
  return range.end >= range.start ? line.slice(range.start, range.end) : '';
}

function stackFrameRecord(line, reader, classFqn, method, fileName, lineNumber, column) {
  return {
    kind: 'frame',
    text: line,
    reader: reader,
    classFqn: classFqn,
    method: method,
    fileName: fileName,
    line: lineNumber,
    column: column,
  };
}

function stackFindAtPrefix(line) {
  if (line.indexOf('at ') === 0) return 0;
  var startIdx = line.indexOf(' at ');
  return startIdx < 0 ? line.indexOf('at ') : startIdx;
}
function stackFindRParenAfterLocation(line, startIdx) {
  var singleRParen = line.indexOf(')', startIdx);
  var next = singleRParen;
  while (next > -1) {
    if (next >= 1 && stackIsDigitChar(line.charAt(next - 1))) return next;
    next = line.indexOf(')', next + 1);
    if (next !== -1) singleRParen = -1;
  }
  return singleRParen;
}
function stackMethodNameCandidateBefore(line, start, end) {
  if (end < 0) return null;
  var lParenIdx = line.lastIndexOf('(', end);
  if (lParenIdx < 0) return null;
  var dotIdx = line.lastIndexOf('.', lParenIdx);
  return dotIdx >= 0 && dotIdx >= start ? { start: dotIdx + 1, end: lParenIdx } : null;
}
function stackFrameFromFileAndLine(line, reader, classRange, methodRange, fileLineStart, fileLineEnd) {
  var classFqn = stackRangeText(line, classRange);
  var method = stackRangeText(line, methodRange);
  var fileAndLine = line.slice(fileLineStart, fileLineEnd);
  if (fileAndLine === 'Native Method' || fileAndLine === 'Unknown Source') {
    return stackFrameRecord(line, reader, classFqn, method, null, -1, 0);
  }
  var colonIndex = fileAndLine.lastIndexOf(':');
  if (colonIndex < 0) return null;
  var lineNumber = stackLineNumberOf(fileAndLine.slice(colonIndex + 1));
  if (lineNumber < 0) return null;
  return stackFrameRecord(line, reader, classFqn, method, fileAndLine.slice(0, colonIndex).trim(), lineNumber, 0);
}

function parseStackTraceLine(line, searchForRParenOnlyAfterAt, reader) {
  var startIdx = stackFindAtPrefix(line);
  var rParenIdx = stackFindRParenAfterLocation(line, searchForRParenOnlyAfterAt ? startIdx : 0);
  if (rParenIdx < 0) return null;
  var methodName = stackMethodNameCandidateBefore(line, startIdx, rParenIdx);
  if (!methodName) return null;
  var lParenIdx = methodName.end;
  var dotIdx = methodName.start - 1;
  var moduleIdx = line.indexOf('/');
  var classNameIdx;
  if (moduleIdx > -1 && moduleIdx < dotIdx && line.slice(moduleIdx + 1, moduleIdx + 3) !== '0x') {
    classNameIdx = moduleIdx + 1;
    if (line.charAt(classNameIdx) === '/') classNameIdx += 1;
  } else if (startIdx >= 0) {
    classNameIdx = startIdx + 1 + 2 + (line.charAt(startIdx) === 'a' ? 0 : 1);
  } else {
    classNameIdx = line.search(/\S/);
    if (classNameIdx < 0) classNameIdx = 0;
  }
  return stackFrameFromFileAndLine(line, reader,
    { start: classNameIdx, end: stackHandleSpaces(line, dotIdx, -1) },
    stackTrimmedRange(line, methodName.start, methodName.end),
    lParenIdx + 1, rParenIdx);
}

function parseYourKitStackLine(line) {
  var lineEnd = line.length - 1;
  if (lineEnd > 0 && line.charAt(lineEnd) === '\n') lineEnd -= 1;
  if (!(lineEnd > 0 && stackIsDigitChar(line.charAt(lineEnd)))) return null;
  var spaceIndex = line.lastIndexOf(' ');
  var rParenIdx = line.lastIndexOf(')');
  if (!(rParenIdx > 0 && spaceIndex === rParenIdx + 1)) return null;
  var methodName = stackMethodNameCandidateBefore(line, 0, rParenIdx);
  if (!methodName) return null;
  return stackFrameFromFileAndLine(line, 'yourkit',
    { start: 0, end: methodName.start - 1 }, methodName, spaceIndex + 1, lineEnd + 1);
}

function parseForcedStackLine(line) {
  var dash = '- ';
  if (line.trim().indexOf(dash) !== 0) return null;
  var linePrefix = 'line=';
  var lineNumberStart = line.indexOf(linePrefix);
  if (lineNumberStart < 0) return null;
  var lineNumberEnd = line.indexOf(' ', lineNumberStart);
  if (lineNumberEnd < 0) return null;
  var methodName = stackMethodNameCandidateBefore(line, 0, lineNumberStart);
  if (!methodName) return null;
  var lineNumber = stackLineNumberOf(line.slice(lineNumberStart + linePrefix.length, lineNumberEnd));
  if (lineNumber < 0) return null;
  var classRange = stackTrimmedRange(line, line.indexOf(dash) + dash.length, methodName.start - 1);
  return stackFrameRecord(line, 'forced', stackRangeText(line, classRange), stackRangeText(line, methodName),
    null, lineNumber, 0);
}

function parseJvmStackLine(line) {
  return parseStackTraceLine(line, false, 'jvm')
    || parseYourKitStackLine(line)
    || parseForcedStackLine(line)
    || (line.charAt(0) === '|' ? parseStackTraceLine(line, true, 'lincheck') : null);
}

function stackPathLike(text) {
  if (!text || /[(),]/.test(text) || text.charAt(0) === '<') return false;
  return text.indexOf('/') >= 0 || text.indexOf('.') >= 0;
}
function stackSplitSymbol(subject) {
  var text = String(subject == null ? '' : subject).trim()
    .replace(/\s*\([^()]*\)\s*$/, '')
    .replace(/^(?:async|new)\s+/, '');
  var dot = text.lastIndexOf('.');
  return dot < 0 ? { classFqn: '', method: text } : { classFqn: text.slice(0, dot), method: text.slice(dot + 1) };
}

function parseV8StackLine(line) {
  var at = /^[ \t]*at[ \t]+(.*)$/.exec(line);
  if (at) {
    var body = at[1].replace(/\s+$/, '');
    var parens = /^(.*)\(([^()]*)\)$/.exec(body);
    var located = parens ? parens[2] : body;
    if (!parens && /\s/.test(located)) return null;
    if (!stackPathLike(located)) return null;
    var withColumn = /^(.+):(\d+):(\d+)$/.exec(located);
    if (!withColumn) return null;
    var symbol = stackSplitSymbol(parens ? parens[1] : '');
    return stackFrameRecord(line, 'v8', symbol.classFqn, symbol.method,
      withColumn[1], parseInt(withColumn[2], 10), parseInt(withColumn[3], 10));
  }
  if (!/^\S+$/.test(line)) return null;
  var bare = /^(.+):(\d+):(\d+)$/.exec(line) || /^(.+):(\d+)$/.exec(line);
  if (!bare || !stackPathLike(bare[1]) || !/\.[A-Za-z][A-Za-z0-9_]{0,7}$/.test(bare[1])) return null;
  return stackFrameRecord(line, 'v8', '', '', bare[1], parseInt(bare[2], 10), bare[3] ? parseInt(bare[3], 10) : 0);
}

function parsePythonStackLine(line) {
  var match = /^[ \t]*File[ \t]+"([^"]+)",[ \t]*line[ \t]+(\d+)(?:,[ \t]*in[ \t]+(.*?))?[ \t]*$/.exec(line);
  if (!match) return null;
  return stackFrameRecord(line, 'python', '', (match[3] || '').trim(), match[1], parseInt(match[2], 10), 0);
}

function parseGoStackLine(line) {
  var match = /^[ \t]+(\S+):(\d+)(?:[ \t]+\+0x[0-9a-fA-F]+)?[ \t]*$/.exec(line);
  if (!match || !stackPathLike(match[1])) return null;
  return stackFrameRecord(line, 'go', '', '', match[1], parseInt(match[2], 10), 0);
}

function parseRubyStackLine(line) {
  var match = /^[ \t]*(?:from[ \t]+)?(\S+):(\d+):in[ \t]+[`'](.*?)'/.exec(line);
  if (!match || !stackPathLike(match[1])) return null;
  return stackFrameRecord(line, 'ruby', '', match[3], match[1], parseInt(match[2], 10), 0);
}

function parseRustStackLine(line) {
  var match = /panicked at[ \t]+(\S+):(\d+):(\d+):?[ \t]*$/.exec(line);
  if (!match || !stackPathLike(match[1])) return null;
  return stackFrameRecord(line, 'rust', '', '', match[1], parseInt(match[2], 10), parseInt(match[3], 10));
}

function parseDotnetStackLine(line) {
  var match = /^[ \t]*at[ \t]+(.+?)[ \t]+in[ \t]+(.+):line[ \t]+(\d+)[ \t]*$/.exec(line);
  if (!match) return null;
  var symbol = stackSplitSymbol(match[1]);
  return stackFrameRecord(line, 'dotnet', symbol.classFqn, symbol.method, match[2], parseInt(match[3], 10), 0);
}

var STACK_TRACE_READERS = [
  { name: 'v8', read: parseV8StackLine },
  { name: 'jvm', read: parseJvmStackLine },
  { name: 'python', read: parsePythonStackLine },
  { name: 'go', read: parseGoStackLine },
  { name: 'ruby', read: parseRubyStackLine },
  { name: 'rust', read: parseRustStackLine },
  { name: 'dotnet', read: parseDotnetStackLine },
];

function normalizeStackTraceText(text) {
  return String(text == null ? '' : text)
    .replace(/(\S[ \t\x0B\f\r]+)(at\s+)/g, '$1\n$2')
    .replace(/(\\n|\\r|\\t)+(at\s+)/g, '\n$2');
}
function readStackTraceLines(text) {
  var out = [];
  String(text == null ? '' : text).split(/\r\n|\r|\n/).forEach(function (line) {
    if (!line.trim()) return;
    var frame = null;
    for (var i = 0; i < STACK_TRACE_READERS.length && !frame; i += 1) frame = STACK_TRACE_READERS[i].read(line);
    out.push(frame || { kind: 'text', text: line });
  });
  return out;
}
function stackTraceFrameCount(lines) {
  var n = 0;
  (lines || []).forEach(function (one) { if (one.kind === 'frame') n += 1; });
  return n;
}
function parseStackTrace(text) {
  var raw = readStackTraceLines(text);
  var normalized = readStackTraceLines(normalizeStackTraceText(text));
  return stackTraceFrameCount(normalized) > stackTraceFrameCount(raw) ? normalized : raw;
}

function stackFramePath(frame) {
  return String(frame && frame.fileName || '').replace(/^file:\/\//, '').replace(/^\.\//, '');
}
function stackPathStem(path) {
  var name = baseName(path);
  var dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
function stackClassSimpleName(frame) {
  var fqn = String(frame && frame.classFqn || '').trim();
  var simple = fqn.split('/').pop().split('.').pop();
  return simple.split('$')[0];
}
function stackSharedSuffix(path, wanted) {
  var a = String(path).split('/').filter(Boolean);
  var b = String(wanted).split('/').filter(Boolean);
  var shared = 0;
  while (shared < a.length && shared < b.length && a[a.length - 1 - shared] === b[b.length - 1 - shared]) shared += 1;
  return shared;
}
function stackPackageRun(classFqn) {
  var fqn = String(classFqn || '').trim();
  if (fqn.indexOf('.') < 0) return '';
  var parts = fqn.split('.');
  parts.pop();
  return parts.join('/') + '/';
}
function stackResolverIndex() {
  var byName = new Map();
  var byStem = new Map();
  var paths = new Set();
  allQuickItems().forEach(function (item) {
    if (!item || !item.path || paths.has(item.path)) return;
    paths.add(item.path);
    var name = baseName(item.path);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(item.path);
    var stem = stackPathStem(item.path);
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(item.path);
  });
  return { byName: byName, byStem: byStem, paths: paths, changed: reviewedPaths() };
}
function stackCandidateRank(path, wanted, packageRun, changed) {
  return [
    -stackSharedSuffix(path, wanted),
    packageRun && path.indexOf(packageRun) >= 0 ? 0 : 1,
    changed.has(path) ? 0 : 1,
    path.length,
  ];
}
function stackRankCompare(a, b) {
  for (var i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
function resolveStackFrame(frame, index) {
  if (!frame || frame.kind !== 'frame' || frame.line < 0) return null;
  index = index || stackResolverIndex();
  var wanted = stackFramePath(frame);
  var lineIndex = Math.max(0, frame.line - 1);
  if (wanted && index.paths.has(wanted)) return { path: wanted, lineIndex: lineIndex, ambiguous: 0 };
  var candidates = wanted
    ? (index.byName.get(baseName(wanted)) || [])
    : (index.byStem.get(stackClassSimpleName(frame)) || []);
  if (!candidates.length) return null;
  var packageRun = stackPackageRun(frame.classFqn);
  var ranked = candidates.map(function (path) {
    return { path: path, rank: stackCandidateRank(path, wanted, packageRun, index.changed) };
  }).sort(function (a, b) {
    return stackRankCompare(a.rank, b.rank) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  var tied = ranked.filter(function (one) { return stackRankCompare(one.rank, ranked[0].rank) === 0; });
  return { path: ranked[0].path, lineIndex: lineIndex, ambiguous: tied.length - 1 };
}

var stackTraceLines = [];
var stackTraceActive = -1;
var stackTraceTimer = null;

function stackTraceBox() {
  return document.getElementById('stack-trace');
}
function stackTraceIsOpen() {
  var box = stackTraceBox();
  return !!(box && !box.classList.contains('hidden'));
}
function stackTraceFromClipboard() {
  if (!window.kakapoClipboard || typeof window.kakapoClipboard.read !== 'function') return '';
  var text = '';
  try { text = String(window.kakapoClipboard.read() || ''); } catch (e) { text = ''; }
  return stackTraceFrameCount(readStackTraceLines(text)) ? text : '';
}
function openStackTracePanel() {
  var box = stackTraceBox();
  if (!box) return false;
  if (box.classList.contains('hidden')) rememberOverlayFocus(box);
  box.classList.remove('hidden');
  var input = document.getElementById('stack-trace-input');
  if (input && !input.value) input.value = stackTraceFromClipboard();
  stackTraceActive = -1;
  renderStackTrace();
  if (input) input.focus();
  return true;
}
function closeStackTrace(navigating) {
  var box = stackTraceBox();
  if (!box) return false;
  var held = !navigating && !box.classList.contains('hidden');
  if (stackTraceTimer) { clearTimeout(stackTraceTimer); stackTraceTimer = null; }
  box.classList.add('hidden');
  restoreOverlayFocus(box, held);
  return true;
}
function stackTraceOpenableIndexes() {
  var out = [];
  stackTraceLines.forEach(function (one, index) { if (one.resolved) out.push(index); });
  return out;
}
function renderStackTrace() {
  var results = document.getElementById('stack-trace-results');
  if (!results) return;
  var input = document.getElementById('stack-trace-input');
  var parsed = parseStackTrace(input ? input.value : '');
  var frames = stackTraceFrameCount(parsed);
  var index = frames ? stackResolverIndex() : null;
  stackTraceLines = parsed.map(function (one) {
    if (one.kind !== 'frame') return one;
    one.resolved = resolveStackFrame(one, index);
    return one;
  });
  var linked = stackTraceOpenableIndexes();
  var summary = document.getElementById('stack-trace-summary');
  if (summary) {
    summary.textContent = frames ? t('stack.summary', { n: frames, linked: linked.length }) : '';
  }
  if (stackTraceActive >= 0 && linked.indexOf(stackTraceActive) < 0) stackTraceActive = linked.length ? linked[0] : -1;
  if (!stackTraceLines.length) {
    results.innerHTML = '<div class="quick-open-empty stack-note">' + escapeHtml(t('stack.empty')) + '</div>';
    return;
  }
  results.innerHTML = stackTraceLines.map(function (one, i) {
    if (one.kind !== 'frame') {
      return '<div class="stack-row stack-prose"><span class="stack-line">' + escapeHtml(one.text) + '</span></div>';
    }
    var symbol = stackFrameSymbolLabel(one);
    if (!one.resolved) {
      return '<div class="stack-row stack-missing">'
        + '<span class="stack-loc stack-line">' + escapeHtml(stackFrameLocationLabel(one)) + '</span>'
        + '<span class="stack-note">' + escapeHtml(stackFrameMissingNote(one)) + '</span>'
        + '</div>';
    }
    var ambiguous = one.resolved.ambiguous
      ? '<span class="stack-ambiguous" title="' + escapeHtml(t('stack.ambiguous', { n: one.resolved.ambiguous })) + '">+'
        + one.resolved.ambiguous + '</span>'
      : '';
    return '<button type="button" class="quick-open-item stack-item' + (i === stackTraceActive ? ' active' : '') + '"'
      + ' data-index="' + i + '">'
      + '<span class="stack-loc stack-line">' + escapeHtml(one.resolved.path + ':' + (one.resolved.lineIndex + 1)) + '</span>'
      + '<span class="stack-symbol stack-line">' + escapeHtml(symbol) + '</span>'
      + ambiguous
      + '</button>';
  }).join('');
  updateStackTraceActive();
}
function stackFrameSymbolLabel(frame) {
  var fqn = String(frame.classFqn || '').trim();
  var method = String(frame.method || '').trim();
  return fqn && method ? fqn + '.' + method : (method || fqn);
}
function stackFrameLocationLabel(frame) {
  var name = stackFramePath(frame);
  if (!name) return stackFrameSymbolLabel(frame);
  return frame.line >= 0 ? name + ':' + frame.line : name;
}
function stackFrameMissingNote(frame) {
  if (frame.line < 0) return t('stack.noLine');
  var name = stackFramePath(frame);
  return name ? t('stack.notInProject', { file: baseName(name) }) : t('stack.noFile');
}
function updateStackTraceActive() {
  var results = document.getElementById('stack-trace-results');
  if (!results) return;
  var items = results.querySelectorAll('.stack-item');
  for (var i = 0; i < items.length; i += 1) {
    var on = Number(items[i].dataset.index) === stackTraceActive;
    items[i].classList.toggle('active', on);
    if (on && items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
  }
}
function openStackTraceFrame(line) {
  if (!line || !line.resolved) return false;
  closeStackTrace(true);
  openSourceAt(line.resolved.path, line.resolved.lineIndex, line.column > 0 ? line.column - 1 : 0);
  return true;
}
function openFirstStackTraceFrame() {
  var openable = stackTraceOpenableIndexes();
  if (!openable.length) { showCaretHint(t('stack.nothingToOpen')); return true; }
  return openStackTraceFrame(stackTraceLines[openable[0]]);
}
function stepStackTraceRow(delta) {
  var openable = stackTraceOpenableIndexes();
  if (!openable.length) return;
  var at = openable.indexOf(stackTraceActive);
  var input = document.getElementById('stack-trace-input');
  if (at < 0) {
    stackTraceActive = openable[delta > 0 ? 0 : openable.length - 1];
  } else if (at === 0 && delta < 0) {
    stackTraceActive = -1;
    if (input) input.focus();
    updateStackTraceActive();
    return;
  } else {
    stackTraceActive = openable[Math.min(openable.length - 1, at + delta)];
  }
  var results = document.getElementById('stack-trace-results');
  if (results && document.activeElement === input) results.focus();
  updateStackTraceActive();
}
function handleStackTraceKey(event) {
  if (!stackTraceIsOpen()) return false;
  if (event.key === 'Escape') { event.preventDefault(); closeStackTrace(); return true; }
  if (isShortcut(event, 'analyzeStackTrace')) { event.preventDefault(); closeStackTrace(); return true; }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    openFirstStackTraceFrame();
    return true;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === 'ArrowUp' && document.activeElement === document.getElementById('stack-trace-input')) return false;
    event.preventDefault();
    stepStackTraceRow(event.key === 'ArrowDown' ? 1 : -1);
    return true;
  }
  if (event.key === 'Enter' && stackTraceActive >= 0) {
    event.preventDefault();
    openStackTraceFrame(stackTraceLines[stackTraceActive]);
    return true;
  }
  return false;
}

registerLocalizedPaint({ render: function () { if (stackTraceIsOpen()) renderStackTrace(); } });

document.getElementById('stack-trace-input')?.addEventListener('input', function () {
  if (stackTraceTimer) clearTimeout(stackTraceTimer);
  stackTraceTimer = setTimeout(function () { stackTraceTimer = null; renderStackTrace(); }, STACK_TRACE_DEBOUNCE_MS);
});
document.getElementById('stack-trace-results')?.addEventListener('click', function (event) {
  var row = event.target.closest && event.target.closest('.stack-item');
  if (!row) return;
  openStackTraceFrame(stackTraceLines[Number(row.dataset.index)]);
});
document.getElementById('stack-trace-results')?.addEventListener('mousemove', function (event) {
  var row = event.target.closest && event.target.closest('.stack-item');
  if (!row) return;
  stackTraceActive = Number(row.dataset.index);
  updateStackTraceActive();
});
stackTraceBox()?.addEventListener('click', function (event) {
  if (event.target && event.target.id === 'stack-trace') closeStackTrace();
});
