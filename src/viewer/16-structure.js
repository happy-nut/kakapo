// Navigating by structure rather than by scrolling: the open file's symbols, the symbol boundaries the
// caret steps between, where a type is declared, and the places you have already been.
//
// All four reuse surfaces that already exist. The structure list and the recent-locations list are modes of
// the quick-open shell (its filter, its keyboard handling, its preview — a second dialog would be a second
// set of all three), and the jumps go through the same openSourceAt/restoreNav the rest of the app uses.

// The open file's symbols, keyed by path and by the analysis generation that answered — a rebuild moves
// line numbers, and a cached structure would then point at the wrong lines.
var structureCache = new Map();
var structureQuery = '';
var structureItems = [];
var structureBusy = false;
var structureEngine = '';
var structureSeq = 0;
var structurePath = '';

/**
 * The structure of `path`, asked of main once per file per analysis generation.
 *
 * Cached because two of the four features here read it per keystroke (the filter) and per keypress
 * (next/previous symbol); one round-trip per file is the difference between a list that opens instantly and
 * one that re-queries a language server while someone types.
 */
function fileStructureSymbols(path) {
  if (!path) return Promise.resolve({ symbols: [], engine: '' });
  var cached = structureCache.get(path);
  if (cached && cached.generation === analysisGeneration()) return Promise.resolve(cached.value);
  return Promise.resolve(queryProjectAnalysis('documentSymbol', null, { path: path, lineIndex: 0, column: 0 }))
    .then(function (response) {
      var value = {
        symbols: response && Array.isArray(response.symbols) ? response.symbols : [],
        engine: revisionDecline(response) !== null
          ? t('quickopen.revisionOff')
          : response && response.engine === 'lsp' ? (response.server || 'LSP') : 'index',
      };
      structureCache.set(path, { generation: analysisGeneration(), value: value });
      return value;
    }, function () { return { symbols: [], engine: '' }; });
}

/**
 * Which repository generation a cached structure belongs to.
 *
 * Read off the analysis-status element, which is where main publishes it (15-analysis-status.js) and what
 * analysisGenerationIsCurrent already compares against. A rebuild moves line numbers, so a structure from
 * an older generation points at the wrong lines — the cache key has to move with it.
 */
function analysisGeneration() {
  var status = document.getElementById('analysis-status');
  return status ? Number(status.dataset.generation) || 0 : 0;
}

/** ⌘F12: the open file's structure, filterable, Enter to jump. */
function openFileStructure() {
  var path = structureTargetPath();
  if (!path) return false;
  structurePath = path;
  structureQuery = '\0'; // forces the first render to load, as the symbol mode does
  structureItems = [];
  structureBusy = true;
  openQuickOpen('structure', true);
  return true;
}

/** Which file the structure is of: the open source tab, else the file the diff is showing. */
function structureTargetPath() {
  if (isSourceViewerVisible()) {
    var open = sourceOpenPath();
    if (open) return open;
  }
  var loc = caretSourceLoc();
  return loc ? loc.path : '';
}

function structureSymbolItems(symbols) {
  return symbols.map(function (symbol) {
    return {
      path: structurePath,
      name: String(symbol.name || ''),
      detail: String(symbol.kind || 'symbol'),
      kind: 'symbol',
      recent: false,
      depth: Math.max(0, Number(symbol.depth) || 0),
      summary: String(symbol.detail || ''),
      lineIndex: Number(symbol.lineIndex) || 0,
      column: Number(symbol.column) || 0,
      endLineIndex: Number(symbol.endLineIndex) || Number(symbol.lineIndex) || 0,
      text: String(symbol.detail || symbol.name || ''),
    };
  });
}

/**
 * The structure mode's list. Filtering is local — the whole structure of one file is already here, so a
 * keystroke is a filter and not another query — and it folds Korean jamo the way file search does.
 */
