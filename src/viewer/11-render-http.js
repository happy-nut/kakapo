function skippedReasonText(file) {
  var kind = file && file.skippedKind;
  if (kind) {
    var text = t('source.skipped.' + kind);
    var detail = file && file.skippedDetail;
    return detail ? text.replace('{detail}', detail) : text.replace(/\s*\(\{detail\}\)/, '');
  }
  return String((file && file.skippedReason) || '') || t('source.skipped.notEmbedded');
}
function openSourceFile(path, shouldSwitch = true, options) {
  const file = sourceByPath.get(path);
  if (!file) {
    loadLibrarySourceFile(path).then(function (record) {
      if (record) openSourceFile(path, shouldSwitch, options);
      else reportLibraryMiss(path);
    });
    return;
  }
  const shouldScrollTree = !(options && options.scrollTree === false);
  if (shouldSwitch) flashReviewPanelFocus(document.getElementById('source-body'));
  if (composerState && composerState.path !== path) closeComposer();
  addSourceTab(path);
  renderSourceTabs(path);
  ['source-title', 'source-meta', 'source-body'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.removeAttribute('data-i18n');
  });
  if (!sourceContentLoaded(file)) {
    sourceBodyPath = null;
    document.getElementById('source-viewer').dataset.openPath = path;
    setTimeout(refreshFileFindForActiveView, 0);
    sourceLinks.forEach((link) => link.classList.toggle('active', link.dataset.sourceFile === path));
    renderCommitContext(document.getElementById('source-commit-context'));
    renderCommitContext(document.getElementById('source-commit-context'));
  renderBreadcrumb(document.getElementById('source-title'), path);
    setSourceTypeIcon(path);
    revealTreeFor(path, shouldScrollTree);
    var lb = document.getElementById('source-body');
    setPanelClassNamePreservingFocus(lb, 'source-body empty is-loading');
    lb.innerHTML = loadingStateHtml(t('source.loading'));
    updateRenderToggle(path);
    if (shouldSwitch) showSourceView();
    loadSourceFile(path).then(function () {
      if (sourceOpenPath() === path) openSourceFile(path, false, options);
    });
    return;
  }
  rememberRecent(path, 'source');
  sourceBodyPath = path;
  document.getElementById('source-viewer').dataset.openPath = path;
  setTimeout(refreshFileFindForActiveView, 0);
  sourceLinks.forEach((link) => link.classList.toggle('active', link.dataset.sourceFile === path));
  renderCommitContext(document.getElementById('source-commit-context'));
  renderBreadcrumb(document.getElementById('source-title'), path);
  setSourceTypeIcon(path);
  revealTreeFor(path, shouldScrollTree);
  const meta = (file.library ? t('source.library') + ' · ' : '') + (file.symlink ? t('source.symlink') + ' · ' : '')
    + (file.embedded
      ? formatBytes(file.size || 0)
      : formatBytes(file.size || 0) + ' · ' + skippedReasonText(file));
  document.getElementById('source-meta').textContent = meta;
  const body = document.getElementById('source-body');
  const httpEnvSelect = document.getElementById('http-env-select');
  if (file.image) {
    setPanelClassNamePreservingFocus(body, 'source-body image-body');
    var isPdfPreview = file.image.slice(0, 20) === 'data:application/pdf';
    body.innerHTML = isPdfPreview ? renderPdfView(file) : renderImageView(file);
    if (isPdfPreview) mountPdfPreview(body, file);
    document.getElementById('http-env-select')?.classList.add('hidden');
    updateRenderToggle(path);
    if (shouldSwitch) showSourceView();
    return;
  }
  if (!file.embedded) {
    setPanelClassNamePreservingFocus(body, 'source-body empty');
    var why = skippedReasonText(file);
    body.textContent = why ? t('source.previewUnavailable').replace(/\.$/, '') + ': ' + why + '.' : t('source.previewUnavailable');
    document.getElementById('http-env-select')?.classList.add('hidden');
    updateRenderToggle(path);
    if (shouldSwitch) showSourceView();
    return;
  }
  if (!viewerCursor || viewerCursor.path !== path) {
    viewerCursor = { path, lineIndex: 0, column: 0, targetLine: -1 };
  }
  setPanelClassNamePreservingFocus(body, 'source-body');
  if (isMarkdownPath(path)) {
    if (renderRawMode) {
      body.innerHTML = renderSourceTable(file, '');
    } else {
      body.classList.add('rendered-body');
      body.innerHTML = renderMarkdownRows(file.content);
      rewriteMarkdownAssets(body, path);
    }
    if (httpEnvSelect) httpEnvSelect.classList.add('hidden');
    updateRenderToggle(path);
    renderSourceComments();
    refreshSourceBlamePaint(path);
    if (shouldSwitch) showSourceView();
    return;
  }
  if (isCsvPath(path)) {
    if (renderRawMode) {
      body.innerHTML = renderSourceTable(file, '');
    } else {
      body.classList.add('rendered-body');
      body.innerHTML = renderCsvRows(file.content, path);
    }
    if (httpEnvSelect) httpEnvSelect.classList.add('hidden');
    updateRenderToggle(path);
    renderSourceComments();
    refreshSourceBlamePaint(path);
    if (shouldSwitch) showSourceView();
    return;
  }
  if (isHttpFile(path)) {
    body.innerHTML = renderHttpTable(file);
    if (httpEnvSelect) httpEnvSelect.classList.toggle('hidden', httpEnvNames.length === 0);
  } else {
    body.innerHTML = renderSourceTable(file, '');
    if (httpEnvSelect) httpEnvSelect.classList.add('hidden');
    if (viewerCursor && viewerCursor.path === path) { var ccr = body.querySelector('.source-row.cursor-line'); if (ccr) insertSourceCaret(ccr, viewerCursor.column); }
  }
  updateRenderToggle(path);
  renderSourceComments();
  refreshSourceBlamePaint(path);
  refreshSourceDiagnostics(path);
  paintSourceDecorations();
  if (shouldSwitch) showSourceView();
}

function isMarkdownPath(p) { return /\.(md|mdx|markdown)$/i.test(p || ''); }
function isCsvPath(p) { return /\.(csv|tsv)$/i.test(p || ''); }
function isRenderToggleable(p) { return isMarkdownPath(p) || isCsvPath(p); }

var lineWrapKey = 'kakapo-line-wrap';
var lineWrapEnabled = (function () {
  var saved = persistRead(lineWrapKey);
  if (saved == null) { try { saved = localStorage.getItem(lineWrapKey); } catch (e) {} }
  if (saved == null) return true;
  return saved === true || saved === 'true' || saved === '1';
})();
function sourceLineWrapAvailable(path) {
  var body = document.getElementById('source-body');
  var file = sourceByPath.get(path || '');
  return Boolean(path && body && file && file.embedded && !file.image
    && !body.classList.contains('empty') && !body.classList.contains('rendered-body'));
}
function updateLineWrapToggle(path) {
  var body = document.getElementById('source-body');
  var btn = document.getElementById('line-wrap-toggle');
  var available = sourceLineWrapAvailable(path);
  if (body) body.classList.toggle('line-wrap', available && lineWrapEnabled);
  if (!btn) return;
  btn.classList.toggle('hidden', !available);
  btn.classList.toggle('is-checked', available && lineWrapEnabled);
  btn.setAttribute('aria-checked', available && lineWrapEnabled ? 'true' : 'false');
}
function refreshDiffLineWrapLayout() {
  var wrapper = diffActiveWrapper();
  if (!wrapper) return;
  invalidateAsymmetricDiffGeometry(wrapper);
  requestAnimationFrame(function () {
    refreshLayeredDiffGutters(wrapper);
    invalidateAsymmetricDiffGeometry(wrapper);
    scrollAsymmetricDiff();
    if (typeof diffCursor !== 'undefined' && diffCursor && diffCursor.path === (wrapper.dataset.path || '')) scheduleDiffReveal(wrapper, diffCursor.side, diffCursor.rowIndex);
    else renderDiffCaret();
  });
}
function updateDiffLineWrapToggle() {
  var container = document.getElementById('diff2html-container');
  var btn = document.getElementById('diff-line-wrap-toggle');
  if (container) {
    container.classList.toggle('line-wrap', lineWrapEnabled);
    if (lineWrapEnabled) container.querySelectorAll('.d2h-file-side-diff').forEach(function (side) { side.scrollLeft = 0; });
  }
  if (btn) {
    btn.classList.toggle('is-checked', lineWrapEnabled);
    btn.setAttribute('aria-checked', lineWrapEnabled ? 'true' : 'false');
  }
}
function applyLineWrapState() {
  updateLineWrapToggle(sourceOpenPath());
  updateDiffLineWrapToggle();
}
function toggleLineWrap() {
  if (!isSourceViewerVisible() && !isDiffViewVisible()) return false;
  if (isSourceViewerVisible()) {
    var open = sourceOpenPath();
    if (!open || !sourceLineWrapAvailable(open)) return false;
  }
  lineWrapEnabled = !lineWrapEnabled;
  persistSave(lineWrapKey, lineWrapEnabled ? '1' : '0');
  if (typeof _srcRowH !== 'undefined') _srcRowH = 0;
  applyLineWrapState();
  var body = document.getElementById('source-body');
  if (body && lineWrapEnabled) body.scrollLeft = 0;
  if (isSourceViewerVisible()) requestAnimationFrame(function () { revealSourceCursorWithMargin(); });
  else refreshDiffLineWrapLayout();
  return true;
}

