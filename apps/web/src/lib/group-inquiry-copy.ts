import type { GroupInquiryEntry, GroupInquiryKind, GroupInquiryLocale, GroupInquiryStatus } from "@niho-experience/experience-store/group-inquiry-fields";

/*
 * The words of 団体・個別の相談 (#532, docs/group-inquiry.md) in one place: the form, the two emails and the office's list
 * all read them. Japanese first; the English is the same questions. No server code, so the browser can import it.
 */

export type InquiryCopy = Record<GroupInquiryLocale, string>;
const t = (ja: string, en: string): InquiryCopy => ({ ja, en });

export const INQUIRY_KIND_LABEL: Record<GroupInquiryKind, InquiryCopy> = {
  PERSONAL: t("個人・グループ", "Individual or group"),
  CORPORATE: t("法人・団体", "Company or organization"),
  SCHOOL: t("学校", "School"),
  LISTING: t("体験を載せたい", "List my experience"),
};

export const INQUIRY_KIND_HINT: Record<GroupInquiryKind, InquiryCopy> = {
  PERSONAL: t("友人・家族・サークルなど、少人数のグループ", "Friends, family or a small club"),
  CORPORATE: t("研修・チームビルディング・取引先のおもてなしなど", "Training, team building or hosting guests"),
  SCHOOL: t("修学旅行・校外学習・探究学習など", "School trips and learning programs"),
  LISTING: t("NIHO Experience に体験を載せたい方", "For people who want to offer an experience"),
};

/** The form's question for each optional answer, by its key (GROUP_INQUIRY_FIELDS). */
export const INQUIRY_FIELD_LABEL: Record<string, InquiryCopy> = {
  organization: t("会社・団体・学校の名前", "Name of the company, organization or school"),
  purpose: t("目的", "Purpose"),
  people: t("人数の目安", "About how many people"),
  timing: t("時期・候補日", "Timing or candidate dates"),
  venue: t("会場", "Venue"),
  budget: t("予算の目安", "Budget"),
  budgetUnit: t("予算の単位", "Budget is"),
  grade: t("学年", "Grade"),
  availableTime: t("現地で使える時間", "Time available on site"),
  theme: t("学びたいテーマ", "Themes to learn about"),
  payer: t("支払いは", "Who pays"),
  contentIdea: t("どんなことを届けたいか", "What you would like to offer"),
  area: t("活動している場所", "Where you are based"),
  links: t("サイトや SNS", "Website or social media"),
};

export const INQUIRY_FIELD_PLACEHOLDER: Record<string, InquiryCopy> = {
  organization: t("例：鎌倉サンプル中学校", "e.g. Sample Junior High School"),
  people: t("例：30人ほど", "e.g. about 30"),
  timing: t("例：来年の5月ごろ", "e.g. around May next year"),
  budget: t("例：3,000円", "e.g. 3,000 yen"),
  grade: t("例：中学2年", "e.g. Grade 8"),
  availableTime: t("例：午後の2時間", "e.g. 2 hours in the afternoon"),
  area: t("例：鎌倉市内", "e.g. in Kamakura"),
  links: t("例：https://example.com", "e.g. https://example.com"),
};

export const INQUIRY_CHOICE_LABEL: Record<string, InquiryCopy> = {
  PER_PERSON: t("一人あたり", "per person"),
  TOTAL: t("全体の合計", "for the whole group"),
  HAVE: t("会場はある", "We have a venue"),
  NEED: t("会場を探している", "We need a venue"),
  UNDECIDED: t("未定", "Not decided"),
  SCHOOL: t("学校", "The school"),
  TRAVEL_AGENCY: t("旅行会社", "A travel agency"),
};

export const INQUIRY_ENTRY_LABEL: Record<GroupInquiryEntry, InquiryCopy> = {
  DIRECT: t("相談フォームから直接", "The inquiry form directly"),
  EXPERIENCE: t("体験ページから", "From an experience page"),
  PROVIDER: t("人物（提供者）のページから", "From a host's page"),
  SCHOOL: t("学校向けの案内から", "From the schools page"),
  CORPORATE: t("法人向けの案内から", "From the companies page"),
  LISTING: t("掲載の案内から", "From the listing page"),
};

export const INQUIRY_STATUS_LABEL: Record<GroupInquiryStatus, string> = { NEW: "新着", IN_PROGRESS: "対応中", DONE: "完了" };

/** The one line under the form: the first talk is free, anything that needs planning is priced first (owner, 2026-11-13). */
export const INQUIRY_FREE_NOTE = t(
  "はじめの相談は無料で、20分ほどを目安にしています。企画や調整が必要なときは、内容と料金をご案内してから進めます。",
  "The first conversation is free, about 20 minutes. If planning or coordination is needed, we explain what it covers and what it costs before going ahead.",
);

/** Under the form: what the details are used for. The wording of /privacy is the owner's to confirm before launch (docs/group-inquiry.md). */
export const INQUIRY_PRIVACY_NOTE = t(
  "入力いただいた内容は、ご相談への返信のためだけに使い、NIHO の事務局だけが見ます。",
  "What you enter is used only to reply to your inquiry, and only the NIHO office sees it.",
);

export const INQUIRY_NOT_BOOKED = t("まだ予約は確定していません。", "Nothing is booked yet.");

/** `2026-11-17` → "11月17日" / "17 Nov" (the office's due date, a calendar date in Japan). */
export function inquiryDateLabel(date: string, locale: GroupInquiryLocale): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  if (locale === "ja") return `${month}月${day}日`;
  return `${day} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1]}`;
}

/** An answer as the person (or the office) reads it: a choice by its label, anything else as written. */
export function inquiryAnswerLabel(key: string, value: string, locale: GroupInquiryLocale): string {
  if (key === "budgetUnit" || key === "venue" || key === "payer") return INQUIRY_CHOICE_LABEL[value]?.[locale] ?? value;
  return value;
}
