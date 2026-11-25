package dev.kakapo.comments

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile

/**
 * The diff viewer's editors are not file editors: VIRTUAL_FILE is null there, which is why an action
 * that only read that key worked in the editor and did nothing in the Diff window. The document still
 * knows which file it holds, and in a diff both sides hold the same one.
 *
 * Which side an editor is also lives with the viewer and not with the editor — `getEditor(Side)` is
 * the viewer's method — so the extension that walks the viewer stamps it here. kakapo reopens a
 * comment in the view it names, and a comment written on the left is about the base revision, whose
 * line numbers the working file does not share.
 */
object CommentedEditor {

    val VIEW = Key.create<String>("kakapo.review.view")
    val SIDE = Key.create<String>("kakapo.review.side")

    fun fileOf(editor: Editor, fromDataContext: VirtualFile?): VirtualFile? =
        fromDataContext ?: FileDocumentManager.getInstance().getFile(editor.document)

    fun viewOf(editor: Editor): String = editor.getUserData(VIEW) ?: "source"

    fun sideOf(editor: Editor): String? = editor.getUserData(SIDE)

    fun markDiff(editor: Editor, side: String?) {
        editor.putUserData(VIEW, "diff")
        editor.putUserData(SIDE, side)
    }
}
