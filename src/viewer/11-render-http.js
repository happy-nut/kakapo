function openSourceFile(path, shouldSwitch = true, options) {
  const file = sourceByPath.get(path);
  if (!file) return;
  const shouldScrollTree = !(options && options.scrollTree === false);
  if (shouldSwitch) flashReviewPanelFocus(document.getElementById('source-body'));
  // Switching to another file abandons any in-progress comment elsewhere; closeComposer() clears
  // composerState and (via refreshComments) drops body.mc-composing so no caret stays hidden.
  if (composerState && composerState.path !== path) closeComposer();
  addSourceTab(path);
  renderSourceTabs(path);
  // These three elements start as localized static placeholders, but once a file is open they contain
  // dynamic path/size/source DOM. Leaving data-i18n attached made every watch refresh's applyI18n() replace
  // the whole painted file with "Select a file…" before the async source repaint — the periodic full flash
  // and top-of-file cursor jump. They become static/localizable again when the final tab closes.
  ['source-title', 'source-meta', 'source-body'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.removeAttribute('data-i18n');
  });
  // Desktop lazy-loads only this file. The completion callback repaints only when it is still the
  // intended tab, preventing a slower earlier request from stealing focus after the user moves on.
  if (!sourceContentLoaded(file)) {
    sourceBodyPath = null; // body shows a loading placeholder, not this path's content yet
    document.getElementById('source-viewer').dataset.openPath = path;
    if (typeof refreshFileFindForActiveView === 'function') setTimeout(refreshFileFindForActiveView, 0);
    sourceLinks.forEach((link) => link.classList.toggle('active', link.dataset.sourceFile === path));
    renderBreadcrumb(document.getElementById('source-title'), path);
    setSourceTypeIcon(path);
    revealTreeFor(path, shouldScrollTree);
    var lb = document.getElementById('source-body');
    setPanelClassNamePreservingFocus(lb, 'source-body empty is-loading');
    lb.innerHTML = loadingStateHtml(t('source.loading'));
    updateRenderToggle(path);
    if (shouldSwitch) showSourceView();
    loadSourceFile(path).then(function () {
      var viewer = document.getElementById('source-viewer');
      if (viewer && viewer.dataset.openPath === path) openSourceFile(path, false, options);
    });
    return;
  }
  rememberRecent(path, 'source');
  sourceBodyPath = path; // past the lazy guard — every branch below paints THIS path's body (text/image/not-embedded)
  document.getElementById('source-viewer').dataset.openPath = path;
  if (typeof refreshFileFindForActiveView === 'function') setTimeout(refreshFileFindForActiveView, 0);
  sourceLinks.forEach((link) => link.classList.toggle('active', link.dataset.sourceFile === path));
  renderBreadcrumb(document.getElementById('source-title'), path);
  setSourceTypeIcon(path);
  revealTreeFor(path, shouldScrollTree);
  const meta = file.embedded
    ? formatBytes(file.size || 0)
    : formatBytes(file.size || 0) + ' · ' + (file.skippedReason || 'not embedded');
  document.getElementById('source-meta').textContent = meta;
  const body = document.getElementById('source-body');
  const httpEnvSelect = document.getElementById('http-env-select');
  // Code files have one Review surface. Keeping a second renderer made the same file appear to
  // have two subtly different modes, split search/comment behavior, and forced a full DOM/editor swap.
  // The line-addressable Review renderer now owns every source file, including large lazy-loaded files.
  // Image files carry a data: URI preview instead of text — render inline (click to zoom).
  if (file.image) {
    setPanelClassNamePreservingFocus(body, 'source-body image-body');
    body.innerHTML = renderImageView(file);
    document.getElementById('http-env-select')?.classList.add('hidden');
    updateRenderToggle(path);
    if (shouldSwitch) showSourceView();
    return;
  }
  if (!file.embedded) {
    setPanelClassNamePreservingFocus(body, 'source-body empty');
    body.textContent = file.skippedReason ? t('source.previewUnavailable').replace(/\.$/, '') + ': ' + file.skippedReason + '.' : t('source.previewUnavailable');
    document.getElementById('http-env-select')?.classList.add('hidden');
    updateRenderToggle(path);
    if (shouldSwitch) showSourceView();
    return;
  }
  if (!viewerCursor || viewerCursor.path !== path) {
    viewerCursor = { path, lineIndex: 0, column: 0, targetLine: -1 };
  }
  setPanelClassNamePreservingFocus(body, 'source-body');
  // Markdown/CSV render to HTML but stay a line-numbered .source-table: each block (md) or record (csv)
  // is a .source-row keyed by its start line, so the gutter shows line numbers and line/block comments
  // work exactly as in the plain source view (renderSourceComments anchors on .source-row[data-line-index]).
  if (isMarkdownPath(path)) {
    if (renderRawMode) {
      body.innerHTML = renderSourceTable(file, '');
    } else {
      body.classList.add('rendered-body');
      body.innerHTML = renderMarkdownRows(file.content);
    }
    if (httpEnvSelect) httpEnvSelect.classList.add('hidden');
    updateRenderToggle(path);
    renderSourceComments();
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
  if (shouldSwitch) showSourceView();
}

