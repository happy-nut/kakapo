// Language-server diagnostics for the open source file. Main pushes ranges (LSP
// textDocument/publishDiagnostics, normalized to 0-based line/column); here we draw them as wavy underlines
// via the CSS Custom Highlight API — the same zero-DOM-mutation technique file-find uses — plus a gutter dot,
// and let F2 / Shift+F2 step between them WITHIN the current file. There is no regex fallback — an
// unsupported language reports available:false upstream and simply paints nothing, never a misleading
// "no problems".
//
// Three severities earn a mark, not two. The weak tier — IntelliJ's own name for it, LSP's Information and
// Hint folded together — used to be collected and dropped here on the grounds that this station is about
// "does the AI's code actually hold up". That reading had it backwards: an error is the compiler refusing
// the code, and what a reviewer of generated code is hunting is the half that compiles and is still wrong.
// A variable the agent declared and never read, a line it left after a return, a call it kept using after
// marking it deprecated — every one of those arrives in this tier and nowhere else. tsserver publishes them
// for TypeScript and JavaScript with no configuration at all, which is why the three of them were already
// in the cache when this gate was dropping them.

// State is lazily created because boot calls openSourceFile (→ refreshSourceDiagnostics) while the concatenated
// bundle is still executing top to bottom — before this slice's own initializers would otherwise run. Every
// entry point calls ensureDiagnosticsState() first so it works no matter when it is reached.
var diagnosticsPaintedRows;
var diagnosticsCache; // path -> { sig, items }
var diagnosticsFetchToken; // path -> token: only the newest request FOR THAT PATH may write its entry
var diagnosticsInFlight;   // paths with a request already out, so a held key cannot stack more
var diagnosticsPaintRaf;
function ensureDiagnosticsState() {
  if (diagnosticsCache) return;
  diagnosticsCache = new Map();
  diagnosticsPaintedRows = [];
  diagnosticsFetchToken = new Map();
  diagnosticsInFlight = new Set();
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

/**
 * The file F2 is about, on whichever surface is up.
 *
 * The source view has to insist on the body it is actually PAINTING, because that is where the squiggles
 * go. The diff paints none — it carries its problems in the ⌘6 list — so the caret's file is answer
 * enough, and F2 there is pure navigation. Without this, F2 and ⇧F2 returned false in the diff and the
 * key said nothing whatsoever, in the one view a reviewer spends the time in, while ⌘6 beside it was
 * listing forty problems.
 */
/**
 * The caret's file AND line, in the file's own numbering — '' / null when there is no caret on a file a
 * server diagnoses.
 *
 * Two readers of this used to disagree. F2 was taught the diff and ⌘F1 / ⌥Enter were not, so in the diff
 * F2 jumped to a problem, announced its message, and ⌘F1 on that very line answered "No problem on this
 * line" while ⌥Enter refused to draft a fix for it. The diff's working-tree pane IS the file, so its
 * printed line number converts exactly; a caret in the base pane is looking at a version these
 * diagnostics are not about, and has no line here.
 */
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
  // Rendered Markdown/CSV and HTTP files are line-addressable but not code a language server diagnoses.
  return !(isMarkdownPath(path) || isCsvPath(path) || isHttpFile(path));
}

// The one gate every reading of a diagnostic passes through — the gutter marks, the squiggles, the ⌘6
// Problems list, F2 stepping and the ⌘F1 description all call it — which is why IntelliJ's Essential
// Highlighting is one line here. It drops everything that is not an error, for the review where a hundred
// style warnings are between the reader and the three things that are actually wrong.
function surfacedDiagnostics(items) {
  var errorsOnly = renderToggleOn('essentialHighlighting');
  return (items || []).filter(function (d) {
    if (!d) return false;
    if (d.severity === 'error') return true;
    return !errorsOnly && (d.severity === 'warning' || d.severity === 'weak');
  });
}

// error, then warning, then weak — the one order every reading of a diagnostic paints and sorts by, so the
// gutter mark on a line that holds two, the Opt+Enter list and the ⌘6 rows cannot disagree about which wins.
var DIAGNOSTIC_RANK = { error: 0, warning: 1, weak: 2 };
// The same three names as classes and highlight registries. Read from the rank table rather than written
// out again, because the paint and the clear have to agree about the whole set: when the weak tier was
// added, the clear kept listing two and a weak mark survived into the next file the reader opened.
var DIAGNOSTIC_TIERS = Object.keys(DIAGNOSTIC_RANK);
function diagnosticRank(severity) {
  var rank = DIAGNOSTIC_RANK[severity];
  return rank === undefined ? 3 : rank;
}

