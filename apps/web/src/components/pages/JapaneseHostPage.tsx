import { TrackedLink } from "@/components/Analytics";
import { buttonClass } from "@/components/ui";
import { hostConsoleEntry } from "@/components/pages/HostPageContent";
import { config } from "@/lib/config";
import { inquiryHref } from "@/lib/group-inquiry-entry";
import { HOST_PAGE, HOST_PLANS } from "@/lib/ja-service-copy";
import { safeHttpsUrl } from "@/lib/safe-url";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * 体験を載せる (/ja/host, #565): 日本語サイトの独自の構成。見出し、「まず話してみる」（相談フォームを「体験を載せたい」で開く）、
 * ログイン、載せ方三つ、載せるまでの流れ、よくある質問。署名済みのホストは今までどおり画面へ移す（hostConsoleEntry）。
 * 数字は lib/ja-service-copy.ts（確認済みの手数料率）だけから読む。
 */
export async function JapaneseHostPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const consoleEntry = await hostConsoleEntry(await searchParams);
  const talkHref = config.groupInquiryEnabled ? inquiryHref("ja", { type: "LISTING", from: "LISTING" }) : safeHttpsUrl(config.hostPilotContactUrl);
  return (
    <div className="mx-auto w-full max-w-[64rem] px-4 pb-16">
      <header className="py-10 sm:py-14">
        <p className="hand text-[1.25rem] text-moss">{HOST_PAGE.eyebrow}</p>
        <h1 className="mt-1 max-w-[16ch] text-[2rem] leading-tight sm:text-[2.75rem]">{HOST_PAGE.title}</h1>
        <p className="mt-4 max-w-[40rem] text-[1.0625rem] text-ink-soft">{HOST_PAGE.lead}</p>
        <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
          {talkHref ? <TrackedLink href={talkHref} event="host_start" props={{ signup_mode: "ja" }} className={buttonClass("primary", "w-full sm:w-auto")}>{HOST_PAGE.talk}</TrackedLink> : null}
          {/* A plain link: the console has its own root layout and login is a route handler. */}
          {consoleEntry ? <a href={consoleEntry.loginHref} lang="ja" className="font-extrabold underline underline-offset-4">{HOST_PAGE.loginLabel}</a> : null}
        </div>
      </header>

      <p className="mb-10 rounded-[16px] bg-leaf-pale px-5 py-4"><b className="block">{HOST_PAGE.note.title}</b><span className="text-ink-soft">{HOST_PAGE.note.body}</span></p>

      <section aria-labelledby="plans" className="py-6">
        <h2 id="plans" className="text-[1.5rem]">{HOST_PAGE.plansTitle}</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {HOST_PLANS.map((plan) => (
            <article key={plan.id} className={`flex flex-col rounded-[18px] border bg-white p-5 ${plan.highlight ? "border-moss" : "border-line"}`}>
              <h3 className="text-[1.25rem] leading-snug">{plan.name}</h3>
              <p className="mt-1"><b className="text-[1.5rem]">{plan.rate}</b> <small className="text-ink-soft">{HOST_PAGE.rateLabel}</small></p>
              <p className="mt-1 text-[0.9375rem] font-extrabold text-moss">{plan.seller}</p>
              <p className="mt-3 text-ink-soft">{plan.lead}</p>
              <h4 className="mt-4 text-[0.9375rem] font-extrabold">{HOST_PAGE.you}</h4>
              <ul className="mt-1 grid list-disc gap-1 pl-5 text-[0.9375rem] text-ink-soft">{plan.you.map((item) => <li key={item}>{item}</li>)}</ul>
              <h4 className="mt-4 text-[0.9375rem] font-extrabold">{HOST_PAGE.niho}</h4>
              <ul className="mt-1 grid list-disc gap-1 pl-5 text-[0.9375rem] text-ink-soft">{plan.niho.map((item) => <li key={item}>{item}</li>)}</ul>
            </article>
          ))}
        </div>
        <p className="mt-3 text-sm text-ink-soft">{HOST_PAGE.switchNote}</p>
      </section>

      <section className="grid gap-10 py-6 md:grid-cols-2">
        <div>
          <h2 className="text-[1.5rem]">{HOST_PAGE.stepsTitle}</h2>
          <ol className="mt-5 grid gap-4">
            {HOST_PAGE.steps.map((step, index) => (
              <li key={step.title} className="flex gap-4">
                <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-leaf-pale font-extrabold text-moss">{index + 1}</span>
                <span><b className="block">{step.title}</b><span className="text-ink-soft">{step.body}</span></span>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h2 className="text-[1.5rem]">{HOST_PAGE.questionsTitle}</h2>
          <div className="mt-4 border-t border-line">
            {HOST_PAGE.questions.map((item) => (
              <details key={item.question} className="group border-b border-line">
                <summary className="flex min-h-11 cursor-pointer list-none items-center py-4 font-extrabold [&::-webkit-details-marker]:hidden">{item.question}</summary>
                <p className="pb-4 text-ink-soft">{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {talkHref ? (
        <section className="mt-6 rounded-[22px] bg-leaf-pale px-6 py-8 sm:px-10">
          <h2 className="text-[1.5rem]">{HOST_PAGE.closing.title}</h2>
          <p className="mt-2 text-ink-soft">{HOST_PAGE.closing.body}</p>
          <a href={talkHref} className={buttonClass("primary", "mt-5 w-full sm:w-auto")}>{HOST_PAGE.talk}</a>
        </section>
      ) : null}
    </div>
  );
}
