// The overview stripe: every change in the open file as one column beside the scrollbar, plus a box
// showing where in the file you currently are. IntelliJ calls it the error stripe; the question it answers
// is the one a scrollbar cannot — "how much of this file changed, and where is the rest of it" — which in a
// review is the first thing you want to know about a file you just opened.
//
// Marks are drawn for change runs and for comment threads. A run, not a line: a twelve-line hunk is one
// thing a reviewer goes to, and twelve marks a pixel apart are a smear rather than a map.

var diffStripeRaf = 0;

function diffStripeScroller() {
  return document.getElementById('diff2html-container');
}

/** The stripe element, created on first use beside the diff scroller (never inside it — it must not scroll). */
function diffStripeElement() {
  var scroller = diffStripeScroller();
  if (!scroller || !scroller.parentElement) return null;
  var stripe = document.getElementById('diff-stripe');
  if (stripe) return stripe;
  stripe = document.createElement('div');
  stripe.id = 'diff-stripe';
  stripe.className = 'diff-stripe hidden';
  stripe.innerHTML = '<div class="diff-stripe-viewport" aria-hidden="true"></div>';
  stripe.setAttribute('role', 'presentation');
  scroller.parentElement.appendChild(stripe);
  // A click is "take me there": the fraction of the stripe clicked is the fraction of the file wanted,
  // centred rather than put at the top, because what you aimed at is a mark and you want to see around it.
  stripe.addEventListener('click', function (event) {
    var host = diffStripeScroller();
    if (!host) return;
    var rect = stripe.getBoundingClientRect();
    var fraction = rect.height ? (event.clientY - rect.top) / rect.height : 0;
    host.scrollTop = Math.max(0, fraction * host.scrollHeight - host.clientHeight / 2);
  });
  return stripe;
}

function scheduleDiffStripe() {
  if (diffStripeRaf) return;
  diffStripeRaf = requestAnimationFrame(function () {
    diffStripeRaf = 0;
    renderDiffStripe();
  });
}

/** The code cell of a side-by-side row — the one carrying the change classes, not the line-number cell. */
function diffStripeCodeCell(row) {
  return row
    ? row.querySelector('td:not(.d2h-code-side-linenumber):not(.d2h-code-linenumber)')
    : null;
}

/**
 * Collects the change runs and comment threads of the open file.
 *
 * BOTH sides are read, by row index, because the new side alone cannot tell a modification from an
 * addition: in side-by-side markup a modified line is `d2h-ins` on the right and `d2h-del` on the left,
 * and a plain addition is `d2h-ins` on the right with a placeholder on the left. diff2html marks a matched
 * pair with `d2h-change`, which is the fact that distinguishes them. The two sides are index-aligned (the
 * same assumption the diff's own scroll alignment is built on).
 *
 * Reading the classes is free; geometry is not, so only the FIRST and LAST row of each run are measured.
 * A file of four hundred changed lines is a handful of runs, which is a handful of layout reads.
 */
function diffStripeMarks(wrapper, scroller) {
  var newSide = diffSideTable(wrapper, 'new');
  var oldSide = diffSideTable(wrapper, 'old');
  if (!newSide) return [];
  var newRows = newSide.querySelectorAll('tr');
  var oldRows = oldSide ? oldSide.querySelectorAll('tr') : [];
  var marks = [];
  var runKind = '';
  var runRows = [];
  var flush = function () {
    if (runKind && runRows.length) {
      var first = runRows[0].getBoundingClientRect();
      var last = runRows[runRows.length - 1].getBoundingClientRect();
      marks.push({ kind: runKind, top: first.top, height: Math.max(1, last.bottom - first.top) });
    }
    runKind = '';
    runRows = [];
  };
  for (var i = 0; i < newRows.length; i++) {
    var row = newRows[i];
    if (row.classList.contains('mc-comment-row')) {
      flush();
      var rect = row.getBoundingClientRect();
      marks.push({ kind: 'comment', top: rect.top, height: Math.max(1, rect.height) });
      continue;
    }
    var newCell = diffStripeCodeCell(row);
    var oldCell = diffStripeCodeCell(i < oldRows.length ? oldRows[i] : null);
    var kind = '';
    if ((newCell && newCell.classList.contains('d2h-change')) || (oldCell && oldCell.classList.contains('d2h-change'))) kind = 'change';
    else if (newCell && newCell.classList.contains('d2h-ins')) kind = 'ins';
    else if (oldCell && oldCell.classList.contains('d2h-del')) kind = 'del';
    if (!kind) { flush(); continue; }
    // A deletion run immediately followed by an insertion run is one edit to the reader, so a run whose
    // kind changes becomes a "change" rather than two marks a pixel apart.
    if (runKind && runKind !== kind) runKind = 'change';
    else if (!runKind) runKind = kind;
    runRows.push(row);
  }
  flush();
  // Positions are viewport-relative so far; turn them into fractions of the whole scrollable content.
  var scrollerRect = scroller.getBoundingClientRect();
  var total = Math.max(1, scroller.scrollHeight);
  return marks.map(function (mark) {
    return {
      kind: mark.kind,
      start: Math.min(1, Math.max(0, (mark.top - scrollerRect.top + scroller.scrollTop) / total)),
      size: Math.min(1, mark.height / total),
    };
  });
}

