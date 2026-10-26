// What the reviewed repository is made of: its modules, and which of its directories hold test code
// rather than production code.
//
// Every list IntelliJ shows is divided by these two facts. A usage view groups by module and by
// Production/Test (`ModuleGroupingRule`, `UsageScopeGroupingRule`), the project tree tints a test source
// root green, and the Find in Files scope dropdown offers "Project Production Files" and "Project Test
// Files" as first-class scopes. None of that is possible from a path string alone — `src/test/java` is a
// test root by Maven's convention but `testdata/` is production fixtures in plenty of Go repos — so the
// division has to come from the project's own declarations first and a convention only last.
//
// Three sources, in order of how much they actually know:
//
//   1. `.idea/modules.xml` + the `*.iml` files it points at. This IS IntelliJ's answer: `isTestSource`
//      on a source folder is exactly what `TestSourcesFilter.isTestSources` reads, and the module list is
//      the module list. A repo that has been opened in IntelliJ carries it, and when it is there nothing
//      else should be guessed.
//   2. The build tool's workspace manifest — pnpm/npm workspaces, a Cargo workspace, `go.work`,
//      `settings.gradle`, a Maven aggregator pom. These name the modules but say nothing about test
//      roots, so the conventions of that tool fill the rest in.
//   3. Conventions alone: one module, and the test directories that exist.
//
// The result is small and serialisable on purpose: it crosses into the renderer as one JSON island
// (viewer-contract.ts) and the viewer classifies a path against it by prefix. No runtime dependency —
// the manifest readers below are deliberately shallow, and each says where its ceiling is.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** One module: a name to show, and the repo-relative directory it owns (`""` is the repo root). */
export type ProjectModule = {
  name: string;
  root: string;
  /** IntelliJ's module group path (`group=` in modules.xml), shown when modules are not flattened. */
  group?: string;
};

export type ProjectLayout = {
  modules: ProjectModule[];
  /** Repo-relative directories whose files are test code. Prefix-matched, no trailing slash. */
  testRoots: string[];
  /** Repo-relative directories whose files are generated — IntelliJ's `generated="true"`. */
  generatedRoots: string[];
  /** Which of the three sources above answered. Shown in the UI so a surprising grouping is explicable. */
  source: "intellij" | "workspace" | "conventions";
};

export const EMPTY_PROJECT_LAYOUT: ProjectLayout = { modules: [], testRoots: [], generatedRoots: [], source: "conventions" };

// A repo with more modules than this is either generated or not what this feature is for, and a module
// header per row stops being a division at all. The cap keeps one pathological checkout from making the
// island large enough to matter to startup.
const MAX_MODULES = 400;
// Directories never worth walking to find a module or a test root.
const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", "vendor", ".venv", "venv",
  "__pycache__", ".next", ".nuxt", ".gradle", ".idea", ".cache", "coverage", "tmp",
]);

function normalizeRelative(path: string): string {
  const relative = String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\/+/, "");
  // `.` is how a workspace manifest spells the repository root (Cargo and go.work both allow it), and the
  // root is spelled "" everywhere else here — a module whose root were "." would match no path at all.
  return relative === "." ? "" : relative;
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
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

/**
 * The directories a workspace member pattern names.
 *
 * Only a `*` or `**` that is a whole segment is expanded, because that is the shape every one of these
 * manifests actually uses — `packages/*`, `crates/*`, `modules/**`. Anything subtler is left literal.
 * ponytail: segment globs only. A real matcher belongs here the day a manifest in the wild needs one.
 */
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

// ---- 1. IntelliJ's own project files ---------------------------------------------------------------

/** `$PROJECT_DIR$/a/b.iml` and `file://$MODULE_DIR$/src` both reduce to a repo-relative path here. */
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

/**
 * The layout IntelliJ itself recorded, or null when this repo has never been opened in it.
 *
 * Read with regexes rather than an XML parser for the one reason the whole file has no dependencies: a
 * `modules.xml` is a flat list of self-closing `<module>` tags and an `.iml` a flat list of
 * `<sourceFolder>` tags, and neither has ever needed a tree.
 */
