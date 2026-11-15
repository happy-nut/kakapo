// ===== The endpoints a project declares ==========================================================
// IntelliJ Ultimate's Endpoints tool window, as much of it as a reading tool can honestly have.
//
// SOURCED DIFFERENTLY FROM THE REST OF THE INTELLIJ PORTS, and the difference matters. Everything else
// here was read off the shipped IDE by decompiling it; Endpoints is Ultimate-only and the machine has
// Community, so there is no `com.intellij.microservices` to read. The BEHAVIOUR below comes from
// JetBrains' own documentation for the tool window (what a row shows, that deprecated endpoints are
// struck through, that the row's actions are "jump to source" and a generated HTTP request). The
// DETECTION is not theirs at all: what declares an endpoint is each framework's public API, and the
// table below is written against those.
//
// Ultimate finds endpoints through the PSI of the framework plugin for the language. This app has no
// PSI; it has the regex project index that already answers definitions and workspace symbols when no
// language server does (analysis-index.ts), and endpoints are read off the same lines. So this is a
// heuristic and says so — the same bargain the index itself makes, and the reason a row carries the file
// and line it was read from: the reader can always check.
//
// The pairing with the HTTP client is the point. Running a request is the one thing this app could
// already do and had no way to start from: `.http` files have been runnable since the HTTP Client port,
// and an endpoint row is where a request comes from.

import { maskNonCode } from "./analysis-index.js";
// util.ts already answers "what extension is this" for every other reader; a second copy here is the
// shape that drifts (app-boundaries.test.mjs refuses one in the same program).
import { extensionOf } from "./util.js";

export type Endpoint = {
  /** GET, POST, … or "ANY" where the framework declares a path without naming a method. */
  method: string;
  /** The path as written, including any `:id` / `{id}` / `<int:id>` parameters. */
  path: string;
  /** Which framework's shape matched — shown beside the address, as the tool window does. */
  framework: string;
  file: string;
  /** 0-based, for the caret. */
  lineIndex: number;
  /** The declaration's own line, for a row that wants to show it. */
  text: string;
  /** Struck through in the list, as Ultimate draws a deprecated endpoint. */
  deprecated: boolean;
};

const HTTP_METHODS = "get|post|put|patch|delete|head|options|trace";

// Python puts the string's kind before its quote. `@app.get(f"{API_PREFIX}/health")` is an ordinary way
// to write a route — a prefix held in a constant — and a pattern that expects the quote immediately
// after the paren does not see it at all. The address then reads `{API_PREFIX}/health`, interpolation
// and all: this has no evaluator, and what is written down beats nothing with the file and line beside
// it. `r`, `b` and `u` are here for the same reason, not because a route is often raw or bytes.
const PY_STRING_PREFIX = "(?:[rRbBuUfF]{1,2})?";

/**
 * One shape per framework family.
 *
 * `re` runs against the line as WRITTEN, not against the masked line the symbol index uses: a route IS a
 * string literal, and maskNonCode blanks string literals. The mask is still consulted — a line whose
 * masked form is blank is inside a comment or a string and is not a declaration — which is the same
 * two-readings-of-one-line dance declarationFromLine does for symbols.
 */
