// Registering the vocabulary server with the agent CLIs.
//
// The bug this pins: in a PACKAGED app, process.execPath is the Electron binary and Electron ignores a script
// path in argv — it runs the bundle's own main. So a registration of `<Kakapo binary> .../cli.js mcp` with no
// ELECTRON_RUN_AS_NODE started a second copy of the REVIEW APP, which read the agent's working directory as
// the folder to review, took the single-instance handoff, and had the running window adopt that repository as
// a workspace. Resuming an old session in an unrelated repo put it in the rail, unasked. Development never
// showed it: there argv[1] IS the entry point and cli.js really does run.
//
// Measured against the installed app before the fix: one `initialize` handshake from a scratch repo took
// kakapo-open-workspaces from 6 entries to 7. With the variable set, the same handshake answered identically
// and left it at 6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MCP_SERVER_ENV, mcpServerCommand } from "../dist/mcp-register.js";

const source = readFileSync(new URL("../src/mcp-register.ts", import.meta.url), "utf8");

test("the spawn that an agent runs is forced into node, not into the review app", () => {
  assert.equal(MCP_SERVER_ENV.ELECTRON_RUN_AS_NODE, "1");
  const { command, args, env } = mcpServerCommand();
  assert.ok(command, "a command is named");
  assert.deepEqual(args.slice(-1), ["mcp"], "and it asks for the server, whatever the entry point is");

  // The bundled-entry form is the one that goes through Electron. In this test process the sibling cli.js
  // exists (dist/), so that is the branch under test.
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1", "the bundled entry carries the variable");
  assert.match(args[0], /cli\.js$/, "…because it is being spawned through an Electron binary");
});

test("a PATH `kakapo` registration is left alone — it is a shell script that already ends up in node", () => {
  // Not reachable from the built module (the branch depends on a file that exists here), so pin the intent
  // at the source: exactly one branch returns an empty env, and it is the PATH one.
  const fn = source.match(/export function mcpServerCommand\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "one function builds the command");
  assert.match(fn, /return \{ command: "kakapo", args: \["mcp"\], env: \{\} \}/, "the PATH form gets no env");
  assert.match(fn, /command: process\.execPath, args: \[entry, "mcp"\], env \}/, "the bundled form gets it");
});

test("the env reaches the CLI as flags, before the -- that ends them", () => {
  const fn = source.match(/export function connectMcp\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "one function registers");
  assert.match(fn, /\["--env", `\$\{key\}=\$\{value\}`\]/, "each pair becomes --env KEY=VALUE");
  for (const cli of ["claude", "codex"]) {
    const line = fn.split("\n").find((l) => l.includes(`"mcp", "add"`) && (cli === "claude" ? l.includes("--scope") : !l.includes("--scope")));
    assert.ok(line, `${cli} has an add line`);
    assert.ok(line.indexOf("envFlags") < line.indexOf('"--"'), `${cli} puts the env flags before the --`);
  }
});

test("a registration that predates the fix is detected and rewritten, not reported as fine", () => {
  // It answers, it is listed, nothing about it looks broken — only the missing variable distinguishes it.
  assert.match(source, /stale: boolean/, "status carries the distinction");
  assert.match(source, /stale: connected && !\(await registrationHasEnv\(agent\)\)/, "and derives it from the CLI's own answer");

  const check = source.match(/function registrationHasEnv[\s\S]*?\n\}/)?.[0];
  assert.ok(check, "one function decides");
  assert.match(check, /"mcp", "get", "kakapo"/, "asks the CLI rather than reading its config file");
  assert.match(check, /catch \{\s*\n?\s*return true;/, "an unreadable answer is not stale — re-registering on every launch would be worse");

  const reconnect = source.match(/export async function reconnectMcp[\s\S]*?\n\}/)?.[0];
  assert.ok(reconnect, "and one rewrites it");
  // "connectMcp" is a substring of "reconnectMcp" — match the call, not the name.
  assert.ok(reconnect.indexOf('"mcp", "remove"') < reconnect.indexOf("return connectMcp(agent)"),
    "removal comes first: `mcp add` refuses an existing name on both CLIs, so without it this is a no-op");

  // Both entry points have to repair, not just the launch path: the Settings button is what someone presses
  // when the rail has already misbehaved.
  const main = readFileSync(new URL("../src/app-main.ts", import.meta.url), "utf8");
  assert.match(main, /if \(status\.stale\) await reconnectMcp\(status\.agent\)/, "launch repairs a stale entry");
  assert.match(main, /kakapo:mcp-connect[\s\S]{0,320}reconnectMcp/, "and so does the Settings button");
});
