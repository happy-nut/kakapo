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
    // `onSend` is what makes a run a RUN. Sending the explain prompt has to record the note high-water mark
    // (markExplainRunStarting) or the next run's notes land on top of the last one's: the walk still starts at
    // the old briefing, which has already been seen, so the new briefing never opens and F8 steps through two
    // explanations of two different changes. The rail's Explain button did this and the launcher did not —
    // and the launcher is how the prompt is actually sent.
    { id: 'annotate', file: 'explain-diff.md', title: t('annotatePrompt.title'), when: t('annotatePrompt.when'),
      text: currentAnnotatePromptText, onSend: markExplainRunStarting },
    { id: 'codebase', file: 'explain-codebase.md', title: t('codebasePrompt.title'), when: t('codebasePrompt.when'), text: currentCodebasePromptText },
    { id: 'terms', file: 'keep-what-i-learned.md', title: t('termsPrompt.title'), when: t('termsPrompt.when'), text: currentTermsPromptText },
  ];
}

// Hand `text` to the terminal's send mode (the same staging step ⌥⏎ uses everywhere else), so it lands in
// the composer for review rather than executing behind the user's back. Falls back to the clipboard where
// there is no integrated terminal (the CLI's browser viewer). Also the Explain rail button's fallback — see
// runAnnotatePrompt (23-annotations.js).
// The prompt goes to DISK and the composer carries one line naming it — the same hand-off the merged review
// request uses (sendWholeDocToTerminal, 08-dock.js). These prompts are sixty lines of instructions; pasted in,
// they filled the composer with a wall of text the reviewer had to scroll past to find the send button, and
// every send pasted the same sixty lines again. On disk it is also inspectable afterwards: what the agent was
// actually asked is a file you can open, not something that scrolled away.
//
// Falls back to pasting whenever the write cannot happen — a browser build with no bridge, a repo with no git
// dir — because a prompt that reaches the agent as text still works, and one that reaches it as a path to a
// file that was never written does not.
function sendPromptToTerminal(text, name) {
  var toTerminal = function (payload) {
    if (window.__kakapoTerminal && typeof window.__kakapoTerminal.enterSendMode === 'function') {
      window.__kakapoTerminal.enterSendMode(payload);
      return;
    }
    if (copyTextToClipboard(payload)) showToast(t('explain.copied'));
  };
  var canWrite = name && window.kakapoComments && typeof window.kakapoComments.writeRequest === 'function';
  if (!canWrite) { toTerminal(text); return; }
  Promise.resolve(window.kakapoComments.writeRequest(text, name)).catch(function () { return null; })
    .then(function (result) {
      toTerminal(result && result.ok && result.path ? t('prompt.requestFile') + ' ' + result.path : text);
    });
}

// One-line gist of each prompt so the list is scannable without opening Settings: the first non-empty line,
// clipped. The full text is what gets sent — this is a label, not a preview pane.
function promptPaletteSummary(text) {
  var first = String(text || '').split('\n').filter(function (l) { return l.trim(); })[0] || '';
  return first.length > 140 ? first.slice(0, 140) + '…' : first;
}
