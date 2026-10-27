import { createHash, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { HttpBodyPart, HttpSendRequest, HttpSendResult } from "./types.js";
import { errorMessage } from "./util.js";
import { cookieHeaderFor, readHttpAttachmentBytes, saveCookies } from "./http-files.js";

/**
 * A request over a client certificate, through node:https.
 *
 * `fetch` cannot carry one — its only hook for that is undici's dispatcher, and undici is not importable
 * from core — so this is the one path that bypasses it. The answer is wrapped in a real `Response`, so
 * everything around it (redirect checks, cookies, the body cap) stays one implementation.
 *
 * A passphrase-protected key is refused by name: IntelliJ asks for it interactively, and kakapo has
 * nowhere to ask.
 */
function sendOverClientCertificate(
  url: URL,
  options: { method: string; headers: Record<string, string>; body?: Buffer | string; timeoutMs: number },
  ssl: NonNullable<HttpSendRequest["ssl"]>,
  root: string | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (ssl.hasCertificatePassphrase) {
      reject(new Error("that client certificate needs a passphrase, which kakapo cannot ask for"));
      return;
    }
    if (!root) { reject(new Error("a client certificate needs the desktop app")); return; }
    const cert = ssl.clientCertificate ? readHttpAttachmentBytes(root, ssl.clientCertificate) : undefined;
    const key = ssl.clientCertificateKey ? readHttpAttachmentBytes(root, ssl.clientCertificateKey) : undefined;
    if (ssl.clientCertificate && !cert) {
      reject(new Error(`cannot read the client certificate ${ssl.clientCertificate} — it is missing or outside the review`));
      return;
    }
    if (ssl.clientCertificateKey && !key) {
      reject(new Error(`cannot read the client key ${ssl.clientCertificateKey} — it is missing or outside the review`));
      return;
    }
    const request = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        headers: options.headers,
        cert,
        key,
        // IntelliJ's `verifyHostCertificate: false` is "this is a dev server with a self-signed
        // certificate". Off by default, as it is there.
        rejectUnauthorized: ssl.verifyHostCertificate !== false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const one of value) headers.append(name, one);
            else if (value !== undefined) headers.append(name, String(value));
          }
          // 204/304 carry no body, and Response refuses one for them.
          const status = incoming.statusCode ?? 0;
          const body = status === 204 || status === 304 || options.method === "HEAD"
            ? null
            : Buffer.concat(chunks);
          resolve(new Response(body, { status, statusText: incoming.statusMessage || "", headers }));
        });
      },
    );
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error(`timed out after ${options.timeoutMs} ms`)));
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

// Performs an HTTP request on behalf of the sandboxed renderer (the .http file runner). The renderer cannot
// reach the network itself, so the main process makes the call and hands back the whole response.
//
// This file used to also host `kakapo serve` — a local HTTP server that streamed the review to a browser,
// with its own build/watch loop and JSON endpoints. Nothing has called it since the app became the only
// front end; what is left is the one function the desktop app actually invokes.

const MAX_REDIRECTS = 5;
// A response is handed to the renderer as one string. Fifty megabytes is already far past anything an .http
// file is written to inspect, and past it the request is more likely to be pointed at a file server than an
// API, so stop reading rather than buffering whatever arrives in main.
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
// A binary response crosses the IPC boundary base64-encoded (a third larger), and nothing in the response
// panel does more with it than report its size — so only a previewable amount is carried over.
const MAX_BINARY_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000; // IntelliJ's own default for both read and connection timeouts

/** Where the cookie jar lives and which repository it belongs to; absent in tests and the browser review. */
export type HttpSendContext = { root?: string; userData?: string };

