import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");

function docs() {
  const found = ["AGENTS.md", "README.md", "README_KR.md"];
  const skills = join(root, ".claude", "skills");
  if (existsSync(skills)) {
    for (const name of readdirSync(skills)) {
      const file = join(".claude", "skills", name, "SKILL.md");
      if (existsSync(join(root, file))) found.push(file);
    }
  }
  return found.filter((file) => existsSync(join(root, file)));
}

// A path is only read where the prose spells a directory this repository owns. A bare word in backticks is
// usually a symbol, and a slash alone may be another program's path.
const OWNED = /^(?:src|test|scripts|docs|\.github|\.claude|dist)\//;
const CITATION = /`([A-Za-z0-9_.\-/]+\/[A-Za-z0-9_.\-/]+?\.[a-z]{2,5})(?::(\d+))?`/g;

// Names that belong to other programs, quoted as theirs. A reader wide enough to demand these exist in
// src/ calls every one of them rot — the same mistake the README chord reader was narrowed to avoid.
const FOREIGN_NAMES = new Set([
  "ExceptionWorker", "parseExceptionLine", "ExceptionWorker.parseExceptionLine", "FernFlower", "DefaultColorSchemesManager", "MinusculeMatcher",
  "UsageViewBundle.properties", "UsageGroupingRulesDefaultRanks", "MixedListFactory",
  "MULTIPLE_CONTRIBUTORS_ELEMENTS_LIMIT", "CARGO_TARGET_DIR", "RUSTUP_TARGETS", "TMPDIR",
  // IntelliJ platform, named by the IDE harness because it is the way a tool window is opened.
  "ToolWindow.show",
]);

const SYMBOL = /`([A-Z][A-Za-z0-9]+(?:\.[a-z][A-Za-z0-9]*)?|[a-z][A-Za-z0-9]*\(\)|[A-Z][A-Z0-9_]{3,})`/g;

function sourceHaystack() {
  const parts = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir))) {
      const relative = `${dir}/${entry}`;
      parts.push(entry);
      if (statSync(join(root, relative)).isDirectory()) { walk(relative); continue; }
      if (/\.(?:ts|cts|js|mjs|json|tla|cfg|sh|txt)$/.test(entry)) parts.push(readFileSync(join(root, relative), "utf8"));
    }
  };
  // The skills are part of the haystack: a TLA+ action and a fixture's own file name are declared there and
  // nowhere else, and a reader that cannot see them calls every one of them rot.
  for (const dir of ["src", "test", "scripts", ".claude/skills"]) walk(dir);
  return parts.join("\n");
}

test("the readers find what these documents are known to cite", () => {
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  const paths = Array.from(agents.matchAll(CITATION), (match) => match[1]);
  assert.ok(paths.includes("src/shortcuts.ts"), "the path reader did not find src/shortcuts.ts in AGENTS.md, "
    + `so any rot it reports below is its own bug. Found: ${JSON.stringify(paths.slice(0, 8))}`);
  const haystack = sourceHaystack();
  assert.ok(haystack.includes("printHelp") && haystack.includes("SHORTCUTS"),
    "the source haystack is missing names this repository certainly declares");
});

test("every file a document points at is there", () => {
  const rot = [];
  for (const file of docs()) {
    const text = readFileSync(join(root, file), "utf8");
    for (const [, path] of text.matchAll(CITATION)) {
      if (!OWNED.test(path)) continue;
      if (!existsSync(join(root, path))) rot.push(`${file} cites ${path}, which does not exist`);
    }
  }
  assert.deepEqual(rot, [], "a document points at a file that has been moved, renamed or deleted.");
});

test("a line a document points at is a line that file has", () => {
  const rot = [];
  for (const file of docs()) {
    const text = readFileSync(join(root, file), "utf8");
    for (const [, path, line] of text.matchAll(CITATION)) {
      if (!line || !OWNED.test(path) || !existsSync(join(root, path))) continue;
      const lines = readFileSync(join(root, path), "utf8").split("\n").length;
      if (Number(line) > lines) rot.push(`${file} cites ${path}:${line}, which has ${lines} lines`);
    }
  }
  assert.deepEqual(rot, [], "a line citation points past the end of the file it names.");
});

test("a symbol a document names is a symbol this repository declares", () => {
  const haystack = sourceHaystack();
  const rot = [];
  for (const file of docs()) {
    const text = readFileSync(join(root, file), "utf8");
    for (const [, symbol] of text.matchAll(SYMBOL)) {
      const name = symbol.replace(/\(\)$/, "");
      if (FOREIGN_NAMES.has(name) || name.length < 4) continue;
      if (!haystack.includes(name)) rot.push(`${file} names ${symbol}`);
    }
  }
  assert.deepEqual(rot, [], "a document names a function, constant or table that nothing in src/, test/ or "
    + "scripts/ declares any more. Rename it in the document, or add it to FOREIGN_NAMES in this test with "
    + "the program it belongs to.");
});

// The rule table in AGENTS.md is the one place prose is allowed to stand in for a rule, and only because
// every row names the check that fails when the rule breaks. A row naming a check that no longer exists is
// worse than no row: it reads as covered.
const RULE_TABLE = /^\|(.+?)\|(.+?)\|\s*$/gm;

function enforcers(cell) {
  return Array.from(cell.matchAll(/`([^`]+)`/g), (match) => match[1]);
}

test("every rule in the table names an enforcer that exists", () => {
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  const rows = Array.from(agents.matchAll(RULE_TABLE))
    .map(([, rule, cell]) => [rule.trim(), cell.trim()])
    .filter(([rule]) => rule !== "Rule" && !rule.startsWith("---"));
  assert.ok(rows.length >= 20, `the table reader found ${rows.length} rows, so it is not reading the table `
    + "and the assertions below cannot fail for the right reason");

  const workflows = readdirSync(join(root, ".github", "workflows"))
    .map((file) => readFileSync(join(root, ".github", "workflows", file), "utf8")).join("\n");
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  const missing = [];
  let named = 0;
  for (const [rule, cell] of rows) {
    const found = enforcers(cell);
    assert.ok(found.length, `the row "${rule.slice(0, 50)}" names no enforcer at all`);
    for (const enforcer of found) {
      named += 1;
      if (enforcer.startsWith("npm run ")) {
        if (!scripts[enforcer.slice("npm run ".length)]) missing.push(`${rule.slice(0, 40)} → no ${enforcer}`);
      } else if (enforcer.includes("/") || enforcer.endsWith(".mjs")) {
        if (!existsSync(join(root, enforcer))) missing.push(`${rule.slice(0, 40)} → no ${enforcer}`);
      } else if (!workflows.includes(enforcer)) {
        missing.push(`${rule.slice(0, 40)} → no workflow job or script named ${enforcer}`);
      }
    }
  }
  assert.ok(named >= rows.length, "every row names at least one enforcer");
  assert.deepEqual(missing, [], "a rule in AGENTS.md names a check that is not there. Either the check moved "
    + "and the row has to follow it, or the rule is now unenforced prose and belongs in one of the sections "
    + "that say so.");
});
