
var projectLayoutParsed = null;

function projectLayoutData() {
  if (projectLayoutParsed) return projectLayoutParsed;
  var parsed = {};
  try {
    parsed = JSON.parse(document.getElementById('project-layout-data')?.textContent || '{}') || {};
  } catch (e) {
    parsed = {};
  }
  projectLayoutParsed = {
    modules: Array.isArray(parsed.modules) ? parsed.modules : [],
    testRoots: Array.isArray(parsed.testRoots) ? parsed.testRoots : [],
    generatedRoots: Array.isArray(parsed.generatedRoots) ? parsed.generatedRoots : [],
    source: typeof parsed.source === 'string' ? parsed.source : 'conventions',
  };
  return projectLayoutParsed;
}

function setProjectLayout(layout) {
  if (!layout || typeof layout !== 'object') return;
  projectLayoutParsed = {
    modules: Array.isArray(layout.modules) ? layout.modules : [],
    testRoots: Array.isArray(layout.testRoots) ? layout.testRoots : [],
    generatedRoots: Array.isArray(layout.generatedRoots) ? layout.generatedRoots : [],
    source: typeof layout.source === 'string' ? layout.source : 'conventions',
  };
  projectScopeCache = null;
  markProjectLayoutInTrees();
}

var projectScopeCache = null;
function projectScopeCacheMap() {
  if (!projectScopeCache) projectScopeCache = new Map();
  return projectScopeCache;
}

var projectConventionPatterns = null;
function projectConventions() {
  if (!projectConventionPatterns) {
    projectConventionPatterns = {
      test: /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(?:test|spec)\.[^.]+$/i,
      generated: /(^|\/)(dist|build|out|target|node_modules|vendor|generated|__generated__|\.next|coverage)(\/|$)|\.(?:min\.(?:js|css)|g\.dart|pb\.go)$|_pb2\.pyi?$/i,
    };
  }
  return projectConventionPatterns;
}

function projectNormalizePath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function projectUnderRoot(path, root) {
  var prefix = projectNormalizePath(root);
  if (!prefix) return false;
  return path === prefix || path.indexOf(prefix + '/') === 0;
}

function projectScopeOf(path) {
  var relative = projectNormalizePath(path);
  if (!relative) return 'production';
  var file = typeof sourceByPath !== 'undefined' && sourceByPath
    ? (sourceByPath.get(path) || sourceByPath.get(relative)) : null;
  if (file && file.library) return 'library';
  var cache = projectScopeCacheMap();
  var cached = cache.get(relative);
  if (cached) return cached;
  var layout = projectLayoutData();
  var scope = 'production';
  if (layout.generatedRoots.some(function (root) { return projectUnderRoot(relative, root); })) {
    scope = 'generated';
  } else if (layout.testRoots.some(function (root) { return projectUnderRoot(relative, root); })) {
    scope = 'test';
  } else if (projectConventions().generated.test(relative)) {
    scope = 'generated';
  } else if (projectConventions().test.test(relative)) {
    scope = 'test';
  }
  cache.set(relative, scope);
  return scope;
}

function projectIsTestPath(path) {
  return projectScopeOf(path) === 'test';
}

function projectModuleOf(path) {
  var relative = projectNormalizePath(path);
  var best = null;
  var bestLength = -1;
  projectLayoutData().modules.forEach(function (module) {
    if (!module) return;
    var root = projectNormalizePath(module.root);
    if (root && !projectUnderRoot(relative, root)) return;
    if (root.length > bestLength) { best = module; bestLength = root.length; }
  });
  return best;
}

function projectModuleName(path) {
  var module = projectModuleOf(path);
  return module && module.name ? String(module.name) : '';
}

function projectHasModules() {
  return projectLayoutData().modules.length > 1;
}

function projectCurrentModule() {
  var path = sourceOpenPath();
  return path ? projectModuleName(path) : '';
}

function projectScopePrefixes(scope) {
  var layout = projectLayoutData();
  if (scope === 'production') return { include: [], exclude: layout.testRoots.concat(layout.generatedRoots) };
  if (scope === 'tests') return { include: layout.testRoots, exclude: [] };
  if (scope === 'module') {
    var module = projectModuleOf(sourceOpenPath());
    var root = module ? projectNormalizePath(module.root) : '';
    return { include: root ? [root] : [], exclude: [] };
  }
  return { include: [], exclude: [] };
}

