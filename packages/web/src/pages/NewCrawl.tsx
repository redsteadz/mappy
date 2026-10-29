import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, go, type AppInfo, type DeviceEntry, type Project } from "../api.ts";

type AppDetails = AppInfo & { icon?: string };

const DEFAULT_RISKY = "delete, remove, erase, discard, log ?out, sign ?out, pay, buy, purchase, checkout, place order, subscribe, upgrade, donate, send, post, publish, share, submit, confirm, reset, clear, wipe, uninstall, deactivate, close account, report, block, unfollow, call";

function AppIcon({ app }: { app: AppDetails }) {
  return <div className="app-icon">{app.icon ? <img src={app.icon} alt="" /> : (app.label ?? app.pkg.split(".").pop() ?? "?")[0].toUpperCase()}</div>;
}

export function NewCrawl() {
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<DeviceEntry[]>("/api/devices"), refetchInterval: 5000 });
  const [serial, setSerial] = useState<string>("");
  const [system, setSystem] = useState(false);
  const [filter, setFilter] = useState("");
  const [pkg, setPkg] = useState("");
  const ready = devices.data?.filter((d) => d.state === "device") ?? [];

  useEffect(() => {
    if (!serial && ready.length) setSerial((ready.find((d) => d.kind === "adb") ?? ready[0]).serial);
  }, [ready, serial]);

  const apps = useQuery({
    queryKey: ["apps", serial, system],
    queryFn: () => api<AppInfo[]>(`/api/devices/${encodeURIComponent(serial)}/apps${system ? "?system=1" : ""}`),
    enabled: !!serial,
  });
  const details = useQuery({
    queryKey: ["app", serial, pkg],
    queryFn: () => api<AppDetails>(`/api/devices/${encodeURIComponent(serial)}/apps/${encodeURIComponent(pkg)}`),
    enabled: !!serial && !!pkg,
    staleTime: Infinity,
  });
  const visible = useMemo(
    () => (apps.data ?? []).filter((a) => !filter || `${a.pkg} ${a.label ?? ""}`.toLowerCase().includes(filter.toLowerCase())),
    [apps.data, filter],
  );
  useEffect(() => {
    if (serial === "demo" && apps.data?.length) setPkg(apps.data[0].pkg);
  }, [serial, apps.data]);

  // Crawl configuration
  const [maxActions, setMaxActions] = useState(300);
  const [maxScreens, setMaxScreens] = useState(80);
  const [maxMinutes, setMaxMinutes] = useState(30);
  const [listSample, setListSample] = useState(2);
  const [riskyPolicy, setRiskyPolicy] = useState<"ask" | "skip" | "allow">("ask");
  const [permissionPolicy, setPermissionPolicy] = useState<"grant" | "deny" | "ask">("deny");
  const [startMode, setStartMode] = useState<"relaunch" | "current">("relaunch");
  const [scroll, setScroll] = useState(true);
  const [longPress, setLongPress] = useState(false);
  const [inputs, setInputs] = useState(true);
  const [disableAnimations, setDisableAnimations] = useState(true);
  const [stayAwake, setStayAwake] = useState(true);
  const [risky, setRisky] = useState(DEFAULT_RISKY);
  const [values, setValues] = useState({ email: "mappy.test@example.com", password: "MappyTest123!", name: "Alex Mappy", phone: "5555550123", search: "test" });
  const [advanced, setAdvanced] = useState(false);

  const start = useMutation({
    mutationFn: () =>
      api<Project>("/api/projects", {
        body: {
          serial,
          pkg,
          label: details.data?.label,
          config: {
            maxActions,
            maxScreens,
            maxMinutes,
            listSample,
            riskyPolicy,
            permissionPolicy,
            startMode,
            riskyPatterns: risky.split(",").map((s) => s.trim()).filter(Boolean),
            inputs: { ...values, number: "42", url: "https://example.com", default: "Mappy test" },
            explore: { scroll, longPress, inputs },
            device: { disableAnimations, stayAwake },
            ...(serial === "demo" ? { settle: { minMs: 150, maxMs: 2000, stableFrames: 2 } } : {}),
          },
        },
      }),
    onSuccess: (p) => go("p", p.id, "live"),
  });

  const selected = apps.data?.find((a) => a.pkg === pkg);
  return (
    <div className="page">
      <div className="page-narrow stack">
        <div>
          <h1>New crawl</h1>
          <p className="muted">Pick a device and an app. Mappy taps through every button and records each screen it reaches.</p>
        </div>

        <div className="card card-pad stack">
          <div className="section-title">
            <h2>1. Device</h2>
            <a href="#/doctor" className="small">
              Device setup →
            </a>
          </div>
          {devices.data && (
            <div className="stack" style={{ gap: 8 }}>
              {devices.data.map((d) => (
                <label key={d.serial} className="check">
                  <input type="radio" name="device" checked={serial === d.serial} disabled={d.state !== "device"} onChange={() => (setSerial(d.serial), setPkg(""))} />
                  <span style={{ fontWeight: 600 }}>{d.model || d.serial}</span>
                  <span className="muted small mono">{d.serial}</span>
                  {d.state !== "device" && <span className="badge bad">{d.state}</span>}
                  {d.kind === "demo" && <span className="badge accent">simulated</span>}
                </label>
              ))}
              {!devices.data.some((d) => d.kind === "adb") && (
                <div className="callout warn small">
                  No phone detected. Connect one with USB debugging enabled (see <a href="#/doctor">Device setup</a>), or try the demo phone.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="card card-pad stack">
          <div className="section-title">
            <h2>2. App</h2>
            <label className="check small">
              <input type="checkbox" checked={system} onChange={(e) => setSystem(e.target.checked)} /> Include system apps
            </label>
          </div>
          <input placeholder="Filter by name or package…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="app-list">
            {apps.isLoading && <div className="empty">Loading apps…</div>}
            {apps.error && <div className="empty">{String(apps.error)}</div>}
            {visible.map((a) => (
              <div key={a.pkg} className={`app-item ${a.pkg === pkg ? "selected" : ""}`} onClick={() => setPkg(a.pkg)}>
                <AppIcon app={a.pkg === pkg && details.data ? details.data : a} />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{(a.pkg === pkg && details.data?.label) || a.label || a.pkg.split(".").pop()}</div>
                  <div className="muted small mono">{a.pkg}</div>
                </div>
                {a.system && <span className="badge">system</span>}
              </div>
            ))}
            {apps.data && !visible.length && <div className="empty">No matching apps</div>}
          </div>
          {selected && (
            <div className="row callout">
              <span className="muted small">Selected</span>
              <AppIcon app={details.data ?? selected} />
              <div className="grow">
                <b>{details.data?.label ?? selected.label ?? selected.pkg}</b>{" "}
                <span className="muted small">{details.data?.versionName ? `v${details.data.versionName}` : details.isFetching ? "reading app info…" : ""}</span>
                <div className="muted small mono">{selected.launchActivity ?? selected.pkg}</div>
              </div>
            </div>
          )}
        </div>

        <div className="card card-pad stack">
          <h2>3. How to explore</h2>
          <div className="grid-2">
            <label className="field">
              Risky actions
              <select value={riskyPolicy} onChange={(e) => setRiskyPolicy(e.target.value as typeof riskyPolicy)}>
                <option value="ask">Ask me first (recommended)</option>
                <option value="skip">Never tap them</option>
                <option value="allow">Tap them too (test devices only)</option>
              </select>
              <span className="hint">Buttons matching delete, pay, log out, send… (editable below)</span>
            </label>
            <label className="field">
              Permission prompts
              <select value={permissionPolicy} onChange={(e) => setPermissionPolicy(e.target.value as typeof permissionPolicy)}>
                <option value="deny">Deny</option>
                <option value="grant">Allow</option>
                <option value="ask">Ask me</option>
              </select>
              <span className="hint">Camera, location, notifications…</span>
            </label>
            <label className="field">
              Start from
              <select value={startMode} onChange={(e) => setStartMode(e.target.value as typeof startMode)}>
                <option value="relaunch">A fresh app launch</option>
                <option value="current">Whatever is on screen now (e.g. after you log in)</option>
              </select>
            </label>
            <label className="field">
              List items to open
              <input type="number" min={1} max={10} value={listSample} onChange={(e) => setListSample(Number(e.target.value))} />
              <span className="hint">Rows in a list share a layout, so a couple are enough</span>
            </label>
          </div>
          <div className="grid-3">
            <label className="field">
              Max actions
              <input type="number" min={5} value={maxActions} onChange={(e) => setMaxActions(Number(e.target.value))} />
            </label>
            <label className="field">
              Max screens
              <input type="number" min={2} value={maxScreens} onChange={(e) => setMaxScreens(Number(e.target.value))} />
            </label>
            <label className="field">
              Max minutes
              <input type="number" min={1} value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))} />
            </label>
          </div>
          <div className="row wrap" style={{ gap: 20 }}>
            <label className="check">
              <input type="checkbox" checked={inputs} onChange={(e) => setInputs(e.target.checked)} /> Fill text fields
            </label>
            <label className="check">
              <input type="checkbox" checked={scroll} onChange={(e) => setScroll(e.target.checked)} /> Scroll to find more
            </label>
            <label className="check">
              <input type="checkbox" checked={longPress} onChange={(e) => setLongPress(e.target.checked)} /> Long-press items
            </label>
          </div>
          <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setAdvanced(!advanced)}>
            {advanced ? "▾" : "▸"} Test data, risky words and device options
          </button>
          {advanced && (
            <div className="stack">
              <div className="grid-3">
                {(Object.keys(values) as (keyof typeof values)[]).map((k) => (
                  <label key={k} className="field">
                    {k[0].toUpperCase() + k.slice(1)}
                    <input type={k === "password" ? "password" : "text"} value={values[k]} onChange={(e) => setValues({ ...values, [k]: e.target.value })} />
                  </label>
                ))}
              </div>
              <label className="field">
                Risky words (comma separated, regex allowed)
                <textarea rows={3} value={risky} onChange={(e) => setRisky(e.target.value)} />
              </label>
              <div className="row wrap" style={{ gap: 20 }}>
                <label className="check">
                  <input type="checkbox" checked={disableAnimations} onChange={(e) => setDisableAnimations(e.target.checked)} /> Turn animations off while crawling
                </label>
                <label className="check">
                  <input type="checkbox" checked={stayAwake} onChange={(e) => setStayAwake(e.target.checked)} /> Keep screen awake
                </label>
              </div>
              <p className="muted small">Both settings are put back when the crawl ends, even if Mappy is interrupted.</p>
            </div>
          )}
        </div>

        {start.error && <div className="callout bad">{String(start.error)}</div>}
        <div className="row">
          <div className="grow muted small">{serial !== "demo" && pkg ? "Unlock the phone and keep it connected while the crawl runs." : ""}</div>
          <button className="primary" disabled={!serial || !pkg || start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? "Starting…" : "Start crawl"}
          </button>
        </div>
      </div>
    </div>
  );
}
