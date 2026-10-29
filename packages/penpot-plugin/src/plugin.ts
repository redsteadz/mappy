/// <reference types="@penpot/plugin-types" />
import type { Board, Font, ImageData as PenpotImage, Shape } from "@penpot/plugin-types";
import type { DesignIR, IRLayer } from "@mappy/shared";

/**
 * Mappy → Penpot. Runs in Penpot's plugin sandbox; the UI iframe (served by the local Mappy
 * server) hands over a parsed .mappy.zip bundle: { ir, assets: { [assetId]: Uint8Array } }.
 */

declare const __MAPPY_ORIGIN__: string;

penpot.ui.open("Mappy import", `${__MAPPY_ORIGIN__}/plugins/penpot/ui.html?theme=${penpot.theme}`, { width: 380, height: 520 });

type Msg = { type: "import"; ir: DesignIR; assets: Record<string, Uint8Array> };

const progress = (message: string, done?: boolean) => penpot.ui.sendMessage({ type: "progress", message, done });

penpot.ui.onMessage<Msg>(async (msg) => {
  if (msg?.type !== "import") return;
  try {
    const stats = await importIR(msg.ir, msg.assets);
    progress(`Imported ${stats.screens} screens, ${stats.links} prototype links and ${stats.arrows} flow arrows.`, true);
  } catch (err) {
    progress(`Import failed: ${(err as Error).message}`, true);
  }
});

