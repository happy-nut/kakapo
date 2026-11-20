
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

var USAGE_TYPE_ORDER = [
  'declaration',
  'import', 'extends', 'new', 'annotation', 'instanceof', 'cast', 'type.parameter',
  'parameter.declaration', 'return', 'local.declaration', 'write', 'read', 'unclassified',
  'string.constant', 'comment',
];
var USAGE_NON_CODE = { 'string.constant': 1, comment: 1 };

var USAGE_IMPORT_LINE = /^\s*(?:import\b|from\s|export\s+(?:\*|\{)|use\s|using\s|require\b|#include\b|package\b|@import\b|load\()/;
var USAGE_EXTENDS_BEFORE = /\b(?:extends|implements|with)\s+(?:[A-Za-z0-9_$.<>,\s]*,\s*)?$/;
var USAGE_CLASS_HEADER = /^\s*(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|static|export|default|pub(?:\([^)]*\))?)\s+)*(?:class|interface|struct|trait|enum|object|record|protocol)\b/;
var USAGE_DECLARES_BEFORE = /\b(?:class|interface|struct|trait|enum|type|function|func|fn|def|val|var|let|const|object|record|protocol|namespace|module)\s+$/;

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
  if (USAGE_EXTENDS_BEFORE.test(before) && USAGE_CLASS_HEADER.test(line)) return 'extends';
  if (/\bclass\s+[A-Za-z0-9_$]+\s*\([A-Za-z0-9_$.,\s]*$/.test(before)) return 'extends';
  if (/\bimpl\b[^{]*\bfor\s+$/.test(before)) return 'extends';
  if (/\bas\s+$/.test(before) || (/\(\s*$/.test(before) && /^\s*\)\s*[A-Za-z0-9_$]/.test(after))) return 'cast';
  if (/<\s*(?:[A-Za-z0-9_$.<>,\s]*,\s*)?$/.test(before) && /^\s*[,>]/.test(after)) return 'type.parameter';
  if (/(?::|->)\s*$/.test(before)) {
    if (USAGE_CLASS_HEADER.test(line)) return 'extends';
    if (/\)\s*(?::|->)\s*$/.test(before)) return 'return';
    if (/\([^)]*$/.test(before)) return 'parameter.declaration';
    if (/\b(?:let|const|var|val)\s+[A-Za-z0-9_$]+\s*:\s*$/.test(before)) return 'local.declaration';
  }
  if (/^\s*(?:=(?![=>])|\+=|-=|\*=|\/=|%=|\|\|=|&&=|\?\?=|\|=|&=|\^=|<<=|>>=)/.test(after)) return 'write';
  if (/(?:\+\+|--)\s*$/.test(before) || /^\s*(?:\+\+|--)/.test(after)) return 'write';
  if (/^\(/.test(after) || /^<[^<>]*>\s*\(/.test(after)) return 'unclassified';
  return 'read';
}

function usageTypeLabel(type) {
  return t('usagetype.' + type);
}

var usageViewName = '';
var usageViewLoc = null;
var usageViewRows = [];
var usageViewBusy = false;
var usageViewEngine = '';
var usageViewNote = '';
var usageViewSeq = 0;
var usageViewHideNoise = false;

function openFindUsages() {
  var symbol = symbolUnderCursor();
  if (!symbol || !symbol.name) { showSemanticNavigationFailure('symbol'); return false; }
  usageViewName = symbol.name;
  usageViewLoc = symbol;
  usageViewRows = [];
  usageViewNote = '';
  usageViewBusy = true;
  collapsedUsageGroups = {};
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
        scope: projectScopeOf(item.path),
        module: projectModuleName(item.path),
        moduleGroup: (projectModuleOf(item.path) || {}).group || '',
        moduleRoot: (projectModuleOf(item.path) || {}).root || '',
      };
    });
    usageViewNote = usageViewRows.length ? ''
      : analysisStillArriving() ? t('monaco.analysisPending').replace('{symbol}', usageViewName)
        : response && response.noServer ? t('monaco.noServer')
          : response && response.baseSide ? t('monaco.baseSide').replace('{symbol}', usageViewName)
            : response && response.serverAnswered ? ''
              : (response && response.fallbackReason ? String(response.fallbackReason) : '');
    quickActive = 0;
    collapseUsageDirectoriesWhenCrowded();
    renderFindUsagesResults(String(quickInput && quickInput.value || ''));
  }, function () {
    if (seq !== usageViewSeq) return;
    usageViewBusy = false;
    renderFindUsagesResults(String(quickInput && quickInput.value || ''));
  });
}

