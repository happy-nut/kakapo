// ===== Prompt palette (⌘⇧P): browse the saved agent prompts, pick one, send it to the integrated
// terminal. Read-only by design — editing stays in Settings ▸ Prompts, which is where the textareas,
// autosave, and reset-to-defaults already live. This is the "use it" half of that pair. =====
//
// Reuses the .quick-open / .quick-open-panel / .quick-open-item CSS wholesale (the same way the Usages
// popup does), so the palette needs no chrome of its own — only the small list + key handling below.

// Only the prompts a human actually SENDS on purpose. The questions heading, the change-request
// instructions, and the plan contract are all prepended automatically to the merged hand-off (07-comments.js)
// — listing them here would offer a second, redundant way to deliver text the agent already receives.
//
// Each entry resolves its text lazily: a prompt edited in Settings must be current when the palette opens,
// and the {{...}} placeholders (spec/notes paths) are only known once a workspace is loaded.
function promptPaletteEntries() {
  return [
    { id: 'annotate', title: t('annotatePrompt.title'), text: currentAnnotatePromptText },
    { id: 'explain', title: t('explainPrompt.title'), text: currentExplainPromptText },
  ];
}

var promptPaletteItems = [];
var promptPaletteActive = 0;

function isPromptPaletteOpen() {
  var box = document.getElementById('prompt-palette');
  return !!(box && !box.classList.contains('hidden'));
}
function openPromptPalette() {
  var box = document.getElementById('prompt-palette');
  if (!box) return;
  promptPaletteItems = promptPaletteEntries();
  promptPaletteActive = 0;
  renderPromptPalette();
  box.classList.remove('hidden');
}
function closePromptPalette() {
  var box = document.getElementById('prompt-palette');
  if (box) box.classList.add('hidden');
}
function togglePromptPalette() { if (isPromptPaletteOpen()) closePromptPalette(); else openPromptPalette(); }

// One-line gist of each prompt so the list is scannable without opening Settings: the first non-empty line,
// clipped. The full text is what gets sent — this is a label, not a preview pane.
function promptPaletteSummary(text) {
  var first = String(text || '').split('\n').filter(function (l) { return l.trim(); })[0] || '';
  return first.length > 140 ? first.slice(0, 140) + '…' : first;
}
function renderPromptPalette() {
  var results = document.getElementById('prompt-palette-results');
  if (!results) return;
  results.innerHTML = promptPaletteItems.map(function (item, index) {
    var summary = promptPaletteSummary(item.text());
    return '<button type="button" class="quick-open-item prompt-palette-item' + (index === promptPaletteActive ? ' active' : '') + '" data-index="' + index + '">'
      + '<span class="prompt-palette-name">' + escapeHtml(item.title) + '</span>'
      + '<span class="prompt-palette-summary">' + escapeHtml(summary) + '</span>'
      + '</button>';
  }).join('');
  updatePromptPaletteActive();
}
function updatePromptPaletteActive() {
  var results = document.getElementById('prompt-palette-results');
  if (!results) return;
  var items = results.querySelectorAll('.prompt-palette-item');
  for (var i = 0; i < items.length; i++) {
    var on = i === promptPaletteActive;
    items[i].classList.toggle('active', on);
    if (on && items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
  }
}
// Enter hands the prompt to the terminal's send mode (the same staging step ⌥⏎ uses everywhere else), so it
// lands in the composer for review rather than executing behind the user's back.
function sendPromptPaletteSelection() {
  var item = promptPaletteItems[promptPaletteActive];
  closePromptPalette();
  if (!item) return;
  if (!window.__kakapoTerminal || typeof window.__kakapoTerminal.enterSendMode !== 'function') {
    if (copyTextToClipboard(item.text()) && typeof showToast === 'function') showToast(t('explain.copied'));
    return;
  }
  window.__kakapoTerminal.enterSendMode(item.text());
}
function handlePromptPaletteKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); closePromptPalette(); return true; }
  if (event.key === 'ArrowDown') { event.preventDefault(); promptPaletteActive = Math.min(promptPaletteActive + 1, promptPaletteItems.length - 1); updatePromptPaletteActive(); return true; }
  if (event.key === 'ArrowUp') { event.preventDefault(); promptPaletteActive = Math.max(promptPaletteActive - 1, 0); updatePromptPaletteActive(); return true; }
  if (event.key === 'Enter') { event.preventDefault(); sendPromptPaletteSelection(); return true; }
  return false;
}

(function wirePromptPalette() {
  var box = document.getElementById('prompt-palette');
  if (!box) return;
  box.addEventListener('click', function (event) {
    if (event.target === box) { closePromptPalette(); return; }
    var item = event.target.closest && event.target.closest('.prompt-palette-item');
    if (!item) return;
    promptPaletteActive = parseInt(item.dataset.index, 10) || 0;
    sendPromptPaletteSelection();
  });
})();
