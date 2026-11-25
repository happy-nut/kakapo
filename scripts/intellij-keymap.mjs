#!/usr/bin/env node
// Captures, from the IntelliJ this machine has installed, every keystroke its macOS keymap already
// spends. test/idea-plugin-chords.test.mjs reads the result so a chord the plugin invents cannot
// quietly land on one the IDE is using — ⌘⇧/ shipped in 0.0.1 and 0.0.2 on CommentByBlockComment.
//
// Refresh with: npm run idea:keymap
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const IDE = "/Applications/IntelliJ IDEA CE.app";
const JAR = join(IDE, "Contents/lib/app-client.jar");
// The macOS keymap is an overlay on $default, and an entry inherited from $default is still a chord
// the IDE answers, so both files count as spent.
const KEYMAPS = ["keymaps/$default.xml", "keymaps/Mac OS X 10.5+.xml", "keymaps/macOS System Shortcuts.xml"];

// IntelliJ writes the modifiers in its own order and a plugin.xml may write another. Canonicalise on
// capture so the comparison is about the chord and not about the spelling.
function canonical(chord) {
  const parts = chord.trim().split(/\s+/);
  const key = parts.pop();
  return [...parts].sort().join(" ") + (parts.length ? " " : "") + key;
}

function chordsOf(xml) {
  const spent = new Map();
  for (const action of xml.matchAll(/<action id="([^"]+)">([\s\S]*?)<\/action>/g)) {
    for (const stroke of action[2].matchAll(/first-keystroke="([^"]+)"/g)) {
      const chord = canonical(stroke[1]);
      const held = spent.get(chord) ?? [];
      if (!held.includes(action[1])) held.push(action[1]);
      spent.set(chord, held);
    }
  }
  return spent;
}

const scratch = mkdtempSync(join(tmpdir(), "kakapo-keymap-"));
try {
  execFileSync("unzip", ["-o", "-q", JAR, "-d", scratch, "keymaps/*"]);
  const spent = new Map();
  for (const name of KEYMAPS) {
    for (const [chord, actions] of chordsOf(readFileSync(join(scratch, name), "utf8"))) {
      spent.set(chord, [...new Set([...(spent.get(chord) ?? []), ...actions])].sort());
    }
  }

  // A capture that cannot see a binding it is meant to see would read as "every chord is free".
  const control = spent.get(canonical("shift meta SLASH")) ?? [];
  if (!control.includes("CommentByBlockComment")) {
    throw new Error(`capture is blind: ⌘⇧/ should be CommentByBlockComment, got ${JSON.stringify(control)}`);
  }

  const out = join(REPO, "test/fixtures/intellij-mac-keymap.json");
  writeFileSync(out, `${JSON.stringify({
    ide: execFileSync("defaults", ["read", join(IDE, "Contents/Info"), "CFBundleVersion"], { encoding: "utf8" }).trim(),
    captured: KEYMAPS,
    spent: Object.fromEntries([...spent].sort(([a], [b]) => a.localeCompare(b))),
  }, null, 2)}\n`);
  console.log(`${out}: ${spent.size} chords from ${execFileSync("defaults", ["read", join(IDE, "Contents/Info"), "CFBundleVersion"], { encoding: "utf8" }).trim()}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
