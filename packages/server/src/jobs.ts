import { EventEmitter } from "node:events";
import { Crawler } from "@mappy/engine";
import type { CrawlEvent, UiElement } from "@mappy/shared";
import type { Devices } from "./devices.ts";
import type { ProjectStore } from "./store.ts";

interface PendingApproval {
  requestId: string;
  projectId: string;
  element: UiElement;
  screenId: string;
  obsId: string;
  resolve: (allow: boolean) => void;
}

interface Job {
  crawler: Crawler;
  done: Promise<void>;
  log: CrawlEvent[];
}

/** Runs at most one crawl per device and relays crawl events to dashboard subscribers. */
export class CrawlManager {
  readonly events = new EventEmitter();
  private jobs = new Map<string, Job>();
  private approvals = new Map<string, PendingApproval>();
  private busyDevices = new Map<string, string>();
  private readonly store: ProjectStore;
  private readonly devices: Devices;

  constructor(store: ProjectStore, devices: Devices) {
    this.store = store;
    this.devices = devices;
    this.events.setMaxListeners(100);
  }

  private emit(e: CrawlEvent) {
    const job = this.jobs.get(e.projectId);
    if (job && (e.type === "log" || e.type === "approval")) {
      job.log.push(e);
      if (job.log.length > 500) job.log.shift();
    }
    this.events.emit("event", e);
  }

  isRunning(projectId: string): boolean {
    return this.jobs.has(projectId);
  }

  recentLog(projectId: string): CrawlEvent[] {
    return this.jobs.get(projectId)?.log ?? [];
  }

  pendingApprovals(projectId: string) {
    return [...this.approvals.values()].filter((a) => a.projectId === projectId).map(({ resolve: _r, ...rest }) => rest);
  }

  current(projectId: string) {
    return this.jobs.get(projectId)?.crawler.current() ?? null;
  }

  async start(projectId: string, opts: { resume: boolean }): Promise<void> {
    if (this.jobs.has(projectId)) throw new Error("This project is already crawling");
    const project = await this.store.get(projectId);
    const serial = project.device.serial;
    const busy = this.busyDevices.get(serial);
    if (busy) throw new Error(`Device ${serial} is busy with another crawl (${busy})`);
    const driver = this.devices.crawlDriver(serial);
    const files = this.store.filesOf(projectId);
    const crawler = new Crawler({
      driver,
      app: project.app,
      config: project.config,
      store: files,
      overrides: await this.store.overrides(projectId),
      projectId,
      onEvent: (e) => {
        this.emit(e);
        // Updates are queued per project, so these can't overwrite the final status written below.
        if (e.type === "status") void this.store.update(projectId, { status: e.status }).catch(() => {});
        if (e.type === "stats") void this.store.update(projectId, { stats: e.stats }).catch(() => {});
      },
      approve: (req) =>
        new Promise<boolean>((resolve) => {
          this.approvals.set(req.requestId, { ...req, projectId, resolve });
          this.emit({ type: "approval", projectId, ...req });
        }),
    });
    if (opts.resume) await crawler.restore();
    this.busyDevices.set(serial, projectId);
    await this.store.update(projectId, { status: "running", error: undefined });
    const job: Job = { crawler, log: [], done: Promise.resolve() };
    this.jobs.set(projectId, job);
    job.done = (async () => {
      try {
        const result = await crawler.run();
        const status = result === "stopped" ? "stopped" : "done";
        await this.store.update(projectId, { status, stats: crawler.stats() });
        this.emit({ type: "status", projectId, status });
      } catch (err) {
        const message = (err as Error).message;
        await this.store.update(projectId, { status: "error", error: message, stats: crawler.stats() }).catch(() => {});
        this.emit({ type: "log", projectId, level: "error", message, ts: Date.now() });
        this.emit({ type: "status", projectId, status: "error", error: message });
      } finally {
        this.jobs.delete(projectId);
        this.busyDevices.delete(serial);
        for (const [id, a] of this.approvals) {
          if (a.projectId === projectId) {
            a.resolve(false);
            this.approvals.delete(id);
          }
        }
      }
    })();
  }

  control(projectId: string, op: "pause" | "resume" | "takeover" | "stop"): void {
    const job = this.jobs.get(projectId);
    if (!job) throw new Error("No crawl is running for this project");
    if (op === "pause") job.crawler.pause("paused");
    else if (op === "takeover") job.crawler.pause("takeover");
    else if (op === "resume") job.crawler.resume();
    else {
      job.crawler.stop();
      for (const [id, a] of this.approvals) {
        if (a.projectId === projectId) {
          a.resolve(false);
          this.approvals.delete(id);
        }
      }
    }
  }

  approve(requestId: string, allow: boolean): void {
    const a = this.approvals.get(requestId);
    if (!a) throw new Error("Unknown or already answered approval request");
    this.approvals.delete(requestId);
    a.resolve(allow);
    this.emit({ type: "approvalResolved", projectId: a.projectId, requestId, allow });
  }

  async waitFor(projectId: string): Promise<void> {
    await this.jobs.get(projectId)?.done;
  }

  async stopAll(): Promise<void> {
    for (const id of this.jobs.keys()) this.control(id, "stop");
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }
}
