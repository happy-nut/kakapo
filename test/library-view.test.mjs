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