const ENDPOINT_PATTERNS: Array<{
  framework: string;
  re: RegExp;
  /** Which capture holds the method, when the pattern names one. */
  method?: (match: RegExpMatchArray) => string;
  path: (match: RegExpMatchArray) => string;
  extensions?: string[];
  /** Addressed `Service/Method` rather than as a URL path — see the gRPC shape. */
  rpc?: boolean;
}> = [
  // Express / Koa / Fastify / Hono: `app.get("/users", …)`, `router.post('/x/:id', …)`.
  // `.all(` is Express's any-method route, which the tool window shows as an endpoint like any other.
  //
  // The trailing comma is doing real work: a route ALWAYS takes a handler after its path, and an HTTP
  // CLIENT takes a url and nothing. Without it `api.get("users")` — an axios instance, the commonest way
  // there is to call someone else's endpoint — was listed as a route this project serves. Measured: six
  // such rows in one checkout here, every one of them a call out rather than a route in. It also rules
  // out Express's own one-argument `app.get("view engine")`, which reads a setting.
  {
    framework: "Express",
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"],
    re: new RegExp(`\\b(?:app|router|server|fastify|api)\\s*\\.\\s*(${HTTP_METHODS}|all)\\s*\\(\\s*(['"\`])([^'"\`]*)\\2\\s*,`, "i"),
    method: (m) => (m[1].toLowerCase() === "all" ? "ANY" : m[1].toUpperCase()),
    path: (m) => m[3],
  },
  // FastAPI: `@app.get("/users")`, `@router.post("/x", response_model=…)`.
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
  // Spring: `@GetMapping("/x")`, and `@RequestMapping(value = "/x", method = RequestMethod.POST)`.
  {
    framework: "Spring",
    extensions: [".java", ".kt"],
    // The path is OPTIONAL: `@PostMapping` with no arguments is the controller's own base path, and it is
    // the commonest shape of all in a REST controller. Requiring a string missed every one of them.
    re: /^\s*@\s*(Get|Post|Put|Patch|Delete|Request)Mapping\s*(?:\(\s*(?:(?:value|path)\s*=\s*)?(?:\{\s*)?(?:(['"])([^'"]*)\2)?([^)]*)\))?/,
    // `@RequestMapping` is the general one and names its verb in its own arguments
    // (`method = RequestMethod.POST`). Reading it as ANY threw away a method that was written down right
    // there; ANY is only for a mapping that genuinely does not say.
    method: (m) => {
      if (m[1] !== "Request") return m[1].toUpperCase();
      const named = /RequestMethod\s*\.\s*([A-Z]+)/g;
      const verbs = [...String(m[4] ?? "").matchAll(named)].map((one) => one[1].toUpperCase());
      return verbs.length ? [...new Set(verbs)].join(", ") : "ANY";
    },
    path: (m) => m[3] ?? "",
  },
  // JAX-RS: `@Path("/x")` with the verb on its own annotation, usually the line above or below. The verb
  // is resolved by the caller, which can see the neighbouring lines; the shape alone only gives the path.
  {
    framework: "JAX-RS",
    extensions: [".java", ".kt"],
    re: /^\s*@\s*Path\s*\(\s*(['"])([^'"]*)\1/,
    path: (m) => m[2],
  },
  // NestJS: `@Get()`, `@Post('x')` — an empty argument list means the controller's own base path.
  {
    framework: "NestJS",
    extensions: [".ts"],
    re: new RegExp(`^\\s*@\\s*(${HTTP_METHODS})\\s*\\(\\s*(?:(['"\`])([^'"\`]*)\\2)?\\s*\\)`, "i"),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3] ?? "",
  },
  // Micronaut: `@Get("/x")`, `@Post` — the same annotation names as Spring without the "Mapping" suffix,
  // which is why it is matched after Spring rather than before: `@GetMapping` must not read as `@Get`.
  {
    framework: "Micronaut",
    extensions: [".java", ".kt", ".groovy"],
    re: new RegExp(`^\\s*@\\s*(Get|Post|Put|Patch|Delete|Head|Options)\\s*(?:\\(\\s*(?:(?:value|uri)\\s*=\\s*)?(?:(['"])([^'"]*)\\2)?[^)]*\\))?\\s*$`),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3] ?? "",
  },
  // ASP.NET: `[HttpGet("x")]`, `[Route("api/x")]`.
  {
    framework: "ASP.NET",
    extensions: [".cs"],
    re: new RegExp(`^\\s*\\[\\s*Http(${HTTP_METHODS})\\s*(?:\\(\\s*(['"])([^'"]*)\\2\\s*\\))?`, "i"),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3] ?? "",
  },
  // Go's standard library and the routers that wrap it: `http.HandleFunc("/x", …)`,
  // `mux.Handle("/x", …)`, and `r.GET("/x", …)` for gin / chi / echo, whose verbs are capitalised.
  {
    framework: "Go",
    extensions: [".go"],
    re: new RegExp(`\\b(?:\\w+)\\.(?:(Handle|HandleFunc)|(${HTTP_METHODS})|(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))\\s*\\(\\s*(\`|['"])([^'"\`]*)\\4`),
    // Go 1.22 put the method INSIDE the pattern: `mux.HandleFunc("GET /api/healthz", h)`. Read as a path
    // it produced `ANY /GET /api/healthz` — an address nobody serves, with the verb buried in it.
    method: (m) => (goPattern(m[5]).method ?? (m[1] ? "ANY" : (m[2] ?? m[3]).toUpperCase())),
    path: (m) => goPattern(m[5]).path,
  },
  // Django: `path("items/<int:pk>/", view)` and `re_path(r"^items/$", view)` in a urlpatterns list. The
  // method lives on the view, not on the route, so Django routes genuinely do not name one.
  {
    framework: "Django",
    extensions: [".py"],
    re: new RegExp(`\\b(?:path|re_path|url)\\s*\\(\\s*${PY_STRING_PREFIX}(['"])([^'"]*)\\1\\s*,`),
    method: () => "ANY",
    // `^` and `$` are the regex's, not the address's. A row reading `/^legacy/$` names a path nobody
    // can call; the rest of the pattern is left exactly as written, because it IS the address.
    path: (m) => m[2].replace(/^\^/, "").replace(/\$$/, ""),
  },
  // Rails: `get "items/:id", to: "items#show"`.
  {
    framework: "Rails",
    extensions: [".rb"],
    re: new RegExp(`^\\s*(${HTTP_METHODS})\\s+(['"])([^'"]*)\\2`, "i"),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3],
  },
  // …and `resources :items`, which is how a real routes.rb is actually written: the verb lines are the
  // exception. It stands for seven routes, and what is listed is the ONE line that declares them — the
  // seven are Rails' to generate, and a row for each would be six addresses nobody wrote down. Without
  // this a Rails project showed almost nothing, which is the same half-answer this was built to stop.
  {
    framework: "Rails",
    extensions: [".rb"],
    re: /^\s*(resources?)\s+:([A-Za-z_][A-Za-z0-9_]*)/,
    method: () => "ANY",
    path: (m) => m[2],
  },
  // gRPC: `rpc Method(Request) returns (Response);` inside a service. Not HTTP, and the tool window lists
  // it all the same — the address is the fully qualified method, which here is the service and the name.
  {
    framework: "gRPC",
    extensions: [".proto"],
    re: /^\s*rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    method: () => "RPC",
    path: (m) => m[1],
    // An RPC is addressed `Service/Method`, not `/Service/Method`: it is not a URL path and a leading
    // slash would be a URL this service does not serve.
    rpc: true,
  },
  // Ktor: `get("/x") {` inside a routing block. The brace is required so that a bare `get(…)` call on
  // some other object is not read as a route — and it is also the reason a path-less `post { }` nested
  // under `route("/x") { }` is NOT listed: finding its address means tracking brace nesting, which this
  // scanner deliberately does not do, and guessing one would be worse than leaving it out.
  {
    framework: "Ktor",
    extensions: [".kt"],
    re: new RegExp(`^\\s*(${HTTP_METHODS})\\s*\\(\\s*(['"])([^'"]*)\\2\\s*\\)\\s*\\{`, "i"),
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[3],
  },
];

/**
 * `@Deprecated`, `@deprecated` in a doc comment, or Python's `@deprecated` — as Ultimate strikes through.
 *
 * Walked backwards only across the lines an annotation block can actually span: other annotations,
 * comments and blanks. A fixed look-back of a few lines reaches over the END of the previous declaration
 * and takes its `@Deprecated` with it — measured, on a `@Path` three lines below an unrelated deprecated
 * method, which the list then struck through for no reason.
 */
function deprecatedNear(lines: string[], lineIndex: number): boolean {
  for (let line = lineIndex - 1; line >= 0; line -= 1) {
    const text = (lines[line] ?? "").trim();
    if (!text) continue;
    if (/@\s*deprecated\b/i.test(text)) return true;
    const attaches = text.startsWith("@") || text.startsWith("//") || text.startsWith("*")
      || text.startsWith("/*") || text.startsWith("#");
    if (!attaches) return false; // real code: the block above this declaration has ended
  }
  return false;
}

/** JAX-RS puts the verb on its own annotation beside the `@Path`. Look both ways for it. */
function jaxRsMethodNear(lines: string[], lineIndex: number): string {
  for (let line = Math.max(0, lineIndex - 3); line <= Math.min(lines.length - 1, lineIndex + 3); line += 1) {
    const verb = /^\s*@\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*$/.exec(lines[line] ?? "");
    if (verb) return verb[1].toUpperCase();
  }
  return "ANY";
}

/**
 * Is the matched declaration real code, or text inside a string?
 *
 * Tested at the first non-space character of the match — the `app` of `app.get(`, the `@` of
 * `@GetMapping` — because the mask blanks string contents and the route's own path is a string.
 */
function declarationIsCode(maskedLine: string, match: RegExpMatchArray): boolean {
  const start = match.index ?? 0;
  const raw = match[0];
  for (let offset = 0; offset < raw.length; offset += 1) {
    if (!/\s/.test(raw[offset])) return Boolean((maskedLine[start + offset] ?? " ").trim());
  }
  return false;
}

/**
 * The base path every endpoint in this file hangs off, by line.
 *
 * Ultimate shows a full address, and a method-level mapping is only half of one: Spring puts the rest on
 * the controller (`@RequestMapping("/transfers")` above the class) and FastAPI on the router
 * (`APIRouter(prefix="/items")`). Without this the list showed `/{idempotencyKey}` for an endpoint that
 * is really `/transfers/{idempotencyKey}`, and listed the controller's own base path as if it were an
 * endpoint of its own — a row that does not exist.
 *
 * Returned as a single prefix for the file rather than per class. One controller per file is the
 * convention in every framework here, and a file with two would need the brace nesting this scanner
 * deliberately does not do — so a second class's base is simply not claimed.
 */
function basePathOf(lines: string[], mask: string[]): { prefix: string; declaredAt: Set<number> } {
  const declaredAt = new Set<number>();
  let prefix = "";
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!mask[lineIndex]?.trim()) continue;
    // The same wrapped-declaration reading the endpoints themselves get. `APIRouter(` on its own line
    // with `prefix=` under it is how black writes a router with more than one argument — seven of them
    // in one real project — and reading a line at a time dropped the prefix from every route beneath it,
    // which is the half-address this base path exists to prevent.
    const wrapped = logicalLine(lines, mask, lineIndex);
    const line = wrapped.text;
    // Spring: a class-level @RequestMapping. "Class-level" = the next real line declares a type, which is
    // what separates it from a method-level mapping with the same spelling.
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
    // FastAPI / Flask: the router or blueprint carries the prefix.
    const router = /\b(?:APIRouter|Blueprint)\s*\([^)]*?\bprefix\s*=\s*(['"])([^'"]*)\1/.exec(line);
    if (router) prefix = router[2];
    // NestJS and Micronaut: @Controller('users').
    const nest = /^\s*@\s*Controller\s*\(\s*(['"`])([^'"`]*)\1/.exec(line);
    if (nest) { prefix = nest[2]; declaredAt.add(lineIndex); }
    // ASP.NET: a class-level [Route("api/x")].
    const aspnet = /^\s*\[\s*Route\s*\(\s*(['"])([^'"]*)\1\s*\)\s*\]/.exec(line);
    if (aspnet) { prefix = aspnet[2]; declaredAt.add(lineIndex); }
    // gRPC: the enclosing service qualifies every rpc in it.
    const service = /^\s*service\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
    if (service) prefix = service[1];
  }
  return { prefix, declaredAt };
}

/**
 * `/a` + `b` → `/a/b`, and an empty half never produces `//` or a bare "".
 *
 * The result always starts with a slash. Not every framework writes one — ASP.NET's
 * `[Route("api/items")]` has none — and an address that reads `api/items/{id}` is not the thing a client
 * calls, nor what any other row in the list looks like.
 */
function joinPaths(prefix: string, path: string): string {
  const left = prefix.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  const joined = !left && !right ? "/" : !right ? left : `${left}/${right}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * Go 1.22's `ServeMux` patterns, where the method and an optional host precede the path:
 * `"GET /api/healthz"`, `"POST example.com/x"`. Everything before the first `/` that is not itself a path.
 */
function goPattern(pattern: string): { method?: string; path: string } {
  const match = /^\s*([A-Z]+)\s+(\S*)\s*$/.exec(pattern);
  if (!match) return { path: pattern };
  return { method: match[1], path: match[2] };
}

// ---- Routes that are declared by WHERE A FILE IS ------------------------------------------------
// Next.js, SvelteKit and Remix put the address in the path of the file rather than in a call inside it,
// so no line pattern can see them: `app/api/users/[id]/route.ts` IS `/api/users/[id]`. The verbs come
// from the handlers the file exports, which is the one thing still read from its text.

const FILE_ROUTE_VERB = new RegExp(
  `^\\s*export\\s+(?:async\\s+)?(?:function|const)\\s+(${HTTP_METHODS.toUpperCase()})\\b`, "m");

// Remix names its two halves rather than its verbs: `loader` answers the GET and `action` answers
// everything else, which is why the action's row says POST and not one verb per method — Remix does not
// write those down anywhere, and inventing four rows from one export would be four addresses nobody
// declared.
const REMIX_EXPORT = /^\s*export\s+(?:async\s+)?(?:function|const)\s+(loader|action)\b/;

/** `app/api/users/[id]/route.ts` → `/api/users/[id]`; `src/routes/x/+server.ts` → `/x`. */
function fileRouteAddress(path: string): { address: string; framework: string } | undefined {
  const unix = path.replace(/\\/g, "/");
  // SvelteKit: a +server file under src/routes.
  const sveltekit = /(?:^|\/)src\/routes\/(.*)\/?\+server\.(?:ts|js)$/.exec(unix)
    ?? /(?:^|\/)src\/routes\/\+server\.(?:ts|js)$/.exec(unix);
  if (sveltekit) return { address: "/" + (sveltekit[1] ?? "").replace(/\/$/, ""), framework: "SvelteKit" };
  // Next.js app router: a route file under app/ (optionally src/app/).
  const appRouter = /(?:^|\/)(?:src\/)?app\/(.*)\/route\.(?:ts|tsx|js|jsx)$/.exec(unix);
  if (appRouter) return { address: "/" + appRouter[1], framework: "Next.js" };
  // Next.js pages router: everything under pages/api is an endpoint, and the file name is the last
  // segment unless it is `index`.
  const pages = /(?:^|\/)(?:src\/)?pages\/api\/(.*)\.(?:ts|tsx|js|jsx)$/.exec(unix);
  if (pages) return { address: "/api/" + pages[1].replace(/\/index$/, ""), framework: "Next.js" };
  // Remix: `app/routes/users.$id.tsx` IS `/users/:id`. Its flat routes separate segments with a DOT, a
  // leading `$` is the parameter, `_index` is the segment's own root, and a segment in brackets is a
  // literal (`[sitemap.xml]`) rather than a separator — which is the one that bites, since a dot inside
  // it is part of the name.
  const remix = /(?:^|\/)app\/routes\/(.*)\.(?:ts|tsx|js|jsx)$/.exec(unix);
  if (remix) return { address: remixAddress(remix[1]), framework: "Remix" };
  return undefined;
}


/**
 * `users.$id` → `/users/:id`; `_index` → `/`; `[sitemap.xml]` keeps its dot.
 *
 * Remix has had two conventions and both are still in the wild: flat routes separate segments with a
 * DOT (`users.$id.tsx`) and the older nested routes with a FOLDER (`users/$id.tsx`), so both separate
 * here. `index` and `_index` are the segment's own root rather than a segment of its own, and a segment
 * in brackets is a literal — the dot inside `[sitemap.xml]` is part of the name, not a separator, which
 * is the one that bites.
 */
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
  // One row per exported verb, which is how the file declares several endpoints at one address.
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

/**
 * Every endpoint one file declares.
 *
 * `codeLines` is the masked form of the same file (comments and strings blanked, offsets preserved). A
 * line that is blank there is not code, whatever it looks like — which is what keeps a route in a
 * comment, or the example in a doc string, out of the list.
 */
/**
 * How far a line leaves its brackets open, counted on the MASKED line so a paren inside a string or a
 * comment does not count. Braces are deliberately not counted: Ktor's `get("/x") {` opens one and is a
 * complete declaration already.
 */
function openBrackets(maskedLine: string): number {
  let depth = 0;
  for (const ch of maskedLine) {
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
  }
  return depth;
}

/** How many continuation lines a wrapped declaration may span before it stops being one declaration. */
const CONTINUATION_LINES = 8;

/**
 * A declaration wrapped over several lines, read as one.
 *
 * black formats a long decorator by putting every argument on its own line:
 *
 *     @live_trading_router.get(
 *         "/positions",
 *         response_model=PositionsOut,
 *     )
 *
 * and a scanner that looks at one line at a time sees a decorator with no path at all. Measured on a
 * real project: 34 of its 448 FastAPI routes were written this way — not an exotic shape but the house
 * style of every repository that runs black (or prettier, or ktlint) with long argument lists. The
 * continuation is taken only while the brackets stay open, and the row is still attributed to the line
 * the declaration STARTS on, which is where the caret belongs.
 */
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
  // util.ts answers without the dot ("ts"); the tables below read better with it, so the dot is put
  // back here rather than in thirteen places. A file with no extension gives ".", which matches none.
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
    // Not code at all — a comment, or inside a string.
    const maskedLine = mask[lineIndex] ?? "";
    if (!maskedLine.trim()) continue;
    // The line that DECLARES the base path is not itself an endpoint.
    if (base.declaredAt.has(lineIndex)) continue;
    // The declaration as one line, even when it was formatted across several.
    const declaration = logicalLine(lines, mask, lineIndex).text;
    for (const shape of shapes) {
      const match = shape.re.exec(declaration);
      if (!match) continue;
      // A joined declaration is only this line's if it STARTS here. Everything after the first line was
      // trimmed and re-joined, so an offset past it no longer means anything in this line's mask — and
      // the continuation line gets its own turn in the loop anyway.
      if ((match.index ?? 0) >= line.length) continue;
      // ...and the MATCH itself has to be code, not just the line. The mask preserves offsets, so the
      // question is answerable where the declaration starts: `const s = "app.get(\'/x\', h)"` is a line of
      // real code whose `app.get(` lives inside a string, and asking only whether the LINE was code
      // listed that string as an endpoint. The route's own path is a string literal and therefore blank
      // in the mask, which is why the position tested is the call's, not the path's.
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
      break; // one declaration per line; the first shape that matches owns it
    }
  }
  return out;
}

/**
 * Every endpoint in the project, in reading order: by file, then by line.
 *
 * Sorted by path rather than by address because the reader's question is usually "what does this file
 * serve", and because an address is not unique — the same `/users` is a GET and a POST in two places.
 */
export function collectEndpoints(files: Array<{ path: string; content: string; codeLines?: string[] }>): Endpoint[] {
  const out: Endpoint[] = [];
  for (const file of files) out.push(...endpointsInFile(file.path, file.content, file.codeLines));
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.lineIndex - b.lineIndex);
}
