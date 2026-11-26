import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { declaredVersion, drive, makeProject } from "./drive.mjs";

const FILE = "src/main/java/demo/Greeter.java";

const project = makeProject("ui");
project.put(FILE, `package demo;

public class Greeter {
    public String greet(String name) {
        return "Hello, " + name;
    }

    public int twice(int n) { return n * 2; }
}
`);
project.commit("initial");

// One comment, open: the box is photographed being written, and then the hand-off archives this one
// and opens the window the archive is read in. Both windows are reached by the chords the plugin
// declares, so a run where the keystrokes do not land cannot produce the pictures.
const comments = join(project.dir, ".git", "kakapo", "comments.jsonl");
mkdirSync(join(project.dir, ".git", "kakapo"), { recursive: true });
writeFileSync(comments, JSON.stringify({
  id: 1, path: FILE, line: 5, anchor: '        return "Hello, " + name;',
  kind: "c", by: "me", view: "source", text: "Greet by display name, not the raw argument.",
}) + "\n");

await drive("comment-box-and-history", project, async (h) => {
  h.control(/Loaded custom plugins: kakapo comments/.test(h.ideLog()),
    "the IDE loaded the plugin from the distribution zip");

  const jar = join(h.sandbox, "plugins/kakapo-comments/lib", `kakapo-comments-${declaredVersion()}.jar`);
  h.control(existsSync(jar) && readFileSync(jar, "latin1").includes("ReviewHistoryFactory"),
    "and that build carries the tool window the archive is read in", jar);

  // Launching the IDE takes the screen on its own, and the chord still does not land while another
  // application holds the focus — the Claude app takes it straight back. So this script is only worth
  // running on a Mac nobody is using, and h.raise() is there for that run rather than called here.
  // ⌥⇧⌘/ is kakapo.AddComment. The box is a component inside the editor, so the picture is the proof.
  await h.action("Comment at Caret");
  await h.shot("comment-box");
  await h.key("esc");

  // ⌃⇧⌘/ is kakapo.HandOff: it copies, archives what it copied, and shows the archive.
  const before = readFileSync(comments, "utf8");
  h.control(!before.includes('"addressed":true'), "nothing is archived before the hand-off runs");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await h.key("ctrl+shift+cmd+/", 4000, true);
    if (readFileSync(comments, "utf8").includes('"addressed":true')) break;
  }

  // The file changing is what says the keystroke landed; without it the shot below proves nothing.
  await h.until(() => readFileSync(comments, "utf8").includes('"addressed":true'), 30000,
    "the hand-off chord to reach the IDE and archive the comment");
  h.check(true, "the hand-off chord reached the IDE and archived the comment");
  await h.shot("history");

  const onDisk = readFileSync(comments, "utf8");
  h.check(onDisk.split("\n").filter(Boolean).length === 1, "and the record is still there — archived is not deleted");
}, { open: FILE, line: 5 });