var renderRawMode = false;
function updateRenderToggle(path) {
  var btn = document.getElementById('render-toggle');
  var on = isRenderToggleable(path);
  if (btn) {
    btn.classList.toggle('hidden', !on);
    if (on) {
      btn.textContent = renderRawMode ? t('source.viewRendered') : t('source.viewRaw');
      btn.removeAttribute('aria-pressed');
    }
  }
  updateLineWrapToggle(path);
}
function toggleRenderMode() {
  var open = sourceOpenPath();
  if (!open || !isRenderToggleable(open)) return;
  renderRawMode = !renderRawMode;
  openSourceFile(open, false);
}
(function wireRenderToggle() {
  var btn = document.getElementById('render-toggle');
  if (btn) btn.addEventListener('click', function () { toggleRenderMode(); });
  var wrapBtn = document.getElementById('line-wrap-toggle');
  if (wrapBtn) wrapBtn.addEventListener('click', function () { toggleLineWrap(); });
  var diffWrapBtn = document.getElementById('diff-line-wrap-toggle');
  if (diffWrapBtn) diffWrapBtn.addEventListener('click', function () { toggleLineWrap(); });
  var sourceBody = document.getElementById('source-body');
  if (sourceBody) sourceBody.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[data-md-link]') : null;
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    var from = sourceOpenPath();
    var target = resolveRepoHref(from, link.getAttribute('data-md-link') || '');
    if (!target) return;
    event.preventDefault();
    openSourceFile(target);
  });
  applyLineWrapState();
  if (lineWrapEnabled) refreshDiffLineWrapLayout();
})();

function renderPdfView(file) {
  return '<div class="pdf-view">'
    + '<embed class="pdf-frame" type="application/pdf" title="' + escapeHtml(file.name) + '">'
    + '<div class="image-cap">' + escapeHtml(file.name) + ' &middot; ' + formatBytes(file.size || 0) + '</div>'
    + '</div>';
}
// One object URL at a time, revoked when the next PDF opens: a data: URI in an <embed> is refused by
// Chromium's plugin loader, and stuffing a 4/3-inflated base64 string into an attribute is not free either.
// The blob is the same bytes with a real content type, which is exactly what the viewer wants.
var pdfObjectUrl = null;
function mountPdfPreview(body, file) {
  var frame = body.querySelector('.pdf-frame');
  if (!frame) return;
  if (pdfObjectUrl) { try { URL.revokeObjectURL(pdfObjectUrl); } catch (e) {} }
  var base64 = String(file.image).slice(String(file.image).indexOf(',') + 1);
  try {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    pdfObjectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    frame.src = pdfObjectUrl;
  } catch (e) {
    pdfObjectUrl = null;
    body.textContent = t('source.previewUnavailable');
  }
}

function renderImageView(file) {
  return '<div class="image-view">'
    + '<img class="image-preview" src="' + file.image + '" alt="' + escapeHtml(file.name) + '" data-zoomable="1">'
    + '<div class="image-cap">' + escapeHtml(file.name) + ' &middot; ' + formatBytes(file.size || 0) + ' &middot; click to zoom</div>'
    + '</div>';
}

function openLightbox(src, alt, vector) {
  if (!src) return;
  var lb = document.getElementById('mc-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'mc-lightbox';
    lb.className = 'mc-lightbox hidden';
    lb.innerHTML = '<img class="mc-lightbox-img" alt="">';
    document.body.appendChild(lb);
    lb.addEventListener('click', closeLightbox);
  }
  var img = lb.querySelector('img');
  img.classList.toggle('mc-lightbox-vector', !!vector);
  img.src = src;
  img.alt = alt || '';
  lb.classList.remove('hidden');
}
function closeLightbox() {
  var lb = document.getElementById('mc-lightbox');
  if (lb) lb.classList.add('hidden');
}
function lightboxOpen() {
  var lb = document.getElementById('mc-lightbox');
  return !!(lb && !lb.classList.contains('hidden'));
}

function isRepoRelativeHref(href) {
  if (!href) return false;
  if (href.charAt(0) === '#') return false;
  if (href.slice(0, 2) === '//') return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(href);
}
function resolveRepoHref(fromPath, href) {
  var hash = href.indexOf('#');
  if (hash >= 0) href = href.slice(0, hash);
  var query = href.indexOf('?');
  if (query >= 0) href = href.slice(0, query);
  if (!href) return '';
  if (href.charAt(0) === '/') return href.replace(/^\/+/, '');
  var parts = String(fromPath || '').split('/');
  parts.pop();
  href.split('/').forEach(function (seg) {
    if (!seg || seg === '.') return;
    if (seg === '..') { parts.pop(); return; }
    parts.push(seg);
  });
  return parts.join('/');
}
var markdownEngine = null;
function markdownLanguage(lang) {
  var l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (l === 'js' || l === 'jsx' || l === 'ts' || l === 'tsx') return 'typescript';
  if (l === 'sh' || l === 'bash' || l === 'zsh') return 'bash';
  if (l === 'yml') return 'yaml';
  return l || 'text';
}
function getMarkdownEngine() {
  if (markdownEngine) return markdownEngine;
  if (typeof window.markdownit !== 'function') throw new Error('markdown-it runtime is unavailable');
  markdownEngine = window.markdownit({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false,
    highlight: function (source, lang) {
      var language = markdownLanguage(lang);
      return String(source).split('\n').map(function (line) { return highlightLine(line, language); }).join('\n');
    },
  });
  // Autolink real URLs only. linkify's fuzzy mode turns anything shaped like a domain into a link, and half
  // the file extensions an agent names in prose are country TLDs — `chart.py` (Paraguay), `run.sh`, `notes.md`
  // — so a file it mentioned without backticks came out as a blue external link to a domain that does not
  // exist, opening a browser tab on click. `https://…` still linkifies; a bare filename degrades to text.
  markdownEngine.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
  var defaultLinkOpen = markdownEngine.renderer.rules.link_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  markdownEngine.renderer.rules.link_open = function (tokens, idx, options, env, self) {
    var href = tokens[idx].attrGet('href') || '';
    if (isRepoRelativeHref(href)) {
      tokens[idx].attrSet('data-md-link', href);
      return defaultLinkOpen(tokens, idx, options, env, self);
    }
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkOpen(tokens, idx, options, env, self);
  };
  return markdownEngine;
}
function sanitizeMarkdown(html) {
  if (!window.DOMPurify || typeof window.DOMPurify.sanitize !== 'function') throw new Error('DOMPurify runtime is unavailable');
  return window.DOMPurify.sanitize(String(html), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
}
function renderMarkdownHtml(content) {
  return sanitizeMarkdown(getMarkdownEngine().render(String(content || '')));
}

// YAML frontmatter is not markdown, and handing it to a CommonMark parser is actively wrong: a `---` line
// UNDER text is a setext H2, so `---\nname: x\ndescription: y\n---` renders as one giant bold heading between
// two rules, with every line in between collapsed out of the gutter. Split it off and render it as what it is.
// Only a fence at the very top counts; a `---` anywhere else is a legitimate thematic break.
function splitFrontmatter(content) {
  var text = String(content || '');
  var match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!match) return { yaml: null, body: text, offset: 0 };
  return { yaml: match[1], body: text.slice(match[0].length), offset: (match[0].match(/\n/g) || []).length };
}
function frontmatterHtml(yaml) {
  var lines = String(yaml).split('\n').map(function (line) { return highlightLine(line, 'yaml'); }).join('\n');
  return '<pre class="md-frontmatter"><code class="language-yaml">' + lines + '</code></pre>';
}

