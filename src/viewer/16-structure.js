
var structureCache = new Map();
var structureQuery = '';
var structureItems = [];
var structureBusy = false;
var structureEngine = '';
var structureSeq = 0;
var structurePath = '';

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

function analysisGeneration() {
  var status = document.getElementById('analysis-status');
  return status ? Number(status.dataset.generation) || 0 : 0;
}

function openFileStructure() {
  var path = structureTargetPath();
  if (!path) return false;
  structurePath = path;
  structureQuery = '\0';
  structureItems = [];
  structureBusy = true;
  openQuickOpen('structure', true);
  return true;
}

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

var DECLARATION_KINDS = ['method', 'function', 'constructor', 'class', 'interface', 'struct', 'enum', 'namespace', 'module'];

function declarationStops(symbols) {
  return (symbols || []).filter(function (symbol) {
    return symbol && (symbol.depth === 0 || DECLARATION_KINDS.indexOf(symbol.kind) >= 0);
  });
}

function goToNextSymbol(delta) {
  var path = structureTargetPath();
  if (!path) return false;
  var inDiff = !isSourceViewerVisible();
  if (inDiff && !isDiffViewVisible()) return false;
  var wrapper = inDiff ? diffWrapperByPath(path) : null;
  if (inDiff && !wrapper) return false;
  var cached = structureCache.get(path);
  if (!cached || cached.generation !== analysisGeneration()) {
    fileStructureSymbols(path);
    showCaretHint(t('structure.pending'));
    return true;
  }
  var symbols = declarationStops(cached.value.symbols).sort(function (a, b) { return a.lineIndex - b.lineIndex; });
  var line = null;
  if (inDiff) {
    symbols = symbols.filter(function (symbol) { return diffRowIndexForLine(wrapper, 'new', symbol.lineIndex + 1) >= 0; });
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

function openRecentLocationItem(item) {
  if (!item || item.kind !== 'location') return false;
  closeQuickOpen(true);
  restoreNav(navList[item.navIndex]);
  return true;
}

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
  var stripped = testSubjectStem(stem);
  if (stripped) {
    out.push(stripped + extension);
  } else {
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

function pathDistance(a, b) {
  var left = String(a || '').split('/').slice(0, -1);
  var right = String(b || '').split('/').slice(0, -1);
  var shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1;
  return (left.length - shared) + (right.length - shared);
}

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
  var wanted = testStemPrefixes((subject || stem).toLowerCase());
  sourceByPath.forEach(function (_file, candidate) {
    if (candidate === path) return;
    var otherStem = filePathParts(candidate).stem;
    var otherSubject = testSubjectStem(otherStem);
    if (subject) {
      var at = wanted.indexOf(otherStem.toLowerCase());
      if (!otherSubject && at >= 0) { hits.push(candidate); rank[candidate] = at; }
      return;
    }
    if (!otherSubject) return;
    var base = otherSubject.toLowerCase();
    var want = wanted[0];
    if (base === want) { hits.push(candidate); rank[candidate] = 0; return; }
    if (base.indexOf(want) === 0 && /^[._-]/.test(base.slice(want.length))) { hits.push(candidate); rank[candidate] = 1; }
  });
  return hits.sort(function (a, b) {
    return (rank[a] - rank[b]) || (pathDistance(path, a) - pathDistance(path, b)) || a.localeCompare(b);
  });
}

function noFileHere() {
  showCaretHint(t('structure.noFile'));
  return true;
}

function goToTestCounterpart() {
  var path = structureTargetPath();
  if (!path) return noFileHere();
  var matches = filesNamed(testCounterpartNames(path), path);
  if (!matches.length) matches = testCounterpartsByShape(path);
  if (!matches.length) {
    showToast(t(semanticTestPath(path) ? 'test.noSubject' : 'test.noTest').replace('{file}', sourceTabLabel(path)));
    return true;
  }
  if (matches.length === 1 || pathDistance(path, matches[0]) < pathDistance(path, matches[1])) {
    openSourceFile(matches[0]);
    return true;
  }
  openAnalysisUsages(sourceTabLabel(path), matches.map(function (candidate) {
    return { path: candidate, lineIndex: 0, column: 0, name: sourceTabLabel(candidate) };
  }), null, 'goToTest');
  return true;
}

var hierarchyKind = 'callers';
var hierarchyRootName = '';
var hierarchyRootLoc = null;
var hierarchyRows = [];
var hierarchySeq = 0;
var hierarchyBusy = false;
var hierarchyEngine = '';
var hierarchyNote = '';

var HIERARCHY_FLIP = {
  callers: 'callees', callees: 'callers',
  supertypes: 'subtypes', subtypes: 'supertypes',
  implementation: 'supertypes',
};

function hierarchyTitle(kind) {
  return t('hierarchy.' + kind);
}

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
        hasChildren: true,
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

function handleHierarchyKey(event) {
  if (quickMode !== 'hierarchy') return false;
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

async function goToSuperDeclaration() {
  var symbol = isSourceViewerVisible() ? wordAtCursor() : null;
  var name = symbol ? symbol.name : wordAtDiffCaret();
  var loc = symbol || caretSourceLoc();
  if (!name || !loc) { showSemanticNavigationFailure('symbol'); return; }
  var response = await queryProjectAnalysis('supertypes', name, loc);
  if (declinedForRevision(response, name)) return;
  var items = (response && response.locations) || [];
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

async function inheritedMemberLocations(name, loc) {
  var own = await fileStructureSymbols(loc.path);
  var line = Number(loc.lineIndex) || 0;
  var covering = (own.symbols || []).filter(function (one) {
    var from = Number(one.lineIndex) || 0;
    var to = Number(one.endLineIndex) || from;
    return from <= line && line <= to;
  }).sort(function (a, b) { return (Number(a.depth) || 0) - (Number(b.depth) || 0); });
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

function goToRelatedSymbol() {
  var path = structureTargetPath();
  if (!path) return false;
  var parts = filePathParts(path);
  var related = [];
  filesNamed(testCounterpartNames(path), path).forEach(function (candidate) {
    related.push({ path: candidate, lineIndex: 0, column: 0, name: sourceTabLabel(candidate), text: t('related.test') });
  });
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

var REGION_MARKER = /^\s*(?:\/\/|#|--|\/\*|<!--)\s*#?\s*region\b[ \t:]*(.*?)\s*(?:\*\/|-->)?\s*$/i;

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

function jumpToLastChange() {
  var path = structureTargetPath();
  if (!path) return noFileHere();
  var file = sourceByPath.get(path);
  var lines = file && Array.isArray(file.changedLines) ? file.changedLines : [];
  if (!lines.length) {
    showToast(t('lastchange.none').replace('{file}', sourceTabLabel(path)));
    return true;
  }
  var last = lines[lines.length - 1];
  for (var i = 0; i < lines.length; i += 1) if (lines[i] > last) last = lines[i];
  openSourceAt(path, Math.max(0, Number(last) - 1), 0);
  return true;
}

var BOOKMARKS_KEY = 'kakapo-bookmarks:' + location.pathname;
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

function assignBookmarkMnemonic(digit) {
  var loc = caretSourceLoc();
  if (!loc || !loc.path) return false;
  var all = bookmarks();
  var existing = bookmarkIndexOf(loc.path, loc.lineIndex);
  var already = existing >= 0 && String(all[existing].mnemonic || '') === String(digit);
  var displaced = existing >= 0 ? String(all[existing].mnemonic || '') : '';
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

function bookmarkMnemonicAt(path, lineIndex) {
  var at = bookmarkIndexOf(path, lineIndex);
  return at >= 0 ? String(bookmarks()[at].mnemonic || '') : '';
}

function openBookmarks() {
  openQuickOpen('bookmarks', true);
  return true;
}

function renderBookmarkResults(query) {
  var needle = String(query || '').trim().toLowerCase();
  var queries = queryVariants(String(query || '').trim());
  var all = bookmarks().slice().reverse().map(function (mark) {
    return {
      path: mark.path,
      name: sourceTabLabel(mark.path),
      detail: semanticFileLabel(mark.path, Number(mark.lineIndex) || 0),
      kind: 'symbol',
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