function isMarkdownPath(p) { return /\.(md|mdx|markdown)$/i.test(p || ''); }
function isCsvPath(p) { return /\.(csv|tsv)$/i.test(p || ''); }
function isRenderToggleable(p) { return isMarkdownPath(p) || isCsvPath(p); }

// Long code lines stay on one editor row by default. Line wrap is an explicit, persisted display choice
// shared by side-by-side Diff and raw source (including Raw Markdown/CSV), never rendered documents/images.
var lineWrapKey = 'kakapo-line-wrap';
var lineWrapEnabled = (function () {
  var saved = persistRead(lineWrapKey);
  if (saved == null) { try { saved = localStorage.getItem(lineWrapKey); } catch (e) {} }
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
  var wrapper = typeof diffActiveWrapper === 'function' ? diffActiveWrapper() : null;
  if (!wrapper) return;
  if (typeof invalidateAsymmetricDiffGeometry === 'function') invalidateAsymmetricDiffGeometry(wrapper);
  requestAnimationFrame(function () {
    if (typeof refreshLayeredDiffGutters === 'function') refreshLayeredDiffGutters(wrapper);
    if (typeof invalidateAsymmetricDiffGeometry === 'function') invalidateAsymmetricDiffGeometry(wrapper);
    if (typeof scrollAsymmetricDiff === 'function') scrollAsymmetricDiff();
    if (typeof diffCursor !== 'undefined' && diffCursor && diffCursor.path === (wrapper.dataset.path || '')
      && typeof scheduleDiffReveal === 'function') scheduleDiffReveal(wrapper, diffCursor.side, diffCursor.rowIndex);
    else if (typeof renderDiffCaret === 'function') renderDiffCaret();
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
  var viewer = document.getElementById('source-viewer');
  updateLineWrapToggle(viewer && viewer.dataset.openPath);
  updateDiffLineWrapToggle();
}
function toggleLineWrap() {
  if (!isSourceViewerVisible() && !(typeof isDiffViewVisible === 'function' && isDiffViewVisible())) return false;
  if (isSourceViewerVisible()) {
    var viewer = document.getElementById('source-viewer');
    var open = viewer && viewer.dataset.openPath;
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

// Markdown/CSV open rendered by default; this flips the open file to raw line-numbered text and back.
// Session-global so the choice carries across files. The toolbar button + Option+R both call it.
var renderRawMode = false;
function updateRenderToggle(path) {
  var btn = document.getElementById('render-toggle');
  var on = isRenderToggleable(path);
  if (btn) {
    btn.classList.toggle('hidden', !on);
    if (on) {
      btn.textContent = renderRawMode ? t('source.viewRendered') : t('source.viewRaw'); // label = the mode you switch TO
      btn.setAttribute('aria-pressed', renderRawMode ? 'true' : 'false');
    }
  }
  updateLineWrapToggle(path);
}
function toggleRenderMode() {
  var sv = document.getElementById('source-viewer');
  var open = sv && sv.dataset.openPath;
  if (!open || !isRenderToggleable(open)) return;
  renderRawMode = !renderRawMode;
  openSourceFile(open, false); // re-render the current file in the new mode
}
(function wireRenderToggle() {
  var btn = document.getElementById('render-toggle');
  if (btn) btn.addEventListener('click', function () { toggleRenderMode(); });
  var wrapBtn = document.getElementById('line-wrap-toggle');
  if (wrapBtn) wrapBtn.addEventListener('click', function () { toggleLineWrap(); });
  var diffWrapBtn = document.getElementById('diff-line-wrap-toggle');
  if (diffWrapBtn) diffWrapBtn.addEventListener('click', function () { toggleLineWrap(); });
  applyLineWrapState();
  if (lineWrapEnabled) refreshDiffLineWrapLayout();
  document.addEventListener('keydown', function (e) {
    if (isFloatingModalOpen()) return; // a floating overlay owns focus -> no render-toggle shortcut beneath it
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === 'R' || e.key === 'r' || e.code === 'KeyR')) {
      var sv = document.getElementById('source-viewer');
      var open = sv && sv.dataset.openPath;
      if (open && isRenderToggleable(open) && isSourceViewerVisible()) { e.preventDefault(); toggleRenderMode(); }
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === 'W' || e.key === 'w' || e.code === 'KeyW')) {
      if (toggleLineWrap()) e.preventDefault();
    }
  });
})();

function renderImageView(file) {
  return '<div class="image-view">'
    + '<img class="image-preview" src="' + file.image + '" alt="' + escapeHtml(file.name) + '" data-zoomable="1">'
    + '<div class="image-cap">' + escapeHtml(file.name) + ' &middot; ' + formatBytes(file.size || 0) + ' &middot; click to zoom</div>'
    + '</div>';
}

function openLightbox(src, alt) {
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

// One open-source Markdown engine is shared by source previews and merged prompts. The editable memo uses
// a lazy Tiptap surface but persists ordinary Markdown and shares the document typography below.
// markdown-it gives CommonMark-compatible parsing plus top-level token source maps; DOMPurify sanitizes the
// final HTML, including raw HTML blocks. Both audited browser bundles are prepended at build time.
var markdownEngine = null;
function markdownLanguage(lang) {
  var l = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (l === 'js' || l === 'jsx' || l === 'ts' || l === 'tsx') return 'typescript';
  if (l === 'sh' || l === 'bash' || l === 'zsh') return 'shell';
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
  var defaultLinkOpen = markdownEngine.renderer.rules.link_open || function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  markdownEngine.renderer.rules.link_open = function (tokens, idx, options, env, self) {
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

// Group markdown-it's top-level tokens into source-addressable blocks. A block retains the first source
// line for the gutter/comment anchor, while its HTML comes from the exact same renderer as merged prompts.
function renderMarkdownBlocks(content) {
  var md = getMarkdownEngine();
  var env = {};
  var tokens = md.parse(String(content || ''), env);
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
  return groups.map(function (item) {
    return {
      line: item.line,
      endLine: item.endLine,
      html: sanitizeMarkdown(md.renderer.render(item.tokens, md.options, env)),
    };
  });
}

function renderMarkdownRows(content) {
  var blocks = renderMarkdownBlocks(content);
  if (!blocks.length) return '<table class="source-table md-doc"><tbody></tbody></table>';
  var rows = blocks.map(function (b) {
    return '<tr class="source-row md-row" data-line-index="' + b.line + '" data-line-end="' + b.endLine + '"><td class="num">' + (b.line + 1) + '</td><td class="source-code md-cell markdown-body">' + b.html + '</td></tr>';
  }).join('');
  return '<table class="source-table md-doc"><tbody>' + rows + '</tbody></table>';
}

// RFC-4180-ish delimited parser: handles quoted fields with embedded delimiters, newlines, and "" escapes.
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

// CSV/TSV renders to an aligned table that is still a .source-table: each record is a .source-row keyed
// by its record index (data-line-index) so line numbers show in the gutter and comments anchor per row.
function renderCsvRows(content, path) {
  var delim = /\.tsv$/i.test(path || '') ? '\t' : ',';
  var records = parseDelimited(content, delim).filter(function (r) { return !(r.length === 1 && r[0] === ''); });
  if (!records.length) return '<table class="source-table csv-doc"><tbody></tbody></table>';
  var cols = records.reduce(function (max, r) { return Math.max(max, r.length); }, 0);
  var rows = records.map(function (rec, idx) {
    var head = idx === 0;
    var cells = '';
    for (var c = 0; c < cols; c++) {
      var v = escapeHtml(rec[c] == null ? '' : rec[c]);
      cells += head ? '<th class="csv-cell">' + v + '</th>' : '<td class="csv-cell">' + v + '</td>';
    }
    return '<tr class="source-row csv-row' + (head ? ' csv-head' : '') + '" data-line-index="' + idx + '"><td class="num">' + (idx + 1) + '</td>' + cells + '</tr>';
  }).join('');
  return '<table class="source-table csv-doc"><tbody>' + rows + '</tbody></table>';
}

function isHttpFile(path) {
  return /\.(http|rest)$/i.test(path || '');
}

function currentHttpEnv() {
  return httpEnvironments[currentHttpEnvName] || {};
}

function applyHttpVars(text, env) {
  return String(text == null ? '' : text).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, function (whole, name) {
    if (env && Object.prototype.hasOwnProperty.call(env, name)) return env[name];
    return whole;
  });
}

// Parses an IntelliJ-style .http file into a list of requests. Each request
// tracks the line of its request line (for the gutter Run button) and the line
// span it covers (for placing the inline response and for Cmd/Alt+Enter).
function parseHttpRequests(content) {
  const methods = { GET: 1, POST: 1, PUT: 1, PATCH: 1, DELETE: 1, HEAD: 1, OPTIONS: 1, TRACE: 1, CONNECT: 1 };
  const lines = String(content).split(/\r?\n/);
  const requests = [];
  const vars = {};
  let curr = null;
  let phase = 'pre';
  function flush() {
    if (curr && curr.url) {
      curr.body = curr.bodyLines.join('\n').replace(/\s+$/, '');
      requests.push(curr);
    }
  }
  function start(boundaryLine, name, index) {
    return { name: name, method: '', url: '', headers: [], bodyLines: [], startLine: -1, endLine: index, boundaryLine: boundaryLine };
  }
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (trimmed.indexOf('###') === 0) {
      flush();
      curr = start(i, trimmed.replace(/^#+/, '').trim(), i);
      phase = 'pre';
      continue;
    }
    if (!curr) {
      curr = start(-1, '', i);
      phase = 'pre';
    }
    curr.endLine = i;
    if (phase === 'pre') {
      if (trimmed === '') continue;
      if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) continue;
      const varMatch = /^@([\w.$-]+)\s*=\s*(.*)$/.exec(trimmed);
      if (varMatch) { vars[varMatch[1]] = varMatch[2].trim(); continue; }
      const sp = trimmed.indexOf(' ');
      const firstToken = sp >= 0 ? trimmed.slice(0, sp) : trimmed;
      if (sp >= 0 && methods[firstToken.toUpperCase()]) {
        curr.method = firstToken.toUpperCase();
        curr.url = trimmed.slice(sp + 1).replace(/\s+HTTP\/[\d.]+\s*$/i, '').trim();
      } else {
        curr.method = 'GET';
        curr.url = trimmed.replace(/\s+HTTP\/[\d.]+\s*$/i, '').trim();
      }
      curr.startLine = i;
      phase = 'headers';
      continue;
    }
    if (phase === 'headers') {
      if (trimmed === '') { phase = 'body'; continue; }
      if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) continue;
      const colon = rawLine.indexOf(':');
      if (colon > 0) curr.headers.push({ name: rawLine.slice(0, colon).trim(), value: rawLine.slice(colon + 1).trim() });
      continue;
    }
    curr.bodyLines.push(rawLine);
  }
  flush();
  return { requests: requests, vars: vars };
}

function renderHttpTable(file) {
  const parsed = parseHttpRequests(file.content);
  const requests = parsed.requests;
  httpRequestsByPath.set(file.path, requests);
  httpVarsByPath.set(file.path, parsed.vars);
  const env = Object.assign({}, parsed.vars, currentHttpEnv());
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
    const gutter = hasRun
      ? '<button type="button" class="http-run" data-keyhint="⌘↵" data-req="' + reqIdx + '" title="Run request (⌘Enter / ⌥Enter)" aria-label="Run request">&#9654;</button>'
      : '';
    rows += '<tr class="source-row http-row' + (hasRun ? ' http-request-line' : '') + (isCursorLine ? ' cursor-line' : '') + '" data-line-index="' + index + '">'
      + '<td class="num http-gutter">' + gutter + '<span class="num-text">' + (index + 1) + '</span></td>'
      + '<td class="source-code">' + (isCursorLine ? renderHttpLineWithCursor(line, env, cursor.column) : highlightHttpLine(line, env)) + '</td>'
      + '</tr>';
    if (Object.prototype.hasOwnProperty.call(respAfterLine, index)) {
      const rIdx = respAfterLine[index];
      rows += '<tr class="http-response-row"><td class="num"></td><td class="source-code"><div class="http-response hidden" id="http-resp-' + rIdx + '"></div></td></tr>';
    }
  });
  return '<table class="source-table http-table"><tbody>' + rows + '</tbody></table>';
}
function renderHttpLineWithCursor(text, env, column) {
  var col = Math.max(0, Math.min(column, text.length));
  return highlightHttpLine(text.slice(0, col), env) + '<span class="code-cursor" aria-hidden="true"></span>' + highlightHttpLine(text.slice(col), env);
}

function highlightHttpLine(line, env) {
  const trimmed = line.trim();
  if (trimmed.indexOf('###') === 0) return '<span class="http-sep">' + escapeHtml(line) + '</span>';
  if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) return '<span class="tok-comment">' + escapeHtml(line) + '</span>';
  let html = escapeHtml(line);
  html = html.replace(/^(\s*)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(\s)/, function (whole, pre, method, post) {
    return pre + '<span class="http-method">' + method + '</span>' + post;
  });
  html = html.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, function (whole, name) {
    const known = env && Object.prototype.hasOwnProperty.call(env, name);
    const title = known ? String(env[name]) : 'Undefined variable';
    return '<span class="http-var ' + (known ? 'known' : 'unknown') + '" title="' + escapeHtml(title) + '">' + escapeHtml(whole) + '</span>';
  });
  return html;
}

