import type { Rect, UiNode } from "@mappy/shared";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function parseBounds(s: string | undefined): Rect {
  const m = s?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return { x: 0, y: 0, w: 0, h: 0 };
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Scan one tag starting at `<`; attribute values may contain `>` so quotes are respected. */
function readTag(xml: string, start: number): { name: string; attrs: Record<string, string>; close: boolean; selfClose: boolean; end: number } | null {
  let i = start + 1;
  let close = false;
  if (xml[i] === "/") {
    close = true;
    i++;
  }
  const nameStart = i;
  while (i < xml.length && !/[\s/>]/.test(xml[i])) i++;
  const name = xml.slice(nameStart, i);
  const attrs: Record<string, string> = {};
  while (i < xml.length) {
    const c = xml[i];
    if (c === ">") return { name, attrs, close, selfClose: false, end: i + 1 };
    if (c === "/" && xml[i + 1] === ">") return { name, attrs, close, selfClose: true, end: i + 2 };
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const keyStart = i;
    while (i < xml.length && xml[i] !== "=" && !/[\s/>]/.test(xml[i])) i++;
    const key = xml.slice(keyStart, i);
    if (xml[i] === "=") {
      i++;
      const q = xml[i];
      if (q === '"' || q === "'") {
        const valEnd = xml.indexOf(q, i + 1);
        if (valEnd < 0) return null;
        attrs[key] = decodeEntities(xml.slice(i + 1, valEnd));
        i = valEnd + 1;
      }
    } else if (key) {
      attrs[key] = "";
    }
  }
  return null;
}

const bool = (v: string | undefined): boolean => v === "true";

const EDITABLE_CLASS = /EditText|AutoCompleteTextView|SearchView\$SearchAutoComplete/;

/**
 * Parse a `uiautomator dump` XML document into a flat, pre-ordered node list.
 * Tolerates the "UI hierchary dumped to: ..." trailer and multiple window roots.
 */
export function parseHierarchy(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const stack: number[] = [];
  let i = xml.indexOf("<");
  while (i >= 0 && i < xml.length) {
    if (xml.startsWith("<?", i) || xml.startsWith("<!", i)) {
      i = xml.indexOf(">", i);
      if (i < 0) break;
      i = xml.indexOf("<", i + 1);
      continue;
    }
    const tag = readTag(xml, i);
    if (!tag) break;
    if (tag.name === "node") {
      if (tag.close) {
        stack.pop();
      } else {
        const a = tag.attrs;
        const parent = stack.length ? stack[stack.length - 1] : null;
        const cls = a.class ?? "";
        const node: UiNode = {
          idx: nodes.length,
          parent,
          depth: stack.length,
          children: [],
          cls,
          pkg: a.package ?? "",
          rid: a["resource-id"] ?? "",
          text: a.text ?? "",
          desc: a["content-desc"] ?? "",
          hint: a.hint ?? a["hint-text"] ?? "",
          bounds: parseBounds(a.bounds),
          clickable: bool(a.clickable),
          longClickable: bool(a["long-clickable"]),
          checkable: bool(a.checkable),
          checked: bool(a.checked),
          scrollable: bool(a.scrollable),
          focusable: bool(a.focusable),
          focused: bool(a.focused),
          enabled: a.enabled === undefined ? true : bool(a.enabled),
          selected: bool(a.selected),
          password: bool(a.password),
          editable: EDITABLE_CLASS.test(cls) || bool(a.editable),
        };
        nodes.push(node);
        if (parent !== null) nodes[parent].children.push(node.idx);
        if (!tag.selfClose) stack.push(node.idx);
      }
    }
    i = xml.indexOf("<", tag.end);
  }
  return nodes;
}

/** Ancestors of a node, nearest first. */
export function ancestors(nodes: UiNode[], idx: number): UiNode[] {
  const out: UiNode[] = [];
  let p = nodes[idx].parent;
  while (p !== null) {
    out.push(nodes[p]);
    p = nodes[p].parent;
  }
  return out;
}

/** All descendants of a node in pre-order. */
export function descendants(nodes: UiNode[], idx: number): UiNode[] {
  const out: UiNode[] = [];
  const walk = (i: number) => {
    for (const c of nodes[i].children) {
      out.push(nodes[c]);
      walk(c);
    }
  };
  walk(idx);
  return out;
}

/** The most common package among nodes — usually the foreground app. */
export function dominantPackage(nodes: UiNode[]): string {
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.pkg, (counts.get(n.pkg) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [pkg, c] of counts) {
    if (c > bestCount && pkg) {
      best = pkg;
      bestCount = c;
    }
  }
  return best;
}
