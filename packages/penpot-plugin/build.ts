import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import sharp from "sharp";

/** Bundle the Penpot plugin into dist/ (served by the Mappy server at /plugins/penpot/). */
const dist = new URL("./dist/", import.meta.url).pathname;
mkdirSync(dist, { recursive: true });
await build({ entryPoints: ["src/plugin.ts"], bundle: true, format: "iife", target: "es2020", outfile: `${dist}plugin.js`, absWorkingDir: new URL(".", import.meta.url).pathname });
await build({ entryPoints: ["src/ui.ts"], bundle: true, format: "esm", target: "es2020", minify: true, outfile: `${dist}ui.js`, absWorkingDir: new URL(".", import.meta.url).pathname });
for (const f of readdirSync(new URL("./public/", import.meta.url))) copyFileSync(new URL(`./public/${f}`, import.meta.url), `${dist}${f}`);
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f5bd5"/><path d="M8 22V10l8 7 8-7v12" stroke="white" stroke-width="3" fill="none" stroke-linejoin="round"/></svg>`;
await sharp(Buffer.from(icon)).resize(128, 128).png().toFile(`${dist}icon.png`);
console.log("Penpot plugin built →", dist);