function sendHttp(request) {
  if (window.kakapoHttp && typeof window.kakapoHttp.send === 'function') {
    return Promise.resolve(window.kakapoHttp.send(request));
  }
  return fetch('/__http_send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }).then(function (response) { return response.json(); });
}

function runHttpRequest(reqIndex) {
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  const requests = httpRequestsByPath.get(path);
  if (!requests || !requests[reqIndex]) return;
  const req = requests[reqIndex];
  const env = Object.assign({}, httpVarsByPath.get(path) || {}, currentHttpEnv());
  const headers = {};
  req.headers.forEach(function (header) {
    const key = applyHttpVars(header.name, env);
    if (key) headers[key] = applyHttpVars(header.value, env);
  });
  const resolved = {
    method: req.method || 'GET',
    url: applyHttpVars(req.url, env),
    headers: headers,
    body: req.body ? applyHttpVars(req.body, env) : undefined,
  };
  const target = document.getElementById('http-resp-' + reqIndex);
  if (target) {
    target.className = 'http-response loading';
    target.innerHTML = kakapoLoaderHtml('kakapo-loader-inline') + '<span class="http-loading-copy">'
      + escapeHtml(resolved.method + ' ' + resolved.url) + '</span>';
  }
  sendHttp(resolved).then(function (result) {
    if (target) renderHttpResponse(target, result);
  }).catch(function (error) {
    if (target) {
      target.className = 'http-response error';
      target.innerHTML = '<div class="http-resp-head"><span class="http-status bad">Failed</span></div><pre class="http-resp-body">' + escapeHtml(String(error && error.message ? error.message : error)) + '</pre>';
    }
  });
}

function runHttpAtCaret() {
  const path = document.getElementById('source-viewer')?.dataset.openPath || '';
  const requests = httpRequestsByPath.get(path);
  if (!requests || !requests.length) return;
  const caretLine = viewerCursor && viewerCursor.path === path ? viewerCursor.lineIndex : 0;
  let chosen = -1;
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const from = req.boundaryLine >= 0 ? req.boundaryLine : req.startLine;
    if (from <= caretLine && caretLine <= req.endLine) { chosen = i; break; }
    if (from <= caretLine) chosen = i;
  }
  if (chosen < 0) chosen = 0;
  runHttpRequest(chosen);
}

