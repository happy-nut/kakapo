// IntelliJ Ultimate's Endpoints tool window: every HTTP route a project declares.
//
// Sourced differently from the other IntelliJ ports and that matters for how it is tested. The rest were
// read off the shipped IDE by decompiling it; Endpoints is Ultimate-only and the machine has Community,
// so the BEHAVIOUR comes from JetBrains' documentation (a row shows the address with its type and
// framework, a deprecated endpoint is struck through) and the DETECTION from each framework's own public
// API. There is no oracle to diff against, so what is pinned here is every case that was wrong when this
// was first run against real code.
import test from "node:test";
import assert from "node:assert/strict";
import { collectEndpoints, endpointsInFile } from "../dist/endpoints.js";

const find = (list, path) => list.find((one) => one.path === path);

test("the frameworks' own shapes are recognised, with the method each one declares", () => {
  const found = collectEndpoints([
    { path: "a.ts", content: 'app.get("/users", h);\nrouter.post(\'/users/:id\', h);\napp.all("/any", h);\n' },
    { path: "b.py", content: '@app.get("/items")\ndef i(): ...\n@app.route("/legacy", methods=["POST", "PUT"])\ndef l(): ...\n@app.route("/plain")\ndef p(): ...\n' },
    { path: "d.kt", content: 'routing {\n  get("/ktor") { }\n}\n' },
  ]);
  assert.equal(find(found, "/users").method, "GET");
  assert.equal(find(found, "/users/:id").method, "POST");
  assert.equal(find(found, "/any").method, "ANY", "Express's .all has no one verb, and says so");
  assert.equal(find(found, "/items").framework, "FastAPI");
  assert.equal(find(found, "/legacy").method, "POST, PUT", "Flask lists its methods; all of them are the answer");
  assert.equal(find(found, "/plain").method, "GET", "…and with none listed, Flask's own default is GET");
  assert.equal(find(found, "/ktor").framework, "Ktor");
});

// A route is a string literal, and the mask the symbol index uses blanks string literals — so the
// declaration has to be tested as code while the path is read from the raw line. Both of these were
// listed as endpoints before the match's own position was checked against the mask.
test("a route in a comment or inside a string is not an endpoint", () => {
  const found = endpointsInFile("a.ts", [
    'app.get("/real", h);',
    '// app.get("/commented-out", h);',
    'const sample = "app.get(\'/in-a-string\', h)";',
  ].join("\n"));
  assert.deepEqual(found.map((one) => one.path), ["/real"]);

  // Six rows in one checkout here were `api.get("users")` — an axios instance calling SOMEONE ELSE'S
  // endpoint, listed as a route this project serves. A route always takes a handler after its path and a
  // client call takes a url and nothing, so the comma is what tells them apart. Express's own
  // one-argument `app.get("view engine")` reads a setting and is ruled out by the same test.
  assert.deepEqual(endpointsInFile("a.ts", [
    'const data = await api.get("/users");',
    'app.get("view engine");',
    'app.get("/served", handler);',
  ].join("\n")).map((one) => one.path), ["/served"]);
});