function renderMarkdownBlocks(content) {
  var md = getMarkdownEngine();
  var split = splitFrontmatter(content);
  var env = {};
  var tokens = md.parse(split.body, env);
  var groups = [];
  var group = null;
  tokens.forEach(function (token) {
    if (token.level === 0 && Array.isArray(token.map)) {
      if (group) groups.push(group);
      group = { line: token.map[0], endLine: token.map[1], tokens: [] };
    }
    if (!group) group = { line: 0, endLine: 1, tokens: [] };
    group.tokens.push(token);
  });
  if (group) groups.push(group);
  var blocks = groups.map(function (item) {
    return {
      line: item.line + split.offset,
      endLine: item.endLine + split.offset,
      html: sanitizeMarkdown(md.renderer.render(item.tokens, md.options, env)),
    };
  });
  if (split.yaml !== null) {
    blocks.unshift({ line: 0, endLine: split.offset, html: sanitizeMarkdown(frontmatterHtml(split.yaml)) });
  }
  return blocks;
}

function renderMarkdownRows(content) {
  var blocks = renderMarkdownBlocks(content);
  if (!blocks.length) return '<table class="source-table md-doc" role="presentation"><tbody></tbody></table>';
  var rows = blocks.map(function (b) {
    return '<tr class="source-row md-row" data-line-index="' + b.line + '" data-line-end="' + b.endLine + '"><td class="num">' + (b.line + 1) + '</td><td class="source-code md-cell markdown-body">' + b.html + '</td></tr>';
  }).join('');
  return '<table class="source-table md-doc" role="presentation"><tbody>' + rows + '</tbody></table>';
}

