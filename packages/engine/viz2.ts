import { CrawlConfig } from "@mappy/shared";
import { MockDriver, demoApp, parseHierarchy, reconstructScreen, AssetSink } from "@mappy/engine";
const d = new MockDriver(demoApp); await d.launch(demoApp.pkg);
await d.tap(900, 2120); // settings nav
const xml = await d.hierarchy(); const png = await d.screenshot();
const rec = await reconstructScreen({ png, nodes: parseHierarchy(xml), appPkg: demoApp.pkg, density: 420 }, new AssetSink());
const walk = (ls, ind = "") => ls.forEach((l) => { if (l.y + l.h > 800 || ind === "") console.log(ind + l.type, l.name, Math.round(l.y), Math.round(l.h), l.fill ?? "", l.radius ?? ""); l.children && walk(l.children, ind + "  "); });
walk(rec.layers);
