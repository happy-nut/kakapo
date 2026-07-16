const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");

app.commandLine.appendSwitch("disable-gpu");

const cssPath = process.argv[2];
const layerScriptPath = process.argv[3];
const css = readFileSync(cssPath, "utf8");
const layerScript = readFileSync(layerScriptPath, "utf8");
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css}
html, body { width: 1100px; height: 300px; overflow: hidden; }
body { display: block; }
#surface { width: 1000px; height: 160px; }
#surface .d2h-file-side-diff { height: 220px; }
#surface .wide { display: block; width: 1800px; white-space: nowrap; }
</style></head><body>
<div id="surface" class="d2h-files-diff">
  <div id="old-side" class="d2h-file-side-diff"><div class="d2h-code-wrapper">
    <table class="d2h-diff-table"><tbody><tr>
      <td id="old-code" class="d2h-del"><div class="d2h-code-side-line"><span id="old-text" class="d2h-code-line-ctn wide">base content wider than its pane</span></div></td>
      <td id="old-number" class="d2h-code-side-linenumber">1348</td>
    </tr></tbody></table>
  </div></div>
  <div id="new-side" class="d2h-file-side-diff"><div class="d2h-code-wrapper">
    <table class="d2h-diff-table"><tbody><tr>
      <td id="new-number" class="d2h-code-side-linenumber">1542</td>
      <td id="new-code" class="d2h-ins"><div class="d2h-code-side-line"><span id="new-text" class="d2h-code-line-ctn wide">working content wider than its pane</span></div></td>
    </tr><tr class="mc-comment-row"><td id="comment-cell" class="mc-thread-cell" colspan="2">
      <div id="comment-card" class="mc-card mc-composer">
        <div class="mc-card-head"><span class="mc-kind">Question</span><span class="mc-target">fixture.ts:1542</span></div>
        <textarea id="comment-input" class="mc-input" rows="3">Comment remains visible at maximum horizontal scroll.</textarea>
        <div class="mc-actions"><button id="comment-save" type="button" class="mc-btn mc-save">Comment</button><button type="button" class="mc-btn mc-ghost">Cancel</button></div>
      </div>
    </td></tr></tbody></table>
  </div></div>
  <svg class="mc-diff-connectors" aria-hidden="true"></svg>
