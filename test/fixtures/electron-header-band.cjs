// The header band is a layout fact, so it needs a browser. jsdom reports every height as 0, which is why
// the seam this measures could drift without one test in the suite noticing.
const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");

const css = readFileSync(process.argv[2], "utf8");
// <body> carries no class, which is what render.ts emits.
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css}
html, body { width: 1000px; height: 640px; overflow: hidden; }
* { transition: none !important; animation: none !important; }
</style></head><body>
  <aside class="sidebar"><div id="sidebar-brand" class="sidebar-brand"><span class="brand-project">Project</span></div><div class="sidebar-scroll"></div></aside>
  <main class="content">
    <section id="diff-view">
      <div id="review-bar" class="toolbar diff-toolbar"><span id="review-title">project / changed-file.ts</span></div>
    </section>
    <section id="source-view" class="hidden">
      <div id="source-bar" class="toolbar source-toolbar"><span id="source-title">file.ts</span></div>
    </section>
  </main>
</body></html>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 640 });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const result = await window.webContents.executeJavaScript(`(() => {
    const box = (id) => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { top: rect.top, height: rect.height, bottom: rect.bottom };
    };
    const brand = box('sidebar-brand');
    const diff = box('review-bar');
    // Only one content view is mounted at a time, so the source toolbar has to be measured in its own turn.
    document.getElementById('source-view').classList.remove('hidden');
    document.getElementById('diff-view').classList.add('hidden');
    void document.body.offsetWidth;
    const source = box('source-bar');
    const band = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-band')) || 0;
    return { band, brand, diff, source };
  })()`);
  process.stdout.write(`KAKAPO_HEADER_BAND=${JSON.stringify(result)}\n`);
  window.destroy();
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  app.exit(1);
});
