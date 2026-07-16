// Load a standalone review HTML into jsdom and drive it like a user would.
//
// The page ships its client as one inline <script> (viewer.client.js). jsdom runs it for us when
// `runScripts: "dangerously"` is set; `beforeParse` installs the handful of browser APIs the viewer
// feature-detects (IntersectionObserver, ResizeObserver, matchMedia, scrollTo) so the script boots
// without throwing. We give the document a real http origin so localStorage works — the viewer keys
// its persistence on `location.pathname`, and an opaque (file://) origin would make localStorage
// throw on access.
//
// Helpers below speak in the viewer's own vocabulary (open a file, click a line, open the composer,
// save) and deliberately locate the *visible* composer the way a user's eyes would — never by raw
// DOM order — so a test that "types and saves" exercises the same wrong-textarea hazard the
// regression came from, instead of papering over it.
import { JSDOM } from "jsdom";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} html standalone review HTML
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.seedStorage] localStorage entries to install BEFORE the
 *   viewer boots — used to simulate "reopen the app" so persistence/restore can be asserted.
 */
export async function loadViewer(html, opts = {}) {
  const dom = new JSDOM(html, {
    url: "http://localhost/review.html",
    runScripts: "dangerously",
    pretendToBeVisual: true, // provides requestAnimationFrame/cancelAnimationFrame
    beforeParse(window) {
      if (opts.seedStorage) {
        for (const [k, val] of Object.entries(opts.seedStorage)) {
          try {
            window.localStorage.setItem(k, val);
          } catch {
            /* localStorage not ready — caller falls back to a same-instance assertion */
          }
        }
      }
      if (opts.seedSession) {
        // sessionStorage holds the UI restore state (open tabs, view, caret) — seed it to simulate "reopen".
        for (const [k, val] of Object.entries(opts.seedSession)) {
          try { window.sessionStorage.setItem(k, val); } catch { /* not ready */ }
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
      window.IntersectionObserver = noopObserver;
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

      // The production editor is a lazy Tiptap bundle served by Electron's private asset scheme. jsdom
      // cannot fetch that scheme, so dock tests use a tiny contract-compatible inline editor; a separate
      // bundle test loads the real Tiptap runtime and verifies Markdown round-tripping/heading rendering.
      window.MonacoriMarkdownEditor = {
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
            focus() { editable.focus(); },
            destroy() {},
          };
        },
      };

      // Simulate Electron's settings bridge. contextBridge DEEP-FREEZES everything it exposes, so the
      // persisted `all` snapshot is immutable — the renderer must clone before mutating. Without this
      // the tests only ever exercise the localStorage path (plain mutable arrays) and miss the
      // "object is not extensible" class of bug entirely.
      if (opts.electronSettings) {
        const frozen = deepFreeze(JSON.parse(JSON.stringify(opts.electronSettings)));
        const writes = {};
        window.__electronWrites = writes;
        window.monacoriSettings = {
          all: frozen,
          set(key, value) {
            writes[key] = value;
          },
        };
      }
      // Electron's diff-update bridge: capture the listener so a test can push a watch-refresh payload.
      if (opts.menuBridge) {
        window.monacoriMenu = { onDiffUpdate: (cb) => { window.__diffUpdateCb = cb; } };
      }
      // lazy-LOAD source/diff bridge: serve source content + per-index diff bodies on demand, as
      // Electron/serve do. opts.getDiffBody(index, kind) lets a test swap the served body between builds
      // (watch refresh), which is how the stale-bodyCache regression is reproduced.
      if (opts.lazySourceData != null || opts.getDiffBody || opts.sourceBridge) {
        let sourceRecords = [];
        try { sourceRecords = JSON.parse(opts.lazySourceData ?? "[]"); } catch { sourceRecords = []; }
        window.__sourceRequests = [];
        window.__projectIndexRequests = 0;
        window.monacoriFile = {
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
            return Promise.resolve(opts.sourceBridge ? opts.sourceBridge(path) : sourceRecords.find((record) => record.path === path) || null);
          },
          get: (index, kind) => Promise.resolve(opts.getDiffBody ? opts.getDiffBody(Number(index), kind) : ""),
          getDiffContext: opts.diffContextBridge
            ? (request) => Promise.resolve(opts.diffContextBridge(request))
            : undefined,
        };
      }
      if (opts.searchBridge) {
        window.monacoriSearch = {
          query: (request) => Promise.resolve(opts.searchBridge(request)),
        };
      }
      if (opts.analysisBridge) {
        window.monacoriAnalysis = {
          query: (request) => Promise.resolve(opts.analysisBridge(request)),
          status: () => Promise.resolve(opts.analysisStatus || {
            generation: 0,
            phase: "idle",
            updatedAt: new Date(0).toISOString(),
          }),
          onStatus: (cb) => { window.__analysisStatusCb = cb; },
        };
      }
      if (opts.memoBridge) {
        const state = JSON.parse(JSON.stringify(opts.memoBridge));
        state.body = typeof state.body === "string" ? state.body : "";
        state.updatedAt = state.updatedAt || null;
        const operations = [];
        window.__memoOperations = operations;
        window.monacoriMemo = {
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
        window.monacoriPerf = { mark: (name, details) => opts.perfBridge(name, details) };
      }
      if (opts.monacoBridge) installMonacoMock(window);
    },
  });

  const { window } = dom;
  const { document } = window;
  // Let the inline script finish its synchronous boot + any 0ms timers (lazy-diff setup, the initial
  // refreshComments, the composer focus retry interval which caps at ~300ms).
  await tick(60);

  const api = new Viewer(dom, window, document);
  return api;
}