async function importIR(ir: DesignIR, assetBytes: Record<string, Uint8Array>) {
  const page = penpot.currentPage;
  if (!page) throw new Error("Open a page first");

  // Place the flow to the right of anything already on the page.
  const existing = page.findShapes();
  const ox = existing.length ? Math.max(...existing.map((s) => s.x + s.width)) + 400 : 0;
  const oy = 200;

  // Upload every image once.
  const images = new Map<string, PenpotImage>();
  const ids = Object.keys(ir.assets);
  for (let i = 0; i < ids.length; i += 4) {
    progress(`Uploading images ${i + 1}–${Math.min(i + 4, ids.length)} of ${ids.length}…`);
    await Promise.all(
      ids.slice(i, i + 4).map(async (id) => {
        const bytes = assetBytes[id];
        if (bytes) images.set(id, await penpot.uploadMediaData(id, bytes, "image/png"));
      }),
    );
  }

  const roboto: Font | null = penpot.fonts.findByName("Roboto");
  const styleText = (t: Shape & { fontFamily: string; fontWeight: string }, weight: number) => {
    if (roboto && "applyToText" in roboto) {
      const variant = roboto.variants.find((v) => Number(v.fontWeight) === weight && !/italic/i.test(v.name)) ?? roboto.variants.find((v) => v.fontWeight === "400");
      roboto.applyToText(t as never, variant);
    } else {
      t.fontFamily = "Roboto";
      t.fontWeight = String(weight);
    }
  };

  const buildLayer = (l: IRLayer, parent: Board, sx: number, sy: number) => {
    if (l.type === "text" && l.text) {
      const t = penpot.createText(l.text.chars);
      if (!t) return;
      parent.appendChild(t);
      t.name = l.name;
      styleText(t, l.text.weight >= 650 ? 700 : l.text.weight >= 450 ? 500 : 400);
      t.fontSize = String(l.text.size);
      if (l.text.lineHeight) t.lineHeight = String(Math.round((l.text.lineHeight / l.text.size) * 100) / 100);
      t.fills = [{ fillColor: l.text.color, fillOpacity: 1 }];
      t.align = l.text.align;
      t.growType = "fixed";
      t.resize(Math.max(1, l.w + 2), Math.max(1, l.h));
      t.growType = "auto-height";
      t.x = sx + l.x;
      t.y = sy + l.y;
      return;
    }
    if (l.type === "image" || l.type === "rect") {
      const r = penpot.createRectangle();
      parent.appendChild(r);
      r.name = l.name;
      r.resize(Math.max(0.01, l.w), Math.max(0.01, l.h));
      r.x = sx + l.x;
      r.y = sy + l.y;
      const img = l.assetId ? images.get(l.assetId) : undefined;
      r.fills = img ? [{ fillOpacity: 1, fillImage: img }] : l.fill ? [{ fillColor: l.fill, fillOpacity: 1 }] : [];
      if (l.radius) r.borderRadius = l.radius;
      if (l.stroke) r.strokes = [{ strokeColor: l.stroke, strokeWidth: 1, strokeAlignment: "inner", strokeStyle: "solid" }];
      return;
    }
    const b = penpot.createBoard();
    parent.appendChild(b);
    b.name = l.name;
    b.resize(Math.max(0.01, l.w), Math.max(0.01, l.h));
    b.x = sx + l.x;
    b.y = sy + l.y;
    b.clipContent = false;
    b.fills = l.fill ? [{ fillColor: l.fill, fillOpacity: 1 }] : [];
    if (l.radius) b.borderRadius = l.radius;
    if (l.stroke) b.strokes = [{ strokeColor: l.stroke, strokeWidth: 1, strokeAlignment: "inner", strokeStyle: "solid" }];
    for (const c of l.children ?? []) buildLayer(c, b, sx, sy);
  };

  const boards = new Map<string, Board>();
  const hotspots: { shape: Shape; target: string }[] = [];
  ir.screens.forEach((s, i) => {
    progress(`Building screen ${i + 1} of ${ir.screens.length}: ${s.name}`);
    const sx = ox + s.x;
    const sy = oy + s.y;
    const board = penpot.createBoard();
    board.name = s.name;
    board.resize(s.w, s.h);
    board.x = sx;
    board.y = sy;
    board.clipContent = true;
    board.fills = [{ fillColor: s.background, fillOpacity: 1 }];
    boards.set(s.id, board);

    const ref = penpot.createRectangle();
    board.appendChild(ref);
    ref.name = "Reference screenshot";
    ref.resize(s.w, s.h);
    ref.x = sx;
    ref.y = sy;
    const refImg = images.get(s.referenceAssetId);
    ref.fills = refImg ? [{ fillOpacity: 1, fillImage: refImg }] : [];
    ref.hidden = true;
    ref.blocked = true;

    for (const l of s.layers) buildLayer(l, board, sx, sy);

    for (const h of s.hotspots) {
      const hs = penpot.createRectangle();
      board.appendChild(hs);
      hs.name = `Hotspot → ${h.label}`.slice(0, 60);
      hs.resize(Math.max(1, h.w), Math.max(1, h.h));
      hs.x = sx + h.x;
      hs.y = sy + h.y;
      hs.fills = [{ fillColor: "#4f5bd5", fillOpacity: 0 }];
      hotspots.push({ shape: hs, target: h.target });
    }
  });

  progress("Linking prototype and drawing the flow…");
  let links = 0;
  for (const h of hotspots) {
    const dest = boards.get(h.target);
    if (!dest) continue;
    h.shape.addInteraction("click", { type: "navigate-to", destination: dest });
    links++;
  }

  let arrows = 0;
  for (const e of ir.edges) {
    if (e.points.length < 2) continue;
    const path = penpot.createPath();
    path.name = `Flow: ${e.label}`.slice(0, 60);
    path.content = e.points.map((p, i) => `${i ? "L" : "M"}${ox + p.x} ${oy + p.y}`).join(" ");
    path.fills = [];
    path.strokes = [{ strokeColor: "#4f5bd5", strokeWidth: 3, strokeStyle: "solid", strokeAlignment: "center", strokeCapEnd: "triangle-arrow" }];
    path.blocked = true;
    arrows++;
    if (e.label) {
      let best = e.points[0];
      let bestLen = -1;
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1];
        const b = e.points[i];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len > bestLen) {
          bestLen = len;
          best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }
      }
      const t = penpot.createText(e.label.length > 32 ? e.label.slice(0, 31) + "…" : e.label);
      if (t) {
        t.name = `Label: ${e.label}`.slice(0, 60);
        styleText(t, 400);
        t.fontSize = "13";
        t.fills = [{ fillColor: "#3a44b0", fillOpacity: 1 }];
        t.x = ox + best.x + 6;
        t.y = oy + best.y - 18;
        t.blocked = true;
      }
    }
  }

  const title = penpot.createText(`${ir.app.label ?? ir.name} — UI flow (Mappy)`);
  if (title) {
    styleText(title, 700);
    title.fontSize = "40";
    title.x = ox;
    title.y = oy - 140;
  }

  const start = ir.startScreen ? boards.get(ir.startScreen) : undefined;
  if (start) page.createFlow(ir.app.label ?? ir.name, start);
  return { screens: boards.size, links, arrows };
}
