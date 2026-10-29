import type { DesignIR, IRLayer, IRScreen } from "@mappy/shared";

export type AssetLookup = (id: string) => Buffer | undefined;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r2 = (v: number) => Math.round(v * 100) / 100;
const dataUri = (buf: Buffer | undefined) => (buf ? `data:image/png;base64,${buf.toString("base64")}` : "");

// Roboto metrics (em) for baseline placement.
const ASC = 0.928;
const DESC = 0.244;

class Ids {
  private used = new Map<string, number>();
  next(name: string): string {
    const base = name.replace(/[^\w-]+/g, "_").replace(/^([^a-zA-Z_])/, "_$1").slice(0, 40) || "layer";
    const n = this.used.get(base) ?? 0;
    this.used.set(base, n + 1);
    return n ? `${base}_${n}` : base;
  }
}

/** Greedy word wrap using an average glyph width; good enough to keep text inside its box. */
function wrap(text: string, width: number, size: number): string[] {
  const maxChars = Math.max(1, Math.floor(width / (size * 0.52)));
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!line) line = word;
      else if ((line + " " + word).length <= maxChars) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

function layerSvg(l: IRLayer, asset: AssetLookup, ids: Ids, out: string[]): void {
  const id = ids.next(l.name);
  if (l.type === "text" && l.text) {
    const t = l.text;
    const lh = t.lineHeight ?? t.size * 1.18;
    const lines = wrap(t.chars, l.w + 2, t.size);
    const anchor = t.align === "center" ? "middle" : t.align === "right" ? "end" : "start";
    const x = t.align === "center" ? l.x + l.w / 2 : t.align === "right" ? l.x + l.w : l.x;
    const first = l.y + (lh - (ASC + DESC) * t.size) / 2 + ASC * t.size;
    const tspans = lines.map((ln, i) => `<tspan x="${r2(x)}" y="${r2(first + i * lh)}">${esc(ln)}</tspan>`).join("");
    out.push(`<text id="${id}" font-family="Roboto, sans-serif" font-size="${t.size}" font-weight="${t.weight}" fill="${t.color}" text-anchor="${anchor}">${tspans}</text>`);
    return;
  }
  if (l.type === "image") {
    const uri = l.assetId ? dataUri(asset(l.assetId)) : "";
    if (uri) out.push(`<image id="${id}" x="${r2(l.x)}" y="${r2(l.y)}" width="${r2(l.w)}" height="${r2(l.h)}" preserveAspectRatio="none" href="${uri}"/>`);
    return;
  }
  const rect = (rid: string) =>
    `<rect id="${rid}" x="${r2(l.x)}" y="${r2(l.y)}" width="${r2(l.w)}" height="${r2(l.h)}"${l.radius ? ` rx="${r2(l.radius)}"` : ""} fill="${l.fill ?? "none"}"${l.stroke ? ` stroke="${l.stroke}" stroke-width="1"` : ""}/>`;
  if (l.type === "rect") {
    out.push(rect(id));
    return;
  }
  out.push(`<g id="${id}">`);
  if (l.fill || l.stroke) out.push(rect(ids.next(`${l.name}_bg`)));
  for (const c of l.children ?? []) layerSvg(c, asset, ids, out);
  out.push(`</g>`);
}

/** Editable SVG of one reconstructed screen — drag into Figma/Penpot/Illustrator for real layers. */
export function screenSvg(screen: IRScreen, asset: AssetLookup, opts: { withReference?: boolean } = {}): string {
  const ids = new Ids();
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${r2(screen.w)}" height="${r2(screen.h)}" viewBox="0 0 ${r2(screen.w)} ${r2(screen.h)}">`);
  out.push(`<title>${esc(screen.name)}</title>`);
  if (opts.withReference) {
    out.push(`<image id="reference_screenshot" opacity="0" width="${r2(screen.w)}" height="${r2(screen.h)}" href="${dataUri(asset(screen.referenceAssetId))}"/>`);
  }
  out.push(`<rect id="${ids.next("background")}" width="${r2(screen.w)}" height="${r2(screen.h)}" fill="${screen.background}"/>`);
  for (const l of screen.layers) layerSvg(l, asset, ids, out);
  out.push(`</svg>`);
  return out.join("\n");
}

const TITLE_GAP = 56;
const MARGIN = 120;

/** Bounding box of the whole flow canvas, including screen titles. */
export function canvasBounds(ir: DesignIR) {
  const maxX = Math.max(0, ...ir.screens.map((s) => s.x + s.w), ...ir.edges.flatMap((e) => e.points.map((p) => p.x)));
  const maxY = Math.max(0, ...ir.screens.map((s) => s.y + s.h), ...ir.edges.flatMap((e) => e.points.map((p) => p.y)));
  return { width: maxX + MARGIN * 2, height: maxY + MARGIN * 2 + TITLE_GAP, offsetX: MARGIN, offsetY: MARGIN + TITLE_GAP };
}

