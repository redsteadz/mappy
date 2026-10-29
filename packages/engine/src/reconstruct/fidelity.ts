import { existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import type { IRScreen } from "@mappy/shared";
import { ROBOTO_TTF } from "../export/formats.ts";
import { screenSvg, type AssetLookup } from "../export/svg.ts";

/**
 * How closely the reconstructed layers reproduce the original screenshot: render the editable
 * SVG, downscale both images and compare. 1 = identical, ~0.9+ = visually close.
 */
export async function fidelity(screen: IRScreen, asset: AssetLookup): Promise<number> {
  const ref = asset(screen.referenceAssetId);
  if (!ref) return 0;
  const svg = screenSvg(screen, asset);
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: 180 },
    font: { fontFiles: existsSync(ROBOTO_TTF) ? [ROBOTO_TTF] : [], loadSystemFonts: false, defaultFontFamily: "Roboto" },
  })
    .render()
    .asPng();
  const size = { width: 180, height: Math.round((180 * screen.h) / screen.w), fit: "fill" as const };
  const [a, b] = await Promise.all([
    sharp(Buffer.from(rendered)).resize(size).removeAlpha().raw().toBuffer(),
    sharp(ref).resize(size).removeAlpha().raw().toBuffer(),
  ]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return Math.round((1 - diff / a.length / 255) * 1000) / 1000;
}
