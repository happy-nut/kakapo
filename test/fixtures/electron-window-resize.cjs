const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");

const css = readFileSync(process.argv[2], "utf8");
const layers = readFileSync(process.argv[3], "utf8");
const rows = Array.from({ length: 700 }, (_, index) => {
  const line = index + 1;
  return `<tr><td class="d2h-code-side-linenumber">${line}</td><td class="d2h-code-side-line"><span class="d2h-code-line-ctn">const value_${line} = ${line};</span></td></tr>`;
}).join("");
const pane = `<div class="d2h-file-side-diff"><div class="d2h-code-wrapper"><table class="d2h-diff-table"><tbody>${rows}</tbody></table></div></div>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
html, body { width: 100%; height: 100%; overflow: hidden; }
* { transition: none !important; }
</style></head><body class="native-app">
  <nav class="activity-rail"></nav>
  <aside class="sidebar"><div class="sidebar-brand">Project</div><div class="sidebar-scroll"></div></aside>
  <main class="content">
    <section id="diff-view">
      <div class="toolbar diff-toolbar"><span>changed-file.ts</span></div>
      <div class="diff-pane-header"><div class="diff-pane">Base</div><div class="diff-pane">Working tree</div></div>
      <div id="diff2html-container" class="diff2html-container"><div class="d2h-wrapper"><div class="d2h-file-wrapper"><div class="d2h-files-diff">${pane}${pane}</div></div></div></div>
    </section>
  </main>
</body></html>`;

function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitForResize(window) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 300);
    window.once("resize", () => {
      clearTimeout(timer);
      setTimeout(resolve, 30);
    });
  });
}

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => {
    const body = document.body.getBoundingClientRect();
    const content = document.querySelector('.content').getBoundingClientRect();
    const toolbar = document.querySelector('.diff-toolbar').getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      bodyWidth: body.width,
      contentLeft: content.left,
      contentRight: content.right,
      contentWidth: content.width,
      toolbarRight: toolbar.right,
      gutterLayerCount: document.querySelectorAll('.mc-diff-gutter-layer').length,
      resizeSettled: typeof diffViewportResizing === 'undefined' || !diffViewportResizing,
    };
  })()`);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1240, height: 760 });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await window.webContents.executeJavaScript(`${layers}\ninstallLayeredDiffGutters(document.querySelector('.d2h-file-wrapper'));`);
  const before = await measure(window);

  let resized = waitForResize(window);
  window.setSize(1900, 1000, false);
  await resized;
  await pause(220);
  const after = await measure(window);

  resized = waitForResize(window);
  window.maximize();
  await resized;
  await pause(220);
  const afterMaximize = await measure(window);
  process.stdout.write(`KAKAPO_WINDOW_RESIZE=${JSON.stringify({ before, after, afterMaximize })}\n`);
  window.destroy();
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  app.exit(1);
});
