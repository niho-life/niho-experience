"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { hostBackLink, isHostNavActive, providerSwitchPath } from "@/host/nav";
import { hasOwnerMembership, nihoIdOrNull, providerRoleLabel, selectProvider, type HostConsoleChoice, type HostProviderRole } from "@/lib/host/providers";
import { hostSupportPath, HOST_ACCOUNT_PATH, HOST_DAILY_NAV, HOST_HOME_PATH, HOST_LOGOUT_PATH, HOST_MEMBERS_PATH, HOST_NAV, withProvider } from "@/lib/host/routes";
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
  "/host/members": "members",
  "/host/settings": "settings",
};

/** The traveler site has its own root layout: a plain link, so the browser loads it as a new page. */
const TRAVELER_SITE_PATH = "/experiences";
/** Experience-owned article writer, on the same origin and the same host session. */
const WRITER_LINK_LABEL = "記事を書く";

const MENU_LINK = "flex min-h-11 items-center gap-2 rounded-[10px] px-2.5 text-[0.8125rem] font-bold text-ink-soft hover:bg-sand hover:text-ink";

export interface HostChromeProps {
  account: HostAccount;
  providers: readonly HostConsoleChoice[];
  /** NIHO's own app (NEXT_PUBLIC_NIHO_WEB_ORIGIN). */
  nihoAppUrl: string;
  /** Same-origin writer path. */
  writePath?: string;
}

export interface HostWriterArticle {
  readonly id: string;
  readonly title: string;
  readonly status: "DRAFT" | "PUBLISHED" | "STOPPED" | "OPS_STOPPED";
  readonly statusLabel: string;
}

