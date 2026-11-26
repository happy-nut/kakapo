package dev.kakapo.comments

import com.intellij.icons.AllIcons
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.colors.EditorFontType
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.impl.EditorEmbeddedComponentManager
import com.intellij.ui.JBColor
import com.intellij.ui.RoundedLineBorder
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.panels.VerticalLayout
import com.intellij.util.ui.GraphicsUtil
import com.intellij.util.ui.JBFont
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import java.awt.geom.RoundRectangle2D
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.KeyStroke
import javax.swing.ScrollPaneConstants
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/**
 * The card for the comments on one line, not a form for a new one.
 *
 * It used to be write-only, and the only way to read a comment again was to hover its gutter icon in
 * the one file it was in: the tool window held the archive and nothing held the open ones. So the card
 * shows what is already on the line, and the gutter mark opens it — one surface for writing, re-reading,
 * editing and removing, instead of a surface for writing and no surface for anything else.
 */
object CommentBox {

    /** What the card may do to the review. The card holds no store, so it cannot half-write one. */
    class Hooks(
        val write: (String) -> Unit,
        val edit: (Comment, String) -> Unit,
        val delete: (Comment) -> Unit,
    )

    private val BORDER = JBColor.namedColor("Component.borderColor", UIUtil.getBoundsColor())
    private val ACCENT = JBColor.namedColor("Link.activeForeground", JBColor(Color(0x3574F0), Color(0x548AF7)))

