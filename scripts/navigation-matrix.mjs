// Code and library navigation, kakapo against IntelliJ, as a table you can re-run.
//
// navigation-smoke.mjs asks "does this key still work". This asks the question that one cannot: "does it
// still do what IntelliJ does". The two are not the same — ⌘B worked perfectly for a year and showed the
// usages popup on a reference, which IntelliJ never does, and no check that only pressed the key could
// have seen it. A row here fails when kakapo's answer stops matching IntelliJ's, including when kakapo
// answers something perfectly reasonable.
//
// Every expectation carries where it came from. They are not recalled: the behaviour is read out of the
// installed IDE's own classes, decompiled with the FernFlower it ships
// (Contents/plugins/java-decompiler), and the chords out of the keymaps inside the same jar.
//
//   unzip -qo "<IDEA>/Contents/lib/app-client.jar" 'com/intellij/codeInsight/navigation/*' -d <dir>
//   "<IDEA>/Contents/jbr/Contents/Home/bin/java" \
//     -cp "<IDEA>/Contents/plugins/java-decompiler/lib/java-decompiler.jar" \
//     org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler -dgs=1 <dir>/com <out>
//
// It is app-client.jar, not app.jar: the 2025 frontend/backend split moved the whole UI there. `rea`
// cannot read any of it — `rea capabilities` (6.7.0) has no JVM provider — but `rea inspect-artifact`
// does pin WHICH build an expectation was read from, which is why the sha is recorded below.
//
// Three rows are expected to differ, and say so rather than being left out. A matrix that lists only the
// agreements is a matrix nobody can use to decide what to do next.
//
// Run it with `npm run nav:matrix`. Like the smoke, it refuses while a Kakapo from this checkout is open.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync as write } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PORT, checkoutElectronPids, launchApp, portHolder, preflightPort, readyPage, sleep, stopApp }
  from "./lib/app-harness.mjs";

// The build every IntelliJ expectation below was read from. `rea inspect-artifact <path>` prints it.
const IDEA_BUILD = "app-client.jar sha256 092c52b2e4b470027506bb8de6c07af07969258cc91f6f9052267a282111e039";

