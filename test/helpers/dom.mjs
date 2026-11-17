import { JSDOM } from "jsdom";
import { after } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeDeferredSourceFile } from "../../dist/diff.js";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const openWindows = new Set();
after(() => {
  for (const window of openWindows) { try { window.close(); } catch { } }
  openWindows.clear();
});

const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");

function inlineExternalClient(html) {
  return html.replace(
    /<script src="kakapo-asset:\/\/app\/(viewer\.client(?:\.min)?\.js)(?:\?[^"]*)?"><\/script>/,
    (_match, file) => `<script>${readFileSync(join(DIST_DIR, file), "utf8")}</script>`,
  );
}

export async function loadViewer(html, opts = {}) {
  const dom = new JSDOM(inlineExternalClient(html), {
    url: "http://localhost/review.html",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      if (opts.seedStorage) {
        for (const [k, val] of Object.entries(opts.seedStorage)) {
          try {
            window.localStorage.setItem(k, val);
          } catch {
          }
        }
      }
      if (opts.seedSession) {
        for (const [k, val] of Object.entries(opts.seedSession)) {
          try { window.sessionStorage.setItem(k, val); } catch { }
        }
      }
      const noopObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      };
      window.IntersectionObserver = opts.eagerIntersections ? class extends noopObserver {
        constructor(callback) { super(); this.callback = callback; }
        observe(target) { this.callback([{ isIntersecting: true, target }]); }
      } : noopObserver;
      window.ResizeObserver = noopObserver;
      if (!window.matchMedia) {
        window.matchMedia = () => ({
          matches: false,
          media: "",
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() {
            return false;
          },
        });
      }
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.confirm = () => true;

      window.KakapoMarkdownEditor = {
        create({ element, markdown = "", onUpdate = () => {}, placeholder = "", className = "" }) {
          let value = String(markdown);
          const editable = window.document.createElement("div");
          editable.className = `markdown-body mc-inline-editor ${className}`.trim();
          editable.setAttribute("contenteditable", "true");
          editable.setAttribute("aria-label", placeholder);
          const render = () => {
            editable.innerHTML = window.markdownit ? window.markdownit().render(value) : value;
            element.dataset.empty = value ? "false" : "true";
          };
          editable.addEventListener("input", () => { value = editable.textContent || ""; element.dataset.empty = value ? "false" : "true"; onUpdate(value); });
          element.appendChild(editable);
          render();
          return {
            getMarkdown: () => value,
            setMarkdown(next) { value = String(next); render(); },
            focus(position) {
              editable.focus();
              if (position !== "start" && position !== "end") return;
              try {
                const range = window.document.createRange();
                const sel = window.getSelection();
                if (position === "start") range.setStart(editable, 0);
                else range.setStart(editable, editable.childNodes.length);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
              } catch (e) {}
            },
            getCaretElement() {
              const selection = window.getSelection();
              const node = selection && selection.rangeCount ? selection.anchorNode : null;
              return node ? (node.nodeType === 1 ? node : node.parentElement) : null;
            },
            atBoundary(direction) {
              const selection = window.getSelection();
              if (!selection || !selection.rangeCount) return true;
              const range = selection.getRangeAt(0);
              if (!editable.contains(range.startContainer)) return true;
              const probe = window.document.createRange();
              if (direction === "up") {
                probe.setStart(editable, 0);
                probe.setEnd(range.startContainer, range.startOffset);
              } else {
                probe.setStart(range.endContainer, range.endOffset);
                probe.setEnd(editable, editable.childNodes.length);
              }
              return probe.toString().length === 0;
            },
            destroy() {},
          };
        },
      };

      if (opts.electronSettings) {
        const frozen = deepFreeze(JSON.parse(JSON.stringify(opts.electronSettings)));
        const writes = {};
        window.__electronWrites = writes;
        window.kakapoSettings = {
          all: frozen,
          set(key, value) {
            writes[key] = value;
          },
        };
      }
      if (opts.menuBridge) {
        const diffUpdateListeners = [];
        window.__diffUpdateListeners = diffUpdateListeners;
        window.__diffUpdateCb = (payload) => { for (const cb of diffUpdateListeners) cb(payload); };
        window.kakapoMenu = {
          onDiffUpdate: (cb) => { diffUpdateListeners.push(cb); },
          onReleaseView: (cb) => { window.__releaseViewCb = cb; },
        };
      }
      if (opts.lazySourceData != null || opts.getDiffBody || opts.sourceBridge || opts.existingPathsBridge) {
        let sourceRecords = [];
        try { sourceRecords = JSON.parse(opts.lazySourceData ?? "[]"); } catch { sourceRecords = []; }
        window.__sourceRequests = [];
        window.__projectIndexRequests = 0;
        window.kakapoFile = {
          getIndex: () => {
            window.__projectIndexRequests += 1;
            if (opts.projectIndexBridge) return Promise.resolve(opts.projectIndexBridge());
            let records = sourceRecords;
            if (!records.length) {
              try { records = JSON.parse(window.document.getElementById("source-files-data")?.textContent || "[]"); } catch { records = []; }
            }
            const metadata = records.map((record) => ({ ...record, content: "", image: "" }));
            const filesTree = '<nav class="tree source-tree">' + metadata.map((record) =>
              '<button type="button" class="file-link source-link tree-file" data-source-file="' + record.path + '"><span class="path">' + record.name + '</span></button>'
            ).join("") + '</nav>';
            return Promise.resolve({ sourceFilesMeta: metadata, fileStates: [], filesTree });
          },
          getSource: (path) => {
            window.__sourceRequests.push(path);
            if (opts.sourceBridge) return Promise.resolve(opts.sourceBridge(path));
            const record = sourceRecords.find((item) => item.path === path) || null;
            if (record?.deferred && opts.root) return Promise.resolve(materializeDeferredSourceFile(opts.root, record));
            return Promise.resolve(record);
          },
          existingPaths: opts.existingPathsBridge
            ? (paths) => Promise.resolve(opts.existingPathsBridge(paths))
            : undefined,
          get: (index, kind) => Promise.resolve(opts.getDiffBody ? opts.getDiffBody(Number(index), kind) : ""),
          getDiffContext: opts.diffContextBridge
            ? (request) => Promise.resolve(opts.diffContextBridge(request))
            : undefined,
        };
      }
      if (opts.searchBridge) {
        window.kakapoSearch = {
          query: (request) => Promise.resolve(opts.searchBridge(request)),
        };
      }
      if (opts.analysisBridge || opts.diagnosticsBridge) {
        window.kakapoAnalysis = {
          query: (request) => Promise.resolve(opts.analysisBridge ? opts.analysisBridge(request) : null),
          status: () => Promise.resolve(opts.analysisStatus || {
            generation: 0,
            phase: "idle",
            updatedAt: new Date(0).toISOString(),
          }),
          onStatus: (cb) => { window.__analysisStatusCb = cb; },
        };
        if (opts.diagnosticsBridge) {
          window.__diagnosticsRequests = [];
          window.kakapoAnalysis.diagnostics = (path) => {
            window.__diagnosticsRequests.push(path);
            return Promise.resolve(opts.diagnosticsBridge(path));
          };
        }
      }
      if (opts.memoBridge) {
        const state = JSON.parse(JSON.stringify(opts.memoBridge));
        state.body = typeof state.body === "string" ? state.body : "";
        state.updatedAt = state.updatedAt || null;
        const operations = [];
        window.__memoOperations = operations;
        window.kakapoMemo = {
          read: () => Promise.resolve(JSON.parse(JSON.stringify(state))),
          write: (body) => {
            state.body = String(body); state.updatedAt = new Date().toISOString();
            operations.push({ kind: "write", body: state.body });
            return Promise.resolve({ ...state });
          },
          remove: () => {
            state.body = ""; state.updatedAt = null; operations.push({ kind: "delete" });
            return Promise.resolve({ ok: true });
          },
        };
      }
      if (opts.perfBridge) {
        window.kakapoPerf = { mark: (name, details) => opts.perfBridge(name, details) };
      }
      if (opts.termsBridge) {
        const terms = JSON.parse(JSON.stringify(opts.termsBridge));
        window.__termsWrites = [];
        window.kakapoTerms = {
          read: () => Promise.resolve({ path: ".git/kakapo/terms.jsonl", terms }),
          write: (next) => { window.__termsWrites.push(JSON.parse(JSON.stringify(next))); return Promise.resolve({ ok: true }); },
        };
      }
      if (opts.monacoBridge) installMonacoMock(window);
    },
  });

  const { window } = dom;
  const { document } = window;
  await tick(60);

  openWindows.add(window);
  const api = new Viewer(dom, window, document);
  return api;
}