function projectRowTagsHtml(path, kinds) {
  var wanted = kinds || 'test module';
  var tags = '';
  if (wanted.indexOf('test') >= 0 && projectIsTestPath(path)) {
    tags += '<span class="row-tag is-test">' + escapeHtml(t('usagescope.test')) + '</span>';
  }
  var module = wanted.indexOf('module') >= 0 && projectHasModules() ? projectModuleName(path) : '';
  if (module) tags += '<span class="row-tag is-module">' + escapeHtml(module) + '</span>';
  return tags ? '<span class="row-tags">' + tags + '</span>' : '';
}

function projectTestFolderMark() { return '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<polygon fill="#62B543" points="13.75 10.75 17.25 14.25 10.25 14.25" transform="rotate(90 13.75 12.5)"/>'
  + '<polygon fill="#F26522" points="9.25 10.75 12.75 14.25 5.75 14.25" transform="rotate(-90 9.25 12.5)"/></svg>'; }
function projectModuleFolderMark() { return '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<polygon fill="#40B6E0" points="10 16 16 16 16 10 10 10"/></svg>'; }

function projectModuleGroupFolderMark() { return '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<polygon fill="#40B6E0" points="13 16 16 16 16 13 13 13"/><polygon fill="#40B6E0" points="13 12 16 12 16 9 13 9"/>'
  + '<polygon fill="#40B6E0" points="9 16 12 16 12 13 9 13"/><polygon fill="#40B6E0" points="9 12 12 12 12 9 9 9"/></svg>'; }
function projectLibraryFolderMark() { return '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<rect width="2" height="6" x="14" y="8" fill="#40B6E0"/><rect width="2" height="8" x="11" y="6" fill="#9AA7B0"/>'
  + '<rect width="2" height="6" x="8" y="8" fill="#62B543"/></svg>'; }
function projectGeneratedFolderMark() { return '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<polygon fill="currentColor" fill-opacity=".75" points="15.995 15.291 14.2 13.498 15.988 11.709 15.288 11.008'
  + ' 13.499 12.798 11.704 11.004 11.003 11.703 12.8 13.498 11 15.299 11.7 16 13.5 14.198 15.294 15.991"/></svg>'; }

function projectFolderIconHtml(mark) {
  return '<span class="folder-icon usage-group-icon">'
    + '<svg class="folder-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
    + '</svg>' + (mark || '') + '</span>';
}

function setFolderMark(row, mark) {
  var icon = row.querySelector('summary .folder-icon');
  if (!icon) return;
  var existing = icon.querySelector('.folder-mark');
  if (!mark) { if (existing) existing.remove(); return; }
  if (existing && existing.dataset.mark === mark.length + '') return;
  if (existing) existing.remove();
  icon.insertAdjacentHTML('beforeend', mark);
  var added = icon.querySelector('.folder-mark');
  if (added) added.dataset.mark = mark.length + '';
}

function projectRowOpening(rows, root) {
  var best = null;
  var bestLength = Infinity;
  rows.forEach(function (row) {
    var path = projectNormalizePath(row.dataset.dir);
    if (!projectUnderRoot(path, root)) return;
    if (path.length < bestLength) { best = row; bestLength = path.length; }
  });
  return best;
}

function markProjectLayoutTreeDirectories() {
  var layout = projectLayoutData();
  ['changes-dir', 'source-dir'].forEach(function (kind) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('.tree-dir.' + kind + '[data-dir]'));
    var testRows = new Set();
    layout.testRoots.forEach(function (root) {
      var row = projectRowOpening(rows, projectNormalizePath(root));
      if (row) testRows.add(row);
    });
    rows.forEach(function (row) {
      if (!row.querySelector(':scope > summary')) return;
      var isTestRoot = testRows.has(row);
      row.classList.toggle('is-test-root', isTestRoot);
      setFolderMark(row, isTestRoot ? projectTestFolderMark() : (row.dataset.module ? projectModuleFolderMark() : ''));
    });
  });
}

function markProjectLayoutInTrees() {
  Array.prototype.forEach.call(
    document.querySelectorAll('.source-link[data-source-file], .change-row[data-file]'),
    function (row) {
      var path = row.dataset.sourceFile || row.dataset.file || '';
      if (!path) return;
      var scope = projectScopeOf(path);
      row.classList.toggle('is-test-file', scope === 'test');
      row.classList.toggle('is-generated-file', scope === 'generated');
    },
  );
  markProjectLayoutTreeDirectories();
}

markProjectLayoutInTrees();
