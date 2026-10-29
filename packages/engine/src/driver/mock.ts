import sharp from "sharp";
import type { AppInfo, DeviceInfo } from "@mappy/shared";
import type { Driver, Foreground, KeyName } from "./driver.ts";

/**
 * MockDriver: a deterministic fake Android app for tests and demos. Screens are declared as
 * view trees with effects; the driver renders uiautomator-compatible XML and synthetic PNG
 * screenshots, and simulates navigation, dialogs, permission prompts, external apps and crashes.
 */

export type MockEffect =
  | { go: string; param?: string }
  | { back: true }
  | { replace: string; param?: string }
  | { dialog: string; param?: string }
  | { external: string }
  | { crash: true }
  | { toggle: true }
  | { permission: string; then?: MockEffect }
  | { noop: true };

export interface MockView {
  cls?: string;
  id?: string;
  text?: string;
  desc?: string;
  hint?: string;
  clickable?: boolean;
  checkable?: boolean;
  checked?: boolean;
  scrollable?: boolean;
  editable?: boolean;
  password?: boolean;
  selected?: boolean;
  /** Height in px when stacked vertically. */
  h?: number;
  /** Lay out children horizontally instead of vertically. */
  row?: boolean;
  bg?: string;
  fg?: string;
  children?: MockView[];
  onClick?: MockEffect;
  onLongClick?: MockEffect;
}

export interface MockScreenCtx {
  param?: string;
  get(key: string): unknown;
}

export interface MockScreenDef {
  activity: string;
  title?: string | ((ctx: MockScreenCtx) => string);
  body: (ctx: MockScreenCtx) => MockView[];
  bottomNav?: { id: string; text: string; go: string }[];
  /** Dialog screens render as a small floating window. */
  dialog?: boolean;
}

export interface MockAppDef {
  pkg: string;
  label: string;
  launch: string;
  screens: Record<string, MockScreenDef>;
}

interface Frame {
  screen: string;
  param?: string;
}

interface RNode {
  cls: string;
  pkg: string;
  rid: string;
  text: string;
  desc: string;
  hint: string;
  x: number;
  y: number;
  w: number;
  h: number;
  clickable: boolean;
  checkable: boolean;
  checked: boolean;
  scrollable: boolean;
  editable: boolean;
  password: boolean;
  selected: boolean;
  focused: boolean;
  bg?: string;
  fg?: string;
  children: RNode[];
  onClick?: MockEffect;
  onLongClick?: MockEffect;
  stateKey?: string;
}

const W = 1080;
const H = 2400;
const STATUS = 84;
const TOOLBAR = 168;
const NAV = 180;
const LAUNCHER = "com.android.launcher3";
const PERMISSION_PKG = "com.google.android.permissioncontroller";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function defaultHeight(v: MockView): number {
  if (v.h) return v.h;
  if (v.children?.length) {
    return v.row ? Math.max(...v.children.map(defaultHeight)) : v.children.reduce((s, c) => s + defaultHeight(c), 0);
  }
  if (v.editable) return 150;
  return 140;
}

export class MockDriver implements Driver {
  readonly serial = "mock-0";
  readonly app: MockAppDef;
  private stack: Frame[] = [];
  private fg: "app" | "launcher" | "crash" | { external: string } | { permission: string; then?: MockEffect; prev?: string } = "launcher";
  private state = new Map<string, unknown>();
  private focusedKey: string | null = null;
  private scroll = new Map<string, number>();
  private lastTree: RNode | null = null;
  private pngCache = new Map<string, Buffer>();
  /** Log of every effect performed, for assertions. */
  readonly log: string[] = [];

  constructor(app: MockAppDef) {
    this.app = app;
  }

  async info(): Promise<DeviceInfo> {
    return { serial: this.serial, model: "Mockphone", manufacturer: "Mappy", sdk: 34, release: "14", widthPx: W, heightPx: H, density: 420 };
  }

  async listApps(): Promise<AppInfo[]> {
    return [{ pkg: this.app.pkg, label: this.app.label, versionName: "1.0", launchActivity: this.app.screens[this.app.launch].activity }];
  }

  async launch(pkg: string): Promise<void> {
    if (pkg !== this.app.pkg) throw new Error(`mock: unknown package ${pkg}`);
    if (this.fg === "app" && this.stack.length) return;
    this.stack = [{ screen: this.app.launch }];
    this.fg = "app";
    this.log.push(`launch`);
  }

