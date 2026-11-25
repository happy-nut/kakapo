package dev.kakapo.comments

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.icons.AllIcons
import javax.swing.Icon

object CommentMarks {
    private val PAINTED = Key.create<MutableList<RangeHighlighter>>("kakapo.comment.marks")

    fun refresh(project: Project, editor: Editor, file: VirtualFile, store: CommentStore) {
        val painted = editor.getUserData(PAINTED) ?: mutableListOf<RangeHighlighter>().also {
            editor.putUserData(PAINTED, it)
        }
        painted.forEach { editor.markupModel.removeHighlighter(it) }
        painted.clear()

        val path = store.relativePath(file) ?: return
        val document = editor.document
        for (comment in store.read().filter { it.path == path && !it.addressed }) {
            val lineIndex = anchoredLine(document.text, comment)
            if (lineIndex < 0 || lineIndex >= document.lineCount) continue
            val highlighter = editor.markupModel.addRangeHighlighter(
                document.getLineStartOffset(lineIndex),
                document.getLineEndOffset(lineIndex),
                HighlighterLayer.ADDITIONAL_SYNTAX,
                null,
                HighlighterTargetArea.EXACT_RANGE,
            )
            highlighter.gutterIconRenderer = object : GutterIconRenderer() {
                override fun getIcon(): Icon = AllIcons.General.Balloon
                override fun getTooltipText(): String = comment.text
                override fun equals(other: Any?): Boolean = other === this
                override fun hashCode(): Int = comment.id.hashCode()
            }
            painted.add(highlighter)
        }
    }

    /** Repaints every open editor, so archiving a comment takes its mark away at once. */
    fun refreshOpenEditors(project: Project) {
        val manager = com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project)
        val store = CommentStore(project)
        for (file in manager.openFiles) {
            for (editor in manager.getEditors(file).filterIsInstance<com.intellij.openapi.fileEditor.TextEditor>()) {
                refresh(project, editor.editor, file, store)
            }
        }
    }

    fun anchoredLine(text: String, comment: Comment): Int = Anchor.line(text, comment.line, comment.anchor)
}
