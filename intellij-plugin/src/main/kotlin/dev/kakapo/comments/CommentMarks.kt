package dev.kakapo.comments

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
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

        // One mark per line and not one per comment: two comments on a line used to put two renderers
        // on the same gutter row, where the second one is simply not seen.
        val byLine = store.read()
            .filter { it.path == path && !it.addressed }
            .groupBy { anchoredLine(document.text, it) }
            .filterKeys { it in 0 until document.lineCount }

        for ((lineIndex, comments) in byLine) {
            val highlighter = editor.markupModel.addRangeHighlighter(
                document.getLineStartOffset(lineIndex),
                document.getLineEndOffset(lineIndex),
                HighlighterLayer.ADDITIONAL_SYNTAX,
                null,
                HighlighterTargetArea.EXACT_RANGE,
            )
            highlighter.gutterIconRenderer = Mark(project, editor, file, lineIndex, comments)
            painted.add(highlighter)
        }
    }

    /**
     * The mark is the way back to a comment. It carried only a tooltip until 0.0.6, so a comment could
     * be read by hovering the gutter of the one file it was in, and by nothing else — the tool window
     * held the archive and no list held the open ones. Clicking it opens the same card the chord does.
     */
    private class Mark(
        private val project: Project,
        private val editor: Editor,
        private val file: VirtualFile,
        private val lineIndex: Int,
        private val comments: List<Comment>,
    ) : GutterIconRenderer() {

        override fun getIcon(): Icon = AllIcons.General.Balloon

        override fun getTooltipText(): String =
            comments.joinToString("\n\n") { it.text } + "\n\nClick to read, edit or remove."

        override fun isNavigateAction(): Boolean = true

        override fun getClickAction(): AnAction = object : AnAction() {
            override fun actionPerformed(event: AnActionEvent) =
                AddCommentAction.open(project, editor, file, lineIndex)
        }

        override fun equals(other: Any?): Boolean = other === this
        override fun hashCode(): Int = comments.first().id.hashCode()
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
