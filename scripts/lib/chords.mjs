import { SHORTCUTS } from "../../dist/shortcuts.js";

const MODIFIERS = /^[⌘⌥⇧⌃]+$/;
const ARROW_RUN = /^([⌘⌥⇧⌃]*)([←↑↓→]{2,})$/;

export function chordsInApp() {
  return new Set(SHORTCUTS.flatMap((row) => row.keys));
}

export function appHasChord(app, chord) {
  if (app.has(chord)) return true;
  const run = ARROW_RUN.exec(chord);
  return Boolean(run) && Array.from(run[2]).every((arrow) => app.has(run[1] + arrow));
}

export function chordsClaimedIn(markdown) {
  const out = [];
  markdown.split("\n").forEach((line, index) => {
    if (!line.startsWith("|")) return;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const chord = match[1].trim();
      if (!/[⌘⌥⇧⌃]/.test(chord) && !/^(?:F\d{1,2}|Esc)$/.test(chord)) continue;
      if (MODIFIERS.test(chord)) continue;
      out.push({ chord, line: index + 1 });
    }
  });
  return out;
}
