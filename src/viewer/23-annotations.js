// ===== Explain: an AI walks the diff and drops explanatory note cards on the lines that matter
// ("why is this here?", explained for a beginner), which render inline exactly where a review comment would.
//
// A note is NOT a separate store any more: it is a comment whose author is the agent (`by: 'agent'`,
// `kind: 'note'`), living in the same list, the same file and the same thread rows as everything else the
// review says (comments-file.ts). A reviewer's question, an agent's answer and an agent's note differ only in
// who wrote them and what they hang off — keeping three shapes for that meant three sync paths, three
// lifetimes, and a reply that could not cross from one to another.
//
// What is left here is the note's own rendering (markdown + Mermaid + path links) and the Explain prompt.

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
var NOTE_ROLES = { key: 1, problem: 1, fix: 1 };
// The walk, in the order the explanation was built: group first, then append order inside a group
// (sortedNavComments). Note 1 is the briefing the Explain prompt asks for — nothing here privileges
// `role`, so a note that skips its group number simply sorts to the back with the rest.
function annotationWalk() {
  return sortedNavThread().filter(function (x) { return x.by === 'agent' && x.replyTo == null; });
}
// Cards used to carry their place in the walk — "4/7". It read as "the 4th of 7 comments", which is not what
// it counted: F8 also stops at the reviewer's own comments, and the sidebar counts something different again.
// Three numbers for one review, none of them agreeing, and the one on the card was the loudest. The prev/next
// buttons below say the same thing the badge was for — there is an order, and it goes this way — without
// claiming a total that nothing else on screen shares.
function noteIsInWalk() {
  return annotationWalk().length > 1; // one note is not a walk
}
// Prev/next on the card itself, once the agent has put the notes in an order. The keys have always existed
// and were never on screen — and a key you have to already know is not a control. They sit at the head's
// right edge, quiet until the card is hovered, and each names the key it stands for so using the mouse once
// teaches the keyboard for every time after.
function walkStepButtonsHtml() {
  return '<span class="mc-walk-nav">'
    + '<button type="button" class="mc-walk-step" data-walk="-1" data-keyhint="\u21e7F8" aria-label="'
      + escapeHtml(t('walk.prev')) + '" title="' + escapeHtml(t('walk.prev')) + '">\u2039</button>'
    + '<button type="button" class="mc-walk-step" data-walk="1" data-keyhint="F8" aria-label="'
      + escapeHtml(t('walk.next')) + '" title="' + escapeHtml(t('walk.next')) + '">\u203a</button>'
    + '</span>';
}

function agentCardHtml(c) {
  var isReply = c.replyTo != null;
  var role = !isReply && NOTE_ROLES[c.role] ? 'key' : '';
  var inWalk = !isReply && noteIsInWalk();
  return '<div class="mc-card mc-ai' + (isReply ? ' mc-reply-card' : '') + (role ? ' mc-role-' + role : '') + '">'
    + '<div class="mc-card-head"><span class="mc-kind mc-kind-ai">' + annotationKindIcon()
    + '<span class="mc-kind-text">' + escapeHtml(t(isReply ? 'comment.answer' : 'annotate.kind')) + '</span></span>'
    + (inWalk ? walkStepButtonsHtml() : '')
    + (role ? '<span class="mc-role">' + escapeHtml(t('annotate.role.key')) + '</span>' : '')
    + (c.title ? '<span class="mc-ai-title">' + escapeHtml(c.title) + '</span>' : '')
    + commentTargetHeadHtml(c)
    + '<button type="button" class="mc-del" data-keyhint="Del" data-seq="' + c.seq + '"'
    + ' aria-label="' + escapeHtml(t('composer.delete')) + '" title="' + escapeHtml(t('composer.delete')) + '">\u00d7</button>'
    + '</div>'
    + '<div class="mc-card-body markdown-body mc-ai-body">' + annotationBodyHtml(c.text)
    + '</div></div>';
}
// A lightbulb, in the same monochrome stroke style as commentKindIcon()'s speech bubble.
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
  return fillPromptPaths(loadAnnotatePrompt());
}
// The two paths every explanation prompt needs: where its notes go, and where the reader's own words are
// (26-terms.js). The vocabulary is read-only to an agent — it is the reader's language, not a scratchpad —
// so the prompt only ever hands over the path to read.
// What this review is actually comparing, in git's own words, so the agent explains the diff the reader is
// looking at rather than the one `git diff` happens to print. They are frequently not the same: a review can
// be a patch-set range, an A→B compare picked in History (shift-select), or an incoming change — in every one
// of those the working tree is clean and an agent left to run `git diff` sees nothing at all and says so.
function reviewDiffRange() {
  var data = typeof patchSetData !== 'undefined' ? patchSetData : null;
  if (!data) return '';
  var base = data.activeBase && data.activeBase !== 'auto' ? data.activeBase : (data.branchPoint || '');
  var target = data.activeTarget && data.activeTarget !== 'worktree' ? data.activeTarget : '';
  if (!base) return '';
  return target ? base + '..' + target : base + '..HEAD';
}

function fillPromptPaths(text) {
  // The vocabulary is no longer one of these. It used to be pasted in as a file path, which put the words
  // and the rules for using them in two different places — the rules in the prompt, the capability in a
  // path — and meant every prompt had to re-explain the file. `kakapo_words` carries both: its description
  // IS the rule, and it travels with the tool into every session, including the ones kakapo never wrote a
  // prompt for (mcp-server.ts).
  var range = reviewDiffRange();
  return String(text)
    .split('{{NOTES_PATH}}').join(annotationsPath || '')
    .split('{{DIFF_RANGE}}').join(range ? 'git diff ' + range : 'git diff');
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
  return fillPromptPaths(loadCodebasePrompt());
}

