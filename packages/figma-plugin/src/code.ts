/// <reference types="@figma/plugin-typings" />
import type { DesignIR } from "@mappy/shared";
import { buildAll } from "@mappy/engine/figma-builder";

figma.showUI(__html__, { width: 380, height: 500, themeColors: true });

figma.ui.onmessage = async (msg: { type: string; ir: DesignIR; assets: Record<string, Uint8Array> }) => {
  if (msg.type !== "import") return;
  try {
    const r = await buildAll(msg.ir, (id) => msg.assets[id]);
    const text = `Imported ${r.screens} screens, ${r.reactions} prototype links, ${r.arrows} arrows`;
    figma.ui.postMessage({ type: "progress", message: text, done: true });
    figma.notify(`Mappy: ${text}`);
  } catch (err) {
    figma.ui.postMessage({ type: "progress", message: `Import failed: ${(err as Error).message}`, done: true });
  }
};