  async forceStop(pkg: string): Promise<void> {
    if (pkg !== this.app.pkg) return;
    this.stack = [];
    this.fg = "launcher";
    this.scroll.clear();
    this.log.push("forceStop");
  }

  async foreground(): Promise<Foreground> {
    if (this.fg === "app") return { pkg: this.app.pkg, activity: this.currentDef().activity };
    if (this.fg === "launcher") return { pkg: LAUNCHER, activity: `${LAUNCHER}.Launcher` };
    if (this.fg === "crash") return { pkg: "android", activity: "com.android.server.am.AppErrorDialog" };
    if ("external" in this.fg) return { pkg: this.fg.external, activity: `${this.fg.external}.MainActivity` };
    return { pkg: PERMISSION_PKG, activity: `${PERMISSION_PKG}.ui.GrantPermissionsActivity` };
  }

  private currentFrame(): Frame {
    return this.stack[this.stack.length - 1];
  }

  private currentDef(): MockScreenDef {
    const def = this.app.screens[this.currentFrame().screen];
    if (!def) throw new Error(`mock: unknown screen ${this.currentFrame().screen}`);
    return def;
  }

  private ctx(frame: Frame): MockScreenCtx {
    return { param: frame.param, get: (k) => this.state.get(k) };
  }

  // ---- rendering ---------------------------------------------------------

  private build(v: MockView, pkg: string, x: number, y: number, w: number, scope: string, path: string): RNode {
    const h = defaultHeight(v);
    const stateKey = `${scope}/${v.id ?? path}`;
    const checked = v.checkable ? ((this.state.get(stateKey) as boolean | undefined) ?? !!v.checked) : false;
    const typed = v.editable ? (this.state.get(`text:${stateKey}`) as string | undefined) : undefined;
    const cls =
      v.cls ??
      (v.editable
        ? "android.widget.EditText"
        : v.checkable
          ? "android.widget.CheckBox"
          : v.scrollable
            ? "androidx.recyclerview.widget.RecyclerView"
            : v.children?.length
              ? "android.widget.LinearLayout"
              : v.onClick && v.text
                ? "android.widget.Button"
                : v.text
                  ? "android.widget.TextView"
                  : v.onClick
                    ? "android.widget.ImageButton"
                    : "android.widget.LinearLayout");
    const node: RNode = {
      cls,
      pkg,
      rid: v.id ? `${pkg}:id/${v.id}` : "",
      text: typed ?? v.text ?? "",
      desc: v.desc ?? "",
      hint: v.editable ? (v.hint ?? "") : "",
      x,
      y,
      w,
      h,
      clickable: !!(v.onClick || v.checkable || v.editable || v.clickable),
      checkable: !!v.checkable,
      checked,
      scrollable: !!v.scrollable,
      editable: !!v.editable,
      password: !!v.password,
      selected: !!v.selected,
      focused: this.focusedKey === stateKey,
      bg: v.bg,
      fg: v.fg,
      children: [],
      onClick: v.onClick ?? (v.checkable ? { toggle: true } : undefined),
      onLongClick: v.onLongClick,
      stateKey,
    };
    const kids = v.children ?? [];
    if (v.row) {
      const cw = w / Math.max(1, kids.length);
      kids.forEach((c, i) => node.children.push(this.build(c, pkg, x + i * cw, y, cw, scope, `${path}.${i}`)));
    } else {
      let off = v.scrollable ? -(this.scroll.get(stateKey) ?? 0) : 0;
      kids.forEach((c, i) => {
        const child = this.build(c, pkg, x, y + off, w, scope, `${path}.${i}`);
        off += child.h;
        node.children.push(child);
      });
      if (v.scrollable) {
        // Children outside the viewport are not reported by uiautomator.
        node.children = node.children.filter((c) => c.y + c.h > y && c.y < y + h);
      }
    }
    return node;
  }

  private container(cls: string, pkg: string, x: number, y: number, w: number, h: number, children: RNode[], rid = ""): RNode {
    return { cls, pkg, rid, text: "", desc: "", hint: "", x, y, w, h, clickable: false, checkable: false, checked: false, scrollable: false, editable: false, password: false, selected: false, focused: false, children };
  }

