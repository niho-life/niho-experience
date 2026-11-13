import { BUSINESS_GUIDE, n } from "@/lib/group-inquiry-guide";

/*
 * 日本語サイトの「ご利用の案内」「体験を載せる（/ja/host）」「相談のページの案内」の文面 (#565, 親 #561)。
 * 日本語サイトは英語の訳ではなく独自の構成を持つ。数字は、すでに確認済みの値だけを使う:
 *  - 販売プランの手数料率（決済手数料込み）は docs/experience-sales-plans.md のとおり（テストがその文書と突き合わせる）。
 *  - 相談の料金の考え方は、法人・学校のページと同じ定数（lib/group-inquiry-guide.ts）から読む。
 * 全商品に共通の保証（「必ず実施」「24時間前まで無料」など）は書かない（#538）。実績・事例・利用者の声も書かない。
 */

/** NIHO の手数料率（決済手数料込み）。managed-sales.ts の `feeBasisPoints`（2000 / 1500 / 1000）と同じ値。 */
export const SALES_PLAN_BASIS_POINTS = { omakase: 2000, support: 1500, independent: 1000 } as const;
const percent = (basisPoints: number) => `${basisPoints / 100}%`;

export interface HostPlanCopy {
  readonly id: "omakase" | "support" | "independent";
  readonly name: string;
  readonly rate: string;
  readonly seller: string;
  readonly lead: string;
  readonly you: readonly string[];
  readonly niho: readonly string[];
  readonly highlight: boolean;
}

export const HOST_PLANS: readonly HostPlanCopy[] = [
  {
    id: "omakase", name: "おまかせ", rate: percent(SALES_PLAN_BASIS_POINTS.omakase), seller: "事務局が販売", highlight: true,
    lead: "ページづくりから予約の受付、お客さんとの連絡、返金まで、事務局が引き受けます。あなたは開ける日を教えて、当日の体験に集中してください。",
    you: ["開ける日を共有する", "当日の体験を届ける"],
    niho: ["ページの作成と公開", "予約の承認・お客さんとの連絡", "日程変更・取消・返金", "お支払いの受領と、提供した月の月末締め・翌月末の振込"],
  },
  {
    id: "support", name: "サポート", rate: percent(SALES_PLAN_BASIS_POINTS.support), seller: "あなたが販売", highlight: false,
    lead: "販売するのはあなた。通訳や当日の手伝いが要るときに、事務局が人を探して調整します。",
    you: ["口座の登録と本人確認", "料金と条件を決める", "販売と返金の対応"],
    niho: ["掲載・予約・決済の仕組み", "通訳や当日補助の紹介と調整", "合意した範囲での予約対応"],
  },
  {
    id: "independent", name: "自分で販売", rate: percent(SALES_PLAN_BASIS_POINTS.independent), seller: "あなたが販売", highlight: false,
    lead: "予約と決済の仕組みだけを使います。日程も問い合わせも、自分のペースで。",
    you: ["口座の登録と本人確認", "掲載・日程・問い合わせ", "変更・取消・返金の対応"],
    niho: ["掲載・予約・決済の仕組み", "サイトの基本サポート"],
  },
];

export interface TitledText { readonly title: string; readonly body: string }

export const HOST_PAGE = {
  metaTitle: "あなたの体験を、街の外の人へ",
  metaDescription: "仕事場を見せる。得意なことを教える。好きな道を一緒に歩く。鎌倉・逗子・葉山で続けていることを、会いに来たい人へ届けます。",
  eyebrow: "share your craft",
  title: "あなたの体験を、街の外の人へ。",
  lead: "仕事場を見せる。得意なことを教える。好きな道を一緒に歩く。鎌倉・逗子・葉山で続けていることを、会いに来たい人へ届けます。",
  talk: "まず話してみる",
  note: { title: "お客さんとのやりとりは、事務局が引き受けられます", body: "問い合わせへの返事、日にちの調整、取消と返金。細かい取り決めを事務局が担うので、当日に集中できます。申込みを見て、お断りすることもできます。" },
  plansTitle: "載せ方は三つ。体験ごとに選べます",
  rateLabel: "手数料（決済手数料こみ）",
  you: "あなた",
  niho: "事務局",
  switchNote: "慣れてきたら、自分で販売するプランへ移れます（体験ごとに、条件を確かめてから切り替えます）。",
  stepsTitle: "載せるまで",
  steps: [
    { title: "話を聞かせてください", body: "どんなことを、どんな人に届けたいか。鎌倉駅近くの拠点か、あなたの仕事場で。" },
    { title: "スタッフが体験します", body: "一度やってみて、向いている相手と、無理のない回数を一緒に考えます。" },
    { title: "条件を決めます", body: "手取り、人数、所要時間、お断りしたい場合。決めたことは書面に残します。" },
    { title: "ページをつくって公開", body: "写真と文章は事務局が手伝います。日本語と英語で載せられます。" },
  ] satisfies readonly TitledText[],
  questionsTitle: "よくある質問",
  questions: [
    { question: "申込みを断ることはできますか", answer: "できます。理由を伝える必要はありません。お客さんへの連絡は事務局がします。" },
    { question: "手取りはどう決まりますか", answer: "受け取りたい額と、選んだ載せ方の手数料から、料金を一緒に決めます。条件は体験ごとに書面で確かめます。" },
    { question: "入金はいつですか", answer: "「おまかせ」は、体験を提供した日の月末で締めて、翌月末にお支払いします。「サポート」「自分で販売」は、あなたの口座に直接入ります。" },
    { question: "日程の管理が面倒です", answer: "Googleカレンダーをつなぐと、予定の入っている時間は自動で受付を止めます。読み取るのは予定の有無だけで、内容は見ません。" },
    { question: "ひとりでは毎週できません", answer: "同じ活動を何人かで受け持つチーム制にできます。予約が入ったら、その日に動ける人が担当します。" },
  ],
  closing: { title: "まずは、お茶を飲みに来てください。", body: "載せるかどうかは、話してから決めれば大丈夫です。" },
  loginLabel: "ホスト画面にログイン",
} as const;

