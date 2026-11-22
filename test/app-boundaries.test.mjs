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
    preferences.recordRecentProject(join(base, "gone"));
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
  assert.match(main, /new AppPreferences\(app\.getPath\("userData"\), belongsInRecentProjects\)/);
  assert.match(main, /registerReviewIpc\(ipcMain, stateFromEvent, app\.getPath\("userData"\)\)/);
  assert.match(main, /registerProjectPathIpc\(ipcMain, shell, stateFromEvent\)/);
  assert.match(main, /registerSettingsIpc\(ipcMain, preferences, stateFromEvent[,)]/);
  assert.doesNotMatch(main, /function readSettings|function resolveProjectRowPath|kakapo:get-file|"kakapo:get-settings"/);
  assert.doesNotMatch(main, /registerMemoIpc|ProjectMarkdownMemo/, "the worktree memo is gone, adapter and all");
});

test("the review surface answers for its window being gone", () => {
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const surface = main.match(/const surface: ReviewSurface = \{[\s\S]*?\n  \};/)[0];
  const delegating = surface.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /\bwin\.(show|focus|restore|isMinimized)\(\)/.test(line));
  assert.ok(delegating.length >= 3, "the surface still delegates to a window");
  assert.deepEqual(delegating.filter(({ line }) => !line.includes("isDestroyed")), [],
    "a window method is only called after asking whether the window is still there");
  const zoom = main.match(/function applyUiScale\([\s\S]*?\n\}/)[0];
  assert.match(zoom, /isDestroyed\(\)/, "applyUiScale skips a window that has gone");
});

test("the UI scale list main steps through is the one the dropdown offers", async () => {
  const { UI_SCALES } = await import("../dist/constants.js");
  const core = readFileSync(new URL("../src/viewer/01-core.js", import.meta.url), "utf8");
  const declared = core.match(/var UI_SCALES = \[([^\]]*)\]/)?.[1];
  assert.ok(declared, "the viewer still declares its own copy");
  assert.deepEqual(declared.split(",").map((n) => Number(n.trim())), UI_SCALES);
});

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

test("quitConfirmed is only ever set by finishQuit", () => {
  const source = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  const assignments = source.split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => /(^|[^.\w])quitConfirmed\s*=\s*true/.test(line) && !line.startsWith("//") && !line.startsWith("*"));
  assert.equal(assignments.length, 1, `quitConfirmed is set outside finishQuit: ${JSON.stringify(assignments)}`);
  assert.match(source, /function finishQuit\(\): void \{\n\s*quitConfirmed = true;/);
});

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
  assert.match(fromBuild, /data-i18n="diff\.noDiff"/, "the state names itself from the string table");
  assert.match(fromBuild, /data-i18n="diff\.noDiff\.hint"/, "the state points at the control that resolves it");
  const strings = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
  const hints = strings.match(/"diff\.noDiff\.hint":\s*"([^"]*)"/g) || [];
  assert.equal(hints.length, 2, "the hint is translated in both locales");
  for (const hint of hints) {
    assert.doesNotMatch(hint, /[⌘⌥⇧⌃]|\bF\d\b/, `the hint spells a shortcut instead of naming the control: ${hint}`);
  }
});

test("the leaf-name split is the same on the server and in the viewer", () => {
  const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const body = (source, name) => {
    const found = /function leafNameHtml\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
    assert.ok(found, `${name} still splits a leaf name`);
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

test("the two message resolvers finish a sentence the same way", async () => {
  const { fillMessage } = await import("../dist/i18n.js");
  const source = readFileSync(new URL("../src/viewer/01-core.js", import.meta.url), "utf8");
  const found = /\nfunction t\(key, values\) \{([\s\S]*?)\n\}\n/.exec(source);
  assert.ok(found, "the viewer still resolves a message in t()");
  const build = new Function("I18N", "locale", `return function t(key, values) {${found[1]}\n};`);

  const CASES = [
    ["{n} {{n:usage|usages}}", { n: 1 }],
    ["{n} {{n:usage|usages}}", { n: 0 }],
    ["{n} {{n:usage|usages}}", { n: 2 }],
    ["{n} {{n:problem|problems}} ({errors} {{errors:error|errors}}) in {files} {{files:file|files}}",
      { n: 1, errors: 1, files: 1 }],
    ["{n} {{n:problem|problems}} ({errors} {{errors:error|errors}}) in {files} {{files:file|files}}",
      { n: 25, errors: 0, files: 272 }],
    ["{n} {{n:result|results}}", { n: "134+" }],
    ["{n} {{n:result|results}}", { n: "1" }],
    ["{count} unchanged {{count:line|lines}}", { count: 0 }],
    ["{symbol} has no type", {}],
    ["{n} of {total}", { n: 3 }],
    ["{{n:file has|files have}} no language server", {}],
    ["nothing to interpolate", { n: 1 }],
    ["{n}%", { n: 100 }],
  ];
  for (const [text, values] of CASES) {
    const viewer = build({ en: { probe: text } }, "en")("probe", values);
    const main = fillMessage(text, values);
    assert.equal(viewer, main, `both finish ${JSON.stringify(text)} with ${JSON.stringify(values)} the same way`);
  }
  assert.equal(build({ en: { probe: "{n} {{n:a|b}}" } }, "en")("probe"), fillMessage("{n} {{n:a|b}}", undefined));
});

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
  assert.ok(twins.length > 0, "the sweep still recognises a declaration at all");

  const unexplained = twins.filter(([name]) => !(name in KNOWN_TWINS))
    .map(([name, files]) => `${name}  (${files.join(", ")})`);
  assert.deepEqual(unexplained, [],
    `delete one copy if both are TypeScript — they are in one program. If the pair straddles the server and\n`
    + `the viewer, give it a behavioural guard and a line in KNOWN_TWINS saying so:\n  ${unexplained.join("\n  ")}`);

  const stale = Object.keys(KNOWN_TWINS).filter((name) => !twins.some(([twin]) => twin === name));
  assert.deepEqual(stale, [], "these are no longer declared twice");
});

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

test("the preload imports only what a sandboxed preload is given", () => {
  const source = readFileSync(resolve(import.meta.dirname, "..", "src", "preload.cts"), "utf8");
  const imports = Array.from(source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"electron"/g))
    .flatMap((match) => match[1].split(",").map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean));
  assert.ok(imports.includes("contextBridge") && imports.includes("ipcRenderer"),
    `the reader found the preload's electron imports at all: ${JSON.stringify(imports)}`);

  const SANDBOX_SAFE = ["contextBridge", "crashReporter", "ipcRenderer", "nativeImage", "webFrame", "webUtils"];
  const unavailable = imports.filter((name) => !SANDBOX_SAFE.includes(name));
  assert.deepEqual(unavailable, [],
    `app-main.ts runs this preload with sandbox: true, and a sandboxed preload is handed only `
    + `${SANDBOX_SAFE.join(", ")} — every other electron export is undefined at runtime. `
    + `${JSON.stringify(unavailable)} would be undefined, and the failure is silent: clipboard.readText() `
    + `inside a try returned "" for a year while Compare with Clipboard quietly did nothing. `
    + `Reach it from the main process over IPC instead, as kakapo:clipboard-read does.`);
});