/** Midpoint of the longest segment of a route — where the edge label goes. */
export function labelPoint(points: { x: number; y: number }[]): { x: number; y: number } {
  let best = { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 };
  let bestLen = -1;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > bestLen) {
      bestLen = len;
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return best;
}

/**
 * The whole flow on one canvas: screens at their layout positions, titled, with arrows.
 * mode "screenshots" embeds the original captures (faithful, light); "layers" embeds the
 * reconstructed editable layers.
 */
export function flowSvg(ir: DesignIR, asset: AssetLookup, mode: "screenshots" | "layers" = "screenshots"): string {
  const { width, height, offsetX, offsetY } = canvasBounds(ir);
  const ids = new Ids();
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${r2(width)}" height="${r2(height)}" viewBox="0 0 ${r2(width)} ${r2(height)}">`);
  out.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4f5bd5"/></marker></defs>`);
  out.push(`<rect width="100%" height="100%" fill="#f4f5f7"/>`);
  out.push(`<text x="${MARGIN}" y="${MARGIN - 20}" font-family="Roboto, sans-serif" font-size="44" font-weight="700" fill="#1f2328">${esc(ir.name)}</text>`);
  out.push(`<g transform="translate(${offsetX},${offsetY})">`);
  for (const s of ir.screens) {
    const gid = ids.next(s.name);
    out.push(`<g id="${gid}">`);
    out.push(`<text x="${r2(s.x)}" y="${r2(s.y - 18)}" font-family="Roboto, sans-serif" font-size="26" font-weight="500" fill="#1f2328">${esc(s.name)}${s.id === ir.startScreen ? " ★" : ""}</text>`);
    out.push(`<clipPath id="${gid}_clip"><rect x="${r2(s.x)}" y="${r2(s.y)}" width="${r2(s.w)}" height="${r2(s.h)}" rx="24"/></clipPath>`);
    out.push(`<rect x="${r2(s.x - 1)}" y="${r2(s.y - 1)}" width="${r2(s.w + 2)}" height="${r2(s.h + 2)}" rx="25" fill="#ffffff" stroke="#d0d4da" stroke-width="2"/>`);
    out.push(`<g clip-path="url(#${gid}_clip)">`);
    if (mode === "screenshots") {
      out.push(`<image x="${r2(s.x)}" y="${r2(s.y)}" width="${r2(s.w)}" height="${r2(s.h)}" preserveAspectRatio="none" href="${dataUri(asset(s.referenceAssetId))}"/>`);
    } else {
      out.push(`<g transform="translate(${r2(s.x)},${r2(s.y)})"><rect width="${r2(s.w)}" height="${r2(s.h)}" fill="${s.background}"/>`);
      for (const l of s.layers) layerSvg(l, asset, ids, out);
      out.push(`</g>`);
    }
    out.push(`</g>`);
    for (const h of s.hotspots) {
      out.push(`<rect x="${r2(s.x + h.x)}" y="${r2(s.y + h.y)}" width="${r2(h.w)}" height="${r2(h.h)}" rx="8" fill="#4f5bd5" fill-opacity="0.08" stroke="#4f5bd5" stroke-width="2" stroke-dasharray="6 4"/>`);
    }
    out.push(`</g>`);
  }
  for (const e of ir.edges) {
    if (e.points.length < 2) continue;
    const d = e.points.map((p, i) => `${i ? "L" : "M"}${r2(p.x)},${r2(p.y)}`).join(" ");
    out.push(`<path d="${d}" fill="none" stroke="#4f5bd5" stroke-width="3" stroke-linejoin="round" marker-end="url(#arrow)"/>`);
    if (e.label) {
      const p = labelPoint(e.points);
      const w = Math.min(320, e.label.length * 11 + 20);
      out.push(`<rect x="${r2(p.x - w / 2)}" y="${r2(p.y - 17)}" width="${r2(w)}" height="30" rx="15" fill="#ffffff" stroke="#c7cbf5"/>`);
      out.push(`<text x="${r2(p.x)}" y="${r2(p.y + 5)}" font-family="Roboto, sans-serif" font-size="17" fill="#3a44b0" text-anchor="middle">${esc(e.label.length > 28 ? e.label.slice(0, 27) + "…" : e.label)}</text>`);
    }
  }
  out.push(`</g></svg>`);
  return out.join("\n");
}
