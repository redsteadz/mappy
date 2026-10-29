import { newId, rectCenter, type Action, type AppInfo, type CrawlConfig, type CrawlEvent, type Observation, type Overrides, type Transition, type TransitionOutcome, type UiElement, type UiNode } from "@mappy/shared";
import type { Driver } from "../driver/driver.ts";
import { extractElements, inputValueFor } from "../hierarchy/elements.ts";
import { parseHierarchy } from "../hierarchy/parse.ts";
import { analyzeFrame, thumbDiff, type FrameInfo } from "../image/hash.ts";
import { computeSignature, ScreenClusterer } from "./abstraction.ts";
import { classifyForeign, isPermissionPkg } from "./guardrails.ts";
import { emptyCrawlState, type CrawlState, type CrawlStore } from "./store.ts";

export interface CrawlerOptions {
  driver: Driver;
  app: AppInfo;
  config: CrawlConfig;
  store: CrawlStore;
  overrides?: Overrides;
  onEvent?: (e: CrawlEvent) => void;
  /** Called for risky elements (policy "ask") and permission prompts (policy "ask"). */
  approve?: (req: { requestId: string; element: UiElement; screenId: string; obsId: string }) => Promise<boolean>;
  projectId?: string;
  /** Inject time for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type CrawlResult = "done" | "stopped" | "budget";

interface Current {
  obs: Observation;
  key: string;
  nodes: UiNode[] | null;
  elements: UiElement[];
}

interface NavEdge {
  from: string;
  to: string;
  action: Action;
}

const ROLE_ORDER: Record<UiElement["role"], number> = {
  input: 0,
  tab: 1,
  nav: 2,
  menu: 3,
  listItem: 4,
  button: 5,
  other: 6,
  toggle: 7,
  scroll: 9,
};

const MAX_SCROLLS = 3;

export class Crawler {
  private readonly o: CrawlerOptions;
  private readonly cfg: CrawlConfig;
  private readonly pkg: string;
  private clusterer: ScreenClusterer;
  private state: CrawlState = emptyCrawlState();
  private seq = 0;
  private actionCount = 0;
  private startedAt = 0;
  private lastObs = new Map<string, Observation>();
  private elementsCache = new Map<string, UiElement[]>();
  private nodesCache = new Map<string, UiNode[] | null>();
  private navEdges: NavEdge[] = [];
  private depth = new Map<string, number>();
  private startKey: string | null = null;
  private stopped = false;
  private pauseMode: "running" | "paused" | "takeover" = "running";
  private pauseWaiters: (() => void)[] = [];
  private resyncAfterPause = false;
  private lastCurrent: Current | null = null;
  private deviceInfo: { widthPx: number; heightPx: number } | null = null;

  constructor(opts: CrawlerOptions) {
    this.o = opts;
    this.cfg = opts.config;
    this.pkg = opts.app.pkg;
    this.clusterer = new ScreenClusterer(this.pkg, this.cfg.similarity, opts.overrides);
  }

  // ---- controls ------------------------------------------------------------

  stop(): void {
    this.stopped = true;
    this.wake();
  }

  pause(mode: "paused" | "takeover" = "paused"): void {
    this.pauseMode = mode;
    if (mode === "takeover") this.resyncAfterPause = true;
    this.emitStatus(mode);
  }

  resume(): void {
    if (this.pauseMode === "running") return;
    this.pauseMode = "running";
    this.emitStatus("running");
    this.wake();
  }

  get isPaused(): boolean {
    return this.pauseMode !== "running";
  }

  private wake() {
    const w = this.pauseWaiters;
    this.pauseWaiters = [];
    w.forEach((f) => f());
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.pauseMode !== "running" && !this.stopped) {
      await new Promise<void>((r) => this.pauseWaiters.push(r));
    }
  }

  // ---- helpers -------------------------------------------------------------

  private now = () => (this.o.now ? this.o.now() : Date.now());
  private sleep = (ms: number) => (this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)));

  private emit(e: CrawlEvent) {
    this.o.onEvent?.(e);
  }
  private log(level: "info" | "warn" | "error", message: string) {
    this.emit({ type: "log", projectId: this.o.projectId ?? "", level, message, ts: this.now() });
  }
  private emitStatus(status: "running" | "paused" | "takeover") {
    this.emit({ type: "status", projectId: this.o.projectId ?? "", status });
  }

  private screenCount(): number {
    return this.clusterer.clusterKeys().filter((k) => !k.startsWith("x-")).length;
  }

  private budgetExceeded(): string | null {
    if (this.actionCount >= this.cfg.maxActions) return `action budget (${this.cfg.maxActions}) reached`;
    if (this.screenCount() >= this.cfg.maxScreens) return `screen budget (${this.cfg.maxScreens}) reached`;
    if (this.now() - this.startedAt > this.cfg.maxMinutes * 60_000) return `time budget (${this.cfg.maxMinutes} min) reached`;
    return null;
  }

  private markExplored(screen: string, key: string, skipped = false) {
    const bucket = skipped ? this.state.skipped : this.state.explored;
    (bucket[screen] ??= []).includes(key) || bucket[screen].push(key);
  }

  private isExplored(screen: string, key: string): boolean {
    return !!this.state.explored[screen]?.includes(key) || !!this.state.skipped[screen]?.includes(key);
  }

  private async elementsFor(obs: Observation): Promise<UiElement[]> {
    const cached = this.elementsCache.get(obs.id);
    if (cached) return cached;
    let nodes = this.nodesCache.get(obs.id);
    if (nodes === undefined) {
      const xml = await this.o.store.readXml(obs);
      nodes = xml ? parseHierarchy(xml) : null;
      this.nodesCache.set(obs.id, nodes);
    }
    const els = nodes && obs.pkg === this.pkg ? this.extract(nodes, obs) : [];
    this.elementsCache.set(obs.id, els);
    return els;
  }

  private extract(nodes: UiNode[], obs: Observation): UiElement[] {
    return extractElements(nodes, {
      pkg: this.pkg,
      screen: { w: obs.widthPx, h: obs.heightPx },
      listSample: this.cfg.listSample,
      riskyPatterns: this.cfg.riskyPatterns,
      scroll: this.cfg.explore.scroll,
      longPress: this.cfg.explore.longPress,
      inputs: this.cfg.explore.inputs,
    });
  }

  private pending(key: string, elements: UiElement[]): UiElement[] {
    if (key.startsWith("x-")) return [];
    if ((this.depth.get(key) ?? 0) >= this.cfg.maxDepth) return [];
    const out = elements.filter((e) => {
      if (e.kind === "scroll") return (this.state.scrolls[`${key}|${e.key}`] ?? 0) < MAX_SCROLLS && !this.state.skipped[key]?.includes(e.key);
      return !this.isExplored(key, e.key);
    });
    return out.sort((a, b) => Number(a.risky) - Number(b.risky) || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.bounds.y - b.bounds.y);
  }

  // ---- observation ---------------------------------------------------------

  /** Wait until consecutive screenshots stop changing; returns the last frame. */
  private async settle(): Promise<{ png: Buffer; frame: FrameInfo }> {
    const { minMs, maxMs, stableFrames } = this.cfg.settle;
    if (minMs > 0) await this.sleep(minMs);
    const start = this.now();
    let png = await this.o.driver.screenshot();
    let frame = await analyzeFrame(png);
    let stable = 1;
    while (stable < stableFrames && this.now() - start < maxMs) {
      png = await this.o.driver.screenshot();
      const next = await analyzeFrame(png);
      stable = thumbDiff(frame.thumb, next.thumb) < 1.5 ? stable + 1 : 1;
      frame = next;
    }
    return { png, frame };
  }

