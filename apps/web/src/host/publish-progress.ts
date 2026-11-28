import { blockerNames, publicationStatusLabel, splitBlockers, type PublicationStatus } from "@/components/host/publication-stages";
import { HOST_CALENDAR_PATH, HOST_EXPERIENCES_PATH, HOST_SELLER_PATH, HOST_SETTINGS_PATH, hostPayoutSettingsPath, withProvider, withQuery } from "@/lib/host/routes";

/*
 * ホームの「公開までの道のり」(#706, epic #700): two stages, ① 体験のページを公開する (no payout account needed) and
 * ② 予約の受付を始める. Every row reads what the host screens already have: the product's own `pageBlockers`,
 * `bookingBlockers` and `bookingOpen` (the list API the 体験 screen reads). A row is done when none of its reasons is
 * left; each row links to the screen that does it. Nothing here asks the server anything new.
 *
 * Not in the list, on purpose: 「連絡用メールの確認」. The experience DB does not make publishing wait for it today
 * (the notification address is a destination, not a gate), so a row for it would promise a rule that does not exist.
 */

export interface ProgressProduct {
  readonly id: string;
  readonly title: string;
  readonly status: PublicationStatus;
  readonly publicationBlockers: readonly string[];
  readonly pageBlockers?: readonly string[];
  readonly bookingBlockers?: readonly string[];
  readonly bookingOpen?: boolean;
}

export interface ChecklistRow {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly done: boolean;
  /** The screen that does it. */
  readonly href: string;
  readonly action: string;
  /** The row to do next (the one primary button of its stage). */
  readonly next: boolean;
}

export interface ChecklistStage {
  readonly title: string;
  readonly lead: string;
  readonly done: boolean;
  /** Not yet started in order, but allowed: the second stage may run beside the first. */
  readonly rows: readonly ChecklistRow[];
}

export interface PublishChecklist {
  /** The experience the rows are about (null before the first one is made). */
  readonly experienceId: string | null;
  readonly experienceTitle: string | null;
  readonly stage1: ChecklistStage;
  readonly stage2: ChecklistStage;
}

const PAGE_CONTENT = ["MANUSCRIPT_REQUIRED", "PUBLIC_CONTENT_INVALID", "PHOTOS_REQUIRED", "PRICE_REQUIRED", "CANCELLATION_TERMS_REQUIRED", "SLUG_IN_USE"] as const;
const SUPPORT = ["SUPPORT_CONSENT_REQUIRED", "FEE_SETTINGS_REQUIRED"] as const;
const SELLER = ["SELLER_REQUIRED", "SELLER_MISMATCH"] as const;
const PAYOUT = ["CONNECT_NOT_READY", "PAYMENT_REUSE_CONSENT_REQUIRED", "READINESS_MISSING", "READINESS_EXPIRED"] as const;

const hasAny = (list: readonly string[], codes: readonly string[]) => list.some((code) => codes.includes(code) || (code.startsWith("READINESS_") && codes.includes("READINESS_MISSING")));

/** The experience to show: the first one whose bookings are not open yet; null when every experience is taking bookings. */
export function nextExperience(products: readonly ProgressProduct[]): ProgressProduct | null {
  if (products.length === 0) return null;
  return products.find((product) => !(product.bookingOpen ?? product.status === "PUBLISHED")) ?? null;
}

/** All of the provider's experiences take bookings already: there is nothing left for the card to say. */
export function checklistFinished(products: readonly ProgressProduct[]): boolean {
  return products.length > 0 && nextExperience(products) === null;
}

