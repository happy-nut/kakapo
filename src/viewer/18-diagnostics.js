
var diagnosticsPaintedRows;
var diagnosticsCache;
var diagnosticsFetchToken;
var diagnosticsInFlight;
var diagnosticsPaintRaf;
function ensureDiagnosticsState() {
  if (diagnosticsCache) return;
  diagnosticsCache = new Map();
  diagnosticsPaintedRows = [];
  diagnosticsFetchToken = new Map();
  diagnosticsInFlight = new Set();
  diagnosticsPaintRaf = 0;
}

function diagnosticsSurfacePath() {
  if (!isSourceViewerVisible()) return '';
  var path = sourceOpenPath();
  return path && sourceBodyPath === path ? path : '';
}

function diagnosticsCaretLine() {
  var painted = diagnosticsSurfacePath();
  if (painted) {
    if (typeof viewerCursor === 'undefined' || !viewerCursor || viewerCursor.path !== painted) return null;
    return { path: painted, lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  }
  if (!isDiffViewVisible() || typeof diffCursor === 'undefined' || !diffCursor || !diffCursor.path) return null;
  if (diffCursor.side !== 'new') return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  var row = wrapper ? diffRowAt(wrapper, 'new', diffCursor.rowIndex) : null;
  var line = row ? diffLineNumber(row) : null;
  if (line == null) return null;
  return { path: diffCursor.path, lineIndex: line - 1, column: diffCursor.column };
}

function diagnosticsCaretPath() {
  var painted = diagnosticsSurfacePath();
  if (painted) return painted;
  if (isDiffViewVisible() && typeof diffCursor !== 'undefined' && diffCursor && diffCursor.path) return diffCursor.path;
  return '';
}

function diagnosticsEligible(path) {
  if (!path) return false;
  var file = sourceByPath.get(path);
  if (!file || !file.embedded || file.image) return false;
  return !(isMarkdownPath(path) || isCsvPath(path) || isHttpFile(path));
}

function surfacedDiagnostics(items) {
  var errorsOnly = renderToggleOn('essentialHighlighting');
  return (items || []).filter(function (d) {
    if (!d) return false;
    if (d.severity === 'error') return true;
    return !errorsOnly && (d.severity === 'warning' || d.severity === 'weak');
  });
}

var DIAGNOSTIC_RANK = { error: 0, warning: 1, weak: 2 };
var DIAGNOSTIC_TIERS = Object.keys(DIAGNOSTIC_RANK);
function diagnosticRank(severity) {
  var rank = DIAGNOSTIC_RANK[severity];
  return rank === undefined ? 3 : rank;
}

function refreshDiagnosticsFilter() {
  var open = sourceOpenPath();
  if (open) refreshSourceDiagnostics(open);
  if (quickMode === 'problems') renderProblemsResults(String((quickInput && quickInput.value) || ''));
}

function refreshSourceDiagnostics(path) {
  ensureDiagnosticsState();
  if (!diagnosticsEligible(path)) { clearSourceDiagnosticsPaint(); return; }
  if (fetchDiagnostics(path)) paintSourceDiagnostics(path);
}

function fetchDiagnostics(path, retryOf) {
  ensureDiagnosticsState();
  if (!diagnosticsEligible(path)) return false;
  if (!window.kakapoAnalysis || typeof window.kakapoAnalysis.diagnostics !== 'function') return false;
  var sig = fileSignatureByPath.get(path) || '';
  var isRetry = retryOf !== undefined && retryOf === sig;
  var cached = diagnosticsCache.get(path);
  if (cached && cached.sig === sig) return true;
  if (diagnosticsInFlight.has(path)) return false;
  var token = (diagnosticsFetchToken.get(path) || 0) + 1;
  diagnosticsFetchToken.set(path, token);
  diagnosticsInFlight.add(path);
  var settle = function () { diagnosticsInFlight.delete(path); };
  var asked;
  setTimeout(settle, DIAGNOSTICS_CLAIM_MS);
  try { asked = Promise.resolve(window.kakapoAnalysis.diagnostics(path)); }
  catch (e) { settle(); return false; }
  asked.then(function (response) {
    settle();
    if (token !== diagnosticsFetchToken.get(path)) return;
    if (!analysisGenerationIsCurrent(response)) return;
    if (!response) return;
    if (response.ok === false) { diagnosticsCache.set(path, { sig: sig, items: [], state: 'failed' }); return; }
    var items = Array.isArray(response.diagnostics) ? response.diagnostics : [];
    var state = response.available === false ? 'unavailable' : 'ready';
    var provisional = state === 'ready' && !items.length && !isRetry;
    diagnosticsCache.set(path, { sig: sig, items: items, state: state, provisional: provisional });
    if (diagnosticsSurfacePath() === path) paintSourceDiagnostics(path);
    if (provisional) scheduleProvisionalDiagnosticsRetry(path, sig);
  }).catch(function () {
    settle();
  });
  return false;
}

var DIAGNOSTICS_RETRY_MS = 1200;
var DIAGNOSTICS_CLAIM_MS = 30000;
function scheduleProvisionalDiagnosticsRetry(path, sig) {
  setTimeout(function () {
    if (!pageAlive()) return;
    var cached = diagnosticsCache.get(path);
    if (!cached || cached.sig !== sig || !cached.provisional) return;
    diagnosticsCache.delete(path);
    fetchDiagnostics(path, sig);
  }, DIAGNOSTICS_RETRY_MS);
}

function clearSourceDiagnosticsPaint() {
  ensureDiagnosticsState();
  diagnosticsPaintedRows.forEach(function (row) {
    row.classList.remove('has-diagnostic');
    DIAGNOSTIC_TIERS.forEach(function (tier) { row.classList.remove('diag-' + tier); });
  });
  diagnosticsPaintedRows = [];
  hideDiagnosticTooltip();
  try {
    if (window.CSS && CSS.highlights) {
      DIAGNOSTIC_TIERS.forEach(function (tier) { CSS.highlights.delete('kakapo-diag-' + tier); });
    }
  } catch (e) {}
}

function paintSourceDiagnostics(path) {
  ensureDiagnosticsState();
  clearSourceDiagnosticsPaint();
  if (diagnosticsSurfacePath() !== path) return;
  var cached = diagnosticsCache.get(path);
  var items = surfacedDiagnostics(cached && cached.items);
  if (!items.length) return;
  var ranges = {};
  DIAGNOSTIC_TIERS.forEach(function (tier) { ranges[tier] = []; });
  var rowSeverity = new Map();
  items.forEach(function (d) {
    var row = paintedSourceRow(d.lineIndex);
    if (!row) return;
    var container = row.querySelector('.source-code');
    if (!container) return;
    var textLen = sourceCellText(container).length;
    var start = Math.max(0, Math.min(d.column, textLen));
    var singleLine = d.endLineIndex === d.lineIndex;
    var end = singleLine ? Math.min(Math.max(d.endColumn, start + 1), textLen) : textLen;
    var length = Math.max(1, end - start);
    var range = fileFindRange(container, start, length);
    if (range && ranges[d.severity]) ranges[d.severity].push(range);
    var held = rowSeverity.get(row);
    if (held === undefined || diagnosticRank(d.severity) < diagnosticRank(held)) rowSeverity.set(row, d.severity);
  });
  rowSeverity.forEach(function (severity, row) {
    row.classList.add('has-diagnostic', 'diag-' + severity);
    diagnosticsPaintedRows.push(row);
  });
  try {
    if (window.CSS && CSS.highlights && typeof window.Highlight === 'function') {
      DIAGNOSTIC_TIERS.forEach(function (tier) {
        CSS.highlights.set('kakapo-diag-' + tier, new window.Highlight(...ranges[tier]));
      });
    }
  } catch (e) {}
}

function scheduleSourceDiagnosticsPaint() {
  ensureDiagnosticsState();
  if (diagnosticsPaintRaf) cancelAnimationFrame(diagnosticsPaintRaf);
  diagnosticsPaintRaf = requestAnimationFrame(function () {
    diagnosticsPaintRaf = 0;
    var path = diagnosticsSurfacePath();
    if (path) paintSourceDiagnostics(path);
  });
}

function gotoDiagnostic(delta) {
  ensureDiagnosticsState();
  var path = diagnosticsCaretPath();
  if (!path || !diagnosticsEligible(path)) return false;
  var inDiff = path !== diagnosticsSurfacePath();
  if (inDiff) fetchDiagnostics(path);
  var cached = diagnosticsCache.get(path);
  var items = surfacedDiagnostics(cached && cached.items).slice().sort(function (a, b) {
    return a.lineIndex - b.lineIndex || a.column - b.column;
  });
  var everything = items.length;
  if (inDiff) {
    var inHunks = diffWrapperByPath(path);
    items = inHunks ? items.filter(function (d) { return diffRowIndexForLine(inHunks, 'new', d.lineIndex + 1) >= 0; }) : [];
    if (!items.length && everything) {
      showCaretHint(t('diag.noneChanged', { n: everything, key: shortcutLabel('problemsView') }));
      return true;
    }
  }
  if (!items.length) {
    var state = cached && cached.state;
    if (!cached) showCaretHint(t('diag.pending'));
    else if (state === 'unavailable') showCaretHint(t('diag.unavailable'));
    else if (state === 'failed') showCaretHint(t('diag.failed'));
    else if (cached.provisional) showCaretHint(t('diag.pending'));
    else showCaretHint(t('diag.none'));
    return true;
  }
  var at = diagnosticsCaretLine();
  var curLine = at && at.path === path ? at.lineIndex : -1;
  var curCol = at && at.path === path ? at.column : -1;
  var target = null;
  if (delta > 0) {
    target = items.find(function (d) { return d.lineIndex > curLine || (d.lineIndex === curLine && d.column > curCol); }) || items[0];
  } else {
    for (var i = items.length - 1; i >= 0; i -= 1) {
      var d = items[i];
      if (d.lineIndex < curLine || (d.lineIndex === curLine && d.column < curCol)) { target = d; break; }
    }
    if (!target) target = items[items.length - 1];
  }
  if (inDiff) {
    var wrapper = diffWrapperByPath(path);
    var rowIndex = wrapper ? diffRowIndexForLine(wrapper, 'new', target.lineIndex + 1) : -1;
    if (rowIndex >= 0) setDiffCursor(path, 'new', rowIndex, target.column, true);
    else openSourceAt(path, target.lineIndex, target.column);
  } else {
    setSourceCursor(path, target.lineIndex, target.column, true, target.lineIndex);
    scheduleSourceDiagnosticsPaint();
  }
  if (target.message) showCaretHint(target.message, null, true);
  return true;
}

function diagnosticsAtCaret() {
  ensureDiagnosticsState();
  var where = diagnosticsCaretLine();
  if (!where) return [];
  var cached = diagnosticsCache.get(where.path);
  if (cached && cached.provisional) return [];
  return surfacedDiagnostics(cached && cached.items)
    .filter(function (d) { return d.lineIndex === where.lineIndex; })
    .sort(function (a, b) {
      return (diagnosticRank(a.severity) - diagnosticRank(b.severity)) || (a.column - b.column);
    });
}

function createFixCommentAtCaret() {
  var here = diagnosticsAtCaret();
  if (!here.length) return false;
  var target = currentCommentTarget();
  if (!target) return false;
  var messages = [];
  here.forEach(function (d) { if (messages.indexOf(d.message) < 0) messages.push(d.message); });
  var joined = messages.join('; ');
  var text = t('diag.fixComment').replace('{message}', function () { return joined; });
  addComment('c', target.path, target.line, target.code, text, target.from, target.to, target.side, target.anchorCode);
  refreshComments();
  showCaretHint(t('diag.fixAdded'));
  return true;
}

var diagnosticHoverDelayMs = 1000;
var diagnosticHoverTimer = 0;
var diagnosticHoverKey = '';
var diagnosticHoverX = 0;
var diagnosticHoverY = 0;
var diagnosticTooltipEl = null;

function diagnosticLineMessage(path, lineIndex) {
  var cached = diagnosticsCache.get(path);
  var items = surfacedDiagnostics(cached && cached.items).filter(function (d) { return d.lineIndex === lineIndex; });
  var lines = [];
  items.forEach(function (d) {
    var severity = t(DIAGNOSTIC_RANK[d.severity] === undefined ? 'diag.error' : 'diag.' + d.severity);
    var m = severity + ': ' + d.message + (d.source ? ' (' + d.source + ')' : '');
    if (lines.indexOf(m) < 0) lines.push(m);
  });
  return lines.join('\n');
}

function ensureDiagnosticTooltip() {
  if (diagnosticTooltipEl && document.body && document.body.contains(diagnosticTooltipEl)) return diagnosticTooltipEl;
  var el = document.createElement('div');
  el.className = 'diag-tooltip';
  el.setAttribute('role', 'tooltip');
  el.style.display = 'none';
  (document.body || document.documentElement).appendChild(el);
  diagnosticTooltipEl = el;
  return el;
}

function hideDiagnosticTooltip() {
  if (diagnosticHoverTimer) { clearTimeout(diagnosticHoverTimer); diagnosticHoverTimer = 0; }
  if (diagnosticTooltipEl) diagnosticTooltipEl.style.display = 'none';
}

function showDiagnosticTooltip(x, y, message) {
  var el = ensureDiagnosticTooltip();
  el.textContent = message;
  el.style.display = 'block';
  el.style.visibility = 'hidden';
  var pad = 10;
  var rect = el.getBoundingClientRect();
  var vw = window.innerWidth || 1024;
  var vh = window.innerHeight || 768;
  var left = Math.min(x + 14, vw - rect.width - pad);
  var top = y + 20;
  if (top + rect.height > vh - pad) top = y - rect.height - 12;
  el.style.left = Math.max(pad, left) + 'px';
  el.style.top = Math.max(pad, top) + 'px';
  el.style.visibility = 'visible';
}

function onDiagnosticHover(event) {
  ensureDiagnosticsState();
  var target = event.target;
  var row = target && target.closest ? target.closest('#source-body .source-row.has-diagnostic') : null;
  var path = diagnosticsSurfacePath();
  if (!row || !path) {
    diagnosticHoverKey = '';
    hideDiagnosticTooltip();
    return;
  }
  var lineIndex = Number(row.dataset.lineIndex);
  var key = path + ':' + lineIndex;
  diagnosticHoverX = event.clientX;
  diagnosticHoverY = event.clientY;
  var standing = !!diagnosticHoverTimer
    || !!(diagnosticTooltipEl && diagnosticTooltipEl.style.display !== 'none');
  if (key === diagnosticHoverKey && standing) return;
  diagnosticHoverKey = key;
  hideDiagnosticTooltip();
  var message = diagnosticLineMessage(path, lineIndex);
  if (!message) return;
  diagnosticHoverTimer = setTimeout(function () {
    diagnosticHoverTimer = 0;
    if (diagnosticHoverKey === key) showDiagnosticTooltip(diagnosticHoverX, diagnosticHoverY, message);
  }, diagnosticHoverDelayMs);
}

document.addEventListener('mousemove', onDiagnosticHover);
document.addEventListener('mouseleave', hideDiagnosticTooltip, true);
document.addEventListener('scroll', hideDiagnosticTooltip, true);