// The third prompt: not about a diff or a repository, but about the conversation the reader just had in the
// terminal. Nothing in kakapo reads that conversation — the agent that held it does, and it is the one that
// can tell a word the reader took in from a word it merely said. Same vocabulary file, same one rule: the
// words are the reader's.
function currentTermsPromptText() {
  return fillPromptPaths(t('terms.prompt.default'));
}

// ----- running it (the ⌘⇧P palette, or the Explain rail button with nothing to open yet): stage the
// prompt in the terminal composer, the same
// review-before-it-runs step every other prompt hand-off uses (sendPromptToTerminal, 24-prompt-palette.js).
// Sending an explanation is only worth doing when there is something to explain. A review with no changed
// files — a clean worktree with nothing unpushed and nothing incoming — used to take the prompt anyway, and
// the reviewer waited on an agent that would come back with nothing to say. Refuse where it can be said, at
// the moment of the keystroke, instead of ten seconds later in a terminal.
//
// Returns false when it refused, which is what the launcher checks before handing the text over.
function startExplainRun() {
  if (!reviewHasChanges()) {
    showToast(t('annotate.nothingToExplain'));
    return false;
  }
  markExplainRunStarting();
  return true;
}
// Whatever the review is comparing — the working tree, a patch-set range, several commits shift-picked in
// History — the answer is the same: are there files in the Changes list.
function reviewHasChanges() {
  return document.querySelectorAll('#changes-panel .change-row[data-file]').length > 0;
}
function runAnnotatePrompt() {
  if (!startExplainRun()) return;
  runPrompt(promptEntry('annotate'), currentAnnotatePromptText());
}

// ----- one explanation at a time -------------------------------------------------------------------------
// An explanation is about ONE change. The notes file is shared and append-only, so a second run used to land
// on top of the first: seven notes, four of them about a diff that had already been merged, and both runs
// numbering their groups from 1 — so the walk read them as one story and stepped from this change into an
// old one without saying so. A new explanation therefore supersedes the last one.
//
// Superseded, not "everything that was here": the window is the previous RUN's notes, so a codebase map (the
// other prompt that writes root notes) is not swept up by an Explain. The first run under this code records
// its boundary and prunes nothing — there is no way to know which of the existing notes an older kakapo
// wrote, and deleting on a guess is not worth the one run it would save.
//
// A note somebody REPLIED to is not superseded at all. It stopped being an explanation the moment it became a
// conversation, and a question and its answer outlive the diff they were about.
// Scoped to THIS review, like every other per-review key (COMMENTS_KEY, viewedKey, treeOpenKey …). It was one
// app-wide value, and notes are no longer app-wide: they live in the repository's shared knowledge file and
// arrive in every worktree whose tree has the file (notesForWorkspace, comments-file.ts). So an Explain run
// started in one worktree moved the boundary for all of them — the next run somewhere else then pruned against
// a window it never wrote, and the briefing this boundary identifies was whatever some other worktree had
// explained last. A run belongs to the workspace it was started in.
var EXPLAIN_RUNS_KEY = 'kakapo-explain-runs:' + location.pathname;
// persistRead answers from the Electron settings bridge and nothing else, so outside the app it returns
// undefined for everything ever written. Same localStorage fallback the merge prompts use — without it this
// boundary is forgotten between the send and the notes arriving, and no run ever supersedes another.
function readExplainRuns() {
  var runs = persistRead(EXPLAIN_RUNS_KEY);
  if (runs && typeof runs === 'object') return runs;
  try { var raw = localStorage.getItem(EXPLAIN_RUNS_KEY); if (raw) return JSON.parse(raw); } catch (e) {}
  return null;
}
function maxNoteSeq() {
  return annotationList().reduce(function (max, c) { return Math.max(max, c.seq || 0); }, 0);
}
function markExplainRunStarting() {
  var high = maxNoteSeq();
  var runs = readExplainRuns();
  var last = (runs && typeof runs.last === 'number') ? runs.last : high; // first run: keep what is already here
  // `seen` (25-briefing.js) rides along untouched: dropping it here would put the OLD briefing back on screen
  // in the gap between sending the prompt and the new notes arriving.
  persistSave(EXPLAIN_RUNS_KEY, { prev: last, last: high, seen: runs && runs.seen });
}
// Called as records arrive (applyThreadRecords). The trigger is the first note of the new run, not the send:
// a run that is cancelled, or never pasted into the terminal, must cost nothing.
function pruneSupersededNotes() {
  var runs = readExplainRuns();
  if (!runs || typeof runs.last !== 'number' || typeof runs.prev !== 'number') return;
  var notes = annotationList();
  if (!notes.some(function (c) { return c.seq > runs.last; })) return; // the new run has not written yet
  var replied = {};
  reviewComments.forEach(function (c) { if (c.replyTo != null) replied[c.replyTo] = true; });
  var stale = notes
    .filter(function (c) { return c.seq > runs.prev && c.seq <= runs.last && !replied[c.seq]; })
    .map(function (c) { return c.seq; });
  persistSave(EXPLAIN_RUNS_KEY, { prev: runs.last, last: runs.last, seen: runs.seen });
  if (stale.length) removeComments(stale); // one batch, so one Cmd+Z brings the old explanation back
}
