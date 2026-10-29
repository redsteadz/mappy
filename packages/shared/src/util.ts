import type { Rect } from "./schema.ts";

export const pxToDp = (px: number, density: number): number => (px * 160) / density;

export const rectArea = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);

export const rectCenter = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function rectIntersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  return r > x && bt > y ? { x, y, w: r - x, h: bt - y } : null;
}

export function rectContains(outer: Rect, inner: Rect, slack = 0): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.w <= outer.x + outer.w + slack &&
    inner.y + inner.h <= outer.y + outer.h + slack
  );
}

/** True when two rects are the same within a tolerance (pixels). */
export const rectNear = (a: Rect, b: Rect, tol = 4): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;

export const shortClass = (cls: string): string => cls.slice(cls.lastIndexOf(".") + 1);

export const shortRid = (rid: string): string => rid.slice(rid.indexOf("/") + 1);

/** Short, sortable, collision-resistant id. */
export function newId(prefix = ""): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}${t}${r}`;
}

/** FNV-1a 32-bit hash rendered as base36; good enough for content keys. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