function normalizeMarkdownAssetPath(baseDir, src) {
  var clean = String(src || '').split(/[?#]/)[0];
  if (!clean) return null;
  var parts = baseDir ? baseDir.split('/') : [];
  clean.split('/').forEach(function (seg) {
    if (seg === '' || seg === '.') return;
    if (seg === '..') { if (parts.length) parts.pop(); }
    else parts.push(seg);
  });
  var rel = parts.join('/');
  return rel || null;
}

function rewriteMarkdownAssets(container, docPath) {
  if (!container || !window.kakapoFile || typeof window.kakapoFile.getAsset !== 'function') return;
  var imgs = container.querySelectorAll('img[src]');
  if (!imgs.length) return;
  var slash = String(docPath || '').lastIndexOf('/');
  var baseDir = slash >= 0 ? docPath.slice(0, slash) : '';
  Array.prototype.forEach.call(imgs, function (img) {
    var src = img.getAttribute('src') || '';
    if (!src || src.charAt(0) === '/' || src.charAt(0) === '#' || /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i.test(src)) return;
    var rel = normalizeMarkdownAssetPath(baseDir, src);
    if (!rel) return;
    window.kakapoFile.getAsset(rel).then(function (res) {
      if (res && res.dataUrl && img.isConnected) img.src = res.dataUrl;
    }).catch(function () {});
  });
}

function parseDelimited(content, delim) {
  var rows = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var s = String(content);
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function renderCsvRows(content, path) {
  var delim = /\.tsv$/i.test(path || '') ? '\t' : ',';
  var records = parseDelimited(content, delim).filter(function (r) { return !(r.length === 1 && r[0] === ''); });
  if (!records.length) return '<table class="source-table csv-doc"><tbody></tbody></table>';
  var cols = records.reduce(function (max, r) { return Math.max(max, r.length); }, 0);
  var rowHtml = records.map(function (rec, idx) {
    var head = idx === 0;
    var cells = '';
    for (var c = 0; c < cols; c++) {
      var v = escapeHtml(rec[c] == null ? '' : rec[c]);
      var named = head && rec[c] != null && String(rec[c]).trim() !== '';
      if (head) cells += '<th class="csv-cell"' + (named ? ' scope="col"' : '') + '>' + v + '</th>';
      else cells += '<td class="csv-cell">' + v + '</td>';
    }
    var gutter = '<' + (head ? 'th' : 'td') + ' class="num"' + (head ? ' scope="col"' : '') + '>' + (idx + 1) + '</' + (head ? 'th' : 'td') + '>';
    return '<tr class="source-row csv-row' + (head ? ' csv-head' : '') + '" data-line-index="' + idx + '">' + gutter + cells + '</tr>';
  });
  return '<table class="source-table csv-doc"><thead>' + rowHtml[0] + '</thead><tbody>'
    + rowHtml.slice(1).join('') + '</tbody></table>';
}

function renderHttpTable(file) {
  const parsed = parseHttpRequests(file.content);
  const requests = parsed.requests;
  httpRequestsByPath.set(file.path, requests);
  httpVarsByPath.set(file.path, parsed.vars);
  httpImportsByPath.set(file.path, parsed.imports);
  const scope = httpScope(file.path, -1);
  const lines = String(file.content).split(/\r?\n/);
  const cursor = viewerCursor && viewerCursor.path === file.path ? viewerCursor : null;
  const runAtLine = {};
  const respAfterLine = {};
  requests.forEach(function (req, idx) {
    if (req.startLine >= 0) runAtLine[req.startLine] = idx;
    respAfterLine[req.endLine] = idx;
  });
  let rows = '';
  lines.forEach(function (line, index) {
    const hasRun = Object.prototype.hasOwnProperty.call(runAtLine, index);
    const reqIdx = hasRun ? runAtLine[index] : -1;
    const isCursorLine = Boolean(cursor && cursor.lineIndex === index);
    const label = hasRun ? t('http.runNamed').replace('{name}', requests[reqIdx].name) : '';
    const gutter = hasRun
      ? '<button type="button" class="http-run" data-keyhint-id="runHttp" data-req="' + reqIdx + '"'
        + ' title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">&#9654;</button>'
      : '';
    const isScript = Boolean(parsed.scriptLines[index]);
    rows += '<tr class="source-row http-row' + (hasRun ? ' http-request-line' : '') + (isScript ? ' http-script-line' : '')
      + (isCursorLine ? ' cursor-line' : '') + '" data-line-index="' + index + '">'
      + '<td class="num http-gutter">' + gutter + '<span class="num-text">' + (index + 1) + '</span></td>'
      + sourceCodeCellHtml(isCursorLine ? renderHttpLineWithCursor(line, scope, cursor.column, isScript) : highlightHttpLine(line, scope, isScript), index < lines.length - 1)
      + '</tr>';
    if (Object.prototype.hasOwnProperty.call(respAfterLine, index)) {
      const rIdx = respAfterLine[index];
      rows += '<tr class="http-response-row"><td class="num"></td><td class="source-code"><div class="http-response hidden" id="http-resp-' + rIdx + '"></div></td></tr>';
    }
  });
  return '<table class="source-table http-table"><tbody>' + rows + '</tbody></table>';
}
function renderHttpLineWithCursor(text, scope, column, isScript) {
  var col = Math.max(0, Math.min(column, text.length));
  return highlightHttpLine(text.slice(0, col), scope, isScript)
    + '<span class="code-cursor" aria-hidden="true"></span>'
    + highlightHttpLine(text.slice(col), scope, isScript);
}

function highlightHttpLine(line, scope, isScript) {
  const trimmed = line.trim();
  if (isScript) return highlightLine(line, 'javascript');
  if (trimmed.indexOf('###') === 0) return '<span class="http-sep">' + escapeHtml(line) + '</span>';
  if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) {
    const directive = /^(\s*(?:#+|\/\/)\s*)(@[\w-]+)(.*)$/.exec(line);
    if (directive && httpSyntax().directives[directive[2].slice(1).toLowerCase()]) {
      return '<span class="tok-comment">' + escapeHtml(directive[1]) + '</span>'
        + '<span class="http-directive">' + escapeHtml(directive[2]) + '</span>'
        + '<span class="tok-comment">' + escapeHtml(directive[3]) + '</span>';
    }
    return '<span class="tok-comment">' + escapeHtml(line) + '</span>';
  }
  let html = escapeHtml(line);
  html = html.replace(/^(\s*)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT|GRAPHQL|GRPC|WEBSOCKET)(\s)/, function (whole, pre, method, post) {
    return pre + '<span class="http-method">' + method + '</span>' + post;
  });
  html = html.replace(/^(\s*)(&lt;@?[\w-]*|&gt;&gt;!?|&gt;)(\s)/, function (whole, pre, marker, post) {
    return pre + '<span class="http-marker">' + marker + '</span>' + post;
  });
  html = html.replace(/\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g, function (whole, name) {
    const raw = name.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const value = httpVarValue(raw, scope, 0);
    const known = value !== undefined;
    const title = known ? String(value) : t('http.undefinedVariable');
    return '<span class="http-var ' + (known ? 'known' : 'unknown') + '" title="' + escapeHtml(title) + '">' + whole + '</span>';
  });
  return html;
}

function renderHttpFailure(target, message) {
  target.className = 'http-response error';
  target.innerHTML = '<div class="http-resp-head"><span class="http-status bad">'
    + escapeHtml(t('http.notSent')) + '</span></div>'
    + '<pre class="http-resp-body">' + escapeHtml(message) + '</pre>';
}

function httpScriptLogHtml(log) {
  if (!log) return '';
  let html = '';
  if (log.tests && log.tests.length) {
    const failed = log.tests.filter(function (entry) { return !entry.ok; }).length;
    html += '<div class="http-tests' + (failed ? ' has-failures' : '') + '">'
      + '<div class="http-tests-head">' + escapeHtml(
        failed
          ? t('http.testsFailed', { failed: failed, total: log.tests.length })
          : t('http.testsPassed', { total: log.tests.length }))
      + '</div>'
      + log.tests.map(function (entry) {
        return '<div class="http-test ' + (entry.ok ? 'ok' : 'bad') + '">'
          + '<span class="http-test-mark">' + (entry.ok ? '&#10003;' : '&#10007;') + '</span>'
          + '<span class="http-test-name">' + escapeHtml(entry.name) + '</span>'
          + (entry.error ? '<span class="http-test-error">' + escapeHtml(entry.error) + '</span>' : '')
          + '</div>';
      }).join('')
      + '</div>';
  }
  if (log.lines && log.lines.length) {
    html += '<pre class="http-script-log">' + escapeHtml(log.lines.join('\n')) + '</pre>';
  }
  if (log.error) {
    html += '<div class="http-script-error">' + escapeHtml(t('http.handlerFailed').replace('{error}', log.error)) + '</div>';
  }
  return html;
}

function renderHttpResponse(target, result, extra) {
  const log = extra && extra.log;
  const saved = extra && extra.saved;
  if (!result || !result.ok) {
    target.className = 'http-response error';
    const message = result && result.error ? result.error : 'Request failed';
    target.innerHTML = '<div class="http-resp-head"><span class="http-status bad">Failed</span></div>'
      + '<pre class="http-resp-body">' + escapeHtml(message) + '</pre>' + httpScriptLogHtml(log);
    return;
  }
  target.className = 'http-response';
  const status = Number(result.status) || 0;
  const statusClass = status >= 200 && status < 300 ? 'ok' : (status >= 400 ? 'bad' : 'warn');
  const headers = result.headers || {};
  const headerKeys = Object.keys(headers).sort();
  const headerHtml = headerKeys.map(function (key) {
    return '<div class="http-h"><span class="http-h-k">' + escapeHtml(key) + '</span><span class="http-h-v">' + escapeHtml(String(headers[key])) + '</span></div>';
  }).join('');
  let contentType = '';
  for (let i = 0; i < headerKeys.length; i++) {
    if (headerKeys[i].toLowerCase() === 'content-type') { contentType = String(headers[headerKeys[i]]); break; }
  }
  const bodyText = result.body == null ? '' : String(result.body);
  const size = Number(result.bytes) || bodyText.length;
  const bodyHtml = result.bodyBase64
    ? renderHttpBinaryBody(result, contentType)
    : formatHttpBody(bodyText, contentType);
  const meta = [];
  if (result.redirects && result.redirects.length) {
    meta.push('<span class="http-resp-meta" title="' + escapeHtml(result.redirects.join('\n')) + '">'
      + escapeHtml(t('http.redirects', { count: result.redirects.length })) + '</span>');
  }
  if (result.cookies && result.cookies.length) {
    meta.push('<span class="http-resp-meta">' + escapeHtml(t('http.cookies', { count: result.cookies.length })) + '</span>');
  }
  target.innerHTML =
    '<div class="http-resp-head">'
    + '<span class="http-status ' + statusClass + '">' + status + (result.statusText ? ' ' + escapeHtml(result.statusText) : '') + '</span>'
    + '<span class="http-resp-meta">' + (Number(result.durationMs) || 0) + ' ms</span>'
    + '<span class="http-resp-meta">' + formatBytes(size) + '</span>'
    + meta.join('')
    + (headerKeys.length ? '<button type="button" class="http-resp-toggle">Headers (' + headerKeys.length + ')</button>' : '')
    + '</div>'
    + '<div class="http-resp-headers hidden">' + headerHtml + '</div>'
    + (saved
      ? '<div class="http-saved' + (saved.ok ? '' : ' bad') + '">' + escapeHtml(saved.ok
        ? t('http.savedTo').replace('{path}', saved.path)
        : t('http.saveFailed').replace('{error}', saved.error)) + '</div>'
      : '')
    + '<pre class="http-resp-body">' + bodyHtml + '</pre>'
    + httpScriptLogHtml(log);
}

function renderWebSocketTranscript(target, result) {
  const entries = (result && result.transcript) || [];
  target.className = 'http-response' + (result && result.ok ? '' : ' error');
  const head = '<div class="http-resp-head">'
    + '<span class="http-status ' + (result && result.ok ? 'ok' : 'bad') + '">'
    + escapeHtml(t(result && result.ok ? 'ws.closed' : 'http.notSent')) + '</span>'
    + '<span class="http-resp-meta">' + (Number(result && result.durationMs) || 0) + ' ms</span>'
    + '<span class="http-resp-meta">' + escapeHtml(t('ws.messages', { count: entries.filter(function (entry) {
      return entry.direction === 'in' || entry.direction === 'out';
    }).length })) + '</span>'
    + '</div>';
  const rows = entries.map(function (entry) {
    const mark = entry.direction === 'out' ? '\u2191' : entry.direction === 'in' ? '\u2193' : '\u25cf';
    return '<div class="ws-line is-' + entry.direction + '">'
      + '<span class="ws-mark" aria-hidden="true">' + mark + '</span>'
      + '<span class="ws-at">' + (Number(entry.at) || 0) + 'ms</span>'
      + '<span class="ws-text">' + escapeHtml(String(entry.text || '')) + '</span>'
      + '</div>';
  }).join('');
  target.innerHTML = head
    + (result && result.error ? '<div class="http-script-error">' + escapeHtml(result.error) + '</div>' : '')
    + '<div class="ws-transcript">' + (rows || '<span class="http-resp-empty">' + escapeHtml(t('ws.nothing')) + '</span>') + '</div>';
}

function renderHttpRunSummary(target, path, outcomes) {
  const failed = outcomes.filter(function (outcome) { return !outcome.ok; }).length;
  target.className = 'http-response' + (failed ? ' error' : '');
  target.innerHTML = '<div class="http-resp-head">'
    + '<span class="http-status ' + (failed ? 'bad' : 'ok') + '">'
    + escapeHtml(failed
      ? t('http.ranAllWithFailures', { count: outcomes.length, failed: failed })
      : t('http.ranAll', { count: outcomes.length }))
    + '</span>'
    + '<span class="http-resp-meta">' + escapeHtml(path) + '</span>'
    + '</div>'
    + '<div class="http-run-list">' + outcomes.map(function (outcome) {
      return '<div class="http-run-row ' + (outcome.ok ? 'ok' : 'bad') + '">'
        + '<span class="http-run-mark" aria-hidden="true">' + (outcome.ok ? '&#10003;' : '&#10007;') + '</span>'
        + '<span class="http-run-name">' + escapeHtml(outcome.name) + '</span>'
        + '<span class="http-run-status">' + escapeHtml(outcome.status ? String(outcome.status) : '—') + '</span>'
        + '</div>';
    }).join('') + '</div>';
}

function renderHttpBinaryBody(result, contentType) {
  const mime = String(contentType || '').split(';')[0].trim();
  if (/^image\//i.test(mime)) {
    return '<img class="http-resp-image" alt="" src="data:' + escapeHtml(mime) + ';base64,' + escapeHtml(result.bodyBase64) + '">';
  }
  return '<span class="http-resp-empty">' + escapeHtml(
    t('http.binaryBody').replace('{type}', mime || 'application/octet-stream')
      .replace('{size}', formatBytes(Number(result.bytes) || 0))) + '</span>';
}

function formatHttpBody(text, contentType) {
  if (!text) return '<span class="http-resp-empty">(empty body)</span>';
  const looksJson = /json/i.test(contentType) || /^[\[{]/.test(text.trim());
  if (looksJson) {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      return pretty.split(/\r?\n/).map(function (line) { return highlightLine(line, 'json'); }).join('\n');
    } catch (error) {}
  }
  if (/xml|html/i.test(contentType) || /^\s*<[?!a-zA-Z]/.test(text)) {
    return text.split(/\r?\n/).map(function (line) { return highlightLine(line, 'markup'); }).join('\n');
  }
  return escapeHtml(text);
}

function populateHttpEnvSelect() {
  const select = document.getElementById('http-env-select');
  if (!select) return;
  let opts = '<option value="">No environment</option>';
  httpEnvNames.forEach(function (name) {
    opts += '<option value="' + escapeHtml(name) + '"' + (name === currentHttpEnvName ? ' selected' : '') + '>' + escapeHtml(name) + '</option>';
  });
  select.innerHTML = opts;
  if (!select.dataset.wired) {
    select.dataset.wired = '1';
    select.addEventListener('change', function () {
      currentHttpEnvName = select.value;
      persistSave(httpEnvKey, currentHttpEnvName);
      const path = sourceOpenPath();
      if (path && isHttpFile(path)) {
        const file = sourceByPath.get(path);
        const body = document.getElementById('source-body');
        if (file && body) body.innerHTML = renderHttpTable(file);
      }
    });
  }
}

function sourceProgressiveLimits() {
  return {
    minRows: 600,
    windowRows: 400,
    chunkRows: 2000,
  };
}
function codeInsightMaxBytes() {
  return 2500 * 1024;
}
var sourceFill;
var sourceFillTimer;
var sourceRowModel;

function sourceRowSpacerHtml(fromRow, toRow, height) {
  return '<tr class="source-spacer" aria-hidden="true" data-spacer-from="' + fromRow + '" data-spacer-to="' + toRow
    + '" style="height:' + height + 'px"><td colspan="2"></td></tr>';
}

function expandSourceSpacer(spacer, limit) {
  if (!sourceFill || !spacer) return false;
  const from = Number(spacer.dataset.spacerFrom);
  const to = Number(spacer.dataset.spacerTo);
  if (!(to > from)) { spacer.remove(); return false; }
  const leading = spacer.nextElementSibling && spacer.nextElementSibling.classList.contains('source-row');
  const count = limit > 0 ? Math.min(limit, to - from) : to - from;
  const start = leading ? to - count : from;
  const end = start + count;
  const html = sourceFill.build(start, end);
  const rest = leading ? [from, start] : [end, to];
  const frag = document.createElement('tbody');
  frag.innerHTML = html;
  const rows = Array.prototype.slice.call(frag.children);
  const parent = spacer.parentNode;
  if (!parent) return false;
  rows.forEach(function (row) { parent.insertBefore(row, spacer); });
  if (rest[1] > rest[0]) {
    spacer.dataset.spacerFrom = String(rest[0]);
    spacer.dataset.spacerTo = String(rest[1]);
    spacer.style.height = ((rest[1] - rest[0]) * (sourceRowHeight() || 18)) + 'px';
    if (leading) parent.insertBefore(spacer, rows[0]);
  } else {
    spacer.remove();
  }
  return true;
}

function flushSourceRows() {
  const body = document.getElementById('source-body');
  if (!sourceFill || !body) return;
  let spacer;
  let guard = 0;
  while ((spacer = body.querySelector('.source-spacer')) && guard++ < 500) expandSourceSpacer(spacer, 0);
  const filled = sourceFill.path;
  sourceFill = undefined;
  sourceRowsCompleted(filled);
}

function sourceRowsCompleted(path) {
  if (!path || sourceOpenPath() !== path) return;
  try { renderSourceComments(); } catch (e) {}
  try { refreshSourceBlamePaint(path); } catch (e) {}
  try { refreshSourceDiagnostics(path); } catch (e) {}
  try { paintSourceDecorations(); } catch (e) {}
  try { scheduleFileFindHighlights(); } catch (e) {}
  try { paintUsageHighlights(); } catch (e) {}
}

function nearbySourceSpacer(body) {
  const spacers = body.querySelectorAll('.source-spacer');
  if (!spacers.length) return null;
  const view = body.getBoundingClientRect();
  const margin = (body.clientHeight || 0) * 2;
  for (let i = 0; i < spacers.length; i++) {
    const rect = spacers[i].getBoundingClientRect();
    if (rect.top <= view.bottom + margin && rect.bottom >= view.top - margin) return spacers[i];
  }
  return null;
}

function scheduleSourceFill() {
  if (sourceFillTimer || !sourceFill) return;
  sourceFillTimer = setTimeout(function () {
    sourceFillTimer = undefined;
    const body = document.getElementById('source-body');
    if (!sourceFill || !body) return;
    const spacer = nearbySourceSpacer(body);
    if (spacer) {
      expandSourceSpacer(spacer, sourceProgressiveLimits().chunkRows);
      scheduleSourceFill();
      return;
    }
    const filled = sourceFill.path;
    if (!body.querySelector('.source-spacer')) sourceFill = undefined;
    sourceRowsCompleted(filled);
  }, 16);
}
document.getElementById('source-body')?.addEventListener('scroll', scheduleSourceFill, { passive: true });

function sourceLineHtml(line, byLine, index, language) {
  var tokens = byLine ? byLine.get(index) : null;
  if (tokens && tokens.length) return semanticLineHtml(line, tokens);
  return highlightLine(line, language);
}

/**
 * One line's code cell — and a blank line gets a `<br>` rather than nothing at all.
 *
 * A `<td>` holding no content whatsoever is dropped WHOLE by Chromium's table-to-text serializer: not
 * emptied, removed, taking its row separator with it. `.num` is `user-select: none`, so a blank line's
 * row has no selectable text anywhere and every blank line fell out of the copy. Measured in the real
 * app on `src/analysis.ts`: 1761 lines selected, 1691 on the clipboard, and the 70 missing were exactly
 * its 70 blank lines — so a copied function came back with its paragraphs run together.
 *
 * It also reached the Cmd+K citation, which is worse than losing whitespace: `cleanSelectedSourceText`
 * pairs the serializer's lines with the selected ROWS by index, and on the mismatch (1692 lines against
 * 1762 rows) it gives up and returns the text unpaired. So a citation went out reading
 * `src/analysis.ts:81-83` with two lines under it — a line range that does not hold what it claims.
 *
 * The diff view never had this: diff2html writes `<span class="d2h-code-line-ctn"><br></span>` for its
 * own blank lines. The answer was already in the app, one view over.
 *
 * `hasRowBelow` is false for the table's last row only, and there the `<br>` is left off. Everywhere else
 * the break Chromium emits for it IS the separator before the next row; on the final row there is no next
 * row to separate from, so it emits a newline of its own and a whole-file copy of a file ending in a
 * newline came back one line longer than the file. Measured all four positions — blank first, middle,
 * last, and the file's own final rows — and this is the only one that differed.
 */
function sourceCodeCellHtml(inner, hasRowBelow) {
  return '<td class="source-code">' + (inner || (hasRowBelow ? '<br>' : '')) + '</td>';
}

function renderSourceTable(file, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  const renderLanguage = file.language || 'text';
  const lineLanguages = renderLanguage === 'markup' ? markupBlockLanguages(lines) : null;
  const languageAt = (index) => (lineLanguages ? lineLanguages[index] : renderLanguage);
  const semanticByLine = renderLanguage === 'text' || file.size > codeInsightMaxBytes()
    ? null
    : semanticTokensFor(file.path);
  const cursor = viewerCursor && viewerCursor.path === file.path ? viewerCursor : null;
  const changedSet = new Set(file.changedLines || []);
  const bookmarkedLines = bookmarkLinesFor(file.path);
  const folds = normalizedQuery ? [] : sourceFoldRanges(file);
  const foldAt = new Map(folds.map((fold) => [fold.start, fold]));

  const rowStarts = [];
  for (let index = 0; index < lines.length; index += 1) {
    rowStarts.push(index);
    const fold = foldAt.get(index);
    if (fold) index = fold.end;
  }

  const rowHtml = (index) => {
    const line = lines[index];
    const fold = foldAt.get(index);
    const hit = normalizedQuery.length > 0 && line.toLowerCase().includes(normalizedQuery);
    const isCursorLine = Boolean(cursor && cursor.lineIndex === index);
    const isSymbolTarget = Boolean(cursor && cursor.targetLine === index);
    const isChanged = changedSet.has(index + 1);
    const classes = [
      'source-row',
      fold?.kind === 'imports' ? 'source-fold-row' : '',
      fold?.kind === 'block' ? 'source-block-folded' : '',
      hit ? 'search-hit' : '',
      isChanged ? 'changed-line' : '',
      isCursorLine ? 'cursor-line' : '',
      isSymbolTarget ? 'symbol-target' : '',
      bookmarkedLines.has(index) ? 'bookmarked' : '',
    ].filter(Boolean).join(' ');
    if (fold?.kind === 'imports') {
      const count = fold.end - fold.start + 1;
      return [
        '<tr class="' + classes + '" data-line-index="' + index + '" data-fold-end="' + fold.end + '">',
        '<td class="num">' + String(index + 1) + (fold.end > index ? '–' + String(fold.end + 1) : '') + '</td>',
        '<td class="source-code">' + sourceFoldButtonHtml('imports', count, index, fold.end) + '</td>',
        '</tr>',
      ].join('');
    }
    const foldButton = fold?.kind === 'block'
      ? sourceFoldButtonHtml('block', fold.end - fold.start, fold.start, fold.end)
      : '';
    const mnemonic = bookmarkedLines.has(index) ? bookmarkMnemonicAt(file.path, index) : '';
    return [
      '<tr class="' + classes + '" data-line-index="' + index + '"'
        + (mnemonic ? ' data-bookmark-mnemonic="' + escapeHtml(mnemonic) + '"'
          + ' style="--bookmark-mark: \'' + escapeHtml(mnemonic) + '\'"' : '') + '>',
      '<td class="num">' + String(index + 1) + '</td>',
      sourceCodeCellHtml(markWhitespaceRuns(sourceLineHtml(line, semanticByLine, index, languageAt(index))) + foldButton, index < lines.length - 1),
      '</tr>',
    ].join('');
  };
  const build = (fromRow, toRow) => {
    let out = '';
    for (let row = Math.max(0, fromRow); row < Math.min(rowStarts.length, toRow); row += 1) {
      out += rowHtml(rowStarts[row]);
    }
    return out;
  };

  const limits = sourceProgressiveLimits();
  sourceFill = undefined;
  sourceRowModel = { path: file.path, rowStarts: rowStarts };
  if (normalizedQuery || rowStarts.length < limits.minRows) {
    return '<table class="source-table"><tbody>' + build(0, rowStarts.length) + '</tbody></table>';
  }

  let cursorRow = 0;
  if (cursor) {
    let lo = 0;
    let hi = rowStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rowStarts[mid] <= cursor.lineIndex) lo = mid; else hi = mid - 1;
    }
    cursorRow = lo;
  }
  const half = Math.floor(limits.windowRows / 2);
  const windowStart = Math.max(0, Math.min(cursorRow - half, rowStarts.length - limits.windowRows));
  const windowEnd = Math.min(rowStarts.length, windowStart + limits.windowRows);
  const rowPx = sourceRowHeight() || 18;
  let html = '';
  if (windowStart > 0) html += sourceRowSpacerHtml(0, windowStart, windowStart * rowPx);
  html += build(windowStart, windowEnd);
  if (windowEnd < rowStarts.length) {
    html += sourceRowSpacerHtml(windowEnd, rowStarts.length, (rowStarts.length - windowEnd) * rowPx);
  }
  sourceFill = { path: file.path, rowStarts: rowStarts, build: build };
  scheduleSourceFill();
  return '<table class="source-table"><tbody>' + html + '</tbody></table>';
}

function markupBlockLanguages(lines) {
  var out = new Array(lines.length);
  var mode = 'markup';
  for (var i = 0; i < lines.length; i += 1) {
    var text = lines[i];
    var opener = /<\s*(script|style)\b([^>]*)>/i.exec(text);
    if (opener && !/\/\s*>\s*$/.test(opener[0])) {
      out[i] = 'markup';
      mode = opener[1].toLowerCase() === 'style' ? 'css' : 'typescript';
      continue;
    }
    if (/<\s*\/\s*(script|style)\s*>/i.test(text)) { out[i] = 'markup'; mode = 'markup'; continue; }
    out[i] = mode;
  }
  return out;
}

var TOKEN_SETS = null;
function tokenSets() {
  if (TOKEN_SETS) return TOKEN_SETS;
  var base = new Set(['as','async','await','break','case','catch','class','const','continue','def','default','defer','do','else','enum','export','extends','final','finally','fn','for','from','func','function','go','if','impl','import','in','interface','let','match','module','new','package','private','protected','public','return','select','static','struct','switch','throw','try','type','val','var','while','yield']);
  var literals = new Set(['False','None','True','false','nil','null','self','this','true','undefined']);
  var kotlin = new Set(Array.from(base).filter(function (word) { return word !== 'type' && word !== 'let'; }).concat([
    'abstract','actual','annotation','by','companion','constructor','crossinline','data','expect','external',
    'fun','infix','init','inline','inner','internal','is','lateinit','noinline','object','open','operator',
    'out','override','reified','sealed','suspend','tailrec','typealias','vararg','when','where'
  ]));
  TOKEN_SETS = { base: base, literals: literals, kotlin: kotlin };
  return TOKEN_SETS;
}

function yamlConstantWord(word) {
  return /^(?:true|false|null|yes|no|on|off)$/i.test(word);
}

function highlightYamlValue(text) {
  var out = '';
  var run = '';
  var index = 0;
  var flush = function () {
    if (!run) return;
    var parts = run.match(/^(\s*)([\s\S]*?)(\s*)$/);
    out += parts[1] + (parts[2] ? '<span class="tok-string">' + escapeHtml(parts[2]) + '</span>' : '') + parts[3];
    run = '';
  };
  var atBoundary = function () {
    return index === 0 || /[\s,[\]{}]/.test(text.charAt(index - 1));
  };
  while (index < text.length) {
    var rest = text.slice(index);
    var char = rest.charAt(0);
    // YAML only starts a comment at a `#` that follows whitespace — `a#b` is the scalar "a#b".
    if (char === '#' && (index === 0 || /\s/.test(text.charAt(index - 1)))) {
      flush();
      out += '<span class="tok-comment">' + escapeHtml(rest) + '</span>';
      return out;
    }
    if (char === '"' || char === "'") {
      var quoted = rest.match(char === '"' ? /^"(?:[^"\\]|\\.)*"?/ : /^'(?:[^']|'')*'?/);
      flush();
      out += '<span class="tok-string">' + escapeHtml(quoted[0]) + '</span>';
      index += quoted[0].length;
      continue;
    }
    if ((char === '&' || char === '*') && atBoundary()) {
      var named = rest.match(/^[&*][^\s,\]}]+/);
      if (named) {
        flush();
        out += '<span class="' + (char === '&' ? 'tok-anchor' : 'tok-alias') + '">' + escapeHtml(named[0]) + '</span>';
        index += named[0].length;
        continue;
      }
    }
    if (char === '!' && atBoundary()) {
      var tag = rest.match(/^!{1,2}[^\s]*/);
      if (tag) { flush(); out += escapeHtml(tag[0]); index += tag[0].length; continue; }
    }
    if ((char === '|' || char === '>') && atBoundary()) {
      var block = rest.match(/^[|>][-+]?\d*(?=\s|$)/);
      if (block) {
        flush();
        out += '<span class="tok-keyword">' + escapeHtml(block[0]) + '</span>';
        index += block[0].length;
        continue;
      }
    }
    if (atBoundary()) {
      var number = rest.match(/^-?\d+(?:\.\d+)?(?![\w.-])/);
      if (number) {
        flush();
        out += '<span class="tok-number">' + escapeHtml(number[0]) + '</span>';
        index += number[0].length;
        continue;
      }
      var word = rest.match(/^[A-Za-z~][\w.-]*(?![^\s,[\]{}])/);
      if (word && yamlConstantWord(word[0])) {
        flush();
        out += '<span class="tok-literal">' + escapeHtml(word[0]) + '</span>';
        index += word[0].length;
        continue;
      }
      if (char === '~' ) {
        flush();
        out += '<span class="tok-literal">~</span>';
        index += 1;
        continue;
      }
    }
    if (char === '[' || char === ']' || char === '{' || char === '}' || char === ',') {
      flush();
      out += escapeHtml(char);
      index += 1;
      continue;
    }
    run += char;
    index += 1;
  }
  flush();
  return out;
}

