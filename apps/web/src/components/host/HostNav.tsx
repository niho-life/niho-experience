"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { hostBackLink, isHostNavActive, providerSwitchPath } from "@/host/nav";
import { nihoIdOrNull, providerRoleLabel, selectProvider, type HostConsoleChoice, type HostProviderRole } from "@/lib/host/providers";
import { hostSupportPath, HOST_DAILY_NAV, HOST_HOME_PATH, HOST_LOGOUT_PATH, HOST_NAV, HOST_SETTINGS_PATH, withProvider } from "@/lib/host/routes";
import { HostIcon, type HostIconName } from "./HostIcon";
import { AccountAvatar, InitialAvatar, type HostAccount } from "./ui";

/** The sidebar (PC) and the bottom tabs (phones) share one name; only the one for the screen width is shown. */
const NAV_LABEL = "ホストのメニュー";

const NAV_ICONS: Record<(typeof HOST_NAV)[number]["href"], HostIconName> = {
  "/host/home": "home",
  "/host/experiences": "experiences",
  "/host/calendar": "calendar",
  "/host/bookings": "bookings",
  "/host/sales": "sales",
  "/host/settings": "settings",
};

/** The traveler site has its own root layout: a plain link, so the browser loads it as a new page. */
const TRAVELER_SITE_PATH = "/experiences";
/** Experience-owned article writer, on the same origin and the same host session. */
const EDITOR_LINK_LABEL = "記事を書く";

const MENU_LINK = "flex min-h-11 items-center gap-2 rounded-[10px] px-2.5 text-[0.8125rem] font-bold text-ink-soft hover:bg-sand hover:text-ink";

export interface HostChromeProps {
  account: HostAccount;
  providers: readonly HostConsoleChoice[];
  /** NIHO's own app (NEXT_PUBLIC_NIHO_WEB_ORIGIN). */
  nihoAppUrl: string;
  /** Same-origin writer path. */
  editorUrl?: string;
}

/** Tailwind needs to see each possible column class as a complete string. */
const TAB_COLUMNS: Readonly<Record<number, string>> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };

export function hostNavForRole(role: HostProviderRole | null | undefined) {
  if (role === "OWNER") return HOST_NAV;
  if (role === "EDITOR") return HOST_NAV.filter((item) => item.href !== "/host/sales" && item.href !== "/host/bookings");
  return HOST_NAV.filter((item) => item.href !== "/host/sales");
}

export function hostNavForChoice(choice: HostConsoleChoice | null | undefined) {
  if (choice?.kind === "OPERATOR") {
    // A product operator's screens (docs/product-operators.md): カレンダー, 予約 for the OTA bookings of their products and
    // 設定 for their own email address (#194).
    const screens = choice.screens ?? ["/host/calendar"];
    return HOST_NAV.filter((item) => item.href === "/host/calendar" || screens.includes(item.href));
  }
  return hostNavForRole(choice?.memberRole);
}

/** Daily chrome excludes settings without changing the permissioned section set above. */
export function hostDailyNavForChoice(choice: HostConsoleChoice | null | undefined) {
  return hostNavForChoice(choice).filter((item) => HOST_DAILY_NAV.some((daily) => daily.href === item.href));
}

/** The chosen provider lives in `?providerId=`; every console link carries it. */
function useProviderId(): string | null {
  return nihoIdOrNull(useSearchParams().get("providerId"));
}

