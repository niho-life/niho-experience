import { nihoIdentityOutcomeOrNull } from "./niho-identity";
import { nihoIdOrNull, type HostProviderRole } from "./providers";
import { HOST_ACCOUNT_PATH, HOST_MEMBERS_PATH, HOST_PROFILE_PATH, HOST_SELLER_PATH, HOST_SETTINGS_PATH, hostSupportPath, withProvider, withQuery } from "./routes";

/** `team`, `device` and `account` only forward to their new screens (hostSettingsForwardPath). */
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
  team: "メンバー",
  support: "NIHOサポート",
  device: "この端末",
  account: "あなたのアカウント",
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
  readonly label: "掲載" | "販売" | "運営";
  readonly items: readonly HostSettingsIndexItem[];
}

/** Sections that moved out of 設定: the old `?section=` values only forward to the new screen. */
const FORWARDED_SECTIONS: readonly HostSettingsSection[] = ["account", "device", "team"];

const firstValue = (value: unknown): unknown => Array.isArray(value) ? value[0] : value;

/**
 * Where an old settings URL now lives: `section=account|device` → あなたのアカウント (`device` at its #account-device),
 * `section=team` → メンバー. Only `providerId` (and `niho` for the account, the sign-in outcome) are carried; null for
 * every other section.
 */
export function hostSettingsForwardPath(query: Readonly<Record<string, unknown>>): string | null {
  const section = hostSettingsSectionOrNull(query.section);
  if (!section || !FORWARDED_SECTIONS.includes(section)) return null;
  const providerId = nihoIdOrNull(firstValue(query.providerId));
  if (section === "team") return withProvider(HOST_MEMBERS_PATH, providerId);
  if (section === "device") return `${withProvider(HOST_ACCOUNT_PATH, providerId)}#account-device`;
  return withQuery(HOST_ACCOUNT_PATH, { providerId, niho: nihoIdentityOutcomeOrNull(firstValue(query.niho)) });
}

/**
 * The overview exposes only destinations the current role already has. It does not turn a visible
 * row into authorization; every destination keeps its existing server-side checks. The signed-in
 * person's own settings (login, this device) are not here: they live at /host/account.
 */
export function hostSettingsIndexGroups(input: {
  providerId: string;
  role: HostProviderRole | null;
  articlesEnabled: boolean;
}): readonly HostSettingsIndexGroup[] {
  const { providerId, role } = input;
  const section = (value: HostSettingsSection) => hostSettingsSectionPath(providerId, value);
  const listing: HostSettingsIndexItem[] = [];
  const selling: HostSettingsIndexItem[] = [];
  const operations: HostSettingsIndexItem[] = [];

  if (role === "OWNER" || role === "EDITOR") {
    listing.push({ label: "提供者情報", description: "掲載名・事業者の紹介", href: section("provider") });
  }
  if (role === "OWNER") {
    listing.push({ label: "ホスト紹介", description: "迎える人の紹介文", href: withProvider(HOST_PROFILE_PATH, providerId) });
    selling.push(
      { label: "販売者表示", description: "旅行者に公開する販売者の情報", href: withProvider(HOST_SELLER_PATH, providerId) },
      { label: "受取口座", description: "売上を受け取る口座", href: section("payout") },
    );
  }
  // Preserve the former account entry for every provider role; the API checks ownership.
  selling.push({ label: "NIHOサポート", description: "サポートの利用条件・手数料", href: hostSupportPath("EXPERIENCE_PROVIDER", providerId) });
  operations.push({ label: "カレンダー連携", description: "Google の予定と空き状況", href: section("calendar") });
  if (role === "OWNER" || role === "EDITOR") {
    operations.push({ label: "集合案内", description: "予約後に伝える場所と当日の案内", href: section("meeting") });
  }
  // Every signed-in provider role gets the notification switches; the panel keeps provider-wide ones permissioned.
  operations.push({ label: "通知の種類", description: "この提供者で受け取る通知", href: section("notifications") });
  if (role === "OWNER" && input.articlesEnabled) operations.push({ label: "記事連携", description: "記事ライターとのつながり", href: section("articles") });

  return [
    ...(listing.length ? [{ label: "掲載" as const, items: listing }] : []),
    ...(selling.length ? [{ label: "販売" as const, items: selling }] : []),
    ...(operations.length ? [{ label: "運営" as const, items: operations }] : []),
  ];
}
