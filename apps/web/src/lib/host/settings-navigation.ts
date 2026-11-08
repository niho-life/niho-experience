import { HOST_PROFILE_PATH, HOST_SELLER_PATH, HOST_SETTINGS_PATH, hostSupportPath, withProvider, withQuery } from "./routes";
import type { HostProviderRole } from "./providers";

export const HOST_SETTINGS_SECTIONS = [
  "provider",
  "payout",
  "calendar",
  "meeting",
  "notifications",
  "team",
  "support",
  "device",
  "account",
  "articles",
  "all",
] as const;

export type HostSettingsSection = (typeof HOST_SETTINGS_SECTIONS)[number];

export const HOST_SETTINGS_SECTION_TITLES: Readonly<Record<HostSettingsSection, string>> = {
  provider: "提供者情報",
  payout: "受取口座",
  calendar: "カレンダー連携",
  meeting: "集合案内",
  notifications: "通知",
  team: "チーム",
  support: "NIHOサポート",
  device: "この端末",
  account: "ログイン情報",
  articles: "記事連携",
  all: "設定",
};

const HASH_SECTIONS: Readonly<Record<string, HostSettingsSection>> = {
  "#settings-provider": "provider",
  "#settings-payout": "payout",
  "#settings-calendar": "calendar",
  "#settings-meeting": "meeting",
  "#settings-notification": "notifications",
  "#settings-team": "team",
  "#settings-support": "support",
  "#settings-device": "device",
  "#settings-account": "account",
  "#settings-article-links": "articles",
};

export function hostSettingsSectionOrNull(value: unknown): HostSettingsSection | null {
  return typeof value === "string" && (HOST_SETTINGS_SECTIONS as readonly string[]).includes(value) ? value as HostSettingsSection : null;
}

/** Old settings fragments remain bookmarks; the client adds the matching UI-only section query. */
export function hostSettingsSectionFromHash(value: unknown): HostSettingsSection | null {
  if (typeof value !== "string") return null;
  const hash = value.startsWith("#") ? value : `#${value}`;
  return HASH_SECTIONS[hash] ?? null;
}

export function hostSettingsSectionPath(providerId: string, section: HostSettingsSection): string {
  return withQuery(HOST_SETTINGS_PATH, { providerId, section });
}

export interface HostSettingsIndexItem {
  readonly label: string;
  readonly description: string;
  readonly href: string;
}

export interface HostSettingsIndexGroup {
  readonly label: "販売者" | "運営" | "アカウント";
  readonly items: readonly HostSettingsIndexItem[];
}

/**
 * The overview exposes only destinations the current role already has. It does not turn a visible
 * row into authorization; every destination keeps its existing server-side checks.
 */
export function hostSettingsIndexGroups(input: {
  providerId: string;
  role: HostProviderRole | null;
  deviceEnabled: boolean;
  articlesEnabled: boolean;
}): readonly HostSettingsIndexGroup[] {
  const { providerId, role } = input;
  const section = (value: HostSettingsSection) => hostSettingsSectionPath(providerId, value);
  const seller: HostSettingsIndexItem[] = [];
  const operations: HostSettingsIndexItem[] = [];
  const account: HostSettingsIndexItem[] = [
    { label: "ログイン情報", description: "ログイン中のアカウント", href: section("account") },
  ];

  if (role === "OWNER" || role === "EDITOR") {
    seller.push({ label: "提供者情報", description: "掲載名・事業者の紹介", href: section("provider") });
  }
  if (role === "OWNER") {
    seller.push(
      { label: "ホスト紹介", description: "迎える人の紹介文", href: withProvider(HOST_PROFILE_PATH, providerId) },
      { label: "販売者表示", description: "旅行者に公開する販売者の情報", href: withProvider(HOST_SELLER_PATH, providerId) },
      { label: "受取口座", description: "売上を受け取る口座", href: section("payout") },
    );
  }
  // Every signed-in provider role can manage their own email address. The panel keeps
  // provider-wide notification switches and Google connection commands permissioned.
  operations.push(
    { label: "通知", description: "宛先・受け取る通知", href: section("notifications") },
    { label: "カレンダー連携", description: "Google の予定と空き状況", href: section("calendar") },
  );
  if (role === "OWNER") {
    operations.push(
      { label: "チーム", description: "一緒に体験を運営する人", href: section("team") },
    );
  }
  // Preserve the former account entry for every provider role; the API checks ownership.
  operations.push({ label: "NIHOサポート", description: "サポートの利用条件・手数料", href: hostSupportPath("EXPERIENCE_PROVIDER", providerId) });
  if (role === "OWNER" || role === "EDITOR") {
    operations.push({ label: "集合案内", description: "予約後に伝える場所と当日の案内", href: section("meeting") });
  }
  if (input.deviceEnabled) account.push({ label: "この端末", description: "アプリの追加・端末の通知", href: section("device") });
  if (role === "OWNER" && input.articlesEnabled) account.push({ label: "記事連携", description: "記事ライターとのつながり", href: section("articles") });

  return [
    ...(seller.length ? [{ label: "販売者" as const, items: seller }] : []),
    ...(operations.length ? [{ label: "運営" as const, items: operations }] : []),
    { label: "アカウント" as const, items: account },
  ];
}
