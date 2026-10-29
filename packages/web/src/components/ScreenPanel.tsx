import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, go, obsUrl, type ScreenDetail, type ScreenSummary } from "../api.ts";

const ROLE_LABEL: Record<string, string> = { nav: "nav", tab: "tab", menu: "menu", button: "button", listItem: "list item", input: "input", toggle: "toggle", scroll: "scroll", other: "tap" };

export function ScreenPanel({ projectId, screenId, screens, startScreen }: { projectId: string; screenId: string; screens: ScreenSummary[]; startScreen: string | null }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["screen", projectId, screenId], queryFn: () => api<ScreenDetail>(`/api/projects/${projectId}/screens/${screenId}`) });
  const [name, setName] = useState("");
  const [splitSel, setSplitSel] = useState<string[]>([]);
  const [tab, setTab] = useState<"links" | "elements" | "shots">("links");
  useEffect(() => {
    if (detail.data) setName(detail.data.screen.name);
    setSplitSel([]);
  }, [detail.data]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["map", projectId] });
    qc.invalidateQueries({ queryKey: ["screen", projectId] });
  };
  const mut = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api(`/api/projects/${projectId}/screens/${path}`, { body }),
    onSuccess: refresh,
  });

  if (detail.isLoading) return <div className="empty">Loading screen…</div>;
  if (detail.error || !detail.data) return <div className="empty">{String(detail.error ?? "Screen not found")}</div>;
  const d = detail.data;
  const s = d.screen;
  const nameOf = (id: string) => screens.find((x) => x.id === id)?.name ?? id;
  const hotspots = d.edgesOut.filter((e) => e.bounds && e.to !== e.from && !["back", "scroll", "input", "restart", "launch", "manual"].includes(e.actionType));

  return (
    <div className="stack" style={{ padding: 18 }}>
      <div className="row">
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Screen name" />
        <button className="sm" disabled={name === s.name} onClick={() => mut.mutate({ path: `${screenId}/rename`, body: { name } })}>
          Rename
        </button>
        <button className="sm ghost" onClick={() => go("p", projectId, "map")} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="row wrap small">
        <span className={`badge ${s.kind === "app" ? "accent" : "warn"}`}>{s.kind}</span>
        {s.depth !== null && <span className="badge">{s.depth} taps from launch</span>}
        {screenId === startScreen && <span className="badge ok">★ launch screen</span>}
        <span className="muted mono" title={s.activity}>
          {s.activity.split(".").pop()}
        </span>
      </div>
      <div className="phone" style={{ width: "100%", maxWidth: 340, margin: "0 auto" }}>
        <img src={obsUrl(projectId, d.obs.png)} alt={s.name} />
        {hotspots.map((e) => (
          <div
            key={e.id}
            className={`hotspot ${e.outcome === "external" ? "external" : ""}`}
            style={{
              left: `${(e.bounds!.x / d.obs.widthPx) * 100}%`,
              top: `${(e.bounds!.y / d.obs.heightPx) * 100}%`,
              width: `${(e.bounds!.w / d.obs.widthPx) * 100}%`,
              height: `${(e.bounds!.h / d.obs.heightPx) * 100}%`,
            }}
            onClick={() => go("p", projectId, "map", e.to)}
          >
            <span className="tip">→ {nameOf(e.to)}</span>
          </div>
        ))}
      </div>
      <p className="muted small" style={{ textAlign: "center", margin: 0 }}>
        Outlined areas are taps Mappy followed. Click one to jump to where it leads.
      </p>
      <div className="row wrap">
        <button className="sm" disabled={screenId === startScreen} onClick={() => mut.mutate({ path: `${screenId}/start`, body: {} })}>
          Make launch screen
        </button>
        <button className="sm" onClick={() => mut.mutate({ path: `${screenId}/hide`, body: { hidden: !s.hidden } })}>
          {s.hidden ? "Unhide" : "Hide from exports"}
        </button>
        <a className="btn sm" href={`/api/projects/${projectId}/export/screen/${screenId}`}>
          Editable SVG
        </a>
      </div>

      <div className="tabs" style={{ padding: 0, background: "transparent" }}>
        {(["links", "elements", "shots"] as const).map((t) => (
          <a key={t} href="#" className={tab === t ? "active" : ""} onClick={(e) => (e.preventDefault(), setTab(t))}>
            {t === "links" ? `Links (${d.edgesOut.length + d.edgesIn.length})` : t === "elements" ? `Elements (${d.elements.length})` : `Captures (${s.obsIds.length})`}
          </a>
        ))}
      </div>

      {tab === "links" && (
        <div className="stack" style={{ gap: 6 }}>
          <h3>Leads to</h3>
          {d.edgesOut.filter((e) => e.to !== e.from).length === 0 && <span className="muted small">Nothing — a dead end.</span>}
          {d.edgesOut
            .filter((e) => e.to !== e.from)
            .map((e) => (
              <a key={e.id} href={`#/p/${projectId}/map/${e.to}`} className="small">
                <span className="badge">{e.actionType}</span> “{e.label}” → <b>{nameOf(e.to)}</b> {e.outcome !== "navigate" && <span className="badge warn">{e.outcome}</span>}
              </a>
            ))}
          <h3 style={{ marginTop: 10 }}>Reached from</h3>
          {d.edgesIn
            .filter((e) => e.to !== e.from)
            .map((e) => (
              <a key={e.id} href={`#/p/${projectId}/map/${e.from}`} className="small">
                <b>{nameOf(e.from)}</b> → <span className="badge">{e.actionType}</span> “{e.label}”
              </a>
            ))}
          {d.edgesOut.some((e) => e.to === e.from) && (
            <>
              <h3 style={{ marginTop: 10 }}>Stays on this screen</h3>
              <div className="small muted">
                {d.edgesOut
                  .filter((e) => e.to === e.from)
                  .map((e) => `“${e.label}”`)
                  .join(", ")}
              </div>
            </>
          )}
        </div>
      )}

      {tab === "elements" && (
        <table className="small">
          <tbody>
            {d.elements.map((el) => (
              <tr key={el.key}>
                <td>
                  <span className={`badge ${el.risky ? "bad" : ""}`}>{el.risky ? "risky" : ROLE_LABEL[el.role] ?? el.role}</span>
                </td>
                <td>
                  <div>{el.label}</div>
                  <div className="muted mono" style={{ fontSize: 11 }}>
                    {el.cls.split(".").pop()} {el.rid && `· ${el.rid.split("/").pop()}`}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "shots" && (
        <div className="stack">
          <p className="muted small" style={{ margin: 0 }}>
            Every capture Mappy grouped into this screen. If some belong to a different screen, select them and split.
          </p>
          <div className="row wrap" style={{ alignItems: "flex-start" }}>
            {s.obsIds.slice(0, 40).map((oid) => (
              <label key={oid} style={{ width: 84, position: "relative", cursor: "pointer" }}>
                <img src={obsUrl(projectId, `${oid}.png`)} alt="" loading="lazy" style={{ width: "100%", borderRadius: 6, border: `2px solid ${splitSel.includes(oid) ? "var(--accent)" : "var(--border)"}` }} />
                <input
                  type="checkbox"
                  style={{ position: "absolute", top: 4, left: 4, height: "auto" }}
                  checked={splitSel.includes(oid)}
                  onChange={() => setSplitSel((sel) => (sel.includes(oid) ? sel.filter((x) => x !== oid) : [...sel, oid]))}
                />
                {s.variants.includes(oid) && <span className="badge accent" style={{ position: "absolute", bottom: 4, left: 4, fontSize: 10 }}>variant</span>}
              </label>
            ))}
          </div>
          <button className="sm" disabled={!splitSel.length || splitSel.length === s.obsIds.length} onClick={() => mut.mutate({ path: `${screenId}/split`, body: { obsIds: splitSel } })}>
            Split {splitSel.length || ""} into a new screen
          </button>
        </div>
      )}
      {mut.error && <div className="callout bad small">{String(mut.error)}</div>}
    </div>
  );
}
