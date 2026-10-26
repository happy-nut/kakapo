// IntelliJ's code analysis, as far as a reading app can take it.
//
// Four actions, and they divide the same way IntelliJ's own menus do. Three of them answer "what is this,
// here" from the caret — Quick Documentation (F1), Expression Type (⌃⇧P) and Show Error Description
// (⌃F1) — and the fourth, the Problems view (⌘6), answers "what is wrong, anywhere" across the review.
//
// What is NOT here, and why it cannot be: Inspect Code runs IntelliJ's own inspection engine, and
// SliceBackward/SliceForward are data-flow analysis. Both need a compiler's model of the program, not a
// language server's answers about a position. The language-server diagnostics the Problems view collects
// ARE this app's inspections — they come from the same tools the project's own build uses — and saying so
// is more honest than shipping a weaker engine under IntelliJ's name.

// ---- the three caret questions ------------------------------------------------------------------
// All three are one `textDocument/hover` away, which is the request this app did not make until now: the
// eight it already made all answer "where", and none of them answers "what".

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
  // Hand the keyboard back, as the peek does — Chromium drops focus from a hidden element on its own, and
  // relying on that leaves the keyboard scope reading "a text field is focused" everywhere that does not.
  if (!hadFocus) return true;
  var body = document.getElementById('source-body');
  if (body && body.offsetParent !== null && typeof body.focus === 'function') { body.focus({ preventScroll: true }); return true; }
  var diff = document.getElementById('diff2html-container');
  if (diff && typeof diff.focus === 'function') diff.focus({ preventScroll: true });
  return true;
}

/** The symbol the caret is on, and where — shared by all three of the caret questions. */
function codeInsightTarget() {
  var symbol = symbolUnderCursor();
  if (!symbol || !symbol.name) return null;
  return symbol;
}

/**
 * F1: everything the language server has to say about the thing under the caret.
 *
 * Markdown, because that is what the protocol carries and what every bundled server writes: tsserver
 * sends a fenced signature and then the JSDoc, JDT LS sends Javadoc, rust-analyzer sends the doc comment.
 * It goes through the same markdown-it + DOMPurify stack the source preview uses rather than a second
 * renderer, so a doc comment carrying a link or an image cannot do anything here it could not do there.
 */