function highlightYamlLine(text) {
  var line = String(text);
  var indent = line.match(/^\s*/)[0];
  var out = indent;
  var rest = line.slice(indent.length);
  if (!rest) return escapeHtml(line);
  if (rest.charAt(0) === '#') return out + '<span class="tok-comment">' + escapeHtml(rest) + '</span>';
  if (/^(?:---|\.\.\.)(?:\s|$)/.test(rest)) {
    return out + '<span class="tok-keyword">' + rest.slice(0, 3) + '</span>' + highlightYamlValue(rest.slice(3));
  }
  var bullet = null;
  while ((bullet = rest.match(/^-(\s+|$)/))) {
    out += '<span class="tok-keyword">-</span>' + bullet[1];
    rest = rest.slice(bullet[0].length);
  }
  if (!rest) return out;
  if (rest.charAt(0) === '#') return out + '<span class="tok-comment">' + escapeHtml(rest) + '</span>';
  var key = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#"'][^:#]*?)(\s*):(\s|$)/);
  if (key) {
    out += '<span class="tok-type">' + escapeHtml(key[1]) + '</span>' + key[2] + '<span class="tok-keyword">:</span>';
    return out + highlightYamlValue(rest.slice(key[1].length + key[2].length + 1));
  }
  return out + highlightYamlValue(rest);
}

