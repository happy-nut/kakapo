import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeReviewHtml, cleanupFixtures } from "./helpers/fixture.mjs";
import { loadViewer } from "./helpers/dom.mjs";

const DOC = "docs/guide.md";
const BODY = [
  "# Guide",
  "",
  "See [the flows](../test/USER_FLOWS.md) and [the readme](/README.md).",
  "Also [a sibling](notes.md), [an anchor](#guide) and [the web](https://example.com/x).",
  "",
].join("\n");

let html;
before(async () => {
  ({ html } = await makeReviewHtml([
    { path: DOC, before: "# Guide\n", after: BODY },
    { path: "docs/notes.md", before: "", after: "# Notes\n" },
    { path: "test/USER_FLOWS.md", before: "", after: "# Flows\n" },
    { path: "README.md", before: "", after: "# Readme\n" },
  ]));
});
after(cleanupFixtures);

test("in-repo links are followable and external ones still leave", async () => {
  const v = await loadViewer(html);
  try {
    await v.openSourceFile(DOC);
    await v.settle(120);
    const links = [...v.$all("#source-body a")];
    assert.ok(links.length >= 5, `the document's links rendered (${links.length})`);

    const repo = links.filter((a) => a.hasAttribute("data-md-link"));
    assert.deepEqual(repo.map((a) => a.getAttribute("data-md-link")).sort(),
      ["../test/USER_FLOWS.md", "/README.md", "notes.md"].sort(),
      "every href that names a file in this repository is marked as one");

    for (const a of repo) {
      assert.notEqual(a.getAttribute("target"), "_blank",
        `${a.getAttribute("data-md-link")} is not sent to a browser that will refuse it`);
    }
    const web = links.find((a) => (a.getAttribute("href") || "").startsWith("https://"));
    assert.equal(web.getAttribute("target"), "_blank", "a real URL still opens outside");
    assert.equal(web.getAttribute("rel"), "noopener noreferrer", "and keeps its rel");

    const anchor = links.find((a) => (a.getAttribute("href") || "") === "#guide");
    assert.ok(anchor && !anchor.hasAttribute("data-md-link"), "an in-page anchor is left alone");
  } finally {
    v.close();
  }
});

test("a link resolves against the document it was written in", async () => {
  const v = await loadViewer(html);
  try {
    await v.openSourceFile(DOC);
    await v.settle(120);
    const resolve = (href) => v.window.resolveRepoHref(DOC, href);
    assert.equal(resolve("notes.md"), "docs/notes.md", "a sibling stays in the document's own directory");
    assert.equal(resolve("../test/USER_FLOWS.md"), "test/USER_FLOWS.md", "`..` climbs out of it");
    assert.equal(resolve("/README.md"), "README.md", "a leading slash means the repository root");
    assert.equal(resolve("./notes.md"), "docs/notes.md", "`./` is a no-op, not a directory");
    assert.equal(resolve("notes.md#section"), "docs/notes.md", "a fragment names a place in the file, not the file");
    assert.equal(resolve("#guide"), "", "a bare fragment names no file at all");
  } finally {
    v.close();
  }
});

test("clicking an in-repo link opens that file", async () => {
  const v = await loadViewer(html);
  try {
    await v.openSourceFile(DOC);
    await v.settle(120);
    const link = v.$all("#source-body a[data-md-link]")
      .find((a) => a.getAttribute("data-md-link") === "../test/USER_FLOWS.md");
    assert.ok(link, "the link is there to click");

    link.dispatchEvent(new v.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await v.settle(150);

    assert.equal(v.$("#source-viewer").dataset.openPath, "test/USER_FLOWS.md",
      "the review followed the link instead of swallowing the click");
  } finally {
    v.close();
  }
});
