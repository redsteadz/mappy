import {
  hashString,
  rectCenter,
  shortClass,
  shortRid,
  type Action,
  type CrawlMap,
  type MapEdge,
  type Observation,
  type Overrides,
  type ScreenSummary,
  type Transition,
  type UiNode,
} from "@mappy/shared";
import { ancestors } from "../hierarchy/parse.ts";

/**
 * Screen abstraction: decides when two observations are "the same screen".
 *
 * Signatures are a weighted feature set built from the app's own nodes:
 *  - structural features (class, resource id, capability flags, coarse position) — position is
 *    dropped inside scrolling containers so scroll offset and list length don't matter;
 *  - short static labels (toolbar title, selected tab, button captions) which separate screens
 *    that share a layout (e.g. settings sub-pages).
 * Compose and Flutter apps rarely expose resource ids, so classes/flags/positions carry them.
 */

export interface Signature {
  pkg: string;
  activity: string;
  features: Map<string, number>;
  /** Text-free subset used for list-template matching (e.g. two different note detail pages). */
  structural: Map<string, number>;
  /** Features outside scrolling containers — stable while the content scrolls. */
  fixed: Map<string, number>;
  title: string;
  dhash: string;
  stateKey: string;
  opaque: boolean;
}

const SCROLLING = /RecyclerView|ListView|GridView|ScrollView|ViewPager|LazyColumn|LazyRow|LazyVerticalGrid/;
const TOOLBAR = /Toolbar|ActionBar|action_bar|app_bar|appbar|toolbar|top_app_bar|TopAppBar/i;
const SYSTEM_PKGS = /^(android|com\.android\.systemui|com\.(google\.)?android\.(permissioncontroller|packageinstaller)|com\.android\.launcher\d?|com\.google\.android\.apps\.nexuslauncher)$/;

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function detectTitle(nodes: UiNode[], pkg: string, screenH: number): string {
  const app = nodes.filter((n) => n.pkg === pkg && (n.text || n.desc));
  const inToolbar = app.find(
    (n) => n.text && ancestors(nodes, n.idx).slice(0, 4).some((a) => TOOLBAR.test(a.cls) || TOOLBAR.test(a.rid)),
  );
  if (inToolbar) return inToolbar.text.trim().slice(0, 48);
  const titleRid = app.find((n) => n.text && /title|header|heading/i.test(n.rid) && n.bounds.y < screenH * 0.3);
  if (titleRid) return titleRid.text.trim().slice(0, 48);
  // Dialogs and sheets are windows smaller than the screen: their first static text is the title.
  const root = nodes.find((n) => n.pkg === pkg);
  const floating = !!root && root.bounds.h < screenH * 0.8;
  const top = app
    .filter((n) => n.text && !n.clickable && (floating || (n.bounds.y < screenH * 0.25 && n.bounds.y > screenH * 0.02)))
    .sort((a, b) => (floating ? a.bounds.y - b.bounds.y : b.bounds.h - a.bounds.h || a.bounds.y - b.bounds.y))[0];
  return top ? top.text.trim().slice(0, 48) : "";
}

export function computeSignature(obs: Observation, nodes: UiNode[] | null): Signature {
  const features = new Map<string, number>();
  const structural = new Map<string, number>();
  const fixed = new Map<string, number>();
  const add = (f: string, w = 1, struct = true) => {
    features.set(f, Math.max(features.get(f) ?? 0, w));
    if (struct) structural.set(f, Math.max(structural.get(f) ?? 0, w));
    if (!f.startsWith("S:")) fixed.set(f, Math.max(fixed.get(f) ?? 0, w));
  };
  const W = obs.widthPx || 1;
  const H = obs.heightPx || 1;
  let title = "";
  const states: string[] = [];
  if (nodes && obs.status !== "opaque") {
    const scrollingIdx = new Set(nodes.filter((n) => n.scrollable || SCROLLING.test(n.cls)).map((n) => n.idx));
    for (const n of nodes) {
      if (n.pkg !== obs.pkg) continue;
      const inScroll = ancestors(nodes, n.idx).some((a) => scrollingIdx.has(a.idx));
      const flags = `${n.clickable ? "c" : ""}${n.scrollable ? "s" : ""}${n.editable ? "e" : ""}${n.checkable ? "k" : ""}`;
      const id = `${shortClass(n.cls)}#${shortRid(n.rid)}:${flags}`;
      if (inScroll) {
        add(`S:${id}`);
      } else {
        const c = rectCenter(n.bounds);
        add(`N:${id}@${Math.floor((c.x / W) * 4)},${Math.floor((c.y / H) * 8)}`);
      }
      if (n.selected && (n.text || n.desc)) add(`SEL:${normText(n.text || n.desc)}`, 3, false);
      const label = n.text || n.desc;
      if (n.clickable && !inScroll && label && label.length <= 24 && !/\d/.test(label)) add(`L:${normText(label)}`, 1, false);
      if (n.checkable || n.selected) states.push(`${n.idx}:${n.checked ? 1 : 0}${n.selected ? 1 : 0}`);
    }
    title = detectTitle(nodes, obs.pkg, H);
    if (title && !/\d{2,}/.test(title)) add(`T:${normText(title)}`, 4, false);
  }
  const stateKey = hashString([...features.keys()].sort().join("|") + "#" + states.join(","));
  return {
    pkg: obs.pkg,
    activity: obs.activity,
    features,
    structural,
    fixed,
    title,
    dhash: obs.dhash,
    stateKey,
    opaque: !nodes || obs.status === "opaque" || features.size === 0,
  };
}

