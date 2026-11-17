
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

function selectedText() {
  var sel = window.getSelection && window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return '';
  return String(sel);
}

function leafNameHtml(name) {
  var dot = String(name).indexOf('.', 1);
  if (dot <= 0 || dot === name.length - 1) return '<span class="path-head">' + escapeHtml(name) + '</span>';
  return '<span class="path-head">' + escapeHtml(name.slice(0, dot)) + '</span>'
    + '<span class="path-tail">' + escapeHtml(name.slice(dot)) + '</span>';
}

function tabbablesWithin(root) {
  var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),'
    + ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.prototype.slice.call(root.querySelectorAll(sel)).filter(function (el) {
    if (el.closest('.hidden') || el.hasAttribute('disabled')) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    return true;
  });
}
function trapTabWithin(root, event) {
  if (!root || event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return false;
  var items = tabbablesWithin(root);
  if (!items.length) {
    event.preventDefault();
    if (root.focus) root.focus();
    return true;
  }
  var first = items[0];
  var last = items[items.length - 1];
  var at = items.indexOf(document.activeElement);
  if (at < 0) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return true; }
  if (!event.shiftKey && at === items.length - 1) { event.preventDefault(); first.focus(); return true; }
  if (event.shiftKey && at === 0) { event.preventDefault(); last.focus(); return true; }
  return false;
}

function externalLocationLabel(uri) {
  var text = String(uri || '');
  var bang = text.indexOf('!/');
  if (bang < 0) return text.replace(/^[a-z]+:\/*/i, '');
  var inner = text.slice(bang + 2);
  var archive = text.slice(0, bang).split('/').pop() || '';
  return /\.(jar|zip)$/i.test(archive) ? archive + ' / ' + inner : inner;
}

function applyBranchChip(element, branch) {
  if (!element) return;
  var name = String(branch || '');
  element.title = name;
  element.textContent = '';
  var cut = name.lastIndexOf('/');
  if (cut < 0 || cut === name.length - 1) {
    var only = document.createElement('span');
    only.className = 'branch-tail';
    only.textContent = name;
    element.appendChild(only);
    return;
  }
  var head = document.createElement('span');
  head.className = 'branch-head';
  head.textContent = name.slice(0, cut + 1);
  var tail = document.createElement('span');
  tail.className = 'branch-tail';
  tail.textContent = name.slice(cut + 1);
  element.appendChild(head);
  element.appendChild(tail);
}

function pageAlive() {
  return typeof document !== 'undefined' && !!document && typeof document.getElementById === 'function';
}

var overlayFocusReturn = null;

function rememberOverlayFocus(overlay) {
  if (overlay && overlay.classList && !overlay.classList.contains('hidden')) return;
  var active = typeof document !== 'undefined' && document ? document.activeElement : null;
  if (!active || active === document.body) { overlayFocusReturn = null; return; }
  if (overlay && overlay.contains && overlay.contains(active)) return;
  overlayFocusReturn = active;
}

function focusReadingSurface() {
  var tryFocus = function (el) {
    if (!el || typeof el.focus !== 'function') return false;
    el.tabIndex = -1;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (ignore) {} }
    return document.activeElement === el;
  };
  if (tryFocus(document.getElementById('source-body'))) return true;
  return tryFocus(document.getElementById('diff2html-container'));
}

function restoreOverlayFocus(overlay, wasOpen) {
  var held = typeof wasOpen === 'boolean'
    ? wasOpen
    : !!(overlay && overlay.classList && !overlay.classList.contains('hidden'));
  var target = overlayFocusReturn;
  overlayFocusReturn = null;
  if (!held) return false;
  if (target && target.isConnected && typeof target.focus === 'function'
      && !(overlay && overlay.contains && overlay.contains(target))) {
    try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (ignore) {} }
    if (document.activeElement === target) return true;
  }
  return focusReadingSurface();
}
