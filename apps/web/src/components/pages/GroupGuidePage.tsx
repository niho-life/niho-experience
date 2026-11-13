import { notFound } from "next/navigation";
import { buttonClass } from "@/components/ui";
import { config } from "@/lib/config";
import { inquiryHref } from "@/lib/group-inquiry-entry";
import type { GroupGuide } from "@/lib/group-inquiry-guide";

/**
 * 法人・団体の方へ / 学校の方へ (#532): what can be done, for how many, how long, roughly what it costs, the questions
 * people ask, and one button to the inquiry form opened on the right kind. Japanese only. The figures are provisional and
 * come from lib/group-inquiry-guide.ts. 404 while the inquiry feature is off.
 */
export function GroupGuidePage({ guide }: { guide: GroupGuide }) {
  if (!config.groupInquiryEnabled) notFound();
  const type = guide.kind;
  const ask = inquiryHref("ja", { type, from: type === "SCHOOL" ? "SCHOOL" : "CORPORATE" });
  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 pb-16">
      <header className="py-10 sm:py-14">
        <p className="hand text-[1.25rem] text-moss">{guide.eyebrow}</p>
        <h1 className="mt-1 max-w-[22ch] text-[2rem] leading-tight sm:text-[2.75rem]">{guide.title}</h1>
        <p className="mt-4 max-w-[40rem] text-[1.0625rem] text-ink-soft">{guide.lead}</p>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          <a href={ask} className={buttonClass("primary", "w-full sm:w-auto")}>{guide.cta}</a>
          <a href={guide.otherLink.href} className="font-extrabold underline underline-offset-4">{guide.otherLink.label}</a>
        </div>
        <p className="mt-3 text-sm text-ink-soft">はじめの相談は無料です。企画や調整が必要なときは、内容と料金をご案内してから進めます。</p>
      </header>

      {guide.note ? <p className="mb-10 rounded-[16px] bg-leaf-pale px-5 py-4"><b className="block">{guide.note.title}</b><span className="text-ink-soft">{guide.note.body}</span></p> : null}

      <section aria-labelledby="offers" className="py-6">
        <h2 id="offers" className="text-[1.5rem]">{guide.offersTitle}</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {guide.offers.map((offer) => (
            <article key={offer.title} className="flex flex-col rounded-[18px] border border-line bg-white p-5">
              <h3 className="text-[1.125rem] leading-snug">{offer.title}</h3>
              <p className="mt-1 text-ink-soft">{offer.when}</p>
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.9375rem]">
                <dt className="font-extrabold">人数</dt><dd>{offer.people}</dd>
                <dt className="font-extrabold">時間</dt><dd>{offer.time}</dd>
                <dt className="font-extrabold">料金の目安</dt><dd>{offer.price}</dd>
              </dl>
              <ul className="mt-4 grid list-disc gap-1 pl-5 text-[0.9375rem] text-ink-soft">
                {offer.points.map((point) => <li key={point}>{point}</li>)}
              </ul>
            </article>
          ))}
        </div>
        <p className="mt-3 text-sm text-ink-soft">料金は目安です。日にちや人数、内容によって変わります。お見積りでご案内します。</p>
      </section>

      {guide.parts ? (
        <section aria-labelledby="parts" className="py-6">
          <h2 id="parts" className="text-[1.5rem]">{guide.parts.title}</h2>
          <ul className="mt-5 divide-y divide-line rounded-[18px] border border-line bg-white">
            {guide.parts.items.map((part) => (
              <li key={part.title} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-4">
                <span><b className="block">{part.title}</b><small className="text-ink-soft">{part.note}</small></span>
                <span className="text-right"><b className="block">{part.price}</b><small className="text-ink-soft">{part.people}</small></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="steps" className="grid gap-10 py-6 md:grid-cols-2">
        <div>
          <h2 id="steps" className="text-[1.5rem]">{guide.stepsTitle}</h2>
          <ol className="mt-5 grid gap-4">
            {guide.steps.map((step, index) => (
              <li key={step.title} className="flex gap-4">
                <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-leaf-pale font-extrabold text-moss">{index + 1}</span>
                <span><b className="block">{step.title}</b><span className="text-ink-soft">{step.body}</span></span>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h2 className="text-[1.5rem]">{guide.feesTitle}</h2>
          <table className="mt-5 w-full border-collapse text-left">
            <tbody>
              {guide.fees.map((fee) => (
                <tr key={fee.label} className="border-b border-line align-top">
                  <th scope="row" className="py-3 pr-4 font-extrabold">{fee.label}</th>
                  <td className="py-3">{fee.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="questions" className="py-6">
        <h2 id="questions" className="text-[1.5rem]">{guide.questionsTitle}</h2>
        <div className="mt-4 border-t border-line">
          {guide.questions.map((item) => (
            <details key={item.question} className="group border-b border-line">
              <summary className="flex min-h-11 cursor-pointer list-none items-center py-4 font-extrabold [&::-webkit-details-marker]:hidden">{item.question}</summary>
              <p className="pb-4 text-ink-soft">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mt-6 rounded-[22px] bg-leaf-pale px-6 py-8 sm:px-10">
        <h2 className="text-[1.5rem]">{guide.closing.title}</h2>
        <p className="mt-2 text-ink-soft">{guide.closing.body}</p>
        <a href={ask} className={buttonClass("primary", "mt-5 w-full sm:w-auto")}>{guide.cta}</a>
      </section>
    </div>
  );
}
