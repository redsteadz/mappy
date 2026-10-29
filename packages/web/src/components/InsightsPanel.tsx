import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, obsUrl, type Insights, type ProjectDetail } from "../api.ts";
import { Overlay } from "./LivePanel.tsx";

const KINDS: Record<string, { label: string; help: string }> = {
  unlabeled: { label: "Unlabeled controls", help: "Icon buttons with no text or content description — invisible to screen readers." },
  tapTarget: { label: "Small tap targets", help: "Touch targets under 48×48dp are hard to hit (Material & WCAG 2.5.8)." },
  contrast: { label: "Low contrast text", help: "Text below WCAG AA contrast (4.5:1, or 3:1 for large text), sampled from pixels." },
  crash: { label: "Crashes", help: "Actions that crashed the app." },
  deep: { label: "Deep screens", help: "Screens that take 4+ taps to reach." },
  deadEnd: { label: "Dead ends", help: "Screens with no way forward except Back." },
  external: { label: "Leaves the app", help: "Actions that open another app (browser, share sheet, store)." },
  orphan: { label: "Hard to reach", help: "Screens only reached via back, restart or manual take-over." },
};

export function InsightsPanel({ projectId }: { projectId: string }) {
  const ins = useQuery({ queryKey: ["insights", projectId], queryFn: () => api<Insights>(`/api/projects/${projectId}/insights`) });
  const project = useQuery({ queryKey: ["project", projectId], queryFn: () => api<ProjectDetail>(`/api/projects/${projectId}`) });
  const [kind, setKind] = useState<string | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  if (ins.isLoading) return <div className="empty">Analysing screens…</div>;
  if (ins.error || !ins.data) return <div className="empty">{String(ins.error)}</div>;
  const { summary, findings } = ins.data;
  const shown = findings.filter((f) => !kind || f.kind === kind);
  const f = focus !== null ? shown[focus] : undefined;
  const device = project.data?.project.device;

  return (
    <div className="split">
      <div className="scroll" style={{ padding: 24 }}>
        <div className="stack" style={{ maxWidth: 900, margin: "0 auto" }}>
          <div className="grid-4">
            <div className="card stat">
              <div className="v">{summary.screens}</div>
              <div className="l">app screens</div>
            </div>
            <div className="card stat">
              <div className="v">{summary.maxDepth}</div>
              <div className="l">deepest screen (taps)</div>
            </div>
            <div className="card stat">
              <div className="v">{summary.avgDepth}</div>
              <div className="l">average depth</div>
            </div>
            <div className="card stat">
              <div className="v">{findings.filter((x) => x.severity === "high").length}</div>
              <div className="l">high-severity findings</div>
            </div>
          </div>
          <div className="row wrap">
            <button className={`sm ${kind === null ? "primary" : ""}`} onClick={() => (setKind(null), setFocus(null))}>
              All ({findings.length})
            </button>
            {Object.entries(KINDS)
              .filter(([k]) => summary.byKind[k])
              .map(([k, v]) => (
                <button key={k} className={`sm ${kind === k ? "primary" : ""}`} onClick={() => (setKind(k), setFocus(null))} title={v.help}>
                  {v.label} ({summary.byKind[k]})
                </button>
              ))}
          </div>
          {kind && <p className="muted small" style={{ margin: 0 }}>{KINDS[kind]?.help}</p>}
          <div className="card">
            {shown.length === 0 && <div className="empty">No findings 🎉</div>}
            <table>
              <tbody>
                {shown.map((x, i) => (
                  <tr key={i} className="clickable" onClick={() => setFocus(i)} style={focus === i ? { background: "var(--accent-soft)" } : undefined}>
                    <td style={{ width: 80 }}>
                      <span className={`badge ${x.severity === "high" ? "bad" : x.severity === "medium" ? "warn" : ""}`}>{x.severity}</span>
                    </td>
                    <td>
                      <div>{x.message}</div>
                      <div className="muted small">
                        {KINDS[x.kind]?.label ?? x.kind} · <a href={`#/p/${projectId}/map/${x.screenId}`}>{x.screenName}</a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <aside className="side" style={{ padding: 20 }}>
        {f?.obsId && device ? (
          <div className="stack">
            <h3>{f.screenName}</h3>
            <div className="phone" style={{ width: "100%", maxWidth: 340, margin: "0 auto" }}>
              <img src={obsUrl(projectId, `${f.obsId}.png`)} alt="" />
              {f.bounds && <Overlay bounds={f.bounds} w={device.widthPx} h={device.heightPx} />}
            </div>
            <p className="small">{f.message}</p>
          </div>
        ) : (
          <div className="empty">Select a finding to see it on the screen.</div>
        )}
      </aside>
    </div>
  );
}
