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
// IntelliJ's Show Usages in Comments is one checkbox of its filtering toolbar. kakapo already has a
// toggle that means exactly "comments and tests are noise" — Find in Files' ⌥P — so that one keeps its
// chord and its button, and the three access filters below it are the rest of that toolbar.
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
  syncUsageViewControls();
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
        // What the project says this file is, decided once per row rather than once per regrouping:
        // 14-project-layout.js reads the declared test roots, and a module is a prefix match.
        scope: projectScopeOf(item.path),
        module: projectModuleName(item.path),
        moduleGroup: (projectModuleOf(item.path) || {}).group || '',
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

/** The rows the filters leave: the typed query, ⌥P's noise toggle, and the three access filters. */
function usageRowVisible(row) {
  if (usageViewHideNoise && (row.isTest || USAGE_NON_CODE[row.type] === 1)) return false;
  // IntelliJ's filtering toolbar, one rule each: ReadAccessFilteringRule, WriteAccessFilteringRule,
  // ImportUsageFilteringRule. A declaration that initialises is a write there and here (usageMarksIn
  // reads it the same way), so hiding writes hides it too.
  if (!usageFiltering.read && row.type === 'read') return false;
  if (!usageFiltering.write && row.type === 'write') return false;
  if (!usageFiltering.imports && row.type === 'import') return false;
  return true;
}

function visibleUsageRows(query) {
  var needle = String(query || '').trim().toLowerCase();
  var queries = queryVariants(needle);
  return usageViewRows.filter(function (row) {
    if (!usageRowVisible(row)) return false;
    if (!needle) return true;
    var hay = (row.path + ' ' + row.text).toLowerCase();
    return queries.some(function (variant) { return hay.includes(variant); });
  });
}

// ---- IntelliJ's grouping stack -----------------------------------------------------------------------
// The usage view is not a list, it is a tree, and what it is a tree OF is a stack of grouping rules with
// ranks — `UsageGroupingRulesDefaultRanks` in intellij-community: non-code 0, scope 100, usage type 200,
// module 300, directory 400, file 500, outermost first. The ranks are why that order is not a matter of
// taste: a module inside a usage type and a usage type inside a module are different answers to the same
// question, and IntelliJ picked one.
//
// Defaults are IntelliJ's own (UsageViewSettings.kt): usage type, module and file on, modules flattened,
// Production/Test off. One deliberate difference — `isGroupByPackage` is true there and `directory` is
// false here. IntelliJ's tree collapses; this list does not, so a directory level would be a third header
// above two rows whose path is already printed on the file header. Turning it on makes the file header
// show the bare name instead, which is the point at which a directory header says something new.
var usageGrouping = { scope: false, type: true, module: true, flatten: true, directory: false, file: true };
// IntelliJ's filtering toolbar: Show Read Access / Show Write Access / Show Import Statements, all on.
var usageFiltering = { read: true, write: true, imports: true };

// UsageScopeGroupingRule's own codes: production 0, test 1, library 2. 'generated' is this app's addition
// — IntelliJ makes generated code a FILTER rather than a scope, and a reviewer who has asked for the
// division wants build output in a bucket of its own rather than mixed into production code.
var USAGE_SCOPE_ORDER = ['production', 'test', 'library', 'generated'];

function usageDirectoryOf(path) {
  var normalized = String(path || '').replace(/\\/g, '/');
  var slash = normalized.lastIndexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : '';
}

/**
 * The rules in force, in rank order.
 *
 * Takes the rows because two of the rules need to know what is in the whole answer before they can say
 * whether their own heading is worth drawing: a "Non-code usages" divider with no code above it divides
 * nothing, and "Unclassified" over a list that is nothing but call sites is the same furniture the flat
 * version had. A rule whose `labelOf` returns '' still groups and still orders — it just draws no header
 * and costs no indentation.
 */
