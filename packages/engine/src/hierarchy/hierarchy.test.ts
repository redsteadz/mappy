import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_RISKY_PATTERNS } from "@mappy/shared";
import { extractElements, inputValueFor } from "./elements.ts";
import { dominantPackage, parseHierarchy } from "./parse.ts";

const xml = readFileSync(new URL("../../../../fixtures/views/settings.xml", import.meta.url), "utf8");
const opts = {
  pkg: "com.example.app",
  screen: { w: 1080, h: 2400 },
  listSample: 2,
  riskyPatterns: DEFAULT_RISKY_PATTERNS,
  scroll: true,
  longPress: false,
  inputs: true,
};

describe("parseHierarchy", () => {
  const nodes = parseHierarchy(xml);

  it("parses every node with tree links, bounds and decoded entities, ignoring the dump trailer", () => {
    expect(nodes).toHaveLength(21);
    expect(nodes[0].parent).toBeNull();
    const title = nodes.find((n) => n.text.startsWith("Settings"))!;
    expect(title.text).toBe("Settings & privacy");
    expect(title.bounds).toEqual({ x: 200, y: 124, w: 700, h: 90 });
    expect(nodes[title.parent!].cls).toBe("androidx.appcompat.widget.Toolbar");
    const search = nodes.find((n) => n.editable)!;
    expect(search.hint).toBe("Search settings");
    expect(dominantPackage(nodes)).toBe("com.example.app");
  });

  it("handles self-closing roots and '>' inside attribute values", () => {
    const n = parseHierarchy(`<hierarchy><node text="a > b" class="X" bounds="[0,0][10,10]"/></hierarchy>`);
    expect(n).toHaveLength(1);
    expect(n[0].text).toBe("a > b");
  });
});

describe("extractElements", () => {
  const nodes = parseHierarchy(xml);
  const els = extractElements(nodes, opts);

  it("samples repeated list rows and their toggles", () => {
    const rows = els.filter((e) => e.list && e.kind === "tap");
    expect(rows.map((e) => e.label)).toEqual(["Wi‑Fi · Connected", "Bluetooth · Off"]);
    const toggles = els.filter((e) => e.kind === "toggle");
    expect(toggles).toHaveLength(2);
  });

  it("flags risky elements and ignores other packages", () => {
    const del = els.find((e) => e.label === "Delete account")!;
    expect(del.risky).toBe(true);
    expect(del.riskReason).toBe("Delete");
    expect(els.some((e) => e.label === "12:30")).toBe(false);
  });

  it("produces inputs, scroll containers and stable keys", () => {
    expect(els.find((e) => e.kind === "input")?.label).toBe("Search settings");
    expect(els.find((e) => e.kind === "scroll")?.key).toBe("scroll:recycler_view:RecyclerView");
    const again = extractElements(parseHierarchy(xml.replace("Connected", "Disconnected")), opts);
    expect(again.map((e) => e.key)).toEqual(els.map((e) => e.key));
  });

  it("picks input values from hints", () => {
    const inputs = { email: "e", password: "p", name: "n", phone: "t", search: "s", number: "1", url: "u", default: "d" };
    const search = nodes.find((n) => n.editable)!;
    expect(inputValueFor(search, "Search settings", inputs)).toBe("s");
    expect(inputValueFor({ ...search, hint: "", password: true }, "", inputs)).toBe("p");
  });
});
