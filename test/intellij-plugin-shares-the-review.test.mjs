import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { commentsFilePath } from "../dist/comments-file.js";
import { bundledJdk } from "../scripts/gradle-with-bundled-jdk.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pluginDir = join(repoRoot, "intellij-plugin");
const store = readFileSync(join(pluginDir, "src/main/kotlin/dev/kakapo/comments/CommentStore.kt"), "utf8");

test("the plugin writes the review kakapo reads, not one of its own", () => {
  const scratch = mkdtempSync(join(tmpdir(), "kakapo-plugin-path-"));
  try {
    execFileSync("git", ["init", "-q", scratch], { stdio: "ignore" });
    const path = commentsFilePath(scratch);
    assert.ok(path, "kakapo has a comments file for a repository");
    assert.ok(path.replace(/\\/g, "/").endsWith("/.git/kakapo/comments.jsonl"),
      `and this is where it keeps it: ${path}`);
    assert.match(store, /\.resolve\("kakapo"\)\.resolve\("comments\.jsonl"\)/,
      "the plugin resolves the same file, so a comment written in either tool is one review");
    assert.match(store, /Path\.of\(base, "\.git"\)/, "under the repository's own git directory");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the record the plugin writes is the record kakapo defines", () => {
  const record = readFileSync(join(repoRoot, "src", "comments-file.ts"), "utf8");
  const fields = [...record.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
  for (const field of ["id", "path", "line", "anchor", "kind", "by", "text"]) {
    assert.ok(fields.includes(field), `ThreadRecord still has ${field}`);
    assert.match(store, new RegExp(`"${field}"`), `and the plugin writes ${field}`);
  }
});

test("the anchoring rule is checkable without an IDE, and npm says how", () => {
  const anchor = readFileSync(join(pluginDir, "src/main/kotlin/dev/kakapo/comments/Anchor.kt"), "utf8");
  assert.doesNotMatch(anchor, /com\.intellij/,
    "an IDE import here would make the one risky rule unverifiable outside a sandbox");
  const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;
  assert.equal(scripts["idea:anchor"], "node scripts/gradle-with-bundled-jdk.mjs anchorCheck");
  assert.equal(scripts["idea:build"], "node scripts/gradle-with-bundled-jdk.mjs buildPlugin");
});

test("the Diff window is wired by its own API, not by reflection", () => {
  const extension = readFileSync(join(pluginDir, "src/main/kotlin/dev/kakapo/comments/DiffCommentExtension.kt"), "utf8");
  assert.match(extension, /is TwosideTextDiffViewer -> viewer\.editors/,
    "a diff shows two editors and the viewer names them");
  assert.match(extension, /is UnifiedDiffViewer -> listOf\(viewer\.editor\)/, "and one in the unified view");
  assert.doesNotMatch(extension, /javaClass\.methods|getDeclaredMethod/,
    "reflection here compiles against an IDE that renamed the method and fails only at runtime");

  const plugin = readFileSync(join(pluginDir, "src/main/resources/META-INF/plugin.xml"), "utf8");
  assert.match(plugin, /diff\.DiffExtension/, "the extension point is registered, or nothing paints in the Diff window");
});

test("a comment can be written where VIRTUAL_FILE is null, which is every diff editor", () => {
  const action = readFileSync(join(pluginDir, "src/main/kotlin/dev/kakapo/comments/AddCommentAction.kt"), "utf8");
  assert.match(action, /CommentedEditor\.fileOf\(editor, event\.getData\(CommonDataKeys\.VIRTUAL_FILE\)\)/,
    "the file comes from the document when the data context has none");
  const helper = readFileSync(join(pluginDir, "src/main/kotlin/dev/kakapo/comments/CommentedEditor.kt"), "utf8");
  assert.match(helper, /FileDocumentManager\.getInstance\(\)\.getFile\(editor\.document\)/);
});

test("a release's notes are written for that release, not inherited from the last one", () => {
  const build = readFileSync(join(pluginDir, "build.gradle.kts"), "utf8");
  const version = build.match(/^version = "([^"]+)"$/m);
  assert.ok(version, "the plugin declares its version");

  assert.match(build, /changeNotes = releaseNotes\(project\.version\.toString\(\)\)/,
    "notes come from the changelog, because a literal here keeps describing the version before it");

  const changelog = readFileSync(join(pluginDir, "CHANGELOG.md"), "utf8");
  const headings = [...changelog.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
  assert.ok(headings.includes(version[1]),
    `CHANGELOG.md needs a '## ${version[1]}' section before ${version[1]} can be published`);
});

test("publishing finds the token without a human pasting it", () => {
  const build = readFileSync(join(pluginDir, "build.gradle.kts"), "utf8");
  assert.match(build, /environmentVariable\("JETBRAINS_MARKETPLACE_TOKEN"\)/, "CI passes it in the environment");
  assert.match(build, /\.config\/kakapo\/jetbrains-marketplace-token/,
    "and a machine that has one on disk publishes without being told where it is");
  const scripts = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts;
  assert.equal(scripts["idea:publish"], "node scripts/gradle-with-bundled-jdk.mjs publishPlugin");
});

test("the plugin compiles against the JDK this repository already pins", () => {
  const jdk = bundledJdk("darwin", "arm64", repoRoot);
  assert.equal(jdk, join(repoRoot, "vendor/language-servers/darwin-arm64/java/jdk"),
    "the same bundled JDK that Java reading uses, so there is one pinned Java here and not two");
  const build = readFileSync(join(pluginDir, "build.gradle.kts"), "utf8");
  assert.match(build, /jvmToolchain\(21\)/, "and the toolchain the build asks for is the one it is given");
});

test("a review written in kakapo is marked when the file is opened, not only in a diff", () => {
  const plugin = readFileSync(join(pluginDir, "src/main/resources/META-INF/plugin.xml"), "utf8");
  const build = readFileSync(join(pluginDir, "build.gradle.kts"), "utf8");
  const readme = readFileSync(join(pluginDir, "README.md"), "utf8");

  const promised = /marked in the IDE's gutter/.test(build) || /marked in the IDE's gutter/.test(readme);
  assert.ok(promised, "the listing and the README are where this promise is made");

  assert.match(plugin, /postStartupActivity implementation="dev\.kakapo\.comments\.CommentMarksOnOpen"/,
    "so something has to paint on open; the diff extension only fires inside the Diff window");

  const onOpen = readFileSync(join(pluginDir, "src/main/kotlin/dev/kakapo/comments/CommentMarksOnOpen.kt"), "utf8");
  assert.match(onOpen, /FileEditorManagerListener\.FILE_EDITOR_MANAGER/, "for files opened later");
  assert.match(onOpen, /manager\.openFiles/, "and for the ones already open when the project loads");
  assert.match(onOpen, /CommentMarks\.refresh/, "through the one painter");
});
