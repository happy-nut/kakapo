import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

test("the stacked sidebar is as tall as its tree, up to a third of the window", {
  skip: process.platform !== "darwin" ? "macOS layout regression" : false,
  timeout: 30_000,
}, async () => {
  const electron = require("electron");
  const fixture = fileURLToPath(new URL("./fixtures/electron-narrow-sidebar.cjs", import.meta.url));
  const css = fileURLToPath(new URL("../dist/viewer.css", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [fixture, css], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const marker = result.stdout.split(/\r?\n/).find((line) => line.startsWith("KAKAPO_NARROW_SIDEBAR="));
  assert.ok(marker, `narrow sidebar result missing\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const layout = JSON.parse(marker.slice("KAKAPO_NARROW_SIDEBAR=".length));

  assert.ok(layout.stacked, "precondition: under 900px the panes are stacked into one column");
  const ceiling = layout.viewport * 0.35;

  assert.ok(layout.short.sidebar < ceiling - 40,
    `one row of tree took ${Math.round(layout.short.sidebar)}px of a ${layout.viewport}px window (ceiling ${Math.round(ceiling)}px)`);
  assert.ok(layout.short.content <= layout.short.sidebar + 1,
    `the diff starts at ${Math.round(layout.short.content)}px, under a ${Math.round(layout.short.sidebar)}px sidebar`);

  assert.ok(layout.long.sidebar <= ceiling + 1,
    `42 files grew the sidebar to ${Math.round(layout.long.sidebar)}px, past the ${Math.round(ceiling)}px ceiling`);
  assert.ok(layout.long.scrollHeight > layout.long.clientHeight,
    "the tree scrolls inside the band instead of being clipped away");
});