function usageGroupingRules(rows) {
  var rules = [];
  var hasCode = rows.some(function (row) { return USAGE_NON_CODE[row.type] !== 1; });
  rules.push({
    id: 'noncode',
    keyOf: function (row) { return USAGE_NON_CODE[row.type] === 1 ? 'noncode' : 'code'; },
    orderOf: function (key) { return key === 'noncode' ? 1 : 0; },
    labelOf: function (key) { return key === 'noncode' && hasCode ? t('findusages.noncode') : ''; },
    classOf: function (key) { return key === 'noncode' ? ' usage-group-noncode' : ''; },
  });
  if (usageGrouping.scope) {
    rules.push({
      id: 'scope',
      keyOf: function (row) { return row.scope || 'production'; },
      orderOf: function (key) { return USAGE_SCOPE_ORDER.indexOf(key); },
      // Shown even when every row is in one scope: the toggle was pressed to ask which scope these are
      // in, and "all of them are production" is that answer rather than furniture.
      labelOf: function (key) { return t('usagescope.' + key); },
      classOf: function (key) { return ' usage-group-scope-' + key; },
    });
  }
  if (usageGrouping.type) {
    var types = {};
    rows.forEach(function (row) { types[row.type] = 1; });
    var onlyUnclassified = Object.keys(types).length === 1 && types.unclassified === 1;
    rules.push({
      id: 'type',
      keyOf: function (row) { return row.type; },
      orderOf: function (key) { return USAGE_TYPE_ORDER.indexOf(key); },
      labelOf: function (key) { return onlyUnclassified ? '' : usageTypeLabel(key); },
    });
  }
  // A single-module repository is most repositories, and a module header every row is under is not a
  // division. projectHasModules() is the same guard the file tree uses.
  if (usageGrouping.module && projectHasModules()) {
    if (!usageGrouping.flatten) {
      // ModuleGroupingRule returns the module's group path as parent groups when modules are not
      // flattened — `node.group.module.group`, the `group=` attribute of modules.xml.
      rules.push({
        id: 'moduleGroup',
        keyOf: function (row) { return row.moduleGroup || ''; },
        orderOf: function () { return 0; },
        labelOf: function (key) { return key ? t('usagegroup.moduleGroup').replace('{name}', key) : ''; },
      });
    }
    rules.push({
      id: 'module',
      keyOf: function (row) { return row.module || ''; },
      orderOf: function () { return 0; },
      labelOf: function (key) { return key ? t('usagegroup.module').replace('{name}', key) : ''; },
    });
  }
  if (usageGrouping.directory) {
    rules.push({
      id: 'directory',
      keyOf: function (row) { return usageDirectoryOf(row.path); },
      orderOf: function () { return 0; },
      labelOf: function (key) { return t('usagegroup.directory').replace('{path}', key || '.'); },
    });
  }
  if (usageGrouping.file) {
    rules.push({
      id: 'file',
      keyOf: function (row) { return row.path; },
      orderOf: function () { return 0; },
      // IntelliJ's showShortFilePath is on by default. The whole path when it is the only thing saying
      // where this is; the name alone once a directory header above has already said it.
      labelOf: function (key) { return usageGrouping.directory ? sourceTabLabel(key) : key; },
    });
  }
  return rules;
}

function usageRowOrder(a, b) {
  return a.path.localeCompare(b.path) || a.lineIndex - b.lineIndex || a.column - b.column;
}

/** Rows → a tree, one level per rule. Leaves hold the rows in file/line order. */
function groupUsageTree(rows, rules, depth) {
  if (depth >= rules.length) return { rows: rows.slice().sort(usageRowOrder), children: [] };
  var rule = rules[depth];
  var buckets = new Map();
  rows.forEach(function (row) {
    var key = rule.keyOf(row);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  });
  var keys = Array.from(buckets.keys()).sort(function (a, b) {
    return (rule.orderOf(a) - rule.orderOf(b)) || String(a).localeCompare(String(b));
  });
  return {
    rows: [],
    children: keys.map(function (key) {
      var inner = groupUsageTree(buckets.get(key), rules, depth + 1);
      return {
        id: rule.id,
        key: key,
        label: rule.labelOf(key),
        extraClass: rule.classOf ? rule.classOf(key) : '',
        count: buckets.get(key).length,
        rows: inner.rows,
        children: inner.children,
      };
    }),
  };
}

