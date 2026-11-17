var PATH_CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonl|css|scss|sass|less|html|htm|xml|svg|md|mdx|py|pyi|rb|php|go|rs|java|kt|kts|sh|bash|zsh|fish|yml|yaml|toml|ini|cfg|conf|env|sql|txt|csv|tsv|lock|proto|graphql|gql|vue|svelte|astro|c|h|cc|cpp|hpp|cs|swift|m|mm|scala|clj|ex|exs|erl|lua|r|jl|dart|zig|nim|hs|ml|vim|dockerfile|gradle|properties)$/i;

function pathCodeHtml(text, tag) {
  var el = tag || 'code';
  if (text.indexOf('/') < 0) {
    var bare = text.replace(/:\d+$/, '');
    var resolved = resolveBareFileName(bare);
    if (resolved) text = resolved + text.slice(bare.length);
  }
  var safe = escapeHtml(text);
  var open = '<' + el + ' class="mc-path-code" data-path="' + safe + '" title="' + safe + '">';
  var cut = text.lastIndexOf('/');
  if (cut < 0 || text.slice(0, cut).split('/').length < 2) return open + safe + '</' + el + '>';
  return open
    + '<span class="mc-path-dir">' + escapeHtml(text.slice(0, cut)) + '</span>'
    + '<button type="button" class="mc-path-ell" title="' + escapeHtml(t('comment.expandPath')) + '">(&hellip;)</button>'
    + escapeHtml(text.slice(cut)) + '</' + el + '>';
}
function isPathCodeText(text) {
  var bare = String(text).replace(/:\d+$/, '');
  return text.length < 200 && /^[A-Za-z0-9_@.\-/]+$/.test(bare) && PATH_CODE_EXT.test(bare);
}
function linkifyPathCode(html) {
  return String(html).replace(/<code>([^<]+)<\/code>/g, function (whole, text) {
    if (isPathCodeText(text)) return pathCodeHtml(text);
    if (text.length >= 200 || !/\s/.test(text)) return whole;
    var parts = text.split(/(\s+)/);
    if (!parts.some(isPathCodeText)) return whole;
    return '<code>' + parts.map(function (part) {
      return isPathCodeText(part) ? pathCodeHtml(part, 'span') : part;
    }).join('') + '</code>';
  });
}
function resolveBareFileName(name) {
  if (typeof sourceByPath === 'undefined' || !sourceByPath || typeof sourceByPath.forEach !== 'function') return '';
  if (sourceByPath.has(name)) return name;
  var suffix = '/' + name, hits = [];
  sourceByPath.forEach(function (_file, path) {
    if (path.length > suffix.length && path.slice(-suffix.length) === suffix) hits.push(path);
  });
  return hits.length === 1 ? hits[0] : '';
}
function linkifyBareFileNames(html) {
  return String(html).replace(/(<(?:code|pre|a)\b[\s\S]*?<\/(?:code|pre|a)>)|>([^<]*)(?=<)/gi, function (whole, skip, text) {
    if (skip || !text) return whole;
    return '>' + text.replace(/[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,8}(?::\d+)?/g, function (name) {
      var bare = name.replace(/:\d+$/, '');
      return PATH_CODE_EXT.test(bare) && resolveBareFileName(bare) ? pathCodeHtml(name, 'span') : name;
    });
  });
}
function annotationBodyHtml(text) {
  var parts = String(text || '').split(/^```mermaid\s*$([\s\S]*?)(?:^```\s*$|$(?![\s\S]))/m);
  var html = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) html += mermaidPlaceholderHtml(parts[i].trim());
    else if (parts[i].trim()) html += linkifyBareFileNames(linkifyPathCode(renderMarkdownHtml(parts[i])));
  }
  return html;
}

var NOTE_ROLES = { key: 1, problem: 1, fix: 1 };

function agentCardHtml(c) {
  var isReply = c.replyTo != null;
  var role = !isReply && NOTE_ROLES[c.role] ? 'key' : '';
  return '<div class="mc-card mc-ai' + (isReply ? ' mc-reply-card' : '') + (role ? ' mc-role-' + role : '') + '">'
    + '<div class="mc-card-head"><span class="mc-kind mc-kind-ai">' + annotationKindIcon()
    + '<span class="mc-kind-text">' + escapeHtml(t(isReply ? 'comment.answer' : 'annotate.kind')) + '</span></span>'
    + (role ? '<span class="mc-role">' + escapeHtml(t('annotate.role.key')) + '</span>' : '')
    + (c.title ? '<span class="mc-ai-title">' + escapeHtml(c.title) + '</span>' : '')
    + commentTargetHeadHtml(c)
    + '<button type="button" class="mc-del" data-keyhint-id="deleteComment:1" data-seq="' + c.seq + '"'
    + ' aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">×</button>'
    + '</div>'
    + '<div class="mc-card-body markdown-body mc-ai-body">' + annotationBodyHtml(c.text)
    + '</div></div>';
}
function annotationKindIcon() {
  return '<svg class="mc-kind-ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1V16h6v-1c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3z"/></svg>';
}