    fun open(
        editor: Editor,
        lineIndex: Int,
        label: String,
        anchor: String,
        existing: List<Comment>,
        hooks: Hooks,
    ) {
        if (editor !is EditorEx) return

        val width = contentWidth(editor)

        // The location used to live in emptyText, which the first keystroke wipes — so the one thing the
        // writer needs to see while writing was the one thing that disappeared as they wrote. The line
        // itself is shown under it, because a comment detached from its anchor is a guess.
        val where = JBLabel(label).apply {
            icon = AllIcons.General.Balloon
            foreground = UIUtil.getLabelInfoForeground()
            font = JBFont.small().asBold()
            iconTextGap = JBUI.scale(5)
        }

        val field = JBTextArea().apply {
            lineWrap = true
            wrapStyleWord = true
            border = JBUI.Borders.empty(5, 7)
            font = JBFont.medium()
            emptyText.text = if (existing.isEmpty()) "What should change here?" else "Add another comment on this line"
        }

        val save = JButton(if (existing.isEmpty()) "Comment" else "Add").apply {
            putClientProperty("JButton.buttonType", "default")
            isEnabled = false
        }

        val body = JPanel(VerticalLayout(JBUI.scale(7))).apply { isOpaque = false }
        val card = card()

        // The inlay is given a finished card. An empty one is measured as empty, and the card renders
        // as a strip with the comment inside it clipped away.
        var inlay: Inlay<*>? = null

        fun close() {
            inlay?.dispose()
            editor.contentComponent.requestFocusInWindow()
        }

        // Every change closes the card: the caller repaints the gutter, and clicking the mark again
        // shows the review as it now is. A card that stayed open would be showing the review as it was.
        var editing: Comment? = null
        fun keep() {
            val text = field.text.trim()
            if (text.isEmpty()) return
            val target = editing
            close()
            if (target == null) hooks.write(text) else hooks.edit(target, text)
        }

        fun startEditing(comment: Comment) {
            editing = comment
            field.text = comment.text
            save.text = "Save"
            field.requestFocusInWindow()
            field.caretPosition = field.document.length
        }

        body.add(where)
        if (anchor.isNotBlank()) body.add(quotedLine(editor, anchor, width))
        for (comment in existing) {
            body.add(
                row(
                    comment,
                    width,
                    onEdit = { startEditing(comment) },
                    onDelete = { close(); hooks.delete(comment) },
                ),
            )
        }
        body.add(fieldOf(field, width, existing.isNotEmpty()))
        body.add(footer(save))
        card.add(body, BorderLayout.CENTER)
        card.preferredSize = Dimension(width + card.insets.left + card.insets.right, card.preferredSize.height)
        inlay = embed(editor, card, lineIndex)

        field.document.addDocumentListener(object : DocumentListener {
            // The primary action is off until there is something to keep: pressing it on an empty box
            // used to close the box and write nothing, which reads as a lost comment.
            private fun sync() { save.isEnabled = field.text.isNotBlank() }
            override fun insertUpdate(event: DocumentEvent) = sync()
            override fun removeUpdate(event: DocumentEvent) = sync()
            override fun changedUpdate(event: DocumentEvent) = sync()
        })
        save.addActionListener { keep() }
        field.registerKeyboardAction(
            { keep() },
            KeyStroke.getKeyStroke(KeyEvent.VK_ENTER, InputEvent.META_DOWN_MASK),
            JComponent.WHEN_FOCUSED,
        )
        // On the card and not on the field, or Esc stops closing it the moment focus is on a link.
        card.registerKeyboardAction(
            { close() },
            KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0),
            JComponent.WHEN_ANCESTOR_OF_FOCUSED_COMPONENT,
        )
        field.requestFocusInWindow()
    }

    /**
     * A rounded card with the review's accent down its left edge, so it reads as a note on the line.
     *
     * Its surface is the look and feel's, not the editor colour scheme's. It was the scheme's
     * NOTIFICATION_BACKGROUND, which on a dark IDE is a pale yellow — and every widget standing on it,
     * the buttons, the links and the text field, is painted by the look and feel in dark colours. The
     * bodies came out light grey on pale yellow and the field came out a black rectangle. One surface
     * and one set of foregrounds have to come from the same place.
     */
    private fun card(): JPanel = object : JPanel(BorderLayout()) {
        override fun paintComponent(g: Graphics) {
            val g2 = g.create() as Graphics2D
            try {
                GraphicsUtil.setupAAPainting(g2)
                val arc = JBUI.scale(10).toFloat()
                val shape = RoundRectangle2D.Float(0.5f, 0.5f, width - 1f, height - 1f, arc, arc)
                g2.color = UIUtil.getPanelBackground()
                g2.fill(shape)
                g2.clip(shape)
                g2.color = ACCENT
                g2.fillRect(0, 0, JBUI.scale(3), height)
                g2.clip = null
                g2.color = BORDER
                g2.draw(shape)
            } finally {
                g2.dispose()
            }
        }
    }.apply {
        isOpaque = false
        border = JBUI.Borders.empty(9, 13, 9, 11)
    }

    private fun quotedLine(editor: Editor, anchor: String, width: Int): JComponent {
        val code = JBLabel(anchor.trim().take(140)).apply {
            foreground = UIUtil.getInactiveTextColor()
            font = editor.colorsScheme.getFont(EditorFontType.PLAIN)
                .deriveFont(editor.colorsScheme.editorFontSize2D - 1f)
        }
        return JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.compound(
                JBUI.Borders.customLineLeft(BORDER),
                JBUI.Borders.empty(0, 7),
            )
            add(code, BorderLayout.WEST)
            preferredSize = Dimension(width, preferredSize.height)
        }
    }

    /** One comment already on this line: who wrote it, what it says, and the two things to do to it. */
    private fun row(comment: Comment, width: Int, onEdit: () -> Unit, onDelete: () -> Unit): JComponent {
        val meta = JBLabel(comment.by).apply {
            foreground = UIUtil.getInactiveTextColor()
            font = JBFont.small()
        }
        val actions = JPanel().apply {
            isOpaque = false
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(ActionLink("Edit") { onEdit() }.apply { font = JBFont.small() })
            add(Box.createHorizontalStrut(JBUI.scale(10)))
            add(ActionLink("Delete") { onDelete() }.apply { font = JBFont.small() })
        }
        val head = JPanel(BorderLayout()).apply {
            isOpaque = false
            add(meta, BorderLayout.WEST)
            add(actions, BorderLayout.EAST)
        }
        return JPanel(BorderLayout(0, JBUI.scale(2))).apply {
            isOpaque = false
            add(head, BorderLayout.NORTH)
            add(wrapped(comment.text, width), BorderLayout.CENTER)
            preferredSize = Dimension(width, preferredSize.height)
        }
    }

    private fun fieldOf(field: JBTextArea, width: Int, separated: Boolean): JComponent {
        val scroll = JBScrollPane(field).apply {
            border = RoundedLineBorder(BORDER, JBUI.scale(7), 1)
            isOpaque = false
            viewport.isOpaque = false
            horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
            verticalScrollBarPolicy = ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
            preferredSize = Dimension(width, field.getFontMetrics(field.font).height * 3 + JBUI.scale(14))
        }
        if (!separated) return scroll
        return JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.compound(JBUI.Borders.customLineTop(BORDER), JBUI.Borders.emptyTop(7))
            add(scroll, BorderLayout.CENTER)
        }
    }

    private fun footer(save: JButton): JComponent = JPanel().apply {
        isOpaque = false
        layout = BoxLayout(this, BoxLayout.X_AXIS)
        add(
            JBLabel("⌘⏎ keep   ·   Esc close").apply {
                foreground = UIUtil.getInactiveTextColor()
                font = JBFont.small()
            },
        )
        add(Box.createHorizontalGlue())
        add(save)
    }

    /**
     * A wrapping body has to be laid out before it can say how tall it is: a JTextArea asked for its
     * preferred size before it has a width answers as one long line, and the card then clips the text.
     */
    private fun wrapped(text: String, width: Int): JBTextArea = JBTextArea(text).apply {
        lineWrap = true
        wrapStyleWord = true
        isEditable = false
        isOpaque = false
        border = JBUI.Borders.empty()
        font = JBFont.medium()
        // A JTextArea that cannot be edited is painted in the disabled colour, and a comment read back
        // in the disabled colour reads as a comment that is no longer there.
        foreground = UIUtil.getLabelForeground()
        disabledTextColor = UIUtil.getLabelForeground()
        setSize(width, Short.MAX_VALUE.toInt())
        preferredSize = Dimension(width, preferredSize.height)
    }

    /** Wide enough to read a sentence in, never wider than the editor the card sits in. */
    private fun contentWidth(editor: Editor): Int {
        val visible = editor.scrollingModel.visibleArea.width
        val room = if (visible > 0) visible - JBUI.scale(90) else JBUI.scale(560)
        return room.coerceIn(JBUI.scale(320), JBUI.scale(620))
    }

    private fun embed(editor: EditorEx, card: JPanel, lineIndex: Int): Inlay<*>? {
        val offset = editor.document.getLineEndOffset(lineIndex.coerceIn(0, editor.document.lineCount - 1))
        return EditorEmbeddedComponentManager.getInstance().addComponent(
            editor,
            card,
            EditorEmbeddedComponentManager.Properties(
                EditorEmbeddedComponentManager.ResizePolicy.none(),
                null,
                true,
                false,
                0,
                offset,
            ),
        )
    }
}
