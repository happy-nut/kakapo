import type { HttpSendRequest, HttpSendResult } from "./types.js";
import { errorMessage } from "./util.js";

// Performs an HTTP request on behalf of the sandboxed renderer (the .http file runner). The renderer cannot
// reach the network itself, so the main process makes the call and hands back the whole response.
//
// This file used to also host `kakapo serve` — a local HTTP server that streamed the review to a browser,
// with its own build/watch loop and JSON endpoints. Nothing has called it since the app became the only
// front end; what is left is the one function the desktop app actually invokes.
export async function performHttpRequest(request: HttpSendRequest): Promise<HttpSendResult> {
  const startedAt = Date.now();
  const method = (request.method || "GET").toUpperCase();
  try {
    const hasBody = typeof request.body === "string" && request.body.length > 0
      && method !== "GET" && method !== "HEAD";
    const response = await fetch(request.url, {
      method,
      headers: request.headers ?? {},
      body: hasBody ? request.body : undefined,
      redirect: "follow",
    });
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

