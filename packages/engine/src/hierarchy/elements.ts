import { hashString, rectContains, rectIntersect, rectNear, shortClass, shortRid, type Rect, type UiElement, type UiNode } from "@mappy/shared";
import { ancestors, descendants } from "./parse.ts";

export interface ExtractOptions {
  /** Only elements from this package are actionable (others are overlays, IME, system UI). */
  pkg?: string;
  screen: { w: number; h: number };
  listSample: number;
  riskyPatterns: string[];
  scroll: boolean;
  longPress: boolean;
  inputs: boolean;
}

const LIST_CLASS = /RecyclerView|ListView|GridView|ScrollView|ViewPager|LazyColumn|LazyRow/;
const NAV_HINT = /bottom_?nav|navigation|nav_bar|navbar|drawer|tab_?bar|BottomNavigation|NavigationBar|NavigationRail/i;
const TAB_CLASS = /TabLayout|TabWidget|TabView|\$TabView/;
const MENU_HINT = /overflow|more options|menu|toolbar|action_bar|actionbar/i;

/** Text shown for a node: own text/desc, else the first few descendant texts. */
export function nodeLabel(nodes: UiNode[], n: UiNode): string {
  const own = (n.text || n.desc || n.hint).trim();
  if (own) return own.slice(0, 80);
  const parts: string[] = [];
  for (const d of descendants(nodes, n.idx)) {
    const t = (d.text || d.desc).trim();
    if (t && !parts.includes(t)) parts.push(t);
    if (parts.length >= 3) break;
  }
  if (parts.length) return parts.join(" · ").slice(0, 80);
  if (n.rid) return shortRid(n.rid).replace(/_/g, " ");
  return shortClass(n.cls);
}

/** Structural shape of a subtree (classes + resource ids, no text) used to detect repeated list items. */
export function subtreeShape(nodes: UiNode[], n: UiNode, maxNodes = 40): string {
  const parts = [`${shortClass(n.cls)}#${shortRid(n.rid)}`];
  for (const d of descendants(nodes, n.idx).slice(0, maxNodes)) {
    parts.push(`${d.depth - n.depth}:${shortClass(d.cls)}#${shortRid(d.rid)}`);
  }
  return hashString(parts.join("|"));
}

export function compileRiskyPatterns(patterns: string[]): RegExp | null {
  const clean = patterns.map((p) => p.trim()).filter(Boolean);
  if (!clean.length) return null;
  return new RegExp(`(^|[^a-z])(${clean.join("|")})([^a-z]|$)`, "i");
}

/** Normalise volatile text so element keys survive counters and timestamps. */
const normLabel = (s: string): string => s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 40);

function visibleRect(b: Rect, screen: { w: number; h: number }): Rect | null {
  return rectIntersect(b, { x: 0, y: 0, w: screen.w, h: screen.h });
}

function classifyRole(nodes: UiNode[], n: UiNode, kind: UiElement["kind"], inList: boolean): UiElement["role"] {
  if (kind === "input") return "input";
  if (kind === "toggle") return "toggle";
  if (kind === "scroll") return "scroll";
  const chain = [n, ...ancestors(nodes, n.idx).slice(0, 4)];
  if (chain.some((a) => TAB_CLASS.test(a.cls))) return "tab";
  if (chain.some((a) => NAV_HINT.test(a.rid) || NAV_HINT.test(a.cls))) return "nav";
  if (inList) return "listItem";
  if (MENU_HINT.test(n.desc) || chain.slice(0, 3).some((a) => MENU_HINT.test(a.rid) || /Toolbar|ActionMenuView/.test(a.cls))) return "menu";
  if (/Button/.test(n.cls)) return "button";
  return "other";
}

/**
 * Derive the actionable elements of an observation: deduplicated, list-sampled,
 * labelled, keyed stably across observations, and flagged when risky.
 */
