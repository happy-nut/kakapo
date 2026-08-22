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
