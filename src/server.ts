import { createHash, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { HttpBodyPart, HttpSendRequest, HttpSendResult } from "./types.js";
import { errorMessage } from "./util.js";
import { cookieHeaderFor, readHttpAttachmentBytes, saveCookies } from "./http-files.js";

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

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_BINARY_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export type HttpSendContext = { root?: string; userData?: string };

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
  }
  return { bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), truncated };
}

function isTextualContentType(contentType: string): boolean {
  if (!contentType) return true;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|.*\+json|xml|.*\+xml|javascript|ecmascript|x-www-form-urlencoded|graphql|yaml|x-ndjson)$/.test(mime)) return true;
  return false;
}

function multipartPartName(part: HttpBodyPart, index: number): string {
  const disposition = Object.entries(part.headers || {})
    .find(([name]) => name.toLowerCase() === "content-disposition")?.[1] ?? "";
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

const DIGEST_HASHES: Record<string, string> = {
  "MD5": "md5", "MD5-SESS": "md5",
  "SHA-256": "sha256", "SHA-256-SESS": "sha256",
  "SHA-512-256": "sha512-256", "SHA-512-256-SESS": "sha512-256",
};

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
    const requestedOrigin = url.origin;
    const headersFor = (target: URL, extra?: Record<string, string>): Record<string, string> => {
      const headers: Record<string, string> = { ...(request.headers ?? {}), ...(extra ?? {}) };
      const sameOrigin = target.origin === requestedOrigin;
      if (!sameOrigin) {
        for (const name of Object.keys(headers)) {
          if (/^(authorization|proxy-authorization|cookie)$/i.test(name)) delete headers[name];
        }
      }
      if (sameOrigin && request.auth?.type === "basic") {
        headers.Authorization = basicHeader(request.auth.user, request.auth.password);
      }
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
        redirect: "manual",
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