/** Essential Highlighting flipped: repaint whatever is on screen through the gate above. */
function refreshDiagnosticsFilter() {
  var viewer = document.getElementById('source-viewer');
  var open = viewer && viewer.dataset.openPath;
  if (open) refreshSourceDiagnostics(open);
  // The ⌘6 list reads through the same gate, so it only needs re-rendering when it happens to be up. Its
  // own ⌥E errors-only filter still works and simply has nothing left to drop while this is on.
  if (quickMode === 'problems') renderProblemsResults(String((quickInput && quickInput.value) || ''));
}

// Entry point, called from openSourceFile after a code body renders. Paints from cache when the file content
// is unchanged; otherwise fetches once and paints on arrival (guarded against stale files and generations).
function refreshSourceDiagnostics(path) {
  ensureDiagnosticsState();
  if (!diagnosticsEligible(path)) { clearSourceDiagnosticsPaint(); return; }
  if (fetchDiagnostics(path)) paintSourceDiagnostics(path);
}

/**
 * Fill the cache for `path`, painting the source body if it happens to be the one on screen.
 *
 * Returns true when the answer is already cached and current — which is the only thing a caller that is
 * not the source painter needs to know, and which is why this is its own function: the diff's F2 wants
 * the same cache, filled the same way, without a source body to paint into.
 *
 * `isRetry` marks the second read of an empty answer (see below). It is what ENDS the retry: without it
 * the second empty answer looked exactly like the first, re-armed itself, and left the entry provisional
 * for the life of the window — so a genuinely clean file never got past "still checking", and every press
 * of F2 on it was a cache miss and a fresh round trip.
 */
function fetchDiagnostics(path, retryOf) {
  ensureDiagnosticsState();
  if (!diagnosticsEligible(path)) return false;
  if (!window.kakapoAnalysis || typeof window.kakapoAnalysis.diagnostics !== 'function') return false;
  var sig = fileSignatureByPath.get(path) || '';
  // `retryOf` is the signature the retry was scheduled FOR, not a bare flag. It re-derives `sig` here, so
  // a watch rebuild between the schedule and the fire would have carried "this is the second read" into
  // what is actually the FIRST read of new content — stamping a syntactic-only empty as the last word on
  // it. Only a retry of the content still in hand counts as one.
  var isRetry = retryOf !== undefined && retryOf === sig;
  var cached = diagnosticsCache.get(path);
  // A provisional entry is still served. The re-ask is the scheduled one and only the scheduled one:
  // treating `provisional` as a cache miss meant every caller that arrived during the window fired its
  // own request — measured at three reads of one clean file where there should have been two.
  if (cached && cached.sig === sig) return true;
  // One request per file in flight at a time. It de-duplicates presses on the SAME file — every F2 on a
  // cold file used to fire another ask while the first was still coming — and nothing more: holding
  // ⌘⇧→ across a review still asks once per file crossed, because each crossing is a different path.
  // That is a prefetch doing its job, not a storm, but it is not what this guard bounds.
  if (diagnosticsInFlight.has(path)) return false;
  // Per path, not one counter for the app. A single global token meant the newest request anywhere
  // cancelled every other file's in-flight answer: step A -> B with F7 and A's diagnostics, already on
  // their way, were dropped on arrival and never cached — so the prefetch this token guards was feeding
  // nothing. A request can only ever be superseded by a newer request for the SAME file.
  var token = (diagnosticsFetchToken.get(path) || 0) + 1;
  diagnosticsFetchToken.set(path, token);
  diagnosticsInFlight.add(path);
  var settle = function () { diagnosticsInFlight.delete(path); };
  var asked;
  // A claim taken before a call must be released by the same code that took it, on every way out. A
  // synchronous throw is one; a promise that never settles is the other, and that one is reachable —
  // main can be torn down mid-request. Either way a claimed path never re-asks, so F2 would answer
  // "still checking" for the life of the window and the squiggles would never paint.
  setTimeout(settle, DIAGNOSTICS_CLAIM_MS);
  try { asked = Promise.resolve(window.kakapoAnalysis.diagnostics(path)); }
  catch (e) { settle(); return false; }
  asked.then(function (response) {
    settle();
    if (token !== diagnosticsFetchToken.get(path)) return; // a newer read of this file superseded it
    if (!analysisGenerationIsCurrent(response)) return;
    // `available` and `ok` are part of the answer, not plumbing. analysis.ts reports available:false for a
    // file no server covers precisely so the viewer can say so instead of an empty "no problems"
    // (USER_FLOWS Flow 6 forbids the reassuring version) — and then the viewer dropped the field and said
    // the reassuring version anyway, for CSS, for Markdown, for anything outside a server's languages.
    if (!response) return;
    if (response.ok === false) { diagnosticsCache.set(path, { sig: sig, items: [], state: 'failed' }); return; }
    var items = Array.isArray(response.diagnostics) ? response.diagnostics : [];
    var state = response.available === false ? 'unavailable' : 'ready';
    // An empty answer from a server that DOES cover this file is not the same as "no problems": tsserver
    // publishes its syntactic pass first and its suggestion pass — the whole weak tier — afterwards, so
    // the first read of a file is routinely `ok, available, []` and the second one is not. Cached as final,
    // that emptiness was permanent: the ⌘6 list (which asks main directly) showed a problem on a line F2
    // swore was clean, in the same file, in the same second. Marked provisional instead, so the next read
    // asks again — and asked again once here, because a reader who opened a file is not going to press a
    // key to find out whether the squiggles meant it. Once, though: the retry's own answer is the last
    // word on this content, empty or not, which is what `isRetry` says.
    var provisional = state === 'ready' && !items.length && !isRetry;
    diagnosticsCache.set(path, { sig: sig, items: items, state: state, provisional: provisional });
    if (diagnosticsSurfacePath() === path) paintSourceDiagnostics(path);
    if (provisional) scheduleProvisionalDiagnosticsRetry(path, sig);
  }).catch(function () {
    settle(); // transport failures already quarantine the server in main; the paint just stays empty
  });
  return false;
}

