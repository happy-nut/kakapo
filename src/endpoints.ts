
import { maskNonCode } from "./analysis-index.js";
import { extensionOf } from "./util.js";

export type Endpoint = {
  method: string;
  path: string;
  framework: string;
  file: string;
  lineIndex: number;
  text: string;
  deprecated: boolean;
};

const HTTP_METHODS = "get|post|put|patch|delete|head|options|trace";

const PY_STRING_PREFIX = "(?:[rRbBuUfF]{1,2})?";

const ENDPOINT_PATTERNS: Array<{
  framework: string;
  re: RegExp;
  method?: (match: RegExpMatchArray) => string;
  path: (match: RegExpMatchArray) => string;
  extensions?: string[];
  rpc?: boolean;
}> = [
  {
    framework: "Express",
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
    re: new RegExp(`\\b(?:app|router|server|fastify|api)\\s*\\.\\s*(${HTTP_METHODS}|all)\\s*\\(\\s*(['"\`])([^'"\`]*)\\2\\s*,`, "i"),
    method: (m) => (m[1].toLowerCase() === "all" ? "ANY" : m[1].toUpperCase()),
    path: (m) => m[3],
  },
  {
    framework: "FastAPI",
    extensions: [".py"],
    re: new RegExp(`^\\s*@\\s*(?:\\w+)\\s*\\.\\s*(${HTTP_METHODS})\\s*\\(\\s*${PY_STRING_PREFIX}(['"])([^'"]*)\\2`, "i"),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3],
  },
  // Flask / Blueprint: `@app.route("/x", methods=["POST"])`. The method list is optional and defaults to
  // GET, which is Flask's own default rather than a guess.
  {
    framework: "Flask",
    extensions: [".py"],
    re: new RegExp(`^\\s*@\\s*\\w+\\s*\\.\\s*route\\s*\\(\\s*${PY_STRING_PREFIX}(['"])([^'"]*)\\1([^)]*)\\)`, "i"),
    method: (m) => {
      const listed = /methods\s*=\s*[[(]([^\])]*)[\])]/i.exec(m[3] ?? "");
      if (!listed) return "GET";
      const methods = listed[1].match(/[A-Za-z]+/g);
      return methods?.length ? methods.map((one) => one.toUpperCase()).join(", ") : "GET";
    },
    path: (m) => m[2],
  },
  {
    framework: "Spring",
    extensions: [".java", ".kt"],
    re: /^\s*@\s*(Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(\s*(?:(?:value|path)\s*=\s*)?(?:\{\s*)?(?:(['"])([^'"]*)\2)?([^)]*)\))?/,
    method: (m) => {
      if (m[1] !== "Request") return m[1].toUpperCase();
      const named = /RequestMethod\s*\.\s*([A-Z]+)/g;
      const verbs = [...String(m[4] ?? "").matchAll(named)].map((one) => one[1].toUpperCase());
      return verbs.length ? [...new Set(verbs)].join(", ") : "ANY";
    },
    path: (m) => m[3] ?? "",
  },
  {
    framework: "JAX-RS",
    extensions: [".java", ".kt"],
    re: /^\s*@\s*Path\s*\(\s*(['"])([^'"]*)\1/,
    path: (m) => m[2],
  },
  {
    framework: "NestJS",
    extensions: [".ts"],
    re: new RegExp(`^\\s*@\\s*(${HTTP_METHODS})\\s*\\(\\s*(?:(['"\`])([^'"\`]*)\\2)?\\s*\\)`, "i"),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3] ?? "",
  },
  {
    framework: "Micronaut",
    extensions: [".java", ".kt", ".groovy"],
    re: new RegExp(`^\\s*@\\s*(Get|Post|Put|Patch|Delete|Head|Options)\\s*(?:\\(\\s*(?:(?:value|uri)\\s*=\\s*)?(?:(['"])([^'"]*)\\2)?[^)]*\\))?\\s*$`),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3] ?? "",
  },
  {
    framework: "ASP.NET",
    extensions: [".cs"],
    re: new RegExp(`^\\s*\\[\\s*Http(${HTTP_METHODS})\\s*(?:\\(\\s*(['"])([^'"]*)\\2\\s*\\))?`, "i"),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3] ?? "",
  },
  {
    framework: "Go",
    extensions: [".go"],
    re: new RegExp(`\\b(?:\\w+)\\.(?:(Handle|HandleFunc)|(${HTTP_METHODS})|(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))\\s*\\(\\s*(\`|['"])([^'"\`]*)\\4`),
    // Go 1.22 put the method INSIDE the pattern: `mux.HandleFunc("GET /api/healthz", h)`. Read as a path
    // it produced `ANY /GET /api/healthz` — an address nobody serves, with the verb buried in it.
    method: (m) => (goPattern(m[5]).method ?? (m[1] ? "ANY" : (m[2] ?? m[3]).toUpperCase())),
    path: (m) => goPattern(m[5]).path,
  },
  {
    framework: "Django",
    extensions: [".py"],
    re: new RegExp(`\\b(?:path|re_path|url)\\s*\\(\\s*${PY_STRING_PREFIX}(['"])([^'"]*)\\1\\s*,`),
    method: () => "ANY",
    path: (m) => m[2].replace(/^\^/, "").replace(/\$$/, ""),
  },
  {
    framework: "Rails",
    extensions: [".rb"],
    re: new RegExp(`^\\s*(${HTTP_METHODS})\\s+(['"])([^'"]*)\\2`, "i"),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3],
  },
  {
    framework: "Rails",
    extensions: [".rb"],
    re: /^\s*(resources?)\s+:([A-Za-z_][A-Za-z0-9_]*)/,
    method: () => "ANY",
    path: (m) => m[2],
  },
  {
    framework: "gRPC",
    extensions: [".proto"],
    re: /^\s*rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    method: () => "RPC",
    path: (m) => m[1],
    rpc: true,
  },
  {
    framework: "Ktor",
    extensions: [".kt"],
    re: new RegExp(`^\\s*(${HTTP_METHODS})\\s*\\(\\s*(['"])([^'"]*)\\2\\s*\\)\\s*\\{`, "i"),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3],
  },
];

function deprecatedNear(lines: string[], lineIndex: number): boolean {
  for (let line = lineIndex - 1; line >= 0; line -= 1) {
    const text = (lines[line] ?? "").trim();
    if (!text) continue;
    if (/@\s*deprecated\b/i.test(text)) return true;
    const attaches = text.startsWith("@") || text.startsWith("//") || text.startsWith("*")
      || text.startsWith("/*") || text.startsWith("#");
    if (!attaches) return false;
  }
  return false;
}

function jaxRsMethodNear(lines: string[], lineIndex: number): string {
  for (let line = Math.max(0, lineIndex - 3); line <= Math.min(lines.length - 1, lineIndex + 3); line += 1) {
    const verb = /^\s*@\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*$/.exec(lines[line] ?? "");
    if (verb) return verb[1].toUpperCase();
  }
  return "ANY";
}

function declarationIsCode(maskedLine: string, match: RegExpMatchArray): boolean {
  const start = match.index ?? 0;
  const raw = match[0];
  for (let offset = 0; offset < raw.length; offset += 1) {
    if (!/\s/.test(raw[offset])) return Boolean((maskedLine[start + offset] ?? " ").trim());
  }
  return false;
}

function basePathOf(lines: string[], mask: string[]): { prefix: string; declaredAt: Set<number> } {
  const declaredAt = new Set<number>();
  let prefix = "";
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!mask[lineIndex]?.trim()) continue;
    const wrapped = logicalLine(lines, mask, lineIndex);
    const line = wrapped.text;
    const spring = /^\s*@\s*RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?(['"])([^'"]*)\1/.exec(line);
    if (spring) {
      for (let next = wrapped.endsAt + 1; next < lines.length; next += 1) {
        const text = (lines[next] ?? "").trim();
        if (!text || text.startsWith("@") || text.startsWith("//") || text.startsWith("*")) continue;
        if (/\b(class|interface|object)\b/.test(text)) { prefix = spring[2]; declaredAt.add(lineIndex); }
        break;
      }
      continue;
    }
    const router = /\b(?:APIRouter|Blueprint)\s*\([^)]*?\bprefix\s*=\s*(['"])([^'"]*)\1/.exec(line);
    if (router) prefix = router[2];
    const nest = /^\s*@\s*Controller\s*\(\s*(['"`])([^'"`]*)\1/.exec(line);
    if (nest) { prefix = nest[2]; declaredAt.add(lineIndex); }
    const aspnet = /^\s*\[\s*Route\s*\(\s*(['"])([^'"]*)\1\s*\)\s*\]/.exec(line);
    if (aspnet) { prefix = aspnet[2]; declaredAt.add(lineIndex); }
    const service = /^\s*service\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
    if (service) prefix = service[1];
  }
  return { prefix, declaredAt };
}

function joinPaths(prefix: string, path: string): string {
  const left = prefix.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  const joined = !left && !right ? "/" : !right ? left : `${left}/${right}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function goPattern(pattern: string): { method?: string; path: string } {
  const match = /^\s*([A-Z]+)\s+(\S*)\s*$/.exec(pattern);
  if (!match) return { path: pattern };
  return { method: match[1], path: match[2] };
}

const FILE_ROUTE_VERB = new RegExp(
  `^\\s*export\\s+(?:async\\s+)?(?:function|const)\\s+(${HTTP_METHODS.toUpperCase()})\\b`, "m");

// Remix names its two halves rather than its verbs: `loader` answers the GET and `action` answers
// everything else, which is why the action's row says POST and not one verb per method — Remix does not
// write those down anywhere, and inventing four rows from one export would be four addresses nobody
// declared.
const REMIX_EXPORT = /^\s*export\s+(?:async\s+)?(?:function|const)\s+(loader|action)\b/;

function fileRouteAddress(path: string): { address: string; framework: string } | undefined {
  const unix = path.replace(/\\/g, "/");
  const sveltekit = /(?:^|\/)src\/routes\/(.*)\/?\+server\.(?:ts|js)$/.exec(unix)
    ?? /(?:^|\/)src\/routes\/\+server\.(?:ts|js)$/.exec(unix);
  if (sveltekit) return { address: "/" + (sveltekit[1] ?? "").replace(/\/$/, ""), framework: "SvelteKit" };
  const appRouter = /(?:^|\/)(?:src\/)?app\/(.*)\/route\.(?:ts|tsx|js|jsx)$/.exec(unix);
  if (appRouter) return { address: "/" + appRouter[1], framework: "Next.js" };
  const pages = /(?:^|\/)(?:src\/)?pages\/api\/(.*)\.(?:ts|tsx|js|jsx)$/.exec(unix);
  if (pages) return { address: "/api/" + pages[1].replace(/\/index$/, ""), framework: "Next.js" };
  const remix = /(?:^|\/)app\/routes\/(.*)\.(?:ts|tsx|js|jsx)$/.exec(unix);
  if (remix) return { address: remixAddress(remix[1]), framework: "Remix" };
  return undefined;
}

function remixAddress(name: string): string {
  const segments: string[] = [];
  let current = "";
  let literal = false;
  for (const ch of name) {
    if (ch === "[") { literal = true; continue; }
    if (ch === "]") { literal = false; continue; }
    if ((ch === "." || ch === "/") && !literal) { segments.push(current); current = ""; continue; }
    current += ch;
  }
  segments.push(current);
  const address = segments
    // A leading underscore is a layout or a pathless route: it names a file, not a segment of the URL.
    .filter((one) => one && one !== "index" && one !== "_index" && !one.startsWith("_"))
    .map((one) => (one.startsWith("$") ? ":" + one.slice(1) : one))
    .join("/");
  return "/" + address;
}

function fileRouteEndpoints(path: string, content: string): Endpoint[] {
  const route = fileRouteAddress(path);
  if (!route) return [];
  const lines = content.split(/\r?\n/);
  const out: Endpoint[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const remix = route.framework === "Remix" ? REMIX_EXPORT.exec(lines[lineIndex]) : null;
    const verb = remix ?? FILE_ROUTE_VERB.exec(lines[lineIndex]);
    if (!verb) continue;
    out.push({
      method: remix ? (remix[1] === "loader" ? "GET" : "POST") : verb[1].toUpperCase(),
      path: route.address || "/",
      framework: route.framework,
      file: path,
      lineIndex,
      text: lines[lineIndex].trim(),
      deprecated: deprecatedNear(lines, lineIndex),
    });
  }
  // A pages-router file exports a default handler and serves every verb through it. A Remix file with
  // neither export is a PAGE — it renders a component — and a row for it would be a route the project
  // does not serve as an endpoint at all, which is why Remix is excluded from this fallback.
  if (!out.length && route.framework !== "Remix") {
    out.push({
      method: "ANY", path: route.address || "/", framework: route.framework,
      file: path, lineIndex: 0, text: "", deprecated: false,
    });
  }
  return out;
}

function openBrackets(maskedLine: string): number {
  let depth = 0;
  for (const ch of maskedLine) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
  }
  return depth;
}

const CONTINUATION_LINES = 8;

function logicalLine(lines: string[], mask: string[], lineIndex: number): { text: string; endsAt: number } {
  if (openBrackets(mask[lineIndex] ?? "") <= 0) return { text: lines[lineIndex], endsAt: lineIndex };
  let depth = 0;
  let joined = "";
  let endsAt = lineIndex;
  for (let next = lineIndex; next < lines.length && next <= lineIndex + CONTINUATION_LINES; next += 1) {
    joined += next === lineIndex ? lines[next] : " " + (lines[next] ?? "").trim();
    depth += openBrackets(mask[next] ?? "");
    endsAt = next;
    if (depth <= 0) break;
  }
  return { text: joined, endsAt };
}

export function endpointsInFile(path: string, content: string, codeLines?: string[]): Endpoint[] {
  const fileRoutes = fileRouteEndpoints(path, content);
  if (fileRoutes.length) return fileRoutes;
  const extension = "." + extensionOf(path.toLowerCase());
  const shapes = ENDPOINT_PATTERNS.filter((shape) => !shape.extensions || shape.extensions.includes(extension));
  if (!shapes.length) return [];
  const lines = content.split(/\r?\n/);
  const mask = codeLines ?? maskNonCode(content, path);
  const base = basePathOf(lines, mask);
  const out: Endpoint[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    const maskedLine = mask[lineIndex] ?? "";
    if (!maskedLine.trim()) continue;
    if (base.declaredAt.has(lineIndex)) continue;
    const declaration = logicalLine(lines, mask, lineIndex).text;
    for (const shape of shapes) {
      const match = shape.re.exec(declaration);
      if (!match) continue;
      if ((match.index ?? 0) >= line.length) continue;
      if (!declarationIsCode(maskedLine, match)) continue;
      const method = shape.method ? shape.method(match) : jaxRsMethodNear(lines, lineIndex);
      out.push({
        method,
        path: shape.rpc
          ? [base.prefix, shape.path(match)].filter(Boolean).join("/")
          : joinPaths(base.prefix, shape.path(match)),
        framework: shape.framework,
        file: path,
        lineIndex,
        text: line.trim(),
        deprecated: deprecatedNear(lines, lineIndex),
      });
      break;
    }
  }
  return out;
}

export function collectEndpoints(files: Array<{ path: string; content: string; codeLines?: string[] }>): Endpoint[] {
  const out: Endpoint[] = [];
  for (const file of files) out.push(...endpointsInFile(file.path, file.content, file.codeLines));
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.lineIndex - b.lineIndex);
}