/**
 * Only plain http(s) is a request the .http runner is for; anything else is a way to ask main to read
 * something that is not a web resource.
 *
 * NOTE this is checked per HOP, not once. The URL comes from a file in the reviewed repository, and
 * `redirect: "follow"` let a URL that looked like an ordinary public API hand main a 302 to somewhere it
 * would never have been asked to go — a different scheme, or an internal address the reviewer never saw.
 * Loopback and private addresses stay reachable on purpose (a .http file run against `localhost:3000` is
 * the feature), but the reviewer should be able to read the destination in the file they are running.
 */
function httpUrl(value: string): URL | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}

async function readBodyCapped(response: Response): Promise<{ bytes: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.from(await response.arrayBuffer()), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        chunks.push(value.subarray(0, value.byteLength - (total - MAX_RESPONSE_BYTES)));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    // A truncated transfer still has whatever arrived; the status line above is the real answer.
  }
  return { bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), truncated };
}

/** Whether a response body is text the panel can show, decided the way a browser's devtools does. */
function isTextualContentType(contentType: string): boolean {
  if (!contentType) return true; // no type at all: an API that forgot the header, not a binary download
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|.*\+json|xml|.*\+xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|x-ndjson)$/.test(mime)) return true;
  return false;
}

/** The field a part is named after on the wire, for an error the reviewer can act on. */
function multipartPartName(part: HttpBodyPart, index: number): string {
  const disposition = Object.entries(part.headers || {})
    .find(([name]) => name.toLowerCase() === "content-disposition")?.[1] ?? "";
  // `name=` and not the tail of `filename=`, which comes first on a file part's disposition.
  const named = /(?:^|[;\s])name\s*=\s*"?([^";]+)"?/i.exec(String(disposition));
  return named ? `the part named ${named[1].trim()}` : `multipart part ${index + 1}`;
}

/**
 * Whether `content` contains the boundary at all. RFC 2046 defines a delimiter as CRLF followed by
 * `--boundary`, so in principle only a line start counts — but the check cannot be narrower than the most
 * eager parser that will read the body, and real parsers are much more eager than that. Measured against
 * undici, which is Node's own `fetch` and so the server side of most JS dev servers: it rejects the entire
 * body when the complete boundary string appears anywhere in a part, with or without the `--` prefix and
 * nowhere near a line start. A prefix of the boundary, or the boundary less one character, parses fine.
 *
 * So the rule is the one a real encoder keeps by construction: the boundary does not occur in the content.
 * With a boundary of the length encoders actually generate this never fires by accident; with a three
 * character boundary it fires often, and correctly, because that upload was going to fail anyway.
 */
function carriesMultipartDelimiter(content: Buffer, boundary: string): boolean {
  return content.includes(boundary);
}

/**
 * Whether a part would change the request's shape rather than fill it in. A part's header values and its
 * bytes are both written into the body verbatim, so either can carry a line break or the delimiter and
 * add parts nobody wrote. `fetch` rejects CRLF in a real header value, and a real multipart encoder
 * chooses a boundary its content does not contain; this body is assembled by hand and inherited neither.
 *
 * The content is not the request author's to vouch for — it is a file out of the reviewed repository, or a
 * value captured from a server's response — so the reviewer can read two fields and send five. Refusing by
 * name keeps the request that was read the request that is sent; re-generating the boundary would also fix
 * the collision, but then the wire would stop matching the `boundary=` the reviewer can see in the file.
 */
function multipartPartProblem(
  part: HttpBodyPart, content: Buffer, boundary: string, index: number,
): string | undefined {
  const where = multipartPartName(part, index);
  for (const [name, value] of Object.entries(part.headers || {})) {
    const broken = /[\r\n]/.test(name) ? "name" : /[\r\n]/.test(String(value)) ? "value" : "";
    if (broken) {
      const shown = name.replace(/[\r\n]+/g, " ").trim() || "(unnamed)";
      return `${where}: the header ${shown} has a line break in its ${broken}, `
        + "which would add parts to the request that are not in the file";
    }
  }
  if (carriesMultipartDelimiter(content, boundary)) {
    return `${where}: its content contains the boundary ${boundary}, so the request on the wire would `
      + "not be the one you read — give Content-Type a boundary the content does not contain";
  }
  return undefined;
}

