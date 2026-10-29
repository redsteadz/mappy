import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { CrawlEvent, CrawlMap } from "@mappy/shared";
import { createApp, PENPOT_DIST } from "./app.ts";
import { ProjectStore } from "./store.ts";

const home = mkdtempSync(join(tmpdir(), "mappy-server-"));
process.env.MAPPY_HOME = home;

describe("server API against the demo device", async () => {
  const { app, ctx } = await createApp({ store: new ProjectStore(join(home, "projects")) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  afterAll(() => app.close());

  const json = async <T = any>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> => {
    const r = await app.inject({ method, url, payload: body as object });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json() as T;
  };

  let projectId = "";
  let map: CrawlMap;

  it("lists the demo device and its app", async () => {
    const devices = await json("GET", "/api/devices");
    expect(devices.some((d: { serial: string }) => d.serial === "demo")).toBe(true);
    const apps = await json("GET", "/api/devices/demo/apps");
    expect(apps[0].pkg).toBe("com.mappy.notely");
  });

  it("crawls with live WebSocket events and risky-action approvals", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    await new Promise((r) => ws.on("open", r));
    const events: CrawlEvent[] = [];
    const approvals: string[] = [];
    ws.on("message", async (data) => {
      const e = JSON.parse(String(data)) as CrawlEvent;
      events.push(e);
      if (e.type === "approval") {
        approvals.push(e.element.label);
        // Allow "Delete" (just opens a dialog), refuse everything else.
        await json("POST", `/api/projects/${e.projectId}/approvals/${e.requestId}`, { allow: e.element.label === "Delete" });
      }
    });
    const project = await json("POST", "/api/projects", {
      serial: "demo",
      pkg: "com.mappy.notely",
      config: { riskyPolicy: "ask", settle: { minMs: 0, maxMs: 500, stableFrames: 1 } },
    });
    projectId = project.id;
    await ctx.jobs.waitFor(projectId);
    ws.close();
    const detail = await json("GET", `/api/projects/${projectId}`);
    expect(detail.project.error ?? "").toBe("");
    expect(detail.project.status).toBe("done");
    expect(approvals).toEqual(expect.arrayContaining(["Delete", "Log out"]));
    expect(events.some((e) => e.type === "observation" && e.isNewScreen)).toBe(true);
    map = await json("GET", `/api/projects/${projectId}/map`);
    expect(map.screens.filter((s) => s.kind === "app").length).toBeGreaterThanOrEqual(14);
  });

  it("serves screen details and screenshots", async () => {
    const settings = map.screens.find((s) => s.name === "Settings")!;
    const d = await json("GET", `/api/projects/${projectId}/screens/${settings.id}`);
    expect(d.elements.some((e: { label: string }) => e.label === "Account")).toBe(true);
    expect(d.edgesOut.length).toBeGreaterThan(5);
    const png = await app.inject({ method: "GET", url: `/api/projects/${projectId}/obs/${d.obs.png}` });
    expect(png.headers["content-type"]).toBe("image/png");
  });

  it("applies rename, merge and reset overrides", async () => {
    const notes = map.screens.find((s) => s.name === "Notes")!;
    const search = map.screens.find((s) => s.name === "Search")!;
    let m = await json("POST", `/api/projects/${projectId}/screens/${notes.id}/rename`, { name: "Home feed" });
    expect(m.screens.find((s: { id: string }) => s.id === notes.id).name).toBe("Home feed");
    m = await json("POST", `/api/projects/${projectId}/screens/merge`, { into: notes.id, ids: [notes.id, search.id] });
    expect(m.screens.some((s: { id: string }) => s.id === search.id)).toBe(false);
    m = await json("POST", `/api/projects/${projectId}/overrides/reset`);
    expect(m.screens.some((s: { id: string }) => s.id === search.id)).toBe(true);
  });

  it("computes insights and exports every format", async () => {
    const ins = await json("GET", `/api/projects/${projectId}/insights`);
    expect(ins.summary.byKind.crash).toBeGreaterThanOrEqual(1);
    expect(ins.summary.byKind.unlabeled).toBeGreaterThanOrEqual(1); // the demo's icon buttons have no labels
    for (const [fmt, type] of [
      ["mermaid", "text/plain"],
      ["json", "application/json"],
      ["svg", "application/zip"],
      ["poster.png", "image/png"],
      ["poster.pdf", "application/pdf"],
      ["bundle", "application/zip"],
    ]) {
      const r = await app.inject({ method: "GET", url: `/api/projects/${projectId}/export/${fmt}` });
      expect(r.statusCode, fmt).toBe(200);
      expect(String(r.headers["content-type"])).toContain(type);
    }
    const ir = await json("GET", `/api/projects/${projectId}/ir`);
    const anyAsset = Object.keys(ir.assets)[0];
    const a = await app.inject({ method: "GET", url: `/api/projects/${projectId}/assets/${anyAsset}.png` });
    expect(a.statusCode).toBe(200);
    expect(a.headers["access-control-allow-origin"]).toBe("*");
  });

  it.runIf(existsSync(PENPOT_DIST))("serves the Penpot plugin with this server's origin baked in", async () => {
    const r = await app.inject({ method: "GET", url: "/plugins/penpot/plugin.js", headers: { host: "127.0.0.1:4317" } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`${JSON.stringify("http://127.0.0.1:4317")}}/plugins/penpot/ui.html`);
    expect(() => new Function("penpot", r.body)).not.toThrow();
    const manifest = await app.inject({ method: "GET", url: "/plugins/penpot/manifest.json" });
    expect(manifest.json().code).toBe("plugin.js");
  });
});
