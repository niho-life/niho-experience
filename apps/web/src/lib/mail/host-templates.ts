import "server-only";
import { otaSiteLabel } from "@/host/ota-sites";
import { hostPushLines, whenJa, type HostPushEvent } from "@/lib/host/push/payload";
import { HOST_LOGIN_LINK_PATH, HOST_NOTIFICATION_EMAIL_PATH, HOST_SETTINGS_PATH } from "@/lib/host/routes";
import { absolute, mail, oneLine, type MailBlock, type RenderedMail } from "./templates";

/*
 * The emails hosts get from this site (#194, owner decision 2026-11-01): Japanese, like the host console, in the same plain
 * text and minimal HTML as the guests' (no images, tracking or remote resources; absolute links only). A booking's email says
 * what its push says, no more: the site it came from, the experience, the time, an OTA guest's name and the party size, with
 * a link into /host. Never a guest's contact, an amount or a site's IDs.
 */

const NOTIFICATION_SETTINGS = `${HOST_SETTINGS_PATH}#settings-notification`;

const SETTINGS_LEAD = "宛先と届く通知は、ホストの画面の「設定 › 通知」で変えられます。";
const REPLY: MailBlock = { kind: "p", text: "このメールに返信すると NIHO サポートに届きます。" };

/**
 * 「{OTA} で新しい予約：{体験} {日時}」 and the like: the push's words for the same booking (`event`, the push the job would
 * send), and the link the push opens. An OTA booking adds where its cancellations, refunds and messages are handled.
 */
export function hostBookingEmail(event: HostPushEvent, options: { readonly siteUrl: string }): RenderedMail {
  if (event.assignment) return hostAssignmentEmail(event, options);
  const lines = hostPushLines(event);
  const site = event.ota ? otaSiteLabel(event.ota.site) : null;
  const rows: (readonly [string, string])[] = [
    ...(site ? [["予約サイト", site] as const] : [["予約", "体験サイト"] as const]),
    ...(lines.experience ? [["体験", lines.experience] as const] : []),
    ...(lines.when ? [[event.ota?.change === "RESCHEDULED" ? "日時（変更前 → 変更後）" : "日時", lines.when] as const] : []),
    ...(lines.guest ? [["予約者", `${oneLine(lines.guest)} 様`] as const] : []),
    ...(lines.seats ? [["人数", lines.seats] as const] : []),
  ];
  const lead = event.ota
    ? event.ota.change === "NEW" ? `${site} で新しい予約がありました。` : event.ota.change === "CANCELLED" ? `${site} の予約が取り消されました。` : `${site} の予約の日時が変わりました。`
    : event.kind === "CANCELLATION" ? "このサイトで受けた予約が取り消されました。" : "このサイトで新しい予約を受けました。";
  const subject = [lines.title, [lines.experience, event.ota?.change === "RESCHEDULED" ? whenJa(event.startsAt) : lines.when].filter(Boolean).join(" ")].filter(Boolean).join("：");
  return mail(subject, [
    { kind: "p", text: lead },
    { kind: "facts", rows },
    {
      kind: "link",
      lead: event.ota ? "予約者の連絡先と予約サイトの予約番号は、ホストの画面で確かめられます。" : "予約の内容は、ホストの画面で確かめられます。",
      label: "予約を開く",
      href: absolute(options.siteUrl, event.url),
    },
    ...(site ? [{ kind: "p", text: `取消・返金・予約者とのやりとりは ${site} で行ってください。` } as const] : []),
    { kind: "link", lead: SETTINGS_LEAD, label: "設定 › 通知", href: absolute(options.siteUrl, NOTIFICATION_SETTINGS) },
    REPLY,
  ], "ja");
}

/**
 * 担当を募る (#535): a NIHO-managed request needs someone to take its occurrence. It says what the push says and where 対応する
 * is. Never the guest, an amount or who else was asked; it does not say the request is approved or paid.
 */
