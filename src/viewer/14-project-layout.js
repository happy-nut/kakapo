// What this repository is made of, in the renderer: which module a path belongs to, and whether it is
// production code, test code, generated code or a library.
//
// IntelliJ divides every list it shows by these two facts — `ModuleGroupingRule` and
// `UsageScopeGroupingRule` in intellij-community, ranks 300 and 100 of its usage-view grouping stack, and
// a green source-root icon in the project tree — and neither can be answered from a path string with any
// confidence. `src/test/java` is a test root by Maven's convention; `testdata/` is production fixtures in
// half the Go repos that have one. So the answer comes from the project's own declarations, read in the
// main process (src/project-layout.ts) from `.idea/modules.xml` + the `.iml` files, or from the build
// tool's workspace manifest, and carried here as one island.
//
// The path conventions below are the LAST resort, not the first: they run only for a path no declared
// root covers. That ordering is the whole design — a declared root is a fact, a convention is a guess,
// and a guess that overrode a fact would be worse than having neither.

var projectLayoutParsed = null;

/**
 * The layout, parsed on first use.
 *
 * Lazily, not at this slice's top level, because slice order IS execution order: 01-core.js and
 * 05-keymap.js run their own top-level code before this file is reached, and anything of theirs that
 * asks about a path would read an `undefined` layout. A function is the one form that cannot be too
 * early (the same reason tokenSets() in 11-render-http.js is a function).
 */
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

/** A watch refresh rebuilds the review; the layout travels with it so a new module appears without a reload. */
function setProjectLayout(layout) {
  if (!layout || typeof layout !== 'object') return;
  projectLayoutParsed = {
    modules: Array.isArray(layout.modules) ? layout.modules : [],
    testRoots: Array.isArray(layout.testRoots) ? layout.testRoots : [],
    generatedRoots: Array.isArray(layout.generatedRoots) ? layout.generatedRoots : [],
    source: typeof layout.source === 'string' ? layout.source : 'conventions',
  };
  projectScopeCache = new Map();
  markProjectLayoutInTrees();
}

// Classifying a path is two prefix scans and a regex, and the lists that use it ask about the same few
// hundred paths over and over as a filter is typed. One map, dropped whenever the layout changes.
var projectScopeCache = new Map();

function projectNormalizePath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

function projectUnderRoot(path, root) {
  var prefix = projectNormalizePath(root);
  if (!prefix) return false;
  return path === prefix || path.indexOf(prefix + '/') === 0;
}

// Conventions, used only where the project declared nothing. The test one is the pattern this app has
// always used for "is this a test file" (it was `semanticTestPath`'s whole body); the generated one is
// IntelliJ's `generated="true"` without the declaration — a build output directory, or a file whose name
// says a generator wrote it.
var PROJECT_TEST_CONVENTION = /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(?:test|spec)\.[^.]+$/i;
var PROJECT_GENERATED_CONVENTION = /(^|\/)(dist|build|out|target|node_modules|vendor|generated|__generated__|\.next|coverage)(\/|$)|\.(?:min\.(?:js|css)|g\.dart|pb\.go)$|_pb2\.pyi?$/i;

/** 'test' | 'generated' | 'library' | 'production' — IntelliJ's scope groups, plus generated. */
function projectScopeOf(path) {
  var relative = projectNormalizePath(path);
  if (!relative) return 'production';
  var cached = projectScopeCache.get(relative);
  if (cached) return cached;
  var layout = projectLayoutData();
  var scope = 'production';
  var file = typeof sourceByPath !== 'undefined' && sourceByPath ? sourceByPath.get(path) : null;
  if (file && file.library) {
    scope = 'library';
  } else if (layout.generatedRoots.some(function (root) { return projectUnderRoot(relative, root); })) {
    scope = 'generated';
  } else if (layout.testRoots.some(function (root) { return projectUnderRoot(relative, root); })) {
    scope = 'test';
  } else if (PROJECT_GENERATED_CONVENTION.test(relative)) {
    scope = 'generated';
  } else if (PROJECT_TEST_CONVENTION.test(relative)) {
    scope = 'test';
  }
  projectScopeCache.set(relative, scope);
  return scope;
}

