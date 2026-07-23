// CORE USER FLOW: the integrated terminal opens a clean login shell.
//
// Launching kakapo through npm (`npm run dev`, or a global install behind an npm shim) injects
// npm_config_* vars into the process. Inheriting them into the pty makes nvm warn on every new shell
// ("nvm is not compatible with the npm_config_prefix environment variable") — which doesn't happen in
// iTerm. sanitizeTerminalEnv keeps the integrated terminal indistinguishable from the user's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTerminalEnv, ensureUtf8Locale } from "../dist/util.js";

test("strips every npm_*-injected var (incl. the npm_config_prefix nvm rejects)", () => {
  const out = sanitizeTerminalEnv({
    PATH: "/usr/bin",
    HOME: "/Users/x",
    SHELL: "/bin/zsh",
    npm_config_prefix: "/Users/x/.nvm/versions/node/v22.22.2",
    npm_config_cache: "/Users/x/.npm",
    npm_lifecycle_event: "dev",
    npm_package_name: "@happy-nut/kakapo",
    npm_node_execpath: "/usr/bin/node",
  });
  assert.equal("npm_config_prefix" in out, false, "the var nvm rejects is gone");
  assert.equal(
    Object.keys(out).some((k) => k.startsWith("npm_")),
    false,
    "no npm_* var leaks into the shell",
  );
});

test("preserves the user's real shell environment", () => {
  const out = sanitizeTerminalEnv({
    PATH: "/usr/bin",
    HOME: "/Users/x",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
  });
  assert.deepEqual(out, {
    PATH: "/usr/bin",
    HOME: "/Users/x",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
  });
});

test("drops undefined holes and never mutates the input", () => {
  const input = { FOO: undefined, BAR: "1" };
  const out = sanitizeTerminalEnv(input);
  assert.equal("FOO" in out, false, "undefined values are dropped");
  assert.equal(out.BAR, "1");
  assert.deepEqual(input, { FOO: undefined, BAR: "1" }, "input object is untouched");
});

// A GUI launch (Finder/Spotlight/`mo`) hands us no LANG/LC_*, so git's `less` pager renders Korean commit
// messages as escaped bytes ("<EA><B5><AD>"). ensureUtf8Locale forces a UTF-8 codeset in that case.
test("forces a UTF-8 locale when none is set (the Finder-launch case)", () => {
  const out = ensureUtf8Locale({ PATH: "/usr/bin" });
  assert.equal(out.LANG, "en_US.UTF-8", "LANG defaults to a UTF-8 locale that exists on macOS");
});

test("leaves an already-UTF-8 locale untouched", () => {
  assert.equal(ensureUtf8Locale({ LANG: "ko_KR.UTF-8" }).LANG, "ko_KR.UTF-8");
  assert.equal(ensureUtf8Locale({ LC_ALL: "en_US.UTF-8" }).LANG, undefined, "no LANG added when LC_ALL is already UTF-8");
});

test("preserves the user's region but forces the UTF-8 codeset", () => {
  assert.equal(ensureUtf8Locale({ LANG: "ko_KR" }).LANG, "ko_KR.UTF-8");
  assert.equal(ensureUtf8Locale({ LANG: "fr_FR.ISO8859-1" }).LANG, "fr_FR.UTF-8");
});

test("a non-UTF-8 LC_ALL/LC_CTYPE can't defeat the forced UTF-8 LANG", () => {
  const out = ensureUtf8Locale({ LC_ALL: "C", LANG: "ko_KR" });
  assert.equal("LC_ALL" in out, false, "a C LC_ALL (overrides everything) is dropped");
  assert.equal(out.LANG, "ko_KR.UTF-8");
  const out2 = ensureUtf8Locale({ LC_CTYPE: "C", PATH: "/usr/bin" });
  assert.equal("LC_CTYPE" in out2, false, "a C LC_CTYPE (overrides LANG for ctype) is dropped");
  assert.equal(out2.LANG, "en_US.UTF-8");
});
