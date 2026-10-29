import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CrawlConfig,
  newId,
  Observation,
  Overrides,
  Project,
  Transition,
  type AppInfo,
  type CrawlConfigInput,
  type CrawlMap,
  type DeviceInfo,
  type UiNode,
} from "@mappy/shared";
import { buildMap, computeSignature, emptyCrawlState, parseHierarchy, type CrawlState, type CrawlStore, type ScreenClusterer, type Signature } from "@mappy/engine";

export const dataDir = () => process.env.MAPPY_HOME ?? join(homedir(), ".local", "share", "mappy");

async function readJsonl<T>(file: string, parse: (v: unknown) => T): Promise<T[]> {
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(parse(JSON.parse(line)));
    } catch {
      // A crash mid-write can leave a truncated last line; skip it.
    }
  }
  return out;
}

/** One project = one crawl of one app, stored as plain files. */
export class ProjectFiles implements CrawlStore {
  readonly dir: string;
  private obsCache: Observation[] | null = null;
  private transCache: Transition[] | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  get obsDir() {
    return join(this.dir, "obs");
  }

  async saveObservation(obs: Observation, png: Buffer, xml: string | null): Promise<void> {
    await mkdir(this.obsDir, { recursive: true });
    await writeFile(join(this.obsDir, obs.png), png);
    if (xml && obs.xml) await writeFile(join(this.obsDir, obs.xml), xml);
    await appendFile(join(this.dir, "observations.jsonl"), JSON.stringify(obs) + "\n");
    this.obsCache?.push(obs);
  }

  async saveTransition(t: Transition): Promise<void> {
    await appendFile(join(this.dir, "transitions.jsonl"), JSON.stringify(t) + "\n");
    this.transCache?.push(t);
  }

  async saveState(state: CrawlState): Promise<void> {
    await writeFile(join(this.dir, "state.json"), JSON.stringify(state));
  }

  async observations(): Promise<Observation[]> {
    this.obsCache ??= await readJsonl(join(this.dir, "observations.jsonl"), (v) => Observation.parse(v));
    return this.obsCache;
  }

  async transitions(): Promise<Transition[]> {
    this.transCache ??= await readJsonl(join(this.dir, "transitions.jsonl"), (v) => Transition.parse(v));
    return this.transCache;
  }

  async load() {
    const stateFile = join(this.dir, "state.json");
    const state: CrawlState = existsSync(stateFile) ? { ...emptyCrawlState(), ...JSON.parse(await readFile(stateFile, "utf8")) } : emptyCrawlState();
    return { observations: [...(await this.observations())], transitions: [...(await this.transitions())], state };
  }

  async readXml(obs: Observation): Promise<string | null> {
    if (!obs.xml) return null;
    const f = join(this.obsDir, obs.xml);
    return existsSync(f) ? readFile(f, "utf8") : null;
  }

  async readPng(obs: Observation): Promise<Buffer | null> {
    const f = join(this.obsDir, obs.png);
    return existsSync(f) ? readFile(f) : null;
  }
}

export interface LoadedMap extends CrawlMap {
  clusterer: ScreenClusterer;
}

export class ProjectStore {
  readonly root: string;
  private files = new Map<string, ProjectFiles>();
  private sigCache = new Map<string, Signature>();
  private nodeCache = new Map<string, UiNode[] | null>();

  constructor(root = join(dataDir(), "projects")) {
    this.root = root;
  }

  dirOf(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("invalid project id");
    return join(this.root, id);
  }

  filesOf(id: string): ProjectFiles {
    let f = this.files.get(id);
    if (!f) {
      f = new ProjectFiles(this.dirOf(id));
      this.files.set(id, f);
    }
    return f;
  }

  async list(): Promise<Project[]> {
    if (!existsSync(this.root)) return [];
    const ids = await readdir(this.root);
    const out: Project[] = [];
    for (const id of ids) {
      const p = await this.get(id).catch(() => null);
      if (p) out.push(p);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Project> {
    return Project.parse(JSON.parse(await readFile(join(this.dirOf(id), "project.json"), "utf8")));
  }

  async create(device: DeviceInfo, app: AppInfo, config: CrawlConfigInput, name?: string): Promise<Project> {
    const id = newId("p");
    const now = Date.now();
    const project: Project = Project.parse({
      id,
      name: name ?? `${app.label ?? app.pkg} — ${new Date(now).toLocaleString()}`,
      createdAt: now,
      updatedAt: now,
      device,
      app,
      config: CrawlConfig.parse(config),
      status: "idle",
    });
    await mkdir(join(this.dirOf(id), "obs"), { recursive: true });
    await this.save(project);
    return project;
  }

  async save(p: Project): Promise<void> {
    await writeFile(join(this.dirOf(p.id), "project.json"), JSON.stringify(p, null, 2));
  }

  private updateQueues = new Map<string, Promise<unknown>>();

  /** Read-modify-write of project.json, serialised per project so concurrent updates can't interleave. */
  update(id: string, patch: Partial<Project>): Promise<Project> {
    const prev = this.updateQueues.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const p = { ...(await this.get(id)), ...patch, updatedAt: Date.now() };
        await this.save(p);
        return p;
      });
    this.updateQueues.set(id, next);
    void next.finally(() => {
      if (this.updateQueues.get(id) === next) this.updateQueues.delete(id);
    }).catch(() => {});
    return next;
  }

  async remove(id: string): Promise<void> {
    await rm(this.dirOf(id), { recursive: true, force: true });
    this.files.delete(id);
  }

  async overrides(id: string): Promise<Overrides> {
    const f = join(this.dirOf(id), "overrides.json");
    return Overrides.parse(existsSync(f) ? JSON.parse(await readFile(f, "utf8")) : {});
  }

  async saveOverrides(id: string, o: Overrides): Promise<void> {
    await writeFile(join(this.dirOf(id), "overrides.json"), JSON.stringify(Overrides.parse(o), null, 2));
  }

  async nodes(id: string, obs: Observation): Promise<UiNode[] | null> {
    const k = `${id}/${obs.id}`;
    if (!this.nodeCache.has(k)) {
      const xml = await this.filesOf(id).readXml(obs);
      this.nodeCache.set(k, xml ? parseHierarchy(xml) : null);
      if (this.nodeCache.size > 2000) this.nodeCache.delete(this.nodeCache.keys().next().value!);
    }
    return this.nodeCache.get(k)!;
  }

  /** Rebuild the screen map from the event log; signatures are cached since observations are immutable. */
  async map(id: string): Promise<LoadedMap> {
    const project = await this.get(id);
    const files = this.filesOf(id);
    const observations = await files.observations();
    const transitions = await files.transitions();
    const overrides = await this.overrides(id);
    const sigs = new Map<string, Signature>();
    for (const o of observations) {
      const k = `${id}/${o.id}`;
      let s = this.sigCache.get(k);
      if (!s) {
        s = computeSignature(o, await this.nodes(id, o));
        this.sigCache.set(k, s);
      }
      sigs.set(o.id, s);
    }
    return buildMap({
      projectId: id,
      appPkg: project.app.pkg,
      threshold: project.config.similarity,
      observations,
      transitions,
      overrides,
      signature: (o) => sigs.get(o.id)!,
    });
  }
}
