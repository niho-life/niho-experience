import { HOST_BOOKINGS_PATH, HOST_HOME_PATH, HOST_MESSAGES_PATH, HOST_NAV, HOST_REVIEWS_PATH, HOST_SUPPORT_PATH } from "@/lib/host/routes";

/** Path only: `?providerId=` (and any other query or hash) never changes which item is selected. */
function pathOf(location: string): string {
  const path = location.split(/[?#]/, 1)[0] ?? "";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Screens of their own that live under ホーム without a menu item: メッセージ (#106) and レビュー
 * (#108). The menu keeps ホーム selected and phones get "‹ ホーム" instead of the brand header and
 * the bottom tabs.
 */
const HOME_SUB_SCREENS: readonly string[] = [HOST_MESSAGES_PATH, HOST_REVIEWS_PATH, HOST_SUPPORT_PATH];

const isUnder = (path: string, target: string) => path === target || path.startsWith(`${target}/`);

/** The menu item for a location: its own page and the pages under it (/host/experiences/{id}, and ホーム's screens). */
export function isHostNavActive(location: string, href: string): boolean {
  const path = pathOf(location);
  const target = pathOf(href);
  if (isUnder(path, target)) return true;
  return target === HOST_HOME_PATH && HOME_SUB_SCREENS.some((screen) => isUnder(path, screen));
}

/** The query of a location ("a=1" from "/host/bookings?a=1#x"). */
function queryOf(location: string): string {
  const at = location.indexOf("?");
  return at < 0 ? "" : (location.slice(at + 1).split("#", 1)[0] ?? "");
}

/**
 * Sub screens that live in a page's query instead of a path of their own, so the page keeps its
 * list's state: one booking of 予約 (`/host/bookings?booking=…`, #90) and one thread of
 * メッセージ (`?thread=…`, or a booking's thread to start: `?booking=…`, #106).
 */
const QUERY_SUB_SCREENS: readonly { path: string; params: readonly string[]; label: string }[] = [
  { path: HOST_BOOKINGS_PATH, params: ["booking"], label: "予約" },
  { path: HOST_MESSAGES_PATH, params: ["thread", "booking"], label: "メッセージ" },
];

/**
 * Pages under a menu item, ホーム's own screens and the sub screens above get a "‹ 体験" back
 * header on phones instead of the brand header and the bottom tabs. Returns where it leads back
 * to, or null on the five top pages. `search` is the page's query (useSearchParams); without
 * it, the query written in `location` counts.
 */
export function hostBackLink(location: string, search?: string | URLSearchParams | null): { href: string; label: string } | null {
  const path = pathOf(location);
  for (const item of HOST_NAV) {
    if (item.href !== HOST_HOME_PATH && path.startsWith(`${item.href}/`)) return { href: item.href, label: item.label };
  }
  const query = new URLSearchParams(search ?? queryOf(location));
  for (const sub of QUERY_SUB_SCREENS) {
    if (path === sub.path && sub.params.some((param) => query.get(param))) return { href: sub.path, label: sub.label };
  }
  if (HOME_SUB_SCREENS.some((screen) => isUnder(path, screen))) return { href: HOST_HOME_PATH, label: "ホーム" };
  return null;
}

/**
 * Where switching the provider goes from a location: the same page, except a page under a
 * section (one experience), which may not exist for the other provider: its section.
 */
export function providerSwitchPath(location: string): string {
  const path = pathOf(location);
  for (const item of HOST_NAV) {
    if (item.href !== HOST_HOME_PATH && path.startsWith(`${item.href}/`)) return item.href;
  }
  return path;
}