/**
 * Assembles the request body. Three shapes arrive, and only the first is a plain string:
 * an inline body, a `< ./file` body (bytes, read here), and multipart parts (bytes per part, read here).
 */
function requestBody(request: HttpSendRequest, root: string | undefined): Buffer | string | undefined | { error: string } {
  if (request.bodyParts?.length) {
    const boundary = request.boundary || "kakapo-boundary";
    const pieces: Buffer[] = [];
    for (const [index, part] of request.bodyParts.entries()) {
      const headerLines = Object.entries(part.headers || {}).map(([name, value]) => `${name}: ${value}`);
      let content: Buffer;
      if (typeof part.file === "string" && part.file) {
        if (!root) return { error: "a multipart file part needs the desktop app" };
        const bytes = readHttpAttachmentBytes(root, part.file);
        if (!bytes) return { error: `cannot read ${part.file} — it is missing, too large, or outside the review` };
        content = bytes;
      } else {
        content = Buffer.from(part.text ?? "", "utf8");
      }
      const problem = multipartPartProblem(part, content, boundary, index);
      if (problem) return { error: problem };
      pieces.push(Buffer.from(`--${boundary}\r\n${headerLines.join("\r\n")}${headerLines.length ? "\r\n" : ""}\r\n`, "utf8"));
      pieces.push(content);
      pieces.push(Buffer.from("\r\n", "utf8"));
    }
    pieces.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
    return Buffer.concat(pieces);
  }
  if (typeof request.bodyFile === "string" && request.bodyFile) {
    if (!root) return { error: "an external request body needs the desktop app" };
    const bytes = readHttpAttachmentBytes(root, request.bodyFile);
    if (!bytes) return { error: `cannot read ${request.bodyFile} — it is missing, too large, or outside the review` };
    return bytes;
  }
  return typeof request.body === "string" && request.body.length ? request.body : undefined;
}

function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

/** Parses `Digest realm="x", nonce="y", qop="auth"` into its fields. */
function digestChallenge(header: string): Record<string, string> | undefined {
  const match = /^\s*Digest\s+(.*)$/is.exec(header || "");
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const pair of match[1].match(/[a-zA-Z0-9_-]+\s*=\s*(?:"[^"]*"|[^,]*)/g) ?? []) {
    const index = pair.indexOf("=");
    fields[pair.slice(0, index).trim().toLowerCase()] = pair.slice(index + 1).trim().replace(/^"|"$/g, "");
  }
  return fields;
}

/**
 * The algorithms a Digest challenge may name (RFC 7616 §6.1 plus RFC 2617's MD5), and the hash each one
 * means. The name was previously echoed back into the header and then ignored: a server asking for
 * SHA-256 was answered with an MD5 digest labelled `algorithm=SHA-256`, 32 hex characters where 64 were
 * promised. A credential that claims the wrong algorithm is not a weaker credential, it is a wrong one.
 */
const DIGEST_HASHES: Record<string, string> = {
  "MD5": "md5", "MD5-SESS": "md5",
  "SHA-256": "sha256", "SHA-256-SESS": "sha256",
  "SHA-512-256": "sha512-256", "SHA-512-256-SESS": "sha512-256",
};

/**
 * RFC 2617/7616 Digest, with the qop="auth" extension every server that still offers Digest actually
 * uses. Returns the reason instead of a header when the challenge asks for something this cannot compute:
 * guessing produces a request that fails as a bare 401 with nothing to read, and the two ways of guessing
 * are both worse than saying so — hashing with MD5 under another algorithm's name, or dropping to the
 * RFC 2069 form (no cnonce, no nc, replayable) because the only qop offered was auth-int.
 */
