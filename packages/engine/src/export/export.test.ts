import { describe, expect, it } from "vitest";
import { CrawlConfig, DesignIR } from "@mappy/shared";
import { strFromU8, unzipSync } from "fflate";
import sharp from "sharp";
import { buildMap, computeSignature } from "../crawler/abstraction.ts";
import { Crawler } from "../crawler/crawler.ts";
import { MemoryStore } from "../crawler/store.ts";
import { demoApp } from "../driver/demo-app.ts";
import { MockDriver } from "../driver/mock.ts";
import { extractElements } from "../hierarchy/elements.ts";
import { parseHierarchy } from "../hierarchy/parse.ts";
import { countLayers } from "../reconstruct/index.ts";
import { fidelity } from "../reconstruct/fidelity.ts";
import { bundleZip, posterPdf, posterPng, svgZip, toMermaid } from "./formats.ts";
import { buildDesignIR } from "./ir.ts";
import { screenSvg } from "./svg.ts";

async function demoIR() {
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
  const device = await driver.info();
  const { ir, assets } = await buildDesignIR({
    name: "Notely",
    app: { pkg: demoApp.pkg, label: "Notely" },
    device,
    map,
    observation: (id) => store.observations.find((o) => o.id === id)!,
    png: async (o) => store.pngs.get(o.id)!,
    nodes: async (o) => nodes(o.id),
    elements: (o, n) => extractElements(n, { pkg: demoApp.pkg, screen: { w: o.widthPx, h: o.heightPx }, listSample: 2, riskyPatterns: [], scroll: false, longPress: false, inputs: true }),
  });
  const asset = (id: string) => assets.files.get(id)?.png;
  return { ir, asset, map };
}

describe("design IR and exports", async () => {
  const { ir, asset, map } = await demoIR();
  const settings = ir.screens.find((s) => s.name === "Settings")!;

  it("produces a valid IR with dp geometry, layout and hotspots", () => {
    expect(DesignIR.safeParse(ir).success).toBe(true);
    expect(ir.device.widthDp).toBeCloseTo(411.43, 1);
    expect(ir.startScreen).toBe(ir.screens.find((s) => s.name === "Notes")!.id);
    const xs = new Set(ir.screens.map((s) => `${s.x},${s.y}`));
    expect(xs.size).toBe(ir.screens.length); // every screen placed somewhere distinct
    expect(settings.hotspots.length).toBeGreaterThanOrEqual(6);
    expect(ir.edges.every((e) => e.points.length >= 2)).toBe(true);
    expect(ir.inventory.length).toBeGreaterThan(5);
  });

  it("reconstructs editable text with plausible sizes and colours", () => {
    const counts = countLayers(settings.layers);
    expect(counts.text).toBeGreaterThanOrEqual(8);
    const texts: { chars: string; size: number; color: string }[] = [];
    const walk = (ls: typeof settings.layers) => ls.forEach((l) => (l.text && texts.push(l.text), l.children && walk(l.children)));
    walk(settings.layers);
    const account = texts.find((t) => t.chars === "Account")!;
    // Mock renders 44px text at 420dpi ≈ 16.8dp.
    expect(account.size).toBeGreaterThanOrEqual(15);
    expect(account.size).toBeLessThanOrEqual(18);
    expect(account.color).toMatch(/^#[0-3][0-9a-f]{5}$/); // dark text
  });

  it("renders reconstructed screens close to the original screenshots", async () => {
    for (const s of ir.screens.filter((x) => ["Settings", "Edit note", "Notes"].includes(x.name))) {
      expect(await fidelity(s, asset)).toBeGreaterThan(0.93);
    }
  });

  it("exports Mermaid, SVG, PNG/PDF posters and the plugin bundle", async () => {
    const mermaid = toMermaid(map);
    expect(mermaid).toMatch(/^flowchart LR/);
    expect(mermaid).toContain('|"Settings"|');
    expect(screenSvg(settings, asset)).toContain(">Account</tspan>");
    const svgs = unzipSync(new Uint8Array(svgZip(ir, asset)));
    expect(Object.keys(svgs).filter((f) => f.startsWith("screens/")).length).toBe(ir.screens.length);
    const png = posterPng(ir, asset, 3000);
    expect((await sharp(png).metadata()).width).toBeGreaterThan(1000);
    const pdf = await posterPdf(ir, asset);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const bundle = unzipSync(new Uint8Array(bundleZip(ir, asset)));
    const back = DesignIR.parse(JSON.parse(strFromU8(bundle["ir.json"])));
    expect(Object.values(back.assets).every((a) => bundle[a.file])).toBe(true);
  });
});
