/*
 * 体験の編集の「ページを公開する」と「予約の受付を始める」(#706, epic #700): the page and the start of bookings are two
 * steps. This file holds what the screen says about them, apart from React so the words and the rules can be tested:
 * which button is shown and whether it can be pressed, why not (in words), and what each confirmation says.
 * The reasons come from the server's `pageBlockers` and `bookingBlockers` (publication-http.ts); nothing here decides what
 * the server accepts. The home's checklist reads the same lists (host/publish-progress.ts).
 */

export type PublicationStatus = "DRAFT" | "PUBLISHED" | "STOPPED" | "RESTART_REQUIRED" | "SUSPENDED";

/** The editor's actions: the old one-step `publish` stays only for the Admin proxy. */
export type PublicationAction = "publish-page" | "open-booking" | "stop-booking" | "stop";

/** What stops the public page. The server sends the split; this is the fallback for a server that does not. */
export const PAGE_BLOCKER_CODES: ReadonlySet<string> = new Set([
  "MANUSCRIPT_REQUIRED", "PUBLIC_CONTENT_INVALID", "PHOTOS_REQUIRED", "PRICE_REQUIRED", "CANCELLATION_TERMS_REQUIRED",
  "SLUG_IN_USE", "OPERATIONS_SUSPENDED", "PROVIDER_SUSPENDED", "OWNER_NOT_CURRENT", "ACCOUNT_NOT_USABLE", "NOTIFICATION_ADDRESS_REQUIRED",
]);

/** A short name for what is missing, in the order a host would do it. Unknown codes are said as 「公開の条件」. */
const NAMES: readonly (readonly [string, string])[] = [
  ["MANUSCRIPT_REQUIRED", "題と説明の原稿"],
  ["PUBLIC_CONTENT_INVALID", "公開原稿の見直し"],
  ["PHOTOS_REQUIRED", "写真（と写真の説明）"],
  ["PRICE_REQUIRED", "料金"],
  ["CANCELLATION_TERMS_REQUIRED", "取消条件"],
  ["SLUG_IN_USE", "別のページのアドレス"],
  ["NOTIFICATION_ADDRESS_REQUIRED", "連絡用メールアドレスの確認"],
  ["OWNER_NOT_CURRENT", "ログインし直すこと"],
  ["ACCOUNT_NOT_USABLE", "アカウントの確認"],
  ["OPERATIONS_SUSPENDED", "運営の停止の解除"],
  ["PROVIDER_SUSPENDED", "運営によるホストの停止の解除"],
  ["SUPPORT_CONSENT_REQUIRED", "売上の受け取り方（サポート・手数料）への同意"],
  ["FEE_SETTINGS_REQUIRED", "手数料の設定（運営側）"],
  ["SELLER_REQUIRED", "販売者情報"],
  ["SELLER_MISMATCH", "販売者情報と受取口座の一致"],
  ["SELLER_DISCLOSURE_REQUIRED", "販売者表示（特定商取引法に基づく表記）"],
  ["AGENT_CONSENT_REQUIRED", "「サポート 15%（NIHO が代金を受け取る）」への同意"],
  ["SALES_PLAN_REQUIRED", "販売プラン（独立 10%）の選択"],
  ["CONNECT_NOT_READY", "受取口座"],
  ["PAYMENT_REUSE_CONSENT_REQUIRED", "受取口座での売上の受け取りへの同意"],
  ["READINESS_MISSING", "受取口座の最新の確認"],
  ["READINESS_EXPIRED", "受取口座の最新の確認"],
  ["CONSENT_OUTDATED", "最新の掲載条件への同意"],
  ["SCHEDULE_REQUIRED", "開催枠"],
];
const NAME_BY_CODE = new Map(NAMES);
const ORDER = new Map(NAMES.map(([code], index) => [code, index] as const));

