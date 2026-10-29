import { useState } from "react";
import type { Project } from "../api.ts";

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy">
      <code>{text}</code>
      <button
        className="sm"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function ExportPanel({ project }: { project: Project }) {
  const base = `/api/projects/${project.id}/export`;
  const origin = location.origin.includes(":5173") ? "http://127.0.0.1:4317" : location.origin;
  const dl = (fmt: string, label: string, primary = false) => (
    <a className={`btn ${primary ? "primary" : ""}`} href={`${base}/${fmt}`}>
      {label}
    </a>
  );
  return (
    <div className="page">
      <div className="page-narrow stack">
        <p className="muted" style={{ margin: 0 }}>
          Exports rebuild every screen as editable layers (frames, live text in Roboto, image crops for icons and pictures). The first export of a big crawl can take a moment.
        </p>

        <div className="card card-pad stack">
          <div className="section-title">
            <h2>Figma</h2>
            <span className="badge accent">recommended: Claude Code push</span>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <h3>A. Push the whole flow with Claude Code + the Figma connector</h3>
            <p className="small muted" style={{ margin: 0 }}>
              Builds a Figma file with one frame per screen rebuilt as editable layers, arrows between screens, clickable prototype links from every hotspot, an inventory page of interactive elements, and a page of the original captures. Works with Figma in the browser on Linux. In Claude Code, inside the Mappy folder, run:
            </p>
            <Copy text={`/mappy-figma-export ${project.id}`} />
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <h3>B. Drag SVGs into Figma (no plugin)</h3>
            <p className="small muted" style={{ margin: 0 }}>Each screen becomes editable vector + text layers. You get no prototype links this way.</p>
            <div className="row wrap">
              {dl("svg", "Download SVG pack (.zip)")}
              {dl("flow.svg", "Whole flow (.svg)")}
            </div>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <h3>C. Mappy Figma plugin (Figma desktop app)</h3>
            <p className="small muted" style={{ margin: 0 }}>
              On macOS/Windows (or figma-linux), import <code>packages/figma-plugin/manifest.json</code> via Plugins → Development, then load this bundle.
            </p>
            <div className="row">{dl("bundle", "Download .mappy.zip")}</div>
          </div>
        </div>

        <div className="card card-pad stack">
          <h2>Penpot</h2>
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>In Penpot, open the Plugin manager (Ctrl + Alt + P) and install the Mappy plugin from:</li>
          </ol>
          <Copy text={`${origin}/plugins/penpot/manifest.json`} />
          <ol className="small" start={2} style={{ margin: 0, paddingLeft: 18 }}>
            <li>Open the plugin and choose the .mappy.zip below. It builds boards, layers, and the prototype flow.</li>
          </ol>
          <div className="row">{dl("bundle", "Download .mappy.zip", true)}</div>
          <div className="callout warn small">
            Brave and recent Chrome block public sites from loading localhost. If the plugin won't load, allow "Local network access" for design.penpot.app in the site settings (Brave:{" "}
            <code>brave://settings/content/localhostAccess</code>), or self-host Penpot.
          </div>
        </div>

        <div className="card card-pad stack">
          <h2>Share &amp; document</h2>
          <div className="row wrap">
            {dl("poster.png", "Flow poster (.png)")}
            {dl("poster.pdf", "Flow poster (.pdf)")}
            {dl("mermaid", "Mermaid flowchart (.mmd)")}
            {dl("json", "Full data (.json)")}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            The JSON contains the crawl graph and the design model (screens, layers in dp, hotspots, edges) for your own tools.
          </p>
        </div>
      </div>
    </div>
  );
}
