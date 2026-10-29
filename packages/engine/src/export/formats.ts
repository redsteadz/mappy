import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { strToU8, zipSync } from "fflate";
import PDFDocument from "pdfkit";
import type { CrawlMap, DesignIR } from "@mappy/shared";
import { canvasBounds, flowSvg, labelPoint, screenSvg, type AssetLookup } from "./svg.ts";

export const ROBOTO_TTF = fileURLToPath(new URL("../../../../assets/fonts/Roboto.ttf", import.meta.url));

/** Mermaid flowchart of the screen graph (paste into GitHub, Notion, mermaid.live …). */
export function toMermaid(map: CrawlMap, opts: { includeBack?: boolean } = {}): string {
  const visible = map.screens.filter((s) => !s.hidden);
  const idOf = new Map(visible.map((s, i) => [s.id, `s${i}`]));
  const q = (s: string) => `"${s.replace(/"/g, "#quot;").replace(/\n/g, " ")}"`;
  const lines = ["flowchart LR"];
  for (const s of visible) {
    const shape = s.kind === "app" ? `[${q(s.name)}]` : `([${q(s.name)}])`;
    lines.push(`  ${idOf.get(s.id)}${shape}`);
  }
  const seen = new Set<string>();
  for (const e of map.edges) {
    const a = idOf.get(e.from);
    const b = idOf.get(e.to);
    if (!a || !b || e.from === e.to) continue;
    if (e.actionType === "back" && !opts.includeBack) continue;
    if (["restart", "launch", "manual"].includes(e.actionType)) continue;
    const key = `${a}>${b}>${e.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const arrow = e.outcome === "crash" ? "-.->" : e.outcome === "external" ? "-->" : "-->";
    lines.push(`  ${a} ${arrow}|${q(e.label.slice(0, 40))}| ${b}`);
  }
  if (map.startScreen && idOf.get(map.startScreen)) lines.push(`  style ${idOf.get(map.startScreen)} stroke:#4f5bd5,stroke-width:3px`);
  const ext = visible.filter((s) => s.kind !== "app").map((s) => idOf.get(s.id));
  if (ext.length) {
    lines.push("  classDef foreign fill:#fff4e5,stroke:#e0a040,color:#5a3a00");
    lines.push(`  class ${ext.join(",")} foreign`);
  }
  return lines.join("\n") + "\n";
}

/** Raster poster of the whole flow (PNG), rendered with resvg and bundled Roboto. */
export function posterPng(ir: DesignIR, asset: AssetLookup, maxWidth = 9000): Buffer {
  const svg = flowSvg(ir, asset, "screenshots");
  const { width } = canvasBounds(ir);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: Math.min(maxWidth, Math.round(width * 1.5)) },
    font: { fontFiles: existsSync(ROBOTO_TTF) ? [ROBOTO_TTF] : [], loadSystemFonts: true, defaultFontFamily: "Roboto" },
    imageRendering: 0,
  });
  return Buffer.from(resvg.render().asPng());
}

/** Vector PDF poster: screenshots placed at layout positions, arrows and labels drawn natively. */
export function posterPdf(ir: DesignIR, asset: AssetLookup): Promise<Buffer> {
  const { width, height, offsetX, offsetY } = canvasBounds(ir);
  const scale = Math.min(1, 14000 / Math.max(width, height));
  const doc = new PDFDocument({ size: [width * scale, height * scale], margin: 0, info: { Title: ir.name, Creator: "Mappy" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  if (existsSync(ROBOTO_TTF)) doc.registerFont("Roboto", ROBOTO_TTF);
  const font = existsSync(ROBOTO_TTF) ? "Roboto" : "Helvetica";
  doc.scale(scale);
  doc.rect(0, 0, width, height).fill("#f4f5f7");
  doc.fillColor("#1f2328").font(font).fontSize(44).text(ir.name, 120, 50, { lineBreak: false });
  doc.translate(offsetX, offsetY);
  for (const s of ir.screens) {
    doc.fillColor("#1f2328").fontSize(26).text(s.name + (s.id === ir.startScreen ? "  ★" : ""), s.x, s.y - 40, { lineBreak: false });
    doc.save();
    doc.roundedRect(s.x, s.y, s.w, s.h, 24).clip();
    const png = asset(s.referenceAssetId);
    if (png) doc.image(png, s.x, s.y, { width: s.w, height: s.h });
    doc.restore();
    doc.roundedRect(s.x, s.y, s.w, s.h, 24).lineWidth(2).stroke("#d0d4da");
    for (const h of s.hotspots) {
      doc.roundedRect(s.x + h.x, s.y + h.y, h.w, h.h, 8).lineWidth(2).dash(6, { space: 4 }).stroke("#4f5bd5").undash();
    }
  }
  for (const e of ir.edges) {
    if (e.points.length < 2) continue;
    doc.moveTo(e.points[0].x, e.points[0].y);
    for (const p of e.points.slice(1)) doc.lineTo(p.x, p.y);
    doc.lineWidth(3).lineJoin("round").stroke("#4f5bd5");
    const a = e.points[e.points.length - 2];
    const b = e.points[e.points.length - 1];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const L = 16;
    doc
      .polygon([b.x, b.y], [b.x - L * Math.cos(ang - 0.4), b.y - L * Math.sin(ang - 0.4)], [b.x - L * Math.cos(ang + 0.4), b.y - L * Math.sin(ang + 0.4)])
      .fill("#4f5bd5");
    if (e.label) {
      const p = labelPoint(e.points);
      const label = e.label.length > 28 ? e.label.slice(0, 27) + "…" : e.label;
      doc.fontSize(17);
      const w = doc.widthOfString(label) + 24;
      doc.roundedRect(p.x - w / 2, p.y - 16, w, 30, 15).fillAndStroke("#ffffff", "#c7cbf5");
      doc.fillColor("#3a44b0").text(label, p.x - w / 2 + 12, p.y - 9, { lineBreak: false });
    }
  }
  doc.end();
  return done;
}

/** Portable bundle consumed by the Figma and Penpot plugins: ir.json + assets/*.png. */
export function bundleZip(ir: DesignIR, asset: AssetLookup): Buffer {
  const files: Record<string, Uint8Array> = {
    "ir.json": strToU8(JSON.stringify(ir)),
    "README.txt": strToU8(
      `Mappy export: ${ir.name}\n\nImport this file with the Mappy Penpot plugin (http://localhost:4317/plugins/penpot/manifest.json)\nor the Mappy Figma plugin. ir.json describes screens, layers (dp), hotspots and flow edges; assets/ holds PNGs.\n`,
    ),
  };
  for (const a of Object.values(ir.assets)) {
    const buf = asset(a.id);
    if (buf) files[a.file] = buf;
  }
  return Buffer.from(zipSync(files, { level: 0 }));
}

/** Zip of one editable SVG per screen plus the whole-flow SVGs. */
export function svgZip(ir: DesignIR, asset: AssetLookup): Buffer {
  const files: Record<string, Uint8Array> = {};
  ir.screens.forEach((s, i) => {
    const name = `${String(i + 1).padStart(2, "0")}-${s.name.replace(/[^\w-]+/g, "_").slice(0, 40)}.svg`;
    files[`screens/${name}`] = strToU8(screenSvg(s, asset));
  });
  files["flow-screenshots.svg"] = strToU8(flowSvg(ir, asset, "screenshots"));
  files["flow-editable.svg"] = strToU8(flowSvg(ir, asset, "layers"));
  return Buffer.from(zipSync(files, { level: 6 }));
}