function readIntellijLayout(root: string): ProjectLayout | null {
  const modulesXml = join(root, ".idea", "modules.xml");
  const imlPaths: { name: string; file: string; group?: string }[] = [];
  const xml = readTextFile(modulesXml);
  for (const tag of xml.match(/<module\b[^>]*>/g) ?? []) {
    const filepath = attribute(tag, "filepath") || attribute(tag, "fileurl");
    if (!filepath) continue;
    const relative = resolveIdeaUrl(filepath, "");
    if (!/\.iml$/i.test(relative)) continue;
    const group = attribute(tag, "group");
    imlPaths.push({ name: basename(relative).replace(/\.iml$/i, ""), file: relative, group: group || undefined });
    if (imlPaths.length >= MAX_MODULES) break;
  }
  // A single-module IntelliJ project keeps its .iml at the repo root and may have no modules.xml at all.
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
    const iml = readTextFile(join(root, entry.file));
    if (!iml) continue;
    for (const tag of iml.match(/<sourceFolder\b[^>]*>/g) ?? []) {
      const folder = resolveIdeaUrl(attribute(tag, "url"), moduleDirectory);
      if (!folder) continue;
      // `isTestSource="true"` is the Java-style flag; `type="java-test-resource"` is how a test RESOURCE
      // root is spelled, and IntelliJ counts both as test sources.
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

// ---- 2. the build tool's workspace manifest ---------------------------------------------------------

/** `name` from a member's own manifest, so a module is called what its tool calls it. */
function manifestName(root: string, member: string): string {
  const packageJson = readTextFile(join(root, member, "package.json"));
  if (packageJson) {
    try {
      const name = JSON.parse(packageJson)?.name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      // A manifest that does not parse is not a reason to have no module; fall through to the directory.
    }
  }
  const cargo = readTextFile(join(root, member, "Cargo.toml"));
  const cargoName = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo);
  if (cargoName) return cargoName[1];
  return basename(member) || member;
}

function workspaceMembers(root: string): string[] {
  // pnpm first: when it is there it is the authority, and a pnpm repo's root package.json usually has no
  // `workspaces` field at all.
  const pnpm = readTextFile(join(root, "pnpm-workspace.yaml")) || readTextFile(join(root, "pnpm-workspace.yml"));
  if (pnpm) {
    const patterns = (pnpm.match(/^\s*-\s*['"]?([^'"\n#]+)['"]?\s*$/gm) ?? [])
      .map((line) => line.replace(/^\s*-\s*['"]?/, "").replace(/['"]?\s*$/, "").trim());
    const members = patterns.flatMap((pattern) => expandMemberPattern(root, pattern));
    if (members.length) return members;
  }
  const packageJson = readTextFile(join(root, "package.json"));
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
      // ignore: an unparseable root manifest just means this is not the source
    }
  }
  const cargo = readTextFile(join(root, "Cargo.toml"));
  const cargoWorkspace = /\[workspace\][^[]*?members\s*=\s*\[([^\]]*)\]/s.exec(cargo);
  if (cargoWorkspace) {
    const members = (cargoWorkspace[1].match(/"([^"]+)"/g) ?? [])
      .map((value) => value.replace(/"/g, ""))
      .flatMap((pattern) => expandMemberPattern(root, pattern));
    if (members.length) return members;
  }
  const goWork = readTextFile(join(root, "go.work"));
  if (goWork) {
    // Both spellings: `use ./a` per line, and the `use (` block that lists bare paths. Walked by line
    // rather than matched globally because `\s` eats newlines and a path with one on the end is not a path.
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
  const gradle = readTextFile(join(root, "settings.gradle")) || readTextFile(join(root, "settings.gradle.kts"));
  if (gradle) {
    // `include ':app', ':core:data'` and `include(":app")` — a Gradle project path's `:` is a directory
    // separator, which is why the module name and the module root differ here.
    const members = (gradle.match(/include[\s(]+[^\n]*/g) ?? [])
      .flatMap((line) => line.match(/['"]:?([^'"]+)['"]/g) ?? [])
      .map((value) => normalizeRelative(value.replace(/['"]/g, "").replace(/^:/, "").replace(/:/g, "/")))
      .filter((value) => value && isDirectory(join(root, value)));
    if (members.length) return members;
  }
  const pom = readTextFile(join(root, "pom.xml"));
  if (pom) {
    const block = /<modules>([\s\S]*?)<\/modules>/.exec(pom);
    const members = (block ? block[1].match(/<module>([^<]+)<\/module>/g) ?? [] : [])
      .map((value) => normalizeRelative(value.replace(/<\/?module>/g, "")))
      .filter((value) => value && isDirectory(join(root, value)));
    if (members.length) return members;
  }
  return [];
}

// Where each build tool puts test code. Checked against the filesystem rather than assumed, so a module
// that has no tests contributes no test root and the grouping does not invent an empty one.
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
  // `src/test` and `src/test/java` are both roots by convention; keeping the outer one alone is the same
  // answer with fewer prefixes to match against.
  return { testRoots: shortestPrefixes(testRoots), generatedRoots: shortestPrefixes(generatedRoots) };
}

function shortestPrefixes(paths: string[]): string[] {
  const sorted = unique(paths);
  return sorted.filter((path) => !sorted.some((other) => other !== path && path.startsWith(`${other}/`)));
}

/**
 * Read the layout of the repository at `root`.
 *
 * Never throws and never reports failure: a repo with no modules.xml, no workspace and no test directory
 * is a one-module project whose test files are whatever the path conventions say, and that is a complete
 * answer rather than a missing one.
 */
export function readProjectLayout(root: string): ProjectLayout {
  if (!root || !isDirectory(root)) return EMPTY_PROJECT_LAYOUT;
  const intellij = readIntellijLayout(root);
  if (intellij) {
    // IntelliJ records source roots per module, but a module whose .iml predates the repo's current test
    // directory would otherwise lose it. The conventions are additive here, never overriding.
    const convention = conventionRoots(root, intellij.modules.map((module) => module.root));
    return {
      modules: intellij.modules.slice(0, MAX_MODULES),
      testRoots: shortestPrefixes([...intellij.testRoots, ...convention.testRoots]),
      generatedRoots: shortestPrefixes([...intellij.generatedRoots, ...convention.generatedRoots]),
      source: "intellij",
    };
  }

  const members = workspaceMembers(root);
  if (members.length) {
    const memberRoots = unique(members).slice(0, MAX_MODULES);
    const modules = memberRoots.map((member) => ({ name: manifestName(root, member), root: member }));
    // The repo root is a module too when it holds source of its own — a Cargo workspace whose root crate
    // is also a member, a Gradle root project with a `src/`. Otherwise it is only a container.
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

/** The module owning `path`, by longest matching root — the renderer's `projectModuleOf` mirrors this. */
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

/** Whether `path` is under one of the declared test roots. Conventions are the renderer's fallback. */
export function isTestSourcePath(layout: ProjectLayout, path: string): boolean {
  const relative = normalizeRelative(path);
  return (layout.testRoots ?? []).some((root) => relative === root || relative.startsWith(`${normalizeRelative(root)}/`));
}
