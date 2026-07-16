import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

test("package, launcher, documentation, and source use the Kakapo identity exclusively", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "@happy-nut/kakapo");
  assert.deepEqual(pkg.bin, { kakapo: "bin/kakapo.js" });
  assert.equal(existsSync(join(root, "bin", "kakapo.js")), true);
  assert.equal(existsSync(join(root, "assets", "kakapo-core-flow.gif")), true);

  const legacyBrand = ["mona", "cori"].join("");
  const textExtensions = new Set(["", ".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ts", ".yml", ".yaml"]);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
  const offenders = [];
  for (const relative of tracked) {
    const file = join(root, relative);
    if (!existsSync(file) || !textExtensions.has(extname(relative))) continue;
    if (readFileSync(file, "utf8").toLowerCase().includes(legacyBrand)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], `legacy product identity remains in: ${offenders.join(", ")}`);
});