  private async observe(viaTransition?: { fromKey: string; action: Action }, manual = false): Promise<Current> {
    const { png, frame } = await this.settle();
    const fg = await this.o.driver.foreground();
    let xml: string | null = null;
    for (let attempt = 0; attempt < 3 && xml === null; attempt++) {
      try {
        xml = await this.o.driver.hierarchy();
      } catch (err) {
        this.log("warn", `hierarchy dump failed (${(err as Error).message}); retrying`);
        await this.sleep(400);
      }
    }
    const nodes = xml ? parseHierarchy(xml) : null;
    const black = frame.black;
    const info = (this.deviceInfo ??= await this.o.driver.info());
    const id = newId("o");
    const obs: Observation = {
      id,
      seq: this.seq++,
      ts: this.now(),
      pkg: fg.pkg || nodes?.[0]?.pkg || "",
      activity: fg.activity,
      png: `${id}.png`,
      xml: xml ? `${id}.xml` : undefined,
      widthPx: info.widthPx,
      heightPx: info.heightPx,
      dhash: frame.dhash,
      status: black ? "opaque" : nodes ? "ok" : "stale",
      manual: manual || undefined,
    };
    await this.o.store.saveObservation(obs, png, xml);
    this.nodesCache.set(obs.id, nodes);
    const sig = computeSignature(obs, nodes);
    const { key, isNew } = this.clusterer.add(obs, sig, viaTransition);
    if (this.startKey === null && obs.pkg === this.pkg) {
      this.startKey = key;
      this.depth.set(key, 0);
    }
    this.lastObs.set(key, obs);
    const elements = await this.elementsFor(obs);
    if (black) this.log("warn", "Screen captured as black (FLAG_SECURE?) — marked opaque");
    this.emit({ type: "observation", projectId: this.o.projectId ?? "", obs, screenId: key, isNewScreen: isNew });
    const cur = { obs, key, nodes, elements };
    this.lastCurrent = cur;
    return cur;
  }

