/*
 * 法人・団体の方へ（/ja/business）と学校の方へ（/ja/schools）の案内の中身 (#532 続き, docs/group-inquiry.md)。
 *
 * **ここにある金額・人数・時間・期間はすべて仮**で、公開の前にオーナーが確認する（PR 本文に一覧がある）。数字は1か所
 * （GROUP_GUIDE_NUMBERS）に置き、文面は `n()` でそこから読む。ページの文に数字を直接書かない。実績・事例・利用者の声は
 * 書かない。「必ず実施」のような保証は書かない。当日の立ち会いは「必要なときに見積に含める」。はじめの相談は無料で20分ほど
 * （オーナー決定 2026-11-13）。
 */

export type GuideNumberKey =
  | "freeConsultMinutes"
  | "planningFeePersonalFrom" | "planningFeeGroupFrom"
  | "venueSeatsUpstairs" | "venueSeatsWithDining" | "venueHourlyFee"
  | "bizOffsiteCapacityMin" | "bizOffsiteCapacityMax" | "bizOffsitePerPersonFrom"
  | "bizTableCapacityMin" | "bizTableCapacityMax" | "bizTablePerPersonFrom"
  | "bizVoiceParticipants" | "bizVoicePerSessionApprox"
  | "bizHalfDayCapacityMin" | "bizHalfDayCapacityMax" | "bizHalfDayPerPersonFrom"
  | "bizTalkMinutes" | "bizTalkCapacityMax" | "bizTalkPerSessionFrom"
  | "bizLeadTimeMonths" | "bizShortNoticeWeeks"
  | "schoolClassMax" | "schoolLunchMax" | "schoolTeamSizeMin" | "schoolTeamSizeMax"
  | "schoolTalkMinutes" | "schoolTalkAdults" | "schoolTalkPerPersonFrom" | "schoolFieldTeamFrom" | "schoolFieldPerTeamFrom"
  | "schoolLeadTimeMonths";

export interface GuideNumber {
  readonly key: GuideNumberKey;
  readonly value: number;
  readonly unit: "円" | "人" | "分" | "か月" | "週間" | "班" | "時間";
  /** What the number is, for the owner's checklist. */
  readonly label: string;
}

