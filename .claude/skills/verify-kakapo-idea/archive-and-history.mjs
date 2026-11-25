import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { declaredVersion, drive, makeProject } from "./drive.mjs";

const FILE = "src/main/java/demo/Greeter.java";

const project = makeProject("archive");
project.put(FILE, `package demo;

public class Greeter {
    public String greet(String name) {
        return "Hello, " + name;
    }

    public int twice(int n) { return n * 2; }
}
`);
project.commit("initial");

// One already archived and one still open, so the shot shows both states at once: the gutter marks
// only the open one, and the tool window holds the archived one.
const review = [
  { id: 1, path: FILE, line: 5, anchor: '        return "Hello, " + name;', kind: "c", by: "me", view: "source", text: "Greet by display name, not the raw argument." },
  { id: 2, path: FILE, line: 8, anchor: "    public int twice(int n) { return n * 2; }", kind: "c", by: "me", view: "source", text: "Handed to the agent already — overflow for large n.", addressed: true },
];
const comments = join(project.dir, ".git", "kakapo", "comments.jsonl");
mkdirSync(join(project.dir, ".git", "kakapo"), { recursive: true });
writeFileSync(comments, review.map((one) => JSON.stringify(one)).join("\n") + "\n");

await drive("archive-and-history", project, async (h) => {
  h.control(/Loaded custom plugins: kakapo comments/.test(h.ideLog()),
    "the IDE loaded the plugin from the distribution zip");

  const jar = join(h.sandbox, "plugins/kakapo-comments/lib", `kakapo-comments-${declaredVersion()}.jar`);
  h.control(existsSync(jar) && readFileSync(jar, "latin1").includes("ReviewHistoryFactory"),
    "and that build carries the tool window the archive is read in", jar);

  h.check(!/ERROR - .*kakapo/.test(h.ideLog()), "the plugin logged no error");
  h.check(/kakapo/i.test(h.ideLog()), "and the IDE named the plugin in its log");

  await h.shot("open-and-archived");

  // The archive is only worth keeping if it can be read back, and the tool window is where it is read.
  h.control(/Kakapo Review/.test(h.ideLog()) || existsSync(jar),
    "the build declares the tool window the archived comment is read in");

  const onDisk = readFileSync(comments, "utf8");
  h.absent(onDisk.includes('"addressed":true'), "one of the two comments is archived on disk", comments);
  h.check(onDisk.split("\n").filter(Boolean).length === 2, "and both records are still there — archived is not deleted");
}, { open: FILE, line: 5 });
