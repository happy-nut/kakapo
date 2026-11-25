package dev.kakapo.comments

import com.intellij.icons.AllIcons
import com.intellij.openapi.fileEditor.FileEditorManager
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
 * Archived is not deleted. The hand-off marks a comment addressed so the next one carries only what is
 * new, and this is where the ones already handed over stay readable — with the line each was about,
 * and a way back to it.
 */
object ReviewHistory {
    const val ID = "Kakapo Review"

    fun show(project: Project) {
        val window = ToolWindowManager.getInstance(project).getToolWindow(ID) ?: return
        window.show(null)
        refresh(project)
    }

    fun refresh(project: Project) {
        panels[project]?.reload()
    }

    private val panels = mutableMapOf<Project, HistoryPanel>()

    internal fun register(project: Project, panel: HistoryPanel) {
        panels[project] = panel
    }

    internal fun forget(project: Project) {
        panels.remove(project)
    }
}

class ReviewHistoryFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = HistoryPanel(project)
        ReviewHistory.register(project, panel)
        val content = ContentFactory.getInstance().createContent(panel, "Archived", false)
        content.setDisposer { ReviewHistory.forget(project) }
        toolWindow.contentManager.addContent(content)
        panel.reload()
    }
}

internal class HistoryPanel(private val project: Project) : JPanel(BorderLayout()) {

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
        list.emptyText.text = "Nothing archived yet — ⌃⇧⌘/ copies the open comments and archives them."
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
        val archived = CommentStore(project).read().filter { it.addressed }
        model.clear()
        archived.asReversed().forEach(model::addElement)
    }

    private fun openSelected() {
        val comment = list.selectedValue ?: return
        val base = project.basePath ?: return
        val file = LocalFileSystem.getInstance().findFileByPath("$base/${comment.path}") ?: return
        FileEditorManager.getInstance(project).openTextEditor(
            com.intellij.openapi.fileEditor.OpenFileDescriptor(project, file, (comment.line - 1).coerceAtLeast(0), 0),
            true,
        )
    }
}

internal class ReloadAction(private val panel: HistoryPanel) :
    com.intellij.openapi.actionSystem.AnAction("Refresh", "Re-read the review file", AllIcons.Actions.Refresh) {
    override fun actionPerformed(event: com.intellij.openapi.actionSystem.AnActionEvent) = panel.reload()
}
