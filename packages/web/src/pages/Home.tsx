import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, go, timeAgo, type Project } from "../api.ts";

export const statusBadge = (s: Project["status"]) => {
  const cls = s === "done" ? "ok" : s === "error" ? "bad" : s === "running" ? "accent" : s === "paused" || s === "takeover" ? "warn" : "";
  return <span className={`badge ${cls}`}>{s === "running" && <span className="dot" />} {s}</span>;
};

export function Home() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<Project[]>("/api/projects"), refetchInterval: 4000 });
  const del = useMutation({
    mutationFn: (id: string) => api(`/api/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  return (
    <div className="page">
      <div className="stack" style={{ maxWidth: 1200, margin: "0 auto" }}>
        <div className="section-title">
          <div>
            <h1>Crawls</h1>
            <p className="muted">Each crawl explores one app and builds its screen map, ready to export to Figma, Penpot and more.</p>
          </div>
          <a className="btn primary" href="#/new">
            New crawl
          </a>
        </div>
        <div className="card">
          {projects.data?.length === 0 && (
            <div className="empty stack" style={{ alignItems: "center" }}>
              <h2>No crawls yet</h2>
              <p>Connect a phone (see Device setup) or try the simulated demo phone.</p>
              <a className="btn primary" href="#/new">
                Start a crawl
              </a>
            </div>
          )}
          {!!projects.data?.length && (
            <table>
              <thead>
                <tr>
                  <th>App</th>
                  <th>Device</th>
                  <th>Status</th>
                  <th>Screens</th>
                  <th>Actions</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {projects.data.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => go("p", p.id, p.status === "running" ? "live" : "map")}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.app.label ?? p.app.pkg}</div>
                      <div className="muted small mono">{p.app.pkg}</div>
                    </td>
                    <td className="small">{p.device.model || p.device.serial}</td>
                    <td>{statusBadge(p.status)}</td>
                    <td>{p.stats.screens}</td>
                    <td>{p.stats.actions}</td>
                    <td className="muted small">{timeAgo(p.updatedAt)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="sm ghost danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete the crawl of ${p.app.label ?? p.app.pkg}? Screenshots and the map are removed.`)) del.mutate(p.id);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