// ---- the project ---------------------------------------------------------------------------------
// Small, but not a toy: it has the four shapes the navigation questions are actually asked about — a
// method with an override, an interface with two implementations, a reference in another file, and a
// dependency that ships typings and no readable implementation. That last one is electron's shape, and
// it is the one that was broken: `main` points at a CommonJS launcher, `types` at a .d.ts, and the
// declaration a reader wants is in the .d.ts.
function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "kakapo-nav-matrix-"));
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  const put = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    write(join(repo, path), content);
  };
  git(["init", "-qb", "main"]);
  git(["config", "user.email", "matrix@kakapo.test"]);
  git(["config", "user.name", "kakapo matrix"]);
  put("package.json", JSON.stringify({ name: "@matrix/root", private: true }));
  put("tsconfig.json", JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "node" },
    include: ["src", "test"],
  }));

  put("src/store.ts", [
    "export class Store {",                 // 1
    "  private total = 0;",                 // 2
    "",                                     // 3
    "  bump(): number {",                   // 4
    "    this.total += 1;",                 // 5
    "    return this.total;",               // 6
    "  }",                                  // 7
    "}",                                    // 8
    "",                                     // 9
    "export function makeStore(): Store {", // 10
    "  return new Store();",                // 11
    "}",                                    // 12
    "",
  ].join("\n"));
  put("src/use-store.ts", [
    "import { makeStore, Store } from \"./store\";", // 1
    "",                                              // 2
    "export function run(): number {",               // 3
    "  const store: Store = makeStore();",           // 4
    "  return store.bump();",                        // 5
    "}",                                             // 6
    "",
  ].join("\n"));
  // Two implementations, so Go to Implementation has something to choose between, and a super to walk up
  // to. Both are what IntelliJ's own actions are for; a single-implementation fixture proves nothing.
  put("src/shape.ts", [
    "export interface Shape {",             // 1
    "  area(): number;",                    // 2
    "}",                                    // 3
    "",                                     // 4
    "export class Circle implements Shape {", // 5
    "  area(): number { return 3; }",       // 6
    "}",                                    // 7
    "",                                     // 8
    "export class Square implements Shape {", // 9
    "  area(): number { return 4; }",       // 10
    "}",                                    // 11
    "",
  ].join("\n"));
  put("src/app.ts", [
    "import { widget, Panel } from \"widget\";", // 1
    "import { run } from \"./use-store\";",       // 2
    "",                                           // 3
    "export function main(): void {",             // 4
    "  widget.start();",                           // 5
    "  const panel = new Panel();",                // 6
    "  panel.show(run());",                        // 7
    "}",                                           // 8
    "",
  ].join("\n"));
  // The name collision that used to decide whether a library answer survived: this project declares
  // `widget` too, in a file that has nothing to do with the dependency.
  put("test/fixture.ts", "const widget = 1;\nexport default widget;\n");

  // A dependency shaped like electron: an entry that is a launcher shim, and typings beside it.
  put("node_modules/widget/package.json", JSON.stringify({
    name: "widget", version: "1.0.0", main: "index.js", types: "index.d.ts",
  }));
  put("node_modules/widget/index.js", [
    "const { spawnSync } = require('child_process');",
    "// A launcher, not an implementation — exactly what a typings-only package's entry is.",
    "module.exports = require('./dist/widget-native');",
    "",
  ].join("\n"));
  put("node_modules/widget/index.d.ts", [
    "declare namespace Widget {",                    // 1
    "  interface Thing {",                           // 2
    "    start(): void;",                            // 3
    "  }",                                           // 4
    "  interface PanelLike {",                       // 5
    "    show(value: number): void;",                // 6
    "  }",                                           // 7
    "}",                                             // 8
    "",                                              // 9
    "declare module \"widget\" {",                   // 10
    "  const widget: Widget.Thing;",                 // 11
    "  class Panel implements Widget.PanelLike {",   // 12
    "    show(value: number): void;",                // 13
    "  }",                                           // 14
    "  export { widget, Panel };",                   // 15
    "}",                                             // 16
    "",
  ].join("\n"));

  git(["add", "-A"]);
  git(["commit", "-qm", "baseline"]);
  // A change, so the app opens a review rather than the welcome screen.
  put("src/store.ts", [
    "export class Store {",
    "  private total = 1;",
    "",
    "  bump(): number {",
    "    this.total += 1;",
    "    return this.total;",
    "  }",
    "}",
    "",
    "export function makeStore(): Store {",
    "  return new Store();",
    "}",
    "",
  ].join("\n"));
  return repo;
}

// ---- reading the app -----------------------------------------------------------------------------
// What a navigation key did, in one string. Deliberately coarse: the question is "did kakapo do what
// IntelliJ does", and IntelliJ's answers are coarse too — it navigated, it opened a chooser, it opened
// the usage view, it said there was nowhere to go.
const STATE = `(() => {
  const shown = (id) => {
    const el = document.getElementById(id);
    return Boolean(el) && getComputedStyle(el).display !== 'none' && !el.classList.contains('hidden');
  };
  const rows = (sel) => Array.from(document.querySelectorAll(sel)).filter((r) => r.getBoundingClientRect().height > 0).length;
  return {
    caret: typeof caretLocation === 'function' ? String(caretLocation() || '') : '',
    open: (document.getElementById('source-viewer') || { dataset: {} }).dataset.openPath || '',
    peek: shown('semantic-peek'),
    peekTitle: String((document.getElementById('semantic-peek-title') || {}).textContent || ''),
    peekRows: rows('#semantic-peek-results .semantic-peek-item'),
    quick: shown('quick-open'),
    quickLabel: String((document.getElementById('quick-open-filter') || {}).textContent || ''),
    quickRows: rows('#quick-open-results .quick-open-item'),
    // .mc-caret-hint, and the toast it falls back to when there is no row to anchor against
    // (showCaretHint, 07-comments.js). Written down because the obvious guess, '.caret-hint', matches
    // nothing at all — and a selector that cannot match reads every outcome as silence.
    hint: String((document.querySelector('.mc-caret-hint, #mc-toast, .mc-toast') || {}).textContent || '').trim(),
    highlights: (() => { try { return CSS.highlights ? CSS.highlights.size : 0; } catch (e) { return 0; } })(),
    // How a library file is actually marked: the meta line carries t('source.library') ahead of the size
    // (11-render-http.js), and edits are refused with t('source.libraryReadOnly'). There is no badge
    // element and no #source-crumbs — both were guesses, and both read as "not marked".
    meta: String((document.getElementById('source-meta') || {}).textContent || ''),
    library: (() => { try { return isLibrarySourcePath((document.getElementById('source-viewer') || { dataset: {} }).dataset.openPath || ''); } catch (e) { return false; } })(),
  };
})()`;

