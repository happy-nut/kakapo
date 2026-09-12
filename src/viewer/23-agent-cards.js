// ===== Agent cards: rendering a turn somebody's agent appended to the review thread =====
//
// kakapo no longer runs an agent of its own. What it still does is keep the review conversation in one
// plain file (comments-file.ts) and hand out its path — so an agent running in the reader's OWN terminal
// can answer a comment by appending a line to it, and the answer arrives on the card it answers. This slice
// is the rendering half of that: everything needed to draw a `by: "agent"` record, and nothing else.
var PATH_CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonl|css|scss|sass|less|html|htm|xml|svg|md|mdx|py|pyi|rb|php|go|rs|java|kt|kts|sh|bash|zsh|fish|yml|yaml|toml|ini|cfg|conf|env|sql|txt|csv|tsv|lock|proto|graphql|gql|vue|svelte|astro|c|h|cc|cpp|hpp|cs|swift|m|mm|scala|clj|ex|exs|erl|lua|r|jl|dart|zig|nim|hs|ml|vim|dockerfile|gradle|properties)$/i;

// A path an agent names in prose — `app/optimization/domain/campaign_control.py` — is a place the reader wants
// to go, so make it one (openPathReference in 07-comments.js resolves and jumps on click). Only inline code
// that actually looks like a file path is marked: a symbol (`get_context`), a route template
// (`/campaigns/{id}/lessons`), a number (`0.5`) and an attribute chain (`advisor.study_summary.params`) all
// fail and stay plain text. Fenced blocks are untouched — their <code> carries a class and highlight spans,
// so `[^<]+` never matches one.
// A deep path spends most of a line naming directories nobody reads — `turtle/backend/src/app/stock/backtest/
// domain/evaluation_policy.py:27` is one file's name wearing seven folders, and the sentence around it was
// about the file. Everything before the last slash folds into a (…) that unfolds on click, so the prose keeps
// its rhythm and the full path stays one click (or one hover — it is the title) away.
//
// The characters are restricted to [A-Za-z0-9_@.-/] plus a trailing :42 by the caller, so the text is safe in
// an attribute as-is. `data-path` carries the whole thing because textContent no longer does: the folded
// directory is still in the DOM, and the (…) is in there with it.
function pathCodeHtml(text, tag) {
  var el = tag || 'code';
  // A mention with no directory in it — `chart.py`, `chart.py:106` — is a reference to a file whose path this
  // project already knows. Fill it in (resolveBareFileName) so every mention of that file in a note carries
  // the same path, folds the same way, and lands in the same place on click.
  if (text.indexOf('/') < 0) {
    var bare = text.replace(/:\d+$/, '');
    var resolved = resolveBareFileName(bare);
    if (resolved) text = resolved + text.slice(bare.length);
  }
  var open = '<' + el + ' class="mc-path-code" data-path="' + text + '" title="' + text + '">';
  var cut = text.lastIndexOf('/');
  // One directory deep is already short: folding `src/build.ts` saves no room and costs a click.
  if (cut < 0 || text.slice(0, cut).split('/').length < 2) return open + text + '</' + el + '>';
  return open
    + '<span class="mc-path-dir">' + text.slice(0, cut) + '</span>'
    + '<button type="button" class="mc-path-ell" title="' + escapeHtml(t('comment.expandPath')) + '">(&hellip;)</button>'
    + text.slice(cut) + '</' + el + '>';
}
function isPathCodeText(text) {
  var bare = String(text).replace(/:\d+$/, ''); // a trailing :42 is a line number, not part of the name
  return text.length < 200 && /^[A-Za-z0-9_@.\-/]+$/.test(bare) && PATH_CODE_EXT.test(bare);
}
function linkifyPathCode(html) {
  return String(html).replace(/<code>([^<]+)<\/code>/g, function (whole, text) {
    if (isPathCodeText(text)) return pathCodeHtml(text);
    // A path an agent quotes with something in front of it is still that path: `M turtle/.../turtle.py` is
    // how git status names a file, and requiring the WHOLE span to be a path left exactly those spans as
    // plain text — the same file, in the same note, folded in one sentence and spelled out in full in the
    // next. Mark the tokens that are paths and leave the rest of the span (already escaped) alone.
    if (text.length >= 200 || !/\s/.test(text)) return whole;
    var parts = text.split(/(\s+)/);
    if (!parts.some(isPathCodeText)) return whole;
    return '<code>' + parts.map(function (part) {
      return isPathCodeText(part) ? pathCodeHtml(part, 'span') : part;
    }).join('') + '</code>';
  });
}
// An agent names a file it is only referring to by its bare name — `chart.py`, no directory — because that is
// how anyone talks about a file. The reference is real; what is missing is the path, and the project index
// already knows it (the same suffix match openPathReference does on click). So fill it in: one match and the
// mention becomes the ordinary folded path chip carrying the WHOLE path, reading exactly like every other
// mention of that file in the note. Ambiguous, or not in this project, and it stays what it was — text.
function resolveBareFileName(name) {
  if (typeof sourceByPath === 'undefined' || !sourceByPath || typeof sourceByPath.forEach !== 'function') return '';
  if (sourceByPath.has(name)) return name;
  var suffix = '/' + name, hits = [];
  sourceByPath.forEach(function (_file, path) {
    if (path.length > suffix.length && path.slice(-suffix.length) === suffix) hits.push(path);
  });
  return hits.length === 1 ? hits[0] : '';
}
// Prose only: an existing chip, a code block and a real link are all left exactly as they are.
function linkifyBareFileNames(html) {
  // The `<` is matched by lookahead, never consumed: consuming it would leave the scanner INSIDE the tag that
  // follows, so the skip branch could not recognise the chip it had just walked past and rewrote its innards.
  return String(html).replace(/(<(?:code|pre|a)\b[\s\S]*?<\/(?:code|pre|a)>)|>([^<]*)(?=<)/gi, function (whole, skip, text) {
    if (skip || !text) return whole;
    return '>' + text.replace(/[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,8}(?::\d+)?/g, function (name) {
      var bare = name.replace(/:\d+$/, '');
      // Only a name this project actually has becomes a link. Anything else — a version, a domain, a file
      // from somewhere else entirely — is prose, and stays prose.
      return PATH_CODE_EXT.test(bare) && resolveBareFileName(bare) ? pathCodeHtml(name, 'span') : name;
    });
  });
}
// The closing fence is OPTIONAL: a diagram runs to the end of the note when nothing closes it. An agent
// dropping the final ``` is the commonest way this text arrives malformed, and the old pattern — which
// demanded both fences — answered it by matching nothing, so markdown-it rendered the mermaid SOURCE as a
// code block. The reviewer got `flowchart TD` as literal text, the agent then noticed and posted a second
// note re-drawing it, and the thread kept all three: a broken diagram, an apology, and the real one. A
// diagram is the last thing in a note far more often than not, so treating end-of-note as a close costs
// nothing and removes the whole failure.
function annotationBodyHtml(text) {
  var parts = String(text || '').split(/^```mermaid\s*$([\s\S]*?)(?:^```\s*$|$(?![\s\S]))/m);
  var html = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) html += mermaidPlaceholderHtml(parts[i].trim());
    else if (parts[i].trim()) html += linkifyBareFileNames(linkifyPathCode(renderMarkdownHtml(parts[i])));
  }
  return html;
}

