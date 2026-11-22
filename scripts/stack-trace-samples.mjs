#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "test", "fixtures", "stack-trace-samples.json");

const RUNTIMES = [
  {
    runtime: "node",
    probe: ["node", ["--version"]],
    files: {
      "lib/inner.js": "function deep(n) { if (n === 0) throw new Error('boom'); return deep(n - 1); }\nmodule.exports = { deep };\n",
      "app.js": "const { deep } = require('./lib/inner');\nfunction start() { return [1].map(() => deep(2))[0]; }\nstart();\n",
    },
    run: ["node", ["app.js"]],
  },
  {
    runtime: "python",
    probe: ["python3", ["--version"]],
    files: {
      "pkg/__init__.py": "",
      "pkg/inner.py": "def deep(n):\n    if n == 0:\n        raise ValueError('boom')\n    return deep(n - 1)\n",
      "main.py": "from pkg.inner import deep\n\n\ndef start():\n    return deep(2)\n\n\nstart()\n",
    },
    run: ["python3", ["main.py"]],
  },
  {
    runtime: "go",
    probe: ["go", ["version"]],
    files: {
      "go.mod": "module sample\n\ngo 1.21\n",
      "inner/inner.go": "package inner\n\nfunc Deep(n int) int {\n\tif n == 0 {\n\t\tpanic(\"boom\")\n\t}\n\treturn Deep(n - 1)\n}\n",
      "main.go": "package main\n\nimport \"sample/inner\"\n\nfunc start() int { return inner.Deep(2) }\n\nfunc main() { _ = start() }\n",
    },
    run: ["go", ["run", "."]],
  },
  {
    runtime: "rust",
    probe: ["rustc", ["--version"]],
    files: {
      "main.rs": "fn deep(n: u32) -> u32 {\n    if n == 0 {\n        panic!(\"boom\");\n    }\n    deep(n - 1)\n}\n\nfn start() -> u32 {\n    deep(2)\n}\n\nfn main() {\n    start();\n}\n",
    },
    build: ["rustc", ["-g", "-o", "sample", "main.rs"]],
    run: ["./sample", []],
    env: { RUST_BACKTRACE: "full" },
  },
  {
    runtime: "ruby",
    probe: ["ruby", ["--version"]],
    files: {
      "lib/inner.rb": "def deep(n)\n  raise ArgumentError, 'boom' if n.zero?\n  deep(n - 1)\nend\n",
      "main.rb": "require_relative 'lib/inner'\n\ndef start\n  deep(2)\nend\n\nstart\n",
    },
    run: ["ruby", ["main.rb"]],
  },
];

function capture(spec, dir) {
  for (const [rel, body] of Object.entries(spec.files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  const env = { ...process.env, ...(spec.env ?? {}) };
  if (spec.build) execFileSync(spec.build[0], spec.build[1], { cwd: dir, env, stdio: "pipe" });
  try {
    execFileSync(spec.run[0], spec.run[1], { cwd: dir, env, stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    const text = String(error.stderr ?? "");
    if (text.trim()) return text;
    throw new Error(`${spec.runtime} crashed with nothing on stderr`);
  }
  throw new Error(`${spec.runtime} did not crash — the sample program stopped failing`);
}

const rows = [];
const skipped = [];
for (const spec of RUNTIMES) {
  try {
    execFileSync(spec.probe[0], spec.probe[1], { stdio: "ignore" });
  } catch {
    skipped.push(spec.runtime);
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), `kakapo-stack-${spec.runtime}-`));
  try {
    const raw = capture(spec, dir);
    let text = raw.replace(/\r\n/g, "\n");
    for (const form of new Set([realpathSync(dir), dir])) text = text.split(form).join("<DIR>");
    if (!text.includes("<DIR>") && spec.runtime !== "go") {
      throw new Error(`${spec.runtime} produced no path under the sample directory — nothing to resolve`);
    }
    rows.push({ runtime: spec.runtime, command: `${spec.run[0]} ${spec.run[1].join(" ")}`.trim(), text });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (rows.length === 0) {
  console.error("no runtime on this machine produced a trace — nothing was captured.");
  process.exit(2);
}
writeFileSync(out, JSON.stringify(rows, null, 2) + "\n");
console.log(`${out}: ${rows.map((row) => `${row.runtime} (${row.text.trim().split("\n").length} lines)`).join(", ")}`);
if (skipped.length) console.log(`not installed here, so not captured: ${skipped.join(", ")}`);
