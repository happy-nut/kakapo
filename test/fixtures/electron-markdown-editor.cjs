const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");

const editorBundle = readFileSync(process.argv[2], "utf8");
const css = readFileSync(process.argv[3], "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
html, body { width: 680px; height: 240px; overflow: hidden; }
body { display: block; padding: 24px; background: #272727; }
#host { width: 620px; min-height: 120px; }
</style></head><body><div id="host"></div></body></html>`;

function wait(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function type(window, value) {
  for (const character of value) {
    window.webContents.sendInputEvent({ type: "char", keyCode: character });
    await wait(8);
  }
  await wait();
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 700, height: 280 });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await window.webContents.executeJavaScript(`window.eval(${JSON.stringify(editorBundle)}); window.__memoEditor = window.KakapoMarkdownEditor.create({ element: document.getElementById('host'), markdown: '' }); window.__memoEditor.focus();`);
  await type(window, "[] ");

  const layout = await window.webContents.executeJavaScript(`(() => {
    const task = document.querySelector('ul[data-type="taskList"] > li[data-checked]');
    const editable = task && task.querySelector(':scope > div');
    const taskRect = task.getBoundingClientRect();
    const editableRect = editable.getBoundingClientRect();
    return {
      x: editableRect.left + Math.min(24, editableRect.width / 2),
      y: editableRect.top + Math.max(4, Math.min(12, editableRect.height / 2)),
      taskDisplay: getComputedStyle(task).display,
      taskTop: taskRect.top,
      editableTop: editableRect.top,
      editableWidth: editableRect.width,
    };
  })()`);

  window.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(layout.x), y: Math.round(layout.y), button: "left", clickCount: 1 });
  window.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(layout.x), y: Math.round(layout.y), button: "left", clickCount: 1 });
  await wait();
  await type(window, "typed after click");
  const markdown = await window.webContents.executeJavaScript("window.__memoEditor.getMarkdown()");
  process.stdout.write(`KAKAPO_MARKDOWN_EDITOR=${JSON.stringify({ ...layout, markdown })}\n`);
  window.destroy();
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  app.exit(1);
});
