/// <reference types="@figma/plugin-typings" />
import type { DesignIR, IREdge, IRHotspot, IRLayer, IRScreen } from "@mappy/shared";

/**
 * Figma builder — plain Plugin API code with no runtime imports, so it can run inside the Mappy
 * Figma plugin AND be bundled into `use_figma` scripts for the Figma MCP connector.
 *
 * Images are abstracted: in plugin mode they are created from bytes; in MCP mode the builder
 * draws a placeholder and records an "image slot" that is filled afterwards with upload_assets.
 */

export interface ImageSlot {
  assetId: string;
  nodeId: string;
}

export interface BuildContext {
  /** Returns the paint for an asset, or null to leave a placeholder slot. */
  imagePaint?: (assetId: string) => Paint | null;
  slots: ImageSlot[];
  fonts: Record<number, FontName>;
  created: string[];
}

export interface ScreensPart {
  pageName: string;
  screens: IRScreen[];
  /** Canvas offset applied to every screen (dp). */
  origin: { x: number; y: number };
  /**
   * Put the full screenshot inside each frame as a hidden, locked layer (plugin mode). The MCP
   * path keeps frames purely editable and places captures on a separate page instead.
   */
  referenceInFrame?: boolean;
}

export interface WirePart {
  pageName: string;
  appName: string;
  origin: { x: number; y: number };
  frames: Record<string, string>;
  hotspots: Record<string, string>;
  screens: { id: string; hotspots: Pick<IRHotspot, "id" | "target">[] }[];
  edges: IREdge[];
  startScreen: string | null;
  /** Copy the image fill of `from` (already uploaded) onto every node in `to`. */
  imageCopies: { from: string; to: string[] }[];
}

// ---- helpers ---------------------------------------------------------------

function rgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
}

const solid = (hex: string, opacity = 1): SolidPaint => ({ type: "SOLID", color: rgb(hex), opacity });

const PLACEHOLDER = solid("#e6e8ec");

export async function findOrCreatePage(name: string): Promise<PageNode> {
  let page = figma.root.children.find((p) => p.name === name) as PageNode | undefined;
  if (!page) {
    page = figma.createPage();
    page.name = name;
  }
  await figma.setCurrentPageAsync(page);
  return page;
}

/** Load Roboto (Android's UI font) with Inter as a fallback; returns weight → font. */
export async function loadFonts(): Promise<Record<number, FontName>> {
  const attempt = async (family: string, styles: [number, string][]) => {
    const out: Record<number, FontName> = {};
    for (const [w, style] of styles) {
      const font = { family, style };
      await figma.loadFontAsync(font);
      out[w] = font;
    }
    return out;
  };
  try {
    return await attempt("Roboto", [
      [400, "Regular"],
      [500, "Medium"],
      [700, "Bold"],
    ]);
  } catch {
    return attempt("Inter", [
      [400, "Regular"],
      [500, "Medium"],
      [700, "Bold"],
    ]);
  }
}

const fontFor = (ctx: BuildContext, weight: number): FontName => ctx.fonts[weight >= 650 ? 700 : weight >= 450 ? 500 : 400];

function imageFill(ctx: BuildContext, node: GeometryMixin & BaseNode, assetId: string) {
  const paint = ctx.imagePaint?.(assetId) ?? null;
  if (paint) node.fills = [paint];
  else {
    node.fills = [PLACEHOLDER];
    ctx.slots.push({ assetId, nodeId: node.id });
  }
}

function place(node: SceneNode & LayoutMixin, x: number, y: number, w: number, h: number) {
  node.x = Math.round(x * 100) / 100;
  node.y = Math.round(y * 100) / 100;
  node.resize(Math.max(0.01, w), Math.max(0.01, h));
}

// ---- layers ----------------------------------------------------------------

