#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export function bundledJdk(platform = process.platform, arch = process.arch, root = repoRoot) {
  return join(root, "vendor", "language-servers", `${platform}-${arch}`, "java", "jdk");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const jdk = bundledJdk();
  if (!existsSync(join(jdk, "bin", "javac"))) {
    console.error(`No bundled JDK at ${jdk}. Run: npm run lsp:install`);
    process.exit(1);
  }
  const ran = spawnSync("gradle", process.argv.slice(2), {
    cwd: join(repoRoot, "intellij-plugin"),
    stdio: "inherit",
    env: { ...process.env, JAVA_HOME: jdk },
  });
  process.exit(ran.status ?? 1);
}
