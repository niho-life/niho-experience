import type { GroupInquiryMail } from "@niho-experience/experience-store";
import { GROUP_INQUIRY_FIELDS } from "@niho-experience/experience-store/group-inquiry-fields";
import {
  INQUIRY_ENTRY_LABEL,
  INQUIRY_FIELD_LABEL,
  INQUIRY_FREE_NOTE,
  INQUIRY_KIND_LABEL,
  INQUIRY_NOT_BOOKED,
  inquiryAnswerLabel,
  inquiryDateLabel,
} from "@/lib/group-inquiry-copy";
import { absolute, mail, oneLine, type MailBlock, type RenderedMail } from "@/lib/mail/templates";

/*
 * The two emails of 団体・個別の相談 (#532, docs/group-inquiry.md): the receipt to the person who wrote (in the language
 * of the page they used) and the notice to the office (Japanese). Both say what was received; the receipt says the
 * reply to expect and that nothing is booked yet. Replying to the receipt reaches NIHO's office address.
 */

/** A message body: line breaks kept, other control characters dropped. */
function words(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim();
}

/** What the person answered, in the order the form asked, as label/value rows. */
function answerRows(inquiry: GroupInquiryMail, locale: "ja" | "en"): [string, string][] {
  return GROUP_INQUIRY_FIELDS[inquiry.kind].flatMap((field): [string, string][] => {
    const value = inquiry.details[field.key];
    if (!value) return [];
    const label = INQUIRY_FIELD_LABEL[field.key]?.[locale] ?? field.key;
    return [[label, oneLine(inquiryAnswerLabel(field.key, value, locale))]];
  });
}

function interestRow(inquiry: GroupInquiryMail, locale: "ja" | "en"): [string, string][] {
  const parts = [inquiry.experienceTitle ? oneLine(inquiry.experienceTitle) : null, inquiry.hostName ? (locale === "ja" ? `${oneLine(inquiry.hostName)}さん` : oneLine(inquiry.hostName)) : null].filter((part): part is string => part !== null);
  return parts.length > 0 ? [[locale === "ja" ? "気になる体験・人" : "Interested in", parts.join(" / ")]] : [];
}

/** The receipt: what was received, when to expect an answer, that nothing is booked and that the first talk is free. */
export function groupInquiryReceiptEmail(inquiry: GroupInquiryMail): RenderedMail {
  const ja = inquiry.locale === "ja";
  const locale = inquiry.locale;
  const name = oneLine(inquiry.contactName);
  const reply = inquiry.replyByDate ? inquiryDateLabel(inquiry.replyByDate, locale) : null;
  const blocks: MailBlock[] = [
    { kind: "p", text: ja ? `${name} 様` : `Hi ${name},` },
    { kind: "p", text: ja ? "ご相談を受け付けました。次の内容で受け取っています。" : "We received your inquiry. This is what we have." },
    {
      kind: "facts",
      rows: [
        [ja ? "受付番号" : "Reference", inquiry.inquiryRef],
        [ja ? "ご相談の種類" : "Type", INQUIRY_KIND_LABEL[inquiry.kind][locale]],
        ...interestRow(inquiry, locale),
        ...answerRows(inquiry, locale),
      ],
    },
    { kind: "quote", text: words(inquiry.message) },
    { kind: "p", text: ja
      ? `返信の目安：${reply ?? "2営業日"}までに、このメールのアドレスへご連絡します（土日は含みません）。`
      : `When to expect a reply: we will write to this address by ${reply ?? "two business days from now"} (weekends not counted).` },
    { kind: "p", text: INQUIRY_NOT_BOOKED[locale] + (ja ? "今回のご相談だけで、予約や料金は発生しません。" : " This inquiry alone does not book anything or charge you.") },
    { kind: "p", text: INQUIRY_FREE_NOTE[locale] },
    { kind: "p", text: ja ? "このメールに返信すると、NIHO の事務局に届きます。" : "Replying to this email reaches the NIHO office." },
  ];
  return mail(ja ? `ご相談を受け付けました（${inquiry.inquiryRef}）` : `We received your inquiry (${inquiry.inquiryRef})`, blocks, locale);
}

/** The notice to the office: everything the person wrote, who it is from and where the list is. */
export function groupInquiryStaffEmail(inquiry: GroupInquiryMail, options: { readonly siteUrl: string }): RenderedMail {
  const kind = INQUIRY_KIND_LABEL[inquiry.kind].ja;
  const blocks: MailBlock[] = [
    { kind: "p", text: "新しい相談が届きました。内容は以下のとおりです。" },
    {
      kind: "facts",
      rows: [
        ["受付番号", inquiry.inquiryRef],
        ["種類", kind],
        ["お名前", oneLine(inquiry.contactName)],
        ["メール", oneLine(inquiry.contactEmail)],
        ["返信の期限（相手に伝えた目安）", inquiry.replyByDate ? inquiryDateLabel(inquiry.replyByDate, "ja") : "2営業日"],
        ["入口", INQUIRY_ENTRY_LABEL[inquiry.entry].ja],
        ...interestRow(inquiry, "ja"),
        ...answerRows(inquiry, "ja"),
      ],
    },
    { kind: "quote", text: words(inquiry.message) },
    { kind: "link", lead: "受付の一覧（状態・担当・次の期限・メモ）：", label: "相談の受付一覧を開く", href: absolute(options.siteUrl, "/admin/inquiries") },
    { kind: "p", text: "相手には受付のメールを送っています。このメールへの返信は相手には届きません。" },
  ];
  return mail(`【新しい相談】${kind}：${oneLine(inquiry.contactName)}（${inquiry.inquiryRef}）`, blocks, "ja");
}
