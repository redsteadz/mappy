import { describe, expect, it } from "vitest";
import { CrawlConfig, type DesignIR } from "@mappy/shared";
import { buildMap, computeSignature } from "../../crawler/abstraction.ts";
import { Crawler } from "../../crawler/crawler.ts";
import { MemoryStore } from "../../crawler/store.ts";
import { demoApp } from "../../driver/demo-app.ts";
import { MockDriver } from "../../driver/mock.ts";
import { extractElements } from "../../hierarchy/elements.ts";
import { parseHierarchy } from "../../hierarchy/parse.ts";
import { buildDesignIR } from "../ir.ts";
import { buildAll } from "./builder.ts";
import { finishFigmaScripts, MCP_SCRIPT_LIMIT, planFigmaScripts, type ScreensResult } from "./mcp.ts";

/** Minimal in-memory stand-in for the Figma Plugin API — enough to execute the builder. */
function fakeFigma() {
  let seq = 0;
  const nodes = new Map<string, any>();
  const loaded = new Set<string>();
  const available = new Set(["Roboto/Regular", "Roboto/Medium", "Roboto/Bold", "Inter/Regular"]);
  const make = (type: string) => {
    const n: any = {
      id: `${++seq}:1`,
      type,
      name: "",
      children: [],
      parent: null,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [],
      strokes: [],
      visible: true,
      locked: false,
      appendChild(c: any) {
        if (c.parent) c.parent.children = c.parent.children.filter((x: any) => x !== c);
        c.parent = n;
        n.children.push(c);
      },
      resize(w: number, h: number) {
        if (!(w > 0 && h > 0)) throw new Error(`invalid size ${w}×${h}`);
        n.width = w;
        n.height = h;
      },
      async setReactionsAsync(r: any) {
        n.reactions = r;
      },
      async setVectorNetworkAsync(v: any) {
        if (!v.vertices.length || v.vertices.some((p: any) => !Number.isFinite(p.x))) throw new Error("bad network");
        n.vectorNetwork = v;
      },
    };
    if (type === "TEXT") {
      let chars = "";
      Object.defineProperty(n, "characters", {
        get: () => chars,
        set: (v: string) => {
          if (!n.fontName || !loaded.has(`${n.fontName.family}/${n.fontName.style}`)) throw new Error("unloaded font");
          chars = v;
        },
      });
    }
    nodes.set(n.id, n);
    return n;
  };
  const pages: any[] = [];
  const figma: any = {
    mixed: Symbol("mixed"),
    root: { children: pages },
    currentPage: null,
    createPage() {
      const p = make("PAGE");
      p.flowStartingPoints = [];
      pages.push(p);
      return p;
    },
    async setCurrentPageAsync(p: any) {
      figma.currentPage = p;
    },
    async loadFontAsync(f: { family: string; style: string }) {
      const k = `${f.family}/${f.style}`;
      if (!available.has(k)) throw new Error(`font ${k} unavailable`);
      loaded.add(k);
    },
    createFrame: () => make("FRAME"),
    createRectangle: () => make("RECTANGLE"),
    createText: () => make("TEXT"),
    createVector: () => make("VECTOR"),
    createImage: (b: Uint8Array) => ({ hash: `img${b.length}` }),
    async getNodeByIdAsync(id: string) {
      return nodes.get(id) ?? null;
    },
  };
  const all = (type?: string) => [...nodes.values()].filter((n) => !type || n.type === type);
  return { figma, all, pages };
}