class Viewer {
  constructor(dom, window, document) {
    this.dom = dom;
    this.window = window;
    this.document = document;
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  close() {
    this.window.close();
  }
  /** Wait for the viewer's async work (focus retry interval, in-place re-renders) to settle. */
  settle(ms = 50) {
    return tick(ms);
  }
  /** Simulate a watch refresh (Electron diff-update) with a hand-built payload. Needs { menuBridge: true }. */
  async pushDiffUpdate(payload) {
    const cb = this.window.__diffUpdateCb;
    if (!cb) throw new Error("pushDiffUpdate: no diff-update listener (pass { menuBridge: true })");
    cb(payload);
    await this.settle(80);
  }
  /** Read the persisted comments exactly as the viewer wrote them to localStorage. */
  storedComments() {
    const raw = this.window.localStorage.getItem("monacori-comments:/review.html");
    return raw ? JSON.parse(raw) : [];
  }
  /** What the simulated Electron settings bridge (monacoriSettings.set) was asked to persist. */
  electronWrites() {
    return this.window.__electronWrites || {};
  }
  /** Snapshot the whole localStorage — feed it back via loadViewer(html, { seedStorage }). */
  exportStorage() {
    const out = {};
    const ls = this.window.localStorage;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      out[k] = ls.getItem(k);
    }
    return out;
  }

  // ---- queries ---------------------------------------------------------------------------------
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
  /** The change-list file currently marked active (i.e. the file the diff is showing), or null. */
  activeDiffFile() {
    const link = this.$("#changes-panel .file-link.active");
    return link ? link.dataset.file || null : null;
  }
  /** Is the quick-open (Shift Shift / Cmd+E / find-in-files) overlay visible? */
  quickOpenVisible() {
    const qo = this.$("#quick-open");
    return !!(qo && !qo.classList.contains("hidden"));
  }
  /** The composer textarea the user can actually see — the gate the regression turned on. */
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
  /** Text bodies of saved comment cards rendered in whichever view is on screen. */
  visibleCardTexts() {
    const root = this.visibleView() === "diff" ? "#diff2html-container" : "#source-body";
    return this.$all(`${root} .mc-card:not(.mc-composer) .mc-card-body`).map((b) => b.textContent);
  }
  /** The comment box currently selected via arrow-key navigation (caret-stop), in the on-screen view. */
  selectedCommentBox() {
    const root = this.visibleView() === "diff" ? "#diff2html-container" : "#source-body";
    return this.$(`${root} .mc-comment-row.mc-row-selected`);
  }
  /** The diff row the caret currently sits on (mc-diff-cursor-row), or null when none is rendered. */
  diffCaretRow() {
    return this.$("#diff2html-container .mc-diff-cursor-row");
  }
  /** The new-side line number the diff caret is on, or null. */
  diffCaretLine() {
    const row = this.diffCaretRow();
    const n = row && row.querySelector(".d2h-code-side-linenumber");
    const v = n ? parseInt((n.textContent || "").trim(), 10) : NaN;
    return Number.isFinite(v) ? v : null;
  }