/** Every number the two pages show. Provisional; the owner confirms each before launch. */
export const GROUP_GUIDE_NUMBERS: readonly GuideNumber[] = [
  { key: "freeConsultMinutes", value: 20, unit: "分", label: "はじめの相談（無料）の目安の時間" },
  { key: "planningFeePersonalFrom", value: 5_000, unit: "円", label: "企画と調整の料金（個人・少人数）の下限" },
  { key: "planningFeeGroupFrom", value: 30_000, unit: "円", label: "企画と調整の料金（団体・法人・学校）の下限" },
  { key: "venueSeatsUpstairs", value: 20, unit: "人", label: "拠点の二階に着席で入れる人数" },
  { key: "venueSeatsWithDining", value: 38, unit: "人", label: "平日の夕方以降、一階の食堂と合わせて入れる人数" },
  { key: "venueHourlyFee", value: 8_500, unit: "円", label: "会場だけを使う場合の1時間の料金" },
  { key: "bizOffsiteCapacityMin", value: 12, unit: "人", label: "一日オフサイトの人数（下限）" },
  { key: "bizOffsiteCapacityMax", value: 20, unit: "人", label: "一日オフサイトの人数（上限）" },
  { key: "bizOffsitePerPersonFrom", value: 16_000, unit: "円", label: "一日オフサイトの1人あたり料金の下限" },
  { key: "bizTableCapacityMin", value: 10, unit: "人", label: "街の人と囲む食卓の人数（下限）" },
  { key: "bizTableCapacityMax", value: 20, unit: "人", label: "街の人と囲む食卓の人数（上限）" },
  { key: "bizTablePerPersonFrom", value: 7_000, unit: "円", label: "街の人と囲む食卓の1人あたり料金の下限" },
  { key: "bizVoiceParticipants", value: 6, unit: "人", label: "生活者ヒアリングの参加する暮らし手の人数" },
  { key: "bizVoicePerSessionApprox", value: 300_000, unit: "円", label: "生活者ヒアリング1回の料金の目安" },
  { key: "bizHalfDayCapacityMin", value: 8, unit: "人", label: "街の人を訪ねる半日の人数（下限）" },
  { key: "bizHalfDayCapacityMax", value: 30, unit: "人", label: "街の人を訪ねる半日の人数（上限）" },
  { key: "bizHalfDayPerPersonFrom", value: 6_000, unit: "円", label: "街の人を訪ねる半日の1人あたり料金の下限" },
  { key: "bizTalkMinutes", value: 90, unit: "分", label: "街の人の話を聞く時間" },
  { key: "bizTalkCapacityMax", value: 20, unit: "人", label: "街の人の話を聞く90分の人数（上限）" },
  { key: "bizTalkPerSessionFrom", value: 30_000, unit: "円", label: "街の人の話を聞く90分の1回あたり料金の下限" },
  { key: "bizLeadTimeMonths", value: 1, unit: "か月", label: "法人の相談の時期の目安（これ以上前）" },
  { key: "bizShortNoticeWeeks", value: 2, unit: "週間", label: "法人の直前の相談を内容によって受ける目安" },
  { key: "schoolClassMax", value: 40, unit: "人", label: "学校が一度に受けられる人数（1クラス）" },
  { key: "schoolLunchMax", value: 20, unit: "人", label: "拠点で昼食をとれる人数" },
  { key: "schoolTeamSizeMin", value: 6, unit: "人", label: "学校の班の人数（下限）" },
  { key: "schoolTeamSizeMax", value: 7, unit: "人", label: "学校の班の人数（上限）" },
  { key: "schoolTalkMinutes", value: 90, unit: "分", label: "学校向けの対話の時間" },
  { key: "schoolTalkAdults", value: 3, unit: "人", label: "学校向けの対話で順に訪ねる大人の人数" },
  { key: "schoolTalkPerPersonFrom", value: 2_500, unit: "円", label: "学校向けの対話の1人あたり料金" },
  { key: "schoolFieldTeamFrom", value: 4, unit: "人", label: "取材先の手配を受ける1班の人数（下限）" },
  { key: "schoolFieldPerTeamFrom", value: 5_000, unit: "円", label: "取材先の手配の1班あたり料金の下限" },
  { key: "schoolLeadTimeMonths", value: 3, unit: "か月", label: "学校の相談の時期の目安（これ以上前）" },
];

export type GuideFactKey = "venueWalk" | "bizOffsiteTime" | "bizTableTime" | "bizVoiceTime" | "schoolFieldTime" | "schoolBaseTime";

/** The other figures the pages show in words (a time of day, a walk, a span). Provisional too. */
export const GROUP_GUIDE_FACTS: Readonly<Record<GuideFactKey, { readonly value: string; readonly label: string }>> = {
  venueWalk: { value: "鎌倉駅から歩いて2分", label: "拠点の場所の案内（駅からの徒歩）" },
  bizOffsiteTime: { value: "1日", label: "一日オフサイトの所要時間" },
  bizTableTime: { value: "2時間半ほど", label: "街の人と囲む食卓の所要時間" },
  bizVoiceTime: { value: "2時間ほど", label: "生活者の声を聞く食卓の所要時間" },
  schoolFieldTime: { value: "半日〜", label: "取材先の手配の時間" },
  schoolBaseTime: { value: "半日〜1日", label: "拠点を使う時間" },
};

const fact = (key: GuideFactKey): string => GROUP_GUIDE_FACTS[key].value;

const BY_KEY = new Map(GROUP_GUIDE_NUMBERS.map((item) => [item.key, item]));

/** A number as the page shows it: `1,000円`, `20人`, `90分`. */
export function n(key: GuideNumberKey): string {
  const item = BY_KEY.get(key);
  if (!item) throw new Error(`Unknown guide number: ${key}`);
  return `${item.value.toLocaleString("en-US")}${item.unit}`;
}

/** `5,000円〜`. */
export const from = (key: GuideNumberKey): string => `${n(key)}〜`;
/** `12〜20人`: two numbers of one unit. */
export function range(min: GuideNumberKey, max: GuideNumberKey): string {
  const low = BY_KEY.get(min)!;
  const high = BY_KEY.get(max)!;
  return `${low.value.toLocaleString("en-US")}〜${high.value.toLocaleString("en-US")}${high.unit}`;
}

