// ===== The Explain briefing, shown once as a panel whose beak points at the file to start in.
//
// The explanation was always there and nobody met it. Notes hang off lines, so they are found by WALKING, and
// the walk had no visible start — what a reviewer saw on opening a review was a diff with no context. This is
// that start: after a new explain-diff run, the first time the diff is on screen, the briefing note the prompt
// already asks for is put in front of the reader with a beak on the sidebar row of the file the change is
// about.
//
// It does NOT replace the inline notes (F8 still walks them) and it does NOT summarise anything — the note it
// shows is the same note the diff shows, read through a different window. Once per run, then never again
// unless asked: "브리핑 다시 보기" in the sidebar, or ⌘⇧B.
//
// briefingReady is the boot latch. 05-keymap.js's closing `syncRail()` runs BEFORE this slice (and before
// 23-annotations.js) has executed a single statement, so at that moment EXPLAIN_RUNS_KEY is still undefined
// and "have I shown this?" would read as no. The flag turns true at the bottom of this file, and the rAF
// there is the real boot pass, once every slice has run and the diff has painted.
var briefingReady = false;
var briefingPage = 0;
var briefingWaitTimer = 0; // set while the panel is held back for a terminal being typed into
// The three pages are a fixed structure (the prompt writes exactly these), so the eyebrow is ours to name and
// the agent only has to write the sentence under it. A note that came back with no `##` headings at all —
// an old briefing, or a run that ignored the shape — is one page and gets the generic label.
var BRIEFING_KICKERS = ['briefing.p1', 'briefing.p2', 'briefing.p3'];

// The notes THIS workspace's latest Explain run wrote. Not every note on screen: notes live in the
// repository's shared knowledge file now and arrive in every worktree whose tree has the file they name
// (notesForWorkspace, comments-file.ts), so "every note here" includes what other worktrees have explained —
// and a briefing about someone else's task, opening itself over your diff, is worse than no briefing.
//
// The run boundary already says which notes are ours: markExplainRunStarting records the high-water mark
// before the agent writes, so everything past it is what the run put there (23-annotations.js). A workspace
// that has never run Explain has no boundary, and therefore no briefing — which is the right answer, not a
// missing one.
function briefingRunNotes() {
  var runs = readExplainRuns();
  if (!runs || typeof runs.last !== 'number') return [];
  return annotationList().filter(function (c) { return c.seq > runs.last; });
}
// The first note of the walk, among this run's own. Not "the note carrying a role": the walk's order IS the
// reading order (sortedNavComments), and whatever stands first in it is what the reader starts from.
function briefingNote() {
  var runs = readExplainRuns();
  if (!runs || typeof runs.last !== 'number') return null;
  var walk = annotationWalk();
  for (var i = 0; i < walk.length; i++) if (walk[i].seq > runs.last) return walk[i];
  return null;
}

