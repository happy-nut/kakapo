// Semantic navigation controller. Source rendering owns caret state; this slice translates that state into
// project-analysis requests and hands multiple results to the semantic presenter in 16-semantic-peek.js.
// Standalone reviews retain a bounded in-memory fallback without coupling it back into source rendering.
function wordAtCursor() {
  if (!viewerCursor) return null;
  const file = sourceByPath.get(viewerCursor.path);
  if (!file || !file.embedded) return null;
  const line = file.content.split(/\r?\n/)[viewerCursor.lineIndex] || '';
  const column = Math.max(0, Math.min(viewerCursor.column, line.length));
  const identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match = null;
  while ((match = identifier.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (column >= start && column <= end) {
      return { name: match[0], path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: start };
    }
  }
  return null;
}

// The symbol the caret is on, in whichever view is up.
function symbolUnderCursor() {
  return isSourceViewerVisible() ? wordAtCursor() : symbolAtDiffCaret();
}
// ⌘↓ and ⌘-click: go to the definition. Landing on the declaration itself is the one case where the
// definition is not the answer, so that shows who uses it instead (same as IntelliJ).
function goToDefinitionUnderCursor() {
  const symbol = symbolUnderCursor();
  if (symbol) goToDefOrUsages(symbol.name, symbol);
  else showSemanticNavigationFailure('symbol');
}
// ⌘B: who uses this, always — never a jump to the declaration.
function findUsagesUnderCursor() {
  const symbol = symbolUnderCursor();
  if (symbol) findUsagesOf(symbol.name, symbol);
  else showSemanticNavigationFailure('symbol');
}
async function findUsagesOf(name, explicitLoc) {
  if (!name) { showSemanticNavigationFailure('symbol'); return; }
  var loc = explicitLoc || caretSourceLoc();
  // A cold language server answers its first question only after it has read the project — up to a minute
  // for a Gradle/Kotlin workspace. Silence for that long reads as a dead key, so say what is happening as
  // soon as the answer is not immediate. Anything that arrives later replaces the hint on its own.
  var pending = setTimeout(function () { showCaretHint(t('monaco.searching').replace('{symbol}', name), null, true); }, 250);
  var response = await queryProjectAnalysis('references', name, loc);
  clearTimeout(pending);
  hideCaretHint();
  if (declinedForRevision(response, name)) return;
  // The declaration the caret is sitting on is not one of its usages. Some servers report it, and a lone
  // self-hit then "navigated" to the line the caret was already on, which looks exactly like nothing.
  var items = ((response && response.locations) || []).filter(function (item) {
    return !(loc && item && item.path === loc.path && Number(item.lineIndex) === Number(loc.lineIndex));
  });
  if (items.length) { openAnalysisUsages(name, items, response, 'references'); return; }
  // Standalone HTML has no analyzer; the in-memory scan answers the same question over the embedded files.
  var def = findSymbolDefinition(name) || { path: (loc && loc.path) || '', lineIndex: -1 };
  openUsages(name, def);
}
// A dead end has to say WHICH dead end. "No definition" and "the language server has not finished reading
// the project yet" are different situations, and only one of them is worth pressing the key again a second
// later — a cold server is not hypothetical, it is slow enough on a big project to take a release down.
// The analysis status chip already carries the reason, but the reviewer is looking at the caret, which is
// where the key they pressed just failed.
// True when the answer did NOT come from a language server although one is being brought up: during the
// indexing window the regex index answers instead, and that is a different quality of answer.
function isPartialAnalysisAnswer(response) {
  if (!response || response.engine === 'lsp') return false;
  // A revision answer always carries a fallbackReason (no server can read a revision), which would make
  // every one of them read as "still indexing" — telling the reviewer to wait for an answer that will
  // never improve. It gets its own label below instead.
  if (response.revision) return false;
  var phase = (document.getElementById('analysis-status') || { dataset: {} }).dataset.phase;
  return phase === 'indexing' || phase === 'starting' || Boolean(response.fallbackReason);
}
function showPartialAnalysisHint(name) {
  showCaretHint(t('monaco.analysisPartial').replace('{symbol}', String(name || '')));
}
// True while a language server is coming up and has not answered yet — so a better answer than the regex
// index's is still on its way. Narrower than isPartialAnalysisAnswer on purpose: that one also counts
// "there is no server at all", where the index IS the final answer and should behave like one.
function analysisStillArriving() {
  var phase = (document.getElementById('analysis-status') || { dataset: {} }).dataset.phase;
  return phase === 'starting' || phase === 'indexing';
}
// The analyzer declined because the canvas is showing a revision and it only knows the working tree.
// Checked wherever an answer is consumed, and checked BEFORE the standalone in-memory scan: that scan
// reads the rendered DOM and would happily answer, which is the same wrong jump by another route.
function revisionDecline(response) {
  return response && response.declined === 'revision' ? String(response.revision || '') : null;
}
// An answer that DID come back, about a revision. Name-matched by construction, and permanently so.
function revisionAnswer(response) {
  return response && !response.declined && response.revision ? String(response.revision) : null;
}
function showRevisionAnswerHint(name, revision) {
  showCaretHint(t('monaco.analysisRevisionMatched')
    .replace('{symbol}', String(name || ''))
    .replace('{revision}', revision));
}
function showRevisionDecline(revision, name) {
  closeSemanticPeek();
  showCaretHint(t('monaco.analysisRevision')
    .replace('{revision}', revision || '—')
    .replace('{symbol}', String(name || '')));
}
// One line per call site, so every surface that asks the analyzer a question stops at the same boundary.
// Returns true when the caller should go no further — including past its own local fallback.
function declinedForRevision(response, name) {
  var revision = revisionDecline(response);
  if (revision === null) return false;
  showRevisionDecline(revision, name);
  return true;
}
function showSemanticNavigationFailure(kind, name, response) {
  var revision = revisionDecline(response);
  if (revision !== null) { showRevisionDecline(revision, name); return; }
  // `fallbackReason` is only set when the semantic answer could not be obtained, so this is "could not
  // ask", not "asked and there is nothing". Standalone HTML has no server at all and no reason either.
  var pending = Boolean(response && response.engine !== 'lsp' && response.fallbackReason);
  var key = pending ? 'monaco.analysisPending'
    : kind === 'references' ? 'monaco.referencesNotFound'
      : kind === 'implementation' ? 'monaco.implementationNotFound'
        : kind === 'typeDefinition' ? 'monaco.typeNotFound'
          : kind === 'supertypes' ? 'monaco.superNotFound'
            : kind === 'symbol' ? 'monaco.noSymbol' : 'monaco.definitionNotFound';
  var message = t(key).replace('{symbol}', String(name || ''));
  closeSemanticPeek();
  showCaretHint(message);
}
// Cmd+B: on a declaration, show its usages (navigate if there's only one); elsewhere, go to the definition.
async function goToDefOrUsages(name, explicitLoc) {
  if (!name) { showSemanticNavigationFailure('symbol'); return; }
  var loc = explicitLoc || caretSourceLoc();
  var pending = setTimeout(function () { showCaretHint(t('monaco.searching').replace('{symbol}', name), null, true); }, 250);
  var response = await queryProjectAnalysis('definition', name, loc);
  clearTimeout(pending);
  hideCaretHint(); // the wait is over, whatever the answer is; failures put their own message up below
  // Before the `ok` branch AND before the standalone scan below it: a decline is neither an answer nor a
  // failure to find one, and the local scan would read the rendered DOM and jump anyway.
  if (declinedForRevision(response, name)) return;
  if (response && response.ok) {
    var defs = response.locations || [];
    // An answer from the regex index while a language server exists is a guess at what the server would
    // have said. It is worth having — it is usually right, and it is immediate — but the reviewer should
    // know they are looking at the partial version, not conclude the project has only one definition of
    // this name. Said here, where they pressed the key, because the status chip is not where they looked.
    var answeredFor = revisionAnswer(response);
    if (defs.length && answeredFor) showRevisionAnswerHint(name, answeredFor);
    else if (defs.length && isPartialAnalysisAnswer(response)) showPartialAnalysisHint(name);
    // A guess must not MOVE the reviewer.
    //
    // While the server is still reading the project the regex index answers instead, and it matches on the
    // NAME alone — no types, no receiver. In a project with several same-named declarations (every Kotlin
    // codebase with more than one `greet`, `name`, `value`) that lands somewhere unrelated, and the
    // reviewer has lost their place to a guess the server was about to answer properly a moment later.
    // Reported from use: Cmd+Down in the diff view during the indexing window, "goes somewhere random".
    //
    // So during that window a single heuristic hit is OFFERED rather than taken — the peek list shows it,
    // labelled partial by the hint above, and the same key jumps for real once the server is ready. With
    // no server at all the index is the final word and still navigates, which is why this asks about the
    // phase rather than reusing isPartialAnalysisAnswer.
    var guessing = response.engine !== 'lsp' && analysisStillArriving();
    if (defs.length > 1 || (defs.length === 1 && guessing)) {
      openSemanticPeek(name, defs, response, 'definition');
      return;
    }
    var def = defs[0];
    // A compiled target is a real answer this app cannot open — a JDK class, a class inside a dependency
    // jar. Say where it is. Before this, the location was mangled into a path that exists nowhere and then
    // filtered away for having no readable text, so every stdlib and dependency symbol in Kotlin and Java
    // reported "definition not found" while the server had answered.
    if (def && def.external) {
      showCaretHint(t('monaco.definitionExternal')
        .replace('{symbol}', String(name || ''))
        .replace('{where}', externalLocationLabel(def.path)));
      return;
    }
    if (def && loc && def.path === loc.path && def.lineIndex === loc.lineIndex) {
      var refs = await queryProjectAnalysis('references', name, loc);
      openAnalysisUsages(name, refs && refs.locations || [], refs, 'references');
      return;
    }
    if (def) { openSourceAt(def.path, def.lineIndex, def.column); return; }
  }
  // Standalone HTML has no main-process analyzer. Keep a small in-memory scan for that mode only.
  var def = findSymbolDefinition(name);
  if (def && loc && def.path === loc.path && def.lineIndex === loc.lineIndex) {
    openUsages(name, def);
    return;
  }
  if (def) { openSourceAt(def.path, def.lineIndex, def.column); return; }
  showSemanticNavigationFailure('definition', name, response);
}
async function goToImplementation() {
  var symbol = isSourceViewerVisible() ? wordAtCursor() : null;
  var name = symbol ? symbol.name : wordAtDiffCaret();
  var loc = symbol || caretSourceLoc();
  if (!name || !loc) { showSemanticNavigationFailure('symbol'); return; }
  var response = await queryProjectAnalysis('implementation', name, loc);
  if (declinedForRevision(response, name)) return;
  var items = response && response.locations || [];
  if (items.length === 1) { openSourceAt(items[0].path, items[0].lineIndex, items[0].column); return; }
  openAnalysisUsages(name, items, response, 'implementation');
}
function queryProjectAnalysis(kind, symbol, loc, extra) {
  if (!window.kakapoAnalysis || typeof window.kakapoAnalysis.query !== 'function') return Promise.resolve(null);
  var request = Object.assign({
    kind: kind,
    symbol: symbol || undefined,
    path: loc && loc.path,
    line: loc && loc.lineIndex,
    column: loc && loc.column,
  }, extra || {});
  return Promise.resolve(window.kakapoAnalysis.query(request)).then(function (response) {
    if (!analysisGenerationIsCurrent(response)) return null;
    return response;
  }).catch(function () { return null; });
}
// Where the caret sits, mapped to a source (path, lineIndex). Both diff panes carry their own real line
// number; callers that need the token itself use symbolAtDiffCaret so the old side can query by name too.
function caretSourceLoc() {
  if (isSourceViewerVisible() && viewerCursor) return { path: viewerCursor.path, lineIndex: viewerCursor.lineIndex, column: viewerCursor.column };
  if (isDiffViewVisible() && diffCursor) {
    var wrap = diffWrapperByPath(diffCursor.path);
    var row = wrap ? diffRowAt(wrap, diffCursor.side, diffCursor.rowIndex) : null;
    var ln = row ? diffLineNumber(row) : null;
    if (ln != null) return { path: diffCursor.path, lineIndex: ln - 1, column: diffCursor.column, side: diffCursor.side };
  }
  return null;
}
// All word-boundary occurrences of name across embedded files, excluding the declaration line itself.
function findUsages(name, defPath, defLine) {
  var re;
  try { re = new RegExp('(^|[^A-Za-z0-9_$])' + escapeRegExp(name) + '(?![A-Za-z0-9_$])'); } catch (e) { return []; }
  var out = [];
  for (var fi = 0; fi < sourceFiles.length; fi++) {
    var f = sourceFiles[fi];
    if (!f.embedded || semanticDocumentPath(f.path)) continue;
    var lines = String(f.content).split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      if (f.path === defPath && li === defLine) continue;
      if (semanticCommentOnlyLine(lines[li])) continue;
      var m = re.exec(lines[li]);
      if (m) {
        out.push({ path: f.path, lineIndex: li, column: m.index + (m[1] ? m[1].length : 0), text: lines[li] });
        if (out.length >= 500) return out;
      }
    }
  }
  return out;
}
function openUsages(name, def) {
  var items = findUsages(name, def.path, def.lineIndex);
  if (items.length === 1) { openSourceAt(items[0].path, items[0].lineIndex, items[0].column); return; }
  if (!items.length) { showSemanticNavigationFailure('references', name, response); return; }
  usageItems = items;
  usageActive = 0;
  showUsages(name, items.length);
}
function openAnalysisUsages(name, locations, response, kind) {
  locations = semanticNavigationLocations(locations, kind);
  if (!(locations || []).length) { showSemanticNavigationFailure(kind || 'references', name, response); return; }
  if (locations.length > 1) {
    openSemanticPeek(name, locations, response, kind || 'references');
    return;
  }
  openAnalysisUsagesFallback(name, locations, kind || 'references');
}
function showUsages(name, count) {
  var box = document.getElementById('usages');
  var title = document.getElementById('usages-title');
  if (!box) return;
  if (title) title.textContent = count + ' usage' + (count === 1 ? '' : 's') + ' of ' + name;
  renderUsages();
  box.classList.remove('hidden');
  positionUsagesAtCaret();
}
// Anchor the usages popup just below (or above, if cramped) the live caret — source OR diff both render a
// `.code-cursor` span. No caret on screen → leave the centered overlay fallback in place.
function positionUsagesAtCaret() {
  var box = document.getElementById('usages');
  if (!box) return;
  var panel = box.querySelector('.quick-open-panel');
  if (!panel) return;
  resetUsagesAnchor(box, panel); // measure from a clean slate
  var caret = document.querySelector('#source-body .code-cursor') || document.querySelector('#diff2html-container .code-cursor');
  if (!caret) return;
  var rect = caret.getBoundingClientRect();
  if (!rect.height && !rect.width && !rect.top) return; // detached / off-layout
  var vw = window.innerWidth, vh = window.innerHeight, gap = 6, margin = 8;
  var pw = Math.min(560, vw - margin * 2);
  var left = Math.min(Math.max(margin, rect.left), vw - pw - margin);
  box.classList.add('anchored');
  panel.style.width = pw + 'px';
  panel.style.left = left + 'px';
  var spaceBelow = vh - rect.bottom - gap - margin;
  var spaceAbove = rect.top - gap - margin;
  if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
    panel.style.top = (rect.bottom + gap) + 'px';
    panel.style.maxHeight = Math.max(120, spaceBelow) + 'px';
  } else {
    panel.style.bottom = (vh - rect.top + gap) + 'px';
    panel.style.maxHeight = Math.max(120, spaceAbove) + 'px';
  }
}
function resetUsagesAnchor(box, panel) {
  box.classList.remove('anchored');
  panel.style.left = panel.style.top = panel.style.bottom = panel.style.width = panel.style.maxHeight = '';
}
function renderUsages() {
  var results = document.getElementById('usages-results');
  if (!results) return;
  if (!usageItems.length) { results.innerHTML = '<div class="quick-open-empty">No usages found.</div>'; return; }
  results.innerHTML = usageItems.map(function (item, index) {
    var fname = item.path.split('/').pop();
    var isTest = item.isTest || semanticTestPath(item.path);
    return '<button type="button" class="quick-open-item usage-item' + (isTest ? ' is-test' : '') + (index === usageActive ? ' active' : '') + '" data-index="' + index + '" title="' + escapeHtml(item.path + ':' + (item.lineIndex + 1)) + '">'
      + '<span class="usage-loc">' + escapeHtml(fname) + ':' + (item.lineIndex + 1) + '</span>'
      + '<span class="usage-code">' + semanticCodeHtml(item.path, item.text.replace(/^\s+/, '').slice(0, 160)) + '</span>'
      + '</button>';
  }).join('');
  updateUsageActive();
}
function updateUsageActive() {
  var results = document.getElementById('usages-results');
  if (!results) return;
  var items = results.querySelectorAll('.usage-item');
  for (var i = 0; i < items.length; i++) {
    var on = i === usageActive;
    items[i].classList.toggle('active', on);
    if (on && items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
  }
}
function handleUsagesKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); closeUsages(); return true; }
  if (event.key === 'ArrowDown') { event.preventDefault(); usageActive = Math.min(usageActive + 1, usageItems.length - 1); updateUsageActive(); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); usageActive = Math.max(usageActive - 1, 0); updateUsageActive(); return true; }
  if (event.key === 'Enter') { event.preventDefault(); openUsageItem(usageItems[usageActive]); return true; }
  return false;
}
function openUsageItem(item) {
  if (!item) return;
  closeUsages();
  openSourceAt(item.path, item.lineIndex, item.column);
}
function closeUsages() {
  var box = document.getElementById('usages');
  if (!box) return;
  box.classList.add('hidden');
  var panel = box.querySelector('.quick-open-panel');
  if (panel) resetUsagesAnchor(box, panel); // clear inline anchoring so the next open re-measures cleanly
}

