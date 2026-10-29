import { createHash } from "node:crypto";
import sharp from "sharp";
import { rectNear, shortClass, shortRid, type IRLayer, type Rect, type UiNode } from "@mappy/shared";
import { analyzeText, colorDist, cornerRadius, Pixels, toHex, trimToFill, type RGB } from "./pixels.ts";

/** Collects image assets (screenshots, crops) and deduplicates them by content. */
export class AssetSink {
  readonly files = new Map<string, { png: Buffer; w: number; h: number }>();

  add(png: Buffer, w: number, h: number): string {
    const id = createHash("sha1").update(png).digest("hex").slice(0, 16);
    if (!this.files.has(id)) this.files.set(id, { png, w, h });
    return id;
  }

  async crop(full: Buffer, r: Rect): Promise<{ id: string; w: number; h: number }> {
    const png = await sharp(full).extract({ left: r.x, top: r.y, width: r.w, height: r.h }).png({ compressionLevel: 6 }).toBuffer();
    return { id: this.add(png, r.w, r.h), w: r.w, h: r.h };
  }
}

export interface ReconstructInput {
  png: Buffer;
  nodes: UiNode[] | null;
  appPkg: string;
  /** Device density in dpi. */
  density: number;
  /** Treat as an opaque screenshot (other apps, system dialogs, FLAG_SECURE). */
  opaque?: boolean;
}

export interface ReconstructedScreen {
  w: number;
  h: number;
  background: string;
  referenceAssetId: string;
  layers: IRLayer[];
}

// Roboto vertical metrics (em): used to turn measured ink height into a font size.
const CAP = 0.711;
const XH = 0.528;
const DESC = 0.21;
const SIZES = [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 45, 48, 52, 57, 64];

const snapSize = (v: number) => SIZES.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), SIZES[0]);

