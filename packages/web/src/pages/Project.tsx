import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, go, useLiveEvents, type CrawlEvent, type ProjectDetail } from "../api.ts";
import { ExportPanel } from "../components/ExportPanel.tsx";
import { InsightsPanel } from "../components/InsightsPanel.tsx";
import { LivePanel } from "../components/LivePanel.tsx";
import { MapView } from "../components/MapView.tsx";
import { statusBadge } from "./Home.tsx";

const TABS = [
  ["live", "Live"],
  ["map", "Map"],
  ["insights", "Insights"],
  ["export", "Export"],
] as const;

export function ProjectPage({ id, tab, screen }: { id: string; tab: string; screen?: string }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["project", id], queryFn: () => api<ProjectDetail>(`/api/projects/${id}`), refetchInterval: (q) => (q.state.data?.running ? 3000 : false) });
  const [events, setEvents] = useState<CrawlEvent[]>([]);
  const invalidate = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEvent = useCallback(
    (e: CrawlEvent) => {
      setEvents((prev) => [...prev.slice(-400), e]);
      if (e.type === "status" || e.type === "approval" || e.type === "approvalResolved") qc.invalidateQueries({ queryKey: ["project", id] });
      if (e.type === "observation" || e.type === "transition" || e.type === "status") {
        // Coalesce map refreshes while the crawl streams events.
        if (!invalidate.current) {
          invalidate.current = setTimeout(() => {
            invalidate.current = null;
            qc.invalidateQueries({ queryKey: ["map", id] });
            qc.invalidateQueries({ queryKey: ["insights", id] });
          }, 1200);
        }
      }
    },
    [id, qc],
  );
  const connected = useLiveEvents(id, onEvent);
  useEffect(() => () => void (invalidate.current && clearTimeout(invalidate.current)), []);

  const p = detail.data?.project;
  if (detail.error) return <div className="empty">{String(detail.error)}</div>;
  if (!p) return <div className="empty">Loading…</div>;
  return (
    <div className="project-shell">
      <div className="project-head">
        <div className="grow">
          <div className="row">
            <h1>{p.app.label ?? p.app.pkg}</h1>
            {statusBadge(p.status)}
            {detail.data?.running && !connected && <span className="badge warn">reconnecting…</span>}
          </div>
          <div className="muted small">
            <span className="mono">{p.app.pkg}</span> · {p.device.model || p.device.serial} · {p.stats.screens} screens · {p.stats.actions} actions
          </div>
        </div>
      </div>
      <nav className="tabs">
        {TABS.map(([key, label]) => (
          <a key={key} href={`#/p/${id}/${key}`} className={tab === key ? "active" : ""}>
            {label}
          </a>
        ))}
      </nav>
      <div className="project-body">
        {tab === "live" && <LivePanel detail={detail.data!} events={events} onOpenMap={() => go("p", id, "map")} />}
        {tab === "map" && <MapView projectId={id} selected={screen} current={detail.data?.running ? detail.data.current?.screen : undefined} />}
        {tab === "insights" && <InsightsPanel projectId={id} />}
        {tab === "export" && <ExportPanel project={p} />}
      </div>
    </div>
  );
}