/** The tree as the flat sequence the list renders: headers with a depth, then the rows under them. */
function flattenUsageTree(node, depth, out) {
  (node.children || []).forEach(function (child) {
    var shown = Boolean(child.label);
    if (shown) {
      out.push({ kind: 'group', id: child.id, key: child.key, label: child.label, extraClass: child.extraClass, count: child.count, depth: depth });
    }
    flattenUsageTree(child, shown ? depth + 1 : depth, out);
  });
  (node.rows || []).forEach(function (row) { out.push({ kind: 'row', row: row, depth: depth }); });
}

/** Headers and rows in display order — the one function the renderer and the tests both read. */
function usageViewEntries(query) {
  var rows = visibleUsageRows(query);
  var entries = [];
  flattenUsageTree(groupUsageTree(rows, usageGroupingRules(rows), 0), 0, entries);
  return entries;
}

function renderFindUsagesResults(query) {
  if (!quickResults) return;
  var entries = usageViewEntries(query);
  var flat = entries.filter(function (entry) { return entry.kind === 'row'; }).map(function (entry) { return entry.row; });
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
  var tests = flat.filter(function (row) { return row.isTest; }).length;
  if (quickFilterEl) {
    quickFilterEl.className = 'quick-open-filter' + (usageViewBusy ? ' is-loading' : '');
    quickFilterEl.innerHTML = usageViewBusy
      ? kakapoLoaderHtml('kakapo-loader-micro') + '<span>' + escapeHtml(t('quickopen.searching')) + '</span>'
      : escapeHtml(t('findusages.summary')
        .replace('{n}', String(flat.length))
        .replace('{files}', String(Object.keys(files).length))
        // How much of this answer is test code, before any grouping is turned on. "Forty usages" and
        // "forty usages, thirty-one of them in tests" are different facts about a symbol.
        + (tests ? ' · ' + t('findusages.testCount').replace('{n}', String(tests)) : '')
        + (usageViewEngine ? ' · ' + usageViewEngine : ''));
  }
  if (usageViewBusy) {
    quickResults.innerHTML = loadingStateHtml(t('quickopen.searching'), 'quick-open-empty');
    renderQuickPreview(null);
    return;
  }
  if (!flat.length) {
    // "No usages of Store" when there are nine of them and a filter is hiding all nine is a wrong answer,
    // and it is the one a reviewer would believe. Only when nothing was typed: with a query in the box,
    // "nothing matched" is what happened.
    var hidden = usageViewRows.length && !String(query || '').trim();
    quickResults.innerHTML = '<div class="quick-open-empty">'
      + escapeHtml(hidden
        ? t('findusages.allFiltered').replace('{n}', String(usageViewRows.length))
        : t('findusages.none').replace('{name}', usageViewName))
      + (usageViewNote ? '<span class="quick-open-why">' + escapeHtml(usageViewNote) + '</span>' : '')
      + '</div>';
    renderQuickPreview(null);
    return;
  }
  var index = 0;
  var html = '';
  entries.forEach(function (entry) {
    if (entry.kind === 'group') {
      html += '<div class="usage-group' + escapeHtml(entry.extraClass || '') + '" data-usage-group="' + escapeHtml(entry.id) + '"'
        + ' data-usage-key="' + escapeHtml(String(entry.key)) + '" style="--depth:' + entry.depth + '">'
        + '<span class="usage-group-name">' + escapeHtml(entry.label) + '</span>'
        + '<span class="usage-group-count">' + String(entry.count) + '</span></div>';
      return;
    }
    var row = entry.row;
    // Under a file header the path is already on screen; the line number is the part that is not. Without
    // one, the row carries `name:line` as it always has.
    var where = usageGrouping.file ? ':' + String(row.lineIndex + 1) : semanticFileLabel(row.path, row.lineIndex);
    // Test code is marked on the row, not only when the scope grouping is on: the division IntelliJ draws
    // with a green icon in every list it has. When the scope header is above it, saying it twice is noise.
    var tag = row.isTest && !usageGrouping.scope
      ? '<span class="usage-result-tag">' + escapeHtml(t('usagescope.test')) + '</span>' : '';
    html += '<button type="button" class="quick-open-item usage-result' + (index === quickActive ? ' active' : '')
      + (row.isTest ? ' is-test' : '') + '" data-index="' + index + '" data-usage-type="' + escapeHtml(row.type) + '"'
      + ' style="--depth:' + entry.depth + '"'
      + ' title="' + escapeHtml(usageTypeLabel(row.type) + ' — ' + row.path + ':' + (row.lineIndex + 1)) + '">'
      // Where first, then the line — the order the caret popup beside this one uses (.usage-loc then
      // .usage-code in 15-semantic-navigation.js), and the order IntelliJ's own usage rows read in. With
      // the code first, ":1" trailed off the end of the line and read as part of it.
      + '<span class="quick-open-main">'
      + '<span class="quick-open-path">' + escapeHtml(where) + '</span>'
      + '<span class="usage-result-code">' + semanticCodeHtml(row.path, row.text.trim().slice(0, 180)) + '</span>'
      + tag + '</span></button>';
    index += 1;
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

// Every toggle of the two toolbars, by the name on its chip: which flag it owns, and which shortcut row
// labels it. One table so the chips, the chords and the click handler cannot come to disagree — the same
// reason src/shortcuts.ts exists.
var USAGE_TOGGLES = [
  { name: 'scope', group: true, shortcut: 'usageGroupScope' },
  { name: 'type', group: true, shortcut: 'usageGroupType' },
  { name: 'module', group: true, shortcut: 'usageGroupModule' },
  { name: 'flatten', group: true, shortcut: 'usageFlattenModules' },
  { name: 'directory', group: true, shortcut: 'usageGroupDirectory' },
  { name: 'file', group: true, shortcut: 'usageGroupFile' },
  { name: 'read', group: false, shortcut: 'usageFilterRead' },
  { name: 'write', group: false, shortcut: 'usageFilterWrite' },
  { name: 'imports', group: false, shortcut: 'usageFilterImports' },
];

function usageToggleState(toggle) {
  return toggle.group ? usageGrouping[toggle.name] === true : usageFiltering[toggle.name] === true;
}

/** The chips show what is on. Called on open and after every toggle. */
function syncUsageViewControls() {
  var strip = document.getElementById('quick-open-usage-options');
  if (!strip) return;
  USAGE_TOGGLES.forEach(function (toggle) {
    var chip = strip.querySelector('.quick-open-usage-chip[data-usage-toggle="' + toggle.name + '"]');
    if (!chip) return;
    var on = usageToggleState(toggle);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.classList.toggle('active', on);
    // Flattening is a property of the module grouping, so it is not a choice while that is off.
    var available = toggle.name !== 'flatten' || usageGrouping.module;
    chip.disabled = !available;
    chip.classList.toggle('unavailable', !available);
  });
}

/** One toggle, by chip name. The answer is the same rows regrouped, so nothing is re-queried. */
function toggleUsageView(name) {
  var toggle = USAGE_TOGGLES.filter(function (item) { return item.name === name; })[0];
  if (!toggle) return false;
  if (toggle.group) usageGrouping[name] = !usageGrouping[name];
  else usageFiltering[name] = !usageFiltering[name];
  quickActive = 0;
  syncUsageViewControls();
  renderFindUsagesResults(String(quickInput && quickInput.value || ''));
  return true;
}

document.getElementById('quick-open-usage-options')?.addEventListener('click', function (event) {
  var chip = event.target && event.target.closest ? event.target.closest('.quick-open-usage-chip') : null;
  if (!chip || !chip.dataset.usageToggle) return;
  event.preventDefault();
  toggleUsageView(chip.dataset.usageToggle);
  if (quickInput) quickInput.focus();
});

function handleUsageViewKey(event) {
  if (quickMode !== 'usages') return false;
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
    && (event.code === 'KeyP' || String(event.key).toLowerCase() === 'p')) {
    event.preventDefault();
    return toggleUsageViewNoise();
  }
  for (var i = 0; i < USAGE_TOGGLES.length; i += 1) {
    var toggle = USAGE_TOGGLES[i];
    if (!isShortcut(event, toggle.shortcut)) continue;
    event.preventDefault();
    if (toggle.name === 'flatten' && !usageGrouping.module) return true;
    return toggleUsageView(toggle.name);
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