var USAGE_CROWDED_FILES = 10;

function collapseUsageDirectoriesWhenCrowded() {
  var files = {};
  usageViewRows.forEach(function (row) { files[row.path] = 1; });
  if (Object.keys(files).length <= USAGE_CROWDED_FILES) return;
  usageViewEntries('', true).forEach(function (entry) {
    if (entry.kind === 'group' && entry.id === 'directory') collapsedUsageGroups[entry.path] = true;
  });
}

function usageRowVisible(row) {
  if (usageViewHideNoise && (row.isTest || USAGE_NON_CODE[row.type] === 1)) return false;
  if (!usageFiltering.read && row.type === 'read') return false;
  if (!usageFiltering.write && row.type === 'write') return false;
  if (!usageFiltering.imports && row.type === 'import') return false;
  return true;
}

function visibleUsageRows(query) {
  var needle = String(query || '').trim().toLowerCase();
  var queries = queryVariants(String(query || '').trim());
  return usageViewRows.filter(function (row) {
    if (!usageRowVisible(row)) return false;
    if (!needle) return true;
    var hay = [row.text, row.path];
    return matchesQueryVariants(hay, queries);
  });
}

var usageGrouping = { scope: false, type: true, module: true, flatten: true, directory: true, file: true };
var usageFiltering = { read: true, write: true, imports: true };

var USAGE_SCOPE_ORDER = ['production', 'test', 'library', 'generated'];

function usageDirectoryOf(path) {
  var normalized = String(path || '').replace(/\\/g, '/');
  var slash = normalized.lastIndexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : '';
}

function usageDirectoryPathOf(row) {
  var dir = usageDirectoryOf(row.path);
  if (!usageGrouping.module || !projectHasModules()) return dir;
  var root = projectNormalizePath(row.moduleRoot || '');
  if (!root) return dir;
  if (dir === root) return '';
  return dir.indexOf(root + '/') === 0 ? dir.slice(root.length + 1) : dir;
}

function usageDirectoryLevels(rows) {
  var under = {};
  var direct = {};
  var childDirs = {};
  var depth = 0;
  rows.forEach(function (row) {
    var dir = usageDirectoryPathOf(row);
    var segments = dir ? dir.split('/') : [];
    if (segments.length > depth) depth = segments.length;
    direct[dir] = (direct[dir] || 0) + 1;
    var prefix = '';
    segments.forEach(function (segment) {
      var parent = prefix;
      prefix = prefix ? prefix + '/' + segment : segment;
      if (!childDirs[parent]) childDirs[parent] = {};
      childDirs[parent][prefix] = 1;
      under[prefix] = (under[prefix] || 0) + 1;
    });
  });
  var shown = {};
  Object.keys(under).forEach(function (prefix) {
    shown[prefix] = (direct[prefix] || 0) > 0 || Object.keys(childDirs[prefix] || {}).length > 1;
  });
  var label = {};
  Object.keys(shown).forEach(function (prefix) {
    if (!shown[prefix]) return;
    var segments = prefix.split('/');
    var taken = [];
    for (var i = segments.length - 1; i >= 0; i -= 1) {
      taken.unshift(segments[i]);
      var ancestor = segments.slice(0, i).join('/');
      if (!ancestor || shown[ancestor]) break;
    }
    label[prefix] = taken.join('/');
  });
  return { depth: depth, shown: shown, label: label };
}

