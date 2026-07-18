// Language-server diagnostics for the open source file. Main pushes error/warning ranges (LSP
// textDocument/publishDiagnostics, normalized to 0-based line/column); here we draw them as wavy underlines
// via the CSS Custom Highlight API — the same zero-DOM-mutation technique file-find uses — plus a gutter dot,
// and let F2 / Shift+F2 step between them WITHIN the current file. Info/hint severities are collected by main
// but intentionally not surfaced: this review station is about "does the AI's code actually hold up", so only
// errors (red) and warnings (amber) earn a mark. There is no regex fallback — an unsupported language reports
// available:false upstream and simply paints nothing, never a misleading "no problems".

// State is lazily created because boot calls openSourceFile (→ refreshSourceDiagnostics) while the concatenated
// bundle is still executing top to bottom — before this slice's own initializers would otherwise run. Every
// entry point calls ensureDiagnosticsState() first so it works no matter when it is reached.
var diagnosticsPaintedRows;
var diagnosticsCache; // path -> { sig, items }
var diagnosticsFetchToken;
var diagnosticsPaintRaf;
function ensureDiagnosticsState() {
  if (diagnosticsCache) return;
  diagnosticsCache = new Map();
  diagnosticsPaintedRows = [];
  diagnosticsFetchToken = 0;
  diagnosticsPaintRaf = 0;
}

// The path whose content is actually painted in the visible source body. dataset.openPath alone is not enough:
// it is set before the lazy body repaint, so a fetch that resolves mid-switch must not paint the wrong file.
function diagnosticsSurfacePath() {
  var viewer = document.getElementById('source-viewer');
  if (!viewer || viewer.classList.contains('hidden')) return '';
  var path = viewer.dataset.openPath || '';
  return path && sourceBodyPath === path ? path : '';
}

function diagnosticsEligible(path) {
  if (!path) return false;
  var file = sourceByPath.get(path);
  if (!file || !file.embedded || file.image) return false;
  // Rendered Markdown/CSV and HTTP files are line-addressable but not code a language server diagnoses.
  return !(isMarkdownPath(path) || isCsvPath(path) || isHttpFile(path));
}

function surfacedDiagnostics(items) {
  return (items || []).filter(function (d) { return d && (d.severity === 'error' || d.severity === 'warning'); });
}

// Entry point, called from openSourceFile after a code body renders. Paints from cache when the file content
// is unchanged; otherwise fetches once and paints on arrival (guarded against stale files and generations).
function refreshSourceDiagnostics(path) {
  ensureDiagnosticsState();
  if (!diagnosticsEligible(path)) { clearSourceDiagnosticsPaint(); return; }
  if (!window.kakapoAnalysis || typeof window.kakapoAnalysis.diagnostics !== 'function') return;
  var sig = fileSignatureByPath.get(path) || '';
  var cached = diagnosticsCache.get(path);
  if (cached && cached.sig === sig) { paintSourceDiagnostics(path); return; }
  var token = ++diagnosticsFetchToken;
  Promise.resolve(window.kakapoAnalysis.diagnostics(path)).then(function (response) {
    if (token !== diagnosticsFetchToken) return; // a newer file / watch refresh superseded this request
    if (typeof analysisGenerationIsCurrent === 'function' && !analysisGenerationIsCurrent(response)) return;
    if (!response || response.ok === false) return;
    diagnosticsCache.set(path, { sig: sig, items: Array.isArray(response.diagnostics) ? response.diagnostics : [] });
    if (diagnosticsSurfacePath() === path) paintSourceDiagnostics(path);
  }).catch(function () { /* transport failures already quarantine the server in main; the paint just stays empty */ });
}

