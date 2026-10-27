function openSourceFile(path, shouldSwitch = true, options) {
  const file = sourceByPath.get(path);
  // Not in the project index: this is either a library file a definition just pointed at, or nothing at all.
  // Ask main once; it answers only for a path a language server actually reported, or one inside the repo.
  if (!file) {
    loadLibrarySourceFile(path).then(function (record) {
      if (record) openSourceFile(path, shouldSwitch, options);
      else showCaretHint(t('source.libraryUnavailable').replace('{file}', sourceTabLabel(path)));
    });
    return;
  }
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
      var viewer = document.getElementById('source-viewer');
      if (viewer && viewer.dataset.openPath === path) openSourceFile(path, false, options);
    });
    return;
  }
  rememberRecent(path, 'source');
  sourceBodyPath = path; // past the lazy guard — every branch below paints THIS path's body (text/image/not-embedded)
  document.getElementById('source-viewer').dataset.openPath = path;
  setTimeout(refreshFileFindForActiveView, 0);
  sourceLinks.forEach((link) => link.classList.toggle('active', link.dataset.sourceFile === path));
  renderCommitContext(document.getElementById('source-commit-context'));
  renderBreadcrumb(document.getElementById('source-title'), path);
  setSourceTypeIcon(path);
  revealTreeFor(path, shouldScrollTree);
  const meta = (file.library ? t('source.library') + ' · ' : '')
    + (file.embedded
      ? formatBytes(file.size || 0)
      : formatBytes(file.size || 0) + ' · ' + (file.skippedReason || 'not embedded'));
  document.getElementById('source-meta').textContent = meta;
  const body = document.getElementById('source-body');
  const httpEnvSelect = document.getElementById('http-env-select');
  // Code files have one Review surface. Keeping a second renderer made the same file appear to
  // have two subtly different modes, split search/comment behavior, and forced a full DOM/editor swap.
  // The line-addressable Review renderer now owns every source file, including large lazy-loaded files.
  // Image and PDF files carry a data: URI preview instead of text — render inline (an image zooms on click;
  // a PDF gets Chromium's own viewer, which brings its scroll/zoom/search along for free).
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
  if (shouldSwitch) showSourceView();
}

function isMarkdownPath(p) { return /\.(md|mdx|markdown)$/i.test(p || ''); }
function isCsvPath(p) { return /\.(csv|tsv)$/i.test(p || ''); }
function isRenderToggleable(p) { return isMarkdownPath(p) || isCsvPath(p); }

// Long code lines stay on one editor row by default. Line wrap is an explicit, persisted display choice
// shared by side-by-side Diff and raw source (including Raw Markdown/CSV), never rendered documents/images.
var lineWrapKey = 'kakapo-line-wrap';
// ON unless the reviewer turned it off. Measured on a real four-file review at an ordinary window size:
// 95% of lines (36 of 38) reached past their pane, by up to 251px — a side-by-side pane is about 78
// characters wide, and this is a tool for reading code whose comments are prose. Off by default meant the
// normal case was "the end of almost every line is somewhere to the right", and the reader either scrolled
// horizontally to read a sentence or never saw it.
//
// Wrapping holds the two halves together: a wrapped line takes more rows on one side than the other, and
// the alignment connectors (01-diff-alignment.js) already draw that correspondence — checked on an
// asymmetric change. It also puts the vertical space to use, since the text was hiding sideways.
//
// An explicit choice still wins, in both directions: only an unset preference defaults to on.
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
  var viewer = document.getElementById('source-viewer');
  updateLineWrapToggle(viewer && viewer.dataset.openPath);
  updateDiffLineWrapToggle();
}
function toggleLineWrap() {
  if (!isSourceViewerVisible() && !isDiffViewVisible()) return false;
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
      // Deliberately no aria-pressed. This button's NAME is the action, not its state — and carrying a
      // pressed state on top of a changing name made the two say opposite things: in raw mode a screen
      // reader announced "Rendered, pressed" while the view was raw.
      btn.removeAttribute('aria-pressed');
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
  // Following an in-repo link from a rendered Markdown document. Delegated from the source body so it
  // survives every re-render, and resolved here because this is the moment the open file is known.
  // openSourceFile already answers for a path the review does not hold — it asks main once and says so if
  // the file is not there — so a broken link in a document reads as a broken link rather than as nothing.
  var sourceBody = document.getElementById('source-body');
  if (sourceBody) sourceBody.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[data-md-link]') : null;
    if (!link) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    var viewer = document.getElementById('source-viewer');
    var from = (viewer && viewer.dataset.openPath) || '';
    var target = resolveRepoHref(from, link.getAttribute('data-md-link') || '');
    if (!target) return; // a bare fragment resolves to nothing to open; leave it to the browser
    event.preventDefault();
    openSourceFile(target);
  });
  applyLineWrapState();
  if (lineWrapEnabled) refreshDiffLineWrapLayout();
  // ⌥R and ⌥W used to be a second document keydown listener spelling their own chords; they are rows of
  // the shortcut table now (SHORTCUT_ACTIONS in 05-keymap.js), which is also what lets them be rebound.
})();

