import type { Observation, Transition } from "@mappy/shared";

/** Crawl progress that isn't derivable from observations/transitions alone. */
export interface CrawlState {
  /** screenKey → element keys already tried (or deliberately skipped). */
  explored: Record<string, string[]>;
  skipped: Record<string, string[]>;
  scrolls: Record<string, number>;
  unreachable: string[];
  backTried: string[];
}

export const emptyCrawlState = (): CrawlState => ({ explored: {}, skipped: {}, scrolls: {}, unreachable: [], backTried: [] });

/** Persistence the crawler writes through. The server implements it on disk; tests use memory. */
export interface CrawlStore {
  saveObservation(obs: Observation, png: Buffer, xml: string | null): Promise<void>;
  saveTransition(t: Transition): Promise<void>;
  saveState(state: CrawlState): Promise<void>;
  load(): Promise<{ observations: Observation[]; transitions: Transition[]; state: CrawlState }>;
  readXml(obs: Observation): Promise<string | null>;
  readPng(obs: Observation): Promise<Buffer | null>;
}

export class MemoryStore implements CrawlStore {
  observations: Observation[] = [];
  transitions: Transition[] = [];
  state: CrawlState = emptyCrawlState();
  pngs = new Map<string, Buffer>();
  xmls = new Map<string, string | null>();

  async saveObservation(obs: Observation, png: Buffer, xml: string | null) {
    this.observations.push(obs);
    this.pngs.set(obs.id, png);
    this.xmls.set(obs.id, xml);
  }
  async saveTransition(t: Transition) {
    this.transitions.push(t);
  }
  async saveState(state: CrawlState) {
    this.state = structuredClone(state);
  }
  async load() {
    return { observations: [...this.observations], transitions: [...this.transitions], state: structuredClone(this.state) };
  }
  async readXml(obs: Observation) {
    return this.xmls.get(obs.id) ?? null;
  }
  async readPng(obs: Observation) {
    return this.pngs.get(obs.id) ?? null;
  }
}