async function settled(page, predicate, capMs = 9000) {
  const deadline = Date.now() + capMs;
  let state = await page.evaluate(STATE);
  while (Date.now() < deadline) {
    if (predicate(state)) return state;
    await sleep(150);
    state = await page.evaluate(STATE);
  }
  return state;
}

// ---- the matrix ----------------------------------------------------------------------------------
// `intellij` is what the IDE does and `source` is where that was read. `expect` turns the measured state
// into the same sentence, so a row reads as one claim rather than as two numbers to compare by eye.
const CHORD = {
  "⌘B": ["b", "KeyB", 66, 4],
  "⌘⇧B": ["b", "KeyB", 66, 4 + 8],
  "⌘⌥B": ["b", "KeyB", 66, 4 + 1],
  "⌘↓": ["ArrowDown", "ArrowDown", 40, 4],
  "⌥F7": ["F7", "F7", 118, 1],
  "⌘⌥F7": ["F7", "F7", 118, 4 + 1],
  "⌘F7": ["F7", "F7", 118, 4],
  "⌘⌥↓": ["ArrowDown", "ArrowDown", 40, 4 + 1],
  "⌘U": ["u", "KeyU", 85, 4],
  "⌘⇧E": ["e", "KeyE", 69, 4 + 8],
  Escape: ["Escape", "Escape", 27, 0],
};

const GTDU = "GtduKt.fromTargetData";
const GTD1 = "GotoDeclarationOnlyHandler2.gotoDeclaration";
const MACKEYS = "keymaps/Mac OS X 10.5+.xml";
const DEFKEYS = "keymaps/$default.xml";

