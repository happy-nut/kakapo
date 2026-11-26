package dev.kakapo.comments

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.Messages
import java.awt.datatransfer.StringSelection

class HandOffAction : AnAction() {

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val store = CommentStore(project)
        val comments = store.read().filter { !it.addressed }
        if (comments.isEmpty()) {
            Messages.showInfoMessage(project, "No comments to hand over.", "Kakapo")
            return
        }

        CopyPasteManager.getInstance().setContents(StringSelection(handOffText(comments)))

        // Copying without archiving means the next hand-off carries the same comments again, so the
        // reader cannot tell what is new. Archived is not deleted: the Archived list is where they go.
        val archived = store.markAddressed(comments.map { it.id }.toSet())
        CommentMarks.refreshOpenEditors(project)
        ReviewList.show(project, ReviewTabs.ARCHIVED)

        Messages.showInfoMessage(
            project,
            if (archived) {
                "${comments.size} comment(s) copied and archived.\nThe archive is in the Kakapo Review tool window."
            } else {
                "${comments.size} comment(s) copied, but the review file could not be rewritten, so they are still open."
            },
            "Kakapo",
        )
    }

    /**
     * The location comes from the record's own path and line, not from a prefix baked into the text:
     * 0.0.1 and 0.0.2 wrote it into the body, so a comment carried its location only as long as nobody
     * edited the body. Those bodies still exist, so a body that already opens with its own location is
     * not given a second one.
     */
    fun handOffText(comments: List<Comment>): String =
        comments.joinToString("\n\n") { comment ->
            val body = comment.text.trim()
            if (body.startsWith(comment.where())) body else "${comment.where()}\n$body"
        }
}
