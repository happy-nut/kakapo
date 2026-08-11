// ===== Explain (⌘7): an AI walks the diff and drops explanatory note cards on the lines that matter
// ("why is this here?", explained for a beginner), which render inline exactly where a review comment would.
//
// A note is NOT a separate store any more: it is a comment whose author is the agent (`by: 'agent'`,
// `kind: 'note'`), living in the same list, the same file and the same thread rows as everything else the
// review says (comments-file.ts). A reviewer's question, an agent's answer and an agent's note differ only in
// who wrote them and what they hang off — keeping three shapes for that meant three sync paths, three
// lifetimes, and a reply that could not cross from one to another.
//
// What is left here is the note's own rendering (markdown + Mermaid + path links) and the ⌘7 prompt.

var annotationsPath = ''; // the thread file the Explain prompt tells the agent to append to

// Agent-written notes: the root cards the agent left on its own, not answers to anything.
function annotationList() {
  if (typeof reviewComments === 'undefined' || !Array.isArray(reviewComments)) return [];
  return reviewComments.filter(function (c) { return c.by === 'agent' && c.replyTo == null; });
}

// Markdown body with ```mermaid fences lifted out into real diagrams. Splitting before the markdown pass
// (rather than post-processing markdown-it's <pre><code class="language-mermaid">) keeps the diagram source
// away from the syntax highlighter, which would otherwise mangle it into spans.
// A path an agent names in prose — `app/optimization/domain/campaign_control.py` — is a place the reader wants
// to go, so make it one (openPathReference in 07-comments.js resolves and jumps on click). Only inline code
// that actually looks like a file path is marked: a symbol (`get_context`), a route template
// (`/campaigns/{id}/lessons`) and a number (`0.5`) all fail the extension test and stay plain text. Fenced
// blocks are untouched — their <code> carries a class and highlight spans, so `[^<]+` never matches one.
function linkifyPathCode(html) {
  return String(html).replace(/<code>([^<]+)<\/code>/g, function (whole, text) {
    return text.length < 200 && /^[A-Za-z0-9_@.\-/]+\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?$/.test(text)
      ? '<code class="mc-path-code" title="' + escapeHtml(t('comment.openPath')) + '">' + text + '</code>'
      : whole;
  });
}
function annotationBodyHtml(text) {
  var parts = String(text || '').split(/^```mermaid\s*$([\s\S]*?)^```\s*$/m);
  var html = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) html += mermaidPlaceholderHtml(parts[i].trim());
    else if (parts[i].trim()) html += linkifyPathCode(renderMarkdownHtml(parts[i]));
  }
  return html;
}

// Same .mc-card shell as a review comment, because it IS one — written by the agent instead of by the
// reviewer. The kind pill carries the authorship, the way it already does for a question vs a change request;
// a second visual language for "this one came from the agent" only made one timeline read as two.
function agentCardHtml(c) {
  var target = commentTargetLabel(c);
  var isReply = c.replyTo != null;
  return '<div class="mc-card mc-ai' + (isReply ? ' mc-reply-card' : '') + '">'
    + '<div class="mc-card-head"><span class="mc-kind mc-kind-ai">' + annotationKindIcon()
    + '<span class="mc-kind-text">' + escapeHtml(t(isReply ? 'comment.answer' : 'annotate.kind')) + '</span></span>'
    + (c.title ? '<span class="mc-ai-title">' + escapeHtml(c.title) + '</span>' : '')
    + '<span class="mc-target" title="' + escapeHtml(target) + '">' + escapeHtml(target) + '</span>'
    // An explanation is the start of a conversation as often as the end of one: "why this way?", "then what
    // about X?". Reply continues it in the same thread instead of making the reviewer find the line again.
    + '<button type="button" class="mc-reply" data-seq="' + c.seq + '"'
    + ' aria-label="' + escapeHtml(t('comment.reply')) + '" title="' + escapeHtml(t('comment.reply')) + '">\u21a9</button>'
    + '<button type="button" class="mc-del" data-keyhint="Del" data-seq="' + c.seq + '"'
    + ' aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">\u00d7</button>'
    + '</div>'
    + '<div class="mc-card-body markdown-body mc-ai-body">' + annotationBodyHtml(c.text) + '</div></div>';
}
// A lightbulb, in the same monochrome stroke style as commentKindIcon()'s question/pencil glyphs.
function annotationKindIcon() {
  return '<svg class="mc-kind-ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1V16h6v-1c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3z"/></svg>';
}

// ----- the prompt itself: a settings-editable default, same shape as loadMergePrompts() (08-dock.js) -----
var annotatePromptKey = 'kakapo-annotate-prompt';
function defaultAnnotatePrompt() { return t('annotate.prompt.default'); }
function loadAnnotatePrompt() {
  var b = persistRead(annotatePromptKey);
  if (typeof b === 'string' && b.trim()) return b;
  try { var ls = localStorage.getItem(annotatePromptKey); if (ls && ls.trim()) return ls; } catch (e) {}
  return defaultAnnotatePrompt();
}
function saveAnnotatePrompt(text) { persistSave(annotatePromptKey, text || ''); }
function currentAnnotatePromptText() {
  return loadAnnotatePrompt().split('{{NOTES_PATH}}').join(annotationsPath || '');
}

// The other editable prompt: map the WHOLE repository rather than explain one diff. Same storage shape as
// the annotate prompt above, and the same output contract — it writes the same annotations.json, so its map
// and its component notes land on the code as ordinary notes, navigable with F8 and answerable like any
// other card. The difference is what it is asked to look at, not what it produces.
var codebasePromptKey = 'kakapo-codebase-prompt';
function defaultCodebasePrompt() { return t('codebase.prompt.default'); }
function loadCodebasePrompt() {
  var b = persistRead(codebasePromptKey);
  if (typeof b === 'string' && b.trim()) return b;
  try { var ls = localStorage.getItem(codebasePromptKey); if (ls && ls.trim()) return ls; } catch (e) {}
  return defaultCodebasePrompt();
}
function saveCodebasePrompt(text) { persistSave(codebasePromptKey, text || ''); }
function currentCodebasePromptText() {
  return loadCodebasePrompt().split('{{NOTES_PATH}}').join(annotationsPath || '');
}

// ----- running it (⌘7 / the Explain rail button): stage the prompt in the terminal composer, the same
// review-before-it-runs step every other prompt hand-off uses (sendPromptToTerminal, 24-prompt-palette.js).
function runAnnotatePrompt() {
  if (typeof sendPromptToTerminal === 'function') sendPromptToTerminal(currentAnnotatePromptText());
}
