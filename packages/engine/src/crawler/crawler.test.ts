import { describe, expect, it } from "vitest";
import { CrawlConfig, type CrawlEvent } from "@mappy/shared";
import { demoApp } from "../driver/demo-app.ts";
import { MockDriver } from "../driver/mock.ts";
import { parseHierarchy } from "../hierarchy/parse.ts";
import { buildMap, computeSignature } from "./abstraction.ts";
import { Crawler } from "./crawler.ts";
import { MemoryStore } from "./store.ts";

const fastConfig = (over: Partial<CrawlConfig> = {}) =>
  CrawlConfig.parse({ settle: { minMs: 0, maxMs: 1000, stableFrames: 1 }, ...over });

async function crawl(over: Partial<CrawlConfig> = {}, approve?: (label: string) => boolean) {
  const driver = new MockDriver(demoApp);
  const store = new MemoryStore();
  const events: CrawlEvent[] = [];
  const crawler = new Crawler({
    driver,
    app: { pkg: demoApp.pkg },
    config: fastConfig(over),
    store,
    onEvent: (e) => events.push(e),
    approve: approve ? async (r) => approve(r.element.label) : undefined,
    sleep: async () => {},
  });
  const result = await crawler.run();
  const map = buildMap({
    projectId: "p",
    appPkg: demoApp.pkg,
    threshold: fastConfig(over).similarity,
    observations: store.observations,
    transitions: store.transitions,
    overrides: { assign: {}, renames: {}, hidden: [] },
    signature: (o) => computeSignature(o, store.xmls.get(o.id) ? parseHierarchy(store.xmls.get(o.id)!) : null),
  });
  return { result, store, map, driver, events, crawler };
}

const appScreenNames = (m: Awaited<ReturnType<typeof crawl>>["map"]) =>
  m.screens.filter((s) => s.kind === "app").map((s) => s.name).sort();

describe("Crawler on the Notely demo app", () => {
  it("explores every reachable screen exactly once and skips risky actions", async () => {
    const { result, map, store } = await crawl({ riskyPolicy: "skip" });
    expect(result).toBe("done");
    expect(appScreenNames(map)).toEqual(
      [
        "About",
        "Account",
        "Backup",
        "Change password",
        "Edit note",
        "Export data",
        "Help",
        "Licenses",
        "Notes",
        "Notifications",
        "Results",
        "Search",
        "Settings",
        "Groceries",
      ].sort(),
    );
    // Delete (dialog) and Log out are risky and must never have been tapped.
    expect(store.transitions.some((t) => /^(Delete|Log out)$/.test(t.action.label))).toBe(false);
    // The note-detail template is one screen even though two notes were opened.
    const detail = map.screens.find((s) => s.name === "Groceries")!;
    const titles = new Set(detail.obsIds.map((id) => store.xmls.get(id)!.match(/Groceries|Trip to Lisbon/)?.[0]));
    expect(titles.has("Trip to Lisbon")).toBe(true);
  });

  it("records external apps, crashes and permission prompts as edges", async () => {
    const { map } = await crawl({ riskyPolicy: "skip" });
    const outcomes = new Set(map.edges.map((e) => e.outcome));
    expect(outcomes).toContain("external");
    expect(outcomes).toContain("crash");
    const kinds = new Set(map.screens.map((s) => s.kind));
    expect(kinds).toContain("external");
    expect(kinds).toContain("system");
    expect(map.edges.some((e) => e.label === "Deny")).toBe(true);
  });

  it("asks before risky actions and follows them when approved", async () => {
    const asked: string[] = [];
    const { map } = await crawl({ riskyPolicy: "ask" }, (label) => {
      asked.push(label);
      return label === "Delete";
    });
    expect(asked).toContain("Delete");
    expect(asked).toContain("Log out");
    expect(map.screens.some((s) => s.kind === "app" && s.name === "Delete this note?")).toBe(true);
    expect(map.screens.some((s) => s.name === "Sign in")).toBe(false);
  });

  it("computes depth from the launch screen and respects the action budget", async () => {
    const { map } = await crawl({ riskyPolicy: "skip" });
    const byName = Object.fromEntries(map.screens.map((s) => [s.name, s]));
    expect(byName["Notes"].depth).toBe(0);
    expect(byName["Settings"].depth).toBe(1);
    expect(byName["Change password"].depth).toBe(3);
    const small = await crawl({ riskyPolicy: "skip", maxActions: 5 });
    expect(small.result).toBe("budget");
    expect(small.store.transitions.length).toBeLessThanOrEqual(6);
  });

  it("resumes from a stored crawl without redoing explored actions", async () => {
    const first = await crawl({ riskyPolicy: "skip", maxActions: 12 });
    const before = first.store.transitions.length;
    const driver = new MockDriver(demoApp);
    const resumed = new Crawler({ driver, app: { pkg: demoApp.pkg }, config: fastConfig({ riskyPolicy: "skip" }), store: first.store, sleep: async () => {} });
    await resumed.restore();
    expect(await resumed.run()).toBe("done");
    const map = buildMap({
      projectId: "p",
      appPkg: demoApp.pkg,
      threshold: 0.8,
      observations: first.store.observations,
      transitions: first.store.transitions,
      overrides: { assign: {}, renames: {}, hidden: [] },
      signature: (o) => computeSignature(o, parseHierarchy(first.store.xmls.get(o.id) ?? "")),
    });
    const explorations = (ts: typeof first.store.transitions) =>
      ts.filter((t) => t.action.type === "tap" && t.note !== "navigation").map((t) => `${map.obsToScreen[t.fromObs]}|${t.action.elementKey}`);
    const firstRun = new Set(explorations(first.store.transitions.slice(0, before)));
    const secondRun = explorations(first.store.transitions.slice(before));
    expect(secondRun.length).toBeGreaterThan(0);
    // Nothing explored in the first run is explored again after resuming.
    expect(secondRun.filter((k) => firstRun.has(k))).toEqual([]);
  });
});
