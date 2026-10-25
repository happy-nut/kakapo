// Find Usages: the half of IntelliJ's code exploration that the structure port (16-structure.js) left out.
//
// ⌘B already answers "who uses this" as a caret popup — that is IntelliJ's Show Usages, and it is a flat
// list. What it cannot say is WHAT each usage is, and that is the question a reviewer actually arrives
// with: this symbol has forty references, which of them WRITE to it, which are imports, which are a line
// of prose in a comment. IntelliJ answers it by grouping the usage view by usage type, so that is what
// ⌥F7 does here.
//
// The type names are not invented. They are IntelliJ's own, read out of
// `platform/usageView/resources/messages/UsageViewBundle.properties` in intellij-community — "Value read",
// "Usage in extends/implements clause", "New instance creation" — and the ids below are that file's keys
// with the `usage.type.` prefix dropped. A type IntelliJ has and a line of text cannot decide (field vs
// local declaration needs to know whether the enclosing scope is a class body) is simply not in the table:
// the alternative is a group header that is right about half the time, which is worse than no header.
//
// Ceiling, stated once: everything here classifies ONE LINE at a time, because one line of text is what an
// analyzer answer carries. A block comment opened on a previous line is therefore invisible to it, and so
// is a multi-line string. The comment/string zone scan below is honest about the line it is given and
// nothing more.
// ponytail: line-local zones. If this ever needs to be right about a `/*` three lines up, the masked
// copy main already builds (maskNonCode in analysis-index.ts) is the thing to ask, not a bigger regex.

// Which characters open a comment, by language family. `#` is not a comment in C and `//` is not one in
// Python, and guessing wrong turns real code into a "Usage in comments" group.
var USAGE_HASH_LANGUAGES = {
  python: 1, ruby: 1, bash: 1, shell: 1, sh: 1, zsh: 1, yaml: 1, yml: 1, toml: 1, perl: 1, r: 1,
  makefile: 1, dockerfile: 1, elixir: 1, julia: 1, nim: 1, ini: 1, properties: 1, conf: 1, gitignore: 1,
};
var USAGE_DASH_LANGUAGES = { sql: 1, lua: 1, haskell: 1, ada: 1, elm: 1 };
var USAGE_MARKUP_LANGUAGES = { html: 1, xml: 1, markdown: 1, md: 1, svg: 1, vue: 1, svelte: 1 };

function usageLanguageOf(path) {
  var file = typeof sourceByPath !== 'undefined' ? sourceByPath.get(path) : null;
  return String((file && file.language) || '').toLowerCase();
}

/**
 * Which zone of the line column `column` sits in: 'code', 'comment' or 'string'.
 *
 * One left-to-right walk with a quote state, which is the only way to tell `"// not a comment"` from a
 * real one — and telling those apart is the whole reason this exists rather than a `line.indexOf('//')`.
 */
function usageZoneAt(line, column, language) {
  var text = String(line || '');
  var limit = Math.max(0, Math.min(Number(column) || 0, text.length));
  var hash = USAGE_HASH_LANGUAGES[language] === 1;
  var dash = USAGE_DASH_LANGUAGES[language] === 1;
  var markup = USAGE_MARKUP_LANGUAGES[language] === 1;
  var quote = '';
  for (var i = 0; i < limit; i += 1) {
    var ch = text.charAt(i);
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (!hash && ch === '/' && text.charAt(i + 1) === '/') return 'comment';
    if (!hash && ch === '/' && text.charAt(i + 1) === '*') return 'comment';
    if (hash && ch === '#') return 'comment';
    if (dash && ch === '-' && text.charAt(i + 1) === '-') return 'comment';
    if (markup && text.substr(i, 4) === '<!--') return 'comment';
  }
  return quote ? 'string' : 'code';
}

// Every usage type this can decide, in the order the groups are shown — IntelliJ's own order: what the
// usage IS, then the value accesses, then the ones that are not code at all.
var USAGE_TYPE_ORDER = [
  // First, and its own group: a declaration is not a usage. IntelliJ keeps the target's declaration apart
  // from the usages it found, and a language server hands one back anyway — tsserver answers
  // `references` with the `export class Store {` line whether or not includeDeclaration was asked for.
  // Labelling that "Value read" was wrong in the real app, which is where it was caught.
  'declaration',
  'import', 'extends', 'new', 'annotation', 'instanceof', 'cast', 'type.parameter',
  'parameter.declaration', 'return', 'local.declaration', 'write', 'read', 'unclassified',
  'string.constant', 'comment',
];
// The two IntelliJ puts under its "Non-code usages" node.
var USAGE_NON_CODE = { 'string.constant': 1, comment: 1 };

