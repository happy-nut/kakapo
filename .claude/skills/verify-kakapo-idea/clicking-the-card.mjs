import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { declaredVersion, drive, makeProject } from "./drive.mjs";

const FILE = "src/main/java/demo/Greeter.java";

const project = makeProject("click-card");
project.put(FILE, `package demo;

public class Greeter {
    public String greet(String name) {
        return "Hello, " + name;
    }

    public int twice(int n) { return n * 2; }
}
`);
project.commit("initial");

// One comment, because this run is about the controls on a card and not about how many it can hold.
const comments = join(project.dir, ".git", "kakapo", "comments.jsonl");
mkdirSync(join(project.dir, ".git", "kakapo"), { recursive: true });
writeFileSync(comments, JSON.stringify({
  path: FILE, kind: "c", by: "me", view: "source", id: 1, line: 5,
  anchor: '        return "Hello, " + name;',
  text: "Greet by display name, not the raw argument.",
}) + "\n");

const records = () => readFileSync(comments, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** A PNG says its own size in the eight bytes after the IHDR tag, and a click has to be scaled by it. */
function pictureWidth(file) {
  return readFileSync(file).readUInt32BE(16);
}

await drive("clicking-the-card", project, async (h) => {
  h.control(/Loaded custom plugins: kakapo comments/.test(h.ideLog()),
    "the IDE loaded the plugin from the distribution zip");
  const jar = join(h.sandbox, "plugins/kakapo-comments/lib", `kakapo-comments-${declaredVersion()}.jar`);
  h.control(existsSync(jar) && readFileSync(jar, "latin1").includes("getClickAction"),
    "and that build carries a gutter mark that answers a click", jar);
  h.control(records().length === 1, "one comment is open before anything is driven", records().length);

  // The point to hit is read off the picture by whoever is running this, because the card is laid out
  // by Swing and nothing here can ask it where it put a link. The run writes what it wants aimed and
  // waits; the answer is two numbers in that picture's own pixels.
  const aim = async (label, what) => {
    const shot = await h.shot(label);
    const want = join(h.evidence, `aim-needed-${label}.json`);
    const answer = join(h.evidence, `aim-${label}.json`);
    writeFileSync(want, JSON.stringify({ what, picture: shot, pictureWidth: pictureWidth(shot) }, null, 1) + "\n");
    await h.until(() => existsSync(answer), 900000, `a point to click for ${what}`);
    const { x, y } = JSON.parse(readFileSync(answer, "utf8"));
    await h.clickInWindow(x, y, pictureWidth(shot));
  };

  await h.actionOrRetry("Comment at Caret");

  // 1. The card's own Edit link. Until now the only thing tested about it was that the store can
  //    replace a line, which says nothing about whether the control reaches that code.
  const EDITED = "Greet by display name. Edited through the card's own link.";
  await aim("card-with-one-comment", "the Edit link on the card");
  // Edit fills the field with what is already there and leaves the caret at the end, which is what it
  // is for. So typing alone appends, and a check that only looked for the new words passed on the
  // concatenation — "…the raw argument.Greet by display name…" — and would have passed just the same
  // if nothing replaced anything. Select all first, and then equality can tell the two apart.
  await h.key("cmd+a", 800);
  await h.type(EDITED);
  await h.key("cmd+enter", 3000);
  await h.until(() => records()[0]?.text === EDITED, 30000,
    "the Edit link to replace the comment's text");
  h.check(records().length === 1 && records()[0].id === 1,
    "Edit replaced the text of the comment that was already there, and did not write a second one",
    `${records().length} record(s), id ${records()[0]?.id}`);

  // 2. The gutter mark, and Delete on the card it opens. One aim answers both: if Delete removes the
  //    record, the mark opened a card and that card's control reached the store. A picture of a
  //    reopened card would only have said it was drawn.
  await aim("gutter-mark", "the kakapo mark in the gutter on line 5");
  await aim("card-reopened-from-the-gutter", "the Delete link on the card the gutter mark opened");
  await h.until(() => records().length === 0, 30000, "Delete to remove the comment");
  h.check(true, "the gutter mark opened the card again, and Delete removed the comment from the file");
  await h.shot("after-delete");
}, { open: FILE, line: 5 });
