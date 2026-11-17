import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewWorkspaceOptions, ReviewWorkspaceSnapshot } from "./review-workspace.js";
import type { SourceFile } from "./types.js";

export type BuildSnapshot = Omit<ReviewWorkspaceSnapshot, "html">;

type WorkerReply = { id: number; ok: true; snapshot?: BuildSnapshot; sourceFiles?: SourceFile[] } | { id: number; ok: false; error: string };

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
      if (this.pending.size === 0) worker.unref();
      if (reply.ok) entry.resolve(reply.snapshot ?? reply.sourceFiles);
      else entry.reject(new Error(reply.error));
    });
    worker.on("error", (error) => this.failAll(error));
    worker.on("exit", (code) => { if (code !== 0) this.failAll(new Error(`review build worker exited (code ${code})`)); this.worker = undefined; });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.worker = undefined;
  }

  private request<T>(message: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    worker.ref();
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

  warmUp(): void { this.ensureWorker(); }
}