function buildLayer(ctx: BuildContext, l: IRLayer, parent: FrameNode, px: number, py: number): void {
  if (l.type === "text" && l.text) {
    const t = figma.createText();
    parent.appendChild(t);
    t.name = l.name;
    t.fontName = fontFor(ctx, l.text.weight);
    t.characters = l.text.chars;
    t.fontSize = l.text.size;
    if (l.text.lineHeight) t.lineHeight = { unit: "PIXELS", value: l.text.lineHeight };
    t.fills = [solid(l.text.color)];
    t.textAlignHorizontal = l.text.align === "center" ? "CENTER" : l.text.align === "right" ? "RIGHT" : "LEFT";
    t.x = l.x - px;
    t.y = l.y - py;
    t.resize(Math.max(1, l.w + 2), Math.max(1, l.h));
    t.textAutoResize = "HEIGHT";
    ctx.created.push(t.id);
    return;
  }
  if (l.type === "image" || l.type === "rect") {
    const r = figma.createRectangle();
    parent.appendChild(r);
    r.name = l.name;
    place(r, l.x - px, l.y - py, l.w, l.h);
    if (l.type === "image" && l.assetId) imageFill(ctx, r, l.assetId);
    else r.fills = l.fill ? [solid(l.fill)] : [];
    if (l.radius) r.cornerRadius = l.radius;
    if (l.stroke) {
      r.strokes = [solid(l.stroke)];
      r.strokeWeight = 1;
    }
    ctx.created.push(r.id);
    return;
  }
  const f = figma.createFrame();
  parent.appendChild(f);
  f.name = l.name;
  place(f, l.x - px, l.y - py, l.w, l.h);
  f.fills = l.fill ? [solid(l.fill)] : [];
  f.clipsContent = false;
  if (l.radius) f.cornerRadius = l.radius;
  if (l.stroke) {
    f.strokes = [solid(l.stroke)];
    f.strokeWeight = 1;
    f.strokeAlign = "INSIDE";
  }
  ctx.created.push(f.id);
  for (const c of l.children ?? []) buildLayer(ctx, c, f, l.x, l.y);
}

/** One frame per screen: hidden reference screenshot, editable layers, prototype hotspots. */
export async function buildScreens(part: ScreensPart, ctx: BuildContext) {
  const page = await findOrCreatePage(part.pageName);
  const frames: Record<string, string> = {};
  const hotspots: Record<string, string> = {};
  for (const s of part.screens) {
    const frame = figma.createFrame();
    page.appendChild(frame);
    frame.name = s.name;
    place(frame, part.origin.x + s.x, part.origin.y + s.y, s.w, s.h);
    frame.fills = [solid(s.background)];
    frame.clipsContent = true;
    frames[s.id] = frame.id;
    ctx.created.push(frame.id);

    if (part.referenceInFrame !== false) {
      const ref = figma.createRectangle();
      frame.appendChild(ref);
      ref.name = "Reference screenshot";
      place(ref, 0, 0, s.w, s.h);
      imageFill(ctx, ref, s.referenceAssetId);
      ref.visible = false;
      ref.locked = true;
      ctx.created.push(ref.id);
    }

    for (const l of s.layers) {
      // Screens of other apps / system dialogs are a single full capture; without in-frame
      // references, show a labelled placeholder (the capture is on the Captures page).
      if (part.referenceInFrame === false && l.type === "image" && l.assetId === s.referenceAssetId) {
        const note = figma.createText();
        frame.appendChild(note);
        note.fontName = fontFor(ctx, 500);
        note.characters = `${s.name}\n(outside the app — capture on the Captures page)`;
        note.fontSize = 16;
        note.fills = [solid("#5f6368")];
        note.textAlignHorizontal = "CENTER";
        note.x = 16;
        note.y = s.h / 2 - 30;
        note.resize(Math.max(1, s.w - 32), 60);
        note.textAutoResize = "HEIGHT";
        frame.fills = [solid("#f1f3f4")];
        ctx.created.push(note.id);
        continue;
      }
      buildLayer(ctx, l, frame, 0, 0);
    }

    if (s.hotspots.length) {
      const layer = figma.createFrame();
      frame.appendChild(layer);
      layer.name = "Hotspots";
      place(layer, 0, 0, s.w, s.h);
      layer.fills = [];
      layer.clipsContent = false;
      ctx.created.push(layer.id);
      for (const h of s.hotspots) {
        const hs = figma.createFrame();
        layer.appendChild(hs);
        hs.name = `Hotspot → ${h.label}`.slice(0, 60);
        place(hs, h.x, h.y, h.w, h.h);
        hs.fills = [];
        hotspots[h.id] = hs.id;
        ctx.created.push(hs.id);
      }
    }
  }
  return { frames, hotspots, slots: ctx.slots, createdCount: ctx.created.length };
}

