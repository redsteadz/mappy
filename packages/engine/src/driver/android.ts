/// <reference path="../types/app-info-parser.d.ts" />
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppInfo, DeviceInfo, DeviceSummary } from "@mappy/shared";
import type { Driver, Foreground, KeyName } from "./driver.ts";

/**
 * AndroidDriver: controls a phone or emulator through the `adb` CLI.
 * Every call is a short-lived adb process — transparent, easy to debug, and no native deps.
 */

export interface AdbResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

const adbBin = () => process.env.MAPPY_ADB ?? "adb";

export function runAdb(args: string[], opts: { timeoutMs?: number; serial?: string } = {}): Promise<AdbResult> {
  const full = opts.serial ? ["-s", opts.serial, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(adbBin(), full, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

export async function adbVersion(): Promise<string | null> {
  try {
    const r = await runAdb(["version"], { timeoutMs: 5000 });
    return r.code === 0 ? r.stdout.toString().split("\n")[0].trim() : null;
  } catch {
    return null;
  }
}

export async function listDevices(): Promise<DeviceSummary[]> {
  const r = await runAdb(["devices", "-l"], { timeoutMs: 10_000 });
  return r.stdout
    .toString()
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const kv = Object.fromEntries(rest.map((p) => p.split(":")).filter((p) => p.length === 2));
      return { serial, state, model: (kv.model ?? "").replace(/_/g, " "), product: kv.product ?? "" };
    });
}

const KEYCODES: Record<KeyName, string> = {
  BACK: "KEYCODE_BACK",
  HOME: "KEYCODE_HOME",
  ENTER: "KEYCODE_ENTER",
  ESCAPE: "KEYCODE_ESCAPE",
  APP_SWITCH: "KEYCODE_APP_SWITCH",
};

/** Quote a string for the device's /system/bin/sh. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const dataDir = () => process.env.MAPPY_HOME ?? join(homedir(), ".local", "share", "mappy");
const restoreFile = (serial: string) => join(dataDir(), "device-restore", `${serial.replace(/[^\w.-]/g, "_")}.json`);

const ANIMATION_KEYS = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];

export class AndroidDriver implements Driver {
  readonly serial: string;
  private cachedInfo: DeviceInfo | null = null;

  constructor(serial: string) {
    this.serial = serial;
  }

  private async adb(args: string[], timeoutMs = 30_000): Promise<AdbResult> {
    const r = await runAdb(args, { serial: this.serial, timeoutMs });
    if (r.code !== 0 && /device .* not found|device offline|unauthorized|no devices/i.test(r.stderr)) {
      throw new Error(`adb: ${r.stderr.trim()}`);
    }
    return r;
  }

  /** Run a device shell command and return trimmed stdout. */
  async shell(cmd: string, timeoutMs = 30_000): Promise<string> {
    const r = await this.adb(["shell", cmd], timeoutMs);
    return r.stdout.toString().replace(/\r\n/g, "\n").trim();
  }

  async info(): Promise<DeviceInfo> {
    if (this.cachedInfo) return this.cachedInfo;
    const props = await this.shell(
      "getprop ro.product.model; getprop ro.product.manufacturer; getprop ro.build.version.sdk; getprop ro.build.version.release; wm size; wm density",
    );
    const lines = props.split("\n");
    const size = [...props.matchAll(/(Physical|Override) size: (\d+)x(\d+)/g)].pop();
    const dens = [...props.matchAll(/(Physical|Override) density: (\d+)/g)].pop();
    this.cachedInfo = {
      serial: this.serial,
      model: lines[0] ?? "",
      manufacturer: lines[1] ?? "",
      sdk: Number(lines[2]) || 0,
      release: lines[3] ?? "",
      widthPx: size ? Number(size[2]) : 1080,
      heightPx: size ? Number(size[3]) : 2400,
      density: dens ? Number(dens[2]) : 420,
    };
    return this.cachedInfo;
  }

  /** Launchable apps (those with a launcher activity), optionally including system apps. */
  async listApps(opts: { includeSystem?: boolean } = {}): Promise<AppInfo[]> {
    const [third, launchable] = await Promise.all([
      this.shell("pm list packages -3"),
      this.shell("cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER"),
    ]);
    const userPkgs = new Set(third.split("\n").map((l) => l.replace(/^package:/, "").trim()).filter(Boolean));
    const launch = new Map<string, string>();
    for (const l of launchable.split("\n")) {
      const m = l.trim().match(/^([\w.]+)\/([\w.$]+)$/);
      if (m && !launch.has(m[1])) launch.set(m[1], m[2].startsWith(".") ? m[1] + m[2] : m[2]);
    }
    const pkgs = new Set([...launch.keys()].filter((p) => opts.includeSystem || userPkgs.has(p)));
    if (!launch.size) for (const p of userPkgs) pkgs.add(p); // older devices without query-activities
    return [...pkgs].sort().map((pkg) => ({ pkg, launchActivity: launch.get(pkg), system: !userPkgs.has(pkg) }));
  }

  /** Label, version and icon, read from the APK (pulled once and cached). */
  async appDetails(pkg: string): Promise<AppInfo & { icon?: string }> {
    const cacheDir = join(dataDir(), "apk-cache");
    const metaFile = join(cacheDir, `${pkg}.json`);
    const dumpsys = await this.shell(`dumpsys package ${pkg} | grep -E 'versionName|versionCode' | head -2`);
    const versionName = dumpsys.match(/versionName=(\S+)/)?.[1];
    const versionCode = dumpsys.match(/versionCode=(\d+)/)?.[1];
    if (existsSync(metaFile)) {
      const cached = JSON.parse(await readFile(metaFile, "utf8"));
      if (cached.versionCode === versionCode) return cached;
    }
    const base: AppInfo & { icon?: string } = { pkg, versionName, versionCode };
    try {
      const path = (await this.shell(`pm path ${pkg}`)).split("\n").find((l) => l.includes("base.apk"))?.replace(/^package:/, "").trim();
      if (!path) return base;
      const size = Number(await this.shell(`stat -c %s ${shQuote(path)}`));
      if (size > 250 * 1024 * 1024) return base;
      await mkdir(cacheDir, { recursive: true });
      const local = join(cacheDir, `${pkg}.apk`);
      const r = await this.adb(["pull", path, local], 120_000);
      if (r.code !== 0) return base;
      const { default: AppInfoParser } = await import("app-info-parser");
      const parsed = await new AppInfoParser(local).parse();
      const label = Array.isArray(parsed.application?.label) ? parsed.application.label[0] : parsed.application?.label;
      const details = { ...base, label: typeof label === "string" ? label : undefined, icon: typeof parsed.icon === "string" ? parsed.icon : undefined };
      await writeFile(metaFile, JSON.stringify(details));
      await rm(local, { force: true });
      return details;
    } catch {
      return base;
    }
  }

  async launch(pkg: string): Promise<void> {
    const resolved = (await this.shell(`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${pkg}`)).split("\n").pop() ?? "";
    if (/^[\w.]+\/[\w.$]+$/.test(resolved.trim())) {
      await this.shell(`am start -W -n ${resolved.trim()}`, 30_000);
    } else {
      await this.shell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
    }
  }

  async forceStop(pkg: string): Promise<void> {
    await this.shell(`am force-stop ${pkg}`);
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.adb(["exec-out", "screencap", "-p"], 15_000);
    if (r.code !== 0 || r.stdout.length < 100 || r.stdout[0] !== 0x89) throw new Error(`screencap failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  async hierarchy(): Promise<string> {
    const file = "/sdcard/mappy_dump.xml";
    const r = await this.adb(["exec-out", `rm -f ${file}; uiautomator dump ${file} >/dev/null 2>&1; cat ${file}`], 30_000);
    const xml = r.stdout.toString("utf8");
    const start = xml.indexOf("<?xml");
    if (start < 0 || !xml.includes("</hierarchy>")) {
      throw new Error(/idle/i.test(xml) ? "could not get idle state" : "uiautomator dump failed");
    }
    return xml.slice(start, xml.lastIndexOf("</hierarchy>") + "</hierarchy>".length);
  }

  async foreground(): Promise<Foreground> {
    const out = await this.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'");
    const parse = (s: string | undefined): Foreground | null => {
      const m = s?.match(/ ([\w.]+)\/([\w.$]+)/);
      if (!m) return null;
      return { pkg: m[1], activity: m[2].startsWith(".") ? m[1] + m[2] : m[2] };
    };
    const focus = out.split("\n").find((l) => l.includes("mCurrentFocus"));
    const app = out.split("\n").find((l) => l.includes("mFocusedApp"));
    const fromFocus = parse(focus);
    if (fromFocus) return fromFocus;
    // Popup windows (no component) belong to the focused app.
    return parse(app) ?? { pkg: "", activity: "" };
  }

  async tap(x: number, y: number): Promise<void> {
    await this.shell(`input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async longPress(x: number, y: number): Promise<void> {
    await this.shell(`input swipe ${Math.round(x)} ${Math.round(y)} ${Math.round(x)} ${Math.round(y)} 800`);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, ms = 400): Promise<void> {
    await this.shell(`input swipe ${[x1, y1, x2, y2].map(Math.round).join(" ")} ${ms}`);
  }

  async typeText(text: string): Promise<void> {
    // `input text` only handles ASCII; spaces are encoded as %s.
    const ascii = text.replace(/[^\x20-\x7e]/g, "").replace(/%/g, "").replace(/ /g, "%s");
    if (ascii) await this.shell(`input text ${shQuote(ascii)}`);
  }

  async key(key: KeyName): Promise<void> {
    await this.shell(`input keyevent ${KEYCODES[key]}`);
  }

  async keyboardShown(): Promise<boolean> {
    const out = await this.shell("dumpsys input_method | grep -iE 'mInputShown|InputViewShown'");
    return /mInputShown=true|InputViewShown=true/i.test(out);
  }

  /** Screen state for the doctor page. */
  async screenState(): Promise<{ awake: boolean; locked: boolean }> {
    const power = await this.shell("dumpsys power | grep -E 'mWakefulness=|Display Power: state='");
    const kg = await this.shell("dumpsys window | grep -E 'mDreamingLockscreen|isKeyguardShowing|mShowingLockscreen|KeyguardShowing'");
    return { awake: /Awake|state=ON/.test(power), locked: /(mDreamingLockscreen|mShowingLockscreen|KeyguardShowing|isKeyguardShowing)=true/i.test(kg) };
  }

  async readSettings(): Promise<Record<string, string>> {
    const keys = [...ANIMATION_KEYS, "stay_on_while_plugged_in"];
    const out = await this.shell(keys.map((k) => `settings get global ${k}`).join("; "));
    const vals = out.split("\n");
    return Object.fromEntries(keys.map((k, i) => [k, (vals[i] ?? "null").trim()]));
  }

  private async writeSettings(values: Record<string, string>): Promise<void> {
    const cmds = Object.entries(values).map(([k, v]) => (v === "null" ? `settings delete global ${k}` : `settings put global ${k} ${shQuote(v)}`));
    if (cmds.length) await this.shell(cmds.join("; "));
  }

  /**
   * Disable animations and keep the screen on while crawling. Previous values are written to a
   * restore file first, so they can be put back even if Mappy is killed mid-crawl.
   */
  async prepare(opts: { disableAnimations: boolean; stayAwake: boolean }): Promise<() => Promise<void>> {
    await this.restorePending();
    const before = await this.readSettings();
    const changes: Record<string, string> = {};
    if (opts.disableAnimations) for (const k of ANIMATION_KEYS) changes[k] = "0";
    if (opts.stayAwake) changes.stay_on_while_plugged_in = "7";
    const original = Object.fromEntries(Object.keys(changes).map((k) => [k, before[k]]));
    if (Object.keys(changes).length) {
      await mkdir(join(dataDir(), "device-restore"), { recursive: true });
      await writeFile(restoreFile(this.serial), JSON.stringify(original));
      await this.writeSettings(changes);
    }
    await this.shell("input keyevent KEYCODE_WAKEUP");
    return async () => {
      await this.writeSettings(original);
      await rm(restoreFile(this.serial), { force: true });
    };
  }

  /** Put back settings left over from a crawl that didn't shut down cleanly. */
  async restorePending(): Promise<boolean> {
    const f = restoreFile(this.serial);
    if (!existsSync(f)) return false;
    const original = JSON.parse(await readFile(f, "utf8")) as Record<string, string>;
    await this.writeSettings(original);
    await rm(f, { force: true });
    return true;
  }
}

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** Environment and device checks shown on the dashboard's Doctor page. */
export async function doctor(): Promise<{ checks: DoctorCheck[]; devices: DeviceSummary[] }> {
  const checks: DoctorCheck[] = [];
  const version = await adbVersion();
  checks.push({
    id: "adb",
    label: "adb installed",
    ok: !!version,
    detail: version ?? "adb was not found on PATH",
    fix: version ? undefined : "sudo pacman -S android-tools android-udev   (then re-plug the phone)",
  });
  if (!version) return { checks, devices: [] };
  const devices = await listDevices();
  checks.push({
    id: "device",
    label: "Device connected",
    ok: devices.some((d) => d.state === "device"),
    detail: devices.length ? devices.map((d) => `${d.serial} (${d.state})`).join(", ") : "No devices found",
    fix: devices.length ? undefined : "Enable Developer options → USB debugging on the phone and connect it by USB",
  });
  for (const d of devices.filter((x) => x.state === "unauthorized")) {
    checks.push({ id: `auth-${d.serial}`, label: `Authorize ${d.serial}`, ok: false, detail: "The phone hasn't accepted this computer's RSA key", fix: "Unlock the phone and tap Allow on the USB debugging prompt" });
  }
  for (const d of devices.filter((x) => x.state === "device")) {
    const drv = new AndroidDriver(d.serial);
    try {
      const s = await drv.screenState();
      checks.push({ id: `screen-${d.serial}`, label: `${d.model || d.serial}: screen unlocked`, ok: s.awake && !s.locked, detail: s.awake ? (s.locked ? "Lock screen is showing" : "Awake and unlocked") : "Screen is off", fix: s.awake && !s.locked ? undefined : "Wake and unlock the phone" });
      const probe = await drv.shell("uiautomator 2>&1 | head -1");
      checks.push({ id: `uia-${d.serial}`, label: `${d.model || d.serial}: UiAutomator available`, ok: /usage|dump/i.test(probe), detail: probe || "no output" });
      const pending = existsSync(restoreFile(d.serial));
      if (pending) checks.push({ id: `restore-${d.serial}`, label: `${d.model || d.serial}: settings from an interrupted crawl`, ok: false, detail: "Animation/stay-awake settings were not restored", fix: "Start any crawl or use 'Restore settings' to put them back" });
    } catch (err) {
      checks.push({ id: `probe-${d.serial}`, label: `${d.serial}: responds to adb shell`, ok: false, detail: (err as Error).message });
    }
  }
  return { checks, devices };
}
