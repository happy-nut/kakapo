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
