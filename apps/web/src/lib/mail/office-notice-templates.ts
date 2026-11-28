import type { ClaimedOfficeNotice } from "@niho-experience/experience-store";
import { absolute, mail, oneLine, type MailBlock, type RenderedMail } from "@/lib/mail/templates";

/*
 * 事務局への知らせ (#711, docs/host-operations.md): the notice to the office's mailbox the first time a host's page is
 * published and the first time its bookings open. Public names and the experience's title only: no guest, no owner address.
 */
export function officeNoticeEmail(notice: ClaimedOfficeNotice, options: { readonly siteUrl: string }): RenderedMail {
  const page = notice.kind === "FIRST_PAGE_PUBLISHED";
  const name = oneLine(notice.hostName);
  const blocks: MailBlock[] = [
    { kind: "p", text: page ? "ホストが初めてページを公開しました。" : "ホストが初めて予約の受付を始めました。" },
    {
      kind: "facts",
      rows: [
        ["ホスト", notice.hostNameEn ? `${name}（${oneLine(notice.hostNameEn)}）` : name],
        ["登録の経路", notice.route === "SELF" ? "自分で登録" : "事務局"],
        ["体験", notice.experienceTitle ? oneLine(notice.experienceTitle) : "（題なし）"],
      ],
    },
    { kind: "link", lead: "ホストの一覧（公開と受付の状態・運営停止）：", label: "ホストの一覧を開く", href: absolute(options.siteUrl, "/admin/hosts") },
    { kind: "p", text: "内容に問題があれば、ホストの一覧から運営停止できます。このメールへの返信は相手には届きません。" },
  ];
  return mail(page ? `【初めての公開】${name}` : `【初めての予約受付】${name}`, blocks, "ja");
}
