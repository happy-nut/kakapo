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
// What ending makes something a FILE and not an attribute chain. A shape-only test — "path characters, then a
// dot, then 1-8 letters" — cannot tell them apart: `advisor.study_summary.search_space.params` is built from
// nothing but path-legal characters and ends in a short lowercase word, so it was underlined as a file and
// clicked through to nowhere. Every dotted accessor an agent names in prose (`config.database.pool.size`,
// `state.user.profile.name`) had the same problem. The extension is the only part that actually distinguishes
// them, so it has to be a known one. Mirrors languageForPath (util.ts) plus the data/config/doc files agents
// name in prose; a suffix missing here degrades to plain text, which is what it looked like before it was
// ever a link.
var PATH_CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonl|css|scss|sass|less|html|htm|xml|svg|md|mdx|py|pyi|rb|php|go|rs|java|kt|kts|sh|bash|zsh|fish|yml|yaml|toml|ini|cfg|conf|env|sql|txt|csv|tsv|lock|proto|graphql|gql|vue|svelte|astro|c|h|cc|cpp|hpp|cs|swift|m|mm|scala|clj|ex|exs|erl|lua|r|jl|dart|zig|nim|hs|ml|vim|dockerfile|gradle|properties)$/i;

// A path an agent names in prose — `app/optimization/domain/campaign_control.py` — is a place the reader wants
// to go, so make it one (openPathReference in 07-comments.js resolves and jumps on click). Only inline code
// that actually looks like a file path is marked: a symbol (`get_context`), a route template
// (`/campaigns/{id}/lessons`), a number (`0.5`) and an attribute chain (`advisor.study_summary.params`) all
// fail and stay plain text. Fenced blocks are untouched — their <code> carries a class and highlight spans,
// so `[^<]+` never matches one.
function linkifyPathCode(html) {
  return String(html).replace(/<code>([^<]+)<\/code>/g, function (whole, text) {
    var bare = text.replace(/:\d+$/, ''); // a trailing :42 is a line number, not part of the name
    return text.length < 200 && /^[A-Za-z0-9_@.\-/]+$/.test(bare) && PATH_CODE_EXT.test(bare)
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
// reviewer. The kind pill says who wrote it; a tinted background (viewer.css) says the same thing at a
// glance, so a long thread reads as an alternating conversation without having to parse every pill.
function agentCardHtml(c) {
  var target = commentTargetLabel(c);
  var isReply = c.replyTo != null;
  return '<div class="mc-card mc-ai' + (isReply ? ' mc-reply-card' : '') + '">'
    + '<div class="mc-card-head"><span class="mc-kind mc-kind-ai">' + annotationKindIcon()
    + '<span class="mc-kind-text">' + escapeHtml(t(isReply ? 'comment.answer' : 'annotate.kind')) + '</span></span>'
    + (c.title ? '<span class="mc-ai-title">' + escapeHtml(c.title) + '</span>' : '')
    + '<span class="mc-target" title="' + escapeHtml(target) + '">' + escapeHtml(target) + '</span>'
    + '<button type="button" class="mc-del" data-keyhint="Del" data-seq="' + c.seq + '"'
    + ' aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">\u00d7</button>'
    + '</div>'
    + '<div class="mc-card-body markdown-body mc-ai-body">' + annotationBodyHtml(c.text)
    + (c.steps && c.steps.length ? tourStartHtml(c) : '') + '</div></div>';
}
// A note that carries a walkthrough says so where it is read, and starting it is one click. The card holds
// only this button: the walkthrough itself plays in the floating tour overlay (see below), because its steps
// can leave this file and take the card with them.
function tourStartHtml(c) {
  return '<button type="button" class="mc-tour-start" data-seq="' + c.seq + '">'
    + '<span class="mc-tour-start-ic">▶</span>'
    + escapeHtml(t('tour.start').replace('{n}', String(c.steps.length))) + '</button>';
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

// ===== The walkthrough: a note whose explanation is a PATH through the code =====
// Some answers are not a paragraph anchored to one line — they are several places that only make sense in
// order (a request crossing layers, a value written here and read there). Such a note carries `steps`, and
// kakapo plays them: the code view jumps to each stop and highlights its lines while that step's text is on
// screen, so the reader WATCHES the path being walked instead of reading a description of it.
//
// The player is a floating overlay rather than something inside the note card, and that is the whole reason
// it works: a step may land in another file, which unmounts the card the button was pressed in. The overlay
// outlives the view it is driving.
// Assigned below; read by the KEY_OWNERS table in 05-keymap.js, which loads first and tests it with `typeof`.
var handleTourKey, startNoteTour;
(function () {
  var tour = null; // { steps, index, title, playing, timer, el }

  // How long a step stays up while playing. Proportional to what there is to read (a two-word step and a
  // three-sentence one are not the same beat), clamped so neither extreme becomes annoying.
  function dwellFor(text) {
    return Math.max(3000, Math.min(12000, 2500 + String(text || '').length * 45));
  }

  // Paint the step's lines wherever the code is currently shown. Both views are handled because the same note
  // is read in both: an Explain-the-diff note in the diff, a codebase-map note in the source view.
  // ponytail: a 400-line "step" is a step that wasn't thought through; painting stops there rather than
  // walking the whole file. Raise the cap if a real note ever needs it.
  function paintBand(path, from, to) {
    document.querySelectorAll('.mc-tour-line').forEach(function (el) { el.classList.remove('mc-tour-line'); });
    var last = Math.min(to, from + 400);
    var painted = 0;
    var body = document.getElementById('source-body');
    var viewer = document.getElementById('source-viewer');
    if (body && viewer && !viewer.classList.contains('hidden') && viewer.dataset.openPath === path) {
      for (var line = from; line <= last; line++) {
        var row = body.querySelector('.source-row[data-line-index="' + (line - 1) + '"]');
        if (row) { row.classList.add('mc-tour-line'); painted++; }
      }
      return painted;
    }
    var wrapper = typeof diffWrapperByPath === 'function' ? diffWrapperByPath(path) : null;
    if (!wrapper) return 0;
    // One pass over the side's rows, not one lookup per line: a range of 40 lines would otherwise re-scan the
    // whole file 40 times for what a single walk answers.
    ['new', 'old'].forEach(function (side) {
      if (painted) return; // the new side is the one a reader is following; only fall back when it has none
      diffRowsOf(diffSideTable(wrapper, side)).forEach(function (row) {
        var n = diffLineNumber(row);
        if (n >= from && n <= last) { row.classList.add('mc-tour-line'); painted++; }
      });
    });
    return painted;
  }

  // Move the code view to a step. The diff is tried first when it is what's on screen — a note written about
  // a diff should walk the diff, not throw the reader into the source view halfway through.
  function gotoStep(step) {
    var path = step.path;
    if (typeof isDiffViewVisible === 'function' && isDiffViewVisible()
      && typeof navigateToLineInDiff === 'function' && navigateToLineInDiff(path, step.line, 'new')) return;
    if (typeof navigateToLine === 'function') navigateToLine(path, step.line);
  }

  // The band is painted after the navigation has actually landed — a lazily-loaded file body materializes a
  // frame or two later, and painting into the old DOM would highlight nothing (or, worse, the previous file's
  // rows). Retry for a few frames, then give up quietly: a missing highlight is a cosmetic loss, and the step
  // text and the caret have already done the real work.
  function paintWhenReady(step, tries) {
    if (!tour) return;
    if (paintBand(step.path, step.line, step.to || step.line) || tries > 12) return;
    requestAnimationFrame(function () { paintWhenReady(step, tries + 1); });
  }

  function renderTour() {
    if (!tour) return;
    var step = tour.steps[tour.index];
    tour.el.querySelector('.mc-tour-count').textContent = (tour.index + 1) + ' / ' + tour.steps.length;
    tour.el.querySelector('.mc-tour-body').innerHTML = annotationBodyHtml(step.text);
    if (typeof renderMermaidDiagrams === 'function') renderMermaidDiagrams(tour.el);
    var play = tour.el.querySelector('.mc-tour-play');
    play.textContent = tour.playing ? '\u2016' : '\u25b6'; // ‖ / ▶ — plain glyphs, not emoji, so they match the rest of the chrome
    play.title = t(tour.playing ? 'tour.pause' : 'tour.play');
    tour.el.querySelector('.mc-tour-prev').disabled = tour.index === 0;
    tour.el.querySelector('.mc-tour-next').disabled = tour.index === tour.steps.length - 1;
    tour.el.querySelector('.mc-tour-bar').style.width = ((tour.index + 1) / tour.steps.length * 100) + '%';
  }

  function schedule() {
    if (tour.timer) { clearTimeout(tour.timer); tour.timer = 0; }
    if (!tour.playing) return;
    // The last step ENDS the walkthrough instead of looping back to the first — the same reason F7 stops at
    // the last change: a tour that restarts silently is indistinguishable from one that never finished.
    if (tour.index >= tour.steps.length - 1) { tour.playing = false; renderTour(); return; }
    tour.timer = setTimeout(function () { go(tour.index + 1); }, dwellFor(tour.steps[tour.index].text));
  }

  function go(index) {
    if (!tour) return;
    tour.index = Math.max(0, Math.min(index, tour.steps.length - 1));
    var step = tour.steps[tour.index];
    renderTour();
    gotoStep(step);
    paintWhenReady(step, 0);
    schedule();
  }

  function closeTour() {
    if (!tour) return;
    if (tour.timer) clearTimeout(tour.timer);
    document.querySelectorAll('.mc-tour-line').forEach(function (el) { el.classList.remove('mc-tour-line'); });
    tour.el.remove();
    tour = null;
  }

  function buildOverlay(title) {
    var el = document.createElement('div');
    el.className = 'mc-tour';
    el.id = 'mc-tour';
    el.innerHTML = '<div class="mc-tour-head">' + annotationKindIcon()
      + '<span class="mc-tour-title"></span><span class="mc-tour-count"></span>'
      + '<button type="button" class="mc-tour-close" data-keyhint="Esc" title="' + escapeHtml(t('tour.close')) + '" aria-label="' + escapeHtml(t('tour.close')) + '">×</button></div>'
      + '<div class="mc-tour-body markdown-body mc-ai-body"></div>'
      + '<div class="mc-tour-foot"><button type="button" class="mc-tour-prev" data-keyhint="←" title="' + escapeHtml(t('tour.prev')) + '" aria-label="' + escapeHtml(t('tour.prev')) + '">‹</button>'
      + '<button type="button" class="mc-tour-play"></button>'
      + '<button type="button" class="mc-tour-next" data-keyhint="→" title="' + escapeHtml(t('tour.next')) + '" aria-label="' + escapeHtml(t('tour.next')) + '">›</button>'
      + '<span class="mc-tour-track"><span class="mc-tour-bar"></span></span></div>';
    el.querySelector('.mc-tour-title').textContent = title || t('tour.title');
    el.querySelector('.mc-tour-close').addEventListener('click', closeTour);
    el.querySelector('.mc-tour-prev').addEventListener('click', function () { pauseAnd(tour.index - 1); });
    el.querySelector('.mc-tour-next').addEventListener('click', function () { pauseAnd(tour.index + 1); });
    el.querySelector('.mc-tour-play').addEventListener('click', function () {
      tour.playing = !tour.playing;
      // Pressing play on the last step means "watch it again", not "sit here": there is nowhere forward to go.
      if (tour.playing && tour.index >= tour.steps.length - 1) { go(0); return; }
      renderTour();
      schedule();
    });
    document.body.appendChild(el);
    return el;
  }
  // Stepping by hand is a decision to read this one, so it stops the clock — otherwise the reader is fighting
  // an auto-advance they just overrode.
  function pauseAnd(index) {
    if (!tour) return;
    tour.playing = false;
    go(index);
  }

  // Entry point: the ▶ button on a note card that carries steps.
  startNoteTour = function (seq) {
    var note = reviewComments.find(function (c) { return c.seq === seq; });
    if (!note || !note.steps || !note.steps.length) return;
    closeTour();
    tour = { steps: note.steps, index: 0, playing: true, timer: 0, el: buildOverlay(note.title) };
    go(0);
  };

  // A live walkthrough owns the arrows: they are how you walk it, and the caret they would otherwise move is
  // being driven by the tour anyway. Everything else falls through untouched (see KEY_OWNERS, 05-keymap.js).
  handleTourKey = function (event) {
    if (!tour) return false;
    if (event.key === 'Escape') { event.preventDefault(); closeTour(); return true; }
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); pauseAnd(tour.index + 1); return true; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); pauseAnd(tour.index - 1); return true; }
    return false;
  };
})();