function projectIsTestPath(path) {
  return projectScopeOf(path) === 'test';
}

/** The module owning `path`, by longest matching root — mirrors moduleForPath in project-layout.ts. */
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

/**
 * Whether dividing a list by module would divide anything.
 *
 * A single-module repository — which most repositories are — gets no module headers at all, for the same
 * reason the usage view suppresses a sole "Unclassified" group: a header that every row is under is not a
 * division, it is a line of furniture above the answer.
 */
function projectHasModules() {
  return projectLayoutData().modules.length > 1;
}

/** The file on screen, which is what IntelliJ's "Module '<name>'" scope is relative to. */
function projectOpenPath() {
  var viewer = document.getElementById('source-viewer');
  return (viewer && viewer.dataset ? viewer.dataset.openPath : '') || '';
}

function projectCurrentModule() {
  var path = projectOpenPath();
  return path ? projectModuleName(path) : '';
}

/**
 * The directory prefixes a scope narrows to, as `{include, exclude}`.
 *
 * Only a NARROWING. ripgrep is asked for at most 500 matches, so a scope applied to the answer alone
 * would cut the wrong 500 rows first; this is what gets sent with the query, and the exact rule
 * (projectScopeOf, conventions and all) is applied to what comes back. A scope whose rule cannot be put
 * as a prefix — "changed files" — narrows nothing here, and that is the honest answer rather than a glob
 * that is nearly right.
 */
function projectScopePrefixes(scope) {
  var layout = projectLayoutData();
  if (scope === 'production') return { include: [], exclude: layout.testRoots.concat(layout.generatedRoots) };
  if (scope === 'tests') return { include: layout.testRoots, exclude: [] };
  if (scope === 'module') {
    var module = projectModuleOf(projectOpenPath());
    var root = module ? projectNormalizePath(module.root) : '';
    return { include: root ? [root] : [], exclude: [] };
  }
  return { include: [], exclude: [] };
}

/**
 * The tags IntelliJ's own popups carry on a row: which module the file is in, and whether it is test code.
 *
 * Go to File and Go to Symbol show the module on the right of every row there, and that is the division
 * the question "which Button.ts?" usually turns on in a workspace with four of them. The module tag is
 * suppressed in a single-module repository for the same reason the usage view's module header is.
 *
 * `kinds` leaves one of them out where the row already says it another way — a peek row that is a test
 * is already marked `is-test` by the surface it is in.
 */
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

// ---- The trees -------------------------------------------------------------------------------------
// IntelliJ marks a test source root in the project tree with its own icon, and every file under it is a
// test file at a glance. Both of kakapo's trees are plain path trees, so the marking goes on afterwards:
// the rows are rendered by render-tree.ts (server side, where the same classification would be a second
// copy of the rules above) and the test files are whichever of them this file says are test files.
//
// Idempotent, because it runs again every time either tree is rebuilt.

// IntelliJ's own folder marks, lifted out of its icons: the green/orange arrow pair that
// `platform/icons/src/nodes/testSourceFolder.svg` draws over a folder, and the blue square that
// `Module.svg` draws over the same folder. The polygons and the three colours (#62B543, #F26522,
// #40B6E0) are verbatim from those two files; what is kakapo's is the folder they sit on, which is this
// app's own outline icon rather than IntelliJ's filled one. A 16-unit viewBox over a 14px icon puts them
// in the bottom-right corner, which is where IntelliJ composes them.
var PROJECT_TEST_FOLDER_MARK = '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<polygon fill="#62B543" points="13.75 10.75 17.25 14.25 10.25 14.25" transform="rotate(90 13.75 12.5)"/>'
  + '<polygon fill="#F26522" points="9.25 10.75 12.75 14.25 5.75 14.25" transform="rotate(-90 9.25 12.5)"/></svg>';