// One note, three pages, split on its `##` headings — the heading is the page's title. Anything written above
// the first heading is not dropped: it joins page one, because a note that opens with a sentence before its
// structure is still saying something.
function briefingPages(note) {
  var text = String((note && note.text) || '');
  var parts = text.split(/^##[ \t]+/m);
  var lead = parts.shift() || '';
  if (!parts.length) return [{ title: (note && note.title) || '', body: lead }];
  var pages = parts.map(function (chunk) {
    var nl = chunk.indexOf('\n');
    return nl < 0
      ? { title: chunk.trim(), body: '' }
      : { title: chunk.slice(0, nl).trim(), body: chunk.slice(nl + 1) };
  });
  if (lead.trim()) pages[0].body = lead.trim() + '\n\n' + pages[0].body;
  return pages;
}

function briefingChangeRows() {
  return Array.prototype.slice.call(document.querySelectorAll('#changes-panel .change-row[data-file]'));
}
// An agent names a file the way a person does — `07-comments.js`, not the repo-relative path the sidebar rows
// carry. Exact match first so two files of the same basename cannot swap places, then a trailing-segment
// match, which is what the short form actually means.
function briefingRowForPath(path) {
  var want = String(path || '').replace(/:\d+$/, '');
  if (!want) return null;
  var rows = briefingChangeRows(), tail = null;
  for (var i = 0; i < rows.length; i++) {
    var file = rows[i].dataset.file || '';
    if (file === want) return rows[i];
    if (!tail && file.length > want.length && file.slice(-(want.length + 1)) === '/' + want) tail = rows[i];
  }
  return tail;
}
// Which row the beak lands on. The briefing's own `path` is the first answer and usually the right one — but
// the prompt deliberately hangs that note on the line where the problem HAPPENS, which is often a line this
// diff never touched, and a file the diff never touched has no row in the Changes list. Then the notes marked
// as key say where the change actually turns, and the file carrying most of them is where to start reading.
function briefingAnchorRow() {
  var rows = briefingChangeRows();
  if (!rows.length) return null;
  var note = briefingNote();
  var row = note && briefingRowForPath(note.path);
  if (row) return row;
  // Only files that HAVE a row can win: the whole point of this fallback is to find something to point at, and
  // the briefing's own path already failed that test — the marked notes on files the diff never touched would
  // fail it the same way, and one of them outvoting a file that is actually on screen puts the beak nowhere.
  var counts = {}, best = null, top = 0;
  briefingRunNotes().forEach(function (c) {
    if (!NOTE_ROLES[c.role] || !c.path || !briefingRowForPath(c.path)) return;
    counts[c.path] = (counts[c.path] || 0) + 1;
  });
  Object.keys(counts).forEach(function (p) { if (counts[p] > top) { top = counts[p]; best = p; } });
  return (best && briefingRowForPath(best)) || rows[0];
}

// The beak lands ON the row, measured from the row's own box. The panel's height is FIXED in the CSS and that
// is what makes this arithmetic hold: a panel sized by its content grows on the page carrying the diagrams,
// walks off the row it is pointing at, and the reader has to re-find what it was ever about. It also cannot
// outgrow the window — an unbounded panel pushed `top` negative and the beak then pointed at nothing at all.
//
// A row below the fold in a forty-file review is scrolled to first (`nearest`, so a visible row never moves
// and the panel never jumps). With the sidebar collapsed or the Files tab open there is no box to point at,
// and a beak aimed at nothing is worse than no beak: the panel centres itself and drops it.
function placeBriefing() {
  var pop = document.getElementById('mc-briefing');
  var row = briefingAnchorRow();
  if (!pop) return;
  if (row && row.scrollIntoView) { try { row.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  var r = row ? row.getBoundingClientRect() : null;
  if (!r || !r.width) {
    pop.classList.add('mc-brf-nobeak');
    pop.style.left = '';
    pop.style.top = '';
    return;
  }
  pop.classList.remove('mc-brf-nobeak');
  var anchor = r.top + r.height / 2;
  var h = pop.offsetHeight;
  var top = Math.min(Math.max(anchor - h * 0.34, 16), Math.max(16, window.innerHeight - h - 16));
  pop.style.left = (r.right + 18) + 'px';
  pop.style.top = top + 'px';
  pop.style.setProperty('--mc-brf-beak', (anchor - top) + 'px');
}

// Two strengths, never one. The beak points at exactly one file and that row is lit hard, with a ring; the
// files the page NAMES are lit faintly and underlined, and only the one under the cursor comes up to meet it.
// Same strength for both would leave "where do I look?" with two answers.
//
// Only on the last page. Pages one and two are about what went wrong and how it was bent back — a lit row
// there answers a question the reader has not asked yet, and by the time the page that IS about files arrives
// it has been lit so long it has stopped meaning anything. The names come from the page's own inline code
// paths (linkifyPathCode, 23-annotations.js), so nothing new has to be declared to mark a file.
function markBriefingFiles(lit) {
  briefingChangeRows().forEach(function (r) {
    r.classList.remove('mc-brf-aim', 'mc-brf-mark', 'mc-brf-hot');
  });
  if (!lit) return;
  var anchor = briefingAnchorRow();
  if (anchor) anchor.classList.add('mc-brf-aim');
  var body = document.querySelector('#mc-briefing .mc-brf-body');
  if (!body) return;
  body.querySelectorAll('code.mc-path-code').forEach(function (code) {
    // dataset.path — a folded path's textContent carries the (…) and the hidden directory both.
    var row = briefingRowForPath(code.dataset.path || code.textContent || '');
    if (!row) return;
    row.classList.add('mc-brf-mark');
    var on = function () { row.classList.add('mc-brf-hot'); };
    var off = function () { row.classList.remove('mc-brf-hot'); };
    code.addEventListener('mouseenter', on);
    code.addEventListener('mouseleave', off);
  });
}

function renderBriefing() {
  var pop = document.getElementById('mc-briefing');
  var note = briefingNote();
  if (!pop || !note) return;
  var pages = briefingPages(note);
  if (briefingPage >= pages.length) briefingPage = pages.length - 1;
  if (briefingPage < 0) briefingPage = 0;
  var page = pages[briefingPage];
  var last = briefingPage === pages.length - 1;
  var kicker = pages.length > 1 && BRIEFING_KICKERS[briefingPage] ? BRIEFING_KICKERS[briefingPage] : 'briefing.kind';
  pop.querySelector('.mc-brf-kind').textContent = t(kicker);
  var of = pop.querySelector('.mc-brf-of');
  of.textContent = (briefingPage + 1) + ' / ' + pages.length;
  of.classList.toggle('hidden', pages.length < 2);
  pop.querySelector('.mc-brf-h').textContent = page.title || note.title || '';
  var body = pop.querySelector('.mc-brf-body');
  body.innerHTML = annotationBodyHtml(page.body);
  body.scrollTop = 0;
  try { renderMermaidDiagrams(body); } catch (e) {}
  pop.querySelector('.mc-brf-dots').innerHTML = pages.map(function (p, i) {
    return '<button type="button" class="mc-brf-dot" data-brf-page="' + i + '"'
      + (i === briefingPage ? ' aria-current="true"' : '')
      + ' aria-label="' + escapeHtml((i + 1) + ' / ' + pages.length + ' · ' + (p.title || '')) + '"></button>';
  }).join('');
  pop.querySelector('[data-brf="-1"]').disabled = briefingPage === 0;
  pop.querySelector('[data-brf="1"]').textContent = t(last ? 'briefing.close' : 'briefing.next');
  markBriefingFiles(last);
  placeBriefing();
}

function briefingPanelHtml() {
  return '<div class="mc-brf-top">'
    + '<div class="mc-brf-kicker"><span class="mc-brf-kind"></span><span class="mc-brf-of"></span></div>'
    + '<h2 class="mc-brf-h"></h2>'
    + '</div>'
    + '<div class="mc-brf-body markdown-body mc-ai-body"></div>'
    + '<div class="mc-brf-foot">'
    + '<div class="mc-brf-dots" role="tablist"></div><span class="mc-brf-sp"></span>'
    + '<button type="button" class="mc-brf-go mc-brf-quiet" data-brf="-1">' + escapeHtml(t('briefing.prev')) + '</button>'
    + '<button type="button" class="mc-brf-go" data-brf="1"></button>'
    + '</div>';
}

// Seen the moment it is PUT UP, not the moment it is dismissed. The one thing this must never become is a
// notice board that reappears every time a window opens, and a reader who closes it without finishing has
// still met the explanation — which was the entire problem. Missing it is recoverable; the sidebar button and
// ⌘⇧B both bring it back. The flag is the briefing note's own seq, so a NEW run writes a new briefing with a
// new seq and shows itself without anything having to be cleared.
function briefingSeenSeq() {
  var runs = readExplainRuns();
  return runs && typeof runs.seen === 'number' ? runs.seen : 0;
}
function markBriefingSeen(seq) {
  var runs = readExplainRuns() || {};
  runs.seen = seq;
  persistSave(EXPLAIN_RUNS_KEY, runs);
}

function openBriefing() {
  var note = briefingNote();
  if (!note) { showCaretHint(t('annotate.nav.none')); return; }
  if (document.getElementById('mc-briefing')) return;
  var scrim = document.createElement('div');
  scrim.className = 'mc-brf-scrim';
  scrim.id = 'mc-briefing-scrim';
  scrim.addEventListener('click', closeBriefing);
  var pop = document.createElement('div');
  pop.className = 'mc-brf';
  pop.id = 'mc-briefing';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('briefing.title'));
  pop.innerHTML = briefingPanelHtml();
  pop.addEventListener('click', onBriefingClick);
  document.body.appendChild(scrim);
  document.body.appendChild(pop);
  briefingPage = 0;
  renderBriefing();
  markBriefingSeen(note.seq);
}

function closeBriefing() {
  var pop = document.getElementById('mc-briefing');
  var scrim = document.getElementById('mc-briefing-scrim');
  if (pop) pop.remove();
  if (scrim) scrim.remove();
  markBriefingFiles(false);
}

function toggleBriefing() {
  if (document.getElementById('mc-briefing')) closeBriefing();
  else openBriefing();
}

function briefingStep(delta) {
  var note = briefingNote();
  if (!note) return;
  var pages = briefingPages(note);
  var next = briefingPage + delta;
  if (next >= pages.length) { closeBriefing(); return; } // the last page's "next" is the way out
  if (next < 0) return;
  briefingPage = next;
  renderBriefing();
}

function onBriefingClick(event) {
  var target = event.target;
  if (!target || !target.closest) return;
  // A path in the prose navigates (the document-level handler in 08-dock.js does that part) — so get out of
  // the way of the file it just opened rather than sitting on top of it.
  if (target.closest('.mc-path-code')) { closeBriefing(); return; }
  var dot = target.closest('[data-brf-page]');
  if (dot) { briefingPage = Number(dot.dataset.brfPage); renderBriefing(); return; }
  var go = target.closest('[data-brf]');
  if (go && !go.disabled) briefingStep(Number(go.dataset.brf));
}

// Registered in KEY_OWNERS (05-keymap.js) above the caret surfaces: while the panel is up the arrows page it,
// which is what a reader with three pages in front of them expects them to do.
function handleBriefingKey(event) {
  if (!document.getElementById('mc-briefing')) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  // The panel can arrive on its own, mid-sentence, while a comment composer or the terminal has focus — the
  // agent finishing its notes is exactly when someone is still typing at it. Paging keys are only ours when
  // nothing is being written into.
  var focused = document.activeElement;
  if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.isContentEditable)) return false;
  if (event.key === 'Escape') closeBriefing();
  else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === 'Enter') briefingStep(1);
  else if (event.key === 'ArrowLeft' || event.key === 'PageUp') briefingStep(-1);
  else return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

