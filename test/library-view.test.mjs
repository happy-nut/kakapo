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
    assert.notEqual(v.window.t("source.libraryUnavailable"), v.window.t("source.libraryOnWeb"));
    assert.notEqual(v.window.t("source.libraryUnavailable"), v.window.t("source.libraryInArchive"));
  } finally {
    v.close();
  }
});

const INDEX_FILE = { path: "src/app.ts", name: "app.ts", language: "typescript", content: "", size: 20,
  changed: true, embedded: true, changedLines: [1], signature: "s1" };

function countSourceOpens(v, cap) {
  const real = v.window.openSourceFile;
  let calls = 0;
  v.window.openSourceFile = function (...args) {
    calls += 1;
    return calls > cap ? undefined : real.apply(this, args);
  };
  return () => calls;
}

async function lazyViewer(bridge) {
  const { html: lazyHtml } = await makeReviewHtml(
    [{ path: "src/app.ts", before: "export const a = 1;\n", after: "export const a = 2;\n" }],
    { lazyLoad: true, app: true },
  );
  const v = await loadViewer(lazyHtml);
  v.window.kakapoFile = bridge(v);
  return v;
}

test("a library tab outlives the project index that lands after it", async () => {
  const v = await lazyViewer((view) => {
    installLibraryBridge(view);
    return Object.assign(view.window.kakapoFile, {
      getIndex: () => Promise.resolve({
        signature: view.$("#review-meta").dataset.signature || "",
        sourceFilesMeta: [INDEX_FILE],
        filesTree: "",
      }),
    });
  });
  try {
    v.window.openSourceFile(LIBRARY_PATH);
    await settle();
    assert.match(v.$("#source-body").textContent, /at\(index: number\)/, "the library file paints first");

    await v.window.ensureProjectIndex();

    const opens = countSourceOpens(v, 30);
    v.window.openSourceFile(LIBRARY_PATH);
    await settle(150);

    assert.ok(opens() <= 3, `reopening the tab must settle, not retry forever (took ${opens()} calls)`);
    assert.equal(v.$("#source-viewer").dataset.openPath, LIBRARY_PATH, "it is still the open tab");
    assert.match(v.$("#source-body").textContent, /at\(index: number\)/, "and still painted");
  } finally {
    v.close();
  }
});

test("an indexed file main has no answer for stops, instead of retrying for ever", async () => {
  const v = await lazyViewer(() => ({ getSource: () => Promise.resolve(null) }));
  try {
    const opens = countSourceOpens(v, 30);
    v.window.openSourceFile("src/app.ts");
    await settle(150);
    assert.ok(opens() <= 3, `a missing file must settle, not retry forever (took ${opens()} calls)`);
    assert.equal(v.$("#source-viewer").dataset.openPath, "src/app.ts", "the tab is open");
    assert.ok(!v.$("#source-body").classList.contains("is-loading"), "and not stuck on its loading state");
  } finally {
    v.close();
  }
});
