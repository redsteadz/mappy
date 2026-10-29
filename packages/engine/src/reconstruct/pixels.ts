import sharp from "sharp";
import type { Rect } from "@mappy/shared";

export type RGB = [number, number, number];

/** Decoded screenshot with helpers for sampling colours inside rectangles. */
export class Pixels {
  readonly w: number;
  readonly h: number;
  readonly data: Buffer;

  constructor(data: Buffer, w: number, h: number) {
    this.data = data;
    this.w = w;
    this.h = h;
  }

  static async load(png: Buffer): Promise<Pixels> {
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return new Pixels(data, info.width, info.height);
  }

  at(x: number, y: number): RGB {
    const xi = Math.min(this.w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(this.h - 1, Math.max(0, Math.round(y)));
    const i = (yi * this.w + xi) * 3;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  clip(r: Rect): Rect | null {
    const x = Math.max(0, Math.floor(r.x));
    const y = Math.max(0, Math.floor(r.y));
    const x2 = Math.min(this.w, Math.ceil(r.x + r.w));
    const y2 = Math.min(this.h, Math.ceil(r.y + r.h));
    return x2 - x >= 1 && y2 - y >= 1 ? { x, y, w: x2 - x, h: y2 - y } : null;
  }

  /**
   * Dominant colour of a region (optionally excluding sub-rectangles), on a sampling grid.
   * Colours are quantised to 4 bits/channel for voting, then averaged within the winning bucket.
   */
  dominant(r: Rect, exclude: Rect[] = [], maxSamples = 2500): { color: RGB; share: number; samples: number } | null {
    const c = this.clip(r);
    if (!c) return null;
    const step = Math.max(1, Math.sqrt((c.w * c.h) / maxSamples));
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    let total = 0;
    for (let y = c.y + step / 2; y < c.y + c.h; y += step) {
      for (let x = c.x + step / 2; x < c.x + c.w; x += step) {
        if (exclude.some((e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h)) continue;
        const [pr, pg, pb] = this.at(x, y);
        const key = ((pr >> 4) << 8) | ((pg >> 4) << 4) | (pb >> 4);
        const bk = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        bk.n++;
        bk.r += pr;
        bk.g += pg;
        bk.b += pb;
        buckets.set(key, bk);
        total++;
      }
    }
    if (!total) return null;
    let best = { n: 0, r: 0, g: 0, b: 0 };
    for (const b of buckets.values()) if (b.n > best.n) best = b;
    return { color: [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)], share: best.n / total, samples: total };
  }

  /** Dominant colour along the 1px ring just inside a rectangle. */
  ring(r: Rect, inset = 1): { color: RGB; share: number } | null {
    const c = this.clip(r);
    if (!c || c.w < 6 || c.h < 6) return null;
    const pts: RGB[] = [];
    const n = 40;
    for (let i = 0; i < n; i++) {
      const fx = c.x + inset + ((c.w - 2 * inset - 1) * i) / (n - 1);
      const fy = c.y + inset + ((c.h - 2 * inset - 1) * i) / (n - 1);
      pts.push(this.at(fx, c.y + inset), this.at(fx, c.y + c.h - 1 - inset), this.at(c.x + inset, fy), this.at(c.x + c.w - 1 - inset, fy));
    }
    // Skip the corners (rounded shapes) by trimming the first/last samples of each side.
    const mid = pts.filter((_, i) => {
      const k = Math.floor(i / 4);
      return k > 4 && k < n - 5;
    });
    const votes = new Map<string, { n: number; c: RGB }>();
    for (const p of mid) {
      const key = p.map((v) => v >> 4).join(",");
      const v = votes.get(key) ?? { n: 0, c: p };
      v.n++;
      votes.set(key, v);
    }
    let best = { n: 0, c: [0, 0, 0] as RGB };
    for (const v of votes.values()) if (v.n > best.n) best = v;
    return { color: best.c, share: best.n / Math.max(1, mid.length) };
  }
}

export const colorDist = (a: RGB, b: RGB): number => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

export const toHex = (c: RGB): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

export function fromHex(hex: string): RGB {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** WCAG relative luminance and contrast ratio. */
export function luminance(c: RGB): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface TextInk {
  fg: RGB;
  bg: RGB;
  /** Number of detected text lines (rows of ink separated by gaps). */
  lines: number;
  /** Median height of an ink line, in px. */
  lineInk: number;
  /** Horizontal extent of the ink within the rectangle. */
  inkLeft: number;
  inkRight: number;
  /** Fraction of ink pixels inside ink rows — a rough boldness signal. */
  density: number;
}

/** Analyse a text region: background, text colour, line structure and ink extents. */
export function analyzeText(px: Pixels, r: Rect): TextInk | null {
  const c = px.clip(r);
  if (!c || c.w < 4 || c.h < 4) return null;
  const bgDom = px.dominant(c);
  if (!bgDom) return null;
  const bg = bgDom.color;
  const stepX = Math.max(1, c.w / 300);
  const rowsInk: number[] = [];
  const fgVotes = new Map<string, { n: number; sum: [number, number, number] }>();
  let inkLeft = Infinity;
  let inkRight = -Infinity;
  let inkPixels = 0;
  let samplesInInkRows = 0;
  for (let y = c.y; y < c.y + c.h; y++) {
    let rowInk = 0;
    let rowSamples = 0;
    for (let x = c.x; x < c.x + c.w; x += stepX) {
      const p = px.at(x, y);
      rowSamples++;
      if (colorDist(p, bg) > 70) {
        rowInk++;
        inkLeft = Math.min(inkLeft, x);
        inkRight = Math.max(inkRight, x);
        // Only strongly contrasting pixels vote for the text colour (anti-aliased edges are mixed).
        if (colorDist(p, bg) > 140 || fgVotes.size < 3) {
          const key = p.map((v) => v >> 5).join(",");
          const v = fgVotes.get(key) ?? { n: 0, sum: [0, 0, 0] };
          v.n++;
          v.sum[0] += p[0];
          v.sum[1] += p[1];
          v.sum[2] += p[2];
          fgVotes.set(key, v);
        }
      }
    }
    rowsInk.push(rowInk);
    if (rowInk) {
      inkPixels += rowInk;
      samplesInInkRows += rowSamples;
    }
  }
  if (!fgVotes.size) return { fg: bg, bg, lines: 0, lineInk: 0, inkLeft: c.x, inkRight: c.x + c.w, density: 0 };
  let best = { n: 0, sum: [0, 0, 0] as [number, number, number] };
  for (const v of fgVotes.values()) if (v.n > best.n) best = v;
  const fg: RGB = [Math.round(best.sum[0] / best.n), Math.round(best.sum[1] / best.n), Math.round(best.sum[2] / best.n)];
  // Group ink rows into lines, tolerating 1–2px gaps inside glyphs.
  const runs: number[] = [];
  let runStart = -1;
  let lastInk = -10;
  rowsInk.forEach((v, i) => {
    if (!v) return;
    if (runStart < 0 || i - lastInk > 2) {
      if (runStart >= 0) runs.push(lastInk - runStart + 1);
      runStart = i;
    }
    lastInk = i;
  });
  if (runStart >= 0) runs.push(lastInk - runStart + 1);
  const meaningful = runs.filter((h) => h >= 3);
  const sorted = [...meaningful].sort((a, b) => a - b);
  const lineInk = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return {
    fg,
    bg,
    lines: Math.max(1, meaningful.length),
    lineInk,
    inkLeft: Number.isFinite(inkLeft) ? inkLeft : c.x,
    inkRight: Number.isFinite(inkRight) ? inkRight : c.x + c.w,
    density: samplesInInkRows ? inkPixels / samplesInInkRows : 0,
  };
}

/** Colour distance that still counts as "the fill": half the fill/background contrast, capped. */
const fillTolerance = (fill: RGB, bg: RGB) => Math.max(4, Math.min(30, colorDist(fill, bg) * 0.45));

/**
 * Shrink a rectangle to where its fill colour actually starts — Android backgrounds are often
 * drawn inset from the view bounds (touch-target padding, card margins).
 */
export function trimToFill(px: Pixels, r: Rect, fill: RGB, bg: RGB, maxFrac = 0.3): Rect {
  const c = px.clip(r);
  if (!c) return r;
  const tol = fillTolerance(fill, bg);
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  const scan = (limit: number, sample: (i: number) => RGB) => {
    for (let i = 0; i < limit; i++) if (colorDist(sample(i), fill) <= tol) return i;
    return 0;
  };
  const lx = Math.floor(c.w * maxFrac);
  const ly = Math.floor(c.h * maxFrac);
  const top = scan(ly, (i) => px.at(cx, c.y + i));
  const bottom = scan(ly, (i) => px.at(cx, c.y + c.h - 1 - i));
  const left = scan(lx, (i) => px.at(c.x + i, cy));
  const right = scan(lx, (i) => px.at(c.x + c.w - 1 - i, cy));
  return { x: c.x + left, y: c.y + top, w: Math.max(1, c.w - left - right), h: Math.max(1, c.h - top - bottom) };
}

/** Estimate a rounded-corner radius (px) of a filled shape by scanning the top-left diagonal. */
export function cornerRadius(px: Pixels, r: Rect, fill: RGB, bg: RGB): number {
  const c = px.clip(r);
  if (!c || c.w < 12 || c.h < 12) return 0;
  const tol = fillTolerance(fill, bg);
  const maxD = Math.min(c.w, c.h) / 2;
  let d = 0;
  while (d < maxD && colorDist(px.at(c.x + d, c.y + d), fill) > tol) d++;
  if (d === 0 || d >= maxD) return 0;
  // A circle of radius R reaches the diagonal at R(1 - 1/√2) from the corner.
  return Math.min(maxD, Math.round(d / (1 - Math.SQRT1_2)));
}