  private renderScreen(frame: Frame): RNode {
    const def = this.app.screens[frame.screen];
    const pkg = this.app.pkg;
    const ctx = this.ctx(frame);
    if (def.dialog) {
      const views = def.body(ctx);
      const bodyH = views.reduce((s, v) => s + defaultHeight(v), 0);
      const dh = bodyH + 120;
      const dy = Math.round((H - dh) / 2);
      const inner = views.reduce<{ y: number; nodes: RNode[] }>(
        (acc, v, i) => {
          const n = this.build(v, pkg, 120, acc.y, W - 240, frame.screen, `${i}`);
          return { y: acc.y + n.h, nodes: [...acc.nodes, n] };
        },
        { y: dy + 60, nodes: [] },
      ).nodes;
      return this.container("android.widget.FrameLayout", pkg, 90, dy, W - 180, dh, [this.container("android.widget.LinearLayout", pkg, 90, dy, W - 180, dh, inner, `${pkg}:id/parentPanel`)]);
    }
    const children: RNode[] = [];
    let y = STATUS;
    const title = typeof def.title === "function" ? def.title(ctx) : def.title;
    if (title !== undefined) {
      const bar: RNode[] = [];
      if (this.stack.length > 1) {
        bar.push({ ...this.container("android.widget.ImageButton", pkg, 0, y, 168, TOOLBAR, []), desc: "Navigate up", clickable: true, onClick: { back: true } });
      }
      bar.push({ ...this.container("android.widget.TextView", pkg, 200, y + 40, 700, 90, []), text: title });
      children.push(this.container("androidx.appcompat.widget.Toolbar", pkg, 0, y, W, TOOLBAR, bar, `${pkg}:id/toolbar`));
      y += TOOLBAR;
    }
    const navH = def.bottomNav?.length ? 200 : 0;
    const bodyBottom = H - NAV - navH;
    const body: RNode[] = [];
    let by = y;
    const views = def.body(ctx);
    views.forEach((v, i) => {
      const n = this.build(v, pkg, 0, by, W, frame.screen, `${i}`);
      if (v.scrollable) {
        const after = views.slice(i + 1).reduce((s, x) => s + defaultHeight(x), 0);
        n.h = Math.max(200, bodyBottom - by - after);
        n.children = n.children.filter((c) => c.y + c.h > n.y && c.y < n.y + n.h);
      }
      by += n.h;
      body.push(n);
    });
    children.push(this.container("android.widget.LinearLayout", pkg, 0, y, W, bodyBottom - y, body, `${pkg}:id/content`));
    if (def.bottomNav?.length) {
      const iw = W / def.bottomNav.length;
      const items = def.bottomNav.map((it, i) => ({
        ...this.container("android.widget.FrameLayout", pkg, i * iw, bodyBottom, iw, navH, [
          { ...this.container("android.widget.TextView", pkg, i * iw + 20, bodyBottom + 110, iw - 40, 60, []), text: it.text },
        ], `${pkg}:id/${it.id}`),
        clickable: true,
        selected: frame.screen === it.go,
        desc: it.text,
        onClick: frame.screen === it.go ? ({ noop: true } as MockEffect) : ({ replace: it.go } as MockEffect),
      }));
      children.push(this.container("com.google.android.material.bottomnavigation.BottomNavigationView", pkg, 0, bodyBottom, W, navH, items, `${pkg}:id/bottom_nav`));
    }
    return this.container("android.widget.FrameLayout", pkg, 0, 0, W, H, [this.container("android.widget.LinearLayout", pkg, 0, 0, W, H, children)]);
  }

  private renderSystem(pkg: string, title: string, buttons: { id: string; text: string; onClick: MockEffect }[], dialog = false): RNode {
    const y0 = dialog ? 900 : STATUS;
    const kids: RNode[] = [{ ...this.container("android.widget.TextView", pkg, 120, y0 + 60, W - 240, 120, []), text: title }];
    buttons.forEach((b, i) => {
      kids.push({ ...this.container("android.widget.Button", pkg, 120, y0 + 220 + i * 150, W - 240, 130, [], `${pkg}:id/${b.id}`), text: b.text, clickable: true, onClick: b.onClick });
    });
    const h = dialog ? 300 + buttons.length * 150 : H - STATUS;
    return this.container("android.widget.FrameLayout", pkg, dialog ? 90 : 0, y0, dialog ? W - 180 : W, h, kids);
  }

