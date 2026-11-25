package dev.kakapo.comments

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.vfs.VirtualFile

class AddCommentAction : AnAction() {

    override fun update(event: AnActionEvent) {
        val editor = event.getData(CommonDataKeys.EDITOR)
        val file = editor?.let { CommentedEditor.fileOf(it, event.getData(CommonDataKeys.VIRTUAL_FILE)) }
        event.presentation.isEnabled = editor != null && file != null && event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val editor = event.getData(CommonDataKeys.EDITOR) ?: return
        val file: VirtualFile = CommentedEditor.fileOf(editor, event.getData(CommonDataKeys.VIRTUAL_FILE)) ?: return

        val document = editor.document
        val lineIndex = document.getLineNumber(editor.caretModel.offset)
        val anchor = document.getText(
            TextRange(document.getLineStartOffset(lineIndex), document.getLineEndOffset(lineIndex)),
        )

        val store = CommentStore(project)
        val path = store.relativePath(file) ?: return
        val where = Comment.where(path, lineIndex + 1)

        // Refuse before the box rather than after it: a comment typed into a box that cannot save is a
        // comment the writer watches disappear.
        if (store.file() == null) {
            Messages.showErrorDialog(
                project,
                "kakapo keeps the review inside the repository's own .git directory, and this project has none that can be read. Nothing was written.",
                "Kakapo",
            )
            return
        }

        CommentBox.open(editor, lineIndex, where, anchor) { written ->
            val stored = store.append(
                Comment(
                    id = store.nextId(),
                    path = path,
                    line = lineIndex + 1,
                    anchor = anchor,
                    text = written,
                    view = CommentedEditor.viewOf(editor),
                    side = CommentedEditor.sideOf(editor),
                ),
            )
            if (stored) {
                CommentMarks.refresh(project, editor, file, store)
            } else {
                Messages.showErrorDialog(project, "The comment could not be written to ${store.file()}:\n\n$written", "Kakapo")
            }
        }
    }
}