function hostAssignmentEmail(event: HostPushEvent, options: { readonly siteUrl: string }): RenderedMail {
  const lines = hostPushLines(event);
  const rows: (readonly [string, string])[] = [
    ["受け方", "NIHO で受けた申込"],
    ...(lines.experience ? [["体験", lines.experience] as const] : []),
    ...(lines.when ? [["日時", lines.when] as const] : []),
    ...(lines.seats ? [["人数", lines.seats] as const] : []),
  ];
  const subject = [lines.title, [lines.experience, lines.when].filter(Boolean).join(" ")].filter(Boolean).join("：");
  return mail(subject, [
    { kind: "p", text: "担当できる方を募っています。行ける方は、ホストの画面で「対応する」を押してください。先に押した1人が担当になります。" },
    { kind: "facts", rows },
    { kind: "link", lead: "担当になっても、予約者への承認・支払いの案内・予約の確定は NIHO が行います。予約者には担当者は知らされません。", label: "予約を開く", href: absolute(options.siteUrl, event.url) },
    { kind: "link", lead: SETTINGS_LEAD, label: "設定 › 通知", href: absolute(options.siteUrl, NOTIFICATION_SETTINGS) },
    REPLY,
  ], "ja");
}

/** Non-booking host notifications use the same parsed event and minimum facts as Web Push. */
export function hostNotificationEmail(event: HostPushEvent, options: { readonly siteUrl: string }): RenderedMail {
  const lines = hostPushLines(event);
  const rows: (readonly [string, string])[] = [
    ...(lines.experience ? [["体験", lines.experience] as const] : []),
    ...(lines.when ? [["日時", lines.when] as const] : []),
    ...(lines.seats ? [["人数", lines.seats] as const] : []),
  ];
  return mail(lines.title, [
    { kind: "p", text: event.note ?? lines.title },
    ...(rows.length ? [{ kind: "facts", rows } as const] : []),
    { kind: "link", lead: "内容はホストの画面で確認できます。", label: "ホストの画面を開く", href: absolute(options.siteUrl, event.url) },
    { kind: "link", lead: SETTINGS_LEAD, label: "設定 › 通知", href: absolute(options.siteUrl, NOTIFICATION_SETTINGS) },
    REPLY,
  ], "ja");
}

const JST = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * 「ログインのリンク」 (Experience host accounts, ADR 0003): `/host/auth/open#t=<token>`, the token in the fragment only.
 * It works once, until `expiresAt` (15 minutes), and only in the browser that asked for it: the email says so, and how to
 * get it there when the mail app opens links in its own browser. Someone else may have typed the address: nothing
 * happens unless the link is opened in the browser that asked.
 */
export function hostLoginLinkEmail(input: { readonly siteUrl: string; readonly token: string; readonly expiresAt: string; readonly minutes: number }): RenderedMail {
  const until = JST.format(new Date(input.expiresAt));
  return mail("NIHO 体験ホストへのログイン", [
    { kind: "p", text: "NIHO 体験ホストにログインするためのリンクです。" },
    {
      kind: "link",
      lead: `リンクは ${until} まで（${input.minutes} 分間）、1 回だけ使えます。リンクは、リクエストしたブラウザで開いてください。`,
      label: "ログインする",
      href: `${absolute(input.siteUrl, HOST_LOGIN_LINK_PATH)}#t=${encodeURIComponent(input.token)}`,
    },
    { kind: "p", text: "メールのアプリの中でリンクが開いたときは、リンクをコピーして、リクエストしたブラウザに貼り付けてください。" },
    { kind: "p", text: "心当たりがなければ、このメールは無視してください。リクエストしたブラウザで開かない限り、ログインはされません。" },
    REPLY,
  ], "ja");
}

/**
 * 「通知の宛先の確認」: the link that makes this address the one this site emails (`/host/notification-email#t=<token>`; the
 * token in the fragment only). It works once and until `expiresAt`. Someone else may have typed the address: the email says
 * nothing changes unless the link is opened.
 */
export function hostAddressConfirmationEmail(input: { readonly siteUrl: string; readonly token: string; readonly expiresAt: string }): RenderedMail {
  const until = JST.format(new Date(input.expiresAt));
  return mail("通知の宛先の確認", [
    { kind: "p", text: "NIHO 体験ホストの通知を、このアドレスで受け取るための確認です。" },
    {
      kind: "link",
      lead: `下のリンクを開いて「このアドレスに切り替える」を押すと、予約などの通知がこのアドレスに届くようになります。リンクは ${until} まで、1 回だけ使えます。`,
      label: "宛先を切り替える",
      href: `${absolute(input.siteUrl, HOST_NOTIFICATION_EMAIL_PATH)}#t=${encodeURIComponent(input.token)}`,
    },
    { kind: "p", text: "心当たりがなければ、このメールは無視してください。宛先は変わりません。" },
    REPLY,
  ], "ja");
}