export interface GuideOffer {
  readonly title: string;
  /** どんなときに向くか: one line. */
  readonly when: string;
  readonly people: string;
  readonly time: string;
  readonly price: string;
  readonly points: readonly string[];
}

export interface GuideQuestion {
  readonly question: string;
  readonly answer: string;
}

export interface GuideStep {
  readonly title: string;
  readonly body: string;
}

export interface GuideFee {
  readonly label: string;
  readonly value: string;
}

export interface GuidePart {
  readonly title: string;
  readonly note: string;
  readonly people: string;
  readonly price: string;
}

export interface GroupGuide {
  readonly kind: "CORPORATE" | "SCHOOL";
  readonly path: string;
  readonly metaTitle: string;
  readonly metaDescription: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly lead: string;
  readonly cta: string;
  readonly otherLink: { readonly href: string; readonly label: string };
  readonly offersTitle: string;
  readonly offers: readonly GuideOffer[];
  readonly parts?: { readonly title: string; readonly items: readonly GuidePart[] };
  readonly note?: { readonly title: string; readonly body: string };
  readonly stepsTitle: string;
  readonly steps: readonly GuideStep[];
  readonly feesTitle: string;
  readonly fees: readonly GuideFee[];
  readonly questionsTitle: string;
  readonly questions: readonly GuideQuestion[];
  readonly closing: { readonly title: string; readonly body: string };
}

const FREE = `無料（${n("freeConsultMinutes")}ほど）`;
const PLANNING = `個人・少人数 ${from("planningFeePersonalFrom")}／団体・法人・学校 ${from("planningFeeGroupFrom")}`;

const SHARED_FEES: readonly GuideFee[] = [
  { label: "はじめのご相談", value: FREE },
  { label: "企画と調整", value: PLANNING },
  { label: "担い手への謝礼・会場・食事", value: "内容に応じて、お見積りに入れます" },
  { label: "当日の立ち会い", value: "必要なときに、お見積りに含めます" },
];