var lineCommentCache = null;
function lineCommentPrefixes(language) {
  if (!lineCommentCache) lineCommentCache = {
    python: ['#'], ruby: ['#'], bash: ['#'], yaml: ['#'], toml: ['#'],
    perl: ['#'], r: ['#'], julia: ['#'], elixir: ['#'], powershell: ['#'],
    makefile: ['#'], dockerfile: ['#'], ini: ['#', ';'], gherkin: ['#'], nginx: ['#'],
    graphql: ['#'],
    http: ['#', '//'],
    lua: ['--'], haskell: ['--'], vhdl: ['--'], sql: ['--'],
    erlang: ['%'], latex: ['%'],
    clojure: [';'],
  };
  return lineCommentCache[language] || ['//'];
}

function highlightLine(text, language) {
  if (language === 'text') return escapeHtml(text);
  if (language === 'css') {
    var commentAt = text.indexOf('/*');
    if (commentAt >= 0) {
      return highlightLine(text.slice(0, commentAt), 'css')
        + '<span class="tok-comment">' + escapeHtml(text.slice(commentAt)) + '</span>';
    }
    var braceAt = text.indexOf('{');
    var head = braceAt >= 0 ? text.slice(0, braceAt) : '';
    var body = braceAt >= 0 ? text.slice(braceAt) : text;
    var out = '';
    var selector = head.match(/^(\s*)(.*?)(\s*)$/);
    out += selector && selector[2]
      ? selector[1] + '<span class="tok-tag">' + escapeHtml(selector[2]) + '</span>' + selector[3]
      : escapeHtml(head);
    out += escapeHtml(body).replace(/([-\w]+)(\s*:)/g, '<span class="tok-type">$1</span>$2');
    return out;
  }
  if (language === 'markup') {
    return escapeHtml(text).replace(/(&lt;\/?)([\w:-]+)([^&]*?)(\/?&gt;)/g, '$1<span class="tok-tag">$2</span>$3$4');
  }
  if (language === 'yaml') return highlightYamlLine(text);
  if (language === 'markdown') {
    const escaped = escapeHtml(text);
    if (/^\s{0,3}#{1,6}\s/.test(text)) return '<span class="tok-keyword">' + escaped + '</span>';
    return escaped.replace(new RegExp(String.fromCharCode(96) + '[^' + String.fromCharCode(96) + ']+' + String.fromCharCode(96), 'g'), '<span class="tok-string">$&</span>');
  }
  const sets = tokenSets();
  const keywords = language === 'kotlin' ? sets.kotlin : sets.base;
  const commentPrefixes = lineCommentPrefixes(language);
  let output = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const commentPrefix = commentPrefixes.find((prefix) => rest.startsWith(prefix));
    if (commentPrefix) {
      output += '<span class="tok-comment">' + escapeHtml(rest) + '</span>';
      break;
    }
    const char = text[index];
    if (char === '"' || char === "'" || char === String.fromCharCode(96)) {
      const quote = char;
      let end = index + 1;
      let escaped = false;
      while (end < text.length) {
        const currentChar = text[end];
        if (currentChar === quote && !escaped) {
          end += 1;
          break;
        }
        escaped = currentChar === '\\' && !escaped;
        if (currentChar !== '\\') escaped = false;
        end += 1;
      }
      output += '<span class="tok-string">' + escapeHtml(text.slice(index, end)) + '</span>';
      index = end;
      continue;
    }
    if (char === '@') {
      const decorator = rest.match(/^@[A-Za-z_$][\w$.]*/);
      if (decorator) {
        output += '<span class="tok-decorator">' + escapeHtml(decorator[0]) + '</span>';
        index += decorator[0].length;
        continue;
      }
    }
    const number = rest.match(/^\b\d+(?:\.\d+)?\b/);
    if (number) {
      output += '<span class="tok-number">' + escapeHtml(number[0]) + '</span>';
      index += number[0].length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_$][\w$-]*/);
    if (identifier) {
      const value = identifier[0];
      const trailing = text.slice(index + value.length);
      if (keywords.has(value)) output += '<span class="tok-keyword">' + escapeHtml(value) + '</span>';
      else if (sets.literals.has(value)) output += '<span class="tok-literal">' + escapeHtml(value) + '</span>';
      else if (/^\s*\(/.test(trailing)) output += '<span class="tok-function">' + escapeHtml(value) + '</span>';
      else if (/^[A-Z][A-Z0-9_$]+$/.test(value)) output += '<span class="tok-constant">' + escapeHtml(value) + '</span>';
      else if (/^[A-Z]/.test(value) && /[a-z]/.test(value)) output += '<span class="tok-type">' + escapeHtml(value) + '</span>';
      else output += escapeHtml(value);
      index += value.length;
      continue;
    }
    output += escapeHtml(char);
    index += 1;
  }
  return output;
}

