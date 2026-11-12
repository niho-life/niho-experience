"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { HostIcon, type HostIconName } from "@/components/host/HostIcon";
import { InitialAvatar } from "@/components/host/ui";
import { isAdminSectionActive, type AdminSection, type AdminSectionKey } from "@/lib/admin/sections";

/** Same frame as the host console (HostNav): the sidebar on PC, the top band and the bottom tabs on phones. */
const NAV_LABEL = "管理メニュー";
const ENTRY_PATH = "/admin";
const TRAVELER_SITE_PATH = "/experiences";
const PHONE_TAB_LIMIT = 5;
const MENU_LINK = "flex min-h-11 items-center gap-2 rounded-[10px] px-2.5 text-[0.8125rem] font-bold text-ink-soft hover:bg-sand hover:text-ink";
const SCOPE_PILL = "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full bg-sand px-[7px] text-xs font-extrabold text-ink-soft";

export type AdminAccountKind = "google" | "niho" | "preview";
const ACCOUNT_KIND_LABEL: Record<AdminAccountKind, string> = { google: "Google アカウント", niho: "NIHO アカウント", preview: "プレビュー" };

const ICONS: Record<AdminSectionKey, HostIconName> = {
  bookings: "calendar",
  "site-bookings": "bookings",
  notifications: "bell",
  inquiries: "article",
  products: "providers",
  operators: "operators",
  preparations: "article",
  channels: "experiences",
};

const TAB_COLUMNS: Readonly<Record<number, string>> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };

export interface AdminChromeProps {
  sections: readonly AdminSection[];
  actorName: string | null;
  accountKind: AdminAccountKind;
  unreadCount: number | null;
}

const homeOf = (sections: readonly AdminSection[]) => sections[0]?.href ?? ENTRY_PATH;

function UnreadBadge({ count, className = "" }: { count: number | null; className?: string }) {
  if (count === null || count <= 0) return null;
  return <span aria-label={`未読${count}件`} aria-live="polite" className={`inline-flex min-w-5 items-center justify-center rounded-full bg-warn px-1.5 text-xs leading-5 font-bold text-white ${className}`.trim()}>{count}</span>;
}

/** Both widths use one account menu; the phone variant also owns the modal-like inert behavior and the sections past the tabs. */
function AccountMenu({ sections, actorName, accountKind, variant }: Pick<AdminChromeProps, "sections" | "actorName" | "accountKind"> & { variant: "mobile" | "sidebar" }) {
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  const close = useCallback(() => menu.current?.removeAttribute("open"), []);
  useEffect(() => {
    const details = menu.current;
    const syncMainInert = () => {
      const main = document.getElementById("main");
      if (main && variant === "mobile") main.inert = Boolean(details?.open);
    };
    const closeFromOutside = (event: PointerEvent) => {
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) close();
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (details?.open && event.key === "Escape") {
        event.preventDefault();
        close();
        details.querySelector("summary")?.focus();
      }
    };
    details?.addEventListener("toggle", syncMainInert);
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      details?.removeEventListener("toggle", syncMainInert);
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
      const main = document.getElementById("main");
      if (main && variant === "mobile") main.inert = false;
    };
  }, [close, variant]);
  if (!actorName) return null;
  const sidebar = variant === "sidebar";
  const overflow = sidebar ? [] : sections.slice(PHONE_TAB_LIMIT);
  return (
    <details ref={menu} className="relative group">
      <summary className={sidebar ? "flex min-h-12 cursor-pointer list-none items-center gap-2.5 border-t border-line px-2.5 pt-3 [&::-webkit-details-marker]:hidden" : "grid size-11 cursor-pointer list-none place-items-center rounded-full [&::-webkit-details-marker]:hidden"}>
        <InitialAvatar name={actorName} className="size-[30px] text-[0.8125rem]" />
        {sidebar ? <><span className="min-w-0 flex-1 truncate text-left text-[0.78125rem] leading-[1.3] font-extrabold">{actorName}</span><HostIcon name="chevronDown" className="size-4 text-muted group-open:rotate-180" /></> : null}
        <span className="sr-only">{`${actorName}のアカウントメニュー`}</span>
      </summary>
      <div className={sidebar ? "absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-[204px] rounded-2xl border border-line bg-canvas p-1.5 shadow-[var(--shadow-card)]" : "absolute top-full right-0 z-30 mt-1 w-64 max-w-[calc(100vw-1rem)] rounded-2xl border border-line bg-canvas p-1.5 shadow-[var(--shadow-card)]"}>
        <div className="px-2.5 pt-1.5 pb-2.5">
          <p className="font-extrabold break-words">{actorName}</p>
          <p className="text-xs text-muted">{ACCOUNT_KIND_LABEL[accountKind]}</p>
        </div>
        {overflow.length > 0 ? (
          <div className="flex flex-col gap-0.5 border-t border-line py-1">
            {overflow.map((section) => (
              <Link key={section.key} href={section.href} aria-current={isAdminSectionActive(pathname, section.href) ? "page" : undefined} onClick={close} className={MENU_LINK}>
                <HostIcon name={ICONS[section.key]} className="size-3.5" />
                <span>{section.label}</span>
              </Link>
            ))}
          </div>
        ) : null}
        <div className="flex flex-col gap-0.5 border-t border-line py-1">
          {/* The traveler site has its own root layout: a plain link, so the browser loads it as a new page. */}
          <a href={TRAVELER_SITE_PATH} onClick={close} className={MENU_LINK}>
            <HostIcon name="external" className="size-3.5" />
            <span>体験サイトを見る</span>
          </a>
        </div>
        <form method="post" action="/admin/auth/logout" className="border-t border-line pt-1">
          <button type="submit" className={`${MENU_LINK} w-full`}>
            ログアウト
          </button>
        </form>
      </div>
    </details>
  );
}