function digestHeader(
  challenge: Record<string, string>, method: string, url: URL, user: string, password: string,
): string | { error: string } {
  const uri = `${url.pathname}${url.search}`;
  const realm = challenge.realm ?? "";
  const nonce = challenge.nonce ?? "";
  // Echo the server's own spelling: RFC 7616 registers `MD5-sess`, and a server may compare it literally.
  const algorithm = challenge.algorithm ?? "MD5";
  const hashName = DIGEST_HASHES[algorithm.toUpperCase()];
  if (!hashName) {
    return { error: `the server asked for Digest algorithm=${algorithm}, which kakapo cannot compute` };
  }
  const offered = (challenge.qop ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (offered.length && !offered.includes("auth")) {
    return { error: `the server offers Digest qop=${offered.join(",")} only; kakapo implements qop=auth` };
  }
  const hash = (value: string): string => createHash(hashName).update(value, "utf8").digest("hex");
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const qop = offered.includes("auth") ? "auth" : "";
  let ha1 = hash(`${user}:${realm}:${password}`);
  if (/-SESS$/.test(algorithm.toUpperCase())) ha1 = hash(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = hash(`${method}:${uri}`);
  const response = qop
    ? hash(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${nonce}:${ha2}`);
  const fields = [
    `username="${user}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`,
    `algorithm=${algorithm}`, `response="${response}"`,
  ];
  if (challenge.opaque) fields.push(`opaque="${challenge.opaque}"`);
  if (qop) fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${fields.join(", ")}`;
}

export async function performHttpRequest(
  request: HttpSendRequest, context: HttpSendContext = {},
): Promise<HttpSendResult> {
  const startedAt = Date.now();
  const method = (request.method || "GET").toUpperCase();
  const done = (result: Omit<HttpSendResult, "durationMs">): HttpSendResult =>
    ({ ...result, durationMs: Date.now() - startedAt } as HttpSendResult);

  let url = httpUrl(request.url);
  if (!url) return done({ ok: false, error: `unsupported URL scheme: ${request.url?.split(":")[0] || "(unparseable)"}` });

  const body = requestBody(request, context.root);
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return done({ ok: false, error: body.error });

  const jarred = Boolean(context.root && context.userData);
  const redirects: string[] = [];
  try {
    const hasBody = body !== undefined && method !== "GET" && method !== "HEAD";
    // ONE deadline, from two directives that describe two phases. `fetch` has no hook between connecting
    // and reading, so `@timeout` (read) and `@connection-timeout` cannot be enforced separately here; the
    // larger of the two is used, which is never shorter than either asked for, and 60s when neither is set
    // (IntelliJ's own default for both). The error names the deadline actually applied.
    const timeoutMs = Math.max(Number(request.timeoutMs) || 0, Number(request.connectTimeoutMs) || 0)
      || DEFAULT_TIMEOUT_MS;
    // The origin the reviewer actually named, which is the only one the credentials in their file are for.
    const requestedOrigin = url.origin;
    const headersFor = (target: URL, extra?: Record<string, string>): Record<string, string> => {
      const headers: Record<string, string> = { ...(request.headers ?? {}), ...(extra ?? {}) };
      // Every hop re-sent the file's headers and its Basic credentials, whatever host the hop led to.
      // Following redirects manually is what makes each one checkable (above) — and it also took over the
      // one thing `redirect: "follow"` had been doing correctly, because fetch drops Authorization when a
      // redirect crosses origins and nothing here did. A server named in a .http file could answer `302
      // Location: https://elsewhere/` and be handed the reviewer's password in cleartext, along with
      // whatever API key the file sets. A scheme downgrade is a different origin too, deliberately.
      const sameOrigin = target.origin === requestedOrigin;
      if (!sameOrigin) {
        for (const name of Object.keys(headers)) {
          if (/^(authorization|proxy-authorization|cookie)$/i.test(name)) delete headers[name];
        }
      }
      if (sameOrigin && request.auth?.type === "basic") {
        headers.Authorization = basicHeader(request.auth.user, request.auth.password);
      }
      // The jar fills in what the file did not say. A Cookie: line written in the .http file wins outright —
      // it is the request the reviewer can read, and silently appending to it would change what they ran.
      if (jarred && !Object.keys(headers).some((name) => name.toLowerCase() === "cookie")) {
        const cookie = cookieHeaderFor(context.root as string, context.userData as string, target);
        if (cookie) headers.Cookie = cookie;
      }
      return headers;
    };
    // A Buffer is a Uint8Array at runtime, but not a BodyInit to the type checker (its buffer is typed
    // ArrayBufferLike, which may be a SharedArrayBuffer). Copying into a fresh ArrayBuffer is the honest
    // conversion; request bodies are capped at 10 MB, so the copy is not worth a cast to work around.
    const sendable = typeof body === "string" || body === undefined ? body : new Uint8Array(body).buffer;
    const send = (target: URL, extra?: Record<string, string>): Promise<Response> => {
      const headers = headersFor(target, extra);
      // A client certificate takes the node:https path; everything else is fetch. Both answer with a
      // Response, so the redirect, cookie and body handling below does not know the difference.
      if (request.ssl && (request.ssl.clientCertificate || request.ssl.verifyHostCertificate === false)) {
        return sendOverClientCertificate(
          target,
          { method, headers, body: hasBody ? (body as Buffer | string) : undefined, timeoutMs },
          request.ssl,
          context.root,
        );
      }
      return fetch(target.href, {
        method,
        headers,
        body: hasBody ? sendable : undefined,
        redirect: "manual", // every hop is re-checked below instead of being followed blind
        signal: AbortSignal.timeout(timeoutMs),
      });
    };

    let response = await send(url);
    // Digest is a two-step scheme by design: the server has to hand out a nonce before a request can carry
    // a valid Authorization header, so the 401 is part of the protocol rather than a failure.
    if (response.status === 401 && request.auth?.type === "digest") {
      const challenge = digestChallenge(response.headers.get("www-authenticate") ?? "");
      if (challenge?.nonce) {
        const authorization = digestHeader(challenge, method, url, request.auth.user, request.auth.password);
        if (typeof authorization !== "string") return done({ ok: false, error: authorization.error, redirects });
        response = await send(url, { Authorization: authorization });
      }
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const location = response.status >= 300 && response.status < 400 && !request.noRedirect
        ? response.headers.get("location")
        : null;
      if (!location) break;
      const next = httpUrl(new URL(location, url).href);
      if (!next) return done({ ok: false, error: `refused a redirect to a non-http(s) URL: ${location}`, redirects });
      if (hop === MAX_REDIRECTS) return done({ ok: false, error: `too many redirects (${MAX_REDIRECTS})`, redirects });
      url = next;
      redirects.push(next.href);
      response = await send(next);
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    const setCookie = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    const cookies = jarred && !request.noCookieJar
      ? saveCookies(context.root as string, context.userData as string, url, setCookie)
      : setCookie;

    const { bytes, truncated } = await readBodyCapped(response);
    const textual = isTextualContentType(headers["content-type"] ?? "");
    return done({
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      bytes: bytes.byteLength,
      cookies,
      redirects,
      ...(textual
        ? { body: bytes.toString("utf8") + (truncated ? "\n… response truncated at 50 MB" : "") }
        : bytes.byteLength <= MAX_BINARY_BYTES ? { bodyBase64: bytes.toString("base64") } : {}),
    });
  } catch (error) {
    const message = errorMessage(error);
    return done({
      ok: false,
      redirects,
      error: /timeout|abort/i.test(message)
        ? `timed out after ${Math.max(Number(request.timeoutMs) || 0, Number(request.connectTimeoutMs) || 0) || DEFAULT_TIMEOUT_MS} ms`
        : message,
    });
  }
}