// Ultimate shows a FULL address. A method-level mapping is only half of one: Spring puts the rest on the
// controller and FastAPI on the router. Measured against a real controller, where this listed
// `/{idempotencyKey}` for an endpoint that is really `/transfers/{idempotencyKey}`.
test("a controller's base path is part of every address under it", () => {
  const spring = endpointsInFile("T.kt", [
    "@RestController",
    '@RequestMapping("/transfers")',
    "class TransferController {",
    "  @PostMapping",                       // no argument at all: the base path IS the address
    "  fun transfer() {}",
    '  @GetMapping("/{idempotencyKey}")',
    "  fun result() {}",
    "}",
  ].join("\n"));
  assert.deepEqual(spring.map((one) => `${one.method} ${one.path}`),
    ["POST /transfers", "GET /transfers/{idempotencyKey}"]);
  // …and the class-level mapping is NOT itself an endpoint. It was listed as `ANY /transfers`, a row for
  // something that does not exist.
  assert.equal(spring.length, 2);

  const fastapi = endpointsInFile("r.py", [
    'router = APIRouter(prefix="/api/recipes", tags=["recipes"])',
    '@router.get("/{recipe_id}")',
    "def one(): ...",
  ].join("\n"));
  assert.deepEqual(fastapi.map((one) => one.path), ["/api/recipes/{recipe_id}"]);

  // …and the base path is read across lines for the same reason the endpoints are. A router with more
  // than one argument is written this way by black, and reading a line at a time dropped the prefix from
  // every route beneath it: 184 of one real project's 448 addresses were half of what they really are.
  const wrappedRouter = endpointsInFile("w.py", [
    "live_trading_router = APIRouter(",
    '    prefix="/live-trading",',
    '    tags=["crypto-live-trading"],',
    ")",
    '@live_trading_router.get("/account/balance")',
    "def balance(): ...",
  ].join("\n"));
  assert.deepEqual(wrappedRouter.map((one) => one.path), ["/live-trading/account/balance"]);

  // Spring's class-level mapping wraps too, and the "is a class next?" question has to look past the
  // annotation's own arguments to find it.
  const wrappedSpring = endpointsInFile("W.java", [
    "@RequestMapping(",
    '    value = "/transfers",',
    "    produces = APPLICATION_JSON_VALUE",
    ")",
    "public class TransferController {",
    '  @GetMapping("/{id}")',
    "  void one() {}",
    "}",
  ].join("\n"));
  assert.deepEqual(wrappedSpring.map((one) => `${one.method} ${one.path}`), ["GET /transfers/{id}"]);
});

// `@RequestMapping` names its verb in its own arguments. Reading it as ANY threw away a method that was
// written down right there.
test("a general mapping that names its method is not reported as ANY", () => {
  const found = endpointsInFile("C.java", [
    '  @RequestMapping(value = "/req", method = RequestMethod.POST)',
    "  void b() {}",
  ].join("\n"));
  assert.equal(found[0].method, "POST");
});

// Struck through in the list, as Ultimate draws one — but only where the annotation actually attaches.
// A fixed look-back of a few lines reached over the END of the previous declaration and took its
// `@Deprecated` with it, marking an unrelated endpoint below.
test("deprecated is read from the block that attaches, not from a few lines up", () => {
  const found = endpointsInFile("C.java", [
    "  @Deprecated",
    '  @PostMapping("/old")',
    "  void c() {}",
    "  @GET",
    '  @Path("/current")',
    "  void d() {}",
  ].join("\n"));
  assert.equal(find(found, "/old").deprecated, true);
  assert.equal(find(found, "/current").deprecated, false,
    "the deprecation three lines up belongs to another method");
  assert.equal(find(found, "/current").method, "GET", "JAX-RS puts the verb on its own annotation");
});

// Measured on a real project: 34 of its 448 FastAPI routes were invisible, and every one of them was
// simply formatted by black. A one-line-at-a-time scanner sees a decorator with no path at all.
test("a declaration formatted across several lines is still one declaration", () => {
  const wrapped = endpointsInFile("r.py", [
    "@router.get(",
    '    "/positions",',
    "    response_model=PositionsOut,",
    ")",
    "def positions(): ...",
  ].join("\n"));
  assert.deepEqual(wrapped.map((one) => `${one.method} ${one.path}`), ["GET /positions"]);
  assert.equal(wrapped[0].lineIndex, 0, "the row belongs to the line the declaration starts on");

  // The same shape in JavaScript, and the continuation must not be counted a second time.
  assert.deepEqual(endpointsInFile("a.js", 'app.get(\n  "/users",\n  handler,\n);\n')
    .map((one) => `${one.method} ${one.path}`), ["GET /users"]);

  // A paren inside a comment does not open anything, so the next line is not swallowed.
  assert.deepEqual(endpointsInFile("a.js", '// open ( here\napp.get("/x", h);\n')
    .map((one) => one.path), ["/x"]);

  // A route nested inside an open block IS still a route — but it belongs to its own line, not to the
  // line that opened the block. Reported from the opener it would carry the wrong caret and, worse, be
  // asked of the opener's mask: the only honest answer is to let the inner line have its own turn.
  const nested = endpointsInFile("a.js", 'describe("suite", () => {\n  app.get("/real", h);\n});\n');
  assert.deepEqual(nested.map((one) => one.path), ["/real"]);
  assert.equal(nested[0].lineIndex, 1);

  // The two neighbours that read AROUND a declaration — "is it deprecated" and "which verb annotation is
  // beside it" — both measure from the line the declaration starts on, which is the line a wrapped one
  // now claims. Checked together because this is where a later change would pull them apart.
  const neighbours = endpointsInFile("C.java", [
    "  @Deprecated",
    "  @RequestMapping(",
    '      value = "/old",',
    "      method = RequestMethod.POST)",
    "  void x() {}",
    "  @GET",
    "  @Path(",
    '      "/current")',
    "  void y() {}",
  ].join("\n"));
  assert.deepEqual(neighbours.map((one) => `${one.method} ${one.path} ${one.deprecated}`),
    ["POST /old true", "GET /current false"]);
});