function wordAtDiffCaret() {
  var symbol = symbolAtDiffCaret();
  return symbol ? symbol.name : null;
}
// Resolve the token and its real source coordinates from whichever diff pane owns the caret. The old/base
// side is intentionally supported too: the analyzer receives the explicit token, so its index fallback can
// still resolve a definition when that exact baseline line no longer exists in the working tree.
function symbolAtDiffCaret() {
  if (!diffCursor) return null;
  var wrapper = diffWrapperByPath(diffCursor.path);
  if (!wrapper) return null;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  var line = diffLineNumber(row);
  if (line == null) return null;
  var text = diffLineText(row);
  var column = Math.max(0, Math.min(diffCursor.column, text.length));
  var identifier = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  var match = null;
  while ((match = identifier.exec(text))) {
    if (column >= match.index && column <= match.index + match[0].length) {
      return {
        name: match[0],
        path: diffCursor.path,
        lineIndex: line - 1,
        column: match.index,
        side: diffCursor.side,
      };
    }
  }
  return null;
}

function findSymbolDefinition(name) {
  const matchers = definitionMatchers(name);
  const currentPath = viewerCursor?.path || '';
  const orderedFiles = [
    ...sourceFiles.filter((file) => file.path === currentPath),
    ...sourceFiles.filter((file) => file.path !== currentPath),
  ].filter((file) => file.embedded && !semanticDocumentPath(file.path));

  for (const file of orderedFiles) {
    const lines = file.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (semanticCommentOnlyLine(line)) continue;
      if (matchers.some((matcher) => matcher.test(line))) {
        return { path: file.path, lineIndex, column: Math.max(0, line.indexOf(name)) };
      }
    }
  }
  return null;
}

