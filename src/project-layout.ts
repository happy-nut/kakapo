import { readdirSync, statSync } from "node:fs";
import { readTextFile } from "./util.js";
import { basename, dirname, join } from "node:path";

export type ProjectModule = {
  name: string;
  root: string;
  group?: string;
};

export type ProjectLayout = {
  modules: ProjectModule[];
  testRoots: string[];
  generatedRoots: string[];
  source: "intellij" | "workspace" | "conventions";
};

export const EMPTY_PROJECT_LAYOUT: ProjectLayout = { modules: [], testRoots: [], generatedRoots: [], source: "conventions" };

const MAX_MODULES = 400;
const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", "vendor", ".venv", "venv",
  "__pycache__", ".next", ".nuxt", ".gradle", ".idea", ".cache", "coverage", "tmp",
]);

function insideRepository(relative: string): boolean {
  return Boolean(relative) && !relative.split("/").includes("..");
}

function normalizeRelative(path: string): string {
  const relative = String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\/+/, "");
  return relative === "." ? "" : relative;
}

function readManifest(path: string): string {
  try {
    return readTextFile(path);
  } catch {
    return "";
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function expandMemberPattern(root: string, pattern: string): string[] {
  const relative = normalizeRelative(pattern);
  if (!relative || relative.startsWith("!")) return [];
  const segments = relative.split("/");
  let found = [""];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of found) {
      if (segment === "*" || segment === "**") {
        const directory = join(root, base);
        let entries: string[] = [];
        try {
          entries = readdirSync(directory);
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          if (entry.startsWith(".") || SKIP_DIRECTORIES.has(entry)) continue;
          const candidate = base ? `${base}/${entry}` : entry;
          if (isDirectory(join(root, candidate))) next.push(candidate);
        }
      } else {
        const candidate = base ? `${base}/${segment}` : segment;
        if (isDirectory(join(root, candidate))) next.push(candidate);
      }
      if (next.length > MAX_MODULES) break;
    }
    found = next;
    if (!found.length) break;
  }
  return found.filter(Boolean);
}

