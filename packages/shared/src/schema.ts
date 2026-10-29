import { z } from "zod";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Rectangle in device pixels (crawl data) or dp (design IR), depending on context. */
export const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Rect = z.infer<typeof Rect>;

export const Point = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof Point>;

// ---------------------------------------------------------------------------
// Devices and apps
// ---------------------------------------------------------------------------

export const DeviceInfo = z.object({
  serial: z.string(),
  model: z.string().default(""),
  manufacturer: z.string().default(""),
  sdk: z.number().default(0),
  release: z.string().default(""),
  widthPx: z.number(),
  heightPx: z.number(),
  /** Density in dpi; dp = px * 160 / density. */
  density: z.number(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const DeviceSummary = z.object({
  serial: z.string(),
  state: z.string(),
  model: z.string().default(""),
  product: z.string().default(""),
});
export type DeviceSummary = z.infer<typeof DeviceSummary>;

export const AppInfo = z.object({
  pkg: z.string(),
  label: z.string().optional(),
  versionName: z.string().optional(),
  versionCode: z.string().optional(),
  launchActivity: z.string().optional(),
  system: z.boolean().optional(),
});
export type AppInfo = z.infer<typeof AppInfo>;

// ---------------------------------------------------------------------------
// Crawl configuration
// ---------------------------------------------------------------------------

export const RiskyPolicy = z.enum(["ask", "skip", "allow"]);
export type RiskyPolicy = z.infer<typeof RiskyPolicy>;

export const PermissionPolicy = z.enum(["grant", "deny", "ask"]);
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const DEFAULT_RISKY_PATTERNS = [
  "delete", "remove", "erase", "discard", "log ?out", "sign ?out", "logout", "signout",
  "pay", "buy", "purchase", "checkout", "place order", "subscribe", "upgrade", "donate",
  "send", "post", "publish", "share", "submit", "confirm", "reset", "clear", "wipe",
  "uninstall", "deactivate", "close account", "report", "block", "unfollow", "call",
];

export const CrawlConfig = z.object({
  maxActions: z.number().int().positive().default(300),
  maxScreens: z.number().int().positive().default(80),
  maxMinutes: z.number().positive().default(30),
  maxDepth: z.number().int().positive().default(15),
  /** How many items of a repeated list to explore (items share a template). */
  listSample: z.number().int().min(1).default(2),
  riskyPolicy: RiskyPolicy.default("ask"),
  riskyPatterns: z.array(z.string()).default(DEFAULT_RISKY_PATTERNS),
  permissionPolicy: PermissionPolicy.default("deny"),
  /** "relaunch" force-stops and starts the app; "current" starts from whatever is on screen. */
  startMode: z.enum(["relaunch", "current"]).default("relaunch"),
  inputs: z
    .object({
      email: z.string().default("mappy.test@example.com"),
      password: z.string().default("MappyTest123!"),
      name: z.string().default("Alex Mappy"),
      phone: z.string().default("5555550123"),
      search: z.string().default("test"),
      number: z.string().default("42"),
      url: z.string().default("https://example.com"),
      default: z.string().default("Mappy test"),
    })
    .default({
      email: "mappy.test@example.com",
      password: "MappyTest123!",
      name: "Alex Mappy",
      phone: "5555550123",
      search: "test",
      number: "42",
      url: "https://example.com",
      default: "Mappy test",
    }),
  explore: z
    .object({
      scroll: z.boolean().default(true),
      longPress: z.boolean().default(false),
      inputs: z.boolean().default(true),
    })
    .default({ scroll: true, longPress: false, inputs: true }),
  /** Skeleton similarity at or above which two observations are the same screen. */
  similarity: z.number().min(0).max(1).default(0.8),
  settle: z
    .object({ minMs: z.number().default(350), maxMs: z.number().default(5000), stableFrames: z.number().default(2) })
    .default({ minMs: 350, maxMs: 5000, stableFrames: 2 }),
  device: z
    .object({ disableAnimations: z.boolean().default(true), stayAwake: z.boolean().default(true) })
    .default({ disableAnimations: true, stayAwake: true }),
});
export type CrawlConfig = z.infer<typeof CrawlConfig>;
export type CrawlConfigInput = z.input<typeof CrawlConfig>;

// ---------------------------------------------------------------------------
// Crawl data (event-sourced: observations + transitions are immutable facts)
// ---------------------------------------------------------------------------

export const ObservationStatus = z.enum(["ok", "stale", "opaque"]);
export type ObservationStatus = z.infer<typeof ObservationStatus>;

export const Observation = z.object({
  id: z.string(),
  seq: z.number().int(),
  ts: z.number(),
  pkg: z.string(),
  activity: z.string().default(""),
  /** Relative file names inside the project's obs/ directory. */
  png: z.string(),
  xml: z.string().optional(),
  widthPx: z.number(),
  heightPx: z.number(),
  /** 64-bit difference hash of the screenshot, hex encoded. */
  dhash: z.string().default(""),
  status: ObservationStatus.default("ok"),
  /** Set when this observation came from the user driving the device (take-over). */
  manual: z.boolean().optional(),
});
export type Observation = z.infer<typeof Observation>;

export const ActionType = z.enum(["tap", "longPress", "input", "scroll", "back", "launch", "restart", "manual", "dismiss"]);
export type ActionType = z.infer<typeof ActionType>;

export const Action = z.object({
  type: ActionType,
  elementKey: z.string().optional(),
  label: z.string().default(""),
  bounds: Rect.optional(),
  value: z.string().optional(),
});
export type Action = z.infer<typeof Action>;

export const TransitionOutcome = z.enum(["navigate", "self", "external", "crash", "error"]);
export type TransitionOutcome = z.infer<typeof TransitionOutcome>;

export const Transition = z.object({
  id: z.string(),
  seq: z.number().int(),
  ts: z.number(),
  fromObs: z.string(),
  toObs: z.string(),
  action: Action,
  outcome: TransitionOutcome,
  externalPkg: z.string().optional(),
  note: z.string().optional(),
});
export type Transition = z.infer<typeof Transition>;

/** User corrections applied on top of automatic screen clustering. */
export const Overrides = z.object({
  /** Force an observation into the cluster with this key (used for merge and split). */
  assign: z.record(z.string(), z.string()).default({}),
  renames: z.record(z.string(), z.string()).default({}),
  hidden: z.array(z.string()).default([]),
  start: z.string().optional(),
});
export type Overrides = z.infer<typeof Overrides>;

export const ProjectStatus = z.enum(["idle", "running", "paused", "takeover", "done", "stopped", "error"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  device: DeviceInfo,
  app: AppInfo,
  config: CrawlConfig,
  status: ProjectStatus.default("idle"),
  error: z.string().optional(),
  stats: z
    .object({ actions: z.number().default(0), observations: z.number().default(0), screens: z.number().default(0) })
    .default({ actions: 0, observations: 0, screens: 0 }),
});
export type Project = z.infer<typeof Project>;

// ---------------------------------------------------------------------------
// Parsed UI hierarchy and derived elements (not persisted; derived from XML)
// ---------------------------------------------------------------------------

export interface UiNode {
  idx: number;
  parent: number | null;
  depth: number;
  children: number[];
  cls: string;
  pkg: string;
  rid: string;
  text: string;
  desc: string;
  hint: string;
  bounds: Rect;
  clickable: boolean;
  longClickable: boolean;
  checkable: boolean;
  checked: boolean;
  scrollable: boolean;
  focusable: boolean;
  focused: boolean;
  enabled: boolean;
  selected: boolean;
  password: boolean;
  editable: boolean;
}

export type ElementKind = "tap" | "toggle" | "input" | "scroll" | "longPress";

export interface UiElement {
  key: string;
  nodeIdx: number;
  kind: ElementKind;
  cls: string;
  rid: string;
  label: string;
  bounds: Rect;
  risky: boolean;
  riskReason?: string;
  /** Set for elements that belong to a repeated list; index is the visual order in the list. */
  list?: { group: string; index: number };
  /** Heuristic role used for prioritisation and design naming. */
  role: "nav" | "tab" | "menu" | "button" | "listItem" | "input" | "toggle" | "scroll" | "other";
}

// ---------------------------------------------------------------------------
// Derived map (screens + edges) served to the dashboard
// ---------------------------------------------------------------------------

export const ScreenSummary = z.object({
  id: z.string(),
  name: z.string(),
  activity: z.string(),
  pkg: z.string(),
  repObs: z.string(),
  obsIds: z.array(z.string()),
  variants: z.array(z.string()),
  kind: z.enum(["app", "external", "system", "opaque"]),
  depth: z.number().nullable(),
  hidden: z.boolean().default(false),
});
export type ScreenSummary = z.infer<typeof ScreenSummary>;

export const MapEdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string(),
  actionType: ActionType,
  elementKey: z.string().optional(),
  bounds: Rect.optional(),
  outcome: TransitionOutcome,
  count: z.number(),
  transitionIds: z.array(z.string()),
});
export type MapEdge = z.infer<typeof MapEdge>;

export const CrawlMap = z.object({
  projectId: z.string(),
  startScreen: z.string().nullable(),
  screens: z.array(ScreenSummary),
  edges: z.array(MapEdge),
  obsToScreen: z.record(z.string(), z.string()),
});
export type CrawlMap = z.infer<typeof CrawlMap>;

// ---------------------------------------------------------------------------
// Design IR — tool-neutral description of the reconstructed design (dp units)
// ---------------------------------------------------------------------------

export const Color = z.string(); // #rrggbb or #rrggbbaa
export type Color = z.infer<typeof Color>;

export const TextStyle = z.object({
  chars: z.string(),
  family: z.string().default("Roboto"),
  weight: z.number().default(400),
  size: z.number(),
  lineHeight: z.number().optional(),
  color: Color,
  align: z.enum(["left", "center", "right"]).default("left"),
});
export type TextStyle = z.infer<typeof TextStyle>;

export type IRLayer = {
  id: string;
  type: "frame" | "rect" | "text" | "image";
  name: string;
  /** Absolute position relative to the screen's top-left, in dp. */
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  radius?: number;
  opacity?: number;
  text?: TextStyle;
  assetId?: string;
  /** Android source metadata for traceability. */
  source?: { cls: string; rid?: string; nodeIdx: number };
  children?: IRLayer[];
};
export const IRLayer: z.ZodType<IRLayer> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.enum(["frame", "rect", "text", "image"]),
    name: z.string(),
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    fill: z.string().optional(),
    stroke: z.string().optional(),
    radius: z.number().optional(),
    opacity: z.number().optional(),
    text: TextStyle.optional(),
    assetId: z.string().optional(),
    source: z.object({ cls: z.string(), rid: z.string().optional(), nodeIdx: z.number() }).optional(),
    children: z.array(IRLayer).optional(),
  }),
);