function usageDirectoryRule(levels, depth) {
  return {
    id: 'directory',
    keyOf: function (row) {
      var segments = usageDirectoryPathOf(row).split('/').filter(Boolean);
      return segments.length > depth ? segments.slice(0, depth + 1).join('/') : '';
    },
    orderOf: function () { return 0; },
    labelOf: function (key) { return key && levels.shown[key] ? levels.label[key] : ''; },
  };
}

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
  if (usageGrouping.module && projectHasModules()) {
    if (!usageGrouping.flatten) {
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
    var levels = usageDirectoryLevels(rows);
    for (var depth = 0; depth < levels.depth; depth += 1) {
      rules.push(usageDirectoryRule(levels, depth));
    }
  }
  if (usageGrouping.file) {
    rules.push({
      id: 'file',
      keyOf: function (row) { return row.path; },
      orderOf: function () { return 0; },
      labelOf: function (key) { return usageGrouping.directory ? sourceTabLabel(key) : key; },
    });
  }
  return rules;
}

function usageGroupIconHtml(group) {
  if (group.id === 'scope') {
    if (group.key === 'test') return projectFolderIconHtml(projectTestFolderMark());
    if (group.key === 'library') return projectFolderIconHtml(projectLibraryFolderMark());
    if (group.key === 'generated') return projectFolderIconHtml(projectGeneratedFolderMark());
    return projectFolderIconHtml('');
  }
  if (group.id === 'moduleGroup') return projectFolderIconHtml(projectModuleGroupFolderMark());
  if (group.id === 'module') return projectFolderIconHtml(projectModuleFolderMark());
  if (group.id === 'directory') return projectFolderIconHtml('');
  if (group.id === 'file') return '<span class="usage-group-icon">' + virtualTypeIcon(group.key) + '</span>';
  return '';
}

var collapsedUsageGroups = {};

/**
 * A node's identity: its own rank and key, after its parent's.
 *
 * Percent-encoded and joined with `|` because this string goes into a `data-` attribute and comes back
 * out of `dataset` — a NUL separator did not survive the HTML parser, which is a fold that silently never
 * happened rather than an error.
 */
function usageGroupPath(parent, id, key) {
  return (parent ? parent + '|' : '') + encodeURIComponent(id + ':' + String(key));
}

function toggleUsageGroup(path) {
  if (!path) return false;
  if (collapsedUsageGroups[path]) delete collapsedUsageGroups[path];
  else collapsedUsageGroups[path] = true;
  quickActive = 0;
  renderFindUsagesResults(String(quickInput && quickInput.value || ''));
  return true;
}

function usageGroupPaths() {
  var paths = [];
  usageViewEntries(String(quickInput && quickInput.value || ''), true).forEach(function (entry) {
    if (entry.kind === 'group') paths.push(entry.path);
  });
  return paths;
}

function setAllUsageGroupsCollapsed(collapsed) {
  var paths = usageGroupPaths();
  collapsedUsageGroups = {};
  if (collapsed) paths.forEach(function (path) { collapsedUsageGroups[path] = true; });
  quickActive = 0;
  renderFindUsagesResults(String(quickInput && quickInput.value || ''));
  return true;
}

function usageRowOrder(a, b) {
  return a.path.localeCompare(b.path) || a.lineIndex - b.lineIndex || a.column - b.column;
}

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

function flattenUsageTree(node, depth, out, parentPath, ignoreCollapsed) {
  (node.children || []).forEach(function (child) {
    var shown = Boolean(child.label);
    var path = shown ? usageGroupPath(parentPath, child.id, child.key) : parentPath;
    var collapsed = shown && !ignoreCollapsed && collapsedUsageGroups[path] === true;
    if (shown) {
      out.push({
        kind: 'group', id: child.id, key: child.key, label: child.label, extraClass: child.extraClass,
        count: child.count, depth: depth, path: path, collapsed: collapsed,
      });
    }
    if (!collapsed) flattenUsageTree(child, shown ? depth + 1 : depth, out, path, ignoreCollapsed);
  });
  (node.rows || []).forEach(function (row) { out.push({ kind: 'row', row: row, depth: depth }); });
}

