import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffRoot } from "../dist/handoff.js";

const checks = (gitPaths) => ({
  reviewable: (path) => path !== "/gone",
  gitRepository: (path) => gitPaths.includes(path),
});

test("a folder the CLI named opens even though git has never heard of it", () => {
  const root = handoffRoot(
    { additionalData: { workspaceRoot: "/plain/tree", explicitRoot: true }, workingDirectory: "/plain/tree" },
    checks([]),
  );
  assert.equal(root, "/plain/tree");
});

test("a git repository the CLI named still opens", () => {
  const root = handoffRoot(
    { additionalData: { workspaceRoot: "/repo", explicitRoot: true }, workingDirectory: "/repo" },
    checks(["/repo"]),
  );
  assert.equal(root, "/repo");
});

test("a second app-icon launch does not review the launcher's working directory", () => {
  assert.equal(handoffRoot({ workingDirectory: "/" }, checks([])), undefined);
});

test("an unnamed working directory that IS a repository is still worth guessing at", () => {
  assert.equal(handoffRoot({ workingDirectory: "/repo" }, checks(["/repo"])), "/repo");
});

test("an older CLI with no additionalData is believed via --cwd", () => {
  assert.equal(handoffRoot({ commandLineRoot: () => "/plain/tree", workingDirectory: "/" }, checks([])), "/plain/tree");
});

test("a launch that named a folder which is gone opens nothing", () => {
  assert.equal(
    handoffRoot({ additionalData: { workspaceRoot: "/gone", explicitRoot: true } }, checks([])),
    undefined,
  );
});

test("a handoff that says the folder was NOT named explicitly falls back to the git test", () => {
  assert.equal(
    handoffRoot({ additionalData: { workspaceRoot: "/plain/tree", explicitRoot: false } }, checks([])),
    undefined,
  );
  assert.equal(
    handoffRoot({ additionalData: { workspaceRoot: "/repo", explicitRoot: false } }, checks(["/repo"])),
    "/repo",
  );
});

test("a command line the fallback cannot read does not take the handoff down with it", () => {
  const thrower = () => { throw new Error("Missing value for --cwd"); };
  assert.equal(
    handoffRoot({ additionalData: { workspaceRoot: "/repo", explicitRoot: true }, commandLineRoot: thrower }, checks([])),
    "/repo",
    "additionalData answers without the fallback ever being consulted",
  );
  assert.equal(
    handoffRoot({ commandLineRoot: thrower, workingDirectory: "/repo" }, checks(["/repo"])),
    "/repo",
    "and when there is no additionalData, a throwing fallback falls through to the working directory",
  );
  assert.equal(handoffRoot({ commandLineRoot: thrower, workingDirectory: "/" }, checks([])), undefined);
});