function renderHttpResponse(target, result) {
  if (!result || !result.ok) {
    target.className = 'http-response error';
    const message = result && result.error ? result.error : 'Request failed';
    target.innerHTML = '<div class="http-resp-head"><span class="http-status bad">Failed</span></div><pre class="http-resp-body">' + escapeHtml(message) + '</pre>';
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
  const bodyHtml = formatHttpBody(bodyText, contentType);
  target.innerHTML =
    '<div class="http-resp-head">'
    + '<span class="http-status ' + statusClass + '">' + status + (result.statusText ? ' ' + escapeHtml(result.statusText) : '') + '</span>'
    + '<span class="http-resp-meta">' + (Number(result.durationMs) || 0) + ' ms</span>'
    + '<span class="http-resp-meta">' + formatBytes(bodyText.length) + '</span>'
    + (headerKeys.length ? '<button type="button" class="http-resp-toggle">Headers (' + headerKeys.length + ')</button>' : '')
    + '</div>'
    + '<div class="http-resp-headers hidden">' + headerHtml + '</div>'
    + '<pre class="http-resp-body">' + bodyHtml + '</pre>';
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
  // The <select> lives in the toolbar (not swapped on in-place diff updates), so wire the change handler
  // exactly once — populateHttpEnvSelect is re-called by applyDiffUpdate to refresh the options.
  if (!select.dataset.wired) {
    select.dataset.wired = '1';
    select.addEventListener('change', function () {
      currentHttpEnvName = select.value;
      persistSave(httpEnvKey, currentHttpEnvName);
      const path = document.getElementById('source-viewer')?.dataset.openPath || '';
      if (path && isHttpFile(path)) {
        const file = sourceByPath.get(path);
        const body = document.getElementById('source-body');
        if (file && body) body.innerHTML = renderHttpTable(file);
      }
    });
  }
}

function renderSourceTable(file, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  const cursor = viewerCursor && viewerCursor.path === file.path ? viewerCursor : null;
  const changedSet = new Set(file.changedLines || []);
  const folds = normalizedQuery ? [] : sourceFoldRanges(file);
  const foldAt = new Map(folds.map((fold) => [fold.start, fold]));
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
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
    ].filter(Boolean).join(' ');
    if (fold?.kind === 'imports') {
      const count = fold.end - fold.start + 1;
      rows.push([
        '<tr class="' + classes + '" data-line-index="' + index + '" data-fold-end="' + fold.end + '">',
        '<td class="num">' + String(index + 1) + (fold.end > index ? '–' + String(fold.end + 1) : '') + '</td>',
        '<td class="source-code">' + sourceFoldButtonHtml('imports', count, index, fold.end) + '</td>',
        '</tr>',
      ].join(''));
      index = fold.end;
      continue;
    }
    const foldButton = fold?.kind === 'block'
      ? sourceFoldButtonHtml('block', fold.end - fold.start, fold.start, fold.end)
      : '';
    rows.push([
      '<tr class="' + classes + '" data-line-index="' + index + '">',
      '<td class="num">' + String(index + 1) + '</td>',
      '<td class="source-code">' + highlightLine(line, file.language || 'text') + foldButton + '</td>',
      '</tr>',
    ].join(''));
    if (fold?.kind === 'block') index = fold.end;
  }
  return '<table class="source-table"><tbody>' + rows.join('') + '</tbody></table>';
}

