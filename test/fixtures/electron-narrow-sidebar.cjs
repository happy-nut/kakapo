const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");

const WIDTH = 820;
const HEIGHT = 700;

const css = readFileSync(process.argv[2], "utf8");
const rows = (n) => Array.from({ length: n }, (_, i) =>
  `<div class="tree-row" style="height:22px">file-${i}.ts</div>`).join("");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css}
* { transition: none !important; animation: none !important; }
</style></head><body>
  <aside class="sidebar">
    <div id="sidebar-brand" class="sidebar-brand"><span class="brand-project">Project</span></div>
    <div id="sidebar-scroll" class="sidebar-scroll">${rows(1)}</div>
  </aside>
  <main class="content" id="content">
    <div id="review-bar" class="toolbar diff-toolbar"><span id="review-title">one-file.ts</span></div>
  </main>
</body></html>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: WIDTH, height: HEIGHT });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const result = await window.webContents.executeJavaScript(`(() => {
    const sidebar = document.querySelector('.sidebar');
    const scroll = document.getElementById('sidebar-scroll');
    const content = document.getElementById('content');
    const read = () => ({
      sidebar: sidebar.getBoundingClientRect().height,
      content: content.getBoundingClientRect().top,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
    });
    const stacked = getComputedStyle(document.body).gridTemplateColumns.split(' ').length === 1;
    const short = read();
    // The review this bound was written for: more files than the band can hold.
    scroll.innerHTML = ${JSON.stringify(rows(42))};
    void document.body.offsetWidth;
    const long = read();
    return { stacked, viewport: innerHeight, short, long };
  })()`);
  process.stdout.write(`KAKAPO_NARROW_SIDEBAR=${JSON.stringify(result)}\n`);
  window.destroy();
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  app.exit(1);
});
