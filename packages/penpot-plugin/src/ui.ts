import { unzipSync, strFromU8 } from "fflate";
import type { DesignIR, Project } from "@mappy/shared";

const status = document.getElementById("status")!;
const select = document.getElementById("project") as HTMLSelectElement;
const fetchBtn = document.getElementById("fetch") as HTMLButtonElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
document.body.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";

const say = (s: string) => (status.textContent = s);

/** Unpack a .mappy.zip and hand it to the plugin sandbox. */
function sendBundle(zip: Uint8Array) {
  const files = unzipSync(zip);
  if (!files["ir.json"]) throw new Error("Not a Mappy bundle (ir.json missing)");
  const ir = JSON.parse(strFromU8(files["ir.json"])) as DesignIR;
  const assets: Record<string, Uint8Array> = {};
  for (const a of Object.values(ir.assets)) if (files[a.file]) assets[a.id] = files[a.file];
  say(`Importing ${ir.screens.length} screens…`);
  parent.postMessage({ type: "import", ir, assets }, "*");
}

fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    sendBundle(new Uint8Array(await f.arrayBuffer()));
  } catch (e) {
    say(String(e));
  }
});

fetchBtn.addEventListener("click", async () => {
  const id = select.value;
  if (!id) return;
  fetchBtn.disabled = true;
  say("Preparing the export (rebuilding layers)…");
  try {
    const res = await fetch(`/api/projects/${id}/export/bundle`);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    sendBundle(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    say(`Could not load the crawl: ${e}`);
    fetchBtn.disabled = false;
  }
});

window.addEventListener("message", (ev) => {
  const m = ev.data as { type?: string; message?: string; done?: boolean };
  if (m?.type === "progress" && m.message) {
    say(m.message);
    if (m.done) fetchBtn.disabled = false;
  }
});

fetch("/api/projects")
  .then((r) => r.json() as Promise<Project[]>)
  .then((projects) => {
    select.innerHTML = projects.length
      ? projects.map((p) => `<option value="${p.id}">${(p.app.label ?? p.app.pkg).replace(/</g, "&lt;")} · ${p.stats.screens} screens · ${new Date(p.updatedAt).toLocaleDateString()}</option>`).join("")
      : `<option value="">No crawls yet</option>`;
    fetchBtn.disabled = !projects.length;
  })
  .catch(() => (select.innerHTML = `<option value="">Mappy server not reachable — use a file</option>`));