  /** App screens and permission prompts can be traversed when replaying paths; other apps can't. */
  private navigable(c: { key: string; obs: Observation }): boolean {
    return !c.key.startsWith("x-") || isPermissionPkg(c.obs.pkg);
  }

  private outcomeOf(from: Current, to: Current): { outcome: TransitionOutcome; externalPkg?: string } {
    if (to.obs.pkg === this.pkg) return { outcome: to.key === from.key ? "self" : "navigate" };
    const foreign = classifyForeign(to.obs.pkg, to.nodes);
    if (foreign.kind === "crash") return { outcome: "crash", externalPkg: to.obs.pkg };
    return { outcome: "external", externalPkg: to.obs.pkg };
  }

  private async record(from: Current, action: Action, to: Current, note?: string): Promise<Transition> {
    const { outcome, externalPkg } = this.outcomeOf(from, to);
    const t: Transition = { id: newId("t"), seq: this.seq++, ts: this.now(), fromObs: from.obs.id, toObs: to.obs.id, action, outcome, externalPkg, note };
    await this.o.store.saveTransition(t);
    if (from.key !== to.key && this.navigable(from) && this.navigable(to)) {
      if (!this.navEdges.some((e) => e.from === from.key && e.to === to.key && e.action.type === action.type && e.action.elementKey === action.elementKey)) {
        this.navEdges.push({ from: from.key, to: to.key, action });
      }
      if (action.type !== "back" && this.depth.has(from.key)) {
        const d = this.depth.get(from.key)! + 1;
        if (!this.depth.has(to.key) || this.depth.get(to.key)! > d) this.depth.set(to.key, d);
      }
    }
    this.emit({ type: "transition", projectId: this.o.projectId ?? "", transition: t });
    return t;
  }

  // ---- actions -------------------------------------------------------------

  private async perform(cur: Current, el: UiElement): Promise<Action> {
    const d = this.o.driver;
    const c = rectCenter(el.bounds);
    const action: Action = { type: "tap", elementKey: el.key, label: el.label, bounds: el.bounds };
    this.emit({ type: "action", projectId: this.o.projectId ?? "", action, screenId: cur.key });
    this.actionCount++;
    switch (el.kind) {
      case "input": {
        const node = cur.nodes![el.nodeIdx];
        const value = inputValueFor(node, el.label, this.cfg.inputs as Record<string, string>);
        await d.tap(c.x, c.y);
        await this.sleep(250);
        await d.typeText(value);
        if (await d.keyboardShown()) await d.key("BACK");
        return { ...action, type: "input", value: node.password ? "••••" : value };
      }
      case "scroll": {
        const x = c.x;
        const y1 = el.bounds.y + el.bounds.h * 0.75;
        const y2 = el.bounds.y + el.bounds.h * 0.25;
        await d.swipe(x, y1, x, y2, 400);
        return { ...action, type: "scroll", label: `Scroll down`, value: "down" };
      }
      case "longPress":
        await d.longPress(c.x, c.y);
        return { ...action, type: "longPress" };
      default:
        await d.tap(c.x, c.y);
        return action;
    }
  }

  private async pressBack(cur: Current, label = "Back"): Promise<Current> {
    this.actionCount++;
    const action: Action = { type: "back", label };
    this.emit({ type: "action", projectId: this.o.projectId ?? "", action, screenId: cur.key });
    await this.o.driver.key("BACK");
    const next = await this.observe({ fromKey: cur.key, action });
    await this.record(cur, action, next);
    return next;
  }