// `@app.get(f"{API_PREFIX}/health")` — a prefix held in a constant, which is an ordinary way to write a
// route and was simply not seen. There is no evaluator here, so the address reads as written.
test("a Python string says its kind before its quote", () => {
  assert.deepEqual(endpointsInFile("m.py", '@app.get(f"{API_PREFIX}/health")\ndef h(): ...\n')
    .map((one) => `${one.method} ${one.path}`), ["GET /{API_PREFIX}/health"]);
  assert.deepEqual(endpointsInFile("urls.py", '    re_path(rb"^legacy/$", v),\n')
    .map((one) => one.path), ["/legacy/"]);
});

test("a file in a language no framework here uses costs nothing and finds nothing", () => {
  assert.deepEqual(endpointsInFile("notes.md", 'app.get("/not-code", h)\n'), []);
  assert.deepEqual(endpointsInFile("a.ts", ""), []);
});

// Ultimate's list reaches well past the annotation-and-call shapes. These are the server-side families a
// reviewer actually meets, each pinned with the case that was wrong when it was first run.
test("the address can be declared by where a file IS, not by a call inside it", () => {
  // Next.js, SvelteKit and Remix put the route in the path of the file; no line pattern can see it.
  const next = endpointsInFile("app/api/users/[id]/route.ts",
    "export async function GET(req) {}\nexport async function DELETE(req) {}\n");
  assert.deepEqual(next.map((one) => `${one.method} ${one.path}`),
    ["GET /api/users/[id]", "DELETE /api/users/[id]"], "one row per exported verb, at the file's address");
  assert.equal(next[0].framework, "Next.js");

  assert.deepEqual(endpointsInFile("src/routes/health/+server.ts", "export const GET = () => new Response('ok');\n")
    .map((one) => `${one.method} ${one.path}`), ["GET /health"]);

  // A pages-router file exports one default handler and serves every verb through it.
  const pages = endpointsInFile("pages/api/legacy.ts", "export default function handler(req, res) {}\n");
  assert.deepEqual(pages.map((one) => `${one.method} ${one.path}`), ["ANY /api/legacy"]);

  // Remix separates segments with a DOT and names its two halves rather than its verbs: the loader
  // answers the GET, the action answers everything else.
  const remix = endpointsInFile("app/routes/users.$id.tsx",
    "export async function loader({ params }) {}\nexport const action = async () => {};\n");
  assert.deepEqual(remix.map((one) => `${one.method} ${one.path}`), ["GET /users/:id", "POST /users/:id"]);
  assert.equal(remix[0].framework, "Remix");
  assert.deepEqual(endpointsInFile("app/routes/_index.tsx", "export function loader() {}\n")
    .map((one) => one.path), ["/"], "_index is the segment's own root, not a segment of its own");
  // A bracketed segment is a literal, so the dot inside it is part of the name rather than a separator.
  assert.deepEqual(endpointsInFile("app/routes/[sitemap.xml].tsx", "export function loader() {}\n")
    .map((one) => one.path), ["/sitemap.xml"]);
  // Remix has had two conventions and both are still in the wild: a dot and a folder separate the same.
  const loader = "export function loader() {}\n";
  assert.deepEqual(endpointsInFile("app/routes/users/$id.tsx", loader).map((one) => one.path), ["/users/:id"]);
  assert.deepEqual(endpointsInFile("app/routes/users/index.tsx", loader).map((one) => one.path), ["/users"]);
  // A leading underscore is a pathless layout — it names a file, not a segment of the address.
  assert.deepEqual(endpointsInFile("app/routes/_auth.login.tsx", loader).map((one) => one.path), ["/login"]);
  // …and a route file that exports neither is a PAGE. Listing it would name an endpoint nobody serves.
  assert.deepEqual(endpointsInFile("app/routes/about.tsx", "export default function About() {}\n"), []);
});

