import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { HttpAttachment, HttpSaveRequest, HttpSaveResult } from "./types.js";
import { containedRealPath, errorMessage } from "./util.js";
import { workspaceDataDirectory } from "./workspace-data.js";

// The files side of the .http runner: external request bodies (`< ./body.json`), handler scripts
// (`> ./handler.js`), saved responses (`>> out.json`) and the cookie jar.
//
// Two rules hold everything here together, and both exist because every path in this module is written in a
// file that came with the repository under review:
//
//  1. A READ is confined to the review root, canonically (containedRealPath follows symlinks before
//     comparing). A .http file that says `< ../../../.ssh/id_rsa` is answered with "outside the review",
//     not with a key — the request would otherwise POST it somewhere.
//  2. A WRITE goes either to a path inside the review root that the .http file names, or — for
//     `{{$historyFolder}}` — to kakapo's own user-data mirror. kakapo never puts its own state in a
//     reviewed project (AGENTS.md), so the history folder is NOT `.idea/httpRequests` as in IntelliJ.

/** 10 MiB: large enough for the fixture bodies .http files carry, small enough that a stray blob can't bloat main. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const HISTORY_SENTINEL = "$historyFolder";

/** The one place `{{$historyFolder}}` resolves to. Repo-relative paths never reach it. */
function historyDirectory(root: string, userData: string): string {
  return join(workspaceDataDirectory(userData, root), "http", "history");
}

function cookieJarFile(root: string, userData: string): string {
  return join(workspaceDataDirectory(userData, root), "http", "http-client.cookies");
}

/**
 * Where a `>>` path may be written. Unlike containedRealPath this has to work for a file that does not exist
 * yet, so the PARENT is the thing resolved canonically — a symlinked directory cannot be used to land the
 * write outside the root, and the leaf name is checked for separators rather than resolved.
 */