</div>
<script>${layerScript}</script>
<script>installLayeredDiffGutters(document.getElementById('surface'));</script>
</body></html>`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1100, height: 300 });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const result = await window.webContents.executeJavaScript(`(async () => {
    const oldSide = document.getElementById('old-side');
    const newSide = document.getElementById('new-side');
    const oldGutter = oldSide.querySelector('.mc-diff-gutter-layer');
    const newGutter = newSide.querySelector('.mc-diff-gutter-layer');
    const oldVisibleNumber = oldGutter.querySelector('.mc-diff-gutter-number');
    const newVisibleNumber = newGutter.querySelector('.mc-diff-gutter-number');
    const initialOldTextRect = document.getElementById('old-text').getBoundingClientRect();
    const initialNewTextRect = document.getElementById('new-text').getBoundingClientRect();
    const initialOldAnchorRect = document.getElementById('old-number').getBoundingClientRect();
    const initialNewAnchorRect = document.getElementById('new-number').getBoundingClientRect();
    const initialCommentCellRect = document.getElementById('comment-cell').getBoundingClientRect();
    const initialCommentCardRect = document.getElementById('comment-card').getBoundingClientRect();
    oldSide.scrollLeft = oldSide.scrollWidth - oldSide.clientWidth;
    newSide.scrollLeft = newSide.scrollWidth - newSide.clientWidth;
    // Native sticky positioning must already be correct in the scroll event's own task. A transform-based
    // requestAnimationFrame catch-up would leave the immediate measurements displaced by scrollLeft.
    oldSide.dispatchEvent(new Event('scroll'));
    newSide.dispatchEvent(new Event('scroll'));
    const immediateOldSideRect = oldSide.getBoundingClientRect();
    const immediateNewSideRect = newSide.getBoundingClientRect();
    const immediateOldNumberRect = oldVisibleNumber.getBoundingClientRect();
    const immediateNewNumberRect = newVisibleNumber.getBoundingClientRect();
    const immediateOldCodeRect = document.getElementById('old-code').getBoundingClientRect();
    const immediateNewCodeRect = document.getElementById('new-code').getBoundingClientRect();
    const immediateCommentCellRect = document.getElementById('comment-cell').getBoundingClientRect();
    const immediateCommentCardRect = document.getElementById('comment-card').getBoundingClientRect();
    const immediateCommentSaveRect = document.getElementById('comment-save').getBoundingClientRect();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const oldSideRect = oldSide.getBoundingClientRect();
    const newSideRect = newSide.getBoundingClientRect();
    const oldNumberRect = oldVisibleNumber.getBoundingClientRect();
    const newNumberRect = newVisibleNumber.getBoundingClientRect();
    const oldAnchorRect = document.getElementById('old-number').getBoundingClientRect();
    const newAnchorRect = document.getElementById('new-number').getBoundingClientRect();
    const oldCodeRect = document.getElementById('old-code').getBoundingClientRect();
    const newCodeRect = document.getElementById('new-code').getBoundingClientRect();
    const oldTextRect = document.getElementById('old-text').getBoundingClientRect();
    const newTextRect = document.getElementById('new-text').getBoundingClientRect();
    const commentCellRect = document.getElementById('comment-cell').getBoundingClientRect();
    const commentCardRect = document.getElementById('comment-card').getBoundingClientRect();
    const commentInputRect = document.getElementById('comment-input').getBoundingClientRect();
    const commentSaveRect = document.getElementById('comment-save').getBoundingClientRect();
    const oldRowBeforeTransform = document.getElementById('old-code').getBoundingClientRect();
    const oldGutterBeforeTransform = oldVisibleNumber.getBoundingClientRect();
    const newRowBeforeTransform = document.getElementById('new-code').getBoundingClientRect();
    const newGutterBeforeTransform = newVisibleNumber.getBoundingClientRect();
    oldSide.querySelector('.mc-diff-layer-stack').style.transform = 'translate3d(0, 17px, 0)';
    newSide.querySelector('.mc-diff-layer-stack').style.transform = 'translate3d(0, 17px, 0)';
    const oldRowAfterTransform = document.getElementById('old-code').getBoundingClientRect();
    const oldGutterAfterTransform = oldVisibleNumber.getBoundingClientRect();
    const newRowAfterTransform = document.getElementById('new-code').getBoundingClientRect();
    const newGutterAfterTransform = newVisibleNumber.getBoundingClientRect();
    return {
      oldScrollLeft: oldSide.scrollLeft,
      newScrollLeft: newSide.scrollLeft,
      gutterLayerCount: document.querySelectorAll('.mc-diff-gutter-layer').length,
      visibleOriginalNumberCount: Array.from(document.querySelectorAll('.d2h-code-side-linenumber')).filter((node) => getComputedStyle(node).visibility !== 'hidden').length,
      oldAppliedOffset: parseFloat(getComputedStyle(oldSide).getPropertyValue('--mc-diff-gutter-offset')) || 0,
      newAppliedOffset: parseFloat(getComputedStyle(newSide).getPropertyValue('--mc-diff-gutter-offset')) || 0,
      immediateOldDividerGap: Math.abs(immediateOldSideRect.right - immediateOldNumberRect.right),
      immediateNewDividerGap: Math.abs(immediateNewSideRect.left - immediateNewNumberRect.left),
      immediateOldBandGap: Math.max(0, immediateOldNumberRect.left - immediateOldCodeRect.right),
      immediateNewBandGap: Math.max(0, immediateNewCodeRect.left - immediateNewNumberRect.right),
      oldDividerGap: Math.abs(oldSideRect.right - oldNumberRect.right),
      newDividerGap: Math.abs(newSideRect.left - newNumberRect.left),
      oldNumberWidth: oldNumberRect.width,
      newNumberWidth: newNumberRect.width,
      oldBandGap: Math.max(0, oldNumberRect.left - oldCodeRect.right),
      newBandGap: Math.max(0, newCodeRect.left - newNumberRect.right),
      oldTextTravel: oldTextRect.left - initialOldTextRect.left,
      newTextTravel: newTextRect.left - initialNewTextRect.left,
      oldAnchorTravel: oldAnchorRect.left - initialOldAnchorRect.left,
      newAnchorTravel: newAnchorRect.left - initialNewAnchorRect.left,
      initialCommentCellLeft: initialCommentCellRect.left,
      initialCommentCardLeft: initialCommentCardRect.left,
      immediateCommentCellGap: immediateCommentCellRect.left - immediateNewNumberRect.right,
      immediateCommentCardGap: immediateCommentCardRect.left - immediateNewNumberRect.right,
      immediateCommentRightOverflow: Math.max(0, immediateCommentCardRect.right - immediateNewSideRect.right),
      immediateCommentButtonClip: Math.max(0, immediateNewNumberRect.right - immediateCommentSaveRect.left),
      commentCellGap: commentCellRect.left - newNumberRect.right,
      commentCardGap: commentCardRect.left - newNumberRect.right,
      commentRightOverflow: Math.max(0, commentCardRect.right - newSideRect.right),
      commentInputRightOverflow: Math.max(0, commentInputRect.right - newSideRect.right),
      commentButtonClip: Math.max(0, newNumberRect.right - commentSaveRect.left),
      commentCellTravel: commentCellRect.left - initialCommentCellRect.left,
      commentCardTravel: commentCardRect.left - initialCommentCardRect.left,
      oldVerticalLock: (oldRowAfterTransform.top - oldRowBeforeTransform.top) - (oldGutterAfterTransform.top - oldGutterBeforeTransform.top),
      newVerticalLock: (newRowAfterTransform.top - newRowBeforeTransform.top) - (newGutterAfterTransform.top - newGutterBeforeTransform.top),
    };
  })()`);
  process.stdout.write(`MONACORI_DIFF_LAYOUT=${JSON.stringify(result)}\n`);
  window.destroy();
  app.exit(0);
}).catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  app.exit(1);
});
