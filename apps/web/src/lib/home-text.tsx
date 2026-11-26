import type { ReactNode } from "react";
import { JAPANESE_ABOUT_LABEL } from "./site-nav";
import { JA_HOME_LEAD } from "./ja-home";

/**
 * The home's words and the few intended differences between the English and the Japanese home (#658, owner decision 2026-11-25:
 * one component for both languages; only the words and deliberate differences vary, and the English shape is the base).
 * Everything the shared `HomePageView` does not read from the interface copy lives here, in one place.
 */
export type HomeText = Readonly<{
  /** Replaces the hero heading and its class; absent = the shared component's own heading (`home.heroHeadingRich`). */
  heroHeading?: ReactNode;
  heroHeadingClassName?: string;
  heroBody: ReactNode;
  heroAction: Readonly<{ href: string; label: string }>;
  cardsEyebrow: string;
  cardsTitle: ReactNode;
  priceSuffix: string;
  registeredHost: string;
  groupCard?: Readonly<{ title: string; body: string; hand: string }>;
  /** The hero photo's alt in this language; absent = the photo's own (English) alt. */
  heroAlt?: string;
  /** The living-room band's words; absent = the English band. */
  livingRoom?: Readonly<{ hand: string; title: string; body: string; action: { href: string; label: string }; alt: string; titleClassName: string }>;
}>;

export const HOME_TEXT: Readonly<Record<"en" | "ja", HomeText>> = {
  en: {
    heroBody: "Small experiences with people who live here, one hour from Tokyo.",
    heroAction: { href: "/experiences", label: "See the experiences" },
    cardsEyebrow: "after the Great Buddha",
    cardsTitle: <>Spend a few hours with a <span className="squig">neighbor</span></>,
    priceSuffix: " / adult",
    registeredHost: "Already registered?",
  },
  ja: {
    heroHeading: <>鎌倉の人に、<br />会いにいく。<span className="hand mt-1 block text-[1.75rem] font-normal text-leaf lg:text-[2.5rem]">meet the town</span></>,
    heroHeadingClassName: "text-[2.375rem] leading-[1.2] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] lg:text-[4rem]",
    heroBody: <span className="[word-break:auto-phrase]">{JA_HOME_LEAD}</span>,
    heroAlt: "NIHOのリビングで、飲みものを手に話す街の人とゲスト",
    heroAction: { href: "/ja/experiences", label: "体験をさがす" },
    cardsEyebrow: "our picks",
    cardsTitle: "おすすめの体験",
    // 日本語のカードの料金は `card.priceRich`（「/ 大人1名」つき）が描く。接尾辞を足すと二重になるので空にする。
    priceSuffix: "",
    registeredHost: "登録済みの方は",
    groupCard: {
      title: "企業・学校・グループで",
      hand: "ask the town",
      body: "学校や会社、グループでの参加について、目的を聞かせてください。体験や日にちが決まっていなくても大丈夫です。はじめの相談は無料です。",
    },
    livingRoom: {
      hand: "it starts here",
      title: "街のリビング、NIHO",
      body: "鎌倉駅から歩いて2分。街の人がふらりと寄って、一緒につくり、話し、手を動かす場所です。",
      action: { href: "/ja/about", label: JAPANESE_ABOUT_LABEL },
      alt: "NIHOの長いテーブルを囲む街の人たち",
      titleClassName: "mt-1 text-[2rem] leading-[1.25] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] lg:text-[3rem]",
    },
  },
};
