import { strFromU8, unzipSync } from "fflate";
import type { DesignIR, Project } from "@mappy/shared";

const SERVER = "http://127.0.0.1:4317";
const status = document.getElementById("status")!;
const select = document.getElementById("project") as HTMLSelectElement;
const fetchBtn = document.getElementById("fetch") as HTMLButtonElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const say = (s: string) => (status.textContent = s);

function send(zip: Uint8Array) {
  const files = unzipSync(zip);
  if (!files["ir.json"]) throw new Error("Not a Mappy bundle (ir.json missing)");
  const ir = JSON.parse(strFromU8(files["ir.json"])) as DesignIR;
  const assets: Record<string, Uint8Array> = {};
  for (const a of Object.values(ir.assets)) if (files[a.file]) assets[a.id] = files[a.file];
  say(`Building ${ir.screens.length} screens…`);
  parent.postMessage({ pluginMessage: { type: "import", ir, assets } }, "*");
}

fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (f) {
    try {
      send(new Uint8Array(await f.arrayBuffer()));
    } catch (e) {
      say(String(e));
    }
  }
});

fetchBtn.addEventListener("click", async () => {
  if (!select.value) return;
  fetchBtn.disabled = true;
  say("Preparing the export…");
  try {
    const res = await fetch(`${SERVER}/api/projects/${select.value}/export/bundle`);
    if (!res.ok) throw new Error(`${res.status}`);
    send(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    say(`Could not load the crawl: ${e}`);
    fetchBtn.disabled = false;
  }
});

window.onmessage = (ev) => {
  const m = ev.data?.pluginMessage as { type?: string; message?: string; done?: boolean } | undefined;
  if (m?.type === "progress" && m.message) {
    say(m.message);
    if (m.done) fetchBtn.disabled = false;
  }
};

fetch(`${SERVER}/api/projects`)
  .then((r) => r.json() as Promise<Project[]>)
  .then((ps) => {
    select.innerHTML = ps.length ? ps.map((p) => `<option value="${p.id}">${(p.app.label ?? p.app.pkg).replace(/</g, "&lt;")} · ${p.stats.screens} screens</option>`).join("") : `<option value="">No crawls yet</option>`;
    fetchBtn.disabled = !ps.length;
  })
  .catch(() => (select.innerHTML = `<option value="">Mappy isn't running — use a file</option>`));
