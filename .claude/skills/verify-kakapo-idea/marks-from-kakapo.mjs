import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { declaredVersion, drive, makeProject } from "./drive.mjs";

const FILE = "src/main/java/demo/Greeter.java";

const project = makeProject("marks");
project.put(FILE, `package demo;

public class Greeter {
    public String greet(String name) {
        return "Hello, " + name;
    }

    public int twice(int n) { return n * 2; }
}
`);
project.commit("initial");

const review = [
  { id: 1, path: FILE, line: 5, anchor: '        return "Hello, " + name;', kind: "c", by: "me", view: "source", text: "Greet by display name, not the raw argument." },
  { id: 2, path: FILE, line: 8, anchor: "    public int twice(int n) { return n * 2; }", kind: "c", by: "me", view: "source", text: "Guard against overflow for large n." },
];
const comments = join(project.dir, ".git", "kakapo", "comments.jsonl");
mkdirSync(join(project.dir, ".git", "kakapo"), { recursive: true });
writeFileSync(comments, review.map((one) => JSON.stringify(one)).join("\n") + "\n");

await drive("marks-from-kakapo", project, async (h) => {
  h.control(/Loaded custom plugins: kakapo comments/.test(h.ideLog()),
    "the IDE loaded the plugin from the distribution zip");

  // Read the painter out of what was installed, not out of src/: the sources can have it while the
  // artifact that ships does not, which is the whole reason this harness installs the zip. A jar is a
  // zip and its entry names sit in the central directory as plain bytes, so this needs no unzip.
  const jar = join(h.sandbox, "plugins/kakapo-comments/lib", `kakapo-comments-${declaredVersion()}.jar`);
  h.control(readFileSync(jar, "latin1").includes("CommentMarksOnOpen"),
    "and the zip it came from carries the painter that runs when a file is opened", jar);

  h.check(!/ERROR - .*kakapo/.test(h.ideLog()), "the plugin logged no error");
  await h.shot("review-painted");

  // The picture is the deliverable: balloons on the two reviewed lines. A run cannot read pixels, so it
  // states what the reader should see and leaves the file in place for that shot.
  h.absent(existsSync(comments), "the review the shot above has to be showing is on disk");
  rmSync(comments, { force: true });
  h.check(!existsSync(comments), "and is removed, so a second run of this script shoots the control");
}, { open: FILE, line: 5 });
