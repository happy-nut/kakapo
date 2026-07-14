import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

type InlineMarkdownEditor = {
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
  focus(): void;
  destroy(): void;
};

type CreateOptions = {
  element: HTMLElement;
  markdown?: string;
  placeholder?: string;
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
        Markdown.configure({
          markedOptions: { gfm: true, breaks: false, pedantic: false },
        }),
      ],
      content: options.markdown ?? "",
      contentType: "markdown",
      editorProps: {
        attributes: {
          class: "markdown-body mc-inline-editor",
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
      destroy: () => editor.destroy(),
    };
  },
};
