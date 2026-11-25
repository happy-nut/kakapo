package dev.kakapo.comments

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.impl.EditorEmbeddedComponentManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.event.KeyEvent
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.KeyStroke

object CommentBox {

    fun open(editor: Editor, lineIndex: Int, label: String, onSave: (String) -> Unit) {
        if (editor !is EditorEx) return
        val area = JBTextArea(2, 60).apply {
            lineWrap = true
            wrapStyleWord = true
            emptyText.text = "⌘⏎ to keep it, Esc to drop it"
        }
        // The location used to live in emptyText, which the first keystroke wipes — so the one thing the
        // writer needs to see while writing was the one thing that disappeared as they wrote.
        val where = JBLabel(label).apply {
            border = JBUI.Borders.emptyBottom(4)
            foreground = UIUtil.getContextHelpForeground()
        }
        val panel = JPanel(BorderLayout()).apply {
            border = JBUI.Borders.empty(6, 8)
            add(where, BorderLayout.NORTH)
            add(JBScrollPane(area), BorderLayout.CENTER)
        }
        val save = JButton("Comment")
        panel.add(save, BorderLayout.EAST)

        val offset = editor.document.getLineEndOffset(lineIndex.coerceIn(0, editor.document.lineCount - 1))
        val inlay: Inlay<*>? = EditorEmbeddedComponentManager.getInstance().addComponent(
            editor,
            panel,
            EditorEmbeddedComponentManager.Properties(
                EditorEmbeddedComponentManager.ResizePolicy.none(),
                null,
                true,
                false,
                0,
                offset,
            ),
        )

        fun close() {
            inlay?.dispose()
            editor.contentComponent.requestFocusInWindow()
        }
        fun keep() {
            val text = area.text.trim()
            close()
            if (text.isNotEmpty()) onSave(text)
        }

        save.addActionListener { keep() }
        area.registerKeyboardAction(
            { keep() },
            KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, java.awt.event.InputEvent.META_DOWN_MASK),
            JPanel.WHEN_FOCUSED,
        )
        area.registerKeyboardAction(
            { close() },
            KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0),
            JPanel.WHEN_FOCUSED,
        )
        area.requestFocusInWindow()
    }
}
