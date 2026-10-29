import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, obsUrl, type CrawlEvent, type ProjectDetail, type Rect } from "../api.ts";

export function Overlay({ bounds, w, h, className = "hotspot focus" }: { bounds: Rect; w: number; h: number; className?: string }) {
  return (
    <div
      className={className}
      style={{ left: `${(bounds.x / w) * 100}%`, top: `${(bounds.y / h) * 100}%`, width: `${(bounds.w / w) * 100}%`, height: `${(bounds.h / h) * 100}%` }}
    />
  );
}

export function LivePanel({ detail, events, onOpenMap }: { detail: ProjectDetail; events: CrawlEvent[]; onOpenMap: () => void }) {
  const qc = useQueryClient();
  const p = detail.project;
  const [err, setErr] = useState<string | null>(null);
  const control = useMutation({
    mutationFn: (op: string) => api(`/api/projects/${p.id}/crawl/${op}`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", p.id] }),
    onError: (e) => setErr(String(e)),
  });
  const answer = useMutation({
    mutationFn: ({ requestId, allow }: { requestId: string; allow: boolean }) => api(`/api/projects/${p.id}/approvals/${requestId}`, { body: { allow } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", p.id] }),
  });

  const lastObs = useMemo(() => [...events].reverse().find((e) => e.type === "observation"), [events]);
  const lastAction = useMemo(() => {
    const iObs = events.lastIndexOf(lastObs!);
    const a = [...events].reverse().find((e) => e.type === "action");
    return a && events.lastIndexOf(a) > iObs ? a : undefined;
  }, [events, lastObs]);
  const stats = [...events].reverse().find((e) => e.type === "stats");
  const logs = [...detail.log, ...events].filter((e): e is Extract<CrawlEvent, { type: "log" }> => e.type === "log");
  const uniqueLogs = logs.filter((l, i) => logs.findIndex((x) => x.ts === l.ts && x.message === l.message) === i).slice(-80);
  const newScreens = events.filter((e): e is Extract<CrawlEvent, { type: "observation" }> => e.type === "observation" && e.isNewScreen);
  const approval = detail.approvals[0];
  const status = p.status;
  const running = detail.running;
  const obs = lastObs?.type === "observation" ? lastObs.obs : null;
  const currentFile = obs?.png ?? (detail.current ? `${detail.current.obs}.png` : null);
  const s = stats?.type === "stats" ? stats.stats : p.stats;

  return (
    <div className="split">
      <div className="scroll" style={{ padding: 24 }}>
        <div className="stack" style={{ maxWidth: 820, margin: "0 auto" }}>
          <div className="row wrap">
            {running ? (
              <>
                {status === "running" ? (
                  <button onClick={() => control.mutate("pause")}>Pause</button>
                ) : (
                  <button className="primary" onClick={() => control.mutate("resume")}>
                    {status === "takeover" ? "Resume (re-sync screen)" : "Resume"}
                  </button>
                )}
                <button onClick={() => control.mutate("takeover")} disabled={status === "takeover"} title="Pause so you can operate the phone yourself (log in, dismiss something); Mappy re-reads the screen when you resume">
                  Take over
                </button>
                <button className="danger" onClick={() => control.mutate("stop")}>
                  Stop
                </button>
              </>
            ) : (
              <>
                <button className="primary" onClick={() => control.mutate("continue")} title="Keep exploring from where the last crawl stopped">
                  Continue crawl
                </button>
                <button onClick={onOpenMap}>Open map</button>
              </>
            )}
            <div className="grow" />
            <span className="muted small">
              {s.screens} screens · {s.actions}/{p.config.maxActions} actions
            </span>
          </div>
          {err && <div className="callout bad small">{err}</div>}
          {status === "takeover" && (
            <div className="callout warn">
              <b>You have control.</b> Use the phone (log in, close a popup, open a hard-to-reach screen), then press <b>Resume</b>. Mappy will record where you ended up and continue from there.
            </div>
          )}
          {p.status === "error" && <div className="callout bad">The crawl stopped with an error: {p.error}</div>}
          <div className="grid-4">
            <div className="card stat">
              <div className="v">{s.screens}</div>
              <div className="l">screens found</div>
            </div>
            <div className="card stat">
              <div className="v">{s.actions}</div>
              <div className="l">actions taken</div>
            </div>
            <div className="card stat">
              <div className="v">{s.observations}</div>
              <div className="l">screenshots</div>
            </div>
            <div className="card stat">
              <div className="v">{newScreens.length}</div>
              <div className="l">new this session</div>
            </div>
          </div>
          <div className="card card-pad stack">
            <h3>Activity</h3>
            <div className="log" style={{ maxHeight: 360, overflow: "auto" }}>
              {uniqueLogs.length === 0 && <span className="muted">Waiting for events…</span>}
              {uniqueLogs.map((l, i) => (
                <div key={i} className={l.level}>
                  <span className="muted">{new Date(l.ts).toLocaleTimeString()}</span> {l.message}
                </div>
              ))}
            </div>
          </div>
          {newScreens.length > 0 && (
            <div className="card card-pad stack">
              <h3>New screens</h3>
              <div className="row wrap" style={{ alignItems: "flex-start" }}>
                {newScreens.slice(-12).map((e) => (
                  <a key={e.obs.id} href={`#/p/${p.id}/map/${e.screenId}`} style={{ width: 96 }}>
                    <img src={obsUrl(p.id, e.obs.png)} alt="" style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)" }} />
                    <div className="muted small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.obs.activity.split(".").pop()}
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <aside className="side" style={{ padding: 20 }}>
        <div className="stack">
          <h3>On the device</h3>
          {currentFile ? (
            <div className="phone" style={{ width: "100%", maxWidth: 360, margin: "0 auto" }}>
              <img src={obsUrl(p.id, currentFile)} alt="Current screen" />
              {lastAction?.type === "action" && lastAction.action.bounds && obs && <Overlay bounds={lastAction.action.bounds} w={obs.widthPx} h={obs.heightPx} />}
            </div>
          ) : (
            <div className="empty">No screenshot yet</div>
          )}
          {lastAction?.type === "action" && (
            <div className="small">
              Next: <b>{lastAction.action.type}</b> “{lastAction.action.label}”
            </div>
          )}
        </div>
      </aside>
      {approval && (
        <div className="modal-backdrop">
          <div className="modal card card-pad stack">
            <h2>Tap a risky element?</h2>
            <p>
              Mappy wants to tap <b>“{approval.element.label}”</b>
              {approval.element.riskReason && (
                <>
                  {" "}
                  (matches <code>{approval.element.riskReason}</code>)
                </>
              )}
              . It could change data on the device or account.
            </p>
            <div className="phone" style={{ width: 240, margin: "0 auto" }}>
              <img src={obsUrl(p.id, `${approval.obsId}.png`)} alt="" />
              <Overlay bounds={approval.element.bounds} w={p.device.widthPx} h={p.device.heightPx} />
            </div>
            <div className="row">
              <div className="grow" />
              <button onClick={() => answer.mutate({ requestId: approval.requestId, allow: false })}>Skip it</button>
              <button className="primary" onClick={() => answer.mutate({ requestId: approval.requestId, allow: true })}>
                Tap it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
