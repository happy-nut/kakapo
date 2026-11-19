import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBundledLanguageServer, SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS } from "../dist/lsp.js";

const OUT = fileURLToPath(new URL("../test/fixtures/semantic-legends.json", import.meta.url));

const FIXTURES = {
  typescript: ["a.ts", "export class A { readonly n = 1; m(p: number) { return p + this.n; } }\n"],
  python: ["a.py", "class A:\n    def m(self, p: int) -> int:\n        return p\n"],
  go: ["a.go", "package main\n\ntype A struct{ N int }\n\nfunc (a A) M(p int) int { return p + a.N }\n"],
  rust: ["a.rs", "pub struct A { pub n: i32 }\nimpl A { pub fn m(&self, p: i32) -> i32 { p + self.n } }\n"],
  clang: ["a.c", "struct A { int n; };\nint m(struct A *a, int p) { return p + a->n; }\n"],
  java: ["A.java", "public class A { final int n = 1; int m(int p) { return p + n; } }\n"],
  kotlin: ["A.kt", "class A { val n = 1\n  fun m(p: Int) = p + n\n}\n"],
  ruby: ["a.rb", "class A\n  def m(p)\n    p\n  end\nend\n"],
  php: ["a.php", "<?php\nclass A { public int $n = 1;\n  function m(int $p): int { return $p + $this->n; } }\n"],
};

function parsedOrNothing(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function frame(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

async function legendOf(family, timeoutMs) {
  const [name, source] = FIXTURES[family];
  const root = mkdtempSync(join(tmpdir(), `kakapo-legend-${family}-`));
  writeFileSync(join(root, name), source);
  if (family === "typescript") writeFileSync(join(root, "tsconfig.json"), "{}\n");
  if (family === "rust") {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "lib.rs"), source);
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n');
  }
  if (family === "go") writeFileSync(join(root, "go.mod"), "module a\n\ngo 1.21\n");

  const server = resolveBundledLanguageServer(join(root, name), root);
  if (!server) { rmSync(root, { recursive: true, force: true }); return { error: "no bundled server" }; }

  const child = spawn(server.command, server.args, {
    cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(server.env ?? {}) },
  });
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const head = buffer.indexOf("\r\n\r\n");
      if (head < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffer.slice(0, head).toString())?.[1]);
      if (!Number.isFinite(length) || buffer.length < head + 4 + length) return;
      const body = buffer.slice(head + 4, head + 4 + length).toString();
      buffer = buffer.slice(head + 4 + length);
      const message = parsedOrNothing(body);
      if (message && message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  child.stderr.resume();

  const answer = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ error: String(error.message ?? error) }); });
    pending.set(1, (message) => {
      clearTimeout(timer);
      const legend = message.result?.capabilities?.semanticTokensProvider?.legend;
      resolve(legend
        ? { tokenTypes: legend.tokenTypes ?? [], tokenModifiers: legend.tokenModifiers ?? [] }
        : { error: "the server declared no semanticTokensProvider legend" });
    });
    child.stdin.write(frame({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        processId: process.pid, rootUri: pathToFileURL(root).href,
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: "a" }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true, symbol: {} },
          textDocument: {
            semanticTokens: {
              requests: { full: true, range: false }, formats: ["relative"],
              tokenTypes: SEMANTIC_TOKEN_TYPES,
              tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
            },
          },
        },
      },
    }));
  });

  child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
  return { server: server.name, ...answer };
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const families = wanted.length ? wanted : Object.keys(FIXTURES);
const timeoutMs = Number(process.env.KAKAPO_LEGEND_TIMEOUT ?? 90000);

const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
for (const family of families) {
  if (!FIXTURES[family]) { console.log(`${family}: no fixture`); continue; }
  const result = await legendOf(family, timeoutMs);
  if (result.error) {
    console.log(`${family}: ${result.error}`);
    if (!existing[family]) existing[family] = { server: result.server ?? null, error: result.error };
    continue;
  }
  existing[family] = result;
  console.log(`${family} (${result.server}): ${result.tokenTypes.length} types, ${result.tokenModifiers.length} modifiers`);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(existing, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);