function usageViewEntries(query, ignoreCollapsed) {
  var rows = visibleUsageRows(query);
  var entries = [];
  flattenUsageTree(groupUsageTree(rows, usageGroupingRules(rows), 0), 0, entries, '', ignoreCollapsed === true);
  return entries;
}

function usageCodeHtml(row) {
  var text = String(row.text || '');
  var lead = text.length - text.replace(/^\s+/, '').length;
  var trimmed = text.trim().slice(0, 180);
  var start = (Number(row.column) || 0) - lead;
  var name = usageViewName || '';
  if (!name || start < 0 || trimmed.substr(start, name.length) !== name) return semanticCodeHtml(row.path, trimmed);
  return semanticCodeHtml(row.path, trimmed.slice(0, start))
    + '<mark class="usage-hit">' + escapeHtml(name) + '</mark>'
    + semanticCodeHtml(row.path, trimmed.slice(start + name.length));
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
  clampQuickActive();
  var files = {};
  flat.forEach(function (row) { files[row.path] = 1; });
  var tests = flat.filter(function (row) { return row.isTest; }).length;
  setQuickFilterChip(usageViewBusy, t('findusages.summary', { n: flat.length, files: Object.keys(files).length })
    + (tests ? ' · ' + t('findusages.testCount', { n: tests }) : '')
    + (usageViewEngine ? ' · ' + usageViewEngine : ''));
  if (usageViewBusy) {
    showQuickLoading();
    return;
  }
  if (!entries.length) {
    var hidden = usageViewRows.length && !String(query || '').trim();
    showQuickEmpty(hidden
      ? t('findusages.allFiltered', { n: usageViewRows.length })
      : t('findusages.none').replace('{name}', usageViewName), usageViewNote);
    return;
  }
  var index = 0;
  var html = '';
  entries.forEach(function (entry) {
    if (entry.kind === 'group') {
      html += '<div class="usage-group' + escapeHtml(entry.extraClass || '')
        + (entry.collapsed ? ' is-collapsed' : '') + '" data-usage-group="' + escapeHtml(entry.id) + '"'
        + ' data-usage-key="' + escapeHtml(String(entry.key)) + '"'
        + ' data-usage-path="' + escapeHtml(entry.path) + '"'
        + ' role="button" tabindex="-1" aria-expanded="' + (entry.collapsed ? 'false' : 'true') + '"'
        + ' style="--depth:' + entry.depth + '">'
        + '<span class="usage-twisty" aria-hidden="true">' + (entry.collapsed ? '▸' : '▾') + '</span>'
        + usageGroupIconHtml(entry)
        + '<span class="usage-group-name">' + escapeHtml(entry.label) + '</span>'
        + '<span class="usage-group-count">' + escapeHtml(t('usagegroup.count', { n: entry.count })) + '</span>'
        + '</div>';
      return;
    }
    var row = entry.row;
    var where = usageGrouping.file ? ':' + String(row.lineIndex + 1) : semanticFileLabel(row.path, row.lineIndex);
    var tag = row.isTest && !usageGrouping.scope
      ? '<span class="usage-result-tag">' + escapeHtml(t('usagescope.test')) + '</span>' : '';
    html += '<button type="button" class="quick-open-item usage-result' + (index === quickActive ? ' active' : '')
      + (row.isTest ? ' is-test' : '') + '" data-index="' + index + '" data-usage-type="' + escapeHtml(row.type) + '"'
      + ' style="--depth:' + entry.depth + '"'
      + ' title="' + escapeHtml(usageTypeLabel(row.type) + ' — ' + row.path + ':' + (row.lineIndex + 1)) + '">'
      + '<span class="quick-open-main">'
      + '<span class="quick-open-path">' + escapeHtml(where) + '</span>'
      + '<span class="usage-result-code">' + usageCodeHtml(row) + '</span>'
      + tag + '</span></button>';
    index += 1;
  });
  quickResults.innerHTML = html;
  renderQuickPreview(quickItems[quickActive]);
}

