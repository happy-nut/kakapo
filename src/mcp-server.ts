// ===== kakapo's MCP server: the vocabulary, offered to whatever agent the reviewer is talking to.
//
// The problem this solves is not "how does an agent write a word" — that is one appended line — it is HOW IT
// KNOWS TO. Every other way of telling it is a note left somewhere and a hope that it gets read: a block in
// AGENTS.md (which is committed, so the whole team gets it whether they use kakapo or not), a launch flag
// (different per agent, and missing entirely from the sessions the reviewer starts themselves), or a prompt
// the reviewer has to remember to send. A tool is the opposite shape: its description is IN the agent's
// context on every turn, so the rules travel with the capability instead of being filed next to it.
//
// Two tools, and the split between them is the whole design of the vocabulary:
//   - `kakapo_words` reads. Any agent explaining anything about this repository should call it first — those
//     are the words the explanation has to be written in.
//   - `kakapo_keep_word` writes, and its description carries the one rule that makes the file worth reading:
//     the words are the READER's. An agent's own coinage never goes in, however much better it is.
//
// It speaks JSON-RPC over stdio (the MCP stdio transport) directly rather than through the SDK: initialize,
// tools/list, tools/call and notifications are about eighty lines, and a dependency that large for eighty
// lines would be the tail wagging the dog.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mergeTerms, readTerms, termsFilePath, writeTerms, type TermRecord } from "./terms-file.js";

const PROTOCOL_VERSION = "2024-11-05";

// The repository is wherever the agent is working, which is where its own process was started — so nothing
// has to be passed in and nothing can be passed in wrong. A worktree resolves to the same shared file as its
// main clone (kakapoSharedDataFile), which is the point: knowledge outlives the workspace it was learned in.
export function repoRootFrom(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export const KEEP_WORD_TOOL = {
  name: "kakapo_keep_word",
  description:
    "Record one word the USER has taken into their own vocabulary about this repository, so that every later " +
    "explanation can be written in it. Call this when a conversation shows the user has taken a concept in: " +
    "they used the word themselves, and then stopped asking about it or went on to build on it.\n\n" +
    "The one rule: the words are the USER's. Never record a name you coined, however much better it is, and " +
    "never a word from an answer they have not responded to — an answer nobody took in must not become the " +
    "language the next explanation is written in. A word they are still asking about is a misunderstanding, " +
    "not knowledge.\n\n" +
    "Record concepts, not identifiers: a file, function or variable name is not a word, it is what a word " +
    "turns out to BE in the code, which is what `code` is for. And record only words that say something " +
    "about this repository: a connective, particle or filler the user happened to type (\"rather\", " +
    "\"actually\", \"아니라\") is grammar, not knowledge — if the word alone cannot carry one line of meaning " +
    "about this codebase, it does not go in. If there is nothing to record, do not call " +
    "this — most conversations record nothing, and a knowledge graph full of words the user never chose is worse " +
    "than an empty one.",
  inputSchema: {
    type: "object",
    properties: {
      w: { type: "string", description: "The word, exactly as the user wrote it." },
      gloss: { type: "string", description: "One line saying what it is, in the user's words. Mentioning other words from kakapo_words is what links them on the map." },
      parent: { type: "string", description: "Set when the word only means something inside another concept — \"serialization\" as discussed inside \"external API\"." },
      code: {
        type: "array",
        description: "What the word turns out to be in the code.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The identifier, rule or file it is." },
            at: { type: "string", description: "repo-relative path[:line] where it is now. A cache; the name is the truth." },
          },
          required: ["name"],
        },
      },
    },
    required: ["w", "gloss"],
  },
} as const;

export const WORDS_TOOL = {
  name: "kakapo_words",
  description:
    "The words this repository's reviewer actually uses, with what each one means to them. Read this before " +
    "explaining anything about this repository, and write the explanation in these words: if one of them says " +
    "what you mean, use it rather than a name of your own — calling the same thing by a second name makes the " +
    "reader work out whether the two are the same before they can read anything at all.",
  inputSchema: { type: "object", properties: {} },
} as const;

type Json = Record<string, unknown>;

function termsFileFor(cwd: string): string | undefined {
  const root = repoRootFrom(cwd);
  return root ? termsFilePath(root) : undefined;
}