async function openQuickDocumentation() {
  var panel = quickDocPanel();
  var symbol = codeInsightTarget();
  if (!panel || !symbol) { if (!symbol) showSemanticNavigationFailure('symbol'); return false; }
  // A second press closes it, the way the chord that opened a panel does everywhere else here.
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

/**
 * ⌘⇧P: the type of the thing under the caret, on one line.
 *
 * The same answer F1 renders in full, cut down to the part a reader glancing at an unfamiliar call wants:
 * its signature. That is the first fenced block when the server sends one (every bundled server does) and
 * the first non-empty line otherwise.
 */
function hoverSignatureLine(markdown) {
  var text = String(markdown || '');
  var fenced = text.match(/```[^\n]*\n([\s\S]*?)```/);
  var body = fenced ? fenced[1] : text;
  var lines = body.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  if (!lines.length) return '';
  // A multi-line signature (an overload set, a Kotlin function with its receiver on its own line) is
  // joined rather than truncated: the first line of `fun <T> List<T>.` says nothing on its own.
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

/**
 * ⌘F1: the message of the problem the caret is on, in full.
 *
 * The gutter already carries it in a hover tooltip (18-diagnostics.js), which is a mouse affordance on a
 * surface whose whole point is the keyboard — and a long message is cut off there. This is the same text
 * with no pointer and no truncation.
 */
function showErrorDescriptionAtCaret() {
  var items = diagnosticsAtCaret();
  if (!items || !items.length) {
    showCaretHint(t('problems.noneHere'));
    return true;
  }
  var text = items.map(function (item) {
    var source = item.source ? item.source + ': ' : '';
    return source + String(item.message || '').replace(/\s+/g, ' ');
  }).join(' — ');
  showCaretHint(text);
  return true;
}

/**
 * ⌥Space / ⌘Y: the definition's own code, here — IntelliJ's Quick Definition.
 *
 * ⌘↓ takes you there; this shows it without taking you anywhere, which is the difference that matters when
 * the question is "what does this call do" in the middle of reading something else. Same panel as Quick
 * Documentation because it is the same shape of answer — a caret-anchored box with a heading — and the two
 * can never be up at once.
 */
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
  // A definition outside the review — a dependency, a stdlib module, a class inside a JDK image — has no
  // body this page can read. Saying where it is beats showing an empty box.
  if (target.external || !sourceByPath.has(target.path)) {
    if (meta) meta.textContent = semanticFileLabel(target.path, target.lineIndex);
    if (body) body.innerHTML = '<div class="quick-doc-empty">' + escapeHtml(t('quickdef.outside')) + '</div>';
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

// How many lines of the definition to show. IntelliJ sizes its popup to the whole declaration; this takes
// the server's own end line when it sent one and a fixed window when it did not — a 400-line class would
// otherwise fill the screen with a panel you cannot scroll out of the way.
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

// ---- ⌘6: the Problems view ------------------------------------------------------------------------
// IntelliJ's Problems tool window, on IntelliJ's own chord. The diagnostics were already here — every one
// of them — but only ever for the file on screen, one file at a time (18-diagnostics.js asks for the open
// path). "Is anything wrong in this review" had no answer, which for a reviewer is the first question.
//
// A mode of the quick-open shell, like the structure list, the hierarchies and the usage view: its filter,
// its keyboard handling and its preview are written, and a fifth list surface would be a fifth copy.

var problemRows = [];
var problemsBusy = false;
var problemsScanned = 0;
var problemsTotal = 0;
var problemsSeq = 0;
var problemsGeneration = -1;
// Errors first and warnings after is the order a reviewer reads in, and hiding the quiet ones is the
// toolbar button IntelliJ puts above the list.
var problemsErrorsOnly = false;
// Files no language server covers. They are NOT zero problems — USER_FLOWS Flow 6 is explicit that an
// empty answer for an unanalysable file is the misleading version — so they are counted and said out loud.
var problemsUnavailable = 0;
// How many files are asked at once. The request is cheap per file and expensive per SERVER — each one
// opens the document — so this is a politeness bound on the language server, not on the page.
var PROBLEMS_CONCURRENCY = 4;

/** ⌘6. */
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

/** Which files are worth asking about: the review's own, that the page actually has content for. */
function problemFilePaths() {
  var paths = [];
  sourceFiles.forEach(function (file) {
    if (!file || !file.path || !file.embedded || file.image) return;
    if (!diagnosticsEligible(file.path)) return;
    paths.push(file.path);
  });
  return paths;
}

/**
 * Ask every file, a few at a time, and paint as the answers land.
 *
 * Progressive rather than awaited-in-full because the first answer is useful and the last one may be a
 * cold server away: a reviewer who opens this on a 60-file branch should see the first errors immediately
 * and watch the count fill in, not stare at a spinner for a minute.
 */
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
      // Errors and warnings only, which is what this app surfaces anywhere — info and hint are collected
      // by main and shown nowhere, and a Problems list that disagreed with the gutter beside it would be
      // two different answers to one question.
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

/** One file's diagnostics, through the same bridge 18-diagnostics.js uses — a bare path, as it takes. */
function queryProjectDiagnostics(path) {
  if (!window.kakapoAnalysis || typeof window.kakapoAnalysis.diagnostics !== 'function') return Promise.resolve(null);
  return Promise.resolve(window.kakapoAnalysis.diagnostics(path));
}

var PROBLEM_ORDER = { error: 0, warning: 1, info: 2, hint: 3 };

function visibleProblemRows(query) {
  var needle = String(query || '').trim().toLowerCase();
  var queries = queryVariants(needle);
  return problemRows.filter(function (row) {
    if (problemsErrorsOnly && row.severity !== 'error') return false;
    if (!needle) return true;
    var hay = (row.path + ' ' + row.message).toLowerCase();
    return queries.some(function (variant) { return hay.includes(variant); });
  }).sort(function (a, b) {
    return (PROBLEM_ORDER[a.severity] - PROBLEM_ORDER[b.severity])
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
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
  var errors = problemRows.filter(function (row) { return row.severity === 'error'; }).length;
  if (quickFilterEl) {
    quickFilterEl.className = 'quick-open-filter' + (problemsBusy ? ' is-loading' : '');
    var summary = t('problems.summary')
      .replace('{n}', String(problemRows.length))
      .replace('{errors}', String(errors))
      .replace('{files}', String(problemsTotal));
    if (problemsUnavailable) {
      summary += ' · ' + t('problems.unavailable').replace('{n}', String(problemsUnavailable));
    }
    quickFilterEl.innerHTML = problemsBusy
      ? kakapoLoaderHtml('kakapo-loader-micro') + '<span>'
        + escapeHtml(t('problems.scanning').replace('{done}', String(problemsScanned)).replace('{total}', String(problemsTotal)))
        + '</span>'
      : escapeHtml(summary);
  }
  if (!rows.length) {
    var empty = problemsBusy ? t('quickopen.searching')
      : problemsErrorsOnly && problemRows.length ? t('problems.noErrors')
        : t('problems.none');
    quickResults.innerHTML = '<div class="quick-open-empty">' + escapeHtml(empty)
      // "No problems" over a review where half the files had no server is the reassuring lie Flow 6 names.
      + (!problemsBusy && problemsUnavailable
        ? '<span class="quick-open-why">' + escapeHtml(t('problems.unavailableWhy').replace('{n}', String(problemsUnavailable))) + '</span>'
        : '')
      + '</div>';
    renderQuickPreview(null);
    return;
  }
  quickResults.innerHTML = rows.map(function (row, index) {
    return '<button type="button" class="quick-open-item problem-result' + (index === quickActive ? ' active' : '')
      + '" data-index="' + index + '" data-severity="' + escapeHtml(row.severity) + '"'
      + ' title="' + escapeHtml(row.path + ':' + (row.lineIndex + 1)) + '">'
      + '<span class="problem-mark" aria-hidden="true"></span>'
      + '<span class="quick-open-main"><span class="problem-message">' + escapeHtml(row.message) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(semanticFileLabel(row.path, row.lineIndex))
      + (row.source ? ' · ' + escapeHtml(row.source) : '') + '</span></span>'
      + '<span class="quick-open-badge">' + escapeHtml(t('problems.severity.' + row.severity)) + '</span></button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

/** ⌥E inside the list: errors only, which is the one filter IntelliJ's toolbar is really used for. */
function toggleProblemsErrorsOnly() {
  problemsErrorsOnly = !problemsErrorsOnly;
  quickActive = 0;
  renderProblemsResults(String(quickInput && quickInput.value || ''));
  return true;
}

function handleProblemsKey(event) {
  if (quickMode !== 'problems') return false;
  // The launcher owns every key while it is up (KEY_OWNERS in 05-keymap.js), so the chord that opened this
  // list never reaches the dispatcher — it is answered here, the way the hierarchy answers its own.
  if (isShortcut(event, 'problemsView')) { event.preventDefault(); closeQuickOpen(); return true; }
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
    && (event.code === 'KeyE' || String(event.key).toLowerCase() === 'e')) {
    event.preventDefault();
    return toggleProblemsErrorsOnly();
  }
  return false;
}
