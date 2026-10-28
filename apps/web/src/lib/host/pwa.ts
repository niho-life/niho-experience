import type { MetadataRoute } from "next";
import type { BookingFilter } from "@/host/bookings";
import { HOST_APP_SCOPE, HOST_BOOKINGS_PATH, HOST_CALENDAR_PATH, HOST_LAUNCH_PATH, HOST_MESSAGES_PATH, withQuery } from "./routes";

/**
 * The console as an installable app (#177, docs/host-pwa.md). Named apart from NIHO's own
 * "NIHO host" app on niho.life; its icon is the site's mark on leaf green (public/host-app/*.svg).
 */
export const HOST_APP_NAME = "NIHO 体験ホスト";
export const HOST_APP_SHORT_NAME = "体験ホスト";
/** The host root layout's themeColor. */
export const HOST_APP_THEME_COLOR = "#ffffff";
export const HOST_APP_ICONS = {
  icon192: "/host-app/icon-192.png",
  icon512: "/host-app/icon-512.png",
  maskable512: "/host-app/icon-maskable-512.png",
  apple: "/host-app/apple-touch-icon.png",
} as const;

const PENDING: BookingFilter = "pending";

/** /host/manifest.webmanifest. Shortcuts show on Android and computers only. */
export function hostWebManifest(): MetadataRoute.Manifest {
  return {
    id: HOST_APP_SCOPE,
    name: HOST_APP_NAME,
    short_name: HOST_APP_SHORT_NAME,
    description: "体験の予約・メッセージ・カレンダーを確かめる、NIHO Experience のホストの画面です。",
    lang: "ja",
    dir: "ltr",
    start_url: `${HOST_LAUNCH_PATH}?source=pwa`,
    scope: HOST_APP_SCOPE,
    display: "standalone",
    background_color: HOST_APP_THEME_COLOR,
    theme_color: HOST_APP_THEME_COLOR,
    icons: [
      { src: HOST_APP_ICONS.icon192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: HOST_APP_ICONS.icon512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: HOST_APP_ICONS.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "承認待ち", url: withQuery(HOST_BOOKINGS_PATH, { filter: PENDING }) },
      // 予約's default list (これから) starts with today's sessions; ホーム's 今日の開催 is not there on a day without any.
      { name: "今日の回", url: HOST_BOOKINGS_PATH },
      { name: "メッセージ", url: HOST_MESSAGES_PATH },
      { name: "カレンダー", url: HOST_CALENDAR_PATH },
    ],
  };
}

/** What 設定 › この端末 › アプリ offers on this device. */
export type HostInstallGuide =
  | { kind: "installed" }
  /** Chromium's own install dialog (beforeinstallprompt). */
  | { kind: "prompt"; label: string }
  | { kind: "ios" }
  | { kind: "mac-safari" }
  | { kind: "other" };

export interface HostInstallDevice {
  standalone: boolean;
  canPrompt: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

export function hostInstallGuide({ standalone, canPrompt, userAgent, platform, maxTouchPoints }: HostInstallDevice): HostInstallGuide {
  if (standalone) return { kind: "installed" };
  if (canPrompt) return { kind: "prompt", label: /Android/.test(userAgent) ? "ホーム画面に追加" : "アプリとして追加" };
  // iPadOS reports itself as a Mac with a touch screen.
  if (/iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1)) return { kind: "ios" };
  if (/Macintosh/.test(userAgent) && /Safari\//.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(userAgent)) return { kind: "mac-safari" };
  return { kind: "other" };
}
