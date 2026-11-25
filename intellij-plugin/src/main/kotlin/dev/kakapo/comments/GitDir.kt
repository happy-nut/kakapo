package dev.kakapo.comments

import java.nio.file.Files
import java.nio.file.Path

/**
 * Where a repository keeps its own data. Plain Kotlin on purpose: a linked worktree and a submodule
 * keep `.git` as a file, and this is the rule that decides whether a comment has anywhere to go, so it
 * is checked without an IDE.
 */
object GitDir {

    fun of(base: Path): Path? {
        val dot = base.resolve(".git")
        if (Files.isDirectory(dot)) return dot
        if (!Files.isRegularFile(dot)) return null
        val pointer = Files.readAllLines(dot).firstOrNull { it.startsWith("gitdir:") } ?: return null
        val target = Path.of(pointer.removePrefix("gitdir:").trim())
        return (if (target.isAbsolute) target else base.resolve(target)).normalize()
    }

    fun reviewFile(base: Path): Path? = of(base)?.resolve("kakapo")?.resolve("comments.jsonl")

    /**
     * A linked worktree's own git directory is `<common>/worktrees/<name>`, and kakapo keeps the file
     * it shares between worktrees in `<common>` — `git rev-parse --git-common-dir`. Reading the review
     * out of the worktree's directory while the shared ids live in the common one is how two records
     * end up with the same id.
     */
    fun commonOf(base: Path): Path? {
        val own = of(base) ?: return null
        val parent = own.parent ?: return own
        return if (parent.fileName?.toString() == "worktrees") parent.parent ?: own else own
    }

    /** The file kakapo shares between worktrees. Ids are shared with it, so the plugin has to see it. */
    fun knowledgeFile(base: Path): Path? = commonOf(base)?.resolve("kakapo")?.resolve("knowledge.jsonl")
}
