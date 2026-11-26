package dev.kakapo.comments

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
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
        open(project, editor, file, editor.document.getLineNumber(editor.caretModel.offset))
    }

    companion object {

        /**
         * The one way the card is opened, by the chord and by the gutter mark alike. Two ways in is how
         * writing a comment and re-reading one drift apart, and re-reading one is what had no way in
         * at all.
         */
        fun open(project: Project, editor: Editor, file: VirtualFile, lineIndex: Int) {
            val document = editor.document
            val line = lineIndex.coerceIn(0, maxOf(document.lineCount - 1, 0))
            val anchor = document.getText(
                TextRange(document.getLineStartOffset(line), document.getLineEndOffset(line)),
            )

            val store = CommentStore(project)
            val path = store.relativePath(file) ?: return
            val where = Comment.where(path, line + 1)

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

            fun done(ok: Boolean, failure: String, body: String) {
                if (ok) {
                    CommentMarks.refresh(project, editor, file, CommentStore(project))
                    ReviewList.refresh(project)
                } else {
                    Messages.showErrorDialog(project, "$failure ${store.file()}:\n\n$body", "Kakapo")
                }
            }

            CommentBox.open(
                editor,
                line,
                where,
                anchor,
                store.at(path, document.text, line),
                CommentBox.Hooks(
                    write = { written ->
                        val stored = store.append(
                            Comment(
                                id = store.nextId(),
                                path = path,
                                line = line + 1,
                                anchor = anchor,
                                text = written,
                                view = CommentedEditor.viewOf(editor),
                                side = CommentedEditor.sideOf(editor),
                            ),
                        )
                        done(stored, "The comment could not be written to", written)
                    },
                    edit = { comment, written ->
                        done(store.replaceText(comment.id, written), "The edit could not be written to", written)
                    },
                    delete = { comment ->
                        done(store.remove(setOf(comment.id)), "The comment could not be removed from", comment.text)
                    },
                ),
            )
        }
    }
}