function definitionMatchers(name) {
  const escaped = escapeRegExp(name);
  const mod = '(?:(?:public|private|protected|internal|abstract|final|open|sealed|data|inner|enum|annotation|static|export|default|expect|actual|value)\\s+)*';
  const funMod = '(?:(?:public|private|protected|internal|abstract|final|open|override|suspend|inline|operator|static|async)\\s+)*';
  // An enum entry declares itself by standing alone on a line — `DONE,` — which matches none of the shapes
  // below, so Cmd+B on one used to dead-end ("Definition not found") even though its usages are right there.
  // Only for SCREAMING_SNAKE names: in any other casing a bare `name(` line is far more likely to be a call.
  const enumEntry = /^[A-Z][A-Z0-9_$]*$/.test(name)
    ? [new RegExp('^\\s*' + escaped + '\\s*(?:[,;(]|\\{|$)')]
    : [];
  return enumEntry.concat([
    new RegExp('^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + mod + '(?:class|interface|object|enum|trait|struct)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*(?:export\\s+)?(?:const|let|var|val)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + '(?:fun|def|fn|func)\\s+' + escaped + '\\b'),
    new RegExp('^\\s*' + funMod + escaped + '\\s*\\([^)]*\\)\\s*(?::\\s*[^=]+)?\\s*(?:\\{|=>)'),
    new RegExp('^\\s*' + escaped + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>)'),
  ]);
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}
