import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CrawlConfig } from "@mappy/shared";
import { buildDesignIR, buildMap, computeSignature, Crawler, demoApp, MemoryStore, MockDriver, parseHierarchy } from "@mappy/engine";

const dist = new URL("../dist/", import.meta.url).pathname;
execFileSync(process.execPath, ["build.ts"], { cwd: new URL("..", import.meta.url).pathname });

function fakePenpot() {
  const shapes: any[] = [];
  let handler: ((m: unknown) => Promise<void>) | null = null;
  const messages: any[] = [];
  const flows: any[] = [];
  let opened = "";
  const make = (type: string) => {
    const s: any = {
      type,
      name: "",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      children: [],
      fills: [],
      strokes: [],
      interactions: [],
      appendChild(c: any) {
        c.parent = s;
        s.children.push(c);
      },
      resize(w: number, h: number) {
        if (!(w > 0 && h > 0)) throw new Error(`bad size ${w}x${h}`);
        s.width = w;
        s.height = h;
      },
      addInteraction(trigger: string, action: any) {
        s.interactions.push({ trigger, action });
      },
    };
    shapes.push(s);
    return s;
  };
  const penpot: any = {
    theme: "dark",
    ui: {
      open: (_n: string, url: string) => (opened = url),
      sendMessage: (m: unknown) => messages.push(m),
      onMessage: (cb: any) => (handler = cb),
    },
    currentPage: { findShapes: () => [...shapes], createFlow: (name: string, board: any) => flows.push({ name, board }) },
    fonts: {
      findByName: () => ({
        name: "Roboto",
        variants: ["400", "500", "700"].map((w) => ({ name: w, fontWeight: w })),
        applyToText(t: any, v: any) {
          t.fontFamily = "Roboto";
          t.fontWeight = v.fontWeight;
        },
      }),
    },
    uploadMediaData: async (name: string) => ({ id: `media-${name}` }),
    createBoard: () => make("board"),
    createRectangle: () => make("rect"),
    createPath: () => make("path"),
    createText: (chars: string) => Object.assign(make("text"), { characters: chars }),
  };
  return { penpot, shapes, messages, flows, opened: () => opened, send: (m: unknown) => handler!(m) };
}

describe("Penpot plugin", async () => {
  const driver = new MockDriver(demoApp);
  const store = new MemoryStore();
  const config = CrawlConfig.parse({ riskyPolicy: "skip", settle: { minMs: 0, maxMs: 1000, stableFrames: 1 } });
  await new Crawler({ driver, app: { pkg: demoApp.pkg }, config, store, sleep: async () => {} }).run();
  const nodes = (id: string) => (store.xmls.get(id) ? parseHierarchy(store.xmls.get(id)!) : null);
  const map = buildMap({ projectId: "p", appPkg: demoApp.pkg, threshold: 0.8, observations: store.observations, transitions: store.transitions, overrides: { assign: {}, renames: {}, hidden: [] }, signature: (o) => computeSignature(o, nodes(o.id)) });
  const { ir, assets } = await buildDesignIR({ name: "Notely", app: { pkg: demoApp.pkg, label: "Notely" }, device: await driver.info(), map, observation: (id) => store.observations.find((o) => o.id === id)!, png: async (o) => store.pngs.get(o.id)!, nodes: async (o) => nodes(o.id) });
  const bytes = Object.fromEntries([...assets.files].map(([id, f]) => [id, new Uint8Array(f.png)]));

  it("imports boards, editable text, images, prototype links and the flow", async () => {
    const code = readFileSync(`${dist}plugin.js`, "utf8").replaceAll("__MAPPY_ORIGIN__", JSON.stringify("http://127.0.0.1:4317"));
    const f = fakePenpot();
    new Function("penpot", code)(f.penpot);
    expect(f.opened()).toBe("http://127.0.0.1:4317/plugins/penpot/ui.html?theme=dark");
    await f.send({ type: "import", ir, assets: bytes });
    const last = f.messages.at(-1);
    expect(last.done).toBe(true);
    expect(last.message).toMatch(/^Imported \d+ screens/);
    const screenBoards = f.shapes.filter((s) => s.type === "board" && ir.screens.some((x) => x.name === s.name) && !s.parent);
    expect(screenBoards).toHaveLength(ir.screens.length);
    expect(f.shapes.some((s) => s.type === "text" && s.characters === "Account" && s.fontFamily === "Roboto")).toBe(true);
    const ref = f.shapes.find((s) => s.name === "Reference screenshot");
    expect(ref.hidden).toBe(true);
    expect(ref.fills[0].fillImage.id).toMatch(/^media-/);
    const links = f.shapes.flatMap((s) => s.interactions);
    expect(links.length).toBe(ir.screens.reduce((n, s) => n + s.hotspots.length, 0));
    expect(links[0].action.type).toBe("navigate-to");
    expect(f.shapes.filter((s) => s.type === "path")).toHaveLength(ir.edges.length);
    expect(f.flows[0].board.name).toBe("Notes");
  });
});
