// ===== Prompts (⌘⇧P): the saved agent prompts, listed in the ⌘E launcher's Prompts section and sent
// to the integrated terminal. Read-only by design — editing stays in Settings ▸ Prompts, where the
// textareas, autosave, and reset-to-defaults already live. This is the "use it" half of that pair.
// The list, its keys and its chrome all belong to the launcher now (03-quick-open.js); what stays here
// is what a prompt IS and what sending one means. =====

// Only the prompts a human actually SENDS on purpose. The questions heading, the change-request
// instructions, and the plan contract are all prepended automatically to the merged hand-off (07-comments.js)
// — listing them here would offer a second, redundant way to deliver text the agent already receives.
//
// Each entry resolves its text lazily: a prompt edited in Settings must be current when the palette opens,
// and the {{...}} placeholders (spec/notes paths) are only known once a workspace is loaded.
function promptPaletteEntries() {
  return [
    { id: 'annotate', title: t('annotatePrompt.title'), text: currentAnnotatePromptText },
  ];
}

// Hand `text` to the terminal's send mode (the same staging step ⌥⏎ uses everywhere else), so it lands in
// the composer for review rather than executing behind the user's back. Falls back to the clipboard where
// there is no integrated terminal (the CLI's browser viewer). Also the ⌘7 Explain entry point — see
// runAnnotatePrompt (23-annotations.js).
function sendPromptToTerminal(text) {
  if (window.__kakapoTerminal && typeof window.__kakapoTerminal.enterSendMode === 'function') {
    window.__kakapoTerminal.enterSendMode(text);
    return;
  }
  if (copyTextToClipboard(text) && typeof showToast === 'function') showToast(t('explain.copied'));
}

// One-line gist of each prompt so the list is scannable without opening Settings: the first non-empty line,
// clipped. The full text is what gets sent — this is a label, not a preview pane.
function promptPaletteSummary(text) {
  var first = String(text || '').split('\n').filter(function (l) { return l.trim(); })[0] || '';
  return first.length > 140 ? first.slice(0, 140) + '…' : first;
}
