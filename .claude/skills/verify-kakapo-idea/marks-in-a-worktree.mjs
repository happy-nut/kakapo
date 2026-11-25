import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { declaredVersion, drive, makeProject } from "./drive.mjs";

const FILE = "src/main/java/demo/Greeter.java";

const project = makeProject("worktree");
project.put(FILE, `package demo;

public class Greeter {
    public String greet(String name) {
        return "Hello, " + name;
    }
}
`);
project.commit("initial");

const linked = project.linkTo("side");
process.on("exit", () => rmSync(project.dir, { recursive: true, force: true }));

// Where kakapo keeps the review for this worktree: git's own answer, not a guess.
const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: linked, encoding: "utf8" }).trim();
const comments = join(gitDir, "kakapo", "comments.jsonl");
mkdirSync(join(gitDir, "kakapo"), { recursive: true });
writeFileSync(comments, `${JSON.stringify({
  id: 1, path: FILE, line: 5, anchor: '        return "Hello, " + name;',
  kind: "c", by: "me", view: "source", text: "This review lives in the worktree's own git directory.",
})}\n`);

await drive("marks-in-a-worktree", { ...project, dir: linked }, async (h) => {
  h.control(/Loaded custom plugins: kakapo comments/.test(h.ideLog()),
    "the IDE loaded the plugin from the distribution zip");
  h.control(statSync(join(linked, ".git")).isFile(),
    "and this really is a linked worktree: its .git is a file, not a directory");

  // A class inside a jar is deflated, so a string constant is not in the jar's bytes — only entry
  // names are. Read the class out before looking for the literal.
  const jar = join(h.sandbox, "plugins/kakapo-comments/lib", `kakapo-comments-${declaredVersion()}.jar`);
  const klass = execFileSync("unzip", ["-p", jar, "dev/kakapo/comments/CommentStore.class"], { encoding: "latin1" });
  h.control(klass.includes("gitdir:"),
    "and the installed build reads that file's pointer", jar);

  h.check(!/ERROR - .*kakapo/.test(h.ideLog()), "the plugin logged no error");
  await h.shot("worktree-review-painted");
  h.absent(readFileSync(comments, "utf8").includes("worktree's own git directory"),
    "the review the shot has to be showing is where git says it lives", comments);
}, { open: FILE, line: 5 });
