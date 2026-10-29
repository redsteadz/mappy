import { writeFileSync } from "node:fs";
import { CrawlConfig } from "@mappy/shared";
import { Resvg } from "@resvg/resvg-js";
import { MockDriver, demoApp, Crawler, MemoryStore, buildMap, computeSignature, parseHierarchy, buildDesignIR, posterPng, screenSvg, ROBOTO_TTF, fidelity } from "@mappy/engine";
const driver = new MockDriver(demoApp); const store = new MemoryStore();
const config = CrawlConfig.parse({ riskyPolicy: "skip", settle: { minMs: 0, maxMs: 1000, stableFrames: 1 } });
await new Crawler({ driver, app: { pkg: demoApp.pkg }, config, store, sleep: async () => {} }).run();
const nodes = (id) => (store.xmls.get(id) ? parseHierarchy(store.xmls.get(id)) : null);
const map = buildMap({ projectId: "p", appPkg: demoApp.pkg, threshold: 0.8, observations: store.observations, transitions: store.transitions, overrides: { assign: {}, renames: {}, hidden: [] }, signature: (o) => computeSignature(o, nodes(o.id)) });
const { ir, assets } = await buildDesignIR({ name: "Notely", app: { pkg: demoApp.pkg }, device: await driver.info(), map, observation: (id) => store.observations.find((o) => o.id === id), png: async (o) => store.pngs.get(o.id), nodes: async (o) => nodes(o.id) });
const asset = (id) => assets.files.get(id)?.png;
writeFileSync("/tmp/claude-1000/-home-red1-Projects-mappy/ca102e2a-d8e7-42d9-bb23-eabfae05852c/scratchpad/poster.png", posterPng(ir, asset, 2400));
for (const name of ["Settings", "Edit note"]) {
  const s = ir.screens.find((x) => x.name === name);
  writeFileSync("/tmp/claude-1000/-home-red1-Projects-mappy/ca102e2a-d8e7-42d9-bb23-eabfae05852c/scratchpad/" + name.replace(" ", "_") + "-recon.png", new Resvg(screenSvg(s, asset), { fitTo: { mode: "width", value: 412 }, font: { fontFiles: [ROBOTO_TTF], loadSystemFonts: false, defaultFontFamily: "Roboto" } }).render().asPng());
  console.log(name, "fidelity", await fidelity(s, asset));
}
