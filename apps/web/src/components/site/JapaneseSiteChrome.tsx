import Link from "next/link";
import type { ReactNode } from "react";
import { HandIcon, PresentationRootV1, RubberStamp } from "@niho/experience-presentation/v1";
import { NavLink } from "../NavLink";
import { PRESENTATION_PRIMITIVES_V1 } from "../PresentationV1";
import { LanguageButton } from "./LanguageButton";

/**
 * 日本語サイトのヘッダーとフッター（#562）。英語サイトの訳ではなく、日本語サイトの独自の構成を持つ。
 * 配色・書体・手描きのアイコンは公開サイトの部品（presentation v1）のまま。英語側の `SiteChrome.tsx` とは別。
 *
 * ヘッダーは1行：ロゴ、ナビ、言語のボタン。スマホ幅では「さがす」「相談」と言語のボタンだけにし、ほかはフッターから行く。
 * まだ無いページ（街の人 #564・読みもの #154・ご利用の案内 #565・カテゴリー #529）へのリンクは、そのページが main に入ってから
 * `NAV` と `FOOTER_LINKS` に足す（入るまで出さない）。
 */

type Counterparts = Readonly<Record<string, string>>;

const { Image } = PRESENTATION_PRIMITIVES_V1;

export const JAPANESE_SITE_DESCRIPTION = "鎌倉周辺の人や活動に、会いにいくための予約窓口です。街のリビングNIHO kamakuraが運営しています";

type NavItem = { href: string; label: ReactNode; mobile: boolean; needsInquiry?: boolean };
/** ヘッダーのナビ（上から順）。スマホ幅に出すのは `mobile` のものだけ。 */
const NAV: readonly NavItem[] = [
  { href: "/ja/experiences", label: <><span className="max-sm:hidden">体験を</span>さがす</>, mobile: true },
  // 街の人（#564）・読みもの（#154）は、そのページが入ってからここに足す。
  { href: "/ja/business", label: "法人・学校", mobile: false, needsInquiry: true },
  { href: "/ja/inquiry", label: <>相談<span className="max-sm:hidden">する</span></>, mobile: true, needsInquiry: true },
];

type FooterLink = { href: string; label: string; needsInquiry?: boolean };
/** フッターの2つ目のまとまり。カテゴリーのまとまり（#529）・街の人・読みもの・ご利用の案内は、入ってから足す。 */
const FOOTER_LINKS: readonly FooterLink[] = [
  { href: "/ja/inquiry", label: "個別の相談", needsInquiry: true },
  { href: "/ja/business", label: "法人・団体の方へ", needsInquiry: true },
  { href: "/ja/schools", label: "学校の方へ", needsInquiry: true },
  { href: "/ja/host", label: "体験を載せる" },
  { href: "/host/auth/sign-in", label: "ホストログイン" },
  // 「ご利用の案内」（#565）が入るまでは、いまある予約のヘルプへ。
  { href: "/ja/help", label: "予約のヘルプ" },
];

function HostEntry({ signedIn }: { signedIn: boolean }) {
  return signedIn
    ? <Link href="/host/home" prefetch={false} className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 hover:bg-sand sm:px-3">
        <span aria-hidden className="grid size-7 place-items-center rounded-full bg-leaf-pale"><HandIcon name="house" className="size-4 text-moss" /></span>
        <span className="max-sm:sr-only">ホスト画面</span>
      </Link>
    : <NavLink href="/ja/host" className="rounded-full px-3 py-2 hover:bg-sand">ホストの方</NavLink>;
}

export function JapaneseSiteHeader({ counterparts, hostSignedIn, inquiryOpen }: { counterparts: Counterparts; hostSignedIn: boolean; inquiryOpen: boolean }) {
  const items = NAV.filter((item) => !item.needsInquiry || inquiryOpen);
  return <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur-md backdrop-saturate-[1.2]">
    <div className="container-page flex h-16 items-center gap-1.5">
      <Link href="/ja" className="flex shrink-0 items-center gap-2 font-display text-xl font-semibold tracking-[-0.01em]">
        <span aria-hidden className="relative size-7 shrink-0 sm:size-8"><Image src="/icon.svg" alt="" sizes="32px" priority className="object-contain" /></span>
        <span className="flex items-baseline gap-1.5"><span>NIHO</span><span className="font-normal text-ink-soft max-[479px]:sr-only">Experience 鎌倉</span></span>
      </Link>
      <nav aria-label="メイン" className="ml-auto">
        <ul className="flex items-center gap-0.5 text-[0.9375rem] font-bold sm:gap-1">
          {items.map((item) => <li key={item.href} className={item.mobile ? undefined : "hidden sm:block"}>
            <NavLink href={item.href} className="block rounded-full px-2.5 py-2 whitespace-nowrap hover:bg-sand sm:px-3">{item.label}</NavLink>
          </li>)}
          <li className="hidden sm:block"><HostEntry signedIn={hostSignedIn} /></li>
          <li className="ml-1"><LanguageButton counterparts={counterparts} /></li>
        </ul>
      </nav>
    </div>
  </header>;
}

export function JapaneseSiteFooter({ counterparts, inquiryOpen }: { counterparts: Counterparts; inquiryOpen: boolean }) {
  const links = FOOTER_LINKS.filter((link) => !link.needsInquiry || inquiryOpen);
  return <footer className="mt-24 border-t border-line bg-white">
    <div className="container-page grid gap-7 pt-11 pb-14 sm:grid-cols-[2fr_1fr_auto] sm:items-start">
      <div className="max-w-md">
        <p className="font-display text-xl font-semibold text-muted">NIHO Experience 鎌倉</p>
        <p className="mt-2 text-sm text-muted">{JAPANESE_SITE_DESCRIPTION}</p>
      </div>
      <nav aria-label="フッター">
        <ul className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm font-bold">
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
export function JapaneseSiteChrome({ children, counterparts, hostSignedIn, inquiryOpen }: { children?: ReactNode; counterparts: Counterparts; hostSignedIn: boolean; inquiryOpen: boolean }) {
  return <PresentationRootV1 className="flex min-h-dvh flex-1 flex-col">
    <JapaneseSiteHeader counterparts={counterparts} hostSignedIn={hostSignedIn} inquiryOpen={inquiryOpen} />
    <main id="main" className="flex-1">{children}</main>
    <JapaneseSiteFooter counterparts={counterparts} inquiryOpen={inquiryOpen} />
  </PresentationRootV1>;
}