function weightedJaccard(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0;
  let union = 0;
  for (const [k, wa] of a) {
    const wb = b.get(k) ?? 0;
    inter += Math.min(wa, wb);
    union += Math.max(wa, wb);
  }
  for (const [k, wb] of b) if (!a.has(k)) union += wb;
  return union === 0 ? 1 : inter / union;
}

export function hamming64(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
  }
  return d;
}

export function similarity(a: Signature, b: Signature, mode: "full" | "structural" | "fixed" = "full"): number {
  if (a.pkg !== b.pkg) return 0;
  if (a.activity && b.activity && a.activity !== b.activity) return 0;
  if (a.opaque || b.opaque) return a.opaque && b.opaque ? 1 - hamming64(a.dhash, b.dhash) / 64 : 0;
  return weightedJaccard(a[mode === "full" ? "features" : mode], b[mode === "full" ? "features" : mode]);
}

/** How an observation was reached; lets the clusterer apply action-specific rules. */
export interface ClusterHint {
  fromKey?: string;
  action?: Action;
}

export const isSystemPkg = (pkg: string): boolean => SYSTEM_PKGS.test(pkg);

interface Cluster {
  key: string;
  forced: boolean;
  members: string[];
  sigs: Signature[];
  variants: Map<string, string>;
}

export interface AssignResult {
  key: string;
  isNew: boolean;
}

/**
 * Incremental clustering of observations into screens. Deterministic: replaying the same
 * observations (with the same hints) in the same order yields the same assignment, which is
 * how the map is rebuilt from the event log.
 */
export class ScreenClusterer {
  readonly appPkg: string;
  readonly threshold: number;
  readonly overrides: Overrides;
  private clusters = new Map<string, Cluster>();
  private obsToKey = new Map<string, string>();
  private templates = new Map<string, string>();
  readonly sigs = new Map<string, Signature>();

  constructor(appPkg: string, threshold: number, overrides?: Partial<Overrides>) {
    this.appPkg = appPkg;
    this.threshold = threshold;
    this.overrides = { assign: {}, renames: {}, hidden: [], ...overrides };
  }

  keyOf(obsId: string): string | undefined {
    return this.obsToKey.get(obsId);
  }

  clusterKeys(): string[] {
    return [...this.clusters.keys()];
  }

  members(key: string): string[] {
    return this.clusters.get(key)?.members ?? [];
  }

  variants(key: string): string[] {
    return [...(this.clusters.get(key)?.variants.values() ?? [])];
  }

  signatureOf(key: string): Signature | undefined {
    return this.clusters.get(key)?.sigs[0];
  }

  /**
   * Rules applied before generic similarity matching:
   *  - scrolling never navigates: a scroll result joins the screen it was taken on when the
   *    fixed chrome (toolbar, tabs, title) still matches;
   *  - screens reached from the same sampled list share a template and merge even if their
   *    titles differ (e.g. two notes opened from the notes list).
   */
  add(obs: Observation, sig: Signature, hint?: ClusterHint): AssignResult {
    this.sigs.set(obs.id, sig);
    const forcedKey = this.overrides.assign[obs.id];
    let key: string | undefined = forcedKey;
    if (!key && sig.pkg !== this.appPkg) key = `x-${sig.pkg}`;
    if (!key && hint?.fromKey && hint.action?.type === "scroll") {
      const c = this.clusters.get(hint.fromKey);
      if (c && similarity(c.sigs[0], sig, "fixed") >= this.threshold) key = c.key;
    }
    const templateGroup = templateGroupOf(hint?.fromKey, hint?.action?.elementKey);
    if (!key && templateGroup) {
      const t = this.templates.get(templateGroup);
      const c = t ? this.clusters.get(t) : undefined;
      if (c && similarity(c.sigs[0], sig, "structural") >= this.threshold) key = t;
    }
    if (!key) {
      let best = 0;
      for (const c of this.clusters.values()) {
        if (c.key.startsWith("x-")) continue;
        const probe = [c.sigs[0], ...c.sigs.slice(-4)];
        const s = Math.max(...probe.map((p) => similarity(p, sig)));
        if (s > best) {
          best = s;
          key = s >= this.threshold ? c.key : key;
        }
      }
      if (best < this.threshold) key = undefined;
    }
    let isNew = false;
    if (!key) key = `s-${obs.id}`;
    let c = this.clusters.get(key);
    if (!c) {
      c = { key, forced: !!forcedKey, members: [], sigs: [], variants: new Map() };
      this.clusters.set(key, c);
      isNew = true;
    }
    c.members.push(obs.id);
    if (c.sigs.length < 12) c.sigs.push(sig);
    if (!c.variants.has(sig.stateKey) && c.variants.size < 8) c.variants.set(sig.stateKey, obs.id);
    this.obsToKey.set(obs.id, key);
    if (templateGroup && !this.templates.has(templateGroup) && !key.startsWith("x-")) this.templates.set(templateGroup, key);
    return { key, isNew };
  }
}

