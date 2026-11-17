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

test("a route in a comment or inside a string is not an endpoint", () => {
  const found = endpointsInFile("a.ts", [
    'app.get("/real", h);',
    '// app.get("/commented-out", h);',
    'const sample = "app.get(\'/in-a-string\', h)";',
  ].join("\n"));
  assert.deepEqual(found.map((one) => one.path), ["/real"]);

  assert.deepEqual(endpointsInFile("a.ts", [
    'const data = await api.get("/users");',
    'app.get("view engine");',
    'app.get("/served", handler);',
  ].join("\n")).map((one) => one.path), ["/served"]);
});

test("a controller's base path is part of every address under it", () => {
  const spring = endpointsInFile("T.kt", [
    "@RestController",
    '@RequestMapping("/transfers")',
    "class TransferController {",
    "  @PostMapping",
    "  fun transfer() {}",
    '  @GetMapping("/{idempotencyKey}")',
    "  fun result() {}",
    "}",
  ].join("\n"));
  assert.deepEqual(spring.map((one) => `${one.method} ${one.path}`),
    ["POST /transfers", "GET /transfers/{idempotencyKey}"]);
  assert.equal(spring.length, 2);

  const fastapi = endpointsInFile("r.py", [
    'router = APIRouter(prefix="/api/recipes", tags=["recipes"])',
    '@router.get("/{recipe_id}")',
    "def one(): ...",
  ].join("\n"));
  assert.deepEqual(fastapi.map((one) => one.path), ["/api/recipes/{recipe_id}"]);

  const wrappedRouter = endpointsInFile("w.py", [
    "live_trading_router = APIRouter(",
    '    prefix="/live-trading",',
    '    tags=["crypto-live-trading"],',
    ")",
    '@live_trading_router.get("/account/balance")',
    "def balance(): ...",
  ].join("\n"));
  assert.deepEqual(wrappedRouter.map((one) => one.path), ["/live-trading/account/balance"]);

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

test("a general mapping that names its method is not reported as ANY", () => {
  const found = endpointsInFile("C.java", [
    '  @RequestMapping(value = "/req", method = RequestMethod.POST)',
    "  void b() {}",
  ].join("\n"));
  assert.equal(found[0].method, "POST");
});

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

  assert.deepEqual(endpointsInFile("a.js", 'app.get(\n  "/users",\n  handler,\n);\n')
    .map((one) => `${one.method} ${one.path}`), ["GET /users"]);

  assert.deepEqual(endpointsInFile("a.js", '// open ( here\napp.get("/x", h);\n')
    .map((one) => one.path), ["/x"]);

  const nested = endpointsInFile("a.js", 'describe("suite", () => {\n  app.get("/real", h);\n});\n');
  assert.deepEqual(nested.map((one) => one.path), ["/real"]);
  assert.equal(nested[0].lineIndex, 1);

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

test("the address can be declared by where a file IS, not by a call inside it", () => {
  const next = endpointsInFile("app/api/users/[id]/route.ts",
    "export async function GET(req) {}\nexport async function DELETE(req) {}\n");
  assert.deepEqual(next.map((one) => `${one.method} ${one.path}`),
    ["GET /api/users/[id]", "DELETE /api/users/[id]"], "one row per exported verb, at the file's address");
  assert.equal(next[0].framework, "Next.js");

  assert.deepEqual(endpointsInFile("src/routes/health/+server.ts", "export const GET = () => new Response('ok');\n")
    .map((one) => `${one.method} ${one.path}`), ["GET /health"]);

  const pages = endpointsInFile("pages/api/legacy.ts", "export default function handler(req, res) {}\n");
  assert.deepEqual(pages.map((one) => `${one.method} ${one.path}`), ["ANY /api/legacy"]);

  const remix = endpointsInFile("app/routes/users.$id.tsx",
    "export async function loader({ params }) {}\nexport const action = async () => {};\n");
  assert.deepEqual(remix.map((one) => `${one.method} ${one.path}`), ["GET /users/:id", "POST /users/:id"]);
  assert.equal(remix[0].framework, "Remix");
  assert.deepEqual(endpointsInFile("app/routes/_index.tsx", "export function loader() {}\n")
    .map((one) => one.path), ["/"], "_index is the segment's own root, not a segment of its own");
  assert.deepEqual(endpointsInFile("app/routes/[sitemap.xml].tsx", "export function loader() {}\n")
    .map((one) => one.path), ["/sitemap.xml"]);
  const loader = "export function loader() {}\n";
  assert.deepEqual(endpointsInFile("app/routes/users/$id.tsx", loader).map((one) => one.path), ["/users/:id"]);
  assert.deepEqual(endpointsInFile("app/routes/users/index.tsx", loader).map((one) => one.path), ["/users"]);
  assert.deepEqual(endpointsInFile("app/routes/_auth.login.tsx", loader).map((one) => one.path), ["/login"]);
  assert.deepEqual(endpointsInFile("app/routes/about.tsx", "export default function About() {}\n"), []);
});

test("Go, Django, Rails, ASP.NET, Micronaut and gRPC", () => {
  const go = endpointsInFile("main.go", '\thttp.HandleFunc("/healthz", h)\n\tr.GET("/items/:id", h)\n');
  assert.deepEqual(go.map((one) => `${one.method} ${one.path}`), ["ANY /healthz", "GET /items/:id"],
    "the standard library's Handle names no verb, and a router's does");

  const go122 = endpointsInFile("api.go", '\tmux.HandleFunc("GET /api/healthz", s.healthz)\n\tmux.HandleFunc("DELETE /api/users/{id}", s.del)\n');
  assert.deepEqual(go122.map((one) => `${one.method} ${one.path}`),
    ["GET /api/healthz", "DELETE /api/users/{id}"]);

  const django = endpointsInFile("urls.py", '    path("items/<int:pk>/", v),\n    re_path(r"^legacy/$", v),\n');
  assert.deepEqual(django.map((one) => `${one.method} ${one.path}`), ["ANY /items/<int:pk>/", "ANY /legacy/"]);

  assert.deepEqual(endpointsInFile("routes.rb", '  get "items/:id", to: "items#show"\n  resources :photos\n  resource :profile\n')
    .map((one) => `${one.method} ${one.path}`), ["GET /items/:id", "ANY /photos", "ANY /profile"]);

  const aspnet = endpointsInFile("C.cs", [
    '[Route("api/items")]', "public class ItemsController {", '  [HttpGet("{id}")]', "  void A() {}",
    "  [HttpPost]", "  void B() {}", "}",
  ].join("\n"));
  assert.deepEqual(aspnet.map((one) => `${one.method} ${one.path}`), ["GET /api/items/{id}", "POST /api/items"]);

  const micronaut = endpointsInFile("M.java", '@Controller("/mn")\nclass M {\n  @Get("/items")\n  String a() { return ""; }\n}\n');
  assert.deepEqual(micronaut.map((one) => `${one.framework} ${one.method} ${one.path}`), ["Micronaut GET /mn/items"]);
  const spring = endpointsInFile("S.java", '  @GetMapping("/s")\n  void a() {}\n');
  assert.equal(spring[0].framework, "Spring", "the suffixed form is still Spring's");

  const grpc = endpointsInFile("s.proto", "service Transfers {\n  rpc Send(Req) returns (Rep);\n}\n");
  assert.deepEqual(grpc.map((one) => `${one.method} ${one.path}`), ["RPC Transfers/Send"]);
});

test("a rebuild drops the cached list", async () => {
  const { readFile } = await import("node:fs/promises");
  const update = await readFile(new URL("../src/viewer/09-views-update.js", import.meta.url), "utf8");
  assert.match(update, /\bresetEndpoints\(\)/,
    "applyReviewUpdate must drop the endpoint cache with the index it was read from");
});
