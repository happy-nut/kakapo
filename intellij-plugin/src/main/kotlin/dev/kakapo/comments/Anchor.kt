package dev.kakapo.comments

object Anchor {
    fun line(text: String, storedLine: Int, anchor: String): Int {
        val lines = text.split("\n")
        val wanted = anchor.trim()
        val from = (storedLine - 1).coerceIn(0, maxOf(lines.size - 1, 0))
        if (wanted.isEmpty()) return from
        if (lines.getOrNull(from)?.trim() == wanted) return from
        var distance = 1
        while (from - distance >= 0 || from + distance < lines.size) {
            if (lines.getOrNull(from - distance)?.trim() == wanted) return from - distance
            if (lines.getOrNull(from + distance)?.trim() == wanted) return from + distance
            distance += 1
        }
        return from
    }
}

object AnchorCheck {
    private var failures = 0

    private fun check(ok: Boolean, what: String, detail: String = "") {
        println((if (ok) "ok   " else "FAIL ") + what + (if (detail.isEmpty()) "" else " — $detail"))
        if (!ok) failures += 1
    }

    @JvmStatic
    fun main(args: Array<String>) {
        val file = listOf(
            "class Config {",
            "    fun job(): Job {",
            "        return builder.incrementer(RunIdIncrementer())",
            "    }",
            "}",
        ).joinToString("\n")
        val anchor = "        return builder.incrementer(RunIdIncrementer())"

        check(Anchor.line(file, 3, anchor) == 2, "control: an untouched line is found where it was written")

        val pushed = "import org.springframework.batch.core.Job\n\n" + file
        check(Anchor.line(pushed, 3, anchor) == 4,
            "a line an agent pushed down is followed by its text", Anchor.line(pushed, 3, anchor).toString())

        val gone = file.replace("builder.incrementer(RunIdIncrementer())", "builder.build()")
        check(Anchor.line(gone, 3, anchor) == 2,
            "a line whose text is gone stays put instead of jumping", Anchor.line(gone, 3, anchor).toString())

        val twice = file + "\n" + anchor
        check(Anchor.line(twice, 3, anchor) == 2,
            "the nearest copy wins when the text appears twice", Anchor.line(twice, 3, anchor).toString())

        check(Anchor.line(file, 99, anchor) == 2,
            "a stored line past the end still finds its text", Anchor.line(file, 99, anchor).toString())

        println(if (failures == 0) "\nall checks passed" else "\n$failures check(s) failed")
        if (failures != 0) kotlin.system.exitProcess(1)
    }
}