export function extractElements(nodes: UiNode[], opts: ExtractOptions): UiElement[] {
  const risky = compileRiskyPatterns(opts.riskyPatterns);
  const inPkg = (n: UiNode) => !opts.pkg || n.pkg === opts.pkg;

  // 1. Candidates by capability.
  type Cand = { n: UiNode; kind: UiElement["kind"]; vis: Rect };
  const cands: Cand[] = [];
  for (const n of nodes) {
    if (!n.enabled || !inPkg(n)) continue;
    const vis = visibleRect(n.bounds, opts.screen);
    if (!vis || vis.w < 4 || vis.h < 4) continue;
    if (n.editable) {
      if (opts.inputs) cands.push({ n, kind: "input", vis });
    } else if (n.checkable && (n.clickable || /Switch|CheckBox|RadioButton|ToggleButton|Chip/.test(n.cls))) {
      cands.push({ n, kind: "toggle", vis });
    } else if (n.clickable) {
      cands.push({ n, kind: "tap", vis });
    } else if (n.longClickable && opts.longPress) {
      cands.push({ n, kind: "longPress", vis });
    }
    if (n.scrollable && opts.scroll) cands.push({ n, kind: "scroll", vis });
  }

  // 2. Drop clickables that duplicate a clickable ancestor (same bounds) — keep the outer one.
  const tapIdx = new Set(cands.filter((c) => c.kind === "tap").map((c) => c.n.idx));
  const deduped = cands.filter((c) => {
    if (c.kind !== "tap") return true;
    return !ancestors(nodes, c.n.idx).some((a) => tapIdx.has(a.idx) && rectNear(a.bounds, c.n.bounds, 6));
  });

  // 3. List sampling: group repeated items under the same scrollable ancestor by subtree shape.
  const listInfo = new Map<number, { group: string; container: number }>();
  for (const c of deduped) {
    if (c.kind === "scroll") continue;
    const container = ancestors(nodes, c.n.idx).find((a) => a.scrollable || LIST_CLASS.test(a.cls));
    if (!container) continue;
    // The list item is the ancestor-or-self that is a direct child of the container.
    let item: UiNode = c.n;
    while (item.parent !== null && item.parent !== container.idx) item = nodes[item.parent];
    const itemShape = subtreeShape(nodes, item);
    const relPath = c.n.idx === item.idx ? "" : `${shortClass(c.n.cls)}#${shortRid(c.n.rid)}`;
    listInfo.set(c.n.idx, { group: `${container.idx}:${itemShape}:${relPath}:${c.kind}`, container: container.idx });
  }
  const groupMembers = new Map<string, Cand[]>();
  for (const c of deduped) {
    const li = listInfo.get(c.n.idx);
    if (!li) continue;
    const arr = groupMembers.get(li.group) ?? [];
    arr.push(c);
    groupMembers.set(li.group, arr);
  }

  const out: UiElement[] = [];
  const keyCounts = new Map<string, number>();
  const sorted = [...deduped].sort((a, b) => a.vis.y - b.vis.y || a.vis.x - b.vis.x);
  for (const c of sorted) {
    const n = c.n;
    const li = listInfo.get(n.idx);
    const members = li ? groupMembers.get(li.group)! : undefined;
    const repeated = !!members && members.length >= 2;
    let list: UiElement["list"];
    if (repeated) {
      const index = members!.sort((a, b) => a.vis.y - b.vis.y || a.vis.x - b.vis.x).indexOf(c);
      if (index >= opts.listSample) continue;
      list = { group: li!.group, index };
    }
    const label = c.kind === "scroll" ? `Scroll ${shortRid(n.rid) || shortClass(n.cls)}` : nodeLabel(nodes, n);
    // Stable key: resource id when present (text is often dynamic), otherwise class + normalised label.
    const base = list
      ? `list:${shortRid(nodes[li!.container].rid) || shortClass(nodes[li!.container].cls)}:${li!.group.split(":")[1]}:${c.kind}:#${list.index}`
      : n.rid
        ? `${c.kind}:${shortRid(n.rid)}:${shortClass(n.cls)}`
        : `${c.kind}:${shortClass(n.cls)}:${normLabel(label)}`;
    const ord = keyCounts.get(base) ?? 0;
    keyCounts.set(base, ord + 1);
    const key = ord ? `${base}@${ord}` : base;
    const riskText = [n.text, n.desc, shortRid(n.rid).replace(/_/g, " "), c.kind === "tap" ? label : ""].join(" ");
    const riskMatch = c.kind === "scroll" || c.kind === "input" ? null : risky?.exec(riskText);
    out.push({
      key,
      nodeIdx: n.idx,
      kind: c.kind,
      cls: n.cls,
      rid: n.rid,
      label,
      bounds: c.vis,
      risky: !!riskMatch,
      riskReason: riskMatch ? riskMatch[2] : undefined,
      list,
      role: classifyRole(nodes, n, c.kind, !!list),
    });
  }
  return out;
}

/** Pick the input value for an editable element from the configured test data. */
export function inputValueFor(n: UiNode, label: string, inputs: Record<string, string>): string {
  const hay = `${n.rid} ${n.hint} ${label} ${n.desc}`.toLowerCase();
  if (n.password || /pass(word)?|pin\b/.test(hay)) return inputs.password;
  if (/e-?mail/.test(hay)) return inputs.email;
  if (/phone|mobile|tel\b/.test(hay)) return inputs.phone;
  if (/search|query|find/.test(hay)) return inputs.search;
  if (/url|website|link/.test(hay)) return inputs.url;
  if (/name|user/.test(hay)) return inputs.name;
  if (/amount|number|qty|quantity|age|count|zip|code/.test(hay)) return inputs.number;
  return inputs.default;
}

/** True if `inner` lies within an element's node — used to map taps back to elements. */
export const elementContains = (e: UiElement, r: Rect): boolean => rectContains(e.bounds, r, 2);