function clearSourceDiagnosticsPaint() {
  ensureDiagnosticsState();
  diagnosticsPaintedRows.forEach(function (row) {
    row.classList.remove('has-diagnostic', 'diag-error', 'diag-warning');
  });
  diagnosticsPaintedRows = [];
  hideDiagnosticTooltip(); // the hovered line may be repainted/removed; drop any tooltip anchored to it
  try {
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete('kakapo-diag-error');
      CSS.highlights.delete('kakapo-diag-warning');
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
  var errorRanges = [], warningRanges = [];
  var rowSeverity = new Map(); // row element -> 'error' | 'warning' (error wins when a line has both)
  items.forEach(function (d) {
    var row = sourceFindRow(d.lineIndex);
    if (!row) return; // line folded away or outside the rendered body
    var container = row.querySelector('.source-code');
    if (!container) return;
    var textLen = (container.textContent || '').length;
    var start = Math.max(0, Math.min(d.column, textLen));
    // Underline the diagnostic span on its start line; a multi-line range extends to end of that line so the
    // squiggle stays inside one row container (each source line is its own cell). Zero-width ranges get 1 char.
    var singleLine = d.endLineIndex === d.lineIndex;
    var end = singleLine ? Math.min(Math.max(d.endColumn, start + 1), textLen) : textLen;
    var length = Math.max(1, end - start);
    var range = fileFindRange(container, start, length);
    if (range) (d.severity === 'error' ? errorRanges : warningRanges).push(range);
    if (d.severity === 'error' || !rowSeverity.has(row)) rowSeverity.set(row, d.severity);
  });
  rowSeverity.forEach(function (severity, row) {
    row.classList.add('has-diagnostic', severity === 'error' ? 'diag-error' : 'diag-warning');
    diagnosticsPaintedRows.push(row);
  });
  // The message itself is shown by the dwell tooltip (onDiagnosticHover), keyed off the .has-diagnostic row,
  // not a native title — so the delay and styling are ours and it appears only over the underlined line.
  try {
    if (window.CSS && CSS.highlights && typeof window.Highlight === 'function') {
      CSS.highlights.set('kakapo-diag-error', new window.Highlight(...errorRanges));
      CSS.highlights.set('kakapo-diag-warning', new window.Highlight(...warningRanges));
    }
  } catch (e) {}
}

// The caret fast-path (setSourceCursor) repatches only the previous and new caret rows in place, which drops
// any highlight range anchored in those rows. Re-establish the full paint on the next frame after a move.
function scheduleSourceDiagnosticsPaint() {
  ensureDiagnosticsState();
  if (diagnosticsPaintRaf) cancelAnimationFrame(diagnosticsPaintRaf);
  diagnosticsPaintRaf = requestAnimationFrame(function () {
    diagnosticsPaintRaf = 0;
    var path = diagnosticsSurfacePath();
    if (path) paintSourceDiagnostics(path);
  });
}

// F2 / Shift+F2: step to the next / previous problem in the current file, wrapping at the ends. Returns true
// when F2 belongs to this surface (so the key is consumed), false to let the event fall through.
function gotoDiagnostic(delta) {
  ensureDiagnosticsState();
  var path = diagnosticsSurfacePath();
  if (!path || !diagnosticsEligible(path)) return false;
  var cached = diagnosticsCache.get(path);
  var items = surfacedDiagnostics(cached && cached.items).slice().sort(function (a, b) {
    return a.lineIndex - b.lineIndex || a.column - b.column;
  });
  if (!items.length) {
    if (typeof showCaretHint === 'function') showCaretHint(t('diag.none'));
    return true;
  }
  var atPath = viewerCursor && viewerCursor.path === path;
  var curLine = atPath ? viewerCursor.lineIndex : -1;
  var curCol = atPath ? viewerCursor.column : -1;
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
  setSourceCursor(path, target.lineIndex, target.column, true, target.lineIndex);
  scheduleSourceDiagnosticsPaint();
  if (typeof showCaretHint === 'function' && target.message) showCaretHint(target.message);
  return true;
}

// Surfaced diagnostics on the caret's current line, errors first, for the Opt+Enter fix action.
function diagnosticsAtCaret() {
  ensureDiagnosticsState();
  var path = diagnosticsSurfacePath();
  if (!path || typeof viewerCursor === 'undefined' || !viewerCursor || viewerCursor.path !== path) return [];
  var cached = diagnosticsCache.get(path);
  return surfacedDiagnostics(cached && cached.items)
    .filter(function (d) { return d.lineIndex === viewerCursor.lineIndex; })
    .sort(function (a, b) {
      if ((a.severity === 'error') !== (b.severity === 'error')) return a.severity === 'error' ? -1 : 1;
      return a.column - b.column;
    });
}

// Opt+Enter on a problem line: draft a change-request comment that tells the agent to fix it, folding every
// message on the line into one instruction. Saved immediately (editable/removable like any comment). The
// merged prompt already prepends @path#Lline, so the comment text only needs to carry the instruction.
function createFixCommentAtCaret() {
  var here = diagnosticsAtCaret();
  if (!here.length) return false;
  if (typeof currentCommentTarget !== 'function' || typeof addComment !== 'function') return false;
  var target = currentCommentTarget();
  if (!target) return false;
  var messages = [];
  here.forEach(function (d) { if (messages.indexOf(d.message) < 0) messages.push(d.message); });
  var joined = messages.join('; ');
  // Function replacer so a diagnostic message containing $&, $1, etc. is inserted literally.
  var text = t('diag.fixComment').replace('{message}', function () { return joined; });
  addComment('c', target.path, target.line, target.code, text, target.from, target.to, target.side, target.anchorCode);
  if (typeof refreshComments === 'function') refreshComments();
  if (typeof showCaretHint === 'function') showCaretHint(t('diag.fixAdded'));
  return true;
}

// ---- dwell tooltip -------------------------------------------------------------------------------------
// Hover a problem line for ~1s and a styled tooltip shows the message(s). Native title tooltips were replaced
// because their delay and styling are OS-controlled; this owns both and appears only over .has-diagnostic rows.
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
    var m = d.message + (d.source ? ' (' + d.source + ')' : '');
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
  el.style.visibility = 'hidden'; // measure before placing so it can flip above/left near an edge
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
  if (key === diagnosticHoverKey) return; // same line — let the pending timer or shown tooltip stand
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
document.addEventListener('mouseleave', hideDiagnosticTooltip, true); // pointer left a scroller/window
document.addEventListener('scroll', hideDiagnosticTooltip, true); // a scrolled line no longer sits under the tip
