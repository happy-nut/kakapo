#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { drive, makeRepo } from "./drive.mjs";

const repo = makeRepo("media");
for (const dir of ["assets", "docs"]) mkdirSync(join(repo.dir, dir), { recursive: true });

function ffmpeg(...args) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: repo.dir });
}

try {
  ffmpeg("-f", "lavfi", "-i", "color=c=crimson:s=320x200:d=1", "-frames:v", "1", "assets/banner.png");
} catch (error) {
  console.error("this check needs ffmpeg to make a real picture and a real video: " + error.message);
  process.exit(2);
}
repo.put("README.md", "# media\n\nA picture and a recording.\n");
repo.commit("initial");

ffmpeg("-f", "lavfi", "-i", "color=c=teal:s=320x200:d=1", "-frames:v", "1", "assets/banner.png");
ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x200:rate=12:duration=2", "-pix_fmt", "yuv420p", "docs/demo.mp4");

const sides = `(() => {
  const wrapper = Array.from(document.querySelectorAll('#diff2html-container .d2h-file-wrapper'))
    .find((w) => (w.dataset.path || '').endsWith(PATH));
  if (!wrapper) return { found: false };
  return {
    found: true,
    panes: wrapper.querySelectorAll('.media-diff-side').length,
    images: Array.from(wrapper.querySelectorAll('.media-diff-side img')).map((img) => img.naturalWidth),
    videos: Array.from(wrapper.querySelectorAll('.media-diff-side video')).map((v) => ({
      controls: v.hasAttribute('controls'), duration: Math.round((v.duration || 0) * 100) / 100, error: v.error ? v.error.code : 0,
    })),
    absent: wrapper.querySelectorAll('.media-diff-absent').length,
  };
})()`;
const forPath = (path) => sides.replace("PATH", JSON.stringify(path));

await drive("media-preview", repo, async (page, h) => {
  const picture = await h.until(`(${forPath("assets/banner.png")}).images.filter((w) => w > 0).length === 2`, 20000);
  const shown = await page.evaluate(forPath("assets/banner.png"));
  h.check(Boolean(picture), "a changed picture is two pictures, both drawn", JSON.stringify(shown));
  h.check(shown.panes === 2 && shown.absent === 0,
    "the base revision's and the working tree's, with neither pane reporting an absence", JSON.stringify(shown));
  await h.shot("1-picture-diff");

  const played = await h.until(`(${forPath("docs/demo.mp4")}).videos.some((v) => v.duration > 0)`, 20000);
  const video = await page.evaluate(forPath("docs/demo.mp4"));
  h.check(Boolean(played), "the recording is decoded — a duration means Chromium read the file, not just the element",
    JSON.stringify(video));
  h.check(video.videos.every((v) => v.controls && !v.error),
    "every player has its controls and none reported a decode error", JSON.stringify(video));
  h.check(video.absent === 1,
    "the recording is new, so the base pane says there is nothing there rather than showing a broken player",
    JSON.stringify(video));
  await h.shot("2-video-diff");

  await page.evaluate(`openSourceFile('docs/demo.mp4')`);
  await h.until(`sourceOpenPath() === 'docs/demo.mp4'`, 20000);
  const inSource = await h.until(`(() => { const v = document.querySelector('#source-body video.media-preview'); return v && v.duration > 0; })()`, 20000);
  h.check(Boolean(inSource), "and opening the file itself gives a player, not 'preview unavailable'");
  await h.shot("3-video-in-source-view");
});
