import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AndroidDriver, listDevices } from "./android.ts";

const tmp = mkdtempSync(join(tmpdir(), "mappy-adb-"));
const log = join(tmp, "adb.log");

beforeAll(() => {
  process.env.MAPPY_ADB = new URL("./testdata/fake-adb.sh", import.meta.url).pathname;
  process.env.MAPPY_HOME = tmp;
  process.env.FAKE_ADB_LOG = log;
});

describe("AndroidDriver (fake adb)", () => {
  const d = new AndroidDriver("R58N12345");

  it("lists devices with state and model", async () => {
    expect(await listDevices()).toEqual([
      { serial: "R58N12345", state: "device", model: "SM G991B", product: "o1sxx" },
      { serial: "emulator-5554", state: "unauthorized", model: "", product: "" },
    ]);
  });

  it("reads device info, preferring override size and density", async () => {
    expect(await d.info()).toMatchObject({ model: "SM-G991B", manufacturer: "samsung", sdk: 34, widthPx: 720, heightPx: 1600, density: 280 });
  });

  it("lists launchable user apps with their launch activity", async () => {
    expect(await d.listApps()).toEqual([
      { pkg: "com.example.notes", launchActivity: "com.example.notes.MainActivity", system: false },
      { pkg: "org.fossify.notes", launchActivity: "org.fossify.notes.activities.SplashActivity", system: false },
    ]);
    expect((await d.listApps({ includeSystem: true })).map((a) => a.pkg)).toContain("com.android.settings");
  });

  it("parses the focused window, falling back to the focused app for popups", async () => {
    expect(await d.foreground()).toEqual({ pkg: "com.google.android.permissioncontroller", activity: "com.android.permissioncontroller.permission.ui.GrantPermissionsActivity" });
    const flag = join(tmp, "popup");
    writeFileSync(flag, "1");
    process.env.FAKE_ADB_POPUP = flag;
    expect(await d.foreground()).toEqual({ pkg: "org.fossify.notes", activity: "org.fossify.notes.activities.MainActivity" });
    delete process.env.FAKE_ADB_POPUP;
  });

  it("returns the dump without the trailer", async () => {
    const xml = await d.hierarchy();
    expect(xml.endsWith("</hierarchy>")).toBe(true);
  });

  it("escapes typed text for the device shell", async () => {
    await d.typeText("it's a test");
    expect(readFileSync(log, "utf8")).toContain(`input text 'it'\\''s%sa%stest'`);
  });

  it("saves original settings before changing them and restores them", async () => {
    writeFileSync(log, "");
    const restore = await d.prepare({ disableAnimations: true, stayAwake: true });
    const restoreFile = join(tmp, "device-restore", "R58N12345.json");
    expect(JSON.parse(readFileSync(restoreFile, "utf8"))).toEqual({
      window_animation_scale: "1.0",
      transition_animation_scale: "1.0",
      animator_duration_scale: "0.5",
      stay_on_while_plugged_in: "null",
    });
    expect(readFileSync(log, "utf8")).toContain("settings put global window_animation_scale '0'");
    await restore();
    expect(readFileSync(log, "utf8")).toContain("settings delete global stay_on_while_plugged_in");
    expect(existsSync(restoreFile)).toBe(false);
  });
});
