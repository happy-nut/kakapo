package dev.kakapo.comments

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.VirtualFile

/**
 * The diff viewer's editors are not file editors: VIRTUAL_FILE is null there, which is why an action that
 * only read that key worked in the editor and did nothing in the Diff window. The document still knows
 * which file it holds, and in a diff both sides hold the same one.
 */
object CommentedEditor {
    fun fileOf(editor: Editor, fromDataContext: VirtualFile?): VirtualFile? =
        fromDataContext ?: FileDocumentManager.getInstance().getFile(editor.document)
}
