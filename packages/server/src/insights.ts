import { analyzeText, contrastRatio, extractElements, nodeLabel, Pixels } from "@mappy/engine";
import { shortClass, type Rect } from "@mappy/shared";
import type { ProjectStore } from "./store.ts";

export interface Finding {
  kind: "tapTarget" | "unlabeled" | "contrast" | "deep" | "deadEnd" | "crash" | "orphan" | "external";
  severity: "high" | "medium" | "low";
  screenId: string;
  screenName: string;
  message: string;
  bounds?: Rect;
  obsId?: string;
}

const cache = new Map<string, { key: string; value: unknown }>();

/** UX and accessibility findings derived from the crawl (per representative screen). */
export async function computeInsights(store: ProjectStore, id: string) {
  const project = await store.get(id);
  const files = store.filesOf(id);
  const observations = await files.observations();
  const transitions = await files.transitions();
  const key = `${observations.length}|${transitions.length}|${JSON.stringify(await store.overrides(id))}`;
  const hit = cache.get(id);
  if (hit?.key === key) return hit.value;

  const map = await store.map(id);
  const byId = new Map(observations.map((o) => [o.id, o]));
  const s = 160 / project.device.density;
  const findings: Finding[] = [];
  const appScreens = map.screens.filter((sc) => sc.kind === "app" && !sc.hidden);

  for (const sc of appScreens) {
    const obs = byId.get(sc.repObs)!;
    const nodes = await store.nodes(id, obs);
    if (!nodes) continue;
    const els = extractElements(nodes, {
      pkg: project.app.pkg,
      screen: { w: obs.widthPx, h: obs.heightPx },
      listSample: 99,
      riskyPatterns: [],
      scroll: false,
      longPress: false,
      inputs: true,
    });
    const base = { screenId: sc.id, screenName: sc.name, obsId: obs.id };
    for (const el of els) {
      const n = nodes[el.nodeIdx];
      const w = el.bounds.w * s;
      const h = el.bounds.h * s;
      if (Math.min(w, h) < 48 && el.kind !== "input") {
        findings.push({ ...base, kind: "tapTarget", severity: Math.min(w, h) < 32 ? "high" : "medium", message: `"${el.label}" is ${Math.round(w)}×${Math.round(h)}dp — below the 48dp minimum touch target`, bounds: el.bounds });
      }
      const hasLabel = !!(n.text || n.desc || n.hint) || nodeLabel(nodes, n) !== (n.rid ? n.rid.slice(n.rid.indexOf("/") + 1).replace(/_/g, " ") : shortClass(n.cls));
      if (!hasLabel && (el.kind === "tap" || el.kind === "toggle")) {
        findings.push({ ...base, kind: "unlabeled", severity: "high", message: `${shortClass(n.cls)} "${el.label}" has no text or content description — screen readers announce it as unlabeled`, bounds: el.bounds });
      }
    }
    const png = await files.readPng(obs);
    if (png) {
      const px = await Pixels.load(png);
      for (const n of nodes) {
        if (n.pkg !== project.app.pkg || !n.text.trim() || n.children.length || n.bounds.h < 8 || n.bounds.w < 8) continue;
        const ink = analyzeText(px, n.bounds);
        if (!ink || !ink.lines) continue;
        const ratio = contrastRatio(ink.fg, ink.bg);
        const sizeDp = ink.lineInk * s * 1.3;
        const large = sizeDp >= 18;
        const min = large ? 3 : 4.5;
        if (ratio < min) {
          findings.push({ ...base, kind: "contrast", severity: ratio < min * 0.7 ? "high" : "medium", message: `"${n.text.slice(0, 40)}" contrast ${ratio.toFixed(2)}:1 — WCAG AA needs ${min}:1`, bounds: n.bounds });
        }
      }
    }
    if (sc.depth !== null && sc.depth >= 4) {
      findings.push({ ...base, kind: "deep", severity: sc.depth >= 6 ? "medium" : "low", message: `Takes ${sc.depth} taps to reach from the launch screen` });
    }
    if (sc.depth === null) {
      findings.push({ ...base, kind: "orphan", severity: "low", message: "Not reachable by forward navigation from the launch screen (reached via back, restart or take-over)" });
    }
    const out = map.edges.filter((e) => e.from === sc.id && e.to !== sc.id && e.actionType !== "back");
    if (!out.length) {
      findings.push({ ...base, kind: "deadEnd", severity: "low", message: "Dead end — no way forward except Back" });
    }
  }
  for (const e of map.edges) {
    const from = map.screens.find((x) => x.id === e.from);
    if (!from) continue;
    if (e.outcome === "crash") findings.push({ kind: "crash", severity: "high", screenId: from.id, screenName: from.name, message: `"${e.label}" crashed the app`, bounds: e.bounds });
    if (e.outcome === "external") {
      const to = map.screens.find((x) => x.id === e.to);
      findings.push({ kind: "external", severity: "low", screenId: from.id, screenName: from.name, message: `"${e.label}" leaves the app (${to?.pkg ?? "another app"})`, bounds: e.bounds });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const depths = appScreens.map((x) => x.depth).filter((d): d is number => d !== null);
  const value = {
    summary: {
      screens: appScreens.length,
      maxDepth: depths.length ? Math.max(...depths) : 0,
      avgDepth: depths.length ? Math.round((depths.reduce((a, b) => a + b, 0) / depths.length) * 10) / 10 : 0,
      byKind: findings.reduce<Record<string, number>>((acc, f) => ((acc[f.kind] = (acc[f.kind] ?? 0) + 1), acc), {}),
    },
    findings,
  };
  cache.set(id, { key, value });
  return value;
}