/** Captures page: the original screenshots side by side, as a reference next to the editable flow. */
export async function buildCaptures(pageName: string, appName: string, screens: Pick<IRScreen, "name" | "referenceAssetId" | "w" | "h">[], startIndex: number, ctx: BuildContext) {
  const page = await findOrCreatePage(pageName);
  if (startIndex === 0) {
    const title = figma.createText();
    page.appendChild(title);
    title.fontName = fontFor(ctx, 700);
    title.characters = `${appName} — captured screens (reference)`;
    title.fontSize = 32;
    ctx.created.push(title.id);
  }
  const perRow = 8;
  screens.forEach((s, j) => {
    const i = startIndex + j;
    const x = (i % perRow) * (s.w + 80);
    const y = 100 + Math.floor(i / perRow) * (s.h + 120);
    const cap = figma.createText();
    page.appendChild(cap);
    cap.fontName = fontFor(ctx, 500);
    cap.characters = s.name;
    cap.fontSize = 18;
    cap.x = x;
    cap.y = y;
    const r = figma.createRectangle();
    page.appendChild(r);
    r.name = `Capture: ${s.name}`.slice(0, 60);
    place(r, x, y + 32, s.w, s.h);
    r.cornerRadius = 16;
    imageFill(ctx, r, s.referenceAssetId);
    ctx.created.push(cap.id, r.id);
  });
  return { slots: ctx.slots, createdCount: ctx.created.length };
}

/** Inventory page: every distinct interactive element, grouped by role, with usage counts. */
export async function buildInventory(pageName: string, appName: string, items: DesignIR["inventory"], ctx: BuildContext) {
  const page = await findOrCreatePage(pageName);
  const title = figma.createText();
  page.appendChild(title);
  title.fontName = fontFor(ctx, 700);
  title.characters = `${appName} — interactive element inventory`;
  title.fontSize = 32;
  title.x = 0;
  title.y = 0;
  ctx.created.push(title.id);
  let y = 80;
  const roles = [...new Set(items.map((i) => i.role))];
  for (const role of roles) {
    const header = figma.createText();
    page.appendChild(header);
    header.fontName = fontFor(ctx, 500);
    header.characters = role;
    header.fontSize = 20;
    header.x = 0;
    header.y = y;
    ctx.created.push(header.id);
    y += 40;
    let x = 0;
    let rowH = 0;
    for (const item of items.filter((i) => i.role === role)) {
      const scale = Math.min(1, 360 / item.w);
      const w = item.w * scale;
      const h = item.h * scale;
      if (x + w > 1600) {
        x = 0;
        y += rowH + 56;
        rowH = 0;
      }
      const r = figma.createRectangle();
      page.appendChild(r);
      r.name = item.label.slice(0, 40) || role;
      place(r, x, y, w, h);
      r.cornerRadius = 4;
      imageFill(ctx, r, item.assetId);
      const cap = figma.createText();
      page.appendChild(cap);
      cap.fontName = fontFor(ctx, 400);
      cap.characters = `${item.label.slice(0, 40)}${item.count > 1 ? `  ×${item.count}` : ""}`;
      cap.fontSize = 12;
      cap.fills = [solid("#5f6368")];
      cap.x = x;
      cap.y = y + h + 6;
      ctx.created.push(r.id, cap.id);
      x += Math.max(w, 120) + 32;
      rowH = Math.max(rowH, h);
    }
    y += rowH + 80;
  }
  return { slots: ctx.slots, createdCount: ctx.created.length };
}