export const BUSINESS_GUIDE: GroupGuide = {
  kind: "CORPORATE",
  path: "/ja/business",
  metaTitle: "法人・団体の方へ",
  metaDescription: "研修・オフサイト・懇親の場を、鎌倉の街の人と一緒に。企画から調整まで、ひとつの窓口でご相談ください。",
  eyebrow: "法人・団体の方へ",
  title: "チームの一日を、鎌倉の街で。",
  lead: "会議、食事、街の人との時間を、ひとつの窓口でご相談いただけます。部署の方針づくり、新しいメンバーの歓迎、企画の前の聞き取りなど、日にちが決まっていなくても大丈夫です。",
  cta: "相談する",
  otherLink: { href: "/ja/schools", label: "学校の方はこちら" },
  offersTitle: "こんな使い方ができます",
  offers: [
    {
      title: "一日オフサイト",
      when: "部署の方針を、いつもの会議室の外で話したいとき",
      people: range("bizOffsiteCapacityMin", "bizOffsiteCapacityMax"),
      time: fact("bizOffsiteTime"),
      price: `1人 ${from("bizOffsitePerPersonFrom")}`,
      points: ["拠点を一日使い、会議と食事を組み合わせます", "午後は会議の続きか、街の人を訪ねる時間に", "内容は、目的に合わせてご相談の中で決めます"],
    },
    {
      title: "街の人と囲む食卓",
      when: "新しいメンバーを迎える日や、節目の懇親に",
      people: range("bizTableCapacityMin", "bizTableCapacityMax"),
      time: fact("bizTableTime"),
      price: `1人 ${from("bizTablePerPersonFrom")}`,
      points: ["懇親会を、お店ではなく街の居間で", "その日の食材でつくる食事", "街の人が同じ食卓に座る時間を設けます"],
    },
    {
      title: "生活者の声を聞く食卓",
      when: "商品企画の仮説を、生活者の言葉で確かめたいとき",
      people: `暮らし手${n("bizVoiceParticipants")}`,
      time: fact("bizVoiceTime"),
      price: `1回 ${n("bizVoicePerSessionApprox")}前後`,
      points: ["条件に合う方に、事務局が声をかけます", "進行の補助と記録をつけることもできます（内容はご相談で）"],
    },
  ],
  parts: {
    title: "すでにある予定に、一部分だけ組み込む",
    items: [
      { title: "街の人を訪ねる半日", note: "新しいメンバーどうしが、互いを知るきっかけに", people: range("bizHalfDayCapacityMin", "bizHalfDayCapacityMax"), price: `1人 ${from("bizHalfDayPerPersonFrom")}` },
      { title: "街の人と囲む夕食", note: "自社で組んだ合宿の、夜の食事だけ", people: range("bizTableCapacityMin", "bizTableCapacityMax"), price: `1人 ${from("bizTablePerPersonFrom")}` },
      { title: `街の人の話を聞く${n("bizTalkMinutes")}`, note: "研修の一コマに、外の人の話を入れたい", people: `${n("bizTalkCapacityMax")}まで`, price: `1回 ${from("bizTalkPerSessionFrom")}` },
      { title: "会議の場所", note: "会場だけ、鎌倉に移したい", people: `日中は${n("venueSeatsUpstairs")}まで`, price: `1時間 ${n("venueHourlyFee")}` },
    ],
  },
  stepsTitle: "進め方",
  steps: [
    { title: "相談を送る", body: "フォームから。決まっていないことは空欄のままで大丈夫です。" },
    { title: "お話をうかがう", body: `電話などで、${n("freeConsultMinutes")}ほど。ここまでは無料です。` },
    { title: "内容と料金をご案内", body: "企画や調整が必要なときは、内容とお見積りをお送りします。進めるかどうかは、それを見て決めてください。" },
    { title: "当日まで", body: "担い手との調整とお支払いの窓口は、事務局がまとめて担当します。" },
  ],
  feesTitle: "料金の考え方",
  fees: [
    ...SHARED_FEES,
    { label: "お支払い", value: "内容に応じて、請求書でのお支払いなどをご相談ください" },
  ],
  questionsTitle: "よくある質問",
  questions: [
    { question: "何人まで入れますか", answer: `拠点の二階は着席で${n("venueSeatsUpstairs")}までです。平日の夕方以降は、一階の食堂と合わせて${n("venueSeatsWithDining")}まで入れる想定です。これより多いときは、近くの場所を含めて相談します。` },
    { question: "請求書で支払えますか", answer: "ご相談ください。会場・食事・謝礼・企画と調整の料金をまとめた見積書をお出しし、お支払いの方法はそこで決めます。" },
    { question: "どのくらい前に相談すればよいですか", answer: `${n("bizLeadTimeMonths")}前までが目安です。${n("bizShortNoticeWeeks")}前でも、内容によっては相談に応じます。` },
    { question: "雨の日はどうなりますか", answer: "屋外を歩く内容は、屋内の訪問先に組み替えることを前に提案します。会議と食事は屋内です。" },
    { question: "社外秘の話をしても大丈夫ですか", answer: "会議の時間を貸切にし、街の人が同席する時間は事前に決める形で相談できます。進め方は、お話をうかがう中で確認します。" },
  ],
  closing: { title: "まずは、目的を聞かせてください。", body: "期初の方針づくり、新しいメンバーの歓迎、企画の前の聞き取り。日にちが決まっていなくても相談できます。" },
};