function writableTarget(root: string, userData: string, requested: string): string | undefined {
  const cleaned = String(requested || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!cleaned) return undefined;
  if (cleaned === HISTORY_SENTINEL || cleaned.startsWith(`${HISTORY_SENTINEL}/`)) {
    const within = cleaned.slice(HISTORY_SENTINEL.length).replace(/^\//, "") || "response.txt";
    if (within.split("/").includes("..") || isAbsolute(within)) return undefined;
    const base = historyDirectory(root, userData);
    mkdirSync(join(base, dirname(within)), { recursive: true });
    return join(base, within);
  }
  if (isAbsolute(cleaned) || cleaned.split("/").includes("..")) return undefined;
  const directory = dirname(cleaned);
  const parent = directory === "." ? resolve(root) : containedRealPath(root, directory);
  if (!parent) return undefined; // the folder has to already exist inside the review — we don't mkdir into a repo
  const target = join(parent, cleaned.split("/").pop() as string);
  const within = relative(realpathSync(resolve(root)), target);
  return !within || within.startsWith("..") || isAbsolute(within) ? undefined : target;
}

/** Reads a file the .http request references, as text. */
export function readHttpAttachment(root: string, requested: string): HttpAttachment {
  const bytes = readHttpAttachmentBytes(root, requested);
  if (!bytes) return { ok: false, error: `cannot read ${requested} — it is missing, too large, or outside the review` };
  return { ok: true, text: bytes.toString("utf8"), bytes: bytes.byteLength };
}

/** The same read as bytes, for a multipart part or a raw body that must not pass through a JS string. */
export function readHttpAttachmentBytes(root: string, requested: string): Buffer | undefined {
  const target = containedRealPath(root, String(requested || "").replace(/\\/g, "/").replace(/^\.\//, ""));
  if (!target) return undefined;
  try {
    const stats = statSync(target);
    if (!stats.isFile() || stats.size > MAX_ATTACHMENT_BYTES) return undefined;
    return readFileSync(target);
  } catch { return undefined; }
}

/**
 * `>> path` writes beside the existing file (`out-1.json`); `>>! path` overwrites it. The suffix search is
 * bounded — a folder holding a thousand saved responses is a sign the file meant `>>!`.
 */
export function saveHttpResponse(root: string, userData: string, request: HttpSaveRequest): HttpSaveResult {
  const target = writableTarget(root, userData, request?.path ?? "");
  if (!target) return { ok: false, error: `cannot write ${request?.path} — it is outside the review, or its folder does not exist` };
  let file = target;
  if (!request?.force) {
    const extension = extname(target);
    const stem = target.slice(0, target.length - extension.length);
    for (let index = 1; existsSync(file) && index <= 1000; index += 1) file = `${stem}-${index}${extension}`;
    if (existsSync(file)) return { ok: false, error: "too many saved responses beside that name — use >>! to overwrite" };
  }
  try {
    writeFileSync(file, String(request?.body ?? ""));
    // Against the REAL root: on macOS a repo under /tmp resolves to /private/var/…, and comparing the
    // written path with the unresolved root makes every save look like it landed outside the review.
    const within = relative(realpathSync(resolve(root)), file);
    return { ok: true, path: within.startsWith("..") ? file : within };
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
}

type Cookie = { domain: string; path: string; name: string; value: string; expires: number };

/** IntelliJ's own jar format — `# domain path name value date` — so the file stays readable and editable. */
function parseJar(text: string): Cookie[] {
  const cookies: Cookie[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [domain, path, name, value, date] = trimmed.split(/\t/);
    if (!domain || !name) continue;
    cookies.push({ domain, path: path || "/", name, value: value ?? "", expires: Number(date) || -1 });
  }
  return cookies;
}

function serializeJar(cookies: Cookie[]): string {
  return "# domain\tpath\tname\tvalue\tdate (-1 never expires)\n"
    + cookies.map((c) => [c.domain, c.path, c.name, c.value, String(c.expires)].join("\t")).join("\n") + "\n";
}

function readJar(root: string, userData: string): Cookie[] {
  const file = cookieJarFile(root, userData);
  try { return existsSync(file) ? parseJar(readFileSync(file, "utf8")) : []; } catch { return []; }
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  return domain === target || target.endsWith(`.${domain}`);
}

function pathMatches(cookiePath: string, path: string): boolean {
  if (cookiePath === "/" || cookiePath === path) return true;
  return path.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

/** The `Cookie:` header this URL has earned from earlier responses, or "" when the jar has nothing for it. */
export function cookieHeaderFor(root: string, userData: string, url: URL): string {
  const now = Date.now();
  const matched = readJar(root, userData).filter((cookie) =>
    (cookie.expires < 0 || cookie.expires > now)
    && domainMatches(cookie.domain, url.hostname)
    && pathMatches(cookie.path, url.pathname || "/"));
  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const cookie of matched) {
    if (seen.has(cookie.name)) continue; // first match wins, as a browser would for the more specific entry
    seen.add(cookie.name);
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join("; ");
}

/** Folds this response's `Set-Cookie` values into the jar. Returns the values, for the response panel. */
export function saveCookies(root: string, userData: string, url: URL, setCookie: string[]): string[] {
  if (!setCookie.length) return [];
  const jar = readJar(root, userData);
  for (const raw of setCookie) {
    const parts = raw.split(";");
    const [name, ...valueParts] = (parts.shift() ?? "").split("=");
    if (!name?.trim()) continue;
    const cookie: Cookie = {
      domain: url.hostname, path: "/", name: name.trim(), value: valueParts.join("=").trim(), expires: -1,
    };
    let maxAge: number | undefined;
    let expires: number | undefined;
    for (const attribute of parts) {
      const [key, ...rest] = attribute.split("=");
      const attributeName = key.trim().toLowerCase();
      const value = rest.join("=").trim();
      if (attributeName === "domain" && value) cookie.domain = value.replace(/^\./, "");
      else if (attributeName === "path" && value) cookie.path = value;
      else if (attributeName === "max-age") maxAge = Number(value);
      else if (attributeName === "expires") expires = Date.parse(value);
    }
    // Max-Age wins over Expires, as in RFC 6265. A zero/negative age is a deletion.
    if (Number.isFinite(maxAge)) cookie.expires = Date.now() + (maxAge as number) * 1000;
    else if (Number.isFinite(expires)) cookie.expires = expires as number;
    const index = jar.findIndex((existing) =>
      existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path);
    if (cookie.expires >= 0 && cookie.expires <= Date.now()) {
      if (index >= 0) jar.splice(index, 1); // Set-Cookie with a past date deletes
      continue;
    }
    if (index >= 0) jar[index] = cookie; else jar.push(cookie);
  }
  const file = cookieJarFile(root, userData);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializeJar(jar));
  } catch { /* the jar is a convenience; a failed write must not fail the request */ }
  return setCookie;
}
