/*
 * ホスト規約 (Epic #700, #708): what a person agrees to when they register as a host by themselves (EXPERIENCE_HOST_SELF_REGISTRATION_ENABLED).
 * The version goes to the store with the registration (`hostTermsVersion`, kept with the time of the agreement), so a later
 * change of the wording is a new version that people agree to again. Plain text here, so the page and the tests read one source.
 *
 * THE WORDING IS A DRAFT, WAITING FOR LEGAL REVIEW. It is written from what the repository already tells hosts (the photo-rights
 * confirmation, the support and payout-account consents) and from Epic #700's policy. It must be fixed (and the version raised)
 * before registering by oneself is opened to everyone (stage 5, #712).
 */
export const HOST_TERMS_VERSION = "2026-11-28";

/** Said at the top of the page and in docs/host-self-registration.md. */
export const HOST_TERMS_DRAFT_NOTICE = "この規約の文言は下書きで、法務の確認待ちです。自分での登録を開く前に確定します。";

export interface HostTermsSection {
  readonly id: string;
  readonly title: string;
  readonly points: readonly string[];
}

export const HOST_TERMS_SECTIONS: readonly HostTermsSection[] = [
  {
    id: "scope",
    title: "この規約について",
    points: [
      "NIHO Travel に、ホストとして体験のページを載せる人（個人・会社・お店・団体）に向けた規約です。登録にあたって、内容に同意していただきます。",
      "ホストは、NIHO アカウントでログインして登録します。登録できるホストは、1 つの NIHO アカウントにつき 3 つまでです。",
    ],
  },
  {
    id: "publishing",
    title: "公開と、公開後の確認",
    points: [
      "体験のページは、公開の前に NIHO の審査はありません。必要なことがそろえば、ホストが自分で公開できます。",
      "公開したあと、NIHO が内容を確かめ、この規約や法令に合わないときは、ホストに知らせたうえでページを止めることがあります。旅行者の安全にかかわるときは、先に止めます。",
      "ホストは、いつでも自分でページや予約の受付を止められます。受け付けた予約は、そのまま残ります。",
    ],
  },
  {
    id: "content",
    title: "掲載する内容と権利",
    points: [
      "題・説明・写真・料金・取消条件など、掲載する内容が正確であることは、ホストの責任です。実際と違う内容、ない実績やレビューを載せてはいけません。",
      "写真・文章・ロゴは、掲載する権利があるものだけを使います。写っている人や権利を持つ人から、掲載の許諾を得てください。",
      "ホストは、掲載した内容を NIHO Travel とその紹介（検索・一覧・SNS など）で使うことを許諾します。",
    ],
  },
  {
    id: "name",
    title: "掲載名",
    points: [
      "本名でも、屋号・活動名でもかまいません。会社・お店・団体として載せるときは、その名前で載せる権利があることが必要です。",
      "NIHO や事務局を名乗る名前、ほかの人や団体になりすます名前は使えません。",
    ],
  },
  {
    id: "fees",
    title: "手数料と売上の受け取り",
    points: [
      "登録と、体験のページの公開は無料です。",
      "予約の受付を始めるときに、手数料のプラン（自分で販売・サポート・おまかせ）を選び、その条件に同意していただきます。受取口座は、Stripe の画面で本人が登録します。",
    ],
  },
  {
    id: "contact",
    title: "連絡用のメールアドレス",
    points: [
      "予約や相談の知らせは、登録した連絡用のメールアドレスに届きます。確認のメールのリンクを開くと、アドレスが使えるようになります。",
      "アドレスの確認が済むまで、体験のページは公開できません。変更は、設定の「通知」からできます。",
    ],
  },
  {
    id: "privacy",
    title: "個人情報の扱い",
    points: [
      "予約した人の名前や連絡先は、その予約への対応のためだけに使います。ほかの目的に使ったり、第三者に渡したりしてはいけません。",
      "NIHO は、ホストの登録情報（NIHO アカウント、掲載名、連絡用のメールアドレス）を、運営と安全のために扱います。詳しくは、プライバシーポリシーをご覧ください。",
    ],
  },
  {
    id: "prohibited",
    title: "してはいけないこと",
    points: [
      "法令に反する体験や、参加する人の安全を軽んじる体験を載せること。",
      "特定の人を差別したり、傷つけたりする内容を載せること。",
      "手数料を避けるために、予約した人を NIHO Travel の外の支払いへ誘うこと。",
      "ほかの人になりすますこと、サイトへ不正にアクセスすること。",
    ],
  },
  {
    id: "changes",
    title: "停止と変更",
    points: [
      "この規約に反するとき、NIHO は、ページや予約の受付、ホストの利用を止めることがあります。",
      "規約を変えるときは、新しい版をお知らせし、続けて使う前にもう一度同意していただきます。",
    ],
  },
];