  private async relaunch(cur: Current | null, hard: boolean): Promise<Current> {
    if (hard) await this.o.driver.forceStop(this.pkg);
    await this.o.driver.launch(this.pkg);
    const action: Action = { type: hard ? "restart" : "launch", label: hard ? "Restart app" : "Launch app" };
    const next = await this.observe();
    if (cur) await this.record(cur, action, next);
    return next;
  }

  /** Get back into the target app from permission prompts, crash dialogs, other apps or the launcher. */
  private async recover(cur: Current): Promise<Current> {
    const foreign = classifyForeign(cur.obs.pkg, cur.nodes);
    switch (foreign.kind) {
      case "permission": {
        let allow = this.cfg.permissionPolicy === "grant";
        if (this.cfg.permissionPolicy === "ask" && this.o.approve && foreign.allow) {
          allow = await this.o.approve({ requestId: newId("r"), element: this.syntheticElement(foreign.allow, "Allow permission"), screenId: cur.key, obsId: cur.obs.id });
        }
        const btn = allow ? foreign.allow : foreign.deny;
        if (!btn) return this.pressBack(cur, "Dismiss permission prompt");
        const c = rectCenter(btn.bounds);
        this.actionCount++;
        await this.o.driver.tap(c.x, c.y);
        const action: Action = { type: "dismiss", label: allow ? "Allow" : "Deny", bounds: btn.bounds };
        const next = await this.observe({ fromKey: cur.key, action });
        await this.record(cur, action, next);
        this.log("info", `Permission prompt ${allow ? "granted" : "denied"}`);
        return next;
      }
      case "crash": {
        this.log("warn", "App crashed — dismissing and relaunching");
        if (foreign.close) {
          const c = rectCenter(foreign.close.bounds);
          await this.o.driver.tap(c.x, c.y);
          await this.sleep(300);
        }
        return this.relaunch(cur, true);
      }
      case "launcher":
        return this.relaunch(cur, false);
      case "system":
      case "external": {
        const next = await this.pressBack(cur, `Back from ${cur.obs.pkg}`);
        if (next.obs.pkg === this.pkg) return next;
        return this.relaunch(next, false);
      }
    }
  }

  private syntheticElement(n: UiNode, label: string): UiElement {
    return { key: `sys:${n.rid || label}`, nodeIdx: n.idx, kind: "tap", cls: n.cls, rid: n.rid, label, bounds: n.bounds, risky: false, role: "button" };
  }

  // ---- navigation ----------------------------------------------------------

  private findPath(from: string, targets: Set<string>): NavEdge[] | null {
    if (targets.has(from)) return [];
    const prev = new Map<string, NavEdge>();
    const seen = new Set([from]);
    const q = [from];
    while (q.length) {
      const s = q.shift()!;
      for (const e of this.navEdges) {
        if (e.from !== s || seen.has(e.to)) continue;
        seen.add(e.to);
        prev.set(e.to, e);
        if (targets.has(e.to)) {
          const path: NavEdge[] = [];
          let n = e.to;
          while (n !== from) {
            const pe = prev.get(n)!;
            path.unshift(pe);
            n = pe.from;
          }
          return path;
        }
        q.push(e.to);
      }
    }
    return null;
  }

