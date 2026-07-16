import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalWorkspacePath, workspaceMemoFile } from "./workspace-data.js";

export type MarkdownMemoDocument = {
  version: 1;
  worktreePath: string;
  body: string;
  updatedAt: string | null;
};

const MAX_BODY_LENGTH = 2_000_000;

function memoBody(value: unknown): string {
  return (typeof value === "string" ? value : String(value ?? "")).slice(0, MAX_BODY_LENGTH);
}

function normalizedDate(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function canonicalWorktreePath(root: string): string {
  return canonicalWorkspacePath(root);
}

export function markdownMemoFile(userData: string, root: string): string {
  return workspaceMemoFile(userData, root);
}

function legacyMarkdownMemoFile(userData: string, root: string): string {
  const scope = createHash("sha256").update(canonicalWorktreePath(root)).digest("hex");
  return join(resolve(userData), "notes", `${scope}.json`);
}

export class ProjectMarkdownMemo {
  constructor(private readonly userData: string) {}

  read(root: string): MarkdownMemoDocument {
    const worktreePath = canonicalWorktreePath(root);
    const file = markdownMemoFile(this.userData, worktreePath);
    const legacyFile = legacyMarkdownMemoFile(this.userData, worktreePath);
    try {
      const source = existsSync(file) ? file : legacyFile;
      const parsed = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown>;
      // Compatibility with the short-lived multi-note development format: retain the newest note rather
      // than dropping local work when moving to the deliberately simpler one-document model.
      const formerNote = Array.isArray(parsed.notes) && parsed.notes[0] && typeof parsed.notes[0] === "object"
        ? parsed.notes[0] as Record<string, unknown>
        : undefined;
      const document = {
        version: 1,
        worktreePath,
        body: memoBody(formerNote ? formerNote.body : parsed.body),
        updatedAt: normalizedDate(formerNote ? formerNote.updatedAt : parsed.updatedAt),
      } satisfies MarkdownMemoDocument;
      if (source === legacyFile) {
        this.writeDocument(root, document);
        rmSync(legacyFile, { force: true });
      }
      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, worktreePath, body: "", updatedAt: null };
      }
      // Never treat corrupt or unreadable data as an empty memo: a later save would overwrite the only
      // copy. Let the renderer surface a load error and preserve the file byte-for-byte.
      throw error;
    }
  }

  write(root: string, body: unknown): MarkdownMemoDocument {
    const file = markdownMemoFile(this.userData, root);
    if (existsSync(file)) this.read(root); // validate before replacement; never overwrite corrupt data
    const document: MarkdownMemoDocument = {
      version: 1,
      worktreePath: canonicalWorktreePath(root),
      body: memoBody(body),
      updatedAt: new Date().toISOString(),
    };
    this.writeDocument(root, document);
    return document;
  }

  remove(root: string): boolean {
    const file = markdownMemoFile(this.userData, root);
    const legacyFile = legacyMarkdownMemoFile(this.userData, root);
    const existed = existsSync(file) || existsSync(legacyFile);
    rmSync(file, { force: true });
    rmSync(legacyFile, { force: true });
    return existed;
  }

  private writeDocument(root: string, document: MarkdownMemoDocument): void {
    const file = markdownMemoFile(this.userData, root);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
