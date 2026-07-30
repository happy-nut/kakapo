import { test } from "node:test";
import assert from "node:assert/strict";
import { githubOwnerFromUrl } from "../dist/util.js";

// The GitHub owner parse feeds the workspace badge avatar; pin the remote-URL shapes it must handle,
// extracted from app-main so it's testable without a git repo.
test("githubOwnerFromUrl handles the common remote URL shapes", () => {
  assert.equal(githubOwnerFromUrl("https://github.com/acme/repo.git"), "acme");
  assert.equal(githubOwnerFromUrl("https://github.com/acme/repo"), "acme");
  assert.equal(githubOwnerFromUrl("git@github.com:acme/repo.git"), "acme");
  assert.equal(githubOwnerFromUrl("ssh://git@github.com/acme/repo"), "acme");
  assert.equal(githubOwnerFromUrl("https://GitHub.com/Acme/Repo"), "Acme", "host match is case-insensitive; owner case is kept");
});

test("githubOwnerFromUrl returns undefined for non-GitHub or unparseable remotes", () => {
  assert.equal(githubOwnerFromUrl("https://gitlab.com/acme/repo.git"), undefined);
  assert.equal(githubOwnerFromUrl(""), undefined);
  assert.equal(githubOwnerFromUrl("not a url"), undefined);
});