// Same .mc-card shell as a review comment, because it IS one — written by the agent instead of by the
// reviewer. The kind pill says who wrote it; a tinted background (viewer.css) says the same thing at a
// glance, so a long thread reads as an alternating conversation without having to parse every pill.
// A note may mark itself as one of the few places the change actually turns on (comments-file.ts). ONE mark,
// not two: "the problem" and "the fix" asked the reader to hold a distinction while reading, and it bought
// nothing — what a note says is already in the note, and the only thing worth adding beside it is whether
// this is a place to stop. Notes written under the old two values still carry the mark; the pill just no
// longer tries to tell them apart. An unknown role degrades to no role rather than an empty pill.

// Only a role the card knows how to draw survives the trip: anything else an agent invents would otherwise
// reach agentCardHtml as a class name and a missing translation. "key" is the one written now; the older
// "problem"/"fix" still read back as the same single mark.
var NOTE_ROLES = { key: 1, problem: 1, fix: 1 };

// Same .mc-card shell as a review comment, because it IS one — written by an agent instead of by the
// reviewer. The kind pill says who wrote it; a tinted background (viewer.css) says the same thing at a
// glance, so a long thread reads as an alternating conversation without having to parse every pill.
function agentCardHtml(c) {
  var isReply = c.replyTo != null;
  var role = !isReply && NOTE_ROLES[c.role] ? 'key' : '';
  return '<div class="mc-card mc-ai' + (isReply ? ' mc-reply-card' : '') + (role ? ' mc-role-' + role : '') + '">'
    + '<div class="mc-card-head"><span class="mc-kind mc-kind-ai">' + annotationKindIcon()
    + '<span class="mc-kind-text">' + escapeHtml(t(isReply ? 'comment.answer' : 'annotate.kind')) + '</span></span>'
    + (role ? '<span class="mc-role">' + escapeHtml(t('annotate.role.key')) + '</span>' : '')
    + (c.title ? '<span class="mc-ai-title">' + escapeHtml(c.title) + '</span>' : '')
    + commentTargetHeadHtml(c)
    + '<button type="button" class="mc-del" data-keyhint="Del" data-seq="' + c.seq + '"'
    + ' aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">×</button>'
    + '</div>'
    + '<div class="mc-card-body markdown-body mc-ai-body">' + annotationBodyHtml(c.text)
    + '</div></div>';
}
// A lightbulb, in the same monochrome stroke style as commentKindIcon()'s speech bubble.
function annotationKindIcon() {
  return '<svg class="mc-kind-ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1V16h6v-1c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3z"/></svg>';
}
