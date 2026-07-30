import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewWorkspaceOptions, ReviewWorkspaceSnapshot } from "./review-workspace.js";
import type { SourceFile } from "./types.js";

// The build snapshot as it crosses back from the worker — everything writeReviewWorkspace returns except the
// HTML string (the worker wrote that to the review file, so main never needs it in memory).
export type BuildSnapshot = Omit<ReviewWorkspaceSnapshot, "html">;

type WorkerReply = { id: number; ok: true; snapshot?: BuildSnapshot; sourceFiles?: SourceFile[] } | { id: number; ok: false; error: string };

// Owns the single worker thread that runs every review build. Keeping the build off the main process means a
// rebuild never blocks the main loop's IPC / terminal I/O — the main thread only pays the compact snapshot
// clone (~7-14ms for a 6k-file index) instead of the ~90-180ms build itself. Requests are correlated by id;
// a worker crash rejects everything in flight and the next request respawns.
export class ReviewBuilder {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(join(dirname(fileURLToPath(import.meta.url)), "build-worker.js"));
    worker.on("message", (reply: WorkerReply) => {
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      this.pending.delete(reply.id);
      if (this.pending.size === 0) worker.unref(); // idle again — don't keep the process alive on quit
      if (reply.ok) entry.resolve(reply.snapshot ?? reply.sourceFiles);
      else entry.reject(new Error(reply.error));
    });
    worker.on("error", (error) => this.failAll(error));
    worker.on("exit", (code) => { if (code !== 0) this.failAll(new Error(`review build worker exited (code ${code})`)); this.worker = undefined; });
    worker.unref(); // idle by default; ref()'d only while a build is in flight (see request)
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.worker = undefined; // the next request respawns a fresh worker
  }

  private request<T>(message: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    worker.ref(); // keep the process/event loop alive while this build is in flight; unref'd when it drains
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, ...message });
    });
  }

  build(target: string, options: ReviewWorkspaceOptions, title: string, deferFullIndex: boolean): Promise<BuildSnapshot> {
    return this.request<BuildSnapshot>({ kind: "build", target, options, title, deferFullIndex });
  }

  index(options: ReviewWorkspaceOptions, reviewBase?: string, reviewTarget?: string): Promise<SourceFile[]> {
    return this.request<SourceFile[]>({ kind: "index", options, reviewBase, reviewTarget });
  }

  // Spawn the worker eagerly (at app startup) so the first window's boot build doesn't pay worker-startup cost.
  warmUp(): void { this.ensureWorker(); }
}