export const IRHotspot = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  label: z.string(),
  role: z.string().default("button"),
  edgeId: z.string(),
  target: z.string(),
});
export type IRHotspot = z.infer<typeof IRHotspot>;

export const IRScreen = z.object({
  id: z.string(),
  name: z.string(),
  activity: z.string(),
  /** Canvas position of the screen frame, in dp. */
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  background: Color.default("#ffffff"),
  referenceAssetId: z.string(),
  layers: z.array(IRLayer),
  hotspots: z.array(IRHotspot),
  variantAssetIds: z.array(z.string()).default([]),
  depth: z.number().nullable().default(null),
});
export type IRScreen = z.infer<typeof IRScreen>;

export const IREdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  label: z.string(),
  /** Canvas route (absolute dp), first point at the source, last at the target. */
  points: z.array(Point),
});
export type IREdge = z.infer<typeof IREdge>;

export const IRAsset = z.object({
  id: z.string(),
  file: z.string(),
  mime: z.string().default("image/png"),
  /** Pixel size of the file. */
  w: z.number(),
  h: z.number(),
});
export type IRAsset = z.infer<typeof IRAsset>;

export const DesignIR = z.object({
  version: z.literal(1),
  name: z.string(),
  app: AppInfo,
  device: z.object({ widthDp: z.number(), heightDp: z.number(), scale: z.number(), model: z.string() }),
  startScreen: z.string().nullable(),
  screens: z.array(IRScreen),
  edges: z.array(IREdge),
  assets: z.record(z.string(), IRAsset),
  inventory: z
    .array(z.object({ role: z.string(), label: z.string(), assetId: z.string(), w: z.number(), h: z.number(), count: z.number() }))
    .default([]),
});
export type DesignIR = z.infer<typeof DesignIR>;

// ---------------------------------------------------------------------------
// Live crawl events (server → dashboard over WebSocket)
// ---------------------------------------------------------------------------

export type CrawlEvent =
  | { type: "status"; projectId: string; status: ProjectStatus; error?: string }
  | { type: "observation"; projectId: string; obs: Observation; screenId: string; isNewScreen: boolean }
  | { type: "action"; projectId: string; action: Action; screenId: string }
  | { type: "transition"; projectId: string; transition: Transition }
  | { type: "log"; projectId: string; level: "info" | "warn" | "error"; message: string; ts: number }
  | { type: "approval"; projectId: string; requestId: string; element: UiElement; screenId: string; obsId: string }
  | { type: "approvalResolved"; projectId: string; requestId: string; allow: boolean }
  | { type: "stats"; projectId: string; stats: Project["stats"] };
