import Link from "next/link";
import type { ReactNode } from "react";
import { HandIcon, PresentationRootV1, RubberStamp } from "@niho/experience-presentation/v1";
import { EXPERIENCE_CATEGORIES } from "@niho-experience/experience-domain";
import { SiteHeader } from "../SiteChrome";
import { siteNav } from "@/lib/site-nav";
import { LanguageButton } from "./LanguageButton";

/**
 * 日本語サイトの枠（#562、#612、#658）。ヘッダーは英語と同じ1つの部品（`SiteHeader`）で、タブの中身だけを `siteNav("ja")`
 * （lib/site-nav.ts）から渡す（オーナー決定 2026-11-25：日英は同じレイアウト。差は意図があるものだけ）。日本語だけの差は
 * 「企業・学校」のタブと、メニューの「ご相談」、ログイン中のホストに出す「ホスト画面」。
 * ページが無いものへのリンクは出さない（読みものは公開中の記事があるときだけ）。街の人はどこにも置かない（#612: 人物ページは止めている）。
 * フッターはまだ日本語だけの部品（カテゴリーの列がある）。日英で1つにするのは #658 の次の段。
 */

type Counterparts = Readonly<Record<string, string>>;

/** フッターの説明文：だれが運営しているかと、どこにあるか。 */
export const JAPANESE_SITE_DESCRIPTION = "運営：NIHO kamakura（鎌倉駅西口から歩いて2分）";

type FooterLink = { href: string; label: string; needsInquiry?: boolean; needsGuides?: boolean };
/** フッターの2つ目のまとまり（1つ目はカテゴリー）。読みものは公開中の記事があるときだけ。 */
const FOOTER_LINKS: readonly FooterLink[] = [
  { href: "/ja/about", label: "NIHOについて" },
  { href: "/ja/guides", label: "読みもの", needsGuides: true },
  { href: "/ja/inquiry", label: "ご相談", needsInquiry: true },
  { href: "/ja/business", label: "企業・学校の方へ", needsInquiry: true },
  { href: "/ja/host", label: "ホストになる" },
  { href: "/host/auth/sign-in", label: "ホストログイン" },
  // 「ご利用の案内」（#565）が入るまでは、いまある予約のヘルプへ。
  { href: "/ja/help", label: "予約のヘルプ" },
];

/** ログイン中のホストにだけ、行の右端（lg 以上）に出す。 */
function HostHomeLink() {
  return <Link href="/host/home" prefetch={false} className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 whitespace-nowrap hover:bg-sand md:px-3">
    <span aria-hidden className="grid size-7 place-items-center rounded-full bg-leaf-pale"><HandIcon name="house" className="size-4 text-moss" /></span>
    <span>ホスト画面</span>
  </Link>;
}

export function JapaneseSiteHeader({ counterparts, hostSignedIn, inquiryOpen, guidesOpen = false }: { counterparts: Counterparts; hostSignedIn: boolean; inquiryOpen: boolean; guidesOpen?: boolean }) {
  return <SiteHeader
    navLabel="メイン"
    menuLabel="メニュー"
    entries={siteNav("ja", { guides: guidesOpen, inquiry: inquiryOpen })}
    languageSwitch={<LanguageButton counterparts={counterparts} />}
    menuLanguage={<LanguageButton counterparts={counterparts} variant="text" />}
    foot={hostSignedIn ? { href: "/host/home", label: "ホスト画面" } : { href: "/ja/host", label: "ホストになる" }}
    rowEnd={hostSignedIn ? <HostHomeLink /> : null}
  />;
}

export function JapaneseSiteFooter({ counterparts, inquiryOpen, guidesOpen = false }: { counterparts: Counterparts; inquiryOpen: boolean; guidesOpen?: boolean }) {
  const links = FOOTER_LINKS.filter((link) => (!link.needsInquiry || inquiryOpen) && (!link.needsGuides || guidesOpen));
  return <footer className="mt-24 border-t border-line bg-white">
    <div className="container-page grid gap-7 pt-11 pb-14 sm:grid-cols-[1.2fr_2fr_auto] sm:items-start">
      <div className="max-w-md">
        <p className="font-display text-xl font-semibold text-muted">NIHO Travel 鎌倉</p>
        <p className="mt-2 text-sm text-muted">{JAPANESE_SITE_DESCRIPTION}</p>
      </div>
      <nav aria-label="フッター" className="grid grid-cols-2 gap-x-6 gap-y-2 sm:gap-x-10">
        <ul aria-label="カテゴリー" className="grid content-start gap-2 text-sm font-bold">
          {EXPERIENCE_CATEGORIES.map((category) => <li key={category.id}><Link href={`/ja/experiences?category=${category.id}`} className="hover:underline">{category.label}</Link></li>)}
        </ul>
        <ul className="grid content-start gap-2 text-sm font-bold">
          {links.map((link) => <li key={link.href}><Link href={link.href} className="hover:underline">{link.label}</Link></li>)}
          <li><LanguageButton counterparts={counterparts} variant="text" /></li>
          <li><Link href="/privacy" className="hover:underline">プライバシー</Link></li>
        </ul>
      </nav>
      <RubberStamp className="size-[104px] rotate-[10deg] text-moss max-sm:hidden" />
    </div>
  </footer>;
}

/** The Japanese site's frame: header, main, footer. The page's own routes and copy are the page's. */
export function JapaneseSiteChrome({ children, counterparts, hostSignedIn, inquiryOpen, guidesOpen = false }: { children?: ReactNode; counterparts: Counterparts; hostSignedIn: boolean; inquiryOpen: boolean; guidesOpen?: boolean }) {
  return <PresentationRootV1 className="flex min-h-dvh flex-1 flex-col">
    <JapaneseSiteHeader counterparts={counterparts} hostSignedIn={hostSignedIn} inquiryOpen={inquiryOpen} guidesOpen={guidesOpen} />
    <main id="main" className="flex-1">{children}</main>
    <JapaneseSiteFooter counterparts={counterparts} inquiryOpen={inquiryOpen} guidesOpen={guidesOpen} />
  </PresentationRootV1>;
}
