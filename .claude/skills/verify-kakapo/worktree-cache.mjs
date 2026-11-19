import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, drive, makeRepo } from "./drive.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const self = join(here, "worktree-cache.mjs");

function devUserData() {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Kakapo", "dev");
  if (process.platform === "win32") return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Kakapo", "dev");
  return join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Kakapo", "dev");
}

const { workspaceDataDirectory } = await import(join(REPO, "dist/workspace-data.js"));
const { repositorySymbolCacheFile } = await import(join(REPO, "dist/workspace-data.js"));


const MODULES = 8;
function source(index, variant) {
  return [
    `export interface Shipment${index} { id: number; weight: number }`,
    `export class Depot${index} {`,
    `  dispatch(shipment: Shipment${index}): number { return shipment.weight + ${variant}; }`,
    "}",
    `export function restock${index}(depot: Depot${index}) { return depot; }`,
  ].join("\n") + "\n";
}

if (process.env.KAKAPO_WT_ROOT) {
  await drive(process.env.KAKAPO_WT_LABEL, process.env.KAKAPO_WT_ROOT, async (page, h) => {
    const asked = await page.evaluate(`(async () => {
      const answer = await window.kakapoAnalysis.query({ kind: 'endpoints' });
      return Boolean(answer && answer.ok);
    })()`);
    h.check(asked, "a question only the project index can answer was asked");
    const reuse = await h.until(`(analysisStatusLast && typeof analysisStatusLast.indexedFiles === 'number')
      ? { indexedFiles: analysisStatusLast.indexedFiles, reusedFiles: analysisStatusLast.reusedFiles } : null`, 60000);
    h.check(reuse.indexedFiles > 0, "the window says how many files its index holds", JSON.stringify(reuse));
    const title = await h.until(`(() => {
      const el = document.getElementById('analysis-status');
      return el && /\\d/.test(el.title) ? el.title : null;
    })()`, 20000);
    h.check(/\d+/.test(title) && title.split("\n").some((line) => line.includes(String(reuse.indexedFiles))),
      "the status a reader can hover names the same numbers", JSON.stringify(title));
    writeFileSync(process.env.KAKAPO_WT_REPORT, JSON.stringify(reuse));
    await h.shot(`${process.env.KAKAPO_WT_LABEL}-window`);
  });
}

const repo = makeRepo("worktree-cache");
for (let index = 0; index < MODULES; index += 1) repo.put(`src/module-${index}.ts`, source(index, 1));
repo.commit("initial");
const sibling = `${repo.dir}-sibling`;
execFileSync("git", ["worktree", "add", "--detach", "-q", sibling, "HEAD"], { cwd: repo.dir, stdio: "pipe" });

const reports = `${repo.dir}-reports`;
mkdirSync(reports, { recursive: true });
const results = [];
function phase(label, root) {
  const report = join(reports, `${label}.json`);
  const run = spawnSync(process.execPath, [self], {
    stdio: "inherit",
    env: { ...process.env, KAKAPO_WT_ROOT: root, KAKAPO_WT_LABEL: label, KAKAPO_WT_REPORT: report },
  });
  const counts = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : undefined;
  results.push({ label, root, status: run.status, counts });
}

let failures = 0;
const check = (ok, what, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

try {
  check(repositorySymbolCacheFile(devUserData(), sibling) === repositorySymbolCacheFile(devUserData(), repo.dir),
    "both checkouts resolve to one symbol cache file",
    repositorySymbolCacheFile(devUserData(), repo.dir));

  phase("main", repo.dir);
  writeFileSync(join(sibling, "src/module-3.ts"), source(3, 2));
  phase("sibling", sibling);

  const first = results[0].counts;
  const second = results[1].counts;
  check(results.every((entry) => entry.status === 0), "both launches drove a usable window",
    results.map((entry) => `${entry.label}=${entry.status}`).join(" "));
  check(Boolean(first) && first.indexedFiles >= MODULES && first.reusedFiles === 0,
    "the first checkout scanned every file it indexed", JSON.stringify(first));
  check(Boolean(second) && second.indexedFiles === first.indexedFiles && second.reusedFiles === second.indexedFiles - 1,
    "the sibling worktree re-read only the file it had edited", JSON.stringify(second));
} finally {
  try { execFileSync("git", ["worktree", "remove", "--force", sibling], { cwd: repo.dir, stdio: "pipe" }); } catch { }
  for (const root of [repo.dir, sibling]) {
    rmSync(workspaceDataDirectory(devUserData(), root), { recursive: true, force: true });
  }
  rmSync(repo.dir, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
  rmSync(reports, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
