package dev.kakapo.comments

import java.nio.file.Files
import java.nio.file.Path

/**
 * The review format and the git directory, run for real without an IDE. Everything the plugin was
 * shipped wrong about lived in these two, and the only checks on them were regular expressions over
 * this very source — which pass whether or not the code is ever called.
 *
 * Writes a file for the caller when given a path, so the same records can be read back by kakapo's
 * own reader and the two can be compared rather than described.
 */
object ReviewCheck {

    private var failures = 0

    private fun check(ok: Boolean, what: String, detail: Any? = null) {
        println("${if (ok) "ok  " else "FAIL"} $what${if (detail == null) "" else " — $detail"}")
        if (!ok) failures += 1
    }

    @JvmStatic
    fun main(args: Array<String>) {
        roundTrip()
        keepsFieldsItDoesNotModel()
        everyStateIsInSomeList()
        idsComeFromTheHeader()
        gitDirFollowsThePointer()
        args.firstOrNull()?.let { emit(Path.of(it)) }
        println(if (failures == 0) "PASSED ReviewCheck" else "FAILED ReviewCheck ($failures)")
        if (failures != 0) kotlin.system.exitProcess(1)
    }

    private fun roundTrip() {
        val written = Comment(
            id = 7,
            path = "src/main/java/demo/Greeter.java",
            line = 5,
            anchor = """        return "Hello, " + name;""",
            text = "Quote \"this\", a tab\there and a newline\nsecond line",
            view = "diff",
            side = "old",
        )
        val back = ReviewFormat.parse(ReviewFormat.encode(written))
        check(back != null, "a comment survives being written and read")
        check(back?.text == written.text, "with its text intact", back?.text)
        check(back?.anchor == written.anchor, "and its anchor", back?.anchor)
        check(back?.view == "diff" && back.side == "old", "and the view and side it was written in", "${back?.view}/${back?.side}")

        // The anchor is a line of source, and source can look like the record around it. Escaping is
        // what keeps the reader from believing it.
        val mimic = written.copy(anchor = """  "text":"not the real text","line":999 """)
        val fooled = ReviewFormat.parse(ReviewFormat.encode(mimic))
        check(fooled?.text == written.text, "a line of source that mimics the record does not fool the reader", fooled?.text)
        check(fooled?.line == 5, "nor its line number", fooled?.line)
    }

    private fun keepsFieldsItDoesNotModel() {
        val kakapo = """{"id":3,"re":2,"by":"agent","kind":"note","group":4,"path":"a.ts","line":9,"anchor":"x","text":"from kakapo"}"""
        val marked = ReviewFormat.addressed(kakapo)
        check(marked.contains("\"re\":2") && marked.contains("\"group\":4"),
            "archiving a kakapo record keeps the fields this plugin never modelled", marked)
        check(ReviewFormat.parse(marked)?.addressed == true, "and it reads back as archived")
        check(ReviewFormat.addressed(marked) == marked, "archiving twice changes nothing")
        check(ReviewFormat.addressed("""{"id":4,"text":"t","addressed":false}""").contains("\"addressed\":true"),
            "and an explicit false is turned over, not duplicated")

        // Editing has to obey the same rule, and it is the newer of the two: a record rebuilt from what
        // this plugin parses would come back without `re` and `group` and silently relocate a reply.
        val edited = ReviewFormat.retext(kakapo, "written again")
        check(edited.contains("\"re\":2") && edited.contains("\"group\":4"),
            "editing a kakapo record keeps the fields this plugin never modelled", edited)
        check(ReviewFormat.parse(edited)?.text == "written again", "and the new body is what reads back",
            ReviewFormat.parse(edited)?.text)
        check(ReviewFormat.parse(edited)?.anchor == "x", "with the fields after it unharmed",
            ReviewFormat.parse(edited)?.anchor)

        // The body is the one field whose value can look like the record around it, which is the whole
        // reason the editor walks escapes instead of matching a regular expression.
        val awkward = """{"id":5,"path":"a.ts","text":"quote \" then \\ then end","line":7}"""
        val replaced = ReviewFormat.retext(awkward, "plain")
        check(ReviewFormat.parse(replaced)?.text == "plain", "a body full of escapes is replaced whole", replaced)
        check(ReviewFormat.parse(replaced)?.line == 7, "and the field after it survives",
            ReviewFormat.parse(replaced)?.line)
        check(ReviewFormat.parse(ReviewFormat.retext(awkward, "a \"b\" c"))?.text == """a "b" c""",
            "and the new body is escaped on the way in")

        val empty = ReviewFormat.retext("""{"id":6,"text":"","line":2}""", "first words")
        check(ReviewFormat.parse(empty)?.text == "first words", "an empty body can be written into", empty)
        check(ReviewFormat.parse(empty)?.line == 2, "without eating the field beside it")
    }