// A PDF is handed to Chromium's built-in viewer rather than drawn by us: no PDF library ships in the bundle,
// and the reader gets page navigation, zoom, text selection and find for nothing. The <embed> starts with no
// src — mountPdfPreview fills it in, because the bytes have to become a blob: URL first.
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

// `vector` says the source scales without loss (a rendered Mermaid SVG). A raster preview must never be
// blown up past its own pixels, but a diagram opened "full size" that comes back the size it was in a 700px
// card reads as a broken button — and max-width/max-height alone can only ever shrink.
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

// One open-source Markdown engine is shared by source previews and agent answers.
// markdown-it gives CommonMark-compatible parsing plus top-level token source maps; DOMPurify sanitizes the
// final HTML, including raw HTML blocks. Both audited browser bundles are prepended at build time.

// A href that names a file in this repository rather than somewhere else: no scheme, no protocol-relative
// prefix, and not a bare in-page fragment (those the browser already handles).
function isRepoRelativeHref(href) {
  if (!href) return false;
  if (href.charAt(0) === '#') return false;
  if (href.slice(0, 2) === '//') return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(href);
}
// Resolve a link's href against the directory of the document it was written in. Kept here rather than
// reaching for a URL object: a review path is repo-relative with no origin, and `new URL` would need a
// fake one and then hand back something that has to be unwound again.
function resolveRepoHref(fromPath, href) {
  var hash = href.indexOf('#');
  if (hash >= 0) href = href.slice(0, hash); // a fragment is for the browser, not for the file name
  var query = href.indexOf('?');
  if (query >= 0) href = href.slice(0, query);
  if (!href) return '';
  if (href.charAt(0) === '/') return href.replace(/^\/+/, ''); // repo-root-relative
  var parts = String(fromPath || '').split('/');
  parts.pop(); // drop the document's own filename
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
    // A link to a file in this repository is not an external link, and sending it to the browser was the
    // same as deleting it: target=_blank on a relative href produces a file:// URL, which the window-open
    // handler denies (it passes http(s) only), so the click did nothing at all — no navigation, no file,
    // no message. Measured on this project's own README: 2 of its 5 links are in-repo documents, both
    // inert, both styled and underlined like live ones. In a tool for reading a repository, its own
    // documents are the links most worth following.
    //
    // Resolved on click rather than here: the engine is a singleton with no idea which file it is
    // rendering, and a rendered Markdown document is always the one the source view has open.
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

// Group markdown-it's top-level tokens into source-addressable blocks. A block retains the first source
// line for the gutter/comment anchor, while its HTML comes from the exact same renderer as merged prompts.
function renderMarkdownBlocks(content) {
  var md = getMarkdownEngine();
  var split = splitFrontmatter(content);
  var env = {};
  // Token maps are relative to what we parsed, so every line is shifted back by the frontmatter we removed —
  // otherwise the gutter numbers and comment anchors would all be off by its height.
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
  // role=presentation: the rows exist so a comment can be anchored to the Markdown block it is about
  // (USER_FLOWS Flow 4) — they are a layout device, not a table of data. Declared as a real table, a
  // screen reader walks a README as a 68-row two-column grid, announcing a row and column position for
  // every paragraph. The CSV view next door is the one that genuinely is a table, and it is marked up
  // as one. (The cells keep their own roles implicitly; presentation on the table is what drops the grid.)
  if (!blocks.length) return '<table class="source-table md-doc" role="presentation"><tbody></tbody></table>';
  var rows = blocks.map(function (b) {
    return '<tr class="source-row md-row" data-line-index="' + b.line + '" data-line-end="' + b.endLine + '"><td class="num">' + (b.line + 1) + '</td><td class="source-code md-cell markdown-body">' + b.html + '</td></tr>';
  }).join('');
  return '<table class="source-table md-doc" role="presentation"><tbody>' + rows + '</tbody></table>';
}

// Join a document-relative image src against the markdown file's directory and collapse ./ and ../ segments,
// yielding a repo-root-relative path. Query/hash are dropped. Returns null for empty/unusable input; a path
// that still climbs above the root is left for main's containment check to reject.
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

// The rendered preview keeps markdown-it's document-relative <img src> (e.g. assets/x.gif), which cannot load
// from the file:// review page. Resolve each such src against the document's directory and swap in a data:
// URL from main. Absolute, remote, and data: sources are left untouched.
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
  var rowHtml = records.map(function (rec, idx) {
    var head = idx === 0;
    var cells = '';
    for (var c = 0; c < cols; c++) {
      var v = escapeHtml(rec[c] == null ? '' : rec[c]);
      // scope="col" is the whole point of a header cell: without it "name: widget, qty: 3" is just
      // "widget, 3". A ragged record makes `cols` wider than the header row, so the padding cells at the
      // end are headers of nothing — they get no scope, because announcing an empty column name on every
      // row below is worse than announcing none.
      var named = head && rec[c] != null && String(rec[c]).trim() !== '';
      if (head) cells += '<th class="csv-cell"' + (named ? ' scope="col"' : '') + '>' + v + '</th>';
      else cells += '<td class="csv-cell">' + v + '</td>';
    }
    // The gutter cell is the row's number, not data — a row header, not another column of values. It sat
    // among the <th>s in the header row as a plain <td>, which made the first column nameless.
    var gutter = '<' + (head ? 'th' : 'td') + ' class="num"' + (head ? ' scope="col"' : '') + '>' + (idx + 1) + '</' + (head ? 'th' : 'td') + '>';
    return '<tr class="source-row csv-row' + (head ? ' csv-head' : '') + '" data-line-index="' + idx + '">' + gutter + cells + '</tr>';
  });
  // thead/tbody: a delimited file's first record names its columns, and a table that says so lets a reader
  // ask for the column headings — the one affordance a data table exists for. This is the only surface
  // here that genuinely IS a data table and it was the one not marked up as one.
  // Split as rows, not as a string: finding the first "</tr>" in joined markup and adding its length is
  // the kind of arithmetic that is right until a cell contains the characters you were counting on.
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
    // The Run button names its request, so a file of twenty requests has twenty distinguishable buttons
    // for a screen reader instead of twenty "Run request"s.
    const label = hasRun ? t('http.runNamed').replace('{name}', requests[reqIdx].name) : '';
    const gutter = hasRun
      ? '<button type="button" class="http-run" data-keyhint-id="runHttp" data-req="' + reqIdx + '"'
        + ' title="' + escapeHtml(label) + '" aria-label="' + escapeHtml(label) + '">&#9654;</button>'
      : '';
    const isScript = Boolean(parsed.scriptLines[index]);
    rows += '<tr class="source-row http-row' + (hasRun ? ' http-request-line' : '') + (isScript ? ' http-script-line' : '')
      + (isCursorLine ? ' cursor-line' : '') + '" data-line-index="' + index + '">'
      + '<td class="num http-gutter">' + gutter + '<span class="num-text">' + (index + 1) + '</span></td>'
      + '<td class="source-code">' + (isCursorLine ? renderHttpLineWithCursor(line, scope, cursor.column, isScript) : highlightHttpLine(line, scope, isScript)) + '</td>'
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
  // A script body is JavaScript, not .http syntax: a `#` in it is a character, and a {{var}} is not one.
  if (isScript) return highlightLine(line, 'javascript');
  if (trimmed.indexOf('###') === 0) return '<span class="http-sep">' + escapeHtml(line) + '</span>';
  if (trimmed.indexOf('#') === 0 || trimmed.indexOf('//') === 0) {
    // A directive comment is syntax that changes what is sent; prose above a request is not.
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

/** The request could not be sent at all: no status line to show, so say why where one would have been. */
function renderHttpFailure(target, message) {
  target.className = 'http-response error';
  target.innerHTML = '<div class="http-resp-head"><span class="http-status bad">'
    + escapeHtml(t('http.notSent')) + '</span></div>'
    + '<pre class="http-resp-body">' + escapeHtml(message) + '</pre>';
}

/** client.test() results and client.log() output — a handler that ran invisibly may as well not have. */
function httpScriptLogHtml(log) {
  if (!log) return '';
  let html = '';
  if (log.tests && log.tests.length) {
    const failed = log.tests.filter(function (entry) { return !entry.ok; }).length;
    html += '<div class="http-tests' + (failed ? ' has-failures' : '') + '">'
      + '<div class="http-tests-head">' + escapeHtml(
        failed
          ? t('http.testsFailed').replace('{failed}', String(failed)).replace('{total}', String(log.tests.length))
          : t('http.testsPassed').replace('{total}', String(log.tests.length)))
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
  // `bytes` is the length on the wire; bodyText.length counts UTF-16 units, which is a different number
  // for any non-ASCII response.
  const size = Number(result.bytes) || bodyText.length;
  const bodyHtml = result.bodyBase64
    ? renderHttpBinaryBody(result, contentType)
    : formatHttpBody(bodyText, contentType);
  const meta = [];
  if (result.redirects && result.redirects.length) {
    meta.push('<span class="http-resp-meta" title="' + escapeHtml(result.redirects.join('\n')) + '">'
      + escapeHtml(t('http.redirects').replace('{count}', String(result.redirects.length))) + '</span>');
  }
  if (result.cookies && result.cookies.length) {
    meta.push('<span class="http-resp-meta">' + escapeHtml(t('http.cookies').replace('{count}', String(result.cookies.length))) + '</span>');
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

/**
 * A WebSocket exchange, in the order it happened: what was sent, what came back, and when.
 *
 * Deliberately not shaped like an HTTP response — there is no status, no header list and nothing to save.
 * The time beside each line is what makes it readable as a conversation rather than a list.
 */
function renderWebSocketTranscript(target, result) {
  const entries = (result && result.transcript) || [];
  target.className = 'http-response' + (result && result.ok ? '' : ' error');
  const head = '<div class="http-resp-head">'
    + '<span class="http-status ' + (result && result.ok ? 'ok' : 'bad') + '">'
    + escapeHtml(t(result && result.ok ? 'ws.closed' : 'http.notSent')) + '</span>'
    + '<span class="http-resp-meta">' + (Number(result && result.durationMs) || 0) + ' ms</span>'
    + '<span class="http-resp-meta">' + escapeHtml(t('ws.messages').replace('{count}', String(entries.filter(function (entry) {
      return entry.direction === 'in' || entry.direction === 'out';
    }).length))) + '</span>'
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

/**
 * What a `run` line did: one row per request it ran, in order, with its status.
 *
 * Not shaped like a response because it is not one — a `run` has no status, headers or body of its own,
 * and what the reader needs from it is which of the requests it started came back.
 */
function renderHttpRunSummary(target, path, outcomes) {
  const failed = outcomes.filter(function (outcome) { return !outcome.ok; }).length;
  target.className = 'http-response' + (failed ? ' error' : '');
  target.innerHTML = '<div class="http-resp-head">'
    + '<span class="http-status ' + (failed ? 'bad' : 'ok') + '">'
    + escapeHtml(failed
      ? t('http.ranAllWithFailures').replace('{count}', String(outcomes.length)).replace('{failed}', String(failed))
      : t('http.ranAll').replace('{count}', String(outcomes.length)))
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

/** A non-text response. An image is worth showing; anything else is worth counting. */
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
  // An XML/HTML body gets the markup highlighter it would get in the source view.
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

// Painting a big file is 85-93% of what a reviewer waits through when they follow a definition: measured in
// the real app, a 30k-line destination took 782ms end to end, of which the language server was 62ms and the
// rest was building every line into the DOM. So a big file paints the rows around the caret first and fills
// the rest in afterwards, with exact-height spacers standing in for what is not there yet — nothing shifts
// under the reader when a spacer becomes real rows, because source rows are a fixed monospace height
// (the same assumption scheduleSourceReveal already computes scroll from).
//
// Anything that needs a row that has not been built yet calls flushSourceRows() first, which finishes the
// job synchronously — so the worst case is exactly today's behaviour, and no caller has to learn about a
// row that might not exist.
// A FUNCTION, not module-level constants: this file is one slice of a concatenated bundle, and a session
// restored into the source view renders a table from an earlier slice during load — before anything
// declared here has been assigned. As `let` that read throws; as `var` it reads `undefined`, which silently
// produced a NaN window and painted zero rows. Function declarations hoist, so this is readable from the
// first render on. (TOKEN_SETS below is the same hazard, found the same way.)
function sourceProgressiveLimits() {
  return {
    minRows: 2000,   // below this a single-shot render is already fast — 74ms at 1k lines, measured
    windowRows: 400, // painted immediately, around the caret
    chunkRows: 2000, // appended per frame afterwards
  };
}
// Declared WITHOUT initialisers on purpose. `var` hoists the declaration but runs the assignment when the
// statement is reached — and a session restored into the source view renders a table from an earlier slice
// during script load, so `= null` here would run AFTER that render and wipe the fill it had just set up.
// The file stayed at its first window forever, and the chunk timer's id was lost with it. Undefined reads
// as "no fill outstanding", which is the same thing null meant.
var sourceFill;      // { path, rowStarts, build } while a fill is outstanding
var sourceFillTimer; // the outstanding chunk timer, if any

function sourceRowSpacerHtml(fromRow, toRow, height) {
  // aria-hidden: this is one empty row standing in for thousands that have not been built yet. It is a
  // scrollbar-honesty device, not content, and a screen reader walking the table should step from the last
  // real row to the next one rather than into a blank cell claiming to be 29,600 lines.
  return '<tr class="source-spacer" aria-hidden="true" data-spacer-from="' + fromRow + '" data-spacer-to="' + toRow
    + '" style="height:' + height + 'px"><td colspan="2"></td></tr>';
}

// Replace one spacer with the rows it stands for. Splitting rather than doing the whole spacer keeps a
// single frame short; `limit` of 0 means "all of it".
function expandSourceSpacer(spacer, limit) {
  if (!sourceFill || !spacer) return false;
  const from = Number(spacer.dataset.spacerFrom);
  const to = Number(spacer.dataset.spacerTo);
  if (!(to > from)) { spacer.remove(); return false; }
  // Fill from the END of a leading spacer and the START of a trailing one, so growth always happens next
  // to the rows already on screen and the reader's viewport never moves.
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

/** Finish every outstanding row of the open file, now. Cheap when there is nothing left to do. */
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

// Comments and the blame gutter decorate rows, and they ran when only the window existed. Re-run them once
// the rest has arrived rather than teaching each one to wait.
function sourceRowsCompleted(path) {
  const viewer = document.getElementById('source-viewer');
  if (!viewer || viewer.dataset.openPath !== path) return;
  try { renderSourceComments(); } catch (e) {}
  try { refreshSourceBlamePaint(path); } catch (e) {}
  try { refreshSourceDiagnostics(path); } catch (e) {}
}

// A timer, not requestAnimationFrame. The first fill is scheduled from the render itself, and a session
// restored into the source view renders during script load — an rAF asked for at that point never fired
// under jsdom, so the file stayed at its first window forever and only the tests noticed. Chunk work does
// not need frame alignment anyway; it needs to not be in the way of the first paint.
function scheduleSourceFill() {
  if (sourceFillTimer || !sourceFill) return;
  sourceFillTimer = setTimeout(function () {
    sourceFillTimer = undefined;
    const body = document.getElementById('source-body');
    if (!sourceFill || !body) return;
    const spacer = body.querySelector('.source-spacer');
    if (!spacer) { sourceFill = undefined; return; }
    expandSourceSpacer(spacer, sourceProgressiveLimits().chunkRows);
    if (body.querySelector('.source-spacer')) { scheduleSourceFill(); return; }
    const filled = sourceFill.path;
    sourceFill = undefined;
    sourceRowsCompleted(filled);
  }, 16);
}

/**
 * A line's highlighted HTML: the language server's tokens where it has sent any for that line, and the
 * hand tokenizer everywhere else.
 *
 * Per LINE rather than per file, because a server's answer is sparse — it sends tokens for the code it
 * recognised and nothing for a blank line or one it has no opinion about. Falling back per line keeps
 * those lines coloured instead of plain.
 */
function sourceLineHtml(line, byLine, index, language) {
  var tokens = byLine ? byLine.get(index) : null;
  if (tokens && tokens.length) return semanticLineHtml(line, tokens);
  return highlightLine(line, language);
}

function renderSourceTable(file, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const lines = file.content.split(/\r?\n/);
  // Past ~10k lines, skip syntax highlighting: tokenizing every line is ~half the render cost (measured
  // ~4.5ms/1000 lines) and blocks the renderer, while plain escaped rows keep the exact same line structure
  // comments/caret/search/find anchor on — only color is lost, the way editors drop highlighting past a size.
  const renderLanguage = lines.length > 10000 ? 'text' : (file.language || 'text');
  // Markup files carry two other languages inside them; everything else is one language for every line.
  const lineLanguages = renderLanguage === 'markup' ? markupBlockLanguages(lines) : null;
  const languageAt = (index) => (lineLanguages ? lineLanguages[index] : renderLanguage);
  // The server's own tokens for this file, if it has answered. One lookup per render, not per line.
  const semanticByLine = renderLanguage === 'text' ? null : semanticTokensFor(file.path);
  const cursor = viewerCursor && viewerCursor.path === file.path ? viewerCursor : null;
  const changedSet = new Set(file.changedLines || []);
  // Bookmarked lines get a gutter mark. Read once per render rather than per row, and written here so a
  // row built later (progressive rendering, a fold opening) comes out marked without a second pass.
  const bookmarkedLines = bookmarkLinesFor(file.path);
  const folds = normalizedQuery ? [] : sourceFoldRanges(file);
  const foldAt = new Map(folds.map((fold) => [fold.start, fold]));

  // One entry per VISUAL row — a collapsed fold occupies a single row — which is the unit every window
  // index and spacer height below is counted in. Building it is a cheap walk; what costs is highlighting,
  // and that only happens for rows actually built.
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
      '<td class="source-code">' + markWhitespaceRuns(sourceLineHtml(line, semanticByLine, index, languageAt(index))) + foldButton + '</td>',
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

  // A search paints hit classes across the whole file, and a small file is already fast, so both render in
  // one shot and leave no fill outstanding.
  const limits = sourceProgressiveLimits();
  sourceFill = undefined;
  if (normalizedQuery || rowStarts.length < limits.minRows) {
    return '<table class="source-table"><tbody>' + build(0, rowStarts.length) + '</tbody></table>';
  }

  // The window goes around the caret, because following a definition lands there and that is the only part
  // the reader is looking at.
  let cursorRow = 0;
  if (cursor) {
    let lo = 0;
    let hi = rowStarts.length - 1;
    while (lo < hi) { // last row whose start line is <= the caret, so a folded caret lands on its fold row
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

// A .svelte/.vue/.html file is markup wrapping a <script> and a <style>, and highlighting it as one
// language leaves whichever part is not markup completely plain. The renderer has every line in order, so
// walk them once and record which block each line is in; highlightLine is then handed the language the line
// is actually written in. Mirrors blockLanguageScanner in highlight.ts, which does the same for the diff.
function markupBlockLanguages(lines) {
  var out = new Array(lines.length);
  var mode = 'markup';
  for (var i = 0; i < lines.length; i += 1) {
    var text = lines[i];
    var opener = /<\s*(script|style)\b([^>]*)>/i.exec(text);
    if (opener && !/\/\s*>\s*$/.test(opener[0])) {
      out[i] = 'markup'; // the line carrying the opening tag is still markup
      mode = opener[1].toLowerCase() === 'style' ? 'css' : 'typescript';
      continue;
    }
    if (/<\s*\/\s*(script|style)\s*>/i.test(text)) { out[i] = 'markup'; mode = 'markup'; continue; }
    out[i] = mode;
  }
  return out;
}

// Built once, on FIRST USE rather than at load: this file is one slice of a concatenated bundle, and the
// boot path in an earlier slice already renders a source table — so a plain `var` here is still unassigned
// when the first line is highlighted, and highlightLine threw on it.
var TOKEN_SETS = null;
function tokenSets() {
  if (TOKEN_SETS) return TOKEN_SETS;
  var base = new Set(['as','async','await','break','case','catch','class','const','continue','def','default','defer','do','else','enum','export','extends','final','finally','fn','for','from','func','function','go','if','impl','import','in','interface','let','match','module','new','package','private','protected','public','return','select','static','struct','switch','throw','try','type','val','var','while','yield']);
  var literals = new Set(['False','None','True','false','nil','null','self','this','true','undefined']);
  // `base` is the union across languages, so a language whose vocabulary is not in it reads as plain text —
  // Kotlin lost `fun`, `override`, `companion object` and `when`, while `type` (an ordinary Kotlin parameter
  // name) came out coloured as a keyword. These stay per-language rather than joining the union: `data`,
  // `object`, `init`, `is`, `by` and `out` are everyday identifiers in every other language here, and
  // `type`/`let` go the other way — a parameter name and a stdlib call in Kotlin, not keywords.
  var kotlin = new Set(Array.from(base).filter(function (word) { return word !== 'type' && word !== 'let'; }).concat([
    'abstract','actual','annotation','by','companion','constructor','crossinline','data','expect','external',
    'fun','infix','init','inline','inner','internal','is','lateinit','noinline','object','open','operator',
    'out','override','reified','sealed','suspend','tailrec','typealias','vararg','when','where'
  ]));
  TOKEN_SETS = { base: base, literals: literals, kotlin: kotlin };
  return TOKEN_SETS;
}

// `true`, `off`, `~` and the rest of YAML's constants. A regex rather than a module-level Set on purpose:
// the slices are ONE script and slice order is execution order, so a `var` initialised here is still
// undefined to anything that runs earlier — and the source view renders its first file from an earlier
// slice. (That is also why the keyword sets below are built lazily by tokenSets() instead of up here.)
// Case-insensitive because YAML accepts `True` and `TRUE` for the same value, and colouring one spelling
// and not the others looks broken.
function yamlConstantWord(word) {
  return /^(?:true|false|null|yes|no|on|off)$/i.test(word);
}

/**
 * One line of a YAML value — everything to the right of a `key:`, or a bare list item.
 *
 * A plain scalar is a STRING in this grammar, not untyped text (Dracula paints `name: Release` and
 * `name: "Release"` the same yellow), so the scanner accumulates a run and only interrupts it for the
 * shapes that are something else. That is also what keeps `#` inside a quoted scalar from starting a
 * comment — a line-local `indexOf('#')` gets that wrong, and a URL fragment in a value is not rare.
 */
function highlightYamlValue(text) {
  var out = '';
  var run = '';
  var index = 0;
  var flush = function () {
    if (!run) return;
    // The whitespace around a run belongs to the layout, not to the scalar: colouring it makes a trailing
    // space visible as a yellow block when the line is selected.
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
    // Flow punctuation is punctuation: #F8F8F2 in the theme, which is the body colour already.
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

/** One line of YAML: its indent, its bullets, its key, then the value. */
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
  // `- - a` is two bullets and one item, so this is a loop rather than one test.
  var bullet = null;
  while ((bullet = rest.match(/^-(\s+|$)/))) {
    out += '<span class="tok-keyword">-</span>' + bullet[1];
    rest = rest.slice(bullet[0].length);
  }
  if (!rest) return out;
  if (rest.charAt(0) === '#') return out + '<span class="tok-comment">' + escapeHtml(rest) + '</span>';
  // A key runs to the first `: ` — lazily, so `url: http://x` keeps its value intact, and a quoted key
  // keeps its quotes. A line with no such colon is a plain scalar (a folded value's continuation).
  var key = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#"'][^:#]*?)(\s*):(\s|$)/);
  if (key) {
    out += '<span class="tok-type">' + escapeHtml(key[1]) + '</span>' + key[2] + '<span class="tok-keyword">:</span>';
    return out + highlightYamlValue(rest.slice(key[1].length + key[2].length + 1));
  }
  return out + highlightYamlValue(rest);
}

function highlightLine(text, language) {
  if (language === 'text') return escapeHtml(text);
  // CSS has none of the generic tokenizer's shapes — no keywords, no // comments, and `8px` is not a number
  // to a \b-anchored match — so a <style> block came out entirely plain. Property names and selectors are
  // what carry the structure when you are skimming, so colour those two and leave values alone.
  if (language === 'css') {
    var commentAt = text.indexOf('/*');
    if (commentAt >= 0) {
      return highlightLine(text.slice(0, commentAt), 'css')
        + '<span class="tok-comment">' + escapeHtml(text.slice(commentAt)) + '</span>';
    }
    // A line is a selector up to its opening brace, then declarations. Both halves appear on one line as
    // often as on three, so split on the brace rather than matching whole-line shapes.
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
  // YAML had no shape here at all: a .yml file in the source view came out plain except for its `#`
  // comments, because the generic tokenizer below is built for keyword languages and a YAML file has no
  // keywords — it has KEYS, and nothing was colouring those. (The diff view was fine; it runs highlight.js,
  // which does know YAML. One engine knowing it and the other not is what "yml isn't highlighted" was.)
  //
  // The colours are not a guess. They are read out of the shipped dracula-theme VS Code package
  // (extension/theme/dracula.json), scope by scope:
  //
  //   entity.name.tag.yaml                        #8BE9FD   the key           -> --token-type
  //   punctuation.separator.key-value.mapping     #FF79C6   the `:`           -> --token-keyword
  //   punctuation.definition.block.sequence.item  #FF79C6   the `-` bullet    -> --token-keyword
  //   punctuation.definition.block.scalar.*       #FF79C6   `|` and `>`       -> --token-keyword
  //   string                                      #F1FA8C   scalars, quoted
  //                                                         AND plain         -> --token-string
  //   constant                                    #BD93F9   numbers, booleans -> --token-number/literal
  //   entity.name.type                            #8BE9FD   `&anchor`, italic -> .tok-anchor
  //   variable.other.alias.yaml                   #50FA7B   `*alias`, italic
  //                                                         underline         -> .tok-alias
  //   comment                                     #6272A4                     -> --token-comment
  //
  // Every one of those is a role this app already has a variable for, which is why the mapping is a
  // mapping and not a second palette: the same branch paints YAML correctly in solarized and contrast too.
  //
  // One line at a time, like every other branch here — that is the contract the source view needs to paint
  // a window of a 30k-line file. The visible cost is a `#` inside a `|` block scalar, which reads as a
  // comment because the line that opened the block is not in front of us.
  // ponytail: line-local. Carrying block-scalar state would mean the painter had to know the lines above
  // the window it is painting, which is the thing the window exists to avoid.
  if (language === 'yaml') return highlightYamlLine(text);
  if (language === 'markdown') {
    const escaped = escapeHtml(text);
    if (/^\s{0,3}#{1,6}\s/.test(text)) return '<span class="tok-keyword">' + escaped + '</span>';
    return escaped.replace(new RegExp(String.fromCharCode(96) + '[^' + String.fromCharCode(96) + ']+' + String.fromCharCode(96), 'g'), '<span class="tok-string">$&</span>');
  }
  const sets = tokenSets();
  const keywords = language === 'kotlin' ? sets.kotlin : sets.base;
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
      else if (sets.literals.has(value)) output += '<span class="tok-literal">' + escapeHtml(value) + '</span>';
      else if (/^\s*\(/.test(trailing)) output += '<span class="tok-function">' + escapeHtml(value) + '</span>';
      // SCREAMING_SNAKE is a constant in every language here — enum entries above all, which is most of what
      // a `when` over an enum is made of and all of it read as plain text. They are values, so they take the
      // colour the other literals take. (An all-caps acronym type like UUID lands here too; telling those
      // apart needs the compiler, not a tokenizer.)
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


// ---- .http requests in the diff view -------------------------------------------------------------
//
// A .http file in a diff is the same file: the request on the new side is the request you would run. It
// was only runnable from the source view because the runner read its path out of #source-viewer and wrote
// its response into a row the source table had rendered. Both of those are now arguments.
//
// Only the NEW side gets a run button. The old side is the request as it was before the change, and
// running that is offering to send something the file no longer says.
//
// The response row is inserted the way a comment is — one row on the side that shows it, one spacer of
// matching height on the other — because the two panes are separate tables aligned by row position, and a
// row added to one alone silently shifts every line below it out of step with its counterpart.
var diffHttpSlot = 0;
// Same resolution diffWrapperByPath uses in reverse: data-path is only written on the wrappers render.ts
// rewrites, and a review that ships diff2html's own markup has the path in the file-name header instead.
// Reading only the dataset meant those reviews silently had no run buttons at all.
function diffHttpPath(wrapper) {
  if (!wrapper) return '';
  var path = (wrapper.dataset && wrapper.dataset.path)
    || ((wrapper.querySelector('.d2h-file-name') || {}).textContent || '').trim();
  return isHttpFile(path) ? path : '';
}
var diffHttpPending = Object.create(null);
function decorateDiffHttpRuns(wrapper) {
  var path = diffHttpPath(wrapper);
  if (!path) return;
  // Parse the file as it is NOW, not the diff text: the request that runs is the one in the working tree,
  // and the diff on screen may be missing the lines a folded context is hiding.
  //
  // The diff view never needed a file's source before, so it is not loaded here — the body it renders is
  // the diff, not the file. Fetch it once and decorate again when it lands; until then the file simply has
  // no run buttons, which is what it looked like before this existed.
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

  // The buttons go in an overlay, not in the table.
  //
  // The obvious place is the line-number cell, and it cannot be used: four separate readers take that
  // cell's textContent — diffLineNumber parses it as an integer, and two others treat "is it non-empty"
  // as "is this a real code line". A glyph in there turns every line number on the file into NaN and every
  // placeholder row into a code row. The connector curves already solved the same problem the same way:
  // an absolutely-positioned layer inside the wrapper, which the table never sees.
  // Hosted on .d2h-files-diff, which is the element the connector overlay is already positioned against —
  // the wrapper itself is not a containing block.
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
    // Derived from the table the row actually came from, not asserted: it is the only way to tell from
    // the DOM which side a button was built from, because the overlay belongs to neither.
    button.dataset.side = side === diffSideTable(wrapper, 'new') ? 'new' : 'old';
    button.dataset.line = String(line);
    button.dataset.httpPath = path;
    button.setAttribute('data-keyhint-id', 'runHttp');
    button.setAttribute('data-i18n-title', 'http.run');
    button.title = t('http.run') || 'Run request';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = '&#9654;';
    layer.appendChild(button);
    // WHICH lines get a button is a fact about the file; WHERE each one sits is a fact about layout, and
    // only the second needs measuring. Keeping them apart means the buttons exist even before the rows
    // have boxes — which is every render in a test, and the first frame in the app.
    //
    // Between the line number and the code, not on top of either: parked over the gutter it hid the line
    // number, and a diff without line numbers is worse off than one without a run button.
    var box = row.getBoundingClientRect();
    if (!box.height) return;
    var code = row.querySelector('.d2h-code-line-ctn');
    var codeBox = code ? code.getBoundingClientRect() : box;
    button.style.top = Math.round(box.top - base.top) + 'px';
    button.style.left = Math.round(codeBox.left - base.left - 19) + 'px';
  });
}
// The response lands under the request's last line, on the new side, with a spacer opposite it.
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

  // Same slot, so the existing comment-spacer sync keeps the two sides the same height.
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
// A response row pushes everything under it down, and the run buttons are an overlay positioned in pixels,
// so they have to be measured again or the next request's button is left pointing at the line that used to
// be there. The opposite pane has to grow to match, too.
//
// Driven by the box's own size rather than by a timer: the response starts as a spinner, becomes a status
// line, then grows again when the body lands, and a fixed delay can only ever be wrong for one of those.
// A first attempt timed it at 400ms and left the second button stranded halfway up the response.
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
// The request the diff caret is standing in, run the same way the source view runs it.
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
