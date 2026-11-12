import { notFound } from "next/navigation";
import type { GroupInquiryLocale } from "@niho-experience/experience-store/group-inquiry-fields";
import { GroupInquiryForm } from "@/components/GroupInquiryForm";
import { config } from "@/lib/config";
import { inquiryContextFromSearch } from "@/lib/group-inquiry-entry";

const WORDS = {
  ja: {
    title: "相談する",
    lead: "学校・法人・グループでの体験づくりや、体験を載せたいというご相談を、NIHO がうかがいます。やりたいことが固まっていなくても大丈夫です。必須なのは、お名前・メールアドレス・ご相談の内容だけです。",
  },
  en: {
    title: "Talk to us",
    lead: "Planning an experience for a school, a company or a group, or want to offer one yourself? Tell NIHO what you have in mind. It's fine if nothing is decided: we only need your name, your email and what you would like to ask.",
  },
} as const;

/** The inquiry form's page (#532), in either language: the same form, the context the entry page passed. 404 while the flag is off. */
export function InquiryPage({ locale, search }: { locale: GroupInquiryLocale; search: Record<string, string | string[] | undefined> }) {
  if (!config.groupInquiryEnabled && !config.groupInquiryPreviewEnabled) notFound();
  const entry = inquiryContextFromSearch(search);
  const words = WORDS[locale];
  return (
    <div className="mx-auto w-full max-w-[40rem] px-4 py-8 sm:py-12">
      <h1 className="text-[1.75rem] leading-tight sm:text-[2.25rem]">{words.title}</h1>
      <p className="mt-3 mb-6 text-ink-soft">{words.lead}</p>
      <GroupInquiryForm
        locale={locale}
        initialKind={entry.kind}
        context={{ entry: entry.entry, experienceSlug: entry.experienceSlug, experienceTitle: entry.experienceTitle, hostName: entry.hostName }}
      />
    </div>
  );
}
