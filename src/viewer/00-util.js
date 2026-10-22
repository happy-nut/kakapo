// Shared string/format utilities for the viewer. These are used by ~16 slices but had historically lived in
// 11-render-http.js (the HTTP-client slice), which made "view a source file" span slices 10 and 11 and hid a
// general helper inside a feature module. They're plain hoisted function declarations, so moving them here is
// location-only in the concatenated global scope — every caller still resolves them by name.

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

// Text the user has selected right now, '' when nothing is. Both code views paint a FAKE caret — a span
// spliced into the line's text nodes — and repainting it re-splits those nodes, which destroys any live
// selection anchored in them. A drag ends with a click, so the click handler that places the caret was
// wiping the selection the drag had just made, in the diff and in the source view alike. A click that
// arrives on top of a range selection is the tail of a drag, not a request to move the caret.
function selectedText() {
  var sel = window.getSelection && window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return '';
  return String(sel);
}

// The client's twin of leafNameHtml() in render-tree.ts. The virtual source tree builds the same row the
// server builds, so a name split in only one of them would read differently depending on whether you had
// scrolled far enough for virtualization to take over. Keep the two in agreement.
function leafNameHtml(name) {
  var dot = String(name).indexOf('.', 1);
  if (dot <= 0 || dot === name.length - 1) return '<span class="path-head">' + escapeHtml(name) + '</span>';
  return '<span class="path-head">' + escapeHtml(name.slice(0, dot)) + '</span>'
    + '<span class="path-tail">' + escapeHtml(name.slice(dot)) + '</span>';
}

// Keep Tab inside a modal surface.
//
// Four of this app's surfaces declare aria-modal="true" and none of them held the key that makes that
// claim true: Tab walked straight out of the dock and out of Settings into the sidebar behind the dim
// backdrop — which is click-blocked, so what you reached could be seen, announced and focused, but not
// used. (That is also a one-way trip: the way back in is a mouse.)
//
// Returns true when it handled the key, so a caller can stop there.
function tabbablesWithin(root) {
  var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),'
    + ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.prototype.slice.call(root.querySelectorAll(sel)).filter(function (el) {
    // Hidden the way this app hides things: a `.hidden` class on the element or an ancestor (USER_FLOWS
    // calls this out — view visibility is class-based here). Asking the layout instead (offsetParent)
    // would have been the obvious spelling and the wrong one: it is null for EVERYTHING under jsdom, so
    // the trap would have quietly degraded to "no tabbables" in every test that covers it, which is the
    // same blindness that let a dialog render 0x0 for several releases.
    return !el.closest('.hidden') && !el.hasAttribute('disabled');
  });
}
function trapTabWithin(root, event) {
  if (!root || event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return false;
  var items = tabbablesWithin(root);
  if (!items.length) {
    // Nothing to land on, but the surface still owns the key — otherwise Tab leaves and cannot come back.
    event.preventDefault();
    if (root.focus) root.focus();
    return true;
  }
  var first = items[0];
  var last = items[items.length - 1];
  var at = items.indexOf(document.activeElement);
  // -1 covers both "focus is outside" and "focus is on something inside that is not itself tabbable" —
  // a comment card is tabindex -1, and Tab from one used to leave the panel entirely.
  if (at < 0) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return true; }
  if (!event.shiftKey && at === items.length - 1) { event.preventDefault(); first.focus(); return true; }
  if (event.shiftKey && at === 0) { event.preventDefault(); last.focus(); return true; }
  return false;
}

// `jrt:/…!/java.base/java/time/Instant.class` -> `java.base/java/time/Instant.class`. The twin of
// externalLocationLabel in src/lsp.ts: the renderer names these targets without the main process's help,
// and what is in front of the `!` is where the archive sits on this machine, which says nothing about the
// symbol. Kept in step by test/app-boundaries.test.mjs.
function externalLocationLabel(uri) {
  var text = String(uri || '');
  var bang = text.indexOf('!/');
  if (bang < 0) return text.replace(/^[a-z]+:\/*/i, '');
  var inner = text.slice(bang + 2);
  var archive = text.slice(0, bang).split('/').pop() || '';
  return /\.(jar|zip)$/i.test(archive) ? archive + ' / ' + inner : inner;
}