export interface HostWriterNavigation {
  readonly articles: readonly HostWriterArticle[];
  readonly activeArticleId?: string;
  readonly articlesAvailable?: boolean;
  readonly onNavigate?: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onNewArticle?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

/** Tailwind needs to see each possible column class as a complete string. */
const TAB_COLUMNS: Readonly<Record<number, string>> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" };

export function hostNavForRole(role: HostProviderRole | null | undefined) {
  if (role === "OWNER") return HOST_NAV;
  if (role === "EDITOR") return HOST_NAV.filter((item) => item.href !== "/host/sales" && item.href !== "/host/bookings" && item.href !== HOST_MEMBERS_PATH);
  return HOST_NAV.filter((item) => item.href !== "/host/sales" && item.href !== HOST_MEMBERS_PATH);
}

export function hostNavForChoice(choice: HostConsoleChoice | null | undefined) {
  if (choice?.kind === "OPERATOR") {
    // A product operator's screens (docs/product-operators.md): カレンダー, 予約 for the OTA bookings of their products and
    // 設定 for their own email address (#194). They never see メンバー.
    const screens = choice.screens ?? ["/host/calendar"];
    return HOST_NAV.filter((item) => item.href !== HOST_MEMBERS_PATH && (item.href === "/host/calendar" || screens.includes(item.href)));
  }
  return hostNavForRole(choice?.memberRole);
}

/** The bottom tabs: the daily sections only (no メンバー or 設定), within the permissioned set above. */
export function hostDailyNavForChoice(choice: HostConsoleChoice | null | undefined) {
  return hostNavForChoice(choice).filter((item) => HOST_DAILY_NAV.some((daily) => daily.href === item.href));
}

export function hostWriterNavAllowed(choice: HostConsoleChoice | null | undefined, writePath?: string, articleOnly = false) {
  return Boolean(writePath) && (choice?.kind === "MEMBER" && choice.memberRole === "OWNER" || articleOnly);
}

/** The chosen provider lives in `?providerId=`; every console link carries it. */
function useProviderId(): string | null {
  return nihoIdOrNull(useSearchParams().get("providerId"));
}

/** What the person is to this provider ("オーナー"), or null when there is none to tell. */
function choiceRoleLabel(choice: HostConsoleChoice): string | null {
  return choice.kind === "OPERATOR" ? "商品運営者" : providerRoleLabel(choice.memberRole);
}

/** Fired when a header/sidebar menu opens, so the other one closes. */
const MENU_OPENED_EVENT = "host-menu-opened";

/**
 * Shared behavior of the `<details>` menus: closes on an outside press and on Escape (focus returns to its summary),
 * closes when the other menu opens, and, for the phone menus (`modal`), keeps #main inert while any of them is open.
 */
function useDetailsMenu(modal: boolean): { menu: RefObject<HTMLDetailsElement | null>; close: () => void } {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = useCallback(() => menu.current?.removeAttribute("open"), []);
  useEffect(() => {
    const details = menu.current;
    const syncMainInert = () => {
      const main = document.getElementById("main");
      if (main && modal) main.inert = document.querySelector("details[data-host-modal-menu][open]") !== null;
    };
    const onToggle = () => {
      if (details?.open) document.dispatchEvent(new CustomEvent(MENU_OPENED_EVENT, { detail: details }));
      syncMainInert();
    };
    const closeFromOther = (event: Event) => {
      if (details?.open && (event as CustomEvent<unknown>).detail !== details) close();
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
    details?.addEventListener("toggle", onToggle);
    document.addEventListener(MENU_OPENED_EVENT, closeFromOther);
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      details?.removeEventListener("toggle", onToggle);
      document.removeEventListener(MENU_OPENED_EVENT, closeFromOther);
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
      if (modal) queueMicrotask(syncMainInert);
    };
  }, [close, modal]);
  return { menu, close };
}

function ProviderLinks({ providers, currentId, onPick, basePath }: { providers: readonly HostConsoleChoice[]; currentId: string; onPick: () => void; basePath?: string }) {
  const pathname = usePathname();
  // A page under a section (one experience) may not exist for the other provider: switch to the section itself.
  const base = basePath ?? providerSwitchPath(pathname);
  return (
    <ul className="flex flex-col gap-0.5">
      {providers.map((provider) => {
        const selected = provider.id === currentId;
        const role = choiceRoleLabel(provider);
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
function SidebarProviderSwitcher({ providers, providerIdOverride, basePath }: { providers: readonly HostConsoleChoice[]; providerIdOverride?: string; basePath?: string }) {
  const routeProviderId = useProviderId();
  const providerId = providerIdOverride ?? routeProviderId;
  const menu = useRef<HTMLDetailsElement>(null);
  const { provider: current } = selectProvider(providers, providerId);
  if (!current) return null;
  const role = choiceRoleLabel(current);
  const face = (
    <>
      <InitialAvatar name={current.displayName} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[0.8125rem] font-extrabold">{current.displayName}</span>
        {role ? <span className="block truncate text-xs text-muted">あなたは{role}</span> : null}
      </span>
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
        <ProviderLinks providers={providers} currentId={current.id} onPick={() => menu.current?.removeAttribute("open")} basePath={basePath} />
      </div>
    </details>
  );
}

/**
 * PC (md and up): the 232px sidebar with the brand, the provider (and the role in it), the sections the role may open
 * (メンバー and 設定 included) and, at its foot, the traveler site and the person's own account menu.
 */
export function HostSidebar({ account, providers, nihoAppUrl, writePath, writerNavigation, providerIdOverride }: HostChromeProps & { readonly writerNavigation?: HostWriterNavigation; readonly providerIdOverride?: string }) {
  const pathname = usePathname();
  const routeProviderId = useProviderId();
  const providerId = providerIdOverride ?? routeProviderId;
  const { provider: current } = selectProvider(providers, providerId);
  const writerAllowed = hostWriterNavAllowed(current, writePath, writerNavigation !== undefined && providers.length === 0);
  const writerActive = pathname === "/write" || pathname.startsWith("/write/");
  const captureNavigation = (event: ReactMouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (anchor) {
      const href = anchor.getAttribute("href") ?? "";
      const sameTabInternal = anchor.target !== "_blank"
        && !anchor.hasAttribute("download")
        && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
        && href.startsWith("/") && !href.startsWith("//");
      if (!sameTabInternal) return;
    } else if (!event.target.closest("button[type='submit']")) {
      return;
    }
    writerNavigation?.onNavigate?.(event);
  };
  const writerItem = writerAllowed ? (
    <li className="mt-2 border-t border-line pt-2">
      <div className={`flex h-10 items-center rounded-[10px] ${writerActive ? "bg-sand text-ink" : "text-ink-soft hover:bg-sand/60 hover:text-ink"}`}>
        <Link href={writePath!} aria-current={writerActive && !writerNavigation?.activeArticleId ? "page" : undefined} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 font-bold">
          <HostIcon name="article" className="size-[18px]" />
          <span>記事</span>
        </Link>
        {writerNavigation ? <button type="button" onClick={writerNavigation.onNewArticle} aria-label="新しい記事" className="grid size-9 place-items-center rounded-[9px] hover:bg-line"><HostIcon name="plus" className="size-4" /></button> : null}
      </div>
      {writerNavigation ? (
        writerNavigation.articles.length ? <><ul className="mt-1 flex flex-col gap-0.5 pl-7">
          {writerNavigation.articles.map((article) => {
            const active = article.id === writerNavigation.activeArticleId;
            const tone = article.status === "PUBLISHED" ? "bg-moss" : article.status === "DRAFT" ? "bg-muted" : "bg-danger";
            return <li key={article.id}><Link href={`/write/${encodeURIComponent(article.id)}`} aria-current={active ? "page" : undefined} className={`flex min-h-9 items-start gap-2 rounded-[9px] px-2 py-2 text-xs leading-[1.35] ${active ? "bg-leaf-pale font-extrabold text-ink" : "font-bold text-ink-soft hover:bg-sand"}`}><span aria-hidden="true" className={`mt-1 size-1.5 shrink-0 rounded-full ${tone}`} /><span className="min-w-0"><span className="block truncate">{article.title || "無題の記事"}</span><span className="block font-normal text-muted">{article.statusLabel}</span></span></Link></li>;
          })}
        </ul>{writerNavigation.articlesAvailable === false ? <p role="status" className="py-2 pl-9 text-xs text-danger">記事一覧を読み込めませんでした</p> : null}</> : writerNavigation.articlesAvailable === false ? <p role="status" className="py-2 pl-9 text-xs text-danger">記事一覧を読み込めませんでした</p> : <p className="py-2 pl-9 text-xs text-muted">まだ記事はありません</p>
      ) : null}
    </li>
  ) : null;
  return (
    <header onClickCapture={captureNavigation} className="sticky top-0 hidden h-dvh flex-col overflow-y-auto border-r border-line bg-canvas px-3 pt-[18px] pb-3.5 md:flex">
      <p className="px-2.5 pt-1 pb-4">
        <Link href={writerNavigation && providers.length === 0 ? writePath! : withProvider(current?.kind === "OPERATOR" ? "/host/calendar" : HOST_HOME_PATH, providerId)} className="font-display text-[1.1875rem] leading-[1.1] font-medium tracking-[-0.01em] whitespace-nowrap">
          NIHO Experience
        </Link>
      </p>
      {providers.length > 0 ? (
        <>
          <SidebarProviderSwitcher providers={providers} providerIdOverride={providerIdOverride} basePath={writerNavigation ? HOST_HOME_PATH : undefined} />
          <nav aria-label={NAV_LABEL}>
            <ul className="flex flex-col gap-0.5">
              {hostNavForChoice(current).map((item) => {
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
              {writerItem}
            </ul>
          </nav>
        </>
      ) : null}
      {providers.length === 0 && writerItem ? <nav aria-label={NAV_LABEL}><ul>{writerItem}</ul></nav> : null}
      <div className="mt-auto pt-3">
        {current?.kind !== "OPERATOR" ? <a href={TRAVELER_SITE_PATH} className="mb-2 flex h-10 items-center gap-2.5 rounded-[10px] px-2.5 font-bold text-ink-soft hover:bg-sand/60 hover:text-ink">
          <HostIcon name="external" className="size-[18px]" />
          <span>体験サイトを見る</span>
        </a> : null}
        <AccountMenu account={account} providers={providers} nihoAppUrl={nihoAppUrl} writePath={writePath} variant="sidebar" providerIdOverride={providerIdOverride} />
      </div>
    </header>
  );
}

/** The person's own menu (not the provider's); both widths use it, the phone variant also owns the modal-like inert behavior. */
function AccountMenu({ account, providers, nihoAppUrl, writePath, variant = "mobile", providerIdOverride }: HostChromeProps & { variant?: "mobile" | "sidebar"; providerIdOverride?: string }) {
  const routeProviderId = useProviderId();
  const providerId = providerIdOverride ?? routeProviderId;
  const sidebar = variant === "sidebar";
  const { menu, close } = useDetailsMenu(!sidebar);
  const { provider: current } = selectProvider(providers, providerId);
  const writerHref = writePath && current?.kind !== "OPERATOR" && hasOwnerMembership(providers) ? writePath : undefined;
  const name = account.displayName || "NIHO アカウント";
  return (
    <details ref={menu} data-host-modal-menu={sidebar ? undefined : ""} className="relative group">
      <summary className={sidebar ? "flex min-h-12 cursor-pointer list-none items-center gap-2.5 border-t border-line px-2.5 pt-3 [&::-webkit-details-marker]:hidden" : "grid size-11 cursor-pointer list-none place-items-center rounded-full [&::-webkit-details-marker]:hidden"}>
        <AccountAvatar account={account} className="size-[30px] text-[0.8125rem]" />
        {sidebar ? <><span className="min-w-0 flex-1 text-left"><span className="block truncate text-[0.78125rem] leading-[1.3] font-extrabold">{name}</span><span className="block text-xs leading-[1.3] text-muted">あなたのアカウント</span></span><HostIcon name="chevronDown" className="size-4 text-muted group-open:rotate-180" /></> : null}
        <span className="sr-only">{sidebar ? `${name}のアカウントメニュー` : `${name}のアカウント`}</span>
      </summary>
      <div className={sidebar ? "absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-[204px] rounded-2xl border border-line bg-canvas p-1.5 shadow-[var(--shadow-card)]" : "absolute top-full right-0 z-30 mt-1 w-64 max-w-[calc(100vw-1rem)] rounded-2xl border border-line bg-canvas p-1.5 shadow-[var(--shadow-card)]"}>
        <div className="px-2.5 pt-1.5 pb-2.5">
          <p className="font-extrabold break-words">{name}</p>
          <p className="text-xs text-muted">あなたのアカウント</p>
        </div>
        <div className="flex flex-col gap-0.5 border-t border-line py-1">
          <Link href={withProvider(HOST_ACCOUNT_PATH, providerId)} onClick={close} className={MENU_LINK}>
            <HostIcon name="settings" className="size-3.5" />
            <span>アカウント設定</span>
          </Link>
          {!current ? <Link href={hostSupportPath()} onClick={close} className={MENU_LINK}>
            <HostIcon name="settings" className="size-3.5" />
            <span>NIHOサポート</span>
          </Link> : null}
          {writerHref ? <a href={writerHref} onClick={close} className={MENU_LINK}>
            <HostIcon name="external" className="size-3.5" />
            <span>{WRITER_LINK_LABEL}</span>
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

/** Phones: the provider chip. Opens the provider's own places (メンバー・設定), the traveler site and, with several providers, the switcher. */
function MobileProviderMenu({ providers, providerId, basePath }: { providers: readonly HostConsoleChoice[]; providerId: string | null; basePath?: string }) {
  const { menu, close } = useDetailsMenu(true);
  const pathname = usePathname();
  const { provider: current } = selectProvider(providers, providerId);
  if (!current) return null;
  const extra = hostNavForChoice(current).filter((item) => !HOST_DAILY_NAV.some((daily) => daily.href === item.href));
  return (
    <details ref={menu} data-host-modal-menu="" className="group relative min-w-0">
      <summary className="flex min-h-11 max-w-full cursor-pointer list-none items-center gap-2 rounded-xl pr-1.5 hover:bg-sand [&::-webkit-details-marker]:hidden">
        <InitialAvatar name={current.displayName} />
        <span className="min-w-0 flex-1 truncate text-[0.9375rem] leading-tight font-extrabold">{current.displayName}</span>
        <HostIcon name="chevronDown" className="size-4 text-muted group-open:rotate-180" />
        <span className="sr-only">{`${current.displayName}のメニュー`}</span>
      </summary>
      <div className="absolute top-full left-0 z-30 mt-1 w-64 max-w-[calc(100vw-1rem)] rounded-2xl border border-line bg-canvas p-1.5 shadow-[var(--shadow-card)]">
        <div className="flex flex-col gap-0.5">
          {extra.map((item) => (
            <Link key={item.href} href={withProvider(item.href, providerId)} aria-current={isHostNavActive(pathname, item.href) ? "page" : undefined} onClick={close} className={MENU_LINK}>
              <HostIcon name={NAV_ICONS[item.href]} className="size-3.5" />
              <span>{item.label}</span>
            </Link>
          ))}
          {current.kind !== "OPERATOR" ? <a href={TRAVELER_SITE_PATH} onClick={close} className={MENU_LINK}>
            <HostIcon name="external" className="size-3.5" />
            <span>体験サイトを見る</span>
          </a> : null}
        </div>
        {providers.length > 1 ? (
          <div className="mt-1 border-t border-line pt-2 pb-1">
            <p className="px-2.5 pb-1 text-xs font-bold text-muted">提供者を切り替える</p>
            <ProviderLinks providers={providers} currentId={current.id} onPick={close} basePath={basePath} />
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** Phones, on the top pages: the provider (brand when there is none) and the person's account. Pages under a section or ホーム (and one booking, `?booking=`) bring their own "‹ 体験" header. */
export function HostMobileHeader(props: HostChromeProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const providerId = useProviderId();
  const providers = props.providers;
  if (hostBackLink(pathname, searchParams)) return null;
  const hasProvider = selectProvider(providers, providerId).provider !== null;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas md:hidden">
      <div className="flex h-[52px] items-center gap-2.5 pr-2 pl-4">
        {hasProvider ? (
          <div className="flex min-w-0 flex-1"><MobileProviderMenu providers={providers} providerId={providerId} /></div>
        ) : (
          <p className="min-w-0 flex-1 truncate">
            <Link href={withProvider(HOST_HOME_PATH, providerId)} className="font-display text-[1.0625rem] leading-none font-medium tracking-[-0.01em]">
              NIHO Experience
            </Link>
          </p>
        )}
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
