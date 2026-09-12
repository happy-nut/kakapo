import { html as renderDiff2HtmlMarkup } from "diff2html";
import hljs from "highlight.js";
import { decodeEntities, languageForPath, stripHtmlTags } from "./util.js";

export function renderDiff2Html(diffText: string): string {
  if (diffText.trim().length === 0) {
    return "";
  }

  const markup = renderDiff2HtmlMarkup(diffText, {
    outputFormat: "side-by-side",
    drawFileList: false,
    matching: "lines",
  });
  return highlightDiffHtml(markup);
}

function highlightDiffHtml(markup: string): string {
  const parts = markup.split(/(?=<div [^>]*class="d2h-file-wrapper")/);
  if (parts.length <= 1) {
    return markup;
  }
  return parts
    .map((part) => (part.includes('class="d2h-file-wrapper"') ? highlightDiffWrapper(part) : part))
    .join("");
}

function highlightDiffWrapper(wrapper: string): string {
  const nameMatch = wrapper.match(/<span class="d2h-file-name">([\s\S]*?)<\/span>/);
  const path = nameMatch ? decodeEntities(stripHtmlTags(nameMatch[1])).trim() : "";
  const language = hljsLanguageForPath(path);
  if (!language) {
    return wrapper;
  }
  // A side-by-side wrapper holds the old file's lines then the new file's, each in its own block and each
  // starting again at that file's first line. The block state below (which language a line is in) has to
  // restart with them, or the right-hand side inherits whatever the left-hand side ended inside.
  if (language !== "xml") {
    return highlightSideLines(wrapper, () => language);
  }
  return wrapper
    .split(/(?=<div [^>]*class="[^"]*d2h-file-side-diff)/)
    .map((side) => highlightSideLines(side, blockLanguageScanner()))
    .join("");
}

// One code line at a time is all diff2html gives us, and hljs cannot see a <script> block from inside it —
// which is why a .svelte or .html diff came back with its tags coloured and its actual code plain. Track the
// block a line is in as the lines go past, and hand each one the language it is really written in.
//
// The diff shows hunks, not whole files: a run of script lines whose opening <script> is not in the diff is
// read as markup, exactly as before. That is the floor, not a regression — and the common case (a hunk that
// includes its own block header, or a file small enough to show whole) lands right.
function blockLanguageScanner(): (text: string) => string {
  let mode = "xml";
  return (text: string): string => {
    const current = mode;
    const opener = /<\s*(script|style)\b([^>]*)>/i.exec(text);
    if (opener && !/\/\s*>\s*$/.test(opener[0])) {
      // `lang="ts"` / `type="text/typescript"` is worth honouring: TS syntax in a plain-javascript grammar
      // reads as an illegal sequence, and ignoreIllegals then drops the tokens we came for.
      mode = opener[1].toLowerCase() === "style"
        ? "css"
        : /\b(?:lang|type)\s*=\s*["']?[^"'>]*\b(?:ts|typescript)\b/i.test(opener[2]) ? "typescript" : "javascript";
      return current; // the line carrying the opening tag is still markup
    }
    if (/<\s*\/\s*(script|style)\s*>/i.test(text)) {
      mode = "xml";
      return "xml";
    }
    return current;
  };
}

function highlightSideLines(side: string, languageFor: (text: string) => string): string {
  return side.replace(
    /(<span class="d2h-code-line-ctn">)([\s\S]*?)(<\/span>\s*<\/div>)/g,
    (whole: string, open: string, content: string, close: string) => {
      const language = languageFor(decodeEntities(stripHtmlTags(content)));
      if (!hljs.getLanguage(language)) return whole;
      const highlighted = highlightCtnSegments(content, language);
      return highlighted === null ? whole : `${open}${highlighted}${close}`;
    },
  );
}

// Apply hljs to a code-line container while preserving diff2html word-level
// change markup (e.g. <span class="d2h-change">...): tags are kept verbatim and
// only the text segments between them are syntax-highlighted.
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
  const lower = path.toLowerCase();
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) {
    return "kotlin";
  }
  const base = languageForPath(path);
  const mapped = base === "markup" ? "xml" : base === "text" ? "" : base;
  return mapped && hljs.getLanguage(mapped) ? mapped : "";
}