    /**
     * 0.0.5 shipped one list, the archive, so a comment you had just written was in no list anywhere:
     * the only way to read it again was to hover the gutter icon of the one file it was in. A comment
     * is open or archived and nothing else, so the lists have to be that whole partition — asserted
     * here rather than remembered, because it was remembered and it was wrong.
     */
    private fun everyStateIsInSomeList() {
        val open = Comment(id = 1, path = "a.ts", line = 1, anchor = "x", text = "open one")
        val archived = open.copy(id = 2, text = "archived one", addressed = true)

        for (comment in listOf(open, archived)) {
            val holding = ReviewTabs.all.filter { it.holds(comment) }.map { it.title }
            check(holding.size == 1,
                "a comment that is addressed=${comment.addressed} is in exactly one list", holding)
        }

        // And the lists are not the same list under two names: the control is that each holds something.
        for (tab in ReviewTabs.all) {
            check(ReviewTabs.of(tab, listOf(open, archived)).size == 1,
                "the ${tab.title} list holds one of the two", ReviewTabs.of(tab, listOf(open, archived)).size)
            check(tab.empty.isNotBlank(), "and says what to do when it is empty", tab.title)
        }

        val newest = ReviewTabs.of(ReviewTabs.OPEN, listOf(open, open.copy(id = 3, text = "later one")))
        check(newest.first().text == "later one", "the newest comment is first, because it is the one being re-read",
            newest.first().text)
    }

    private fun idsComeFromTheHeader() {
        val header = listOf(
            "# kakapo review thread",
            "# NEXT FREE ID: 42. Ids are shared with the other kakapo thread file, so use this, not the highest id below.",
            """{"id":3,"text":"a"}""",
        )
        check(ReviewFormat.nextFreeId(header) == 42L, "the header's next free id wins over the highest id here",
            ReviewFormat.nextFreeId(header))
        val other = listOf("""{"id":99,"text":"b"}""")
        check(ReviewFormat.nextFreeId(header, other) == 100L,
            "and an id taken in the shared file is not minted again", ReviewFormat.nextFreeId(header, other))
        check(ReviewFormat.nextFreeId(listOf("""{"id":5,"text":"c"}""")) == 6L,
            "with no header, one past the highest seen")
    }

    private fun gitDirFollowsThePointer() {
        val root = Files.createTempDirectory("kakapo-gitdir-")
        try {
            val plain = root.resolve("plain")
            Files.createDirectories(plain.resolve(".git"))
            check(GitDir.of(plain) == plain.resolve(".git"), "a plain clone keeps .git as a directory")

            val worktree = root.resolve("linked")
            Files.createDirectories(worktree)
            val own = root.resolve("plain/.git/worktrees/linked")
            Files.createDirectories(own)
            Files.writeString(worktree.resolve(".git"), "gitdir: $own\n")
            check(GitDir.of(worktree) == own, "a linked worktree is followed through its pointer", GitDir.of(worktree))
            check(GitDir.commonOf(worktree) == plain.resolve(".git"),
                "and the file kakapo shares between worktrees is looked for in the common directory",
                GitDir.commonOf(worktree))

            val relative = root.resolve("relative")
            Files.createDirectories(relative)
            Files.writeString(relative.resolve(".git"), "gitdir: ../plain/.git/worktrees/linked\n")
            check(GitDir.of(relative) == own, "a relative pointer is resolved against the worktree", GitDir.of(relative))

            val nothing = root.resolve("nothing")
            Files.createDirectories(nothing)
            check(GitDir.of(nothing) == null, "and a directory with no .git has nowhere to write")
        } finally {
            Files.walk(root).sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) }
        }
    }

    /** Writes the records this plugin produces, so kakapo's own reader can be pointed at them. */
    private fun emit(out: Path) {
        val records = listOf(
            Comment(id = 1, path = "src/a.ts", line = 3, anchor = "const a = 1;", text = "Name this."),
            Comment(id = 2, path = "src/b.ts", line = 9, anchor = """  log("x");""", text = "Quote \"here\"\nand a second line.", view = "diff", side = "old"),
            Comment(id = 3, path = "src/c.ts", line = 1, anchor = "x", text = "Archived one.", addressed = true),
        )
        Files.createDirectories(out.parent)
        Files.writeString(out, records.joinToString("\n") { ReviewFormat.encode(it) } + "\n")
        println("wrote $out")
    }
}