/** PC (md and up): the 232px sidebar with the brand, the sections the sign-in can use, and the account menu at its foot. */
export function AdminSidebar({ sections, actorName, accountKind, unreadCount }: AdminChromeProps) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 hidden h-dvh flex-col overflow-y-auto border-r border-line bg-canvas px-3 pt-[18px] pb-3.5 md:flex">
      <p className="-mr-2 flex items-center gap-1.5 pt-1 pr-0 pb-4 pl-2.5">
        <Link href={homeOf(sections)} className="font-display text-[1.1875rem] leading-[1.1] font-medium tracking-[-0.01em] whitespace-nowrap">
          NIHO Experience
        </Link>
        <span className={SCOPE_PILL}>管理</span>
      </p>
      {sections.length > 0 ? (
        <nav aria-label={NAV_LABEL}>
          <ul className="flex flex-col gap-0.5">
            {sections.map((section) => {
              const active = isAdminSectionActive(pathname, section.href);
              return (
                <li key={section.key}>
                  <Link
                    href={section.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex h-10 items-center gap-2.5 rounded-[10px] px-2.5 font-bold ${active ? "bg-sand text-ink" : "text-ink-soft hover:bg-sand/60 hover:text-ink"}`}
                  >
                    <HostIcon name={ICONS[section.key]} className="size-[18px]" />
                    <span className="min-w-0 flex-1">{section.label}</span>
                    {section.key === "notifications" ? <UnreadBadge count={unreadCount} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
      <div className="mt-auto pt-3">
        <AccountMenu sections={sections} actorName={actorName} accountKind={accountKind} variant="sidebar" />
      </div>
    </header>
  );
}

/** Phones: brand, the scope pill and the account. */
export function AdminMobileHeader({ sections, actorName, accountKind }: Omit<AdminChromeProps, "unreadCount">) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas md:hidden">
      <div className="flex h-[52px] items-center gap-2.5 pr-2 pl-4">
        <p className="flex min-w-0 flex-1 items-center gap-1.5">
          <Link href={homeOf(sections)} className="truncate font-display text-[1.0625rem] leading-none font-medium tracking-[-0.01em]">
            NIHO Experience
          </Link>
          <span className={SCOPE_PILL}>管理</span>
        </p>
        <AccountMenu sections={sections} actorName={actorName} accountKind={accountKind} variant="mobile" />
      </div>
    </header>
  );
}

/** Phones: the first five sections as bottom tabs; the rest are in the account menu. */
export function AdminTabBar({ sections, unreadCount }: Pick<AdminChromeProps, "sections" | "unreadCount">) {
  const pathname = usePathname();
  const tabs = sections.slice(0, PHONE_TAB_LIMIT);
  if (tabs.length === 0) return null;
  return (
    <>
      {/* Keeps the end of the page clear of the fixed bar. */}
      <div aria-hidden="true" className="h-[var(--host-tabbar)] md:hidden" />
      <nav aria-label={NAV_LABEL} className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-canvas px-1 pt-1.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] md:hidden">
        <ul className={`grid ${TAB_COLUMNS[tabs.length]}`}>
          {tabs.map((section) => {
            const active = isAdminSectionActive(pathname, section.href);
            return (
              <li key={section.key}>
                <Link
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex h-[46px] flex-col items-center justify-center gap-0.5 rounded-[10px] text-xs leading-tight font-bold ${active ? "text-ink" : "text-muted hover:text-ink"}`}
                >
                  <HostIcon name={ICONS[section.key]} className="size-[22px]" />
                  <span>{section.label}</span>
                  {/* After the label in the DOM, so the link is named 通知 未読N件; drawn at the icon's upper right. */}
                  {section.key === "notifications" ? <UnreadBadge count={unreadCount} className="absolute top-0 left-[calc(50%+4px)] !min-w-4 !px-1 leading-4" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
