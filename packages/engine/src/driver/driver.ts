import type { AppInfo, DeviceInfo } from "@mappy/shared";

export type KeyName = "BACK" | "HOME" | "ENTER" | "ESCAPE" | "APP_SWITCH";

export interface Foreground {
  pkg: string;
  activity: string;
}

/**
 * Minimal device-control surface the crawler needs. AndroidDriver implements it over adb;
 * MockDriver implements it over a declarative fake app for deterministic tests.
 */
export interface Driver {
  readonly serial: string;
  info(): Promise<DeviceInfo>;
  listApps(opts?: { includeSystem?: boolean }): Promise<AppInfo[]>;
  launch(pkg: string): Promise<void>;
  forceStop(pkg: string): Promise<void>;
  /** PNG bytes of the current screen. */
  screenshot(): Promise<Buffer>;
  /** uiautomator-style XML of the active window. Throws when the UI never idles. */
  hierarchy(): Promise<string>;
  foreground(): Promise<Foreground>;
  tap(x: number, y: number): Promise<void>;
  longPress(x: number, y: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, ms?: number): Promise<void>;
  typeText(text: string): Promise<void>;
  key(key: KeyName): Promise<void>;
  keyboardShown(): Promise<boolean>;
  /** Apply crawl-friendly device settings; returns a function that restores them. */
  prepare?(opts: { disableAnimations: boolean; stayAwake: boolean }): Promise<() => Promise<void>>;
}
