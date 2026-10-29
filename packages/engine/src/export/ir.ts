import { hashString, type AppInfo, type CrawlMap, type DesignIR, type DeviceInfo, type IREdge, type IRHotspot, type IRScreen, type Observation, type UiElement, type UiNode } from "@mappy/shared";
import { layoutGraph } from "../layout/elk.ts";
import { AssetSink, reconstructScreen } from "../reconstruct/index.ts";

export interface IRSource {
  name: string;
  app: AppInfo;
  device: DeviceInfo;
  map: CrawlMap;
  observation: (id: string) => Observation;
  png: (obs: Observation) => Promise<Buffer>;
  nodes: (obs: Observation) => Promise<UiNode[] | null>;
  elements?: (obs: Observation, nodes: UiNode[]) => UiElement[];
  onProgress?: (done: number, total: number) => void;
}

const NAV_ACTIONS = new Set(["tap", "longPress", "dismiss", "toggle"]);
const INVENTORY_ROLES = new Set(["button", "tab", "nav", "menu", "toggle", "input", "listItem"]);
const LAUNCHER = /launcher|nexuslauncher|trebuchet|lawnchair/i;

/** Build the tool-neutral design IR (reconstructed screens, flow edges, layout, inventory). */
export async function buildDesignIR(src: IRSource): Promise<{ ir: DesignIR; assets: AssetSink }> {
  const assets = new AssetSink();
  const s = 160 / src.device.density;
  const dp = (v: number) => Math.round(v * s * 100) / 100;
  const included = src.map.screens.filter((sc) => !sc.hidden && !(sc.kind === "system" && LAUNCHER.test(sc.pkg)));
  const ids = new Set(included.map((sc) => sc.id));

  // Merge parallel map edges into one flow edge per (from, to); keep every hotspot.
  const flow = new Map<string, IREdge & { labels: string[] }>();
  const hotspots = new Map<string, IRHotspot[]>();
  const depthOf = new Map(src.map.screens.map((sc) => [sc.id, sc.depth]));
  // Edges that return to a shallower screen ("Navigate up", "Save", tab back to home) stay as
  // prototype hotspots but are left out of the flow arrows, which would otherwise be a thicket.
  const isReturn = (from: string, to: string) => {
    const a = depthOf.get(from);
    const b = depthOf.get(to);
    return a != null && b != null && b < a;
  };
  for (const e of src.map.edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to || !NAV_ACTIONS.has(e.actionType)) continue;
    const fid = `f-${hashString(`${e.from}>${e.to}`)}`;
    if (!isReturn(e.from, e.to)) {
      const f = flow.get(fid) ?? { id: fid, from: e.from, to: e.to, label: "", labels: [], points: [] };
      if (!f.labels.includes(e.label)) f.labels.push(e.label);
      flow.set(fid, f);
    }
    if (e.bounds) {
      const list = hotspots.get(e.from) ?? [];
      const h: IRHotspot = { id: `h-${hashString(e.id)}`, x: dp(e.bounds.x), y: dp(e.bounds.y), w: dp(e.bounds.w), h: dp(e.bounds.h), label: e.label, role: e.actionType, edgeId: e.id, target: e.to };
      if (!list.some((o) => Math.abs(o.x - h.x) < 2 && Math.abs(o.y - h.y) < 2 && o.target === h.target)) list.push(h);
      hotspots.set(e.from, list);
    }
  }
  const edges = [...flow.values()].map(({ labels, ...e }) => ({ ...e, label: labels.slice(0, 3).join(", ") + (labels.length > 3 ? ` +${labels.length - 3}` : "") }));

  const screens: IRScreen[] = [];
  const inventory = new Map<string, DesignIR["inventory"][number]>();
  let done = 0;
  for (const sc of included) {
    const obs = src.observation(sc.repObs);
    const png = await src.png(obs);
    const nodes = await src.nodes(obs);
    const rec = await reconstructScreen({ png, nodes, appPkg: src.app.pkg, density: src.device.density, opaque: sc.kind !== "app" }, assets);
    const variantAssetIds: string[] = [];
    for (const v of sc.variants.filter((id) => id !== sc.repObs).slice(0, 6)) {
      const vo = src.observation(v);
      variantAssetIds.push(assets.add(await src.png(vo), vo.widthPx, vo.heightPx));
    }
    screens.push({
      id: sc.id,
      name: sc.name,
      activity: sc.activity,
      x: 0,
      y: 0,
      w: rec.w,
      h: rec.h,
      background: rec.background,
      referenceAssetId: rec.referenceAssetId,
      layers: rec.layers,
      hotspots: hotspots.get(sc.id) ?? [],
      variantAssetIds,
      depth: sc.depth,
    });
    if (sc.kind === "app" && nodes && src.elements) {
      for (const el of src.elements(obs, nodes)) {
        if (!INVENTORY_ROLES.has(el.role) || el.bounds.w < 8 || el.bounds.h < 8) continue;
        const c = await assets.crop(png, { x: Math.round(el.bounds.x), y: Math.round(el.bounds.y), w: Math.round(el.bounds.w), h: Math.round(el.bounds.h) });
        const item = inventory.get(c.id);
        if (item) item.count++;
        else inventory.set(c.id, { role: el.role, label: el.label, assetId: c.id, w: dp(c.w), h: dp(c.h), count: 1 });
      }
    }
    src.onProgress?.(++done, included.length);
  }

  const layout = await layoutGraph(
    screens.map((sc) => ({ id: sc.id, w: sc.w, h: sc.h })),
    edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
  );
  for (const sc of screens) {
    const p = layout.positions.get(sc.id);
    if (p) {
      sc.x = Math.round(p.x);
      sc.y = Math.round(p.y);
    }
  }
  for (const e of edges) e.points = layout.routes.get(e.id) ?? [];

  const ir: DesignIR = {
    version: 1,
    name: src.name,
    app: src.app,
    device: { widthDp: dp(src.device.widthPx), heightDp: dp(src.device.heightPx), scale: src.device.density / 160, model: src.device.model },
    startScreen: src.map.startScreen && ids.has(src.map.startScreen) ? src.map.startScreen : (screens[0]?.id ?? null),
    screens,
    edges,
    assets: Object.fromEntries([...assets.files].map(([id, f]) => [id, { id, file: `assets/${id}.png`, mime: "image/png", w: f.w, h: f.h }])),
    inventory: [...inventory.values()].sort((a, b) => a.role.localeCompare(b.role) || b.count - a.count).slice(0, 300),
  };
  return { ir, assets };
}
