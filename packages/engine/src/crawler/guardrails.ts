import type { UiNode } from "@mappy/shared";

/** Classification of whatever is in the foreground when it isn't the target app's own UI. */
export type ForeignState =
  | { kind: "permission"; allow: UiNode | null; deny: UiNode | null }
  | { kind: "crash"; close: UiNode | null }
  | { kind: "launcher" }
  | { kind: "system" }
  | { kind: "external" };

const PERMISSION_PKG = /permissioncontroller|packageinstaller/;
const LAUNCHER_PKG = /launcher|nexuslauncher|trebuchet|lawnchair|\.home$/i;
const ALLOW = /^(allow|while using the app|only this time|allow all the time|ok)$/i;
const DENY = /^(deny|don.t allow|deny & don.t ask again|don.t allow & don.t ask again|no thanks)$/i;

const label = (n: UiNode) => (n.text || n.desc).trim();

export const isPermissionPkg = (pkg: string): boolean => PERMISSION_PKG.test(pkg);

export function classifyForeign(pkg: string, nodes: UiNode[] | null): ForeignState {
  const all = nodes ?? [];
  if (PERMISSION_PKG.test(pkg)) {
    const allow =
      all.find((n) => /permission_allow_foreground_only_button|permission_allow_button/.test(n.rid)) ??
      all.find((n) => n.clickable && ALLOW.test(label(n))) ??
      null;
    const deny =
      all.find((n) => /permission_deny_button|permission_deny_and_dont_ask_again_button/.test(n.rid)) ??
      all.find((n) => n.clickable && DENY.test(label(n))) ??
      null;
    return { kind: "permission", allow, deny };
  }
  if (pkg === "android" || pkg === "com.android.systemui") {
    const crashText = all.some((n) => /has stopped|keeps stopping|isn.t responding/i.test(n.text));
    if (crashText || all.some((n) => /aerr_/.test(n.rid))) {
      const close = all.find((n) => /aerr_close|aerr_restart/.test(n.rid)) ?? all.find((n) => n.clickable && /close app|close|ok/i.test(label(n))) ?? null;
      return { kind: "crash", close };
    }
    return { kind: "system" };
  }
  if (LAUNCHER_PKG.test(pkg)) return { kind: "launcher" };
  return { kind: "external" };
}
