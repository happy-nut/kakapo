// What the reviewed repository is made of — modules and test roots (src/project-layout.ts).
//
// Every assertion here is against a real directory tree, because the whole point of this module is that
// it does not guess: it reads the project's own declarations and checks the filesystem. A test that
// stubbed the filesystem would pass while the thing it guards (is `testSrc` a test root? only the .iml
// knows) was broken.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readProjectLayout, moduleForPath, isTestSourcePath } from "../dist/project-layout.js";

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A throwaway repo. `files` maps a relative path to its content; a path ending in `/` is a bare directory. */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "kakapo-layout-"));
  made.push(dir);
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/")) {
      mkdirSync(join(dir, path), { recursive: true });
      continue;
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const iml = (folders) => `<?xml version="1.0" encoding="UTF-8"?>
<module type="JAVA_MODULE" version="4">
  <component name="NewModuleRootManager">
    <content url="file://$MODULE_DIR$">
${folders.map((line) => `      ${line}`).join("\n")}
    </content>
  </component>
</module>
`;

// ---- 1. IntelliJ's own files ----------------------------------------------------------------------

test("modules.xml names the modules and the .iml says which roots are tests", () => {
  const dir = repo({
    ".idea/modules.xml": `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ProjectModuleManager">
    <modules>
      <module fileurl="file://$PROJECT_DIR$/app/billing-app.iml" filepath="$PROJECT_DIR$/app/billing-app.iml" group="frontend" />
      <module fileurl="file://$PROJECT_DIR$/core/billing-core.iml" filepath="$PROJECT_DIR$/core/billing-core.iml" />
    </modules>
  </component>
</project>`,
    // `testSrc` is a test root in no convention anywhere. Only the .iml knows, which is the point.
    "app/billing-app.iml": iml([
      '<sourceFolder url="file://$MODULE_DIR$/src" isTestSource="false" />',
      '<sourceFolder url="file://$MODULE_DIR$/testSrc" isTestSource="true" />',
      '<sourceFolder url="file://$MODULE_DIR$/gen" isTestSource="false" generated="true" />',
    ]),
    "core/billing-core.iml": iml([
      '<sourceFolder url="file://$MODULE_DIR$/src/main/java" isTestSource="false" />',
      '<sourceFolder url="file://$MODULE_DIR$/src/test/resources" type="java-test-resource" />',
    ]),
    "app/src/Main.java": "class Main {}\n",
    "app/testSrc/MainTest.java": "class MainTest {}\n",
  });

  const layout = readProjectLayout(dir);
  assert.equal(layout.source, "intellij");
  assert.deepEqual(layout.modules.map((module) => [module.name, module.root]), [
    ["billing-app", "app"],
    ["billing-core", "core"],
  ], "the module name is the .iml's name, not the directory's");
  assert.equal(layout.modules[0].group, "frontend", "and modules.xml's group travels with it");
  assert.ok(layout.testRoots.includes("app/testSrc"), `declared test root: ${JSON.stringify(layout.testRoots)}`);
  assert.ok(layout.testRoots.includes("core/src/test/resources"), "a test RESOURCE root counts as test sources");
  assert.deepEqual(layout.generatedRoots, ["app/gen"]);

  assert.equal(isTestSourcePath(layout, "app/testSrc/MainTest.java"), true);
  assert.equal(isTestSourcePath(layout, "app/src/Main.java"), false);
  assert.equal(moduleForPath(layout, "core/src/main/java/A.java").name, "billing-core");
});

test("a single-module project keeps its .iml at the root and has no modules.xml", () => {
  const dir = repo({
    "thing.iml": iml(['<sourceFolder url="file://$MODULE_DIR$/spec" isTestSource="true" />']),
    "spec/": "",
    "src/": "",
  });
  const layout = readProjectLayout(dir);
  assert.equal(layout.source, "intellij");
  assert.deepEqual(layout.modules, [{ name: "thing", root: "", group: undefined }]);
  assert.ok(layout.testRoots.includes("spec"));
});

