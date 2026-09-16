import { html as renderDiff2HtmlMarkup } from "diff2html";
import hljs from "highlight.js";
import { decodeEntities, languageForPath, stripHtmlTags } from "./util.js";

// How the caller finds a changed file's CURRENT text, by the repo-relative path the diff names. Optional
// everywhere: a history diff of an old commit has no such text, and highlighting falls back to reading the
// hunks alone. See markupLanguageByLine for what having it buys.
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
  // A single-file component is markup only around its edges; nearly everything in it lives inside <script>
  // or <style>. Which block a line is in is a property of the FILE, and the diff shows hunks — so ask the
  // file when we can reach it, and fall back to reading the hunks alone when we cannot (history diffs).
  const byLine = markupLanguageByLine(sourceText?.(path));
  if (byLine) {
    return highlightSideLines(wrapper, (_text, line) => (line > 0 && byLine[line - 1]) || "xml");
  }
  // A side-by-side wrapper holds the old file's lines then the new file's, each in its own block and each
  // starting again at that file's first line. The block state below (which language a line is in) has to
  // restart with them, or the right-hand side inherits whatever the left-hand side ended inside.
  return wrapper
    .split(/(?=<div [^>]*class="[^"]*d2h-file-side-diff)/)
    .map((side) => highlightSideLines(side, blockLanguageScanner()))
    .join("");
}

// `lang="ts"` / `type="text/typescript"` is worth honouring: TS syntax in a plain-javascript grammar reads as
// an illegal sequence, and ignoreIllegals then drops the tokens we came for.
function scriptLanguage(attributes: string): string {
  return /\b(?:lang|type)\s*=\s*["']?[^"'>]*\b(?:ts|typescript)\b/i.test(attributes) ? "typescript" : "javascript";
}
const BLOCK_OPENER = /<\s*(script|style)\b([^>]*)>/i;
const BLOCK_CLOSER = /<\s*\/\s*(script|style)\s*>/i;

// The language of every line of a single-file component, by 1-based line number (index 0 = line 1). This is
// the whole answer to "is this line inside <script>": the file has the openers and closers in it, whether or
// not the diff happened to show them.
//
// Line numbers are the NEW file's, and the old side of a side-by-side diff is numbered against the old file.
// Blocks are hundreds of lines long and a diff shifts things by a handful, so the two agree everywhere except
// within a few lines of a boundary — where the worst case is one `</script>` line coloured as script.
function markupLanguageByLine(text: string | undefined): string[] | undefined {
  if (typeof text !== "string" || !text) return undefined;
  const lines = text.split(/\r?\n/);
  const out: string[] = new Array(lines.length);
  let mode = "xml";
  for (let i = 0; i < lines.length; i += 1) {
    const opener = BLOCK_OPENER.exec(lines[i]);
    if (opener && !/\/\s*>\s*$/.test(opener[0])) {
      out[i] = "xml"; // the line carrying the opening tag is still markup
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

// Fallback for a diff with no file behind it (git history). One code line at a time is all diff2html gives
// us, so track the block as the lines go past. A run of script lines whose opening <script> is not in the
// diff reads as markup — the floor, not a regression.
function blockLanguageScanner(): (text: string) => string {
  let mode = "xml";
  return (text: string): string => {
    const current = mode;
    const opener = BLOCK_OPENER.exec(text);
    if (opener && !/\/\s*>\s*$/.test(opener[0])) {
      mode = opener[1].toLowerCase() === "style" ? "css" : scriptLanguage(opener[2]);
      return current; // the line carrying the opening tag is still markup
    }
    if (BLOCK_CLOSER.test(text)) {
      mode = "xml";
      return "xml";
    }
    return current;
  };
}

// diff2html emits each side-by-side row as a line-number cell followed by the code cell, so the number for a
// row is the last one printed before it. Indexing the per-file language map by line rather than by position
// in the hunk is what makes it correct across folds — a folded hunk skips line numbers, so counting rows
// would drift by however many lines were left out.
function highlightSideLines(side: string, languageFor: (text: string, line: number) => string): string {
  return side.replace(
    /(<span class="d2h-code-line-ctn">)([\s\S]*?)(<\/span>\s*<\/div>)/g,
    (whole: string, open: string, content: string, close: string, offset: number) => {
      const language = languageFor(decodeEntities(stripHtmlTags(content)), lineNumberBefore(side, offset));
      if (!hljs.getLanguage(language)) return whole;
      const highlighted = highlightCtnSegments(content, language);
      return highlighted === null ? whole : `${open}${highlighted}${close}`;
    },
  );
}

// The line number diff2html printed for the row that ends at `offset`. Empty on the blank half of an
// added/removed pair, which is what 0 means — the caller then falls back to markup.
const LINE_NUMBER_CELL = "d2h-code-side-linenumber";
function lineNumberBefore(side: string, offset: number): number {
  const head = side.lastIndexOf(LINE_NUMBER_CELL, offset);
  if (head < 0) return 0;
  const cell = side.slice(head, offset);
  const digits = /^[^>]*>\s*(\d+)/.exec(cell);
  return digits ? Number(digits[1]) : 0;
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
  const base = languageForPath(path);
  const mapped = base === "markup" ? "xml" : base === "text" ? "" : base;
  return mapped && hljs.getLanguage(mapped) ? mapped : "";
}
