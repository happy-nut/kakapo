package dev.kakapo.comments

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.Messages
import java.awt.datatransfer.StringSelection

class HandOffAction : AnAction() {

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val comments = CommentStore(project).read().filter { !it.addressed }
        if (comments.isEmpty()) {
            Messages.showInfoMessage(project, "No comments to hand over.", "Kakapo")
            return
        }
        CopyPasteManager.getInstance().setContents(StringSelection(handOffText(comments)))
        Messages.showInfoMessage(project, "${comments.size} comment(s) copied.", "Kakapo")
    }

    fun handOffText(comments: List<Comment>): String =
        comments.joinToString("\n\n") { it.text }
}