  private async screensWithPending(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const [key, obs] of this.lastObs) {
      if (key.startsWith("x-") || this.state.unreachable.includes(key)) continue;
      if (this.pending(key, await this.elementsFor(obs)).length) out.add(key);
    }
    return out;
  }

  /** Replay a known path; returns the final state and whether every hop landed where expected. */
  private async follow(cur: Current, path: NavEdge[]): Promise<{ cur: Current; ok: boolean }> {
    for (const edge of path) {
      if (this.stopped) return { cur, ok: false };
      if (edge.action.type === "back") {
        cur = await this.pressBack(cur);
      } else if (edge.action.type === "dismiss") {
        cur = await this.recover(cur);
      } else {
        const found = await this.reveal(cur, edge.action);
        cur = found.cur;
        const el = found.el;
        if (!el) return { cur, ok: false };
        const action = await this.perform(cur, el);
        const next = await this.observe({ fromKey: cur.key, action });
        await this.record(cur, action, next, "navigation");
        cur = next;
      }
      if (cur.key !== edge.to) return { cur, ok: false };
    }
    return { cur, ok: true };
  }

  private findElement(cur: Current, action: Action): UiElement | undefined {
    return cur.elements.find((e) => e.key === action.elementKey) ?? cur.elements.find((e) => e.label === action.label && e.kind !== "scroll");
  }

  /** Locate an element for a known action, scrolling the screen's containers (up, then down) if it is off-screen. */
  private async reveal(cur: Current, action: Action): Promise<{ cur: Current; el?: UiElement }> {
    let el = this.findElement(cur, action);
    if (el) return { cur, el };
    const startKey = cur.key;
    for (const dir of ["up", "down"] as const) {
      for (let i = 0; i < MAX_SCROLLS && !el; i++) {
        const scroller = cur.elements.find((e) => e.kind === "scroll");
        if (!scroller || cur.key !== startKey) return { cur };
        const prevDhash = cur.obs.dhash;
        cur = await this.swipe(cur, scroller, dir, "navigation");
        el = this.findElement(cur, action);
        if (cur.obs.dhash === prevDhash) break; // reached the end in this direction
      }
      if (el) break;
    }
    return { cur, el };
  }

  private async swipe(cur: Current, el: UiElement, dir: "up" | "down", note?: string): Promise<Current> {
    const x = el.bounds.x + el.bounds.w / 2;
    const [a, b] = dir === "down" ? [0.75, 0.25] : [0.25, 0.75];
    this.actionCount++;
    const action: Action = { type: "scroll", elementKey: el.key, label: `Scroll ${dir}`, bounds: el.bounds, value: dir };
    this.emit({ type: "action", projectId: this.o.projectId ?? "", action, screenId: cur.key });
    await this.o.driver.swipe(x, el.bounds.y + el.bounds.h * a, x, el.bounds.y + el.bounds.h * b, 400);
    const next = await this.observe({ fromKey: cur.key, action });
    await this.record(cur, action, next, note);
    return next;
  }

  /** Move to the nearest screen that still has unexplored elements; null when exploration is complete. */
  private async navigateToPending(cur: Current): Promise<Current | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.stopped) return null;
      const targets = await this.screensWithPending();
      if (!targets.size) return null;
      const path = this.findPath(cur.key, targets);
      if (path && path.length) {
        const r = await this.follow(cur, path);
        cur = r.cur;
        if (r.ok) return cur;
        if (cur.obs.pkg !== this.pkg) cur = await this.recover(cur);
        if (attempt >= 2) {
          // Repeated failures: give up on the farthest target of this path.
          this.state.unreachable.push(path[path.length - 1].to);
        }
        continue;
      }
      if (!this.state.backTried.includes(cur.key)) {
        this.state.backTried.push(cur.key);
        const next = await this.pressBack(cur);
        return next.obs.pkg === this.pkg ? next : this.recover(next);
      }
      if (cur.key !== this.startKey) {
        cur = await this.relaunch(cur, true);
        continue;
      }
      // Nothing reachable from the start screen: the remaining targets are orphans.
      for (const t of targets) this.state.unreachable.push(t);
      return null;
    }
    return cur;
  }

  // ---- main loop -----------------------------------------------------------

  /** Restore graph knowledge from a previous run so the crawl can continue where it stopped. */
  async restore(): Promise<void> {
    const { observations, transitions, state } = await this.o.store.load();
    this.state = { ...emptyCrawlState(), ...state, unreachable: [], backTried: [] };
    const producedBy = new Map(transitions.map((t) => [t.toObs, t]));
    for (const obs of [...observations].sort((a, b) => a.seq - b.seq)) {
      const xml = await this.o.store.readXml(obs);
      const nodes = xml ? parseHierarchy(xml) : null;
      this.nodesCache.set(obs.id, nodes);
      const t = producedBy.get(obs.id);
      const { key } = this.clusterer.add(obs, computeSignature(obs, nodes), t ? { fromKey: this.clusterer.keyOf(t.fromObs), action: t.action } : undefined);
      if (this.startKey === null && obs.pkg === this.pkg) {
        this.startKey = key;
        this.depth.set(key, 0);
      }
      this.lastObs.set(key, obs);
    }
    for (const t of [...transitions].sort((a, b) => a.seq - b.seq)) {
      const from = this.clusterer.keyOf(t.fromObs);
      const to = this.clusterer.keyOf(t.toObs);
      const fromObs = observations.find((o) => o.id === t.fromObs);
      const toObs = observations.find((o) => o.id === t.toObs);
      if (!from || !to || !fromObs || !toObs || from === to) continue;
      if (!this.navigable({ key: from, obs: fromObs }) || !this.navigable({ key: to, obs: toObs })) continue;
      this.navEdges.push({ from, to, action: t.action });
      if (t.action.type !== "back" && this.depth.has(from)) {
        const d = this.depth.get(from)! + 1;
        if (!this.depth.has(to) || this.depth.get(to)! > d) this.depth.set(to, d);
      }
    }
    this.seq = Math.max(0, ...observations.map((o) => o.seq + 1), ...transitions.map((t) => t.seq + 1));
    this.actionCount = transitions.length;
  }

  async run(): Promise<CrawlResult> {
    const d = this.o.driver;
    this.startedAt = this.now();
    const restore = d.prepare ? await d.prepare(this.cfg.device) : async () => {};
    let result: CrawlResult = "done";
    try {
      this.emitStatus("running");
      let cur: Current;
      if (this.cfg.startMode === "relaunch") {
        await d.forceStop(this.pkg);
        await d.launch(this.pkg);
        cur = await this.observe();
      } else {
        cur = await this.observe(undefined, true);
        if (cur.obs.pkg !== this.pkg) cur = await this.relaunch(null, false);
      }

      while (!this.stopped) {
        if (this.pauseMode !== "running") {
          await this.waitWhilePaused();
          if (this.stopped) break;
          if (this.resyncAfterPause) {
            this.resyncAfterPause = false;
            const next = await this.observe(undefined, true);
            await this.record(cur, { type: "manual", label: "Manual interaction" }, next);
            cur = next;
            this.log("info", `Re-synced after take-over on ${cur.key}`);
          }
        }
        const over = this.budgetExceeded();
        if (over) {
          this.log("info", `Stopping: ${over}`);
          result = "budget";
          break;
        }
        if (cur.obs.pkg !== this.pkg) {
          cur = await this.recover(cur);
          continue;
        }
        const pending = this.pending(cur.key, cur.elements);
        if (!pending.length) {
          const next = await this.navigateToPending(cur);
          if (!next) break;
          cur = next;
          continue;
        }
        const el = pending[0];
        if (el.kind === "scroll") {
          const sk = `${cur.key}|${el.key}`;
          this.state.scrolls[sk] = (this.state.scrolls[sk] ?? 0) + 1;
        } else {
          this.markExplored(cur.key, el.key);
        }
        if (el.risky && this.cfg.riskyPolicy !== "allow") {
          let allow = false;
          if (this.cfg.riskyPolicy === "ask" && this.o.approve) {
            this.log("info", `Risky element "${el.label}" (${el.riskReason}) — waiting for approval`);
            allow = await this.o.approve({ requestId: newId("r"), element: el, screenId: cur.key, obsId: cur.obs.id });
          }
          if (!allow) {
            this.markExplored(cur.key, el.key, true);
            this.log("info", `Skipped risky element "${el.label}"`);
            await this.o.store.saveState(this.state);
            continue;
          }
        }
        const before = cur;
        const action = await this.perform(cur, el);
        const next = await this.observe({ fromKey: cur.key, action });
        await this.record(before, action, next);
        if (el.kind === "scroll" && next.key === before.key) {
          // Stop scrolling once a swipe reveals nothing new.
          const newKeys = next.elements.filter((e) => !before.elements.some((b) => b.key === e.key));
          if (!newKeys.length) this.state.scrolls[`${cur.key}|${el.key}`] = MAX_SCROLLS;
        }
        cur = next;
        await this.o.store.saveState(this.state);
        this.emit({
          type: "stats",
          projectId: this.o.projectId ?? "",
          stats: { actions: this.actionCount, observations: this.seq, screens: this.screenCount() },
        });
      }
      if (this.stopped) result = "stopped";
    } finally {
      await this.o.store.saveState(this.state);
      await restore().catch((err) => this.log("error", `Failed to restore device settings: ${(err as Error).message}`));
    }
    this.log("info", `Crawl finished (${result}): ${this.screenCount()} screens, ${this.actionCount} actions`);
    return result;
  }

  /** Current screen key and observation id, for the dashboard. */
  current(): { screen: string; obs: string } | null {
    return this.lastCurrent ? { screen: this.lastCurrent.key, obs: this.lastCurrent.obs.id } : null;
  }

  stats() {
    return { actions: this.actionCount, observations: this.seq, screens: this.screenCount() };
  }
}
