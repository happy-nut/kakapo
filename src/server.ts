import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { DiffReviewBuild, DiffReviewResult, HttpSendRequest, HttpSendResult } from "./types.js";
import { parsePositiveInteger } from "./util.js";
import { buildDiffReview, renderLazyDiffBody } from "./build.js";
import { readReviewDiffContext } from "./diff-context.js";

// Performs an HTTP request on behalf of the sandboxed renderer. Used by both the
// Electron IPC handler (app-main.ts) and the browser-mode proxy below.
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
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function handleHttpProxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HttpSendRequest;
    const result = await performHttpRequest(payload);
    writeHttpJson(response, result);
  } catch (error) {
    writeHttpJson(response, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: 0,
    });
  }
}

export function createDiffReview(input: {
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  output: string;
  title: string;
  ignoreWhitespace?: boolean;
}): DiffReviewResult {
  const outputPath = resolve(input.output);
  const build = buildDiffReview({
    base: input.base,
    staged: input.staged,
    includeUntracked: input.includeUntracked,
    context: input.context,
    title: input.title,
    ignoreWhitespace: input.ignoreWhitespace,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, build.html);
  return {
    path: outputPath,
    url: pathToFileURL(outputPath).href,
    files: build.files,
    hunks: build.hunks,
  };
}

export function serveDiffWatch(input: {
  base?: string;
  staged: boolean;
  includeUntracked: boolean;
  context: number;
  openInBrowser: boolean;
  port?: string;
  ignoreWhitespace?: boolean;
}): void {
  const host = "127.0.0.1";
  const port = input.port ? parsePositiveInteger(input.port, "--port") : 0;
  let lastBuild: DiffReviewBuild | undefined;
  let lastBodyCache = new Map<number, string>();
  const build = () => {
    lastBuild = buildDiffReview({
      base: input.base,
      staged: input.staged,
      includeUntracked: input.includeUntracked,
      context: input.context,
      title: "monacori live diff",
      watch: true,
      ignoreWhitespace: input.ignoreWhitespace,
      lazyLoad: true, // serve can stream per-file bodies/source over /file + /source
    });
    lastBodyCache = new Map();
    return lastBuild;
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    try {
      if (requestUrl.pathname === "/__ai_flow_state") {
        const latest = build();
        writeHttpJson(response, {
          signature: latest.signature,
          generatedAt: latest.generatedAt,
          files: latest.files,
          hunks: latest.hunks,
        });
        return;
      }

      // Compact in-place refresh payload — the poller fetches this only when the signature changed.
      if (requestUrl.pathname === "/__ai_flow_update") {
        const latest = lastBuild ?? build();
        writeHttpJson(response, latest.update ?? {});
        return;
      }

      if (requestUrl.pathname === "/__http_send" && request.method === "POST") {
        void handleHttpProxy(request, response);
        return;
      }

      if (requestUrl.pathname === "/" || requestUrl.pathname === "/review") {
        const latest = build();
        writeHttp(response, 200, "text/html; charset=utf-8", latest.html);
        return;
      }

      // Phase 2 lazy-LOAD: serve a single file's diff body on demand (the renderer fetches this
      // when a file scrolls into view / is navigated to). Reuses the cached build so we don't re-run
      // git diff per file; falls back to a fresh build if no review has been requested yet.
      if (requestUrl.pathname === "/file") {
        const b = lastBuild ?? build();
        const idx = Number(requestUrl.searchParams.get("index"));
        const bodyDiffs = b.lazyBodyDiffs ?? [];
        if (Number.isInteger(idx) && idx >= 0 && idx < bodyDiffs.length) {
          let body = lastBodyCache.get(idx);
          if (body === undefined) {
            body = renderLazyDiffBody(bodyDiffs[idx]);
            lastBodyCache.set(idx, body);
          }
          writeHttp(response, 200, "text/html; charset=utf-8", body);
        } else {
          writeHttp(response, 404, "text/plain; charset=utf-8", "Not found\n");
        }
        return;
      }

      // Standalone browser compatibility: serve the source JSON on first source open. The Electron app
      // uses a per-file IPC endpoint instead and keeps analysis/indexing in its main process.
      if (requestUrl.pathname === "/source-data") {
        const b = lastBuild ?? build();
        writeHttp(response, 200, "application/json; charset=utf-8", b.lazySourceData ?? "[]");
        return;
      }

      // Project-wide metadata/tree is fetched after first paint, only when a project navigation surface
      // needs it. This mirrors Electron's monacori:get-project-index IPC endpoint.
      if (requestUrl.pathname === "/project-index") {
        const b = lastBuild ?? build();
        const update = b.update;
        writeHttpJson(response, update ? {
          signature: update.signature,
          filesTree: update.filesTree,
          sourceFilesMeta: update.sourceFilesMeta,
        } : { signature: b.signature, filesTree: "", sourceFilesMeta: [] });
        return;
      }

      if (requestUrl.pathname === "/diff-context") {
        const b = lastBuild ?? build();
        writeHttpJson(response, readReviewDiffContext({
          root: process.cwd(),
          base: b.reviewBase ?? input.base,
          staged: input.staged,
          bodyDiffs: b.lazyBodyDiffs ?? [],
          request: {
            path: requestUrl.searchParams.get("path"),
            oldStart: requestUrl.searchParams.get("oldStart"),
            oldEnd: requestUrl.searchParams.get("oldEnd"),
            newStart: requestUrl.searchParams.get("newStart"),
            newEnd: requestUrl.searchParams.get("newEnd"),
          },
        }));
        return;
      }

      writeHttp(response, 404, "text/plain; charset=utf-8", "Not found\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeHttp(response, 500, "text/plain; charset=utf-8", `${message}\n`);
    }
  });

  server.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`monacori: diff watch server failed: ${message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const url = `http://${host}:${actualPort}/review`;
    console.log(`Live diff review: ${url}`);
    console.log("Watching working tree. Press Ctrl+C to stop.");
    if (input.openInBrowser) {
      spawnSync("open", [url], { stdio: "ignore" });
    }
  });
}

function writeHttp(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

function writeHttpJson(response: ServerResponse, body: unknown): void {
  writeHttp(response, 200, "application/json; charset=utf-8", JSON.stringify(body));
}