var PROJECT_MODULE_FOLDER_MARK = '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<polygon fill="#40B6E0" points="10 16 16 16 16 10 10 10"/></svg>';

// A module GROUP, from moduleGroup.svg: four squares where the module icon has one.
var PROJECT_MODULE_GROUP_FOLDER_MARK = '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<polygon fill="#40B6E0" points="13 16 16 16 16 13 13 13"/><polygon fill="#40B6E0" points="13 12 16 12 16 9 13 9"/>'
  + '<polygon fill="#40B6E0" points="9 16 12 16 12 13 9 13"/><polygon fill="#40B6E0" points="9 12 12 12 12 9 9 9"/></svg>';
// The library mark, from ppLibFolder.svg: three bars in IntelliJ's blue, grey and green.
var PROJECT_LIBRARY_FOLDER_MARK = '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<rect width="2" height="6" x="14" y="8" fill="#40B6E0"/><rect width="2" height="8" x="11" y="6" fill="#9AA7B0"/>'
  + '<rect width="2" height="6" x="8" y="8" fill="#62B543"/></svg>';
// Excluded/generated, from excludedFromCompile.svg: its cross, in the row's own colour rather than
// IntelliJ's near-black — a dark theme would swallow that.
var PROJECT_GENERATED_FOLDER_MARK = '<svg class="folder-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<polygon fill="currentColor" fill-opacity=".75" points="15.995 15.291 14.2 13.498 15.988 11.709 15.288 11.008'
  + ' 13.499 12.798 11.704 11.004 11.003 11.703 12.8 13.498 11 15.299 11.7 16 13.5 14.198 15.294 15.991"/></svg>';

/**
 * A folder icon with one of IntelliJ's marks on it, for a usage-view group node.
 *
 * The same composition the trees use, built here so the two surfaces cannot drift: the outline is
 * kakapo's folder, the mark is IntelliJ's.
 */
function projectFolderIconHtml(mark) {
  return '<span class="folder-icon usage-group-icon">'
    + '<svg class="folder-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
    + '</svg>' + (mark || '') + '</span>';
}

/** Put `mark` on the row's folder icon, or take whatever is there off. Idempotent, like its caller. */
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

/** The directory row that IS a module root gets the module's name; a test root gets told so once. */
function markProjectLayoutTreeDirectories() {
  var layout = projectLayoutData();
  var byRoot = {};
  if (projectHasModules()) {
    layout.modules.forEach(function (module) {
      var root = projectNormalizePath(module && module.root);
      if (root && module.name) byRoot[root] = module.name;
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tree-dir[data-dir]'), function (row) {
    var path = projectNormalizePath(row.dataset.dir);
    var summary = row.querySelector('summary');
    if (!summary) return;
    var isTestRoot = layout.testRoots.some(function (root) { return projectNormalizePath(root) === path; });
    row.classList.toggle('is-test-root', isTestRoot);
    var existing = summary.querySelector('.tree-module');
    var name = byRoot[path] || '';
    row.classList.toggle('has-module', Boolean(name));
    // One mark per folder, and a test root inside a module keeps the test one: that is the distinction
    // the reader is being asked to see, and IntelliJ draws it the same way round.
    setFolderMark(row, isTestRoot ? PROJECT_TEST_FOLDER_MARK : (name ? PROJECT_MODULE_FOLDER_MARK : ''));
    if (!name) { if (existing) existing.remove(); return; }
    if (existing) { existing.textContent = name; return; }
    var badge = document.createElement('span');
    badge.className = 'tree-module';
    badge.textContent = name;
    summary.appendChild(badge);
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

// The server-rendered trees are already in the document by the time this slice runs — the client script is
// the last thing in the body — so this is the first marking, and every tree rebuild calls it again.
markProjectLayoutInTrees();
