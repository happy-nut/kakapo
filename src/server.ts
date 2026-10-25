import { createHash, randomBytes } from "node:crypto";
import type { HttpSendRequest, HttpSendResult } from "./types.js";
import { errorMessage } from "./util.js";
import { cookieHeaderFor, readHttpAttachmentBytes, saveCookies } from "./http-files.js";

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

/**
 * Assembles the request body. Three shapes arrive, and only the first is a plain string:
 * an inline body, a `< ./file` body (bytes, read here), and multipart parts (bytes per part, read here).
 */
function requestBody(request: HttpSendRequest, root: string | undefined): Buffer | string | undefined | { error: string } {
  if (request.bodyParts?.length) {
    const boundary = request.boundary || "kakapo-boundary";
    const pieces: Buffer[] = [];
    for (const part of request.bodyParts) {
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

const md5 = (value: string): string => createHash("md5").update(value, "utf8").digest("hex");

/**
 * RFC 2617 Digest, with the qop="auth" extension every server that still offers Digest actually uses.
 * MD5 is not a choice here — it is what the scheme specifies, and the alternative is not supporting the
 * `Authorization: Digest user pass` line IntelliJ's own .http files are written with.
 */
function digestHeader(
  challenge: Record<string, string>, method: string, url: URL, user: string, password: string,
): string {
  const uri = `${url.pathname}${url.search}`;
  const realm = challenge.realm ?? "";
  const nonce = challenge.nonce ?? "";
  const algorithm = (challenge.algorithm ?? "MD5").toUpperCase();
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const qop = (challenge.qop ?? "").split(",").map((value) => value.trim()).includes("auth") ? "auth" : "";
  let ha1 = md5(`${user}:${realm}:${password}`);
  if (algorithm === "MD5-SESS") ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
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
    const timeoutMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const headersFor = (target: URL, extra?: Record<string, string>): Record<string, string> => {
      const headers: Record<string, string> = { ...(request.headers ?? {}), ...(extra ?? {}) };
      if (request.auth?.type === "basic") headers.Authorization = basicHeader(request.auth.user, request.auth.password);
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
    const send = (target: URL, extra?: Record<string, string>): Promise<Response> => fetch(target.href, {
      method,
      headers: headersFor(target, extra),
      body: hasBody ? sendable : undefined,
      redirect: "manual", // every hop is re-checked below instead of being followed blind
      signal: AbortSignal.timeout(timeoutMs),
    });

    let response = await send(url);
    // Digest is a two-step scheme by design: the server has to hand out a nonce before a request can carry
    // a valid Authorization header, so the 401 is part of the protocol rather than a failure.
    if (response.status === 401 && request.auth?.type === "digest") {
      const challenge = digestChallenge(response.headers.get("www-authenticate") ?? "");
      if (challenge?.nonce) {
        response = await send(url, {
          Authorization: digestHeader(challenge, method, url, request.auth.user, request.auth.password),
        });
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
      error: /timeout|abort/i.test(message) ? `timed out after ${request.timeoutMs || DEFAULT_TIMEOUT_MS} ms` : message,
    });
  }
}
