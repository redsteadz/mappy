import { useEffect, useRef, useState } from "react";
import type { AppInfo, CrawlEvent, CrawlMap, Observation, Project, ScreenSummary, MapEdge, UiElement, Rect } from "@mappy/shared";

export type { AppInfo, CrawlEvent, CrawlMap, Observation, Project, ScreenSummary, MapEdge, UiElement, Rect };

export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export interface DeviceEntry {
  serial: string;
  state: string;
  model: string;
  product: string;
  kind: "adb" | "demo";
}

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface ProjectDetail {
  project: Project;
  running: boolean;
  current: { screen: string; obs: string } | null;
  approvals: { requestId: string; projectId: string; element: UiElement; screenId: string; obsId: string }[];
  log: CrawlEvent[];
}

export interface MapWithLayout extends CrawlMap {
  layout?: { positions: Record<string, { x: number; y: number }>; nodeWidth: number; nodeHeight: number; forward: string[] };
}

export interface NodeLite {
  idx: number;
  parent: number | null;
  depth: number;
  cls: string;
  rid: string;
  text: string;
  desc: string;
  bounds: Rect;
  clickable: boolean;
  scrollable: boolean;
  editable: boolean;
  checkable: boolean;
  checked: boolean;
  selected: boolean;
  enabled: boolean;
  pkg: string;
}

export interface ScreenDetail {
  screen: ScreenSummary;
  obs: Observation;
  variants: Observation[];
  elements: UiElement[];
  nodes: NodeLite[];
  edgesOut: MapEdge[];
  edgesIn: MapEdge[];
}

export interface Finding {
  kind: string;
  severity: "high" | "medium" | "low";
  screenId: string;
  screenName: string;
  message: string;
  bounds?: Rect;
  obsId?: string;
}

export interface Insights {
  summary: { screens: number; maxDepth: number; avgDepth: number; byKind: Record<string, number> };
  findings: Finding[];
}

export const obsUrl = (projectId: string, file: string) => `/api/projects/${projectId}/obs/${file}`;

/** Subscribe to live crawl events for a project. */
export function useLiveEvents(projectId: string | undefined, onEvent: (e: CrawlEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/ws?project=${encodeURIComponent(projectId)}`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (m) => handler.current(JSON.parse(m.data));
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [projectId]);
  return connected;
}

/** Tiny hash router: #/path/segments */
export function useRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (...parts: string[]) => {
  location.hash = "#/" + parts.map(encodeURIComponent).join("/");
};

export const timeAgo = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
};
