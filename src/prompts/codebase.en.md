Read this repository and leave ONE note on it: a map of what it is made of. I have just joined and need its shape before its details.

Stop at the top. This prompt does not explain files, functions or decisions - "Explain the diff" does that later, once the reader knows which part of the map they are standing in. One map is the whole job; a second note is scope creep.

Write it to exactly this file, ONE JSON object per line (create it and its parent directories if missing; the file documents its own format in the # header at the top):
{{NOTES_PATH}}

{"id":<the NEXT FREE ID given at the top of the file>,"by":"agent","kind":"note","path":"repo/relative/entry-point.ts","line":1,"title":"What this repository is made of","text":"markdown"}
- APPEND only. Comments from the reviewer and your earlier answers live in this same file: never rewrite, reorder or renumber a line already there.
- "text" is markdown on ONE line - write real line breaks as \n inside the JSON string.
- Anchor the note to the entry point: whatever actually runs first. That is where a newcomer starts reading, so that is where the map belongs.

**The map is drawn in the reader's words.** Call `kakapo_words` for the words this repository's reviewer has actually used.

Read them; do not add new ones while you are drawing the map. A word gets in there only when the reader used it themselves — that the names are theirs and not yours is the entire point of the file. Three rules follow from it.

1. **Pick the component names from there first.** When you choose the 3-5 core components below, prefer the ones you can call by a word that file already has. A box named in the reader's own word finds its place the moment they look at the map; a box named by you is one more thing to learn. Coin a new name only when that file genuinely cannot say it, and define it on the spot.
2. **Attach it to what they already know.** Start each paragraph from a word they have - "this is the same place a comment used to hang from" is faster than a fresh paragraph. Where that file shows two words used together, draw that connection as an edge.
3. **Do not break the "why" chain.** Understanding travels along why. A component stands on "what stops working without it", not on "what it does", and each paragraph starts from the why the previous one answered.

If the tool returns nothing, or is not there at all, the reviewer has not built up any words yet. Then it matters even more not to coin one: write in plain words anyone knows — whatever they meet in this explanation is what they will be saying next time.

Once the map is written, leave your **proposals** in that file: one line per domain concept you found to be
core to this repository, `{"w":"the concept","gloss":"one line","proposed":true,"code":[{"name":"identifier","at":"src/x.ts:12"}]}`.
The `"proposed":true` is the whole point — a line carrying it is read as YOURS, not the reader's, and is drawn
around the outside of the map joined to nothing. It moves inside the day the reader uses the word themselves.
Never propose a word the file already has. Five at most, and domain concepts — not file or function names.

The map has two halves and both are required.

1. The diagram, drawn through the `kakapo_map` tool - NOT drawn in the note. Pick the 3-5 components this codebase is actually built out of - not every directory, the handful you cannot explain the system without. Call `kakapo_map` once with:
   - one component per box: `label` NAMES the component and `sublabel` states its job in a few words, so the diagram reads on its own
   - `connections` that say what flows between them and in which direction - the relationships are the point
   - `sources` giving every component the place it lives, as `"src/app-main.ts:1198"` - kakapo turns those into navigation: clicking the node opens that file at that line.
   The tool validates the diagram before rendering anything. If it answers with diagnostics, fix exactly what they name and call it again - the map does not exist until the call succeeds.

2. In the note, one short paragraph per component - three or four sentences, in the same order as the diagram. Each paragraph must carry all three of:
   - what it is responsible for, and what it deliberately is NOT.
   - AN EXAMPLE. One concrete thing that actually passes through it, named. "Handles review requests" is not an example. "`kakapo:get-file` arrives carrying a file index and leaves as HTML" is. Every paragraph needs at least one real identifier, message name, path or number in it - an abstraction the reader cannot land on a case is an abstraction they will agree with and not remember.
   - A LINK ONWARD. Write file references as inline code with a line number - `src/app-review-ipc.ts:50` - and kakapo turns them into a click that jumps there. Name the seam where this component meets the next one and link it. When two components meet, both paragraphs should point at that same place from their own side, so the prose is a mesh and not a list.

How to write it:
- Explain it to a smart 12-year-old who happens to program. Short sentences, plain words.
- Keep the real term - the reader deserves its name - and spend half a sentence earning it the first time it appears. A name this codebase invented is different: a pin, a manifest, a workspace mean nothing until you say what they are, so define one the first time you use it.
- Concrete over abstract, always. Name the actual file, function, symptom. "The window goes blank for a second while the index rebuilds" beats "a synchronisation issue".
- Lead with why a component exists, not with what its files are called.
- Read the comments and the commit history where the code alone does not say WHY.
- Write nothing you have not verified. If you cannot establish something, leave it out entirely - never hedge, never write "probably" or "seems to". A gap reads as "not explained yet"; a hedge costs the reader the same space as a real sentence and gives them nothing to act on.
- The whole note should fit on a screen or two. Longer than that means you are explaining the components instead of mapping them - which is the other prompt.

After writing the file, stop - kakapo detects it and renders the map on the code automatically.
