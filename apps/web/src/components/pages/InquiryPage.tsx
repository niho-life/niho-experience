import { notFound } from "next/navigation";
import type { GroupInquiryLocale } from "@niho-experience/experience-store/group-inquiry-fields";
import { GroupInquiryForm } from "@/components/GroupInquiryForm";
import { config } from "@/lib/config";
import { buttonClass } from "@/components/ui";
import { inquiryContextFromSearch } from "@/lib/group-inquiry-entry";
import { CONCIERGE_INTRO } from "@/lib/ja-service-copy";

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
  const entry = inquiryContextFromSearch(search, locale);
  const words = WORDS[locale];
  // 相談のページ (#565): opened with no entry context (not from a school, company, person or experience), the Japanese page
  // first says what can be asked, how it goes and what it costs; the form is the same one below.
  const intro = locale === "ja" && entry.entry === "DIRECT" && search.type === undefined;
  if (intro) {
    return (
      <div className="mx-auto w-full max-w-[64rem] px-4 pb-16">
        <header className="py-10 sm:py-14">
          <p className="hand text-[1.25rem] text-moss">{CONCIERGE_INTRO.eyebrow}</p>
          <h1 className="mt-1 max-w-[18ch] text-[2rem] leading-tight sm:text-[2.75rem]">{CONCIERGE_INTRO.title}</h1>
          <p className="mt-4 max-w-[40rem] text-[1.0625rem] text-ink-soft">{CONCIERGE_INTRO.lead}</p>
          <a href="#ask" className={buttonClass("primary", "mt-6 w-full sm:w-auto")}>{CONCIERGE_INTRO.cta}</a>
        </header>
        <section aria-labelledby="concierge-examples" className="py-6">
          <h2 id="concierge-examples" className="text-[1.5rem]">{CONCIERGE_INTRO.examplesTitle}</h2>
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CONCIERGE_INTRO.examples.map((example) => (
              <li key={example.title} className="rounded-[18px] border border-line bg-white p-5">
                <b className="block text-[1.0625rem]">{example.title}</b>
                <span className="mt-1 block text-ink-soft">{example.body}</span>
                {example.href && (example.href !== "/ja/people" || config.peoplePagesEnabled) ? <a href={example.href} className="mt-3 inline-block font-extrabold underline underline-offset-4">くわしく見る</a> : null}
              </li>
            ))}
          </ul>
        </section>
        <section className="grid gap-10 py-6 md:grid-cols-2">
          <div>
            <h2 className="text-[1.5rem]">{CONCIERGE_INTRO.stepsTitle}</h2>
            <ol className="mt-5 grid gap-4">
              {CONCIERGE_INTRO.steps.map((step, index) => (
                <li key={step.title} className="flex gap-4">
                  <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-leaf-pale font-extrabold text-moss">{index + 1}</span>
                  <span><b className="block">{step.title}</b><span className="text-ink-soft">{step.body}</span></span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h2 className="text-[1.5rem]">{CONCIERGE_INTRO.feesTitle}</h2>
            <table className="mt-5 w-full border-collapse text-left">
              <tbody>
                {CONCIERGE_INTRO.fees.map((fee) => (
                  <tr key={fee.label} className="border-b border-line align-top">
                    <th scope="row" className="py-3 pr-4 font-extrabold">{fee.label}</th>
                    <td className="py-3">{fee.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section id="ask" aria-labelledby="concierge-form" className="mx-auto mt-6 max-w-[40rem] scroll-mt-24 py-6">
          <h2 id="concierge-form" className="text-[1.5rem]">{CONCIERGE_INTRO.formTitle}</h2>
          <p className="mt-2 mb-6 text-ink-soft">{words.lead}</p>
          <GroupInquiryForm
            locale={locale}
            initialKind={entry.kind}
            context={{ entry: entry.entry, experienceSlug: entry.experienceSlug, experienceTitle: entry.experienceTitle, hostName: entry.hostName }}
          />
        </section>
      </div>
    );
  }
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