export function publishChecklist(products: readonly ProgressProduct[], hostName: string, linkProviderId: string | null): PublishChecklist | null {
  if (checklistFinished(products)) return null;
  const product = nextExperience(products);
  const link = (path: string) => withProvider(path, linkProviderId);
  const editor = product ? link(`${HOST_EXPERIENCES_PATH}/${encodeURIComponent(product.id)}`) : link(`${HOST_EXPERIENCES_PATH}/new`);
  const { page, booking } = product ? splitBlockers(product) : { page: ["MANUSCRIPT_REQUIRED"], booking: [] };
  const all = [...page, ...booking];
  const pagePublic = product?.status === "PUBLISHED";
  const left = (codes: readonly string[]) => product !== null && hasAny(all, codes);
  const pageContentLeft = product === null || hasAny(page, PAGE_CONTENT);
  const pageReady = product !== null && page.length === 0;

  const stage1Rows: ChecklistRow[] = [
    { key: "host", title: "ホストの情報", detail: hostName ? `${hostName} として登録しました` : "登録しました", done: true, href: link(HOST_SETTINGS_PATH), action: "見る", next: false },
    {
      key: "page", title: "体験のページを作る",
      detail: product === null ? "題・写真・料金・取消条件を入れて、体験のページを作ります"
        : pageContentLeft ? `残り：${blockerNames(page.filter((code) => (PAGE_CONTENT as readonly string[]).includes(code))).join("・")}` : "題と説明・写真・料金・取消条件がそろいました",
      done: !pageContentLeft, href: editor, action: product === null ? "作る" : pageContentLeft ? "続ける" : "見る", next: pageContentLeft,
    },
    {
      key: "publish-page", title: "ページを公開する",
      detail: pagePublic ? "公開中" : pageReady ? "公開できます" : "上の項目がそろうと公開できます",
      done: pagePublic, href: editor, action: pagePublic ? "見る" : "公開へ", next: !pagePublic && pageReady,
    },
  ];

  const supportLeft = left(SUPPORT);
  const payoutLeft = left(PAYOUT);
  const sellerLeft = left(SELLER);
  const scheduleLeft = left(["SCHEDULE_REQUIRED"]);
  const bookingOpen = product !== null && (product.bookingOpen ?? pagePublic);
  const waiting = blockerNames(all);
  const bookingReady = product !== null && all.length === 0;
  const stage2Rows: ChecklistRow[] = [
    {
      key: "support", title: "売上の受け取り方", done: product !== null && !supportLeft,
      detail: !supportLeft ? "サポートと手数料の条件に同意済みです" : hasAny(all, ["FEE_SETTINGS_REQUIRED"]) ? "手数料の設定は運営側で行います" : "サポートの条件と手数料を確認して、同意します",
      href: `${link(HOST_SETTINGS_PATH)}#settings-support`, action: supportLeft ? "選ぶ" : "見る", next: false,
    },
    {
      key: "payout", title: "受取口座", done: product !== null && !payoutLeft,
      detail: !payoutLeft ? "準備ができました" : "本人確認と口座の登録は Stripe の画面で行います（10分ほど）",
      href: hostPayoutSettingsPath(linkProviderId), action: payoutLeft ? "つなぐ" : "見る", next: false,
    },
    {
      key: "seller", title: "販売者情報", done: product !== null && !sellerLeft,
      detail: !sellerLeft ? "登録しました" : "予約の画面とページの末尾に出る、販売者の情報です",
      href: link(HOST_SELLER_PATH), action: sellerLeft ? "入れる" : "見る", next: false,
    },
    {
      key: "schedule", title: "開催枠", done: product !== null && !scheduleLeft,
      detail: !scheduleLeft && product !== null ? "入っています" : "予約を受ける日にちと時間を入れます",
      href: withQuery(HOST_CALENDAR_PATH, { providerId: linkProviderId, experience: product?.id }),
      action: scheduleLeft || product === null ? "入れる" : "見る", next: false,
    },
    {
      key: "open-booking", title: "予約の受付を始める",
      detail: bookingOpen ? "受付中" : bookingReady ? "始められます。ページも同時に公開されます" : `残り：${waiting.join("・")}`,
      done: bookingOpen, href: editor, action: bookingOpen ? "見る" : "始める", next: bookingReady,
    },
  ];

  return {
    experienceId: product?.id ?? null,
    experienceTitle: product && products.length > 1 ? product.title : null,
    stage1: { title: "体験のページを公開する", lead: "受取口座はまだ要りません。公開すると、ページを見た人がホストに相談できます。", done: pagePublic, rows: stage1Rows },
    stage2: { title: "予約の受付を始める", lead: pagePublic ? "ここで受取口座をつなぎます。" : "ここで受取口座をつなぎます。①と並行して進めてもかまいません。", done: bookingOpen, rows: stage2Rows },
  };
}

/** The status line of the experience the card is about, as the editor says it. */
export function checklistStatus(product: ProgressProduct | null): string {
  return product === null ? "まだ体験がありません" : publicationStatusLabel(product.status, product.bookingOpen ?? product.status === "PUBLISHED");
}