test("IntelliJ's answer wins over the build manifest in the same repo", () => {
  const dir = repo({
    ".idea/modules.xml": `<project version="4"><component name="ProjectModuleManager"><modules>
      <module filepath="$PROJECT_DIR$/one.iml" />
    </modules></component></project>`,
    "one.iml": iml([]),
    "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "packages/a/package.json": JSON.stringify({ name: "@scope/a" }),
  });
  const layout = readProjectLayout(dir);
  assert.equal(layout.source, "intellij");
  assert.deepEqual(layout.modules.map((module) => module.name), ["one"]);
});

// ---- 2. the build tool's workspace ----------------------------------------------------------------

test("pnpm workspace globs expand, and a module is called what its own manifest calls it", () => {
  const dir = repo({
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - apps/web\n",
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui" }),
    "packages/data/package.json": JSON.stringify({ name: "@acme/data" }),
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "packages/data/test/data.test.ts": "",
  });
  const layout = readProjectLayout(dir);
  assert.equal(layout.source, "workspace");
  assert.deepEqual(layout.modules.map((module) => [module.name, module.root]), [
    ["web", "apps/web"],
    ["@acme/data", "packages/data"],
    ["@acme/ui", "packages/ui"],
  ]);
  assert.deepEqual(layout.testRoots, ["packages/data/test"], "a module with no tests contributes no root");
});

test("npm workspaces, a Cargo workspace and go.work each name their members", () => {
  const npm = readProjectLayout(repo({
    "package.json": JSON.stringify({ name: "root", workspaces: ["libs/*"] }),
    "libs/one/package.json": JSON.stringify({ name: "one" }),
  }));
  assert.deepEqual(npm.modules.map((module) => module.root), ["libs/one"]);

  const cargo = readProjectLayout(repo({
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    "crates/engine/Cargo.toml": '[package]\nname = "engine"\n',
    "crates/engine/tests/": "",
  }));
  assert.equal(cargo.source, "workspace");
  assert.deepEqual(cargo.modules.map((module) => module.name), ["engine"], "the name comes from Cargo.toml");
  assert.deepEqual(cargo.testRoots, ["crates/engine/tests"]);

  const go = readProjectLayout(repo({
    "go.work": "go 1.22\n\nuse ./cmd/server\nuse ./internal/store\n",
    "cmd/server/main.go": "package main\n",
    "internal/store/store.go": "package store\n",
  }));
  assert.deepEqual(go.modules.map((module) => module.root), ["cmd/server", "internal/store"]);
});

test("a Gradle project path's colons are directories, and Maven lists its modules", () => {
  const gradle = readProjectLayout(repo({
    "settings.gradle": "rootProject.name = 'demo'\ninclude ':app', ':core:data'\n",
    "app/build.gradle": "",
    "core/data/build.gradle": "",
  }));
  assert.deepEqual(gradle.modules.map((module) => module.root), ["app", "core/data"]);

  const maven = readProjectLayout(repo({
    "pom.xml": "<project><modules><module>service</module><module>client</module></modules></project>",
    "service/pom.xml": "",
    "client/pom.xml": "",
    "service/src/test/java/": "",
  }));
  assert.deepEqual(maven.modules.map((module) => module.root), ["client", "service"]);
  assert.deepEqual(maven.testRoots, ["service/src/test"], "src/test covers src/test/java — one prefix, same answer");
});

// ---- 3. conventions -------------------------------------------------------------------------------

test("a plain repo is one module whose test roots are the ones that exist", () => {
  const dir = repo({ "src/index.ts": "", "test/index.test.ts": "", "docs/readme.md": "" });
  const layout = readProjectLayout(dir);
  assert.equal(layout.source, "conventions");
  assert.equal(layout.modules.length, 1);
  assert.equal(layout.modules[0].root, "");
  assert.deepEqual(layout.testRoots, ["test"]);
  assert.deepEqual(layout.generatedRoots, []);
  assert.equal(moduleForPath(layout, "src/index.ts").root, "", "everything belongs to the one module");
});

test("a directory that is not there is not a root, and a missing repo is an empty layout", () => {
  const layout = readProjectLayout(repo({ "src/index.ts": "" }));
  assert.deepEqual(layout.testRoots, [], "no test directory exists, so none is declared");
  const missing = readProjectLayout(join(tmpdir(), "kakapo-layout-does-not-exist"));
  assert.deepEqual(missing.modules, []);
  assert.equal(moduleForPath(missing, "a/b.ts"), null);
  assert.equal(isTestSourcePath(missing, "test/a.ts"), false, "without a declared root this says no — the path conventions are the renderer's fallback");
});