  private tree(): RNode {
    if (this.fg === "app") return this.renderScreen(this.currentFrame());
    if (this.fg === "launcher") {
      return this.renderSystem(LAUNCHER, "Home", [{ id: "app_icon", text: this.app.label, onClick: { noop: true } }]);
    }
    if (this.fg === "crash") {
      return this.renderSystem("android", `${this.app.label} has stopped`, [{ id: "aerr_close", text: "Close app", onClick: { noop: true } }], true);
    }
    if ("external" in this.fg) {
      return this.renderSystem(this.fg.external, `External: ${this.fg.external}`, [{ id: "ext_button", text: "External thing", onClick: { noop: true } }]);
    }
    return this.renderSystem(PERMISSION_PKG, `Allow ${this.app.label} to ${this.fg.permission}?`, [
      { id: "permission_allow_button", text: "Allow", onClick: { noop: true } },
      { id: "permission_deny_button", text: "Don't allow", onClick: { noop: true } },
    ], true);
  }

  private toXml(n: RNode, index = 0): string {
    const b = `[${Math.round(n.x)},${Math.round(n.y)}][${Math.round(n.x + n.w)},${Math.round(n.y + n.h)}]`;
    const attrs = `index="${index}" text="${esc(n.text)}" resource-id="${esc(n.rid)}" class="${n.cls}" package="${n.pkg}" content-desc="${esc(n.desc)}" hint="${esc(n.hint)}" checkable="${n.checkable}" checked="${n.checked}" clickable="${n.clickable}" enabled="true" focusable="${n.clickable}" focused="${n.focused}" scrollable="${n.scrollable}" long-clickable="${!!n.onLongClick}" password="${n.password}" selected="${n.selected}" bounds="${b}"`;
    if (!n.children.length) return `<node ${attrs} />`;
    return `<node ${attrs}>${n.children.map((c, i) => this.toXml(c, i)).join("")}</node>`;
  }