function inkEm(text: string): number {
  const hasTall = /[A-Z0-9bdfhklt!?#%&@()[\]{}|/\\]/.test(text);
  const hasDesc = /[gjpqy,;()[\]{}|]/.test(text);
  return (hasTall ? CAP : XH) + (hasDesc ? DESC : 0);
}

const IMAGE_CLASS = /ImageView|ImageButton|\.Image$|ProgressBar|SeekBar|RatingBar/;
const CONTROL_CLASS = /Switch|CheckBox|RadioButton|ToggleButton|CompoundButton/;

let layerSeq = 0;
const lid = (prefix: string) => `${prefix}${(layerSeq++).toString(36)}`;

function layerName(n: UiNode): string {
  if (n.rid) return shortRid(n.rid);
  const t = (n.text || n.desc).trim();
  if (t) return t.slice(0, 32);
  return shortClass(n.cls);
}

/**
 * Turn a screenshot + UI hierarchy into an editable layer tree (dp units):
 * containers become frames with sampled fills/strokes/radii, text becomes live text with
 * sampled colour and estimated size, and images/icons/controls become image crops.
 */
export async function reconstructScreen(input: ReconstructInput, assets: AssetSink): Promise<ReconstructedScreen> {
  const px = await Pixels.load(input.png);
  const W = px.w;
  const H = px.h;
  const s = 160 / input.density;
  const dp = (v: number) => Math.round(v * s * 100) / 100;
  const referenceAssetId = assets.add(input.png, W, H);
  const nodes = input.nodes ?? [];
  const appNodes = nodes.filter((n) => n.pkg === input.appPkg);
  // Window background: what's left visible once every leaf view is masked out.
  const leaves = appNodes.filter((n) => !n.children.length).map((n) => n.bounds);
  const statusStrip = { x: 0, y: 0, w: W, h: Math.round((24 * input.density) / 160) };
  const screenBg = (px.dominant({ x: 0, y: 0, w: W, h: H }, [...leaves, statusStrip]) ?? px.dominant({ x: 0, y: 0, w: W, h: H }))?.color ?? [255, 255, 255];
  const result: ReconstructedScreen = { w: dp(W), h: dp(H), background: toHex(screenBg), referenceAssetId, layers: [] };

  if (input.opaque || !appNodes.length) {
    result.layers.push({ id: lid("img"), type: "image", name: "Screenshot", x: 0, y: 0, w: dp(W), h: dp(H), assetId: referenceAssetId });
    return result;
  }

  const crop = async (r: Rect, name: string, n?: UiNode): Promise<IRLayer | null> => {
    const c = px.clip(r);
    if (!c || c.w < 2 || c.h < 2) return null;
    const a = await assets.crop(input.png, c);
    return {
      id: lid("img"),
      type: "image",
      name,
      x: dp(c.x),
      y: dp(c.y),
      w: dp(c.w),
      h: dp(c.h),
      assetId: a.id,
      source: n ? { cls: n.cls, rid: n.rid || undefined, nodeIdx: n.idx } : undefined,
    };
  };

  const textLayer = (n: UiNode, r: Rect, chars: string, parentBg: RGB): { layer: IRLayer; bg: RGB } | null => {
    const ink = analyzeText(px, r);
    if (!ink || !ink.lines) return null;
    const em = inkEm(chars);
    const sizePx = ink.lineInk >= 4 ? ink.lineInk / em : (r.h / ink.lines) * 0.6;
    const size = snapSize(sizePx * s);
    const lineH = Math.round(size * 1.18 * 10) / 10;
    const leftGap = ink.inkLeft - r.x;
    const rightGap = r.x + r.w - ink.inkRight;
    let align: "left" | "center" | "right" = "left";
    if (Math.abs(leftGap - rightGap) < Math.max(6, r.w * 0.08) && leftGap > 6) align = "center";
    else if (leftGap > rightGap * 2 && leftGap > 12) align = "right";
    const x = align === "left" ? Math.max(r.x, ink.inkLeft - 2) : r.x;
    const w = align === "right" ? ink.inkRight - r.x + 3 : r.x + r.w - x;
    const blockH = (lineH * ink.lines) / s;
    const y = r.y + (r.h - blockH) / 2;
    const weight = ink.density > 0.34 ? 700 : ink.density > 0.27 || /Button/.test(n.cls) ? 500 : 400;
    return {
      bg: ink.bg,
      layer: {
        id: lid("txt"),
        type: "text",
        name: chars.slice(0, 32),
        x: dp(x),
        y: dp(y),
        w: dp(Math.max(w, 4)),
        h: dp(blockH),
        text: { chars, family: "Roboto", weight, size, lineHeight: lineH, color: toHex(colorDist(ink.fg, ink.bg) < 30 ? (parentBg[0] > 128 ? [32, 33, 36] : [240, 240, 240]) : ink.fg), align },
        source: { cls: n.cls, rid: n.rid || undefined, nodeIdx: n.idx },
      },
    };
  };

  const walk = async (n: UiNode, parentBg: RGB): Promise<IRLayer[]> => {
    const r = px.clip(n.bounds);
    if (!r || r.w < 2 || r.h < 2) return [];
    const kids = n.children.map((c) => nodes[c]).filter((c) => c.pkg === input.appPkg && px.clip(c.bounds));
    const label = n.text.trim();
    const source = { cls: n.cls, rid: n.rid || undefined, nodeIdx: n.idx };

    // Images, icons and stateful controls are kept as pixels.
    if ((IMAGE_CLASS.test(n.cls) || CONTROL_CLASS.test(n.cls) || (n.checkable && !kids.length)) && !label) {
      const dom = px.dominant(r);
      if (dom && dom.share > 0.985) {
        return colorDist(dom.color, parentBg) > 12 ? [{ id: lid("rect"), type: "rect", name: layerName(n), x: dp(r.x), y: dp(r.y), w: dp(r.w), h: dp(r.h), fill: toHex(dom.color), source }] : [];
      }
      const img = await crop(r, layerName(n), n);
      return img ? [img] : [];
    }

    // Leaf text (TextView, Button with a caption, EditText with text or hint).
    if (!kids.length && (label || (n.editable && n.hint))) {
      const chars = label || n.hint;
      const dom = px.dominant(r);
      const ring = n.editable ? px.ring(r) : null;
      const t = textLayer(n, r, chars, dom?.color ?? parentBg);
      if (!t) return [];
      const ownBg = t.bg;
      const hasBg = colorDist(ownBg, parentBg) > 18;
      const stroke = ring && ring.share > 0.6 && colorDist(ring.color, ownBg) > 40 ? toHex(ring.color) : undefined;
      if (!hasBg && !stroke && !n.clickable) return [t.layer];
      const box = hasBg ? trimToFill(px, r, ownBg, parentBg) : r;
      return [
        {
          id: lid("frm"),
          type: "frame",
          name: layerName(n),
          x: dp(box.x),
          y: dp(box.y),
          w: dp(box.w),
          h: dp(box.h),
          fill: hasBg ? toHex(ownBg) : undefined,
          stroke,
          radius: hasBg ? dp(cornerRadius(px, box, ownBg, parentBg)) : undefined,
          source,
          children: [t.layer],
        },
      ];
    }

    // Leaf without text: a plain colour block, or pixels (custom drawing, canvas, video).
    if (!kids.length) {
      const dom = px.dominant(r);
      if (!dom) return [];
      if (dom.share > 0.97) {
        return colorDist(dom.color, parentBg) > 12 ? [{ id: lid("rect"), type: "rect", name: layerName(n), x: dp(r.x), y: dp(r.y), w: dp(r.w), h: dp(r.h), fill: toHex(dom.color), source }] : [];
      }
      if (dom.share > 0.6 && colorDist(dom.color, parentBg) > 12) {
        // Mostly one colour with inset/rounded edges: a shape, not a picture.
        const box = trimToFill(px, r, dom.color, parentBg);
        const inner = px.dominant(box);
        if (inner && inner.share > 0.97) {
          return [{ id: lid("rect"), type: "rect", name: layerName(n), x: dp(box.x), y: dp(box.y), w: dp(box.w), h: dp(box.h), fill: toHex(dom.color), radius: dp(cornerRadius(px, box, dom.color, parentBg)), source }];
        }
      }
      const img = await crop(r, layerName(n), n);
      return img ? [img] : [];
    }

    // Container: sample its own background (excluding children) and recurse.
    const childRects = kids.map((k) => k.bounds);
    const dom = px.dominant(r, childRects) ?? px.dominant(r);
    const fillRgb = dom && dom.share >= 0.8 && colorDist(dom.color, parentBg) > 12 ? dom.color : undefined;
    const ring = n.clickable || n.editable ? px.ring(r) : null;
    const stroke = ring && ring.share > 0.7 && colorDist(ring.color, fillRgb ?? parentBg) > 40 ? toHex(ring.color) : undefined;
    const bgForKids = fillRgb ?? parentBg;
    const childLayers = (await Promise.all(kids.map((k) => walk(k, bgForKids)))).flat();
    const meaningful = !!fillRgb || !!stroke || n.clickable || n.scrollable || !!n.rid;
    if (!meaningful) return childLayers; // flatten pass-through layout containers
    if (!fillRgb && !stroke && childLayers.length === 1 && rectNear({ x: childLayers[0].x, y: childLayers[0].y, w: childLayers[0].w, h: childLayers[0].h }, { x: dp(r.x), y: dp(r.y), w: dp(r.w), h: dp(r.h) }, 2)) {
      return [{ ...childLayers[0], name: layerName(n) }];
    }
    if (!childLayers.length && !fillRgb && !stroke) return [];
    const box = fillRgb ? trimToFill(px, r, fillRgb, parentBg) : r;
    return [
      {
        id: lid("frm"),
        type: "frame",
        name: layerName(n),
        x: dp(box.x),
        y: dp(box.y),
        w: dp(box.w),
        h: dp(box.h),
        fill: fillRgb ? toHex(fillRgb) : undefined,
        stroke,
        radius: fillRgb ? dp(cornerRadius(px, box, fillRgb, parentBg)) : undefined,
        source,
        children: childLayers,
      },
    ];
  };

  const roots = appNodes.filter((n) => n.parent === null || nodes[n.parent].pkg !== input.appPkg);
  for (const root of roots) result.layers.push(...(await walk(root, screenBg)));

  // System bars are captured as pixels on top so edge-to-edge apps still look right.
  const top = Math.min(...roots.map((r) => r.bounds.y));
  const bottom = Math.max(...roots.map((r) => r.bounds.y + r.bounds.h));
  const statusH = Math.max(top, Math.round((24 * input.density) / 160));
  const status = await crop({ x: 0, y: 0, w: W, h: Math.min(statusH, H) }, "Status bar");
  if (status && top < H / 2) result.layers.push(status);
  if (bottom < H - 2) {
    const nav = await crop({ x: 0, y: bottom, w: W, h: H - bottom }, "Navigation bar");
    if (nav) result.layers.push(nav);
  }
  return result;
}

/** Count layers in a tree (for fidelity reporting and tests). */
export function countLayers(layers: IRLayer[]): Record<IRLayer["type"], number> {
  const out = { frame: 0, rect: 0, text: 0, image: 0 };
  const walk = (ls: IRLayer[]) => {
    for (const l of ls) {
      out[l.type]++;
      if (l.children) walk(l.children);
    }
  };
  walk(layers);
  return out;
}