// One re-ask per provisional answer, not a poll: the second read is the one that carries the suggestion
// pass, and if it is empty too then the file really is clean. The signature is checked at fire time so a
// watch rebuild cannot be answered by a retry scheduled for the previous content, and `isRetry` below is
// what stops the second empty answer from arming a third.
var DIAGNOSTICS_RETRY_MS = 1200;
// Longer than any answer this bridge gives (main caps its own waits well inside it), so the release only
// ever fires for a request that is not coming back. Releasing early would cost a duplicate ask, which is
// the cheaper mistake of the two.
var DIAGNOSTICS_CLAIM_MS = 30000;
function scheduleProvisionalDiagnosticsRetry(path, sig) {
  setTimeout(function () {
    if (!pageAlive()) return;
    var cached = diagnosticsCache.get(path);
    if (!cached || cached.sig !== sig || !cached.provisional) return;
    diagnosticsCache.delete(path); // dropped rather than refreshed, so fetchDiagnostics takes its cold path
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
  hideDiagnosticTooltip(); // the hovered line may be repainted/removed; drop any tooltip anchored to it
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
  var rowSeverity = new Map(); // row element -> severity; the strongest on the line wins
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
    if (range && ranges[d.severity]) ranges[d.severity].push(range);
    var held = rowSeverity.get(row);
    if (held === undefined || diagnosticRank(d.severity) < diagnosticRank(held)) rowSeverity.set(row, d.severity);
  });
  rowSeverity.forEach(function (severity, row) {
    row.classList.add('has-diagnostic', 'diag-' + severity);
    diagnosticsPaintedRows.push(row);
  });
  // The message itself is shown by the dwell tooltip (onDiagnosticHover), keyed off the .has-diagnostic row,
  // not a native title — so the delay and styling are ours and it appears only over the underlined line.
  try {
    if (window.CSS && CSS.highlights && typeof window.Highlight === 'function') {
      DIAGNOSTIC_TIERS.forEach(function (tier) {
        CSS.highlights.set('kakapo-diag-' + tier, new window.Highlight(...ranges[tier]));
      });
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
  var path = diagnosticsCaretPath();
  if (!path || !diagnosticsEligible(path)) return false;
  var inDiff = path !== diagnosticsSurfacePath();
  // The diff never asked for this file's diagnostics on its own account — openSourceFile is what used to
  // warm the cache — so the first press in the diff kicks the request off and reports 'pending', exactly
  // as the first press on a cold file does in the source view.
  if (inDiff) fetchDiagnostics(path);
  var cached = diagnosticsCache.get(path);
  var items = surfacedDiagnostics(cached && cached.items).slice().sort(function (a, b) {
    return a.lineIndex - b.lineIndex || a.column - b.column;
  });
  // In the diff, the problems worth stepping are the ones in the lines this review CHANGED. The diff
  // prints hunks, so a problem in untouched code has no row here at all, and stepping to it meant leaving
  // the diff for the source view mid-review with nothing saying why. It is also not what the question
  // means on this surface: "the next problem" in a review of a change is a problem in the change. The
  // count of everything is named in the message below and listed in full by ⌘6, so nothing is buried.
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
    // Three different silences, and they used to be one sentence. "No problems" is true for exactly one
    // of them; for the other two it is a reassurance the app has not earned.
    var state = cached && cached.state;
    if (!cached) showCaretHint(t('diag.pending'));                          // nothing has come back yet
    else if (state === 'unavailable') showCaretHint(t('diag.unavailable')); // no server covers this file
    else if (state === 'failed') showCaretHint(t('diag.failed'));           // the server could not answer
    // A provisional empty is a fourth silence. The server has answered but not FINISHED answering —
    // tsserver's syntactic pass lands before its suggestion pass — so "no problems in this file" is a
    // reassurance it has not earned yet, and the ⌘6 list beside it may already be showing four. It earns
    // the sentence a moment later, when the one scheduled re-ask settles the entry.
    else if (cached.provisional) showCaretHint(t('diag.pending'));
    else showCaretHint(t('diag.none'));
    return true;
  }
  // Where the caret is, in the file's own line numbers — the same answer ⌘F1 and ⌥Enter read, so the
  // three cannot disagree about which problem the caret is on. A caret in the base pane has no line here,
  // and starts the walk from the top rather than pretending its row numbers are the working tree's.
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
    // The problem is about the working tree, so it has a row in the working-tree pane — unless the line
    // is inside a hunk the diff never printed (unchanged context, collapsed away). Open the file at it
    // rather than refuse: "go to the next problem" is the promise, and the source view is where the
    // squiggle and the gutter mark live anyway.
    var wrapper = diffWrapperByPath(path);
    var rowIndex = wrapper ? diffRowIndexForLine(wrapper, 'new', target.lineIndex + 1) : -1;
    // The filter above only keeps problems that have a row here, so this is always the first branch. The
    // fallback stands for the race where the body is repainted between the filter and the jump.
    if (rowIndex >= 0) setDiffCursor(path, 'new', rowIndex, target.column, true);
    else openSourceAt(path, target.lineIndex, target.column);
  } else {
    setSourceCursor(path, target.lineIndex, target.column, true, target.lineIndex);
    scheduleSourceDiagnosticsPaint();
  }
  // sticky: a diagnostic message is the longest thing this app shows in a hint — measured to 190
  // characters, about nine seconds of reading — and the hint's own default is two. There is no way to ask
  // for it again from the keyboard, so the two-second version was a message you were shown and could not
  // read. It stays until something replaces or hides it, which is what the flag is for (07-comments.js).
  if (target.message) showCaretHint(target.message, null, true);
  return true;
}

