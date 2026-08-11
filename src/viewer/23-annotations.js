// ===== Explain (⌘7): an AI walks the diff and drops explanatory note cards on the lines that matter
// ("why is this here?", explained for a beginner), which render inline exactly where a human review comment
// would. The agent writes annotations.json (see app-annotations-ipc.ts); main watches it. =====
//
// This IS the Explain feature — there is no separate document view. An earlier version rendered an
// agent-written content spec into its own full-page panel; explaining a change is worth more attached to the
// code it explains than parked in a second surface the reader has to hold beside the diff.
//
// A SEPARATE store from reviewComments (07-comments.js): these are the agent talking TO the reviewer, not
// review feedback going back to the agent. Mixing them into reviewComments would leak them into the merged
// prompt, the answers.json checklist, the per-file comment badges, and localStorage — every one of which
// would need an exclusion. Rendering hooks into threadHtml()/relevantLines() instead, so annotations ride
// the existing thread-row placement for free in both the diff and the source view.
//
// The note list is replaced wholesale on every file write (never merged) and is NOT persisted here — it
// lives in annotations.json, and main serves it back on reload. Notes are read-only: no editing, no delete;
// re-running the prompt regenerates them.

var aiNotes = [];
var annotationsPath = '';

// 07-comments.js is concatenated BEFORE this slice and calls the three accessors below. Function
// declarations hoist, but `var aiNotes = []` does not — so an early refreshComments() (during another
// slice's top-level init) would otherwise read undefined. Every reader goes through this.
function annotationList() { return Array.isArray(aiNotes) ? aiNotes : []; }
function annotationsAt(path, line) {
  return annotationList().filter(function (n) { return n.path === path && n.line === line; });
}
function annotationLines(path, set) {
  annotationList().forEach(function (n) { if (n.path === path) set[n.line] = true; });
}
// Folded into renderDiffComments's per-file render key so a fresh annotation actually repaints a wrapper
// whose review comments did not change.
function annotationRenderKey(path) {
  return annotationList().filter(function (n) { return n.path === path; })
    .map(function (n) { return n.line + ':' + n.text.length; }).join(',');
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

// Same .mc-card shell as a review comment (so the two read as one timeline), minus every control — there is
// nothing to delete, reopen, or reply to on a note the agent regenerates each round.
function annotationCardHtml(note) {
  var target = '@' + note.path + '#L' + note.line;
  return '<div class="mc-card mc-ai">'
    + '<div class="mc-card-head"><span class="mc-kind mc-kind-ai">' + annotationKindIcon()
    + '<span class="mc-kind-text">' + escapeHtml(t('annotate.kind')) + '</span></span>'
    + (note.title ? '<span class="mc-ai-title">' + escapeHtml(note.title) + '</span>' : '')
    + '<span class="mc-target" title="' + escapeHtml(target) + '">' + escapeHtml(target) + '</span>'
    // An explanation is the start of a conversation as often as it is the end of one: "why this way?",
    // "then what about X?". Reply continues it in the same thread, on the same line, instead of making the
    // reviewer find the line again and write what reads as an unrelated new comment.
    + '<button type="button" class="mc-reply mc-ai-reply" data-path="' + escapeHtml(note.path) + '" data-line="' + note.line + '"'
    + ' aria-label="' + escapeHtml(t('comment.reply')) + '" title="' + escapeHtml(t('comment.reply')) + '">↩</button>'
    // Deletable like any other card in this timeline. It reaches the FILE (see kakapo:annotations-delete):
    // the list is re-read from annotations.json every tick, so a renderer-only delete would come back.
    + '<button type="button" class="mc-del mc-ai-del" data-path="' + escapeHtml(note.path) + '" data-line="' + note.line + '"'
    + ' aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">×</button>'
    + '</div>'
    + '<div class="mc-card-body markdown-body mc-ai-body">' + annotationBodyHtml(note.text) + '</div></div>';
}
// A lightbulb, in the same monochrome stroke style as commentKindIcon()'s question/pencil glyphs.
function annotationKindIcon() {
  return '<svg class="mc-kind-ic" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.7.5 1.1V16h6v-1c0-.4.1-.8.5-1.1A6 6 0 0 0 12 3z"/></svg>';
}
function annotationsThreadHtml(path, line) {
  return annotationsAt(path, line).map(annotationCardHtml).join('');
}

// ----- store sync: main pushes the whole list whenever annotations.json changes -----
function setAnnotations(notes) {
  aiNotes = (Array.isArray(notes) ? notes : []).map(function (n) {
    return {
      path: String((n && n.path) || ''),
      line: Math.max(1, parseInt(n && n.line, 10) || 1),
      title: n && n.title ? String(n.title) : '',
      text: String((n && n.text) || ''),
    };
  }).filter(function (n) { return n.path && n.text; });
  // Agent-driven, so the re-render yields to a terminal being typed into (see refreshCommentsWhenNotTyping).
  if (typeof refreshCommentsWhenNotTyping === 'function') { try { refreshCommentsWhenNotTyping(); } catch (e) {} }
  if (typeof syncRail === 'function') { try { syncRail(); } catch (e) {} } // the Explain rail icon lights up once notes exist
}
function requestAnnotations() {
  if (!window.kakapoAnnotations || typeof window.kakapoAnnotations.read !== 'function') return;
  window.kakapoAnnotations.read().then(function (result) {
    if (!result) return;
    annotationsPath = result.path || '';
    if (result.notes && result.notes.length) setAnnotations(result.notes);
  }).catch(function () {});
}
if (window.kakapoAnnotations && typeof window.kakapoAnnotations.onUpdate === 'function') {
  window.kakapoAnnotations.onUpdate(function (payload) { setAnnotations(payload && payload.notes); });
}
requestAnnotations();

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


// Notes in file order, merged into the review timeline by sortedNavThread (07-comments.js) so F8 walks them
// alongside the reviewer's own comments. File order comes from the diff, not from the order the agent
// happened to emit them in.
function sortedAnnotations() {
  var order = typeof commentNavOrder === 'function' ? commentNavOrder() : {};
  function rank(n) { return n.path in order ? order[n.path] : Infinity; }
  return annotationList().slice().sort(function (a, b) { return rank(a) - rank(b) || a.line - b.line; });
}

// Dismiss a note: main rewrites annotations.json without it and pushes the new list straight back, so the
// card goes as the click lands rather than a poll tick later. The text is part of the match so two notes on
// one line stay distinguishable.
function deleteAnnotation(path, line) {
  var note = aiNotes.filter(function (n) { return n.path === path && n.line === line; })[0];
  if (!note || !window.kakapoAnnotations || typeof window.kakapoAnnotations.remove !== 'function') return;
  aiNotes = aiNotes.filter(function (n) { return n !== note; }); // optimistic: the card leaves now
  if (typeof refreshComments === 'function') { try { refreshComments(); } catch (e) {} }
  Promise.resolve(window.kakapoAnnotations.remove({ path: note.path, line: note.line, text: note.text }))
    .catch(function () { requestAnnotations(); }); // put it back if the file could not be written
}