// Called from syncRail (09-views-update.js) — one hook covers both moments that matter: notes arriving
// (applyThreadRecords syncs the rail) and the diff coming into view. Everything it does is idempotent, so
// being called thirteen ways costs nothing.
function syncBriefing() {
  var note = briefingNote();
  var recall = document.getElementById('mc-briefing-recall');
  if (recall) recall.classList.toggle('hidden', !note);
  if (!briefingReady || !note) return;
  if (document.getElementById('mc-briefing')) return;
  if (!isDiffViewVisible() || briefingSeenSeq() === note.seq) return;
  // Everything says open it — but not into the middle of a syllable. A panel arriving over a pane being typed
  // at is exactly the DOM change macOS answers by committing a half-built 가 as ㄱ ㅏ, and the moment this
  // fires is the moment the agent finished writing its notes: precisely when someone is still at its prompt.
  // Every other agent-driven render already waits this out (refreshCommentsWhenNotTyping, 09-views-update.js)
  // and a briefing is in no hurry. The retry only runs while a briefing is genuinely pending, so it stops as
  // soon as it opens rather than polling for the life of the window.
  if (terminalTypingAgeMs() < TERMINAL_TYPING_IDLE_MS) {
    if (!briefingWaitTimer) {
      briefingWaitTimer = setTimeout(function () { briefingWaitTimer = 0; syncBriefing(); }, TERMINAL_TYPING_IDLE_MS);
    }
    return;
  }
  openBriefing();
}

window.addEventListener('resize', function () {
  if (document.getElementById('mc-briefing')) placeBriefing();
});
document.getElementById('mc-briefing-recall')?.addEventListener('click', toggleBriefing);
briefingReady = true;
requestAnimationFrame(syncBriefing);