// A word arrives from an agent, so it is checked here rather than trusted: the shape, and the two things the
// tool description asks for that a model can still get wrong — an identifier passed off as a word, and a
// word that is already in the file.
export function keepWord(cwd: string, input: Json): { ok: boolean; message: string } {
  const file = termsFileFor(cwd);
  if (!file) return { ok: false, message: "not inside a git repository, so there is no vocabulary to add to" };
  const w = typeof input.w === "string" ? input.w.trim() : "";
  const gloss = typeof input.gloss === "string" ? input.gloss.trim() : "";
  if (!w || !gloss) return { ok: false, message: "both `w` and `gloss` are required" };
  if (/[(){}]|\.[a-z]{1,4}$|[a-z][A-Z]|_/.test(w)) {
    return { ok: false, message: `"${w}" looks like an identifier. A word is what the user says out loud; put the identifier in \`code\`.` };
  }
  const term: TermRecord = { w, gloss };
  if (typeof input.parent === "string" && input.parent.trim()) term.parent = input.parent.trim();
  if (Array.isArray(input.code)) {
    const code = input.code
      .filter((entry): entry is { name: string; at?: string } => !!entry && typeof (entry as { name?: unknown }).name === "string")
      .map((entry) => (entry.at ? { name: entry.name, at: String(entry.at) } : { name: entry.name }));
    if (code.length) term.code = code;
  }
  const existing = readTerms(file);
  const match = existing.find((other) => other.w === term.w && other.parent === term.parent);
  // A word the reader threw out is not a gap to fill. Offering it again is how a rejected name creeps back
  // into the vocabulary one session at a time, so the tombstone answers for it (terms-file.ts).
  if (match?.dropped) return { ok: false, message: `"${w}" was removed from the vocabulary by the reviewer — leave it out` };
  if (match) return { ok: false, message: `"${w}" is already in the vocabulary — nothing to add` };
  writeTerms(file, mergeTerms(existing, [term]));
  return { ok: true, message: `kept "${w}" — it is on the reviewer's knowledge map now` };
}

export function listWords(cwd: string): string {
  const file = termsFileFor(cwd);
  if (!file) return "not inside a git repository";
  const terms = readTerms(file).filter((term) => !term.dropped); // a word thrown out is not vocabulary
  if (!terms.length) return "The reviewer has not built up any words yet. Write in plain words anyone knows, and do not coin a name.";
  return terms
    .map((term) => {
      const name = term.parent ? `${term.parent} · ${term.w}` : term.w;
      const code = term.code?.length ? ` [${term.code.map((entry) => (entry.at ? `${entry.name} @ ${entry.at}` : entry.name)).join(", ")}]` : "";
      // A proposal is the agent's own offering, not the reader's word, and it must not be mistaken for one.
      return `${term.proposed ? "(offered, not yet theirs) " : ""}${name} — ${term.gloss}${code}`;
    })
    .join("\n");
}

// ── the protocol ─────────────────────────────────────────────────────────────────────────────────
export function handleRpc(message: Json, cwd: string): Json | undefined {
  const { id, method, params } = message as { id?: unknown; method?: string; params?: Json };
  const reply = (result: Json): Json => ({ jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    return reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "kakapo", version: "1" },
    });
  }
  if (method === "tools/list") return reply({ tools: [WORDS_TOOL, KEEP_WORD_TOOL] });
  if (method === "tools/call") {
    const name = typeof params?.name === "string" ? params.name : "";
    const args = (params?.arguments as Json) ?? {};
    if (name === WORDS_TOOL.name) {
      return reply({ content: [{ type: "text", text: listWords(cwd) }] });
    }
    if (name === KEEP_WORD_TOOL.name) {
      const outcome = keepWord(cwd, args);
      return reply({ content: [{ type: "text", text: outcome.message }], isError: !outcome.ok });
    }
    return reply({ content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true });
  }
  // A notification (no id) is acknowledged by saying nothing at all — answering one is a protocol error.
  if (id === undefined) return undefined;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } };
}

export function runMcpServer(): void {
  const cwd = process.cwd();
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Json;
    try {
      message = JSON.parse(trimmed) as Json;
    } catch {
      return; // a half-written line is not worth answering, and there is no id to answer with
    }
    const response = handleRpc(message, cwd);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}
