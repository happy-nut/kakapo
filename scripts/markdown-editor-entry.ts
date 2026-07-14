import { Editor, Extension, InputRule, markInputRule, wrappingInputRule } from "@tiptap/core";
import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

type InlineMarkdownEditor = {
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
  focus(): void;
  destroy(): void;
  deleteBlockRange(start: HTMLElement, end?: HTMLElement | null): boolean;
  replaceBlockText(block: HTMLElement, text: string): boolean;
  typeText(text: string): void;
};

type CreateOptions = {
  element: HTMLElement;
  markdown?: string;
  placeholder?: string;
  className?: string;
  onUpdate?: (markdown: string) => void;
};

declare global {
  interface Window {
    MonacoriMarkdownEditor?: {
      create(options: CreateOptions): InlineMarkdownEditor;
    };
  }
}

function setEmptyState(element: HTMLElement, editor: Editor): void {
  element.dataset.empty = editor.isEmpty ? "true" : "false";
}

// Notion-like shorthands that are deliberately narrower than Markdown itself:
//   >  creates a collapsible details block, while "  creates a blockquote.
//   ~text~ applies the existing Markdown strike mark (serialized as portable ~~text~~).
// TaskItem already accepts the requested [] shorthand and StarterKit owns Mod-U underline.
const NotionInputShortcuts = Extension.create({
  name: "monacoriNotionInputShortcuts",
  priority: 210,
  addInputRules() {
    const blockquote = this.editor.schema.nodes.blockquote;
    const strike = this.editor.schema.marks.strike;
    return [
      new InputRule({
        find: /^\s*>\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).setDetails().run();
        },
      }),
      wrappingInputRule({
        find: /^\s*"\s$/,
        type: blockquote,
      }),
      markInputRule({
        find: /(?:^|\s)(~(?![~\s])([^~\n]+?)~)$/,
        type: strike,
      }),
    ];
  },
});

function topLevelBlockPosition(editor: Editor, element: HTMLElement): number {
  const inside = editor.view.posAtDOM(element, 0);
  const resolved = editor.state.doc.resolve(inside);
  return resolved.depth > 0 ? resolved.before(1) : inside;
}

window.MonacoriMarkdownEditor = {
  create(options: CreateOptions): InlineMarkdownEditor {
    const element = options.element;
    element.dataset.placeholder = options.placeholder ?? "";
    const editor = new Editor({
      element,
      extensions: [
        StarterKit.configure({
          link: { openOnClick: false },
          heading: { levels: [1, 2, 3, 4, 5, 6] },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Details.configure({
          persist: true,
          renderToggleButton: ({ element: button, isOpen }) => {
            button.className = "mc-details-toggle";
            button.textContent = isOpen ? "▾" : "▸";
            button.setAttribute("aria-label", isOpen ? "Collapse toggle" : "Expand toggle");
          },
        }),
        DetailsSummary,
        DetailsContent,
        NotionInputShortcuts,
        Markdown.configure({
          markedOptions: { gfm: true, breaks: false, pedantic: false },
        }),
      ],
      content: options.markdown ?? "",
      contentType: "markdown",
      editorProps: {
        attributes: {
          class: ["markdown-body", "mc-inline-editor", options.className].filter(Boolean).join(" "),
          spellcheck: "true",
          "aria-label": options.placeholder ?? "Markdown memo",
        },
      },
      onCreate: ({ editor: created }) => setEmptyState(element, created),
      onUpdate: ({ editor: updated }) => {
        setEmptyState(element, updated);
        options.onUpdate?.(updated.getMarkdown());
      },
    });
    setEmptyState(element, editor);
    return {
      getMarkdown: () => editor.getMarkdown(),
      setMarkdown: (markdown: string) => {
        editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false });
        setEmptyState(element, editor);
      },
      focus: () => { editor.commands.focus(); },
      deleteBlockRange: (start: HTMLElement, end?: HTMLElement | null) => {
        try {
          const from = topLevelBlockPosition(editor, start);
          const to = end ? topLevelBlockPosition(editor, end) : editor.state.doc.content.size;
          if (to <= from) return false;
          return editor.commands.deleteRange({ from, to });
        } catch {
          return false;
        }
      },
      replaceBlockText: (block: HTMLElement, text: string) => {
        try {
          const inside = editor.view.posAtDOM(block, 0);
          const resolved = editor.state.doc.resolve(inside);
          if (resolved.depth < 1) return false;
          return editor.commands.insertContentAt(
            { from: resolved.start(resolved.depth), to: resolved.end(resolved.depth) },
            text,
          );
        } catch {
          return false;
        }
      },
      // Internal test/automation seam: exercise the same ProseMirror text-input pipeline as typing.
      typeText: (text: string) => {
        for (const character of text) {
          const { from, to } = editor.state.selection;
          let handled = false;
          editor.view.someProp("handleTextInput", handler => {
            if (!handled) handled = Boolean(handler(editor.view, from, to, character));
          });
          if (!handled) editor.commands.insertContent(character);
        }
      },
      destroy: () => editor.destroy(),
    };
  },
};
