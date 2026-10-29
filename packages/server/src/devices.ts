import { AndroidDriver, demoApp, doctor, listDevices, MockDriver, type Driver } from "@mappy/engine";
import type { AppInfo, DeviceSummary } from "@mappy/shared";

export const DEMO_SERIAL = "demo";

export interface DeviceEntry extends DeviceSummary {
  kind: "adb" | "demo";
}

/** Real adb devices plus a simulated demo phone, so the dashboard can be tried without hardware. */
export class Devices {
  private drivers = new Map<string, Driver>();

  async list(): Promise<DeviceEntry[]> {
    const real = await listDevices().catch(() => [] as DeviceSummary[]);
    return [
      ...real.map((d) => ({ ...d, kind: "adb" as const })),
      { serial: DEMO_SERIAL, state: "device", model: "Demo phone (simulated Notely app)", product: "mappy-demo", kind: "demo" },
    ];
  }

  driver(serial: string): Driver {
    let d = this.drivers.get(serial);
    if (!d) {
      d = serial === DEMO_SERIAL ? new MockDriver(demoApp) : new AndroidDriver(serial);
      this.drivers.set(serial, d);
    }
    return d;
  }

  /** A fresh demo driver per crawl so each demo crawl starts from a clean app state. */
  crawlDriver(serial: string): Driver {
    return serial === DEMO_SERIAL ? new MockDriver(demoApp) : this.driver(serial);
  }

  async apps(serial: string, includeSystem: boolean): Promise<AppInfo[]> {
    return this.driver(serial).listApps({ includeSystem });
  }

  async appDetails(serial: string, pkg: string): Promise<AppInfo & { icon?: string }> {
    const d = this.driver(serial);
    if (d instanceof AndroidDriver) return d.appDetails(pkg);
    return (await d.listApps()).find((a) => a.pkg === pkg) ?? { pkg };
  }

  doctor() {
    return doctor();
  }
}