function toggleUsageViewNoise() {
  usageViewHideNoise = !usageViewHideNoise;
  quickActive = 0;
  renderFindUsagesResults(String(quickInput && quickInput.value || ''));
  syncContentSearchControls();
  return true;
}

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

function syncUsageViewControls() {
  var strip = document.getElementById('quick-open-usage-options');
  if (!strip) return;
  USAGE_TOGGLES.forEach(function (toggle) {
    var chip = strip.querySelector('.quick-open-usage-chip[data-usage-toggle="' + toggle.name + '"]');
    if (!chip) return;
    var on = usageToggleState(toggle);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.classList.toggle('active', on);
    var available = toggle.name !== 'flatten' || usageGrouping.module;
    chip.disabled = !available;
    chip.classList.toggle('unavailable', !available);
  });
}

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
  var target = event.target && event.target.closest ? event.target : null;
  if (!target) return;
  var tree = target.closest('[data-usage-tree]');
  if (tree) {
    event.preventDefault();
    setAllUsageGroupsCollapsed(tree.dataset.usageTree === 'collapse');
    if (quickInput) quickInput.focus();
    return;
  }
  var chip = target.closest('.quick-open-usage-chip');
  if (!chip || !chip.dataset.usageToggle) return;
  event.preventDefault();
  toggleUsageView(chip.dataset.usageToggle);
  if (quickInput) quickInput.focus();
});

