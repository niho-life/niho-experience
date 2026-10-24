import type { HostReview, HostReviewText } from "../types";
import { PREVIEW_ENGLISH_DRAFT } from "./threads";

/*
 * Invented reviews of the sample kitchen's Community Dinner (#108); nobody here is real. Each is
 * for a past booking of mock/bookings.ts the guest came to (来た: none for one who did not), on
 * that booking's day, written the day after or so. Three published with a reply (one corrected,
 * one to a review NIHO could not translate), two published without one (one with a note for the
 * host), and one NIHO is still checking. Every time is before the preview's moment (MOCK_NOW,
 * 10/21 15:30). The translations are what NIHO would show; the English of a reply is what the
 * experience page shows. よかった点 are NIHO's identifiers (REVIEW_TAGS has the words).
 */

const english = (original: string, translation: string): HostReviewText => ({ original, language: "en", translation });

type ReviewFields = Pick<HostReview, "id" | "bookingId" | "sessionDate" | "reviewer" | "rating" | "tags" | "body" | "writtenAt" | "status" | "publishedAt"> &
  Partial<Pick<HostReview, "privateNote" | "reply">>;

const review = (fields: ReviewFields): HostReview => ({ experienceId: "community-dinner", privateNote: null, reply: null, report: null, ...fields });