var USAGE_IMPORT_LINE = /^\s*(?:import\b|from\s|export\s+(?:\*|\{)|use\s|using\s|require\b|#include\b|package\b|@import\b|load\()/;
var USAGE_EXTENDS_BEFORE = /\b(?:extends|implements|with)\s+(?:[A-Za-z0-9_$.<>,\s]*,\s*)?$/;
var USAGE_CLASS_HEADER = /^\s*(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|static|export|default|pub(?:\([^)]*\))?)\s+)*(?:class|interface|struct|trait|enum|object|record|protocol)\b/;
// A declaring keyword immediately before THIS name — `export class Store`, `let count`, `def run`. Not
// `const subject = Store`, where the keyword declares something else and Store is read.
var USAGE_DECLARES_BEFORE = /\b(?:class|interface|struct|trait|enum|type|function|func|fn|def|val|var|let|const|object|record|protocol|namespace|module)\s+$/;

/**
 * What kind of usage the occurrence of `name` at `column` in `text` is — one of USAGE_TYPE_ORDER.
 *
 * Decided from the characters on either side, in the order a narrower rule beats a wider one. Returns
 * 'unclassified' for a plain call, which is what IntelliJ does too: a call site has no usage type of its
 * own there, and it shows under the file rather than under a header.
 */