async function demoIR(): Promise<{ ir: DesignIR; bytes: (id: string) => Uint8Array | undefined }> {
  const driver = new MockDriver(demoApp);
  const store = new MemoryStore();
  const config = CrawlConfig.parse({ riskyPolicy: "skip", settle: { minMs: 0, maxMs: 1000, stableFrames: 1 } });
  await new Crawler({ driver, app: { pkg: demoApp.pkg }, config, store, sleep: async () => {} }).run();
  const nodes = (id: string) => (store.xmls.get(id) ? parseHierarchy(store.xmls.get(id)!) : null);
  const map = buildMap({
    projectId: "p",
    appPkg: demoApp.pkg,
    threshold: config.similarity,
    observations: store.observations,
    transitions: store.transitions,
    overrides: { assign: {}, renames: {}, hidden: [] },
    signature: (o) => computeSignature(o, nodes(o.id)),
  });
  const { ir, assets } = await buildDesignIR({
    name: "Notely",
    app: { pkg: demoApp.pkg, label: "Notely" },
    device: await driver.info(),
    map,
    observation: (id) => store.observations.find((o) => o.id === id)!,
    png: async (o) => store.pngs.get(o.id)!,
    nodes: async (o) => nodes(o.id),
    elements: (o, n) => extractElements(n, { pkg: demoApp.pkg, screen: { w: o.widthPx, h: o.heightPx }, listSample: 2, riskyPatterns: [], scroll: false, longPress: false, inputs: true }),
  });
  return { ir, bytes: (id) => assets.files.get(id)?.png };
}

describe("Figma export", async () => {
  const { ir, bytes } = await demoIR();
  const hotspotCount = ir.screens.reduce((n, s) => n + s.hotspots.length, 0);

  it("builds frames, editable text, prototype links and arrows in plugin mode", async () => {
    const { figma, all, pages } = fakeFigma();
    (globalThis as any).figma = figma;
    try {
      const r = await buildAll(ir, bytes);
      const flowPage = pages.find((p) => p.name === "Mappy — Notely");
      const screenFrames = flowPage.children.filter((n: any) => n.type === "FRAME" && ir.screens.some((s) => s.name === n.name));
      expect(screenFrames).toHaveLength(ir.screens.length);
      expect(all("TEXT").some((t) => t.characters === "Account")).toBe(true);
      expect(r.reactions).toBe(hotspotCount);
      expect(all("VECTOR")).toHaveLength(ir.edges.length);
      expect(flowPage.flowStartingPoints[0].name).toBe("Notely");
      const ref = all("RECTANGLE").find((n) => n.name === "Reference screenshot");
      expect(ref.visible).toBe(false);
      expect(ref.fills[0].type).toBe("IMAGE");
      const link = all().find((n) => n.reactions?.length);
      expect(link.reactions[0].actions[0]).toMatchObject({ type: "NODE", navigation: "NAVIGATE" });
    } finally {
      delete (globalThis as any).figma;
    }
  });

  it("generates connector scripts under the size limit that run end to end", async () => {
    const { plan, scripts } = await planFigmaScripts(ir, "p1", { stamp: "test" });
    expect(Object.values(scripts).every((c) => c.length <= MCP_SCRIPT_LIMIT)).toBe(true);
    expect(plan.steps.filter((s) => s.kind === "screens").flatMap((s) => s.screens)).toHaveLength(ir.screens.length);

    const { figma, all } = fakeFigma();
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const run = (code: string) => new AsyncFunction("figma", code)(figma);
    const results: ScreensResult[] = [];
    for (const step of plan.steps) results.push(await run(scripts[step.file]));
    // MCP mode leaves placeholders for upload_assets instead of image fills…
    expect(all("RECTANGLE").some((n) => n.fills[0]?.type === "IMAGE")).toBe(false);
    // …and keeps full-screen captures out of the editable frames (they go on the captures page).
    expect(all("RECTANGLE").some((n) => n.name === "Reference screenshot")).toBe(false);
    expect(all("RECTANGLE").filter((n) => n.name.startsWith("Capture: "))).toHaveLength(ir.screens.length);

    const { uploads, wire } = await finishFigmaScripts(ir, plan, results);
    const distinctAssets = new Set(results.flatMap((r) => r.slots.map((s) => s.assetId)));
    expect(uploads).toHaveLength(distinctAssets.size);
    // Simulate upload_assets filling the primary slots, then run the wiring script.
    for (const u of uploads) (await figma.getNodeByIdAsync(u.nodeId)).fills = [{ type: "IMAGE", imageHash: u.assetId, scaleMode: "FILL" }];
    const wired = await run(wire);
    expect(wired.reactions).toBe(hotspotCount);
    expect(wired.arrows).toBe(ir.edges.length);
    const slotNodes = results.flatMap((r) => r.slots.map((s) => s.nodeId));
    for (const id of slotNodes) expect((await figma.getNodeByIdAsync(id)).fills[0].type).toBe("IMAGE");
  });
});
