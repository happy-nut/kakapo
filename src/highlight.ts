import { html as renderDiff2HtmlMarkup } from "diff2html";
import hljs from "highlight.js";
import { decodeEntities, languageForPath, markWhitespaceRuns, stripHtmlTags } from "./util.js";

export type SourceTextLookup = (path: string) => string | undefined;

export function renderDiff2Html(diffText: string, sourceText?: SourceTextLookup): string {
  if (diffText.trim().length === 0) {
    return "";
  }

  const markup = renderDiff2HtmlMarkup(diffText, {
    outputFormat: "side-by-side",
    drawFileList: false,
    matching: "lines",
  });
  return highlightDiffHtml(markup, sourceText);
}

function highlightDiffHtml(markup: string, sourceText?: SourceTextLookup): string {
  const parts = markup.split(/(?=<div [^>]*class="d2h-file-wrapper")/);
  if (parts.length <= 1) {
    return markup;
  }
  return parts
    .map((part) => (part.includes('class="d2h-file-wrapper"') ? highlightDiffWrapper(part, sourceText) : part))
    .join("");
}

function highlightDiffWrapper(wrapper: string, sourceText?: SourceTextLookup): string {
  const nameMatch = wrapper.match(/<span class="d2h-file-name">([\s\S]*?)<\/span>/);
  const path = nameMatch ? decodeEntities(stripHtmlTags(nameMatch[1])).trim() : "";
  const language = hljsLanguageForPath(path);
  if (!language) {
    return wrapper;
  }
  if (language !== "xml") {
    return highlightSideLines(wrapper, () => language);
  }
  const byLine = markupLanguageByLine(sourceText?.(path));
  if (byLine) {
    return highlightSideLines(wrapper, (_text, line) => (line > 0 && byLine[line - 1]) || "xml");
  }
  return wrapper
    .split(/(?=<div [^>]*class="[^"]*d2h-file-side-diff)/)
    .map((side) => highlightSideLines(side, blockLanguageScanner()))
    .join("");
}

function scriptLanguage(attributes: string): string {
  return /\b(?:lang|type)\s*=\s*["']?[^"'>]*\b(?:ts|typescript)\b/i.test(attributes) ? "typescript" : "javascript";
}
const BLOCK_OPENER = /<\s*(script|style)\b([^>]*)>/i;
const BLOCK_CLOSER = /<\s*\/\s*(script|style)\s*>/i;

function markupLanguageByLine(text: string | undefined): string[] | undefined {
  if (typeof text !== "string" || !text) return undefined;
  const lines = text.split(/\r?\n/);
  const out: string[] = new Array(lines.length);
  let mode = "xml";
  for (let i = 0; i < lines.length; i += 1) {
    const opener = BLOCK_OPENER.exec(lines[i]);
    if (opener && !/\/\s*>\s*$/.test(opener[0])) {
      out[i] = "xml";
      mode = opener[1].toLowerCase() === "style" ? "css" : scriptLanguage(opener[2]);
      continue;
    }
    if (BLOCK_CLOSER.test(lines[i])) {
      out[i] = "xml";
      mode = "xml";
      continue;
    }
    out[i] = mode;
  }
  return out;
}

function blockLanguageScanner(): (text: string) => string {
  let mode = "xml";
  return (text: string): string => {
    const current = mode;
    const opener = BLOCK_OPENER.exec(text);
    if (opener && !/\/\s*>\s*$/.test(opener[0])) {
      mode = opener[1].toLowerCase() === "style" ? "css" : scriptLanguage(opener[2]);
      return current;
    }
    if (BLOCK_CLOSER.test(text)) {
      mode = "xml";
      return "xml";
    }
    return current;
  };
}

function highlightSideLines(side: string, languageFor: (text: string, line: number) => string): string {
  return side.replace(
    /(<span class="d2h-code-line-ctn">)([\s\S]*?)(<\/span>\s*<\/div>)/g,
    (whole: string, open: string, content: string, close: string, offset: number) => {
      const language = languageFor(decodeEntities(stripHtmlTags(content)), lineNumberBefore(side, offset));
      const marked = (inner: string) => `${open}${markWhitespaceRuns(inner)}${close}`;
      if (!hljs.getLanguage(language)) return marked(content);
      const highlighted = highlightCtnSegments(content, language);
      return marked(highlighted === null ? content : highlighted);
    },
  );
}

const LINE_NUMBER_CELL = "d2h-code-side-linenumber";
function lineNumberBefore(side: string, offset: number): number {
  const head = side.lastIndexOf(LINE_NUMBER_CELL, offset);
  if (head < 0) return 0;
  const cell = side.slice(head, offset);
  const digits = /^[^>]*>\s*(\d+)/.exec(cell);
  return digits ? Number(digits[1]) : 0;
}

function highlightCtnSegments(content: string, language: string): string | null {
  if (content.trim().length === 0) {
    return null;
  }
  if (content.indexOf("<") < 0) {
    const text = decodeEntities(content);
    if (text.trim().length === 0) {
      return null;
    }
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }
  let changed = false;
  const out = content.replace(/(<[^>]+>)|([^<]+)/g, (_match: string, tag: string, text: string) => {
    if (tag) {
      return tag;
    }
    const decoded = decodeEntities(text);
    if (decoded.trim().length === 0) {
      return text;
    }
    try {
      changed = true;
      return hljs.highlight(decoded, { language, ignoreIllegals: true }).value;
    } catch {
      return text;
    }
  });
  return changed ? out : null;
}

function hljsLanguageForPath(path: string): string {
  if (!path) {
    return "";
  }
  const base = languageForPath(path);
  const mapped = base === "markup" ? "xml" : base === "text" ? "" : base;
  return mapped && hljs.getLanguage(mapped) ? mapped : "";
}
