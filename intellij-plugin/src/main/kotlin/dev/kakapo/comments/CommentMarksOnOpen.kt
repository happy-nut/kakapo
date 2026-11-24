package dev.kakapo.comments

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.vfs.VirtualFile

/**
 * Without this, a review written in kakapo is invisible until the file is opened in the Diff window or
 * a comment is written here: CommentMarks.refresh had two callers and neither of them is "a file was
 * opened". The listing and both READMEs promise the opposite.
 */
class CommentMarksOnOpen : ProjectActivity {

    override suspend fun execute(project: Project) {
        val connection = project.messageBus.connect()
        connection.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun fileOpened(source: FileEditorManager, file: VirtualFile) {
                paint(project, source, file)
            }
        })
        val manager = FileEditorManager.getInstance(project)
        for (file in manager.openFiles) paint(project, manager, file)
    }

    private fun paint(project: Project, manager: FileEditorManager, file: VirtualFile) {
        val store = CommentStore(project)
        for (editor in editorsOf(manager, file)) CommentMarks.refresh(project, editor, file, store)
    }

    private fun editorsOf(manager: FileEditorManager, file: VirtualFile): List<Editor> =
        manager.getEditors(file).filterIsInstance<TextEditor>().map { it.editor }
}
