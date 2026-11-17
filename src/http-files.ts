import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { HttpAttachment, HttpSaveRequest, HttpSaveResult } from "./types.js";
import { containedRealPath, errorMessage } from "./util.js";
import { workspaceDataDirectory } from "./workspace-data.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const HISTORY_SENTINEL = "$historyFolder";

function historyDirectory(root: string, userData: string): string {
  return join(workspaceDataDirectory(userData, root), "http", "history");
}

function cookieJarFile(root: string, userData: string): string {
  return join(workspaceDataDirectory(userData, root), "http", "http-client.cookies");
}

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
  if (!parent) return undefined;
  const target = join(parent, cleaned.split("/").pop() as string);
  const within = relative(realpathSync(resolve(root)), target);
  return !within || within.startsWith("..") || isAbsolute(within) ? undefined : target;
}

export function readHttpAttachment(root: string, requested: string): HttpAttachment {
  const bytes = readHttpAttachmentBytes(root, requested);
  if (!bytes) return { ok: false, error: `cannot read ${requested} — it is missing, too large, or outside the review` };
  return { ok: true, text: bytes.toString("utf8"), bytes: bytes.byteLength };
}

export function readHttpAttachmentBytes(root: string, requested: string): Buffer | undefined {
  const target = containedRealPath(root, String(requested || "").replace(/\\/g, "/").replace(/^\.\//, ""));
  if (!target) return undefined;
  try {
    const stats = statSync(target);
    if (!stats.isFile() || stats.size > MAX_ATTACHMENT_BYTES) return undefined;
    return readFileSync(target);
  } catch { return undefined; }
}

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
  secure?: boolean;
  hostOnly?: boolean;
};

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

function secureEnough(url: URL): boolean {
  if (url.protocol === "https:") return true;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
}

function pathMatches(cookiePath: string, path: string): boolean {
  if (cookiePath === "/" || cookiePath === path) return true;
  return path.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
}

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
    if (seen.has(cookie.name)) continue;
    seen.add(cookie.name);
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join("; ");
}

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
        if (!maySetDomain(value, url.hostname)) { rejected = true; break; }
        cookie.domain = value.replace(/^\./, "");
        cookie.hostOnly = false;
      } else if (attributeName === "path" && value) cookie.path = value;
      else if (attributeName === "max-age") maxAge = Number(value);
      else if (attributeName === "expires") expires = Date.parse(value);
      else if (attributeName === "secure") cookie.secure = true;
    }
    if (rejected) continue;
    if (Number.isFinite(maxAge)) cookie.expires = Date.now() + (maxAge as number) * 1000;
    else if (Number.isFinite(expires)) cookie.expires = expires as number;
    const index = jar.findIndex((existing) =>
      existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path
      && Boolean(existing.hostOnly) === Boolean(cookie.hostOnly));
    if (cookie.expires >= 0 && cookie.expires <= Date.now()) {
      if (index >= 0) jar.splice(index, 1);
      continue;
    }
    if (index >= 0) jar[index] = cookie; else jar.push(cookie);
  }
  const file = cookieJarFile(root, userData);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializeJar(jar));
  } catch { }
  return setCookie;
}
