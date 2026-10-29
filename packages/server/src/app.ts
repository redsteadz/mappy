import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { CrawlConfig, newId, type CrawlEvent, type Overrides } from "@mappy/shared";
import { extractElements, layoutGraph } from "@mappy/engine";
import { Devices } from "./devices.ts";
import { registerExportRoutes } from "./exports.ts";
import { computeInsights } from "./insights.ts";
import { CrawlManager } from "./jobs.ts";
import { ProjectStore } from "./store.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
export const WEB_DIST = join(here, "../../web/dist");
export const PENPOT_DIST = join(here, "../../penpot-plugin/dist");

export interface AppContext {
  store: ProjectStore;
  devices: Devices;
  jobs: CrawlManager;
}

export async function createApp(ctx?: Partial<AppContext>): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const store = ctx?.store ?? new ProjectStore();
  const devices = ctx?.devices ?? new Devices();
  const jobs = ctx?.jobs ?? new CrawlManager(store, devices);
  const context: AppContext = { store, devices, jobs };
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });

  // The Penpot/Figma plugin iframes have a null origin, so allow any origin on this local-only server.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Private-Network", "true");
  });
  app.options("/*", async (_req, reply) => {
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS").header("Access-Control-Allow-Headers", "content-type").code(204).send();
  });
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; message: string };
    reply.code(e.statusCode && e.statusCode >= 400 ? e.statusCode : 400).send({ error: e.message });
  });

  await app.register(fastifyWebsocket);

  // ---- devices -------------------------------------------------------------

  app.get("/api/doctor", async () => devices.doctor());
  app.get("/api/devices", async () => devices.list());
  app.get<{ Params: { serial: string }; Querystring: { system?: string } }>("/api/devices/:serial/apps", async (req) =>
    devices.apps(req.params.serial, req.query.system === "1"),
  );
  app.get<{ Params: { serial: string; pkg: string } }>("/api/devices/:serial/apps/:pkg", async (req) => devices.appDetails(req.params.serial, req.params.pkg));
  app.get<{ Params: { serial: string } }>("/api/devices/:serial/screen.png", async (req, reply) => {
    const png = await devices.driver(req.params.serial).screenshot();
    reply.type("image/png").header("Cache-Control", "no-store").send(png);
  });
  app.post<{ Params: { serial: string } }>("/api/devices/:serial/restore-settings", async (req) => {
    const d = devices.driver(req.params.serial) as { restorePending?: () => Promise<boolean> };
    return { restored: d.restorePending ? await d.restorePending() : false };
  });

  // ---- projects ------------------------------------------------------------

  app.get("/api/projects", async () => store.list());

  app.post<{ Body: { serial: string; pkg: string; label?: string; name?: string; config?: unknown; start?: boolean } }>("/api/projects", async (req) => {
    const { serial, pkg, label, name } = req.body;
    const driver = devices.driver(serial);
    const info = { ...(await driver.info()), serial };
    const apps = await driver.listApps({ includeSystem: true });
    const app = { ...(apps.find((a) => a.pkg === pkg) ?? { pkg }), ...(label ? { label } : {}) };
    const config = CrawlConfig.parse(req.body.config ?? {});
    const project = await store.create(info, app, config, name);
    if (req.body.start !== false) await jobs.start(project.id, { resume: false });
    return store.get(project.id);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const project = await store.get(req.params.id);
    return {
      project,
      running: jobs.isRunning(project.id),
      current: jobs.current(project.id),
      approvals: jobs.pendingApprovals(project.id),
      log: jobs.recentLog(project.id),
    };
  });

  app.put<{ Params: { id: string }; Body: { name?: string; config?: unknown } }>("/api/projects/:id", async (req) => {
    const patch: Record<string, unknown> = {};
    if (req.body.name) patch.name = req.body.name;
    if (req.body.config) patch.config = CrawlConfig.parse(req.body.config);
    return store.update(req.params.id, patch);
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    if (jobs.isRunning(req.params.id)) {
      jobs.control(req.params.id, "stop");
      await jobs.waitFor(req.params.id);
    }
    await store.remove(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string; op: string } }>("/api/projects/:id/crawl/:op", async (req) => {
    const { id, op } = req.params;
    if (op === "start" || op === "continue") await jobs.start(id, { resume: op === "continue" });
    else if (op === "pause" || op === "resume" || op === "takeover" || op === "stop") jobs.control(id, op);
    else throw Object.assign(new Error(`unknown operation ${op}`), { statusCode: 404 });
    return { ok: true };
  });

  app.post<{ Params: { id: string; requestId: string }; Body: { allow: boolean } }>("/api/projects/:id/approvals/:requestId", async (req) => {
    jobs.approve(req.params.requestId, !!req.body.allow);
    return { ok: true };
  });

  // ---- map, screens, observations -------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { layout?: string } }>("/api/projects/:id/map", async (req) => {
    const { clusterer: _c, ...map } = await store.map(req.params.id);
    if (req.query.layout !== "1") return map;
    // Thumbnail-sized layout for the dashboard's map view (forward edges only, like the export).
    const project = await store.get(req.params.id);
    const tw = 180;
    const th = Math.round((tw * project.device.heightPx) / project.device.widthPx) + 44;
    const depth = new Map(map.screens.map((s) => [s.id, s.depth]));
    const forward = map.edges.filter((e) => {
      if (e.from === e.to || e.actionType === "back" || ["restart", "launch", "manual", "scroll", "input"].includes(e.actionType)) return false;
      const a = depth.get(e.from);
      const b = depth.get(e.to);
      return !(a != null && b != null && b < a);
    });
    const visible = map.screens.filter((s) => !s.hidden);
    const layout = await layoutGraph(
      visible.map((s) => ({ id: s.id, w: tw, h: th })),
      forward.map((e) => ({ id: e.id, from: e.from, to: e.to })),
      { spacing: 50 },
    );
    return { ...map, layout: { positions: Object.fromEntries(layout.positions), nodeWidth: tw, nodeHeight: th, forward: forward.map((e) => e.id) } };
  });

  app.get<{ Params: { id: string; file: string } }>("/api/projects/:id/obs/:file", async (req, reply) => {
    const { id, file } = req.params;
    if (!/^[\w-]+\.(png|xml)$/.test(file)) throw Object.assign(new Error("bad file"), { statusCode: 404 });
    const path = join(store.filesOf(id).obsDir, file);
    if (!existsSync(path)) throw Object.assign(new Error("not found"), { statusCode: 404 });
    reply
      .type(file.endsWith(".png") ? "image/png" : "application/xml")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .send(await readFile(path));
  });

  app.get<{ Params: { id: string; sid: string } }>("/api/projects/:id/screens/:sid", async (req) => {
    const { id, sid } = req.params;
    const project = await store.get(id);
    const map = await store.map(id);
    const screen = map.screens.find((s) => s.id === sid);
    if (!screen) throw Object.assign(new Error("screen not found"), { statusCode: 404 });
    const observations = await store.filesOf(id).observations();
    const rep = observations.find((o) => o.id === screen.repObs)!;
    const nodes = (await store.nodes(id, rep)) ?? [];
    const elements =
      rep.pkg === project.app.pkg
        ? extractElements(nodes, {
            pkg: project.app.pkg,
            screen: { w: rep.widthPx, h: rep.heightPx },
            listSample: project.config.listSample,
            riskyPatterns: project.config.riskyPatterns,
            scroll: project.config.explore.scroll,
            longPress: project.config.explore.longPress,
            inputs: project.config.explore.inputs,
          })
        : [];
    return {
      screen,
      obs: rep,
      variants: observations.filter((o) => screen.variants.includes(o.id)),
      elements,
      nodes: nodes.map(({ idx, parent, depth, cls, rid, text, desc, bounds, clickable, scrollable, editable, checkable, checked, selected, enabled, pkg }) => ({
        idx, parent, depth, cls, rid, text, desc, bounds, clickable, scrollable, editable, checkable, checked, selected, enabled, pkg,
      })),
      edgesOut: map.edges.filter((e) => e.from === sid),
      edgesIn: map.edges.filter((e) => e.to === sid),
    };
  });

  // ---- manual corrections (overrides) ----------------------------------------

  const withOverrides = async (id: string, fn: (o: Overrides, map: Awaited<ReturnType<ProjectStore["map"]>>) => void) => {
    const o = await store.overrides(id);
    fn(o, await store.map(id));
    await store.saveOverrides(id, o);
    const { clusterer: _c, ...map } = await store.map(id);
    return map;
  };

  app.post<{ Params: { id: string; sid: string }; Body: { name: string } }>("/api/projects/:id/screens/:sid/rename", async (req) =>
    withOverrides(req.params.id, (o) => {
      if (req.body.name?.trim()) o.renames[req.params.sid] = req.body.name.trim();
      else delete o.renames[req.params.sid];
    }),
  );

  app.post<{ Params: { id: string; sid: string }; Body: { hidden: boolean } }>("/api/projects/:id/screens/:sid/hide", async (req) =>
    withOverrides(req.params.id, (o) => {
      o.hidden = o.hidden.filter((h) => h !== req.params.sid);
      if (req.body.hidden) o.hidden.push(req.params.sid);
    }),
  );

  app.post<{ Params: { id: string; sid: string } }>("/api/projects/:id/screens/:sid/start", async (req) =>
    withOverrides(req.params.id, (o) => {
      o.start = req.params.sid;
    }),
  );

  app.post<{ Params: { id: string }; Body: { into: string; ids: string[] } }>("/api/projects/:id/screens/merge", async (req) =>
    withOverrides(req.params.id, (o, map) => {
      for (const sid of req.body.ids) {
        if (sid === req.body.into) continue;
        const s = map.screens.find((x) => x.id === sid);
        for (const obsId of s?.obsIds ?? []) o.assign[obsId] = req.body.into;
      }
    }),
  );

  app.post<{ Params: { id: string; sid: string }; Body: { obsIds: string[] } }>("/api/projects/:id/screens/:sid/split", async (req) =>
    withOverrides(req.params.id, (o) => {
      const key = `u-${newId()}`;
      for (const obsId of req.body.obsIds) o.assign[obsId] = key;
    }),
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/overrides/reset", async (req) =>
    withOverrides(req.params.id, (o) => {
      o.assign = {};
      o.renames = {};
      o.hidden = [];
      o.start = undefined;
    }),
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/insights", async (req) => computeInsights(store, req.params.id));

  registerExportRoutes(app, store);

  // ---- live events -----------------------------------------------------------

  app.get<{ Querystring: { project?: string } }>("/api/ws", { websocket: true }, (socket, req) => {
    const project = req.query.project;
    const listener = (e: CrawlEvent) => {
      if (!project || e.projectId === project) socket.send(JSON.stringify(e));
    };
    jobs.events.on("event", listener);
    socket.on("close", () => jobs.events.off("event", listener));
  });

  // ---- static: dashboard + Penpot plugin --------------------------------------

  if (existsSync(PENPOT_DIST)) {
    // plugin.js runs inside Penpot and needs this server's address to open its UI iframe.
    app.get("/plugins/penpot/plugin.js", async (req, reply) => {
      const code = await readFile(join(PENPOT_DIST, "plugin.js"), "utf8");
      const origin = `${req.protocol}://${req.headers.host ?? "127.0.0.1:4317"}`;
      reply.type("application/javascript").header("Cache-Control", "no-store").send(code.replaceAll("__MAPPY_ORIGIN__", JSON.stringify(origin)));
    });
    await app.register(fastifyStatic, {
      root: PENPOT_DIST,
      prefix: "/plugins/penpot/",
      decorateReply: false,
      allowedPath: (path) => !path.endsWith("plugin.js"),
    });
  }
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: "/", wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async (_req, reply) =>
      reply.type("text/html").send("<p>Mappy API is running. Build the dashboard with <code>npm run build</code>, or run <code>npm run dev:web</code>.</p>"),
    );
  }

  return { app, ctx: context };
}
