const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");

const css = readFileSync(process.argv[2], "utf8");
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css}
html, body { width: 1000px; height: 640px; overflow: hidden; }
* { transition: none !important; }
</style></head><body class="native-app sidebar-collapsed">
  <nav class="activity-rail"><button id="rail-action" class="rail-btn" type="button">R</button></nav>
  <aside class="sidebar"><div id="sidebar-brand" class="sidebar-brand">Project</div><div class="sidebar-scroll"></div></aside>
  <main class="content">
    <section id="diff-view">
      <div id="review-bar" class="toolbar diff-toolbar"><span id="review-title">project / changed-file.ts</span></div>
    </section>
  </main>
  <section id="history-view" class="history-view hidden">
    <div id="history-bar" class="history-bar"><span id="history-title" class="history-title">History</span><input aria-label="Filter"></div>
    <div class="history-body"></div>
  </section>
  <section id="dock-panel" class="dock-panel" style="display:none">
    <div id="dock-bar" class="dock-bar"><span id="dock-title" class="dock-title">Prompt memo</span><button type="button" class="dock-btn">Close</button></div>
    <div class="dock-body"></div>
  </section>
</body></html>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 640 });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const result = await window.webContents.executeJavaScript(`(() => {
    const px = (value) => Number.parseFloat(value) || 0;
    const bodyStyle = getComputedStyle(document.body);
    const safeWidth = px(bodyStyle.getPropertyValue('--native-traffic-safe-width'));
    const titlebarHeight = px(bodyStyle.getPropertyValue('--native-titlebar-height'));
    document.body.classList.remove('sidebar-collapsed');
    const sidebar = document.querySelector('.sidebar');
    const sidebarBrandTop = document.getElementById('sidebar-brand').getBoundingClientRect().top;
    sidebar.classList.add('mc-panel-focus-flash');
    const sidebarFocusTop = px(getComputedStyle(sidebar, '::after').top);
    const sidebarFocusOutline = getComputedStyle(sidebar).outlineStyle;
    sidebar.classList.remove('mc-panel-focus-flash');
    const rail = document.querySelector('.activity-rail');
    rail.classList.add('mc-panel-focus-flash');
    const railFocusOutline = getComputedStyle(rail).outlineStyle;
    rail.classList.remove('mc-panel-focus-flash');
    document.body.classList.add('sidebar-collapsed');
    void document.body.offsetWidth;
    const reviewTitleLeft = document.getElementById('review-title').getBoundingClientRect().left;
    const railActionTop = document.getElementById('rail-action').getBoundingClientRect().top;

    document.getElementById('history-view').classList.remove('hidden');
    const historyTitleLeft = document.getElementById('history-title').getBoundingClientRect().left;
    const historyBarHeight = document.getElementById('history-bar').getBoundingClientRect().height;
    document.getElementById('history-view').classList.add('hidden');

    document.body.classList.add('dock-maximized');
    document.getElementById('dock-panel').style.display = 'flex';
    const dockTitleLeft = document.getElementById('dock-title').getBoundingClientRect().left;
    const dockBarHeight = document.getElementById('dock-bar').getBoundingClientRect().height;
    const dockButtonRegion = getComputedStyle(document.querySelector('#dock-bar button')).webkitAppRegion;
    return {
      safeWidth,
      titlebarHeight,
      sidebarBrandTop,
      sidebarFocusTop,
      sidebarFocusOutline,
      railFocusOutline,
      reviewTitleLeft,
      railActionTop,
      historyTitleLeft,
      historyBarHeight,
      dockTitleLeft,
      dockBarHeight,
      dockButtonRegion,
    };
  })()`);
  process.stdout.write(`MONACORI_NATIVE_TITLE_LAYOUT=${JSON.stringify(result)}\n`);
  window.destroy();
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  app.exit(1);
});
