/*
 * 管理画面 (#542) のメニュー: 今のログインで使えるものだけ、決まった順番で。純粋関数で、React にもサーバー API にも依存しない
 * (flag の組み立ては sections-server.ts)。
 */

export type AdminSectionKey = "bookings" | "site-bookings" | "notifications" | "inquiries" | "people" | "products" | "operators" | "preparations" | "channels";

export interface AdminSectionFlags {
  bookingSupport: boolean;
  siteBookings: boolean;
  notifications: boolean;
  inquiries: boolean;
  people: boolean;
  products: boolean;
  operators: boolean;
  preparations: boolean;
  channels: boolean;
}

export interface AdminSection {
  key: AdminSectionKey;
  href: string;
  label: string;
}

const SECTIONS: readonly (AdminSection & { flag: keyof AdminSectionFlags })[] = [
  { key: "bookings", href: "/admin/bookings", label: "予約支援", flag: "bookingSupport" },
  { key: "site-bookings", href: "/admin/site-bookings", label: "予約", flag: "siteBookings" },
  { key: "notifications", href: "/admin/notifications", label: "通知", flag: "notifications" },
  { key: "inquiries", href: "/admin/inquiries", label: "相談", flag: "inquiries" },
  { key: "products", href: "/admin/products", label: "提供者", flag: "products" },
  { key: "people", href: "/admin/people", label: "街の人", flag: "people" },
  { key: "operators", href: "/admin/operators", label: "運営者", flag: "operators" },
  { key: "preparations", href: "/admin/preparations", label: "掲載準備", flag: "preparations" },
  { key: "channels", href: "/admin/channels", label: "掲載先", flag: "channels" },
];

export const NO_ADMIN_SECTION_FLAGS: AdminSectionFlags = { bookingSupport: false, siteBookings: false, notifications: false, inquiries: false, people: false, products: false, operators: false, preparations: false, channels: false };

export function adminSections(flags: AdminSectionFlags): AdminSection[] {
  return SECTIONS.filter((section) => flags[section.flag]).map(({ key, href, label }) => ({ key, href, label }));
}

/** Where /admin/* pages that are not available for this sign-in send the person: the first menu item, or nothing. */
export function adminHomePath(flags: AdminSectionFlags): string | null {
  return adminSections(flags)[0]?.href ?? null;
}

/**
 * On phones the page for one provider (/admin/products/<id>, this level only) brings its own "‹ 提供者" band and no bottom
 * tabs, like the host console's pages under a section. null everywhere else.
 */
export function adminBackLink(pathname: string): { href: string; label: string } | null {
  return /^\/admin\/products\/[^/]+\/?$/.test(pathname) ? { href: "/admin/products", label: "提供者" } : null;
}

/** The menu item that is current: the path is the section's own or one under it. */
export function isAdminSectionActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
