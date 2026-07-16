const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");

const css = readFileSync(process.argv[2], "utf8");
const layers = readFileSync(process.argv[3], "utf8");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
html, body { width: 1000px; height: 500px; overflow: hidden; }
body { display: block; }
#surface { width: 900px; }
</style></head><body>
<div id="surface" class="d2h-files-diff">
  <div class="d2h-file-side-diff"><div class="d2h-code-wrapper"><table class="d2h-diff-table"><tbody>
    <tr><td><div class="d2h-code-side-line"><span class="d2h-code-line-ctn">base before</span></div></td><td class="d2h-code-side-linenumber">10</td></tr>
    <tr id="spacer-row" class="mc-spacer-row mc-comment-spacer-row"><td colspan="2"><div id="spacer" class="mc-comment-spacer"></div></td></tr>
    <tr><td id="old-follow"><div class="d2h-code-side-line"><span class="d2h-code-line-ctn">base after</span></div></td><td class="d2h-code-side-linenumber">11</td></tr>
  </tbody></table></div></div>
  <div class="d2h-file-side-diff"><div class="d2h-code-wrapper"><table class="d2h-diff-table"><tbody>
    <tr><td class="d2h-code-side-linenumber">10</td><td><div class="d2h-code-side-line"><span class="d2h-code-line-ctn">working before</span></div></td></tr>
    <tr id="comment-row" class="mc-comment-row"><td class="mc-thread-cell" colspan="2"><div class="mc-card mc-composer"><div class="mc-card-head"><span class="mc-kind">Question</span></div><textarea class="mc-input" rows="3">paired timeline</textarea><div class="mc-actions"><button class="mc-btn">Comment</button></div></div></td></tr>
    <tr><td class="d2h-code-side-linenumber">11</td><td id="new-follow"><div class="d2h-code-side-line"><span class="d2h-code-line-ctn">working after</span></div></td></tr>
  </tbody></table></div></div>
</div>
<script>${layers}</script>
<script>
installLayeredDiffGutters(document.getElementById('surface'));
document.getElementById('spacer').style.height = document.getElementById('comment-row').getBoundingClientRect().height + 'px';
refreshLayeredDiffGutters(document.getElementById('surface'));
</script></body></html>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 500 });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const result = await window.webContents.executeJavaScript(`(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const comment = document.getElementById('comment-row').getBoundingClientRect();
    const spacer = document.getElementById('spacer-row').getBoundingClientRect();
    const oldFollow = document.getElementById('old-follow').getBoundingClientRect();
    const newFollow = document.getElementById('new-follow').getBoundingClientRect();
    const spacerBackground = getComputedStyle(document.querySelector('#spacer-row td')).backgroundColor;
    const bodyBackground = getComputedStyle(document.body).backgroundColor;
    document.getElementById('comment-row').remove();
    document.getElementById('spacer-row').remove();
    refreshLayeredDiffGutters(document.getElementById('surface'));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const oldRemoved = document.getElementById('old-follow').getBoundingClientRect();
    const newRemoved = document.getElementById('new-follow').getBoundingClientRect();
    return {
      pairedHeightGap: Math.abs(comment.height - spacer.height),
      openFollowTopGap: Math.abs(oldFollow.top - newFollow.top),
      removedFollowTopGap: Math.abs(oldRemoved.top - newRemoved.top),
      backgroundMatches: spacerBackground === bodyBackground,
    };
  })()`);
  process.stdout.write(`KAKAPO_COMMENT_LAYOUT=${JSON.stringify(result)}\n`);
  window.destroy();
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  app.exit(1);
});
