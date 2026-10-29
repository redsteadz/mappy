#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { bundleZip, flowSvg, posterPdf, posterPng, svgZip, toMermaid } from "@mappy/engine";
import { createApp } from "./app.ts";
import { Devices } from "./devices.ts";
import { getIR } from "./exports.ts";
import { CrawlManager } from "./jobs.ts";
import { ProjectStore } from "./store.ts";

const HELP = `mappy — crawl an Android app's UI and export its UX map

Usage:
  mappy [serve] [--port 4317] [--host 127.0.0.1] [--no-open]   Start the dashboard
  mappy crawl --device <serial|demo> --package <pkg> [--config cfg.json] [--max-actions N]
  mappy projects                                               List crawls
  mappy export <projectId> --format <fmt> [--out file]         fmt: json | mermaid | svg | flow.svg | poster.png | poster.pdf | bundle
  mappy figma-plan <projectId> [--out dir] [--max-chars N] [--finish]  use_figma scripts for pushing to Figma via Claude Code + Figma MCP
  mappy figma-upload <projectId> --batch N --urls urls-N.json  POST image PNGs to upload_assets URLs

Data lives in ~/.local/share/mappy (override with MAPPY_HOME).`;

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string", default: process.env.MAPPY_PORT ?? "4317" },
      host: { type: "string", default: "127.0.0.1" },
      "no-open": { type: "boolean", default: false },
      device: { type: "string" },
      package: { type: "string" },
      config: { type: "string" },
      "max-actions": { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      urls: { type: "string" },
      batch: { type: "string" },
      dir: { type: "string" },
      finish: { type: "boolean", default: false },
      "max-chars": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd = "serve", ...rest] = positionals;
  if (values.help || cmd === "help") return console.log(HELP);
  const store = new ProjectStore();

  switch (cmd) {
    case "serve": {
      const { app, ctx } = await createApp({ store });
      const port = Number(values.port);
      await app.listen({ port, host: values.host });
      const url = `http://${values.host === "0.0.0.0" ? "127.0.0.1" : values.host}:${port}`;
      console.log(`Mappy dashboard: ${url}`);
      console.log(`Penpot plugin:   ${url}/plugins/penpot/manifest.json`);
      if (!values["no-open"]) openBrowser(url);
      const shutdown = async () => {
        console.log("\nStopping crawls and restoring device settings…");
        await ctx.jobs.stopAll();
        await app.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "crawl": {
      if (!values.device || !values.package) throw new Error("crawl needs --device and --package");
      const devices = new Devices();
      const driver = devices.driver(values.device);
      const config = values.config ? JSON.parse(readFileSync(values.config, "utf8")) : {};
      if (values["max-actions"]) config.maxActions = Number(values["max-actions"]);
      if (!config.riskyPolicy || config.riskyPolicy === "ask") config.riskyPolicy = "skip"; // nobody to ask headless
      const apps = await driver.listApps({ includeSystem: true });
      const project = await store.create({ ...(await driver.info()), serial: values.device }, apps.find((a) => a.pkg === values.package) ?? { pkg: values.package }, config);
      const jobs = new CrawlManager(store, devices);
      jobs.events.on("event", (e) => {
        if (e.type === "log") console.log(`[${e.level}] ${e.message}`);
        if (e.type === "observation" && e.isNewScreen) console.log(`  + new screen ${e.screenId} (${e.obs.activity})`);
      });
      process.on("SIGINT", () => jobs.control(project.id, "stop"));
      await jobs.start(project.id, { resume: false });
      await jobs.waitFor(project.id);
      const done = await store.get(project.id);
      console.log(`\nProject ${done.id}: ${done.status}, ${done.stats.screens} screens, ${done.stats.actions} actions`);
      return;
    }
    case "projects": {
      for (const p of await store.list()) console.log(`${p.id}  ${p.status.padEnd(8)} ${String(p.stats.screens).padStart(3)} screens  ${p.name}`);
      return;
    }
    case "export": {
      const id = rest[0];
      if (!id || !values.format) throw new Error("export needs <projectId> and --format");
      const project = await store.get(id);
      const base = (project.app.label ?? project.app.pkg).replace(/[^\w-]+/g, "_");
      let body: Buffer | string;
      let ext: string;
      if (values.format === "mermaid") {
        body = toMermaid(await store.map(id));
        ext = "mmd";
      } else {
        const { ir, asset } = await getIR(store, id);
        const f = values.format;
        if (f === "json") [body, ext] = [JSON.stringify(ir, null, 2), "ir.json"];
        else if (f === "svg") [body, ext] = [svgZip(ir, asset), "svg.zip"];
        else if (f === "flow.svg") [body, ext] = [flowSvg(ir, asset), "flow.svg"];
        else if (f === "poster.png") [body, ext] = [posterPng(ir, asset), "poster.png"];
        else if (f === "poster.pdf") [body, ext] = [await posterPdf(ir, asset), "poster.pdf"];
        else if (f === "bundle") [body, ext] = [bundleZip(ir, asset), "mappy.zip"];
        else throw new Error(`unknown format ${f}`);
      }
      const out = values.out ?? `${base}.${ext}`;
      writeFileSync(out, body);
      console.log(`Wrote ${out}`);
      return;
    }
    case "figma-plan":
    case "figma-upload": {
      const { figmaCommand } = await import("./figma.ts");
      await figmaCommand(cmd, rest, values, store);
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`mappy: ${(err as Error).message}`);
  process.exit(1);
});
