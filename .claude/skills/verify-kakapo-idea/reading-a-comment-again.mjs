import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { declaredVersion, drive, makeProject } from "./drive.mjs";

const FILE = "src/main/java/demo/Greeter.java";

const project = makeProject("read-again");
project.put(FILE, `package demo;

public class Greeter {
    public String greet(String name) {
        return "Hello, " + name;
    }

    public int twice(int n) { return n * 2; }
}
`);
project.commit("initial");

// Two comments on one line, one on another, and one already archived. Two on a line is the case that
// used to paint two gutter renderers into the same row and show one of them, and the archived one is
// what proves the Open list is a filter and not the whole file.
const comments = join(project.dir, ".git", "kakapo", "comments.jsonl");
mkdirSync(join(project.dir, ".git", "kakapo"), { recursive: true });
const record = (fields) => JSON.stringify({
  path: FILE, kind: "c", by: "me", view: "source", ...fields,
});
writeFileSync(comments, [
  record({ id: 1, line: 5, anchor: '        return "Hello, " + name;', text: "Greet by display name, not the raw argument." }),
  record({ id: 2, line: 5, anchor: '        return "Hello, " + name;', by: "agent", text: "Agreed — and the greeting itself belongs in a message bundle." }),
  record({ id: 3, line: 8, anchor: "    public int twice(int n) { return n * 2; }", text: "Name this what it is for." }),
  record({ id: 4, line: 3, anchor: "public class Greeter {", text: "Handed over already.", addressed: true }),
].join("\n") + "\n");

const open = () => readFileSync(comments, "utf8").split("\n").filter(Boolean)
  .filter((line) => !line.includes('"addressed":true'));

await drive("reading-a-comment-again", project, async (h) => {
  h.control(/Loaded custom plugins: kakapo comments/.test(h.ideLog()),
    "the IDE loaded the plugin from the distribution zip");

  const jar = join(h.sandbox, "plugins/kakapo-comments/lib", `kakapo-comments-${declaredVersion()}.jar`);
  h.control(existsSync(jar) && readFileSync(jar, "latin1").includes("ReviewListFactory"),
    "and that build carries the lists a comment is read again in", jar);
  h.control(open().length === 3, "three comments are open before anything is driven", open().length);

  // Find Action is the way in, and only the first one in a run lands: a later one loses the screen to
  // the terminal this run was started from, every time, whatever action it asks for. The chord the
  // plugin declares does not reach a Java window when it is synthesised — macOS turns Option into a
  // character before Java sees it — so the one reliable opening goes to the thing being shown.
  await h.actionOrRetry("Comment at Caret");
  await h.shot("card-on-a-commented-line");

  // The screenshot says the card is on screen. Only a record says it had the keyboard, so one is
  // written through it — and that is also the write path for a line that already holds comments.
  await h.type("And a third, written while the other two were being read.");
  await h.key("cmd+enter", 3000);
  await h.until(() => open().length === 4, 30000, "the card to write a third comment on that line");
  h.check(true, "the card took a comment on a line that already had two");

  // ⌃⇧⌘/ archives what it copies and asks for the Archived list, so the same window moves tabs.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await h.key("ctrl+shift+cmd+/", 4000, true);
    if (open().length === 0) break;
  }
  await h.until(() => open().length === 0, 30000, "the hand-off to archive all four open comments");
  h.check(true, "the hand-off archived every open comment");
  await h.shot("archived-list");

  const all = readFileSync(comments, "utf8").split("\n").filter(Boolean);
  h.check(all.length === 5, "and nothing was deleted — five records, all archived", all.length);
  h.check(all.every((line) => line.includes('"addressed":true')), "every one of them marked, not rewritten away");
}, { open: FILE, line: 5 });
