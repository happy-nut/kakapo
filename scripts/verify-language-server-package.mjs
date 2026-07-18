#!/usr/bin/env node

import { constants, accessSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLanguageServerBundle, platformTarget } from "./install-language-servers.mjs";

export function verifyLanguageServerPackage(appRoot, platform, arch) {
  const target = platformTarget(platform, arch);
  assertLanguageServerBundle(join(appRoot, "vendor", "language-servers"), target);
  const nodeServers = {
    typescript: join(appRoot, "node_modules", "typescript-language-server", "lib", "cli.mjs"),
    python: join(appRoot, "node_modules", "pyright", "langserver.index.js"),
  };
  const missing = Object.entries(nodeServers)
    .filter(([, path]) => !existsSync(path))
    .map(([family, path]) => `${family}: ${path}`);
  if (missing.length) throw new Error(`Packaged Node language servers are missing:\n${missing.join("\n")}`);
  for (const path of Object.values(nodeServers)) accessSync(path, constants.R_OK);
  process.stdout.write(`Verified all 9 bundled language families in ${appRoot}\n`);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , appRoot, platform = process.platform, arch = process.arch] = process.argv;
  if (!appRoot) throw new Error("Usage: verify-language-server-package.mjs <app-root> [platform] [arch]");
  verifyLanguageServerPackage(resolve(appRoot), platform, arch);
}