var diffHttpSlot = 0;
function diffHttpPath(wrapper) {
  if (!wrapper) return '';
  var path = diffWrapperPathKey(wrapper);
  return isHttpFile(path) ? path : '';
}
var diffHttpPending = Object.create(null);
function decorateDiffHttpRuns(wrapper) {
  var path = diffHttpPath(wrapper);
  if (!path) return;
  var file = sourceByPath.get(path);
  if (!file) return;
  if (!sourceContentLoaded(file)) {
    if (diffHttpPending[path]) return;
    diffHttpPending[path] = true;
    loadSourceFile(path).then(function () {
      delete diffHttpPending[path];
      var again = diffWrapperByPath(path);
      if (again) decorateDiffHttpRuns(again);
    }).catch(function () { delete diffHttpPending[path]; });
    return;
  }
  var parsed = parseHttpRequests(file.content);
  httpRequestsByPath.set(path, parsed.requests);
  httpVarsByPath.set(path, parsed.vars);
  httpImportsByPath.set(path, parsed.imports);
  var side = diffSideTable(wrapper, 'new');
  if (!side) return;
  var startLine = {};
  parsed.requests.forEach(function (req, idx) { if (req.startLine >= 0) startLine[req.startLine + 1] = idx; });

  var surface = wrapper.querySelector('.d2h-files-diff');
  if (!surface) return;
  var layer = surface.querySelector(':scope > .mc-http-runs');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'mc-http-runs';
    surface.appendChild(layer);
  }
  layer.textContent = '';
  var base = surface.getBoundingClientRect();
  diffRowsOf(side).forEach(function (row) {
    var line = diffLineNumber(row);
    if (line == null || !Object.prototype.hasOwnProperty.call(startLine, line)) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'http-run http-run-diff';
    button.dataset.req = String(startLine[line]);
    button.dataset.side = side === diffSideTable(wrapper, 'new') ? 'new' : 'old';
    button.dataset.line = String(line);
    button.dataset.httpPath = path;
    button.setAttribute('data-keyhint-id', 'runHttp');
    button.setAttribute('data-i18n-title', 'http.run');
    button.title = t('http.run') || 'Run request';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = '&#9654;';
    layer.appendChild(button);
    var box = row.getBoundingClientRect();
    if (!box.height) return;
    var code = row.querySelector('.d2h-code-line-ctn');
    var codeBox = code ? code.getBoundingClientRect() : box;
    button.style.top = Math.round(box.top - base.top) + 'px';
    button.style.left = Math.round(codeBox.left - base.left - 19) + 'px';
  });
}
function diffHttpResponseTarget(wrapper, reqIndex) {
  var side = diffSideTable(wrapper, 'new');
  var other = diffSideTable(wrapper, 'old');
  if (!side || !other) return null;
  var existing = wrapper.querySelector('.mc-http-row[data-http-req="' + reqIndex + '"] .http-response');
  if (existing) return existing;
  var requests = httpRequestsByPath.get(diffHttpPath(wrapper)) || [];
  var req = requests[reqIndex];
  if (!req) return null;
  var rows = diffRowsOf(side);
  var anchorIndex = -1;
  for (var i = 0; i < rows.length; i++) {
    var line = diffLineNumber(rows[i]);
    if (line != null && line <= req.endLine + 1) anchorIndex = i;
  }
  if (anchorIndex < 0) return null;
  var anchor = rows[anchorIndex];
  var peer = diffRowsOf(other)[anchorIndex];
  if (!anchor || !peer) return null;
  var slot = String(++diffHttpSlot);

  var tr = document.createElement('tr');
  tr.className = 'mc-comment-row mc-http-row';
  tr.dataset.commentSlot = slot;
  tr.dataset.httpReq = String(reqIndex);
  var td = document.createElement('td');
  td.colSpan = 2;
  var box = document.createElement('div');
  box.className = 'http-response';
  td.appendChild(box);
  tr.appendChild(td);
  anchor.parentNode.insertBefore(tr, anchor.nextSibling);

  var spacer = document.createElement('tr');
  spacer.className = 'mc-spacer-row mc-comment-spacer-row';
  spacer.dataset.commentSlot = slot;
  spacer.setAttribute('aria-hidden', 'true');
  var spacerCell = document.createElement('td');
  spacerCell.colSpan = 2;
  var filler = document.createElement('div');
  filler.className = 'mc-comment-spacer';
  spacerCell.appendChild(filler);
  spacer.appendChild(spacerCell);
  peer.parentNode.insertBefore(spacer, peer.nextSibling);

  invalidateDiffRows(wrapper);
  return box;
}
function runDiffHttpRequest(button) {
  var wrapper = button.closest ? button.closest('.d2h-file-wrapper') : null;
  var path = button.dataset.httpPath || diffHttpPath(wrapper);
  var reqIndex = parseInt(button.dataset.req, 10);
  if (!wrapper || !path || !(reqIndex >= 0)) return false;
  var target = diffHttpResponseTarget(wrapper, reqIndex);
  runHttpRequest(reqIndex, path, target);
  afterDiffHttpResponse(wrapper, target);
  return true;
}
function afterDiffHttpResponse(wrapper, target) {
  var settle = function () {
    syncDiffCommentSpacerHeights(wrapper);
    decorateDiffHttpRuns(wrapper);
  };
  requestAnimationFrame(settle);
  if (!target || typeof ResizeObserver !== 'function') { setTimeout(settle, 400); return; }
  if (target.__kakapoHttpObserver) return;
  var observer = new ResizeObserver(function () { settle(); });
  observer.observe(target);
  target.__kakapoHttpObserver = observer;
}
function runDiffHttpAtCaret() {
  if (typeof diffCursor === 'undefined' || !diffCursor) return false;
  var wrapper = diffWrapperByPath(diffCursor.path);
  var path = diffHttpPath(wrapper);
  if (!path) return false;
  decorateDiffHttpRuns(wrapper);
  var requests = httpRequestsByPath.get(path) || [];
  if (!requests.length) return false;
  var row = diffRowAt(wrapper, diffCursor.side, diffCursor.rowIndex);
  var line = diffLineNumber(row);
  var caretLine = (line == null ? 1 : line) - 1;
  var chosen = -1;
  for (var i = 0; i < requests.length; i++) {
    var req = requests[i];
    var from = req.boundaryLine >= 0 ? req.boundaryLine : req.startLine;
    if (from <= caretLine && caretLine <= req.endLine) { chosen = i; break; }
    if (from <= caretLine) chosen = i;
  }
  if (chosen < 0) chosen = 0;
  var target = diffHttpResponseTarget(wrapper, chosen);
  runHttpRequest(chosen, path, target);
  afterDiffHttpResponse(wrapper, target);
  return true;
}
