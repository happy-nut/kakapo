// Runs the review build off the Electron main process. The build path (writeReviewWorkspace /
// collectReviewSourceIndex) is deliberately free of BrowserWindow/app types, so it runs unchanged here in a
// worker thread. Only a compact snapshot crosses back to main — never the ~780KB HTML, which the worker
// writes straight to the review file. See ReviewBuilder (review-builder.ts) for the main-side manager.
import { parentPort } from "node:worker_threads";
import { collectReviewSourceIndex, writeReviewWorkspace, type ReviewWorkspaceOptions } from "./review-workspace.js";
import { errorMessage } from "./util.js";

type BuildRequest = { id: number; kind: "build"; target: string; options: ReviewWorkspaceOptions; title: string; deferFullIndex: boolean };
type IndexRequest = { id: number; kind: "index"; options: ReviewWorkspaceOptions; reviewBase?: string; reviewTarget?: string };

if (!parentPort) throw new Error("build-worker must run as a worker thread");
const port = parentPort;

port.on("message", (msg: BuildRequest | IndexRequest) => {
  try {
    if (msg.kind === "build") {
      const snapshot = writeReviewWorkspace(msg.target, msg.options, msg.title, msg.deferFullIndex);
      // The HTML is already written to `target`; shipping the string back would add ~780KB to every clone.
      const { html: _html, ...rest } = snapshot;
      port.postMessage({ id: msg.id, ok: true, snapshot: rest });
    } else {
      const sourceFiles = collectReviewSourceIndex(msg.options, msg.reviewBase, msg.reviewTarget);
      port.postMessage({ id: msg.id, ok: true, sourceFiles });
    }
  } catch (error) {
    port.postMessage({ id: msg.id, ok: false, error: errorMessage(error) });
  }
});