/** Prototype links, flow arrows with labels, start point, and image fill copies. */
export async function wireFlow(part: WirePart, ctx: BuildContext) {
  const page = await findOrCreatePage(part.pageName);
  let copied = 0;
  for (const c of part.imageCopies) {
    const from = (await figma.getNodeByIdAsync(c.from)) as (SceneNode & GeometryMixin) | null;
    if (!from || from.fills === figma.mixed) continue;
    for (const id of c.to) {
      const n = (await figma.getNodeByIdAsync(id)) as (SceneNode & GeometryMixin) | null;
      if (n) {
        n.fills = from.fills;
        copied++;
      }
    }
  }

  let reactions = 0;
  for (const s of part.screens) {
    for (const h of s.hotspots) {
      const nodeId = part.hotspots[h.id];
      const dest = part.frames[h.target];
      if (!nodeId || !dest) continue;
      const node = (await figma.getNodeByIdAsync(nodeId)) as (SceneNode & ReactionMixin) | null;
      if (!node) continue;
      // Cast: with the DOM lib loaded, the typings' `Navigation` collides with the DOM Navigation API.
      const navigate = {
        type: "NODE",
        destinationId: dest,
        navigation: "NAVIGATE",
        transition: { type: "DISSOLVE", easing: { type: "EASE_OUT" }, duration: 0.2 },
        preserveScrollPosition: false,
      } as unknown as Action;
      await node.setReactionsAsync([{ trigger: { type: "ON_CLICK" }, actions: [navigate] }]);
      reactions++;
    }
  }

  const arrowColor = "#4f5bd5";
  let arrows = 0;
  for (const e of part.edges) {
    if (e.points.length < 2) continue;
    const pts = e.points.map((p) => ({ x: p.x + part.origin.x, y: p.y + part.origin.y }));
    const v = figma.createVector();
    page.appendChild(v);
    v.name = `Flow: ${e.label}`.slice(0, 60);
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    await v.setVectorNetworkAsync({
      vertices: pts.map((p, i) => ({ x: p.x - minX, y: p.y - minY, strokeCap: i === pts.length - 1 ? "ARROW_LINES" : "NONE" })),
      segments: pts.slice(1).map((_, i) => ({ start: i, end: i + 1 })),
      regions: [],
    });
    v.x = minX;
    v.y = minY;
    v.strokes = [solid(arrowColor)];
    v.strokeWeight = 3;
    v.strokeJoin = "ROUND";
    v.locked = true;
    ctx.created.push(v.id);
    arrows++;
    if (e.label) {
      // Label at the middle of the longest segment.
      let best = { x: pts[0].x, y: pts[0].y };
      let bestLen = -1;
      for (let i = 1; i < pts.length; i++) {
        const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (len > bestLen) {
          bestLen = len;
          best = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 };
        }
      }
      const pill = figma.createFrame();
      page.appendChild(pill);
      pill.name = `Label: ${e.label}`.slice(0, 60);
      pill.layoutMode = "HORIZONTAL";
      pill.primaryAxisSizingMode = "AUTO";
      pill.counterAxisSizingMode = "AUTO";
      pill.paddingLeft = pill.paddingRight = 10;
      pill.paddingTop = pill.paddingBottom = 4;
      pill.cornerRadius = 12;
      pill.fills = [solid("#ffffff")];
      pill.strokes = [solid("#c7cbf5")];
      pill.strokeWeight = 1;
      const t = figma.createText();
      pill.appendChild(t);
      t.fontName = fontFor(ctx, 400);
      t.characters = e.label.length > 32 ? e.label.slice(0, 31) + "…" : e.label;
      t.fontSize = 13;
      t.fills = [solid("#3a44b0")];
      pill.x = best.x - pill.width / 2;
      pill.y = best.y - pill.height / 2;
      pill.locked = true;
      ctx.created.push(pill.id, t.id);
    }
  }

  const titleNode = figma.createText();
  page.appendChild(titleNode);
  titleNode.fontName = fontFor(ctx, 700);
  titleNode.characters = `${part.appName} — UI flow (Mappy)`;
  titleNode.fontSize = 40;
  titleNode.x = part.origin.x;
  titleNode.y = part.origin.y - 140;
  ctx.created.push(titleNode.id);

  if (part.startScreen && part.frames[part.startScreen]) {
    page.flowStartingPoints = [{ nodeId: part.frames[part.startScreen], name: part.appName }];
  }
  return { reactions, arrows, imageFillsCopied: copied, createdCount: ctx.created.length };
}

/** Plugin mode: build everything in one go with real image bytes. */
export async function buildAll(ir: DesignIR, bytes: (assetId: string) => Uint8Array | undefined, opts: { pageName?: string } = {}) {
  const fonts = await loadFonts();
  const hashes = new Map<string, string>();
  const imagePaint = (assetId: string): Paint | null => {
    let hash = hashes.get(assetId);
    if (!hash) {
      const b = bytes(assetId);
      if (!b) return null;
      hash = figma.createImage(b).hash;
      hashes.set(assetId, hash);
    }
    return { type: "IMAGE", imageHash: hash, scaleMode: "FILL" };
  };
  const appName = ir.app.label ?? ir.name;
  const pageName = opts.pageName ?? `Mappy — ${appName}`;
  const ctx: BuildContext = { imagePaint, slots: [], fonts, created: [] };
  const origin = { x: 0, y: 200 };
  const built = await buildScreens({ pageName, screens: ir.screens, origin }, ctx);
  if (ir.inventory.length) await buildInventory(`${pageName} — inventory`, appName, ir.inventory, ctx);
  const wired = await wireFlow(
    {
      pageName,
      appName,
      origin,
      frames: built.frames,
      hotspots: built.hotspots,
      screens: ir.screens.map((s) => ({ id: s.id, hotspots: s.hotspots.map((h) => ({ id: h.id, target: h.target })) })),
      edges: ir.edges,
      startScreen: ir.startScreen,
      imageCopies: [],
    },
    ctx,
  );
  return { screens: ir.screens.length, ...wired, nodes: ctx.created.length };
}
