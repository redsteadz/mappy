import { mkdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

/** Bundle the Figma plugin: dist/code.js (sandbox) and dist/ui.html (UI with inlined script). */
const root = new URL(".", import.meta.url).pathname;
mkdirSync(`${root}dist`, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ["src/code.ts"], bundle: true, format: "iife", target: "es2019", outfile: "dist/code.js" });
const ui = await build({ absWorkingDir: root, entryPoints: ["src/ui.ts"], bundle: true, format: "iife", target: "es2019", minify: true, write: false });
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:16px;font:12px/1.45 Inter,system-ui,sans-serif;color:var(--figma-color-text,#1c2026);background:var(--figma-color-bg,#fff)}
h1{font-size:14px;margin:0 0 4px}p{margin:0 0 12px;color:var(--figma-color-text-secondary,#646c78)}
.box{border:1px dashed var(--figma-color-border,#e1e4ea);border-radius:8px;padding:12px;margin-bottom:12px}
select,button{width:100%;height:30px;margin-top:6px;border-radius:6px;border:1px solid var(--figma-color-border,#e1e4ea);background:transparent;color:inherit;font:inherit}
button{background:var(--figma-color-bg-brand,#4f5bd5);color:#fff;border:0}button:disabled{opacity:.5}label{font-weight:600}#status{white-space:pre-wrap}
</style></head><body>
<h1>Import a Mappy map</h1><p>One frame per screen: editable layers, a hidden reference screenshot, prototype links, flow arrows and an inventory page.</p>
<div class="box"><label for="file">From a .mappy.zip</label><input id="file" type="file" accept=".zip" style="margin-top:6px;width:100%"></div>
<div class="box"><label for="project">From Mappy on this computer</label><select id="project"><option>Loading…</option></select><button id="fetch" disabled>Import selected crawl</button></div>
<div id="status"></div><script>${ui.outputFiles[0].text}</script></body></html>`;
writeFileSync(`${root}dist/ui.html`, html);
console.log("Figma plugin built → dist/ (import manifest.json in Figma desktop: Plugins → Development → Import plugin from manifest)");
