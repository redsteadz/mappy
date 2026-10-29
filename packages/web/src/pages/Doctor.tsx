import { useQuery } from "@tanstack/react-query";
import { api, type DeviceEntry, type DoctorCheck } from "../api.ts";

export function Doctor() {
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => api<{ checks: DoctorCheck[]; devices: DeviceEntry[] }>("/api/doctor") });
  return (
    <div className="page">
      <div className="page-narrow stack">
        <div className="section-title">
          <div>
            <h1>Device setup</h1>
            <p className="muted">Mappy drives your phone over USB with adb. Each check below must pass before a real crawl.</p>
          </div>
          <button onClick={() => doctor.refetch()} disabled={doctor.isFetching}>
            {doctor.isFetching ? "Checking…" : "Re-check"}
          </button>
        </div>
        <div className="card">
          {doctor.isLoading && <div className="empty">Checking adb and connected devices…</div>}
          {doctor.error && <div className="empty">{String(doctor.error)}</div>}
          {doctor.data && (
            <table>
              <tbody>
                {doctor.data.checks.map((c) => (
                  <tr key={c.id}>
                    <td style={{ width: 36 }}>
                      <span className={`badge ${c.ok ? "ok" : "bad"}`}>{c.ok ? "✓" : "✕"}</span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{c.label}</div>
                      <div className="muted small">{c.detail}</div>
                      {c.fix && (
                        <div className="small" style={{ marginTop: 4 }}>
                          Fix: <code>{c.fix}</code>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card card-pad stack">
          <h2>Setting up a phone</h2>
          <ol className="stack" style={{ margin: 0, paddingLeft: 20, gap: 6 }}>
            <li>
              Install adb: <code>sudo pacman -S android-tools android-udev</code>, then re-plug the phone.
            </li>
            <li>On the phone: Settings → About phone → tap <b>Build number</b> 7 times to enable Developer options.</li>
            <li>
              Settings → System → Developer options → enable <b>USB debugging</b>. Connect the cable and tap <b>Allow</b> on the RSA prompt.
            </li>
            <li>Keep the phone unlocked. During a crawl Mappy turns animations off and keeps the screen awake, and restores both afterwards.</li>
            <li>Prefer a test account: Mappy taps everything except actions you mark as risky (delete, pay, log out…), which it asks about first.</li>
          </ol>
          <p className="muted small">
            No phone yet? Pick <b>Demo phone</b> on the New crawl page. It's a simulated notes app that exercises every feature.
          </p>
        </div>
      </div>
    </div>
  );
}