  // ---- low-level events ------------------------------------------------------------------------
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

  // ---- viewer vocabulary -----------------------------------------------------------------------
  async openSourceFile(path) {
    // lazy-LOAD keeps the Files tree as an inert island until its tab is shown — materialize it first.
    if (!this.document.querySelector(".source-link")) {
      const filesTab = this.document.querySelector('.tab[data-tab="files"]');
      if (filesTab) {
        this.click(filesTab);
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
  }
  async openDiffFor(path) {
    const row =
      this.document.querySelector(`.change-row[data-file="${cssEscape(path)}"]`) ||
      this.document.querySelector(".change-row, #changes-panel .file-link");
    this.click(row);
    await this.settle(80);
  }
  /** Place the caret on a source row by its 0-based line index (markdown/csv rows are sparse). */
  async clickSourceLine(lineIndex) {
    const row = this.document.querySelector(`.source-row[data-line-index="${lineIndex}"]`);
    if (!row) throw new Error(`clickSourceLine: no source row at line-index ${lineIndex}`);
    this.click(row.querySelector(".source-code") || row);
    await this.settle(20);
  }
  /** Place the caret on the first changed line of the active diff (right/new side). */
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
  /** Open the composer for the caret line. kind: 'q' (question, "?") or 'c' (change request, ">"). */
  async openComposer(kind = "q") {
    this.key(kind === "q" ? "?" : ">");
    await this.settle(40);
  }
  /** Type into the *visible* composer and click its own Save ("Comment") button. */
  async writeAndSave(text) {
    const input = this.visibleComposerInput();
    if (!input) throw new Error("writeAndSave: no visible composer input");
    this.typeInto(input, text);
    const saveBtn = input.closest(".mc-comment-row").querySelector(".mc-save");
    this.click(saveBtn);
    await this.settle(40);
  }
  /** Toggle markdown/CSV between rendered and raw line-numbered text (the toolbar button). */
  async clickRenderToggle() {
    const btn = this.$("#render-toggle");
    if (!btn || btn.classList.contains("hidden")) throw new Error("render toggle not available");
    this.click(btn);
    await this.settle(60);
  }
  /** 0-based line indices of the rows currently in the source body, in document order. */
  sourceRowLineIndices() {
    return this.$all("#source-body .source-row").map((r) => Number(r.dataset.lineIndex));
  }
  /** Open the merged-prompt modal (Cmd+Shift+/ for questions, Cmd+Shift+. for change requests). */
  async openMergedView(kind = "q") {
    this.key(kind === "q" ? "?" : ">", {
      metaKey: true,
      shiftKey: true,
      code: kind === "q" ? "Slash" : "Period",
    });
    await this.settle(40);
  }
  /** Toggle the prompt memo dock (Cmd/Ctrl+Shift+N). */
  async openMemo() {
    this.key("n", { metaKey: true, shiftKey: true, code: "KeyN" });
    await this.settle(40);
  }
  /** Maximize/restore the active dock (Cmd/Ctrl+Shift+'). */
  toggleDockMax() {
    this.key("'", { metaKey: true, shiftKey: true, code: "Quote" });
  }
  /** Is the bottom dock currently maximized over the editor area? */
  isDockMaximized() {
    return this.document.body.classList.contains("dock-maximized");
  }
  /** The rendered text of the open merged-prompt document, or null if none is open. */
  mergedModalText() {
    const document = this.$("#mc-merged-panel .mc-merged-preview");
    return document ? document.textContent : null;
  }
  /** Type into the visible composer and save with Cmd+Enter (the keyboard path). */
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

// Minimal CSS.escape for attribute selectors (jsdom has CSS.escape, but keep helpers self-contained).
function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

// Recursively freeze an object graph the way Electron's contextBridge does to exposed values.
function deepFreeze(obj) {
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

// Monaco itself is exercised in the packaged Electron smoke pass. jsdom gets a deliberately small API
// double so viewer tests can lock down our integration contract (models, providers, cursor sync, Peek)
// without evaluating Monaco's browser workers in Node.
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
    KeyCode: { KeyB: 32, Digit8: 29, Slash: 85, Period: 84 },
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
