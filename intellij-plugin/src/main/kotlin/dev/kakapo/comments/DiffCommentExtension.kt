package dev.kakapo.comments

import com.intellij.diff.DiffContext
import com.intellij.diff.DiffExtension
import com.intellij.diff.FrameDiffTool
import com.intellij.diff.requests.DiffRequest
import com.intellij.diff.tools.fragmented.UnifiedDiffViewer
import com.intellij.diff.tools.util.base.DiffViewerBase
import com.intellij.diff.tools.util.base.DiffViewerListener
import com.intellij.diff.tools.util.side.TwosideTextDiffViewer
import com.intellij.diff.util.Side
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project

class DiffCommentExtension : DiffExtension() {

    override fun onViewerCreated(viewer: FrameDiffTool.DiffViewer, context: DiffContext, request: DiffRequest) {
        val project = context.project ?: return
        if (viewer !is DiffViewerBase) return
        stampSides(viewer)
        viewer.addListener(object : DiffViewerListener() {
            override fun onInit() = paint(viewer, project)
            override fun onAfterRediff() = paint(viewer, project)
        })
    }

    /**
     * Only the viewer knows which editor is which side, so it is written onto the editors here. Without
     * it a comment written in the Diff window was recorded as a source comment, and one written on the
     * left carried a line number the working file does not have.
     */
    private fun stampSides(viewer: DiffViewerBase) {
        when (viewer) {
            is TwosideTextDiffViewer -> {
                CommentedEditor.markDiff(viewer.getEditor(Side.LEFT), "old")
                CommentedEditor.markDiff(viewer.getEditor(Side.RIGHT), "new")
            }
            // A unified view holds both sides in one editor, so the side is the one thing it cannot say.
            is UnifiedDiffViewer -> CommentedEditor.markDiff(viewer.editor, null)
            else -> Unit
        }
    }

    private fun paint(viewer: DiffViewerBase, project: Project) {
        val store = CommentStore(project)
        for (editor in editorsOf(viewer)) {
            val file = FileDocumentManager.getInstance().getFile(editor.document) ?: continue
            CommentMarks.refresh(project, editor, file, store)
        }
    }

    private fun editorsOf(viewer: DiffViewerBase): List<Editor> = when (viewer) {
        is TwosideTextDiffViewer -> viewer.editors
        is UnifiedDiffViewer -> listOf(viewer.editor)
        else -> emptyList()
    }
}
