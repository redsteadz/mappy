import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { DesignIR, IRLayer, IRScreen } from "@mappy/shared";
import type { ImageSlot } from "./builder.ts";

/**
 * Turns a DesignIR into `use_figma` scripts for the Figma MCP connector (≤50k chars each):
 *   1. screens-NN.js   build screen frames (layers + hidden reference + hotspots), return IDs
 *   2. inventory.js     build the inventory page
 *   (upload_assets fills image placeholders using the returned slots)
 *   3. wire.js          prototype links, arrows, labels, start point, duplicate image fills
 */

export const MCP_SCRIPT_LIMIT = 50_000;

let runtimeCache: string | null = null;

/** The builder bundled as an IIFE exposing `MappyFigma`. */
export async function figmaRuntime(): Promise<string> {
  if (runtimeCache) return runtimeCache;
  const r = await build({
    entryPoints: [fileURLToPath(new URL("./builder.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName: "MappyFigma",
    minify: true,
    write: false,
    target: "es2020",
    legalComments: "none",
  });
  runtimeCache = r.outputFiles[0].text.trim();
  return runtimeCache;
}

export interface FigmaPlanStep {
  file: string;
  kind: "screens" | "inventory" | "captures";
  screens: string[];
  chars: number;
}

export interface FigmaPlan {
  projectId: string;
  appName: string;
  pageName: string;
  inventoryPage: string;
  capturesPage: string;
  origin: { x: number; y: number };
  steps: FigmaPlanStep[];
  simplified: string[];
}

/** Drop data the builder doesn't use so more screens fit per script. */
function compactLayer(l: IRLayer): unknown {
  const { id: _id, source: _s, children, ...rest } = l;
  return children ? { ...rest, children: children.map(compactLayer) } : rest;
}

function compactScreen(s: IRScreen): IRScreen {
  return { ...s, layers: s.layers.map(compactLayer) as IRLayer[], variantAssetIds: [] };
}

/** Fallback for screens whose layer tree is too large for one script: keep the pixels only. */
function flatScreen(s: IRScreen): IRScreen {
  return { ...compactScreen(s), layers: [{ id: "flat", type: "image", name: "Screenshot (too complex to rebuild)", x: 0, y: 0, w: s.w, h: s.h, assetId: s.referenceAssetId }] };
}

const screensScript = (runtime: string, part: unknown) =>
  `${runtime}\nconst fonts = await MappyFigma.loadFonts();\nconst ctx = { slots: [], fonts, created: [] };\nreturn await MappyFigma.buildScreens(${JSON.stringify(part)}, ctx);\n`;

export async function planFigmaScripts(ir: DesignIR, projectId: string, opts: { stamp?: string; maxChars?: number } = {}): Promise<{ plan: FigmaPlan; scripts: Record<string, string> }> {
  const runtime = await figmaRuntime();
  const BUDGET = Math.min(MCP_SCRIPT_LIMIT, opts.maxChars ?? MCP_SCRIPT_LIMIT) - 1_500;
  const appName = ir.app.label ?? ir.name;
  const stamp = opts.stamp ?? new Date().toLocaleString("sv").slice(0, 16);
  const pageName = `Mappy — ${appName} — ${stamp}`;
  const inventoryPage = `${pageName} — inventory`;
  const capturesPage = `${pageName} — captures (reference)`;
  const origin = { x: 0, y: 200 };
  const scripts: Record<string, string> = {};
  const steps: FigmaPlanStep[] = [];
  const simplified: string[] = [];

  let batch: IRScreen[] = [];
  const flush = () => {
    if (!batch.length) return;
    const file = `screens-${String(steps.length + 1).padStart(2, "0")}.js`;
    const code = screensScript(runtime, { pageName, origin, screens: batch, referenceInFrame: false });
    scripts[file] = code;
    steps.push({ file, kind: "screens", screens: batch.map((s) => s.id), chars: code.length });
    batch = [];
  };
  for (const s of ir.screens) {
    let cs = compactScreen(s);
    if (screensScript(runtime, { pageName, origin, screens: [cs], referenceInFrame: false }).length > BUDGET) {
      cs = flatScreen(s);
      simplified.push(s.name);
    }
    if (screensScript(runtime, { pageName, origin, screens: [...batch, cs], referenceInFrame: false }).length > BUDGET) flush();
    batch.push(cs);
  }
  flush();

  if (ir.inventory.length) {
    let items = ir.inventory;
    const inv = (list: typeof items) =>
      `${runtime}\nconst fonts = await MappyFigma.loadFonts();\nconst ctx = { slots: [], fonts, created: [] };\nreturn await MappyFigma.buildInventory(${JSON.stringify(inventoryPage)}, ${JSON.stringify(appName)}, ${JSON.stringify(list)}, ctx);\n`;
    while (inv(items).length > BUDGET && items.length > 10) items = items.slice(0, Math.floor(items.length * 0.8));
    scripts["inventory.js"] = inv(items);
    steps.push({ file: "inventory.js", kind: "inventory", screens: [], chars: scripts["inventory.js"].length });
  }

  // Original captures go on their own page (the flow frames stay purely editable).
  const caps = ir.screens.map((s) => ({ name: s.name, referenceAssetId: s.referenceAssetId, w: s.w, h: s.h }));
  for (let i = 0; i < caps.length; i += 40) {
    const file = `captures-${String(i / 40 + 1).padStart(2, "0")}.js`;
    scripts[file] = `${runtime}\nconst fonts = await MappyFigma.loadFonts();\nconst ctx = { slots: [], fonts, created: [] };\nreturn await MappyFigma.buildCaptures(${JSON.stringify(capturesPage)}, ${JSON.stringify(appName)}, ${JSON.stringify(caps.slice(i, i + 40))}, ${i}, ctx);\n`;
    steps.push({ file, kind: "captures", screens: [], chars: scripts[file].length });
  }

  return { plan: { projectId, appName, pageName, inventoryPage, capturesPage, origin, steps, simplified }, scripts };
}

export interface ScreensResult {
  frames?: Record<string, string>;
  hotspots?: Record<string, string>;
  slots: ImageSlot[];
}

/**
 * After the build scripts ran: which nodes need uploads (one per distinct asset), and the
 * wiring script that links hotspots, draws arrows and copies uploaded fills to duplicates.
 */
export async function finishFigmaScripts(ir: DesignIR, plan: FigmaPlan, results: ScreensResult[]): Promise<{ uploads: ImageSlot[]; wire: string }> {
  const runtime = await figmaRuntime();
  const frames: Record<string, string> = {};
  const hotspots: Record<string, string> = {};
  const byAsset = new Map<string, string[]>();
  for (const r of results) {
    Object.assign(frames, r.frames ?? {});
    Object.assign(hotspots, r.hotspots ?? {});
    for (const s of r.slots ?? []) byAsset.set(s.assetId, [...(byAsset.get(s.assetId) ?? []), s.nodeId]);
  }
  const uploads: ImageSlot[] = [];
  const imageCopies: { from: string; to: string[] }[] = [];
  for (const [assetId, nodes] of byAsset) {
    uploads.push({ assetId, nodeId: nodes[0] });
    if (nodes.length > 1) imageCopies.push({ from: nodes[0], to: nodes.slice(1) });
  }
  const part = {
    pageName: plan.pageName,
    appName: plan.appName,
    origin: plan.origin,
    frames,
    hotspots,
    screens: ir.screens.map((s) => ({ id: s.id, hotspots: s.hotspots.map((h) => ({ id: h.id, target: h.target })) })),
    edges: ir.edges.map((e) => ({ ...e, points: e.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })) })),
    startScreen: ir.startScreen,
    imageCopies,
  };
  const wire = `${runtime}\nconst fonts = await MappyFigma.loadFonts();\nconst ctx = { slots: [], fonts, created: [] };\nreturn await MappyFigma.wireFlow(${JSON.stringify(part)}, ctx);\n`;
  if (wire.length > MCP_SCRIPT_LIMIT) throw new Error(`wire script is ${wire.length} chars — too many edges/copies for one use_figma call`);
  return { uploads, wire };
}
