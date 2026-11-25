package dev.kakapo.comments

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption

data class Comment(
    val id: Long,
    val path: String,
    val line: Int,
    val anchor: String,
    val text: String,
    val kind: String = "c",
    val by: String = "me",
    val addressed: Boolean = false,
) {
    companion object {
        /** The one spelling of "which line this is about". The box shows it and the hand-off writes it. */
        fun where(path: String, line: Int): String = "@$path#L$line"
    }

    fun where(): String = where(path, line)
}

class CommentStore(private val project: Project) {

    /**
     * In a linked worktree and in a submodule, `.git` is a file holding `gitdir: <path>`, not a
     * directory. Treating it as a directory is how a comment written there went nowhere: `file()`
     * returned null and `append` dropped it without a word. kakapo itself asks git
     * (`rev-parse --absolute-git-dir`); this reads the same answer without spawning a process.
     */
    fun gitDir(): Path? {
        val base = project.basePath ?: return null
        val dot = Path.of(base, ".git")
        if (Files.isDirectory(dot)) return dot
        if (!Files.isRegularFile(dot)) return null
        val pointer = Files.readAllLines(dot).firstOrNull { it.startsWith("gitdir:") } ?: return null
        val target = Path.of(pointer.removePrefix("gitdir:").trim())
        return (if (target.isAbsolute) target else Path.of(base).resolve(target)).normalize()
    }

    fun file(): Path? = gitDir()?.resolve("kakapo")?.resolve("comments.jsonl")

    fun read(): List<Comment> {
        val path = file() ?: return emptyList()
        if (!Files.exists(path)) return emptyList()
        return Files.readAllLines(path).mapNotNull(::parse)
    }

    /** Answers whether the comment reached the file, because losing one in silence is how they vanish. */
    fun append(comment: Comment): Boolean {
        val path = file() ?: return false
        return try {
            Files.createDirectories(path.parent)
            Files.writeString(path, encode(comment) + "\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND)
            true
        } catch (failed: java.io.IOException) {
            false
        }
    }

    fun relativePath(file: VirtualFile): String? {
        val base = project.basePath ?: return null
        val root = com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(base) ?: return null
        return VfsUtilCore.getRelativePath(file, root, '/')
    }

    fun nextId(existing: List<Comment>): Long = (existing.maxOfOrNull { it.id } ?: 0L) + 1L

    private fun encode(comment: Comment): String = buildString {
        append('{')
        append("\"id\":").append(comment.id)
        append(",\"path\":").append(quote(comment.path))
        append(",\"line\":").append(comment.line)
        append(",\"anchor\":").append(quote(comment.anchor))
        append(",\"kind\":").append(quote(comment.kind))
        append(",\"by\":").append(quote(comment.by))
        append(",\"view\":\"source\"")
        append(",\"text\":").append(quote(comment.text))
        append('}')
    }

    private fun parse(line: String): Comment? {
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
            addressed = trimmed.contains("\"addressed\":true"),
        )
    }

    private fun quote(value: String): String = buildString {
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

    private fun string(line: String, key: String): String? {
        val at = line.indexOf("\"$key\":\"")
        if (at < 0) return null
        val start = at + key.length + 4
        val out = StringBuilder()
        var index = start
        while (index < line.length) {
            val char = line[index]
            if (char == '\\' && index + 1 < line.length) {
                when (val escaped = line[index + 1]) {
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        out.append(line.substring(index + 2, index + 6).toInt(16).toChar())
                        index += 4
                    }
                    else -> out.append(escaped)
                }
                index += 2
                continue
            }
            if (char == '"') return out.toString()
            out.append(char)
            index += 1
        }
        return null
    }

    private fun number(line: String, key: String): Long? {
        val match = Regex("\"$key\":(-?\\d+)").find(line) ?: return null
        return match.groupValues[1].toLongOrNull()
    }
}