export const MOCK_KITCHEN_REVIEWS: readonly HostReview[] = [
  // Published, no reply yet, with a note for the host only.
  review({
    id: "rv-5020",
    bookingId: "bk-2020",
    sessionDate: "2026-10-17",
    reviewer: { name: "Oliver", country: "イギリス" },
    rating: 5,
    tags: ["GOOD_FOR_BEGINNERS", "GREAT_HOST", "GOOD_VALUE"],
    body: english(
      "We cooked six dishes with people who actually live here and ended up talking until the last train. The miso-glazed aubergine was the best thing we ate in Japan. Thank you for making us feel like neighbours.",
      "ここに暮らす人たちと 6 品を作り、終電の時間まで話し込みました。なすの味噌田楽は、日本で食べたなかでいちばんでした。ご近所さんのように迎えてくださってありがとうございました。",
    ),
    privateNote: english("Thank you for the recipe card! My wife has already made the aubergine twice.", "レシピのカードをありがとうございました！ 妻がもう 2 回もなすを作りました。"),
    writtenAt: "2026-10-18T21:10",
    status: "published",
    publishedAt: "2026-10-19T10:00",
  }),
  // NIHO is still checking it: the host can read it (and report it), not reply yet. Written in Japanese.
  review({
    id: "rv-5013",
    bookingId: "bk-2005",
    sessionDate: "2026-10-13",
    reviewer: { name: "由紀", country: "日本" },
    rating: 4,
    tags: ["GOOD_FOR_BEGINNERS", "EASY_TO_FIND"],
    body: {
      original: "駅から近く、地元の方と一緒に料理するのは新鮮でした。英語と日本語が混ざった会話も楽しかったです。席が少し窮屈だったので、星は 4 つにしました。",
      language: "ja",
      translation: null,
    },
    writtenAt: "2026-10-20T08:30",
    status: "pending",
    publishedAt: null,
  }),
  // NIHO could not translate it: the host reads the original. Answered with a short thanks.
  review({
    id: "rv-4926",
    bookingId: "bk-2004",
    sessionDate: "2026-09-26",
    reviewer: { name: "Lena", country: "チェコ" },
    rating: 5,
    tags: ["CALM_ATMOSPHERE", "GREAT_HOST"],
    body: { original: "Úžasný večer! Vařili jsme společně a všichni byli velmi milí. Děkujeme za recept na misopolévku.", language: "cs", translation: null },
    writtenAt: "2026-09-27T19:40",
    status: "published",
    publishedAt: "2026-09-28T11:00",
    reply: {
      japanese: "ご参加ありがとうございました。またいつでも鎌倉へお越しください。",
      english: "Thank you for joining us. Come back to Kamakura any time.",
      publishedAt: "2026-09-29T09:15",
      editedAt: null,
    },
  }),
  // Published with a reply the host corrected the next day.
  review({
    id: "rv-4912",
    bookingId: "bk-2001",
    sessionDate: "2026-09-12",
    reviewer: { name: "Grace", country: "シンガポール" },
    rating: 5,
    tags: ["GOOD_FOR_BEGINNERS", "GREAT_HOST"],
    body: english(
      "Everything was explained so clearly, from the knife skills to the dashi. We started and finished right on time, which mattered with our train.",
      "包丁の使い方からだしまで、とてもわかりやすく教えてもらいました。時間どおりに始まって終わったので、電車に乗る私たちには助かりました。",
    ),
    writtenAt: "2026-09-13T22:05",
    status: "published",
    publishedAt: "2026-09-14T10:30",
    reply: {
      japanese: "ありがとうございました！ 次は秋の新米の頃にぜひお越しください。",
      english: "Thank you so much! Do come back when the new rice is in this autumn.",
      publishedAt: "2026-09-15T08:40",
      editedAt: "2026-09-16T19:20",
    },
  }),
  // Published, no reply yet: four stars and a wish.
  review({
    id: "rv-4906",
    bookingId: "bk-1998",
    sessionDate: "2026-09-05",
    reviewer: { name: "Ella", country: "オーストラリア" },
    rating: 4,
    tags: ["GOOD_VALUE"],
    body: english(
      "A lovely evening. The food was delicious, though it was a little hard to hear across the long table when everyone was talking at once.",
      "すてきな夜でした。料理はおいしかったのですが、みんなが一度に話すと、長いテーブルの向こうの声が少し聞き取りにくかったです。",
    ),
    writtenAt: "2026-09-06T10:20",
    status: "published",
    publishedAt: "2026-09-07T09:00",
  }),
  // Written in German, translated by NIHO, answered.
  review({
    id: "rv-4902",
    bookingId: "bk-1996",
    sessionDate: "2026-09-01",
    reviewer: { name: "Jonas", country: "ドイツ" },
    rating: 5,
    tags: ["CALM_ATMOSPHERE", "GREAT_HOST"],
    body: {
      original: "Ein wunderbarer Abend mit herzlichen Gastgebern. Wir haben viel gelernt und noch mehr gelacht.",
      language: "de",
      translation: "温かいホストとのすばらしい夜でした。たくさん学んで、それ以上にたくさん笑いました。",
    },
    writtenAt: "2026-09-02T18:00",
    status: "published",
    publishedAt: "2026-09-03T10:00",
    reply: {
      japanese: "温かいお言葉をありがとうございます。またご一緒に料理できる日を楽しみにしています。",
      english: "Thank you for your kind words. We look forward to cooking with you again.",
      publishedAt: "2026-09-03T21:00",
      editedAt: null,
    },
  }),
];

/** The example replies to the reviews without one, with a natural English for each. */
export const MOCK_REVIEW_REPLY_EXAMPLES: readonly { reviewId: string; japanese: string; english: string }[] = [
  {
    reviewId: "rv-5020",
    japanese: "ディナーに来てくださってありがとうございました！ なすの味噌田楽をご家庭でも作ってくださって、とてもうれしいです。また鎌倉でお会いしましょう。",
    english: "Thank you for coming to dinner! We are so happy you are making the miso aubergine at home. See you again in Kamakura.",
  },
  {
    reviewId: "rv-4906",
    japanese: "ご参加ありがとうございました。声が届きにくかったとのこと、次からは席の並べ方を工夫します。",
    english: "Thank you for joining us. We are sorry it was hard to hear; we will set the table differently from now on.",
  },
];

/** The preview's 英語にする for a review's reply: the example's English for its Japanese, else a sentence that says it is a preview. */
export function mockReviewEnglishDraft(reviewId: string, japanese: string): string {
  const example = MOCK_REVIEW_REPLY_EXAMPLES.find((candidate) => candidate.reviewId === reviewId && candidate.japanese === japanese.trim());
  return example?.english ?? PREVIEW_ENGLISH_DRAFT;
}