function renderLineWithCursor(text, language, column) {
  const boundedColumn = Math.max(0, Math.min(column, text.length));
  const before = text.slice(0, boundedColumn);
  const after = text.slice(boundedColumn);
  return highlightLine(before, language) + '<span class="code-cursor" aria-hidden="true"></span>' + highlightLine(after, language);
}

function highlightLine(text, language) {
  if (language === 'text') return escapeHtml(text);
  if (language === 'markup') {
    return escapeHtml(text).replace(/(&lt;\/?)([\w:-]+)([^&]*?)(\/?&gt;)/g, '$1<span class="tok-tag">$2</span>$3$4');
  }
  if (language === 'markdown') {
    const escaped = escapeHtml(text);
    if (/^\s{0,3}#{1,6}\s/.test(text)) return '<span class="tok-keyword">' + escaped + '</span>';
    return escaped.replace(new RegExp(String.fromCharCode(96) + '[^' + String.fromCharCode(96) + ']+' + String.fromCharCode(96), 'g'), '<span class="tok-string">$&</span>');
  }
  const keywords = new Set(['as','async','await','break','case','catch','class','const','continue','def','default','defer','do','else','enum','export','extends','final','finally','fn','for','from','func','function','go','if','impl','import','in','interface','let','match','module','new','package','private','protected','public','return','select','static','struct','switch','throw','try','type','val','var','while','yield']);
  const literals = new Set(['False','None','True','false','nil','null','self','this','true','undefined']);
  const commentPrefixes = ['python','ruby','shell','yaml','toml'].includes(language) ? ['#'] : ['//'];
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
      else if (literals.has(value)) output += '<span class="tok-literal">' + escapeHtml(value) + '</span>';
      else if (/^\s*\(/.test(trailing)) output += '<span class="tok-function">' + escapeHtml(value) + '</span>';
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const kib = bytes / 1024;
  if (kib < 1024) return kib.toFixed(1) + ' KiB';
  return (kib / 1024).toFixed(1) + ' MiB';
}
