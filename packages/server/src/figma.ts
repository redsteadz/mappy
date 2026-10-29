import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { finishFigmaScripts, planFigmaScripts, type FigmaPlan, type ImageSlot, type ScreensResult } from "@mappy/engine";
import { getIR } from "./exports.ts";
import type { ProjectStore } from "./store.ts";

/** upload_assets accepts at most 60 URLs per call. */
export const UPLOAD_BATCH = 60;

/** Normalise whatever the upload_assets response looked like into [{url, nodeId?}]. */
export function parseUploadUrls(raw: unknown): { url: string; nodeId?: string }[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? (Object.values(raw as Record<string, unknown>).find(Array.isArray) as unknown[] | undefined) ?? []
      : [];
  return list.map((e) => {
    if (typeof e === "string") return { url: e };
    const o = e as Record<string, unknown>;
    const url = (o.submitUrl ?? o.url ?? o.uploadUrl ?? o.upload_url) as string | undefined;
    if (!url) throw new Error(`upload entry without a URL: ${JSON.stringify(e).slice(0, 120)}`);
    return { url, nodeId: (o.targetNodeId ?? o.nodeId ?? o.target_node_id) as string | undefined };
  });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function figmaCommand(cmd: string, rest: string[], values: Record<string, unknown>, store: ProjectStore): Promise<void> {
  const projectId = rest[0];
  if (!projectId) throw new Error(`${cmd} needs a project id (see \`mappy projects\`)`);
  const dir = resolve((values.out as string | undefined) ?? (values.dir as string | undefined) ?? join(".mappy-figma", projectId));
  await mkdir(join(dir, "results"), { recursive: true });

  if (cmd === "figma-plan" && !values.finish) {
    const { ir } = await getIR(store, projectId);
    const maxChars = values["max-chars"] ? Number(values["max-chars"]) : undefined;
    const { plan, scripts } = await planFigmaScripts(ir, projectId, { maxChars });
    for (const [file, code] of Object.entries(scripts)) await writeFile(join(dir, file), code);
    await writeFile(join(dir, "plan.json"), JSON.stringify(plan, null, 2));
    console.log(`Figma plan for "${plan.appName}" → ${dir}`);
    console.log(`Page: ${plan.pageName}`);
    for (const s of plan.steps) console.log(`  ${s.file.padEnd(16)} ${s.kind.padEnd(10)} ${String(s.screens.length).padStart(3)} screens  ${s.chars} chars`);
    if (plan.simplified.length) console.log(`  (kept as flat screenshots, too complex for one call: ${plan.simplified.join(", ")})`);
    console.log(`\nNext: run each script with use_figma and save its returned JSON to ${join(dir, "results", "<script>.json")},`);
    console.log(`then: mappy figma-plan ${projectId} --finish`);
    return;
  }

  if (cmd === "figma-plan") {
    const plan = await readJson<FigmaPlan>(join(dir, "plan.json"));
    const results: ScreensResult[] = [];
    const missing: string[] = [];
    for (const step of plan.steps) {
      const f = join(dir, "results", step.file.replace(/\.js$/, ".json"));
      if (!existsSync(f)) missing.push(step.file);
      else results.push(await readJson<ScreensResult>(f));
    }
    if (missing.length) throw new Error(`missing results for: ${missing.join(", ")} (save each use_figma return value to results/<script>.json)`);
    const { ir } = await getIR(store, projectId);
    const { uploads, wire } = await finishFigmaScripts(ir, plan, results);
    await writeFile(join(dir, "wire.js"), wire);
    await writeFile(join(dir, "uploads.json"), JSON.stringify(uploads, null, 2));
    const batches = Math.ceil(uploads.length / UPLOAD_BATCH);
    for (let b = 0; b < batches; b++) {
      const slice = uploads.slice(b * UPLOAD_BATCH, (b + 1) * UPLOAD_BATCH);
      await writeFile(join(dir, `upload-batch-${b + 1}.json`), JSON.stringify({ count: slice.length, nodeIds: slice.map((s) => s.nodeId) }, null, 2));
    }
    console.log(`${uploads.length} images to upload in ${batches} batch(es) of ≤${UPLOAD_BATCH}: upload-batch-1.json … upload-batch-${batches}.json`);
    console.log(`For each batch: call upload_assets with that count + nodeIds, save the response to urls-<n>.json, then`);
    console.log(`  mappy figma-upload ${projectId} --batch <n> --urls ${join(dir, "urls-<n>.json")}`);
    console.log(`Finally run wire.js with use_figma (${wire.length} chars).`);
    return;
  }

  // figma-upload
  const batch = Number(values.batch ?? 1);
  const urlsFile = values.urls as string | undefined;
  if (!urlsFile) throw new Error("figma-upload needs --urls <file with the upload_assets response>");
  const uploads = await readJson<ImageSlot[]>(join(dir, "uploads.json"));
  const slice = uploads.slice((batch - 1) * UPLOAD_BATCH, batch * UPLOAD_BATCH);
  const urls = parseUploadUrls(await readJson<unknown>(urlsFile));
  if (urls.length !== slice.length) throw new Error(`batch ${batch} has ${slice.length} images but the response has ${urls.length} URLs`);
  const assetsDir = join(store.dirOf(projectId), "export", "assets");
  let ok = 0;
  const failures: string[] = [];
  await Promise.all(
    urls.map(async (u, i) => {
      const slot = (u.nodeId && slice.find((s) => s.nodeId === u.nodeId)) || slice[i];
      const png = await readFile(join(assetsDir, `${slot.assetId}.png`));
      const res = await fetch(u.url, { method: "POST", headers: { "Content-Type": "image/png" }, body: png });
      if (res.ok) ok++;
      else failures.push(`${slot.nodeId}: ${res.status} ${(await res.text()).slice(0, 160)}`);
    }),
  );
  console.log(`Uploaded ${ok}/${slice.length} images for batch ${batch}.`);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
}
