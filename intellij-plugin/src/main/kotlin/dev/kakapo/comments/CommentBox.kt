package dev.kakapo.comments

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorColors
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.impl.EditorEmbeddedComponentManager
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Font
import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.KeyStroke
import javax.swing.ScrollPaneConstants
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

object CommentBox {

    fun open(editor: Editor, lineIndex: Int, label: String, anchor: String, onSave: (String) -> Unit) {
        if (editor !is EditorEx) return

        val area = JBTextArea(2, 60).apply {
            lineWrap = true
            wrapStyleWord = true
            border = JBUI.Borders.empty(6, 8)
            emptyText.text = "What should change here?"
        }

        // The location used to live in emptyText, which the first keystroke wipes — so the one thing the
        // writer needs to see while writing was the one thing that disappeared as they wrote. The line
        // itself is shown under it, because a comment detached from its anchor is a guess.
        val where = JBLabel(label).apply {
            foreground = UIUtil.getContextHelpForeground()
            font = font.deriveFont(Font.BOLD, font.size2D - 1f)
        }
        val quoted = JBLabel(anchor.trim().take(80)).apply {
            foreground = UIUtil.getInactiveTextColor()
            font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
                .deriveFont(editor.colorsScheme.editorFontSize2D - 1f)
            border = JBUI.Borders.emptyTop(2)
        }
        val heading = JPanel().apply {
            isOpaque = false
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(where)
            if (anchor.isNotBlank()) add(quoted)
            border = JBUI.Borders.emptyBottom(6)
        }

        val hint = JBLabel("⌘⏎ keep   ·   Esc discard").apply {
            foreground = UIUtil.getInactiveTextColor()
            font = font.deriveFont(font.size2D - 1f)
        }
        // The primary action looks like one, and it is off until there is something to keep: pressing
        // it on an empty box used to close the box and write nothing, which reads as a lost comment.
        val save = JButton("Comment").apply {
            putClientProperty("JButton.buttonType", "default")
            isEnabled = false
        }
        area.document.addDocumentListener(object : DocumentListener {
            private fun sync() { save.isEnabled = area.text.isNotBlank() }
            override fun insertUpdate(event: DocumentEvent) = sync()
            override fun removeUpdate(event: DocumentEvent) = sync()
            override fun changedUpdate(event: DocumentEvent) = sync()
        })
        val footer = JPanel().apply {
            isOpaque = false
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            border = JBUI.Borders.emptyTop(6)
            add(hint)
            add(Box.createHorizontalGlue())
            add(save)
        }

        val panel = JPanel(BorderLayout()).apply {
            isOpaque = true
            background = editor.colorsScheme.getColor(EditorColors.NOTIFICATION_BACKGROUND)
                ?: UIUtil.getPanelBackground()
            border = BorderFactory.createCompoundBorder(
                JBUI.Borders.customLine(UIUtil.getBoundsColor(), 1),
                JBUI.Borders.empty(8, 10),
            )
            add(heading, BorderLayout.NORTH)
            add(
                JBScrollPane(area).apply {
                    border = JBUI.Borders.customLine(UIUtil.getBoundsColor(), 1)
                    horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
                },
                BorderLayout.CENTER,
            )
            add(footer, BorderLayout.SOUTH)
        }

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
            KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, InputEvent.META_DOWN_MASK),
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
