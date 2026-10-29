import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { bundleZip, buildDesignIR, extractElements, fidelity, flowSvg, posterPdf, posterPng, screenSvg, svgZip, toMermaid, type AssetLookup } from "@mappy/engine";
import { hashString, type DesignIR } from "@mappy/shared";
import type { ProjectStore } from "./store.ts";

interface CachedIR {
  key: string;
  ir: DesignIR;
  asset: AssetLookup;
}

const cache = new Map<string, CachedIR>();
const building = new Map<string, Promise<CachedIR>>();

async function irKey(store: ProjectStore, id: string): Promise<string> {
  const files = store.filesOf(id);
  const [obs, trans, overrides] = await Promise.all([files.observations(), files.transitions(), store.overrides(id)]);
  return hashString(`${obs.length}|${trans.length}|${JSON.stringify(overrides)}`);
}

/** Build (or reuse) the design IR for a project; assets are also written to <project>/export/. */
export async function getIR(store: ProjectStore, id: string): Promise<CachedIR> {
  const key = await irKey(store, id);
  const hit = cache.get(id);
  if (hit?.key === key) return hit;
  const inflight = building.get(`${id}:${key}`);
  if (inflight) return inflight;
  const p = (async () => {
    const project = await store.get(id);
    const map = await store.map(id);
    const files = store.filesOf(id);
    const observations = await files.observations();
    const byId = new Map(observations.map((o) => [o.id, o]));
    const { ir, assets } = await buildDesignIR({
      name: project.app.label ?? project.app.pkg,
      app: project.app,
      device: project.device,
      map,
      observation: (oid) => byId.get(oid)!,
      png: async (o) => (await files.readPng(o))!,
      nodes: (o) => store.nodes(id, o),
      elements: (o, nodes) =>
        extractElements(nodes, {
          pkg: project.app.pkg,
          screen: { w: o.widthPx, h: o.heightPx },
          listSample: project.config.listSample,
          riskyPatterns: [],
          scroll: false,
          longPress: false,
          inputs: true,
        }),
    });
    const outDir = join(store.dirOf(id), "export");
    await mkdir(join(outDir, "assets"), { recursive: true });
    for (const [aid, f] of assets.files) {
      const path = join(outDir, "assets", `${aid}.png`);
      if (!existsSync(path)) await writeFile(path, f.png);
    }
    await writeFile(join(outDir, "ir.json"), JSON.stringify(ir));
    const entry: CachedIR = { key, ir, asset: (aid) => assets.files.get(aid)?.png };
    cache.set(id, entry);
    return entry;
  })();
  building.set(`${id}:${key}`, p);
  try {
    return await p;
  } finally {
    building.delete(`${id}:${key}`);
  }
}

const slug = (s: string) => s.replace(/[^\w-]+/g, "_").slice(0, 48) || "mappy";

export function registerExportRoutes(app: FastifyInstance, store: ProjectStore): void {
  app.get<{ Params: { id: string } }>("/api/projects/:id/ir", async (req) => (await getIR(store, req.params.id)).ir);

  app.get<{ Params: { id: string; asset: string } }>("/api/projects/:id/assets/:asset", async (req, reply) => {
    const aid = req.params.asset.replace(/\.png$/, "");
    if (!/^[0-9a-f]{16}$/.test(aid)) throw Object.assign(new Error("bad asset id"), { statusCode: 404 });
    const path = join(store.dirOf(req.params.id), "export", "assets", `${aid}.png`);
    const buf = existsSync(path) ? await readFile(path) : (await getIR(store, req.params.id)).asset(aid);
    if (!buf) throw Object.assign(new Error("asset not found"), { statusCode: 404 });
    reply.type("image/png").header("Cache-Control", "public, max-age=31536000, immutable").send(buf);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/fidelity", async (req) => {
    const { ir, asset } = await getIR(store, req.params.id);
    const out: Record<string, number> = {};
    for (const s of ir.screens) out[s.id] = await fidelity(s, asset);
    return out;
  });

  app.get<{ Params: { id: string; sid: string } }>("/api/projects/:id/export/screen/:sid", async (req, reply) => {
    const { ir, asset } = await getIR(store, req.params.id);
    const s = ir.screens.find((x) => x.id === req.params.sid.replace(/\.svg$/, ""));
    if (!s) throw Object.assign(new Error("screen not found"), { statusCode: 404 });
    reply.type("image/svg+xml").header("Content-Disposition", `attachment; filename="${slug(s.name)}.svg"`).send(screenSvg(s, asset));
  });

  app.get<{ Params: { id: string; format: string } }>("/api/projects/:id/export/:format", async (req, reply) => {
    const id = req.params.id;
    const project = await store.get(id);
    const base = slug(project.app.label ?? project.app.pkg);
    const send = (body: Buffer | string, type: string, file: string) =>
      reply.type(type).header("Content-Disposition", `attachment; filename="${file}"`).send(body);
    switch (req.params.format) {
      case "mermaid": {
        const { clusterer: _c, ...map } = await store.map(id);
        return send(toMermaid(map), "text/plain; charset=utf-8", `${base}-flow.mmd`);
      }
      case "json": {
        const { clusterer: _c, ...map } = await store.map(id);
        const { ir } = await getIR(store, id);
        return send(JSON.stringify({ project, map, ir }, null, 2), "application/json", `${base}-map.json`);
      }
    }
    const { ir, asset } = await getIR(store, id);
    switch (req.params.format) {
      case "svg":
        return send(svgZip(ir, asset), "application/zip", `${base}-svg.zip`);
      case "flow.svg":
        return send(flowSvg(ir, asset, "screenshots"), "image/svg+xml", `${base}-flow.svg`);
      case "poster.png":
        return send(posterPng(ir, asset), "image/png", `${base}-poster.png`);
      case "poster.pdf":
        return send(await posterPdf(ir, asset), "application/pdf", `${base}-poster.pdf`);
      case "bundle":
        return send(bundleZip(ir, asset), "application/zip", `${base}.mappy.zip`);
      default:
        throw Object.assign(new Error(`unknown export format ${req.params.format}`), { statusCode: 404 });
    }
  });
}
