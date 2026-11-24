package dev.kakapo.comments

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
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
            com.intellij.openapi.util.TextRange(
                document.getLineStartOffset(lineIndex),
                document.getLineEndOffset(lineIndex),
            ),
        )

        val store = CommentStore(project)
        val path = store.relativePath(file) ?: return
        val label = "@$path#L${lineIndex + 1}"
        CommentBox.open(editor, lineIndex, label) { written ->
            store.append(
                Comment(
                    id = store.nextId(store.read()),
                    path = path,
                    line = lineIndex + 1,
                    anchor = anchor,
                    text = "$label $written",
                ),
            )
            CommentMarks.refresh(project, editor, file, store)
        }
    }
}
