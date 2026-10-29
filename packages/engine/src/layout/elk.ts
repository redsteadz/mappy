import ElkBundled from "elkjs/lib/elk.bundled.js";
import type { ELK as ElkApi, ElkExtendedEdge } from "elkjs/lib/elk-api.js";
import type { Point } from "@mappy/shared";

// elk.bundled is CommonJS; depending on interop the constructor is the module or its default.
const ELK = ((ElkBundled as unknown as { default?: unknown }).default ?? ElkBundled) as unknown as new () => ElkApi;

export interface LayoutNode {
  id: string;
  w: number;
  h: number;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
}

export interface LayoutResult {
  positions: Map<string, Point>;
  routes: Map<string, Point[]>;
  width: number;
  height: number;
}

/** Layered (top-down by default) layout of the screen graph with orthogonal edge routes (all in dp). */
export async function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], opts: { spacing?: number; direction?: "DOWN" | "RIGHT" } = {}): Promise<LayoutResult> {
  const spacing = opts.spacing ?? 140;
  const ids = new Set(nodes.map((n) => n.id));
  const elk = new ELK();
  const graph = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": opts.direction ?? "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": String(spacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(spacing * 2),
      "elk.spacing.edgeEdge": "24",
      "elk.spacing.edgeNode": "40",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": String(spacing * 2),
    },
    children: nodes.map((n) => ({ id: n.id, width: n.w, height: n.h })),
    edges: edges
      .filter((e) => e.from !== e.to && ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  });
  const positions = new Map<string, Point>();
  for (const c of graph.children ?? []) positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  const routes = new Map<string, Point[]>();
  for (const e of (graph.edges ?? []) as ElkExtendedEdge[]) {
    const sec = e.sections?.[0];
    if (!sec) continue;
    routes.set(e.id, [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x, y: p.y })));
  }
  const size = graph as { width?: number; height?: number };
  return { positions, routes, width: size.width ?? 0, height: size.height ?? 0 };
}