class Viewer {
  constructor(dom, window, document) {
    this.dom = dom;
    this.window = window;
    this.document = document;
  }

  close() {
    openWindows.delete(this.window);
    this.window.close();
  }
  settle(ms = 50) {
    return tick(ms);
  }
  async until(fn, cap = 3000) {
    const deadline = Date.now() + cap;
    while (!fn() && Date.now() < deadline) await this.settle(20);
    return Boolean(fn());
  }
  async pushDiffUpdate(payload) {
    const cb = this.window.__diffUpdateCb;
    if (!cb) throw new Error("pushDiffUpdate: no diff-update listener (pass { menuBridge: true })");
    cb(payload);
    await this.settle(80);
  }
  async releaseView() {
    const cb = this.window.__releaseViewCb;
    if (!cb) throw new Error("releaseView: no release listener (pass { menuBridge: true })");
    cb();
    await this.settle(20);
  }
  storedComments() {
    const raw = this.window.localStorage.getItem("kakapo-comments:/review.html");
    return raw ? JSON.parse(raw) : [];
  }
  electronWrites() {
    return this.window.__electronWrites || {};
  }
  exportStorage() {
    const out = {};
    const ls = this.window.localStorage;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      out[k] = ls.getItem(k);
    }
    return out;
  }

  $(sel) {
    return this.document.querySelector(sel);
  }
  $all(sel) {
    return Array.from(this.document.querySelectorAll(sel));
  }
  visibleView() {
    const sv = this.document.getElementById("source-viewer");
    const dv = this.document.getElementById("diff-view");
    if (sv && !sv.classList.contains("hidden")) return "source";
    if (dv && !dv.classList.contains("hidden")) return "diff";
    return null;
  }
  activeDiffFile() {
    const link = this.$("#changes-panel .file-link.active");
    return link ? link.dataset.file || null : null;
  }
  async openQuickOpenSection(section) {
    this.key("f", { metaKey: true, shiftKey: true, code: "KeyF" });
    await this.settle(20);
    if (section === "content") return;
    const row = this.$(`#quick-open-side .quick-open-side-item[data-section="${section}"]`);
    row.dispatchEvent(new this.window.MouseEvent("click", { bubbles: true }));
    await this.settle(20);
  }
  quickOpenVisible() {
    const qo = this.$("#quick-open");
    return !!(qo && !qo.classList.contains("hidden"));
  }
  visibleComposerInput() {
    const inputs = this.$all(".mc-composer .mc-input");
    return (
      inputs.find((i) => {
        const dv = this.document.getElementById("diff-view");
        const sv = this.document.getElementById("source-viewer");
        if (i.closest("#diff-view") && dv && dv.classList.contains("hidden")) return false;
        if (i.closest("#source-viewer") && sv && sv.classList.contains("hidden")) return false;
        return true;
      }) || null
    );
  }
  agentSays(record) {
    const w = this.window;
    const records = w.reviewComments.map(w.commentToRecord);
    const id = records.reduce((max, r) => Math.max(max, r.id), 0) + 1;
    w.applyThreadRecords(records.concat([{ id, by: "agent", text: "", ...record }]));
    return id;
  }
  visibleCardTexts() {
    const root = this.visibleView() === "diff" ? "#diff2html-container" : "#source-body";
    return this.$all(`${root} .mc-card:not(.mc-composer) .mc-card-body`).map((b) => b.textContent);
  }
  selectedCommentBox() {
    const root = this.visibleView() === "diff" ? "#diff2html-container" : "#source-body";
    return this.$(`${root} .mc-comment-row.mc-row-selected`);
  }
  diffCaretRow() {
    return this.$("#diff2html-container .mc-diff-cursor-row");
  }
  diffCaretLine() {
    const row = this.diffCaretRow();
    const n = row && row.querySelector(".d2h-code-side-linenumber");
    const v = n ? parseInt((n.textContent || "").trim(), 10) : NaN;
    return Number.isFinite(v) ? v : null;
  }
  caretLine() {
    const row = this.$("#source-body .source-row.cursor-line");
    if (row && this.window.isSourceViewerVisible()) return Number(row.dataset.lineIndex) + 1;
    return this.diffCaretLine();
  }

  click(el) {
    if (!el) throw new Error("click: element not found");
    // A real browser blurs the focused field when you click a non-focusable target (e.g. a code row);
    // jsdom's synthetic clicks don't, which would leave a textarea "focused" and make the viewer's
    // `?`/`>` composer shortcuts no-op (they skip when activeElement is editable). Mirror the browser.
    const active = this.document.activeElement;
    if (active && active !== el && typeof active.blur === "function") active.blur();
    const opts = { bubbles: true, cancelable: true, view: this.window };
    el.dispatchEvent(new this.window.MouseEvent("mousedown", opts));
    el.dispatchEvent(new this.window.MouseEvent("mouseup", opts));
    el.dispatchEvent(new this.window.MouseEvent("click", opts));
  }
  key(key, mods = {}) {
    this.document.dispatchEvent(
      new this.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  }
  typeInto(el, value) {
    if (!el) throw new Error("typeInto: element not found");
    el.focus();
    if ("value" in el) el.value = value;
    else el.textContent = value;
    el.dispatchEvent(new this.window.Event("input", { bubbles: true }));
  }
  async typeChars(el, text, settleMs = 120) {
    if (!el) throw new Error("typeChars: element not found");
    el.focus();
    for (const ch of text) {
      const event = new this.window.KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      if (!event.defaultPrevented && this.document.activeElement === el) {
        el.value += ch;
        el.dispatchEvent(new this.window.Event("input", { bubbles: true }));
      }
      await this.settle(settleMs);
    }
    return el.value;
  }

  async openSourceFile(path) {
    if (!this.document.querySelector(".source-link")) {
      if (typeof this.window.setTab === "function") {
        this.window.setTab("files");
        await this.settle(40);
      }
    }
    if (!this.document.querySelector(`.source-link[data-source-file="${cssEscape(path)}"]`) && typeof this.window.openVirtualSourceDirectory === "function") {
      const slash = path.lastIndexOf("/");
      if (slash > 0) this.window.openVirtualSourceDirectory(path.slice(0, slash));
      await this.settle(20);
    }
    const link =
      this.document.querySelector(`.source-link[data-source-file="${cssEscape(path)}"]`) ||
      this.document.querySelector(".source-link");
    this.click(link);
    await this.settle(80);
    if (typeof this.window.clearTreeFocus === "function") this.window.clearTreeFocus();
    const source = this.document.getElementById("source-body");
    if (source) { source.tabIndex = -1; source.focus({ preventScroll: true }); }
  }
  async openDiffFor(path) {
    const row =
      this.document.querySelector(`.change-row[data-file="${cssEscape(path)}"]`) ||
      this.document.querySelector(".change-row, #changes-panel .file-link");
    this.click(row);
    await this.settle(80);
    if (typeof this.window.clearTreeFocus === "function") this.window.clearTreeFocus();
    const diff = this.document.getElementById("diff2html-container");
    if (diff) { diff.tabIndex = -1; diff.focus({ preventScroll: true }); }
  }
  async clickSourceLine(lineIndex) {
    const row = this.document.querySelector(`.source-row[data-line-index="${lineIndex}"]`);
    if (!row) throw new Error(`clickSourceLine: no source row at line-index ${lineIndex}`);
    this.click(row.querySelector(".source-code") || row);
    await this.settle(20);
  }
  async clickFirstDiffLine() {
    const wrap = this.document.querySelector("#diff2html-container .d2h-file-wrapper");
    if (!wrap) throw new Error("clickFirstDiffLine: no diff wrapper");
    const sides = wrap.querySelectorAll(".d2h-file-side-diff");
    const right = sides[sides.length - 1];
    const numCell = Array.from(right.querySelectorAll(".d2h-code-side-linenumber")).find(
      (n) => (n.textContent || "").trim() !== "",
    );
    const tr = numCell.closest("tr");
    this.click(tr.querySelector(".d2h-code-line, .d2h-code-side-line") || numCell);
    await this.settle(20);
  }
  async openComposer() {
    this.key("?");
    await this.settle(40);
  }
  async writeAndSave(text) {
    const input = this.visibleComposerInput();
    if (!input) throw new Error("writeAndSave: no visible composer input");
    this.typeInto(input, text);
    const saveBtn = input.closest(".mc-comment-row").querySelector(".mc-save");
    this.click(saveBtn);
    await this.settle(40);
  }
  async clickRenderToggle() {
    const btn = this.$("#render-toggle");
    if (!btn || btn.classList.contains("hidden")) throw new Error("render toggle not available");
    this.click(btn);
    await this.settle(60);
  }
  sourceRowLineIndices() {
    return this.$all("#source-body .source-row").map((r) => Number(r.dataset.lineIndex));
  }
  async openMergedView() {
    this.key("?", { metaKey: true, shiftKey: true, code: "Slash" });
    await this.settle(40);
  }
  async openMemo() {
    this.key("n", { metaKey: true, shiftKey: true, code: "KeyN" });
    await this.settle(40);
  }
  toggleDockMax() {
    this.key("'", { metaKey: true, shiftKey: true, code: "Quote" });
  }
  isDockMaximized() {
    return this.document.body.classList.contains("dock-maximized");
  }
  mergedModalText() {
    const host = this.$("#mc-merged-panel .mc-merged-editor-host");
    if (!host) return null;
    return Array.from(host.children).map((node) => node.textContent).join("\n");
  }
  async writeAndSaveWithKeyboard(text) {
    const input = this.visibleComposerInput();
    if (!input) throw new Error("writeAndSaveWithKeyboard: no visible composer input");
    this.typeInto(input, text);
    input.dispatchEvent(
      new this.window.KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await this.settle(40);
  }
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function deepFreeze(obj) {
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

function installMonacoMock(window) {
  const models = [];
  const editors = [];
  const providers = {};
  const openers = [];

  class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  }

  const parseUri = (raw) => {
    const match = /^([^:]+):\/\/[^/]*(\/.*)?$/.exec(String(raw));
    const scheme = match ? match[1] : "";
    const path = match ? (match[2] || "/") : String(raw);
    return { scheme, path, toString: () => String(raw) };
  };

  const createModel = (initialValue, language, uri) => {
    let value = String(initialValue || "");
    let disposed = false;
    const disposeListeners = [];
    const model = {
      uri,
      language,
      getValue: () => value,
      setValue: (next) => { value = String(next); },
      isDisposed: () => disposed,
      onWillDispose: (cb) => { disposeListeners.push(cb); return { dispose() {} }; },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        disposeListeners.forEach((cb) => cb());
      },
      getWordAtPosition(position) {
        const line = value.split(/\r?\n/)[Math.max(0, position.lineNumber - 1)] || "";
        const offset = Math.max(0, Math.min(line.length, position.column - 1));
        const wordPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
        for (const match of line.matchAll(wordPattern)) {
          const start = match.index;
          const end = start + match[0].length;
          if (offset >= start && offset <= end) return { word: match[0], startColumn: start + 1, endColumn: end + 1 };
        }
        return null;
      },
    };
    models.push(model);
    return model;
  };

  const createEditor = (host, options = {}) => {
    const liveOptions = { ...options };
    let model = options.model || null;
    let position = { lineNumber: 1, column: 1 };
    let cursorListener = null;
    const commands = [];
    const editor = {
      host,
      commands,
      options: liveOptions,
      onDidChangeCursorPosition(cb) { cursorListener = cb; return { dispose() {} }; },
      onDidLayoutChange() { return { dispose() {} }; },
      updateOptions(next) { Object.assign(liveOptions, next); },
      getLayoutInfo() { return { height: 800, width: 1200 }; },
      saveViewState() { return { position: { ...position } }; },
      restoreViewState(state) { if (state && state.position) position = { ...state.position }; },
      addCommand(keybinding, handler) { commands.push({ keybinding, handler }); return commands.length; },
      createDecorationsCollection(items = []) {
        return { items, clear() { this.items = []; } };
      },
      setPosition(next) {
        position = { ...next };
        if (cursorListener) cursorListener({ position });
      },
      getPosition: () => ({ ...position }),
      getAction(id) {
        return { run() { editor.lastAction = id; } };
      },
      revealPositionInCenterIfOutsideViewport() {},
      revealPositionInCenter() {},
      revealLineInCenterIfOutsideViewport() {},
      focus() { host.tabIndex = 0; host.focus(); },
      dispose() {},
      trigger() {},
      setModel(next) { model = next; },
      getModel: () => model,
    };
    editors.push(editor);
    return editor;
  };

  window.__monacoMock = { models, editors, providers, openers, themes: {} };
  window.monaco = {
    Range,
    Uri: { parse: parseUri },
    KeyMod: { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9 },
    KeyCode: { KeyB: 32, KeyF: 36, Digit8: 29, Slash: 85, Period: 84 },
    editor: {
      create: createEditor,
      createModel,
      defineTheme(name, definition) { window.__monacoMock.themes[name] = definition; },
      setTheme(theme) { window.__monacoMock.theme = theme; },
      registerEditorOpener(opener) { openers.push(opener); return { dispose() {} }; },
    },
    languages: {
      registerDefinitionProvider(_selector, provider) { providers.definition = provider; return { dispose() {} }; },
      registerReferenceProvider(_selector, provider) { providers.references = provider; return { dispose() {} }; },
      registerImplementationProvider(_selector, provider) { providers.implementation = provider; return { dispose() {} }; },
    },
  };
}