/** The list-template group of a transition's action, scoped to the screen it was taken on. */
export function templateGroupOf(fromScreen: string | undefined, elementKey: string | undefined): string | undefined {
  if (!fromScreen || !elementKey?.startsWith("list:")) return undefined;
  return `${fromScreen}|${elementKey.replace(/:#\d+(@\d+)?$/, "")}`;
}

export interface BuildMapInput {
  projectId: string;
  appPkg: string;
  threshold: number;
  observations: Observation[];
  transitions: Transition[];
  overrides: Overrides;
  /** Signature cache keyed by observation id (signatures are immutable). */
  signature: (obs: Observation) => Signature;
}

/** Rebuild screens and aggregated edges from the event log + user overrides. */
export function buildMap(input: BuildMapInput): CrawlMap & { clusterer: ScreenClusterer } {
  const { observations, transitions, overrides } = input;
  const obsSorted = [...observations].sort((a, b) => a.seq - b.seq);
  const producedBy = new Map<string, Transition>();
  for (const t of transitions) if (!producedBy.has(t.toObs)) producedBy.set(t.toObs, t);

  const clusterer = new ScreenClusterer(input.appPkg, input.threshold, overrides);
  for (const obs of obsSorted) {
    const t = producedBy.get(obs.id);
    clusterer.add(obs, input.signature(obs), t ? { fromKey: clusterer.keyOf(t.fromObs), action: t.action } : undefined);
  }

  const obsById = new Map(obsSorted.map((o) => [o.id, o]));
  const obsToScreen: Record<string, string> = {};
  for (const o of obsSorted) obsToScreen[o.id] = clusterer.keyOf(o.id)!;

  // Aggregate edges.
  const edgeMap = new Map<string, MapEdge>();
  for (const t of [...transitions].sort((a, b) => a.seq - b.seq)) {
    const from = obsToScreen[t.fromObs];
    const to = obsToScreen[t.toObs];
    if (!from || !to) continue;
    const id = `e-${hashString(`${from}|${to}|${t.action.type}|${t.action.elementKey ?? t.action.label}`)}`;
    const existing = edgeMap.get(id);
    if (existing) {
      existing.count++;
      existing.transitionIds.push(t.id);
    } else {
      edgeMap.set(id, {
        id,
        from,
        to,
        label: t.action.label || t.action.type,
        actionType: t.action.type,
        elementKey: t.action.elementKey,
        bounds: t.action.bounds,
        outcome: from === to ? "self" : t.outcome,
        count: 1,
        transitionIds: [t.id],
      });
    }
  }
  const edges = [...edgeMap.values()];

  const keys = clusterer.clusterKeys();
  const startScreen = overrides.start && keys.includes(overrides.start) ? overrides.start : (obsSorted[0] ? obsToScreen[obsSorted[0].id] : null);

  // Depth = fewest forward (non-back) actions from the start screen.
  const depth = new Map<string, number>();
  if (startScreen) {
    depth.set(startScreen, 0);
    const q = [startScreen];
    while (q.length) {
      const s = q.shift()!;
      for (const e of edges) {
        if (e.from !== s || e.actionType === "back" || e.outcome === "self" || depth.has(e.to)) continue;
        depth.set(e.to, depth.get(s)! + 1);
        q.push(e.to);
      }
    }
  }

  const usedNames = new Map<string, number>();
  const screens: ScreenSummary[] = keys.map((key) => {
    const members = clusterer.members(key);
    const rep = obsById.get(members[0])!;
    const sig = clusterer.signatureOf(key)!;
    const kind: ScreenSummary["kind"] = key.startsWith("x-")
      ? isSystemPkg(rep.pkg)
        ? "system"
        : "external"
      : sig.opaque
        ? "opaque"
        : "app";
    let name = overrides.renames[key];
    if (!name) {
      const act = shortClass(rep.activity || "").replace(/Activity$/, "") || "Screen";
      if (kind === "external") name = `↗ ${rep.pkg}`;
      else if (kind === "system") name = `⚙ ${shortClass(rep.pkg)}`;
      else name = sig.title ? `${sig.title}` : act;
      const n = (usedNames.get(name) ?? 0) + 1;
      usedNames.set(name, n);
      if (n > 1) name = `${name} (${n})`;
    }
    return {
      id: key,
      name,
      activity: rep.activity,
      pkg: rep.pkg,
      repObs: members[0],
      obsIds: members,
      variants: clusterer.variants(key),
      kind,
      depth: depth.get(key) ?? null,
      hidden: overrides.hidden.includes(key),
    };
  });

  return { projectId: input.projectId, startScreen, screens, edges, obsToScreen, clusterer };
}