// Surfaced diagnostics on the caret's current line, errors first, for the Opt+Enter fix action.
function diagnosticsAtCaret() {
  ensureDiagnosticsState();
  var where = diagnosticsCaretLine();
  if (!where) return [];
  var cached = diagnosticsCache.get(where.path);
  // Same rule as F2's: an answer that is not final yet is not an answer that this line is clean. ⌘F1
  // would say "no problem on this line" and ⌥Enter would refuse to draft a fix, for a problem that is
  // about to arrive — so they wait with it rather than denying it.
  if (cached && cached.provisional) return [];
  return surfacedDiagnostics(cached && cached.items)
    .filter(function (d) { return d.lineIndex === where.lineIndex; })
    .sort(function (a, b) {
      return (diagnosticRank(a.severity) - diagnosticRank(b.severity)) || (a.column - b.column);
    });
}

// Opt+Enter on a problem line: draft a change-request comment that tells the agent to fix it, folding every
// message on the line into one instruction. Saved immediately (editable/removable like any comment). The
// merged prompt already prepends @path#Lline, so the comment text only needs to carry the instruction.
function createFixCommentAtCaret() {
  var here = diagnosticsAtCaret();
  if (!here.length) return false;
  var target = currentCommentTarget();
  if (!target) return false;
  var messages = [];
  here.forEach(function (d) { if (messages.indexOf(d.message) < 0) messages.push(d.message); });
  var joined = messages.join('; ');
  // Function replacer so a diagnostic message containing $&, $1, etc. is inserted literally.
  var text = t('diag.fixComment').replace('{message}', function () { return joined; });
  addComment('c', target.path, target.line, target.code, text, target.from, target.to, target.side, target.anchorCode);
  refreshComments();
  showCaretHint(t('diag.fixAdded'));
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
    // Which severity, in words. The two colours measure 1.28:1 against each other and the marks were the
    // same shape, so a reader who cannot separate the hues had nothing at all to go on — and this message
    // is the one place that can simply say it. Two messages on one line also used to run together as a
    // single paragraph; a labelled prefix gives each one a visible start.
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
  // Same line — let a pending timer or a shown tooltip stand. But only if one of them IS standing: any
  // scroll calls hideDiagnosticTooltip, which clears the timer and leaves this key set, and every later
  // mousemove over the same line then returned here without scheduling anything. The message became
  // unreachable for that line until the pointer left the row and came back. Scrolling is not rare in the
  // middle of reading a problem — F7, ⌘L, saving a comment and the wheel all do it.
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
document.addEventListener('mouseleave', hideDiagnosticTooltip, true); // pointer left a scroller/window
document.addEventListener('scroll', hideDiagnosticTooltip, true); // a scrolled line no longer sits under the tip