/** The words for a list of reasons: each once, in the order above, joined with 「・」. */
export function blockerNames(codes: readonly string[]): string[] {
  const names: string[] = [];
  const sorted = [...new Set(codes)].sort((a, b) => (ORDER.get(a) ?? 999) - (ORDER.get(b) ?? 999));
  for (const code of sorted) {
    const name = code.startsWith("READINESS_") ? NAME_BY_CODE.get("READINESS_MISSING")! : NAME_BY_CODE.get(code) ?? "公開の条件";
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

export type SectionNeed = "page" | "booking" | "optional";
/** The small tag on each section of the editor. */
export const SECTION_NEED_LABEL: Record<SectionNeed, string> = { page: "ページ公開に必要", booking: "予約の受付に必要", optional: "任意" };

export interface StageInput {
  readonly status: PublicationStatus;
  /** Everything that stops both (the old list). */
  readonly publicationBlockers: readonly string[];
  readonly pageBlockers?: readonly string[];
  readonly bookingBlockers?: readonly string[];
  readonly bookingOpen?: boolean;
  /** The saved draft differs from what the page shows. */
  readonly publicationNeedsUpdate: boolean;
  /** There are unsaved edits: a press saves them first and then checks again. */
  readonly dirty: boolean;
  /** Another update is waiting to be settled. */
  readonly conflict: boolean;
  /**
   * A press confirms the saved manuscripts (a page written before saving confirmed them) and checks again, so a missing
   * confirmation alone does not keep the buttons off: whatever is really missing is then listed. Off for a Japanese-only page.
   */
  readonly confirmManuscriptsOnPress?: boolean;
}

export interface StageButton {
  readonly visible: boolean;
  readonly label: string;
  readonly enabled: boolean;
  /** The one to press next: the other one is shown quietly. */
  readonly primary: boolean;
  /** Why it cannot be pressed (or what the press will also do), in words. Null when there is nothing to say. */
  readonly reason: string | null;
  /** The reasons behind `reason`, for the 「必要なことを見る」 list. */
  readonly blockers: readonly string[];
}

export interface PublicationStages {
  readonly statusLabel: string;
  readonly page: StageButton;
  readonly booking: StageButton;
  readonly stopBooking: { readonly visible: boolean; readonly enabled: boolean };
}

export function publicationStatusLabel(status: PublicationStatus, bookingOpen: boolean): string {
  if (status === "PUBLISHED") return bookingOpen ? "公開中・予約受付中" : "公開中・予約の受付は準備中";
  return { DRAFT: "下書き", STOPPED: "停止中", RESTART_REQUIRED: "再公開が必要", SUSPENDED: "運営停止中" }[status];
}

/** The split lists from the server, or (for a server that has not got them yet) from the old single list. */
export function splitBlockers(input: Pick<StageInput, "publicationBlockers" | "pageBlockers" | "bookingBlockers">): { page: readonly string[]; booking: readonly string[] } {
  if (input.pageBlockers && input.bookingBlockers) return { page: input.pageBlockers, booking: input.bookingBlockers };
  return {
    page: input.publicationBlockers.filter((code) => PAGE_BLOCKER_CODES.has(code)),
    booking: input.publicationBlockers.filter((code) => !PAGE_BLOCKER_CODES.has(code)),
  };
}

/** Which buttons the editor shows, whether each can be pressed, and why not. */
export function publicationStages(input: StageInput): PublicationStages {
  const { page, booking } = splitBlockers(input);
  const bookingOpen = input.bookingOpen ?? input.status === "PUBLISHED";
  const suspended = input.status === "SUSPENDED";
  const stoppedOld = input.status === "STOPPED" || input.status === "RESTART_REQUIRED";
  const pagePublic = input.status === "PUBLISHED";
  const hold = input.conflict ? "競合を解消してから操作できます。" : suspended ? "運営が停止しているため、いまは操作できません。" : null;

  // While bookings are open the store checks the booking reasons too and moves the page and the sale together.
  const pageNeeds = bookingOpen ? [...new Set([...page, ...booking])] : page;
  const pageVisible = !(pagePublic && !input.publicationNeedsUpdate);
  const pageLabel = pagePublic ? "変更を公開する" : stoppedOld ? "ページを公開し直す" : "ページを公開する";
  // Only an unconfirmed manuscript: the press itself confirms it, so the button stays on (and says so).
  const onlyManuscript = (codes: readonly string[]) => input.confirmManuscriptsOnPress === true && codes.length > 0 && codes.every((code) => code === "MANUSCRIPT_REQUIRED");
  const pageBlocked = pageNeeds.length > 0 && !input.dirty && !onlyManuscript(pageNeeds);
  const CHECK_ON_PRESS = "原稿は、押したときに確かめます。足りないところがあれば、お知らせします。";
  const pageReason = hold ?? (input.dirty ? "入力を保存すると、公開できるか確かめます。"
    : pageBlocked ? `${pagePublic ? "変更の公開" : "ページの公開"}には、${blockerNames(pageNeeds).join("・")}が必要です。`
      : onlyManuscript(pageNeeds) ? CHECK_ON_PRESS : null);

  const bookingNeeds = [...new Set([...page, ...booking])];
  const bookingBlocked = bookingNeeds.length > 0 && !input.dirty && !onlyManuscript(bookingNeeds);
  const bookingReason = hold ?? (input.dirty ? "入力を保存すると、始められるか確かめます。"
    : bookingBlocked ? `予約の受付には、${blockerNames(bookingNeeds).join("・")}が必要です。`
      : onlyManuscript(bookingNeeds) ? CHECK_ON_PRESS : pagePublic ? null : "予約の受付を始めると、ページも公開されます。");

  return {
    statusLabel: publicationStatusLabel(input.status, bookingOpen),
    page: { visible: pageVisible, label: pageLabel, enabled: hold === null && !pageBlocked, primary: true, reason: pageReason, blockers: pageNeeds },
    booking: {
      visible: !bookingOpen, label: stoppedOld ? "予約の受付を再開する" : "予約の受付を始める",
      enabled: hold === null && !bookingBlocked, primary: pagePublic && !input.publicationNeedsUpdate, reason: bookingReason, blockers: bookingNeeds,
    },
    stopBooking: { visible: bookingOpen && !suspended, enabled: !input.conflict && !input.dirty },
  };
}

/** The confirmation of each action: what it does, and (for stopping) what stays. */
export function publicationConfirmCopy(action: PublicationAction, status: PublicationStatus, bookingOpen = false): { title: string; description: string; confirm: string } {
  switch (action) {
    case "publish-page":
      // While bookings are open the change is sold as shown, so it goes out with the conditions the host agrees to again.
      if (bookingOpen) return { title: "変更を公開しますか？", description: "変更が旅行者に見えるようになります。予約の受付は、そのまま続きます。公開内容と販売条件に同意します。", confirm: "同意して公開する" };
      return { title: status === "PUBLISHED" ? "変更を公開しますか？" : "体験のページを公開しますか？", description: "このページが旅行者に見えるようになります。予約の受付は、別に始めます。", confirm: "公開する" };
    case "open-booking":
      return { title: status === "STOPPED" || status === "RESTART_REQUIRED" ? "予約の受付を再開しますか？" : "予約の受付を始めますか？", description: "掲載条件を確認し、予約の受付を始めます。ページが公開されていなければ、同時に公開します。公開内容と販売条件に同意します。", confirm: "同意して始める" };
    case "stop-booking":
      return { title: "予約の受付を止めますか？", description: "新しい予約が入らなくなります。ページは公開のままで、旅行者は相談だけできます。受け付けた予約と、外部の予約サイトから入った予約は、そのまま残ります。", confirm: "受付を止める" };
    case "stop":
      return { title: "ページを止めますか？", description: "公開ページが見えなくなり、新しい予約も止まります。受け付けた予約はそのまま残ります。", confirm: "止める" };
  }
}

/** What the page says after each action succeeded. */
export const PUBLICATION_ACTION_NOTICE: Record<PublicationAction, string> = {
  "publish-page": "ページを公開しました。",
  "open-booking": "予約の受付を始めました。",
  "stop-booking": "予約の受付を止めました。ページは公開のままです。",
  stop: "ページを止めました。",
};

/** The endpoint of each action under `/host/api/products/{id}/`. */
export const PUBLICATION_ACTION_PATH: Record<PublicationAction, string> = {
  "publish-page": "publish-page", "open-booking": "open-booking", "stop-booking": "stop-booking", stop: "stop",
};