test("Go, Django, Rails, ASP.NET, Micronaut and gRPC", () => {
  const go = endpointsInFile("main.go", '\thttp.HandleFunc("/healthz", h)\n\tr.GET("/items/:id", h)\n');
  assert.deepEqual(go.map((one) => `${one.method} ${one.path}`), ["ANY /healthz", "GET /items/:id"],
    "the standard library's Handle names no verb, and a router's does");

  // Go 1.22 put the method INSIDE the pattern. Read as a path it produced `ANY /GET /api/healthz` — an
  // address nobody serves, with the verb buried in it. Found on a real repository, not in a fixture.
  const go122 = endpointsInFile("api.go", '\tmux.HandleFunc("GET /api/healthz", s.healthz)\n\tmux.HandleFunc("DELETE /api/users/{id}", s.del)\n');
  assert.deepEqual(go122.map((one) => `${one.method} ${one.path}`),
    ["GET /api/healthz", "DELETE /api/users/{id}"]);

  // Django routes carry no method — it lives on the view — and `^`/`$` are the regex's, not the address's.
  const django = endpointsInFile("urls.py", '    path("items/<int:pk>/", v),\n    re_path(r"^legacy/$", v),\n');
  assert.deepEqual(django.map((one) => `${one.method} ${one.path}`), ["ANY /items/<int:pk>/", "ANY /legacy/"]);

  // A real routes.rb is `resources`, not verb lines — missing the shorthand showed almost nothing for a
  // Rails project. One row for the line that declares them, not seven addresses nobody wrote down.
  assert.deepEqual(endpointsInFile("routes.rb", '  get "items/:id", to: "items#show"\n  resources :photos\n  resource :profile\n')
    .map((one) => `${one.method} ${one.path}`), ["GET /items/:id", "ANY /photos", "ANY /profile"]);

  // ASP.NET's class attribute is the base path and does not write a leading slash — the address must.
  const aspnet = endpointsInFile("C.cs", [
    '[Route("api/items")]', "public class ItemsController {", '  [HttpGet("{id}")]', "  void A() {}",
    "  [HttpPost]", "  void B() {}", "}",
  ].join("\n"));
  assert.deepEqual(aspnet.map((one) => `${one.method} ${one.path}`), ["GET /api/items/{id}", "POST /api/items"]);

  // Micronaut spells its annotations like Spring's without the suffix, so `@GetMapping` must not read as
  // `@Get` — Spring is matched first, and this is the case that would have gone to the wrong framework.
  const micronaut = endpointsInFile("M.java", '@Controller("/mn")\nclass M {\n  @Get("/items")\n  String a() { return ""; }\n}\n');
  assert.deepEqual(micronaut.map((one) => `${one.framework} ${one.method} ${one.path}`), ["Micronaut GET /mn/items"]);
  const spring = endpointsInFile("S.java", '  @GetMapping("/s")\n  void a() {}\n');
  assert.equal(spring[0].framework, "Spring", "the suffixed form is still Spring's");

  // An RPC is addressed Service/Method. A leading slash would be a URL this service does not serve.
  const grpc = endpointsInFile("s.proto", "service Transfers {\n  rpc Send(Req) returns (Rep);\n}\n");
  assert.deepEqual(grpc.map((one) => `${one.method} ${one.path}`), ["RPC Transfers/Send"]);
});

// The list is read once per review and cached — so the one thing that can make it lie is a rebuild it
// does not hear about. A route added, moved or deleted by the build the watcher just applied would keep
// showing at its old address, and the row's Enter would land on a line that no longer declares anything.
test("a rebuild drops the cached list", async () => {
  const { readFile } = await import("node:fs/promises");
  const update = await readFile(new URL("../src/viewer/09-views-update.js", import.meta.url), "utf8");
  assert.match(update, /\bresetEndpoints\(\)/,
    "applyReviewUpdate must drop the endpoint cache with the index it was read from");
});
