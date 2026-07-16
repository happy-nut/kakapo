import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { defaultMonacoriUserDataDirectory, workspacePerformanceDirectory } from "./workspace-data.js";

export type PerformanceDetails = Record<string, string | number | boolean | null | undefined>;

export type PerformanceEvent = {
  name: string;
  elapsedMs: number;
  at: string;
  details?: PerformanceDetails;
};

export type PerformanceSnapshot = {
  schemaVersion: 1;
  startedAt: string;
  root: string;
  pid: number;
  events: PerformanceEvent[];
};

// A deliberately small, inspectable performance trace. It captures user-visible milestones rather than
// profiler internals and writes plain JSON under the workspace's application-data mirror, so regressions
// can be compared without a hosted telemetry service or modifying the reviewed repository. The bounded
// event list prevents a long-running watch session from growing the artifact forever.
export class ReviewPerformanceTrace {
  private readonly clockStarted = performance.now();
  private readonly startedAt = new Date().toISOString();
  private readonly events: PerformanceEvent[] = [];

  constructor(readonly root: string, private readonly userData = defaultMonacoriUserDataDirectory()) {}

  mark(name: string, details?: PerformanceDetails): PerformanceEvent {
    const event: PerformanceEvent = {
      name,
      elapsedMs: Math.round((performance.now() - this.clockStarted) * 10) / 10,
      at: new Date().toISOString(),
      ...(details && Object.keys(details).length ? { details } : {}),
    };
    this.events.push(event);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    this.writeLatest();
    return event;
  }

  snapshot(): PerformanceSnapshot {
    return {
      schemaVersion: 1,
      startedAt: this.startedAt,
      root: this.root,
      pid: process.pid,
      events: this.events.map((event) => ({ ...event, details: event.details ? { ...event.details } : undefined })),
    };
  }

  private writeLatest(): void {
    try {
      const dir = workspacePerformanceDirectory(this.userData, this.root);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, "latest.json");
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.snapshot(), null, 2) + "\n");
      renameSync(temporary, target);
    } catch {
      // Performance evidence must never prevent the review itself from opening.
    }
  }
}