export const SCHOOLS_GUIDE: GroupGuide = {
  kind: "SCHOOL",
  path: "/ja/schools",
  metaTitle: "学校の方へ",
  metaDescription: "校外学習・探究学習で、鎌倉の街の人に会う時間を。取材先への依頼や日程の調整まで、事務局がご相談に応じます。",
  eyebrow: "学校の方へ",
  title: "鎌倉で、働く大人に会う。",
  lead: "班別行動の時間を、街の人との対話に。取材先への依頼や日程の調整は、事務局が引き受けます。学年・人数・時期・予算が決まっていなくても、相談できます。",
  cta: "資料と見積を相談する",
  otherLink: { href: "/ja/business", label: "法人・団体の方はこちら" },
  note: { title: `${fact("venueWalk")}の拠点があります`, body: `集合、荷物置き、雨の日の待機に使えます。日中に使えるのは二階で、同時に入れるのは${n("venueSeatsUpstairs")}までです。` },
  offersTitle: "こんな使い方ができます",
  offers: [
    {
      title: `まちで働く大人に聞く、${n("schoolTalkMinutes")}`,
      when: "探究学習で、仕事や暮らしの話を直接聞きたいとき",
      people: `1クラス（${n("schoolClassMax")}まで）・班に分かれて`,
      time: n("schoolTalkMinutes"),
      price: `1人 ${n("schoolTalkPerPersonFrom")}`,
      points: [`${range("schoolTeamSizeMin", "schoolTeamSizeMax")}の班で、${n("schoolTalkAdults")}の大人を順に訪ねます`, `拠点に同時に入るのは${n("venueSeatsUpstairs")}まで。全員が一か所に集まる時間はつくりません`, "事前の質問づくりと、事後のまとめの資料をつける想定です"],
    },
    {
      title: "班別行動の取材先を手配",
      when: "班ごとの問いに合う、お店や工房を探したいとき",
      people: `1班（${n("schoolFieldTeamFrom")}以上）から`,
      time: fact("schoolFieldTime"),
      price: `1班 ${from("schoolFieldPerTeamFrom")}`,
      points: ["班の問いに合う訪問先を、事務局が探します", "訪問先への依頼と、時間の調整まで担当します"],
    },
    {
      title: "班別行動の拠点として",
      when: "集合・荷物置き・雨の日の待機の場所がほしいとき",
      people: `同時に${n("venueSeatsUpstairs")}まで`,
      time: fact("schoolBaseTime"),
      price: `1時間 ${n("venueHourlyFee")}`,
      points: ["集合と解散、荷物置き、待機に", "先生の待機場所と、班からの連絡の窓口にも"],
    },
  ],
  stepsTitle: "当日までの流れ",
  steps: [
    { title: `${n("schoolLeadTimeMonths")}前までに相談`, body: "学年、人数、日にち、探究のテーマを聞かせてください。決まっていない項目は空欄で大丈夫です。" },
    { title: "会う人をご提案", body: "テーマに合う大人を、プロフィールつきでご案内します。" },
    { title: "内容と見積", body: "企画や調整が必要なときは、内容と料金をご案内します。それを見て、進めるかを決めてください。" },
    { title: "事前の準備", body: "班ごとに、聞きたいことを用意する時間をとります。" },
    { title: "当日と、そのあと", body: "当日の進行と連絡は、事務局がまとめます。終わったあとの振り返りもご相談ください。" },
  ],
  feesTitle: "料金の考え方",
  fees: [
    ...SHARED_FEES,
    { label: "お支払い", value: "学校あての請求書、または旅行会社を通したお支払いを、ご相談ください" },
  ],
  questionsTitle: "先生へ：よくある質問",
  questions: [
    { question: "一度に何人まで受けられますか", answer: `${n("schoolClassMax")}（1クラス）までを目安にしています。班に分かれて、拠点と近くの訪問先に分散します。2クラス以上のときは、時間をずらす形で相談します。` },
    { question: "昼食はとれますか", answer: `拠点で昼食をとれるのは、${n("schoolLunchMax")}までです。それより多いときは、近くの場所を含めて相談します。` },
    { question: "雨の日はどうなりますか", answer: "対話は屋内で行う想定です。雨の日の扱いは、見積の前に先生と決めます。" },
    { question: "下見はできますか", answer: "ご相談ください。平日の日中を想定しています。" },
    { question: "支払いはどうなりますか", answer: "学校あての請求書、または旅行会社を通したお支払いを、相談の中で決めます。相談の時点で未定でも大丈夫です。" },
    { question: "安全面はどうなっていますか", answer: "引率・連絡体制・保険など、当日の安全の取り決めは、お見積りの前に先生と確認します。" },
  ],
  closing: { title: "来年の校外学習を、一緒に考えます。", body: "日にちが決まる前のご相談も歓迎です。" },
};