export const USAGE_PAGE = {
  metaTitle: "ご利用の案内",
  metaDescription: "参加する方と、体験を提供する方への案内。取消、実施できないとき、天気、連絡とお支払いについて。",
  eyebrow: "good to know",
  title: "ご利用の案内",
  sub: "参加する方と、体験を提供する方へ。",
  guestsTitle: "参加する方へ",
  guests: [
    { title: "取消について", body: "無料で取消できる期限は、体験ごとに違います。予約の画面と、確認のメールに書いてあります。" },
    { title: "実施できないとき", body: "主催者の都合で実施できないときは、料金をお返しします。" },
    { title: "天気について", body: "外を歩く体験は、中止を判断する時刻と、中止のときの扱いを、体験のページに載せています。" },
    { title: "連絡とお支払い", body: "日にちの変更や領収書は、予約の確認メールからご連絡ください。" },
  ] satisfies readonly TitledText[],
  hostsTitle: "体験を提供する方へ",
  hosts: [
    { title: "申込みは断れます", body: "申込みを読んで、合わないと思ったら断ってください。お客さんには事務局が伝えます。" },
    { title: "手取りは、一緒に決めます", body: "受け取りたい額から、料金を一緒に組み立てます。" },
    { title: "取消の扱いは、体験ごとに決めます", body: "期限と、期限を過ぎたときの扱いを、載せる前に一緒に決めます。" },
    { title: "細かいやりとりは任せられます", body: "問い合わせ、日程、返金、領収書は、事務局が引き受けられます（選んだ載せ方によります）。" },
  ] satisfies readonly TitledText[],
} as const;

export interface ConciergeExample { readonly title: string; readonly body: string; readonly href: string | null }

export const CONCIERGE_INTRO = {
  eyebrow: "ask the town",
  title: "載っていないことも、相談できます。",
  lead: "目的と人数を聞かせてください。合いそうな人と場をお伝えします。はじめのご相談は無料です。",
  cta: "相談を送る",
  examplesTitle: "たとえば、こんな相談",
  examples: [
    { title: "学校の探究・校外学習", body: "班別行動の取材先、働く大人との対話、雨の日の拠点。", href: "/ja/schools" },
    { title: "会社のチームで過ごす一日", body: "会議の場所、食事、街の人との時間をひとつの窓口で。", href: "/ja/business" },
    { title: "生活者の声を聞きたい", body: "条件に合う暮らし手を集めた、食卓でのヒアリング。", href: "/ja/business" },
    { title: "人を探している", body: "講師、職人、書き手、撮影に協力してくれる人。", href: "/ja/people" },
    { title: "特別な日を貸切で", body: "記念日、家族の集まり、遠くから来る友人を迎える日。", href: null },
    { title: "移住や開業を考えている", body: "先に越してきた人、店を始めた人に話を聞く。", href: null },
  ] satisfies readonly ConciergeExample[],
  stepsTitle: "進め方",
  steps: [
    { title: "相談を送る", body: "下のフォームから。決まっていないことは空欄のままで大丈夫です。" },
    { title: "お話をうかがう", body: `電話などで、${n("freeConsultMinutes")}ほど。ここまでは無料です。` },
    { title: "内容と料金をご案内", body: "企画や調整が必要なときは、内容とお見積りをお送りします。進めるかどうかは、それを見て決めてください。" },
    { title: "当日まで", body: "担い手との調整とお支払いの窓口は、事務局がまとめて担当します。" },
  ] satisfies readonly TitledText[],
  feesTitle: BUSINESS_GUIDE.feesTitle,
  fees: BUSINESS_GUIDE.fees,
  formTitle: "相談を送る",
} as const;
