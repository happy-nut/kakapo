import type { HttpSendRequest, HttpSendResult } from "./types.js";
import { errorMessage } from "./util.js";

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

async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        chunks.push(value.subarray(0, value.byteLength - (total - MAX_RESPONSE_BYTES)));
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    // A truncated transfer still has whatever arrived; the status line above is the real answer.
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function performHttpRequest(request: HttpSendRequest): Promise<HttpSendResult> {
  const startedAt = Date.now();
  const method = (request.method || "GET").toUpperCase();
  const done = (result: Omit<HttpSendResult, "durationMs">): HttpSendResult =>
    ({ ...result, durationMs: Date.now() - startedAt } as HttpSendResult);

  let url = httpUrl(request.url);
  if (!url) return done({ ok: false, error: `unsupported URL scheme: ${request.url?.split(":")[0] || "(unparseable)"}` });

  try {
    const hasBody = typeof request.body === "string" && request.body.length > 0
      && method !== "GET" && method !== "HEAD";
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await fetch(url.href, {
        method,
        headers: request.headers ?? {},
        body: hasBody ? request.body : undefined,
        redirect: "manual", // every hop is re-checked below instead of being followed blind
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) break;
      const next = httpUrl(new URL(location, url).href);
      if (!next) {
        return done({ ok: false, error: `refused a redirect to a non-http(s) URL: ${location}` });
      }
      if (hop === MAX_REDIRECTS) {
        return done({ ok: false, error: `too many redirects (${MAX_REDIRECTS})` });
      }
      url = next;
    }
    if (!response) return done({ ok: false, error: "no response" });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    return done({
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      body: await readBodyCapped(response),
    });
  } catch (error) {
    return done({ ok: false, error: errorMessage(error) });
  }
}
