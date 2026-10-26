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

type Cookie = {
  domain: string;
  path: string;
  name: string;
  value: string;
  expires: number;
  /** `Secure`: this cookie may only be sent over a secure transport. */
  secure?: boolean;
  /** No `Domain=` was given, so it belongs to that one host and not to anything under it. */
  hostOnly?: boolean;
};

/**
 * IntelliJ's own jar format — `# domain path name value date` — so the file stays readable and editable,
 * with the two flags RFC 6265 needs appended after it.
 *
 * Appended rather than woven in: `parseJar` reads by position, so a jar written by a version that did not
 * have them still parses, and one written now still parses for a version that does not look for them.
 * A jar entry from before this existed has neither flag, which is what it meant at the time.
 */
function parseJar(text: string): Cookie[] {
  const cookies: Cookie[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [domain, path, name, value, date, secure, hostOnly] = trimmed.split(/\t/);
    if (!domain || !name) continue;
    cookies.push({
      domain, path: path || "/", name, value: value ?? "", expires: Number(date) || -1,
      secure: secure === "secure", hostOnly: hostOnly === "host",
    });
  }
  return cookies;
}

function serializeJar(cookies: Cookie[]): string {
  return "# domain\tpath\tname\tvalue\tdate (-1 never expires)\tsecure\thost-only\n"
    + cookies.map((c) => [
      c.domain, c.path, c.name, c.value, String(c.expires),
      c.secure ? "secure" : "-", c.hostOnly ? "host" : "-",
    ].join("\t")).join("\n") + "\n";
}

function readJar(root: string, userData: string): Cookie[] {
  const file = cookieJarFile(root, userData);
  try { return existsSync(file) ? parseJar(readFileSync(file, "utf8")) : []; } catch { return []; }
}

function domainMatches(cookie: Cookie, host: string): boolean {
  const domain = cookie.domain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  // A cookie with no `Domain=` belongs to the host that set it and to nothing under it (RFC 6265 §5.1.3,
  // "host-only"). Treating every cookie as a domain cookie sent a session set by example.org to
  // sub.example.org, which is a host the server never said to trust.
  if (cookie.hostOnly) return domain === target;
  return domain === target || target.endsWith(`.${domain}`);
}

/**
 * Whether a response from `host` is allowed to set a cookie for `domain` (RFC 6265 §5.3.5–6).
 *
 * The `Domain=` attribute was taken at its word, so a response from any server a .http file happened to
 * name could put a cookie in the jar for a host it has nothing to do with — `Set-Cookie: s=1;
 * Domain=github.com` from attacker.test was then sent to api.github.com by the next request. The
 * attribute may only widen a cookie to a PARENT of the host that set it.
 *
 * The single-label rule is the public-suffix problem in the form this file can answer without shipping
 * the Public Suffix List: `Domain=com` passes the suffix test for every host that ends in `.com`, and one
 * response could claim every one of them. ponytail: a multi-label suffix (`co.uk`, `github.io`) is still
 * claimable by a server already under it, which is what the PSL exists for; this is the cheap 90%.
 */
function maySetDomain(domain: string, host: string): boolean {
  const wanted = domain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  if (!wanted || !wanted.includes(".")) return false;
  return wanted === target || target.endsWith(`.${wanted}`);
}

/**
 * `Secure` means "not over plain http". Loopback counts as secure, as it does in every browser: a .http
 * file run against your own dev server over http is the feature, not an attack on it.
 */
function secureEnough(url: URL): boolean {
  if (url.protocol === "https:") return true;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
}

function pathMatches(cookiePath: string, path: string): boolean {
  if (cookiePath === "/" || cookiePath === path) return true;
  return path.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

/** The `Cookie:` header this URL has earned from earlier responses, or "" when the jar has nothing for it. */
export function cookieHeaderFor(root: string, userData: string, url: URL): string {
  const now = Date.now();
  const secure = secureEnough(url);
  const matched = readJar(root, userData).filter((cookie) =>
    (cookie.expires < 0 || cookie.expires > now)
    && (!cookie.secure || secure)
    && domainMatches(cookie, url.hostname)
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
      hostOnly: true,
    };
    let maxAge: number | undefined;
    let expires: number | undefined;
    let rejected = false;
    for (const attribute of parts) {
      const [key, ...rest] = attribute.split("=");
      const attributeName = key.trim().toLowerCase();
      const value = rest.join("=").trim();
      if (attributeName === "domain" && value) {
        // Not "whatever the response asked for": a `Domain=` that is not a parent of the host that sent it
        // is a cookie for somebody else's site, and the whole Set-Cookie is dropped (RFC 6265 §5.3.6).
        if (!maySetDomain(value, url.hostname)) { rejected = true; break; }
        cookie.domain = value.replace(/^\./, "");
        cookie.hostOnly = false;
      } else if (attributeName === "path" && value) cookie.path = value;
      else if (attributeName === "max-age") maxAge = Number(value);
      else if (attributeName === "expires") expires = Date.parse(value);
      else if (attributeName === "secure") cookie.secure = true;
    }
    if (rejected) continue;
    // Max-Age wins over Expires, as in RFC 6265. A zero/negative age is a deletion.
    if (Number.isFinite(maxAge)) cookie.expires = Date.now() + (maxAge as number) * 1000;
    else if (Number.isFinite(expires)) cookie.expires = expires as number;
    // Host-only is part of a cookie's identity: `s` for example.org and `s` for `.example.org` are two
    // cookies, and replacing one with the other would silently widen or narrow where it is sent.
    const index = jar.findIndex((existing) =>
      existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path
      && Boolean(existing.hostOnly) === Boolean(cookie.hostOnly));
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