const ROWS = [
  // ---- code navigation ---------------------------------------------------------------------------
  {
    group: "code",
    action: "Go to Declaration",
    chord: "⌘B",
    situation: "caret on a reference",
    intellij: "goes to the declaration",
    source: `${GTDU}: referenced → GTD`,
    at: ["src/use-store.ts", 4, "makeStore"],
    expect: (s) => (s.caret === "src/store.ts:10" ? "goes to the declaration" : `caret ${s.caret}${s.peek ? ", chooser" : ""}`),
  },
  {
    group: "code",
    action: "Go to Declaration",
    chord: "⌘B",
    situation: "caret on the declaration itself",
    intellij: "shows its usages",
    source: `${GTDU}: declared → SU`,
    at: ["src/store.ts", 10, "makeStore"],
    settle: (s) => s.peek,
    expect: (s) => (s.peek && s.peekRows > 0 ? "shows its usages" : s.caret !== "src/store.ts:10" ? `navigated to ${s.caret}` : "nothing"),
  },
  {
    group: "code",
    action: "Go to Declaration",
    chord: "⌘B",
    situation: "nothing resolvable under the caret",
    intellij: "says there is nowhere to go",
    source: `${GTDU} → null → IdeKt.notifyNowhereToGo`,
    at: ["src/store.ts", 3, null],
    settle: (s) => Boolean(s.hint),
    expect: (s) => (s.hint ? "says there is nowhere to go" : s.peek ? "opened a popup" : "nothing at all"),
  },
  {
    group: "code",
    action: "Go to Declaration",
    chord: "⌘↓",
    situation: "the app's second key for the same row",
    intellij: "⌘↓ is EditSource there, not a declaration key",
    source: `${MACKEYS}: EditSource`,
    at: ["src/use-store.ts", 4, "makeStore"],
    expect: (s) => (s.caret === "src/store.ts:10" ? "goes to the declaration" : `caret ${s.caret}`),
    differs: "kakapo keeps ⌘↓ as an alias; IntelliJ's ⌘↓ is a tool-window action with nothing to collide with here",
  },
  {
    group: "code",
    action: "Go to Type Declaration",
    chord: "⌘⇧B",
    situation: "caret on a typed value",
    intellij: "goes to the type's declaration",
    source: `${MACKEYS}: GotoTypeDeclaration = meta shift B`,
    at: ["src/use-store.ts", 5, "store"],
    expect: (s) => (s.caret === "src/store.ts:1" ? "goes to the type's declaration" : `caret ${s.caret}`),
  },
  {
    group: "code",
    action: "Go to Implementation",
    chord: "⌘⌥B",
    situation: "caret on an interface with two implementations",
    intellij: "lists both implementations",
    source: `${MACKEYS}: GotoImplementation = meta alt B`,
    at: ["src/shape.ts", 1, "Shape"],
    settle: (s) => s.peek,
    expect: (s) => (s.peek && s.peekRows >= 2 ? "lists both implementations" : s.peek ? `lists ${s.peekRows}` : `caret ${s.caret}`),
  },
  {
    group: "code",
    action: "Find Usages",
    chord: "⌥F7",
    situation: "caret on a symbol used elsewhere",
    intellij: "opens the grouped usage view",
    source: `${DEFKEYS}: FindUsages = alt F7`,
    at: ["src/store.ts", 10, "makeStore"],
    settle: (s) => s.quick,
    expect: (s) => (s.quick && s.quickRows > 0 ? "opens the grouped usage view" : s.peek ? "opened the flat popup" : "nothing"),
  },
  {
    group: "code",
    action: "Show Usages",
    chord: "⌘⌥F7",
    situation: "caret on a symbol used elsewhere",
    intellij: "opens the flat popup at the caret",
    source: `${DEFKEYS}: ShowUsages = control alt F7 (⌃ folds to ⌘ in this table)`,
    at: ["src/store.ts", 10, "makeStore"],
    settle: (s) => s.peek,
    expect: (s) => (s.peek && s.peekRows > 0 ? "opens the flat popup at the caret" : s.quick ? "opened the grouped view" : "nothing"),
  },
  {
    group: "code",
    action: "Find Usages in File",
    chord: "⌘F7",
    situation: "caret on a symbol used in this file",
    intellij: "paints this file's occurrences",
    source: `${DEFKEYS}: FindUsagesInFile = control F7`,
    at: ["src/store.ts", 5, "total"],
    settle: (s) => s.highlights > 0,
    expect: (s) => (s.highlights > 0 ? "paints this file's occurrences" : "paints nothing"),
  },
  {
    group: "code",
    action: "Next Occurrence",
    chord: "⌘⌥↓",
    situation: "after the in-file highlight",
    intellij: "steps to the next occurrence",
    source: `${DEFKEYS}: GotoNextElementUnderCaretUsage`,
    before: ["⌘F7"],
    at: ["src/store.ts", 5, "total"],
    expect: (s) => (s.caret !== "src/store.ts:5" && s.caret.startsWith("src/store.ts:") ? "steps to the next occurrence" : `caret ${s.caret}`),
  },
  {
    group: "code",
    action: "Go to Super",
    chord: "⌘U",
    situation: "caret on a class that implements an interface",
    intellij: "goes to the interface",
    source: `${MACKEYS}: GotoSuperMethod = meta U`,
    at: ["src/shape.ts", 5, "Circle"],
    settle: (s) => s.caret === "src/shape.ts:1" || s.peek || Boolean(s.hint),
    expect: (s) => (s.caret === "src/shape.ts:1" ? "goes to the interface" : s.peek ? "offers a list" : s.hint ? "says it found none" : `caret ${s.caret}`),
  },
  {
    group: "code",
    action: "Go to Super",
    chord: "⌘U",
    situation: "caret on the METHOD that implements an interface member",
    intellij: "goes to the member it overrides",
    source: `${MACKEYS}: GotoSuperMethod — the action is about the member, not only the type`,
    at: ["src/shape.ts", 6, "area"],
    settle: (s) => s.caret === "src/shape.ts:2" || s.peek || Boolean(s.hint),
    expect: (s) => (s.caret === "src/shape.ts:2" ? "goes to the member it overrides" : s.peek ? "offers a list" : s.hint ? "says it found none" : `caret ${s.caret}`),
  },
  {
    group: "code",
    action: "Recent Locations",
    chord: "⌘⇧E",
    situation: "after a few jumps",
    intellij: "lists where the caret has been",
    source: `${MACKEYS}: RecentLocations = meta shift E`,
    at: ["src/store.ts", 10, null],
    settle: (s) => s.quick,
    expect: (s) => (s.quick && s.quickRows > 0 ? "lists where the caret has been" : "nothing"),
  },

  // ---- library navigation ------------------------------------------------------------------------
  {
    group: "library",
    action: "Go to Declaration",
    chord: "⌘B",
    situation: "a value from a typings-only dependency",
    intellij: "goes to the declaration in the typings",
    source: `${GTDU}: referenced → GTD (no source-definition step exists)`,
    at: ["src/app.ts", 5, "widget"],
    settle: (s) => s.open.includes("node_modules"),
    expect: (s) => (s.caret === "node_modules/widget/index.d.ts:11"
      ? "goes to the declaration in the typings"
      : s.caret.endsWith("index.js:1") ? "goes to the package's entry file" : `caret ${s.caret}`),
  },
  {
    group: "library",
    action: "Go to Declaration",
    chord: "⌘B",
    situation: "a class from the same dependency",
    intellij: "goes to the declaration in the typings",
    source: `${GTD1}: SingleTarget → navigate`,
    at: ["src/app.ts", 6, "Panel"],
    settle: (s) => s.open.includes("node_modules"),
    expect: (s) => (s.caret === "node_modules/widget/index.d.ts:12"
      ? "goes to the declaration in the typings"
      : s.caret.endsWith("index.js:1") ? "goes to the package's entry file" : `caret ${s.caret}`),
  },
  {
    group: "library",
    action: "(opening one)",
    chord: "⌘B",
    situation: "the library file it landed in",
    intellij: "opens it read-only",
    source: "IntelliJ marks dependency sources read-only",
    at: null,
    reuse: true,
    expect: (s) => (s.library && /library|라이브러리/.test(s.meta) ? "opens it read-only" : "opens it like any other file"),
  },
  {
    group: "library",
    action: "Go to Declaration",
    chord: "⌘B",
    situation: "caret INSIDE a library file",
    intellij: "navigates within the library",
    source: `${GTDU}: a library file is a file like any other`,
    at: ["node_modules/widget/index.d.ts", 12, "Widget"],
    settle: (s) => s.caret !== "node_modules/widget/index.d.ts:12",
    expect: (s) => (s.open === "node_modules/widget/index.d.ts" && s.caret !== "node_modules/widget/index.d.ts:12"
      ? "navigates within the library" : `caret ${s.caret}`),
  },
  {
    group: "library",
    action: "Find Usages",
    chord: "⌥F7",
    situation: "caret INSIDE a library file",
    intellij: "answers with the project's usages",
    source: "IntelliJ indexes libraries; FindUsagesManager searches the project scope",
    at: ["node_modules/widget/index.d.ts", 11, "widget"],
    settle: (s) => s.quick,
    expect: (s) => (!s.quick ? "nothing"
      : /index|인덱스/.test(s.quickLabel) ? "falls back to the text index"
      : "answers with the project's usages"),
    // Matches HERE and not always in the wild, which is why it is called out rather than left as a tick.
    // This fixture's dependency is small enough that tsserver keeps it in the project. A real one is not:
    // asked for references from node_modules/electron/electron.d.ts in this repository, tsserver answers
    // with references inside node_modules and nothing else, and kakapo falls back to the text index and
    // labels the answer `index`. IntelliJ answers that from an index of the libraries themselves, which
    // kakapo does not have.
    differs: "matches on a small dependency; on a real one (electron in this repo) tsserver answers with "
      + "references inside node_modules only, and kakapo falls back to the text index and says so. "
      + "IntelliJ answers from an index of the libraries, which kakapo does not have.",
  },
];

