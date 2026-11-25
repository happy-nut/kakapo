package dev.kakapo.comments

import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import java.io.IOException
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
    /** "source" or "diff" — kakapo reopens the comment in the view it was written in. */
    val view: String = "source",
    /** "old" or "new" for a comment written on one side of a diff; null outside one. */
    val side: String? = null,
    val re: Long? = null,
    val addressed: Boolean = false,
) {
    companion object {
        /** The one spelling of "which line this is about". The box shows it and the hand-off writes it. */
        fun where(path: String, line: Int): String = "@$path#L$line"
    }

    fun where(): String = where(path, line)
}

class CommentStore(private val project: Project) {

    private fun base(): Path? = project.basePath?.let { Path.of(it) }

    fun gitDir(): Path? = base()?.let { GitDir.of(it) }

    fun file(): Path? = base()?.let { GitDir.reviewFile(it) }

    private fun knowledge(): Path? = base()?.let { GitDir.knowledgeFile(it) }

    private fun linesOf(path: Path?): List<String> =
        if (path != null && Files.exists(path)) Files.readAllLines(path) else emptyList()

    fun read(): List<Comment> = ReviewFormat.comments(linesOf(file()))

    /** Answers whether the comment reached the file, because losing one in silence is how they vanish. */
    fun append(comment: Comment): Boolean {
        val path = file() ?: return false
        return try {
            Files.createDirectories(path.parent)
            Files.writeString(path, ReviewFormat.encode(comment) + "\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND)
            true
        } catch (failed: IOException) {
            false
        }
    }

    /**
     * Marks comments addressed in place. Every other line is written back as the bytes it arrived as:
     * kakapo's records carry fields this plugin does not model, and rebuilding a line from a parsed
     * object would quietly drop them.
     */
    fun markAddressed(ids: Set<Long>): Boolean {
        val path = file() ?: return false
        if (ids.isEmpty()) return true
        return try {
            val rewritten = linesOf(path).map { raw ->
                val id = ReviewFormat.parse(raw)?.id
                if (id != null && id in ids) ReviewFormat.addressed(raw) else raw
            }
            Files.writeString(path, rewritten.joinToString("\n") + "\n")
            true
        } catch (failed: IOException) {
            false
        }
    }

    fun relativePath(file: VirtualFile): String? {
        val base = project.basePath ?: return null
        val root = LocalFileSystem.getInstance().findFileByPath(base) ?: return null
        return VfsUtilCore.getRelativePath(file, root, '/')
    }

    /** Ids are shared with the review's other file, and its header says which one is free. */
    fun nextId(): Long = ReviewFormat.nextFreeId(linesOf(file()), linesOf(knowledge()))
}
