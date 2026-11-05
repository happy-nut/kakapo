// The renderer half of library navigation: a definition that lands outside the project index opens as a
// read-only tab. main's half (which paths it will serve at all) is pinned in library-source.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

let html;
const LIBRARY_PATH = "/opt/typescript/lib/lib.es2022.d.ts";
const LIBRARY_SOURCE = "interface Array<T> {\n  at(index: number): T | undefined;\n}\n";

before(async () => {
  ({ html } = await makeReviewHtml([{ path: "src/app.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" }]));
});

after(cleanupFixtures);

// Stands in for the main process: it answers for the one library path a language server reported, and for
// nothing else — the same contract librarySource() enforces in app-review-ipc.ts.
function installLibraryBridge(v) {
  const asked = [];
  v.window.kakapoFile = {
    getSource: (path) => {
      asked.push(path);
      if (path !== LIBRARY_PATH) return Promise.resolve(null);
      return Promise.resolve({
        path: LIBRARY_PATH,
        name: "lib.es2022.d.ts",
        language: "typescript",
        content: LIBRARY_SOURCE,
        size: LIBRARY_SOURCE.length,
        changed: false,
        embedded: true,
        changedLines: [],
        signature: "lib",
        library: true,
      });
    },
  };
  return asked;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a library file opens in the source view and says what it is", async () => {
  const v = await loadViewer(html);
  try {
    installLibraryBridge(v);
    v.window.openSourceFile(LIBRARY_PATH);
    await settle();

    assert.equal(v.$("#source-viewer").dataset.openPath, LIBRARY_PATH, "the library file is the open tab");
    assert.match(v.$("#source-body").textContent, /at\(index: number\)/, "its contents are painted");
    assert.match(v.$("#source-meta").textContent, /library|라이브러리/, "the meta line marks it as library code");
    assert.ok(
      v.$("#source-tabs").querySelector(`.source-tab[data-tab-path="${LIBRARY_PATH}"]`),
      "it gets an ordinary tab, so it can be closed like any other",
    );
    // Its absolute path is not a tree inside this project. Split into crumbs it read as one —
    // `opt › ts › lib › lib.es2022.d.ts` — which invents a structure the reviewer does not have.
    const crumbs = v.$("#source-title");
    assert.ok(crumbs.querySelector(".crumb-library"), "the breadcrumb says the file is from outside the review");
    assert.equal(
      crumbs.querySelector(".crumb-leaf").textContent,
      LIBRARY_PATH,
      "and shows the path whole, instead of pretending its segments are project directories",
    );
  } finally {
    v.close();
  }
});

test("a library file joins no index: the tree and quick-open stay the project's own files", async () => {
  const v = await loadViewer(html);
  try {
    installLibraryBridge(v);
    v.window.openSourceFile(LIBRARY_PATH);
    await settle();

    assert.equal(
      Boolean(v.document.querySelector(`[data-source-file="${LIBRARY_PATH}"]`)),
      false,
      "nothing was added to the file tree",
    );
    await v.openQuickOpenSection("all");
    v.typeInto(v.$("#quick-open-input"), "lib.es2022");
    await v.settle(30);
    assert.equal(
      v.$all("#quick-open-results .quick-open-item").length,
      0,
      "and quick-open does not offer it either: the index is still the project's own files",
    );
  } finally {
    v.close();
  }
});

test("a comment cannot be anchored to a library file", async () => {
  const v = await loadViewer(html);
  try {
    installLibraryBridge(v);
    v.window.openSourceFile(LIBRARY_PATH);
    await settle();
    v.window.setSourceCursor(LIBRARY_PATH, 1, 0, true, 1);

    const before = v.window.reviewComments.length;
    v.window.openComposer("question");
    assert.equal(v.window.composerState, null, "no composer opens on library code");
    v.window.openComposer("note");
    assert.equal(v.window.reviewComments.length, before, "and nothing was added to the thread");
  } finally {
    v.close();
  }
});

test("a path main refuses to serve does not open a blank tab", async () => {
  const v = await loadViewer(html);
  try {
    const asked = installLibraryBridge(v);
    v.window.openSourceFile("/Users/someone/.ssh/id_rsa");
    await settle();

    assert.deepEqual(asked, ["/Users/someone/.ssh/id_rsa"], "the renderer asked once");
    assert.notEqual(
      v.$("#source-viewer").dataset.openPath,
      "/Users/someone/.ssh/id_rsa",
      "a refusal leaves the view where it was instead of opening an empty file",
    );
  } finally {
    v.close();
  }
});

// Three different things reach the same miss, and only one of them is a failure. Before this, all three
// said "could not be opened" — which made two known limits look like bugs and sent one real answer
// (Sorbet publishes its stdlib RBIs on github.com and ships no file) nowhere at all.
const hintText = (v) => (v.$(".mc-caret-hint")?.textContent || "").trim();
const filled = (v, key, label) => v.window.t(key).replace("{file}", () => label);

test("a definition published only on the web is handed to the browser", async () => {
  const v = await loadViewer(html);
  try {
    installLibraryBridge(v);
    const opened = [];
    v.window.open = (url) => { opened.push(url); return null; };
    const target = "https://github.com/sorbet/sorbet/tree/aafce23/rbi/stdlib/json.rbi#L194";

    v.window.openSourceFile(target);
    await settle();

    assert.deepEqual(opened, [target], "the URL went to the browser, which is the only place that source is");
    assert.equal(hintText(v), filled(v, "source.libraryOnWeb", "json.rbi#L194"), "and the hint says so");
    assert.notEqual(v.$("#source-viewer").dataset.openPath, target, "no empty tab opened for it");
  } finally {
    v.close();
  }
});

test("a target inside an archive or a JDK image says that, and does not open a browser", async () => {
  const v = await loadViewer(html);
  try {
    installLibraryBridge(v);
    const opened = [];
    v.window.open = (url) => { opened.push(url); return null; };
    // What the Kotlin server answers for java.time.Instant: an entry in the JDK's jimage, which needs a
    // decompiler this app does not ship. A `$` in the name is the other half of this test — `$&` in a
    // replacement STRING is a pattern, and a Java inner class is spelled `Map$Entry`.
    v.window.openSourceFile("/opt/kotlin/jbr/Contents/Home!/java.base/java/util/Map$Entry.class");
    await settle();

    assert.equal(hintText(v), filled(v, "source.libraryInArchive", "Map$Entry.class"));
    assert.deepEqual(opened, [], "a path is not a URL — nothing is handed to the OS");
  } finally {
    v.close();
  }
});

test("a server-named file that simply would not read keeps the plain message", async () => {
  const v = await loadViewer(html);
  try {
    installLibraryBridge(v);
    v.window.openSourceFile("/opt/typescript/lib/gone.d.ts");
    await settle();

    assert.equal(hintText(v), filled(v, "source.libraryUnavailable", "gone.d.ts"));
    // The control: the three messages really are different, so the two above cannot be passing by accident.
    assert.notEqual(v.window.t("source.libraryUnavailable"), v.window.t("source.libraryOnWeb"));
    assert.notEqual(v.window.t("source.libraryUnavailable"), v.window.t("source.libraryInArchive"));
  } finally {
    v.close();
  }
});
