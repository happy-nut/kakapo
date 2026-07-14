import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot } from "./git.js";

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
  const top = resolve(repoRoot(resolve(root)));
  try { return realpathSync.native(top); } catch { return top; }
}

export function markdownMemoFile(userData: string, root: string): string {
  const worktreePath = canonicalWorktreePath(root);
  const scope = createHash("sha256").update(worktreePath).digest("hex");
  return join(resolve(userData), "notes", `${scope}.json`);
}

export class ProjectMarkdownMemo {
  constructor(private readonly userData: string) {}

  read(root: string): MarkdownMemoDocument {
    const worktreePath = canonicalWorktreePath(root);
    const file = markdownMemoFile(this.userData, worktreePath);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      // Compatibility with the short-lived multi-note development format: retain the newest note rather
      // than dropping local work when moving to the deliberately simpler one-document model.
      const formerNote = Array.isArray(parsed.notes) && parsed.notes[0] && typeof parsed.notes[0] === "object"
        ? parsed.notes[0] as Record<string, unknown>
        : undefined;
      return {
        version: 1,
        worktreePath,
        body: memoBody(formerNote ? formerNote.body : parsed.body),
        updatedAt: normalizedDate(formerNote ? formerNote.updatedAt : parsed.updatedAt),
      };
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
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
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