/**
 * Puts the stripe over the scroller's box — the pane also holds a toolbar, and the scroller's height
 * changes with the window. `offsetWidth - clientWidth` is the vertical scrollbar: where one takes space
 * (Windows, Linux, and macOS when "always show" is set) the stripe sits beside it rather than under it.
 */
function placeDiffStripe(stripe, scroller) {
  stripe.style.top = scroller.offsetTop + 'px';
  stripe.style.height = scroller.clientHeight + 'px';
  stripe.style.right = Math.max(0, scroller.offsetWidth - scroller.clientWidth) + 'px';
}

/**
 * Where in the file the reader is — the only part that moves while scrolling.
 *
 * Reads three properties, then writes two styles, and deliberately does NOT re-place the stripe: writing a
 * style and then reading a layout property forces a synchronous layout, and this runs on every scroll
 * frame. The stripe's own box is placed when the diff is rendered and when the window resizes.
 */
function updateDiffStripeViewport() {
  var stripe = document.getElementById('diff-stripe');
  var scroller = diffStripeScroller();
  if (!stripe || !scroller || stripe.classList.contains('hidden')) return;
  var box = stripe.querySelector('.diff-stripe-viewport');
  if (!box) return;
  var total = Math.max(1, scroller.scrollHeight);
  box.style.top = (100 * scroller.scrollTop / total) + '%';
  box.style.height = Math.max(2, 100 * scroller.clientHeight / total) + '%';
}

function renderDiffStripe() {
  var stripe = diffStripeElement();
  if (!stripe) return;
  var scroller = diffStripeScroller();
  var wrapper = diffActiveWrapper();
  if (!scroller || !wrapper || !isDiffViewVisible()) { stripe.classList.add('hidden'); return; }
  var marks = diffStripeMarks(wrapper, scroller);
  // Nothing to map: a file with no changes on screen (a hunkless file, an unreadied lazy body) gets no
  // ruler rather than an empty one, which would read as "this file has no changes".
  if (!marks.length) { stripe.classList.add('hidden'); return; }
  stripe.classList.remove('hidden');
  var html = '<div class="diff-stripe-viewport" aria-hidden="true"></div>';
  for (var i = 0; i < marks.length; i++) {
    html += '<span class="diff-stripe-mark is-' + marks[i].kind + '"'
      + ' style="top:' + (100 * marks[i].start).toFixed(3) + '%;height:' + Math.max(0.4, 100 * marks[i].size).toFixed(3) + '%"></span>';
  }
  stripe.innerHTML = html;
  placeDiffStripe(stripe, scroller);
  updateDiffStripeViewport();
}

(function wireDiffStripe() {
  var scroller = diffStripeScroller();
  if (scroller) {
    // Scrolling moves the viewport box only — no re-measure, so this stays a style write per frame.
    scroller.addEventListener('scroll', updateDiffStripeViewport, { passive: true });
  }
  // A window resize changes both the content height and the stripe's own, so the marks move.
  window.addEventListener('resize', scheduleDiffStripe);
})();