  async hierarchy(): Promise<string> {
    this.lastTree = this.tree();
    return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${this.toXml(this.lastTree)}</hierarchy>`;
  }

  private svg(n: RNode, out: string[]) {
    const fill = n.bg ?? (n.editable ? "#f1f3f4" : n.checkable ? (n.checked ? "#1a73e8" : "#dadce0") : n.clickable && n.text ? "#e8f0fe" : n.cls.includes("Toolbar") ? "#1a73e8" : n.cls.includes("BottomNavigation") ? "#f8f9fa" : undefined);
    if (fill) out.push(`<rect x="${n.x + 4}" y="${n.y + 4}" width="${Math.max(0, n.w - 8)}" height="${Math.max(0, n.h - 8)}" rx="${n.clickable ? 24 : 0}" fill="${fill}"/>`);
    if (n.cls.includes("ImageButton") || (n.clickable && !n.text && !n.editable && !n.children.length)) {
      out.push(`<circle cx="${n.x + n.w / 2}" cy="${n.y + n.h / 2}" r="${Math.min(n.w, n.h) / 4}" fill="#5f6368"/>`);
    }
    const label = n.text || n.hint;
    if (label) {
      const color = n.fg ?? (n.text ? "#202124" : "#80868b");
      out.push(`<text x="${n.x + 48}" y="${n.y + n.h / 2 + 16}" font-family="sans-serif" font-size="44" fill="${color}">${esc(label)}</text>`);
    }
    for (const c of n.children) this.svg(c, out);
  }

  async screenshot(): Promise<Buffer> {
    const t = this.tree();
    const out: string[] = [];
    this.svg(t, out);
    const dim = this.fg === "crash" || (typeof this.fg === "object" && "permission" in this.fg) || (this.fg === "app" && this.currentDef().dialog);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${dim ? "#5f6368" : "#ffffff"}"/><rect width="${W}" height="${STATUS}" fill="#202124"/>${dim ? `<rect x="90" y="${t.y}" width="${W - 180}" height="${t.h}" rx="32" fill="#ffffff"/>` : ""}${out.join("")}</svg>`;
    const hit = this.pngCache.get(svg);
    if (hit) return hit;
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 1 }).toBuffer();
    if (this.pngCache.size > 200) this.pngCache.clear();
    this.pngCache.set(svg, png);
    return png;
  }

  // ---- input ---------------------------------------------------------------

  private hit(x: number, y: number): RNode | null {
    const t = this.tree();
    let found: RNode | null = null;
    const walk = (n: RNode) => {
      if (x < n.x || y < n.y || x > n.x + n.w || y > n.y + n.h) return;
      if (n.clickable) found = n;
      for (const c of n.children) walk(c);
    };
    walk(t);
    return found;
  }

  private apply(effect: MockEffect | undefined, node: RNode | null): void {
    if (!effect) return;
    this.log.push(JSON.stringify(effect));
    if ("noop" in effect) return;
    if ("back" in effect) return void this.pressBack();
    if ("go" in effect) {
      this.stack.push({ screen: effect.go, param: effect.param });
      return;
    }
    if ("replace" in effect) {
      this.stack[this.stack.length - 1] = { screen: effect.replace, param: effect.param };
      return;
    }
    if ("dialog" in effect) {
      this.stack.push({ screen: effect.dialog, param: effect.param });
      return;
    }
    if ("external" in effect) {
      this.fg = { external: effect.external };
      return;
    }
    if ("crash" in effect) {
      this.stack = [];
      this.fg = "crash";
      return;
    }
    if ("toggle" in effect && node?.stateKey) {
      this.state.set(node.stateKey, !node.checked);
      return;
    }
    if ("permission" in effect) {
      this.fg = { permission: effect.permission, then: effect.then };
    }
  }

  private pressBack(): void {
    if (this.fg === "crash" || this.fg === "launcher") return;
    if (typeof this.fg === "object" && "external" in this.fg) {
      this.fg = "app";
      return;
    }
    if (typeof this.fg === "object" && "permission" in this.fg) {
      this.fg = "app";
      return;
    }
    if (this.stack.length > 1) {
      this.stack.pop();
      this.focusedKey = null;
    } else {
      this.stack = [];
      this.fg = "launcher";
    }
  }

  async tap(x: number, y: number): Promise<void> {
    const n = this.hit(x, y);
    if (!n) return;
    if (this.fg === "crash") {
      this.fg = "launcher";
      return;
    }
    if (typeof this.fg === "object" && "permission" in this.fg) {
      const perm = this.fg;
      this.fg = "app";
      const granted = n.rid.endsWith("permission_allow_button");
      this.state.set(`perm:${perm.permission}`, granted);
      if (perm.then) this.apply(perm.then, null);
      return;
    }
    if (n.editable) {
      this.focusedKey = n.stateKey ?? null;
      return;
    }
    this.apply(n.onClick, n);
  }

  async longPress(x: number, y: number): Promise<void> {
    const n = this.hit(x, y);
    if (n?.onLongClick) this.apply(n.onLongClick, n);
  }

  async swipe(x1: number, y1: number, _x2: number, y2: number): Promise<void> {
    const t = this.tree();
    let target: RNode | null = null;
    const walk = (n: RNode) => {
      if (x1 < n.x || y1 < n.y || x1 > n.x + n.w || y1 > n.y + n.h) return;
      if (n.scrollable) target = n;
      n.children.forEach(walk);
    };
    walk(t);
    if (!target) return;
    const tn = target as RNode;
    const key = tn.stateKey!;
    const cur = this.scroll.get(key) ?? 0;
    const next = Math.max(0, cur + (y1 - y2));
    this.scroll.set(key, next);
  }

  async typeText(text: string): Promise<void> {
    if (this.focusedKey) this.state.set(`text:${this.focusedKey}`, text);
  }

  async key(key: KeyName): Promise<void> {
    if (key === "BACK") {
      if (this.focusedKey) {
        this.focusedKey = null; // first BACK hides the keyboard
        return;
      }
      this.pressBack();
    } else if (key === "HOME") {
      this.fg = "launcher";
    } else if (key === "ESCAPE") {
      this.focusedKey = null;
    }
  }

  async keyboardShown(): Promise<boolean> {
    return this.focusedKey !== null;
  }

  /** Test helper: the logical screen currently displayed. */
  current(): string {
    if (this.fg === "app") return this.currentFrame().screen;
    if (typeof this.fg === "object") return "external" in this.fg ? `external:${this.fg.external}` : `permission:${this.fg.permission}`;
    return this.fg;
  }
}
