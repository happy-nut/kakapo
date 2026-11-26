package dev.kakapo.comments

import com.intellij.icons.AllIcons
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.ColoredListCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.ToolbarDecorator
import com.intellij.ui.components.JBList
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.DefaultListModel
import javax.swing.JList
import javax.swing.JPanel

/**
 * Where a comment is read again when its file is not the one in front of you.
 *
 * It held one list, the archive, until 0.0.6 — so a comment you had just written appeared in no list
 * at all and could only be found by hovering the gutter of the file it was in. The lists are a table
 * now, `ReviewTabs`, and `ReviewCheck` holds that table to being the whole of what a comment can be.
 */
object ReviewList {
    const val ID = "Kakapo Review"

    private val panels = mutableMapOf<Project, MutableList<ListPanel>>()

    fun show(project: Project, tab: ReviewTabs.Tab) {
        val window = ToolWindowManager.getInstance(project).getToolWindow(ID) ?: return
        window.show(null)
        refresh(project)
        val manager = window.contentManager
        manager.contents.firstOrNull { it.displayName == tab.title }?.let(manager::setSelectedContent)
    }

    fun refresh(project: Project) {
        panels[project]?.forEach(ListPanel::reload)
    }

    internal fun register(project: Project, panel: ListPanel) {
        panels.getOrPut(project) { mutableListOf() }.add(panel)
    }

    internal fun forget(project: Project, panel: ListPanel) {
        panels[project]?.remove(panel)
        if (panels[project]?.isEmpty() == true) panels.remove(project)
    }
}

class ReviewListFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        for (tab in ReviewTabs.all) {
            val panel = ListPanel(project, tab)
            ReviewList.register(project, panel)
            val content = ContentFactory.getInstance().createContent(panel, tab.title, false)
            content.setDisposer { ReviewList.forget(project, panel) }
            toolWindow.contentManager.addContent(content)
            panel.reload()
        }
    }
}

internal class ListPanel(private val project: Project, private val tab: ReviewTabs.Tab) : JPanel(BorderLayout()) {

    private val model = DefaultListModel<Comment>()
    private val list = JBList(model).apply {
        cellRenderer = object : ColoredListCellRenderer<Comment>() {
            override fun customizeCellRenderer(
                list: JList<out Comment>,
                value: Comment,
                index: Int,
                selected: Boolean,
                focused: Boolean,
            ) {
                icon = AllIcons.General.Balloon
                append(value.where(), SimpleTextAttributes.GRAYED_ATTRIBUTES)
                append("  ")
                append(value.text.lineSequence().first().take(120))
            }
        }
    }

    init {
        border = JBUI.Borders.empty()
        list.emptyText.text = tab.empty
        list.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(event: MouseEvent) {
                if (event.clickCount == 2) openSelected()
            }
        })
        add(
            ToolbarDecorator.createDecorator(list)
                .disableAddAction()
                .disableRemoveAction()
                .disableUpDownActions()
                .addExtraAction(ReloadAction(this))
                .createPanel(),
            BorderLayout.CENTER,
        )
    }

    fun reload() {
        val shown = ReviewTabs.of(tab, CommentStore(project).read())
        model.clear()
        shown.forEach(model::addElement)
    }

    /**
     * Opened through the anchor and not through the stored line, the same rule the gutter mark is
     * painted by. The stored number is where the comment was written, and an agent has edited the file
     * since — that is the whole reason the anchor exists.
     */
    private fun openSelected() {
        val comment = list.selectedValue ?: return
        val base = project.basePath ?: return
        val file = LocalFileSystem.getInstance().findFileByPath("$base/${comment.path}") ?: return
        val text = FileDocumentManager.getInstance().getDocument(file)?.text
        val line = if (text == null) (comment.line - 1) else CommentMarks.anchoredLine(text, comment)
        FileEditorManager.getInstance(project).openTextEditor(
            OpenFileDescriptor(project, file, line.coerceAtLeast(0), 0),
            true,
        )
    }
}

internal class ReloadAction(private val panel: ListPanel) :
    com.intellij.openapi.actionSystem.AnAction("Refresh", "Re-read the review file", AllIcons.Actions.Refresh) {
    override fun actionPerformed(event: com.intellij.openapi.actionSystem.AnActionEvent) = panel.reload()
}
