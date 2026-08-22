import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { kakapoSharedDataFile } from "./git.js";

// The vocabulary: the words the REVIEWER uses about this repository, one per line. This is the knowledge
// base — notes on a diff explain one change and are replaced by the next explanation (23-annotations.js),
// but a word the reviewer has taken up outlives every change, so it lives in its own file beside the
// repository rather than beside a workspace.
//
// Two rules decide what may be in here, and both are about who owns the words:
//   - the name is something the READER said. An agent may propose one, but a proposal waits outside the
//     vocabulary until the reader uses that word themselves. An answer nobody read must never become the
//     language the next explanation is written in.
//   - the code half is a NAME, and `at` is only where it was last found. Line numbers rot on every commit;
//     an identifier that is simply gone is real news, and that is the one thing worth reporting.
export type TermCode = {
  name: string; // an identifier, a rule, a file — whatever the word turns out to be in the code
  at?: string; // repo-relative path[:line] where it was last resolved. A CACHE, never the truth.
};

export type TermRecord = {
  w: string; // the word itself, exactly as the reader writes it
  // A detail belongs to the concept it details, so its identity carries that concept: "앵커" under 말풍선 and
  // "앵커" under 코멘트 are two words, not one. Merging them would draw an edge between 말풍선 and 코멘트 that
  // nobody ever claimed.
  parent?: string;
  gloss: string; // one line, in the reader's words. Mentions of other words in here ARE the graph's edges.
  code?: TermCode[];
  // Read since it appeared. Absent on a word that has just entered, which is what the unread dot keys off —
  // opening the map is not reading, so this is only set when the word's own detail is opened.
  seen?: boolean;
  // The thread records this was extracted from, so a word can always be traced back to the conversation
  // that produced it.
  from?: number[];
  // A concept the AGENT found in the code and is offering — not one the reader has taken up. It is drawn
  // around the outside of the map and joins nothing: an edge would say the reader connected these two ideas,
  // and they have not. It becomes an ordinary word the day the reader uses it themselves.
  proposed?: boolean;
};

export function termsFilePath(root: string): string | undefined {
  return kakapoSharedDataFile(root, "terms.jsonl");
}

// Same identity rule the graph draws with.
export function termKey(term: Pick<TermRecord, "w" | "parent">): string {
  return term.parent ? `${term.parent}·${term.w}` : term.w;
}

function headerFor(): string[] {
  return [
    "# kakapo vocabulary — one JSON object per line. Lines starting with # are ignored.",
    '# {"w":"단어","gloss":"한 줄 설명","code":[{"name":"식별자","at":"src/x.ts:12"}]}',
    "# A word belongs here only once the READER has used it. `at` is a cache: the name is what is stored.",
    '# An agent may add {"proposed":true} entries — concepts it found in the code and is offering. They are',
    "# drawn around the outside of the map and join nothing until the reader uses the word themselves.",
  ];
}

export function readTerms(file: string | undefined): TermRecord[] {
  if (!file || !existsSync(file)) return [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const terms: TermRecord[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // a half-written line costs one word, not the file
    }
    const record = parsed as Partial<TermRecord>;
    if (!record || typeof record.w !== "string" || !record.w.trim()) continue;
    const term: TermRecord = {
      w: record.w.trim(),
      gloss: typeof record.gloss === "string" ? record.gloss : "",
    };
    if (typeof record.parent === "string" && record.parent.trim()) term.parent = record.parent.trim();
    if (Array.isArray(record.code)) {
      const code = record.code
        .filter((entry): entry is TermCode => !!entry && typeof (entry as TermCode).name === "string")
        .map((entry) => (entry.at ? { name: entry.name, at: entry.at } : { name: entry.name }));
      if (code.length) term.code = code;
    }
    if (record.seen === true) term.seen = true;
    if (record.proposed === true) term.proposed = true;
    if (Array.isArray(record.from)) {
      const from = record.from.map(Number).filter((id) => Number.isFinite(id) && id > 0);
      if (from.length) term.from = from;
    }
    // The last line for a key wins, so a word can be corrected by appending — the same append-only habit the
    // thread file teaches an agent, without a rewrite step that could drop somebody else's line.
    const key = termKey(term);
    if (seen.has(key)) {
      const at = terms.findIndex((existing) => termKey(existing) === key);
      terms[at] = term;
      continue;
    }
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

export function writeTerms(file: string, terms: TermRecord[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const lines = headerFor().concat(terms.map((term) => JSON.stringify(term)));
  writeFileSync(file, lines.join("\n") + "\n");
}

// Two writers, one file. The renderer holds the whole vocabulary in memory while the map is open and writes
// it back entire; the agent appends a line at a time, from a session that may have started before the map
// was even opened. Writing the renderer's copy straight over the file would silently drop whatever the agent
// added in between — so the file on disk is re-read at the moment of writing, and only the records the
// renderer actually has an opinion about are replaced.
export function mergeTerms(onDisk: TermRecord[], incoming: TermRecord[]): TermRecord[] {
  const merged = onDisk.slice();
  const at = new Map(merged.map((term, index) => [termKey(term), index]));
  for (const term of incoming) {
    const key = termKey(term);
    const index = at.get(key);
    if (index === undefined) {
      at.set(key, merged.length);
      merged.push(term);
    } else {
      merged[index] = term;
    }
  }
  return merged;
}

// ── IPC ──────────────────────────────────────────────────────────────────────────────────────────
// Read the file, hand it over; take it back, merge it onto whatever the file says now, write it.
export type TermsIpcState = { options: { root: string }; termsFile?: string };
type TermsResolver = (event: IpcMainInvokeEvent) => TermsIpcState | undefined;

export function registerTermsIpc(ipc: IpcMain, stateFromEvent: TermsResolver): void {
  const fileFor = (state: TermsIpcState | undefined): string | undefined => {
    if (!state) return undefined;
    if (!state.termsFile) state.termsFile = termsFilePath(state.options.root);
    return state.termsFile;
  };

  ipc.handle("kakapo:terms-read", (event) => {
    const file = fileFor(stateFromEvent(event));
    return { path: file ?? "", terms: readTerms(file) };
  });

  ipc.handle("kakapo:terms-write", (event, payload: { terms?: TermRecord[] }) => {
    const file = fileFor(stateFromEvent(event));
    if (!file || !Array.isArray(payload?.terms)) return { ok: false };
    const merged = mergeTerms(readTerms(file), payload.terms);
    writeTerms(file, merged);
    return { ok: true, path: file, terms: merged };
  });
}