test("the deepest module root owns the path", () => {
  const layout = {
    modules: [{ name: "root", root: "" }, { name: "web", root: "apps/web" }, { name: "shared", root: "apps" }],
    testRoots: [],
    generatedRoots: [],
    source: "workspace",
  };
  assert.equal(moduleForPath(layout, "apps/web/src/a.ts").name, "web");
  assert.equal(moduleForPath(layout, "apps/other/a.ts").name, "shared");
  assert.equal(moduleForPath(layout, "tools/a.ts").name, "root");
});

// ---- what the reviewed repository is allowed to make this read ---------------------------------------
// Three bugs from the 2026-10-26 bounty, each confirmed against readProjectLayout before it was fixed.

test("a Cargo workspace is found however its [workspace] keys are ordered", () => {
  // `[^[]*?members` could not cross the `[` of an earlier array, so `exclude` or `default-members`
  // above `members` — which is where a formatter that sorts keys alphabetically puts both — read as
  // "this is not a workspace" and the repo lost every module it had.
  const dir = repo({
    "Cargo.toml": '[workspace]\nresolver = "2"\nexclude = ["old"]\ndefault-members = ["crates/a"]\nmembers = ["crates/a"]\n',
    "crates/a/Cargo.toml": '[package]\nname = "crate-a"\n',
    "crates/a/src/lib.rs": "",
  });
  const layout = readProjectLayout(dir);
  assert.equal(layout.source, "workspace");
  assert.deepEqual(Array.from(layout.modules, (m) => m.name).sort(), ["crate-a"]);
});

test("only `packages:` in pnpm-workspace.yaml names a module", () => {
  // pnpm 10 puts other lists in this file. Reading every `- item` in it as a package pattern invented a
  // module for any that happened to name a directory that exists.
  const dir = repo({
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\nonlyBuiltDependencies:\n  - esbuild\n",
    "packages/ui/package.json": '{"name":"@acme/ui"}',
    "esbuild/index.js": "",
  });
  const layout = readProjectLayout(dir);
  assert.deepEqual(Array.from(layout.modules, (m) => m.name), ["@acme/ui"],
    "esbuild is a built dependency, not a package of this workspace");
});

test("a reviewed repository cannot point the layout outside itself", () => {
  // `.idea/modules.xml` is content of the repo under review. This one named an .iml two directories
  // above the review root; kakapo read it and took its source folders into the layout.
  const dir = repo({
    ".idea/modules.xml": '<project><component><modules>'
      + '<module filepath="$PROJECT_DIR$/../../OUTSIDE.iml" />'
      + '<module filepath="$PROJECT_DIR$/inside.iml" />'
      + "</modules></component></project>",
    "inside.iml": '<module><component>'
      + '<sourceFolder url="file://$MODULE_DIR$/src/test" isTestSource="true" />'
      + '<sourceFolder url="file://$MODULE_DIR$/../../leaked" isTestSource="true" />'
      + "</component></module>",
    "src/test/a.ts": "",
  });
  const layout = readProjectLayout(dir);
  assert.deepEqual(Array.from(layout.modules, (m) => m.name), ["inside"], "the escaping module is not read");
  assert.ok(!layout.testRoots.some((root) => root.includes("..")), `no root climbs out: ${layout.testRoots}`);
  assert.ok(layout.testRoots.includes("src/test"), "and the one that stays inside is still found");
});

test("a workspace member cannot climb out of the repository either", () => {
  const dir = repo({
    "package.json": '{"name":"root","workspaces":["../escape-target","packages/*"]}',
    "packages/ui/package.json": '{"name":"@acme/ui"}',
  });
  // The escape target has to EXIST, or the directory check already drops it and this test passes against
  // the bug. It is a sibling of the throwaway repo, inside the same temp directory.
  const outside = join(dir, "..", "escape-target");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "package.json"), '{"name":"outside"}');
  made.push(outside);
  const layout = readProjectLayout(dir);
  assert.ok(!layout.modules.some((m) => m.root.includes("..")), `no module root climbs out: ${JSON.stringify(layout.modules)}`);
  assert.ok(!layout.modules.some((m) => m.name === "outside"), "and its manifest was never read");
});