function resolveIdeaUrl(url: string, moduleDirectory: string): string {
  let value = String(url || "").replace(/^file:\/\//, "").replace(/^jar:\/\//, "");
  value = value.replace(/!.*$/, "");
  if (value.includes("$PROJECT_DIR$")) return normalizeRelative(value.replace(/.*\$PROJECT_DIR\$\/?/, ""));
  if (value.includes("$MODULE_DIR$")) {
    const inside = normalizeRelative(value.replace(/.*\$MODULE_DIR\$\/?/, ""));
    return normalizeRelative(moduleDirectory ? (inside ? `${moduleDirectory}/${inside}` : moduleDirectory) : inside);
  }
  return normalizeRelative(value);
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match ? match[1] : "";
}

function readIntellijLayout(root: string): ProjectLayout | null {
  const modulesXml = join(root, ".idea", "modules.xml");
  const imlPaths: { name: string; file: string; group?: string }[] = [];
  const xml = readManifest(modulesXml);
  for (const tag of xml.match(/<module\b[^>]*>/g) ?? []) {
    const filepath = attribute(tag, "filepath") || attribute(tag, "fileurl");
    if (!filepath) continue;
    const relative = resolveIdeaUrl(filepath, "");
    if (!/\.iml$/i.test(relative) || !insideRepository(relative)) continue;
    const group = attribute(tag, "group");
    imlPaths.push({ name: basename(relative).replace(/\.iml$/i, ""), file: relative, group: group || undefined });
    if (imlPaths.length >= MAX_MODULES) break;
  }
  if (!imlPaths.length) {
    let rootIml = "";
    try {
      rootIml = readdirSync(root).filter((entry) => /\.iml$/i.test(entry)).sort()[0] ?? "";
    } catch {
      rootIml = "";
    }
    if (!rootIml) return null;
    imlPaths.push({ name: rootIml.replace(/\.iml$/i, ""), file: rootIml });
  }

  const modules: ProjectModule[] = [];
  const testRoots: string[] = [];
  const generatedRoots: string[] = [];
  for (const entry of imlPaths) {
    const moduleDirectory = normalizeRelative(dirname(entry.file) === "." ? "" : dirname(entry.file));
    modules.push({ name: entry.name, root: moduleDirectory, group: entry.group });
    const iml = readManifest(join(root, entry.file));
    if (!iml) continue;
    for (const tag of iml.match(/<sourceFolder\b[^>]*>/g) ?? []) {
      const folder = resolveIdeaUrl(attribute(tag, "url"), moduleDirectory);
      if (!insideRepository(folder)) continue;
      if (attribute(tag, "isTestSource") === "true" || /test/i.test(attribute(tag, "type"))) testRoots.push(folder);
      if (attribute(tag, "generated") === "true") generatedRoots.push(folder);
    }
  }
  if (!modules.length) return null;
  return { modules, testRoots: unique(testRoots), generatedRoots: unique(generatedRoots), source: "intellij" };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function manifestName(root: string, member: string): string {
  const packageJson = readManifest(join(root, member, "package.json"));
  if (packageJson) {
    try {
      const name = JSON.parse(packageJson)?.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
    }
  }
  const cargo = readManifest(join(root, member, "Cargo.toml"));
  const cargoName = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo);
  if (cargoName) return cargoName[1];
  return basename(member) || member;
}

function tomlSection(toml: string, name: string): string {
  const lines = toml.split(/\r?\n/);
  const header = (line: string) => line.replace(/#.*$/, "").trim();
  const start = lines.findIndex((line) => header(line) === `[${name}]`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*\[/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function yamlListUnder(yaml: string, key: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*:`).test(line));
  if (start < 0) return [];
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (!item) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      break;
    }
    const value = item[1].replace(/\s+#.*$/, "").trim().replace(/^['"]/, "").replace(/['"]$/, "").trim();
    if (value) values.push(value);
  }
  return values;
}

function workspaceMembers(root: string): string[] {
  const pnpm = readManifest(join(root, "pnpm-workspace.yaml")) || readManifest(join(root, "pnpm-workspace.yml"));
  if (pnpm) {
    const members = yamlListUnder(pnpm, "packages").flatMap((pattern) => expandMemberPattern(root, pattern));
    if (members.length) return members;
  }
  const packageJson = readManifest(join(root, "package.json"));
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson);
      const raw = Array.isArray(parsed?.workspaces) ? parsed.workspaces : parsed?.workspaces?.packages;
      if (Array.isArray(raw)) {
        const members = raw.filter((value: unknown): value is string => typeof value === "string")
          .flatMap((pattern: string) => expandMemberPattern(root, pattern));
        if (members.length) return members;
      }
    } catch {
    }
  }
  const cargo = readManifest(join(root, "Cargo.toml"));
  const cargoWorkspace = /^\s*members\s*=\s*\[([^\]]*)\]/m.exec(tomlSection(cargo, "workspace"));
  if (cargoWorkspace) {
    const members = (cargoWorkspace[1].match(/"([^"]+)"/g) ?? [])
      .map((value) => value.replace(/"/g, ""))
      .flatMap((pattern) => expandMemberPattern(root, pattern));
    if (members.length) return members;
  }
  const goWork = readManifest(join(root, "go.work"));
  if (goWork) {
    const members: string[] = [];
    let inBlock = false;
    for (const raw of goWork.split(/\r?\n/)) {
      const line = raw.trim();
      if (/^use\s*\($/.test(line)) { inBlock = true; continue; }
      if (inBlock && line.startsWith(")")) { inBlock = false; continue; }
      const candidate = inBlock ? line : (/^use\s+/.test(line) ? line.replace(/^use\s+/, "") : "");
      const relative = normalizeRelative(candidate.replace(/^\.\//, ""));
      if (relative && isDirectory(join(root, relative))) members.push(relative);
    }
    if (members.length) return members;
  }
  const gradle = readManifest(join(root, "settings.gradle")) || readManifest(join(root, "settings.gradle.kts"));
  if (gradle) {
    const members = (gradle.match(/include[\s(]+[^\n]*/g) ?? [])
      .flatMap((line) => line.match(/['"]:?([^'"]+)['"]/g) ?? [])
      .map((value) => normalizeRelative(value.replace(/['"]/g, "").replace(/^:/, "").replace(/:/g, "/")))
      .filter((value) => value && isDirectory(join(root, value)));
    if (members.length) return members;
  }
  const pom = readManifest(join(root, "pom.xml"));
  if (pom) {
    const block = /<modules>([\s\S]*?)<\/modules>/.exec(pom);
    const members = (block ? block[1].match(/<module>([^<]+)<\/module>/g) ?? [] : [])
      .map((value) => normalizeRelative(value.replace(/<\/?module>/g, "")))
      .filter((value) => value && isDirectory(join(root, value)));
    if (members.length) return members;
  }
  return [];
}

const TEST_DIRECTORY_CONVENTIONS = [
  "src/test", "src/test/java", "src/test/kotlin", "src/test/scala", "src/test/groovy", "src/test/resources",
  "src/androidTest", "src/testFixtures", "src/integrationTest", "src/it",
  "test", "tests", "__tests__", "spec", "specs", "testing", "e2e",
];
const GENERATED_DIRECTORY_CONVENTIONS = ["gen", "generated", "build/generated", "target/generated-sources", ".generated"];

function conventionRoots(root: string, moduleRoots: string[]): { testRoots: string[]; generatedRoots: string[] } {
  const testRoots: string[] = [];
  const generatedRoots: string[] = [];
  for (const moduleRoot of moduleRoots) {
    for (const candidate of TEST_DIRECTORY_CONVENTIONS) {
      const relative = normalizeRelative(moduleRoot ? `${moduleRoot}/${candidate}` : candidate);
      if (isDirectory(join(root, relative))) testRoots.push(relative);
    }
    for (const candidate of GENERATED_DIRECTORY_CONVENTIONS) {
      const relative = normalizeRelative(moduleRoot ? `${moduleRoot}/${candidate}` : candidate);
      if (isDirectory(join(root, relative))) generatedRoots.push(relative);
    }
  }
  return { testRoots: shortestPrefixes(testRoots), generatedRoots: shortestPrefixes(generatedRoots) };
}

function shortestPrefixes(paths: string[]): string[] {
  const sorted = unique(paths);
  return sorted.filter((path) => !sorted.some((other) => other !== path && path.startsWith(`${other}/`)));
}

export function readProjectLayout(root: string): ProjectLayout {
  if (!root || !isDirectory(root)) return EMPTY_PROJECT_LAYOUT;
  const intellij = readIntellijLayout(root);
  if (intellij) {
    const convention = conventionRoots(root, intellij.modules.map((module) => module.root));
    return {
      modules: intellij.modules.slice(0, MAX_MODULES),
      testRoots: shortestPrefixes([...intellij.testRoots, ...convention.testRoots]),
      generatedRoots: shortestPrefixes([...intellij.generatedRoots, ...convention.generatedRoots]),
      source: "intellij",
    };
  }

  const members = workspaceMembers(root).filter(insideRepository);
  if (members.length) {
    const memberRoots = unique(members).slice(0, MAX_MODULES);
    const modules = memberRoots.map((member) => ({ name: manifestName(root, member), root: member }));
    if (isDirectory(join(root, "src")) && !memberRoots.includes("")) {
      modules.unshift({ name: manifestName(root, ""), root: "" });
    }
    const convention = conventionRoots(root, modules.map((module) => module.root));
    return { modules, testRoots: convention.testRoots, generatedRoots: convention.generatedRoots, source: "workspace" };
  }

  const convention = conventionRoots(root, [""]);
  return {
    modules: [{ name: basename(root) || "project", root: "" }],
    testRoots: convention.testRoots,
    generatedRoots: convention.generatedRoots,
    source: "conventions",
  };
}

export function moduleForPath(layout: ProjectLayout, path: string): ProjectModule | null {
  const relative = normalizeRelative(path);
  let best: ProjectModule | null = null;
  for (const module of layout.modules ?? []) {
    const root = normalizeRelative(module.root);
    if (root && !(relative === root || relative.startsWith(`${root}/`))) continue;
    if (!best || root.length > normalizeRelative(best.root).length) best = module;
  }
  return best;
}

export function isTestSourcePath(layout: ProjectLayout, path: string): boolean {
  const relative = normalizeRelative(path);
  return (layout.testRoots ?? []).some((root) => relative === root || relative.startsWith(`${normalizeRelative(root)}/`));
}
