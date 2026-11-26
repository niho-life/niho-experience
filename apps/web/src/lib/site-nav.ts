import { BOOKING_LOOKUP_SECTION_ID } from "@niho/experience-presentation/v1";
import type { ExperienceCategoryId } from "@niho-experience/experience-domain";
import { categoryLabel } from "./experience-categories";
import { HOST_HOME_PATH, HOST_LOGIN_PATH } from "./host/routes";
import type { SiteLocale } from "./localized-content";

export const JAPANESE_ABOUT_LABEL = "はじめての方へ";

export type SiteNavLink = Readonly<{ href: string; label: string }>;
export type SiteNavGroup = Readonly<{ label: string; links: readonly SiteNavLink[] }>;
type HeaderEntry = SiteNavLink & Readonly<{ short?: string; mobile?: boolean }>;

const COPY = {
  en: {
    explore: "Explore", experiences: "Experiences", all: "All experiences",
    plan: "Plan your visit", about: "About", help: "Help", bookingHelp: "Booking help", manage: "Manage your booking",
    journal: "Journal", journalFull: "Kamakura Journal",
    hosts: "For hosts", host: "Host an experience", login: "Host log in", menuLogin: "Log in", dashboard: "Host dashboard",
    language: "Language", menu: "Menu",
  },
  ja: {
    explore: "体験をさがす", experiences: "体験をさがす", all: "すべての体験",
    plan: "ご利用ガイド", about: JAPANESE_ABOUT_LABEL, help: "ヘルプ", bookingHelp: "予約のヘルプ", manage: "予約の確認・変更",
    journal: "読みもの", journalFull: "読みもの",
    hosts: "ホストの方", host: "ホストになる", login: "ホストログイン", menuLogin: "ログイン", dashboard: "ホスト画面",
    language: "言語", menu: "メニュー",
  },
} as const;

export function experienceNavLinks(locale: SiteLocale, categories: readonly ExperienceCategoryId[]): SiteNavGroup {
  const href = locale === "ja" ? "/ja/experiences" : "/experiences";
  return {
    label: COPY[locale].explore,
    links: [
      { href, label: COPY[locale].all },
      ...categories.map((id) => ({ href: `${href}?category=${id}`, label: categoryLabel(id, locale) })),
    ],
  };
}

export function bookingLookupHref(locale: SiteLocale): string {
  return `${locale === "ja" ? "/ja" : ""}/help#${BOOKING_LOOKUP_SECTION_ID}`;
}

export function siteNavigation(locale: SiteLocale, {
  guides = false, inquiry = false, categories = [], signedIn = false,
}: { guides?: boolean; inquiry?: boolean; categories?: readonly ExperienceCategoryId[]; signedIn?: boolean } = {}) {
  const words = COPY[locale];
  const ja = locale === "ja";
  const prefix = ja ? "/ja" : "";
  const about = { href: `${prefix}/about`, label: words.about };
  const help = { href: `${prefix}/help`, label: words.bookingHelp };
  const journal = { href: `${prefix}/guides`, label: words.journalFull };
  // Only the Japanese site serves group organizers and offers consultation (#658).
  const groups = ja && inquiry ? {
    label: "団体・ご相談",
    links: [
      { href: "/ja/business", label: "企業・学校の方へ" },
      { href: "/ja/inquiry", label: "体験のご相談" },
    ],
  } : null;
  const header: HeaderEntry[] = [
    { href: `${prefix}/experiences`, label: words.experiences, short: ja ? "さがす" : undefined, mobile: true },
    ...(guides ? [{ ...journal, label: words.journal }] : []),
    about,
    ...(groups ? [{ ...groups.links[0]!, label: "企業・学校" }] : []),
    { ...help, label: words.help },
  ];
  const host = { href: `${prefix}/host`, label: words.host };
  // The route handler selects NIHO, email, or the migration login from runtime flags.
  const login = { href: HOST_LOGIN_PATH, label: words.login };
  const dashboard = { href: HOST_HOME_PATH, label: words.dashboard };
  const explore = experienceNavLinks(locale, categories);
  const visit = {
    label: words.plan,
    links: [
      about,
      help,
      { href: bookingLookupHref(locale), label: words.manage },
      ...(guides ? [journal] : []),
    ],
  };
  return {
    header,
    headerHost: signedIn ? dashboard : { ...host, label: words.hosts },
    mobile: {
      label: words.menu,
      explore,
      visit,
      groups,
      hosts: { label: words.hosts, links: signedIn ? [dashboard] : [host, { ...login, label: words.menuLogin }] },
      language: words.language,
    },
    footer: [
      explore, visit, ...(groups ? [groups] : []),
      { label: words.hosts, links: [host, login, ...(ja ? [] : [{ href: "/write", label: "For writers" }])] },
    ],
    groups,
    hostLogin: login,
  };
}

export type SiteNavigation = ReturnType<typeof siteNavigation>;
