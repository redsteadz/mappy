import sharp from "sharp";

const TW = 36;
const TH = 64;

export interface FrameInfo {
  /** 36×64 grayscale thumbnail used for cheap frame-to-frame comparisons. */
  thumb: Buffer;
  /** 64-bit difference hash (status bar excluded), hex encoded. */
  dhash: string;
  /** FLAG_SECURE windows are captured as (near) black frames. */
  black: boolean;
}

/** Decode a screenshot once and derive everything the crawler needs from it. */
export async function analyzeFrame(png: Buffer): Promise<FrameInfo> {
  const rgb = await sharp(png).resize(TW, TH, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const thumb = Buffer.alloc(TW * TH);
  let max = 0;
  for (let i = 0; i < TW * TH; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    max = Math.max(max, r, g, b);
    thumb[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { thumb, dhash: dhashFromThumb(thumb), black: max <= 12 };
}

/** dhash over the thumbnail with the top rows (status bar) dropped. */
function dhashFromThumb(t: Buffer): string {
  const top = 3;
  const rows = TH - top;
  const sample = (x: number, y: number) => {
    // Box-average the thumbnail cell that maps to the 9×8 grid position.
    const x0 = Math.floor((x * TW) / 9);
    const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * TW) / 9));
    const y0 = top + Math.floor((y * rows) / 8);
    const y1 = Math.max(y0 + 1, top + Math.floor(((y + 1) * rows) / 8));
    let s = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += t[yy * TW + xx];
    return s / ((x1 - x0) * (y1 - y0));
  };
  let hex = "";
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col = 0; col < 8; col++) byte = (byte << 1) | (sample(col, row) > sample(col + 1, row) ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Mean absolute difference (0–255) between two thumbnails. */
export function thumbDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