// ---- running it ------------------------------------------------------------------------------------
async function place(page, [path, line, symbol]) {
  await page.key(...CHORD.Escape);
  await page.evaluate(`(() => { openSourceFile(${JSON.stringify(path)}); return true; })()`);
  const ready = await settled(page, (s) => s.open === path, 20000);
  if (ready.open !== path) return { ok: false, why: `${path} never opened` };
  const column = await page.evaluate(`(() => {
    const file = sourceByPath.get(${JSON.stringify(path)});
    if (!file) return -1;
    const text = file.content.split('\\n')[${line - 1}] || '';
    ${symbol === null ? "return 0;" : `const at = text.indexOf(${JSON.stringify(symbol)}); return at < 0 ? -1 : at + 1;`}
  })()`);
  if (column < 0) return { ok: false, why: `${symbol} not on ${path}:${line}` };
  await page.evaluate(`(() => { setSourceCursor(${JSON.stringify(path)}, ${line - 1}, ${column}, true, -1); return true; })()`);
  await sleep(250);
  return { ok: true };
}

async function run() {
  const already = checkoutElectronPids();
  if (already.length) {
    process.stdout.write(`a Kakapo from this checkout is already running (pid ${already.join(", ")}); quit it first.\n`);
    return 2;
  }
  if (!await preflightPort(PORT)) {
    const holder = portHolder(PORT);
    process.stdout.write(`port ${PORT} is already taken${holder ? ` (${holder})` : ""}; run with KAKAPO_SMOKE_PORT=<free port>.\n`);
    return 2;
  }
  const repo = fixtureRepo();
  const { child, log } = launchApp(repo);
  const measured = [];
  let page = null;
  try {
    page = await readyPage(60000);
    if (!page) {
      process.stdout.write(`the review page never became ready.\n${log().slice(-1500)}\n`);
      return 1;
    }
    // A cold tsserver answers its first question only after it has read the project, and every row below
    // is a semantic question. Asking one early does not fail — it falls back to the text index, which is
    // a different answer, and the row would record kakapo being slow as kakapo disagreeing with IntelliJ.
    await page.evaluate(`(() => { openSourceFile('src/use-store.ts'); return true; })()`);
    await settled(page, () => false, 6000);

    for (const row of ROWS) {
      if (!row.reuse) {
        const placed = await place(page, row.at);
        if (!placed.ok) { measured.push({ row, got: `could not set up: ${placed.why}` }); continue; }
        for (const chord of row.before ?? []) { await page.key(...CHORD[chord]); await sleep(600); }
        await page.key(...CHORD[row.chord]);
      }
      const state = await settled(page, row.settle ?? ((s) => s.caret !== ""), row.reuse ? 1500 : 9000);
      measured.push({ row, got: row.expect(state) });
    }
  } finally {
    page?.close();
    await stopApp(child);
    rmSync(repo, { recursive: true, force: true });
  }

  // ---- the table -----------------------------------------------------------------------------------
  const verdict = (m) => (m.got === m.row.intellij ? "✅" : m.row.differs ? "⚠️" : "❌");
  const out = [];
  out.push(`# Code and library navigation: kakapo vs IntelliJ\n`);
  out.push(`Measured in the real app against a real tsserver. IntelliJ's column is read from ${IDEA_BUILD}`);
  out.push(`and the keymaps in the same jar — see the header of this script for how.\n`);
  for (const group of ["code", "library"]) {
    out.push(`\n## ${group === "code" ? "Code navigation" : "Library navigation"}\n`);
    out.push("| | Action | Key | Caret is on | IntelliJ | kakapo | Source |");
    out.push("|---|---|---|---|---|---|---|");
    for (const m of measured.filter((one) => one.row.group === group)) {
      out.push(`| ${verdict(m)} | ${m.row.action} | \`${m.row.chord}\` | ${m.row.situation} `
        + `| ${m.row.intellij} | ${m.got} | ${m.row.source} |`);
    }
  }
  const differing = measured.filter((m) => m.row.differs);
  if (differing.length) {
    out.push(`\n## Deliberate differences\n`);
    for (const m of differing) out.push(`- **${m.row.action} ${m.row.chord}, ${m.row.situation}** — ${m.row.differs}`);
  }
  const broken = measured.filter((m) => verdict(m) === "❌");
  out.push(`\n${measured.length - broken.length}/${measured.length} rows match IntelliJ `
    + `(${differing.length} of them a difference this repo chose).\n`);
  process.stdout.write(out.join("\n"));
  return broken.length ? 1 : 0;
}

process.exit(await run());