function renderFileStructureResults(query) {
  if (query !== structureQuery) {
    structureQuery = query;
    var seq = ++structureSeq;
    structureBusy = structureBusy || !structureCache.has(structurePath);
    fileStructureSymbols(structurePath).then(function (value) {
      if (seq !== structureSeq || quickMode !== 'structure') return;
      structureEngine = value.engine;
      structureBusy = false;
      structureItems = structureSymbolItems(value.symbols);
      quickActive = 0;
      renderFileStructureResults(query);
    });
  }
  var queries = queryVariants(String(query || ''));
  var needle = String(query || '').trim().toLowerCase();
  // NAMES only, as IntelliJ's structure search matches. Including the signature in the haystack looked
  // like a bonus and was a surprise: typing "store" in a class listing then also returned every member
  // whose return type happened to be Store. The signature stays visible on the row.
  quickItems = needle
    ? structureItems.filter(function (item) {
      var hay = [item.name];
      return matchesQueryVariants(hay, queries);
    })
    : structureItems;
  clampQuickActive();
  setQuickFilterChip(structureBusy, sourceTabLabel(structurePath) + ' · ' + resultsLabel(quickItems.length)
    + (structureEngine ? ' · ' + structureEngine : ''));
  if (structureBusy) {
    showQuickLoading();
    return;
  }
  if (!quickItems.length) {
    showQuickEmpty(t(structureItems.length ? 'quickopen.noMatches' : 'structure.none'));
    return;
  }
  quickResults.innerHTML = quickItems.map(function (item, index) {
    return '<button type="button" class="quick-open-item symbol-result structure-result'
      + (index === quickActive ? ' active' : '') + '" data-index="' + index + '"'
      + ' style="--structure-depth:' + Math.min(item.depth, 6) + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(item.name) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(item.summary || (item.path + ':' + (item.lineIndex + 1))) + '</span></span>'
      + '<span class="quick-open-badge">' + escapeHtml(item.detail) + '</span></button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

// A member or a type: the kinds IntelliJ's next/previous method treats as a boundary. Values are not here
// on purpose — a constant is a thing to read, not a place to stand.
var DECLARATION_KINDS = ['method', 'function', 'constructor', 'class', 'interface', 'struct', 'enum', 'namespace', 'module'];

/**
 * The stops ⌥↓ / ⌥↑ walk: every member and type, plus everything declared at the top of the file.
 *
 * Stepping used to walk the WHOLE documentSymbol answer, which is not a list of declarations. The servers
 * send a flat SymbolInformation[] that includes each function's own local variables and each object
 * literal's fields, so the measured cost of that was absurd: in src/shortcuts.ts, 557 stops, of which 538
 * were fields of the entries in one array — 93 presses to cross a single row of the shortcut table. The
 * same file has 11 declarations.
 *
 * Kind alone is not the rule, because a kind is not a reliable statement about what a symbol IS. A
 * TypeScript `export type` arrives as `variable` (measured: watch-decision.ts's WatchTickDecision), and a
 * module-level table — SHORTCUTS, MENU_OWNED_CHORDS — arrives as `constant`. Those are the landmarks of a
 * file and dropping them would be its own kind of wrong, so depth 0 is admitted whatever its kind: being
 * declared at the top of the file is the thing they have in common, and it is what the caret wants.
 *
 * Known ceiling: an inline callback that a server chooses to name (tsserver answers `keys.map() callback`)
 * is kind `function` and so becomes a stop. Two of them in shortcuts.ts, against the 538 this removes.
 */
function declarationStops(symbols) {
  return (symbols || []).filter(function (symbol) {
    return symbol && (symbol.depth === 0 || DECLARATION_KINDS.indexOf(symbol.kind) >= 0);
  });
}

/**
 * ⌥↓ / ⌥↑: the next or previous declaration in the open file — IntelliJ's next/previous method.
 *
 * Reads the cached structure, so the first press after opening a file may do nothing while the answer is
 * in flight; it then works for every press after. Silent rather than a toast on the movement itself: this
 * is a movement key, and a complaint on a key that moves the caret is noise.
 *
 * Both surfaces. The row is `where: "code"`, which is the source view AND the diff, and the guard here
 * admitted only the first — so in the diff, where a reviewer spends the time, ⌥↓ advertised "next symbol
 * in this file" and did nothing at all. In the diff the walk is over the symbols the diff actually PRINTS:
 * the rest are in hunks it did not draw, and jumping to one would mean leaving the diff mid-review.
 */
function goToNextSymbol(delta) {
  var path = structureTargetPath();
  if (!path) return false;
  var inDiff = !isSourceViewerVisible();
  if (inDiff && !isDiffViewVisible()) return false;
  // The surface check comes FIRST. Promising "still reading this file's structure…" and eating the key
  // for a file this diff is not showing is an answer that will never arrive.
  var wrapper = inDiff ? diffWrapperByPath(path) : null;
  if (inDiff && !wrapper) return false;
  var cached = structureCache.get(path);
  if (!cached || cached.generation !== analysisGeneration()) {
    fileStructureSymbols(path); // warm it for the next press
    showCaretHint(t('structure.pending'));
    return true;
  }
  var symbols = declarationStops(cached.value.symbols).sort(function (a, b) { return a.lineIndex - b.lineIndex; });
  // Where the caret is, and whether it is anywhere at all. `null` is not line −1: with no caret the key
  // has no position to step FROM, so it steps to the nearest end instead of claiming to be at one.
  var line = null;
  if (inDiff) {
    symbols = symbols.filter(function (symbol) { return diffRowIndexForLine(wrapper, 'new', symbol.lineIndex + 1) >= 0; });
    // A caret in the BASE pane has an old-file line number, and these symbols are the working tree's. The
    // row index is the one thing the two panes share, so the equivalent new-side row is the caret's real
    // position here — without it an old-side ⌥↓ read as "no position" and jumped back to the file's first
    // declaration, once, and then behaved normally.
    var caretRow = diffCursor ? diffRowAt(wrapper, 'new', diffCursor.rowIndex) : null;
    var caretLine = caretRow ? diffLineNumber(caretRow) : null;
    if (caretLine != null) line = caretLine - 1;
  } else if (viewerCursor && viewerCursor.path === path) {
    line = viewerCursor.lineIndex;
  }
  if (!symbols.length) {
    showCaretHint(t(inDiff ? 'structure.noneShown' : 'structure.none'));
    return true;
  }
  var target = null;
  if (line === null) {
    // No caret on this file: ⌥↓ enters at the first symbol, ⌥↑ at the last. Reporting "this is the first
    // symbol" from a position the caret does not hold was a claim about a place nobody was standing.
    target = delta > 0 ? symbols[0] : symbols[symbols.length - 1];
  } else if (delta > 0) {
    for (var i = 0; i < symbols.length; i++) {
      if (symbols[i].lineIndex > line) { target = symbols[i]; break; }
    }
  } else {
    for (var j = symbols.length - 1; j >= 0; j--) {
      if (symbols[j].lineIndex < line) { target = symbols[j]; break; }
    }
  }
  // The ends stop, they do not wrap — deliberate, and pinned by navigation-ui.test.mjs ("past the last
  // symbol the key declines rather than wrapping to the top"). What it did NOT do was say so, which is
  // the only part that looked like a broken key: the caret stays where it is and the reason is named.
  // In the diff the walk is over the symbols this diff PRINTED, so the sentence says that and not "in
  // the file" — a file with forty more declarations the reviewer cannot see from here.
  if (!target) {
    showCaretHint(t(inDiff
      ? (delta > 0 ? 'structure.atLastShown' : 'structure.atFirstShown')
      : (delta > 0 ? 'structure.atLast' : 'structure.atFirst')));
    return true;
  }
  if (inDiff) {
    var rowIndex = diffRowIndexForLine(wrapper, 'new', target.lineIndex + 1);
    if (rowIndex < 0) return false;
    setDiffCursor(path, 'new', rowIndex, target.column, true);
  } else {
    openSourceAt(path, target.lineIndex, target.column);
  }
  return true;
}

/** ⌘⇧B: where the TYPE of the thing under the caret is declared, rather than the thing itself. */
async function goToTypeDeclaration() {
  var symbol = isSourceViewerVisible() ? wordAtCursor() : null;
  var name = symbol ? symbol.name : wordAtDiffCaret();
  var loc = symbol || caretSourceLoc();
  if (!name || !loc) { showSemanticNavigationFailure('symbol'); return; }
  var response = await queryProjectAnalysis('typeDefinition', name, loc);
  if (declinedForRevision(response, name)) return;
  var items = (response && response.locations) || [];
  if (!items.length) { showSemanticNavigationFailure('typeDefinition', name, response); return; }
  if (items.length === 1) {
    if (alreadyAtLocation(loc, items[0])) { showCaretHint(t('monaco.alreadyThere').replace('{symbol}', name)); return; }
    openSourceAt(items[0].path, items[0].lineIndex, items[0].column);
    return;
  }
  openAnalysisUsages(name, items, response, 'typeDefinition');
}

/**
 * ⌘⇧E: the places the caret has been, newest first — IntelliJ's Recent Locations.
 *
 * The list is the back/forward history (06-diff-caret.js) read as a list instead of stepped through one
 * ⌘[ at a time, which is the whole difference: the history is already there, what was missing was being
 * able to see it.
 */
function openRecentLocations() {
  structurePath = '';
  openQuickOpen('locations', true);
  return true;
}

function recentLocationItems() {
  var items = [];
  for (var i = navList.length - 1; i >= 0; i--) {
    var entry = navList[i];
    if (!entry || !entry.path) continue;
    var line = entry.kind === 'diff' ? Number(entry.line) || 0 : Number(entry.lineIndex) || 0;
    items.push({
      path: entry.path,
      name: sourceTabLabel(entry.path),
      detail: entry.kind === 'diff' ? t('locations.inDiff') : t('locations.inSource'),
      kind: 'location',
      recent: true,
      navIndex: i,
      current: i === navPos,
      lineIndex: line,
      column: Number(entry.column) || 0,
      text: '',
    });
  }
  return items;
}

function renderRecentLocationResults(query) {
  var queries = queryVariants(String(query || ''));
  var needle = String(query || '').trim().toLowerCase();
  var all = recentLocationItems();
  quickItems = needle
    ? all.filter(function (item) {
      var hay = [item.name, item.path];
      return matchesQueryVariants(hay, queries);
    })
    : all;
  clampQuickActive();
  setQuickFilterChip(false, resultsLabel(quickItems.length));
  if (!quickItems.length) {
    showQuickEmpty(t('locations.none'));
    return;
  }
  quickResults.innerHTML = quickItems.map(function (item, index) {
    return '<button type="button" class="quick-open-item symbol-result' + (index === quickActive ? ' active' : '')
      + (item.current ? ' is-current' : '') + '" data-index="' + index + '">'
      + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(item.name) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '</span>'
      + projectRowTagsHtml(item.path) + '</span>'
      + '<span class="quick-open-badge">' + escapeHtml(item.detail) + '</span></button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

/** Opening a recent location restores the whole caret position, diff side included. */
function openRecentLocationItem(item) {
  if (!item || item.kind !== 'location') return false;
  closeQuickOpen(true); // restoring a caret position IS the navigation
  restoreNav(navList[item.navIndex]);
  return true;
}

// ---- the file's counterpart: its test, or the source a test is for ----------------------------------
// IntelliJ's ⇧⌘T, and like IntelliJ's it is convention-based rather than semantic: a test is a file whose
// name says so. kakapo knows every path in the project, so the work is generating the names a counterpart
// could have and asking which of them exists — nearest directory first, because a monorepo has many
// `test/helper.ts` and only one of them is this file's.

/** `src/a/b/file.ts` -> {dir, stem, extension}. */
function filePathParts(path) {
  var normalized = String(path || '').replace(/\\/g, '/');
  var slash = normalized.lastIndexOf('/');
  var dir = slash >= 0 ? normalized.slice(0, slash) : '';
  var file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  var dot = file.lastIndexOf('.');
  return {
    dir: dir,
    stem: dot > 0 ? file.slice(0, dot) : file,
    extension: dot > 0 ? file.slice(dot + 1) : '',
  };
}

/**
 * Every name the counterpart of `path` could have, as bare file names.
 *
 * Covers the conventions the bundled languages actually use: `.test.`/`.spec.` suffixes (JS/TS), `_test`
 * and `test_` (Go, Python, Rust), and a `Test`/`Tests` suffix on the stem (Java, Kotlin, C#). Both
 * directions from one list — a test's counterpart is the name with the marker removed.
 */
/** The subject's stem inside a test file's stem, or '' when the stem carries no test marker at all. */
function testSubjectStem(stem) {
  var stripped = String(stem || '')
    .replace(/[._-](?:test|tests|spec|specs)$/i, '')
    .replace(/^(?:test|tests|spec|specs)[._-]/i, '')
    .replace(/(?:Test|Tests|Spec|Specs)$/, '');
  return stripped === String(stem || '') ? '' : stripped;
}

function testCounterpartNames(path) {
  var parts = filePathParts(path);
  var extension = parts.extension ? '.' + parts.extension : '';
  var stem = parts.stem;
  var out = [];
  // This file looks like a test -> the names the subject could have.
  var stripped = testSubjectStem(stem);
  if (stripped) {
    out.push(stripped + extension);
  } else {
    // This file looks like a subject -> the names a test could have.
    ['test', 'spec'].forEach(function (marker) {
      out.push(stem + '.' + marker + extension);
      out.push(stem + '_' + marker + extension);
      out.push(marker + '_' + stem + extension);
    });
    out.push(stem + 'Test' + extension);
    out.push(stem + 'Tests' + extension);
  }
  return out;
}

/** How far apart two paths are, in directory steps — so the nearest counterpart wins. */
function pathDistance(a, b) {
  var left = String(a || '').split('/').slice(0, -1);
  var right = String(b || '').split('/').slice(0, -1);
  var shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  return (left.length - shared) + (right.length - shared);
}

/** Every known path whose file name is one of `names`, nearest to `from` first. */
function filesNamed(names, from) {
  var wanted = {};
  names.forEach(function (name) { wanted[name.toLowerCase()] = true; });
  var hits = [];
  sourceByPath.forEach(function (_file, path) {
    var parts = String(path).split('/');
    if (wanted[(parts[parts.length - 1] || '').toLowerCase()] && path !== from) hits.push(path);
  });
  return hits.sort(function (a, b) { return pathDistance(from, a) - pathDistance(from, b) || a.localeCompare(b); });
}

/**
 * The counterpart by shape, when none of the exact names above exists.
 *
 * Two things a list of names cannot say. A test need not share its subject's EXTENSION — `src/lsp.ts` is
 * tested by `test/lsp-flycheck.test.mjs`, and seven files like it sat in this repository while ⌘⇧T
 * answered "No test found for lsp.ts." And one subject is usually covered by several tests that split it
 * by topic, `<stem>-<topic>.test.<anything>`, none of which is named `<stem>.test.<ext>`.
 *
 * Second pass rather than more names: the exact-name list is precise and should keep winning, and this
 * runs only where it came back with nothing.
 */
/**
 * `lsp-flycheck` -> ['lsp-flycheck', 'lsp'] — the stem, then each shorter name a separator marks off.
 *
 * A test is routinely named for its subject plus the part of it being tested, and the subject's own file
 * is named for the subject alone. Longest first, so the most specific subject wins where both exist.
 */
function testStemPrefixes(stem) {
  var out = [String(stem || '')];
  var text = out[0];
  for (var cut = text.length - 1; cut > 0; cut -= 1) {
    if (/[._-]/.test(text[cut])) out.push(text.slice(0, cut));
  }
  return out;
}

function testCounterpartsByShape(path) {
  var stem = filePathParts(path).stem;
  var subject = testSubjectStem(stem);
  var hits = [];
  var rank = {};
  // Going the other way the prefixes belong to the TEST's name: `lsp-flycheck.test.mjs` is a test of
  // `lsp`, and nothing in the project is called `lsp-flycheck`.
  var wanted = testStemPrefixes((subject || stem).toLowerCase());
  sourceByPath.forEach(function (_file, candidate) {
    if (candidate === path) return;
    var otherStem = filePathParts(candidate).stem;
    var otherSubject = testSubjectStem(otherStem);
    if (subject) {
      // This file is the test; its counterpart is a file that is NOT one, named for one of the prefixes.
      var at = wanted.indexOf(otherStem.toLowerCase());
      if (!otherSubject && at >= 0) { hits.push(candidate); rank[candidate] = at; }
      return;
    }
    // This file is the subject; its counterpart is a test whose own subject is this stem, whole or
    // followed by a separator — `lsp` matches `lsp-flycheck`, and never `lspconfig`.
    if (!otherSubject) return;
    var base = otherSubject.toLowerCase();
    var want = wanted[0];
    if (base === want) { hits.push(candidate); rank[candidate] = 0; return; }
    if (base.indexOf(want) === 0 && /^[._-]/.test(base.slice(want.length))) { hits.push(candidate); rank[candidate] = 1; }
  });
  // Most specific subject first, then nearest directory — a monorepo has many files named for the same
  // short prefix and only one of them is in this file's own tree.
  return hits.sort(function (a, b) {
    return (rank[a] - rank[b]) || (pathDistance(path, a) - pathDistance(path, b)) || a.localeCompare(b);
  });
}

/**
 * What every "about the file you are reading" key says when there is no such file.
 *
 * It used to be a bare `return false` in each of them — correct as dispatch (the key is not theirs) and
 * silent on screen, which is the one thing this app is trying not to be. The caret hint has nothing to
 * anchor to in that state, so it falls back to the corner toast, which is right: the answer is about the
 * window, not about a line.
 */
function noFileHere() {
  showCaretHint(t('structure.noFile'));
  return true;
}

/** ⌘⇧T: open this file's test, or the source the open test is for. */
function goToTestCounterpart() {
  var path = structureTargetPath();
  if (!path) return noFileHere();
  var matches = filesNamed(testCounterpartNames(path), path);
  if (!matches.length) matches = testCounterpartsByShape(path);
  if (!matches.length) {
    showToast(t(semanticTestPath(path) ? 'test.noSubject' : 'test.noTest').replace('{file}', sourceTabLabel(path)));
    return true; // handled: the key said something, which is the answer
  }
  // The nearest wins outright: a monorepo has many `test/thing.test.ts` and exactly one of them is this
  // file's. Only a genuine TIE (two candidates the same distance away) is a question for the reader.
  if (matches.length === 1 || pathDistance(path, matches[0]) < pathDistance(path, matches[1])) {
    openSourceFile(matches[0]);
    return true;
  }
  // A tie — let the reader pick, in the same list every other multi-answer navigation uses.
  openAnalysisUsages(sourceTabLabel(path), matches.map(function (candidate) {
    return { path: candidate, lineIndex: 0, column: 0, name: sourceTabLabel(candidate) };
  }), null, 'goToTest');
  return true;
}

// ---- the call and type hierarchies ------------------------------------------------------------------
// IntelliJ shows these as a tree you expand a level at a time, and that is what they are: "who calls
// this" is only half the question, the other half is "and who calls THEM". So the rows carry a depth and
// expand in place, each expansion being its own query about that row's own symbol.
//
// Rendered in the quick-open shell for the same reason the structure list is: its keyboard handling,
// filtering and preview already exist, and a second list surface would be a second copy of all three.

var hierarchyKind = 'callers';
var hierarchyRootName = '';
var hierarchyRootLoc = null;
var hierarchyRows = [];
var hierarchySeq = 0;
var hierarchyBusy = false;
var hierarchyEngine = '';
var hierarchyNote = '';

// The pairs the panel flips between when its own chord is pressed again — IntelliJ's two tabs, one key.
// `implementation` and `supertypes` are the two directions of a METHOD hierarchy as this app can answer it:
// who overrides this, and what it overrides. Both requests already existed (⌘⌥B and ⌘U ask them one answer
// at a time); what was missing was the tree over them.
var HIERARCHY_FLIP = {
  callers: 'callees', callees: 'callers',
  supertypes: 'subtypes', subtypes: 'supertypes',
  implementation: 'supertypes',
};

function hierarchyTitle(kind) {
  return t('hierarchy.' + kind);
}

/** ⌘⇧Y / ⌘⇧H, and pressing the same chord again flips the direction — IntelliJ's two tabs, one key. */
function openHierarchy(kind) {
  var symbol = isSourceViewerVisible() ? wordAtCursor() : null;
  var name = symbol ? symbol.name : wordAtDiffCaret();
  var loc = symbol || caretSourceLoc();
  var open = quickOpen && !quickOpen.classList.contains('hidden') && quickMode === 'hierarchy';
  if (open && (hierarchyKind === kind || HIERARCHY_FLIP[hierarchyKind] === kind)) {
    kind = HIERARCHY_FLIP[hierarchyKind];
    name = hierarchyRootName;
    loc = hierarchyRootLoc;
  }
  if (!name || !loc) { showSemanticNavigationFailure('symbol'); return false; }
  hierarchyKind = kind;
  hierarchyRootName = name;
  hierarchyRootLoc = loc;
  hierarchyRows = [];
  hierarchyNote = '';
  hierarchyBusy = true;
  openQuickOpen('hierarchy', true);
  loadHierarchyChildren(loc, -1);
  return true;
}

/**
 * Asks about one row's symbol and splices the answer in beneath it.
 *
 * `parentIndex` of -1 is the root level. Each row remembers that it has been expanded, so a second ⇢ on
 * it collapses rather than querying again.
 */
function loadHierarchyChildren(loc, parentIndex) {
  var seq = ++hierarchySeq;
  var parent = parentIndex >= 0 ? hierarchyRows[parentIndex] : null;
  if (parent) parent.loading = true;
  renderHierarchyResults(String(quickInput && quickInput.value || ''));
  Promise.resolve(queryProjectAnalysis(hierarchyKind, loc.name || null, loc)).then(function (response) {
    if (seq !== hierarchySeq && parentIndex < 0) return;
    if (quickMode !== 'hierarchy') return;
    var depth = parent ? parent.depth + 1 : 0;
    var rows = ((response && response.locations) || []).map(function (item) {
      return {
        location: item,
        depth: depth,
        expanded: false,
        loading: false,
        hasChildren: true, // not knowable without asking; the expansion itself answers it
      };
    });
    if (parent) {
      parent.loading = false;
      parent.expanded = true;
      parent.hasChildren = rows.length > 0;
      hierarchyRows.splice.apply(hierarchyRows, [parentIndex + 1, 0].concat(rows));
    } else {
      hierarchyRows = rows;
      hierarchyBusy = false;
      hierarchyEngine = response && response.engine === 'lsp' ? (response.server || 'LSP') : 'index';
    }
    // The reason an answer is empty is the answer, when it is empty: a server without this request, a
    // revision no server can read, or an index that cannot tell a call from a mention.
    //
    // The two the APP has a sentence for are said in the app's own words, and in the reader's language.
    // `fallbackReason` is English prose written for a log — "typescript-language-server does not offer a
    // call hierarchy" was being shown verbatim inside a Korean UI, for the commonest case of all.
    if (!rows.length && response && response.noServer) hierarchyNote = t('monaco.noServer');
    else if (!rows.length && response && response.unsupported) {
      hierarchyNote = t('monaco.notOffered').replace('{symbol}', String(name || ''));
    } else if (!rows.length && response && response.fallbackReason) hierarchyNote = response.fallbackReason;
    else if (rows.length) hierarchyNote = '';
    renderHierarchyResults(String(quickInput && quickInput.value || ''));
  }, function () {
    if (parent) parent.loading = false;
    hierarchyBusy = false;
    renderHierarchyResults(String(quickInput && quickInput.value || ''));
  });
}

/** Removes a row's descendants — everything deeper than it, up to the next row at its own depth. */
function collapseHierarchyRow(index) {
  var row = hierarchyRows[index];
  if (!row || !row.expanded) return false;
  var end = index + 1;
  while (end < hierarchyRows.length && hierarchyRows[end].depth > row.depth) end += 1;
  hierarchyRows.splice(index + 1, end - index - 1);
  row.expanded = false;
  renderHierarchyResults(String(quickInput && quickInput.value || ''));
  return true;
}

/** ⇢ on a row: expand it (another query), or collapse it when it is already open. */
function toggleHierarchyRow(index) {
  var row = hierarchyRows[index];
  if (!row) return false;
  if (row.expanded) return collapseHierarchyRow(index);
  if (row.loading) return true;
  loadHierarchyChildren(row.location, index);
  return true;
}

function renderHierarchyResults(query) {
  var needle = String(query || '').trim().toLowerCase();
  // The matcher gets the query AS TYPED — `needle` stays lower-cased for this list's own
  // substring work, because camel humps are case and a lower-cased pattern has none.
  var queries = queryVariants(String(query || '').trim());
  var visible = needle
    ? hierarchyRows.filter(function (row) {
      var hay = [String(row.location.name || ''), String(row.location.path || '')];
      return matchesQueryVariants(hay, queries);
    })
    : hierarchyRows;
  quickItems = visible.map(function (row) {
    return {
      path: row.location.path,
      name: String(row.location.name || sourceTabLabel(row.location.path)),
      detail: semanticFileLabel(row.location.path, row.location.lineIndex),
      kind: 'symbol',
      recent: false,
      lineIndex: Number(row.location.lineIndex) || 0,
      column: Number(row.location.column) || 0,
      text: String(row.location.text || ''),
      hierarchyIndex: hierarchyRows.indexOf(row),
    };
  });
  clampQuickActive();
  setQuickFilterChip(hierarchyBusy, hierarchyTitle(hierarchyKind).replace('{name}', hierarchyRootName)
    + ' · ' + resultsLabel(quickItems.length)
    + (hierarchyEngine ? ' · ' + hierarchyEngine : ''));
  if (hierarchyBusy) {
    showQuickLoading();
    return;
  }
  if (!quickItems.length) {
    showQuickEmpty(t('hierarchy.none').replace('{name}', hierarchyRootName), hierarchyNote);
    return;
  }
  quickResults.innerHTML = visible.map(function (row, index) {
    var marker = row.loading ? '…' : row.expanded ? '▾' : row.hasChildren ? '▸' : '·';
    return '<button type="button" class="quick-open-item symbol-result structure-result'
      + (index === quickActive ? ' active' : '') + '" data-index="' + index + '"'
      + ' style="--structure-depth:' + Math.min(row.depth, 8) + '">'
      + '<span class="hierarchy-twisty" aria-hidden="true">' + marker + '</span>'
      + '<span class="quick-open-main"><span class="quick-open-name">'
      + quickNameHtml(String(row.location.name || sourceTabLabel(row.location.path))) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(semanticFileLabel(row.location.path, row.location.lineIndex)) + '</span>'
      + projectRowTagsHtml(row.location.path) + '</span>'
      + '<span class="quick-open-badge">' + escapeHtml(t('hierarchy.badge.' + hierarchyKind)) + '</span></button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

/** ⇠/⇢ inside the hierarchy panel, and the chords that flip its direction. */
function handleHierarchyKey(event) {
  if (quickMode !== 'hierarchy') return false;
  // The panel's own search box holds the keyboard while it is open, so the content-level chords never
  // reach the dispatcher. Asked through the shortcut table, not re-spelled here: pressing the chord that
  // opened the panel flips its direction (openHierarchy does the swap).
  if (isShortcut(event, 'callHierarchy')) { event.preventDefault(); openHierarchy('callers'); return true; }
  if (isShortcut(event, 'typeHierarchy')) { event.preventDefault(); openHierarchy('supertypes'); return true; }
  if (isShortcut(event, 'methodHierarchy')) { event.preventDefault(); openHierarchy('implementation'); return true; }
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  var item = quickItems[quickActive];
  if (!item || typeof item.hierarchyIndex !== 'number') return false;
  if (event.key === 'ArrowRight') { event.preventDefault(); toggleHierarchyRow(item.hierarchyIndex); return true; }
  if (event.key === 'ArrowLeft') { event.preventDefault(); collapseHierarchyRow(item.hierarchyIndex); return true; }
  return false;
}

/**
 * ⌘U: the supertype — IntelliJ's Go to Super.
 *
 * One answer opens straight away; several (a class that implements three interfaces) open as the list
 * every other multi-answer navigation uses. A server without a type hierarchy still answers here, via the
 * declaration-text heuristic, which is why this is not simply the hierarchy panel with one row.
 */
async function goToSuperDeclaration() {
  var symbol = isSourceViewerVisible() ? wordAtCursor() : null;
  var name = symbol ? symbol.name : wordAtDiffCaret();
  var loc = symbol || caretSourceLoc();
  if (!name || !loc) { showSemanticNavigationFailure('symbol'); return; }
  var response = await queryProjectAnalysis('supertypes', name, loc);
  if (declinedForRevision(response, name)) return;
  var items = (response && response.locations) || [];
  // A type hierarchy is about TYPES, and ⌘U is not only about types: IntelliJ's Go to Super answers for
  // the member under the caret as readily as for the class around it, and a reader standing on an
  // override is the common case. Asked at a method's position every server here answers nothing, so the
  // key said "no supertypes" on exactly the line it is most often pressed. Ask the question the server
  // CAN answer — the owning type's supertypes — and then find the member of that name inside them.
  if (!items.length) {
    var inherited = await inheritedMemberLocations(name, loc);
    if (inherited.length === 1) { openSourceAt(inherited[0].path, inherited[0].lineIndex, inherited[0].column); return; }
    if (inherited.length > 1) { openAnalysisUsages(name, inherited, response, 'supertypes'); return; }
    showSemanticNavigationFailure('supertypes', name, response);
    return;
  }
  if (items.length === 1) { openSourceAt(items[0].path, items[0].lineIndex, items[0].column); return; }
  openAnalysisUsages(name, items, response, 'supertypes');
}

/**
 * The declarations of `name` in the supertypes of whatever declares it here.
 *
 * Three steps, each of which the servers do answer: which declaration encloses the caret (the file's own
 * structure), what that declaration extends (the type hierarchy, asked at the TYPE's position), and where
 * the same name is declared inside each of those (their structure). Empty whenever any step has nothing,
 * which is what a free function or a class that extends nothing should produce.
 */
async function inheritedMemberLocations(name, loc) {
  var own = await fileStructureSymbols(loc.path);
  var line = Number(loc.lineIndex) || 0;
  var covering = (own.symbols || []).filter(function (one) {
    var from = Number(one.lineIndex) || 0;
    var to = Number(one.endLineIndex) || from;
    return from <= line && line <= to;
  }).sort(function (a, b) { return (Number(a.depth) || 0) - (Number(b.depth) || 0); });
  // The member is the innermost declaration over the caret, and its owner is the one outside it. One
  // entry means the caret is on a top-level declaration, which has no owning type to ask about — and the
  // type hierarchy has already answered for that case above.
  if (covering.length < 2) return [];
  var owner = covering[covering.length - 2];
  if (!owner || !owner.name) return [];
  var supers = await queryProjectAnalysis('supertypes', owner.name, {
    path: loc.path, lineIndex: Number(owner.lineIndex) || 0, column: Number(owner.column) || 0,
  });
  var found = [];
  for (var i = 0; i < ((supers && supers.locations) || []).length && found.length < 8; i += 1) {
    var base = supers.locations[i];
    var structure = await fileStructureSymbols(base.path);
    var baseLine = Number(base.lineIndex) || 0;
    // The supertype's own extent, read from its file's structure. Bounding by its START alone is not
    // enough and the fixture says so: one file holding `interface Shape` and two classes implementing it
    // has three declarations of `area` below Shape's line, and all three came back — including the one
    // the caret is standing on.
    var owner = (structure.symbols || []).filter(function (one) {
      return (Number(one.lineIndex) || 0) <= baseLine && baseLine <= (Number(one.endLineIndex) || Number(one.lineIndex) || 0);
    }).sort(function (a, b) { return (Number(b.depth) || 0) - (Number(a.depth) || 0); })[0];
    var from = owner ? Number(owner.lineIndex) || 0 : baseLine;
    var to = owner ? (Number(owner.endLineIndex) || from) : Infinity;
    (structure.symbols || []).forEach(function (one) {
      if (String(one.name || '') !== String(name)) return;
      var at = Number(one.lineIndex) || 0;
      if (at <= from || at > to) return;
      if (!(Number(one.depth) || 0)) return;
      found.push({ path: base.path, lineIndex: at, column: Number(one.column) || 0,
        text: String(one.detail || one.name || '') });
    });
  }
  return found;
}

// ---- the smaller jumps IntelliJ's Navigate menu has ---------------------------------------------------

/**
 * ⌥G: IntelliJ's Go to Related Symbol, as a reader with no framework knowledge can answer it.
 *
 * IntelliJ's list is built by plugins — a Spring bean's XML, a component's template, a controller's view —
 * and none of that is knowable here. What IS knowable is the part every project has: the file's test (or
 * the file a test is for), and its siblings, the files that share its name under another extension
 * (`Button.tsx` / `Button.css` / `Button.stories.tsx`). Those are the two relations a reviewer follows.
 */
function goToRelatedSymbol() {
  var path = structureTargetPath();
  if (!path) return false;
  var parts = filePathParts(path);
  var related = [];
  filesNamed(testCounterpartNames(path), path).forEach(function (candidate) {
    related.push({ path: candidate, lineIndex: 0, column: 0, name: sourceTabLabel(candidate), text: t('related.test') });
  });
  // Same stem, different extension, same directory first.
  sourceByPath.forEach(function (_file, candidate) {
    if (candidate === path) return;
    var other = filePathParts(candidate);
    if (other.stem !== parts.stem || other.extension === parts.extension) return;
    if (related.some(function (item) { return item.path === candidate; })) return;
    related.push({ path: candidate, lineIndex: 0, column: 0, name: sourceTabLabel(candidate), text: t('related.sibling') });
  });
  if (!related.length) {
    showToast(t('related.none').replace('{file}', sourceTabLabel(path)));
    return true;
  }
  related.sort(function (a, b) { return pathDistance(path, a.path) - pathDistance(path, b.path); });
  if (related.length === 1) { openSourceFile(related[0].path); return true; }
  openAnalysisUsages(sourceTabLabel(path), related, null, 'related');
  return true;
}

// `//region Name`, `// #region Name`, `#region Name`, `# region Name` and the markup form. IntelliJ folds
// these and lets you jump between them; this app does not fold them (a fold is a shape of the code, and a
// region is a comment), but the jump is the half worth having.
var REGION_MARKER = /^\s*(?:\/\/|#|--|\/\*|<!--)\s*#?\s*region\b[ \t:]*(.*?)\s*(?:\*\/|-->)?\s*$/i;

/** ⌘⌥. : the named regions of the open file. */
function openCustomRegions() {
  var path = structureTargetPath();
  var file = path ? sourceByPath.get(path) : null;
  if (!file || !file.embedded) return false;
  var regions = [];
  String(file.content || '').split(/\r?\n/).forEach(function (line, lineIndex) {
    var match = REGION_MARKER.exec(line);
    if (!match) return;
    regions.push({
      path: path,
      lineIndex: lineIndex,
      column: Math.max(0, line.length - line.replace(/^\s*/, '').length),
      name: match[1] || t('region.unnamed'),
      text: line.trim(),
    });
  });
  if (!regions.length) {
    showToast(t('region.none').replace('{file}', sourceTabLabel(path)));
    return true;
  }
  if (regions.length === 1) { openSourceAt(path, regions[0].lineIndex, regions[0].column); return true; }
  openAnalysisUsages(sourceTabLabel(path), regions, null, 'region');
  return true;
}

/**
 * ⌘⇧⌫: the last changed line of the open file — IntelliJ's Jump to Last Change.
 *
 * `F7` already steps the review's changes file by file; this one stays inside the file you are reading,
 * which is the question "where did this file actually change" rather than "what is next".
 */
function jumpToLastChange() {
  var path = structureTargetPath();
  if (!path) return noFileHere();
  var file = sourceByPath.get(path);
  var lines = file && Array.isArray(file.changedLines) ? file.changedLines : [];
  if (!lines.length) {
    showToast(t('lastchange.none').replace('{file}', sourceTabLabel(path)));
    return true;
  }
  // changedLines is 1-based (renderSourceTable compares it against index + 1).
  var last = lines[lines.length - 1];
  for (var i = 0; i < lines.length; i += 1) if (lines[i] > last) last = lines[i];
  openSourceAt(path, Math.max(0, Number(last) - 1), 0);
  return true;
}

// ---- bookmarks ---------------------------------------------------------------------------------------
// IntelliJ's F3: a place to come back to, with no text attached. kakapo already keeps comments beside the
// code, and a comment is the right thing when there is something to say — a bookmark is for when there is
// not, and you simply want this line again in a minute.
//
// Kept in kakapo's own per-workspace settings, never in the repository: a bookmark is a reader's note to
// themselves about a file, not a change to it.

// Scoped to THIS review, the way the .http environment key is (01-core.js).
//
// persistSave writes to localStorage as well as to main's per-workspace settings, and on a file:// page
// localStorage is one bucket for every review this app has ever opened. A plain key therefore leaked
// across repositories: a fresh project opened holding another project's bookmarks — paths that do not
// exist in it — which a real run caught by bookmarking a line that was already bookmarked.
var BOOKMARKS_KEY = 'kakapo-bookmarks:' + location.pathname;
// Loaded on FIRST USE, not at slice load. renderSourceTable asks for the bookmarked lines of the file it
// is painting, and it runs during page load — before this slice executes — for a restored source tab. A
// `var` read then is `undefined` and the whole file renders as zero rows; a function call is always
// answerable. (The same reason tokenSets() and sourceProgressiveLimits() are functions.)
var bookmarkList = null;
function bookmarks() {
  if (bookmarkList) return bookmarkList;
  var saved = persistRead(BOOKMARKS_KEY);
  if (!Array.isArray(saved)) { try { saved = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || 'null'); } catch (e) { saved = null; } }
  bookmarkList = Array.isArray(saved) ? saved.filter(function (mark) { return mark && mark.path; }) : [];
  return bookmarkList;
}

function saveBookmarks() {
  persistSave(BOOKMARKS_KEY, bookmarks());
}

/** The bookmarked lines of one file, for the gutter. A Set because every rendered row asks. */
function bookmarkLinesFor(path) {
  var all = bookmarks();
  var lines = new Set();
  for (var i = 0; i < all.length; i++) {
    if (all[i].path === path) lines.add(Number(all[i].lineIndex) || 0);
  }
  return lines;
}

function bookmarkIndexOf(path, lineIndex) {
  var all = bookmarks();
  for (var i = 0; i < all.length; i++) {
    if (all[i].path === path && (Number(all[i].lineIndex) || 0) === lineIndex) return i;
  }
  return -1;
}

/** F3: bookmark the caret's line, or remove the bookmark that is already there. */
function toggleBookmarkAtCaret() {
  var loc = caretSourceLoc();
  if (!loc || !loc.path) return false;
  var at = bookmarkIndexOf(loc.path, loc.lineIndex);
  if (at >= 0) {
    bookmarks().splice(at, 1);
    showToast(t('bookmark.removed').replace('{where}', semanticFileLabel(loc.path, loc.lineIndex)));
  } else {
    bookmarks().push({ path: loc.path, lineIndex: loc.lineIndex, at: new Date().toISOString() });
    showToast(t('bookmark.added').replace('{where}', semanticFileLabel(loc.path, loc.lineIndex)));
  }
  saveBookmarks();
  paintBookmarkGutter();
  return true;
}

/**
 * Marks the bookmarked rows that are on screen.
 *
 * The class is also written by renderSourceTable, so a row built later (progressive rendering, a fold
 * opening) comes out marked; this is the in-place update for the row that just changed, which is cheaper
 * than repainting a file to add one dot.
 */
function paintBookmarkGutter() {
  var path = sourceOpenPath();
  if (!path) return;
  var lines = bookmarkLinesFor(path);
  var body = document.getElementById('source-body');
  if (!body) return;
  body.querySelectorAll('tr.source-row[data-line-index]').forEach(function (row) {
    var line = Number(row.dataset.lineIndex);
    var marked = lines.has(line);
    row.classList.toggle('bookmarked', marked);
    var mnemonic = marked ? bookmarkMnemonicAt(path, line) : '';
    if (mnemonic) {
      row.dataset.bookmarkMnemonic = mnemonic;
      row.style.setProperty('--bookmark-mark', "'" + mnemonic + "'");
    } else {
      delete row.dataset.bookmarkMnemonic;
      row.style.removeProperty('--bookmark-mark');
    }
  });
}

/**
 * ⇧⌥1…⇧⌥9: give this line a number — IntelliJ's mnemonic bookmarks — and ⌥1…⌥9 to go there.
 *
 * On ⌥ rather than IntelliJ's ⌃: this table spells Control and Command alike, and ⌘1 / ⌘2 / ⌘9 already
 * mean the Files panel, the Changes panel and history.
 *
 * A number belongs to one line: assigning it elsewhere moves it, rather than leaving two lines claiming
 * to be bookmark 3.
 */
function assignBookmarkMnemonic(digit) {
  var loc = caretSourceLoc();
  if (!loc || !loc.path) return false;
  var all = bookmarks();
  var existing = bookmarkIndexOf(loc.path, loc.lineIndex);
  var already = existing >= 0 && String(all[existing].mnemonic || '') === String(digit);
  // A line holds ONE number, so assigning a second one to it takes the first away — and that happened in
  // silence, with a toast that spoke only of the number being set. Walk 1 through 9 down the same line
  // and eight of them quietly vanish; press ⌥3 afterwards and the app says "Nothing is bookmarked as 3",
  // which is true and tells you nothing about why.
  var displaced = existing >= 0 ? String(all[existing].mnemonic || '') : '';
  // The number also moves off whatever OTHER line had it.
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].mnemonic || '') === String(digit)) delete all[i].mnemonic;
  }
  if (already) {
    showToast(t('bookmark.mnemonicCleared').replace('{digit}', String(digit)));
  } else {
    if (existing < 0) {
      all.push({ path: loc.path, lineIndex: loc.lineIndex, at: new Date().toISOString(), mnemonic: String(digit) });
    } else {
      all[existing].mnemonic = String(digit);
    }
    showToast(t(displaced && displaced !== String(digit) ? 'bookmark.mnemonicReplaced' : 'bookmark.mnemonicSet')
      .replace('{digit}', String(digit))
      .replace('{old}', displaced)
      .replace('{where}', semanticFileLabel(loc.path, loc.lineIndex)));
  }
  saveBookmarks();
  paintBookmarkGutter();
  return true;
}

/** ⌥1…⌥9: go to the line that holds that number. */
function goToBookmarkMnemonic(digit) {
  var all = bookmarks();
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].mnemonic || '') === String(digit)) {
      openSourceAt(all[i].path, Number(all[i].lineIndex) || 0, 0);
      return true;
    }
  }
  showToast(t('bookmark.mnemonicEmpty').replace('{digit}', String(digit)));
  return true;
}

/** The number on a bookmarked line, for the gutter. '' when it has none. */
function bookmarkMnemonicAt(path, lineIndex) {
  var at = bookmarkIndexOf(path, lineIndex);
  return at >= 0 ? String(bookmarks()[at].mnemonic || '') : '';
}

/** ⌘F3: every bookmark, newest first. */
function openBookmarks() {
  openQuickOpen('bookmarks', true);
  return true;
}

function renderBookmarkResults(query) {
  var needle = String(query || '').trim().toLowerCase();
  // The matcher gets the query AS TYPED — `needle` stays lower-cased for this list's own
  // substring work, because camel humps are case and a lower-cased pattern has none.
  var queries = queryVariants(String(query || '').trim());
  var all = bookmarks().slice().reverse().map(function (mark) {
    return {
      path: mark.path,
      name: sourceTabLabel(mark.path),
      detail: semanticFileLabel(mark.path, Number(mark.lineIndex) || 0),
      kind: 'symbol', // jumps to the line, like a symbol result
      recent: false,
      mnemonic: String(mark.mnemonic || ''),
      lineIndex: Number(mark.lineIndex) || 0,
      column: 0,
      text: '',
    };
  });
  quickItems = needle
    ? all.filter(function (item) {
      var hay = [item.name, item.path];
      return matchesQueryVariants(hay, queries);
    })
    : all;
  clampQuickActive();
  setQuickFilterChip(false, resultsLabel(quickItems.length));
  if (!quickItems.length) {
    showQuickEmpty(t('bookmark.none'));
    return;
  }
  quickResults.innerHTML = quickItems.map(function (item, index) {
    return '<button type="button" class="quick-open-item symbol-result' + (index === quickActive ? ' active' : '')
      + '" data-index="' + index + '">'
      + '<span class="bookmark-mark" aria-hidden="true">' + escapeHtml(item.mnemonic || '\u2691') + '</span>'
      + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(item.name) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(item.detail) + '</span>'
      + projectRowTagsHtml(item.path) + '</span></button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}
