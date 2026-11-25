import type { AboutContent } from "@/components/pages/AboutPage";
import { ABOUT_EXTERIOR, ABOUT_HERO, ABOUT_PILLARS } from "@/lib/site-media";

/**
 * 日本語の「NIHOについて」（#658）：文言とリンクをここで決める。写真は英語のページと同じ（`site-media.ts`、alt だけ日本語）。
 * 組みは英語の `AboutPage` と同じで、見出し・リード・運営の見出しの class だけ日本語向けに変える。
 */

export const JA_ABOUT_TITLE = "NIHOについて";
export const JA_ABOUT_DESCRIPTION = "NIHO Travel は、鎌倉駅から歩いて2分の街のリビング NIHO が運営する、鎌倉に暮らす人が開く少人数の体験の予約サイトです。";

/** 3つの柱：手書き風の語は英語のまま、文と写真の alt が日本語。写真と位置は `ABOUT_PILLARS` から取る。 */
const PILLAR_TEXT: Readonly<Record<string, { line: string; alt: string }>> = {
  local: { line: "どの体験も、鎌倉に暮らす人が開きます。", alt: "NIHOの台所で一緒に料理をする2人" },
  deep: { line: "観光名所ではなく、暮らしと文化のなかへ。", alt: "一緒にサラダを盛りつける手" },
  small: { line: "ひとつの食卓を囲んで話せる人数で。", alt: "NIHOの食卓を囲む街の人とゲスト" },
};

export const JA_ABOUT_CONTENT: AboutContent = {
  sectionLabel: "NIHO Travel について",
  hero: { ...ABOUT_HERO, alt: "NIHOのリビングで、飲みものを手に話す街の人とゲスト" },
  hand: "about",
  title: <>はじまりは、<br />街のリビング。</>,
  lead: "NIHOは、鎌倉駅から歩いて2分の、街の人が集まるリビングです。NIHO Travel は、そのリビングを旅する人にもひらき、鎌倉に暮らす人が開く少人数の体験を届けます。",
  pillarsLabel: "大切にしていること",
  pillars: ABOUT_PILLARS.map((pillar) => {
    const text = PILLAR_TEXT[pillar.word];
    return { word: pillar.word, line: text?.line ?? pillar.line, photo: { ...pillar.photo, alt: text?.alt ?? pillar.photo.alt } };
  }),
  booking: {
    eyebrow: "how it works",
    title: "予約のしくみ",
    steps: [
      { icon: "cal", title: "日にちを選ぶ", body: "体験のページで、開催日と人数を選びます。時刻は日本時間です。" },
      { icon: "card", title: "安全に支払う", body: "お支払いはStripeで、日本円・税込です。" },
      { icon: "mail", title: "ホストに会う", body: "集合場所とご予約の内容は、メールでお届けします。" },
    ],
    action: { href: "/ja/experiences", label: "体験をさがす" },
  },
  who: {
    eyebrow: "who runs it",
    title: "街のリビング、NIHO",
    body: "NIHO Travel は、鎌倉駅西口から歩いて2分の街のリビング、NIHO kamakura が運営しています。",
    link: { href: "/ja/help", label: "ヘルプとお問い合わせ" },
    photo: { ...ABOUT_EXTERIOR, alt: "NIHO kamakura の入口" },
  },
  locals: {
    title: "鎌倉にお住まいの方へ",
    body: "NIHOは、地元のホストが体験を準備し、予約を受け付けるお手伝いをします。まずは小さく、ひとつの食卓、ひとつの午後、数人のゲストから。",
    action: { href: "/ja/host", label: "ホストになるには" },
  },
  titleClassName: "mt-1 text-[2.25rem] leading-[1.25] [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] lg:text-[3.5rem]",
  leadClassName: "max-w-[46rem] text-[1.25rem] leading-relaxed [word-break:auto-phrase] lg:text-[1.625rem]",
  whoTitleClassName: "mt-2 text-[1.625rem] leading-snug lg:text-[2.25rem]",
};
