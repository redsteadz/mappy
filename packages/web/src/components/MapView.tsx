import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { memo, useMemo, useState } from "react";
import { api, go, obsUrl, type MapWithLayout, type ScreenSummary } from "../api.ts";
import { ScreenPanel } from "./ScreenPanel.tsx";

type ScreenNodeData = { screen: ScreenSummary; projectId: string; selected: boolean; multi: boolean; current: boolean; isStart: boolean };

const ScreenNode = memo(function ScreenNode({ data }: NodeProps<Node<ScreenNodeData>>) {
  const s = data.screen;
  const cls = ["screen-node", data.selected && "selected", data.multi && "multi", data.current && "current", s.kind !== "app" && "foreign"].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="title" title={`${s.name}\n${s.activity}`}>
        {data.isStart && <span title="Launch screen">★</span>}
        <span className="name">{s.name}</span>
        <span className="grow" />
        {s.depth !== null && <span className="badge">{s.depth}</span>}
      </div>
      <img src={obsUrl(data.projectId, `${s.repObs}.png`)} alt="" loading="lazy" draggable={false} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
});

const nodeTypes = { screen: ScreenNode };

export function MapView({ projectId, selected, current }: { projectId: string; selected?: string; current?: string }) {
  const qc = useQueryClient();
  const map = useQuery({ queryKey: ["map", projectId], queryFn: () => api<MapWithLayout>(`/api/projects/${projectId}/map?layout=1`) });
  const [showReturns, setShowReturns] = useState(false);
  const [showForeign, setShowForeign] = useState(true);
  const [multi, setMulti] = useState<string[]>([]);

  const merge = useMutation({
    mutationFn: () => api(`/api/projects/${projectId}/screens/merge`, { body: { into: multi[0], ids: multi } }),
    onSuccess: () => {
      setMulti([]);
      qc.invalidateQueries({ queryKey: ["map", projectId] });
      go("p", projectId, "map", multi[0]);
    },
  });
  const reset = useMutation({
    mutationFn: () => api(`/api/projects/${projectId}/overrides/reset`, { body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["map", projectId] }),
  });

  const { nodes, edges } = useMemo(() => {
    const m = map.data;
    if (!m?.layout) return { nodes: [] as Node<ScreenNodeData>[], edges: [] as Edge[] };
    const visible = m.screens.filter((s) => !s.hidden && (showForeign || s.kind === "app"));
    const ids = new Set(visible.map((s) => s.id));
    const forward = new Set(m.layout.forward);
    const nodes: Node<ScreenNodeData>[] = visible.map((s) => ({
      id: s.id,
      type: "screen",
      position: m.layout!.positions[s.id] ?? { x: 0, y: 0 },
      data: { screen: s, projectId, selected: s.id === selected, multi: multi.includes(s.id), current: s.id === current, isStart: s.id === m.startScreen },
    }));
    const seen = new Set<string>();
    const edges: Edge[] = [];
    for (const e of m.edges) {
      if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
      const isForward = forward.has(e.id);
      if (!isForward && !showReturns) continue;
      if (!isForward && ["restart", "launch", "manual", "scroll", "input"].includes(e.actionType)) continue;
      const key = `${e.from}>${e.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const color = e.outcome === "crash" ? "var(--bad)" : e.outcome === "external" ? "var(--warn)" : isForward ? "var(--accent)" : "var(--muted)";
      edges.push({
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.label.length > 24 ? e.label.slice(0, 23) + "…" : e.label,
        animated: e.from === current,
        style: { stroke: color, strokeWidth: isForward ? 2 : 1, strokeDasharray: isForward ? undefined : "5 4" },
        type: "smoothstep",
      });
    }
    return { nodes, edges };
  }, [map.data, projectId, selected, multi, current, showReturns, showForeign]);

  if (map.isLoading) return <div className="empty">Building the map…</div>;
  if (map.error) return <div className="empty">{String(map.error)}</div>;
  if (!map.data?.screens.length) return <div className="empty">No screens yet — start or continue the crawl.</div>;

  return (
    <div className={selected ? "split" : ""} style={{ height: "100%" }}>
      <div style={{ position: "relative", height: "100%", minHeight: 0 }}>
        <div className="card row wrap" style={{ position: "absolute", zIndex: 5, top: 12, left: 12, padding: "8px 12px", gap: 16 }}>
          <label className="check small">
            <input type="checkbox" checked={showReturns} onChange={(e) => setShowReturns(e.target.checked)} /> Return &amp; back links
          </label>
          <label className="check small">
            <input type="checkbox" checked={showForeign} onChange={(e) => setShowForeign(e.target.checked)} /> Other apps &amp; system
          </label>
          {multi.length >= 2 ? (
            <button className="sm primary" onClick={() => merge.mutate()}>
              Merge {multi.length} screens
            </button>
          ) : (
            <span className="muted small">Shift-click screens to merge duplicates</span>
          )}
          {multi.length > 0 && (
            <button className="sm ghost" onClick={() => setMulti([])}>
              Clear
            </button>
          )}
          <button className="sm ghost" onClick={() => confirm("Undo all renames, merges, splits and hidden screens?") && reset.mutate()}>
            Reset corrections
          </button>
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.05}
          maxZoom={2}
          nodesDraggable
          onNodeClick={(ev, n) => {
            if (ev.shiftKey) setMulti((m) => (m.includes(n.id) ? m.filter((x) => x !== n.id) : [...m, n.id]));
            else go("p", projectId, "map", n.id);
          }}
          onPaneClick={() => selected && go("p", projectId, "map")}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => ((n.data as ScreenNodeData).screen.kind === "app" ? "#4f5bd5" : "#e0a040")} />
        </ReactFlow>
      </div>
      {selected && (
        <aside className="side">
          <ScreenPanel projectId={projectId} screenId={selected} screens={map.data.screens} startScreen={map.data.startScreen} />
        </aside>
      )}
    </div>
  );
}
