import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("clangd-index");
repo.put("main.c", ["#include \"target.h\"", "", "int main(void) {", "  return value();", "}"].join("\n") + "\n");
repo.put("target.h", ["#pragma once", "", "int value(void);"].join("\n") + "\n");
repo.commit("initial");

repo.put("main.c", ["#include \"target.h\"", "", "int main(void) {", "  return value() + 1;", "}"].join("\n") + "\n");
repo.put("helper.c", ["#include \"target.h\"", "", "int helper(void) { return value(); }"].join("\n") + "\n");

const index = join(repo.dir, ".cache", "clangd", "index");
mkdirSync(index, { recursive: true });
writeFileSync(join(index, "main.c.51B8DF90E4B3D1D7.idx"), "CdIxindex payload\n");
writeFileSync(join(index, "target.h.5FB022FE0B812705.idx"), "CdIxindex payload\n");

await drive("clangd-index-hidden", repo, async (page, h) => {
  const listed = await h.until(`(() => {
    const rows = [
      ...document.querySelectorAll('a.file-link[data-file]'),
      ...document.querySelectorAll('.change-row[data-file]'),
      ...document.querySelectorAll('[data-path]'),
    ].map((el) => el.getAttribute('data-file') || el.getAttribute('data-path')).filter(Boolean);
    return rows.length ? [...new Set(rows)] : null;
  })()`, 30000);

  h.check(listed.includes("main.c"), "the edited file is in the review", JSON.stringify(listed));
  h.check(listed.includes("helper.c"), "an untracked source file is in the review, so the review has something to lose");
  h.check(!listed.some((path) => path.includes(".cache/clangd")),
    "the index clangd writes into the project is not offered as part of the user's change", JSON.stringify(listed));

  const everywhere = await page.evaluate(`(() => {
    const text = document.body.innerText || "";
    return { hit: text.includes(".cache/clangd") || text.includes(".idx"), sample: text.slice(0, 200) };
  })()`);
  h.check(!everywhere.hit, "nor does its name appear anywhere on the page", JSON.stringify(everywhere.sample));

  await h.shot("clangd-index-hidden");
}, { args: ["--include-untracked"] });