document.getElementById('quick-open-results')?.addEventListener('click', function (event) {
  var group = event.target && event.target.closest ? event.target.closest('.usage-group[data-usage-path]') : null;
  if (!group) return;
  event.preventDefault();
  toggleUsageGroup(group.dataset.usagePath);
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

var USAGE_MARK_LIMIT = 5000;
var USAGE_MARK_PAINT_LIMIT = 200;
var usageMarks = [];
var usageMarkPath = '';
var usageMarkName = '';
var usageMarkActive = -1;
var usageMarkGeneration = -1;
var usageMarkSurface = '';

function usageScanContext(path, name) {
  return {
    path: path,
    name: name,
    language: usageLanguageOf(path),
    pattern: new RegExp('(?:^|[^A-Za-z0-9_$])(' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![A-Za-z0-9_$])', 'g'),
  };
}

function scanUsageLine(ctx, line, onMark) {
  ctx.pattern.lastIndex = 0;
  var match = null;
  while ((match = ctx.pattern.exec(line))) {
    var column = match.index + match[0].length - match[1].length;
    ctx.pattern.lastIndex = column + match[1].length;
    if (usageZoneAt(line, column, ctx.language) !== 'code') continue;
    var type = classifyUsage(ctx.name, line, column, ctx.path);
    var initialised = type === 'declaration' && /^\s*=(?![=>])/.test(line.slice(column + ctx.name.length));
    if (onMark(column, type === 'write' || initialised)) return true;
  }
  return false;
}

function usageMarksInDiff(wrapper, name) {
  if (!wrapper || !name) return [];
  var path = diffWrapperPathKey(wrapper);
  var ctx = usageScanContext(path, name);
  var marks = [];
  ['old', 'new'].some(function (side) {
    var rows = diffRowsOf(diffSideTable(wrapper, side));
    return rows.some(function (row, rowIndex) {
      if (!isDiffCodeRow(row)) return false;
      return scanUsageLine(ctx, diffLineText(row), function (column, write) {
        marks.push({
          path: path, side: side, rowIndex: rowIndex,
          column: column, length: name.length, write: write,
        });
        return marks.length >= USAGE_MARK_LIMIT;
      });
    });
  });
  return marks.sort(function (a, b) {
    return a.rowIndex - b.rowIndex || a.column - b.column || (a.side === 'old' ? -1 : 1);
  });
}

function usageMarksInCaretPane() {
  if (usageMarkSurface !== 'diff') return usageMarks;
  var side = (diffCursor && diffCursor.side) || 'new';
  return usageMarks.filter(function (mark) { return mark.side === side; });
}

function usageMarksIn(path, name) {
  var file = typeof sourceByPath !== 'undefined' ? sourceByPath.get(path) : null;
  if (!file || !file.embedded || file.image || !name) return [];
  var ctx = usageScanContext(path, name);
  var marks = [];
  String(file.content || '').split(/\r?\n/).some(function (line, lineIndex) {
    return scanUsageLine(ctx, line, function (column, write) {
      marks.push({ path: path, lineIndex: lineIndex, column: column, length: name.length, write: write });
      return marks.length >= USAGE_MARK_LIMIT;
    });
  });
  return marks;
}

function clearUsageHighlights() {
  usageMarks = [];
  usageMarkPath = '';
  usageMarkName = '';
  usageMarkActive = -1;
  usageMarkGeneration = -1;
  usageMarkSurface = '';
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
    var inDiff = mark.side !== undefined;
    var row = inDiff
      ? diffRowAt(diffWrapperByPath(mark.path), mark.side, mark.rowIndex)
      : paintedSourceRow(mark.lineIndex);
    if (row) row.classList.add('usage-mark-row');
    var container = row && (inDiff ? diffCellCtn(row) : (row.querySelector('.source-code') || row));
    if (!container) return;
    var shown = sourceCellText(container);
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

var usageHighlightCache;
function usageHighlightCacheMap() {
  if (!usageHighlightCache) usageHighlightCache = new Map();
  return usageHighlightCache;
}
function usageHighlightKey(path, name, lineIndex) { return path + '\u0000' + name + '\u0000' + lineIndex; }
function serverUsageMarks(path, symbol) {
  var key = usageHighlightKey(path, symbol.name, symbol.lineIndex);
  var cached = usageHighlightCacheMap().get(key);
  if (cached && cached.generation === analysisGeneration()) return cached.pending ? null : cached.marks;
  usageHighlightCacheMap().set(key, { generation: analysisGeneration(), marks: null, pending: true });
  Promise.resolve(queryProjectAnalysis('documentHighlight', symbol.name, {
    path: path, lineIndex: symbol.lineIndex, column: symbol.column,
  })).then(function (response) {
    if (!pageAlive()) return;
    var highlights = response && Array.isArray(response.highlights) ? response.highlights : null;
    var marks = highlights && highlights.length ? highlights.map(function (h) {
      return {
        path: path,
        lineIndex: h.lineIndex,
        column: h.startColumn,
        length: Math.max(1, (h.endColumn || h.startColumn) - h.startColumn),
        write: h.kind === 'write',
      };
    }).sort(function (a, b) { return a.lineIndex - b.lineIndex || a.column - b.column; }) : null;
    if (!marks) usageHighlightCacheMap().delete(key);
    else usageHighlightCacheMap().set(key, { generation: analysisGeneration(), marks: marks, pending: false });
    if (!marks || usageMarkSurface !== 'source' || usageMarkPath !== path
      || usageMarkName !== symbol.name || !usageMarks.length) return;
    usageMarks = marks;
    usageMarkActive = -1;
    paintUsageHighlights();
    showCaretHint(t('findusages.inFile', {
      n: usageMarks.length,
      name: symbol.name,
      writes: usageMarks.filter(function (mark) { return mark.write; }).length,
    }));
  }, function () {
    if (!pageAlive()) return;
    usageHighlightCacheMap().delete(key);
  });
  return null;
}

function usageSurface() {
  if (isSourceViewerVisible()) return 'source';
  if (isDiffViewVisible()) return 'diff';
  return '';
}

function usageMarkPathFor(surface, symbol) {
  if (surface === 'source') return sourceOpenPath();
  return (symbol && symbol.path) || '';
}

function ensureUsageMarks() {
  var surface = usageSurface();
  if (!surface) return false;
  var symbol = symbolUnderCursor();
  var path = usageMarkPathFor(surface, symbol);
  if (!symbol || !symbol.name || !path) return false;
  if (usageMarkName === symbol.name && usageMarkPath === path && usageMarkSurface === surface
    && usageMarks.length && usageMarkGeneration === analysisGeneration()) return true;
  if (surface === 'diff') {
    usageMarks = usageMarksInDiff(diffWrapperByPath(path), symbol.name);
  } else {
    var fromServer = serverUsageMarks(path, symbol);
    usageMarks = fromServer && fromServer.length ? fromServer : usageMarksIn(path, symbol.name);
  }
  usageMarkPath = path;
  usageMarkName = symbol.name;
  usageMarkSurface = surface;
  usageMarkGeneration = analysisGeneration();
  usageMarkActive = -1;
  return usageMarks.length > 0;
}

function highlightUsagesInFile() {
  if (!usageSurface()) return false;
  var symbol = symbolUnderCursor();
  if (!symbol || !symbol.name) return false;
  var surface = usageSurface();
  if (usageMarkName === symbol.name && usageMarkPath === usageMarkPathFor(surface, symbol)
    && usageMarkSurface === surface && usageMarks.length) {
    clearUsageHighlights();
    return true;
  }
  clearUsageHighlights();
  if (!ensureUsageMarks()) {
    showCaretHint(t('findusages.noneInFile').replace('{name}', symbol.name));
    return true;
  }
  var painted = paintUsageHighlights();
  var counted = usageMarksInCaretPane();
  showCaretHint(t('findusages.inFile', {
    n: counted.length,
    name: symbol.name,
    writes: counted.filter(function (mark) { return mark.write; }).length,
  }));
  return painted !== null;
}

function stepUsageOccurrence(delta) {
  if (!usageSurface()) return false;
  if (!ensureUsageMarks()) return false;
  var inDiff = usageMarkSurface === 'diff';
  var walk = usageMarksInCaretPane();
  if (!walk.length) {
    showCaretHint(t('findusages.noneInPane')
      .replace('{name}', usageMarkName)
      .replace('{key}', shortcutLabel('sidebarContent', 1)));
    return true;
  }
  var line = inDiff ? (diffCursor ? diffCursor.rowIndex : 0) : (viewerCursor ? viewerCursor.lineIndex : 0);
  var column = inDiff ? (diffCursor ? diffCursor.column : 0) : (viewerCursor ? viewerCursor.column : 0);
  var at = function (mark) { return inDiff ? mark.rowIndex : mark.lineIndex; };
  var target = -1;
  if (delta > 0) {
    for (var i = 0; i < walk.length; i += 1) {
      var next = walk[i];
      if (at(next) > line || (at(next) === line && next.column > column)) { target = i; break; }
    }
    if (target < 0) target = 0;
  } else {
    for (var j = walk.length - 1; j >= 0; j -= 1) {
      var prev = walk[j];
      if (at(prev) < line || (at(prev) === line && prev.column < column)) { target = j; break; }
    }
    if (target < 0) target = walk.length - 1;
  }
  var mark = walk[target];
  if (!mark) return false;
  usageMarkActive = usageMarks.indexOf(mark);
  if (inDiff) setDiffCursor(mark.path, mark.side, mark.rowIndex, mark.column, true);
  else openSourceAt(mark.path, mark.lineIndex, mark.column);
  paintUsageHighlights();
  showCaretHint(t('findusages.occurrence', { i: target + 1, n: walk.length, name: usageMarkName }));
  return true;
}
