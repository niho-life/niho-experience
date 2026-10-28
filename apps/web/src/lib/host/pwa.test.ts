import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ config: { hostConsoleEnabled: true, hostPwaEnabled: true } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: state.config, isPreview: true }));

import { GET as manifestRoute } from "@/app/(host)/host/manifest.webmanifest/route";
import { GET as workerRoute } from "@/app/(host)/host/sw.js/route";
import { hostInstallGuide, hostPushAvailability, hostWebManifest, type HostInstallDevice } from "./pwa";

afterEach(() => {
  state.config.hostConsoleEnabled = true;
  state.config.hostPwaEnabled = true;
});

describe("the app's manifest (#177)", () => {
  it("opens the console's own start page inside /host/, never the English introduction", () => {
    const manifest = hostWebManifest();
    expect(manifest).toMatchObject({
      id: "/host/",
      name: "NIHO 体験ホスト",
      short_name: "体験ホスト",
      lang: "ja",
      dir: "ltr",
      start_url: "/host/launch?source=pwa",
      scope: "/host/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#ffffff",
    });
    expect(manifest.icons?.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
    expect(manifest.shortcuts?.map((shortcut) => [shortcut.name, shortcut.url])).toEqual([
      ["承認待ち", "/host/bookings?filter=pending"],
      ["今日の回", "/host/bookings"],
      ["メッセージ", "/host/messages"],
      ["カレンダー", "/host/calendar"],
    ]);
    for (const url of [manifest.start_url, ...(manifest.shortcuts ?? []).map((shortcut) => shortcut.url)]) expect(url!.startsWith("/host/")).toBe(true);
  });

  it("is served only while HOST_PWA_ENABLED is on", async () => {
    const on = manifestRoute();
    expect(on.status).toBe(200);
    expect(on.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
    expect(on.headers.get("cache-control")).toBe("private, no-store");
    expect(await on.json()).toMatchObject({ id: "/host/", start_url: "/host/launch?source=pwa" });
    state.config.hostPwaEnabled = false;
    expect(manifestRoute().status).toBe(404);
  });
});

describe("/host/sw.js", () => {
  it("serves the worker as JavaScript, and a self-removing one instead of a 404 when switched off", async () => {
    const on = workerRoute();
    expect(on.status).toBe(200);
    expect(on.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(on.headers.get("cache-control")).toBe("private, no-store");
    expect(await on.text()).toContain('addEventListener("fetch"');
    state.config.hostPwaEnabled = false;
    state.config.hostConsoleEnabled = false;
    const off = workerRoute();
    expect(off.status).toBe(200);
    const source = await off.text();
    expect(source).toContain("registration.unregister()");
    expect(source).not.toContain('addEventListener("fetch"');
  });
});

describe("設定 › この端末 › アプリ", () => {
  const device = (overrides: Partial<HostInstallDevice>): HostInstallDevice => ({ standalone: false, canPrompt: false, userAgent: "", platform: "", maxTouchPoints: 0, ...overrides });
  const ua = {
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
    firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
  };

  it("says when the console already runs as an app", () => {
    expect(hostInstallGuide(device({ standalone: true, canPrompt: true, userAgent: ua.android }))).toEqual({ kind: "installed" });
  });

  it("offers Chromium's own dialog, named for phones and computers", () => {
    expect(hostInstallGuide(device({ canPrompt: true, userAgent: ua.android }))).toEqual({ kind: "prompt", label: "ホーム画面に追加" });
    expect(hostInstallGuide(device({ canPrompt: true, userAgent: ua.macChrome, platform: "MacIntel" }))).toEqual({ kind: "prompt", label: "アプリとして追加" });
  });

  it("explains Safari's own steps on iPhone, iPad and Mac", () => {
    expect(hostInstallGuide(device({ userAgent: ua.iphone, platform: "iPhone", maxTouchPoints: 5 }))).toEqual({ kind: "ios" });
    expect(hostInstallGuide(device({ userAgent: ua.ipadDesktop, platform: "MacIntel", maxTouchPoints: 5 }))).toEqual({ kind: "ios" });
    expect(hostInstallGuide(device({ userAgent: ua.macSafari, platform: "MacIntel" }))).toEqual({ kind: "mac-safari" });
  });

  it("stays neutral elsewhere", () => {
    expect(hostInstallGuide(device({ userAgent: ua.macChrome, platform: "MacIntel" }))).toEqual({ kind: "other" });
    expect(hostInstallGuide(device({ userAgent: ua.firefox, platform: "Win32" }))).toEqual({ kind: "other" });
  });

  it("offers push only where the device can take it (#177 P2)", () => {
    const push = (overrides: Partial<HostInstallDevice> & { hasPush?: boolean; permission?: NotificationPermission | null }) =>
      hostPushAvailability({ ...device(overrides), hasPush: overrides.hasPush ?? true, permission: overrides.permission ?? "default" });
    expect(push({ userAgent: ua.iphone, platform: "iPhone", maxTouchPoints: 5, hasPush: false })).toBe("ios-install");
    expect(push({ userAgent: ua.ipadDesktop, platform: "MacIntel", maxTouchPoints: 5 })).toBe("ios-install");
    expect(push({ userAgent: ua.iphone, platform: "iPhone", maxTouchPoints: 5, standalone: true })).toBe("available");
    expect(push({ userAgent: ua.firefox, platform: "Win32", hasPush: false })).toBe("unsupported");
    expect(push({ userAgent: ua.android, permission: "denied" })).toBe("denied");
    expect(push({ userAgent: ua.macSafari, platform: "MacIntel" })).toBe("available");
  });
});
