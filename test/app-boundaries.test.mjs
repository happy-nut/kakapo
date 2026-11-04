import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppPreferences } from "../dist/app-preferences.js";
import { externalUrl, resolveProjectPath } from "../dist/app-path-ipc.js";

test("application preferences separate global and per-worktree state", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-preferences-"));
  try {
    const userData = join(base, "app-data");
    const first = join(base, "repos", "first");
    const nested = join(first, "packages", "nested");
    mkdirSync(nested, { recursive: true });
    const preferences = new AppPreferences(userData);

    preferences.setRendererSetting(first, "kakapo-theme", "light");
    preferences.setRendererSetting(first, "kakapo-viewed", { "a.ts": true });
    preferences.setRendererSetting(nested, "kakapo-viewed", { "b.ts": true });

    assert.equal(preferences.rendererSettings(first)["kakapo-theme"], "light");
    assert.deepEqual(preferences.rendererSettings(first)["kakapo-viewed"], { "a.ts": true });
    assert.deepEqual(preferences.rendererSettings(nested)["kakapo-viewed"], { "b.ts": true });
    assert.equal(preferences.readGlobal()["kakapo-viewed"], undefined);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("recent projects are validated, deduplicated, and bounded", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-recents-"));
  try {
    const preferences = new AppPreferences(join(base, "app-data"), (path) => !path.endsWith("ignored"));
    for (let index = 0; index < 14; index += 1) preferences.recordRecentProject(join(base, `repo-${index}`));
    preferences.recordRecentProject(join(base, "repo-5"));
    preferences.recordRecentProject(join(base, "ignored"));

    const recent = preferences.readRecentProjects();
    assert.equal(recent.length, 12);
    assert.equal(recent[0].path, resolve(base, "repo-5"));
    assert.equal(recent.filter((project) => project.path === resolve(base, "repo-5")).length, 1);
    assert.ok(recent.every((project) => project.path !== resolve(base, "ignored")));

    preferences.forgetRecentProject(join(base, "repo-5"));
    assert.ok(preferences.readRecentProjects().every((project) => project.path !== resolve(base, "repo-5")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("pruneRecentProjects drops recent entries whose folder is gone (deleted-worktree cleanup)", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-prune-"));
  try {
    const live = join(base, "live");
    mkdirSync(live);
    const preferences = new AppPreferences(join(base, "app-data"));
    preferences.recordRecentProject(live);
    preferences.recordRecentProject(join(base, "gone")); // recorded, but its folder is never created
    // readRecentProjects stays a pure shape validator — both are kept until an explicit prune.
    assert.equal(preferences.readRecentProjects().length, 2);
    preferences.pruneRecentProjects();
    const after = preferences.readRecentProjects();
    assert.equal(after.length, 1);
    assert.equal(after[0].path, resolve(live));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("project path boundary accepts only relative paths contained by the opened folder", () => {
  const root = resolve("/tmp/kakapo-workspace/packages/reviewer");
  assert.equal(resolveProjectPath(root, "src/main.ts"), join(root, "src", "main.ts"));
  assert.equal(resolveProjectPath(root, "./README.md"), join(root, "README.md"));
  assert.equal(resolveProjectPath(root, "../sibling/secret.ts"), undefined);
  assert.equal(resolveProjectPath(root, "/tmp/outside.ts"), undefined);
  assert.equal(resolveProjectPath(root, ""), undefined);
});

// A URL an agent wrote into the review thread becomes a clickable link, so the URL a click hands to the OS
// is an untrusted input. Only plain http(s) may reach shell.openExternal — a file:// or custom scheme would
// be dispatched by the OS to whatever app claims it.
test("external-link boundary opens only http(s) URLs from untrusted text", () => {
  assert.equal(externalUrl("https://github.com/happy-nut/kakapo"), "https://github.com/happy-nut/kakapo");
  assert.equal(externalUrl("http://localhost:3000/health"), "http://localhost:3000/health");
  assert.equal(externalUrl("file:///Users/me/.ssh/id_rsa"), undefined);
  assert.equal(externalUrl("javascript:alert(1)"), undefined);
  assert.equal(externalUrl("vscode://install?x=1"), undefined);
  assert.equal(externalUrl("not a url"), undefined);
  assert.equal(externalUrl(""), undefined);
  assert.equal(externalUrl(null), undefined);
  assert.equal(externalUrl("https://x.test/" + "a".repeat(2048)), undefined, "an absurdly long URL is refused outright");
});

test("main process is a composition root for extracted persistence and IPC adapters", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  assert.match(main, /new AppPreferences\(app\.getPath\("userData"\), isGitRepository\)/);
  // The .http runner's cookie jar and `>>` output live under userData, so main hands the adapter that
  // path too — it is still main that owns every absolute location, which is what this test is about.
  assert.match(main, /registerReviewIpc\(ipcMain, stateFromEvent, app\.getPath\("userData"\)\)/);
  assert.match(main, /registerProjectPathIpc\(ipcMain, shell, stateFromEvent\)/);
  assert.match(main, /registerSettingsIpc\(ipcMain, preferences, stateFromEvent[,)]/);
  assert.doesNotMatch(main, /function readSettings|function resolveProjectRowPath|kakapo:get-file|"kakapo:get-settings"/);
  assert.doesNotMatch(main, /registerMemoIpc|ProjectMarkdownMemo/, "the worktree memo is gone, adapter and all");
});

// A window that is gone cannot be zoomed, resized or asked anything: Electron's webContents getter returns
// undefined once it is destroyed, and a timer firing after a close is exactly when that happens. Every
// surface method has to answer for its window being gone before it touches it.
test("the review surface answers for its window being gone", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const surface = main.match(/const surface: ReviewSurface = \{[\s\S]*?\n  \};/)[0];
  const delegating = surface.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /\bwin\.(show|focus|restore|isMinimized)\(\)/.test(line));
  assert.ok(delegating.length >= 3, "the surface still delegates to a window");
  assert.deepEqual(delegating.filter(({ line }) => !line.includes("isDestroyed")), [],
    "a window method is only called after asking whether the window is still there");
  // And the broadcast helpers skip a destroyed one rather than throwing mid-loop.
  const zoom = main.match(/function applyUiScale\([\s\S]*?\n\}/)[0];
  assert.match(zoom, /isDestroyed\(\)/, "applyUiScale skips a window that has gone");
});

// The scale list exists twice: main steps through it for ⌘+ / ⌘− and the Settings dropdown renders it in the
// viewer, which cannot import TypeScript. Let them drift and a keystroke lands on a size the dropdown cannot
// show as selected — the same way the syntax-family list once drifted and a chosen theme came back wrong.
test("the UI scale list main steps through is the one the dropdown offers", async () => {
  const { UI_SCALES } = await import("../dist/constants.js");
  const core = readFileSync(new URL("../src/viewer/01-core.js", import.meta.url), "utf8");
  const declared = core.match(/var UI_SCALES = \[([^\]]*)\]/)?.[1];
  assert.ok(declared, "the viewer still declares its own copy");
  assert.deepEqual(declared.split(",").map((n) => Number(n.trim())), UI_SCALES);
});

// The scale is one setting for the whole app: main applies it to the shell, the overlay and every review view
// from the GLOBAL file. Stored per-workspace instead, the dropdown moved and nothing changed size.
test("the UI scale is stored globally, not per workspace", () => {
  const base = mkdtempSync(join(tmpdir(), "kakapo-scale-"));
  try {
    const prefs = new AppPreferences(join(base, "app-data"));
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    prefs.setRendererSetting(repo, "kakapo-ui-scale", 1.25);
    assert.equal(prefs.readGlobal()["kakapo-ui-scale"], 1.25, "a workspace window writing it still writes the global");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Every quit path goes through finishQuit, which is what sets the flag before-quit reads. Setting
// quitConfirmed by hand is how a caller (the packaged self-update) once bypassed the whole shutdown path.
test("quitConfirmed is only ever set by finishQuit", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const assignments = source.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /(^|[^.\w])quitConfirmed\s*=\s*true/.test(line) && !line.startsWith("//") && !line.startsWith("*"));
  assert.equal(assignments.length, 1, `quitConfirmed is set outside finishQuit: ${JSON.stringify(assignments)}`);
  assert.match(source, /function finishQuit\(\): void \{\n\s*quitConfirmed = true;/);
});

// Two places compose the diff container and both carry the no-diff state's markup: build.ts for the
// standalone review and render.ts for the app's own document. A reviewer who hits the dead end hits it
// through one of them and has no way of knowing which, so the two have to say the same thing. They have
// already been spelled twice; this is what keeps the second copy honest.
test("the no-diff state says the same thing in both documents", () => {
  const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  const markup = (source, name) => {
    const found = source.match(/<div class="empty"><p class="empty-title"[\s\S]*?<\/p><\/div>/);
    assert.ok(found, `${name} still renders the no-diff state`);
    return found[0];
  };
  const fromBuild = markup(read("build.ts"), "build.ts");
  const fromRender = markup(read("render.ts"), "render.ts");
  assert.equal(fromBuild, fromRender, "the two copies of the no-diff state have drifted");
  // A dead end that only names itself is still a dead end: it has to point at the way out, and it has to
  // do so through the i18n table rather than in English baked into the markup.
  assert.match(fromBuild, /data-i18n="diff\.noDiff"/, "the state names itself from the string table");
  assert.match(fromBuild, /data-i18n="diff\.noDiff\.hint"/, "the state points at the control that resolves it");
  // Not with a chord. A chord written outside shortcuts.ts is a copy nothing keeps in agreement (AGENTS.md).
  const strings = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const hints = strings.match(/"diff\.noDiff\.hint":\s*"([^"]*)"/g) || [];
  assert.equal(hints.length, 2, "the hint is translated in both locales");
  for (const hint of hints) {
    assert.doesNotMatch(hint, /[⌘⌥⇧⌃]|\bF\d\b/, `the hint spells a shortcut instead of naming the control: ${hint}`);
  }
});

// The file tree is built twice — once by the server (render-tree.ts) and once by the client when the
// source tree virtualizes (04-source-tree.js) — so splitting a leaf name into base + extension had to be
// written twice too. Whether you see one spelling or the other depends only on how far you scrolled, which
// is exactly the kind of difference nobody would think to look for. The UI_SCALES guard above exists for
// the same reason; this is its sibling for the name split.
test("the leaf-name split is the same on the server and in the viewer", () => {
  const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const body = (source, name) => {
    const found = /function leafNameHtml\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
    assert.ok(found, `${name} still splits a leaf name`);
    // Compare the LOGIC, not the spelling: one file is TypeScript with template literals, the other is
    // ES5 with string concatenation. What has to agree is the split point and the two class names.
    return found[1].replace(/\s+/g, " ").trim();
  };
  const server = body(read("render-tree.ts"), "render-tree.ts");
  const client = body(read("viewer/00-util.js"), "00-util.js");
  const splitPoint = /indexOf\((['"])\.\1, 1\)/;
  assert.match(server, splitPoint, "the server splits at the first interior dot");
  assert.match(client, splitPoint, "the viewer splits at the first interior dot");
  for (const [name, source] of [["server", server], ["viewer", client]]) {
    assert.match(source, /dot <= 0 \|\| dot === name\.length - 1/, `${name} guards a dotless or trailing-dot name`);
    assert.match(source, /class="path-head"/, `${name} emits the base name as path-head`);
    assert.match(source, /class="path-tail"/, `${name} emits the extension as path-tail`);
    assert.match(source, /slice\(0, dot\)/, `${name} puts the base name in the head`);
    assert.match(source, /slice\(dot\)/, `${name} puts the extension in the tail`);
  }
});

// A JVM server answers for anything outside the project with a `jrt:`/`jar:` URI, and both sides have to
// name it the same way: the main process so a location carries a sensible label, the viewer so the caret
// hint can say where the definition is without asking. Written twice, for the same reason the leaf-name
// split is — so guarded the same way. What must agree is where the name is cut, not the spelling.
test("the external-location label is the same in the main process and in the viewer", () => {
  const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const body = (source, name) => {
    const found = /function externalLocationLabel\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
    assert.ok(found, `${name} still labels an external location`);
    return found[1].replace(/\s+/g, " ").trim();
  };
  const main = body(read("lsp.ts"), "lsp.ts");
  const viewer = body(read("viewer/00-util.js"), "00-util.js");
  for (const [side, source] of [["main", main], ["viewer", viewer]]) {
    assert.match(source, /indexOf\((['"])!\/\1\)/, `${side} cuts at the archive separator`);
    assert.match(source, /slice\(bang \+ 2\)/, `${side} keeps what is inside the archive`);
    assert.match(source, /\\\.\(jar\|zip\)\$/i, `${side} recognises an archive by the same extensions`);
    assert.match(source, /\^\[a-z\]\+:/i, `${side} strips the scheme when there is no archive separator`);
  }
});

// A catalog sentence is finished twice — by makeTranslator (i18n.ts) for the application menu, the native
// dialogs and the welcome screen, and by t() (01-core.js) for everything the page builds. The viewer cannot
// import the first one: the catalog reaches the page as JSON in a <script> tag, so the resolver reaches it
// as a second copy. Same reason as the leaf-name split above, same guard — except this one compares what
// the two functions DO rather than how they are written, because one is TypeScript with arrow callbacks
// and the other is ES5 and they are allowed to differ there.
//
// Written because the two had already drifted: makeTranslator substituted {name} and left {{n:one|many}}
// untouched, so the day a menu string grew the plural token the catalog has used for a year, the menu was
// going to print it raw.
test("the two message resolvers finish a sentence the same way", async () => {
  const { fillMessage } = await import("../dist/i18n.js");
  const source = readFileSync(new URL("../src/viewer/01-core.js", import.meta.url), "utf8");
  const found = /\nfunction t\(key, values\) \{([\s\S]*?)\n\}\n/.exec(source);
  assert.ok(found, "the viewer still resolves a message in t()");
  // Give it the two globals it reads off the page, and one catalog entry to find.
  const build = new Function("I18N", "locale", `return function t(key, values) {${found[1]}\n};`);

  const CASES = [
    ["{n} {{n:usage|usages}}", { n: 1 }],
    ["{n} {{n:usage|usages}}", { n: 0 }],
    ["{n} {{n:usage|usages}}", { n: 2 }],
    ["{n} {{n:problem|problems}} ({errors} {{errors:error|errors}}) in {files} {{files:file|files}}",
      { n: 1, errors: 1, files: 1 }],
    ["{n} {{n:problem|problems}} ({errors} {{errors:error|errors}}) in {files} {{files:file|files}}",
      { n: 25, errors: 0, files: 272 }],
    // A count that is not a number: Quick Open prints "134+" when the result list was truncated, and that
    // is plural however it is spelled.
    ["{n} {{n:result|results}}", { n: "134+" }],
    ["{n} {{n:result|results}}", { n: "1" }],
    // Zero is a value, not a missing one — a resolver that tests truthiness prints "" here.
    ["{count} unchanged {{count:line|lines}}", { count: 0 }],
    // A placeholder nobody passed stays visible: "{symbol}" is a bug report, "undefined" is a mystery.
    ["{symbol} has no type", {}],
    ["{n} of {total}", { n: 3 }],
    // A form whose count was never passed: NaN is not 1, so the plural reads.
    ["{{n:file has|files have}} no language server", {}],
    ["nothing to interpolate", { n: 1 }],
    ["{n}%", { n: 100 }],
  ];
  for (const [text, values] of CASES) {
    const viewer = build({ en: { probe: text } }, "en")("probe", values);
    const main = fillMessage(text, values);
    assert.equal(viewer, main, `both finish ${JSON.stringify(text)} with ${JSON.stringify(values)} the same way`);
  }
  // No values at all is the common case and has to short-circuit identically.
  assert.equal(build({ en: { probe: "{n} {{n:a|b}}" } }, "en")("probe"), fillMessage("{n} {{n:a|b}}", undefined));
});

// Two functions with one name are this repository's recurring defect, and the three guards above are each a
// separate response to one instance of it. This is the response to the CLASS: the sweep that finds them.
//
// It was written after it found two nobody had noticed. `readTextFile` existed in util.ts, honouring a BOM
// and dropping it, and in project-layout.ts as `readFileSync(path, "utf8")` — so a manifest saved
// UTF-8-with-BOM, which is what Windows editors write, kept the mark as an invisible first character and
// JSON.parse threw on .idea/modules.xml and tsconfig.json while the layout came back empty with nothing to
// say about why. `executable` existed in lsp.ts and search.ts and the two disagreed about Windows. Both are
// now one function; the ones that remain are listed here with what keeps them honest.
//
// A pair where both copies are TypeScript is a copy to DELETE — they are in one program and can import
// each other. A pair split across the server and the viewer cannot be: the viewer is 39 concatenated .js
// slices served to a page, with no module system to import through. Those get a behavioural guard.
const KNOWN_TWINS = {
  escapeHtml: "server / viewer, and a divergence here is an injection — guarded behaviourally below",
  escapeRegExp: "server / viewer, and a divergence here is a wrong match or a ReDoS — guarded below",
  formatBytes: "server / viewer: the same figure under the same name — guarded below",
  leafNameHtml: "server / viewer: guarded by the leaf-name split test above",
  externalLocationLabel: "main / viewer: guarded by the external-location label test above",
  applyUiScale: "main / viewer: guarded by the UI scale tests above",
};

test("no function is declared in two files without a reason on record", () => {
  const dirs = [new URL("../src/", import.meta.url).pathname, new URL("../src/viewer/", import.meta.url).pathname];
  const where = new Map();
  for (const dir of dirs) {
    for (const file of readdirSync(dir).filter((f) => /\.(ts|js)$/.test(f))) {
      const source = readFileSync(join(dir, file), "utf8");
      for (const found of source.matchAll(/^(?:export )?(?:async )?function (\w+)\s*\(/gm)) {
        const name = found[1];
        if (!where.has(name)) where.set(name, new Set());
        where.get(name).add(dir.endsWith("/viewer/") ? `viewer/${file}` : file);
      }
    }
  }
  const twins = [...where].filter(([, files]) => files.size > 1)
    .map(([name, files]) => [name, [...files].sort()]);
  // The sweep has to be finding something, or a refactor that renames `function` out of this codebase
  // turns this guard into a test that passes by seeing nothing.
  assert.ok(twins.length > 0, "the sweep still recognises a declaration at all");

  const unexplained = twins.filter(([name]) => !(name in KNOWN_TWINS))
    .map(([name, files]) => `${name}  (${files.join(", ")})`);
  assert.deepEqual(unexplained, [],
    `delete one copy if both are TypeScript — they are in one program. If the pair straddles the server and\n`
    + `the viewer, give it a behavioural guard and a line in KNOWN_TWINS saying so:\n  ${unexplained.join("\n  ")}`);

  // And the list is not a parking space: an entry for a pair that is no longer a pair is a line that would
  // quietly excuse the next real one to take that name.
  const stale = Object.keys(KNOWN_TWINS).filter((name) => !twins.some(([twin]) => twin === name));
  assert.deepEqual(stale, [], "these are no longer declared twice");
});

// The three pairs that cannot be deduplicated, compared by what they DO. Source comparison is no good here:
// one side is TypeScript and the other ES5, and they are allowed to differ in spelling.
test("the server and the viewer agree on escaping, and on a size", async () => {
  const util = await import("../dist/util.js");
  const analysis = readFileSync(new URL("../src/analysis.ts", import.meta.url), "utf8");
  const viewerSource = (file) => readFileSync(new URL(`../src/viewer/${file}`, import.meta.url), "utf8");
  const lift = (source, name) => {
    const found = new RegExp(`\\nfunction ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n\\}\\n`).exec(source);
    assert.ok(found, `${name} is still declared in the viewer`);
    return new Function(found[1], found[2]);
  };
  const viewerEscapeHtml = lift(viewerSource("00-util.js"), "escapeHtml");
  const viewerFormatBytes = lift(viewerSource("00-util.js"), "formatBytes");
  const viewerEscapeRegExp = lift(viewerSource("15-semantic-navigation.js"), "escapeRegExp");
  // analysis.ts's copy is TypeScript but this function is plain ES in both, so the same lift reads it.
  const serverEscapeRegExp = lift(analysis.replace(/: string\)/g, ")").replace(/\): string \{/g, ") {"), "escapeRegExp");

  for (const value of ["", "plain", "<script>alert(1)</script>", `a & b`, `"quoted"`, "it's", "&amp;",
    "<img src=x onerror=alert(1)>", "a\u0000b", "<<&&>>''\"\"", "»– "]) {
    assert.equal(viewerEscapeHtml(value), util.escapeHtml(value), `both escape ${JSON.stringify(value)} alike`);
  }
  for (const value of ["", "plain", "a.b", "a|b", "[a-z]+", "(group)", "^$", "a\\b", "{1,2}", "a*?+", "안녕"]) {
    assert.equal(viewerEscapeRegExp(value), serverEscapeRegExp(value),
      `both escape ${JSON.stringify(value)} for a regex alike`);
  }
  for (const bytes of [0, 1, 1023, 1024, 1025, 2048, 1024 * 1023, 1024 * 1024, 1024 * 1024 * 3.5,
    1024 * 1024 * 1024, 2_500 * 1024]) {
    assert.equal(viewerFormatBytes(bytes), util.formatBytes(bytes), `both print ${bytes} bytes alike`);
  }
});