function classifyUsage(name, text, column, path) {
  var line = String(text || '');
  var at = Math.max(0, Number(column) || 0);
  var zone = usageZoneAt(line, at, usageLanguageOf(path));
  if (zone === 'comment') return 'comment';
  if (zone === 'string') return 'string.constant';
  var before = line.slice(0, at);
  var after = line.slice(at + String(name || '').length);
  if (USAGE_DECLARES_BEFORE.test(before)) return 'declaration';
  if (/@\s*$/.test(before)) return 'annotation';
  if (/^\s*#\[/.test(line)) return 'annotation';
  if (USAGE_IMPORT_LINE.test(line) && !/^\s*\(/.test(after)) return 'import';
  if (/\bnew\s+$/.test(before)) return 'new';
  if (/\binstanceof\s+$/.test(before) || /\bisinstance\s*\([^,)]*,\s*$/.test(before)) return 'instanceof';
  // `extends`/`implements`, and a class header's `:` or `(` list — Kotlin's `class A : B`, Python's
  // `class A(B)`. Gated on the line being a class header so that an ordinary `x: Type` does not land here.
  if (USAGE_EXTENDS_BEFORE.test(before) && USAGE_CLASS_HEADER.test(line)) return 'extends';
  if (/\bclass\s+[A-Za-z0-9_$]+\s*\([A-Za-z0-9_$.,\s]*$/.test(before)) return 'extends';
  if (/\bimpl\b[^{]*\bfor\s+$/.test(before)) return 'extends';
  if (/\bas\s+$/.test(before) || (/\(\s*$/.test(before) && /^\s*\)\s*[A-Za-z0-9_$]/.test(after))) return 'cast';
  if (/<\s*(?:[A-Za-z0-9_$.<>,\s]*,\s*)?$/.test(before) && /^\s*[,>]/.test(after)) return 'type.parameter';
  // `(a: Name, …)` and `): Name` / `-> Name` read the same way round: a colon or arrow, then whether the
  // text before it is still inside the parameter list or already past its closing paren.
  if (/(?::|->)\s*$/.test(before)) {
    if (USAGE_CLASS_HEADER.test(line)) return 'extends'; // Kotlin's `class A : B`, Scala's `: B with C`
    if (/\)\s*(?::|->)\s*$/.test(before)) return 'return';
    if (/\([^)]*$/.test(before)) return 'parameter.declaration';
    if (/\b(?:let|const|var|val)\s+[A-Za-z0-9_$]+\s*:\s*$/.test(before)) return 'local.declaration';
  }
  if (/^\s*(?:=(?![=>])|\+=|-=|\*=|\/=|%=|\|\|=|&&=|\?\?=|\|=|&=|\^=|<<=|>>=)/.test(after)) return 'write';
  if (/(?:\+\+|--)\s*$/.test(before) || /^\s*(?:\+\+|--)/.test(after)) return 'write';
  // A call. IntelliJ leaves these without a type, and a header reading "Value read" over forty call sites
  // would be a lie about every one of them.
  if (/^\(/.test(after) || /^<[^<>]*>\s*\(/.test(after)) return 'unclassified';
  return 'read';
}

function usageTypeLabel(type) {
  return t('usagetype.' + type);
}

// ---- ⌥F7: the usage view ----------------------------------------------------------------------------
// A mode of the quick-open shell, like the structure list and the two hierarchies, and for the same
// reason: its filter box, its keyboard handling and its preview pane are already written, and a fourth
// list surface would be a fourth copy of all three. The one thing this mode adds is group headers, which
// are rendered between the rows and carry no index of their own — `data-index` stays the index into
// `quickItems`, so arrows, Enter and the preview keep working untouched.

var usageViewName = '';
var usageViewLoc = null;
var usageViewRows = [];
var usageViewBusy = false;
var usageViewEngine = '';
var usageViewNote = '';
var usageViewSeq = 0;
// IntelliJ's "Show Usages in Comments" and friends are per-type checkboxes in a toolbar. kakapo already
// has one toggle that means exactly "comments and tests are noise" — Find in Files' ⌥P — so the usage view
// borrows it rather than growing a toolbar of its own.
var usageViewHideNoise = false;

/** ⌥F7: every usage of the symbol under the caret, grouped by what kind of usage it is. */
function openFindUsages() {
  var symbol = symbolUnderCursor();
  if (!symbol || !symbol.name) { showSemanticNavigationFailure('symbol'); return false; }
  usageViewName = symbol.name;
  usageViewLoc = symbol;
  usageViewRows = [];
  usageViewNote = '';
  usageViewBusy = true;
  usageViewEngine = '';
  openQuickOpen('usages', true);
  loadFindUsages();
  return true;
}

function loadFindUsages() {
  var seq = ++usageViewSeq;
  var loc = usageViewLoc;
  Promise.resolve(queryProjectAnalysis('references', usageViewName, loc)).then(function (response) {
    if (seq !== usageViewSeq || quickMode !== 'usages') return;
    usageViewBusy = false;
    var revision = revisionDecline(response);
    if (revision !== null) {
      usageViewRows = [];
      usageViewNote = t('monaco.analysisRevision').replace('{revision}', revision).replace('{symbol}', usageViewName);
      renderFindUsagesResults(String(quickInput && quickInput.value || ''));
      return;
    }
    usageViewEngine = response && response.engine === 'lsp' ? (response.server || 'LSP') : 'index';
    // The declaration the caret is sitting on is not one of its own usages — same filter ⌘B applies, for
    // the same reason: a server that reports it would otherwise put the line you are already on at the top.
    usageViewRows = ((response && response.locations) || []).filter(function (item) {
      return item && item.path && !(loc && item.path === loc.path && Number(item.lineIndex) === Number(loc.lineIndex));
    }).map(function (item) {
      var text = String(item.text || '');
      return {
        path: item.path,
        lineIndex: Number(item.lineIndex) || 0,
        column: Number(item.column) || 0,
        text: text,
        type: classifyUsage(usageViewName, text, item.column, item.path),
        isTest: semanticTestPath(item.path),
      };
    });
    usageViewNote = !usageViewRows.length && response && response.fallbackReason ? String(response.fallbackReason) : '';
    quickActive = 0;
    renderFindUsagesResults(String(quickInput && quickInput.value || ''));
  }, function () {
    if (seq !== usageViewSeq) return;
    usageViewBusy = false;
    renderFindUsagesResults(String(quickInput && quickInput.value || ''));
  });
}

/** The rows the filters leave: the typed query, and ⌥P's "comments and tests are noise". */
function visibleUsageRows(query) {
  var needle = String(query || '').trim().toLowerCase();
  var queries = queryVariants(needle);
  return usageViewRows.filter(function (row) {
    if (usageViewHideNoise && (row.isTest || USAGE_NON_CODE[row.type] === 1)) return false;
    if (!needle) return true;
    var hay = (row.path + ' ' + row.text).toLowerCase();
    return queries.some(function (variant) { return hay.includes(variant); });
  });
}

/** Rows in display order, as `[{type, rows}]` — IntelliJ's group order, empty groups left out. */
function groupUsageRows(rows) {
  var byType = {};
  rows.forEach(function (row) {
    (byType[row.type] || (byType[row.type] = [])).push(row);
  });
  return USAGE_TYPE_ORDER.filter(function (type) { return byType[type]; }).map(function (type) {
    return {
      type: type,
      nonCode: USAGE_NON_CODE[type] === 1,
      rows: byType[type].slice().sort(function (a, b) {
        return a.path.localeCompare(b.path) || a.lineIndex - b.lineIndex || a.column - b.column;
      }),
    };
  });
}

function renderFindUsagesResults(query) {
  if (!quickResults) return;
  var groups = groupUsageRows(visibleUsageRows(query));
  var flat = [];
  groups.forEach(function (group) { group.rows.forEach(function (row) { flat.push(row); }); });
  quickItems = flat.map(function (row) {
    return {
      path: row.path,
      name: sourceTabLabel(row.path),
      detail: usageTypeLabel(row.type),
      kind: 'symbol',
      recent: false,
      lineIndex: row.lineIndex,
      column: row.column,
      text: row.text,
    };
  });
  quickActive = Math.min(quickActive, Math.max(quickItems.length - 1, 0));
  var files = {};
  flat.forEach(function (row) { files[row.path] = 1; });
  if (quickFilterEl) {
    quickFilterEl.className = 'quick-open-filter' + (usageViewBusy ? ' is-loading' : '');
    quickFilterEl.innerHTML = usageViewBusy
      ? kakapoLoaderHtml('kakapo-loader-micro') + '<span>' + escapeHtml(t('quickopen.searching')) + '</span>'
      : escapeHtml(t('findusages.summary')
        .replace('{n}', String(flat.length))
        .replace('{files}', String(Object.keys(files).length))
        + (usageViewEngine ? ' · ' + usageViewEngine : ''));
  }
  if (usageViewBusy) {
    quickResults.innerHTML = loadingStateHtml(t('quickopen.searching'), 'quick-open-empty');
    renderQuickPreview(null);
    return;
  }
  if (!flat.length) {
    quickResults.innerHTML = '<div class="quick-open-empty">'
      + escapeHtml(t('findusages.none').replace('{name}', usageViewName))
      + (usageViewNote ? '<span class="quick-open-why">' + escapeHtml(usageViewNote) + '</span>' : '')
      + '</div>';
    renderQuickPreview(null);
    return;
  }
  var index = 0;
  var html = '';
  var openedNonCode = false;
  // "Unclassified" over a list that is nothing but call sites says nothing — and in IntelliJ an untyped
  // usage has no node of its own either, it hangs off the file. So the one group that is only ever a
  // leftover does not get a heading when it is the whole answer.
  var soleUnclassified = groups.length === 1 && groups[0].type === 'unclassified';
  groups.forEach(function (group) {
    if (group.nonCode && !openedNonCode) {
      openedNonCode = true;
      html += '<div class="usage-group usage-group-noncode">' + escapeHtml(t('findusages.noncode')) + '</div>';
    }
    if (!soleUnclassified) html += '<div class="usage-group" data-usage-type="' + escapeHtml(group.type) + '">'
      + '<span class="usage-group-name">' + escapeHtml(usageTypeLabel(group.type)) + '</span>'
      + '<span class="usage-group-count">' + String(group.rows.length) + '</span></div>';
    group.rows.forEach(function (row) {
      html += '<button type="button" class="quick-open-item usage-result' + (index === quickActive ? ' active' : '')
        + (row.isTest ? ' is-test' : '') + '" data-index="' + index + '" data-usage-type="' + escapeHtml(row.type) + '"'
        + ' title="' + escapeHtml(usageTypeLabel(row.type) + ' — ' + row.path + ':' + (row.lineIndex + 1)) + '">'
        + '<span class="quick-open-main"><span class="usage-result-code">'
        + semanticCodeHtml(row.path, row.text.trim().slice(0, 180)) + '</span>'
        + '<span class="quick-open-path">' + escapeHtml(semanticFileLabel(row.path, row.lineIndex)) + '</span></span></button>';
      index += 1;
    });
  });
  quickResults.innerHTML = html;
  renderQuickPreview(quickItems[quickActive]);
}

/** ⌥P inside the usage view: the same "comments and tests are noise" toggle Find in Files has. */
function toggleUsageViewNoise() {
  usageViewHideNoise = !usageViewHideNoise;
  quickActive = 0;
  renderFindUsagesResults(String(quickInput && quickInput.value || ''));
  syncContentSearchControls();
  return true;
}

function handleUsageViewKey(event) {
  if (quickMode !== 'usages') return false;
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
    && (event.code === 'KeyP' || String(event.key).toLowerCase() === 'p')) {
    event.preventDefault();
    return toggleUsageViewNoise();
  }
  return false;
}

// ---- ⌘F7 / ⌘⇧F7: the same symbol, highlighted where the caret already is -----------------------------
// IntelliJ's Find Usages in File and Highlight Usages in File. Both are editor-local there, and both are
// one thing here: paint every occurrence in the open file, writes apart from reads, and let ⌘⌥↓/⌘⌥↑ walk
// them. No analyzer round trip — a highlight that waits for a cold language server is a highlight that
// arrives after the reader has moved on, and IntelliJ's own ⌃F3 (Find Word at Caret) is name-based too.
//
// Name-based is the honest description: two different locals that happen to share a name are highlighted
// together. ⌥F7 is the semantic answer, and the count line says which of the two you are looking at.

var USAGE_MARK_LIMIT = 5000;
var USAGE_MARK_PAINT_LIMIT = 200;
var usageMarks = [];
var usageMarkPath = '';
var usageMarkName = '';
var usageMarkActive = -1;
var usageMarkGeneration = -1;

/** Every code occurrence of `name` in `path`'s content, with 'read'/'write' per occurrence. */
function usageMarksIn(path, name) {
  var file = typeof sourceByPath !== 'undefined' ? sourceByPath.get(path) : null;
  if (!file || !file.embedded || file.image || !name) return [];
  var language = usageLanguageOf(path);
  var pattern = new RegExp('(?:^|[^A-Za-z0-9_$])(' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![A-Za-z0-9_$])', 'g');
  var marks = [];
  String(file.content || '').split(/\r?\n/).some(function (line, lineIndex) {
    pattern.lastIndex = 0;
    var match = null;
    while ((match = pattern.exec(line))) {
      var column = match.index + match[0].length - match[1].length;
      pattern.lastIndex = column + match[1].length;
      if (usageZoneAt(line, column, language) !== 'code') continue;
      var type = classifyUsage(name, line, column, path);
      var initialised = type === 'declaration' && /^\s*=(?![=>])/.test(line.slice(column + name.length));
      marks.push({ path: path, lineIndex: lineIndex, column: column, length: name.length, write: type === 'write' || initialised });
      if (marks.length >= USAGE_MARK_LIMIT) return true;
    }
    return false;
  });
  return marks;
}

function clearUsageHighlights() {
  usageMarks = [];
  usageMarkPath = '';
  usageMarkName = '';
  usageMarkActive = -1;
  usageMarkGeneration = -1;
  Array.prototype.forEach.call(document.querySelectorAll('.usage-mark-row'), function (row) {
    row.classList.remove('usage-mark-row');
  });
  try {
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete('kakapo-usage-read');
      CSS.highlights.delete('kakapo-usage-write');
    }
  } catch (e) {}
}

/**
 * Paint the marks. The ranges go through the Custom Highlight API, as the in-file find's do (17-file-find.js
 * owns fileFindRange and sourceFindRow) — a highlight that does not touch the DOM is one that cannot
 * disturb the tokenised source it is drawn over.
 */
function paintUsageHighlights() {
  var reads = [], writes = [];
  Array.prototype.forEach.call(document.querySelectorAll('.usage-mark-row'), function (row) {
    row.classList.remove('usage-mark-row');
  });
  var indexes = [];
  for (var i = 0; i < Math.min(usageMarks.length, USAGE_MARK_PAINT_LIMIT); i += 1) indexes.push(i);
  if (usageMarkActive >= USAGE_MARK_PAINT_LIMIT) indexes.push(usageMarkActive);
  indexes.forEach(function (index) {
    var mark = usageMarks[index];
    if (!mark) return;
    var row = sourceFindRow(mark.lineIndex);
    if (row) row.classList.add('usage-mark-row');
    var container = row && (row.querySelector('.source-code') || row);
    if (!container) return;
    var shown = container.textContent || '';
    var start = mark.column;
    if (shown.substr(start, mark.length) !== usageMarkName) start = shown.indexOf(usageMarkName);
    if (start < 0) return;
    var range = fileFindRange(container, start, mark.length);
    if (!range) return;
    (mark.write ? writes : reads).push(range);
  });
  try {
    if (window.CSS && CSS.highlights && typeof window.Highlight === 'function') {
      CSS.highlights.set('kakapo-usage-read', new window.Highlight(...reads));
      CSS.highlights.set('kakapo-usage-write', new window.Highlight(...writes));
    }
  } catch (e) {}
  return { reads: reads.length, writes: writes.length };
}

/** The marks for the symbol under the caret in the open file, computed once and reused by the step keys. */
function ensureUsageMarks() {
  if (!isSourceViewerVisible()) return false;
  var symbol = wordAtCursor();
  var path = (document.getElementById('source-viewer') || { dataset: {} }).dataset.openPath || '';
  if (!symbol || !symbol.name || !path) return false;
  if (usageMarkName === symbol.name && usageMarkPath === path && usageMarks.length
    && usageMarkGeneration === analysisGeneration()) return true;
  usageMarks = usageMarksIn(path, symbol.name);
  usageMarkPath = path;
  usageMarkName = symbol.name;
  usageMarkGeneration = analysisGeneration();
  usageMarkActive = -1;
  return usageMarks.length > 0;
}

/** ⌘F7 / ⌘⇧F7: highlight them, and say how many there are — including none. */
function highlightUsagesInFile() {
  if (!isSourceViewerVisible()) return false;
  var symbol = wordAtCursor();
  if (!symbol || !symbol.name) return false;
  // A second press on the same symbol puts the highlight away, as Escape does. IntelliJ keeps it until
  // Escape; a toggle is the same key answering for both, and the key is the one that is already under the
  // finger.
  if (usageMarkName === symbol.name && usageMarks.length) { clearUsageHighlights(); return true; }
  clearUsageHighlights();
  if (!ensureUsageMarks()) {
    showCaretHint(t('findusages.noneInFile').replace('{name}', symbol.name));
    return true;
  }
  var painted = paintUsageHighlights();
  showCaretHint(t('findusages.inFile')
    .replace('{n}', String(usageMarks.length))
    .replace('{name}', symbol.name)
    .replace('{writes}', String(usageMarks.filter(function (mark) { return mark.write; }).length)));
  return painted !== null;
}

/**
 * ⌘⌥↓ / ⌘⌥↑: the next or previous occurrence of the symbol under the caret — IntelliJ's
 * GotoNextElementUnderCaretUsage. Works without pressing ⌘F7 first, as IntelliJ's does: the marks are
 * computed on demand and the highlight comes with them.
 */
function stepUsageOccurrence(delta) {
  if (!isSourceViewerVisible()) return false;
  if (!ensureUsageMarks()) return false;
  var line = viewerCursor ? viewerCursor.lineIndex : 0;
  var column = viewerCursor ? viewerCursor.column : 0;
  var target = -1;
  if (delta > 0) {
    for (var i = 0; i < usageMarks.length; i += 1) {
      var next = usageMarks[i];
      if (next.lineIndex > line || (next.lineIndex === line && next.column > column)) { target = i; break; }
    }
    if (target < 0) target = 0; // IntelliJ wraps, and so does the in-file find
  } else {
    for (var j = usageMarks.length - 1; j >= 0; j -= 1) {
      var prev = usageMarks[j];
      if (prev.lineIndex < line || (prev.lineIndex === line && prev.column < column)) { target = j; break; }
    }
    if (target < 0) target = usageMarks.length - 1;
  }
  var mark = usageMarks[target];
  if (!mark) return false;
  usageMarkActive = target;
  openSourceAt(mark.path, mark.lineIndex, mark.column);
  paintUsageHighlights();
  showCaretHint(t('findusages.occurrence')
    .replace('{i}', String(target + 1))
    .replace('{n}', String(usageMarks.length))
    .replace('{name}', usageMarkName));
  return true;
}
