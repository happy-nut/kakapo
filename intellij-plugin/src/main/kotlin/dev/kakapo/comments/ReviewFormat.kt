package dev.kakapo.comments

/**
 * The review file's format, with no IDE in it, so it can be run and checked without a sandbox — the
 * same reason Anchor.kt is plain Kotlin.
 *
 * Two rules decide everything here:
 *
 * kakapo's records carry fields this plugin does not model — `re`, `group`, `title`, `role`, `from`,
 * `to`. Rewriting a line from a parsed object would drop them, so a line is never rebuilt: it is kept
 * as the bytes it arrived as, and a change is made to those bytes.
 *
 * Ids are shared with the review's other file, and the header says so in as many words. Minting one
 * from the highest id in this file alone is how two records end up with the same id and a reply lands
 * on the wrong comment.
 */
object ReviewFormat {

    /** A line as it arrived, beside what this plugin understands of it. */
    data class Line(val raw: String, val comment: Comment?)

    fun read(lines: List<String>): List<Line> = lines.map { Line(it, parse(it)) }

    fun comments(lines: List<String>): List<Comment> = read(lines).mapNotNull { it.comment }

    /**
     * The next id nobody has taken: the header's own answer when it has one, and otherwise one past
     * everything seen in every file given.
     */
    fun nextFreeId(vararg files: List<String>): Long {
        var fromHeader = 0L
        var highest = 0L
        for (lines in files) {
            for (line in lines) {
                val trimmed = line.trim()
                if (trimmed.startsWith("#")) {
                    val stated = Regex("NEXT FREE ID:\\s*(\\d+)").find(trimmed)?.groupValues?.get(1)?.toLongOrNull()
                    if (stated != null && stated > fromHeader) fromHeader = stated
                    continue
                }
                val id = number(trimmed, "id") ?: continue
                if (id > highest) highest = id
            }
        }
        return maxOf(fromHeader, highest + 1)
    }

    /** Marks a line addressed without rebuilding it, so fields this plugin never modelled survive. */
    fun addressed(raw: String): String {
        val trimmed = raw.trimEnd()
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return raw
        if (Regex("\"addressed\":\\s*true").containsMatchIn(trimmed)) return raw
        val already = Regex("\"addressed\":\\s*false")
        if (already.containsMatchIn(trimmed)) return already.replace(trimmed, "\"addressed\":true")
        return trimmed.dropLast(1) + ",\"addressed\":true}"
    }

    /**
     * Rewrites one comment's body in the line it already is, for the same reason archiving does: a
     * comment written in kakapo carries `re`, `group`, `title` and `role`, and an edit that rebuilt
     * the line from what this plugin understands would drop every one of them.
     */
    fun retext(raw: String, text: String): String {
        val trimmed = raw.trimEnd()
        val span = span(trimmed, "text") ?: return raw
        return trimmed.substring(0, span.first) + quote(text).drop(1).dropLast(1) + trimmed.substring(span.last + 1)
    }

    fun encode(comment: Comment): String = buildString {
        append('{')
        append("\"id\":").append(comment.id)
        append(",\"path\":").append(quote(comment.path))
        append(",\"line\":").append(comment.line)
        append(",\"anchor\":").append(quote(comment.anchor))
        append(",\"kind\":").append(quote(comment.kind))
        append(",\"by\":").append(quote(comment.by))
        append(",\"view\":").append(quote(comment.view))
        if (comment.side != null) append(",\"side\":").append(quote(comment.side))
        append(",\"text\":").append(quote(comment.text))
        if (comment.addressed) append(",\"addressed\":true")
        append('}')
    }

    fun parse(line: String): Comment? {
        val trimmed = line.trim()
        if (!trimmed.startsWith("{")) return null
        val id = number(trimmed, "id") ?: return null
        val text = string(trimmed, "text") ?: return null
        return Comment(
            id = id,
            path = string(trimmed, "path") ?: "",
            line = number(trimmed, "line")?.toInt() ?: 0,
            anchor = string(trimmed, "anchor") ?: "",
            text = text,
            kind = string(trimmed, "kind") ?: "c",
            by = string(trimmed, "by") ?: "me",
            view = string(trimmed, "view") ?: "source",
            side = string(trimmed, "side"),
            re = number(trimmed, "re"),
            addressed = Regex("\"addressed\":\\s*true").containsMatchIn(trimmed),
        )
    }

    fun quote(value: String): String = buildString {
        append('"')
        for (char in value) when (char) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (char < ' ') append("\\u%04x".format(char.code)) else append(char)
        }
        append('"')
    }

    /**
     * The span of a string value's own characters, escapes and all. One walker answers both reading a
     * field and replacing it, because a second walker is a second chance to disagree about an escape.
     */
    private fun span(line: String, key: String): IntRange? {
        val at = line.indexOf("\"$key\":\"")
        if (at < 0) return null
        val from = at + key.length + 4
        var index = from
        while (index < line.length) {
            val char = line[index]
            if (char == '\\' && index + 1 < line.length) {
                index += if (line[index + 1] == 'u') 6 else 2
                continue
            }
            if (char == '"') return from until index
            index += 1
        }
        return null
    }

    fun string(line: String, key: String): String? {
        val span = span(line, key) ?: return null
        val raw = line.substring(span.first, span.last + 1)
        val out = StringBuilder()
        var index = 0
        while (index < raw.length) {
            val char = raw[index]
            if (char == '\\' && index + 1 < raw.length) {
                when (val escaped = raw[index + 1]) {
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        out.append(raw.substring(index + 2, index + 6).toInt(16).toChar())
                        index += 4
                    }
                    else -> out.append(escaped)
                }
                index += 2
                continue
            }
            out.append(char)
            index += 1
        }
        return out.toString()
    }

    fun number(line: String, key: String): Long? =
        Regex("\"$key\":(-?\\d+)").find(line)?.groupValues?.get(1)?.toLongOrNull()
}