function ProviderLinks({ providers, currentId, onPick }: { providers: readonly HostConsoleChoice[]; currentId: string; onPick: () => void }) {
  const pathname = usePathname();
  // A page under a section (one experience) may not exist for the other provider: switch to the section itself.
  const base = providerSwitchPath(pathname);
  return (
    <ul className="flex flex-col gap-0.5">
      {providers.map((provider) => {
        const selected = provider.id === currentId;
        const role = provider.kind === "OPERATOR" ? "商品運営者" : providerRoleLabel(provider.memberRole);
        return (
          <li key={provider.id}>
            <Link
              href={withProvider(base, provider.id)}
              aria-current={selected ? "true" : undefined}
              onClick={onPick}
              className={`flex min-h-11 items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 ${selected ? "bg-sand" : "hover:bg-sand"}`}
            >
              <InitialAvatar name={provider.displayName} />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[0.8125rem] font-extrabold">{provider.displayName}</span>
                {role ? <span className="block text-xs text-muted">{role}</span> : null}
              </span>
              {selected ? <HostIcon name="check" className="size-4 text-ink" /> : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The provider being managed. With one provider it only shows it; with several it opens the list below it. */
function SidebarProviderSwitcher({ providers }: { providers: readonly HostConsoleChoice[] }) {
  const providerId = useProviderId();
  const menu = useRef<HTMLDetailsElement>(null);
  const { provider: current } = selectProvider(providers, providerId);
  if (!current) return null;
  const face = (
    <>
      <InitialAvatar name={current.displayName} />
      <span className="min-w-0 flex-1 truncate text-[0.8125rem] leading-tight font-extrabold">{current.displayName}</span>
    </>
  );
  if (providers.length === 1) return <div className="mb-3.5 flex items-center gap-2.5 rounded-xl border border-line px-2.5 py-2">{face}</div>;
  return (
    <details ref={menu} className="group mb-3.5">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl border border-line px-2.5 py-2 hover:bg-sand [&::-webkit-details-marker]:hidden">
        {face}
        <span className="sr-only">（提供者を切り替える）</span>
        <HostIcon name="chevronDown" className="size-4 text-muted group-open:rotate-180" />
      </summary>
      <div className="mt-1.5 rounded-xl border border-line p-1">
        <ProviderLinks providers={providers} currentId={current.id} onPick={() => menu.current?.removeAttribute("open")} />
      </div>
    </details>
  );
}

/**
 * PC (md and up): the 232px sidebar with the brand, the provider and the daily
 * sections. Settings and the ways out live in the account menu at its foot.
 */
export function HostSidebar({ account, providers, nihoAppUrl, editorUrl }: HostChromeProps) {
  const pathname = usePathname();
  const providerId = useProviderId();
  const { provider: current } = selectProvider(providers, providerId);
  return (
    <header className="sticky top-0 hidden h-dvh flex-col overflow-y-auto border-r border-line bg-canvas px-3 pt-[18px] pb-3.5 md:flex">
      <p className="px-2.5 pt-1 pb-4">
        <Link href={withProvider(current?.kind === "OPERATOR" ? "/host/calendar" : HOST_HOME_PATH, providerId)} className="font-display text-[1.1875rem] leading-[1.1] font-medium tracking-[-0.01em] whitespace-nowrap">
          NIHO Experience
        </Link>
      </p>
      {providers.length > 0 ? (
        <>
          <SidebarProviderSwitcher providers={providers} />
          <nav aria-label={NAV_LABEL}>
            <ul className="flex flex-col gap-0.5">
              {hostDailyNavForChoice(current).map((item) => {
                const active = isHostNavActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={withProvider(item.href, providerId)}
                      aria-current={active ? "page" : undefined}
                      className={`flex h-10 items-center gap-2.5 rounded-[10px] px-2.5 font-bold ${active ? "bg-sand text-ink" : "text-ink-soft hover:bg-sand/60 hover:text-ink"}`}
                    >
                      <HostIcon name={NAV_ICONS[item.href]} className="size-[18px]" />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </>
      ) : null}
      <div className="mt-auto pt-3">
        <AccountMenu account={account} providers={providers} nihoAppUrl={nihoAppUrl} editorUrl={editorUrl} variant="sidebar" />
      </div>
    </header>
  );
}

/** Both widths use one account menu; the phone variant also owns the modal-like inert behavior. */
function AccountMenu({ account, providers, nihoAppUrl, editorUrl, variant = "mobile" }: HostChromeProps & { variant?: "mobile" | "sidebar" }) {
  const pathname = usePathname();
  const providerId = useProviderId();
  const menu = useRef<HTMLDetailsElement>(null);
  const { provider: current } = selectProvider(providers, providerId);
  const name = account.displayName || "NIHO アカウント";
  const switchable = providers.length > 1 ? current : null;
  const settingsAllowed = current?.kind === "OPERATOR"
    ? (current.screens ?? ["/host/calendar"]).includes(HOST_SETTINGS_PATH)
    : Boolean(current);
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
  const sidebar = variant === "sidebar";
  return (
    <details ref={menu} className="relative group">
      <summary className={sidebar ? "flex min-h-12 cursor-pointer list-none items-center gap-2.5 border-t border-line px-2.5 pt-3 [&::-webkit-details-marker]:hidden" : "grid size-11 cursor-pointer list-none place-items-center rounded-full [&::-webkit-details-marker]:hidden"}>
        <AccountAvatar account={account} className="size-[30px] text-[0.8125rem]" />
        {sidebar ? <><span className="min-w-0 flex-1 text-left"><span className="block truncate text-[0.78125rem] leading-[1.3] font-extrabold">{name}</span><span className="block text-xs leading-[1.3] text-muted">アカウント・設定</span></span><HostIcon name="chevronDown" className="size-4 text-muted group-open:rotate-180" /></> : null}
        <span className="sr-only">{sidebar ? `${name}のアカウントメニュー` : switchable ? `${name}のアカウントと提供者の切り替え（表示中：${switchable.displayName}）` : `${name}のアカウント`}</span>
      </summary>
      <div className={sidebar ? "absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-[204px] rounded-2xl border border-line bg-canvas p-1.5 shadow-[var(--shadow-card)]" : "absolute top-full right-0 z-30 mt-1 w-64 max-w-[calc(100vw-1rem)] rounded-2xl border border-line bg-canvas p-1.5 shadow-[var(--shadow-card)]"}>
        <div className="px-2.5 pt-1.5 pb-2.5">
          <p className="font-extrabold break-words">{name}</p>
          <p className="text-xs text-muted">NIHO アカウント</p>
        </div>
        {switchable ? (
          <div className="border-t border-line pt-2 pb-1">
            <p className="px-2.5 pb-1 text-xs font-bold text-muted">提供者</p>
            <ProviderLinks providers={providers} currentId={switchable.id} onPick={close} />
          </div>
        ) : null}
        <div className="flex flex-col gap-0.5 border-t border-line py-1">
          {settingsAllowed ? <Link href={withProvider(HOST_SETTINGS_PATH, providerId)} aria-current={isHostNavActive(pathname, HOST_SETTINGS_PATH) ? "page" : undefined} onClick={close} className={MENU_LINK}>
            <HostIcon name="settings" className="size-3.5" />
            <span>設定</span>
          </Link> : null}
          {!current ? <Link href={hostSupportPath()} onClick={close} className={MENU_LINK}>
            <HostIcon name="settings" className="size-3.5" />
            <span>NIHOサポート</span>
          </Link> : null}
          {current?.kind !== "OPERATOR" ? <a href={TRAVELER_SITE_PATH} onClick={close} className={MENU_LINK}>
            <HostIcon name="external" className="size-3.5" />
            <span>体験サイトを見る</span>
          </a> : null}
          {editorUrl && current?.kind !== "OPERATOR" ? <a href={editorUrl} onClick={close} className={MENU_LINK}>
            <HostIcon name="external" className="size-3.5" />
            <span>{EDITOR_LINK_LABEL}</span>
          </a> : null}
          <a href={nihoAppUrl} onClick={close} className={MENU_LINK}>
            <HostIcon name="external" className="size-3.5" />
            <span>NIHO アプリ</span>
          </a>
        </div>
        <form method="post" action={HOST_LOGOUT_PATH} data-niho-navigation-form className="border-t border-line pt-1">
          <button type="submit" className={`${MENU_LINK} w-full`}>
            ログアウト
          </button>
        </form>
      </div>
    </details>
  );
}

/** Phones, on the five top pages: brand and account. Pages under a section or ホーム (and one booking, `?booking=`) bring their own "‹ 体験" header. */
export function HostMobileHeader(props: HostChromeProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const providerId = useProviderId();
  const providers = props.providers;
  if (hostBackLink(pathname, searchParams)) return null;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas md:hidden">
      <div className="flex h-[52px] items-center gap-2.5 pr-2 pl-4">
        <p className="min-w-0 flex-1 truncate">
          <Link href={withProvider(selectProvider(providers, providerId).provider?.kind === "OPERATOR" ? "/host/calendar" : HOST_HOME_PATH, providerId)} className="font-display text-[1.0625rem] leading-none font-medium tracking-[-0.01em]">
            NIHO Experience
          </Link>
        </p>
        <AccountMenu {...props} />
      </div>
    </header>
  );
}

/** Phones: the same role-appropriate daily sections as the desktop sidebar. */
export function HostTabBar({ providers }: { providers: readonly HostConsoleChoice[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const providerId = useProviderId();
  const { provider: current } = selectProvider(providers, providerId);
  if (hostBackLink(pathname, searchParams)) return null;
  return (
    <>
      {/* Keeps the end of the page clear of the fixed bar. */}
      <div aria-hidden="true" className="h-[var(--host-tabbar)] md:hidden" />
      <nav aria-label={NAV_LABEL} className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-canvas px-1 pt-1.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] md:hidden">
        <ul className={`grid ${TAB_COLUMNS[hostDailyNavForChoice(current).length] ?? "grid-cols-5"}`}>
          {hostDailyNavForChoice(current).map((item) => {
            const active = isHostNavActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={withProvider(item.href, providerId)}
                  aria-current={active ? "page" : undefined}
                  className={`flex h-[46px] flex-col items-center justify-center gap-0.5 rounded-[10px] text-xs leading-tight font-bold ${active ? "text-ink" : "text-muted hover:text-ink"}`}
                >
                  <HostIcon name={NAV_ICONS[item.href]} className="size-[22px]" />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
